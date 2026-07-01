"""One-shot: render a narrated 9:16 short, then upload it to YouTube.

Thin BaseTool wrapper around the pure ``render_and_upload`` in ``oneshot_core``.
It lazily imports the REAL render helper
(``video_generation_agent.tools.shorts_core.render_short_production``) and the
REAL ``upload_video`` (``publisher_agent.tools.youtube_core``), adapts them into
the injected ``render_fn`` / ``upload_fn`` shapes, and chains them.

All import/degraded-mode failures (reddit-shorts media env absent, missing
YouTube credentials) are turned into a clear, actionable error string rather than
crashing, so the agent gets an explanation instead of a stack trace.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field


class RenderAndUploadShort(BaseTool):
    """
    Render a narrated vertical (9:16) short and upload it to YouTube in one step.

    Provide EITHER `text` (original narration you supply — preferred, avoids
    Reddit ToS / copyright concerns) OR `subreddit` (fetch a top story). Exactly
    one is required. The finished .mp4 is uploaded to YouTube with the given
    `title` and `privacy` ('public', 'unlisted', or 'private'); set `publish_at`
    to schedule it (ISO-8601 UTC, future — YouTube keeps it private until then).

    Requires BOTH the reddit-shorts pipeline on the agency host (the
    `reddit-shorts-media` conda env plus a seeded background-clip library) and
    YouTube OAuth credentials (YOUTUBE_TOKEN_FILE / YOUTUBE_CLIENT_SECRETS).
    If rendering degrades or upload creds are missing, a clear message is returned
    and no partial work is left behind. Returns the watch URL on success.
    """

    text: str = Field(
        "", description="Original narration spoken in the short. Use this OR subreddit."
    )
    title: str = Field(
        "",
        description="YouTube title (also spoken first / used in the output filename).",
    )
    subreddit: str = Field(
        "",
        description="Subreddit to pull a story from (e.g. 'AskReddit'). Use this OR text.",
    )
    privacy: str = Field(
        "unlisted",
        description="Privacy status: 'public', 'unlisted', or 'private'. Defaults to 'unlisted'.",
    )
    publish_at: str = Field(
        "",
        description=(
            "Optional ISO-8601/RFC3339 UTC timestamp to schedule the upload, e.g. "
            "'2026-07-05T14:00:00Z'. When set, YouTube keeps the video private until "
            "then, overriding 'privacy'. Must be in the future."
        ),
    )

    def run(self) -> str:
        try:
            from video_generation_agent.tools.shorts_core import render_short_production
            from publisher_agent.tools.youtube_core import get_service, upload_video
            from .oneshot_core import render_and_upload, render_string_to_result
        except Exception as exc:  # noqa: BLE001 - degrade cleanly if wiring is missing
            return (
                "Error: could not load the render-and-upload pipeline "
                f"({exc}). This tool needs both the reddit-shorts render pipeline "
                "and the YouTube upload tool available on the agency host."
            )

        def _render_fn(*, text=None, title=None, subreddit=None):
            out = render_short_production(
                text=text or None, title=title or "", subreddit=subreddit or None
            )
            return render_string_to_result(out)

        def _upload_fn(output_path, meta):
            return upload_video(output_path, meta, service_factory=get_service)

        try:
            result = render_and_upload(
                _render_fn,
                _upload_fn,
                text=self.text or None,
                title=self.title,
                subreddit=self.subreddit or None,
                privacy=self.privacy,
                publish_at=self.publish_at or None,
            )
        except ValueError as exc:
            return f"Error: {exc}"
        except Exception as exc:  # noqa: BLE001 - any unexpected failure becomes a string
            return f"Error: render-and-upload failed: {exc}"

        if not result.get("ok"):
            return f"Error: {result.get('error', 'unknown error')}"
        return (
            f"Rendered and uploaded '{result.get('title', '')}' to YouTube "
            f"({result.get('privacy', '')}): {result.get('url', '')}"
        )
