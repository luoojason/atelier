"""Tests for opt-in `claude -p` isolation in claude_subscription_model.run_cli.

Pytest-style (monkeypatch/tmp_path), injected fake runners, no network and no
real `claude` binary. Covers the CLAUDE_ISOLATED contract:

  * isolation OFF  -> argv has no --safe-mode and the runner is called WITHOUT
    an env kwarg (byte-identical to the historical behavior);
  * isolation ON   -> argv gains --safe-mode and a guaranteed --model, and the
    runner env has CLAUDE_CONFIG_DIR set, CLAUDE_SECURESTORAGE_CONFIG_DIR=="",
    and no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN;
  * a "Not logged in" first response triggers exactly ONE fallback retry with
    the config-dir redirection removed (and no retry loop beyond that).
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import claude_subscription_model as csm  # noqa: E402

CANNED_OK = {"result": "hello", "is_error": False, "usage": {}}


def make_runner(responses):
    """Return (runner, calls). ``responses`` is a list of canned CLI JSON dicts
    consumed in order (the last one repeats). The runner records argv and every
    kwarg — including whether an ``env`` kwarg was passed at all."""
    remaining = list(responses)
    calls = []

    def runner(argv, **kwargs):
        calls.append({"argv": list(argv), "kwargs": kwargs})
        canned = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        return SimpleNamespace(returncode=0, stdout=json.dumps(canned), stderr="")

    return runner, calls


@pytest.fixture
def isolation_off(monkeypatch):
    monkeypatch.delenv("CLAUDE_ISOLATED", raising=False)


@pytest.fixture
def isolation_on(monkeypatch, tmp_path):
    """Isolation active, with CLAUDE_CONFIG_DIR pinned to tmp_path so tests never
    create a real ~/.atelier/claude-home, and a dummy API key to assert removal."""
    monkeypatch.setenv("CLAUDE_ISOLATED", "1")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-dummy")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-dummy")
    monkeypatch.delenv("CLAUDE_CLI_MODEL", raising=False)
    return tmp_path


def test_isolation_off_is_byte_identical(isolation_off):
    runner, calls = make_runner([CANNED_OK])
    data = csm.run_cli("SYS", "USER", model="sonnet", runner=runner)
    assert data == CANNED_OK
    assert len(calls) == 1
    argv = calls[0]["argv"]
    assert "--safe-mode" not in argv
    # No env kwarg at all — not even env=None.
    assert "env" not in calls[0]["kwargs"]


def test_isolation_off_no_forced_model(isolation_off, monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_MODEL", "opus")  # must be ignored when off
    runner, calls = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", runner=runner)
    assert "--model" not in calls[0]["argv"]


def test_isolation_on_argv_and_env(isolation_on):
    runner, calls = make_runner([CANNED_OK])
    data = csm.run_cli("SYS", "USER", runner=runner)
    assert data == CANNED_OK
    assert len(calls) == 1

    argv = calls[0]["argv"]
    assert "--safe-mode" in argv
    assert "--model" in argv
    assert argv[argv.index("--model") + 1] == "sonnet"  # guaranteed default

    env = calls[0]["kwargs"]["env"]
    assert env["CLAUDE_CONFIG_DIR"] == str(isolation_on / "claude-home")
    assert env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] == ""
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    # The isolated config dir is created eagerly.
    assert (isolation_on / "claude-home").is_dir()


def test_isolation_model_precedence(isolation_on, monkeypatch):
    # env CLAUDE_CLI_MODEL beats the "sonnet" default...
    monkeypatch.setenv("CLAUDE_CLI_MODEL", "opus")
    runner, calls = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", runner=runner)
    argv = calls[0]["argv"]
    assert argv[argv.index("--model") + 1] == "opus"

    # ...and an explicit model arg beats both.
    runner2, calls2 = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", model="haiku", runner=runner2)
    argv2 = calls2[0]["argv"]
    assert argv2[argv2.index("--model") + 1] == "haiku"


def test_isolation_default_config_dir(monkeypatch, tmp_path):
    """Without a CLAUDE_CONFIG_DIR override the default lands in ~/.atelier
    (HOME is pointed at tmp_path so nothing real is created)."""
    monkeypatch.setenv("CLAUDE_ISOLATED", "true")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    runner, calls = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", runner=runner)
    env = calls[0]["kwargs"]["env"]
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / ".atelier" / "claude-home")
    assert (tmp_path / ".atelier" / "claude-home").is_dir()


def test_not_logged_in_triggers_single_fallback_retry(isolation_on):
    not_logged_in = {"result": "Not logged in. Please run /login.", "is_error": True}
    runner, calls = make_runner([not_logged_in, CANNED_OK])
    data = csm.run_cli("SYS", "USER", runner=runner)
    assert data == CANNED_OK
    assert len(calls) == 2

    # Same argv both times (still --safe-mode + --model)...
    assert calls[0]["argv"] == calls[1]["argv"]
    assert "--safe-mode" in calls[1]["argv"]

    # ...but the retry env drops the config-dir redirection.
    retry_env = calls[1]["kwargs"]["env"]
    assert "CLAUDE_CONFIG_DIR" not in retry_env
    assert "CLAUDE_SECURESTORAGE_CONFIG_DIR" not in retry_env
    assert "ANTHROPIC_API_KEY" not in retry_env


def test_not_logged_in_retry_happens_exactly_once(isolation_on):
    not_logged_in = {"result": "Not logged in", "is_error": True}
    runner, calls = make_runner([not_logged_in])  # every attempt fails
    with pytest.raises(RuntimeError, match="Not logged in"):
        csm.run_cli("SYS", "USER", runner=runner)
    assert len(calls) == 2  # one attempt + one fallback, no loop


def test_not_logged_in_via_stderr_also_retries(isolation_on):
    """A non-zero exit with 'Not logged in' on stderr takes the same fallback."""
    outs = [
        SimpleNamespace(returncode=1, stdout="", stderr="Not logged in"),
        SimpleNamespace(returncode=0, stdout=json.dumps(CANNED_OK), stderr=""),
    ]
    calls = []

    def runner(argv, **kwargs):
        calls.append({"argv": list(argv), "kwargs": kwargs})
        return outs[len(calls) - 1]

    data = csm.run_cli("SYS", "USER", runner=runner)
    assert data == CANNED_OK
    assert len(calls) == 2
    assert "CLAUDE_CONFIG_DIR" not in calls[1]["kwargs"]["env"]


def test_other_errors_do_not_retry(isolation_on):
    boom = {"result": "rate limited", "is_error": True}
    runner, calls = make_runner([boom])
    with pytest.raises(RuntimeError, match="rate limited"):
        csm.run_cli("SYS", "USER", runner=runner)
    assert len(calls) == 1


def test_off_then_on_same_process(isolation_off, monkeypatch, tmp_path):
    """Isolation is read from env at call time, not import time."""
    runner, calls = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", runner=runner)
    assert "env" not in calls[0]["kwargs"]

    monkeypatch.setenv("CLAUDE_ISOLATED", "1")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "home"))
    runner2, calls2 = make_runner([CANNED_OK])
    csm.run_cli("SYS", "USER", runner=runner2)
    assert "--safe-mode" in calls2[0]["argv"]
    assert calls2[0]["kwargs"]["env"]["CLAUDE_SECURESTORAGE_CONFIG_DIR"] == ""
