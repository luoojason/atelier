"""Overnight run digest: summarize the scheduler ledger into a vault note.

The scheduler appends one structured record per fire to a JSONL ledger (see
``scheduler/run_store.py``). This module turns a list of those records into a
human-readable daily digest and files it into the Obsidian vault as a dated
note (cataloged into index.md / log.md by ``vault_core.write_note`` — round #6).

Everything that computes the digest is a plain function over stdlib types
(``summarize_runs`` / ``format_digest``) with NO dependency on agency_swarm,
pydantic, apscheduler, or the vault-writing code, so it imports and unit-tests
under a bare ``python3``. Only ``run_digest`` touches the vault, and it accepts
an injectable ``write_note`` so tests never write to the real vault.

Intended use (from a ~07:00 daily scheduled job):

    from scheduler.run_store import read_records
    from scheduler.digest import run_digest

    records = read_records(None)            # None -> the SWARM_RUNS_JSONL ledger
    run_digest(vault_root, records, "2026-07-01", since_ts="2026-06-30T00:00:00")

A missing or freshly rotated ledger yields ``[]``; ``run_digest`` still writes a
note whose body carries an explicit "no runs" line rather than a misleading
all-zero summary.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

# How many of the slowest runs to surface in the digest.
SLOWEST_N = 5

# Vault placement + labeling for the produced note.
DEFAULT_FOLDER = "Sessions"
TITLE_PREFIX = "Overnight Run Digest"
DEFAULT_TAGS = ("digest", "scheduler", "operations")

# The explicit sentinel line emitted when the window contains no runs, so the
# digest never reads like a real "0 runs / $0.00" summary.
NO_RUNS_LINE = "No runs in the window."


def _to_number(value):
    """Coerce *value* to a number for summing; non-numbers count as 0.

    ``bool`` is treated as 0 (a stray True/False must not skew a total), and
    ``None`` / unparseable strings fall back to 0 rather than raising.
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def _has_numeric_latency(record) -> bool:
    """True when a record carries a real numeric latency (not None / not bool)."""
    value = record.get("latency_ms")
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def summarize_runs(records, since_ts: Optional[str] = None) -> dict:
    """Reduce ledger *records* to a summary dict.

    When ``since_ts`` is given, only records whose ``ts`` sorts at or after it
    are counted (ISO timestamps compare lexicographically). Records without a
    ``ts`` are treated as older than any real ``since_ts`` and dropped.

    Returns::

        {
          "total": int,
          "ok": int,
          "failed": int,               # total - ok (every non-"ok" status)
          "total_cost": float|int,
          "total_tokens": int,
          "slowest": [{"name", "latency_ms"}, ...],   # desc, up to SLOWEST_N
          "failures": [{"name", "error"}, ...],       # every non-"ok" record
        }
    """
    records = records or []
    # Drop any non-dict record up front: a corrupt/foreign JSONL line can decode
    # to a valid-JSON non-object (e.g. 1, "x", null, []) which read_records hands
    # straight through. Guarding here keeps a single bad line from crashing the
    # whole overnight digest (every access below assumes a dict), so the digest
    # degrades instead of raising.
    records = [r for r in records if isinstance(r, dict)]
    if since_ts is not None:
        filtered = [r for r in records if str(r.get("ts", "")) >= since_ts]
    else:
        filtered = list(records)

    total = len(filtered)
    ok = sum(1 for r in filtered if r.get("status") == "ok")
    failed = total - ok

    total_cost = sum(_to_number(r.get("cost")) for r in filtered)
    total_tokens = int(sum(_to_number(r.get("tokens")) for r in filtered))

    latency_rows = [
        {"name": r.get("name"), "latency_ms": int(_to_number(r.get("latency_ms")))}
        for r in filtered
        if _has_numeric_latency(r)
    ]
    slowest = sorted(
        latency_rows, key=lambda row: row["latency_ms"], reverse=True
    )[:SLOWEST_N]

    failures = [
        {"name": r.get("name"), "error": r.get("error")}
        for r in filtered
        if r.get("status") != "ok"
    ]

    return {
        "total": total,
        "ok": ok,
        "failed": failed,
        "total_cost": total_cost,
        "total_tokens": total_tokens,
        "slowest": slowest,
        "failures": failures,
    }


def _fmt_cost(cost) -> str:
    """Format a cost as a fixed 4-decimal dollar amount (no leading ``$``)."""
    return f"{float(_to_number(cost)):.4f}"


def format_digest(summary, date: str) -> str:
    """Render *summary* as a Markdown digest body dated *date*.

    When ``summary["total"] == 0`` the body is the header plus an explicit
    :data:`NO_RUNS_LINE`; the counts / cost lines are omitted so an empty window
    can never be mistaken for a real zero-cost summary.
    """
    summary = summary or {}
    lines = [f"# {TITLE_PREFIX} — {date}", ""]

    total = summary.get("total", 0)
    if not total:
        lines.append(NO_RUNS_LINE)
        return "\n".join(lines) + "\n"

    lines += [
        f"- Total runs: {total}",
        f"- OK: {summary.get('ok', 0)}",
        f"- Failed: {summary.get('failed', 0)}",
        f"- Total cost: ${_fmt_cost(summary.get('total_cost', 0))}",
        f"- Total tokens: {int(_to_number(summary.get('total_tokens', 0))):,}",
        "",
    ]

    slowest = summary.get("slowest") or []
    if slowest:
        lines.append("## Slowest runs")
        lines.append("")
        for row in slowest:
            name = row.get("name") or "(unnamed)"
            latency = int(_to_number(row.get("latency_ms")))
            lines.append(f"- {name} — {latency:,} ms")
        lines.append("")

    failures = summary.get("failures") or []
    if failures:
        lines.append("## Failures")
        lines.append("")
        for row in failures:
            name = row.get("name") or "(unnamed)"
            error = row.get("error")
            error = " ".join(str(error).split()) if error else "(no error message)"
            lines.append(f"- {name} — {error}")
        lines.append("")

    return "\n".join(lines).rstrip("\n") + "\n"


def _resolve_write_note(vault_root):
    """Load the real ``vault_core.write_note`` and point it at *vault_root*.

    ``vault_core`` is loaded by file path so importing THIS module never drags
    in ``shared_tools/__init__.py`` (which imports agency_swarm). ``vault_core``
    itself is stdlib-only, so this works under a bare ``python3``. The vault root
    is honored by setting ``OBSIDIAN_VAULT``, which ``write_note`` reads.
    """
    import importlib.util

    repo_root = Path(__file__).resolve().parents[1]
    vc_path = repo_root / "shared_tools" / "vault_core.py"
    spec = importlib.util.spec_from_file_location("openswarm_vault_core", vc_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if vault_root is not None:
        os.environ["OBSIDIAN_VAULT"] = str(vault_root)
    return module.write_note


def run_digest(vault_root, records, date: str, *, write_note=None,
               since_ts: Optional[str] = None, folder: str = DEFAULT_FOLDER) -> str:
    """Summarize *records* and file a dated digest note into the vault.

    Returns the absolute path of the written note. ``write_note`` is injectable
    (defaults to the real ``vault_core.write_note`` pointed at *vault_root*) so
    tests can capture the call — or pass a real one against a tempdir — without
    ever writing to the operator's vault. Cataloging (index.md / log.md) happens
    inside ``write_note`` (round #6). An empty/rotated ledger (``records == []``)
    still produces a note carrying the explicit "no runs" line.
    """
    summary = summarize_runs(records, since_ts=since_ts)
    body = format_digest(summary, date)
    title = f"{TITLE_PREFIX} {date}"

    writer = write_note if write_note is not None else _resolve_write_note(vault_root)
    return writer(folder=folder, title=title, body=body, tags=list(DEFAULT_TAGS))
