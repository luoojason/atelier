"""Tests for the sandboxed agent workspace (WriteFile / ReadFile / ListFiles).

Security is the point: the agent runs autonomously on a prompt-injection
surface, so containment to one directory is the invariant. These exercise the
happy path AND every escape vector (relative traversal, absolute paths, planted
symlinks, null bytes) plus the size/count backstops.

    .venv-ext/bin/python -m pytest -q tests/test_workspace_tools.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from shared_tools import workspace_core as w  # noqa: E402


@pytest.fixture(autouse=True)
def _tmp_workspace(monkeypatch, tmp_path):
    ws = tmp_path / "workspace"
    monkeypatch.setenv("ATELIER_WORKSPACE", str(ws))
    monkeypatch.delenv("ATELIER_SETTINGS_PATH", raising=False)
    return ws


# ── happy path ────────────────────────────────────────────────────────────────

def test_write_read_list_round_trip(_tmp_workspace):
    p = w.write_file("demo/hello.py", "print(6 * 7)")
    assert p.endswith("/demo/hello.py")
    assert os.path.isfile(p)
    assert w.read_file("demo/hello.py") == "print(6 * 7)"
    assert w.list_files() == ["demo/hello.py"]


def test_write_creates_subfolders_and_overwrites(_tmp_workspace):
    w.write_file("a/b/c/file.txt", "one")
    assert w.read_file("a/b/c/file.txt") == "one"
    w.write_file("a/b/c/file.txt", "two")  # overwrite is allowed (own scratch)
    assert w.read_file("a/b/c/file.txt") == "two"


def test_list_files_sorted_and_relative(_tmp_workspace):
    w.write_file("z.txt", "1")
    w.write_file("a/b.txt", "2")
    w.write_file("a/a.txt", "3")
    assert w.list_files() == ["a/a.txt", "a/b.txt", "z.txt"]


# ── containment: every escape vector must raise, never touch disk outside ─────

@pytest.mark.parametrize("bad", [
    "../escape.txt",
    "../../etc/passwd",
    "a/../../escape.txt",
    "a/b/../../../escape.txt",
    "../workspace-evil/x.txt",   # sibling sharing a name prefix must not count as inside
    "/etc/passwd",
    "/tmp/escape.txt",
    "",
    "   ",
    "x\x00y",
])
def test_write_refuses_to_escape_the_workspace(_tmp_workspace, tmp_path, bad):
    before = {p for p in tmp_path.rglob("*") if p.is_file()}
    with pytest.raises(ValueError):
        w.write_file(bad, "PWNED")
    # and NOTHING was written anywhere under the test tree (not just: it raised)
    after = {p for p in tmp_path.rglob("*") if p.is_file()}
    assert after == before


@pytest.mark.parametrize("bad", ["../../etc/passwd", "/etc/passwd", "a/../../x"])
def test_read_refuses_to_escape_the_workspace(_tmp_workspace, bad):
    with pytest.raises((ValueError, FileNotFoundError)):
        w.read_file(bad)


def test_cannot_write_to_the_apps_own_config(_tmp_workspace, tmp_path):
    # The workspace is a subdir; a '..' hop toward a sibling config is refused,
    # so the agent can never clobber settings.json / jobs.yaml in the parent.
    (tmp_path / "settings.json").write_text('{"secret": true}')
    with pytest.raises(ValueError):
        w.write_file("../settings.json", "{}")
    assert (tmp_path / "settings.json").read_text() == '{"secret": true}'


def test_symlink_planted_in_workspace_cannot_escape(_tmp_workspace, tmp_path):
    # Even if a symlink somehow exists inside the workspace (the agent has no
    # tool to make one, but defense in depth), resolve() follows it BEFORE the
    # containment check, so writing/reading through it is refused.
    ws = _tmp_workspace
    ws.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (ws / "link").symlink_to(outside)
    with pytest.raises(ValueError):
        w.write_file("link/pwned.txt", "PWNED")
    assert not (outside / "pwned.txt").exists()
    (outside / "secret.txt").write_text("secret")
    with pytest.raises((ValueError, FileNotFoundError)):
        w.read_file("link/secret.txt")


def test_write_refuses_onto_an_existing_directory(_tmp_workspace):
    w.write_file("dir/keep.txt", "x")
    with pytest.raises(ValueError):
        w.write_file("dir", "not a file")


# ── backstops ─────────────────────────────────────────────────────────────────

def test_per_file_size_cap(monkeypatch, _tmp_workspace):
    monkeypatch.setattr(w, "_MAX_FILE_BYTES", 100)
    with pytest.raises(ValueError):
        w.write_file("big.txt", "x" * 101)
    w.write_file("ok.txt", "x" * 100)  # exactly at the cap is fine


def test_file_count_cap(monkeypatch, _tmp_workspace):
    monkeypatch.setattr(w, "_MAX_FILES", 2)
    w.write_file("f1.txt", "a")
    w.write_file("f2.txt", "b")
    with pytest.raises(ValueError):
        w.write_file("f3.txt", "c")
    # overwriting an existing file still works at the cap (no new file)
    w.write_file("f1.txt", "a2")
    assert w.read_file("f1.txt") == "a2"


def test_read_truncates_a_huge_file(monkeypatch, _tmp_workspace):
    monkeypatch.setattr(w, "_READ_MAX_CHARS", 50)
    w.write_file("big.txt", "y" * 500)
    out = w.read_file("big.txt")
    assert "file truncated" in out
    assert len(out) < 120


def test_read_missing_file_raises(_tmp_workspace):
    with pytest.raises(FileNotFoundError):
        w.read_file("nope.txt")


def test_list_empty_workspace(_tmp_workspace):
    assert w.list_files() == []


# ── root resolution: settings > env > default ─────────────────────────────────

def test_workspace_root_prefers_settings_then_env(monkeypatch, tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text('{"workspace_dir": "%s"}' % (tmp_path / "from_settings"))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(settings))
    monkeypatch.setenv("ATELIER_WORKSPACE", str(tmp_path / "from_env"))
    assert w.workspace_root() == tmp_path / "from_settings"
    # remove the settings override -> env wins
    settings.write_text("{}")
    assert w.workspace_root() == tmp_path / "from_env"


def test_workspace_root_rejects_unsafe_configured_roots(monkeypatch):
    # A configured root that would expose the app's own secrets (~, ~/.atelier,
    # /, or an ancestor of ~/.atelier) is ignored -> falls back to the default,
    # so a misconfig can never widen the sandbox onto settings.json / OAuth.
    monkeypatch.delenv("ATELIER_SETTINGS_PATH", raising=False)
    default = os.path.expanduser(w.DEFAULT_WORKSPACE)
    for unsafe in ("~", "~/.atelier", "/", os.path.expanduser("~")):
        monkeypatch.setenv("ATELIER_WORKSPACE", unsafe)
        assert str(w.workspace_root()) == default, unsafe
    # a normal user-chosen dir is still honored
    monkeypatch.setenv("ATELIER_WORKSPACE", "/tmp/atelier-ws-test")
    assert str(w.workspace_root()) == "/tmp/atelier-ws-test"


# ── tool wrappers ─────────────────────────────────────────────────────────────

def test_tool_wrappers(_tmp_workspace):
    from shared_tools import WriteFile, ReadFile, ListFiles

    assert WriteFile(path="p/a.txt", content="hi").run().startswith("Wrote file to:")
    assert ReadFile(path="p/a.txt").run() == "hi"
    assert "p/a.txt" in ListFiles().run()
    # errors come back as a plain "Error: ..." string, not an exception
    assert WriteFile(path="../x", content="y").run().startswith("Error:")
    assert ReadFile(path="../../etc/passwd").run().startswith("Error:")
    # ListFiles takes no args
    from shared_tools.sdk_tools import _build_input_schema
    assert _build_input_schema(ListFiles) == {"type": "object", "properties": {}, "required": []}
