"""Assert-based tests for the Publisher subsystem — run with system python3.

These import ONLY the pure functions from publisher_agent.tools plus stdlib, so
they pass without agency_swarm / pydantic / google-api-python-client and never
touch the network.

    python3 tests/test_publisher.py
"""

import datetime
import os
import sys
import tempfile

# Import the tool modules as bare modules straight from the tools directory. This
# bypasses `publisher_agent/__init__.py` (which imports agency_swarm) so these
# tests run under a plain system python3 with only stdlib + the pure functions.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOLS_DIR = os.path.join(_REPO_ROOT, "publisher_agent", "tools")
sys.path.insert(0, _TOOLS_DIR)

from youtube_core import (  # noqa: E402
    build_upload_request,
    credentials_error,
    normalize_privacy,
    normalize_publish_at,
    resolve_credential_paths,
    upload_video,
)
from PublishToVault import (  # noqa: E402
    build_note,
    publish_to_vault,
    resolve_vault_root,
    slugify_filename,
)

# PyYAML is not stdlib, so it may be absent under a bare system python3. When it
# is available we additionally assert the frontmatter round-trips through a real
# YAML parser; when it is not, the raw-string checks still stand on their own.
try:
    import yaml as _yaml
except ImportError:  # pragma: no cover - depends on the test environment
    _yaml = None


def _parse_frontmatter(note):
    """Parse a note's YAML frontmatter to a mapping, or None when PyYAML is absent."""
    if _yaml is None:
        return None
    block = note.split("---\n", 2)[1]
    return _yaml.safe_load(block)


# ── Fakes ────────────────────────────────────────────────────────────────────

class _FakeExecute:
    def __init__(self, response):
        self._response = response

    def execute(self):
        return self._response


class _FakeVideos:
    def __init__(self, recorder, response):
        self._recorder = recorder
        self._response = response

    def insert(self, part=None, body=None, media_body=None):
        self._recorder["part"] = part
        self._recorder["body"] = body
        self._recorder["media_body"] = media_body
        return _FakeExecute(self._response)


class _FakeService:
    def __init__(self, recorder, response):
        self._recorder = recorder
        self._response = response

    def videos(self):
        return _FakeVideos(self._recorder, self._response)


# ── build_upload_request ─────────────────────────────────────────────────────

def test_build_upload_request_fields():
    req = build_upload_request(
        "/tmp/clip.mp4",
        title="My Launch Video",
        description="A demo",
        tags=["ai", "launch"],
        privacy="public",
    )
    assert req["part"] == "snippet,status", req["part"]
    snippet = req["body"]["snippet"]
    assert snippet["title"] == "My Launch Video"
    assert snippet["description"] == "A demo"
    assert snippet["tags"] == ["ai", "launch"]
    assert snippet["categoryId"] == "22"
    assert req["body"]["status"]["privacyStatus"] == "public"
    assert req["media_path"] == "/tmp/clip.mp4"


def test_build_upload_request_privacy_values():
    for value in ("public", "private", "unlisted"):
        req = build_upload_request("/tmp/c.mp4", title="t", privacy=value)
        assert req["body"]["status"]["privacyStatus"] == value, value
    # Unknown / empty privacy is normalized to a safe default.
    assert build_upload_request("/tmp/c.mp4", title="t", privacy="bogus")[
        "body"
    ]["status"]["privacyStatus"] == "unlisted"
    assert build_upload_request("/tmp/c.mp4", title="t", privacy="")[
        "body"
    ]["status"]["privacyStatus"] == "unlisted"


def test_build_upload_request_defaults_tags_empty():
    req = build_upload_request("/tmp/c.mp4", title="t")
    assert req["body"]["snippet"]["tags"] == []
    assert req["body"]["snippet"]["description"] == ""


def test_build_upload_request_requires_title():
    try:
        build_upload_request("/tmp/c.mp4", title="   ")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for empty title")


def test_normalize_privacy():
    assert normalize_privacy("PUBLIC") == "public"
    assert normalize_privacy(" Unlisted ") == "unlisted"
    assert normalize_privacy(None) == "unlisted"
    assert normalize_privacy("garbage") == "unlisted"


# ── scheduled publish (publish_at / status.publishAt) ────────────────────────

def _future_utc(days=30):
    """A whole-second UTC datetime that is safely in the future."""
    return (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)
    ).replace(microsecond=0)


def test_normalize_publish_at_none_and_empty():
    # No schedule requested -> None (unscheduled), never raises.
    assert normalize_publish_at(None) is None
    assert normalize_publish_at("") is None
    assert normalize_publish_at("   ") is None


def test_normalize_publish_at_naive_iso_treated_as_utc():
    # ISO input like 2026-12-01T09:30:00 (no offset) normalizes to a Z-suffixed
    # RFC3339 UTC string, unchanged apart from the appended Z.
    future = _future_utc(days=45)
    naive = future.strftime("%Y-%m-%dT%H:%M:%S")  # e.g. 2026-12-01T09:30:00
    assert normalize_publish_at(naive) == naive + "Z"


def test_normalize_publish_at_z_and_offset_forms():
    future = _future_utc(days=10)
    z_form = future.strftime("%Y-%m-%dT%H:%M:%SZ")
    # A trailing Z round-trips to the same RFC3339 string.
    assert normalize_publish_at(z_form) == z_form
    # An explicit +00:00 offset normalizes to the Z form.
    assert normalize_publish_at(future.strftime("%Y-%m-%dT%H:%M:%S+00:00")) == z_form


def test_normalize_publish_at_non_utc_offset_converted_to_utc():
    # A time with a -05:00 offset must be converted to the equivalent UTC instant.
    future_utc = _future_utc(days=20)
    minus5 = future_utc.astimezone(datetime.timezone(datetime.timedelta(hours=-5)))
    assert normalize_publish_at(minus5.isoformat()) == future_utc.strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def test_normalize_publish_at_past_raises():
    past = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        normalize_publish_at(past)
    except ValueError as exc:
        assert "future" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError for a past publish_at")


def test_normalize_publish_at_malformed_raises():
    for bad in ("not-a-timestamp", "2026-13-45T99:99:99Z", "July 5th"):
        try:
            normalize_publish_at(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for malformed publish_at={bad!r}")


def test_build_upload_request_schedule_forces_private_and_sets_publish_at():
    future = _future_utc(days=15)
    normalized = future.strftime("%Y-%m-%dT%H:%M:%SZ")
    # publish_at wins even over an explicit privacy='public'.
    req = build_upload_request(
        "/tmp/clip.mp4",
        title="Scheduled",
        privacy="public",
        publish_at=future.strftime("%Y-%m-%dT%H:%M:%S"),
    )
    status = req["body"]["status"]
    assert status["privacyStatus"] == "private", status
    assert status["publishAt"] == normalized, status


def test_build_upload_request_no_publish_at_unchanged():
    # Without publish_at, status has no publishAt and privacy is untouched.
    req = build_upload_request("/tmp/clip.mp4", title="t", privacy="public")
    assert req["body"]["status"] == {"privacyStatus": "public"}, req["body"]["status"]
    assert "publishAt" not in req["body"]["status"]


def test_build_upload_request_past_publish_at_raises():
    past = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        build_upload_request("/tmp/c.mp4", title="t", publish_at=past)
    except ValueError as exc:
        assert "future" in str(exc).lower(), exc
    else:
        raise AssertionError("expected ValueError for past publish_at")


def test_build_upload_request_malformed_publish_at_raises():
    try:
        build_upload_request("/tmp/c.mp4", title="t", publish_at="garbage-time")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for malformed publish_at")


# ── upload_video (with injected fake service) ────────────────────────────────

def test_upload_video_calls_service_and_returns_url():
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
        handle.write(b"fake video bytes")
        video_path = handle.name
    try:
        recorder = {}
        response = {"id": "abc123XYZ"}
        service = _FakeService(recorder, response)

        result = upload_video(
            video_path,
            meta={
                "title": "Launch",
                "description": "d",
                "tags": ["x"],
                "privacy": "public",
            },
            service_factory=lambda: service,
            media_factory=lambda path: ("MEDIA", path),
        )

        assert result["ok"] is True, result
        assert result["video_id"] == "abc123XYZ"
        assert result["url"] == "https://www.youtube.com/watch?v=abc123XYZ"
        assert result["privacy"] == "public"

        # The fake service received exactly the request build_upload_request made.
        assert recorder["part"] == "snippet,status"
        assert recorder["body"]["snippet"]["title"] == "Launch"
        assert recorder["body"]["status"]["privacyStatus"] == "public"
        assert recorder["media_body"] == ("MEDIA", video_path)
    finally:
        os.unlink(video_path)


def test_upload_video_threads_publish_at_and_reports_private():
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
        handle.write(b"fake video bytes")
        video_path = handle.name
    try:
        future = _future_utc(days=12)
        normalized = future.strftime("%Y-%m-%dT%H:%M:%SZ")
        recorder = {}
        service = _FakeService(recorder, {"id": "sched789"})

        result = upload_video(
            video_path,
            meta={
                "title": "Scheduled Launch",
                # Caller asked for public, but scheduling forces private.
                "privacy": "public",
                "publish_at": future.strftime("%Y-%m-%dT%H:%M:%S"),
            },
            service_factory=lambda: service,
            media_factory=lambda path: ("MEDIA", path),
        )

        assert result["ok"] is True, result
        assert result["video_id"] == "sched789"
        # Reported privacy reflects what was actually sent (private), not the ask.
        assert result["privacy"] == "private", result
        sent_status = recorder["body"]["status"]
        assert sent_status["privacyStatus"] == "private", sent_status
        assert sent_status["publishAt"] == normalized, sent_status
    finally:
        os.unlink(video_path)


def test_upload_video_past_publish_at_returns_error():
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
        handle.write(b"x")
        video_path = handle.name
    try:
        past = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        result = upload_video(
            video_path,
            meta={"title": "t", "publish_at": past},
            service_factory=lambda: _FakeService({}, {"id": "x"}),
            media_factory=lambda path: path,
        )
        assert result["ok"] is False
        assert "future" in result["error"].lower(), result
    finally:
        os.unlink(video_path)


def test_upload_video_missing_file():
    result = upload_video(
        "/no/such/file.mp4",
        meta={"title": "t"},
        service_factory=lambda: None,
        media_factory=lambda path: path,
    )
    assert result["ok"] is False
    assert "not found" in result["error"].lower(), result


def test_upload_video_service_build_failure_returns_error():
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
        handle.write(b"x")
        video_path = handle.name
    try:
        def _boom():
            raise RuntimeError("credentials missing")

        result = upload_video(
            video_path,
            meta={"title": "t"},
            service_factory=_boom,
            media_factory=lambda path: path,
        )
        assert result["ok"] is False
        assert "credentials missing" in result["error"], result
    finally:
        os.unlink(video_path)


# ── credentials handling (missing-creds clear error) ─────────────────────────

def test_credentials_error_when_nothing_configured():
    env = {}  # neither var set
    token, secrets = resolve_credential_paths(env)
    assert token == "" and secrets == ""
    err = credentials_error(token, secrets)
    assert err is not None
    assert "not configured" in err.lower()
    assert "YOUTUBE_TOKEN_FILE" in err and "YOUTUBE_CLIENT_SECRETS" in err


def test_credentials_error_missing_files():
    err = credentials_error("/nope/token.json", "/nope/secrets.json")
    assert err is not None
    assert "missing file" in err.lower()


def test_credentials_error_none_when_token_exists():
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
        handle.write(b"{}")
        token_path = handle.name
    try:
        assert credentials_error(token_path, "") is None
    finally:
        os.unlink(token_path)


# ── publish_to_vault ─────────────────────────────────────────────────────────

def test_build_note_frontmatter():
    note = build_note(
        "My Title", "Body line one.\nBody line two.", tags=["a", "b"], updated="2026-07-01"
    )
    assert note.startswith("---\n")
    # Scalars are emitted as quoted YAML strings so arbitrary titles/tags stay valid.
    assert 'title: "My Title"\n' in note
    assert 'tags: ["a", "b"]\n' in note
    assert "2026-07-01" in note
    # frontmatter closes before the body
    head, _, body = note.partition("---\n")[2].partition("---\n")
    assert '"My Title"' in head
    assert "Body line one." in body
    # Parses as a valid YAML mapping and round-trips to the original values.
    parsed = _parse_frontmatter(note)
    if parsed is not None:
        assert parsed == {
            "title": "My Title",
            "tags": ["a", "b"],
            "last_updated": "2026-07-01",
        }, parsed


def test_build_note_yaml_valid_for_colon_and_newline_titles():
    # A colon-space title used to produce `title: Report: Q3` — invalid YAML.
    note = build_note("Report: Q3 Results", "body", tags=["q3: results"], updated="2026-07-01")
    parsed = _parse_frontmatter(note)
    if parsed is not None:
        assert parsed["title"] == "Report: Q3 Results", parsed
        assert parsed["tags"] == ["q3: results"], parsed

    # A newline in the title must NOT inject a second top-level frontmatter key.
    injected = build_note("Line1\nInjected: evil", "body", updated="2026-07-01")
    parsed2 = _parse_frontmatter(injected)
    if parsed2 is not None:
        assert set(parsed2.keys()) == {"title", "tags", "last_updated"}, parsed2
        assert "Injected" not in parsed2
        assert parsed2["title"] == "Line1 Injected: evil", parsed2
    # Frontmatter stays exactly one line per key (no smuggled newline).
    fm = injected.split("---\n", 2)[1]
    assert fm.count("\n") == 3, fm  # title, tags, last_updated


def test_build_note_empty_tags():
    note = build_note("T", "body", tags=[], updated="2026-07-01")
    assert "tags: []\n" in note


def test_slugify_filename_strips_illegal_chars():
    assert slugify_filename("Report: Q3/Q4 <final>") == "Report Q3Q4 final"
    assert slugify_filename("   ") == "Untitled Note"


def test_resolve_vault_root_env_and_default():
    assert resolve_vault_root({"OBSIDIAN_VAULT": "/custom/vault"}) == "/custom/vault"
    assert resolve_vault_root({}) == "/Users/jasonluo08/Desktop/AI Brain"


def test_publish_to_vault_writes_valid_note():
    with tempfile.TemporaryDirectory() as vault:
        path = publish_to_vault(
            title="Weekly Synthesis",
            body="## Findings\n\n- point one\n- point two",
            folder="Analysis",
            tags=["research", "weekly"],
            vault_root=vault,
            updated="2026-07-01",
        )
        assert path == os.path.join(vault, "Analysis", "Weekly Synthesis.md")
        assert os.path.exists(path)
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        assert text.startswith("---\n")
        assert 'title: "Weekly Synthesis"\n' in text
        assert 'tags: ["research", "weekly"]\n' in text
        assert "2026-07-01" in text
        assert "## Findings" in text
        # exactly two frontmatter delimiters
        assert text.count("---\n") == 2, text
        parsed = _parse_frontmatter(text)
        if parsed is not None:
            assert parsed["title"] == "Weekly Synthesis", parsed
            assert parsed["tags"] == ["research", "weekly"], parsed
            assert parsed["last_updated"] == "2026-07-01", parsed


def test_publish_to_vault_nested_folder():
    with tempfile.TemporaryDirectory() as vault:
        path = publish_to_vault(
            title="Run Log",
            body="log body",
            folder="Sessions/Auto Logs",
            vault_root=vault,
            updated="2026-07-01",
        )
        assert path == os.path.join(vault, "Sessions", "Auto Logs", "Run Log.md")
        assert os.path.exists(path)


def test_publish_to_vault_refuses_sources():
    with tempfile.TemporaryDirectory() as vault:
        try:
            publish_to_vault(
                title="x", body="y", folder="Sources", vault_root=vault
            )
        except ValueError as exc:
            assert "immutable" in str(exc).lower()
        else:
            raise AssertionError("expected ValueError writing into Sources/")
        # also blocked for nested Sources path
        try:
            publish_to_vault(
                title="x", body="y", folder="Sources/Immutable", vault_root=vault
            )
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError writing into Sources/ subfolder")


def test_publish_refuses_sources_case_insensitive_and_normalized():
    # macOS is case-insensitive, so 'sources' names the same immutable directory
    # as 'Sources'; normalization tricks must not slip past the guard either.
    with tempfile.TemporaryDirectory() as vault:
        for folder in ("sources", "SOURCES", "./Sources", "x/../Sources", "./sources"):
            try:
                publish_to_vault(title="Injected", body="pwn", folder=folder, vault_root=vault)
            except ValueError as exc:
                assert "immutable" in str(exc).lower(), (folder, exc)
            else:
                raise AssertionError(f"expected ValueError for folder={folder!r}")
        # no note landed under any case-variant of Sources/
        for name in ("sources", "SOURCES", "Sources"):
            assert not os.path.exists(os.path.join(vault, name)), name


def test_publish_refuses_path_traversal():
    # A '..' segment must not write OUTSIDE the vault root.
    with tempfile.TemporaryDirectory() as parent:
        vault = os.path.join(parent, "vault")
        os.mkdir(vault)
        for folder in ("../escaped_evil", "../../escaped_evil"):
            try:
                publish_to_vault(title="Pwn", body="x", folder=folder, vault_root=vault)
            except ValueError:
                pass
            else:
                raise AssertionError(f"expected ValueError for folder={folder!r}")
        # nothing escaped into the parent (sibling) directory
        assert not os.path.exists(os.path.join(parent, "escaped_evil"))
        assert not os.path.exists(os.path.join(parent, "escaped_evil", "Pwn.md"))


# ── runner ───────────────────────────────────────────────────────────────────

def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for test in tests:
        test()
        passed += 1
    print(f"OK - {passed}/{len(tests)} publisher tests passed")


if __name__ == "__main__":
    _run_all()
