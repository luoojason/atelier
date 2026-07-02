"""Tests for lite_server's read-only dashboard endpoints (/metrics /runs /jobs
/notifications) via fastapi TestClient — no live server, no network, and every
file path pointed into tmp_path via env vars (SWARM_RUNS_JSONL,
SWARM_NOTIFICATIONS, SWARM_MEMORY_PATH, SWARM_JOBS_FILE).

Needs the extension venv (lite_server imports claude_agent_sdk + the
agency_swarm-based tools):

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

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

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
    assert len(body["jobs"]) == 1
    job = body["jobs"][0]
    # The computed fire times ride on each item; the rest passes through.
    next_fire = job.pop("next_fire")
    fire_after = job.pop("fire_after")
    assert job == {
        "name": "daily-brief", "schedule": "0 9 * * *",
        "prompt": "Summarize the day",
    }
    assert isinstance(next_fire, str) and isinstance(fire_after, str)


# --------------------------------------------------------------------------- #
# /jobs next_fire + fire_after
# --------------------------------------------------------------------------- #


def test_jobs_next_fire_cron(env, client):
    (env / "jobs.yaml").write_text(
        "- name: daily\n"
        '  schedule: "0 9 * * *"\n'
        "  prompt: p\n",
        encoding="utf-8",
    )
    job = client.get("/jobs").json()["jobs"][0]
    next_fire = datetime.datetime.fromisoformat(job["next_fire"])
    fire_after = datetime.datetime.fromisoformat(job["fire_after"])
    now = datetime.datetime.now().astimezone()
    assert now < next_fire < fire_after
    # Daily cron: consecutive fires are one day apart (23-25h tolerates DST).
    gap = (fire_after - next_fire).total_seconds()
    assert 23 * 3600 <= gap <= 25 * 3600
    assert next_fire.hour == 9 and next_fire.minute == 0


def test_jobs_next_fire_interval(env, client):
    (env / "jobs.yaml").write_text(
        "- name: often\n"
        '  schedule: "30m"\n'
        "  prompt: p\n",
        encoding="utf-8",
    )
    job = client.get("/jobs").json()["jobs"][0]
    next_fire = datetime.datetime.fromisoformat(job["next_fire"])
    fire_after = datetime.datetime.fromisoformat(job["fire_after"])
    # The interval cadence is exact: fires are one interval apart.
    assert (fire_after - next_fire).total_seconds() == 30 * 60


def test_jobs_interval_next_fire_anchors_to_last_ledger_run(env, client):
    # The daemon anchors an interval cadence at ITS start time; the closest
    # in-process proxy is the job's newest ledger fire. Anchored next_fire is
    # the anchor plus a whole number of intervals — and STABLE across
    # requests (a per-request re-anchor would read now + interval forever and
    # the schedring countdown would never advance).
    (env / "jobs.yaml").write_text(
        "- name: often\n"
        '  schedule: "30m"\n'
        "  prompt: p\n",
        encoding="utf-8",
    )
    last_run = (
        datetime.datetime.now() - datetime.timedelta(minutes=45)
    ).replace(microsecond=0)
    _write_jsonl(
        env / "runs.jsonl",
        [_run_record("often", last_run.isoformat()),
         _run_record("other-job", TODAY_TS)],
    )
    job = client.get("/jobs").json()["jobs"][0]
    next_fire = datetime.datetime.fromisoformat(job["next_fire"])
    # 45 minutes past the anchor: the cadence's next fire is anchor + 60m.
    assert next_fire == (last_run + datetime.timedelta(minutes=60)).astimezone()
    fire_after = datetime.datetime.fromisoformat(job["fire_after"])
    assert (fire_after - next_fire) == datetime.timedelta(minutes=30)
    # A second request reports the SAME instant.
    again = client.get("/jobs").json()["jobs"][0]
    assert again["next_fire"] == job["next_fire"]


def test_jobs_bad_schedule_yields_nulls_others_unaffected(env, client, monkeypatch):
    # load_jobs validates schedules at the file level, so a per-job failure
    # can only come from trigger construction itself — simulate one by
    # feeding the route a job list directly.
    monkeypatch.setattr(
        lite_server.jobs_core,
        "load_jobs",
        lambda path: [
            {"name": "bad", "schedule": "not a schedule", "prompt": "p"},
            {"name": "good", "schedule": "30m", "prompt": "p"},
        ],
    )
    resp = client.get("/jobs")
    assert resp.status_code == 200
    jobs = {j["name"]: j for j in resp.json()["jobs"]}
    assert jobs["bad"]["next_fire"] is None
    assert jobs["bad"]["fire_after"] is None
    assert jobs["good"]["next_fire"] is not None
    assert jobs["good"]["fire_after"] is not None


# --------------------------------------------------------------------------- #
# /campaigns
# --------------------------------------------------------------------------- #


def _campaign_entry(cid, goal, ts):
    """A stored campaign entry, shaped like campaign_core.save_campaign's."""
    return {
        "ts": ts,
        "kind": "campaign",
        "text": goal,
        "project": None,
        "id": cid,
        "campaign": {
            "id": cid,
            "goal": goal,
            "project": None,
            "brief": None,
            "deliverables": [
                {"type": "post", "spec": "s", "status": "planned",
                 "path": None, "verdict": None},
            ],
            "stage": "planned",
            "created_ts": ts,
        },
    }


def test_campaigns_empty_shape(env, client):
    resp = client.get("/campaigns")
    assert resp.status_code == 200
    assert resp.json() == {"campaigns": []}


def test_campaigns_corrupt_memory_never_500(env, client):
    (env / "swarm_memory.json").write_text("{not json", encoding="utf-8")
    resp = client.get("/campaigns")
    assert resp.status_code == 200
    assert resp.json() == {"campaigns": []}


def test_campaigns_filters_newest_first_verbatim(env, client):
    older = _campaign_entry("c1", "first goal", OLD_TS)
    newer = _campaign_entry("c2", "second goal", TODAY_TS)
    (env / "swarm_memory.json").write_text(
        json.dumps(
            [
                {"ts": OLD_TS, "kind": "note", "text": "a fact"},
                older,
                {"ts": TODAY_TS, "kind": "brief", "text": "a brief"},
                newer,
            ]
        ),
        encoding="utf-8",
    )
    body = client.get("/campaigns").json()
    # Only kind == "campaign", newest (appended last) first, verbatim.
    assert body["campaigns"] == [newer, older]


def test_campaigns_limit(env, client):
    entries = [_campaign_entry(f"c{i}", f"goal {i}", TODAY_TS) for i in range(25)]
    (env / "swarm_memory.json").write_text(json.dumps(entries), encoding="utf-8")
    body = client.get("/campaigns").json()
    assert len(body["campaigns"]) == 20  # default limit
    assert body["campaigns"][0]["id"] == "c24"  # newest first
    body = client.get("/campaigns?limit=2").json()
    assert [c["id"] for c in body["campaigns"]] == ["c24", "c23"]


def test_notifications_seeded(env, client):
    _seed(env)
    body = client.get("/notifications?limit=1").json()
    assert len(body["notifications"]) == 1
    latest = body["notifications"][0]
    assert latest["name"] == "today-fail"
    assert set(latest) == {"name", "status", "error", "ts", "attempts", "key"}
