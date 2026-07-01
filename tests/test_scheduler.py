"""Assert-based tests for the OpenSwarm scheduler subsystem.

Run with the SYSTEM python (no heavy framework needed):

    python3 tests/test_scheduler.py

These tests import ONLY the pure modules (jobs_core, client) + stdlib, so they
pass without agency_swarm / apscheduler / pydantic installed. PyYAML is
optional: the load_jobs test degrades gracefully (jobs_core has a built-in
fallback parser, so it should still work) and prints a note if it cannot.
"""

import contextlib
import os
import sys

# Make the repo root importable so "scheduler.*" resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scheduler import client, notify, retry, run_store
from scheduler.jobs_core import (
    _parse_scalar,
    _tiny_yaml_load,
    build_trigger,
    format_run_line,
    is_interval,
    load_jobs,
    parse_interval,
    validate_job,
)

EXAMPLE = os.path.join(_ROOT, "scheduler", "jobs.example.yaml")


# --------------------------------------------------------------------------- #
# parse_interval
# --------------------------------------------------------------------------- #


def test_parse_interval_units():
    assert parse_interval("30s") == 30
    assert parse_interval("30m") == 1800
    assert parse_interval("2h") == 7200
    assert parse_interval("1d") == 86400
    assert parse_interval(" 45m ") == 2700  # whitespace tolerant
    assert parse_interval("15M") == 900  # case-insensitive


def test_parse_interval_rejects_bad():
    for bad in ["", "30", "m", "0m", "-5m", "30x", "1.5h", "abc", "5 m"]:
        try:
            parse_interval(bad)
        except ValueError:
            continue
        raise AssertionError(f"parse_interval should have rejected {bad!r}")


def test_is_interval():
    assert is_interval("30m") is True
    assert is_interval("2h") is True
    assert is_interval("0 9 * * *") is False
    assert is_interval("") is False


# --------------------------------------------------------------------------- #
# validate_job
# --------------------------------------------------------------------------- #


def test_validate_job_ok():
    job = validate_job(
        {"name": " j1 ", "schedule": "30m", "prompt": " do it ", "agent": "orchestrator"}
    )
    assert job["name"] == "j1"  # stripped
    assert job["prompt"] == "do it"
    assert job["agent"] == "orchestrator"
    # cron shape also valid
    validate_job({"name": "j2", "schedule": "0 9 * * *", "prompt": "hi"})


def test_validate_job_rejects_missing_fields():
    bad_cases = [
        {},  # nothing
        {"name": "x", "schedule": "30m"},  # no prompt
        {"name": "x", "prompt": "hi"},  # no schedule
        {"schedule": "30m", "prompt": "hi"},  # no name
        {"name": "", "schedule": "30m", "prompt": "hi"},  # empty name
        {"name": "x", "schedule": "not a cron", "prompt": "hi"},  # 3-field junk
        {"name": "x", "schedule": "30m", "prompt": "hi", "bogus": "y"},  # unknown key
        {"name": "x", "schedule": 30, "prompt": "hi"},  # non-string
    ]
    for case in bad_cases:
        try:
            validate_job(case)
        except (ValueError, TypeError):
            continue
        raise AssertionError(f"validate_job should have rejected {case!r}")


# --------------------------------------------------------------------------- #
# build_trigger
# --------------------------------------------------------------------------- #


def test_build_trigger_interval():
    spec = build_trigger({"schedule": "2h"})
    assert spec == {"type": "interval", "seconds": 7200}


def test_build_trigger_cron():
    spec = build_trigger({"schedule": "0 9 * * *"})
    assert spec["type"] == "cron"
    assert spec["fields"]["minute"] == "0"
    assert spec["fields"]["hour"] == "9"
    assert spec["fields"]["day_of_week"] == "*"
    # 6-field cron includes seconds
    spec6 = build_trigger({"schedule": "*/30 0 9 * * *"})
    assert spec6["fields"]["second"] == "*/30"


def test_build_trigger_rejects_bad_cron():
    try:
        build_trigger({"schedule": "1 2 3"})  # 3 fields, not interval
    except ValueError:
        return
    raise AssertionError("build_trigger should reject a 3-field schedule")


def test_build_trigger_rejects_invalid_cron_field_contents():
    # 5/6-field junk that used to pass validate_job on COUNT and then crash the
    # whole daemon inside CronTrigger. Each must now be rejected cleanly.
    bad = [
        "a b c d e",       # non-numeric minute (no names allowed there)
        "99 9 * * *",      # minute out of range
        "0 60 * * *",      # minute 60 out of range
        "0 24 * * *",      # hour 24 out of range
        "0 9 0 * *",       # day 0 (min is 1)
        "0 9 32 * *",      # day 32 out of range
        "0 9 * 13 *",      # month 13 out of range
        "0 9 * 0 *",       # month 0 (min is 1)
        "0 9 * * 8",       # weekday 8 out of range (max is 7)
        "0 9 * badmonth *",  # bad month name
        "0 9 * * badday",  # bad weekday name
        "*/0 9 * * *",     # zero increment
        "*/99 9 * * *",    # increment exceeds the minute range
    ]
    for schedule in bad:
        try:
            build_trigger({"schedule": schedule})
        except ValueError:
            pass
        else:
            raise AssertionError(f"build_trigger should reject {schedule!r}")
        # validate_job routes through build_trigger, so it must reject too.
        try:
            validate_job({"name": "x", "schedule": schedule, "prompt": "hi"})
        except ValueError:
            continue
        raise AssertionError(f"validate_job should reject {schedule!r}")


def test_build_trigger_accepts_valid_cron_fields():
    # Standard forms that must still build without complaint.
    for schedule in [
        "0 9 * * *",
        "*/15 * * * *",
        "0 0,12 * * *",
        "0 9 1-15 * *",
        "0 9 * jan-mar *",
        "0 9 * * mon-fri",
        "30 0 9 * * *",  # 6-field with seconds
    ]:
        spec = build_trigger({"schedule": schedule})
        assert spec["type"] == "cron", schedule


def test_build_trigger_weekday_unix_convention():
    # Unix cron: 0 or 7 = Sunday, 1 = Monday. APScheduler numbers mon=0..sun=6,
    # so the numeric weekday must be remapped to the right day name.
    assert build_trigger({"schedule": "0 9 * * 0"})["fields"]["day_of_week"] == "sun"
    assert build_trigger({"schedule": "0 9 * * 7"})["fields"]["day_of_week"] == "sun"
    assert build_trigger({"schedule": "0 9 * * 1"})["fields"]["day_of_week"] == "mon"
    assert build_trigger({"schedule": "0 9 * * 6"})["fields"]["day_of_week"] == "sat"
    # a Monday-to-Friday range maps to the matching names
    assert (
        build_trigger({"schedule": "0 9 * * 1-5"})["fields"]["day_of_week"]
        == "mon,tue,wed,thu,fri"
    )
    # "*" stays "*", and names pass through unchanged in meaning
    assert build_trigger({"schedule": "0 9 * * *"})["fields"]["day_of_week"] == "*"
    assert (
        build_trigger({"schedule": "0 9 * * mon-fri"})["fields"]["day_of_week"]
        == "mon,tue,wed,thu,fri"
    )
    # A valid Unix Sunday (7) is now accepted rather than crashing the daemon.
    validate_job({"name": "sun", "schedule": "0 9 * * 7", "prompt": "hi"})


# --------------------------------------------------------------------------- #
# load_jobs (example yaml)
# --------------------------------------------------------------------------- #


def test_load_jobs_example():
    try:
        jobs = load_jobs(EXAMPLE)
    except ImportError as exc:
        print(f"NOTE: skipping load_jobs test (yaml parse unavailable): {exc}")
        return
    assert len(jobs) == 2, jobs
    names = [j["name"] for j in jobs]
    assert names == ["morning-standup", "hourly-inbox-sweep"], names

    cron_job = jobs[0]
    assert cron_job["schedule"] == "0 9 * * *"
    assert cron_job["agent"] == "orchestrator"
    assert build_trigger(cron_job)["type"] == "cron"

    interval_job = jobs[1]
    assert interval_job["schedule"] == "30m"
    assert "agent" not in interval_job  # optional field omitted
    assert build_trigger(interval_job) == {"type": "interval", "seconds": 1800}


# --------------------------------------------------------------------------- #
# fallback YAML parser (the no-PyYAML path)
# --------------------------------------------------------------------------- #


def test_parse_scalar_handles_empty_and_quotes():
    # Empty value must not IndexError; it yields "" so validate_job can report a
    # clean "must not be empty" error downstream.
    assert _parse_scalar("") == ""
    assert _parse_scalar("   ") == ""
    assert _parse_scalar('"0 9 * * *"   # comment') == "0 9 * * *"
    assert _parse_scalar("bare value # comment") == "bare value"


def test_tiny_yaml_flat_list():
    text = "- name: a\n  schedule: 30m\n  prompt: hi\n"
    jobs = _tiny_yaml_load(text)
    assert jobs == [{"name": "a", "schedule": "30m", "prompt": "hi"}], jobs


def test_tiny_yaml_jobs_wrapper_matches_flat():
    # The "jobs:" mapping wrapper must parse the same as the flat list form, so a
    # file behaves identically with and without PyYAML.
    wrapped = _tiny_yaml_load(
        "jobs:\n  - name: a\n    schedule: 30m\n    prompt: hi\n"
    )
    assert wrapped == [{"name": "a", "schedule": "30m", "prompt": "hi"}], wrapped


def test_tiny_yaml_empty_value_is_clean_error():
    # 'prompt:' (empty) parses to "" (no IndexError) and validate_job rejects it
    # with a clean, message-bearing ValueError.
    jobs = _tiny_yaml_load("- name: a\n  schedule: 30m\n  prompt:\n")
    assert jobs == [{"name": "a", "schedule": "30m", "prompt": ""}], jobs
    try:
        validate_job(jobs[0])
    except ValueError as exc:
        assert "empty" in str(exc).lower(), exc
    else:
        raise AssertionError("validate_job should reject an empty prompt")


def test_load_jobs_without_pyyaml():
    # Force the ImportError branch so load_jobs exercises the fallback parser
    # even though PyYAML is installed in this interpreter.
    saved = sys.modules.get("yaml", "__ABSENT__")
    sys.modules["yaml"] = None  # makes `import yaml` raise ImportError
    try:
        import tempfile
        from pathlib import Path

        # 1) the flat-list example file parses via the fallback
        jobs = load_jobs(EXAMPLE)
        assert [j["name"] for j in jobs] == [
            "morning-standup",
            "hourly-inbox-sweep",
        ], jobs

        # 2) the "jobs:" wrapper form parses identically without PyYAML
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wrapped.yaml"
            path.write_text(
                "jobs:\n  - name: a\n    schedule: 30m\n    prompt: hi\n"
            )
            wrapped = load_jobs(str(path))
            assert [j["name"] for j in wrapped] == ["a"], wrapped
            assert wrapped[0]["schedule"] == "30m"
    finally:
        if saved == "__ABSENT__":
            sys.modules.pop("yaml", None)
        else:
            sys.modules["yaml"] = saved


# --------------------------------------------------------------------------- #
# client.build_request
# --------------------------------------------------------------------------- #


def test_build_request_basic():
    req = client.build_request("http://localhost:8080", "open-swarm", "hello")
    assert req["url"] == "http://localhost:8080/open-swarm/get_response"
    assert req["json"] == {"message": "hello"}


def test_build_request_with_agent_and_trailing_slash():
    req = client.build_request("http://host:8080/", "open swarm", "hi", "orchestrator")
    # spaces in agency name become underscores (matches the server normalization)
    assert req["url"] == "http://host:8080/open_swarm/get_response"
    assert req["json"] == {"message": "hi", "recipient_agent": "orchestrator"}


def test_build_request_validates_inputs():
    for args in [("", "a", "p"), ("u", "", "p"), ("u", "a", "")]:
        try:
            client.build_request(*args)
        except ValueError:
            continue
        raise AssertionError(f"build_request should reject {args!r}")


# --------------------------------------------------------------------------- #
# client.send (injected fake client, no network)
# --------------------------------------------------------------------------- #


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    """Records the last POST and returns a canned response."""

    def __init__(self, response):
        self._response = response
        self.calls = []

    def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return self._response


def test_send_uses_injected_client_success():
    fake = _FakeClient(
        _FakeResponse(200, {"response": "done", "usage": {"total_tokens": 42}})
    )
    result = client.send(
        "http://localhost:8080",
        "open-swarm",
        "run the report",
        agent="orchestrator",
        app_token="secret",
        client=fake,
    )
    assert result["ok"] is True
    assert result["status_code"] == 200
    assert result["response"] == "done"
    assert result["total_tokens"] == 42
    assert result["url"] == "http://localhost:8080/open-swarm/get_response"

    # verify the request the fake actually received
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["url"] == "http://localhost:8080/open-swarm/get_response"
    assert call["json"] == {"message": "run the report", "recipient_agent": "orchestrator"}
    assert call["headers"] == {"Authorization": "Bearer secret"}


def test_send_no_token_omits_auth_header():
    fake = _FakeClient(_FakeResponse(200, {"response": "ok"}))
    client.send("http://h:8080", "open-swarm", "hi", client=fake)
    assert fake.calls[0]["headers"] == {}
    assert "recipient_agent" not in fake.calls[0]["json"]


def test_send_reports_http_error():
    fake = _FakeClient(_FakeResponse(500, {"error": "boom"}))
    result = client.send("http://h:8080", "open-swarm", "hi", client=fake)
    assert result["ok"] is False
    assert result["status_code"] == 500
    assert result["error"] == "boom"


# --------------------------------------------------------------------------- #
# client.summarize_response — cost retention
# --------------------------------------------------------------------------- #


def test_summarize_response_keeps_cost_when_present():
    # Cost is kept under whichever key the provider used, alongside tokens.
    for key in ("cost", "cost_usd", "total_cost"):
        payload = {"response": "hi", "usage": {"total_tokens": 10, key: 0.0042}}
        summary = client.summarize_response(200, payload)
        assert summary["total_tokens"] == 10
        assert summary["cost"] == 0.0042, key
    # No cost key -> no cost field (tokens still kept).
    plain = client.summarize_response(200, {"usage": {"total_tokens": 7}})
    assert plain["total_tokens"] == 7
    assert "cost" not in plain
    # First matching key wins when several are present.
    multi = client.summarize_response(
        200, {"usage": {"total_tokens": 1, "cost": 0.1, "total_cost": 0.9}}
    )
    assert multi["cost"] == 0.1


# --------------------------------------------------------------------------- #
# format_run_line
# --------------------------------------------------------------------------- #


def test_format_run_line():
    line = format_run_line("job1", "ok", "all good", when="2026-07-01T09:00:00")
    assert line == "2026-07-01T09:00:00\tjob1\tok\tall good"
    # newlines in detail are collapsed so one run == one line
    multiline = format_run_line("j", "ok", "a\nb\n c", when="T")
    assert "\n" not in multiline
    assert multiline == "T\tj\tok\ta b c"


# --------------------------------------------------------------------------- #
# runner (unit test the closure without APScheduler / network)
# --------------------------------------------------------------------------- #


def test_make_runner_logs_success(tmp_path=None):
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    fake = _FakeClient(
        _FakeResponse(
            200,
            {"response": "hi", "usage": {"total_tokens": 12, "cost": 0.003}},
        )
    )
    original_send = client.send
    saved_env = os.environ.get("SWARM_RUNS_JSONL")
    # patch client.send used inside scheduler.client to use our fake
    sched.client.send = lambda *a, **k: original_send(*a, client=fake, **k)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "runs.log"
            ledger_path = Path(tmp) / "runs.jsonl"
            # Point the structured ledger at the temp dir so the runner does not
            # write to the real ~/.openswarm during tests.
            os.environ["SWARM_RUNS_JSONL"] = str(ledger_path)
            job = {"name": "t", "schedule": "30m", "prompt": "hi"}
            runner = sched.make_runner(job, "http://h:8080", "open-swarm", None, log_path)
            runner()

            # 1) the human-readable run log line is still written
            text = log_path.read_text()
            assert "\tt\tok\thi" in text, text

            # 2) the structured ledger got a matching record
            records = run_store.read_records(str(ledger_path))
            assert len(records) == 1, records
            rec = records[0]
            assert rec["name"] == "t"
            assert rec["status"] == "ok"
            assert rec["status_code"] == 200
            assert rec["tokens"] == 12
            assert rec["cost"] == 0.003
            assert rec["attempts"] == 1
            assert rec["error"] is None
            assert rec["response_excerpt"] == "hi"
            assert isinstance(rec["latency_ms"], int) and rec["latency_ms"] >= 0
    finally:
        sched.client.send = original_send
        if saved_env is None:
            os.environ.pop("SWARM_RUNS_JSONL", None)
        else:
            os.environ["SWARM_RUNS_JSONL"] = saved_env


def test_make_runner_retries_then_records_attempts(tmp_path=None):
    # A connection error on the first two fires, success on the third: the run
    # should be logged ok with attempts=3. make_runner does not thread a sleep
    # into send_with_retry, so we replace time.sleep with a recording no-op spy;
    # because send_with_retry resolves its sleep lazily this patch actually
    # reaches it (a def-time default would silently ignore it and the test would
    # really wait ~3.6s). We then assert the spy was used, so the test is fast
    # AND proves the retries were exercised without real waiting.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    calls = {"n": 0}

    def flaky_send(*a, **k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("connection reset")
        return {"ok": True, "status_code": 200, "response": "done", "total_tokens": 5}

    slept = []
    original_send = client.send
    saved_env = os.environ.get("SWARM_RUNS_JSONL")
    saved_sleep = retry.time.sleep
    sched.client.send = flaky_send
    retry.time.sleep = lambda seconds: slept.append(seconds)  # record, never wait
    try:
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "runs.log"
            ledger_path = Path(tmp) / "runs.jsonl"
            os.environ["SWARM_RUNS_JSONL"] = str(ledger_path)
            job = {"name": "flaky", "schedule": "30m", "prompt": "hi"}
            runner = sched.make_runner(job, "http://h:8080", "open-swarm", None, log_path)
            runner()

            assert calls["n"] == 3, calls
            # The patched sleep really reached send_with_retry: one backoff per
            # retry (2 for 3 attempts). If this is empty, the injectable-sleep
            # rule regressed and the suite would be waiting for real seconds.
            assert len(slept) == 2, slept
            assert all(s >= 0 for s in slept)
            records = run_store.read_records(str(ledger_path))
            assert len(records) == 1, records
            assert records[0]["status"] == "ok"
            assert records[0]["attempts"] == 3
            assert records[0]["error"] is None
    finally:
        sched.client.send = original_send
        retry.time.sleep = saved_sleep
        if saved_env is None:
            os.environ.pop("SWARM_RUNS_JSONL", None)
        else:
            os.environ["SWARM_RUNS_JSONL"] = saved_env


# --------------------------------------------------------------------------- #
# notify wiring — the thin _maybe_notify / make_runner glue (the untested layer)
# --------------------------------------------------------------------------- #
#
# scheduler.notify's pure functions (should_notify / notify / ...) are covered by
# tests/test_notify.py. What was NOT covered is the wiring in scheduler.py that
# turns them into a real guarantee:
#   * _maybe_notify's try/except is the SOLE thing that stops a notification
#     failure from crashing the job runner ("notify never crashes the runner").
#   * _maybe_notify does read -> gate -> write (read recent history, apply
#     should_notify, only then write) so a suppressed failure never drifts the
#     dedup anchor and defeats the storm-suppression window.
#   * make_runner only notifies when status != "ok".
# These tests exercise exactly that glue, so a refactor that dropped the swallow,
# flipped the gate, or wrote-before-gating would now fail CI.


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


def _failure_record(name="j", error="connection refused", ts=1000.0, status="error"):
    """A minimal ledger-record-shaped dict for a failed run."""
    return {
        "name": name,
        "ts": ts,
        "status": status,
        "status_code": 0,
        "tokens": None,
        "cost": None,
        "latency_ms": 5,
        "attempts": 3,
        "error": error,
        "response_excerpt": None,
    }


def test_maybe_notify_swallows_internal_error():
    # The bare try/except in _maybe_notify is the only guarantee that a broken
    # notification path cannot crash the job runner. Force the read step to raise
    # and prove _maybe_notify swallows it (returns None, does not propagate). If
    # the swallow is ever removed, this raises and the test fails.
    import scheduler.scheduler as sched

    def _explode(*a, **k):
        raise RuntimeError("sink unreadable")

    saved = sched.notify.read_notifications
    sched.notify.read_notifications = _explode
    try:
        assert sched._maybe_notify(_failure_record()) is None
    finally:
        sched.notify.read_notifications = saved


def test_maybe_notify_read_gate_write_suppresses_storm():
    # _maybe_notify wires read -> gate -> write against the real JSONL sink: it
    # reads recent history, applies should_notify, and only writes on a fresh
    # failure. A suppressed failure must NOT be written, so it cannot drift the
    # dedup anchor forward and defeat the storm-suppression window.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp, _scoped_env(
        SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
        SWARM_NOTIFY_MIN_INTERVAL="3600",
        SWARM_AIEOS_URL=None,  # no network POST from the fallback
    ):
        sink = str(Path(tmp) / "notifications.jsonl")

        # 1) First failure: empty history -> gate allows -> one line written.
        sched._maybe_notify(_failure_record(ts=1000.0))
        assert len(notify.read_notifications(sink)) == 1

        # 2) Same failure 300s later, inside the 3600s window -> suppressed.
        sched._maybe_notify(_failure_record(ts=1300.0))
        assert len(notify.read_notifications(sink)) == 1

        # 3) Anchor-drift guard: 3700s after the *written* anchor (1000), but only
        # 3400s after the *suppressed* 1300. It is allowed, proving the suppressed
        # failure never became the anchor (read->gate->write, not write-always).
        sched._maybe_notify(_failure_record(ts=4700.0))
        assert len(notify.read_notifications(sink)) == 2

        # 4) A distinct job with identical timing shares no key -> never deduped.
        sched._maybe_notify(_failure_record(name="k", ts=4700.0))
        assert len(notify.read_notifications(sink)) == 3


def test_make_runner_notifies_only_on_failure():
    # make_runner gates the notification on status != "ok": a success fires no
    # notification, a failure fires exactly one carrying the ledger record.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    original_send = client.send
    saved_notify = sched._maybe_notify
    calls = []
    sched._maybe_notify = lambda record: calls.append(record)
    try:
        # --- success (status "ok") -> no notification ---
        ok_fake = _FakeClient(
            _FakeResponse(200, {"response": "hi", "usage": {"total_tokens": 3}})
        )
        sched.client.send = lambda *a, **k: original_send(*a, client=ok_fake, **k)
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl")
        ):
            job = {"name": "good", "schedule": "30m", "prompt": "hi"}
            sched.make_runner(
                job, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
            )()
        assert calls == [], calls  # a healthy run never notifies

        # --- failure (http-500) -> exactly one notification with the record ---
        err_fake = _FakeClient(_FakeResponse(500, {"error": "boom"}))
        sched.client.send = lambda *a, **k: original_send(*a, client=err_fake, **k)
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl")
        ):
            job = {"name": "bad", "schedule": "30m", "prompt": "hi"}
            sched.make_runner(
                job, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
            )()
        assert len(calls) == 1, calls
        assert calls[0]["name"] == "bad"
        assert calls[0]["status"] == "http-500"
    finally:
        sched.client.send = original_send
        sched._maybe_notify = saved_notify


def test_make_runner_notify_crash_does_not_break_run():
    # The runner-level guarantee: even when the notification subsystem blows up on
    # a failed job, runner() must not raise, and the run log + ledger (written
    # before the notify step) must still be intact. This proves _maybe_notify's
    # swallow contains the failure inside the live make_runner path.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    fake = _FakeClient(_FakeResponse(500, {"error": "kaboom"}))  # failure -> notify
    original_send = client.send
    saved_should = sched.notify.should_notify

    def _explode(*a, **k):
        raise RuntimeError("notify subsystem down")

    sched.client.send = lambda *a, **k: original_send(*a, client=fake, **k)
    sched.notify.should_notify = _explode
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
            SWARM_AIEOS_URL=None,
        ):
            log_path = Path(tmp) / "runs.log"
            job = {"name": "boom", "schedule": "30m", "prompt": "hi"}
            runner = sched.make_runner(
                job, "http://h:8080", "open-swarm", None, log_path
            )
            runner()  # must NOT raise despite the exploding notify path

            assert "\tboom\thttp-500\t" in log_path.read_text()
            records = run_store.read_records(str(Path(tmp) / "runs.jsonl"))
            assert len(records) == 1 and records[0]["status"] == "http-500", records
    finally:
        sched.client.send = original_send
        sched.notify.should_notify = saved_should


def test_make_runner_failure_writes_notification_end_to_end():
    # End-to-end wiring with no spies between the layers: a failing job drives
    # make_runner -> _maybe_notify -> notify.notify -> the JSONL sink. Exactly one
    # durable notification is written, and no AIEOS POST fires (URL unset).
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    fake = _FakeClient(_FakeResponse(500, {"error": "downstream 503 at 12:00:01"}))
    original_send = client.send
    sched.client.send = lambda *a, **k: original_send(*a, client=fake, **k)
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
            SWARM_AIEOS_URL=None,
        ):
            sink = str(Path(tmp) / "notifications.jsonl")
            job = {"name": "nightly", "schedule": "30m", "prompt": "hi"}
            sched.make_runner(
                job, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
            )()

            notes = notify.read_notifications(sink)
            assert len(notes) == 1, notes
            assert notes[0]["name"] == "nightly"
            assert notes[0]["status"] == "http-500"
            assert notes[0]["key"].startswith("nightly::"), notes[0]
    finally:
        sched.client.send = original_send


# --------------------------------------------------------------------------- #
# run_store — build_record / append+read round-trip / rotation
# --------------------------------------------------------------------------- #


def test_build_record_shape():
    rec = run_store.build_record(
        name="job1",
        ts="2026-07-01T09:00:00",
        status="ok",
        status_code=200,
        tokens=42,
        cost=0.01,
        latency_ms=1234,
        attempts=2,
        error=None,
        response_excerpt="hello world",
    )
    assert set(rec) == set(run_store.RECORD_FIELDS)
    assert rec["name"] == "job1"
    assert rec["ts"] == "2026-07-01T09:00:00"
    assert rec["status"] == "ok"
    assert rec["status_code"] == 200
    assert rec["tokens"] == 42
    assert rec["cost"] == 0.01
    assert rec["latency_ms"] == 1234
    assert rec["attempts"] == 2
    assert rec["error"] is None
    assert rec["response_excerpt"] == "hello world"


def test_build_record_truncates_excerpt():
    long_text = "x" * 5000
    rec = run_store.build_record(
        "j", "T", "ok", 200, None, None, 0, 1, None, long_text
    )
    assert len(rec["response_excerpt"]) == run_store.EXCERPT_MAX_CHARS
    # None excerpt stays None (not the string "None")
    rec_none = run_store.build_record("j", "T", "ok", 200, None, None, 0, 1, None, None)
    assert rec_none["response_excerpt"] is None


def test_append_and_read_records_round_trip():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        # Nested subdir must be created by append_record.
        path = str(Path(tmp) / "nested" / "runs.jsonl")
        assert run_store.read_records(path) == []  # missing file -> []

        recs = [
            run_store.build_record(f"j{i}", "T", "ok", 200, i, None, 1, 1, None, "r")
            for i in range(3)
        ]
        for rec in recs:
            run_store.append_record(path, rec)

        back = run_store.read_records(path)
        assert back == recs, back
        # limit keeps the most recent N; limit<=0 -> []
        assert run_store.read_records(path, limit=2) == recs[-2:]
        assert run_store.read_records(path, limit=0) == []


def test_rotate_if_needed_tiny_max_bytes():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "runs.jsonl")
        rec = run_store.build_record("j", "T", "ok", 200, 1, None, 1, 1, None, "r")
        run_store.append_record(path, rec)

        # Below threshold: no rotation.
        assert run_store.rotate_if_needed(path, max_bytes=10_000) is False
        assert Path(path).exists()
        assert not Path(path + ".1").exists()

        # Tiny threshold: the existing file trips it and is moved aside.
        assert run_store.rotate_if_needed(path, max_bytes=1) is True
        assert not Path(path).exists()
        assert Path(path + ".1").exists()

        # A fresh append recreates the live file; the next read sees only it.
        run_store.append_record(path, rec)
        assert run_store.read_records(path) == [rec]

        # Missing file rotates to nothing.
        missing = str(Path(tmp) / "absent.jsonl")
        assert run_store.rotate_if_needed(missing, max_bytes=1) is False


# --------------------------------------------------------------------------- #
# retry — should_retry matrix / send_with_retry backoff
# --------------------------------------------------------------------------- #


def test_should_retry_matrix():
    # Pre-response failures retry; anything that reached the server does not.
    assert retry.should_retry(0, None) is True
    assert retry.should_retry(429, None) is True
    for status in (400, 403, 404, 500, 502, 503):
        assert retry.should_retry(status, None) is False, status
    # 200 is a success, not retried.
    assert retry.should_retry(200, None) is False
    # A connect-phase failure never reached the server, so it is safe to retry.
    assert retry.should_retry(0, ConnectionError("reset")) is True
    # A timeout may mean the request was already sent (and its side effect fired),
    # so it is NOT retried regardless of the status arg. This is the double-fire
    # guard: a long upload that trips a read timeout must not be replayed.
    assert retry.should_retry(0, TimeoutError("slow")) is False
    assert retry.should_retry(500, TimeoutError("slow")) is False


def test_should_retry_distinguishes_httpx_timeout_phases():
    # Exercised with the real httpx exception hierarchy when it is importable
    # (the daemon uses httpx). Connect-phase failures replay; read/write-phase
    # failures do not, because the request already reached the server.
    try:
        import httpx
    except ImportError:
        print("NOTE: skipping httpx phase test (httpx unavailable)")
        return

    req = httpx.Request("POST", "http://h:8080/x")
    # Connect-phase: the connection was never established -> safe to retry.
    assert retry.should_retry(0, httpx.ConnectError("no route", request=req)) is True
    assert retry.should_retry(0, httpx.ConnectTimeout("slow connect", request=req)) is True
    assert retry.should_retry(0, httpx.PoolTimeout("no free conn", request=req)) is True
    # Read/write-phase: the request reached the server -> must NOT be retried
    # (this is the exact ReadTimeout that would otherwise double an upload).
    assert retry.should_retry(0, httpx.ReadTimeout("slow read", request=req)) is False
    assert retry.should_retry(0, httpx.WriteTimeout("slow write", request=req)) is False
    assert retry.should_retry(0, httpx.RemoteProtocolError("server spoke", request=req)) is False


def test_send_with_retry_does_not_retry_read_timeout():
    # A ReadTimeout means the request reached the server: send_with_retry must
    # call exactly once and never sleep, then report a synthesized error dict.
    try:
        import httpx
    except ImportError:
        print("NOTE: skipping read-timeout retry test (httpx unavailable)")
        return

    req = httpx.Request("POST", "http://h:8080/x")
    calls = {"n": 0}
    sleeps = []

    def upload_that_read_times_out():
        calls["n"] += 1
        raise httpx.ReadTimeout("upload exceeded client timeout", request=req)

    result, attempts = retry.send_with_retry(
        upload_that_read_times_out,
        max_retries=3,
        base_delay=1.0,
        sleep=sleeps.append,
        rand=lambda: 0.0,
    )
    assert calls["n"] == 1, calls  # fired once, NOT re-fired
    assert attempts == 1
    assert sleeps == []
    assert result["ok"] is False
    assert result["status_code"] == 0
    assert "timeout" in result["error"].lower()


def test_send_with_retry_fails_twice_then_succeeds():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("boom")
        return {"ok": True, "status_code": 200, "response": "done"}

    sleeps = []
    result, attempts = retry.send_with_retry(
        flaky,
        max_retries=2,
        base_delay=0.5,
        sleep=sleeps.append,
        rand=lambda: 0.0,  # kill the jitter for a deterministic delay
    )
    assert calls["n"] == 3  # 1 initial + 2 retries
    assert attempts == 3
    assert result["ok"] is True
    assert result["response"] == "done"
    # Deterministic exponential backoff: 0.5 * 2**0, then 0.5 * 2**1.
    assert sleeps == [0.5, 1.0], sleeps


def test_send_with_retry_caps_at_max_retries():
    # Always failing with a retryable (connect-phase) error: capped at
    # 1 + max_retries calls, returns a synthesized error dict (never raises)
    # with the total attempt count.
    calls = {"n": 0}

    def always_fail():
        calls["n"] += 1
        raise ConnectionError("nope")

    result, attempts = retry.send_with_retry(
        always_fail, max_retries=2, base_delay=1.0, sleep=lambda *_a: None, rand=lambda: 0.0
    )
    assert calls["n"] == 3
    assert attempts == 3
    assert result["ok"] is False
    assert result["status_code"] == 0
    assert "nope" in result["error"]


def test_send_with_retry_does_not_retry_5xx():
    # A 5xx reached the server (a side effect may have fired): return at once,
    # exactly one call, no sleeps.
    calls = {"n": 0}
    sleeps = []

    def server_error():
        calls["n"] += 1
        return {"ok": False, "status_code": 500, "error": "boom"}

    result, attempts = retry.send_with_retry(
        server_error, max_retries=3, base_delay=1.0, sleep=sleeps.append, rand=lambda: 0.0
    )
    assert calls["n"] == 1
    assert attempts == 1
    assert sleeps == []
    assert result["status_code"] == 500


def test_send_with_retry_retries_429_result():
    # A 429 comes back as a result dict (not an exception) and is retried.
    calls = {"n": 0}

    def rate_limited():
        calls["n"] += 1
        if calls["n"] < 2:
            return {"ok": False, "status_code": 429}
        return {"ok": True, "status_code": 200, "response": "ok"}

    result, attempts = retry.send_with_retry(
        rate_limited, max_retries=3, base_delay=1.0, sleep=lambda *_a: None, rand=lambda: 0.0
    )
    assert calls["n"] == 2
    assert attempts == 2
    assert result["ok"] is True


# --------------------------------------------------------------------------- #
# regression tests — the six confirmed scheduler bugs
# --------------------------------------------------------------------------- #


def test_read_records_skips_malformed_line():
    # Bug #1: a single torn/interleaved JSONL line must not abort the whole read.
    # read_records should skip it (mirroring notify.read_notifications) so the
    # overnight digest and any ledger inspection still see every intact record,
    # instead of json.loads raising on the first bad line and killing the job.
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "runs.jsonl"
        good1 = run_store.build_record("a", "T", "ok", 200, 1, None, 1, 1, None, "r")
        good2 = run_store.build_record("b", "T", "ok", 200, 2, None, 1, 1, None, "r")
        run_store.append_record(str(path), good1)
        # A torn line, exactly as a crash mid-append / interleaved writers produce.
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"name":"torn","stat\n')
        run_store.append_record(str(path), good2)

        back = run_store.read_records(str(path))
        assert back == [good1, good2], back  # bad line skipped, intact ones kept


def test_concurrent_rotate_append_loses_no_records():
    # Bug #2: distinct scheduler threads firing on the same cron minute each run
    # rotate_if_needed -> append_record against the one global ledger. Unlocked,
    # the second rotation raced os.replace and raised FileNotFoundError, silently
    # dropping that fire's record. Under _LEDGER_LOCK exactly one thread rotates
    # the full file, the rest append to the fresh file, and nothing raises or is
    # lost. Pre-fix this test fails (FileNotFoundError in the losing threads).
    import tempfile
    import threading
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "runs.jsonl")
        # Seed a comfortably over-threshold file so every thread sees a rotation
        # is due; after the single rotation the fresh file stays well under it.
        for i in range(200):
            seed = run_store.build_record(f"seed{i}", "T", "ok", 200, i, None, 1, 1, None, "x")
            run_store.append_record(path, seed)
        max_bytes = 8192

        n = 8
        barrier = threading.Barrier(n)
        errors = []

        def fire(i):
            rec = run_store.build_record(f"j{i}", "T", "ok", 200, i, None, 1, 1, None, "r")
            try:
                barrier.wait()  # release all threads into the rotation window at once
                run_store.rotate_if_needed(path, max_bytes)
                run_store.append_record(path, rec)
            except Exception as exc:  # a raced rotation would surface here
                errors.append(exc)

        threads = [threading.Thread(target=fire, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], errors  # no FileNotFoundError from a raced rotation
        live = run_store.read_records(path)
        rotated = run_store.read_records(path + ".1")
        combined = live + rotated
        # Every seed record survived (rotated aside) and every fire's record is
        # present: total is preserved, nothing was silently dropped or clobbered.
        assert len(combined) == 200 + n, (len(live), len(rotated))
        names = {r["name"] for r in combined}
        for i in range(n):
            assert f"j{i}" in names, (i, sorted(n for n in names if n.startswith("j")))


def test_build_record_truncates_error():
    # Bug #6: the redaction/bloat cap that guards response_excerpt must also guard
    # the error field, so an adversarial server error body or a very long
    # exception string cannot write an unbounded ledger line.
    long_error = "E" * 20000
    rec = run_store.build_record("j", "T", "error", 0, None, None, 5, 3, long_error, None)
    assert len(rec["error"]) == run_store.ERROR_MAX_CHARS
    # A short error passes through unchanged; None stays None (not the str "None").
    rec_short = run_store.build_record("j", "T", "error", 0, None, None, 5, 3, "boom", None)
    assert rec_short["error"] == "boom"
    rec_none = run_store.build_record("j", "T", "ok", 200, None, None, 5, 1, None, "r")
    assert rec_none["error"] is None


def test_should_retry_excludes_write_phase_builtin_socket_errors():
    # Bug #4: BrokenPipeError (peer closed mid-write) and ConnectionResetError
    # (mid-stream reset) are ConnectionError subclasses, but the request may have
    # already reached the server — the same ambiguous write phase as WriteTimeout,
    # which is deliberately not retried. They must NOT be retried, or a scheduled
    # side effect (e.g. a Publisher upload) could be doubled.
    assert retry.should_retry(0, BrokenPipeError("peer closed while writing")) is False
    assert retry.should_retry(0, ConnectionResetError("connection reset")) is False
    # Genuine connect-phase failures never delivered the request -> still retryable.
    assert retry.should_retry(0, ConnectionRefusedError("connection refused")) is True
    assert retry.should_retry(0, ConnectionError("bare connect failure")) is True


def test_make_runner_transport_failure_is_error_not_http0():
    # Bug #3: when send_with_retry exhausts a connect-phase failure it returns the
    # synthesized {"ok": False, "status_code": 0, "error": ...} dict (it never
    # raises). make_runner must label that run "error" and preserve the text, not
    # the nonsensical "http-0" it produced before the fix.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    def refused_send(*a, **k):
        raise ConnectionError("connection refused - server down")

    original_send = client.send
    saved_sleep = retry.time.sleep
    sched.client.send = refused_send
    retry.time.sleep = lambda *_a: None  # never actually wait during retries
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
            SWARM_AIEOS_URL=None,
            SWARM_MAX_RETRIES="0",
        ):
            log_path = Path(tmp) / "runs.log"
            job = {"name": "down", "schedule": "30m", "prompt": "hi"}
            sched.make_runner(job, "http://h:8080", "open-swarm", None, log_path)()

            text = log_path.read_text()
            assert "\tdown\terror\t" in text, text
            assert "http-0" not in text, text

            records = run_store.read_records(str(Path(tmp) / "runs.jsonl"))
            assert len(records) == 1, records
            assert records[0]["status"] == "error"
            assert records[0]["status_code"] == 0
            assert "connection refused" in (records[0]["error"] or ""), records[0]

            # A transport failure still fires the failure alert (status != "ok").
            notes = notify.read_notifications(str(Path(tmp) / "notifications.jsonl"))
            assert len(notes) == 1 and notes[0]["status"] == "error", notes
    finally:
        sched.client.send = original_send
        retry.time.sleep = saved_sleep


def test_make_runner_runlog_write_failure_does_not_suppress_ledger_and_alert():
    # Bug #5: append_run_log runs before the deliberately-guarded ledger append
    # and the failure notification. A transient FS fault on the run-log path must
    # not propagate out of run() and suppress those durable sinks, so make_runner
    # wraps the run-log write. The ledger record and the alert must still land.
    import tempfile
    from pathlib import Path

    import scheduler.scheduler as sched

    fake = _FakeClient(_FakeResponse(500, {"error": "boom"}))  # a failed run
    original_send = client.send
    saved_append = sched.append_run_log

    def _explode_runlog(*a, **k):
        raise PermissionError("runs.log is read-only")

    sched.client.send = lambda *a, **k: original_send(*a, client=fake, **k)
    sched.append_run_log = _explode_runlog
    try:
        with tempfile.TemporaryDirectory() as tmp, _scoped_env(
            SWARM_RUNS_JSONL=str(Path(tmp) / "runs.jsonl"),
            SWARM_NOTIFICATIONS=str(Path(tmp) / "notifications.jsonl"),
            SWARM_AIEOS_URL=None,
        ):
            job = {"name": "loud", "schedule": "30m", "prompt": "hi"}
            runner = sched.make_runner(
                job, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
            )
            runner()  # must NOT raise despite the run-log write blowing up

            # The durable ledger record still landed...
            records = run_store.read_records(str(Path(tmp) / "runs.jsonl"))
            assert len(records) == 1 and records[0]["status"] == "http-500", records
            # ...and so did the failure alert.
            notes = notify.read_notifications(str(Path(tmp) / "notifications.jsonl"))
            assert len(notes) == 1 and notes[0]["name"] == "loud", notes
    finally:
        sched.client.send = original_send
        sched.append_run_log = saved_append


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
