"""Advance one deliverable of a campaign with its produced path and Critic verdict.

Thin BaseTool wrapper over campaign_core.record_result. Loads the campaign by id,
advances the named deliverable (planned -> produced when a result comes in,
-> gated once the Critic's verdict is recorded), and re-saves the campaign to the
shared store. The verdict recorded here is what campaign_core.gate() enforces at
publish time, so this is the single point where the Critic's decision is written
into the campaign's gate state.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.memory_core import memory_path

try:  # runtime: campaign_agent is an importable top-level package
    from campaign_agent.campaign_core import (
        campaign_status,
        gate,
        load_campaign,
        record_result,
        save_campaign,
    )
except ImportError:  # pragma: no cover - path-based fallback
    from campaign_core import (
        campaign_status,
        gate,
        load_campaign,
        record_result,
        save_campaign,
    )


class RecordDeliverable(BaseTool):
    """
    Record the result of one campaign deliverable. Give the campaign id, the
    deliverable's type (matching how it was planned), the path where the finished
    file/note lives, and the Critic's verdict for it (ship / revise / block). With
    a path but no verdict the deliverable moves to "produced"; once a verdict is
    supplied it moves to "gated" — and only a "ship" verdict makes it publishable
    (that gate is enforced in code, so a revise/block/absent verdict can never be
    handed to the Publisher). Call this after the Critic Agent has scored the
    deliverable against the Brief. Returns the updated gate for that deliverable.
    """

    campaign_id: str = Field(
        ...,
        description="Id of the campaign to update (as returned by StartCampaign). A project name also resolves.",
    )
    dtype: str = Field(
        ...,
        description="The deliverable's type, matching how it was planned (e.g. 'slides', 'docs', 'video').",
    )
    path: str = Field(
        default="",
        description="Absolute path/URL where the finished deliverable lives. Leave empty if not yet produced.",
    )
    verdict: str = Field(
        default="",
        description=(
            "The Critic's verdict for this deliverable: 'ship', 'revise', or "
            "'block'. Leave empty to only mark it produced. Only 'ship' makes it "
            "publishable; anything else is gated out."
        ),
    )

    def run(self) -> str:
        campaign = load_campaign(self.campaign_id, memory_path())
        if not campaign:
            return f"No campaign found for {self.campaign_id!r}."

        path = self.path.strip() or None
        verdict = self.verdict.strip() or None
        updated = record_result(campaign, self.dtype, path=path, verdict=verdict)
        save_campaign(updated, memory_path())

        deliverable = next(
            (d for d in updated.get("deliverables", [])
             if isinstance(d, dict) and str(d.get("type") or "").strip() == self.dtype.strip()),
            None,
        )
        if deliverable is None:
            return (
                f"Campaign {campaign.get('id')}: no deliverable of type "
                f"{self.dtype!r} was planned. Nothing recorded."
            )
        status = campaign_status(updated)
        return (
            f"Recorded [{self.dtype}] for campaign {updated.get('id')}: "
            f"status={deliverable.get('status')}, verdict={deliverable.get('verdict')}, "
            f"gate={gate(deliverable)}. "
            f"{status['ready_to_publish']} of {status['total']} deliverable(s) "
            f"now ready to publish."
        )
