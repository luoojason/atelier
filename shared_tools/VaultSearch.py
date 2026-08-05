"""Search the Obsidian knowledge vault for notes matching a query."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.vault_core import VaultUnavailableError, search_vault


class VaultSearch(BaseTool):
    """
    Search the user's Obsidian knowledge vault (a directory of Markdown notes)
    for notes matching a query. Returns a ranked list of hits with each note's
    relative path, title, and a short snippet around the match.

    Use this to pull existing context, prior decisions, project status, or
    reference material before starting work. Notes under Sources/ are the
    immutable originals and are skipped.
    """

    query: str = Field(
        ...,
        description="Text to search for across note titles and bodies (case-insensitive).",
    )
    limit: int = Field(
        default=5,
        description="Maximum number of matching notes to return.",
    )

    def run(self) -> str:
        try:
            hits = search_vault(self.query, self.limit)
        except VaultUnavailableError as exc:
            # NOT "no notes matched": the vault was never scanned. Say so, or
            # the agent concludes the vault is empty and moves on.
            return (
                f"ERROR: the vault could not be searched — {exc} "
                f"No search was performed, so this is NOT evidence that the "
                f"vault lacks notes about {self.query!r}."
            )
        if not hits:
            return f"No vault notes found for query: {self.query!r}"
        lines = [f"Found {len(hits)} note(s) for {self.query!r}:", ""]
        for i, hit in enumerate(hits, 1):
            lines.append(f"{i}. {hit['title']}  ({hit['path']})")
            lines.append(f"   {hit['snippet']}")
        return "\n".join(lines)
