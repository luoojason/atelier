"""Write a generated note into the Obsidian knowledge vault."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.vault_core import write_note


class VaultWrite(BaseTool):
    """
    Write a generated note into the user's Obsidian knowledge vault, with proper
    YAML frontmatter (title, tags, last_updated). Use this to persist research
    syntheses, analyses, or session summaries so they become durable, linkable
    knowledge.

    Notes are written into a vault subfolder (default "Analysis"). Writing under
    Sources/ is refused because those are immutable originals.
    """

    folder: str = Field(
        default="Analysis",
        description="Vault subfolder to write into (e.g. 'Analysis', 'Sessions/Auto Logs'). Never 'Sources'.",
    )
    title: str = Field(
        ...,
        description="Note title; also used as the filename.",
    )
    body: str = Field(
        ...,
        description="Markdown body of the note (frontmatter is added automatically).",
    )
    tags: list[str] = Field(
        default=[],
        description="Optional list of tags for the note's frontmatter.",
    )

    def run(self) -> str:
        try:
            path = write_note(self.folder, self.title, self.body, self.tags)
        except ValueError as exc:
            return f"Error: {exc}"
        return f"Wrote note to: {path}"
