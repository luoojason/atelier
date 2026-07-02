"""vault_core.vault_root() settings-first resolution + build_graph() (stdlib only)."""

import json
import os

from shared_tools import vault_core


def _write_settings(tmp_path, obj):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return p


def test_vault_root_prefers_settings_over_env(tmp_path, monkeypatch):
    vault = tmp_path / "MyVault"
    vault.mkdir()
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"obsidian_vault": str(vault)})
    assert vault_core.vault_root() == vault


def test_vault_root_falls_back_to_env_when_no_setting(tmp_path, monkeypatch):
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"provider": "subscription"})  # no obsidian_vault
    assert vault_core.vault_root() == envdir


def test_vault_root_falls_back_when_setting_dir_missing(tmp_path, monkeypatch):
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"obsidian_vault": str(tmp_path / "nope")})
    assert vault_core.vault_root() == envdir


def test_vault_root_default_when_nothing_set(tmp_path, monkeypatch):
    monkeypatch.delenv("OBSIDIAN_VAULT", raising=False)
    _write_settings(tmp_path, {})
    assert vault_core.vault_root() == vault_core.Path(vault_core.DEFAULT_VAULT).expanduser()
