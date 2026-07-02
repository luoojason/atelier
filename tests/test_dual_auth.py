"""Tests for lite_server's dual-auth layer (settings store + provider routes)
via fastapi TestClient — no live server, no network (httpx is monkeypatched at
the module boundary for the validate route; ATELIER_SETTINGS_PATH points every
test at a tmp_path settings file so nothing real is touched).

The contract under test:
  * load_settings()/save_settings() round-trip; missing/corrupt file degrades
    to {"provider":"subscription"}; atomic write (no leftover tmp) chmod 0600;
  * build_options(): effective provider "api" ONLY when chosen AND a key is
    stored — api mode injects ANTHROPIC_API_KEY into options.env, subscription
    mode neutralizes both inherited keys with empty-string overrides (the SDK
    transport merges options.env OVER os.environ, so only "" survives);
  * GET /config gains provider / api_key_present / api_key_hint (last-4 only);
    GET /health gains provider and its "subscription" bool tracks it;
  * POST /config/provider (invalid value 400, "api" with no key 400, happy
    path resets the chat client); POST /config/api-key (shape-gated on
    ^sk-ant-[A-Za-z0-9_-]{10,200}$); DELETE /config/api-key flips a dead "api"
    choice back to "subscription"; POST /config/api-key/validate maps
    200/401/network-error onto valid/rejected/unreachable;
  * the RAW key string never appears in any response body, anywhere.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_dual_auth.py
"""

import json
import os
import stat
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import httpx  # noqa: E402 - the validate handler imports this same module object

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


RAW_KEY = "sk-ant-api03-test0123456789abcd"  # matches the shape gate; last4 abcd


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def settings_file(monkeypatch, tmp_path):
    """Every test reads/writes a tmp settings file — never ~/.atelier's."""
    path = tmp_path / "settings.json"
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(path))
    # Mutating routes must not trip the token gate, and build_options must not
    # create a real ~/.atelier/claude-home.
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    return path


@pytest.fixture
def client():
    return TestClient(lite_server.app)


class _RecordingChatClient:
    def __init__(self):
        self.disconnected = False

    async def disconnect(self):
        self.disconnected = True


@pytest.fixture
def chat_client(monkeypatch):
    """A recording long-lived chat client, so tests can see the reset happen."""
    fake = _RecordingChatClient()
    monkeypatch.setattr(lite_server, "_chat_client", fake)
    return fake


def _install_fake_httpx(monkeypatch, status=200, error=None, calls=None):
    """Replace httpx.AsyncClient with a fake; the handler's local `import
    httpx` resolves to this same sys.modules entry."""

    class _Resp:
        def __init__(self, status_code):
            self.status_code = status_code

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, **kwargs):
            if calls is not None:
                calls.append({"url": url, "headers": dict(headers or {})})
            if error is not None:
                raise error
            return _Resp(status)

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)


# ── settings store ───────────────────────────────────────────────────────────

def test_settings_round_trip_atomic_and_0600(settings_file):
    saved = {"provider": "api", "anthropic_api_key": RAW_KEY}
    lite_server.save_settings(saved)

    assert lite_server.load_settings() == saved
    # 0600 on the FINAL file (it can hold a real key)...
    assert stat.S_IMODE(os.stat(settings_file).st_mode) == 0o600
    # ...and the atomic-write tmp file is gone: settings.json is the only
    # artifact left beside the (empty) claude-home dir fixture.
    leftovers = [p.name for p in settings_file.parent.iterdir()]
    assert leftovers == ["settings.json"]


def test_save_settings_creates_parent_dirs(monkeypatch, tmp_path):
    nested = tmp_path / "a" / "b" / "settings.json"
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(nested))
    lite_server.save_settings({"provider": "subscription"})
    assert json.loads(nested.read_text()) == {"provider": "subscription"}


def test_load_settings_missing_file_degrades(settings_file):
    assert not settings_file.exists()
    assert lite_server.load_settings() == {"provider": "subscription"}


@pytest.mark.parametrize(
    "raw",
    [
        "{not json",                                   # corrupt JSON
        "[1, 2, 3]",                                   # valid JSON, wrong shape
        json.dumps({"provider": "witchcraft"}),        # unknown provider value
        json.dumps({"provider": 7, "anthropic_api_key": 9}),  # wrong types
    ],
)
def test_load_settings_corrupt_degrades(settings_file, raw):
    settings_file.write_text(raw, encoding="utf-8")
    assert lite_server.load_settings() == {"provider": "subscription"}


def test_load_settings_never_raises_on_unreadable_path(monkeypatch, tmp_path):
    # a directory where the file should be -> OSError branch, still degraded
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path))
    assert lite_server.load_settings() == {"provider": "subscription"}


# ── build_options env in both modes ──────────────────────────────────────────

def test_build_options_subscription_strips_both_keys(monkeypatch):
    # no settings file at all -> subscription; inherited keys must be
    # NEUTRALIZED. Empty-string overrides, not absence: the SDK transport
    # spawns the CLI with {**os.environ, **options.env}, so a key merely
    # popped from options.env resurrects from the inherited process env.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-inherited-000000000000")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-inherited")
    env = lite_server.build_options().env
    assert env["ANTHROPIC_API_KEY"] == ""
    assert env["ANTHROPIC_AUTH_TOKEN"] == ""
    # what SubprocessCLITransport actually spawns with — the strip must
    # survive the merge (this is the regression the pops could not catch)
    merged = {**os.environ, **env}
    assert merged["ANTHROPIC_API_KEY"] == ""
    assert merged["ANTHROPIC_AUTH_TOKEN"] == ""


def test_build_options_api_mode_injects_stored_key(monkeypatch):
    lite_server.save_settings({"provider": "api", "anthropic_api_key": RAW_KEY})
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-inherited-000000000000")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-inherited")
    env = lite_server.build_options().env
    # the STORED key, not the inherited one; auth token still stripped
    assert env["ANTHROPIC_API_KEY"] == RAW_KEY
    assert env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert {**os.environ, **env}["ANTHROPIC_API_KEY"] == RAW_KEY
    # the rest of the isolation env is untouched by provider choice
    assert env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] == ""
    assert env["CLAUDE_CONFIG_DIR"] == os.environ["CLAUDE_CONFIG_DIR"]


def test_build_options_api_without_key_is_subscription(monkeypatch):
    lite_server.save_settings({"provider": "api"})  # dead choice, no key stored
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-inherited-000000000000")
    env = lite_server.build_options().env
    assert env["ANTHROPIC_API_KEY"] == ""


# ── GET /config + GET /health fields ─────────────────────────────────────────

def test_config_provider_fields_no_key(client):
    body = client.get("/config").json()
    assert body["provider"] == "subscription"
    assert body["api_key_present"] is False
    assert body["api_key_hint"] == ""


def test_config_provider_fields_with_key(client):
    lite_server.save_settings({"provider": "api", "anthropic_api_key": RAW_KEY})
    resp = client.get("/config")
    body = resp.json()
    assert body["provider"] == "api"
    assert body["api_key_present"] is True
    assert body["api_key_hint"] == "…abcd"
    assert RAW_KEY not in resp.text


def test_health_provider_field_tracks_effective_provider(client):
    body = client.get("/health").json()
    assert body["provider"] == "subscription"
    assert body["subscription"] is True

    lite_server.save_settings({"provider": "api", "anthropic_api_key": RAW_KEY})
    body = client.get("/health").json()
    assert body["provider"] == "api"
    assert body["subscription"] is False  # stays a bool, now honestly False


# ── POST /config/provider ────────────────────────────────────────────────────

def test_set_provider_happy_path_resets_chat_client(client, chat_client):
    lite_server.save_settings(
        {"provider": "subscription", "anthropic_api_key": RAW_KEY}
    )
    resp = client.post("/config/provider", json={"provider": "api"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "provider": "api"}
    assert lite_server.load_settings()["provider"] == "api"
    # the long-lived chat client was torn down so the next turn rebuilds on
    # the new provider
    assert chat_client.disconnected is True
    assert lite_server._chat_client is None

    # and back again
    resp = client.post("/config/provider", json={"provider": "subscription"})
    assert resp.json() == {"ok": True, "provider": "subscription"}
    assert lite_server.load_settings()["provider"] == "subscription"


def test_set_provider_api_with_no_key_is_400(client):
    resp = client.post("/config/provider", json={"provider": "api"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "no API key saved"}
    # nothing persisted: the effective provider is still subscription
    assert lite_server.load_settings() == {"provider": "subscription"}


def test_set_provider_invalid_value_is_400(client):
    resp = client.post("/config/provider", json={"provider": "both-please"})
    assert resp.status_code == 400
    assert "error" in resp.json()
    assert lite_server.load_settings() == {"provider": "subscription"}


# ── POST /config/api-key ─────────────────────────────────────────────────────

def test_save_api_key_happy_path_strips_and_hints(client):
    resp = client.post("/config/api-key", json={"api_key": f"  {RAW_KEY}\n"})
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True, "api_key_present": True, "api_key_hint": "…abcd",
    }
    assert RAW_KEY not in resp.text  # hint only, never the key
    saved = lite_server.load_settings()
    assert saved["anthropic_api_key"] == RAW_KEY  # whitespace stripped
    assert saved["provider"] == "subscription"    # provider untouched


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-key",
        "sk-ant-short",              # tail under 10 chars
        "sk-ant-has spaces inside",  # chars outside the alphabet
        "",
        "Bearer sk-ant-api03-test0123456789abcd",  # prefix junk
    ],
)
def test_save_api_key_bad_shape_is_400(client, bad):
    resp = client.post("/config/api-key", json={"api_key": bad})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "that does not look like an Anthropic API key"
    }
    assert "anthropic_api_key" not in lite_server.load_settings()


# ── DELETE /config/api-key ───────────────────────────────────────────────────

def test_delete_api_key_flips_api_to_subscription(client, chat_client):
    lite_server.save_settings({"provider": "api", "anthropic_api_key": RAW_KEY})
    resp = client.delete("/config/api-key")
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True, "provider": "subscription", "api_key_present": False,
    }
    # no dead state left behind: key gone AND provider flipped
    assert lite_server.load_settings() == {"provider": "subscription"}
    assert chat_client.disconnected is True
    assert lite_server._chat_client is None

    body = client.get("/config").json()
    assert body["provider"] == "subscription"
    assert body["api_key_present"] is False
    assert body["api_key_hint"] == ""


# ── POST /config/api-key/validate ────────────────────────────────────────────

def test_validate_accepted_key(monkeypatch, client):
    calls = []
    _install_fake_httpx(monkeypatch, status=200, calls=calls)
    resp = client.post("/config/api-key/validate", json={"api_key": RAW_KEY})
    assert resp.status_code == 200
    assert resp.json() == {"valid": True, "detail": "key accepted"}
    assert RAW_KEY not in resp.text
    # the key travels ONLY in the outbound headers, with the pinned version
    assert calls == [{
        "url": "https://api.anthropic.com/v1/models",
        "headers": {"x-api-key": RAW_KEY, "anthropic-version": "2023-06-01"},
    }]


@pytest.mark.parametrize("status", [401, 403])
def test_validate_rejected_key(monkeypatch, client, status):
    _install_fake_httpx(monkeypatch, status=status)
    resp = client.post("/config/api-key/validate", json={"api_key": RAW_KEY})
    assert resp.json() == {
        "valid": False, "detail": "key rejected by Anthropic",
    }
    assert RAW_KEY not in resp.text


def test_validate_unexpected_status(monkeypatch, client):
    _install_fake_httpx(monkeypatch, status=529)
    resp = client.post("/config/api-key/validate", json={"api_key": RAW_KEY})
    assert resp.json() == {"valid": False, "detail": "unexpected response 529"}


def test_validate_network_error_is_unreachable_not_500(monkeypatch, client):
    _install_fake_httpx(
        monkeypatch, error=httpx.ConnectError("connection refused")
    )
    resp = client.post("/config/api-key/validate", json={"api_key": RAW_KEY})
    assert resp.status_code == 200  # never a 500
    assert resp.json() == {
        "valid": False, "detail": "could not reach api.anthropic.com",
    }
    assert RAW_KEY not in resp.text


def test_validate_falls_back_to_stored_key(monkeypatch, client):
    lite_server.save_settings(
        {"provider": "subscription", "anthropic_api_key": RAW_KEY}
    )
    calls = []
    _install_fake_httpx(monkeypatch, status=200, calls=calls)
    resp = client.post("/config/api-key/validate", json={})  # no key supplied
    assert resp.json() == {"valid": True, "detail": "key accepted"}
    assert calls[0]["headers"]["x-api-key"] == RAW_KEY


def test_validate_with_no_key_anywhere(monkeypatch, client):
    calls = []
    _install_fake_httpx(monkeypatch, status=200, calls=calls)
    resp = client.post("/config/api-key/validate", json={})
    assert resp.json() == {"valid": False, "detail": "no key to validate"}
    assert calls == []  # no network attempt without a key


# ── the raw key never leaves the server ──────────────────────────────────────

def test_raw_key_appears_in_no_response_body(monkeypatch, client):
    """Sweep every route the key's lifecycle touches (plus the read routes):
    the raw key string must never appear in a response body."""
    _install_fake_httpx(monkeypatch, status=200)

    responses = [
        client.post("/config/api-key", json={"api_key": RAW_KEY}),
        client.post("/config/provider", json={"provider": "api"}),
        client.post("/config/api-key/validate", json={"api_key": RAW_KEY}),
        client.post("/config/api-key/validate", json={}),
        client.get("/config"),
        client.get("/health"),
        client.get("/metrics"),
        client.get("/runs"),
        client.get("/jobs"),
        client.get("/notifications"),
        client.get("/sessions"),
        client.delete("/config/api-key"),
        client.get("/config"),
    ]
    for resp in responses:
        assert RAW_KEY not in resp.text, resp.request.url
