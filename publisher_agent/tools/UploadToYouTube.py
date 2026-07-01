"""Upload a finished video file to YouTube (Data API v3).

Thin BaseTool wrapper around the pure functions in ``youtube_core``. All real
logic (request building, upload, credential handling) lives there so it can be
tested without agency_swarm, pydantic, or the network.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from .youtube_core import get_service, upload_video


class UploadToYouTube(BaseTool):
    """
    Upload a video file to YouTube.

    Fills the YouTube gap that Composio does not cover. Uploads the video at
    `file_path` with the given title/description/tags and privacy status
    (public, unlisted, or private). Requires YouTube OAuth credentials configured
    via the YOUTUBE_TOKEN_FILE / YOUTUBE_CLIENT_SECRETS environment variables.
    Returns the watch URL on success or a clear error message.
    """

    file_path: str = Field(..., description="Absolute path to the video file to upload.")
    title: str = Field(..., description="Video title shown on YouTube.")
    description: str = Field("", description="Video description text.")
    tags: list[str] = Field(
        default_factory=list, description="List of tag strings for the video."
    )
    privacy: str = Field(
        "unlisted",
        description="Privacy status: 'public', 'unlisted', or 'private'. Defaults to 'unlisted'.",
    )
    publish_at: str = Field(
        "",
        description=(
            "Optional ISO-8601/RFC3339 timestamp (UTC) to schedule the video, e.g. "
            "'2026-07-05T14:00:00Z'. When set, YouTube keeps the video private until "
            "this future time, overriding 'privacy'. Must be in the future."
        ),
    )

    def run(self) -> str:
        meta = {
            "title": self.title,
            "description": self.description,
            "tags": self.tags,
            "privacy": self.privacy,
            "publish_at": self.publish_at or None,
        }
        result = upload_video(self.file_path, meta, service_factory=get_service)
        if not result.get("ok"):
            return f"Error: {result.get('error', 'unknown error')}"
        return (
            f"Uploaded '{result['title']}' to YouTube ({result['privacy']}): "
            f"{result['url']}"
        )
