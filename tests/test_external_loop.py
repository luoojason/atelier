"""The external (non-Claude) tool lane: OpenAI schema conversion, the LiteLLM
tool loop (mocked provider), dispatch to the REAL Atelier handlers with
containment intact, the build_options byte-identity guard, and the agent_message
route incl. the incapable-model fallback."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import external_agents as ea  # noqa: E402
import external_loop  # noqa: E402
import external_tools as et  # noqa: E402
import lite_server  # noqa: E402


# ── fake provider plumbing (an OpenAI-shaped acompletion) ────────────────────────
class _Fn:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class _TC:
    def __init__(self, tid, name, arguments):
        self.id = tid
        self.type = "function"
        self.function = _Fn(name, arguments)


class _Msg:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls


class _Resp:
    def __init__(self, msg):
        self.choices = [type("C", (), {"message": msg})()]


def _scripted(*msgs):
    """An async acompletion that returns the given messages in order."""
    seq = iter(msgs)

    async def _ac(**kwargs):
        return _Resp(next(seq))

    return _ac


def _scripted_mixed(*items):
    """Like _scripted but an Exception item is RAISED on that call (models a
    provider error arriving on a later step, after earlier tool calls ran)."""
    seq = iter(items)

    async def _ac(**kwargs):
        item = next(seq)
        if isinstance(item, BaseException):
            raise item
        return _Resp(item)

    return _ac


class _FakeTool:
    def __init__(self, name, out="ok"):
        self.name = name
        self.description = name
        self.input_schema = {"type": "object", "properties": {}, "required": []}
        self._out = out
        self.calls = []

    async def handler(self, args):
        self.calls.append(args)
        return {"content": [{"type": "text", "text": self._out}]}


def _run(coro):
    return asyncio.run(coro)


_AGENT = {"id": "a1", "name": "T", "base_url": "http://x/v1", "api_key": "k", "model": "gpt-4o-mini"}


# ── schema conversion ────────────────────────────────────────────────────────────
def test_sanitize_schema_guarantees_object_and_strips_keys():
    s = et.sanitize_schema(
        {"type": "object", "title": "X", "additionalProperties": False,
         "properties": {"p": {"type": "string", "description": "d", "default": "z"}},
         "required": ["p"]}
    )
    assert s["type"] == "object"
    assert "title" not in s and "additionalProperties" not in s
    assert s["properties"]["p"]["description"] == "d"     # descriptions kept
    assert "default" not in s["properties"]["p"]          # rejected keyword stripped
    assert s["required"] == ["p"]


def test_sanitize_schema_no_arg_tool_gets_empty_object():
    s = et.sanitize_schema({"type": "object", "properties": {}, "required": []})
    assert s == {"type": "object", "properties": {}}       # empty required dropped


def test_to_openai_tool_shape_uses_plain_name():
    spec = lite_server.sdk_tools.wrap_tool(lite_server.WriteFile)
    t = et.to_openai_tool(spec)
    assert t["type"] == "function"
    assert t["function"]["name"] == "WriteFile"            # not the mcp__ alias
    assert "path" in t["function"]["parameters"]["properties"]


# ── the loop ─────────────────────────────────────────────────────────────────────
def test_loop_no_tool_call_returns_text():
    external_loop.litellm.acompletion = _scripted(_Msg(content="hello"))
    r = _run(external_loop.run_external_turn(_AGENT, "hi", None, [], {}))
    assert r == {"response": "hello", "error": None, "steps": []}


def test_loop_single_tool_call_then_answer():
    echo = _FakeTool("Echo", out="echoed!")
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "Echo", '{"q": "x"}')]),
        _Msg(content="done"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {"Echo": echo}))
    assert r["response"] == "done"
    assert echo.calls == [{"q": "x"}]
    assert r["steps"][0]["tool"] == "Echo" and r["steps"][0]["result"] == "echoed!"


def test_loop_parallel_tool_calls_all_run_in_order():
    a, b = _FakeTool("A", "ra"), _FakeTool("B", "rb")
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "A", "{}"), _TC("c2", "B", "{}")]),
        _Msg(content="both done"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {"A": a, "B": b}))
    assert [s["tool"] for s in r["steps"]] == ["A", "B"]
    assert len(a.calls) == 1 and len(b.calls) == 1


def test_loop_malformed_arguments_recovers_without_aborting():
    echo = _FakeTool("Echo")
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "Echo", "{not json")]),
        _Msg(content="handled"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {"Echo": echo}))
    assert r["response"] == "handled"
    assert echo.calls == []                                # never invoked on bad args
    assert "could not parse" in r["steps"][0]["result"].lower()


def test_loop_unknown_tool_name_is_reported_not_fatal():
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "Nope", "{}")]),
        _Msg(content="ok"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {}))
    assert r["response"] == "ok"
    assert "no tool named" in r["steps"][0]["result"].lower()


class _NoToolSupport(external_loop.BadRequestError):
    def __init__(self):  # a provider 400 on the tools field, no constructor args needed
        pass


def test_loop_tools_unsupported_signals_fallback():
    async def _raise(**kwargs):
        raise _NoToolSupport()

    external_loop.litellm.acompletion = _raise
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {}))
    assert r["error"] == "tools-unsupported" and r["response"] is None


class _CtxOverflow(external_loop.ContextWindowExceededError):
    def __init__(self):  # a context-window 400 (subclasses BadRequestError)
        pass


def test_loop_error_after_tools_ran_is_not_mislabeled_unsupported():
    # A BadRequestError on a LATER step (steps already non-empty) is a real error
    # for this turn, not a "can't use tools" signal — and the completed step must
    # survive rather than being silently discarded + falsely labeled.
    echo = _FakeTool("Echo")
    external_loop.litellm.acompletion = _scripted_mixed(
        _Msg(tool_calls=[_TC("c1", "Echo", "{}")]),
        _NoToolSupport(),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {"Echo": echo}))
    assert r["error"] != "tools-unsupported"
    assert r["response"] is None
    assert len(r["steps"]) == 1                     # completed tool work preserved


def test_loop_context_overflow_is_generic_not_unsupported():
    external_loop.litellm.acompletion = _scripted_mixed(_CtxOverflow())
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {}))
    assert r["error"] != "tools-unsupported"        # not mislabeled as incapable
    assert r["response"] is None and r["error"]


def test_loop_generic_error_is_in_band():
    async def _boom(**kwargs):
        raise RuntimeError("network went away")

    external_loop.litellm.acompletion = _boom
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {}))
    assert r["response"] is None and r["error"]      # a friendly reason, not a raise


def test_loop_max_steps_cap_terminates():
    echo = _FakeTool("Echo")
    # always returns a tool_call -> would loop forever without the cap
    async def _always(**kwargs):
        return _Resp(_Msg(tool_calls=[_TC("c", "Echo", "{}")]))

    external_loop.litellm.acompletion = _always
    r = _run(external_loop.run_external_turn(_AGENT, "go", None, [], {"Echo": echo}, max_steps=3))
    assert r["error"] == "max-steps"
    assert len(r["steps"]) == 3


def test_loop_requires_a_model():
    r = _run(external_loop.run_external_turn({"base_url": "http://x", "model": ""}, "hi", None, [], {}))
    assert r["error"] == "no-model"


# ── dispatch to the REAL handlers, containment preserved ─────────────────────────
def _workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))


def test_loop_dispatches_to_real_writefile(tmp_path, monkeypatch):
    _workspace(tmp_path, monkeypatch)
    specs = lite_server._select_light_tool_specs(False)
    by_name = et.dispatch_table(specs)
    oai = et.openai_tools_for(specs)
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "WriteFile", '{"path": "hello.txt", "content": "hi there"}')]),
        _Msg(content="wrote it"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "write hello.txt", None, oai, by_name))
    assert r["response"] == "wrote it"
    assert (tmp_path / "hello.txt").read_text() == "hi there"
    assert any(t["function"]["name"] == "WriteFile" for t in oai)


def test_loop_writefile_path_escape_still_refused(tmp_path, monkeypatch):
    _workspace(tmp_path, monkeypatch)
    specs = lite_server._select_light_tool_specs(False)
    by_name = et.dispatch_table(specs)
    external_loop.litellm.acompletion = _scripted(
        _Msg(tool_calls=[_TC("c1", "WriteFile", '{"path": "../escape.txt", "content": "x"}')]),
        _Msg(content="tried"),
    )
    r = _run(external_loop.run_external_turn(_AGENT, "escape", None, [], by_name))
    assert not (tmp_path.parent / "escape.txt").exists()   # containment held
    assert r["steps"][0]["result"]                          # handler returned a refusal string


def test_notion_gated_out_of_registry_without_token():
    names_off = {t.name for t in lite_server._select_light_tool_specs(False)}
    names_on = {t.name for t in lite_server._select_light_tool_specs(True)}
    assert "NotionSearch" not in names_off
    assert "NotionSearch" in names_on


# ── capability denylist + sanitize surface ───────────────────────────────────────
def test_model_tools_capable_denylist():
    assert ea.model_tools_capable("gpt-4o") is True
    assert ea.model_tools_capable("sonar") is False
    assert ea.model_tools_capable("sonar-pro") is False
    assert ea.model_tools_capable("deepseek-reasoner") is False
    assert ea.model_tools_capable("llama3.1") is True       # not a false negative
    assert ea.model_tools_capable("") is True               # unknown defaults capable


def test_sanitize_exposes_tools_fields():
    pub = ea.sanitize({"id": "x", "name": "n", "base_url": "http://x", "model": "sonar",
                       "api_key": "k", "tools_enabled": True})
    assert pub["tools_enabled"] is True
    assert pub["tools_capable"] is False                    # sonar can't do tools
    assert "api_key" not in pub                             # key never leaks


# ── build_options byte-identity (the Notion derivation didn't shift the allowlist) ─
def test_notion_tool_names_derivation_is_identical():
    assert lite_server.NOTION_TOOL_NAMES == [
        "mcp__atelier__NotionSearch", "mcp__atelier__NotionRead",
        "mcp__atelier__NotionCreatePage", "mcp__atelier__NotionAppend",
    ]


def test_build_options_allowlist_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))  # no notion
    opts = lite_server.build_options()
    expected = [t for t in lite_server.ATELIER_ALLOWED_TOOLS if t not in lite_server.NOTION_TOOL_NAMES]
    assert opts.allowed_tools == expected


# ── the agent_message route ──────────────────────────────────────────────────────
def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_EXTERNAL_AGENTS_PATH", str(tmp_path / "ext.json"))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return TestClient(lite_server.app)


def test_route_no_model_is_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "nomodel", "base_url": "http://x/v1"})
    aid = ea.load_agents()[0]["id"]
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"})
    assert r.status_code == 400


def test_route_runs_loop_and_returns_transcript(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "gpt", "base_url": "http://x/v1", "model": "gpt-4o-mini"})
    aid = ea.load_agents()[0]["id"]

    async def _fake(agent, message, history, oai_tools, by_name, **kw):
        return {"response": "did it", "error": None, "steps": [{"tool": "WriteFile", "result": "wrote"}]}

    monkeypatch.setattr(external_loop, "run_external_turn", _fake)
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "write a file"})
    assert r.status_code == 200
    data = r.json()
    assert data["response"] == "did it"
    assert data["tools_used"] is True
    assert data["steps"][0]["tool"] == "WriteFile"


def test_route_incapable_model_falls_back_to_chat(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "px", "base_url": "http://x/v1", "model": "sonar"})
    aid = ea.load_agents()[0]["id"]

    async def _fwd(agent_id, message, history=None):
        return True, "plain chat answer"

    monkeypatch.setattr(ea, "forward", _fwd)
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"})
    assert r.status_code == 200
    data = r.json()
    assert data["response"] == "plain chat answer"
    assert data["tools_used"] is False
    assert "note" in data


def test_route_tools_unsupported_falls_back(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "weird", "base_url": "http://x/v1", "model": "gpt-4o-mini"})
    aid = ea.load_agents()[0]["id"]

    async def _fake(*a, **k):
        return {"response": None, "error": "tools-unsupported", "steps": []}

    async def _fwd(agent_id, message, history=None):
        return True, "fell back"

    monkeypatch.setattr(external_loop, "run_external_turn", _fake)
    monkeypatch.setattr(ea, "forward", _fwd)
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"})
    assert r.status_code == 200 and r.json()["response"] == "fell back"


def test_route_filters_tools_by_grants(tmp_path, monkeypatch):
    """An agent granted only 'web' advertises only WebSearch/WebFetch."""
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "webonly", "base_url": "http://x/v1", "model": "gpt-4o-mini",
               "tool_grants": {"files": False, "vault": False, "web": True, "memory": False}})
    aid = ea.load_agents()[0]["id"]

    seen = {}

    async def _fake(agent, message, history, oai_tools, by_name, **kw):
        seen["names"] = sorted(t["function"]["name"] for t in oai_tools)
        return {"response": "ok", "error": None, "steps": []}

    monkeypatch.setattr(external_loop, "run_external_turn", _fake)
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"})
    assert r.status_code == 200
    assert seen["names"] == ["WebFetch", "WebSearch"]


def test_route_all_grants_revoked_falls_back_to_chat(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "none", "base_url": "http://x/v1", "model": "gpt-4o-mini",
               "tool_grants": {"files": False, "vault": False, "web": False, "memory": False}})
    aid = ea.load_agents()[0]["id"]

    async def _forward(agent_id, message, history=None):
        return True, "plain chat answer"

    monkeypatch.setattr(ea, "forward", _forward)

    async def _boom(*a, **kw):
        raise AssertionError("the tools loop ran with zero granted tools")

    monkeypatch.setattr(external_loop, "run_external_turn", _boom)
    r = c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"})
    assert r.status_code == 200
    body = r.json()
    assert body["response"] == "plain chat answer"
    assert body["tools_used"] is False


def test_route_default_grants_filter_nothing(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    ea.upsert({"name": "all", "base_url": "http://x/v1", "model": "gpt-4o-mini"})
    aid = ea.load_agents()[0]["id"]
    seen = {}

    async def _fake(agent, message, history, oai_tools, by_name, **kw):
        seen["count"] = len(oai_tools)
        return {"response": "ok", "error": None, "steps": []}

    monkeypatch.setattr(external_loop, "run_external_turn", _fake)
    assert c.post(f"/external/agents/{aid}/agent_message", json={"message": "hi"}).status_code == 200
    # no notion token in this env -> the full non-notion light tier
    expected = len(lite_server._select_light_tool_specs(False))
    assert seen["count"] == expected
