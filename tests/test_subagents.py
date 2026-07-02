"""Tests for lite_server's sub-agent orchestration (contract part B) — the
orchestra SpawnAgent/CheckAgent tools, parent_id/depth on the /sessions
surface, the factored _make_room / _start_turn helpers, and the structural
depth cap (only depth-0 sessions get the orchestra server) — plus the r16
NavigateBrowser tool (browser_nav on the parent session + the detail route).

Same idioms as test_lite_sessions.py: fastapi TestClient, ClaudeSDKClient
monkeypatched at its boundary, _spawn_session_turn monkeypatched to either a
capturing no-op (the coroutine is recorded + closed, so a spawned child stays
visibly "running") or an inline await (deterministic full turns). The tool
handlers are invoked DIRECTLY via lite_server._orchestra_tools(parent_id) —
exactly the closures _build_orchestra_server hands the SDK server.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_subagents.py
"""

import asyncio
import os
import re
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


# ── fakes + helpers ──────────────────────────────────────────────────────────

class _PoisonChatClient:
    """Any session touching the long-lived chat client fails the test loudly."""

    async def query(self, *a, **k):
        raise AssertionError("sessions must not touch the chat client")

    def receive_response(self):
        raise AssertionError("sessions must not touch the chat client")

    async def disconnect(self):
        pass


def _scripted_client_factory(built=None):
    """A ClaudeSDKClient replacement: one 'scripted reply' turn, records the
    options every instance was built with (the orchestra-gating probe)."""

    class _Client:
        def __init__(self, options=None):
            self.options = options
            if built is not None:
                built.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def query(self, message):
            pass

        async def receive_response(self):
            from claude_agent_sdk import (
                AssistantMessage, ResultMessage, TextBlock,
            )

            yield AssistantMessage(
                content=[TextBlock(text="scripted reply")], model="test"
            )
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1,
                is_error=False, num_turns=1, session_id="s", result=None,
            )

    return _Client


def _inline_turns(monkeypatch):
    """Run each fired turn to completion INSIDE the request (deterministic)."""

    async def _run(coro):
        await coro

    monkeypatch.setattr(lite_server, "_spawn_session_turn", _run)


def _handlers(parent_id):
    """The (SpawnAgent, CheckAgent, NavigateBrowser) handler coroutines bound
    to parent_id. Tolerates extra orchestra tools (DelegateToSubagent)."""
    spawn, check, nav, *_ = lite_server._orchestra_tools(parent_id)
    return spawn.handler, check.handler, nav.handler


def _delegate_handler(parent_id):
    """The DelegateToSubagent handler coroutine (the 4th orchestra tool)."""
    return lite_server._orchestra_tools(parent_id)[3].handler


def _call(handler, args):
    return asyncio.run(handler(args))


def _text(result):
    """Unwrap the wrap_tool-style {"content":[{"type":"text","text"}]} shape."""
    assert set(result) == {"content"}
    (block,) = result["content"]
    assert block["type"] == "text"
    return block["text"]


def _register_parent(status="running"):
    """A depth-0 parent session mid-turn (SpawnAgent always fires mid-turn)."""
    parent = lite_server._AgentSession("parent0000", "Card")
    parent.status = status
    lite_server._sessions[parent.id] = parent
    return parent


_SPAWNED_RE = re.compile(
    r'^Spawned sub-agent "(?P<name>[^"]+)" \(id: (?P<id>[0-9a-f]{32})\)\. '
    r"It is working now; call CheckAgent with this id to collect its result\.$"
)


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    monkeypatch.setattr(lite_server, "_sessions", {})
    monkeypatch.setattr(lite_server, "_chat_client", _PoisonChatClient())
    # hermetic: build_options must read a tmp settings file + config dir
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    monkeypatch.delenv("ATELIER_MAX_SESSIONS", raising=False)


@pytest.fixture
def captured(monkeypatch):
    """_spawn_session_turn as a capturing no-op: the child stays 'running'."""
    coros = []

    async def _capture(coro):
        coros.append(coro)
        coro.close()

    monkeypatch.setattr(lite_server, "_spawn_session_turn", _capture)
    return coros


@pytest.fixture
def client():
    return TestClient(lite_server.app)


# ── parent_id/depth on the /sessions surface ─────────────────────────────────

def test_list_and_detail_carry_parent_id_and_depth(client, captured):
    parent_id = client.post("/sessions", json={"name": "Card"}).json()["id"]
    lite_server._sessions[parent_id].status = "running"  # mid-turn spawner
    spawn, _, _ = _handlers(parent_id)
    reply = _text(_call(spawn, {"task": "dig into X", "name": "Scout"}))
    child_id = _SPAWNED_RE.match(reply).group("id")

    by_id = {
        s["id"]: s for s in client.get("/sessions").json()["sessions"]
    }
    assert by_id[parent_id]["parent_id"] is None
    assert by_id[parent_id]["depth"] == 0
    assert by_id[child_id]["parent_id"] == parent_id
    assert by_id[child_id]["depth"] == 1
    assert by_id[child_id]["status"] == "running"
    assert by_id[child_id]["messages_len"] == 1

    detail = client.get(f"/sessions/{child_id}").json()
    assert detail["parent_id"] == parent_id
    assert detail["depth"] == 1
    assert [(m["role"], m["text"]) for m in detail["messages"]] == [
        ("user", "dig into X"),
    ]


# ── SpawnAgent ───────────────────────────────────────────────────────────────

def test_spawn_creates_running_child_with_task_as_first_message(captured):
    parent = _register_parent()
    spawn, _, _ = _handlers(parent.id)

    reply = _text(_call(spawn, {"task": "summarize the vault", "name": " Scout "}))
    match = _SPAWNED_RE.match(reply)
    assert match and match.group("name") == "Scout"  # name was stripped

    child = lite_server._sessions[match.group("id")]
    assert child.parent_id == parent.id
    assert child.depth == 1
    assert child.status == "running"
    assert [(m["role"], m["text"]) for m in child.messages] == [
        ("user", "summarize the vault"),
    ]
    assert len(captured) == 1  # exactly one turn task fired for the child


def test_spawn_without_name_gets_subagent_counter_name(captured):
    parent = _register_parent()
    spawn, _, _ = _handlers(parent.id)
    reply = _text(_call(spawn, {"task": "t"}))
    assert _SPAWNED_RE.match(reply).group("name").startswith("Sub-agent ")


def test_spawn_child_cap_is_4(captured):
    parent = _register_parent()
    spawn, _, _ = _handlers(parent.id)

    for i in range(4):
        assert _SPAWNED_RE.match(_text(_call(spawn, {"task": f"t{i}"})))

    reply = _text(_call(spawn, {"task": "one too many"}))
    assert reply == (
        "Child limit (4) reached — use CheckAgent on your existing"
        " sub-agents instead."
    )
    children = [
        s for s in lite_server._sessions.values() if s.parent_id == parent.id
    ]
    assert len(children) == 4  # the fifth was never created


def test_spawn_with_parent_gone(captured):
    spawn, _, _ = _handlers("deadbeef00000000deadbeef00000000")
    assert _text(_call(spawn, {"task": "t"})) == (
        "Your session is gone; cannot spawn."
    )
    assert lite_server._sessions == {}  # nothing registered


def test_spawn_with_no_room_left(monkeypatch, captured):
    # cap 1, and the only session (the parent) is running -> _make_room False
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "1")
    parent = _register_parent(status="running")
    spawn, _, _ = _handlers(parent.id)
    assert _text(_call(spawn, {"task": "t"})) == (
        "Session limit reached — no room for a sub-agent right now."
    )
    assert list(lite_server._sessions) == [parent.id]  # parent NOT evicted


def test_spawn_parent_deleted_during_make_room(monkeypatch, captured):
    # TOCTOU guard: _make_room can suspend (awaiting a victim's disconnect);
    # a DELETE of the parent landing in that window must not leave an orphan
    # child registered and running at real token cost.
    parent = _register_parent()
    spawn, _, _ = _handlers(parent.id)

    async def _room_then_parent_gone():
        lite_server._sessions.pop(parent.id, None)  # the interleaved DELETE
        return True

    monkeypatch.setattr(lite_server, "_make_room", _room_then_parent_gone)
    assert _text(_call(spawn, {"task": "t"})) == (
        "Your session is gone; cannot spawn."
    )
    assert lite_server._sessions == {}  # no orphan child
    assert captured == []  # no turn fired


# ── CheckAgent ───────────────────────────────────────────────────────────────

def test_check_unknown_id(captured):
    parent = _register_parent()
    _, check, _ = _handlers(parent.id)
    assert _text(_call(check, {"agent_id": "nope"})) == (
        "No such sub-agent session."
    )


def test_check_foreign_session_is_unknown(captured):
    # containment: a live session that is NOT this parent's child (another
    # card, or a sibling parent's sub-agent) reads as unknown — one card's
    # model must never read another conversation through CheckAgent.
    parent = _register_parent()
    other_card = lite_server._AgentSession("othercard0", "Other card")
    lite_server._sessions[other_card.id] = other_card
    other_parent = lite_server._AgentSession("otherpar00", "Other parent")
    other_parent.status = "running"
    lite_server._sessions[other_parent.id] = other_parent
    other_spawn, _, _ = _handlers(other_parent.id)
    foreign_child_id = _SPAWNED_RE.match(
        _text(_call(other_spawn, {"task": "t"}))
    ).group("id")

    _, check, _ = _handlers(parent.id)
    for sid in (other_card.id, foreign_child_id, parent.id):
        assert _text(_call(check, {"agent_id": sid})) == (
            "No such sub-agent session."
        )


def test_check_running_child(captured):
    parent = _register_parent()
    spawn, check, _ = _handlers(parent.id)
    reply = _text(_call(spawn, {"task": "t", "name": "Scout"}))
    child_id = _SPAWNED_RE.match(reply).group("id")

    assert _text(_call(check, {"agent_id": child_id})) == (
        f'Sub-agent "Scout" ({child_id}) is still working (1 messages so far).'
    )


def test_check_finished_child_returns_last_reply(captured):
    parent = _register_parent()
    spawn, check, _ = _handlers(parent.id)
    child_id = _SPAWNED_RE.match(
        _text(_call(spawn, {"task": "t", "name": "Scout"}))
    ).group("id")
    child = lite_server._sessions[child_id]
    lite_server._append_session_message(child, "assistant", "the answer is 42")
    child.status = "idle"

    assert _text(_call(check, {"agent_id": child_id})) == (
        'Sub-agent "Scout" finished. Last reply: the answer is 42'
    )


def test_check_finished_with_error(captured):
    parent = _register_parent()
    spawn, check, _ = _handlers(parent.id)
    child_id = _SPAWNED_RE.match(
        _text(_call(spawn, {"task": "t", "name": "Scout"}))
    ).group("id")
    child = lite_server._sessions[child_id]
    lite_server._append_session_message(
        child, "assistant", "Atelier hit an error and could not finish that turn"
    )
    child.status = "error"

    assert _text(_call(check, {"agent_id": child_id})) == (
        'Sub-agent "Scout" finished with an error. Last reply: '
        "Atelier hit an error and could not finish that turn"
    )


def test_check_finished_with_no_reply(captured):
    parent = _register_parent()
    spawn, check, _ = _handlers(parent.id)
    child_id = _SPAWNED_RE.match(
        _text(_call(spawn, {"task": "t", "name": "Scout"}))
    ).group("id")
    child = lite_server._sessions[child_id]
    child.status = "idle"  # settled without any assistant message

    assert _text(_call(check, {"agent_id": child_id})) == (
        'Sub-agent "Scout" finished. Last reply: (no reply)'
    )


# ── NavigateBrowser ──────────────────────────────────────────────────────────

def test_navigate_sets_browser_nav_and_seq_increments(captured):
    parent = _register_parent()
    _, _, nav = _handlers(parent.id)
    assert parent.browser_nav is None

    reply = _text(_call(nav, {"url": "https://example.com/a"}))
    assert reply == (
        "Navigation requested — https://example.com/a will load in the"
        " browser card the user linked to this conversation (if none is"
        " linked, ask the user to shift-drag a box around a browser card and"
        " this card)."
    )
    first = parent.browser_nav
    assert set(first) == {"url", "seq"}
    assert first["url"] == "https://example.com/a"
    assert isinstance(first["seq"], int)

    # a second request (even a plain http one) strictly advances seq, so the
    # poller can distinguish it from the one it already acted on
    _call(nav, {"url": "http://example.org/b"})
    second = parent.browser_nav
    assert second["url"] == "http://example.org/b"
    assert second["seq"] == first["seq"] + 1


def test_navigate_rejects_non_http_urls(captured):
    parent = _register_parent()
    _, _, nav = _handlers(parent.id)
    for args in (
        {"url": "ftp://example.com"},
        {"url": "javascript:alert(1)"},
        {"url": "file:///etc/passwd"},
        {"url": "example.com"},
        {"url": ""},
        {},
    ):
        assert _text(_call(nav, args)) == "Only http(s) URLs can be opened."
    assert parent.browser_nav is None  # nothing was ever recorded


def test_navigate_with_parent_gone(captured):
    _, _, nav = _handlers("deadbeef00000000deadbeef00000000")
    assert _text(_call(nav, {"url": "https://example.com"})) == (
        "Your session is gone; cannot navigate."
    )


def test_detail_carries_browser_nav_and_list_does_not(client, captured):
    sid = client.post("/sessions", json={"name": "Card"}).json()["id"]
    assert client.get(f"/sessions/{sid}").json()["browser_nav"] is None

    _, _, nav = _handlers(sid)
    _call(nav, {"url": "https://example.com/page"})

    detail = client.get(f"/sessions/{sid}").json()
    assert detail["browser_nav"]["url"] == "https://example.com/page"
    assert detail["browser_nav"]["seq"] >= 1

    # the list route deliberately does NOT carry browser_nav
    for s in client.get("/sessions").json()["sessions"]:
        assert "browser_nav" not in s


def test_navigate_tool_description_mentions_the_link_requirement():
    _, _, nav_tool, *_ = lite_server._orchestra_tools("p")
    assert nav_tool.name == "NavigateBrowser"
    assert "linked" in nav_tool.description


# ── the structural depth cap ─────────────────────────────────────────────────

def test_build_options_without_spawner_has_no_orchestra():
    # the chat client (stream=True) and the compat route both build this shape
    for opts in (lite_server.build_options(), lite_server.build_options(stream=True)):
        assert "orchestra" not in opts.mcp_servers
        assert "atelier" in opts.mcp_servers
        assert not any(t.startswith("mcp__orchestra__") for t in opts.allowed_tools)


def test_build_options_with_spawner_gains_orchestra():
    opts = lite_server.build_options(spawner_session_id="abc123")
    assert "orchestra" in opts.mcp_servers
    assert "atelier" in opts.mcp_servers  # the base server is untouched
    assert "mcp__orchestra__SpawnAgent" in opts.allowed_tools
    assert "mcp__orchestra__CheckAgent" in opts.allowed_tools
    assert "mcp__orchestra__NavigateBrowser" in opts.allowed_tools
    # the base allowlist is intact alongside the orchestra tools
    assert set(lite_server.ATELIER_ALLOWED_TOOLS) <= set(opts.allowed_tools)


def test_depth0_turn_gets_orchestra_and_depth1_turn_does_not(
    monkeypatch, client
):
    built = []
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
    )
    _inline_turns(monkeypatch)

    # depth-0 card session: its lazy client is built WITH the orchestra
    sid = client.post("/sessions", json={"name": "Card"}).json()["id"]
    assert client.post(
        f"/sessions/{sid}/message", json={"message": "hi"}
    ).status_code == 202
    assert "orchestra" in built[0].options.mcp_servers
    assert "mcp__orchestra__SpawnAgent" in built[0].options.allowed_tools

    # depth-1 sub-agent session: NO orchestra, so it cannot spawn further
    child = lite_server._AgentSession(
        "c" * 32, "Scout", parent_id=sid, depth=1
    )
    lite_server._sessions[child.id] = child
    assert client.post(
        f"/sessions/{child.id}/message", json={"message": "task"}
    ).status_code == 202
    assert child.status == "idle"  # the scripted turn ran to completion
    assert "orchestra" not in built[1].options.mcp_servers
    assert not any(
        t.startswith("mcp__orchestra__") for t in built[1].options.allowed_tools
    )


# ── the raised session cap ───────────────────────────────────────────────────

def test_max_sessions_default_is_12(monkeypatch):
    monkeypatch.delenv("ATELIER_MAX_SESSIONS", raising=False)
    assert lite_server._max_sessions() == 12
    monkeypatch.setenv("ATELIER_MAX_SESSIONS", "not-a-number")
    assert lite_server._max_sessions() == 12


# ── DelegateToSubagent ───────────────────────────────────────────────────────

_NO_MATCH = (
    'No governed sub-agent matches "{ref}". Govern a card first, or use'
    " its exact id or name."
)


def _govern(parent, name, sid=None, depth=None):
    """Register an already-governed child (parent_id == parent.id)."""
    child = lite_server._AgentSession(
        sid or uuid_like(name),
        name,
        parent_id=parent.id,
        depth=(parent.depth + 1) if depth is None else depth,
    )
    lite_server._sessions[child.id] = child
    return child


def uuid_like(seed):
    # a 32-hex id derived from the name, unique per test child
    import hashlib
    return hashlib.md5(seed.encode()).hexdigest()


def test_delegate_runs_a_turn_on_the_governed_child_and_returns_its_reply(
    monkeypatch,
):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    parent = _register_parent()
    child = _govern(parent, "Scout")
    delegate = _delegate_handler(parent.id)

    reply = _text(
        _call(delegate, {"subagent": child.id, "task": "summarize the vault"})
    )
    assert reply == 'Sub-agent "Scout" replied: scripted reply'
    assert child.status == "idle"
    assert [(m["role"], m["text"]) for m in child.messages] == [
        ("user", "summarize the vault"),
        ("assistant", "scripted reply"),
    ]


def test_delegate_resolves_child_by_name(monkeypatch):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    parent = _register_parent()
    _govern(parent, "Scout")
    delegate = _delegate_handler(parent.id)
    assert _text(_call(delegate, {"subagent": "Scout", "task": "t"})) == (
        'Sub-agent "Scout" replied: scripted reply'
    )


def test_delegate_rejects_a_non_governed_target(monkeypatch):
    # containment: a foreign card / sibling's child / junk are all "no match",
    # and none of them is ever run.
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    parent = _register_parent()
    other = lite_server._AgentSession("othercard0", "Other")
    lite_server._sessions[other.id] = other
    delegate = _delegate_handler(parent.id)
    for ref in (other.id, "Other", "nope"):
        assert _text(_call(delegate, {"subagent": ref, "task": "t"})) == (
            _NO_MATCH.format(ref=ref)
        )
    assert other.messages == []  # the foreign session never ran


def test_delegate_by_name_is_ambiguous_when_two_children_share_a_name(
    monkeypatch,
):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    parent = _register_parent()
    _govern(parent, "Twin", sid="twin000000000000000000000000000a")
    _govern(parent, "Twin", sid="twin000000000000000000000000000b")
    delegate = _delegate_handler(parent.id)
    assert _text(_call(delegate, {"subagent": "Twin", "task": "t"})) == (
        'Multiple governed sub-agents are named "Twin"; delegate by id instead.'
    )


def test_delegate_rejects_a_busy_child(monkeypatch):
    monkeypatch.setattr(
        lite_server, "ClaudeSDKClient", _scripted_client_factory()
    )
    parent = _register_parent()
    child = _govern(parent, "Scout")
    child.status = "running"
    delegate = _delegate_handler(parent.id)
    assert _text(_call(delegate, {"subagent": "Scout", "task": "t"})) == (
        'Sub-agent "Scout" is busy with another turn; try again shortly.'
    )
    # nothing appended: the turn was refused before it ran
    assert child.messages == []


def test_delegate_with_parent_gone():
    delegate = _delegate_handler("deadbeef00000000deadbeef00000000")
    assert _text(_call(delegate, {"subagent": "x", "task": "t"})) == (
        "Your session is gone; cannot delegate."
    )


def test_delegate_blocked_at_max_depth():
    # a session already at the depth cap cannot delegate further down the
    # chain (bounds A->B->C->... recursion); the child is never run.
    parent = lite_server._AgentSession(
        "deepparent00000000000000000000aa",
        "Deep",
        parent_id="p" * 32,
        depth=lite_server._MAX_DEPTH,
    )
    parent.status = "running"
    lite_server._sessions[parent.id] = parent
    child = _govern(parent, "Child", depth=lite_server._MAX_DEPTH + 1)
    delegate = _delegate_handler(parent.id)
    assert _text(_call(delegate, {"subagent": child.id, "task": "t"})) == (
        f"Max delegation depth ({lite_server._MAX_DEPTH}) reached — cannot"
        " delegate further down this chain."
    )
    assert child.messages == []
