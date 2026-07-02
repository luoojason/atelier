"""Notion + vault config wiring: build_options gating + (Part C) config routes."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lite_server  # noqa: E402


def _settings(tmp_path, obj):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return p


def test_load_settings_preserves_notion_and_vault(tmp_path):
    _settings(tmp_path, {"provider": "subscription",
                         "notion_token": "secret_x", "obsidian_vault": "/tmp"})
    s = lite_server.load_settings()
    assert s["notion_token"] == "secret_x"
    assert s["obsidian_vault"] == "/tmp"


def test_build_options_attaches_notion_when_token_set(tmp_path):
    _settings(tmp_path, {"provider": "subscription", "notion_token": "secret_x"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" in opts.allowed_tools
    assert "Notion" in opts.system_prompt


def test_build_options_omits_notion_without_token(tmp_path):
    _settings(tmp_path, {"provider": "subscription"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" not in opts.allowed_tools


import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return TestClient(lite_server.app)


def test_config_reports_notion_and_vault(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    body = c.get("/config").json()
    assert body["notion_connected"] is False
    assert body["obsidian_vault"] == ""
    r = c.post("/config/notion-token", json={"token": "secret_abcd1234"})
    assert r.json()["notion_connected"] is True
    body = c.get("/config").json()
    assert body["notion_connected"] is True
    assert body["notion_token_hint"].endswith("1234")
    assert "secret_abcd1234" not in json.dumps(body)  # never the full token


def test_set_and_delete_notion_token(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    c.post("/config/notion-token", json={"token": "secret_z"})
    assert lite_server.load_settings()["notion_token"] == "secret_z"
    c.delete("/config/notion-token")
    assert "notion_token" not in lite_server.load_settings()


def test_set_vault_validates_dir(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    good = tmp_path / "vault"
    good.mkdir()
    assert c.post("/config/vault", json={"path": str(good)}).json()["ok"] is True
    assert lite_server.load_settings()["obsidian_vault"] == str(good)
    bad = c.post("/config/vault", json={"path": str(tmp_path / "missing")})
    assert bad.status_code == 400


def test_validate_notion_token_mocked(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)

    class _Resp:
        status_code = 200

        def json(self):
            return {"bot": {"workspace_name": "My WS"}}

    class _FakeAsync:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsync)
    r = c.post("/config/notion-token/validate", json={"token": "secret_q"})
    assert r.json()["valid"] is True and r.json()["workspace"] == "My WS"


def test_vault_graph_route(tmp_path, monkeypatch):
    (tmp_path / "A.md").write_text("[[B]]", encoding="utf-8")
    (tmp_path / "B.md").write_text("hi", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    c = TestClient(lite_server.app)
    g = c.get("/vault/graph").json()
    assert {n["id"] for n in g["nodes"]} == {"A", "B"}
    assert {"source": "A", "target": "B"} in g["edges"]


def test_vault_note_route(tmp_path, monkeypatch):
    (tmp_path / "A.md").write_text("# Hello\nbody", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    c = TestClient(lite_server.app)
    assert "Hello" in c.get("/vault/note", params={"path": "A"}).json()["markdown"]
    assert c.get("/vault/note", params={"path": "nope"}).status_code == 404


def test_vault_gets_token_gated_when_token_set(tmp_path, monkeypatch):
    (tmp_path / "A.md").write_text("# Hello\nbody", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.setenv("ATELIER_TOKEN", "tok")
    c = TestClient(lite_server.app)

    # No header -> rejected, same shape as the mutating-method gate.
    no_token = c.get("/vault/graph")
    assert no_token.status_code == 403
    assert no_token.json() == {"detail": "missing or bad token"}
    no_token_note = c.get("/vault/note", params={"path": "A"})
    assert no_token_note.status_code == 403
    assert no_token_note.json() == {"detail": "missing or bad token"}

    # With the header -> the routes work as before.
    ok_graph = c.get("/vault/graph", headers={"X-Atelier-Token": "tok"})
    assert ok_graph.status_code == 200
    assert {n["id"] for n in ok_graph.json()["nodes"]} == {"A"}
    ok_note = c.get(
        "/vault/note", params={"path": "A"}, headers={"X-Atelier-Token": "tok"}
    )
    assert ok_note.status_code == 200
    assert "Hello" in ok_note.json()["markdown"]


def test_other_gets_not_token_gated(tmp_path, monkeypatch):
    """Sanity: the token gate is scoped to /vault/* only, not every GET."""
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.setenv("ATELIER_TOKEN", "tok")
    c = TestClient(lite_server.app)
    assert c.get("/config").status_code == 200
    assert c.get("/health").status_code == 200
