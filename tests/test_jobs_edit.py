"""Tests for lite_server's jobs editing routes: POST /jobs (upsert by name)
and DELETE /jobs/{name}.

Same setup as test_lite_endpoints.py: fastapi TestClient, no live server, the
jobs file pointed into tmp_path via SWARM_JOBS_FILE. Covers the round-trip
(create / edit / delete), validation 400s with human-readable reasons, the
repo-fallback 409 (SWARM_JOBS_FILE unset means the repo files would be
written), token gating, and unknown-yaml-key preservation on sibling jobs.

Needs the extension venv (lite_server imports claude_agent_sdk):

    .venv-ext/bin/python -m pytest -q tests/test_jobs_edit.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")
yaml = pytest.importorskip("yaml")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Point the jobs file into tmp_path; token gate off unless a test sets it.

    The runs ledger is isolated too: GET /jobs anchors interval next_fire on
    the job's newest ledger fire, and the developer's real ~/.openswarm ledger
    must not leak into these assertions.
    """
    monkeypatch.setenv("SWARM_JOBS_FILE", str(tmp_path / "jobs.yaml"))
    monkeypatch.setenv("SWARM_RUNS_JSONL", str(tmp_path / "runs.jsonl"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return tmp_path


@pytest.fixture
def client():
    return TestClient(lite_server.app)


TWO_JOBS_YAML = (
    "jobs:\n"
    "  - name: daily-brief\n"
    '    schedule: "0 9 * * *"\n'
    "    prompt: Summarize the day\n"
    "  - name: often\n"
    '    schedule: "30m"\n'
    "    prompt: Poke around\n"
)


def _job_names(client):
    return [j["name"] for j in client.get("/jobs").json()["jobs"]]


def _raw_jobs(env):
    data = yaml.safe_load((env / "jobs.yaml").read_text(encoding="utf-8"))
    return data["jobs"] if isinstance(data, dict) else data


# --------------------------------------------------------------------------- #
# Create / edit / delete round-trip
# --------------------------------------------------------------------------- #


def test_create_new_job_roundtrip(env, client):
    resp = client.post(
        "/jobs",
        json={"name": "nightly", "schedule": "0 2 * * *", "prompt": "Do the thing"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["job"] == {
        "name": "nightly", "schedule": "0 2 * * *", "prompt": "Do the thing",
    }
    listed = client.get("/jobs").json()["jobs"]
    assert len(listed) == 1
    assert listed[0]["name"] == "nightly"
    assert listed[0]["next_fire"] is not None  # a written job schedules cleanly


def test_create_builtin_digest_job(env, client):
    resp = client.post(
        "/jobs",
        json={"name": "digest", "schedule": "0 6 * * *", "type": "builtin:digest"},
    )
    assert resp.status_code == 200
    assert resp.json()["job"] == {
        "name": "digest", "schedule": "0 6 * * *", "builtin": "digest",
    }
    (entry,) = _raw_jobs(env)
    assert entry["builtin"] == "digest"
    assert "prompt" not in entry


def test_upsert_existing_job_changes_schedule(env, client):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    resp = client.post(
        "/jobs",
        json={"name": "daily-brief", "schedule": "0 8 * * *", "prompt": "New prompt"},
    )
    assert resp.status_code == 200
    listed = client.get("/jobs").json()["jobs"]
    assert [j["name"] for j in listed] == ["daily-brief", "often"]  # in place
    assert listed[0]["schedule"] == "0 8 * * *"
    assert listed[0]["prompt"] == "New prompt"
    assert listed[1]["prompt"] == "Poke around"  # sibling untouched


def test_upsert_preserves_extra_fields_on_edited_job(env, client):
    (env / "jobs.yaml").write_text(
        "- name: morning-brief\n"
        '  schedule: "0 7 * * *"\n'
        '  catch_up: "1d"\n'
        "  prompt: Old prompt\n",
        encoding="utf-8",
    )
    resp = client.post(
        "/jobs",
        json={"name": "morning-brief", "schedule": "0 8 * * *", "prompt": "New"},
    )
    assert resp.status_code == 200
    (entry,) = _raw_jobs(env)
    assert entry["catch_up"] == "1d"  # a field the form does not carry survives
    assert entry["schedule"] == "0 8 * * *"


def test_upsert_preserves_unknown_keys_on_other_jobs(env, client):
    # Sibling "weird" carries a key validate_job rejects; the daemon's lenient
    # loader skips it, but an edit of another job must round-trip it verbatim.
    (env / "jobs.yaml").write_text(
        TWO_JOBS_YAML + "  - name: weird\n"
        '    schedule: "1h"\n'
        "    prompt: hi\n"
        "    notes: keepme\n",
        encoding="utf-8",
    )
    resp = client.post(
        "/jobs",
        json={"name": "daily-brief", "schedule": "0 8 * * *", "prompt": "New"},
    )
    assert resp.status_code == 200
    entries = {e["name"]: e for e in _raw_jobs(env)}
    assert entries["weird"]["notes"] == "keepme"
    assert entries["daily-brief"]["schedule"] == "0 8 * * *"


def test_upsert_type_switch_swaps_payload_field(env, client):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    resp = client.post(
        "/jobs",
        json={"name": "often", "schedule": "30m", "type": "builtin:digest"},
    )
    assert resp.status_code == 200
    entries = {e["name"]: e for e in _raw_jobs(env)}
    assert entries["often"]["builtin"] == "digest"
    assert "prompt" not in entries["often"]  # exactly one of prompt|builtin


def test_write_is_atomic_no_tmp_left_behind(env, client):
    client.post("/jobs", json={"name": "a", "schedule": "1h", "prompt": "p"})
    assert not (env / "jobs.yaml.tmp").exists()


def test_delete_removes_job(env, client):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    resp = client.delete("/jobs/daily-brief")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert _job_names(client) == ["often"]


def test_delete_unknown_name(env, client):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    resp = client.delete("/jobs/no-such-job")
    assert resp.status_code == 200
    assert resp.json() == {"ok": False}
    assert _job_names(client) == ["daily-brief", "often"]


def test_delete_missing_file(env, client):
    assert client.delete("/jobs/anything").json() == {"ok": False}


# --------------------------------------------------------------------------- #
# Validation 400s (human-readable reasons)
# --------------------------------------------------------------------------- #


def _post(client, **overrides):
    body = {"name": "j", "schedule": "1h", "prompt": "p"}
    body.update(overrides)
    return client.post("/jobs", json=body)


def test_invalid_cron_400(env, client):
    resp = _post(client, schedule="99 0 * * *")
    assert resp.status_code == 400
    assert "invalid cron field" in resp.json()["error"]


def test_junk_schedule_400(env, client):
    resp = _post(client, schedule="whenever")
    assert resp.status_code == 400
    assert "invalid schedule" in resp.json()["error"]


def test_empty_name_400(env, client):
    resp = _post(client, name="   ")
    assert resp.status_code == 400
    assert resp.json()["error"] == "name must not be empty"


def test_long_name_400(env, client):
    resp = _post(client, name="x" * 101)
    assert resp.status_code == 400
    assert "too long" in resp.json()["error"]


def test_newline_name_400(env, client):
    resp = _post(client, name="two\nlines")
    assert resp.status_code == 400
    assert "newline" in resp.json()["error"]


def test_missing_prompt_400(env, client):
    resp = _post(client, prompt="")
    assert resp.status_code == 400
    assert "prompt is required" in resp.json()["error"]


def test_unknown_type_400(env, client):
    resp = _post(client, type="builtin:rm-rf")
    assert resp.status_code == 400
    assert "type must be" in resp.json()["error"]


def test_slash_name_400(env, client):
    # DELETE /jobs/{name} matches one path segment (starlette decodes %2F
    # before routing), so a slashed name could never be deleted again.
    resp = _post(client, name="team/alpha brief")
    assert resp.status_code == 400
    assert "'/'" in resp.json()["error"]


def test_reserved_scheduler_names_400(env, client):
    # The daemon's internal APScheduler ids share the user-job id namespace:
    # the hot-reload watcher and the boot catch-up one-shots.
    for name in ("__jobs-file-reload__", "catch-up:daily-brief"):
        resp = _post(client, name=name)
        assert resp.status_code == 400, name
        assert "reserved" in resp.json()["error"], name


def test_unparseable_jobs_file_400(env, client):
    (env / "jobs.yaml").write_text("jobs: [unclosed", encoding="utf-8")
    resp = _post(client)
    assert resp.status_code == 400
    assert "could not be parsed" in resp.json()["error"]
    # Nothing was written over the user's (broken but recoverable) file.
    assert (env / "jobs.yaml").read_text(encoding="utf-8") == "jobs: [unclosed"


def test_validation_failure_leaves_file_untouched(env, client):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    resp = _post(client, name="daily-brief", schedule="99 0 * * *")
    assert resp.status_code == 400
    assert (env / "jobs.yaml").read_text(encoding="utf-8") == TWO_JOBS_YAML


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root reads through chmod 000",
)
def test_unreadable_jobs_file_is_never_wiped(env, client):
    # Only a MISSING file may start a fresh document. An unreadable-but-
    # present one still holds the user's jobs; the atomic replace (which only
    # needs directory write permission) must not rebuild it from empty.
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    os.chmod(env / "jobs.yaml", 0)
    try:
        resp = client.post(
            "/jobs", json={"name": "new", "schedule": "1h", "prompt": "p"}
        )
        assert resp.status_code == 500
        assert "could not read jobs file" in resp.json()["error"]
        deleted = client.delete("/jobs/daily-brief")
        assert deleted.status_code == 200
        assert deleted.json() == {"ok": False}
    finally:
        os.chmod(env / "jobs.yaml", 0o644)
    assert (env / "jobs.yaml").read_text(encoding="utf-8") == TWO_JOBS_YAML


# --------------------------------------------------------------------------- #
# Repo fallback -> 409 (never write into the checkout)
# --------------------------------------------------------------------------- #


def test_post_repo_fallback_409(monkeypatch, client):
    monkeypatch.delenv("SWARM_JOBS_FILE", raising=False)
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    resp = client.post("/jobs", json={"name": "j", "schedule": "1h", "prompt": "p"})
    assert resp.status_code == 409
    assert resp.json() == {"error": "no user jobs file configured"}


def test_delete_repo_fallback_409(monkeypatch, client):
    monkeypatch.delenv("SWARM_JOBS_FILE", raising=False)
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    resp = client.delete("/jobs/anything")
    assert resp.status_code == 409
    assert resp.json() == {"error": "no user jobs file configured"}


# --------------------------------------------------------------------------- #
# Token gating (the mutating-methods middleware)
# --------------------------------------------------------------------------- #


def test_token_gates_post_and_delete(env, client, monkeypatch):
    (env / "jobs.yaml").write_text(TWO_JOBS_YAML, encoding="utf-8")
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")

    body = {"name": "j", "schedule": "1h", "prompt": "p"}
    assert client.post("/jobs", json=body).status_code == 403
    assert (
        client.post("/jobs", json=body, headers={"X-Atelier-Token": "wrong"})
        .status_code
        == 403
    )
    assert client.delete("/jobs/daily-brief").status_code == 403
    assert _job_names(client) == ["daily-brief", "often"]  # GETs stay open

    ok = client.post("/jobs", json=body, headers={"X-Atelier-Token": "sekret"})
    assert ok.status_code == 200 and ok.json()["ok"] is True
    gone = client.delete(
        "/jobs/daily-brief", headers={"X-Atelier-Token": "sekret"}
    )
    assert gone.status_code == 200 and gone.json() == {"ok": True}
