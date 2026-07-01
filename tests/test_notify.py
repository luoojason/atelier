"""Assert-based tests for the scheduler failure-notification module.

Run with the SYSTEM python (no heavy framework needed):

    python3 tests/test_notify.py

These tests import ONLY the pure ``scheduler.notify`` module + stdlib, so they
pass without agency_swarm / apscheduler / pydantic / httpx installed. No
network, no real vault, no real ``~/.openswarm`` writes: every JSONL write goes
to a tempdir and every AIEOS POST goes through an injected spy. Timestamps are
supplied explicitly so nothing reads the clock.
"""

import os
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so "scheduler.*" resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scheduler import notify


def _record(name="job1", status="error", error="connection refused", ts=1000.0,
            attempts=3):
    """A minimal ledger-record-shaped dict."""
    return {
        "name": name,
        "ts": ts,
        "status": status,
        "status_code": 0,
        "tokens": None,
        "cost": None,
        "latency_ms": 12,
        "attempts": attempts,
        "error": error,
        "response_excerpt": None,
    }


# --------------------------------------------------------------------------- #
# build_notification
# --------------------------------------------------------------------------- #


def test_build_notification_shape():
    rec = _record(name="daily", status="http-500", error="boom", ts=1234.0,
                  attempts=2)
    note = notify.build_notification(rec)
    # Exactly the compact alert fields, nothing heavy carried over.
    assert set(note.keys()) == {"name", "status", "error", "ts", "attempts", "key"}
    assert note["name"] == "daily"
    assert note["status"] == "http-500"
    assert note["error"] == "boom"
    assert note["ts"] == 1234.0
    assert note["attempts"] == 2
    # key = job name + coarse error signature (digits stripped, lowercased).
    assert note["key"] == notify.notification_key(rec)
    assert note["key"].startswith("daily::")


def test_notification_key_coarse_signature():
    # Same job, same error modulo an embedded timestamp -> identical key.
    a = _record(name="j", error="connection reset at 12:03:44")
    b = _record(name="j", error="connection reset at 12:59:01")
    assert notify.notification_key(a) == notify.notification_key(b)
    # Different error text -> different key.
    c = _record(name="j", error="read timeout")
    assert notify.notification_key(a) != notify.notification_key(c)
    # Different job -> different key.
    d = _record(name="k", error="connection reset at 12:03:44")
    assert notify.notification_key(a) != notify.notification_key(d)
    # No error text falls back to status so failure modes stay distinct.
    e = _record(name="j", status="error", error=None)
    f = _record(name="j", status="http-500", error=None)
    assert notify.notification_key(e) != notify.notification_key(f)


# --------------------------------------------------------------------------- #
# should_notify — dedup / rate-limit window
# --------------------------------------------------------------------------- #


def test_should_notify_suppresses_duplicate_within_window():
    prior = notify.build_notification(
        _record(error="connection reset at 12:03:44", ts=1000.0)
    )
    recent = [prior]
    # Same job, same failure whose error text differs ONLY by an embedded
    # timestamp; 300s later, 3600s window -> suppressed. This proves the coarse
    # signature (digits stripped) collapses the recurring failure.
    within = _record(error="connection reset at 12:08:59", ts=1300.0)
    assert notify.should_notify(within, recent, min_interval_seconds=3600) is False


def test_should_notify_allows_after_window():
    prior = notify.build_notification(_record(ts=1000.0))
    recent = [prior]
    # Same key, 3601s later, 3600s window -> allowed again.
    after = _record(ts=4601.0)
    assert notify.should_notify(after, recent, min_interval_seconds=3600) is True


def test_should_notify_distinct_jobs_not_deduped():
    prior = notify.build_notification(_record(name="a", ts=1000.0))
    recent = [prior]
    other_job = _record(name="b", ts=1010.0)  # well within the window
    assert notify.should_notify(other_job, recent, min_interval_seconds=3600) is True


def test_should_notify_distinct_errors_not_deduped():
    prior = notify.build_notification(
        _record(name="a", error="connection refused", ts=1000.0)
    )
    recent = [prior]
    other_err = _record(name="a", error="read timeout", ts=1010.0)
    assert notify.should_notify(other_err, recent, min_interval_seconds=3600) is True


def test_should_notify_empty_history_allows():
    assert notify.should_notify(_record(), [], min_interval_seconds=3600) is True


def test_should_notify_handles_iso_timestamps():
    # Mixed ISO strings (as the runner produces) still compare by real seconds.
    prior = notify.build_notification(_record(ts="2026-07-01T09:00:00"))
    within = _record(ts="2026-07-01T09:05:00")   # +300s
    after = _record(ts="2026-07-01T10:30:00")    # +5400s
    assert notify.should_notify(within, [prior], 3600) is False
    assert notify.should_notify(after, [prior], 3600) is True


# --------------------------------------------------------------------------- #
# notify — durable JSONL sink + injected AIEOS poster
# --------------------------------------------------------------------------- #


def test_notify_appends_one_jsonl_line_no_poster_when_url_none():
    calls = []

    def spy(url, json):
        calls.append((url, json))

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        rec = _record(name="nightly", ts=1000.0)
        returned = notify.notify(
            rec,
            notifications_path=str(path),
            poster=spy,
            aieos_url=None,          # AIEOS off -> poster must NOT fire
            now_ts=2000.0,           # deterministic stored timestamp
        )

        # Exactly one durable JSONL line was written.
        records = notify.read_notifications(str(path))
        assert len(records) == 1, records
        stored = records[0]
        assert stored["name"] == "nightly"
        assert stored["ts"] == 2000.0          # injected now_ts won
        assert stored["key"] == notify.notification_key(rec)
        assert returned["ts"] == 2000.0
        # aieos_url was None: the poster spy was never called.
        assert calls == []


def test_notify_calls_poster_once_when_aieos_url_set():
    calls = []

    def spy(url, json):
        calls.append((url, json))

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        rec = _record(name="nightly", status="error", error="boom", ts=1000.0,
                      attempts=3)
        notify.notify(
            rec,
            notifications_path=str(path),
            poster=spy,
            aieos_url="http://127.0.0.1:7824",
            now_ts=2000.0,
        )

        # JSONL sink still got its one line.
        assert len(notify.read_notifications(str(path))) == 1

        # The poster fired exactly once with (url, json) matching the endpoint.
        assert len(calls) == 1, calls
        url, body = calls[0]
        assert url == "http://127.0.0.1:7824/timeline/event"
        # Body matches the AIEOS TimelineEvent shape: required type/session_id/
        # payload (dict), plus an optional numeric ts.
        assert body["type"] == notify.DEFAULT_EVENT_TYPE
        assert body["session_id"] == notify.DEFAULT_SESSION_ID
        assert isinstance(body["payload"], dict)
        assert body["payload"]["name"] == "nightly"
        assert body["payload"]["error"] == "boom"
        assert body["payload"]["attempts"] == 3
        assert body["ts"] == 2000.0


def test_notify_trailing_slash_url_is_normalized():
    calls = []
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        notify.notify(
            _record(),
            notifications_path=str(path),
            poster=lambda u, j: calls.append((u, j)),
            aieos_url="http://127.0.0.1:7824/",   # trailing slash
            now_ts=2000.0,
        )
    assert calls[0][0] == "http://127.0.0.1:7824/timeline/event"


def test_notify_poster_failure_is_swallowed_and_jsonl_still_written():
    def boom(url, json):
        raise RuntimeError("network down")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        # A throwing poster must NOT propagate: JSONL is the reliable sink.
        notify.notify(
            _record(),
            notifications_path=str(path),
            poster=boom,
            aieos_url="http://127.0.0.1:7824",
            now_ts=2000.0,
        )
        assert len(notify.read_notifications(str(path))) == 1


def test_notify_no_poster_still_writes_jsonl():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        notify.notify(_record(), notifications_path=str(path), now_ts=2000.0)
        assert len(notify.read_notifications(str(path))) == 1


def test_read_notifications_respects_limit_and_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "notifications.jsonl"
        # Missing file -> [].
        assert notify.read_notifications(str(path)) == []
        for i in range(5):
            notify.notify(_record(name=f"j{i}"), notifications_path=str(path),
                          now_ts=1000.0 + i)
        assert len(notify.read_notifications(str(path))) == 5
        last2 = notify.read_notifications(str(path), limit=2)
        assert [r["name"] for r in last2] == ["j3", "j4"]
        assert notify.read_notifications(str(path), limit=0) == []


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #


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
