"""Regression tests for the shared IPythonInterpreter tool name (bug: the
General Agent globally renamed the shared class, contaminating every other
agent's interpreter tool name).

These build real agents, so they import agency_swarm and MUST run under the
external venv:

    /Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python tests/test_interpreter_tool_name.py

The IPythonInterpreter built-in requires jupyter_client (agency-swarm[jupyter]),
which the lean external venv does not ship. The kernel is never started in
these tests — only class metadata and the FunctionTool adapter are exercised —
so a minimal jupyter_client stub is registered before importing agency_swarm.
"""

import importlib.machinery
import os
import sys
import types

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# A default model that needs no provider key or network, so create_* can build.
os.environ.setdefault("DEFAULT_MODEL", "gpt-5.4")


def _stub_module(name, **attrs):
    module = types.ModuleType(name)
    module.__spec__ = importlib.machinery.ModuleSpec(name, loader=None)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)


# Let the jupyter-gated IPythonInterpreter import without the real kernel deps.
_stub_module("jupyter_client", AsyncKernelManager=type("AsyncKernelManager", (), {}))

from agency_swarm.tools import IPythonInterpreter  # noqa: E402
from agency_swarm.tools.tool_factory_utils.base_tool_adapter import (  # noqa: E402
    adapt_base_tool,
)

# Import the General Agent module FIRST — this reproduces the product path where
# create_agency imports virtual_assistant before building the other agents. The
# old bug mutated IPythonInterpreter.__name__ here at import time.
import virtual_assistant.virtual_assistant as va  # noqa: E402
from data_analyst_agent import create_data_analyst  # noqa: E402


def test_shared_class_name_not_mutated_by_general_agent_import():
    # Importing the General Agent must NOT rename the shared class; other agents
    # (Data Analyst, Docs, Slides, Deep Research) reference it as this name.
    assert IPythonInterpreter.__name__ == "IPythonInterpreter"
    assert adapt_base_tool(IPythonInterpreter).name == "IPythonInterpreter"


def test_general_agent_sees_programmatic_tool_calling():
    # The General Agent still exposes the interpreter under the Composio-facing
    # name its instructions use, via a subclass — not by mutating the shared one.
    assert issubclass(va.ProgrammaticToolCalling, IPythonInterpreter)
    assert va.ProgrammaticToolCalling is not IPythonInterpreter
    assert adapt_base_tool(va.ProgrammaticToolCalling).name == "ProgrammaticToolCalling"
    # Behaviour/schema/description are inherited (not an empty stub tool).
    assert adapt_base_tool(va.ProgrammaticToolCalling).description
    assert va.ProgrammaticToolCalling.run is IPythonInterpreter.run


def test_data_analyst_interpreter_tool_named_ipython_end_to_end():
    # End-to-end: build the real Data Analyst after importing the General Agent
    # and confirm its interpreter tool is exposed as "IPythonInterpreter" — the
    # exact name its instructions tell the model to call — not the contaminated
    # "ProgrammaticToolCalling".
    agent = create_data_analyst()
    tool_names = [getattr(tool, "name", None) for tool in agent.tools]
    assert "IPythonInterpreter" in tool_names
    assert "ProgrammaticToolCalling" not in tool_names


def _run_all():
    funcs = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    passed = 0
    failed = 0
    for name, func in funcs:
        try:
            func()
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"ok   {name}")
    print(f"\n{passed} passed, {failed} failed, {len(funcs)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
