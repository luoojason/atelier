"""Tests for the Claude Max *subscription* backend (claude_subscription_model).

Two tiers:

  * PURE helpers (build_system_prompt / serialize_input / parse_result /
    map_usage / run_cli-with-fake-runner) import only stdlib + the module's own
    pure functions, so they pass under a plain system python3:

        python3 tests/test_claude_subscription.py

  * SDK-backed tests (get_response returning a real ``ModelResponse``, and a LIVE
    round-trip through the real ``claude`` CLI) need the ``agents`` SDK, so run
    them with the extension venv:

        .venv-ext/bin/python tests/test_claude_subscription.py

The runner auto-detects whether ``agents`` is importable and whether the
``claude`` CLI is present, and skips the tiers that cannot run (reporting them as
SKIP rather than failing).
"""

import asyncio
import json
import os
import shutil
import sys
from types import SimpleNamespace

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)

import claude_subscription_model as csm  # noqa: E402

_PASS = 0
_FAIL = 0
_SKIP = 0


def check(name, cond, detail=""):
    global _PASS, _FAIL
    if cond:
        _PASS += 1
        print(f"  PASS  {name}")
    else:
        _FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def skip(name, reason):
    global _SKIP
    _SKIP += 1
    print(f"  SKIP  {name}  ({reason})")


# ── test doubles ──────────────────────────────────────────────────────────────


class FakeTool:
    """Minimal duck-typed stand-in for an SDK FunctionTool (no agents import)."""

    def __init__(self, name, description, params_json_schema):
        self.name = name
        self.description = description
        self.params_json_schema = params_json_schema


class FakeHandoff:
    """Minimal duck-typed stand-in for an SDK Handoff (no agents import).

    A Handoff carries its callable identity under tool_name / tool_description /
    input_json_schema, mirroring the real ``agents.handoffs.Handoff`` shape.
    """

    def __init__(self, tool_name, tool_description, input_json_schema):
        self.tool_name = tool_name
        self.tool_description = tool_description
        self.input_json_schema = input_json_schema


class FakeSchema:
    def __init__(self, plain, schema=None):
        self._plain = plain
        self._schema = schema or {}

    def is_plain_text(self):
        return self._plain

    def json_schema(self):
        return self._schema


def make_fake_runner(canned):
    """Return (runner, calls) where runner ignores real subprocess and returns a
    CompletedProcess-like object wrapping ``canned`` (a dict serialized to JSON)."""
    calls = []

    def runner(argv, input=None, capture_output=True, text=True, timeout=None):
        calls.append({"argv": argv, "input": input, "timeout": timeout})
        return SimpleNamespace(
            returncode=0, stdout=json.dumps(canned), stderr=""
        )

    return runner, calls


# ── pure: build_system_prompt ─────────────────────────────────────────────────


def test_build_system_prompt():
    print("build_system_prompt")
    tools = [
        FakeTool("get_weather", "Look up weather.", {"type": "object", "properties": {"city": {"type": "string"}}}),
    ]
    sp = csm.build_system_prompt("You are a helpful agent.", tools, None)
    check("keeps system instructions", "You are a helpful agent." in sp)
    check("lists tool name", "get_weather" in sp)
    check("includes tool description", "Look up weather." in sp)
    check("renders params schema", '"city"' in sp)
    check("documents tool_call protocol", '"tool_call"' in sp and '"arguments"' in sp)
    check("mentions single fenced json block", "json" in sp.lower() and "fenced" in sp.lower())

    # No tools, plain-text schema -> no tool section, no output-format section.
    sp2 = csm.build_system_prompt("Sys", [], FakeSchema(plain=True))
    check("no tool section without tools", "tool_call" not in sp2)
    check("no output-format for plain text", "JSON Schema" not in sp2)

    # Handoffs must be advertised just like tools (else they are silently dropped
    # and every Handoff flow becomes unavailable under this backend).
    handoffs = [
        FakeHandoff(
            "transfer_to_researcher",
            "Handoff to the researcher agent.",
            {"type": "object", "properties": {"reason": {"type": "string"}}},
        ),
    ]
    sph = csm.build_system_prompt("You are the orchestrator.", [], None, handoffs)
    check("advertises handoff tool_name", "transfer_to_researcher" in sph)
    check("includes handoff description", "Handoff to the researcher agent." in sph)
    check("renders handoff schema", '"reason"' in sph)
    check("handoff alone triggers tool_call protocol", '"tool_call"' in sph)

    # Tools and handoffs coexist in the same catalog.
    spth = csm.build_system_prompt("sys", tools, None, handoffs)
    check("catalog lists both tool and handoff", "get_weather" in spth and "transfer_to_researcher" in spth)

    # Structured output schema -> instruct JSON-only.
    sp3 = csm.build_system_prompt(None, [], FakeSchema(plain=False, schema={"type": "object", "properties": {"answer": {"type": "string"}}}))
    check("structured output instruction present", "JSON Schema" in sp3 and '"answer"' in sp3)


# ── pure: serialize_input ─────────────────────────────────────────────────────


def test_serialize_input():
    print("serialize_input")
    check("passes a string through", csm.serialize_input("hello world") == "hello world")

    items = [
        {"role": "user", "content": "What is 2+2?", "type": "message"},
        {"role": "assistant", "content": [{"type": "output_text", "text": "Let me check."}]},
        {"type": "function_call", "name": "calc", "arguments": '{"expr": "2+2"}', "call_id": "c1"},
        {"type": "function_call_output", "call_id": "c1", "output": "4"},
    ]
    flat = csm.serialize_input(items)
    check("flattens user text", "What is 2+2?" in flat)
    check("flattens assistant content parts", "Let me check." in flat)
    check("renders tool call", "calc(" in flat and '"expr": "2+2"' in flat)
    check("renders tool result", "4" in flat and "tool result" in flat.lower())
    check("labels roles", "User:" in flat and "Assistant:" in flat)


# ── pure: parse_result ────────────────────────────────────────────────────────


def test_parse_result():
    print("parse_result")

    fenced = '```json\n{"tool_call": {"name": "search", "arguments": {"q": "cats"}}}\n```'
    r = csm.parse_result(fenced)
    check("lone fenced tool_call detected", r["kind"] == "tool_call" and r["name"] == "search")
    check("fenced tool_call arguments parsed", r["arguments"] == {"q": "cats"})

    # A lone (unfenced) tool_call JSON is the sole content -> real call.
    bare = '{"tool_call": {"name": "lookup", "arguments": {"id": 7}}}'
    rb = csm.parse_result(bare)
    check("bare sole-content tool_call detected", rb["kind"] == "tool_call" and rb["name"] == "lookup")
    check("bare tool_call arguments parsed", rb["arguments"] == {"id": 7})

    plain = "The answer is 42."
    r2 = csm.parse_result(plain)
    check("plain text detected", r2["kind"] == "text" and r2["text"] == "The answer is 42.")

    # FALSE-POSITIVE GUARDS: prose that merely *mentions* or *explains* the
    # protocol must NOT misfire a phantom tool call. These are the exact misfires
    # the strict sole-content rule fixes.
    echo = (
        'I have no matching tool. The format would be '
        '{"tool_call": {"name": "x", "arguments": {}}} normally.'
    )
    r3 = csm.parse_result(echo)
    check("prose echoing the protocol stays text", r3["kind"] == "text")
    check("prose echo does not invent a call name", "name" not in r3)

    example_block = (
        "Here's an example of the format:\n```json\n"
        '{"tool_call": {"name": "demo", "arguments": {}}}\n```\n'
        "That's how you would call a tool."
    )
    r4 = csm.parse_result(example_block)
    check("example fenced block surrounded by prose stays text", r4["kind"] == "text")

    prose_embedded = (
        "Sure, I'll call the tool now.\n"
        '{"tool_call": {"name": "lookup", "arguments": {"id": 7}}}\n'
        "Hope that helps!"
    )
    r5 = csm.parse_result(prose_embedded)
    check("tool_call embedded in prose stays text", r5["kind"] == "text")

    # A plain-text answer that merely mentions JSON is NOT a tool call.
    r6 = csm.parse_result('Here is some data: {"foo": "bar"}')
    check("non-tool_call json stays text", r6["kind"] == "text")

    # Structured output wrapped in a lone fence gets unwrapped.
    r7 = csm.parse_result('```json\n{"answer": "yes"}\n```')
    check("lone enclosing fence unwrapped", r7["kind"] == "text" and r7["text"] == '{"answer": "yes"}')


# ── pure: map_usage ───────────────────────────────────────────────────────────


def test_map_usage():
    print("map_usage")
    u = csm.map_usage(
        {
            "input_tokens": 18477,
            "cache_creation_input_tokens": 21739,
            "cache_read_input_tokens": 100,
            "output_tokens": 4,
        }
    )
    check("input sums fresh+cache_read+cache_creation", u["input_tokens"] == 18477 + 21739 + 100)
    check("output tokens mapped", u["output_tokens"] == 4)
    check("total = input + output", u["total_tokens"] == (18477 + 21739 + 100) + 4)
    check("cached tokens = cache_read", u["cached_tokens"] == 100)

    empty = csm.map_usage(None)
    check("handles None usage", empty == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cached_tokens": 0})


# ── pure: run_cli with injected fake runner ───────────────────────────────────


def test_run_cli_argv():
    print("run_cli (fake runner)")
    canned = {"result": "ok", "usage": {"input_tokens": 1, "output_tokens": 1}}
    runner, calls = make_fake_runner(canned)
    data = csm.run_cli("SYSPROMPT", "USERPROMPT", model="sonnet", runner=runner)
    check("returns parsed CLI JSON", data == canned)
    argv = calls[0]["argv"]
    check("prompt goes on stdin, not argv", calls[0]["input"] == "USERPROMPT")
    check("argv invokes claude -p json", argv[:4] == ["claude", "-p", "--output-format", "json"])
    check("appends system prompt", "--append-system-prompt" in argv and "SYSPROMPT" in argv)
    check("passes --model", "--model" in argv and "sonnet" in argv)
    check("disables native tools", "--disallowedTools" in argv and "Bash" in argv)
    di = argv.index("--disallowedTools")
    check("disallowedTools is the final variadic option", di > argv.index("--model"))

    # Error surfaces as RuntimeError.
    def bad_runner(argv, input=None, capture_output=True, text=True, timeout=None):
        return SimpleNamespace(returncode=1, stdout="", stderr="boom")

    raised = False
    try:
        csm.run_cli("s", "u", runner=bad_runner)
    except RuntimeError:
        raised = True
    check("nonzero exit raises RuntimeError", raised)

    # is_error in JSON surfaces as RuntimeError.
    err_runner, _ = make_fake_runner({"is_error": True, "result": "nope"})
    raised2 = False
    try:
        csm.run_cli("s", "u", runner=err_runner)
    except RuntimeError:
        raised2 = True
    check("is_error JSON raises RuntimeError", raised2)


# ── SDK-backed: get_response via fake runner ──────────────────────────────────


def test_get_response_text():
    print("get_response -> text ModelResponse (fake runner)")
    from openai.types.responses import ResponseOutputMessage

    canned = {
        "result": "pong",
        "usage": {
            "input_tokens": 10,
            "cache_read_input_tokens": 5,
            "cache_creation_input_tokens": 20,
            "output_tokens": 3,
        },
        "session_id": "sess-1",
        "uuid": "uuid-1",
        "is_error": False,
    }
    runner, calls = make_fake_runner(canned)
    model = csm.ClaudeSubscriptionModel(runner=runner)
    resp = asyncio.run(
        model.get_response(
            "You are helpful.", "say pong", None, [], None, [], None,
            previous_response_id=None, conversation_id=None, prompt=None,
        )
    )
    check("single output item", len(resp.output) == 1)
    check("output is a message", isinstance(resp.output[0], ResponseOutputMessage))
    check("message text is pong", resp.output[0].content[0].text == "pong")
    check("usage.input_tokens sums cache tokens", resp.usage.input_tokens == 35)
    check("usage.output_tokens", resp.usage.output_tokens == 3)
    check("usage.total_tokens", resp.usage.total_tokens == 38)
    check("usage cached_tokens detail", resp.usage.input_tokens_details.cached_tokens == 5)
    check("usage.requests == 1", resp.usage.requests == 1)
    check("response_id from session_id", resp.response_id == "sess-1")
    check("stdin carried the user prompt", "say pong" in calls[0]["input"])


def test_get_response_tool_call():
    print("get_response -> ResponseFunctionToolCall (fake runner)")
    from openai.types.responses import ResponseFunctionToolCall

    tool = FakeTool("get_weather", "weather", {"type": "object", "properties": {"city": {"type": "string"}}})
    canned = {
        "result": '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```',
        "usage": {"input_tokens": 12, "output_tokens": 8},
        "session_id": "sess-2",
        "uuid": "uuid-2",
    }
    runner, calls = make_fake_runner(canned)
    model = csm.ClaudeSubscriptionModel(runner=runner)
    resp = asyncio.run(
        model.get_response(
            "sys", "what is the weather in Paris?", None, [tool], None, [], None,
            previous_response_id=None, conversation_id=None, prompt=None,
        )
    )
    check("single output item", len(resp.output) == 1)
    check("output is a function call", isinstance(resp.output[0], ResponseFunctionToolCall))
    fc = resp.output[0]
    check("tool name matches", fc.name == "get_weather")
    check("arguments is a JSON string of the args", json.loads(fc.arguments) == {"city": "Paris"})
    check("call_id generated", isinstance(fc.call_id, str) and fc.call_id.startswith("call_"))
    check("system prompt described the tool", "get_weather" in calls[0]["argv"][calls[0]["argv"].index("--append-system-prompt") + 1])


def test_get_response_handoff():
    print("get_response -> handoff advertised + call routes by tool_name (fake runner)")
    from openai.types.responses import ResponseFunctionToolCall

    handoff = FakeHandoff(
        "transfer_to_researcher",
        "Handoff to the researcher agent.",
        {"type": "object", "properties": {"reason": {"type": "string"}}},
    )
    canned = {
        "result": '```json\n{"tool_call": {"name": "transfer_to_researcher", "arguments": {"reason": "needs research"}}}\n```',
        "usage": {"input_tokens": 5, "output_tokens": 4},
        "session_id": "sess-h",
        "uuid": "uuid-h",
    }
    runner, calls = make_fake_runner(canned)
    model = csm.ClaudeSubscriptionModel(runner=runner)
    resp = asyncio.run(
        model.get_response(
            "orchestrate", "delegate this", None, [], None, [handoff], None,
            previous_response_id=None, conversation_id=None, prompt=None,
        )
    )
    check("handoff produces a function call", isinstance(resp.output[0], ResponseFunctionToolCall))
    # The runner matches this name against its handoff_map, so it MUST equal tool_name.
    check("call name equals handoff tool_name", resp.output[0].name == "transfer_to_researcher")
    check("handoff arguments carried", json.loads(resp.output[0].arguments) == {"reason": "needs research"})
    sysprompt = calls[0]["argv"][calls[0]["argv"].index("--append-system-prompt") + 1]
    check("system prompt advertised the handoff", "transfer_to_researcher" in sysprompt)


def test_stream_response_events():
    print("stream_response -> minimal Responses events (fake runner)")
    from openai.types.responses import (
        ResponseCompletedEvent,
        ResponseCreatedEvent,
        ResponseOutputItemDoneEvent,
    )

    canned = {
        "result": "streamed pong",
        "usage": {"input_tokens": 6, "output_tokens": 2},
        "session_id": "sess-3",
        "uuid": "uuid-3",
    }
    runner, _ = make_fake_runner(canned)
    model = csm.ClaudeSubscriptionModel(runner=runner)

    async def collect():
        events = []
        async for ev in model.stream_response(
            "sys", "hi", None, [], None, [], None,
            previous_response_id=None, conversation_id=None, prompt=None,
        ):
            events.append(ev)
        return events

    events = asyncio.run(collect())
    check("first event is response.created", isinstance(events[0], ResponseCreatedEvent))
    check("last event is response.completed", isinstance(events[-1], ResponseCompletedEvent))
    done = [e for e in events if isinstance(e, ResponseOutputItemDoneEvent)]
    check("one output_item.done event", len(done) == 1)
    completed = events[-1]
    check("completed response carries output", len(completed.response.output) == 1)
    check("completed response carries usage", completed.response.usage.input_tokens == 6)
    check("completed response has id", completed.response.id == "sess-3")


# ── LIVE: real claude CLI round-trip ──────────────────────────────────────────


def test_live_round_trip():
    print("LIVE claude CLI subscription round-trip")
    if shutil.which("claude") is None:
        skip("live round-trip", "claude CLI not on PATH")
        return
    from openai.types.responses import ResponseOutputMessage

    model = csm.ClaudeSubscriptionModel(timeout=180)
    try:
        resp = asyncio.run(
            model.get_response(
                "You are a terse assistant.",
                "reply with the word pong",
                None, [], None, [], None,
                previous_response_id=None, conversation_id=None, prompt=None,
            )
        )
    except Exception as exc:  # noqa: BLE001
        check("live round-trip returned without error", False, f"raised: {exc!r}")
        return
    check("live output is a message", resp.output and isinstance(resp.output[0], ResponseOutputMessage))
    text = resp.output[0].content[0].text if resp.output else ""
    print(f"        live model text: {text!r}")
    check("live response mentions pong", "pong" in text.lower())
    check("live usage input_tokens > 0", resp.usage.input_tokens > 0)
    check("live usage output_tokens > 0", resp.usage.output_tokens > 0)


# ── harness ───────────────────────────────────────────────────────────────────


def main():
    print("=== pure-function tests (system python3 OK) ===")
    test_build_system_prompt()
    test_serialize_input()
    test_parse_result()
    test_map_usage()
    test_run_cli_argv()

    try:
        import agents  # noqa: F401
        have_agents = True
    except Exception:  # noqa: BLE001
        have_agents = False

    print("\n=== SDK-backed tests (need the agents venv) ===")
    if have_agents:
        test_get_response_text()
        test_get_response_tool_call()
        test_get_response_handoff()
        test_stream_response_events()
        print("\n=== LIVE subscription round-trip ===")
        test_live_round_trip()
    else:
        skip("get_response text", "agents SDK not importable (use .venv-ext/bin/python)")
        skip("get_response tool_call", "agents SDK not importable")
        skip("get_response handoff", "agents SDK not importable")
        skip("stream_response events", "agents SDK not importable")
        skip("live round-trip", "agents SDK not importable")

    print(f"\n{_PASS} passed, {_FAIL} failed, {_SKIP} skipped")
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
