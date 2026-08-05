"""Read the full text of a single note from the Obsidian knowledge vault."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.vault_core import VaultUnavailableError, read_note


class VaultRead(BaseTool):
    """
    Read the full text of one note from the user's Obsidian knowledge vault.

    The note can be identified by its relative path within the vault
    (e.g. "Projects/GeoAI.md") or by its title / filename (e.g. "GeoAI").
    Use this after VaultSearch to load a specific note's contents.
    """

    note: str = Field(
        ...,
        description="Relative path within the vault, or the note's title / filename.",
    )

    def run(self) -> str:
        try:
            return read_note(self.note)
        except VaultUnavailableError as exc:
            # Distinct from "note not found": nothing was looked in at all.
            return (
                f"ERROR: the vault could not be opened — {exc} "
                f"No lookup was performed, so this says nothing about whether "
                f"the note {self.note!r} exists."
            )
        except FileNotFoundError as exc:
            return f"Error: {exc}"
