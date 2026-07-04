"""Legacy state copy-forward: ~/.openswarm -> ~/.atelier, no data loss.

    .venv-ext/bin/python -m pytest -q tests/test_state_migrate.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from shared_tools import state_migrate as sm  # noqa: E402


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    old = tmp_path / "old"
    new = tmp_path / "new"
    monkeypatch.setattr(sm, "LEGACY_STATE_DIR", str(old))
    monkeypatch.setattr(sm, "NEW_STATE_DIR", str(new))
    return old, new


def test_copies_legacy_files_forward(dirs):
    old, new = dirs
    old.mkdir()
    (old / "swarm_memory.json").write_text('[{"fact":"x"}]')
    (old / "runs.jsonl").write_text('{"run":1}\n')
    (old / "notifications.jsonl").write_text('{"n":1}\n')
    sm.migrate_legacy_state()
    assert (new / "swarm_memory.json").read_text() == '[{"fact":"x"}]'
    assert (new / "runs.jsonl").read_text() == '{"run":1}\n'
    assert (new / "notifications.jsonl").read_text() == '{"n":1}\n'


def test_never_clobbers_newer_data(dirs):
    old, new = dirs
    old.mkdir()
    new.mkdir()
    (old / "swarm_memory.json").write_text("OLD")
    (new / "swarm_memory.json").write_text("NEW")
    sm.migrate_legacy_state()
    assert (new / "swarm_memory.json").read_text() == "NEW"  # existing data kept


def test_idempotent(dirs):
    old, new = dirs
    old.mkdir()
    (old / "runs.jsonl").write_text("a\n")
    sm.migrate_legacy_state()
    sm.migrate_legacy_state()  # second run must not raise or duplicate
    assert (new / "runs.jsonl").read_text() == "a\n"


def test_missing_legacy_dir_is_a_noop(dirs):
    _old, new = dirs
    sm.migrate_legacy_state()  # old does not exist
    assert not new.exists()


def test_only_flat_files_migrate_not_subdirs(dirs):
    old, new = dirs
    old.mkdir()
    (old / "claude-home").mkdir()  # a subdir (isolated CLI config), not a state file
    (old / "swarm_memory.json").write_text("m")
    sm.migrate_legacy_state()
    assert (new / "swarm_memory.json").exists()
    assert not (new / "claude-home").exists()  # subdirectories are skipped
