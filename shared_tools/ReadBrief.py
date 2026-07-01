"""Reload the latest structured brief for a project from swarm memory."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.brief_core import load_brief
from shared_tools.memory_core import memory_path


class ReadBrief(BaseTool):
    """
    Reload the most recent structured brief for a project, as saved by
    CaptureBrief. Use this at the start of a task to recover the goal, output
    format, must-include / must-avoid constraints, and acceptance criteria
    instead of re-deriving them from the chat history. Returns a readable summary
    of the brief, or a note that none was found.
    """

    project: str = Field(
        default="",
        description="Project name whose latest brief to load. Leave empty for the unscoped (no-project) brief.",
    )

    def run(self) -> str:
        brief = load_brief(self.project, memory_path())
        if not brief:
            scope = f" for project {self.project!r}" if self.project else ""
            return f"No brief found{scope}."
        lines = []
        proj = brief.get("project")
        header = f"Brief [{proj}]:" if proj else "Brief:"
        lines.append(header)
        lines.append(f"- goal: {brief.get('goal', '')}")
        if brief.get("fmt"):
            lines.append(f"- format: {brief['fmt']}")
        for label, key in (
            ("must include", "must_include"),
            ("must avoid", "must_avoid"),
            ("done criteria", "done_criteria"),
        ):
            items = brief.get(key) or []
            if items:
                lines.append(f"- {label}:")
                lines.extend(f"    - {item}" for item in items)
        return "\n".join(lines)
