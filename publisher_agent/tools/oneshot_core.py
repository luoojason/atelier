"""Pure-function core for the reddit-shorts -> YouTube one-shot chain.

Chains the two owned pieces of the pipeline into one deliverable: render a
narrated 9:16 short, then upload the finished file to YouTube.

All real logic lives in plain module-level functions with NO dependency on
agency_swarm or pydantic. The BaseTool in ``RenderAndUploadShort.py`` is a thin
wrapper that injects the REAL render helper and ``upload_video`` here.

``render_fn`` and ``upload_fn`` are injected so tests never touch the real
reddit-shorts media pipeline or the YouTube network:

- ``render_fn(*, text, title, subreddit) -> dict`` returns a render-result dict
  whose finished ``.mp4`` path is under the ``output_path`` key (matching
  ``video_generation_agent.tools.shorts_core``'s ``OUTPUT_KEY``).
- ``upload_fn(output_path, meta) -> dict`` uploads the file and returns the
  upload result dict (``{"ok": bool, "video_id", "url", ...}``).
"""

# The publish_at validator is the single source of truth for schedule-time rules
# (must parse as ISO-8601 and be strictly in the future). Import it so the one-shot
# can reject a bad schedule BEFORE the expensive render instead of after. Relative
# import in production (publisher_agent.tools.oneshot_core); flat import under the
# test harness, which puts the tools dir on sys.path.
try:  # package context
    from .youtube_core import normalize_publish_at
except ImportError:  # flat import (tests)
    from youtube_core import normalize_publish_at

# The key that a render-result dict uses for the finished .mp4 path. Kept in sync
# with video_generation_agent.tools.shorts_core.OUTPUT_KEY.
OUTPUT_KEY = "output_path"

# Prefixes that shorts_core.render_short_production uses for its error / degraded
# return strings (as opposed to a real output .mp4 path).
RENDER_ERROR_PREFIXES = (
    "DEGRADED MODE",
    "Error:",
    "Error ",
    "Render failed",
    "Could not",
)


def render_string_to_result(out):
    """Adapt ``shorts_core.render_short_production``'s string return into a dict.

    That production helper returns EITHER an output ``.mp4`` path OR a
    human-readable error / DEGRADED-MODE message (never raises). Map a real path
    to ``{"output_path": path}`` and any error message to
    ``{"output_path": "", "error": message}`` so ``render_and_upload`` can surface
    the failure without attempting an upload. Pure; used by the BaseTool glue.
    """
    text = "" if out is None else str(out).strip()
    if not text:
        return {OUTPUT_KEY: "", "error": "render returned no output"}
    if text.startswith(RENDER_ERROR_PREFIXES):
        return {OUTPUT_KEY: "", "error": text}
    return {OUTPUT_KEY: text}


def render_and_upload(
    render_fn,
    upload_fn,
    *,
    text=None,
    title="",
    subreddit=None,
    privacy="unlisted",
    publish_at=None,
):
    """Render a narrated short, then upload it to YouTube — one deliverable.

    Exactly one of ``text`` (original narration, preferred) or ``subreddit``
    (fetch a Reddit story) must be provided; otherwise ``ValueError`` is raised
    and neither ``render_fn`` nor ``upload_fn`` is called.

    Calls ``render_fn(text=..., title=..., subreddit=...)`` and reads the finished
    path from ``result["output_path"]``. When that path is missing or empty the
    render did not produce a video: return a clear error dict
    (``{"ok": False, "error": ...}``) and DO NOT call ``upload_fn``. Any ``error``
    the render result carries is included in the message.

    Otherwise call ``upload_fn(output_path, {title, privacy, publish_at})`` and
    return its result dict unchanged.
    """
    has_text = text is not None and str(text).strip() != ""
    has_sub = subreddit is not None and str(subreddit).strip() != ""

    if has_text and has_sub:
        raise ValueError("provide exactly one of `text` or `subreddit`, not both")
    if not has_text and not has_sub:
        raise ValueError("provide exactly one of `text` or `subreddit`")

    # Validate the schedule time BEFORE rendering. publish_at is a trivially
    # checkable primary input, but the only validator (normalize_publish_at, via
    # upload_fn -> build_upload_request) otherwise runs AFTER the expensive
    # TTS+ffmpeg+whisper render, so a past/malformed timestamp would pay for a full
    # render only to fail at upload. Fail fast, mirroring the pre-render guards
    # above. Raises ValueError for a past or unparseable timestamp; None/"" is fine.
    normalize_publish_at(publish_at)

    render_result = render_fn(text=text, title=title, subreddit=subreddit)

    output_path = ""
    render_error = ""
    if isinstance(render_result, dict):
        output_path = str(render_result.get(OUTPUT_KEY) or "").strip()
        render_error = str(render_result.get("error") or "").strip()

    if not output_path:
        message = (
            "render did not produce a video file (missing output_path); "
            "upload skipped."
        )
        if render_error:
            message = f"{message} render reported: {render_error}"
        return {"ok": False, "error": message}

    meta = {"title": title, "privacy": privacy, "publish_at": publish_at}
    return upload_fn(output_path, meta)
