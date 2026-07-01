"""Render an ORIGINAL narrated 9:16 short from text you provide.

Thin BaseTool wrapper around the pure functions in ``shorts_core``. All real
logic (validation, pipeline loading, degraded-mode handling) lives there so it
can be tested without agency_swarm, pydantic, or the heavy media pipeline.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from .shorts_core import render_short_production


class RenderShortFromText(BaseTool):
    """
    Render an original narrated vertical (9:16) short video from text.

    This is the PREFERRED way to make a short: it narrates your own script over a
    background clip with word-synced captions, avoiding Reddit ToS / copyright
    concerns. Provide the narration `text` (and an optional spoken `title`).
    Requires the reddit-shorts pipeline installed on the agency host (the
    `reddit-shorts-media` conda env plus a seeded background-clip library);
    otherwise a clear DEGRADED-MODE message is returned. Returns the output
    .mp4 path on success.
    """

    text: str = Field(..., description="The narration body spoken in the short.")
    title: str = Field(
        "",
        description="Optional title spoken first and used in the output filename.",
    )

    def run(self) -> str:
        return render_short_production(text=self.text, title=self.title)
