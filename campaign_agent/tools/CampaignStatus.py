"""Load a campaign by id/project and return its compact status summary.

Thin BaseTool wrapper over campaign_core.load_campaign + campaign_status. Read
only: it never advances or mutates the campaign, it just reports where the
campaign stands — counts by deliverable status, counts by gate, and how many
deliverables are ready to publish (gate == ship).
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.memory_core import memory_path

try:  # runtime: campaign_agent is an importable top-level package
    from campaign_agent.campaign_core import (
        campaign_status,
        load_campaign,
        ready_to_publish,
    )
except ImportError:  # pragma: no cover - path-based fallback
    from campaign_core import campaign_status, load_campaign, ready_to_publish


class CampaignStatus(BaseTool):
    """
    Report where a campaign stands. Give the campaign id (or its project name)
    and this loads the latest saved campaign and returns a compact summary: the
    stage, total deliverables, counts by status (planned / produced / gated),
    counts by gate (ship / revise / block), and which deliverables are ready to
    publish. Use it to decide what still needs producing or reviewing, and which
    deliverables can be handed to the Publisher.
    """

    campaign_id: str = Field(
        ...,
        description="Id (or project name) of the campaign to inspect, as returned by StartCampaign.",
    )

    def run(self) -> str:
        campaign = load_campaign(self.campaign_id, memory_path())
        if not campaign:
            return f"No campaign found for {self.campaign_id!r}."

        s = campaign_status(campaign)
        lines = [
            f"Campaign {s['id']} — stage: {s['stage']}",
            f"Goal: {s['goal']}",
        ]
        if s.get("project"):
            lines.append(f"Project: {s['project']}")
        lines.append(
            f"Deliverables: {s['total']} total | "
            + ", ".join(f"{k}={v}" for k, v in s["by_status"].items())
            if s["by_status"]
            else f"Deliverables: {s['total']} total"
        )
        lines.append(
            "Gates: "
            + ", ".join(f"{k}={v}" for k, v in s["by_gate"].items())
        )
        ready = ready_to_publish(campaign)
        lines.append(f"Ready to publish ({len(ready)}):")
        if ready:
            for d in ready:
                path = d.get("path") or "(no path)"
                lines.append(f"  - [{d.get('type') or 'untyped'}] {path}")
        else:
            lines.append("  - none yet (nothing has a shippable Critic verdict)")
        return "\n".join(lines)
