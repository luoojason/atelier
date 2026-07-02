"""Wrap agency_swarm BaseTool subclasses as claude-agent-sdk @tool functions.

Each lite tool is a pydantic v2 BaseTool with Field-annotated attributes and a
sync ``run(self) -> str``. This module introspects a class's ``model_fields`` to
build the SDK's arg schema, then calls the *instance's* ``run()`` verbatim in a
worker thread — run() does blocking file IO under fcntl locks, so it must never
run on the async event loop. The tool logic (hardened over a 28-bug debug) is
reused as-is; this module NEVER reimplements a tool.

The @tool name is the class ``__name__`` so ``allowed_tools`` and any
instructions that reference tool names stay correct; the description is the
class docstring.
"""

import typing

import anyio

from claude_agent_sdk import create_sdk_mcp_server, tool

# pydantic field annotation -> JSON Schema type. A field whose type is not one
# of these (unusual for the lite tools) maps to "string": the model then passes
# a string and BaseTool coerces / treats it as text rather than the schema
# rejecting the call.
_JSON_TYPE = {
    str: "string",
    int: "integer",
    bool: "boolean",
    float: "number",
    list: "array",
    dict: "object",
}


def _field_schema(field) -> dict:
    # Normalize parametrized generics before the lookup: get_origin(list[str])
    # is `list`, so list[str]/dict[str,int]/etc. map to their container type
    # instead of falling through to "string" (a bare type has no origin, so we
    # fall back to the annotation itself).
    annotation = field.annotation
    origin = typing.get_origin(annotation) or annotation
    prop = {"type": _JSON_TYPE.get(origin, "string")}
    # For a typed list, publish the element type so array items validate and the
    # model knows to send e.g. strings (pydantic list[str] rejects non-str).
    if prop["type"] == "array":
        args = typing.get_args(annotation)
        if args and args[0] in _JSON_TYPE:
            prop["items"] = {"type": _JSON_TYPE[args[0]]}
    if field.description:
        prop["description"] = field.description
    return prop


def _build_input_schema(tool_cls) -> dict:
    """A full JSON Schema object for the class's pydantic fields.

    We emit the whole ``{type, properties, required}`` object (which the SDK
    passes through verbatim) rather than the shorthand ``{name: type}`` dict,
    because the shorthand force-marks EVERY property required. Defaulted fields
    must stay optional so the model can omit them and BaseTool(**args) falls
    back to the pydantic default.
    """
    properties = {}
    required = []
    for name, field in tool_cls.model_fields.items():
        properties[name] = _field_schema(field)
        if field.is_required():
            required.append(name)
    return {"type": "object", "properties": properties, "required": required}


def wrap_tool(tool_cls):
    """Wrap one BaseTool subclass as an SdkMcpTool that calls its run()."""
    name = tool_cls.__name__
    description = (tool_cls.__doc__ or name).strip()
    schema = _build_input_schema(tool_cls)

    @tool(name, description, schema)
    async def _handler(args):
        # run() blocks (file IO under fcntl locks) — keep it off the loop.
        text = await anyio.to_thread.run_sync(lambda: tool_cls(**args).run())
        return {"content": [{"type": "text", "text": str(text)}]}

    return _handler


def build_atelier_server(tool_classes, name="atelier", version="1.0.0"):
    """Build one in-process MCP server over all the given BaseTool classes.

    Returns ``(server, allowed_tools)`` where allowed_tools is the
    ``mcp__<name>__<ClassName>`` list to hand ClaudeAgentOptions.
    """
    tools = [wrap_tool(cls) for cls in tool_classes]
    server = create_sdk_mcp_server(name=name, version=version, tools=tools)
    allowed = [f"mcp__{name}__{cls.__name__}" for cls in tool_classes]
    return server, allowed
