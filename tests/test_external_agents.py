"""External-agent connectors: config store CRUD, sanitization (key never leaks),
forwarding (OpenAI adapter, mocked httpx), and the HTTP routes incl. token gate."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio  # noqa: E402

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import external_agents as ea  # noqa: E402
import lite_server  # noqa: E402


def _store(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "ext.json"))


def _client(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return TestClient(lite_server.app)


# ── store + validation ──────────────────────────────────────────────────────────
def test_url_ok():
    assert ea._url_ok("http://127.0.0.1:5000")
    assert ea._url_ok("https://iris.example.com/v1")
    assert not ea._url_ok("ftp://x")
    assert not ea._url_ok("not a url")
    assert not ea._url_ok("")


def test_completions_url_normalizes():
    assert ea._completions_url("http://x:5000/v1") == "http://x:5000/v1/chat/completions"
    assert ea._completions_url("http://x:5000/v1/") == "http://x:5000/v1/chat/completions"
    # already a completions URL -> untouched
    assert (
        ea._completions_url("http://x/v1/chat/completions")
        == "http://x/v1/chat/completions"
    )
    # a query string is preserved on the query component, not folded into path
    assert (
        ea._completions_url("http://x/v1?key=abc")
        == "http://x/v1/chat/completions?key=abc"
    )


def test_completions_url_for_provider_preset_bases():
    # The connection presets (external.js) prefill these base URLs; every one must
    # resolve to the provider's real OpenAI-compatible endpoint by appending
    # /chat/completions to the PATH — including bases with no /v1 and Gemini's
    # /v1beta/openai path.
    cases = {
        "https://api.openai.com/v1": "https://api.openai.com/v1/chat/completions",
        "https://generativelanguage.googleapis.com/v1beta/openai":
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "https://api.deepseek.com": "https://api.deepseek.com/chat/completions",
        "https://api.perplexity.ai": "https://api.perplexity.ai/chat/completions",
        "https://api.groq.com/openai/v1": "https://api.groq.com/openai/v1/chat/completions",
        "https://openrouter.ai/api/v1": "https://openrouter.ai/api/v1/chat/completions",
    }
    for base, expected in cases.items():
        assert ea._completions_url(base) == expected, base


def test_url_ok_rejects_control_chars():
    # urlparse tolerates some control chars and httpx.URL later raises on others
    for bad in ("http://ho\tst", "http://h\x00ost", "http://ho\nst", "https://e\x7fx.com"):
        assert ea._url_ok(bad) is False


def test_forward_malformed_url_never_raises(tmp_path, monkeypatch):
    # even if a control-char URL somehow reaches the store, forward() must return
    # a (False, reason) tuple, never let httpx.InvalidURL escape as a 500.
    _store(tmp_path, monkeypatch)
    ea.save_agents([{"id": "1", "name": "n", "base_url": "http://ho\tst/v1",
                     "api_key": "", "model": "", "adapter": "openai"}])
    # load_agents drops it (control char), so forward sees "no longer configured"
    ok, text = asyncio.run(ea.forward("1", "hi"))
    assert ok is False and isinstance(text, str)


def test_upsert_creates_and_updates(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    ok, agent = ea.upsert({"name": "Iris", "base_url": "http://127.0.0.1:5000/v1"})
    assert ok and agent["name"] == "Iris" and agent["key_present"] is False
    aid = agent["id"]
    # update in place (same id) keeps a single record
    ok2, agent2 = ea.upsert({"id": aid, "name": "Iris v2", "base_url": "http://127.0.0.1:5000/v1"})
    assert ok2 and agent2["id"] == aid and agent2["name"] == "Iris v2"
    assert len(ea.load_agents()) == 1


def test_upsert_rejects_bad(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    assert ea.upsert({"name": "", "base_url": "http://x"})[0] is False
    assert ea.upsert({"name": "n", "base_url": "ftp://x"})[0] is False
    assert ea.upsert({"name": "n", "base_url": "http://x", "adapter": "weird"})[0] is False


def test_key_never_leaks_in_public_view(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    ok, agent = ea.upsert(
        {"name": "Hermes", "base_url": "http://h/v1", "api_key": "sk-supersecret9999"}
    )
    assert ok
    assert agent["key_present"] is True and agent["key_hint"] == "…9999"
    assert "supersecret" not in json.dumps(ea.list_public())
    # but the raw record (internal) keeps it for forwarding
    assert ea.load_agents()[0]["api_key"] == "sk-supersecret9999"


def test_update_without_key_keeps_stored_key(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    _, a = ea.upsert({"name": "n", "base_url": "http://x/v1", "api_key": "sk-keep-1234"})
    # editing the name with no api_key must NOT wipe the stored key
    ea.upsert({"id": a["id"], "name": "renamed", "base_url": "http://x/v1"})
    assert ea.load_agents()[0]["api_key"] == "sk-keep-1234"


def test_remove(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    _, a = ea.upsert({"name": "n", "base_url": "http://x/v1"})
    assert ea.remove(a["id"]) is True
    assert ea.remove(a["id"]) is False
    assert ea.load_agents() == []


def test_store_file_is_0600(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    ea.upsert({"name": "n", "base_url": "http://x/v1", "api_key": "sk-secret"})
    mode = (tmp_path / "ext.json").stat().st_mode & 0o777
    assert mode == 0o600


def test_load_drops_malformed(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    (tmp_path / "ext.json").write_text(
        json.dumps(
            {
                "agents": [
                    {"id": "1", "name": "ok", "base_url": "http://x/v1"},
                    {"id": "2", "name": "", "base_url": "http://x"},  # no name
                    {"id": "3", "name": "bad", "base_url": "ftp://x"},  # bad scheme
                    "not a dict",
                ]
            }
        ),
        encoding="utf-8",
    )
    assert [a["id"] for a in ea.load_agents()] == ["1"]


# ── forwarding (mock the external endpoint) ─────────────────────────────────────
class _FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _fake_client(captured, resp):
    class _FakeAsync:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            captured["json"] = json
            if isinstance(resp, Exception):
                raise resp
            return resp

    return _FakeAsync


def test_forward_openai_success(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    _, a = ea.upsert(
        {"name": "Iris", "base_url": "http://127.0.0.1:5000/v1",
         "api_key": "sk-abc", "model": "iris-1"}
    )
    captured = {}
    resp = _FakeResp(200, {"choices": [{"message": {"content": "hello from Iris"}}]})
    monkeypatch.setattr(httpx, "AsyncClient", _fake_client(captured, resp))
    ok, text = asyncio.run(
        ea.forward(a["id"], "hi", history=[{"role": "user", "content": "prev"}])
    )
    assert ok and text == "hello from Iris"
    assert captured["url"] == "http://127.0.0.1:5000/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-abc"
    assert captured["json"]["model"] == "iris-1"
    # history + new message both forwarded, in order
    assert [m["content"] for m in captured["json"]["messages"]] == ["prev", "hi"]


def test_forward_http_error(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    _, a = ea.upsert({"name": "n", "base_url": "http://x/v1"})
    monkeypatch.setattr(httpx, "AsyncClient", _fake_client({}, _FakeResp(503, {})))
    ok, text = asyncio.run(ea.forward(a["id"], "hi"))
    assert ok is False and "503" in text


def test_forward_connection_failure_no_key_leak(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    _, a = ea.upsert({"name": "n", "base_url": "http://x/v1", "api_key": "sk-topsecret"})
    monkeypatch.setattr(
        httpx, "AsyncClient", _fake_client({}, httpx.ConnectError("refused"))
    )
    ok, text = asyncio.run(ea.forward(a["id"], "hi"))
    assert ok is False and "sk-topsecret" not in text


def test_forward_unknown_agent(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    ok, text = asyncio.run(ea.forward("nope", "hi"))
    assert ok is False and "no longer configured" in text


# ── routes ──────────────────────────────────────────────────────────────────────
def test_routes_crud(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/external/agents").json() == {"agents": []}
    r = c.post("/external/agents", json={"name": "Iris", "base_url": "http://127.0.0.1:5000/v1"})
    assert r.json()["ok"] is True
    aid = r.json()["agent"]["id"]
    listed = c.get("/external/agents").json()["agents"]
    assert len(listed) == 1 and listed[0]["name"] == "Iris"
    assert c.request("DELETE", f"/external/agents/{aid}").json() == {"ok": True}
    assert c.get("/external/agents").json() == {"agents": []}


def test_route_upsert_rejects_bad_url(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/external/agents", json={"name": "n", "base_url": "ftp://x"})
    assert r.status_code == 400


def test_route_message_forwards(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    aid = c.post(
        "/external/agents", json={"name": "n", "base_url": "http://x/v1"}
    ).json()["agent"]["id"]
    resp = _FakeResp(200, {"choices": [{"message": {"content": "pong"}}]})
    monkeypatch.setattr(httpx, "AsyncClient", _fake_client({}, resp))
    r = c.post(f"/external/agents/{aid}/message", json={"message": "ping"})
    assert r.status_code == 200 and r.json()["response"] == "pong"


def test_route_message_failure_is_502(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    aid = c.post(
        "/external/agents", json={"name": "n", "base_url": "http://x/v1"}
    ).json()["agent"]["id"]
    monkeypatch.setattr(httpx, "AsyncClient", _fake_client({}, _FakeResp(500, {})))
    r = c.post(f"/external/agents/{aid}/message", json={"message": "ping"})
    assert r.status_code == 502 and "error" in r.json()


def test_routes_token_gated(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch)
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.setenv("ATELIER_TOKEN", "tok")
    c = TestClient(lite_server.app)
    # GET list IS token-gated (leaks base_url + key hints to a null-origin page)
    assert c.get("/external/agents").status_code == 403
    assert c.get("/external/agents", headers={"X-Atelier-Token": "tok"}).status_code == 200
    # POST without the token -> 403 (mutating-method gate)
    assert c.post("/external/agents", json={"name": "n", "base_url": "http://x/v1"}).status_code == 403
    # with the token -> works
    ok = c.post(
        "/external/agents",
        json={"name": "n", "base_url": "http://x/v1"},
        headers={"X-Atelier-Token": "tok"},
    )
    assert ok.status_code == 200


# ── granular tool grants (Round-2 P2) ─────────────────────────────────────────


def test_grants_default_all_true(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "a.json"))
    ok, agent = ea.upsert({"name": "G", "base_url": "https://api.openai.com/v1"})
    assert ok
    assert agent["tool_grants"] == {"files": True, "vault": True, "web": True, "memory": True}


def test_grants_persist_and_survive_unrelated_updates(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "a.json"))
    ok, agent = ea.upsert({"name": "G", "base_url": "https://api.openai.com/v1",
                           "tool_grants": {"files": False, "web": True}})
    assert ok
    aid = agent["id"]
    stored = next(a for a in ea.load_agents() if a["id"] == aid)
    assert stored["tool_grants"] == {"files": False, "vault": True, "web": True, "memory": True}
    # an update that omits tool_grants keeps the stored values
    ok, _ = ea.upsert({"id": aid, "name": "G2", "base_url": "https://api.openai.com/v1"})
    assert ok
    stored = next(a for a in ea.load_agents() if a["id"] == aid)
    assert stored["tool_grants"]["files"] is False
    assert stored["name"] == "G2"


def test_grants_in_public_view(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "a.json"))
    ea.upsert({"name": "G", "base_url": "https://api.openai.com/v1",
               "tool_grants": {"vault": False}})
    pub = ea.list_public()[0]
    assert pub["tool_grants"]["vault"] is False and pub["tool_grants"]["files"] is True


def test_normalize_grants_drops_unknown_keys():
    out = ea.normalize_grants({"files": 0, "bogus": True})
    assert out == {"files": False, "vault": True, "web": True, "memory": True}
