"""Write a file into the agent's sandboxed project workspace."""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.workspace_core import write_file


class WriteFile(BaseTool):
    """
    Write a file into your project workspace on disk so you can produce a REAL,
    runnable deliverable — a code project, a script, a data file — instead of
    only text in the chat. Use a relative path; subfolders are created as needed
    (e.g. 'yt-pipeline/pipeline.py'). Call it once per file to scaffold a whole
    project, then tell the user the returned path so they can review and run it.
    Files are written verbatim and are NEVER executed; everything stays inside
    one workspace directory and paths that try to escape it are refused.
    """

    path: str = Field(
        ...,
        description="Relative path within the workspace, e.g. 'project/main.py'."
        " No absolute paths and no '..'.",
    )
    content: str = Field(
        ...,
        description="The full file content to write (overwrites any existing"
        " file at this path).",
    )

    def run(self) -> str:
        try:
            written = write_file(self.path, self.content)
        except (ValueError, OSError) as exc:
            return f"Error: {exc}"
        return f"Wrote file to: {written}"
