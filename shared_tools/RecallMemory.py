"""Recall entries from the swarm's persistent memory store."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.memory_core import recall


class RecallMemory(BaseTool):
    """
    Recall entries from the swarm's persistent memory. With no query, returns the
    most recent entries; with a query, returns entries whose text, kind, or
    project match it. Use this at the start of a task to reload prior decisions,
    user preferences, and project state saved by RememberFact.
    """

    query: str = Field(
        default="",
        description="Optional substring to filter memory entries. Empty returns the most recent entries.",
    )
    limit: int = Field(
        default=20,
        description="Maximum number of entries to return.",
    )

    def run(self) -> str:
        entries = recall(self.query or None, self.limit)
        if not entries:
            scope = f" for {self.query!r}" if self.query else ""
            return f"No memory entries found{scope}."
        lines = [f"{len(entries)} memory entr(y/ies):", ""]
        for e in entries:
            proj = f" [{e['project']}]" if e.get("project") else ""
            ts = str(e.get("ts", ""))[:19]
            lines.append(f"- ({e.get('kind', 'note')}){proj} {ts}: {e.get('text', '')}")
        return "\n".join(lines)
