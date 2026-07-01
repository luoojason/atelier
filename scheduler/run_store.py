"""Per-run structured ledger for the OpenSwarm scheduler.

Every scheduled fire appends one JSON object (one line) to a JSONL ledger so
runs can be inspected, tallied, and rotated without parsing the free-form
human log. All the logic here is plain functions over stdlib types (json / os /
pathlib) so it imports and unit-tests under a bare ``python3`` with no
agency_swarm / apscheduler / pydantic.

The ledger path comes from ``SWARM_RUNS_JSONL`` (default ``~/.openswarm/runs.jsonl``).
``build_record`` is deterministic: the caller passes the ISO timestamp in, so
the function never touches the clock.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Optional

DEFAULT_RUNS_JSONL = "~/.openswarm/runs.jsonl"

# Redaction: cap the stored response excerpt so a giant agent reply cannot bloat
# the ledger (or leak an unbounded amount of text into it).
EXCERPT_MAX_CHARS = 500

# Same bloat/leak guard for the error field: an adversarial server error body or
# an unusually long exception string must not write an unbounded ledger line.
ERROR_MAX_CHARS = 1000

# Serializes rotate + append within a single process so the scheduler's
# ThreadPoolExecutor (distinct jobs sharing a cron minute fire concurrently and
# all write the one global ledger) cannot lose a record to a rotation TOCTOU or
# interleave two appends into a torn line. Reentrant so a caller may hold it
# across a rotate-then-append pair without deadlocking.
_LEDGER_LOCK = threading.RLock()

# The stable field order of a ledger record (also the JSON key order).
RECORD_FIELDS = (
    "name",
    "ts",
    "status",
    "status_code",
    "tokens",
    "cost",
    "latency_ms",
    "attempts",
    "error",
    "response_excerpt",
)


def resolve_runs_jsonl_path() -> str:
    """Return the JSONL ledger path from ``SWARM_RUNS_JSONL`` (``~`` expanded)."""
    return os.path.expanduser(os.getenv("SWARM_RUNS_JSONL", DEFAULT_RUNS_JSONL))


def _truncate(value: Any, max_chars: int) -> Optional[str]:
    """Coerce *value* to a string capped at *max_chars*, or ``None`` for nothing."""
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    if len(text) > max_chars:
        return text[:max_chars]
    return text


def _redact_excerpt(value: Any) -> Optional[str]:
    """Coerce *value* to a truncated string, or ``None`` when there is nothing."""
    return _truncate(value, EXCERPT_MAX_CHARS)


def build_record(
    name: str,
    ts: str,
    status: str,
    status_code: Any,
    tokens: Any,
    cost: Any,
    latency_ms: Any,
    attempts: Any,
    error: Any,
    response_excerpt: Any,
) -> dict:
    """Assemble one ledger record.

    Pure and deterministic: ``ts`` (an ISO timestamp) is supplied by the caller
    rather than read from the clock here, so tests get a fixed shape. The
    ``response_excerpt`` is truncated to :data:`EXCERPT_MAX_CHARS` and the
    ``error`` to :data:`ERROR_MAX_CHARS`, so neither field can bloat the ledger.
    """
    return {
        "name": name,
        "ts": ts,
        "status": status,
        "status_code": status_code,
        "tokens": tokens,
        "cost": cost,
        "latency_ms": latency_ms,
        "attempts": attempts,
        "error": _truncate(error, ERROR_MAX_CHARS),
        "response_excerpt": _redact_excerpt(response_excerpt),
    }


def _resolve_path(path: Optional[str]) -> Path:
    """Return a concrete ``Path`` for *path*, defaulting to the env ledger."""
    if path is None:
        path = resolve_runs_jsonl_path()
    return Path(os.path.expanduser(str(path)))


def append_record(path: Optional[str], record: dict) -> str:
    """Append *record* as one JSON line to the JSONL at *path* (dirs created).

    Passing ``path=None`` targets the ``SWARM_RUNS_JSONL`` ledger. Returns the
    resolved path actually written to.
    """
    target = _resolve_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    # Serialize the write so two concurrent scheduler threads cannot interleave
    # their lines into a single torn record (which would then trip read_records).
    with _LEDGER_LOCK:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    return str(target)


def read_records(path: Optional[str], limit: Optional[int] = None) -> list:
    """Read ledger records back from *path*.

    Returns a list of decoded dicts (oldest first). ``limit`` keeps only the
    most recent *limit* records (``limit <= 0`` returns an empty list). A
    missing file yields ``[]``. Blank lines are skipped.
    """
    target = _resolve_path(path)
    if not target.exists():
        return []
    records: list = []
    with open(target, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            # A single malformed line (a torn write from a crash mid-append, or an
            # interleaved concurrent append) must not abort the whole read: skip it
            # so digest/inspection still see every intact record. Mirrors
            # notify.read_notifications' identical guard.
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if limit is not None:
        if limit <= 0:
            return []
        return records[-limit:]
    return records


def rotate_if_needed(path: Optional[str], max_bytes: int) -> bool:
    """Rotate the ledger to ``path + ".1"`` when it reaches *max_bytes*.

    Returns ``True`` when a rotation happened. The current file is renamed to
    ``<path>.1`` (replacing any prior rotation), leaving the live path free for
    a fresh file on the next append. A missing file, or one below the threshold,
    is left untouched and returns ``False``.

    Concurrency: the whole check-then-rename runs under ``_LEDGER_LOCK`` so two
    scheduler threads that fire on the same cron minute cannot both pass the
    size check and then race their ``os.replace`` calls (which would raise
    ``FileNotFoundError`` in the loser and silently drop that fire's record). The
    ``FileNotFoundError`` guard additionally covers a cross-process rotation.
    """
    target = _resolve_path(path)
    with _LEDGER_LOCK:
        if not target.exists():
            return False
        if target.stat().st_size < max_bytes:
            return False
        rotated = Path(str(target) + ".1")
        try:
            os.replace(str(target), str(rotated))
        except FileNotFoundError:
            # Another process rotated the same file between our stat and rename;
            # the rotation already happened, so treat it as a no-op success path.
            return False
        return True
