"""Tests for lite_server's read-only dashboard endpoints (/metrics /runs /jobs
/notifications) via fastapi TestClient — no live server, no network, and every
file path pointed into tmp_path via env vars (SWARM_RUNS_JSONL,
SWARM_NOTIFICATIONS, SWARM_MEMORY_PATH, SWARM_JOBS_FILE).

Needs the extension venv (lite_server imports agency_swarm):

    .venv-ext/bin/python -m pytest -q tests/test_lite_endpoints.py
"""

import datetime
import json
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("agency_swarm")

# Importing lite_server setdefaults DEFAULT_MODEL and CLAUDE_ISOLATED process-
# wide; snapshot and restore so the rest of the pytest run is unaffected.
_HAD_ISOLATED = "CLAUDE_ISOLATED" in os.environ
import lite_server  # noqa: E402

if not _HAD_ISOLATED:
    os.environ.pop("CLAUDE_ISOLATED", None)

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Point every data file the endpoints read into tmp_path (all missing)."""
    monkeypatch.setenv("SWARM_RUNS_JSONL", str(tmp_path / "runs.jsonl"))
    monkeypatch.setenv("SWARM_NOTIFICATIONS", str(tmp_path / "notifications.jsonl"))
    monkeypatch.setenv("SWARM_MEMORY_PATH", str(tmp_path / "swarm_memory.json"))
    monkeypatch.setenv("SWARM_JOBS_FILE", str(tmp_path / "jobs.yaml"))
    return tmp_path


@pytest.fixture
def client():
    return TestClient(lite_server.app)


TODAY_TS = datetime.datetime.now().isoformat(timespec="seconds")
OLD_TS = "2001-01-01T00:00:00"


def _run_record(name, ts, status="ok", tokens=None, cost=None, error=None):
    return {
        "name": name,
        "ts": ts,
        "status": status,
        "status_code": 200 if status == "ok" else 0,
        "tokens": tokens,
        "cost": cost,
        "latency_ms": 12,
        "attempts": 1,
        "error": error,
        "response_excerpt": "excerpt",
    }


def _write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")


def _seed(tmp_path):
    """Seed all four data files and return the seeded run records."""
    run_records = [
        _run_record("old-ok", OLD_TS, tokens=200, cost=1.0),
        _run_record("today-ok", TODAY_TS, tokens=100, cost=0.25),
        _run_record(
            "today-fail", TODAY_TS, status="error", tokens=50, cost=0.1,
            error="connection refused",
        ),
    ]
    _write_jsonl(tmp_path / "runs.jsonl", run_records)

    _write_jsonl(
        tmp_path / "notifications.jsonl",
        [
            {"name": "old-fail", "status": "error", "error": "boom", "ts": OLD_TS,
             "attempts": 3, "key": "old-fail::boom"},
            {"name": "today-fail", "status": "error", "error": "connection refused",
             "ts": TODAY_TS, "attempts": 1, "key": "today-fail::connection refused"},
        ],
    )

    (tmp_path / "swarm_memory.json").write_text(
        json.dumps(
            [
                {"ts": TODAY_TS, "kind": "note", "text": "a fact"},
                {"ts": TODAY_TS, "kind": "fact", "text": "another fact"},
                {"ts": TODAY_TS, "kind": "brief", "text": "a brief",
                 "project": "atelier"},
                {"ts": TODAY_TS, "kind": "campaign", "text": "a campaign"},
            ]
        ),
        encoding="utf-8",
    )

    (tmp_path / "jobs.yaml").write_text(
        "- name: daily-brief\n"
        '  schedule: "0 9 * * *"\n'
        "  prompt: Summarize the day\n",
        encoding="utf-8",
    )
    return run_records


# --------------------------------------------------------------------------- #
# Missing files -> empty shapes, never 500
# --------------------------------------------------------------------------- #


def test_metrics_empty_shape(env, client):
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert resp.json() == {
        "runs": {"today": 0, "total": 0, "ok": 0, "fail": 0, "fail_today": 0},
        "tokens_today": 0,
        "tokens_total": 0,
        "cost_total": 0,
        "memory": {"facts": 0, "briefs": 0, "campaigns": 0},
        "notifications": {"total": 0, "today": 0},
        "jobs": 0,
    }


def test_runs_empty_shape(env, client):
    resp = client.get("/runs")
    assert resp.status_code == 200
    assert resp.json() == {"runs": []}


def test_jobs_missing_file_empty_shape(env, client):
    resp = client.get("/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["jobs"] == []
    assert body["file"] == str(env / "jobs.yaml")
    assert "error" in body


def test_notifications_empty_shape(env, client):
    resp = client.get("/notifications")
    assert resp.status_code == 200
    assert resp.json() == {"notifications": []}


def test_metrics_corrupt_memory_file_never_500(env, client):
    (env / "swarm_memory.json").write_text("{not json", encoding="utf-8")
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert resp.json()["memory"] == {"facts": 0, "briefs": 0, "campaigns": 0}


# --------------------------------------------------------------------------- #
# Seeded files -> correct aggregates
# --------------------------------------------------------------------------- #


def test_metrics_aggregates(env, client):
    _seed(env)
    body = client.get("/metrics").json()
    assert body["runs"] == {
        "today": 2, "total": 3, "ok": 2, "fail": 1, "fail_today": 1,
    }
    assert body["tokens_today"] == 150
    assert body["tokens_total"] == 350
    assert body["cost_total"] == pytest.approx(1.35)
    assert body["memory"] == {"facts": 2, "briefs": 1, "campaigns": 1}
    assert body["notifications"] == {"total": 2, "today": 1}
    assert body["jobs"] == 1


def test_metrics_non_numeric_tokens_count_zero(env, client):
    _write_jsonl(
        env / "runs.jsonl",
        [
            _run_record("a", TODAY_TS, tokens="lots", cost=None),
            _run_record("b", TODAY_TS, tokens=True, cost="free"),
        ],
    )
    body = client.get("/metrics").json()
    assert body["tokens_total"] == 0
    assert body["cost_total"] == 0


def test_runs_tail_oldest_first(env, client):
    _seed(env)
    body = client.get("/runs?limit=2").json()
    names = [r["name"] for r in body["runs"]]
    assert names == ["today-ok", "today-fail"]  # most recent 2, oldest first
    # Record shape passes straight through from the ledger.
    assert set(body["runs"][0]) == {
        "name", "ts", "status", "status_code", "tokens", "cost",
        "latency_ms", "attempts", "error", "response_excerpt",
    }


def test_runs_limit_clamped(env, client):
    _seed(env)
    # limit=0 clamps up to 1 (not "return nothing", not a 500)...
    body = client.get("/runs?limit=0").json()
    assert [r["name"] for r in body["runs"]] == ["today-fail"]
    # ...and an oversized limit clamps down to 200 without erroring.
    body = client.get("/runs?limit=99999").json()
    assert len(body["runs"]) == 3


def test_jobs_seeded(env, client):
    _seed(env)
    body = client.get("/jobs").json()
    assert body["file"] == str(env / "jobs.yaml")
    assert "error" not in body
    assert body["jobs"] == [
        {"name": "daily-brief", "schedule": "0 9 * * *",
         "prompt": "Summarize the day"},
    ]


def test_notifications_seeded(env, client):
    _seed(env)
    body = client.get("/notifications?limit=1").json()
    assert len(body["notifications"]) == 1
    latest = body["notifications"][0]
    assert latest["name"] == "today-fail"
    assert set(latest) == {"name", "status", "error", "ts", "attempts", "key"}
