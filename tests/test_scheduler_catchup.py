"""Assert-based tests for the scheduler's catch_up + builtin-digest wiring.

Run with the SYSTEM python (no heavy framework needed):

    python3 tests/test_scheduler_catchup.py

Most tests import only the pure modules (jobs_core, run_store) + stdlib.
The template-load test needs PyYAML (block-scalar prompts) and the
schedule_catch_ups test needs APScheduler's DateTrigger; each degrades to a
printed note when its dependency is unavailable, matching test_scheduler.py.
"""

import contextlib
import datetime
import os
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so "scheduler.*" resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scheduler import client, notify, run_store
from scheduler.jobs_core import (
    CATCH_UP_INITIAL_DELAY,
    CATCH_UP_STAGGER,
    has_recent_ok,
    load_jobs,
    parse_catch_up,
    plan_catch_ups,
    validate_job,
)

ATELIER_TEMPLATE = os.path.join(_ROOT, "scheduler", "jobs.atelier.yaml")


@contextlib.contextmanager
def _scoped_env(**overrides):
    """Temporarily set env vars (a None value deletes the var); restore on exit."""
    saved = {key: os.environ.get(key) for key in overrides}
    try:
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, old in saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old


def _ok_record(name, ts):
    return run_store.build_record(name, ts, "ok", 200, 5, 0.001, 100, 1, None, "r")


# --------------------------------------------------------------------------- #
# parse_catch_up
# --------------------------------------------------------------------------- #


def test_parse_catch_up_whole_days():
    assert parse_catch_up("1d") == 86400
    assert parse_catch_up("7d") == 7 * 86400
    assert parse_catch_up(" 2D ") == 2 * 86400  # whitespace + case tolerant


def test_parse_catch_up_rejects_junk():
    # Strict: whole positive days only. Everything else is a clean ValueError
    # (the same per-job-validation-never-crashes-the-daemon behavior as cron).
    for bad in ["", "d", "0d", "-1d", "1h", "30m", "24", "1.5d", "1dd", "one d", None, 7]:
        try:
            parse_catch_up(bad)
        except ValueError:
            continue
        raise AssertionError(f"parse_catch_up should have rejected {bad!r}")


# --------------------------------------------------------------------------- #
# validate_job — catch_up / builtin schema additions
# --------------------------------------------------------------------------- #


def test_validate_job_accepts_catch_up_and_builtin():
    prompt_job = validate_job(
        {"name": "brief", "schedule": "0 7 * * *", "prompt": "hi", "catch_up": " 1d "}
    )
    assert prompt_job["catch_up"] == "1d"  # stripped, retained

    builtin_job = validate_job(
        {"name": "digest", "schedule": "0 6 * * *", "builtin": "digest", "catch_up": "1d"}
    )
    assert builtin_job["builtin"] == "digest"
    assert "prompt" not in builtin_job


def test_validate_job_prompt_builtin_mutual_exclusion():
    bad_cases = [
        # both prompt and builtin
        {"name": "x", "schedule": "30m", "prompt": "hi", "builtin": "digest"},
        # neither prompt nor builtin
        {"name": "x", "schedule": "30m"},
        {"name": "x", "schedule": "30m", "catch_up": "1d"},
        # unknown builtin
        {"name": "x", "schedule": "30m", "builtin": "bogus"},
        # non-string / empty builtin
        {"name": "x", "schedule": "30m", "builtin": 3},
        {"name": "x", "schedule": "30m", "builtin": "  "},
        # junk catch_up windows are validation errors, exactly like junk cron
        {"name": "x", "schedule": "30m", "prompt": "hi", "catch_up": "1h"},
        {"name": "x", "schedule": "30m", "prompt": "hi", "catch_up": "0d"},
        {"name": "x", "schedule": "30m", "prompt": "hi", "catch_up": "junk"},
        {"name": "x", "schedule": "30m", "prompt": "hi", "catch_up": 1},
    ]
    for case in bad_cases:
        try:
            validate_job(case)
        except ValueError:
            continue
        raise AssertionError(f"validate_job should have rejected {case!r}")


# --------------------------------------------------------------------------- #
# the shipped Atelier template
# --------------------------------------------------------------------------- #


def test_load_jobs_atelier_template():
    try:
        import yaml  # noqa: F401 - block-scalar prompts need real YAML
    except ImportError:
        print("NOTE: skipping atelier template test (PyYAML unavailable)")
        return

    jobs = load_jobs(ATELIER_TEMPLATE)
    assert [j["name"] for j in jobs] == [
        "morning-brief",
        "project-rollup",
        "overnight-digest",
    ], jobs

    brief, rollup, digest_job = jobs
    assert brief["schedule"] == "0 7 * * *"
    assert brief["catch_up"] == "1d"
    assert "Morning Brief" in brief["prompt"]

    assert rollup["schedule"] == "0 18 * * 0"
    assert rollup["catch_up"] == "7d"
    assert "Project Rollup" in rollup["prompt"]

    assert digest_job["schedule"] == "0 6 * * *"
    assert digest_job["catch_up"] == "1d"
    assert digest_job["builtin"] == "digest"
    assert "prompt" not in digest_job


# --------------------------------------------------------------------------- #
# has_recent_ok / plan_catch_ups (pure window logic + stagger)
# --------------------------------------------------------------------------- #


def test_has_recent_ok():
    records = [
        _ok_record("a", "2026-07-01T05:00:00"),
        {"name": "b", "ts": "2026-07-01T05:00:00", "status": "error"},
        "not a dict",  # foreign ledger line: ignored, never raises
        {"name": "c", "status": "ok"},  # no ts -> older than any cutoff
    ]
    cutoff = "2026-07-01T00:00:00"
    assert has_recent_ok(records, "a", cutoff) is True
    assert has_recent_ok(records, "a", "2026-07-01T06:00:00") is False  # too old
    assert has_recent_ok(records, "b", cutoff) is False  # status != ok
    assert has_recent_ok(records, "c", cutoff) is False  # ts missing
    assert has_recent_ok(records, "missing", cutoff) is False
    assert has_recent_ok([], "a", cutoff) is False
    assert has_recent_ok(None, "a", cutoff) is False


def test_plan_catch_ups_fresh_stale_missing_and_stagger():
    now = datetime.datetime(2026, 7, 1, 12, 0, 0)
    iso = lambda dt: dt.isoformat(timespec="seconds")  # noqa: E731
    jobs = [
        # fresh: ok run 1h ago, window 1d -> NOT planned
        {"name": "fresh", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "1d"},
        # stale: last ok run 2d ago, window 1d -> planned
        {"name": "stale", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "1d"},
        # missing: no ledger record at all -> planned
        {"name": "missing", "schedule": "0 6 * * *", "builtin": "digest", "catch_up": "1d"},
        # no catch_up field -> never planned
        {"name": "plain", "schedule": "30m", "prompt": "p"},
        # only a recent FAILED run inside the window -> planned (ok required)
        {"name": "failing", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "7d"},
    ]
    records = [
        _ok_record("fresh", iso(now - datetime.timedelta(hours=1))),
        _ok_record("stale", iso(now - datetime.timedelta(days=2))),
        run_store.build_record(
            "failing", iso(now - datetime.timedelta(hours=2)),
            "error", 0, None, None, 5, 3, "boom", None,
        ),
    ]

    plans = plan_catch_ups(jobs, records, now=now)
    assert [p["job"]["name"] for p in plans] == ["stale", "missing", "failing"], plans
    # Stagger: first ~20s after start, each subsequent one +45s apart.
    assert [p["delay"] for p in plans] == [
        CATCH_UP_INITIAL_DELAY,
        CATCH_UP_INITIAL_DELAY + CATCH_UP_STAGGER,
        CATCH_UP_INITIAL_DELAY + 2 * CATCH_UP_STAGGER,
    ], plans
    assert [p["delay"] for p in plans] == [20, 65, 110]  # the contract numbers

    # An all-fresh ledger plans nothing.
    fresh_records = [
        _ok_record(j["name"], iso(now - datetime.timedelta(hours=1))) for j in jobs
    ]
    assert plan_catch_ups(jobs, fresh_records, now=now) == []


# --------------------------------------------------------------------------- #
# schedule_catch_ups (daemon glue: ledger read -> plans -> DateTrigger jobs)
# --------------------------------------------------------------------------- #


class _FakeScheduler:
    def __init__(self):
        self.added = []

    def add_job(self, func, trigger=None, id=None, name=None, replace_existing=None):
        self.added.append(
            {"func": func, "trigger": trigger, "id": id, "name": name}
        )


def test_schedule_catch_ups_registers_only_stale_jobs():
    try:
        from apscheduler.triggers.date import DateTrigger  # noqa: F401
    except ImportError:
        print("NOTE: skipping schedule_catch_ups test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    now = datetime.datetime.now().replace(microsecond=0)
    jobs = [
        {"name": "fresh", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "1d"},
        {"name": "stale", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "1d"},
    ]
    with tempfile.TemporaryDirectory() as tmp, _scoped_env(
        SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl")
    ):
        ledger = str(Path(tmp) / "runs.jsonl")
        run_store.append_record(
            ledger,
            _ok_record(
                "fresh",
                (now - datetime.timedelta(hours=1)).isoformat(timespec="seconds"),
            ),
        )

        fake = _FakeScheduler()
        plans = sched.schedule_catch_ups(
            fake, jobs, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log", now=now,
        )

    assert [p["job"]["name"] for p in plans] == ["stale"], plans
    assert len(fake.added) == 1, fake.added
    added = fake.added[0]
    assert added["id"] == "catch-up:stale"
    # The one-shot fires CATCH_UP_INITIAL_DELAY seconds after start.
    run_date = added["trigger"].run_date
    assert run_date.replace(tzinfo=None) == now + datetime.timedelta(
        seconds=CATCH_UP_INITIAL_DELAY
    ), run_date
    assert callable(added["func"])


def test_schedule_catch_ups_missing_ledger_plans_every_catch_up_job():
    try:
        from apscheduler.triggers.date import DateTrigger  # noqa: F401
    except ImportError:
        print("NOTE: skipping schedule_catch_ups missing-ledger test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    now = datetime.datetime.now().replace(microsecond=0)
    jobs = [
        {"name": "a", "schedule": "0 7 * * *", "prompt": "p", "catch_up": "1d"},
        {"name": "b", "schedule": "0 6 * * *", "builtin": "digest", "catch_up": "1d"},
        {"name": "c", "schedule": "30m", "prompt": "p"},  # no catch_up
    ]
    with tempfile.TemporaryDirectory() as tmp, _scoped_env(
        SWARM_RUNS_JSONL=str(Path(tmp) / "absent.jsonl")  # missing -> []
    ):
        fake = _FakeScheduler()
        sched.schedule_catch_ups(
            fake, jobs, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log", now=now,
        )

    assert [a["id"] for a in fake.added] == ["catch-up:a", "catch-up:b"], fake.added
    # Staggered 45s apart after the initial 20s delay.
    first = fake.added[0]["trigger"].run_date.replace(tzinfo=None)
    second = fake.added[1]["trigger"].run_date.replace(tzinfo=None)
    assert first == now + datetime.timedelta(seconds=20), first
    assert second == now + datetime.timedelta(seconds=65), second


# --------------------------------------------------------------------------- #
# builtin digest runner (fires run_digest, writes the ledger, never POSTs)
# --------------------------------------------------------------------------- #


def _never_post(*_a, **_k):
    raise AssertionError("a builtin digest job must never POST to the agency")


def test_digest_runner_writes_ledger_and_never_posts():
    import scheduler.scheduler as sched

    digest_calls = []

    def fake_run_digest(vault_root, records, date, **kwargs):
        digest_calls.append({"vault_root": vault_root, "records": records, "date": date})
        return "/vault/Sessions/Overnight Run Digest.md"

    saved_send = sched.client.send
    saved_run_digest = sched.digest.run_digest
    sched.client.send = _never_post
    sched.digest.run_digest = fake_run_digest
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_VAULT_ROOT="/tmp/some-vault",
        ):
            ledger = str(Path(tmp) / "runs.jsonl")
            prior = _ok_record("earlier", "2026-07-01T05:00:00")
            run_store.append_record(ledger, prior)

            job = {"name": "overnight-digest", "schedule": "0 6 * * *",
                   "builtin": "digest", "catch_up": "1d"}
            log_path = Path(tmp) / "runs.log"
            runner = sched.make_job_runner(
                job, "http://h:8080", "open-swarm", None, log_path
            )
            runner()

            # run_digest was fired once with the ledger records + today's date,
            # and the SWARM_VAULT_ROOT override was passed through.
            assert len(digest_calls) == 1, digest_calls
            call = digest_calls[0]
            assert call["vault_root"] == "/tmp/some-vault"
            assert call["records"] == [prior]
            assert call["date"] == datetime.date.today().isoformat()

            # The human run log line landed...
            assert "\tovernight-digest\tok\t" in log_path.read_text()
            # ...and the ledger record too: tokens 0 / cost 0, no HTTP status.
            records = run_store.read_records(ledger)
            assert len(records) == 2, records
            rec = records[-1]
            assert rec["name"] == "overnight-digest"
            assert rec["status"] == "ok"
            assert rec["status_code"] == 0
            assert rec["tokens"] == 0
            assert rec["cost"] == 0
            assert rec["attempts"] == 1
            assert rec["error"] is None
            assert rec["response_excerpt"].endswith("Overnight Run Digest.md")
            assert isinstance(rec["latency_ms"], int) and rec["latency_ms"] >= 0
    finally:
        sched.client.send = saved_send
        sched.digest.run_digest = saved_run_digest


def test_digest_runner_defaults_vault_root_to_none():
    # With SWARM_VAULT_ROOT unset the runner passes None, deferring to
    # vault_core's own OBSIDIAN_VAULT/default resolution inside run_digest.
    import scheduler.scheduler as sched

    seen = []
    saved_run_digest = sched.digest.run_digest
    sched.digest.run_digest = lambda vault_root, records, date, **k: (
        seen.append(vault_root) or "/vault/note.md"
    )
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_VAULT_ROOT=None,
        ):
            job = {"name": "d", "schedule": "0 6 * * *", "builtin": "digest"}
            sched.make_digest_runner(job, Path(tmp) / "runs.log")()
        assert seen == [None], seen
    finally:
        sched.digest.run_digest = saved_run_digest


def test_digest_runner_failure_records_error_and_notifies():
    import scheduler.scheduler as sched

    def exploding_run_digest(*_a, **_k):
        raise RuntimeError("vault unwritable")

    saved_send = sched.client.send
    saved_run_digest = sched.digest.run_digest
    sched.client.send = _never_post  # even a failing digest never POSTs
    sched.digest.run_digest = exploding_run_digest
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
            SWARM_AIEOS_URL=None,
        ):
            job = {"name": "overnight-digest", "schedule": "0 6 * * *",
                   "builtin": "digest"}
            log_path = Path(tmp) / "runs.log"
            runner = sched.make_digest_runner(job, log_path)
            runner()  # must NOT raise

            records = run_store.read_records(str(Path(tmp) / "runs.jsonl"))
            assert len(records) == 1, records
            assert records[0]["status"] == "error"
            assert "vault unwritable" in (records[0]["error"] or ""), records[0]
            assert records[0]["tokens"] == 0

            # A failed builtin run alerts like any failed job (status != ok).
            notes = notify.read_notifications(str(Path(tmp) / "notifications.jsonl"))
            assert len(notes) == 1 and notes[0]["name"] == "overnight-digest", notes
    finally:
        sched.client.send = saved_send
        sched.digest.run_digest = saved_run_digest


def test_make_job_runner_dispatches_prompt_jobs_to_the_agency():
    # The dispatch must leave prompt jobs on the existing POST path: a prompt
    # job's runner calls client.send, a builtin's never does (proved above).
    import scheduler.scheduler as sched

    sends = []
    saved_send = sched.client.send
    sched.client.send = lambda *a, **k: (
        sends.append(a) or {"ok": True, "status_code": 200, "response": "hi"}
    )
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl")
        ):
            job = {"name": "p", "schedule": "30m", "prompt": "hello"}
            sched.make_job_runner(
                job, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
            )()
        assert len(sends) == 1, sends
    finally:
        sched.client.send = saved_send


def _run_all():
    funcs = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    passed = 0
    failed = 0
    for name, func in funcs:
        try:
            func()
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"ok   {name}")
    print(f"\n{passed} passed, {failed} failed, {len(funcs)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
