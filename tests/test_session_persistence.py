"""Session disk persistence: a chat card + its sub-agent orchestration layer
must survive an app restart (backend half). Persist the ledgers to JSON on
mutation, reload on startup; the live client is NOT persisted (rebuilt lazily,
re-seeded by the r34 replay), and a mid-turn session reloads idle.

    .venv-ext/bin/python -m pytest -q tests/test_session_persistence.py
"""

import json
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402


@pytest.fixture(autouse=True)
def _iso(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_SESSIONS_PATH", str(tmp_path / "sessions.json"))
    monkeypatch.setattr(lite_server, "_sessions", {})


def _sess(sid, name, **kw):
    s = lite_server._AgentSession(sid, name, parent_id=kw.get("parent_id"), depth=kw.get("depth", 0))
    lite_server._sessions[s.id] = s
    return s


def test_persist_and_reload_round_trip():
    p = _sess("p" * 32, "Orchestrator")
    lite_server._append_session_message(p, "user", "build the layer")
    lite_server._append_session_message(p, "assistant", "spawning agents")
    c = _sess("c" * 32, "iris.notes", parent_id=p.id, depth=1)
    c.model = "haiku"
    lite_server._append_session_message(c, "user", "make a ranking video")

    lite_server._persist_sessions()
    lite_server._sessions.clear()          # simulate a restart
    lite_server._load_sessions()

    assert set(lite_server._sessions) == {p.id, c.id}
    rp = lite_server._sessions[p.id]
    assert rp.name == "Orchestrator"
    assert rp.client is None               # not persisted; rebuilt lazily
    assert rp.status == "idle"
    assert [m["text"] for m in rp.messages] == ["build the layer", "spawning agents"]
    rc = lite_server._sessions[c.id]
    assert rc.parent_id == p.id and rc.depth == 1
    assert rc.name == "iris.notes" and rc.model == "haiku"


def test_running_session_reloads_idle():
    s = _sess("a" * 32, "Agent")
    s.status = "running"                    # caught mid-turn at shutdown
    lite_server._persist_sessions()
    lite_server._sessions.clear()
    lite_server._load_sessions()
    assert lite_server._sessions["a" * 32].status == "idle"


def test_error_status_is_preserved():
    s = _sess("b" * 32, "Agent")
    s.status = "error"
    lite_server._persist_sessions()
    lite_server._sessions.clear()
    lite_server._load_sessions()
    assert lite_server._sessions["b" * 32].status == "error"


def test_load_missing_file_is_a_noop():
    lite_server._load_sessions()            # file does not exist yet
    assert lite_server._sessions == {}


def test_load_corrupt_file_is_a_noop(tmp_path):
    open(lite_server._sessions_file(), "w").write("{ not json")
    lite_server._load_sessions()
    assert lite_server._sessions == {}


def test_load_skips_corrupt_records_keeps_good_ones():
    with open(lite_server._sessions_file(), "w") as f:
        json.dump({"v": 1, "sessions": [
            {"id": "good" * 8, "name": "Keep", "messages": [{"role": "user", "text": "hi"}]},
            {"name": "no id"},               # missing id -> skipped
            "not a dict",                    # skipped
        ]}, f)
    lite_server._load_sessions()
    assert set(lite_server._sessions) == {"good" * 8}


def test_message_cap_on_reload(monkeypatch):
    monkeypatch.setattr(lite_server, "_MAX_SESSION_MESSAGES", 3)
    with open(lite_server._sessions_file(), "w") as f:
        json.dump({"v": 1, "sessions": [{
            "id": "x" * 32, "name": "A",
            "messages": [{"role": "user", "text": str(i)} for i in range(10)],
        }]}, f)
    lite_server._load_sessions()
    msgs = lite_server._sessions["x" * 32].messages
    assert len(msgs) == 3 and [m["text"] for m in msgs] == ["7", "8", "9"]  # most recent kept


def test_routes_persist_create_and_delete(monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setattr(lite_server, "_chat_client", None)
    client = TestClient(lite_server.app)
    sid = client.post("/sessions", json={"name": "Card"}).json()["id"]
    # the file now holds the created session
    data = json.load(open(lite_server._sessions_file()))
    assert any(s["id"] == sid for s in data["sessions"])
    client.delete(f"/sessions/{sid}")
    data = json.load(open(lite_server._sessions_file()))
    assert not any(s["id"] == sid for s in data["sessions"])


def test_lifespan_shutdown_flushes_sessions():
    # A clean app quit SIGTERMs the backend, unwinding the FastAPI lifespan. That
    # teardown clears _sessions, so it MUST persist first — otherwise a session
    # created since the last per-turn save would be lost on close.
    from fastapi.testclient import TestClient

    s = _sess("life" * 8, "LifeTest")
    s.messages = [{"role": "user", "text": "remember me"}]
    with TestClient(lite_server.app):
        pass  # context exit unwinds the lifespan -> shutdown flush + teardown

    data = json.load(open(lite_server._sessions_file()))
    assert ("life" * 8) in [r["id"] for r in data["sessions"]]
