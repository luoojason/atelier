from agency_swarm import Agent, ModelSettings
from agency_swarm.tools import (
    WebSearchTool,
    PersistentShellTool,
    IPythonInterpreter,
)
from openai.types.shared import Reasoning

from config import get_default_model, is_openai_provider
from run_utils import _load_openswarm_dotenv
from shared_tools import CopyFile, ExecuteTool, FindTools, ManageConnections, SearchTools

_load_openswarm_dotenv()


# The General Agent's instructions refer to the code-execution tool as
# "ProgrammaticToolCalling" (the Composio programmatic-call workflow), while
# every other agent (Data Analyst, Docs, Slides, Deep Research) refers to the
# SAME shared class as "IPythonInterpreter". The model-facing tool name is
# derived from the class __name__, so renaming the shared IPythonInterpreter
# in place would contaminate all those other agents. Instead, expose a thin
# local subclass to the General Agent only: it inherits the interpreter's
# behavior, docstring, schema, and the Composio run-patch, but carries its own
# name, leaving the shared class untouched for the other agents.
class ProgrammaticToolCalling(IPythonInterpreter):
    __doc__ = IPythonInterpreter.__doc__


def create_virtual_assistant() -> Agent:
    return Agent(
        name="General Agent",
        description="Your virtual assistant that connects to 10000+ external systems.",
        instructions="./instructions.md",
        files_folder="./files",
        tools_folder="./tools",
        model=get_default_model(),
        model_settings=ModelSettings(
            reasoning=Reasoning(effort="medium", summary="auto") if is_openai_provider() else None,
            response_include=["web_search_call.action.sources"] if is_openai_provider() else None,
        ),
        tools=[
            WebSearchTool(),
            PersistentShellTool,
            ProgrammaticToolCalling,
            CopyFile,
            ExecuteTool,
            FindTools,
            ManageConnections,
            SearchTools,
        ],
        conversation_starters=[
            "Send a summary of my unread emails to Slack.",
            "Schedule a meeting with my team for next Monday.",
            "What external systems do I have connected?",
            "Draft and send a follow-up email to my last meeting attendees.",
        ],
    )


if __name__ == "__main__":
    from agency_swarm import Agency
    Agency(create_virtual_assistant()).terminal_demo()
