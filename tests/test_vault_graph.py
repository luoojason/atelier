"""vault_core.vault_root() settings-first resolution + build_graph() (stdlib only)."""

import json
import os

import pytest

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


def _mk(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_extract_wikilinks_strips_alias_and_section():
    text = "See [[Iris]] and [[Projects/Hermes|Hermes]] plus [[Notes#Heading]]."
    assert vault_core._extract_wikilinks(text) == ["Iris", "Projects/Hermes", "Notes"]


def test_build_graph_nodes_edges_and_degree(tmp_path):
    _mk(tmp_path, "Projects/Iris.md", "Iris links to [[Hermes]].")
    _mk(tmp_path, "Projects/Hermes.md", "Hermes standalone.")
    g = vault_core.build_graph(tmp_path)
    ids = {n["id"] for n in g["nodes"]}
    assert ids == {"Projects/Iris", "Projects/Hermes"}
    assert {"source": "Projects/Iris", "target": "Projects/Hermes"} in g["edges"]
    deg = {n["id"]: n["degree"] for n in g["nodes"]}
    assert deg["Projects/Iris"] == 1 and deg["Projects/Hermes"] == 1


def test_build_graph_creates_ghost_for_unresolved_link(tmp_path):
    _mk(tmp_path, "A.md", "A points to [[Nowhere]].")
    g = vault_core.build_graph(tmp_path)
    ghosts = [n for n in g["nodes"] if n["ghost"]]
    assert len(ghosts) == 1 and ghosts[0]["id"] == "Nowhere" and ghosts[0]["path"] is None


def test_build_graph_skips_sources_and_self_links(tmp_path):
    _mk(tmp_path, "Sources/Immutable.md", "[[A]]")   # Sources/ is skipped
    _mk(tmp_path, "A.md", "[[A]] self link ignored.")  # self-link dropped
    g = vault_core.build_graph(tmp_path)
    assert {n["id"] for n in g["nodes"]} == {"A"}
    assert g["edges"] == []


def test_build_graph_empty_vault(tmp_path):
    assert vault_core.build_graph(tmp_path) == {"nodes": [], "edges": []}


# ── a MISSING vault root is an error, not an empty vault ────────────────────
# vault_root() falls through to DEFAULT_VAULT even when nothing is there, so
# every scan used to answer "no notes" for a vault that was never opened.


def test_search_vault_raises_when_root_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path / "nope"))
    _write_settings(tmp_path, {"obsidian_vault": str(tmp_path / "also-nope")})
    monkeypatch.setattr(vault_core, "DEFAULT_VAULT", str(tmp_path / "no-default"))
    with pytest.raises(vault_core.VaultUnavailableError) as exc:
        vault_core.search_vault("anything")
    assert "not found" in str(exc.value)


def test_search_vault_still_returns_empty_for_a_real_miss(tmp_path, monkeypatch):
    """The error must be reserved for a missing ROOT — a real vault with no
    match still returns [] rather than raising."""
    _mk(tmp_path, "A.md", "nothing relevant here")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    _write_settings(tmp_path, {})
    assert vault_core.search_vault("zzz-no-such-term") == []


def test_read_note_distinguishes_missing_vault_from_missing_note(tmp_path, monkeypatch):
    _mk(tmp_path, "A.md", "hello")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    _write_settings(tmp_path, {})
    with pytest.raises(FileNotFoundError):
        vault_core.read_note("NoSuchNote")          # vault fine, note missing

    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path / "gone"))
    monkeypatch.setattr(vault_core, "DEFAULT_VAULT", str(tmp_path / "no-default"))
    with pytest.raises(vault_core.VaultUnavailableError):
        vault_core.read_note("A")                   # vault itself is missing


def test_build_graph_raises_when_root_missing(tmp_path):
    with pytest.raises(vault_core.VaultUnavailableError):
        vault_core.build_graph(tmp_path / "not-a-vault")


def test_vault_unavailable_is_not_a_file_not_found():
    """Callers already map FileNotFoundError to 'that note is missing'; the
    missing-vault signal must not be swallowed by those handlers."""
    assert not issubclass(vault_core.VaultUnavailableError, FileNotFoundError)
