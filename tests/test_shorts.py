"""Assert-based tests for the narrated-short render tool — run with system python3.

These import ONLY the pure functions from ``shorts_core`` plus stdlib, so they
pass without agency_swarm / pydantic and never touch the real reddit-shorts
media pipeline (fakes are injected for render / list_backgrounds).

    python3 tests/test_shorts.py
"""

import os
import sys

# Import shorts_core straight from the tools directory. This bypasses the agent
# package __init__ (which imports agency_swarm) so these tests run under a plain
# system python3 with only stdlib + the pure functions.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOLS_DIR = os.path.join(_REPO_ROOT, "video_generation_agent", "tools")
sys.path.insert(0, _TOOLS_DIR)

from shorts_core import (  # noqa: E402
    OUTPUT_KEY,
    _load_pipeline,
    _resolve_config_path,
    _resolve_pipeline_path,
    list_short_backgrounds,
    render_short,
)


# ── fakes ────────────────────────────────────────────────────────────────────

class _FakeRender:
    """Records the kwargs it is called with and returns a canned result dict."""

    def __init__(self, output_path="/out/clip.mp4"):
        self.calls = []
        self.output_path = output_path

    def __call__(self, config, subreddit=None, text=None, title=None):
        self.calls.append(
            {"config": config, "subreddit": subreddit, "text": text, "title": title}
        )
        return {
            OUTPUT_KEY: self.output_path,
            "duration_seconds": 30.0,
            "subreddit": subreddit,
            "voice": "en-US",
        }


# ── render_short: mapping ────────────────────────────────────────────────────

def test_render_short_from_text_maps_and_returns_path():
    fake = _FakeRender(output_path="/out/original.mp4")
    cfg = object()
    path = render_short(fake, cfg, text="hello world", title="Hey")
    assert path == "/out/original.mp4", path
    assert len(fake.calls) == 1, fake.calls
    call = fake.calls[0]
    assert call["config"] is cfg
    assert call["text"] == "hello world"
    assert call["title"] == "Hey"
    assert call["subreddit"] is None


def test_render_short_from_text_defaults_title_to_empty():
    fake = _FakeRender()
    render_short(fake, object(), text="body only")
    assert fake.calls[0]["title"] == "", fake.calls
    assert fake.calls[0]["subreddit"] is None


def test_render_short_from_reddit_maps_and_returns_path():
    fake = _FakeRender(output_path="/out/reddit.mp4")
    cfg = object()
    path = render_short(fake, cfg, subreddit="AskReddit")
    assert path == "/out/reddit.mp4", path
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["subreddit"] == "AskReddit"
    assert call["text"] is None
    assert call["title"] is None


def test_render_short_returns_string_even_if_pipeline_gives_path_object():
    class _P:
        def __str__(self):
            return "/out/asobj.mp4"

    fake = _FakeRender(output_path=_P())
    path = render_short(fake, object(), text="x")
    assert path == "/out/asobj.mp4", path
    assert isinstance(path, str)


# ── render_short: validation ─────────────────────────────────────────────────

def test_render_short_rejects_both_text_and_subreddit():
    fake = _FakeRender()
    try:
        render_short(fake, object(), text="hi", subreddit="AskReddit")
    except ValueError as exc:
        assert "exactly one" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError when both text and subreddit given")
    assert fake.calls == [], "render must not be invoked on invalid input"


def test_render_short_rejects_neither():
    fake = _FakeRender()
    try:
        render_short(fake, object())
    except ValueError as exc:
        assert "exactly one" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError when neither text nor subreddit given")
    assert fake.calls == []


def test_render_short_treats_blank_text_as_missing():
    fake = _FakeRender()
    try:
        render_short(fake, object(), text="   ")
    except ValueError:
        pass
    else:
        raise AssertionError("blank text should count as missing")


def test_render_short_raises_when_output_key_absent():
    def _bad_render(config, subreddit=None, text=None, title=None):
        return {"duration_seconds": 12.0}  # no output_path

    try:
        render_short(_bad_render, object(), text="hi")
    except ValueError as exc:
        assert OUTPUT_KEY in str(exc), exc
    else:
        raise AssertionError("expected ValueError when render result lacks the output key")


# ── list_short_backgrounds ───────────────────────────────────────────────────

def test_list_short_backgrounds_formats_rows():
    from pathlib import Path

    def _fake_list(config):
        return [(Path("/bg/loop_a.mp4"), 12.3), (Path("/bg/loop_b.mp4"), 60.0)]

    out = list_short_backgrounds(_fake_list, object())
    assert "loop_a.mp4" in out and "loop_b.mp4" in out, out
    assert "12.3s" in out, out
    # filename only, not the full path
    assert "/bg/" not in out, out
    assert out.count("\n") == 1, out  # two rows


def test_list_short_backgrounds_empty_library_message():
    out = list_short_backgrounds(lambda config: [], object())
    assert "no background clips" in out.lower(), out
    assert "seed" in out.lower(), out


# ── degraded-mode helper ─────────────────────────────────────────────────────

def test_load_pipeline_degraded_when_path_missing():
    result = _load_pipeline(env={"REDDIT_SHORTS_PATH": "/no/such/reddit-shorts-dir"})
    assert isinstance(result, str), type(result)
    assert "DEGRADED MODE" in result, result
    assert "reddit-shorts-media" in result, result
    assert "/no/such/reddit-shorts-dir" in result, result


def test_resolve_pipeline_path_env_and_default():
    assert _resolve_pipeline_path({"REDDIT_SHORTS_PATH": "/custom/rs"}) == "/custom/rs"
    # default expands ~ and points at the user's checkout
    default = _resolve_pipeline_path({})
    assert default.endswith("/Content/reddit-shorts"), default
    assert "~" not in default, default


def test_resolve_config_path_override_and_default():
    assert (
        _resolve_config_path({"REDDIT_SHORTS_CONFIG": "/my/config.yaml"})
        == "/my/config.yaml"
    )
    # default is <pipeline_root>/config.yaml
    cfg = _resolve_config_path({"REDDIT_SHORTS_PATH": "/custom/rs"})
    assert cfg == "/custom/rs/config.yaml", cfg


# ── runner ───────────────────────────────────────────────────────────────────

def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for test in tests:
        test()
        passed += 1
    print(f"OK - {passed}/{len(tests)} shorts tests passed")


if __name__ == "__main__":
    _run_all()
