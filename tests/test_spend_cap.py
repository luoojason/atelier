"""The per-provider daily spend cap (spend.py) and its enforcement in both
external-lane paths: the LiteLLM tool loop and plain forward() chat.

The cap is mandatory-by-default ($5/provider/day), settable via
POST /config/spend-cap, and 0 disables it. Loopback hosts are never metered.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import external_loop  # noqa: E402
import lite_server  # noqa: E402
import spend  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_ledger(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_SPEND_PATH", str(tmp_path / "spend.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


@pytest.fixture
def client():
    return TestClient(lite_server.app)


# ── spend.py unit behavior ────────────────────────────────────────────────────


def test_default_cap_is_five_dollars():
    assert spend.cap_usd({}) == 5.0
    assert spend.cap_usd({"spend_cap_usd": "garbage"}) == 5.0
    assert spend.cap_usd(None) == spend.cap_usd(spend._read_settings())


def test_cap_zero_disables():
    assert spend.cap_usd({"spend_cap_usd": 0}) == 0.0
    ok, _, cap = spend.allowed("api.openai.com", {"spend_cap_usd": 0})
    assert ok is True and cap == 0.0


def test_record_and_spent_today_accumulate():
    spend.record("api.openai.com", 1.25)
    spend.record("api.openai.com", 0.75)
    spend.record("other.host", 0.10)
    assert spend.spent_today("api.openai.com") == pytest.approx(2.0)
    assert spend.spent_today("other.host") == pytest.approx(0.10)


def test_record_ignores_garbage_and_nonpositive():
    spend.record("h", -1)
    spend.record("h", "nan-ish")
    spend.record("", 5)
    assert spend.spent_today("h") == 0.0


def test_allowed_flips_at_cap():
    spend.record("api.openai.com", 4.99)
    ok, spent, cap = spend.allowed("api.openai.com", {"spend_cap_usd": 5})
    assert ok is True
    spend.record("api.openai.com", 0.02)
    ok, spent, cap = spend.allowed("api.openai.com", {"spend_cap_usd": 5})
    assert ok is False and spent == pytest.approx(5.01) and cap == 5.0


def test_stale_ledger_date_resets(tmp_path):
    path = tmp_path / "spend.json"
    path.write_text(json.dumps({"date": "2000-01-01", "providers": {"h": 99.0}}))
    assert spend.spent_today("h") == 0.0


def test_corrupt_ledger_never_raises(tmp_path):
    (tmp_path / "spend.json").write_text("{not json")
    assert spend.spent_today("h") == 0.0
    spend.record("h", 1.0)  # must not raise
    assert spend.spent_today("h") == 1.0


def test_metered_classification():
    assert spend.is_metered("https://api.openai.com/v1") is True
    assert spend.is_metered("http://127.0.0.1:11434/v1") is False
    assert spend.is_metered("http://localhost:1234/v1") is False
    assert spend.is_metered("http://192.168.1.20:8080/v1") is True  # LAN box: remote
    assert spend.provider_host("https://API.OpenAI.com:443/v1") == "api.openai.com"


# ── the tool loop stops at the cap ────────────────────────────────────────────


class _Msg:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls


class _Resp:
    def __init__(self, msg):
        self.choices = [type("C", (), {"message": msg})()]
        self.usage = {"prompt_tokens": 10, "completion_tokens": 5}


def _agent(base="https://api.openai.com/v1"):
    return {"id": "x", "name": "X", "base_url": base, "model": "gpt-4o", "api_key": "k"}


def test_loop_refuses_when_cap_reached(monkeypatch):
    spend.record("api.openai.com", 99.0)

    async def _boom(**kwargs):  # must never be called
        raise AssertionError("provider called past the cap")

    monkeypatch.setattr(external_loop.litellm, "acompletion", _boom)
    out = asyncio.run(
        external_loop.run_external_turn(
            _agent(), "hi", [], [], {}, settings={"spend_cap_usd": 5}
        )
    )
    assert out["error"] == "spend-cap"
    assert out["response"] is None


def test_loop_runs_and_records_cost(monkeypatch):
    async def _ok(**kwargs):
        return _Resp(_Msg(content="done"))

    monkeypatch.setattr(external_loop.litellm, "acompletion", _ok)
    monkeypatch.setattr(
        external_loop.litellm, "completion_cost", lambda completion_response: 0.42
    )
    out = asyncio.run(
        external_loop.run_external_turn(
            _agent(), "hi", [], [], {}, settings={"spend_cap_usd": 5}
        )
    )
    assert out["response"] == "done" and out["error"] is None
    assert spend.spent_today("api.openai.com") == pytest.approx(0.42)


def test_loop_local_host_never_metered(monkeypatch):
    spend.record("127.0.0.1", 99.0)  # even a poisoned ledger entry must not gate

    async def _ok(**kwargs):
        return _Resp(_Msg(content="done"))

    monkeypatch.setattr(external_loop.litellm, "acompletion", _ok)
    out = asyncio.run(
        external_loop.run_external_turn(
            _agent("http://127.0.0.1:11434/v1"), "hi", [], [], {},
            settings={"spend_cap_usd": 5},
        )
    )
    assert out["response"] == "done" and out["error"] is None


def test_loop_unpriceable_model_records_nothing(monkeypatch):
    async def _ok(**kwargs):
        return _Resp(_Msg(content="done"))

    def _raise(completion_response):
        raise ValueError("unknown model")

    monkeypatch.setattr(external_loop.litellm, "acompletion", _ok)
    monkeypatch.setattr(external_loop.litellm, "completion_cost", _raise)
    out = asyncio.run(
        external_loop.run_external_turn(
            _agent(), "hi", [], [], {}, settings={"spend_cap_usd": 5}
        )
    )
    assert out["response"] == "done"
    assert spend.spent_today("api.openai.com") == 0.0


# ── plain forward() gets the same gate ────────────────────────────────────────


def test_forward_refuses_when_cap_reached(monkeypatch, tmp_path):
    import external_agents as ea

    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "agents.json"))
    ok, agent = ea.upsert({"name": "X", "base_url": "https://api.openai.com/v1", "model": "gpt-4o"})
    assert ok, agent
    agent_id = agent["id"]
    spend.record("api.openai.com", 99.0)

    ok, text = asyncio.run(ea.forward(agent_id, "hi"))
    assert ok is False
    assert "cap" in text and "api.openai.com" in text


# ── settings + route surface ──────────────────────────────────────────────────


def test_config_exposes_effective_cap(monkeypatch, tmp_path, client):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    assert client.get("/config").json()["spend_cap_usd"] == 5.0


def test_spend_cap_route_persists_and_survives_merges(monkeypatch, tmp_path, client):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    r = client.post("/config/spend-cap", json={"cap": 12.5})
    assert r.status_code == 200 and r.json() == {"ok": True, "spend_cap_usd": 12.5}
    assert client.get("/config").json()["spend_cap_usd"] == 12.5
    # an unrelated settings write must NOT wipe the cap (load_settings allowlist)
    client.post("/config/vault", json={"path": str(tmp_path)})
    assert client.get("/config").json()["spend_cap_usd"] == 12.5


def test_spend_cap_route_zero_disables_and_bounds(monkeypatch, tmp_path, client):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    assert client.post("/config/spend-cap", json={"cap": 0}).status_code == 200
    assert client.get("/config").json()["spend_cap_usd"] == 0.0
    assert client.post("/config/spend-cap", json={"cap": -1}).status_code == 400
    assert client.post("/config/spend-cap", json={"cap": 20000}).status_code == 400
