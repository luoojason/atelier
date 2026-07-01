"""List the background-clip library used to render narrated shorts.

Thin BaseTool wrapper around the pure functions in ``shorts_core``. All real
logic lives there so it can be tested without agency_swarm, pydantic, or the
heavy media pipeline.
"""

from agency_swarm.tools import BaseTool

from .shorts_core import list_backgrounds_production


class ListBackgrounds(BaseTool):
    """
    List the background clip library available for rendering narrated shorts.

    Shows each background clip's length and filename so you can confirm the
    library is seeded before rendering. Requires the reddit-shorts pipeline
    installed on the agency host; otherwise a clear DEGRADED-MODE message is
    returned.
    """

    def run(self) -> str:
        return list_backgrounds_production()
