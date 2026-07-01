from pathlib import Path

from agency_swarm import Agent, ModelSettings, Agency
from openai.types.shared import Reasoning
from shared_tools import CopyFile

from config import get_default_model, is_openai_provider

_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions.md"


def create_publisher_agent() -> Agent:
    return Agent(
        name="Publisher Agent",
        description="Delivery specialist that publishes finished deliverables to their destination — uploads video to YouTube, writes notes to the Obsidian vault, and routes Composio-covered targets (email, Drive, LinkedIn, X, Instagram) to the General Agent.",
        instructions=str(_INSTRUCTIONS_PATH),
        files_folder="./files",
        tools_folder="./tools",
        model=get_default_model(),
        model_settings=ModelSettings(
            reasoning=Reasoning(effort="medium", summary="auto") if is_openai_provider() else None,
        ),
        tools=[CopyFile],
        conversation_starters=[
            "Upload the finished video at ./mnt/launch/generated_videos/promo.mp4 to YouTube as unlisted.",
            "Publish this research summary as a note in my Obsidian vault under Analysis.",
            "Email the final report to the client.",
            "Post the launch announcement to LinkedIn and X.",
        ],
    )


if __name__ == "__main__":
    import contextlib
    import os

    with open(os.devnull, "w") as devnull, contextlib.redirect_stderr(devnull):
        Agency(create_publisher_agent()).terminal_demo()
