"""Always-on scheduler daemon for OpenSwarm.

Loads a jobs file, registers each job with APScheduler (cron or interval), and
on every fire POSTs the job's prompt to the running OpenSwarm FastAPI agency
(``server.py``), appending the outcome to a run log. A job may instead carry
``builtin: digest`` (mutually exclusive with ``prompt``): it never POSTs to the
agency; the daemon summarizes the runs ledger straight into a vault note via
``digest.run_digest`` (zero agent tokens) and still writes a ledger record.
A job may also carry ``catch_up: "<Nd>"``: shortly after daemon start, when the
runs ledger has no "ok" record for it inside the window, it fires once
(staggered — first ~20s after start, then +45s apart) on top of its normal
schedule.

Run it standalone (venv has apscheduler + httpx + pyyaml):

    /Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python scheduler/scheduler.py

Configuration (all via environment):

    SWARM_JOBS_FILE   path to jobs YAML            (default: scheduler/jobs.yaml,
                                                    falls back to jobs.example.yaml)
    SWARM_BASE_URL    agency base URL              (default: http://localhost:8080)
    SWARM_AGENCY      agency name / route segment  (default: open-swarm)
    SWARM_APP_TOKEN   bearer token for the server  (falls back to APP_TOKEN;
                                                    omit if the server has no token)
    SWARM_RUNS_LOG    append-only run log path     (default: scheduler/runs.log)
    SWARM_RUNS_JSONL  structured JSONL ledger path  (default: ~/.openswarm/runs.jsonl)
    SWARM_RUNS_JSONL_MAX_BYTES  ledger rotation size (default: 5242880 = 5 MiB)
    SWARM_MAX_RETRIES retries for pre-response fails (default: 2)
    SWARM_RETRY_BASE_DELAY  backoff base seconds     (default: 1.0)
    SWARM_NOTIFICATIONS  failure-alert JSONL sink     (default: ~/.openswarm/
                                                       notifications.jsonl)
    SWARM_AIEOS_URL   AIEOS timeline base URL for the failure-notification
                      fallback POST (e.g. http://127.0.0.1:7824); unset = off
    SWARM_NOTIFY_MIN_INTERVAL  dedup window seconds for the same failure
                               (default: 3600)
    SWARM_VAULT_ROOT  vault root for builtin digest jobs (unset defers to
                      vault_core's own OBSIDIAN_VAULT / default resolution)

All heavy logic lives in ``jobs_core`` / ``run_store`` / ``retry`` (all pure)
and ``client`` (thin HTTP). This module only wires those into APScheduler, so it
stays small and side-effecty. Each fire is timed, retried (only for pre-response
failures: connect-phase error / status 0 / HTTP 429 — never a read/write timeout,
which may have already reached the server), appended to the human run log
AND to the structured JSONL ledger (name, ts, status, status_code, tokens, cost,
latency_ms, attempts, error, response_excerpt).
"""

from __future__ import annotations

import datetime
import logging
import os
import signal
import sys
import time
from pathlib import Path

# Ensure "scheduler" is importable both as a package and when run as a script.
_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from scheduler import client, digest, notify, retry, run_store
from scheduler.jobs_core import (
    build_trigger,
    format_run_line,
    load_jobs_lenient,
    plan_catch_ups,
)

logger = logging.getLogger("swarm.scheduler")

DEFAULT_JOBS_FILE = _HERE / "jobs.yaml"
EXAMPLE_JOBS_FILE = _HERE / "jobs.example.yaml"
DEFAULT_RUNS_LOG = _HERE / "runs.log"
DEFAULT_BASE_URL = "http://localhost:8080"
DEFAULT_AGENCY = "open-swarm"

# Retry + ledger tuning (all overridable via env).
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BASE_DELAY = 1.0
DEFAULT_RUNS_JSONL_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB before rotation

# Failure-notification tuning (all overridable via env).
DEFAULT_NOTIFY_MIN_INTERVAL = 3600  # suppress the same failure for 1h by default
NOTIFY_RECENT_LIMIT = 200  # how many prior notifications to scan for dedup


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #


def resolve_jobs_file() -> str:
    """Return the jobs file path from SWARM_JOBS_FILE, with a sane fallback."""
    configured = os.getenv("SWARM_JOBS_FILE")
    if configured:
        return configured
    if DEFAULT_JOBS_FILE.exists():
        return str(DEFAULT_JOBS_FILE)
    logger.warning(
        "SWARM_JOBS_FILE unset and %s missing; using example file %s",
        DEFAULT_JOBS_FILE,
        EXAMPLE_JOBS_FILE,
    )
    return str(EXAMPLE_JOBS_FILE)


def resolve_runs_log() -> Path:
    return Path(os.getenv("SWARM_RUNS_LOG", str(DEFAULT_RUNS_LOG)))


def resolve_base_url() -> str:
    return os.getenv("SWARM_BASE_URL", DEFAULT_BASE_URL)


def resolve_agency() -> str:
    return os.getenv("SWARM_AGENCY", DEFAULT_AGENCY)


def resolve_app_token():
    return os.getenv("SWARM_APP_TOKEN") or os.getenv("APP_TOKEN")


def _resolve_int(env_name: str, default: int) -> int:
    """Read a non-negative int from *env_name*, falling back on default/garbage."""
    raw = os.getenv(env_name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


def resolve_max_retries() -> int:
    return _resolve_int("SWARM_MAX_RETRIES", DEFAULT_MAX_RETRIES)


def resolve_retry_base_delay() -> float:
    raw = os.getenv("SWARM_RETRY_BASE_DELAY")
    if raw is None:
        return DEFAULT_RETRY_BASE_DELAY
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_RETRY_BASE_DELAY
    return value if value >= 0 else DEFAULT_RETRY_BASE_DELAY


def resolve_runs_jsonl_max_bytes() -> int:
    return _resolve_int("SWARM_RUNS_JSONL_MAX_BYTES", DEFAULT_RUNS_JSONL_MAX_BYTES)


def resolve_aieos_url():
    """AIEOS timeline base URL for the failure-notification fallback (or None)."""
    return os.getenv("SWARM_AIEOS_URL")


def resolve_notify_min_interval() -> int:
    return _resolve_int("SWARM_NOTIFY_MIN_INTERVAL", DEFAULT_NOTIFY_MIN_INTERVAL)


def resolve_vault_root():
    """Vault root for builtin digest jobs (SWARM_VAULT_ROOT), or ``None``.

    ``None`` defers to ``vault_core``'s own resolution (OBSIDIAN_VAULT env,
    then its built-in default) via ``digest.run_digest``, so the real default
    lives in exactly one place instead of being duplicated here.
    """
    return os.getenv("SWARM_VAULT_ROOT") or None


# --------------------------------------------------------------------------- #
# Run logging
# --------------------------------------------------------------------------- #


def append_run_log(runs_log: Path, name: str, status: str, detail: str = "") -> None:
    """Append a single formatted line to the run log (created if missing)."""
    runs_log.parent.mkdir(parents=True, exist_ok=True)
    with open(runs_log, "a", encoding="utf-8") as handle:
        handle.write(format_run_line(name, status, detail) + "\n")


# --------------------------------------------------------------------------- #
# Job runner
# --------------------------------------------------------------------------- #


def _append_ledger_record(name, status, status_code, result, latency_ms, attempts, error):
    """Build and append one structured ledger record; never raises to the caller."""
    record = run_store.build_record(
        name=name,
        ts=datetime.datetime.now().isoformat(timespec="seconds"),
        status=status,
        status_code=status_code,
        tokens=result.get("total_tokens"),
        cost=result.get("cost"),
        latency_ms=latency_ms,
        attempts=attempts,
        error=error or None,
        response_excerpt=result.get("response"),
    )
    try:
        path = run_store.resolve_runs_jsonl_path()
        run_store.rotate_if_needed(path, resolve_runs_jsonl_max_bytes())
        run_store.append_record(path, record)
    except Exception:  # a broken ledger must not take the daemon down
        logger.exception("failed to append ledger record for job %s", name)
    return record


def _post_aieos_event(url, json) -> None:
    """POST a timeline event to AIEOS (real side effect; injected in tests)."""
    import httpx  # lazy: only the daemon path needs it

    httpx.post(url, json=json, timeout=5.0)


def _maybe_notify(record) -> None:
    """Send a failure notification for *record*, deduped. Never raises.

    Reads the recent notification history from the JSONL sink, applies the
    dedup/rate-limit gate, and only then emits. Any failure here (I/O, network,
    a broken sink) is swallowed so a notification problem cannot crash the job
    runner or the daemon.
    """
    try:
        path = notify.resolve_notifications_path()
        recent = notify.read_notifications(path, limit=NOTIFY_RECENT_LIMIT)
        if notify.should_notify(record, recent, resolve_notify_min_interval()):
            notify.notify(
                record,
                notifications_path=path,
                poster=_post_aieos_event,
                aieos_url=resolve_aieos_url(),
            )
    except Exception:  # a notify failure must never crash the runner
        logger.exception(
            "failed to send failure notification for job %s", record.get("name")
        )


def make_runner(job, base_url, agency, app_token, runs_log):
    """Return a zero-arg callable APScheduler can fire for *job*."""
    endpoint = job.get("endpoint") or base_url

    def run() -> None:
        name = job["name"]
        logger.info("firing job %s -> %s", name, endpoint)

        def _send():
            return client.send(
                endpoint,
                agency,
                job["prompt"],
                agent=job.get("agent"),
                app_token=app_token,
            )

        started = time.monotonic()
        attempts = 1
        error = ""
        result: dict = {}
        try:
            # Retry only pre-response failures (connect-phase error / 429 / status
            # 0); a 5xx OR a read/write timeout may mean the agency already ran a
            # side effect, so neither is retried. send_with_retry does not raise.
            result, attempts = retry.send_with_retry(
                _send,
                max_retries=resolve_max_retries(),
                base_delay=resolve_retry_base_delay(),
            )
        except Exception as exc:  # defensive; send_with_retry should absorb these
            logger.exception("job %s failed", name)
            error = str(exc)
            result = {}
        latency_ms = int((time.monotonic() - started) * 1000)

        if not isinstance(result, dict):
            result = {}
        status_code = result.get("status_code", 0)
        if not error and not result:
            error = "no result"
        if error:
            status = "error"
        elif result.get("ok") and not result.get("error"):
            status = "ok"
        elif result.get("ok"):
            # 2xx but the payload carries the agent-level failure flag: the lite
            # backend's compat route never 500s — an agent exception comes back
            # as 200 + {"response": "<error text>", "error": true}. That is a
            # failed run (it must notify, retry-on-restart via catch_up, and
            # show red in the app), so demote it here and lift the useful text
            # out of "response" ("error" is a bare boolean there, and str() of
            # it would record a useless "True").
            status = "error"
            error = str(result.get("response") or result.get("error") or "")
        elif not status_code:
            # No HTTP response was received: send_with_retry synthesizes an
            # exhausted/terminal transport failure (connection refused, etc.) as
            # {"ok": False, "status_code": 0, "error": <str>}. That is an "error",
            # not a nonsensical "http-0", so surface it as such and lift its text.
            status = "error"
            error = str(result.get("error") or "")
        else:
            status = f"http-{status_code}"

        error_text = error or str(result.get("error") or "")
        detail = str(result.get("response") or error_text or "")

        # Keep the existing human-readable run log line. A transient FS fault here
        # (permissions, disk full, read-only mount) must NOT suppress the durable
        # ledger record or the failure alert below, so it is non-fatal like them.
        try:
            append_run_log(runs_log, name, status, detail)
        except Exception:  # a run-log write fault must not lose the ledger/alert
            logger.exception("failed to append run log line for job %s", name)
        # Plus the structured, machine-readable ledger record.
        record = _append_ledger_record(
            name, status, status_code, result, latency_ms, attempts, error_text
        )
        # On a final failure (retries already exhausted upstream), tell the user
        # — deduped so a recurring failure does not storm every interval.
        if status != "ok":
            _maybe_notify(record)

    run.__name__ = f"run_{job['name']}"
    return run


def make_digest_runner(job, runs_log):
    """Return a zero-arg callable for a ``builtin: digest`` job.

    Never POSTs to the agency: it summarizes the runs ledger straight into a
    dated vault note via ``digest.run_digest`` (pure python, zero agent
    tokens), then writes the same run-log line and ledger record every prompt
    job writes — tokens 0 / cost 0, status_code 0 (no HTTP happened) — so the
    app's live widgets see the run land with real status/latency.
    """

    def run() -> None:
        name = job["name"]
        logger.info("firing builtin digest job %s", name)

        started = time.monotonic()
        error = ""
        detail = ""
        try:
            records = run_store.read_records(None)
            today = datetime.date.today().isoformat()
            detail = digest.run_digest(resolve_vault_root(), records, today)
        except Exception as exc:  # a broken digest must not take the daemon down
            logger.exception("builtin digest job %s failed", name)
            error = str(exc)
        latency_ms = int((time.monotonic() - started) * 1000)

        status = "error" if error else "ok"
        result = {"total_tokens": 0, "cost": 0, "response": detail or None}

        # Same sink discipline as make_runner: the run-log write is non-fatal,
        # the ledger record always lands, failures alert (deduped).
        try:
            append_run_log(runs_log, name, status, detail or error)
        except Exception:  # a run-log write fault must not lose the ledger/alert
            logger.exception("failed to append run log line for job %s", name)
        record = _append_ledger_record(
            name, status, 0, result, latency_ms, 1, error
        )
        if status != "ok":
            _maybe_notify(record)

    run.__name__ = f"run_{job['name']}"
    return run


def make_job_runner(job, base_url, agency, app_token, runs_log):
    """Dispatch: builtin jobs run locally, prompt jobs POST at the agency."""
    if job.get("builtin") == "digest":
        return make_digest_runner(job, runs_log)
    return make_runner(job, base_url, agency, app_token, runs_log)


# --------------------------------------------------------------------------- #
# Scheduler assembly
# --------------------------------------------------------------------------- #


def build_scheduler(jobs, base_url, agency, app_token, runs_log):
    """Create a BlockingScheduler with every job registered. Lazy APScheduler import."""
    from apscheduler.schedulers.blocking import BlockingScheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    scheduler = BlockingScheduler()

    for job in jobs:
        trigger_spec = build_trigger(job)
        if trigger_spec["type"] == "interval":
            trigger = IntervalTrigger(seconds=trigger_spec["seconds"])
        else:
            trigger = CronTrigger(**trigger_spec["fields"])
        scheduler.add_job(
            make_job_runner(job, base_url, agency, app_token, runs_log),
            trigger=trigger,
            id=job["name"],
            name=job["name"],
            replace_existing=True,
        )
        logger.info("registered job %s (%s)", job["name"], job["schedule"])

    return scheduler


def schedule_catch_ups(scheduler, jobs, base_url, agency, app_token, runs_log,
                       now=None):
    """Register one-shot catch-up fires for stale ``catch_up`` jobs.

    Reads the runs ledger once at start; every catch_up job with no "ok"
    record inside its window gets a DateTrigger fire, staggered by
    ``plan_catch_ups`` (first ~20s after start, then +45s apart) so parallel
    claude sessions never stampede at boot. Normal cron/interval scheduling is
    untouched. Returns the plans that were scheduled.
    """
    from apscheduler.triggers.date import DateTrigger

    try:
        records = run_store.read_records(None)
    except Exception:  # a corrupt ledger must not block catch-up planning
        logger.exception("failed to read the runs ledger for catch-up planning")
        records = []

    if now is None:
        now = datetime.datetime.now()
    plans = plan_catch_ups(jobs, records, now=now)
    for plan in plans:
        job = plan["job"]
        scheduler.add_job(
            make_job_runner(job, base_url, agency, app_token, runs_log),
            trigger=DateTrigger(run_date=now + datetime.timedelta(seconds=plan["delay"])),
            id=f"catch-up:{job['name']}",
            name=f"catch-up:{job['name']}",
            replace_existing=True,
        )
        logger.info(
            "scheduled catch-up fire for job %s in %ds (no ok run within %s)",
            job["name"],
            plan["delay"],
            job["catch_up"],
        )
    return plans


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    jobs_file = resolve_jobs_file()
    base_url = resolve_base_url()
    agency = resolve_agency()
    app_token = resolve_app_token()
    runs_log = resolve_runs_log()

    def _surface_config_error(problem: str) -> None:
        # Land the problem everywhere the app can see it: the human run log,
        # the structured ledger (the History card), and a deduped notification.
        # The jobs file is user-editable and app-seeded, so a typo must show up
        # in the UI, not only as a traceback in backend.log.
        try:
            append_run_log(runs_log, "scheduler", "error", problem)
        except Exception:  # a run-log write fault must not lose the ledger/alert
            logger.exception("failed to append run log line for config error")
        record = _append_ledger_record("scheduler", "error", 0, {}, 0, 1, problem)
        _maybe_notify(record)

    try:
        jobs, job_errors = load_jobs_lenient(jobs_file)
    except Exception as exc:
        # File-level failure (missing/unreadable file, unparseable YAML, wrong
        # top-level shape): nothing is salvageable, but do not die as a bare
        # traceback — surface why the scheduler is absent, then exit.
        logger.error("could not load jobs file %s: %s", jobs_file, exc)
        _surface_config_error(f"jobs file {jobs_file}: {exc}")
        return 1
    for problem in job_errors:
        # One typo in one job must not silence every other job: skip the bad
        # entry, keep scheduling the rest, and surface the skip.
        logger.error("skipping invalid job in %s: %s", jobs_file, problem)
        _surface_config_error(f"invalid job skipped ({jobs_file}): {problem}")
    if not jobs:
        logger.error("no valid jobs found in %s; nothing to schedule", jobs_file)
        if not job_errors:
            _surface_config_error(f"no jobs found in {jobs_file}; nothing to schedule")
        return 1

    logger.info(
        "loaded %d job(s) from %s; firing at %s (agency=%s, auth=%s)",
        len(jobs),
        jobs_file,
        base_url,
        agency,
        "on" if app_token else "off",
    )
    append_run_log(runs_log, "scheduler", "start", f"{len(jobs)} job(s) from {jobs_file}")

    scheduler = build_scheduler(jobs, base_url, agency, app_token, runs_log)
    schedule_catch_ups(scheduler, jobs, base_url, agency, app_token, runs_log)

    def _stop(signum, _frame):
        logger.info("received signal %s; shutting down", signum)
        append_run_log(runs_log, "scheduler", "stop", f"signal {signum}")
        scheduler.shutdown(wait=False)

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    try:
        scheduler.start()  # blocks until shutdown
    except (KeyboardInterrupt, SystemExit):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
