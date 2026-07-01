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
import subprocess
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
    CompletedProcess-like object wrapping ``canned`` (a dict serialized to JSON).

    The system prompt is passed to the CLI via ``--append-system-prompt-file``, so
    the runner reads that temp file back (while it still exists — run_cli deletes it
    only after the runner returns) and records its content under ``system_prompt``
    for assertions."""
    calls = []

    def runner(argv, input=None, capture_output=True, text=True, timeout=None):
        system_prompt = None
        if "--append-system-prompt-file" in argv:
            path = argv[argv.index("--append-system-prompt-file") + 1]
            with open(path, encoding="utf-8") as fh:
                system_prompt = fh.read()
        calls.append(
            {"argv": argv, "input": input, "timeout": timeout, "system_prompt": system_prompt}
        )
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
    check(
        "appends system prompt via file (not on argv)",
        "--append-system-prompt-file" in argv and calls[0]["system_prompt"] == "SYSPROMPT",
    )
    check("raw system prompt never lands on argv", "SYSPROMPT" not in argv)
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


# ── REGRESSION (bug 1): stringified tool-call arguments are decoded, not dropped ─


def test_tool_call_arguments_json_string():
    print("parse_result: JSON-string arguments (regression)")

    # A fenced tool_call whose ``arguments`` is a JSON-ENCODED STRING (the common
    # LLM/OpenAI-Anthropic convention) must be decoded back into the real dict, not
    # silently replaced with {} which would fire the tool with no args.
    fenced = '```json\n{"tool_call": {"name": "get_weather", "arguments": "{\\"city\\": \\"Paris\\"}"}}\n```'
    r = csm.parse_result(fenced)
    check("stringified args classified as tool_call", r["kind"] == "tool_call" and r["name"] == "get_weather")
    check("stringified args decoded to dict", r["arguments"] == {"city": "Paris"})

    # Bare (unfenced) sole-content form with stringified args.
    bare = '{"tool_call": {"name": "f", "arguments": "{\\"x\\": 1}"}}'
    rb = csm.parse_result(bare)
    check("bare stringified args decoded", rb["arguments"] == {"x": 1})

    # A dict is still accepted unchanged (happy path preserved).
    d = csm.parse_result('{"tool_call": {"name": "g", "arguments": {"a": 2}}}')
    check("dict args unchanged", d["arguments"] == {"a": 2})

    # Garbage / non-JSON string falls back to {} rather than raising.
    bad = csm.parse_result('{"tool_call": {"name": "h", "arguments": "not json"}}')
    check("undecodable string args fall back to {}", bad["kind"] == "tool_call" and bad["arguments"] == {})

    # A JSON string that decodes to a NON-object (e.g. a list) falls back to {}.
    nonobj = csm.parse_result('{"tool_call": {"name": "i", "arguments": "[1, 2]"}}')
    check("string decoding to non-object falls back to {}", nonobj["arguments"] == {})

    # Omitted arguments still default to {} (unchanged).
    missing = csm.parse_result('{"tool_call": {"name": "j"}}')
    check("missing arguments default to {}", missing["arguments"] == {})


# ── REGRESSION (bug 2 + 5): timeout / launch errors normalized to RuntimeError ──


def test_run_cli_error_normalization():
    print("run_cli: timeout & OSError -> RuntimeError (regression)")

    def timeout_runner(argv, input=None, capture_output=True, text=True, timeout=None):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)

    raised = None
    try:
        csm.run_cli("s", "u", timeout=1, runner=timeout_runner)
    except Exception as exc:  # noqa: BLE001
        raised = exc
    check("timeout raises RuntimeError, not TimeoutExpired", isinstance(raised, RuntimeError))
    check("timeout is NOT a bare TimeoutExpired", not isinstance(raised, subprocess.TimeoutExpired))

    # OSError (e.g. E2BIG / missing binary) is likewise normalized.
    def oserror_runner(argv, input=None, capture_output=True, text=True, timeout=None):
        raise OSError(7, "Argument list too long")

    raised2 = None
    try:
        csm.run_cli("s", "u", runner=oserror_runner)
    except Exception as exc:  # noqa: BLE001
        raised2 = exc
    check("OSError raises RuntimeError", isinstance(raised2, RuntimeError))


# ── REGRESSION (bug 3): tool_choice is bridged into the system prompt ───────────


def test_tool_choice_bridged_into_prompt():
    print("tool_choice bridging (regression)")
    tools = [FakeTool("get_weather", "weather", {"type": "object"})]

    # tool_choice="required" appends a MUST-call instruction when tools exist.
    sp = csm.build_system_prompt("sys", tools, None, None, "required")
    check("required tool_choice forces a tool call", "MUST call one of the available tools" in sp)

    # A specific tool name is enforced by name.
    spn = csm.build_system_prompt("sys", tools, None, None, "get_weather")
    check("named tool_choice forces that tool", "MUST call the tool named `get_weather`" in spn)

    # Default "auto" (and None) add nothing — happy path unchanged.
    sp_auto = csm.build_system_prompt("sys", tools, None, None, "auto")
    check("auto tool_choice adds no enforcement", "MUST call" not in sp_auto)
    sp_none_arg = csm.build_system_prompt("sys", tools, None, None, None)
    check("unset tool_choice adds no enforcement", "MUST call" not in sp_none_arg)

    # "required" with NO callables must not force a call (would only stall).
    sp_empty = csm.build_system_prompt("sys", [], None, None, "required")
    check("required with no tools adds no enforcement", "MUST call" not in sp_empty)

    # "none" tells the model to stay in plain text.
    sp_off = csm.build_system_prompt("sys", tools, None, None, "none")
    check("none tool_choice suppresses tool use", "Do NOT call any tool" in sp_off)

    # _resolve_tool_choice duck-types ModelSettings without importing agents.
    check("resolve reads .tool_choice", csm._resolve_tool_choice(SimpleNamespace(tool_choice="required")) == "required")
    check("resolve of None settings is None", csm._resolve_tool_choice(None) is None)
    check("resolve of non-str tool_choice is None", csm._resolve_tool_choice(SimpleNamespace(tool_choice=None)) is None)


# ── REGRESSION (bug 4): disallowed_tools=[] falls back to the safe denylist ─────


def test_disallowed_tools_empty_uses_default():
    print("disallowed_tools sentinel (regression)")
    canned = {"result": "ok", "usage": {}}

    # None (unset) -> full default denylist.
    runner_none, calls_none = make_fake_runner(canned)
    csm.run_cli("s", "u", runner=runner_none, disallowed_tools=None)
    argv_none = calls_none[0]["argv"]
    check("None uses the default denylist", "--disallowedTools" in argv_none and "Bash" in argv_none)

    # [] MUST NOT silently strip the guardrail — it falls back to the default too.
    runner_empty, calls_empty = make_fake_runner(canned)
    csm.run_cli("s", "u", runner=runner_empty, disallowed_tools=[])
    argv_empty = calls_empty[0]["argv"]
    check("empty list falls back to the default denylist", "--disallowedTools" in argv_empty and "Bash" in argv_empty)
    check("empty list does NOT re-enable native tools", "Write" in argv_empty and "Edit" in argv_empty)

    # A non-empty explicit override still replaces the default.
    runner_custom, calls_custom = make_fake_runner(canned)
    csm.run_cli("s", "u", runner=runner_custom, disallowed_tools=["OnlyThis"])
    argv_custom = calls_custom[0]["argv"]
    check("non-empty override replaces default", "OnlyThis" in argv_custom and "Bash" not in argv_custom)


# ── REGRESSION (bug 5): a large system prompt is kept off argv ──────────────────


def test_large_system_prompt_off_argv():
    print("large system prompt stays off argv (regression)")
    canned = {"result": "ok", "usage": {}}
    runner, calls = make_fake_runner(canned)

    # ~2 MB system prompt would blow past ARG_MAX (~1 MB) if placed on argv.
    huge = "X" * (2 * 1024 * 1024)
    data = csm.run_cli(huge, "u", runner=runner)
    check("run_cli succeeds with a huge system prompt", data == canned)

    argv = calls[0]["argv"]
    check("uses --append-system-prompt-file", "--append-system-prompt-file" in argv)
    check("full system prompt was read from the file", calls[0]["system_prompt"] == huge)
    # The decisive check: total argv size stays tiny (nothing unbounded on argv).
    argv_bytes = sum(len(a.encode("utf-8")) for a in argv)
    check("total argv stays far below ARG_MAX", argv_bytes < 4096, f"argv was {argv_bytes} bytes")
    check("the huge prompt itself is not an argv element", huge not in argv)


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
    check("system prompt described the tool", "get_weather" in calls[0]["system_prompt"])


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
    sysprompt = calls[0]["system_prompt"]
    check("system prompt advertised the handoff", "transfer_to_researcher" in sysprompt)


def test_get_response_threads_tool_choice():
    print("get_response threads model_settings.tool_choice into the prompt (regression)")
    # get_response previously ignored model_settings entirely, so a required
    # tool_choice never reached the CLI. Verify it now surfaces in the system prompt.
    try:
        from agents import ModelSettings  # noqa: PLC0415
        settings = ModelSettings(tool_choice="required")
    except Exception:  # noqa: BLE001 - duck-type if the export path differs
        settings = SimpleNamespace(tool_choice="required")

    tool = FakeTool("get_weather", "weather", {"type": "object", "properties": {"city": {"type": "string"}}})
    canned = {"result": "pong", "usage": {"input_tokens": 1, "output_tokens": 1}, "session_id": "s", "uuid": "u"}
    runner, calls = make_fake_runner(canned)
    model = csm.ClaudeSubscriptionModel(runner=runner)
    asyncio.run(
        model.get_response(
            "sys", "weather in Paris?", settings, [tool], None, [], None,
            previous_response_id=None, conversation_id=None, prompt=None,
        )
    )
    check(
        "required tool_choice reached the CLI system prompt",
        "MUST call one of the available tools" in calls[0]["system_prompt"],
    )


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
    test_tool_call_arguments_json_string()
    test_run_cli_error_normalization()
    test_tool_choice_bridged_into_prompt()
    test_disallowed_tools_empty_uses_default()
    test_large_system_prompt_off_argv()

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
        test_get_response_threads_tool_choice()
        test_stream_response_events()
        print("\n=== LIVE subscription round-trip ===")
        test_live_round_trip()
    else:
        skip("get_response text", "agents SDK not importable (use .venv-ext/bin/python)")
        skip("get_response tool_call", "agents SDK not importable")
        skip("get_response handoff", "agents SDK not importable")
        skip("get_response threads tool_choice", "agents SDK not importable")
        skip("stream_response events", "agents SDK not importable")
        skip("live round-trip", "agents SDK not importable")

    print(f"\n{_PASS} passed, {_FAIL} failed, {_SKIP} skipped")
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
