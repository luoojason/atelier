"""Assert-based tests for the reddit-shorts -> YouTube one-shot chain.

These import ONLY the pure functions from ``oneshot_core`` plus stdlib, so they
pass under a plain system python3 (no agency_swarm / pydantic) and never touch
the real reddit-shorts media pipeline or the YouTube network — fake ``render_fn``
and ``upload_fn`` callables are injected.

    python3 tests/test_oneshot.py
"""

import datetime
import os
import sys

# Import oneshot_core straight from the tools directory, bypassing the agent
# package __init__ (which imports agency_swarm) so these tests run under system
# python3 with only stdlib + the pure functions.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOLS_DIR = os.path.join(_REPO_ROOT, "publisher_agent", "tools")
sys.path.insert(0, _TOOLS_DIR)

from oneshot_core import (  # noqa: E402
    OUTPUT_KEY,
    render_and_upload,
    render_string_to_result,
)


# ── fakes ────────────────────────────────────────────────────────────────────

class _FakeRender:
    """Records the kwargs it was called with; returns a canned render-result dict."""

    def __init__(self, result):
        self.calls = []
        self.result = result

    def __call__(self, *, text=None, title=None, subreddit=None):
        self.calls.append({"text": text, "title": title, "subreddit": subreddit})
        return self.result


class _FakeUpload:
    """Records (path, meta) and returns a canned upload-result dict."""

    def __init__(self, result=None):
        self.calls = []
        self.result = result or {
            "ok": True,
            "video_id": "vid123",
            "url": "https://www.youtube.com/watch?v=vid123",
            "privacy": "unlisted",
            "title": "T",
        }

    def __call__(self, path, meta):
        self.calls.append({"path": path, "meta": meta})
        return self.result


# ── happy path: render -> upload ─────────────────────────────────────────────

def _future_iso(days=30):
    """A whole-second, Z-suffixed UTC timestamp safely in the future."""
    return (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)
    ).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_render_then_upload_passes_path_and_meta_and_returns_upload_result():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()

    # A dynamically-computed future time so the happy path (which now validates
    # publish_at before rendering) stays valid regardless of the run date.
    future = _future_iso()
    out = render_and_upload(
        render,
        upload,
        text="hello world",
        title="My Short",
        privacy="public",
        publish_at=future,
    )

    # returns the upload result unchanged
    assert out is upload.result, out
    assert out["ok"] is True and out["url"].endswith("vid123"), out

    # upload_fn called exactly once with the rendered path
    assert len(upload.calls) == 1, upload.calls
    call = upload.calls[0]
    assert call["path"] == "/tmp/x.mp4", call

    # meta carries title / privacy / publish_at
    meta = call["meta"]
    assert meta["title"] == "My Short", meta
    assert meta["privacy"] == "public", meta
    assert meta["publish_at"] == future, meta


def test_render_called_once_with_text_and_title():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    render_and_upload(render, upload, text="body", title="Hey")
    assert len(render.calls) == 1, render.calls
    call = render.calls[0]
    assert call["text"] == "body"
    assert call["title"] == "Hey"
    assert call["subreddit"] is None


def test_subreddit_path_renders_and_uploads():
    render = _FakeRender({OUTPUT_KEY: "/tmp/reddit.mp4"})
    upload = _FakeUpload()
    render_and_upload(render, upload, subreddit="AskReddit", title="Story")
    assert render.calls[0]["subreddit"] == "AskReddit", render.calls
    assert render.calls[0]["text"] is None
    assert upload.calls[0]["path"] == "/tmp/reddit.mp4", upload.calls


def test_default_meta_values_are_forwarded():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    render_and_upload(render, upload, text="hi", title="T")
    meta = upload.calls[0]["meta"]
    assert meta["privacy"] == "unlisted", meta  # default
    assert meta["publish_at"] is None, meta  # default (not scheduled)


# ── render produced no file: must NOT upload ─────────────────────────────────

def test_missing_output_path_returns_error_and_skips_upload():
    render = _FakeRender({"duration_seconds": 12.0})  # no output_path key
    upload = _FakeUpload()

    out = render_and_upload(render, upload, text="hi", title="T")

    assert out["ok"] is False, out
    assert "output_path" in out["error"], out
    assert upload.calls == [], "upload must not run when render produced no file"


def test_empty_output_path_returns_error_and_skips_upload():
    render = _FakeRender({OUTPUT_KEY: "   "})  # present but blank
    upload = _FakeUpload()
    out = render_and_upload(render, upload, text="hi", title="T")
    assert out["ok"] is False, out
    assert upload.calls == [], upload.calls


def test_render_error_message_is_surfaced():
    render = _FakeRender(
        {OUTPUT_KEY: "", "error": "DEGRADED MODE (reddit-shorts pipeline unavailable)"}
    )
    upload = _FakeUpload()
    out = render_and_upload(render, upload, text="hi", title="T")
    assert out["ok"] is False, out
    assert "DEGRADED MODE" in out["error"], out
    assert upload.calls == []


# ── validation: exactly one of text / subreddit ──────────────────────────────

def test_both_text_and_subreddit_raises_and_renders_nothing():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    try:
        render_and_upload(render, upload, text="hi", subreddit="AskReddit")
    except ValueError as exc:
        assert "exactly one" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError when both text and subreddit given")
    assert render.calls == [] and upload.calls == []


def test_neither_text_nor_subreddit_raises():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    try:
        render_and_upload(render, upload)
    except ValueError as exc:
        assert "exactly one" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError when neither is given")
    assert render.calls == [] and upload.calls == []


def test_blank_text_counts_as_missing():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    try:
        render_and_upload(render, upload, text="   ")
    except ValueError:
        pass
    else:
        raise AssertionError("blank text should count as missing input")
    assert render.calls == []


# ── publish_at validated BEFORE the expensive render (fail fast) ─────────────

def test_past_publish_at_validated_before_render():
    # A past schedule time must be rejected up front, before paying for a full
    # TTS+ffmpeg+whisper render (which the old code did, only failing at upload).
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    past = "2020-01-01T00:00:00Z"
    try:
        render_and_upload(render, upload, text="hi", title="T", publish_at=past)
    except ValueError as exc:
        assert "future" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError for a past publish_at")
    assert render.calls == [], "render must NOT run when publish_at is in the past"
    assert upload.calls == []


def test_malformed_publish_at_validated_before_render():
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    try:
        render_and_upload(render, upload, text="hi", title="T", publish_at="not-a-date")
    except ValueError as exc:
        assert "iso-8601" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError for a malformed publish_at")
    assert render.calls == [], "render must NOT run when publish_at is malformed"
    assert upload.calls == []


def test_no_publish_at_still_renders_and_uploads():
    # The eager validation must be a no-op for the common unscheduled case.
    render = _FakeRender({OUTPUT_KEY: "/tmp/x.mp4"})
    upload = _FakeUpload()
    out = render_and_upload(render, upload, text="hi", title="T")
    assert out["ok"] is True, out
    assert len(render.calls) == 1 and len(upload.calls) == 1


# ── render_string_to_result adapter (glue used by the BaseTool) ──────────────

def test_render_string_to_result_maps_path():
    assert render_string_to_result("/out/clip.mp4") == {OUTPUT_KEY: "/out/clip.mp4"}


def test_render_string_to_result_maps_error_prefixes():
    for msg in (
        "DEGRADED MODE (reddit-shorts pipeline unavailable): ...",
        "Error: provide exactly one of `text` or `subreddit`",
        "Render failed: ffmpeg exploded",
        "Could not load reddit-shorts config",
    ):
        res = render_string_to_result(msg)
        assert res[OUTPUT_KEY] == "", res
        assert res["error"] == msg, res


def test_render_string_to_result_empty_input():
    res = render_string_to_result("")
    assert res[OUTPUT_KEY] == "", res
    assert "error" in res, res
    res_none = render_string_to_result(None)
    assert res_none[OUTPUT_KEY] == "", res_none


def test_render_string_to_result_feeds_render_and_upload_end_to_end():
    # A real path string flows through the adapter into a successful upload.
    def _render_fn(*, text=None, title=None, subreddit=None):
        return render_string_to_result("/out/final.mp4")

    upload = _FakeUpload()
    out = render_and_upload(_render_fn, upload, text="hi", title="T")
    assert out["ok"] is True, out
    assert upload.calls[0]["path"] == "/out/final.mp4", upload.calls

    # A degraded string flows through into a skipped upload + surfaced error.
    def _degraded_render(*, text=None, title=None, subreddit=None):
        return render_string_to_result("DEGRADED MODE: no media env")

    upload2 = _FakeUpload()
    out2 = render_and_upload(_degraded_render, upload2, text="hi", title="T")
    assert out2["ok"] is False, out2
    assert "DEGRADED MODE" in out2["error"], out2
    assert upload2.calls == []


# ── runner ───────────────────────────────────────────────────────────────────

def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for test in tests:
        test()
        passed += 1
    print(f"OK - {passed}/{len(tests)} oneshot tests passed")


if __name__ == "__main__":
    _run_all()
