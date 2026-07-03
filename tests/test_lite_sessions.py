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

        # async-context-manager support so this fake also drives the untracked
        # `async with ClaudeSDKClient(...)` compat path (r24), not just the
        # tracked connect()/disconnect() session path.
        async def __aenter__(self):
            await self.connect()
            return self

        async def __aexit__(self, *exc):
            await self.disconnect()

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
        assert set(s) == {
            "id", "name", "status", "messages_len", "parent_id", "depth",
            "job_name",
        }
        assert s["status"] == "idle"
        assert s["messages_len"] == 0
        # card-created sessions are always depth-0 roots
        assert s["parent_id"] is None
        assert s["depth"] == 0
        assert s["job_name"] is None  # only fired scheduled jobs set this

    detail = client.get(f"/sessions/{made['id']}").json()
    assert detail == {
        "id": made["id"], "name": "Research", "status": "idle", "messages": [],
        "parent_id": None, "depth": 0, "model": None, "job_name": None,
        "browser_nav": None, "canvas_ops": [],
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


def test_session_model_reaches_the_sdk_client(monkeypatch, client):
    monkeypatch.setattr(lite_server, "_resolved_model", lambda: "sonnet")
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    lite_server._sessions[sid].model = "haiku"  # per-session override
    client.post(f"/sessions/{sid}/message", json={"message": "hi"})
    assert built[0].options.model == "haiku"


def test_session_without_model_uses_global(monkeypatch, client):
    monkeypatch.setattr(lite_server, "_resolved_model", lambda: "sonnet")
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    client.post(f"/sessions/{sid}/message", json={"message": "hi"})
    assert built[0].options.model == "sonnet"


def test_create_accepts_allowlisted_model(client):
    r = client.post("/sessions", json={"name": "R", "model": "opus"})
    assert r.status_code == 200
    assert lite_server._sessions[r.json()["id"]].model == "opus"


def test_create_rejects_unknown_model(client):
    r = client.post("/sessions", json={"model": "gpt-4o"})
    assert r.status_code == 400
    assert r.json() == {"error": "unknown model"}
    assert lite_server._sessions == {}  # nothing created on a rejected model


def test_create_without_model_defaults_to_none(client):
    sid = _create(client)["id"]
    assert lite_server._sessions[sid].model is None


def test_set_session_model_happy_path(client):
    sid = _create(client)["id"]
    r = client.post(f"/sessions/{sid}/model", json={"model": "haiku"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "model": "haiku"}
    assert lite_server._sessions[sid].model == "haiku"


def test_set_session_model_unknown_session_404(client):
    r = client.post("/sessions/nope/model", json={"model": "haiku"})
    assert r.status_code == 404
    assert r.json() == {"error": "unknown session"}


def test_set_session_model_rejects_unknown_model(client):
    sid = _create(client)["id"]
    r = client.post(f"/sessions/{sid}/model", json={"model": "gpt-4o"})
    assert r.status_code == 400
    assert r.json() == {"error": "unknown model"}
    assert lite_server._sessions[sid].model is None  # unchanged


def test_get_session_surfaces_model(client):
    sid = _create(client)["id"]
    assert client.get(f"/sessions/{sid}").json()["model"] is None
    client.post(f"/sessions/{sid}/model", json={"model": "opus"})
    assert client.get(f"/sessions/{sid}").json()["model"] == "opus"


def test_set_session_model_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    hdr = {"X-Atelier-Token": "sekret"}
    sid = client.post("/sessions", json={}, headers=hdr).json()["id"]
    assert client.post(
        f"/sessions/{sid}/model", json={"model": "opus"}
    ).status_code == 403
    r = client.post(
        f"/sessions/{sid}/model", json={"model": "opus"}, headers=hdr
    )
    assert r.status_code == 200
    assert lite_server._sessions[sid].model == "opus"


# ── mid-turn model change (pending_model_reset) ───────────────────────────────

def test_set_session_model_while_running_defers_reset(client):
    """A model change POSTed while status=='running' must NOT touch the
    client the in-flight turn is already using — it defers the drop via
    pending_model_reset so the CURRENT turn finishes on its original client
    and only the NEXT turn picks up the new model."""
    sid = _create(client)["id"]
    sess = lite_server._sessions[sid]

    class _FakeClient:
        def __init__(self):
            self.disconnected = False

        async def disconnect(self):
            self.disconnected = True

    fake = _FakeClient()
    sess.client = fake
    sess.status = "running"

    r = client.post(f"/sessions/{sid}/model", json={"model": "haiku"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "model": "haiku"}
    assert sess.model == "haiku"
    assert sess.pending_model_reset is True
    assert sess.client is fake  # untouched — the running turn keeps using it
    assert fake.disconnected is False


def test_set_session_model_while_idle_keeps_resetting_immediately(client):
    """Regression guard: the idle path must stay exactly as before — the
    client drops right away and pending_model_reset never gets set."""
    sid = _create(client)["id"]
    sess = lite_server._sessions[sid]

    class _FakeClient:
        def __init__(self):
            self.disconnected = False

        async def disconnect(self):
            self.disconnected = True

    fake = _FakeClient()
    sess.client = fake
    assert sess.status == "idle"

    r = client.post(f"/sessions/{sid}/model", json={"model": "haiku"})
    assert r.status_code == 200
    assert sess.pending_model_reset is False
    assert sess.client is None
    assert fake.disconnected is True


def test_pending_model_reset_drops_client_after_turn_settles(monkeypatch, client):
    """End-to-end: a pending_model_reset raised mid-turn (simulating the
    concurrent POST /sessions/{id}/model from test above) is honored by
    _run_session_turn's finally block — the stale client is dropped and the
    flag clears, so the NEXT turn rebuilds a fresh client (the model change
    actually takes effect one turn later, per the fix)."""
    built = []
    sid_holder = {}

    def _raise_pending_mid_turn(message):
        # Runs INSIDE the turn (sess.status is genuinely "running" here, same
        # idiom as test_message_202_then_poll_shows_reply_and_idle's _probe).
        lite_server._sessions[sid_holder["sid"]].pending_model_reset = True

    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient",
        _scripted_client_factory(built=built, on_query=_raise_pending_mid_turn),
    )
    _inline_turns(monkeypatch)

    sid = _create(client)["id"]
    sid_holder["sid"] = sid

    assert client.post(
        f"/sessions/{sid}/message", json={"message": "hello"}
    ).status_code == 202

    polled = client.get(f"/sessions/{sid}").json()
    assert polled["status"] == "idle"
    assert lite_server._sessions[sid].pending_model_reset is False
    assert lite_server._sessions[sid].client is None
    assert built[0].disconnected is True

    # the next turn rebuilds a brand-new client — proof the change takes
    assert client.post(
        f"/sessions/{sid}/message", json={"message": "again"}
    ).status_code == 202
    assert len(built) == 2
    assert built[1] is not built[0]


# ── governance links: cycle helper + POST/DELETE /sessions/{id}/govern ────────

def test_governs_cycle_helper_walks_parent_chain():
    # _fresh_state (autouse) already reset _sessions to {}; build a chain A->B->C
    a = lite_server._AgentSession("a" * 32, "A")
    b = lite_server._AgentSession("b" * 32, "B", parent_id=a.id, depth=1)
    c = lite_server._AgentSession("c" * 32, "C", parent_id=b.id, depth=2)
    for s in (a, b, c):
        lite_server._sessions[s.id] = s

    # A is an ancestor of C, so governing A UNDER C would close A->B->C->A
    assert lite_server._governs_cycle(c.id, a.id) is True
    # governing C under A is a fresh downward link — no cycle
    assert lite_server._governs_cycle(a.id, c.id) is False
    # self trivially cycles (the walk starts at parent_id == child_id)
    assert lite_server._governs_cycle(a.id, a.id) is True
    # an unrelated node never cycles
    d = lite_server._AgentSession("d" * 32, "D")
    lite_server._sessions[d.id] = d
    assert lite_server._governs_cycle(a.id, d.id) is False


def test_govern_sets_parent_id_and_depth(client):
    parent = _create(client, name="A")["id"]
    child = _create(client, name="B")["id"]

    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": child})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    detail = client.get(f"/sessions/{child}").json()
    assert detail["parent_id"] == parent
    assert detail["depth"] == 1

    # nesting deepens: govern a grandchild under the depth-1 child -> depth 2
    grand = _create(client, name="C")["id"]
    assert client.post(
        f"/sessions/{child}/govern", json={"child_id": grand}
    ).json() == {"ok": True}
    assert client.get(f"/sessions/{grand}").json()["depth"] == 2


def test_govern_re_govern_moves_child_to_new_parent(client):
    p1 = _create(client, name="P1")["id"]
    p2 = _create(client, name="P2")["id"]
    child = _create(client, name="B")["id"]

    assert client.post(f"/sessions/{p1}/govern", json={"child_id": child}).status_code == 200
    assert client.post(f"/sessions/{p2}/govern", json={"child_id": child}).status_code == 200
    # single-parent invariant: the child now points at p2, not p1
    assert client.get(f"/sessions/{child}").json()["parent_id"] == p2


def test_govern_unknown_parent_is_400(client):
    child = _create(client, name="B")["id"]
    resp = client.post("/sessions/nope/govern", json={"child_id": child})
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown session"}


def test_govern_unknown_child_is_400(client):
    parent = _create(client, name="A")["id"]
    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": "nope"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown session"}


def test_govern_self_is_400(client):
    a = _create(client, name="A")["id"]
    resp = client.post(f"/sessions/{a}/govern", json={"child_id": a})
    assert resp.status_code == 400
    assert resp.json() == {"error": "cannot govern self"}


def test_govern_cycle_across_chain_is_400(client):
    a = _create(client, name="A")["id"]
    b = _create(client, name="B")["id"]
    c = _create(client, name="C")["id"]
    assert client.post(f"/sessions/{a}/govern", json={"child_id": b}).status_code == 200
    assert client.post(f"/sessions/{b}/govern", json={"child_id": c}).status_code == 200
    # C governing A would close A->B->C->A
    resp = client.post(f"/sessions/{c}/govern", json={"child_id": a})
    assert resp.status_code == 400
    assert resp.json() == {"error": "would create a cycle"}


def test_govern_child_limit_reached_is_400(client):
    parent = _create(client, name="P")["id"]
    kids = [
        _create(client, name=f"K{i}")["id"]
        for i in range(lite_server._MAX_CHILDREN)
    ]
    for k in kids:
        assert client.post(
            f"/sessions/{parent}/govern", json={"child_id": k}
        ).status_code == 200
    extra = _create(client, name="extra")["id"]
    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": extra})
    assert resp.status_code == 400
    assert resp.json() == {"error": "child limit reached"}


def test_govern_max_depth_reached_is_400(client):
    # build a full chain L0(0)->L1(1)->...->L_MAXDEPTH(_MAX_DEPTH)
    ids = [
        _create(client, name=f"L{i}")["id"]
        for i in range(lite_server._MAX_DEPTH + 1)
    ]
    for parent, child in zip(ids, ids[1:]):
        assert client.post(
            f"/sessions/{parent}/govern", json={"child_id": child}
        ).status_code == 200
    assert client.get(f"/sessions/{ids[-1]}").json()["depth"] == lite_server._MAX_DEPTH
    # one more level would be depth _MAX_DEPTH + 1 -> rejected
    extra = _create(client, name="deep")["id"]
    resp = client.post(f"/sessions/{ids[-1]}/govern", json={"child_id": extra})
    assert resp.status_code == 400
    assert resp.json() == {"error": "max depth reached"}


def test_ungovern_clears_parent_id_and_depth(client):
    parent = _create(client, name="A")["id"]
    child = _create(client, name="B")["id"]
    assert client.post(
        f"/sessions/{parent}/govern", json={"child_id": child}
    ).status_code == 200

    resp = client.delete(f"/sessions/{parent}/govern/{child}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    detail = client.get(f"/sessions/{child}").json()
    assert detail["parent_id"] is None
    assert detail["depth"] == 0

    # idempotent: a second ungovern still succeeds
    assert client.delete(
        f"/sessions/{parent}/govern/{child}"
    ).json() == {"ok": True}


def test_ungovern_wrong_parent_does_not_detach_real_parent(client):
    """A DELETE naming a session that is NOT the child's actual parent must
    be a no-op on the child (still idempotent {"ok": true}, not an error) —
    it must never clear a link it doesn't own. The correct parent's DELETE
    still detaches normally."""
    real_parent = _create(client, name="Real")["id"]
    other = _create(client, name="Other")["id"]
    child = _create(client, name="Child")["id"]
    assert client.post(
        f"/sessions/{real_parent}/govern", json={"child_id": child}
    ).status_code == 200

    resp = client.delete(f"/sessions/{other}/govern/{child}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    detail = client.get(f"/sessions/{child}").json()
    assert detail["parent_id"] == real_parent  # untouched by the mismatched DELETE
    assert detail["depth"] == 1

    resp2 = client.delete(f"/sessions/{real_parent}/govern/{child}")
    assert resp2.status_code == 200
    assert resp2.json() == {"ok": True}
    detail2 = client.get(f"/sessions/{child}").json()
    assert detail2["parent_id"] is None
    assert detail2["depth"] == 0


def test_ungovern_unknown_child_is_404(client):
    parent = _create(client, name="A")["id"]
    resp = client.delete(f"/sessions/{parent}/govern/nope")
    assert resp.status_code == 404
    assert resp.json() == {"error": "unknown session"}


# ── r24: scheduled jobs surface as tracked, revealable sessions ──────────────

def test_compat_with_job_name_creates_tracked_revealable_session(monkeypatch, client):
    # A NAMED job runs as a depth-0 session tagged with job_name, so the desktop
    # app can auto-reveal it as a live chat card; the {response} ledger shape is
    # preserved for the scheduler.
    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _scripted_client_factory())
    resp = client.post(
        "/open-swarm/get_response",
        json={"message": "brief me", "job_name": "morning-brief"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["response"] == "scripted reply"
    assert body.get("error") in (None, False)

    jobs = [s for s in client.get("/sessions").json()["sessions"] if s["job_name"]]
    assert len(jobs) == 1
    j = jobs[0]
    assert j["job_name"] == "morning-brief" and j["name"] == "morning-brief"
    assert j["depth"] == 0 and j["parent_id"] is None

    detail = client.get(f"/sessions/{j['id']}").json()
    assert detail["job_name"] == "morning-brief"
    roles = [(m["role"], m["text"]) for m in detail["messages"]]
    assert roles[0] == ("note", 'Scheduled job "morning-brief" fired')
    assert ("user", "brief me") in roles
    assert any(r == "assistant" for r, _ in roles)


def test_compat_without_job_name_stays_untracked(monkeypatch, client):
    # No job_name -> the legacy untracked one-shot: same reply, but NO session
    # is registered (the user's /sessions surface is untouched).
    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _scripted_client_factory())
    before = len(lite_server._sessions)
    resp = client.post("/open-swarm/get_response", json={"message": "hi"})
    assert resp.status_code == 200
    assert resp.json()["response"] == "scripted reply"
    assert len(lite_server._sessions) == before
    assert client.get("/sessions").json()["sessions"] == []


def test_job_session_error_preserves_ledger_shape(monkeypatch, client):
    # A job turn that raises still returns {response, error:True} (never a 500),
    # so the scheduler's summarize_response/ledger path is unchanged.
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient",
        _scripted_client_factory(query_error=RuntimeError("boom")),
    )
    resp = client.post(
        "/open-swarm/get_response",
        json={"message": "go", "job_name": "flaky-job"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is True
    assert "boom" in body["response"]
    # the session is still there (status error), revealable after the fact
    jobs = [s for s in client.get("/sessions").json()["sessions"] if s["job_name"]]
    assert len(jobs) == 1 and jobs[0]["status"] == "error"


def test_make_room_for_job_spares_user_cards(monkeypatch):
    import asyncio
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "2")
    user = lite_server._AgentSession("u", "User card")
    user.status = "idle"
    old_job = lite_server._AgentSession("j", "old-job")
    old_job.status = "idle"
    old_job.job_name = "old-job"
    lite_server._sessions["u"] = user
    lite_server._sessions["j"] = old_job
    # cap 2, full: a new job reclaims the finished JOB slot, never the user card
    assert asyncio.run(lite_server._make_room_for_job()) is True
    assert "u" in lite_server._sessions       # user card spared
    assert "j" not in lite_server._sessions   # old job reclaimed


def test_make_room_for_job_falls_back_when_only_user_cards(monkeypatch):
    import asyncio
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "1")
    user = lite_server._AgentSession("u", "User")
    user.status = "idle"
    lite_server._sessions["u"] = user
    # cap 1, full with a USER card and no job sessions -> no room, and the user
    # card is NOT evicted for a job (the job then runs untracked)
    assert asyncio.run(lite_server._make_room_for_job()) is False
    assert "u" in lite_server._sessions


def test_finished_job_session_drops_its_client_but_keeps_transcript(monkeypatch, client):
    # r24 review fix: a completed job lingers for viewing but must NOT hold a
    # live CLI subprocess — the client is dropped, the transcript is preserved.
    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _scripted_client_factory())
    resp = client.post(
        "/open-swarm/get_response", json={"message": "hi", "job_name": "j"}
    )
    assert resp.status_code == 200
    jobs = [s for s in lite_server._sessions.values() if s.job_name]
    assert len(jobs) == 1
    assert jobs[0].client is None                 # subprocess torn down
    assert jobs[0].status == "idle"
    # note + user + assistant all still readable for the revealed card
    roles = [m["role"] for m in jobs[0].messages]
    assert "note" in roles and "user" in roles and "assistant" in roles
