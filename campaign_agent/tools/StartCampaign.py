"""Plan a multi-part campaign from a goal and its deliverables, then persist it.

Thin BaseTool wrapper: all state logic lives in campaign_core. This tool mints a
campaign id, pulls the latest captured Brief for the project (so the Critic can
later score each deliverable against it), plans one deliverable per spec, and
saves the campaign to the shared memory store (kind="campaign") via
campaign_core.save_campaign — the same durable, locked, atomic write path memory
entries and briefs use.
"""

import uuid
from datetime import datetime, timezone

from agency_swarm.tools import BaseTool
from pydantic import Field

from shared_tools.brief_core import load_brief
from shared_tools.memory_core import memory_path

try:  # runtime: campaign_agent is an importable top-level package
    from campaign_agent.campaign_core import plan_campaign, save_campaign
except ImportError:  # pragma: no cover - path-based fallback
    from campaign_core import plan_campaign, save_campaign


class StartCampaign(BaseTool):
    """
    Plan and persist a multi-part campaign. Give the overall goal, an optional
    project name, and the list of deliverables the goal decomposes into (each a
    short type + spec, e.g. {"type": "slides", "spec": "10-slide overview deck"}).
    This creates a campaign with every deliverable marked "planned", attaches the
    latest captured Brief for the project (capture it first with CaptureBrief so
    the Critic has intent to score against), saves it, and returns the campaign
    id plus the plan. Use the returned id with RecordDeliverable and
    CampaignStatus to drive and inspect the rest of the pipeline.
    """

    goal: str = Field(
        ...,
        description="The overall campaign goal, in one or two sentences.",
    )
    project: str = Field(
        default="",
        description="Optional project name. Used to load the matching Brief and to key/recall the campaign.",
    )
    deliverables: list = Field(
        default_factory=list,
        description=(
            "The deliverables the goal decomposes into. Each item is a dict with "
            "'type' and 'spec' (e.g. {'type': 'docs', 'spec': 'one-page brief'}), "
            "or a bare type string. One deliverable is planned per item."
        ),
    )

    def run(self) -> str:
        cid = f"cmp_{uuid.uuid4().hex[:8]}"
        ts = datetime.now(timezone.utc).isoformat()
        brief = load_brief(self.project, memory_path())
        campaign = plan_campaign(
            cid,
            self.goal,
            self.project,
            self.deliverables,
            brief=brief,
            ts=ts,
        )
        save_campaign(campaign, memory_path())

        lines = [f"Started campaign {cid}: {campaign['goal']}"]
        if campaign.get("project"):
            lines[0] += f" [{campaign['project']}]"
        lines.append(f"Brief attached: {'yes' if brief else 'no'}")
        lines.append(f"Planned {len(campaign['deliverables'])} deliverable(s):")
        for d in campaign["deliverables"]:
            spec = f" — {d['spec']}" if d.get("spec") else ""
            lines.append(f"  - [{d['type'] or 'untyped'}] planned{spec}")
        lines.append(
            "Next: produce each deliverable with the right specialist, have the "
            "Critic score it, then RecordDeliverable with its path + verdict."
        )
        return "\n".join(lines)
