"""Tests for lite_server's POST /miniapp (r16 Feature 1) — the one-shot
mini-app generator via fastapi TestClient, no live server, no network
(ClaudeSDKClient is monkeypatched at its boundary, async-context-manager
fakes in the test_lite_compat.py style; the long-lived chat client is
poisoned like test_lite_sessions.py does).

The contract under test (app/miniapp.js posts these shapes):
  * POST /miniapp {"description"} (3..2000 chars, pydantic-validated) ->
    {"html"} on success else {"error"}; never a 500;
  * every request runs on a FRESH client built from the miniapp options
    variant: MINIAPP system prompt, max_turns=4, allowed_tools=[] and
    mcp_servers={} — and build_options() itself stays untouched;
  * extraction: the first fenced html code block, else the raw reply when it
    starts (after whitespace) with <!doctype or <html;
  * >300k chars -> "generated app too large"; unextractable/empty -> "the
    model did not return a usable HTML document";
  * POST is token-gated by the method-based middleware when ATELIER_TOKEN
    is set.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_miniapp.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


DOC = "<!doctype html><html><body><h1>tip splitter</h1></body></html>"


# ── fakes ────────────────────────────────────────────────────────────────────

class _PoisonChatClient:
    """Any /miniapp touching the long-lived chat client fails the test loudly."""

    async def query(self, *a, **k):
        raise AssertionError("/miniapp must not touch the chat client")

    def receive_response(self):
        raise AssertionError("/miniapp must not touch the chat client")

    async def disconnect(self):
        pass


def _assistant(text):
    from claude_agent_sdk import AssistantMessage, TextBlock

    return AssistantMessage(content=[TextBlock(text=text)], model="test")


def _result(is_error=False, result=None):
    from claude_agent_sdk import ResultMessage

    return ResultMessage(
        subtype="error" if is_error else "success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="s",
        result=result,
    )


def _scripted_client_factory(script=None, built=None, query_error=None):
    """A ClaudeSDKClient replacement (async context manager, like the compat
    route's fakes) replaying a scripted message sequence; records options +
    queried messages so tests can assert the miniapp options variant."""
    if script is None:
        script = [_assistant(f"```html\n{DOC}\n```"), _result()]

    class _Client:
        def __init__(self, options=None):
            self.options = options
            self.queried = []
            if built is not None:
                built.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def query(self, message):
            self.queried.append(message)
            if query_error is not None:
                raise query_error

        async def receive_response(self):
            for msg in script:
                yield msg

    return _Client


class _NeverBuiltClient:
    """Validation-reject cases must never reach the SDK client at all."""

    def __init__(self, options=None):
        raise AssertionError("no client may be built for a rejected request")


def _install(monkeypatch, factory):
    monkeypatch.setattr(lite_server, "ClaudeSDKClient", factory)


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    monkeypatch.setattr(lite_server, "_chat_client", _PoisonChatClient())
    # hermetic: build_options must read a tmp settings file + config dir
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


@pytest.fixture
def client():
    return TestClient(lite_server.app)


# ── extraction: fenced + raw variants ────────────────────────────────────────

def test_fenced_html_reply(monkeypatch, client):
    built = []
    reply = f"Here is your app:\n```html\n{DOC}\n```\nEnjoy!"
    _install(monkeypatch, _scripted_client_factory(
        script=[_assistant(reply), _result()], built=built,
    ))

    resp = client.post("/miniapp", json={"description": "a tip splitter"})
    assert resp.status_code == 200
    assert resp.json() == {"html": DOC}
    assert built[0].queried == ["a tip splitter"]


def test_raw_html_reply_variants(monkeypatch, client):
    for raw in (
        f"\n  {DOC}",  # leading whitespace before <!doctype
        "<html><body>hi</body></html>",  # bare <html start
        "<!DOCTYPE HTML><html></html>",  # case-insensitive doctype
    ):
        _install(monkeypatch, _scripted_client_factory(
            script=[_assistant(raw), _result()],
        ))
        body = client.post("/miniapp", json={"description": "a pomodoro"}).json()
        assert body == {"html": raw.strip()}


def test_unextractable_reply(monkeypatch, client):
    for reply in (
        "Sorry, I cannot build that.",  # prose, no document
        "",                             # empty reply
        "```html\n\n```",               # fenced but empty
        "the doc is <html> shaped",     # tag not at the start
    ):
        _install(monkeypatch, _scripted_client_factory(
            script=[_assistant(reply), _result()],
        ))
        body = client.post("/miniapp", json={"description": "a clock"}).json()
        assert body == {
            "error": "the model did not return a usable HTML document"
        }


def test_size_cap(monkeypatch, client):
    huge = "<!doctype html><html>" + "x" * 300_001 + "</html>"
    _install(monkeypatch, _scripted_client_factory(
        script=[_assistant(huge), _result()],
    ))
    body = client.post("/miniapp", json={"description": "a big app"}).json()
    assert body == {"error": "generated app too large"}


# ── the miniapp options variant ──────────────────────────────────────────────

def test_options_variant_and_untouched_builder(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))

    assert client.post(
        "/miniapp", json={"description": "a clock"}
    ).status_code == 200

    opts = built[0].options
    assert opts.system_prompt == lite_server.MINIAPP_INSTRUCTIONS
    assert opts.system_prompt != lite_server.ATELIER_INSTRUCTIONS
    assert opts.max_turns == 4
    assert opts.allowed_tools == []
    assert opts.mcp_servers == {}

    # the shared builder's behavior for every other caller is untouched
    base = lite_server.build_options()
    assert base.system_prompt == lite_server.ATELIER_INSTRUCTIONS
    assert "atelier" in base.mcp_servers
    assert base.allowed_tools == list(lite_server.ATELIER_ALLOWED_TOOLS)


def test_fresh_client_per_request(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))

    client.post("/miniapp", json={"description": "app one"})
    client.post("/miniapp", json={"description": "app two"})
    assert len(built) == 2  # never a shared/long-lived client
    assert built[1].queried == ["app two"]


# ── validation + error semantics ─────────────────────────────────────────────

def test_description_length_validation(monkeypatch, client):
    _install(monkeypatch, _NeverBuiltClient)
    for body in (
        {"description": "ab"},         # below min 3
        {"description": "x" * 2001},   # above max 2000
        {"description": ""},
        {},
    ):
        assert client.post("/miniapp", json=body).status_code == 422


def test_failed_result_surfaces_as_error(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(
        script=[_result(is_error=True, result="rate limited")],
    ))
    resp = client.post("/miniapp", json={"description": "a clock"})
    assert resp.status_code == 200  # never a 500
    body = resp.json()
    assert set(body) == {"error"}
    assert "rate limited" in body["error"]


def test_exception_never_500s(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(
        query_error=RuntimeError("transport died"),
    ))
    resp = client.post("/miniapp", json={"description": "a clock"})
    assert resp.status_code == 200  # never a 500
    body = resp.json()
    assert set(body) == {"error"}
    assert "transport died" in body["error"]


# ── token gate (POST -> gated by the method-based middleware) ────────────────

def test_miniapp_is_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))

    resp = client.post("/miniapp", json={"description": "a clock"})
    assert resp.status_code == 403
    assert built == []  # rejected before the handler ran

    resp = client.post(
        "/miniapp",
        json={"description": "a clock"},
        headers={"X-Atelier-Token": "sekret"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"html": DOC}
