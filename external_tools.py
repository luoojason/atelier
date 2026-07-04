"""OpenAI function-calling adapter for the external (non-Claude) tool lane.

The external tool lane reuses Atelier's REAL tool handlers verbatim — the same
``SdkMcpTool`` objects the Claude lane wraps via ``shared_tools.sdk_tools`` — so
no tool is reimplemented and every containment guard (workspace path-resolve,
Notion token gating) is preserved because it lives inside the handler. This
module only translates a tool's JSON-Schema into the OpenAI ``tools[]`` shape
that LiteLLM forwards to any OpenAI-compatible provider, and builds the
name->tool dispatch table the loop uses.

``lite_server._select_light_tool_specs(notion_enabled)`` owns which tools the
lane exposes (the light tier, Notion-gated exactly as the Claude lane gates it),
so both lanes share one source of truth and cannot drift.
"""

from __future__ import annotations

# Property keywords that Gemini's /v1beta/openai compatibility layer (and some
# other strict validators) reject on a function's ``parameters``. Atelier's own
# schemas don't emit these today, so stripping them is defensive, not lossy.
_SCHEMA_DROP_KEYS = frozenset(
    {"$schema", "additionalProperties", "title", "default", "examples", "format"}
)


def _strip(node):
    """Recursively drop the reject-listed keywords from a schema tree."""
    if isinstance(node, dict):
        return {k: _strip(v) for k, v in node.items() if k not in _SCHEMA_DROP_KEYS}
    if isinstance(node, list):
        return [_strip(v) for v in node]
    return node


def sanitize_schema(schema: dict) -> dict:
    """A copy of a tool's ``input_schema`` safe to send as OpenAI ``parameters``.

    Guarantees an object schema with a ``properties`` map (Gemini 400s on a
    no-arg function whose parameters omit ``properties``), and strips keywords
    strict compat layers reject. An empty ``required`` is dropped (some
    validators dislike an empty array); property ``description``s are kept.
    """
    s = _strip(schema) if isinstance(schema, dict) else {}
    if not isinstance(s, dict):
        s = {}
    s["type"] = "object"
    props = s.get("properties")
    s["properties"] = props if isinstance(props, dict) else {}
    req = s.get("required")
    if not isinstance(req, list) or not req:
        s.pop("required", None)
    return s


def to_openai_tool(spec) -> dict:
    """One ``SdkMcpTool`` -> an OpenAI ``tools[]`` function entry.

    ``spec.name`` is the plain tool name (e.g. ``WriteFile``, not the
    ``mcp__atelier__`` alias), which is exactly what the model calls back with.
    """
    return {
        "type": "function",
        "function": {
            "name": spec.name,
            "description": (spec.description or spec.name),
            "parameters": sanitize_schema(spec.input_schema),
        },
    }


def openai_tools_for(specs) -> list[dict]:
    """The OpenAI ``tools`` array for a list of SdkMcpTool specs."""
    return [to_openai_tool(t) for t in specs]


def dispatch_table(specs) -> dict:
    """A name -> SdkMcpTool map so the loop can route a tool_call to its handler.

    A later spec with a duplicate name wins; the light tier has unique names.
    """
    return {t.name: t for t in specs}
