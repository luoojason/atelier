"""Render a narrated 9:16 short from a fetched Reddit story.

Thin BaseTool wrapper around the pure functions in ``shorts_core``. All real
logic lives there so it can be tested without agency_swarm, pydantic, or the
heavy media pipeline.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from .shorts_core import render_short_production


class RenderShortFromReddit(BaseTool):
    """
    Render a narrated vertical (9:16) short video from a top Reddit story.

    Fetches a story from the given `subreddit`, narrates it over a background clip
    with word-synced captions. Prefer RenderShortFromText for original content to
    avoid Reddit ToS / copyright concerns. Requires the reddit-shorts pipeline
    installed on the agency host (the `reddit-shorts-media` conda env plus Reddit
    API credentials and a seeded background-clip library); otherwise a clear
    DEGRADED-MODE message is returned. Returns the output .mp4 path on success.
    """

    subreddit: str = Field(
        ...,
        description="Subreddit to pull the story from (e.g. 'AskReddit').",
    )

    def run(self) -> str:
        return render_short_production(subreddit=self.subreddit)
