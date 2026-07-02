"""Notion + vault config wiring: build_options gating + (Part C) config routes."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lite_server  # noqa: E402


def _settings(tmp_path, obj):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return p


def test_load_settings_preserves_notion_and_vault(tmp_path):
    _settings(tmp_path, {"provider": "subscription",
                         "notion_token": "secret_x", "obsidian_vault": "/tmp"})
    s = lite_server.load_settings()
    assert s["notion_token"] == "secret_x"
    assert s["obsidian_vault"] == "/tmp"


def test_build_options_attaches_notion_when_token_set(tmp_path):
    _settings(tmp_path, {"provider": "subscription", "notion_token": "secret_x"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" in opts.allowed_tools
    assert "Notion" in opts.system_prompt


def test_build_options_omits_notion_without_token(tmp_path):
    _settings(tmp_path, {"provider": "subscription"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" not in opts.allowed_tools
