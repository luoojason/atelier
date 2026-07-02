"""Tests for shared_tools.sdk_tools — the generic BaseTool -> claude-agent-sdk
@tool factory. No network: each wrapped tool's handler just calls the class's
run() in a worker thread, so we exercise the wrapping and schema, not a model.

    .venv-ext/bin/python -m pytest -q tests/test_sdk_tools.py
"""

import os
import sys

import anyio
import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")
pytest.importorskip("agency_swarm")

from agency_swarm.tools import BaseTool  # noqa: E402
from pydantic import Field  # noqa: E402

from shared_tools import sdk_tools  # noqa: E402


class _Echo(BaseTool):
    """Echo the given text back, optionally shouting."""

    text: str = Field(..., description="What to echo.")
    times: int = Field(default=1, description="How many times to repeat it.")
    shout: bool = Field(default=False, description="Uppercase the output.")

    def run(self) -> str:
        out = " ".join([self.text] * self.times)
        return out.upper() if self.shout else out


def _invoke(handler, args):
    return anyio.run(handler.handler, args)


def test_wrap_produces_sdk_tool_named_after_class():
    wrapped = sdk_tools.wrap_tool(_Echo)
    assert wrapped.name == "_Echo"
    assert wrapped.description == "Echo the given text back, optionally shouting."


def test_schema_types_and_required_only_covers_required_fields():
    schema = sdk_tools._build_input_schema(_Echo)
    assert schema["type"] == "object"
    props = schema["properties"]
    assert props["text"] == {"type": "string", "description": "What to echo."}
    assert props["times"]["type"] == "integer"
    assert props["shout"]["type"] == "boolean"
    # Only the field without a default is required; defaulted fields stay optional
    # so the model may omit them.
    assert schema["required"] == ["text"]


def test_handler_calls_run_and_returns_content_shape():
    wrapped = sdk_tools.wrap_tool(_Echo)
    result = _invoke(wrapped, {"text": "hi", "times": 3, "shout": True})
    assert result == {"content": [{"type": "text", "text": "HI HI HI"}]}


def test_handler_omitting_defaulted_fields_uses_pydantic_defaults():
    wrapped = sdk_tools.wrap_tool(_Echo)
    # No `times`/`shout`: BaseTool(**args) falls back to the pydantic defaults.
    result = _invoke(wrapped, {"text": "solo"})
    assert result == {"content": [{"type": "text", "text": "solo"}]}


def test_build_atelier_server_over_all_ten_lite_tools():
    from shared_tools import (
        VaultSearch,
        VaultRead,
        VaultWrite,
        RememberFact,
        RecallMemory,
        CaptureBrief,
        ReadBrief,
    )
    from campaign_agent.tools.StartCampaign import StartCampaign
    from campaign_agent.tools.RecordDeliverable import RecordDeliverable
    from campaign_agent.tools.CampaignStatus import CampaignStatus

    classes = [
        VaultSearch, VaultRead, VaultWrite, RememberFact, RecallMemory,
        CaptureBrief, ReadBrief, StartCampaign, RecordDeliverable, CampaignStatus,
    ]
    server, allowed = sdk_tools.build_atelier_server(classes)
    assert server is not None
    assert allowed == [f"mcp__atelier__{c.__name__}" for c in classes]
    assert len(allowed) == 10


def test_list_field_maps_to_array():
    from campaign_agent.tools.StartCampaign import StartCampaign

    schema = sdk_tools._build_input_schema(StartCampaign)
    assert schema["properties"]["deliverables"]["type"] == "array"
    assert schema["required"] == ["goal"]  # project + deliverables are defaulted


def test_parametrized_list_field_maps_to_array():
    # list[str] is a parametrized generic, not the bare `list` type: a naive
    # lookup keyed on the annotation misses it and falls through to "string",
    # which then can never be populated (jsonschema wants array, pydantic wants
    # a list). All four list[str] fields must publish "array" with str items.
    from shared_tools.CaptureBrief import CaptureBrief
    from shared_tools.VaultWrite import VaultWrite

    brief = sdk_tools._build_input_schema(CaptureBrief)
    for field in ("must_include", "must_avoid", "done_criteria"):
        assert brief["properties"][field]["type"] == "array"
        assert brief["properties"][field]["items"] == {"type": "string"}

    vault = sdk_tools._build_input_schema(VaultWrite)
    assert vault["properties"]["tags"]["type"] == "array"
    assert vault["properties"]["tags"]["items"] == {"type": "string"}
