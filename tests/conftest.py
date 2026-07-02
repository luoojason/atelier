"""Shared pytest fixtures for the Atelier suite.

The r15 overwrite hook in shared_tools/vault_core.write_note captures the
superseded note content into the versions store rooted at env
ATELIER_VERSIONS_DIR (default ~/.atelier/versions). Any test that overwrites
a note without pointing that env at a tmp dir would therefore write real
blobs into the user's HOME store on every suite run — and those dead
tmp-path entries then surface in the shipped Versions card.

The autouse fixture below closes that hole for the whole suite:
  * ATELIER_VERSIONS_DIR defaults to a per-test tmp dir, so no test can
    touch ~/.atelier/versions (tests that set their own value still win —
    they assign after this fixture runs);
  * both store envs are snapshotted and restored afterwards, so
    script-style tests that assign os.environ directly (test_vault_memory.py
    and test_versions_store.py stay runnable as plain scripts) no longer
    leak dangling tmp paths into modules collected after them.
"""

import os

import pytest

_ISOLATED_KEYS = ("ATELIER_VERSIONS_DIR", "OBSIDIAN_VAULT", "ATELIER_SETTINGS_PATH")


@pytest.fixture(autouse=True)
def _isolate_versions_env(tmp_path):
    saved = {key: os.environ.get(key) for key in _ISOLATED_KEYS}
    os.environ["ATELIER_VERSIONS_DIR"] = str(tmp_path / "atelier-versions")
    os.environ["ATELIER_SETTINGS_PATH"] = str(tmp_path / "atelier-settings.json")
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
