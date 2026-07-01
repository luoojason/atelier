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
    load_or_refresh_credentials,
    normalize_privacy,
    normalize_publish_at,
    resolve_credential_paths,
    upload_video,
)
from PublishToVault import (  # noqa: E402
    append_log,
    build_note,
    publish_to_vault,
    resolve_vault_root,
    slugify_filename,
    upsert_index_row,
)

# Fixtures mirroring the real vault's log.md / index.md formats.
_FIXTURE_LOG = (
    "---\ntitle: Log\ntags: [meta, log]\nlast_updated: \"2026-07-01\"\n---\n\n"
    "# Wiki Log\n\n"
    "- 2026-06-30 — Seeded an earlier operation.\n"
)
_FIXTURE_INDEX = (
    "---\ntitle: Index\ntags: [meta, index]\nlast_updated: \"2026-07-01\"\n---\n\n"
    "# Wiki Index\n\n"
    "## Projects\n\n"
    "| Page | Summary |\n"
    "|------|---------|\n"
    "| [[Projects/Alpha\\|Alpha]] | First project |\n"
    "| [[Projects/Beta\\|Beta]] | Second project |\n\n"
    "## Analysis\n\n"
    "| Page | Summary |\n"
    "|------|---------|\n"
    "| [[Analysis/Existing\\|Existing]] | An existing analysis |\n"
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


# ── OAuth token write-back (load_or_refresh_credentials) ─────────────────────

class _FakeCreds:
    """Minimal stand-in for google.oauth2.credentials.Credentials."""

    def __init__(self, *, valid, expired=False, refresh_token=None, token_json="{}"):
        self.valid = valid
        self.expired = expired
        self.refresh_token = refresh_token
        self._token_json = token_json
        self.refreshed = False

    def refresh(self, request):
        # A real refresh mints a new access token and marks the creds valid.
        self.refreshed = True
        self.valid = True

    def to_json(self):
        return self._token_json


def test_refreshed_token_is_written_back_to_disk():
    # The core regression: after an in-memory refresh, the refreshed token must be
    # persisted so the next run reuses it (and a rotated refresh_token is kept).
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "token.json")
        with open(token_file, "w", encoding="utf-8") as handle:
            handle.write('{"stale": true}')

        creds = _FakeCreds(
            valid=False, expired=True, refresh_token="r",
            token_json='{"refreshed": true}',
        )

        def _loader(tf, scopes):
            return creds

        def _request():
            return object()

        def _flow(secrets, scopes):
            raise AssertionError("flow must not run when the token is refreshable")

        out = load_or_refresh_credentials(
            token_file, "", ["scope"],
            credentials_loader=_loader,
            request_factory=_request,
            flow_runner=_flow,
        )
        assert out is creds
        assert creds.refreshed is True
        with open(token_file, encoding="utf-8") as handle:
            assert handle.read() == '{"refreshed": true}', "refreshed token not persisted"


def test_flow_token_is_written_back_to_disk():
    # The interactive-flow path must also persist (unchanged behavior, guarded).
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "token.json")  # does not exist yet
        new_creds = _FakeCreds(valid=True, token_json='{"new": true}')

        def _loader(tf, scopes):
            raise AssertionError("no token file exists to load")

        def _request():
            raise AssertionError("no refresh on the flow path")

        def _flow(secrets, scopes):
            return new_creds

        out = load_or_refresh_credentials(
            token_file, "/secrets.json", ["scope"],
            credentials_loader=_loader,
            request_factory=_request,
            flow_runner=_flow,
        )
        assert out is new_creds
        with open(token_file, encoding="utf-8") as handle:
            assert handle.read() == '{"new": true}'


def test_valid_token_is_not_rewritten():
    # A still-valid token must be returned as-is with no refresh, no flow, no write.
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "token.json")
        with open(token_file, "w", encoding="utf-8") as handle:
            handle.write('{"good": true}')

        creds = _FakeCreds(valid=True, token_json='{"SHOULD_NOT_WRITE": true}')

        def _loader(tf, scopes):
            return creds

        def _request():
            raise AssertionError("no refresh for a valid token")

        def _flow(secrets, scopes):
            raise AssertionError("no flow for a valid token")

        out = load_or_refresh_credentials(
            token_file, "", ["scope"],
            credentials_loader=_loader,
            request_factory=_request,
            flow_runner=_flow,
        )
        assert out is creds
        with open(token_file, encoding="utf-8") as handle:
            assert handle.read() == '{"good": true}', "valid token must be left untouched"


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


# ── convention-honoring catalog writeback (log.md + index.md) ────────────────

def test_append_log_creates_and_appends():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp)

        append_log(root, "First operation.", "2026-07-01")
        with open(os.path.join(root, "log.md"), encoding="utf-8") as handle:
            log = handle.read()
        assert log == "- 2026-07-01 — First operation.\n", repr(log)

        append_log(root, "Second operation.", "2026-07-02")
        with open(os.path.join(root, "log.md"), encoding="utf-8") as handle:
            log = handle.read()
        assert log == (
            "- 2026-07-01 — First operation.\n"
            "- 2026-07-02 — Second operation.\n"
        ), repr(log)

        # a fixture without a trailing newline still gets a clean new line.
        with open(os.path.join(root, "log.md"), "w", encoding="utf-8") as handle:
            handle.write("# Wiki Log\n\n- 2026-06-30 — seed")
        append_log(root, "New line.", "2026-07-03")
        with open(os.path.join(root, "log.md"), encoding="utf-8") as handle:
            log = handle.read()
        assert log.endswith("- 2026-06-30 — seed\n- 2026-07-03 — New line.\n"), repr(log)


def test_upsert_index_row_add_update_dedupe():
    text = upsert_index_row(_FIXTURE_INDEX, "Projects", "Projects/Gamma", "Gamma", "A new project")
    assert "| [[Projects/Gamma\\|Gamma]] | A new project |" in text
    assert "| [[Projects/Alpha\\|Alpha]] | First project |" in text
    assert "| [[Projects/Beta\\|Beta]] | Second project |" in text
    assert text.index("Projects/Gamma") < text.index("## Analysis")

    text2 = upsert_index_row(text, "Projects", "Projects/Gamma", "Gamma", "Updated summary")
    assert text2.count("[[Projects/Gamma\\|") == 1, "wikilink row must not duplicate"
    assert "Updated summary" in text2 and "A new project" not in text2

    text3 = upsert_index_row(text2, "Projects", "Projects/Gamma", "Gamma", "Updated summary")
    assert text3 == text2, "identical re-run must be a no-op"

    text4 = upsert_index_row(_FIXTURE_INDEX, "Concepts", "Concepts/New Idea", "New Idea", "A concept")
    assert "## Concepts" in text4
    assert "| [[Concepts/New Idea\\|New Idea]] | A concept |" in text4
    assert "## Projects" in text4 and "## Analysis" in text4


def test_upsert_index_row_escapes_pipe_in_summary():
    # A summary containing a literal '|' (realistic: it is the note's first body
    # line) must not inject spurious table columns. The pipe is escaped to '\|'
    # so the row stays a valid two-column Obsidian/GFM table row. This is the
    # exact scenario from the format-preservation finding.
    text = upsert_index_row(_FIXTURE_INDEX, "Projects", "Projects/W", "W", "multi space | pipe")

    # The summary pipe is escaped, and the raw (spurious-column) form is absent.
    assert "| [[Projects/W\\|W]] | multi space \\| pipe |" in text
    assert "| multi space | pipe |" not in text

    # The emitted row still delimits exactly two data cells: after removing the
    # escaped pipes, only the 3 structural table pipes remain (lead|mid|trail).
    row = next(ln for ln in text.splitlines() if "Projects/W" in ln)
    assert row.replace("\\|", "").count("|") == 3, row

    # Escaping does not disturb dedupe/idempotency: same wikilink updates in place.
    text2 = upsert_index_row(text, "Projects", "Projects/W", "W", "again | still")
    assert text2.count("[[Projects/W\\|") == 1
    assert "| [[Projects/W\\|W]] | again \\| still |" in text2


def test_publish_to_vault_catalog_updates_index_and_log():
    with tempfile.TemporaryDirectory() as vault:
        with open(os.path.join(vault, "index.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_INDEX)
        with open(os.path.join(vault, "log.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_LOG)

        publish_to_vault(
            title="Published Note",
            body="The headline summary.\n\nMore body.",
            folder="Projects",
            vault_root=vault,
            updated="2026-07-05",
            catalog=True,
        )

        with open(os.path.join(vault, "index.md"), encoding="utf-8") as handle:
            index = handle.read()
        assert "[[Projects/Published Note\\|Published Note]]" in index
        assert "The headline summary." in index
        assert index.index("Published Note") < index.index("## Analysis")
        assert "| [[Projects/Alpha\\|Alpha]] | First project |" in index

        with open(os.path.join(vault, "log.md"), encoding="utf-8") as handle:
            log = handle.read()
        assert "- 2026-06-30 — Seeded an earlier operation." in log
        assert "- 2026-07-05 — Created note [[Projects/Published Note|Published Note]]\n" in log
        assert log.endswith("\n")

        # Re-publishing the same note does not duplicate the index row.
        publish_to_vault(
            title="Published Note", body="changed", folder="Projects",
            vault_root=vault, updated="2026-07-06", catalog=True,
        )
        with open(os.path.join(vault, "index.md"), encoding="utf-8") as handle:
            index2 = handle.read()
        assert index2.count("[[Projects/Published Note\\|") == 1


def test_publish_to_vault_catalog_false_skips():
    with tempfile.TemporaryDirectory() as vault:
        with open(os.path.join(vault, "index.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_INDEX)
        with open(os.path.join(vault, "log.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_LOG)

        path = publish_to_vault(
            title="Ephemeral", body="scratch", folder="Analysis",
            vault_root=vault, updated="2026-07-05", catalog=False,
        )
        assert os.path.exists(path)

        with open(os.path.join(vault, "index.md"), encoding="utf-8") as handle:
            assert handle.read() == _FIXTURE_INDEX
        with open(os.path.join(vault, "log.md"), encoding="utf-8") as handle:
            assert handle.read() == _FIXTURE_LOG


def test_catalog_wikilink_targets_the_slugified_filename():
    # A title with a colon slugifies to a different filename ('Report: Q3 Results'
    # -> 'Report Q3 Results.md'). The catalog wikilink must point at that real file,
    # not the raw colon title (a name slugify never produces), or the index/log
    # links dangle. Display text keeps the human-readable raw title.
    with tempfile.TemporaryDirectory() as vault:
        with open(os.path.join(vault, "index.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_INDEX)
        with open(os.path.join(vault, "log.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_LOG)

        path = publish_to_vault(
            title="Report: Q3 Results",
            body="Quarterly summary.",
            folder="Analysis",
            vault_root=vault,
            updated="2026-07-05",
            catalog=True,
        )

        # The note file landed under the slugified (colon-stripped) name.
        assert path == os.path.join(vault, "Analysis", "Report Q3 Results.md")
        assert os.path.exists(path)

        with open(os.path.join(vault, "index.md"), encoding="utf-8") as handle:
            index = handle.read()
        with open(os.path.join(vault, "log.md"), encoding="utf-8") as handle:
            log = handle.read()

        # Wikilink target = the slugified stem (the file that exists); display =
        # the raw title. The dangling raw-title target must be absent.
        assert "[[Analysis/Report Q3 Results\\|Report: Q3 Results]]" in index, index
        assert "Created note [[Analysis/Report Q3 Results|Report: Q3 Results]]" in log, log
        assert "Analysis/Report: Q3 Results" not in index
        assert "Analysis/Report: Q3 Results" not in log

        # The catalogued target names a note file that actually exists on disk.
        assert os.path.exists(os.path.join(vault, "Analysis", "Report Q3 Results.md"))


def test_catalog_concurrent_publishes_keep_every_row():
    # Two+ concurrent publishes each read-modify-write the shared index.md/log.md.
    # Without a lock the second write clobbers the first's new row (last-writer-wins)
    # and entries silently vanish. With the catalog lock, every row survives.
    import threading
    from concurrent.futures import ThreadPoolExecutor

    with tempfile.TemporaryDirectory() as vault:
        with open(os.path.join(vault, "index.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_INDEX)
        with open(os.path.join(vault, "log.md"), "w", encoding="utf-8") as handle:
            handle.write(_FIXTURE_LOG)

        n = 40
        barrier = threading.Barrier(n)

        def _publish(i):
            # Release all threads together to maximize contention on the catalog.
            barrier.wait()
            publish_to_vault(
                title=f"Concurrent Note {i}",
                body=f"summary {i}",
                folder="Analysis",
                vault_root=vault,
                updated="2026-07-05",
                catalog=True,
            )

        with ThreadPoolExecutor(max_workers=n) as pool:
            list(pool.map(_publish, range(n)))

        with open(os.path.join(vault, "index.md"), encoding="utf-8") as handle:
            index = handle.read()
        with open(os.path.join(vault, "log.md"), encoding="utf-8") as handle:
            log = handle.read()

        for i in range(n):
            assert f"[[Analysis/Concurrent Note {i}\\|Concurrent Note {i}]]" in index, (
                f"index dropped row {i}"
            )
            assert f"Created note [[Analysis/Concurrent Note {i}|Concurrent Note {i}]]" in log, (
                f"log dropped bullet {i}"
            )

        # Pre-existing catalog content is preserved through the concurrent writes.
        assert "| [[Analysis/Existing\\|Existing]] | An existing analysis |" in index
        assert "- 2026-06-30 — Seeded an earlier operation." in log

        # Each note's own .md file was written (never at risk from the race).
        for i in range(n):
            assert os.path.exists(
                os.path.join(vault, "Analysis", f"Concurrent Note {i}.md")
            ), i


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
