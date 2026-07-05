"""GET /readiness — can the CORE agent authenticate right now? — and the
auth-failure mapping in _friendly_turn_error (Round-2 P1 front door)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import lite_server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


def test_subscription_not_logged_in(client, monkeypatch):
    monkeypatch.setattr(lite_server, "_subscription_login_present", lambda: False)
    body = client.get("/readiness").json()
    assert body == {"provider": "subscription", "ready": False,
                    "reason": "no-subscription-login"}


def test_subscription_logged_in(client, monkeypatch):
    monkeypatch.setattr(lite_server, "_subscription_login_present", lambda: True)
    body = client.get("/readiness").json()
    assert body["ready"] is True and body["reason"] == "ok"


def test_api_chosen_without_key_falls_back_to_subscription(client, monkeypatch):
    # _effective_provider's no-dead-state rule: api without a stored key runs
    # as subscription, so readiness reports the subscription probe.
    monkeypatch.setattr(lite_server, "_subscription_login_present", lambda: False)
    lite_server.save_settings({"provider": "api"})
    body = client.get("/readiness").json()
    assert body == {"provider": "subscription", "ready": False,
                    "reason": "no-subscription-login"}


def test_api_provider_with_key(client):
    lite_server.save_settings({"provider": "api", "anthropic_api_key": "sk-ant-x"})
    body = client.get("/readiness").json()
    assert body["provider"] == "api" and body["ready"] is True


def test_readiness_is_token_gated(client, monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    assert client.get("/readiness").status_code == 403
    assert (
        client.get("/readiness", headers={"X-Atelier-Token": "sekret"}).status_code
        == 200
    )


def test_login_probe_never_raises(monkeypatch):
    import subprocess as sp

    def _boom(*a, **k):
        raise OSError("no security binary")

    monkeypatch.setattr(sp, "run", _boom)
    assert lite_server._subscription_login_present() in (True, False)


# ── the auth-failure message points at setup, not a stack trace ───────────────


@pytest.mark.parametrize("raw", [
    "Invalid API key . Please run /login",
    "Command failed: authentication_error 401 Unauthorized",
    "OAuth token has expired",
])
def test_auth_failures_get_setup_message(raw):
    msg = lite_server._friendly_turn_error(raw)
    assert "not signed in" in msg
    assert "Set up your model" in msg
    assert "exit code" not in msg


def test_generic_errors_keep_original_wording():
    msg = lite_server._friendly_turn_error("something exploded")
    assert "something exploded" in msg


def test_interrupts_still_win_over_auth_wording():
    # exit code 143 must stay an interruption even if the CLI's last words
    # mention credentials somewhere
    msg = lite_server._friendly_turn_error("Command failed with exit code 143")
    assert "interrupted" in msg
