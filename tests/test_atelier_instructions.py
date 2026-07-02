"""Tests for ATELIER_INSTRUCTIONS' anti-confabulation honesty clause and web
tool advertisement (lite_server.py).

Atelier agents could not search or read the web, so any request needing
current or external information had to be confabulated from training
knowledge. Now that WebSearch/WebFetch exist (shared_tools/web_tools.py),
the system prompt must (a) tell the agent it has them and (b) tell it to
say so plainly rather than fabricate sources/URLs/live data when a tool is
missing, errors, or returns nothing.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_atelier_instructions.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402


def test_instructions_advertise_web_tools():
    assert "WebSearch" in lite_server.ATELIER_INSTRUCTIONS
    assert "WebFetch" in lite_server.ATELIER_INSTRUCTIONS


def test_instructions_contain_honesty_clause():
    text = lite_server.ATELIER_INSTRUCTIONS
    assert "say so plainly" in text
    assert "NEVER present training-knowledge" in text
    assert "do not fabricate sources, URLs, or live data" in text
