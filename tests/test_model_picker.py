"""Tests for the R15 model picker backend in lite_server.

The contract under test:
  * _resolved_model() resolution order: settings["model"] (if non-empty)
    beats env CLAUDE_CLI_MODEL beats the "sonnet" floor;
  * load_settings() carries a non-empty string "model" through (so the merge
    every OTHER mutating route does — load_settings() -> save_settings() —
    can never wipe the choice) and drops empty/junk values;
  * POST /config/model: allowlist {"sonnet","opus","haiku"} else 400
    {"error":"unknown model"}; persists via a merge that keeps provider and
    api key; resets the long-lived chat client so the next turn rebuilds;
    returns {"ok":true,"model":<resolved>}; token-gated like every POST;
  * GET /config and GET /health reflect the persisted model (no shape
    change), and build_options() actually runs on it.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_model_picker.py
"""

import json
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


RAW_KEY = "sk-ant-api03-test0123456789abcd"  # matches the shape gate


# ── fixtures (same idioms as test_dual_auth) ─────────────────────────────────

@pytest.fixture(autouse=True)
def settings_file(monkeypatch, tmp_path):
    """Every test reads/writes a tmp settings file — never ~/.atelier's — with
    the token gate and any real CLAUDE_CLI_MODEL cleared."""
    path = tmp_path / "settings.json"
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(path))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    monkeypatch.delenv("CLAUDE_CLI_MODEL", raising=False)
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


# ── _resolved_model resolution order ─────────────────────────────────────────

def test_default_is_sonnet():
    assert lite_server._resolved_model() == "sonnet"


def test_env_beats_default(monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_MODEL", "haiku")
    assert lite_server._resolved_model() == "haiku"


def test_setting_beats_env(monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_MODEL", "haiku")
    lite_server.save_settings({"provider": "subscription", "model": "opus"})
    assert lite_server._resolved_model() == "opus"


def test_empty_setting_falls_through_to_env(settings_file, monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_MODEL", "haiku")
    settings_file.write_text(
        json.dumps({"provider": "subscription", "model": ""}), encoding="utf-8"
    )
    assert lite_server._resolved_model() == "haiku"


def test_junk_model_type_degrades(settings_file):
    settings_file.write_text(
        json.dumps({"provider": "subscription", "model": 7}), encoding="utf-8"
    )
    assert lite_server.load_settings() == {"provider": "subscription"}
    assert lite_server._resolved_model() == "sonnet"


# ── load_settings "model" passthrough ────────────────────────────────────────

def test_load_settings_carries_model():
    lite_server.save_settings({"provider": "subscription", "model": "opus"})
    assert lite_server.load_settings()["model"] == "opus"


def test_other_routes_merge_keeps_model(client):
    """The regression the passthrough exists for: POST /config/api-key (and
    /config/provider) merges via load_settings() -> save_settings(); a model
    filtered out on load would be silently wiped here."""
    assert client.post("/config/model", json={"model": "opus"}).status_code == 200
    assert client.post(
        "/config/api-key", json={"api_key": RAW_KEY}
    ).status_code == 200
    saved = lite_server.load_settings()
    assert saved["model"] == "opus"
    assert saved["anthropic_api_key"] == RAW_KEY

    assert client.post(
        "/config/provider", json={"provider": "api"}
    ).status_code == 200
    assert lite_server.load_settings()["model"] == "opus"


# ── POST /config/model ───────────────────────────────────────────────────────

def test_set_model_happy_path_resets_chat_client(client, chat_client):
    resp = client.post("/config/model", json={"model": "opus"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "model": "opus"}
    assert lite_server.load_settings()["model"] == "opus"
    # the long-lived chat client was torn down so the next turn rebuilds on
    # the new model
    assert chat_client.disconnected is True
    assert lite_server._chat_client is None


@pytest.mark.parametrize(
    "bad", ["gpt-4o", "SONNET", "sonnet ", "", "claude-3-opus", "opus2"]
)
def test_set_model_outside_allowlist_is_400(client, bad):
    resp = client.post("/config/model", json={"model": bad})
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown model"}
    assert "model" not in lite_server.load_settings()  # nothing persisted


def test_set_model_merge_keeps_provider_and_key(client):
    lite_server.save_settings({"provider": "api", "anthropic_api_key": RAW_KEY})
    resp = client.post("/config/model", json={"model": "haiku"})
    assert resp.json() == {"ok": True, "model": "haiku"}
    assert lite_server.load_settings() == {
        "provider": "api",
        "anthropic_api_key": RAW_KEY,
        "model": "haiku",
    }


def test_set_model_token_gated(client, monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    resp = client.post("/config/model", json={"model": "opus"})
    assert resp.status_code == 403
    assert "model" not in lite_server.load_settings()

    resp = client.post(
        "/config/model",
        json={"model": "opus"},
        headers={"X-Atelier-Token": "sekret"},
    )
    assert resp.status_code == 200
    assert lite_server.load_settings()["model"] == "opus"


# ── the setting is live everywhere _resolved_model is surfaced ───────────────

def test_config_and_health_reflect_model(client):
    assert client.get("/config").json()["model"] == "sonnet"
    client.post("/config/model", json={"model": "opus"})
    assert client.get("/config").json()["model"] == "opus"
    body = client.get("/health").json()
    assert body["model"] == "opus"
    assert body["ok"] is True  # no shape change


def test_build_options_runs_on_resolved_model(client):
    client.post("/config/model", json={"model": "haiku"})
    assert lite_server.build_options().model == "haiku"


def test_build_options_honors_explicit_session_model(client):
    # an explicit per-session model beats the global resolution order
    assert lite_server.build_options(model="haiku").model == "haiku"
    client.post("/config/model", json={"model": "opus"})
    assert lite_server.build_options(model="haiku").model == "haiku"
    assert lite_server.build_options(model=None).model == "opus"  # None -> global
