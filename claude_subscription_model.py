"""Claude Max *subscription* backend for OpenSwarm.

This lets the whole agency run on the user's Claude Max subscription through the
``claude`` CLI (``claude -p``) instead of the paid Anthropic API. It bills ZERO
per-token API cost: the CLI is the sanctioned subscription path.

The CLI runs Claude Code's *own* tools, not agency_swarm's Python function tools.
So function-calling is bridged over prompt + parse: we disable the CLI's native
tools, describe the SDK tools in the appended system prompt, and ask the model to
emit a single fenced ``{"tool_call": ...}`` JSON block when it wants to call one.
On the way back we parse that block into a ``ResponseFunctionToolCall`` (the SDK
then runs the Python tool and calls us again with the result appended).

The module is deliberately split so the *pure* helpers (``build_system_prompt``,
``serialize_input``, ``parse_result``, ``map_usage``, ``run_cli``) import only the
standard library and can be unit-tested under a plain ``python3`` with no
``agents``/``pydantic`` installed. The ``agents`` types are imported lazily inside
``get_response``/``stream_response`` (and the base class degrades to ``object``),
so ``import claude_subscription_model`` works even without the SDK present.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable

# The ``agents`` SDK is only needed to actually *run* the model. Keeping the base
# class optional means the pure helpers below stay importable under bare python3.
try:  # pragma: no cover - trivial import guard
    from agents.models.interface import Model as _ModelBase
except Exception:  # noqa: BLE001 - any import failure means "SDK not present"
    _ModelBase = object  # type: ignore[assignment,misc]


# The Claude Code built-in tools we disable so the CLI never tries to run its own
# tooling; agency_swarm's Python tools are bridged via the prompt protocol instead.
DEFAULT_DISALLOWED_TOOLS: list[str] = [
    "Bash",
    "BashOutput",
    "KillShell",
    "Edit",
    "Write",
    "Read",
    "MultiEdit",
    "NotebookEdit",
    "WebSearch",
    "WebFetch",
    "Glob",
    "Grep",
    "Task",
    "TodoWrite",
    "LS",
    "SlashCommand",
]

DEFAULT_TIMEOUT = 600  # seconds; agent turns can be slow


# ── pure helpers (stdlib only) ────────────────────────────────────────────────


def _tool_fields(tool: Any) -> tuple[str, str, dict]:
    """Duck-type the (name, description, json-schema) out of an SDK tool or handoff.

    A ``FunctionTool`` exposes ``name`` / ``description`` / ``params_json_schema``;
    a ``Handoff`` carries the same information under ``tool_name`` /
    ``tool_description`` / ``input_json_schema``. We read either shape so handoffs
    can be advertised to the model exactly like tools. Never imports ``agents``.
    """
    name = getattr(tool, "name", "") or getattr(tool, "tool_name", "") or ""
    description = (
        getattr(tool, "description", "") or getattr(tool, "tool_description", "") or ""
    )
    schema = getattr(tool, "params_json_schema", None)
    if not isinstance(schema, dict):
        schema = getattr(tool, "input_json_schema", None)
    if not isinstance(schema, dict):
        schema = {}
    return name, description, schema


def _resolve_tool_choice(model_settings: Any) -> str | None:
    """Pull ``tool_choice`` off a ModelSettings-like object (duck-typed).

    ``ModelSettings.tool_choice`` is ``"auto"`` / ``"required"`` / ``"none"`` or a
    specific tool name, or ``None`` when unset. Read via ``getattr`` so this stays
    stdlib-only (no ``agents`` import) and testable under bare python3.
    """
    if model_settings is None:
        return None
    choice = getattr(model_settings, "tool_choice", None)
    return choice if isinstance(choice, str) else None


def _tool_choice_instruction(tool_choice: Any, has_callables: bool) -> str | None:
    """Render a system-prompt instruction that enforces a non-default ``tool_choice``.

    The ``claude -p`` subscription CLI has no ``--tool-choice`` flag, so a forced
    tool choice is bridged the same way the tools themselves are: as an instruction
    appended to the system prompt. Returns ``None`` for the default ``"auto"`` (or an
    unset/empty choice) so the happy path is unchanged.
    """
    if not isinstance(tool_choice, str):
        return None
    choice = tool_choice.strip()
    lowered = choice.lower()
    if not lowered or lowered == "auto":
        return None
    if lowered == "none":
        return (
            "# Tool choice\n\n"
            "Do NOT call any tool this turn. Answer directly in plain text."
        )
    if not has_callables:
        # Forcing a call with nothing to call would only stall the model.
        return None
    if lowered in ("required", "any"):
        return (
            "# Tool choice\n\n"
            "You MUST call one of the available tools this turn. Respond with ONLY "
            "the single fenced `json` tool_call block described above and nothing "
            "else — do not answer in plain prose."
        )
    # A specific tool name was forced.
    return (
        "# Tool choice\n\n"
        f"You MUST call the tool named `{choice}` this turn. Respond with ONLY the "
        f'single fenced `json` tool_call block described above (with "name": '
        f'"{choice}") and nothing else.'
    )


def build_system_prompt(
    system_instructions: str | None,
    tools: list | None,
    output_schema: Any | None,
    handoffs: list | None = None,
    tool_choice: Any = None,
) -> str:
    """Assemble the string handed to ``--append-system-prompt``.

    Includes the agent's own instructions, the tool-call bridge protocol + the
    rendered tool catalog, and (when present) an instruction to emit only JSON
    matching ``output_schema``.

    ``handoffs`` are rendered in the same catalog as tools: to the model a handoff
    is just another callable (invoked with the identical ``{"tool_call": ...}``
    protocol), so the SDK runner can match the emitted call name against its
    handoff map. Without this the model is never told those targets exist and every
    handoff flow is silently unavailable under this backend.
    """
    parts: list[str] = []
    if system_instructions:
        parts.append(system_instructions.strip())

    # Tools and handoffs are surfaced to the model through the same bridge; a
    # Handoff duck-types its name/description/schema via ``_tool_fields``.
    callables = list(tools or []) + list(handoffs or [])
    if callables:
        lines = [
            "# Tool calling",
            "",
            "You can call one of the tools listed below. To call a tool, respond "
            "with ONLY a single fenced code block tagged `json` containing an "
            "object of exactly this shape:",
            "",
            "```json",
            '{"tool_call": {"name": "<tool_name>", "arguments": { ... }}}',
            "```",
            "",
            "Rules:",
            "- When calling a tool, output the fenced JSON block and nothing else "
            "(no prose before or after). Do not show the block as an example or "
            "explain the format unless you are actually calling the tool.",
            "- `arguments` must be a JSON object matching that tool's parameters "
            "schema.",
            "- Call at most one tool per response.",
            "- If you do not need a tool, just answer normally in plain text.",
            "",
            "## Available tools",
            "",
        ]
        for tool in callables:
            name, description, schema = _tool_fields(tool)
            if not name:
                continue
            lines.append(f"### {name}")
            if description:
                lines.append(description.strip())
            lines.append("Parameters (JSON Schema):")
            lines.append("```json")
            lines.append(json.dumps(schema, ensure_ascii=False))
            lines.append("```")
            lines.append("")
        parts.append("\n".join(lines).rstrip())

    tc_instruction = _tool_choice_instruction(tool_choice, bool(callables))
    if tc_instruction:
        parts.append(tc_instruction)

    if output_schema is not None and not _is_plain_text(output_schema):
        try:
            schema_json = json.dumps(output_schema.json_schema(), ensure_ascii=False)
        except Exception:  # noqa: BLE001 - be defensive about odd schema objects
            schema_json = None
        if schema_json:
            parts.append(
                "# Output format\n\n"
                "Respond with ONLY a single JSON value that conforms to the "
                "following JSON Schema. Do not wrap it in a code fence and do not "
                "add any prose before or after it.\n\n"
                f"{schema_json}"
            )

    return "\n\n".join(p for p in parts if p).strip()


def _is_plain_text(output_schema: Any) -> bool:
    is_plain = getattr(output_schema, "is_plain_text", None)
    if callable(is_plain):
        try:
            return bool(is_plain())
        except Exception:  # noqa: BLE001
            return False
    return False


def _as_dict(item: Any) -> dict:
    """Normalize an input item (TypedDict / pydantic object) into a plain dict."""
    if isinstance(item, dict):
        return item
    dump = getattr(item, "model_dump", None)
    if callable(dump):
        try:
            out = dump()
            if isinstance(out, dict):
                return out
        except Exception:  # noqa: BLE001
            pass
    return {}


def _content_to_text(content: Any) -> str:
    """Flatten Responses-API message content (str or list of parts) into text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if isinstance(part, str):
                chunks.append(part)
                continue
            part = _as_dict(part)
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
            elif part.get("type") in ("input_image", "image"):
                chunks.append("[image]")
        return "\n".join(chunks)
    if content is None:
        return ""
    return str(content)


def serialize_input(input: Any) -> str:
    """Flatten the conversation (a string, or a list of Responses input items) into
    a single stdin prompt for the CLI."""
    if isinstance(input, str):
        return input
    if not isinstance(input, list):
        return str(input)

    lines: list[str] = []
    for raw in input:
        item = _as_dict(raw)
        itype = item.get("type")

        if itype == "function_call":
            name = item.get("name", "")
            args = item.get("arguments", "")
            lines.append(f"[assistant tool call] {name}({args})")
            continue
        if itype == "function_call_output":
            call_id = item.get("call_id", "")
            output = item.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            suffix = f" (call {call_id})" if call_id else ""
            lines.append(f"[tool result{suffix}]\n{output}")
            continue

        role = item.get("role")
        if role is not None:
            text = _content_to_text(item.get("content"))
            label = {
                "user": "User",
                "assistant": "Assistant",
                "system": "System",
                "developer": "Developer",
            }.get(role, role.capitalize() if isinstance(role, str) else "User")
            lines.append(f"{label}: {text}")
            continue

        # Unknown item shape: fall back to a compact JSON rendering.
        if item:
            lines.append(json.dumps(item, ensure_ascii=False))
        elif raw:
            lines.append(str(raw))

    return "\n\n".join(lines).strip()


_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*\n?(.*?)```", re.DOTALL)


def _tool_call_from_obj(obj: Any) -> dict | None:
    if not isinstance(obj, dict):
        return None
    tc = obj.get("tool_call")
    if not isinstance(tc, dict):
        return None
    name = tc.get("name")
    if not isinstance(name, str) or not name:
        return None
    args = tc.get("arguments")
    if isinstance(args, str):
        # LLMs frequently emit ``arguments`` as a JSON-ENCODED STRING (the same
        # convention the OpenAI/Anthropic function-call schema uses) rather than a
        # nested object, e.g. ``"arguments": "{\"city\": \"Paris\"}"``. Decode it
        # back into a dict instead of silently discarding the caller's arguments
        # and firing the tool with an empty ``{}``.
        try:
            decoded = json.loads(args)
        except (ValueError, TypeError):
            decoded = None
        args = decoded if isinstance(decoded, dict) else {}
    elif not isinstance(args, dict):
        args = {}
    return {"name": name, "arguments": args}


def _tool_call_from_str(s: str) -> dict | None:
    s = s.strip()
    if not s:
        return None
    try:
        obj = json.loads(s)
    except (ValueError, TypeError):
        return None
    return _tool_call_from_obj(obj)


def parse_result(result_text: str | None) -> dict:
    """Classify a CLI result as a tool call or plain text.

    Returns either ``{"kind": "tool_call", "name": ..., "arguments": {...}}`` or
    ``{"kind": "text", "text": ...}``.

    A tool call is recognized ONLY when it is the *sole* content of the reply:
    either a lone fenced block, or bare tool_call JSON with nothing else. The
    bridge protocol instructs the model to emit exactly that, so this stays
    faithful to real calls while refusing to misfire on prose that merely
    *mentions* or *explains* the ``{"tool_call": ...}`` shape (e.g. "the format
    would be {...} normally", or an example fenced block surrounded by prose).
    Scanning for a tool_call embedded anywhere in prose was the source of those
    false positives, so it is deliberately not done.
    """
    text = result_text or ""
    stripped = text.strip()

    # 1. A lone fenced block: the entire (trimmed) reply is a single ```...```
    #    block and nothing else.
    m = _FENCE_RE.fullmatch(stripped)
    if m:
        inner = m.group(1).strip()
        tc = _tool_call_from_str(inner)
        if tc:
            return {"kind": "tool_call", **tc}
        # A lone fence that is not a tool call is structured output; unwrap it so
        # the JSON survives the round-trip cleanly.
        return {"kind": "text", "text": inner}

    # 2. The entire (trimmed) reply is bare tool_call JSON (no fence).
    tc = _tool_call_from_str(stripped)
    if tc:
        return {"kind": "tool_call", **tc}

    # Otherwise plain text — including prose that happens to contain a tool_call
    # shaped object, which must NOT be treated as a call.
    return {"kind": "text", "text": stripped}


def map_usage(cli_usage: dict | None) -> dict:
    """Map the CLI ``usage`` block to SDK token counts.

    ``input_tokens`` mirrors the *true* context size: fresh input plus the cache
    read and cache creation tokens (all of which were part of the prompt window).
    """
    cli_usage = cli_usage or {}

    def _int(key: str) -> int:
        val = cli_usage.get(key, 0)
        if isinstance(val, bool):
            return 0
        if isinstance(val, (int, float)):
            return int(val)
        return 0

    cached = _int("cache_read_input_tokens")
    input_tokens = _int("input_tokens") + cached + _int("cache_creation_input_tokens")
    output_tokens = _int("output_tokens")
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cached_tokens": cached,
    }


def run_cli(
    system: str,
    user: str,
    model: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    runner: Callable[..., Any] = subprocess.run,
    cli_path: str = "claude",
    disallowed_tools: list[str] | None = None,
) -> dict:
    """Invoke ``claude -p --output-format json`` with the prompt on STDIN.

    ``runner`` is injectable (defaults to :func:`subprocess.run`) so tests can feed
    a canned CLI JSON response without touching the network or a real subscription.
    Returns the parsed CLI JSON dict; raises ``RuntimeError`` on failure — including
    a CLI timeout or a failure to launch the process, both of which are normalized
    to ``RuntimeError`` so callers only ever need to catch that single type.
    """
    argv: list[str] = [cli_path, "-p", "--output-format", "json"]

    # The system prompt embeds every tool's/handoff's full JSON Schema and can grow
    # large; passing it as a single argv element risks OSError E2BIG (ARG_MAX
    # overflow). Write it to a private temp file and reference it via the CLI's
    # ``--append-system-prompt-file`` flag instead — the user prompt already goes on
    # stdin, so nothing unbounded lands on argv. The file is removed once the CLI
    # returns (it is fully consumed synchronously by then).
    system_prompt_file: str | None = None
    if system:
        fd, system_prompt_file = tempfile.mkstemp(
            prefix="claude_sysprompt_", suffix=".txt"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(system)
        except Exception:
            os.unlink(system_prompt_file)
            raise
        argv += ["--append-system-prompt-file", system_prompt_file]
    if model:
        argv += ["--model", model]

    # Resolve the native-tool denylist. ``None`` (unset) AND an empty list both fall
    # back to the safe default: an empty list must NOT silently re-enable the CLI's
    # own side-effecting tools (Bash/Write/Edit/WebFetch/...), which would defeat the
    # bridge's whole guardrail. ``[]`` is a natural but dangerous way to say "no
    # restrictions" (config.get(k, []), ``x or []``, JSON-omitted field), so only a
    # NON-EMPTY override replaces the default denylist.
    tools = disallowed_tools or DEFAULT_DISALLOWED_TOOLS
    if tools:
        # Variadic option kept last so it never swallows a following flag/value.
        argv += ["--disallowedTools", *tools]

    try:
        completed = runner(
            argv,
            input=user,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        # subprocess.run raises TimeoutExpired (NOT a RuntimeError); normalize it so
        # the documented single-exception contract holds for the slow-path the
        # module explicitly anticipates ("agent turns can be slow").
        raise RuntimeError(f"claude CLI timed out after {timeout}s") from exc
    except OSError as exc:
        # e.g. E2BIG (argument list too long) or the CLI binary missing — surface as
        # the documented RuntimeError rather than a raw, uncaught OSError.
        raise RuntimeError(f"claude CLI could not be launched: {exc}") from exc
    finally:
        if system_prompt_file is not None:
            try:
                os.unlink(system_prompt_file)
            except OSError:
                pass

    returncode = getattr(completed, "returncode", 0)
    stdout = getattr(completed, "stdout", "") or ""
    stderr = getattr(completed, "stderr", "") or ""
    if returncode != 0:
        raise RuntimeError(
            f"claude CLI exited with code {returncode}: {stderr.strip() or stdout.strip()}"
        )
    try:
        data = json.loads(stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError(
            f"claude CLI returned non-JSON output: {stdout[:500]!r}"
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"claude CLI returned unexpected JSON: {stdout[:500]!r}")
    if data.get("is_error"):
        raise RuntimeError(f"claude CLI reported an error: {data.get('result')!r}")
    return data


def _gen_call_id() -> str:
    return "call_" + uuid.uuid4().hex


def _gen_message_id() -> str:
    return "msg_" + uuid.uuid4().hex


# ── the Model implementation (needs the agents SDK at call time) ──────────────


class ClaudeSubscriptionModel(_ModelBase):  # type: ignore[misc,valid-type]
    """An openai-agents ``Model`` backed by the Claude Max subscription CLI.

    Streaming is supported by running the (non-streamed) CLI turn and replaying it
    as the minimal Responses stream events the SDK runner consumes.
    """

    def __init__(
        self,
        model: str | None = None,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        cli_path: str = "claude",
        disallowed_tools: list[str] | None = None,
        runner: Callable[..., Any] = subprocess.run,
    ) -> None:
        self.model = model
        self.timeout = timeout
        self.cli_path = cli_path
        self.disallowed_tools = disallowed_tools
        self._runner = runner

    # -- internal --------------------------------------------------------------

    def _invoke(
        self, system_instructions, input, tools, output_schema, handoffs=None, model_settings=None
    ) -> dict:
        tool_choice = _resolve_tool_choice(model_settings)
        system = build_system_prompt(
            system_instructions, tools, output_schema, handoffs, tool_choice
        )
        user = serialize_input(input)
        return run_cli(
            system,
            user,
            model=self.model,
            timeout=self.timeout,
            runner=self._runner,
            cli_path=self.cli_path,
            disallowed_tools=self.disallowed_tools,
        )

    def _build_output_items(self, parsed: dict) -> list:
        from openai.types.responses import (
            ResponseFunctionToolCall,
            ResponseOutputMessage,
            ResponseOutputText,
        )

        if parsed.get("kind") == "tool_call":
            return [
                ResponseFunctionToolCall(
                    type="function_call",
                    call_id=_gen_call_id(),
                    name=parsed["name"],
                    arguments=json.dumps(parsed.get("arguments", {}), ensure_ascii=False),
                )
            ]
        return [
            ResponseOutputMessage(
                id=_gen_message_id(),
                type="message",
                role="assistant",
                status="completed",
                content=[
                    ResponseOutputText(
                        type="output_text",
                        text=parsed.get("text", ""),
                        annotations=[],
                    )
                ],
            )
        ]

    def _build_usage(self, cli_data: dict):
        from openai.types.responses.response_usage import (
            InputTokensDetails,
            OutputTokensDetails,
        )

        from agents.usage import Usage

        u = map_usage(cli_data.get("usage"))
        return Usage(
            requests=1,
            input_tokens=u["input_tokens"],
            output_tokens=u["output_tokens"],
            total_tokens=u["total_tokens"],
            input_tokens_details=InputTokensDetails(cached_tokens=u["cached_tokens"]),
            output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
        )

    # -- Model interface -------------------------------------------------------

    async def get_response(
        self,
        system_instructions,
        input,
        model_settings,
        tools,
        output_schema,
        handoffs,
        tracing,
        *,
        previous_response_id=None,
        conversation_id=None,
        prompt=None,
    ):
        import asyncio

        from agents.items import ModelResponse

        cli_data = await asyncio.to_thread(
            self._invoke,
            system_instructions,
            input,
            tools,
            output_schema,
            handoffs,
            model_settings,
        )
        parsed = parse_result(cli_data.get("result", ""))
        output = self._build_output_items(parsed)
        usage = self._build_usage(cli_data)
        return ModelResponse(
            output=output,
            usage=usage,
            response_id=cli_data.get("session_id"),
            request_id=cli_data.get("uuid"),
        )

    async def stream_response(
        self,
        system_instructions,
        input,
        model_settings,
        tools,
        output_schema,
        handoffs,
        tracing,
        *,
        previous_response_id=None,
        conversation_id=None,
        prompt=None,
    ):
        """Run one CLI turn and replay it as the minimal Responses stream events.

        The SDK runner only needs ``response.output_item.done`` events (to collect
        output items) plus a terminal ``response.completed`` carrying the usage, so
        that is exactly what we emit, bracketed by ``response.created``.
        """
        from openai.types.responses import (
            Response,
            ResponseCompletedEvent,
            ResponseCreatedEvent,
            ResponseOutputItemDoneEvent,
        )
        from openai.types.responses.response_usage import ResponseUsage

        response = await self.get_response(
            system_instructions,
            input,
            model_settings,
            tools,
            output_schema,
            handoffs,
            tracing,
            previous_response_id=previous_response_id,
            conversation_id=conversation_id,
            prompt=prompt,
        )

        response_id = response.response_id or _gen_message_id()
        model_name = self.model or "claude-cli"

        def _make_response(output_items: list) -> Response:
            return Response(
                id=response_id,
                created_at=time.time(),
                model=model_name,
                object="response",
                output=output_items,
                parallel_tool_calls=False,
                tool_choice="auto",
                tools=[],
                usage=ResponseUsage(
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                    total_tokens=response.usage.total_tokens,
                    input_tokens_details=response.usage.input_tokens_details,
                    output_tokens_details=response.usage.output_tokens_details,
                ),
            )

        seq = 0
        yield ResponseCreatedEvent(
            type="response.created",
            response=_make_response([]),
            sequence_number=seq,
        )
        for index, item in enumerate(response.output):
            seq += 1
            yield ResponseOutputItemDoneEvent(
                type="response.output_item.done",
                item=item,
                output_index=index,
                sequence_number=seq,
            )
        seq += 1
        yield ResponseCompletedEvent(
            type="response.completed",
            response=_make_response(list(response.output)),
            sequence_number=seq,
        )
