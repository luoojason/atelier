"""The daily spend cap on the Claude API-key path (completes #20's coverage:
the external lane got the cap first; this is the core agent's metered path).

Subscription mode never gates and never records. API mode records each turn's
ResultMessage.total_cost_usd against api.anthropic.com and refuses new turns
at the user-facing entries once today's total crosses the cap.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import lite_server  # noqa: E402
import spend  # noqa: E402


@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_SPEND_PATH", str(tmp_path / "spend.json"))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


def _api_mode():
    lite_server.save_settings({"provider": "api", "anthropic_api_key": "sk-ant-x"})


class _Result:
    def __init__(self, usd):
        self.total_cost_usd = usd


# ── recording ─────────────────────────────────────────────────────────────────


def test_records_turn_cost_in_api_mode():
    _api_mode()
    lite_server._record_api_cost(_Result(0.37))
    assert spend.spent_today("api.anthropic.com") == pytest.approx(0.37)


def test_subscription_mode_never_records():
    lite_server.save_settings({"provider": "subscription"})
    lite_server._record_api_cost(_Result(0.37))
    assert spend.spent_today("api.anthropic.com") == 0.0


def test_missing_cost_field_is_a_noop():
    _api_mode()
    lite_server._record_api_cost(object())
    assert spend.spent_today("api.anthropic.com") == 0.0


# ── gating ────────────────────────────────────────────────────────────────────


def test_no_gate_under_cap():
    _api_mode()
    spend.record("api.anthropic.com", 1.0)
    assert lite_server._api_cap_message() is None


def test_gate_message_at_cap():
    _api_mode()
    spend.record("api.anthropic.com", 99.0)
    msg = lite_server._api_cap_message()
    assert msg and "api.anthropic.com" in msg and "cap" in msg


def test_subscription_never_gates():
    lite_server.save_settings({"provider": "subscription"})
    spend.record("api.anthropic.com", 99.0)
    assert lite_server._api_cap_message() is None


# ── the entries refuse with the friendly pause ────────────────────────────────


def _cap_out(monkeypatch):
    _api_mode()
    spend.record("api.anthropic.com", 99.0)
    # if any gate leaks, the turn must not reach a real client
    async def _boom():
        raise AssertionError("a capped turn reached the chat client")
    monkeypatch.setattr(lite_server, "_get_chat_client", _boom)


def test_chat_refuses_at_cap(client, monkeypatch):
    _cap_out(monkeypatch)
    body = client.post("/chat", json={"message": "hi"}).json()
    assert body["error"] is True and "cap" in body["response"]


def test_chat_stream_refuses_pre_stream(client, monkeypatch):
    _cap_out(monkeypatch)
    resp = client.post("/chat/stream", json={"message": "hi"})
    assert resp.status_code == 429
    assert "cap" in resp.json()["error"]


def test_compat_route_refuses_at_cap(client, monkeypatch):
    _cap_out(monkeypatch)
    body = client.post("/atelier/get_response", json={"message": "hi"}).json()
    assert body["error"] is True and "cap" in body["response"]


def test_session_message_refuses_at_cap(client, monkeypatch):
    _cap_out(monkeypatch)
    made = client.post("/sessions", json={"note": "t"}).json()
    resp = client.post(f"/sessions/{made['id']}/message", json={"message": "hi"})
    assert resp.status_code == 429
    assert "cap" in resp.json()["error"]
