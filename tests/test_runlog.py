"""Tests for lite_server's GET /logs/backend run-log tail endpoint via fastapi
TestClient — no live server, no network, and the log path pointed into
tmp_path via ATELIER_BACKEND_LOG.

Needs the extension venv (lite_server imports claude_agent_sdk + the
agency_swarm-based tools):

    .venv-ext/bin/python -m pytest -q tests/test_runlog.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def log_path(monkeypatch, tmp_path):
    """Point the endpoint at a tmp log file (not created yet)."""
    path = tmp_path / "backend.log"
    monkeypatch.setenv("ATELIER_BACKEND_LOG", str(path))
    return path


@pytest.fixture
def client():
    return TestClient(lite_server.app)


def _write_lines(path, lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- #
# Shape + tail semantics
# --------------------------------------------------------------------------- #


def test_shape_and_content(log_path, client):
    _write_lines(log_path, ["alpha", "beta", "gamma"])
    resp = client.get("/logs/backend")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"lines", "path", "size"}
    assert body["lines"] == ["alpha", "beta", "gamma"]
    assert body["path"] == str(log_path)
    assert body["size"] == log_path.stat().st_size


def test_tail_returns_last_n_lines_in_order(log_path, client):
    _write_lines(log_path, [f"line {i}" for i in range(50)])
    body = client.get("/logs/backend?tail=5").json()
    assert body["lines"] == [f"line {i}" for i in range(45, 50)]


def test_default_tail_is_200(log_path, client):
    _write_lines(log_path, [f"line {i}" for i in range(250)])
    body = client.get("/logs/backend").json()
    assert len(body["lines"]) == 200
    assert body["lines"][0] == "line 50"
    assert body["lines"][-1] == "line 249"


# --------------------------------------------------------------------------- #
# Clamping: 1..1000
# --------------------------------------------------------------------------- #


def test_tail_clamped_low(log_path, client):
    _write_lines(log_path, ["one", "two", "three"])
    # tail=0 clamps up to 1 (not "return nothing", not a 500)...
    body = client.get("/logs/backend?tail=0").json()
    assert body["lines"] == ["three"]
    # ...and so does a negative tail.
    body = client.get("/logs/backend?tail=-5").json()
    assert body["lines"] == ["three"]


def test_tail_clamped_high(log_path, client):
    _write_lines(log_path, [f"line {i}" for i in range(1200)])
    body = client.get("/logs/backend?tail=99999").json()
    assert len(body["lines"]) == 1000
    assert body["lines"][0] == "line 200"
    assert body["lines"][-1] == "line 1199"


# --------------------------------------------------------------------------- #
# Missing/unreadable file -> empty shape, never 500
# --------------------------------------------------------------------------- #


def test_missing_file_empty_shape(log_path, client):
    resp = client.get("/logs/backend")
    assert resp.status_code == 200
    assert resp.json() == {"lines": [], "path": str(log_path), "size": 0}


def test_path_is_a_directory_empty_shape(log_path, client):
    log_path.mkdir()
    resp = client.get("/logs/backend")
    assert resp.status_code == 200
    assert resp.json() == {"lines": [], "path": str(log_path), "size": 0}


def test_default_path_used_when_env_unset(monkeypatch, client):
    monkeypatch.delenv("ATELIER_BACKEND_LOG", raising=False)
    body = client.get("/logs/backend").json()
    assert body["path"] == os.path.expanduser("~/.atelier/logs/backend.log")
    # No assertion on lines/size: the real file may exist on a dev machine.
    assert set(body) == {"lines", "path", "size"}


# --------------------------------------------------------------------------- #
# Non-UTF-8 bytes tolerated (errors='replace', never a decode 500)
# --------------------------------------------------------------------------- #


def test_non_utf8_bytes_tolerated(log_path, client):
    log_path.write_bytes(b"good line\n\xff\xfe garbage\nlast line\n")
    resp = client.get("/logs/backend")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["lines"]) == 3
    assert body["lines"][0] == "good line"
    assert body["lines"][2] == "last line"
    assert "�" in body["lines"][1]  # replacement chars, not an error
    assert body["size"] == log_path.stat().st_size


# --------------------------------------------------------------------------- #
# Big file: only the ~1MB tail window is read, results still correct
# --------------------------------------------------------------------------- #


def test_large_file_reads_only_tail_window(log_path, client):
    # ~1.5MB of numbered lines: the 1MB window starts mid-file, and the last
    # N lines must still come back exact (the window's leading fragment is
    # discarded by the [-n:] slice).
    lines = [f"line {i:06d} " + "x" * 40 for i in range(30000)]
    _write_lines(log_path, lines)
    assert log_path.stat().st_size > lite_server._LOG_TAIL_MAX_BYTES
    body = client.get("/logs/backend?tail=300").json()
    assert body["lines"] == lines[-300:]
    assert body["size"] == log_path.stat().st_size
