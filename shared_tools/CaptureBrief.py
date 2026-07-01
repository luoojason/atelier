"""Capture a structured task brief + acceptance criteria into swarm memory."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.brief_core import build_brief, save_brief
from shared_tools.memory_core import memory_path


class CaptureBrief(BaseTool):
    """
    Capture a structured brief for the current task: the goal, an optional output
    format, things that must be included or avoided, and explicit done_criteria.
    The brief is saved to persistent memory keyed by project and can be reloaded
    later with ReadBrief. Everything except the goal is optional, so a trivial
    one-shot ask is not bogged down; fill in the extra fields only when a run has
    real constraints or acceptance criteria worth pinning down.
    """

    goal: str = Field(
        ...,
        description="What the task is trying to achieve, in one or two sentences.",
    )
    fmt: str = Field(
        default="",
        description="Optional desired output format, e.g. 'markdown report', 'slide deck', '3 tweets'.",
    )
    must_include: list[str] = Field(
        default_factory=list,
        description="Optional list of things the output must include.",
    )
    must_avoid: list[str] = Field(
        default_factory=list,
        description="Optional list of things the output must avoid.",
    )
    done_criteria: list[str] = Field(
        default_factory=list,
        description="Optional list of acceptance criteria that mark the task complete.",
    )
    project: str = Field(
        default="",
        description="Optional project name this brief belongs to. Used to key and later recall the brief.",
    )

    def run(self) -> str:
        brief = build_brief(
            self.goal,
            fmt=self.fmt,
            must_include=self.must_include,
            must_avoid=self.must_avoid,
            done_criteria=self.done_criteria,
            project=self.project,
        )
        entry = save_brief(brief, memory_path())
        proj = f" [{entry['project']}]" if entry.get("project") else ""
        extras = []
        if brief["fmt"]:
            extras.append(f"format={brief['fmt']}")
        if brief["must_include"]:
            extras.append(f"{len(brief['must_include'])} must-include")
        if brief["must_avoid"]:
            extras.append(f"{len(brief['must_avoid'])} must-avoid")
        if brief["done_criteria"]:
            extras.append(f"{len(brief['done_criteria'])} done-criteria")
        suffix = f" ({', '.join(extras)})" if extras else ""
        return f"Captured brief{proj}: {brief['goal']}{suffix}"
