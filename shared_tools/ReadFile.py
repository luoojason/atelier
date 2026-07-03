"""Read a file back from the agent's sandboxed project workspace."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.workspace_core import read_file


class ReadFile(BaseTool):
    """
    Read a file you previously wrote into your project workspace, so you can
    review or extend it across turns. Relative path within the workspace only;
    files outside the workspace cannot be read.
    """

    path: str = Field(
        ...,
        description="Relative path within the workspace to read, e.g."
        " 'project/main.py'.",
    )

    def run(self) -> str:
        try:
            return read_file(self.path)
        except (FileNotFoundError, ValueError, OSError) as exc:
            return f"Error: {exc}"
