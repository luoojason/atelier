"""List the files in the agent's sandboxed project workspace."""

from agency_swarm.tools import BaseTool

from shared_tools.workspace_core import list_files


class ListFiles(BaseTool):
    """
    List every file currently in your project workspace (relative paths) so you
    can see what you have built so far before reading or extending it. Takes no
    arguments.
    """

    def run(self) -> str:
        files = list_files()
        if not files:
            return "The workspace is empty."
        return "Workspace files:\n" + "\n".join(files)
