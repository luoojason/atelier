"""Pure-function core for rendering narrated 9:16 shorts.

This reuses the user's already-tested pipeline at ``~/Content/reddit-shorts``
(``reddit_shorts.pipeline.render`` etc.) instead of re-implementing narration,
captioning, and compositing.

All real, testable logic lives in plain module-level functions with NO dependency
on agency_swarm or pydantic. The BaseTools in ``RenderShortFromText.py`` /
``RenderShortFromReddit.py`` / ``ListBackgrounds.py`` are thin wrappers.

Two layers:

- Injected-callable pure functions (``render_short``, ``list_short_backgrounds``)
  take the ``render`` / ``list_backgrounds`` callables and a loaded ``config`` as
  arguments, so tests pass fakes and never touch the real pipeline.
- Production glue (``_load_pipeline`` and the ``*_production`` helpers) lazily
  puts the reddit-shorts checkout on ``sys.path`` and imports the real pipeline.
  When the pipeline or its media stack is unavailable it returns a clear
  DEGRADED-MODE error string instead of crashing.
"""

import os
import sys

# The exact key in reddit_shorts.pipeline.render()'s result dict that holds the
# finished .mp4 path (see ~/Content/reddit-shorts/reddit_shorts/pipeline.py).
OUTPUT_KEY = "output_path"

# Where the reddit-shorts checkout lives on the agency host (env-overridable).
DEFAULT_PIPELINE_PATH = "~/Content/reddit-shorts"


# ── path / config resolution ─────────────────────────────────────────────────

def _resolve_pipeline_path(env=None):
    """Return the reddit-shorts checkout dir (REDDIT_SHORTS_PATH or the default)."""
    env = env if env is not None else os.environ
    raw = env.get("REDDIT_SHORTS_PATH", "").strip() or DEFAULT_PIPELINE_PATH
    return os.path.expanduser(raw)


def _resolve_config_path(env=None):
    """Return the config.yaml path, mirroring reddit_shorts.mcp_server._config_path.

    Uses REDDIT_SHORTS_CONFIG when set, else ``<pipeline_root>/config.yaml``.
    """
    env = env if env is not None else os.environ
    override = env.get("REDDIT_SHORTS_CONFIG", "").strip()
    if override:
        return os.path.expanduser(override)
    return os.path.join(_resolve_pipeline_path(env), "config.yaml")


def _degraded_error(reason):
    """Build the standard DEGRADED-MODE message explaining what the host needs."""
    return (
        "DEGRADED MODE (reddit-shorts pipeline unavailable): "
        f"{reason}. Rendering narrated shorts needs the reddit-shorts pipeline "
        "installed on the agency host: the `reddit-shorts-media` conda env "
        "(ffmpeg/ffprobe + whisper + edge-tts) plus a seeded background-clip "
        "library. Set REDDIT_SHORTS_PATH to the checkout "
        "(default ~/Content/reddit-shorts) and REDDIT_SHORTS_CONFIG to its "
        "config.yaml, then run `python -m reddit_shorts seed` to populate "
        "backgrounds."
    )


# ── pure, injected-callable functions (unit-tested) ──────────────────────────

def _extract_output_path(result):
    """Pull the finished .mp4 path out of a render() result dict."""
    if not isinstance(result, dict) or not result.get(OUTPUT_KEY):
        raise ValueError(f"render did not return an {OUTPUT_KEY!r}: {result!r}")
    return str(result[OUTPUT_KEY])


def render_short(render_fn, config, *, text=None, title=None, subreddit=None):
    """Render one narrated 9:16 short via an injected ``render_fn``.

    Exactly one of ``text`` (original narration, preferred) or ``subreddit``
    (fetch a Reddit story) must be supplied. ``render_fn`` matches the real
    ``reddit_shorts.pipeline.render(config, subreddit=None, text=None, title=None)``
    signature; tests pass a fake that records its kwargs. Returns the output
    ``.mp4`` path from the result dict. Raises ``ValueError`` on bad input.
    """
    has_text = text is not None and str(text).strip() != ""
    has_sub = subreddit is not None and str(subreddit).strip() != ""

    if has_text and has_sub:
        raise ValueError("provide exactly one of `text` or `subreddit`, not both")
    if not has_text and not has_sub:
        raise ValueError("provide exactly one of `text` or `subreddit`")

    if has_text:
        result = render_fn(config, text=text, title=(title or ""))
    else:
        result = render_fn(config, subreddit=subreddit)

    return _extract_output_path(result)


def list_short_backgrounds(list_fn, config):
    """Format the background-clip library from an injected ``list_fn``.

    ``list_fn(config)`` returns ``list[(path, length_seconds)]`` (as
    ``reddit_shorts.backgrounds.list_backgrounds`` does). Returns a human-readable
    listing, or a clear message when the library is empty.
    """
    rows = list_fn(config)
    if not rows:
        return (
            "No background clips found. Seed the library on the agency host with "
            "`python -m reddit_shorts seed` before rendering shorts."
        )
    lines = []
    for path, length in rows:
        name = getattr(path, "name", os.path.basename(str(path)))
        lines.append(f"{float(length):8.1f}s  {name}")
    return "\n".join(lines)


# ── production glue (imports the real pipeline; not unit-tested) ─────────────

def _load_pipeline(env=None):
    """Lazily import the real reddit-shorts pipeline callables.

    On success returns a dict with ``render``, ``list_backgrounds``,
    ``load_config`` callables and the resolved ``config_path``. On any failure
    (missing checkout dir, ImportError from a missing media env) returns the
    DEGRADED-MODE error *string* instead of raising, so tools degrade gracefully.
    """
    env = env if env is not None else os.environ
    path = _resolve_pipeline_path(env)

    if not os.path.isdir(path):
        return _degraded_error(f"REDDIT_SHORTS_PATH does not exist: {path}")

    if path not in sys.path:
        sys.path.insert(0, path)

    try:
        from reddit_shorts.pipeline import render
        from reddit_shorts.backgrounds import list_backgrounds
        from reddit_shorts.config import load_config
    except ImportError as exc:  # missing package or its media dependencies
        return _degraded_error(f"cannot import the reddit-shorts pipeline: {exc}")

    return {
        "render": render,
        "list_backgrounds": list_backgrounds,
        "load_config": load_config,
        "config_path": _resolve_config_path(env),
    }


def render_short_production(*, text=None, title=None, subreddit=None, env=None):
    """Full production render: load pipeline + config, then render_short.

    Returns the output ``.mp4`` path, or a clear error / DEGRADED-MODE string.
    Never raises.
    """
    bundle = _load_pipeline(env)
    if isinstance(bundle, str):
        return bundle
    try:
        config = bundle["load_config"](bundle["config_path"])
    except Exception as exc:  # noqa: BLE001 - config/ffmpeg problems degrade cleanly
        return _degraded_error(f"could not load reddit-shorts config: {exc}")
    try:
        return render_short(
            bundle["render"], config, text=text, title=title, subreddit=subreddit
        )
    except ValueError as exc:
        return f"Error: {exc}"
    except Exception as exc:  # noqa: BLE001 - render/ffmpeg failures become a string
        return f"Render failed: {exc}"


def list_backgrounds_production(*, env=None):
    """Full production listing: load pipeline + config, then list_short_backgrounds.

    Returns the formatted listing, or a clear error / DEGRADED-MODE string.
    """
    bundle = _load_pipeline(env)
    if isinstance(bundle, str):
        return bundle
    try:
        config = bundle["load_config"](bundle["config_path"])
    except Exception as exc:  # noqa: BLE001
        return _degraded_error(f"could not load reddit-shorts config: {exc}")
    try:
        return list_short_backgrounds(bundle["list_backgrounds"], config)
    except Exception as exc:  # noqa: BLE001
        return f"Could not list backgrounds: {exc}"
