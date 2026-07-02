"""Assert-based tests for the scheduler's jobs-file hot reload.

Run with the SYSTEM python (no heavy framework needed):

    python3 tests/test_scheduler_reload.py

The rediff logic is a pure function (scheduler.diff_jobs) and is tested
directly, never through the running daemon loop, per the contract. The
apply/watcher tests drive apply_jobs_diff and the make_reload_checker closure
against a fake scheduler; only the tests that construct real triggers need
APScheduler, and each of those degrades to a printed note when it is
unavailable (matching test_scheduler.py / test_scheduler_catchup.py).
"""

import contextlib
import os
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so "scheduler.*" resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scheduler.scheduler import (
    DEFAULT_JOBS_RELOAD_SECS,
    RELOAD_JOB_ID,
    diff_jobs,
    make_reload_checker,
    resolve_jobs_reload_secs,
)


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


def _job(name, schedule="30m", prompt="hi", **extra):
    job = {"name": name, "schedule": schedule, "prompt": prompt}
    job.update(extra)
    return job


def _has_apscheduler() -> bool:
    try:
        from apscheduler.triggers.interval import IntervalTrigger  # noqa: F401
    except ImportError:
        return False
    return True


class _FakeScheduler:
    """Records add_job/remove_job calls the way the catchup tests' fake does."""

    def __init__(self):
        self.added = []
        self.removed = []

    def add_job(self, func, trigger=None, id=None, name=None, replace_existing=None):
        self.added.append(
            {
                "func": func,
                "trigger": trigger,
                "id": id,
                "name": name,
                "replace_existing": replace_existing,
            }
        )

    def remove_job(self, job_id):
        self.removed.append(job_id)


def _write_jobs_yaml(path, jobs) -> None:
    """Write a flat jobs YAML (the shape both loaders parse) and bump the mtime.

    The explicit os.utime step makes every rewrite observable: two writes
    inside the same clock tick could otherwise share an mtime and the watcher
    (correctly) would not fire.
    """
    lines = []
    for job in jobs:
        lines.append(f"- name: {job['name']}")
        for key in ("schedule", "prompt", "builtin", "agent", "catch_up"):
            if key in job:
                lines.append(f'  {key}: "{job[key]}"')
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    _bump_mtime(path)


_MTIME_STEP = {"n": 0}


def _bump_mtime(path) -> None:
    """Push the file's mtime strictly past every mtime this test run has seen.

    The growing step keeps successive rewrites monotonic even if two writes
    were to land on the same filesystem timestamp.
    """
    _MTIME_STEP["n"] += 10
    stat = os.stat(path)
    os.utime(path, (stat.st_atime, stat.st_mtime + _MTIME_STEP["n"]))


# --------------------------------------------------------------------------- #
# diff_jobs (the pure rediff — tested directly, never via the daemon loop)
# --------------------------------------------------------------------------- #


def test_diff_jobs_add_remove_change():
    old = [
        _job("keep"),
        _job("gone"),
        _job("retimed", schedule="30m"),
        _job("reworded", prompt="old words"),
    ]
    new = [
        _job("keep"),
        _job("retimed", schedule="45m"),      # schedule change -> replace
        _job("reworded", prompt="new words"),  # prompt change -> replace
        _job("fresh"),
    ]
    diff = diff_jobs(old, new)
    assert [j["name"] for j in diff["added"]] == ["fresh"], diff
    assert diff["removed"] == ["gone"], diff
    assert [j["name"] for j in diff["changed"]] == ["retimed", "reworded"], diff
    # The changed/added entries are the NEW dicts (what gets registered).
    assert diff["changed"][0]["schedule"] == "45m"
    assert diff["changed"][1]["prompt"] == "new words"
    # An untouched job appears nowhere.
    for bucket in ("added", "changed"):
        assert all(j["name"] != "keep" for j in diff[bucket]), diff


def test_diff_jobs_any_field_change_counts():
    # Schedule and prompt are the contract cases; agent/endpoint/builtin/
    # catch_up also feed the trigger or the runner closure, so any normalized
    # field change must land in "changed".
    base = _job("j", schedule="30m", prompt="p")
    variants = [
        _job("j", schedule="45m", prompt="p"),
        _job("j", schedule="30m", prompt="q"),
        _job("j", schedule="30m", prompt="p", agent="orchestrator"),
        _job("j", schedule="30m", prompt="p", endpoint="http://other:8080"),
        _job("j", schedule="30m", prompt="p", catch_up="1d"),
        {"name": "j", "schedule": "0 6 * * *", "builtin": "digest"},
    ]
    for variant in variants:
        diff = diff_jobs([base], [variant])
        assert [j["name"] for j in diff["changed"]] == ["j"], (variant, diff)
        assert diff["added"] == [] and diff["removed"] == [], (variant, diff)
    # An identical dict is NOT a change.
    same = diff_jobs([base], [dict(base)])
    assert same == {"added": [], "removed": [], "changed": []}, same


def test_diff_jobs_empty_and_none_cases():
    jobs = [_job("a"), _job("b")]
    # Everything added from an empty start; everything removed to an empty end.
    grown = diff_jobs([], jobs)
    assert [j["name"] for j in grown["added"]] == ["a", "b"], grown
    assert grown["removed"] == [] and grown["changed"] == []
    shrunk = diff_jobs(jobs, [])
    assert shrunk["removed"] == ["a", "b"], shrunk
    assert shrunk["added"] == [] and shrunk["changed"] == []
    # None tolerated like an empty list on both sides.
    assert diff_jobs(None, None) == {"added": [], "removed": [], "changed": []}
    assert [j["name"] for j in diff_jobs(None, jobs)["added"]] == ["a", "b"]


def test_diff_jobs_preserves_file_order():
    old = [_job("x"), _job("y"), _job("z")]
    new = [_job("n1"), _job("y", schedule="45m"), _job("n2")]
    diff = diff_jobs(old, new)
    assert [j["name"] for j in diff["added"]] == ["n1", "n2"], diff  # new-file order
    assert diff["removed"] == ["x", "z"], diff  # old-file order


# --------------------------------------------------------------------------- #
# apply_jobs_diff (removals, adds, reschedules against the live scheduler API)
# --------------------------------------------------------------------------- #


def test_apply_jobs_diff_removes_adds_reschedules_and_logs_each():
    if not _has_apscheduler():
        print("NOTE: skipping apply_jobs_diff test (apscheduler unavailable)")
        return

    import datetime

    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    import scheduler.scheduler as sched

    fake = _FakeScheduler()
    diff = diff_jobs(
        [_job("gone"), _job("retimed", schedule="30m")],
        [_job("retimed", schedule="45m"), _job("fresh", schedule="0 7 * * *")],
    )
    with tempfile.TemporaryDirectory() as tmp:
        applied = sched.apply_jobs_diff(
            fake, diff, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
        )

    # One returned/logged line per applied change, removals first. The fake's
    # remove_job never raises, so the catch-up sweeps (removed/changed jobs
    # take their pending "catch-up:<name>" one-shot down too) "succeed" here
    # and log; against real APScheduler they are silent lookup misses unless
    # a boot catch-up is actually pending.
    assert applied == [
        "removed job gone",
        "dropped pending catch-up for gone",
        "added job fresh (0 7 * * *)",
        "rescheduled job retimed (45m)",
        "dropped pending catch-up for retimed",
    ], applied
    assert fake.removed == ["gone", "catch-up:gone", "catch-up:retimed"], fake.removed

    assert [a["id"] for a in fake.added] == ["fresh", "retimed"], fake.added
    for entry in fake.added:
        assert entry["replace_existing"] is True, entry
        assert callable(entry["func"]), entry
    # The triggers are real APScheduler triggers built from each job's schedule.
    fresh, retimed = fake.added
    assert isinstance(fresh["trigger"], CronTrigger), fresh
    assert isinstance(retimed["trigger"], IntervalTrigger), retimed
    assert retimed["trigger"].interval == datetime.timedelta(minutes=45), retimed


def test_apply_jobs_diff_empty_diff_is_a_no_op():
    import scheduler.scheduler as sched

    fake = _FakeScheduler()
    with tempfile.TemporaryDirectory() as tmp:
        applied = sched.apply_jobs_diff(
            fake,
            {"added": [], "removed": [], "changed": []},
            "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log",
        )
    assert applied == []
    assert fake.added == [] and fake.removed == []


def test_apply_jobs_diff_remove_failure_does_not_stop_the_rest():
    # One surprising APScheduler failure (e.g. a lookup miss for an already-
    # gone job) is logged and skipped; the rest of the diff still applies.
    if not _has_apscheduler():
        print("NOTE: skipping apply-failure test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    class _Grumpy(_FakeScheduler):
        def remove_job(self, job_id):
            raise KeyError(job_id)  # mimics apscheduler's JobLookupError

    fake = _Grumpy()
    diff = diff_jobs([_job("gone")], [_job("fresh")])
    with tempfile.TemporaryDirectory() as tmp:
        applied = sched.apply_jobs_diff(
            fake, diff, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
        )
    assert applied == ["added job fresh (30m)"], applied
    assert [a["id"] for a in fake.added] == ["fresh"], fake.added


class _LookupFakeScheduler(_FakeScheduler):
    """A fake whose remove_job raises for unregistered ids, like APScheduler."""

    def __init__(self, live_ids):
        super().__init__()
        self.live = set(live_ids)

    def remove_job(self, job_id):
        if job_id not in self.live:
            raise KeyError(job_id)  # mimics apscheduler's JobLookupError
        self.live.discard(job_id)
        super().remove_job(job_id)


def test_apply_jobs_diff_drops_pending_catch_up_one_shots():
    # A job deleted or changed during the boot catch-up window must take its
    # pending "catch-up:<name>" one-shot (schedule_catch_ups) down with it:
    # that one-shot's closure holds the OLD prompt/config.
    if not _has_apscheduler():
        print("NOTE: skipping catch-up-drop test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    fake = _LookupFakeScheduler(
        {"gone", "retimed", "keep", "catch-up:gone", "catch-up:retimed"}
    )
    diff = diff_jobs(
        [_job("gone"), _job("retimed", schedule="30m"), _job("keep")],
        [_job("retimed", schedule="45m"), _job("keep"), _job("fresh")],
    )
    with tempfile.TemporaryDirectory() as tmp:
        applied = sched.apply_jobs_diff(
            fake, diff, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
        )
    assert "catch-up:gone" in fake.removed, fake.removed
    assert "catch-up:retimed" in fake.removed, fake.removed
    assert "dropped pending catch-up for gone" in applied, applied
    assert "dropped pending catch-up for retimed" in applied, applied
    # "fresh" never had a catch-up pending; the lookup miss is silent.
    assert "catch-up:fresh" not in fake.removed, fake.removed
    assert all("fresh" not in line or line.startswith("added") for line in applied)
    # "keep" is untouched entirely.
    assert all("keep" not in entry for entry in fake.removed), fake.removed


def test_apply_jobs_diff_never_touches_the_reload_watcher_id():
    # A hand-edited jobs file naming a job after the watcher must not replace
    # (or remove) the watcher itself — hot reload would die until restart.
    import scheduler.scheduler as sched

    fake = _FakeScheduler()
    diff = {
        "added": [_job(RELOAD_JOB_ID)],
        "removed": [RELOAD_JOB_ID],
        "changed": [_job(RELOAD_JOB_ID, schedule="45m")],
    }
    with tempfile.TemporaryDirectory() as tmp:
        applied = sched.apply_jobs_diff(
            fake, diff, "http://h:8080", "open-swarm", None, Path(tmp) / "runs.log"
        )
    assert applied == [], applied
    assert fake.added == [] and fake.removed == [], (fake.added, fake.removed)


# --------------------------------------------------------------------------- #
# make_reload_checker (mtime gate -> lenient load -> rediff -> apply)
# --------------------------------------------------------------------------- #


def test_reload_checker_mtime_triggered_rediff():
    if not _has_apscheduler():
        print("NOTE: skipping reload-checker rediff test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = str(Path(tmp) / "jobs.yaml")
        v1 = [_job("keep"), _job("gone"), _job("retimed", schedule="30m")]
        _write_jobs_yaml(jobs_file, v1)

        fake = _FakeScheduler()
        check = sched.make_reload_checker(
            fake, jobs_file, v1, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        # Unchanged mtime: the cheap path, nothing touched.
        check()
        assert fake.added == [] and fake.removed == []

        # Rewrite the file (remove one, add one, change one) and poll again.
        # (The catch-up sweep also removes "catch-up:<name>" for the removed
        # and rescheduled jobs — the fake's remove_job accepts anything.)
        _write_jobs_yaml(
            jobs_file,
            [_job("keep"), _job("retimed", schedule="45m"), _job("fresh")],
        )
        check()
        expected_removed = ["gone", "catch-up:gone", "catch-up:retimed"]
        assert fake.removed == expected_removed, fake.removed
        assert [a["id"] for a in fake.added] == ["retimed", "fresh"] or [
            a["id"] for a in fake.added
        ] == ["fresh", "retimed"], fake.added

        # The new state is remembered: polling again without an edit is a no-op.
        adds_before = len(fake.added)
        check()
        assert len(fake.added) == adds_before and fake.removed == expected_removed


def test_reload_checker_bad_file_keeps_old_jobs():
    if not _has_apscheduler():
        print("NOTE: skipping reload-checker bad-file test (apscheduler unavailable)")
        return

    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = str(Path(tmp) / "jobs.yaml")
        v1 = [_job("a"), _job("b")]
        _write_jobs_yaml(jobs_file, v1)

        fake = _FakeScheduler()
        check = sched.make_reload_checker(
            fake, jobs_file, v1, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        # 1) File-level breakage (wrong top-level shape): keep everything.
        Path(jobs_file).write_text("jobs: not-a-list\n", encoding="utf-8")
        _bump_mtime(jobs_file)
        check()  # must not raise
        assert fake.added == [] and fake.removed == [], (fake.added, fake.removed)
        # The failing mtime was consumed: the next poll is quiet, no re-attempt.
        check()
        assert fake.added == [] and fake.removed == []

        # 2) Fixing the file reloads and diffs against the ORIGINAL jobs —
        # proof the old set stayed live through the broken edit. (Removal
        # sweeps the job's pending catch-up one-shot too.)
        _write_jobs_yaml(jobs_file, [_job("a"), _job("c")])
        check()
        assert fake.removed == ["b", "catch-up:b"], fake.removed
        assert [a["id"] for a in fake.added] == ["c"], fake.added


def test_reload_checker_all_invalid_jobs_keeps_old_jobs():
    # A file whose shape parses but whose every entry fails validation must be
    # treated like a failed load, not like "remove every job": a fat-fingered
    # edit cannot silently empty a live scheduler.
    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = str(Path(tmp) / "jobs.yaml")
        v1 = [_job("a")]
        _write_jobs_yaml(jobs_file, v1)

        fake = _FakeScheduler()
        check = sched.make_reload_checker(
            fake, jobs_file, v1, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        # Every entry invalid (junk schedule / missing prompt).
        Path(jobs_file).write_text(
            "- name: broken\n  schedule: junk\n  prompt: hi\n"
            "- name: nopayload\n  schedule: 30m\n",
            encoding="utf-8",
        )
        _bump_mtime(jobs_file)
        check()
        assert fake.added == [] and fake.removed == [], (fake.added, fake.removed)


def test_reload_checker_vanished_file_keeps_old_jobs():
    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = str(Path(tmp) / "jobs.yaml")
        v1 = [_job("a")]
        _write_jobs_yaml(jobs_file, v1)

        fake = _FakeScheduler()
        check = sched.make_reload_checker(
            fake, jobs_file, v1, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        os.remove(jobs_file)
        check()  # must not raise; warns and keeps everything
        check()  # repeated polls on a missing file stay quiet too
        assert fake.added == [] and fake.removed == [], (fake.added, fake.removed)


def test_reload_checker_emptied_file_removes_everything():
    # Zero jobs with zero errors is a deliberate emptying, not a typo: the
    # watcher honors it (contrast with the all-invalid case above).
    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp:
        jobs_file = str(Path(tmp) / "jobs.yaml")
        v1 = [_job("a"), _job("b")]
        _write_jobs_yaml(jobs_file, v1)

        fake = _FakeScheduler()
        check = sched.make_reload_checker(
            fake, jobs_file, v1, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        Path(jobs_file).write_text("# no jobs\n", encoding="utf-8")
        _bump_mtime(jobs_file)
        check()
        # Each removal also sweeps that job's pending catch-up one-shot.
        assert fake.removed == ["a", "catch-up:a", "b", "catch-up:b"], fake.removed
        assert fake.added == [], fake.added


# --------------------------------------------------------------------------- #
# schedule_jobs_reload wiring + the poll-interval env knob
# --------------------------------------------------------------------------- #


def test_resolve_jobs_reload_secs_default_override_and_garbage():
    with _scoped_env(SWARM_JOBS_RELOAD_SECS=None):
        assert resolve_jobs_reload_secs() == DEFAULT_JOBS_RELOAD_SECS == 30
    with _scoped_env(SWARM_JOBS_RELOAD_SECS="5"):
        assert resolve_jobs_reload_secs() == 5
    # Garbage, zero, and negatives all fall back (IntervalTrigger rejects <= 0).
    for bad in ("abc", "0", "-3", ""):
        with _scoped_env(SWARM_JOBS_RELOAD_SECS=bad):
            assert resolve_jobs_reload_secs() == DEFAULT_JOBS_RELOAD_SECS, bad


def test_schedule_jobs_reload_registers_watcher_job():
    if not _has_apscheduler():
        print("NOTE: skipping schedule_jobs_reload test (apscheduler unavailable)")
        return

    import datetime

    from apscheduler.triggers.interval import IntervalTrigger

    import scheduler.scheduler as sched

    with tempfile.TemporaryDirectory() as tmp, _scoped_env(
        SWARM_JOBS_RELOAD_SECS="7"
    ):
        jobs_file = str(Path(tmp) / "jobs.yaml")
        jobs = [_job("a")]
        _write_jobs_yaml(jobs_file, jobs)

        fake = _FakeScheduler()
        checker = sched.schedule_jobs_reload(
            fake, jobs_file, jobs, "http://h:8080", "open-swarm", None,
            Path(tmp) / "runs.log",
        )

        assert callable(checker)
        assert len(fake.added) == 1, fake.added
        watcher = fake.added[0]
        assert watcher["id"] == RELOAD_JOB_ID
        assert watcher["func"] is checker
        assert watcher["replace_existing"] is True
        assert isinstance(watcher["trigger"], IntervalTrigger)
        assert watcher["trigger"].interval == datetime.timedelta(seconds=7)

        # The returned checker is live against the same fake scheduler: an
        # edit on the next poll flows through the whole reload path.
        _write_jobs_yaml(jobs_file, [_job("a"), _job("b")])
        checker()
        assert [a["id"] for a in fake.added[1:]] == ["b"], fake.added


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
