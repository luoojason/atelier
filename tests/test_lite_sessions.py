"""Tests for lite_server's multi-card agent sessions API (the /sessions routes)
via fastapi TestClient — no live server, no network (ClaudeSDKClient is
monkeypatched at its boundary, same style as test_lite_compat.py).

The contract under test (app/sessions.js fire-and-polls these shapes):
  * POST /sessions {"name"?} -> {"id","name"}; GET /sessions -> summaries;
    GET /sessions/{id} -> {id,name,status,messages:[{role,text,ts}]};
  * POST /sessions/{id}/message -> 202 {"status":"running"}, the turn runs as
    a task, and polling GET shows idle -> running -> idle with the assistant
    reply appended;
  * a second message mid-turn -> 409 {"error":"turn in progress"};
  * unknown ids -> 404 {"error":"unknown session"};
  * the cap (ATELIER_MAX_SESSIONS) evicts the least-recently-used idle
    session (disconnecting its client); all-running -> 409 {"error":"session
    limit"};
  * a failed/raising turn sets status "error" + an error-text assistant
    message — never a 500 — and does not block the next send;
  * sessions NEVER touch the long-lived chat client (poisoned here, like
    test_lite_compat does).

Determinism: the fire-and-poll task normally runs via asyncio.create_task
inside lite_server._spawn_session_turn (an async indirection). Tests
monkeypatch it to either await the turn INLINE (so the POST response returns
with the turn already settled — TestClient portals give each request its own
loop, so a real background task would be orphaned) or to swallow the
coroutine (so the session stays visibly "running" for the 409/eviction
cases). The idle->running transition is captured from INSIDE the fake
client's query(), which runs mid-turn.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py
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


# ── fakes ────────────────────────────────────────────────────────────────────

class _PoisonChatClient:
    """Any session touching the long-lived chat client fails the test loudly."""

    async def query(self, *a, **k):
        raise AssertionError("sessions must not touch the chat client")

    def receive_response(self):
        raise AssertionError("sessions must not touch the chat client")

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


def _scripted_client_factory(script=None, built=None, on_query=None,
                             query_error=None):
    """A ClaudeSDKClient replacement yielding a scripted message sequence.

    ``script`` is the message list every receive_response() replays (default:
    one "scripted reply" + success result). ``built`` collects instances,
    ``on_query`` fires mid-turn (the running-status probe), ``query_error``
    raises from query() (the wedged-transport case).
    """
    if script is None:
        script = [_assistant("scripted reply"), _result()]

    class _Client:
        def __init__(self, options=None):
            self.options = options
            self.connected = False
            self.disconnected = False
            self.queried = []
            if built is not None:
                built.append(self)

        async def connect(self):
            self.connected = True

        async def disconnect(self):
            self.disconnected = True

        async def query(self, message):
            self.queried.append(message)
            if on_query is not None:
                on_query(message)
            if query_error is not None:
                raise query_error

        async def receive_response(self):
            for msg in script:
                yield msg

    return _Client


def _inline_turns(monkeypatch):
    """Run each fired turn to completion INSIDE the POST request (deterministic)."""

    async def _run(coro):
        await coro

    monkeypatch.setattr(lite_server, "_spawn_session_turn", _run)


def _swallowed_turns(monkeypatch):
    """Never run the turn: the session stays 'running' (409/eviction cases)."""

    async def _swallow(coro):
        coro.close()

    monkeypatch.setattr(lite_server, "_spawn_session_turn", _swallow)


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch):
    monkeypatch.setattr(lite_server, "_sessions", {})
    monkeypatch.setattr(lite_server, "_chat_client", _PoisonChatClient())


def _create(client, name=None):
    body = {} if name is None else {"name": name}
    resp = client.post("/sessions", json=body)
    assert resp.status_code == 200
    return resp.json()


# ── shapes ───────────────────────────────────────────────────────────────────

def test_create_list_get_shapes(client):
    made = _create(client, name="Research")
    assert set(made) == {"id", "name"}
    assert made["name"] == "Research"

    auto = _create(client)  # no name -> 'Agent N'
    assert auto["name"].startswith("Agent ")

    listing = client.get("/sessions").json()
    assert set(listing) == {"sessions"}
    assert {s["id"] for s in listing["sessions"]} == {made["id"], auto["id"]}
    for s in listing["sessions"]:
        assert set(s) == {"id", "name", "status", "messages_len"}
        assert s["status"] == "idle"
        assert s["messages_len"] == 0

    detail = client.get(f"/sessions/{made['id']}").json()
    assert detail == {
        "id": made["id"], "name": "Research", "status": "idle", "messages": [],
    }


def test_unknown_session_is_404(client):
    for resp in (
        client.get("/sessions/nope"),
        client.post("/sessions/nope/message", json={"message": "hi"}),
        client.delete("/sessions/nope"),
    ):
        assert resp.status_code == 404
        assert resp.json() == {"error": "unknown session"}


# ── the fire-and-poll turn ───────────────────────────────────────────────────

def test_message_202_then_poll_shows_reply_and_idle(monkeypatch, client):
    sid_holder = {}
    seen_mid_turn = []

    def _probe(message):
        # runs INSIDE the turn: the session must be visibly "running" here
        seen_mid_turn.append(lite_server._sessions[sid_holder["sid"]].status)

    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient",
        _scripted_client_factory(on_query=_probe),
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    sid_holder["sid"] = sid
    assert client.get(f"/sessions/{sid}").json()["status"] == "idle"

    resp = client.post(f"/sessions/{sid}/message", json={"message": "hello"})
    assert resp.status_code == 202
    assert resp.json() == {"status": "running"}
    assert seen_mid_turn == ["running"]  # idle -> running observed mid-turn

    polled = client.get(f"/sessions/{sid}").json()
    assert polled["status"] == "idle"  # -> back to idle with the reply appended
    assert [(m["role"], m["text"]) for m in polled["messages"]] == [
        ("user", "hello"),
        ("assistant", "scripted reply"),
    ]
    assert all(m["ts"] for m in polled["messages"])

    listing = client.get("/sessions").json()["sessions"]
    assert listing[0]["messages_len"] == 2


def test_second_message_mid_turn_is_409(monkeypatch, client):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    _swallowed_turns(monkeypatch)  # the turn never settles: stays running

    sid = _create(client)["id"]
    assert client.post(
        f"/sessions/{sid}/message", json={"message": "one"}
    ).status_code == 202
    assert client.get(f"/sessions/{sid}").json()["status"] == "running"

    resp = client.post(f"/sessions/{sid}/message", json={"message": "two"})
    assert resp.status_code == 409
    assert resp.json() == {"error": "turn in progress"}
    # the rejected message was NOT appended
    messages = client.get(f"/sessions/{sid}").json()["messages"]
    assert [(m["role"], m["text"]) for m in messages] == [("user", "one")]


# ── error semantics ──────────────────────────────────────────────────────────

def test_failed_result_sets_error_status_and_error_message(monkeypatch, client):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient",
        _scripted_client_factory(script=[_result(is_error=True, result="rate limited")]),
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    resp = client.post(f"/sessions/{sid}/message", json={"message": "hi"})
    assert resp.status_code == 202  # never a 500

    polled = client.get(f"/sessions/{sid}").json()
    assert polled["status"] == "error"
    last = polled["messages"][-1]
    assert last["role"] == "assistant"
    assert "rate limited" in last["text"]

    # an errored session is not wedged: the next send is accepted
    assert client.post(
        f"/sessions/{sid}/message", json={"message": "again"}
    ).status_code == 202


def test_exception_during_turn_sets_error_and_drops_client(monkeypatch, client):
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient",
        _scripted_client_factory(
            built=built, query_error=RuntimeError("transport died")
        ),
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    resp = client.post(f"/sessions/{sid}/message", json={"message": "hi"})
    assert resp.status_code == 202  # never a 500

    polled = client.get(f"/sessions/{sid}").json()
    assert polled["status"] == "error"
    assert "transport died" in polled["messages"][-1]["text"]
    # the wedged client was disconnected + dropped so the next send reconnects
    assert built[0].disconnected is True
    assert lite_server._sessions[sid].client is None


# ── cap + eviction ───────────────────────────────────────────────────────────

def test_cap_evicts_lru_idle_session(monkeypatch, client):
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "3")
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    a = _create(client, name="A")["id"]
    b = _create(client, name="B")["id"]
    c = _create(client, name="C")["id"]

    # touch C, then B, then A -> C is the least-recently-used idle session,
    # even though it was created LAST (LRU, not FIFO). C also gets a client.
    for sid in (c, b, a):
        assert client.post(
            f"/sessions/{sid}/message", json={"message": "ping"}
        ).status_code == 202

    d = _create(client, name="D")["id"]  # at cap -> evicts C

    ids = {s["id"] for s in client.get("/sessions").json()["sessions"]}
    assert ids == {a, b, d}
    assert client.get(f"/sessions/{c}").status_code == 404
    assert built[0].disconnected is True  # C's client (built first) was closed


def test_cap_with_all_sessions_running_is_409(monkeypatch, client):
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "2")
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    _swallowed_turns(monkeypatch)  # both sessions stay running

    for sid in (_create(client)["id"], _create(client)["id"]):
        client.post(f"/sessions/{sid}/message", json={"message": "go"})

    resp = client.post("/sessions", json={})
    assert resp.status_code == 409
    assert resp.json() == {"error": "session limit"}


# ── delete + lifecycle ───────────────────────────────────────────────────────

def test_delete_session_disconnects_and_404s_after(monkeypatch, client):
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    client.post(f"/sessions/{sid}/message", json={"message": "hi"})

    resp = client.delete(f"/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert built[0].disconnected is True
    assert client.get(f"/sessions/{sid}").status_code == 404
    assert client.delete(f"/sessions/{sid}").status_code == 404


def test_lifespan_shutdown_disconnects_all_sessions(monkeypatch):
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    with TestClient(lite_server.app) as c:
        sid = c.post("/sessions", json={}).json()["id"]
        c.post(f"/sessions/{sid}/message", json={"message": "hi"})
        assert built[0].connected is True
    # context exit runs the lifespan shutdown
    assert built[0].disconnected is True
    assert lite_server._sessions == {}


# ── isolation ────────────────────────────────────────────────────────────────

def test_sessions_never_touch_the_chat_client(monkeypatch, client):
    # _fresh_state already poisoned _chat_client; a full create -> message ->
    # poll -> delete cycle must succeed without tripping the poison.
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    assert client.post(
        f"/sessions/{sid}/message", json={"message": "hi"}
    ).status_code == 202
    polled = client.get(f"/sessions/{sid}").json()
    assert polled["status"] == "idle"
    assert polled["messages"][-1]["text"] == "scripted reply"
    assert client.delete(f"/sessions/{sid}").json() == {"ok": True}
    # the poisoned chat client is still exactly what we installed — untouched
    assert isinstance(lite_server._chat_client, _PoisonChatClient)
