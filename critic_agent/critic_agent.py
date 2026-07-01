from pathlib import Path

from agency_swarm import Agent, ModelSettings, Agency
from openai.types.shared import Reasoning

from shared_tools.ReadBrief import ReadBrief

from config import get_default_model, is_openai_provider

_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions.md"


def create_critic_agent() -> Agent:
    return Agent(
        name="Critic Agent",
        description="Review-only pre-publish critic. Loads the persisted Brief, scores a finished deliverable against goal / must_include / must_avoid / done_criteria, cites evidence for every defect, and returns a gated verdict (ship, revise, or block). Never authors or edits content, and never rubber-stamps.",
        instructions=str(_INSTRUCTIONS_PATH),
        tools_folder="./tools",
        model=get_default_model(),
        model_settings=ModelSettings(
            reasoning=Reasoning(effort="medium", summary="auto") if is_openai_provider() else None,
        ),
        tools=[ReadBrief],
        conversation_starters=[
            "Review this finished blog post against the brief before I publish it.",
            "Score this deliverable and tell me whether to ship, revise, or block.",
            "Check the draft report against the acceptance criteria for project acme.",
        ],
    )


if __name__ == "__main__":
    import contextlib
    import os

    with open(os.devnull, "w") as devnull, contextlib.redirect_stderr(devnull):
        Agency(create_critic_agent()).terminal_demo()
