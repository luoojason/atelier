"""Assert-based tests for the overnight run digest.

Runs under the SYSTEM python3 (no agency_swarm / pydantic / apscheduler): it
loads the pure ``scheduler/digest.py`` module directly by file path, so the
import chain is stdlib-only. The one test that exercises the real vault write
points ``vault_core`` at a TemporaryDirectory, never the operator's vault.

    python3 tests/test_digest.py
"""

import importlib.util
import os
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_digest = _load("digest", "scheduler/digest.py")

summarize_runs = _digest.summarize_runs
format_digest = _digest.format_digest
run_digest = _digest.run_digest
NO_RUNS_LINE = _digest.NO_RUNS_LINE


def _rec(name, ts, status, status_code, tokens, cost, latency_ms, attempts, error):
    """Build a ledger-shaped record (matches run_store.RECORD_FIELDS)."""
    return {
        "name": name,
        "ts": ts,
        "status": status,
        "status_code": status_code,
        "tokens": tokens,
        "cost": cost,
        "latency_ms": latency_ms,
        "attempts": attempts,
        "error": error,
        "response_excerpt": "r",
    }


# A mixed fixture: 2 ok, 2 failed; varied costs, tokens, latencies.
_RECORDS = [
    _rec("alpha", "2026-07-01T07:00:00", "ok", 200, 100, 0.0010, 500, 1, None),
    _rec("beta", "2026-07-01T07:05:00", "ok", 200, 200, 0.0020, 1500, 1, None),
    _rec("gamma", "2026-07-01T07:10:00", "error", 0, 0, 0.0000, 3000, 3, "connection reset"),
    _rec("delta", "2026-07-01T07:15:00", "http-500", 500, 50, 0.0005, 200, 1, "boom"),
]


def test_summarize_totals_slowest_failures():
    s = summarize_runs(_RECORDS)
    assert s["total"] == 4, s
    assert s["ok"] == 2, s
    assert s["failed"] == 2, s
    assert abs(s["total_cost"] - 0.0035) < 1e-9, s["total_cost"]
    assert s["total_tokens"] == 350, s["total_tokens"]

    # slowest is descending by latency and capped at SLOWEST_N=5 (4 here):
    # gamma (3000) > beta (1500) > alpha (500) > delta (200).
    slowest_names = [row["name"] for row in s["slowest"]]
    assert slowest_names == ["gamma", "beta", "alpha", "delta"], slowest_names
    assert s["slowest"][0]["latency_ms"] == 3000, s["slowest"][0]

    # failures carry name + error for exactly the non-ok records
    fail_names = sorted(f["name"] for f in s["failures"])
    assert fail_names == ["delta", "gamma"], fail_names
    errmap = {f["name"]: f["error"] for f in s["failures"]}
    assert errmap["gamma"] == "connection reset", errmap
    assert errmap["delta"] == "boom", errmap
    print("ok test_summarize_totals_slowest_failures")


def test_summarize_since_ts_filter():
    # Only records at/after 07:10 survive: gamma + delta (both failures).
    s = summarize_runs(_RECORDS, since_ts="2026-07-01T07:10:00")
    assert s["total"] == 2, s
    assert s["ok"] == 0, s
    assert s["failed"] == 2, s
    names = sorted(f["name"] for f in s["failures"])
    assert names == ["delta", "gamma"], names
    # a since_ts after every record filters everything out
    empty = summarize_runs(_RECORDS, since_ts="2026-07-02T00:00:00")
    assert empty["total"] == 0, empty
    print("ok test_summarize_since_ts_filter")


def test_summarize_empty_returns_zero():
    for records in ([], None):
        s = summarize_runs(records)
        assert s["total"] == 0, s
        assert s["ok"] == 0 and s["failed"] == 0, s
        assert s["total_cost"] == 0, s
        assert s["total_tokens"] == 0, s
        assert s["slowest"] == [] and s["failures"] == [], s
    print("ok test_summarize_empty_returns_zero")


def test_summarize_bad_ledger_skips_non_dicts_never_raises():
    # A corrupt/foreign JSONL line decodes to a valid-JSON *non-object*
    # (int / str / null / list). read_records hands those straight through, so
    # summarize_runs must skip them and never raise — one bad line can't crash
    # the whole ~07:00 overnight digest.
    junk = [1, "oops", None, [], True, 3.14]
    s = summarize_runs(junk)  # must not raise
    assert s["total"] == 0, s
    assert s["ok"] == 0 and s["failed"] == 0, s
    assert s["total_cost"] == 0, s
    assert s["total_tokens"] == 0, s
    assert s["slowest"] == [] and s["failures"] == [], s

    # A lone valid dict amid the junk is the only thing counted; missing keys
    # must not raise either (no status/cost/tokens/latency present).
    s2 = summarize_runs([1, "oops", None, {}])
    assert s2["total"] == 1, s2
    assert s2["ok"] == 0 and s2["failed"] == 1, s2
    assert s2["total_cost"] == 0 and s2["total_tokens"] == 0, s2

    # Same robustness with a since_ts filter active (the other access path):
    # junk is dropped, only the real at/after-07:10 records survive.
    mixed = [1, "oops", None, []] + _RECORDS
    s3 = summarize_runs(mixed, since_ts="2026-07-01T07:10:00")  # must not raise
    assert s3["total"] == 2, s3
    assert s3["failed"] == 2, s3
    names = sorted(f["name"] for f in s3["failures"])
    assert names == ["delta", "gamma"], names
    print("ok test_summarize_bad_ledger_skips_non_dicts_never_raises")


def test_format_digest_full_body():
    body = format_digest(summarize_runs(_RECORDS), "2026-07-01")
    assert "# Overnight Run Digest — 2026-07-01" in body
    assert "- Total runs: 4" in body
    assert "- OK: 2" in body
    assert "- Failed: 2" in body
    assert "- Total cost: $0.0035" in body
    assert "- Total tokens: 350" in body
    # slowest section, gamma first with its latency
    assert "## Slowest runs" in body
    assert "- gamma — 3,000 ms" in body
    # failures section renders name + error
    assert "## Failures" in body
    assert "- gamma — connection reset" in body
    assert "- delta — boom" in body
    # NOT the misleading empty-window sentinel
    assert NO_RUNS_LINE not in body
    print("ok test_format_digest_full_body")


def test_format_digest_empty_emits_no_runs_not_zero():
    body = format_digest(summarize_runs([]), "2026-07-01")
    assert "# Overnight Run Digest — 2026-07-01" in body
    # the explicit sentinel is present...
    assert NO_RUNS_LINE in body
    # ...and NO fake zero-summary counts / cost lines are emitted
    assert "Total runs:" not in body, body
    assert "Total cost:" not in body, body
    assert "## Slowest runs" not in body, body
    assert "## Failures" not in body, body
    print("ok test_format_digest_empty_emits_no_runs_not_zero")


def test_run_digest_injected_write_note_captures_call():
    # Inject a fake write_note: no real vault write, and we can inspect the call.
    captured = {}

    def fake_write_note(folder, title, body, tags=None, **kwargs):
        captured.update(folder=folder, title=title, body=body, tags=tags)
        return f"/fake/{folder}/{title}.md"

    path = run_digest("/does/not/matter", _RECORDS, "2026-07-01",
                      write_note=fake_write_note)
    assert path == "/fake/Sessions/Overnight Run Digest 2026-07-01.md", path
    assert captured["folder"] == "Sessions", captured
    assert captured["title"] == "Overnight Run Digest 2026-07-01", captured
    assert "- Total runs: 4" in captured["body"], captured["body"]
    assert "- gamma — connection reset" in captured["body"], captured["body"]
    assert "digest" in captured["tags"], captured["tags"]
    print("ok test_run_digest_injected_write_note_captures_call")


def test_run_digest_empty_ledger_still_writes_no_runs_note():
    captured = {}

    def fake_write_note(folder, title, body, tags=None, **kwargs):
        captured.update(folder=folder, title=title, body=body)
        return "/fake/note.md"

    # Guard: a rotated/empty ledger yields [] but still produces a real note
    # whose body carries the explicit no-runs line, not a zero-summary.
    run_digest("/vault", [], "2026-07-01", write_note=fake_write_note)
    assert NO_RUNS_LINE in captured["body"], captured
    assert "Total runs:" not in captured["body"], captured
    print("ok test_run_digest_empty_ledger_still_writes_no_runs_note")


def test_run_digest_real_write_note_tempdir():
    # Exercise the REAL vault_core.write_note against a TemporaryDirectory, so
    # the full path (frontmatter + index.md/log.md catalog) is covered with zero
    # risk to the operator's vault.
    saved_env = os.environ.get("OBSIDIAN_VAULT")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = run_digest(tmp, _RECORDS, "2026-07-01")  # no injection
            p = Path(path)
            assert p.is_file(), path
            # write_note resolve()s paths; compare resolved roots (macOS maps
            # /var -> /private/var, so a raw startswith would spuriously fail).
            tmp_res = Path(tmp).resolve()
            assert tmp_res in p.resolve().parents, (path, tmp_res)
            assert p.name == "Overnight Run Digest 2026-07-01.md", p.name

            text = p.read_text(encoding="utf-8")
            # frontmatter written by write_note
            assert "title: Overnight Run Digest 2026-07-01" in text, text
            # digest content present
            assert "- Total runs: 4" in text, text
            assert "## Failures" in text, text

            # cataloged (round #6): index.md + log.md were created/updated
            index = (Path(tmp) / "index.md").read_text(encoding="utf-8")
            assert "Overnight Run Digest 2026-07-01" in index, index
            log = (Path(tmp) / "log.md").read_text(encoding="utf-8")
            assert "Overnight Run Digest 2026-07-01" in log, log
    finally:
        if saved_env is None:
            os.environ.pop("OBSIDIAN_VAULT", None)
        else:
            os.environ["OBSIDIAN_VAULT"] = saved_env
    print("ok test_run_digest_real_write_note_tempdir")


def _run():
    tests = [
        test_summarize_totals_slowest_failures,
        test_summarize_since_ts_filter,
        test_summarize_empty_returns_zero,
        test_summarize_bad_ledger_skips_non_dicts_never_raises,
        test_format_digest_full_body,
        test_format_digest_empty_emits_no_runs_not_zero,
        test_run_digest_injected_write_note_captures_call,
        test_run_digest_empty_ledger_still_writes_no_runs_note,
        test_run_digest_real_write_note_tempdir,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
