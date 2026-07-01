"""Persist a durable fact / decision to the swarm's memory store."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.memory_core import remember


class RememberFact(BaseTool):
    """
    Save a durable fact, decision, or piece of state to the swarm's persistent
    memory. Memory survives across runs and can be recalled later with
    RecallMemory. Use this to record decisions made, user preferences, project
    status changes, or anything a future run should know.
    """

    kind: str = Field(
        default="fact",
        description="Category of the entry, e.g. 'decision', 'fact', 'state', 'preference'.",
    )
    text: str = Field(
        ...,
        description="The fact or note to remember.",
    )
    project: str = Field(
        default="",
        description="Optional project name this entry belongs to.",
    )

    def run(self) -> str:
        entry = remember(self.kind, self.text, self.project or None)
        proj = f" [{entry['project']}]" if entry.get("project") else ""
        return f"Remembered ({entry['kind']}){proj}: {entry['text']}"
