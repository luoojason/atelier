"""Failure notifications for the OpenSwarm scheduler.

When a scheduled job finally fails (after ``retry.send_with_retry`` has
exhausted its retries), the user should be told, without a recurring failure
storming an alert on every interval. This module provides the pure logic:

* :func:`build_notification` — a compact alert dict from a ledger record.
* :func:`should_notify` — dedup / rate-limit gate keyed on the job name plus a
  *coarse* error signature, so a failure whose only difference is a timestamp,
  port, or request id does not slip past the suppression window.
* :func:`notify` — append the alert to a durable JSONL sink (ALWAYS, the
  reliable record) and, when an AIEOS base URL is configured, POST a minimal
  timeline event via an injected ``poster`` (the durable fallback).

Everything here is plain functions over stdlib types (json / os / re / datetime
/ pathlib) with injectable side effects (``poster``, ``now_ts``, explicit
paths), so it imports and unit-tests under a bare ``python3`` with no
agency_swarm / apscheduler / pydantic and never touches the network or a real
vault.

The JSONL sink path comes from ``SWARM_NOTIFICATIONS``
(default ``~/.openswarm/notifications.jsonl``).

AIEOS event shape
-----------------
The POST target is ``{aieos_url}/timeline/event``. The body matches the
``TimelineEvent`` model of the AIEOS timeline route
(``cc-dashboard-app/aimd/timeline/routes.py`` ``POST /event``), whose required
fields are ``type`` (str), ``session_id`` (str), and ``payload`` (dict); ``ts``
is an optional float. We therefore send ``{type, session_id, payload, ts?}``
rather than the generic ``{source, kind, payload}`` fallback, because the exact
shape was readable from that handler.
"""

from __future__ import annotations

import datetime
import json
import os
import re
from pathlib import Path
from typing import Any, Callable, Optional

DEFAULT_NOTIFICATIONS = "~/.openswarm/notifications.jsonl"

# AIEOS timeline event defaults (see module docstring).
EVENT_PATH = "/timeline/event"
DEFAULT_EVENT_TYPE = "scheduler.job_failed"
DEFAULT_SESSION_ID = "openswarm-scheduler"

# Cap the coarse error signature so a giant error string cannot bloat the key.
_SIGNATURE_MAX_CHARS = 80


# --------------------------------------------------------------------------- #
# Path / time helpers
# --------------------------------------------------------------------------- #


def resolve_notifications_path() -> str:
    """Return the JSONL sink path from ``SWARM_NOTIFICATIONS`` (``~`` expanded)."""
    return os.path.expanduser(os.getenv("SWARM_NOTIFICATIONS", DEFAULT_NOTIFICATIONS))


def _resolve_path(path: Optional[str]) -> Path:
    """Return a concrete ``Path``, defaulting to the env notifications sink."""
    if path is None:
        path = resolve_notifications_path()
    return Path(os.path.expanduser(str(path)))


def _coerce_epoch(value: Any) -> Optional[float]:
    """Best-effort conversion of *value* to epoch seconds, or ``None``.

    Accepts a number, a numeric string, or an ISO-8601 timestamp (as produced
    by ``datetime.isoformat``). Anything unparseable yields ``None`` so callers
    can degrade gracefully rather than raise.
    """
    if value is None:
        return None
    if isinstance(value, bool):  # bool is an int subclass; treat as no time
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            pass
        try:
            return datetime.datetime.fromisoformat(text).timestamp()
        except ValueError:
            return None
    return None


# --------------------------------------------------------------------------- #
# Dedup key
# --------------------------------------------------------------------------- #


def _coarse_error(error: Any) -> str:
    """Collapse an error string to a coarse signature.

    Lowercased, with digit runs removed and whitespace squeezed, then truncated.
    This makes ``"connection reset at 12:03:44"`` and ``"...at 12:04:01"`` share
    one signature, so the same recurring failure is deduped even though its
    timestamps differ.
    """
    if not error:
        return ""
    text = str(error).lower()
    text = re.sub(r"\d+", "", text)          # drop numbers (times, ports, ids)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:_SIGNATURE_MAX_CHARS]


def notification_key(record: dict) -> str:
    """Return the dedup key for *record*: job name + a coarse error signature.

    Falls back to the record ``status`` when there is no error text, so two
    distinct failure modes of the same job (e.g. ``http-500`` vs ``error``) do
    not collapse into one key.
    """
    name = record.get("name") or ""
    signature = _coarse_error(record.get("error")) or (record.get("status") or "")
    return f"{name}::{signature}"


# --------------------------------------------------------------------------- #
# Notification building
# --------------------------------------------------------------------------- #


def build_notification(record: dict) -> dict:
    """Build a compact alert dict from a ledger *record*.

    Keeps only the fields worth alerting on (name, status, error, ts, attempts)
    plus the dedup ``key``. ``ts`` is copied straight from the record so the
    stored notification and the record it came from share a timeline.
    """
    return {
        "name": record.get("name"),
        "status": record.get("status"),
        "error": record.get("error"),
        "ts": record.get("ts"),
        "attempts": record.get("attempts"),
        "key": notification_key(record),
    }


def build_event(
    notification: dict,
    session_id: str = DEFAULT_SESSION_ID,
    event_type: str = DEFAULT_EVENT_TYPE,
) -> dict:
    """Build the AIEOS ``POST /timeline/event`` body for *notification*.

    Shape mirrors the timeline route's ``TimelineEvent`` model: required
    ``type`` / ``session_id`` / ``payload``, with an optional numeric ``ts``.
    """
    event = {
        "type": event_type,
        "session_id": session_id,
        "payload": {
            "name": notification.get("name"),
            "status": notification.get("status"),
            "error": notification.get("error"),
            "attempts": notification.get("attempts"),
            "ts": notification.get("ts"),
        },
    }
    epoch = _coerce_epoch(notification.get("ts"))
    if epoch is not None:
        event["ts"] = epoch
    return event


# --------------------------------------------------------------------------- #
# Dedup gate
# --------------------------------------------------------------------------- #


def should_notify(record: dict, recent: list, min_interval_seconds: float) -> bool:
    """Return ``True`` when *record* deserves a fresh alert.

    Suppresses (returns ``False``) when *recent* already holds a notification
    with the same :func:`notification_key` whose ``ts`` is within
    ``min_interval_seconds`` before the record's own ``ts``. ``recent`` is a
    list of prior notification dicts (each carrying ``key`` and ``ts``).

    Distinct jobs, or distinct coarse error signatures, never share a key and so
    are never deduped against one another. If either timestamp cannot be parsed
    the alert is allowed (fail open — better a duplicate than a dropped alert).
    """
    if min_interval_seconds is None or min_interval_seconds <= 0:
        return True
    now = _coerce_epoch(record.get("ts"))
    if now is None:
        return True
    key = notification_key(record)
    for prior in recent or []:
        if not isinstance(prior, dict):
            continue
        if prior.get("key") != key:
            continue
        prior_ts = _coerce_epoch(prior.get("ts"))
        if prior_ts is None:
            continue
        delta = now - prior_ts
        if 0 <= delta < min_interval_seconds:
            return False
    return True


# --------------------------------------------------------------------------- #
# JSONL sink
# --------------------------------------------------------------------------- #


def read_notifications(path: Optional[str] = None, limit: Optional[int] = None) -> list:
    """Read prior notifications back from the JSONL sink (oldest first).

    ``path=None`` targets the ``SWARM_NOTIFICATIONS`` sink. ``limit`` keeps only
    the most recent *limit* records (``limit <= 0`` -> ``[]``). A missing file
    yields ``[]``; blank lines are skipped.
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
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if limit is not None:
        if limit <= 0:
            return []
        return records[-limit:]
    return records


def notify(
    record: dict,
    notifications_path: Optional[str] = None,
    poster: Optional[Callable[[str, dict], Any]] = None,
    aieos_url: Optional[str] = None,
    now_ts: Optional[float] = None,
) -> dict:
    """Emit a failure notification for *record*.

    Always appends one JSON line to the durable JSONL sink (the reliable
    record). When *aieos_url* is set and a *poster* is provided, additionally
    POSTs a minimal timeline event to ``{aieos_url}/timeline/event`` via
    ``poster(url, json)`` (the durable AIEOS fallback); a poster failure is
    swallowed because the JSONL sink already captured the alert.

    *now_ts* (epoch seconds), when given, overrides the notification's ``ts`` so
    tests get a deterministic timestamp. Returns the notification dict written.
    """
    notification = build_notification(record)
    if now_ts is not None:
        notification["ts"] = now_ts

    # Reliable sink: always append to the JSONL ledger first.
    target = _resolve_path(notifications_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(notification, ensure_ascii=False, sort_keys=True)
    with open(target, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")

    # Durable fallback: POST to AIEOS when configured.
    if aieos_url and poster is not None:
        url = str(aieos_url).rstrip("/") + EVENT_PATH
        event = build_event(notification)
        try:
            poster(url, event)
        except Exception:  # noqa: BLE001 - fallback only; JSONL already has it
            pass

    return notification
