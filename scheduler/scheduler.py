"""Always-on scheduler daemon for OpenSwarm.

Loads a jobs file, registers each job with APScheduler (cron or interval), and
on every fire POSTs the job's prompt to the running OpenSwarm FastAPI agency
(``server.py``), appending the outcome to a run log.

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

from scheduler import client, retry, run_store
from scheduler.jobs_core import build_trigger, format_run_line, load_jobs

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
        elif result.get("ok"):
            status = "ok"
        else:
            status = f"http-{status_code}"

        error_text = error or str(result.get("error") or "")
        detail = str(result.get("response") or error_text or "")

        # Keep the existing human-readable run log line.
        append_run_log(runs_log, name, status, detail)
        # Plus the structured, machine-readable ledger record.
        _append_ledger_record(
            name, status, status_code, result, latency_ms, attempts, error_text
        )

    run.__name__ = f"run_{job['name']}"
    return run


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
            make_runner(job, base_url, agency, app_token, runs_log),
            trigger=trigger,
            id=job["name"],
            name=job["name"],
            replace_existing=True,
        )
        logger.info("registered job %s (%s)", job["name"], job["schedule"])

    return scheduler


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

    jobs = load_jobs(jobs_file)
    if not jobs:
        logger.error("no jobs found in %s; nothing to schedule", jobs_file)
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
