from pathlib import Path

from agency_swarm import Agent, ModelSettings, Agency
from openai.types.shared import Reasoning

from shared_tools.CaptureBrief import CaptureBrief
from shared_tools.ReadBrief import ReadBrief
from shared_tools.VaultWrite import VaultWrite

from config import get_default_model, is_openai_provider

_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions.md"


def create_campaign_agent() -> Agent:
    return Agent(
        name="Campaign Agent",
        description=(
            "Campaign meta-agent that composes the workforce into one coordinated, "
            "gated multi-part deliverable: captures a Brief, decomposes the goal into "
            "deliverables, delegates each to the right specialist, gates each through "
            "the Critic, and publishes only the ones that pass. Turns single-deliverable "
            "runs into end-to-end campaigns; never publishes what the Critic did not pass."
        ),
        instructions=str(_INSTRUCTIONS_PATH),
        tools_folder="./tools",
        model=get_default_model(),
        model_settings=ModelSettings(
            reasoning=Reasoning(effort="medium", summary="auto") if is_openai_provider() else None,
        ),
        tools=[CaptureBrief, ReadBrief, VaultWrite],
        conversation_starters=[
            "Run a full campaign: a launch blog post, a 10-slide deck, and a promo image for project acme.",
            "Plan and execute a multi-part deliverable for our Q3 update, gate each part through the Critic, and publish what passes.",
            "Decompose this goal into deliverables, delegate them, review each against the brief, and publish only the ones that ship.",
        ],
    )


if __name__ == "__main__":
    import contextlib
    import os

    with open(os.devnull, "w") as devnull, contextlib.redirect_stderr(devnull):
        Agency(create_campaign_agent()).terminal_demo()
