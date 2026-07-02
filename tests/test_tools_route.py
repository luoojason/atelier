"""Tests for lite_server's GET /tools (r16 Feature 2) — the read-only tool
registry the tool-inspector card renders: the 10 atelier LIGHT_TOOLS
introspected with the SAME schema builder sdk_tools uses to register them,
plus the orchestra tools (SpawnAgent/CheckAgent/NavigateBrowser) with their
declared schemas. Fixed shape, never 500, no token (read-only GET).

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_tools_route.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402
from shared_tools import sdk_tools  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


ENTRY_KEYS = {"name", "description", "input_schema", "server", "availability"}
ORCHESTRA_NAMES = {
    "SpawnAgent",
    "CheckAgent",
    "NavigateBrowser",
    "DelegateToSubagent",
}


@pytest.fixture
def client():
    return TestClient(lite_server.app)


def _tools(client):
    resp = client.get("/tools")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"tools"}
    return body["tools"]


# ── shape ────────────────────────────────────────────────────────────────────

def test_shape(client):
    tools = _tools(client)
    assert len(tools) == len(lite_server.LIGHT_TOOLS) + len(ORCHESTRA_NAMES)
    for entry in tools:
        assert set(entry) == ENTRY_KEYS
        assert isinstance(entry["name"], str) and entry["name"]
        assert isinstance(entry["description"], str) and entry["description"]
        assert isinstance(entry["input_schema"], dict)
        assert entry["server"] in ("atelier", "orchestra")


# ── the 10 atelier tools ─────────────────────────────────────────────────────

def test_all_ten_atelier_tools_present(client):
    assert len(lite_server.LIGHT_TOOLS) == 10  # the card counts on all 10
    atelier = [t for t in _tools(client) if t["server"] == "atelier"]
    assert {t["name"] for t in atelier} == {
        cls.__name__ for cls in lite_server.LIGHT_TOOLS
    }

    by_name = {t["name"]: t for t in atelier}
    for cls in lite_server.LIGHT_TOOLS:
        entry = by_name[cls.__name__]
        assert entry["availability"] == "all sessions"
        # description/schema come from the SAME introspection wrap_tool uses,
        # so the inspector can never drift from what the model sees
        assert entry["description"] == (cls.__doc__ or cls.__name__).strip()
        assert entry["input_schema"] == sdk_tools._build_input_schema(cls)


# ── the orchestra tools ──────────────────────────────────────────────────────

def test_orchestra_entries_present(client):
    orchestra = {
        t["name"]: t for t in _tools(client) if t["server"] == "orchestra"
    }
    assert set(orchestra) == ORCHESTRA_NAMES
    for entry in orchestra.values():
        assert entry["availability"] == "agent cards (depth 0)"
    assert orchestra["SpawnAgent"]["input_schema"]["required"] == ["task"]
    assert orchestra["CheckAgent"]["input_schema"]["required"] == ["agent_id"]
    assert orchestra["NavigateBrowser"]["input_schema"]["required"] == ["url"]
    assert "linked" in orchestra["NavigateBrowser"]["description"]
    assert orchestra["DelegateToSubagent"]["input_schema"]["required"] == [
        "subagent",
        "task",
    ]


# ── schemas carry properties/required ────────────────────────────────────────

def test_schemas_carry_properties_and_required(client):
    for entry in _tools(client):
        schema = entry["input_schema"]
        assert schema["type"] == "object"
        assert isinstance(schema["properties"], dict)
        assert isinstance(schema["required"], list)
        for prop in schema["properties"].values():
            assert "type" in prop
        # every required name really is a declared property
        assert set(schema["required"]) <= set(schema["properties"])


# ── no token + never 500 ─────────────────────────────────────────────────────

def test_open_with_token_set_and_never_500(client, monkeypatch):
    # read-only GET: stays open even when the token gate is armed
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    assert client.get("/tools").status_code == 200

    def _boom(parent_id):
        raise RuntimeError("introspection broke")

    monkeypatch.setattr(lite_server, "_orchestra_tools", _boom)
    resp = client.get("/tools")
    assert resp.status_code == 200
    assert resp.json() == {"tools": []}
