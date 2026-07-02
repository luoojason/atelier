"""Claude Code usage/cost readers backing lite_server's /cc/* endpoints.

Ported from cc-dashboard-app ``aimd/cc`` (``pricing.py`` + ``transcript.py``),
read-only subset in one stdlib-only module: the per-model pricing table (with
its staleness warning), the transcript JSONL parser, and the
(path, mtime, size) parse cache. aimd's FTS/event-search, live hooks,
install/doctor, and every write path are dropped.

Deviation from the source (deliberate, commented at ``_cache_write_split``):
aimd added the legacy ``cache_creation_input_tokens`` total ON TOP of the
granular ``cache_creation`` buckets, double-counting cache writes (tokens AND
dollars) on modern transcripts, which carry both fields on every line. Here
the granular block is authoritative when present; the legacy field is only a
fallback for old transcripts.

Scans $CLAUDE_PROJECTS_DIR (default ~/.claude/projects) for one-level
``<project>/<session-id>.jsonl`` transcripts — the same layout aimd's
find_transcript walked. Nested ``<session>/subagents/*.jsonl`` sidechains are
deliberately excluded: they are not conversations, and folding their usage
into the parent session is the upgrade.

MANUAL TEST (server on :8765):
    curl -s localhost:8765/cc/status
    curl -s 'localhost:8765/cc/usage?limit=5'
    curl -s localhost:8765/cc/usage/<session-id>
    curl -s localhost:8765/cc/aggregate
    curl -s localhost:8765/cc/heatmap
"""

import collections
import datetime
import json
import logging
import os
import pathlib
import threading
import time
from typing import Optional

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Pricing — ported verbatim from aimd/cc/pricing.py
# --------------------------------------------------------------------------- #

PRICING_UPDATED = "2026-06-06"

# Rates in USD per 1,000,000 tokens.
# cache_write_5m  = ephemeral 5-minute cache creation
# cache_write_1h  = ephemeral 1-hour cache creation
# cache_read      = cache read
PRICING: dict[str, dict[str, float]] = {
    # Claude 4 family. Opus 4.5+ is $5/$25 (not the old Claude-3 $15/$75 Opus rate).
    "claude-opus-4-8":               {"input":  5.0,  "output": 25.0,  "cache_write_5m":  6.25, "cache_write_1h": 10.0,  "cache_read": 0.50},
    "claude-opus-4-7":               {"input":  5.0,  "output": 25.0,  "cache_write_5m":  6.25, "cache_write_1h": 10.0,  "cache_read": 0.50},
    "claude-opus-4-6":               {"input":  5.0,  "output": 25.0,  "cache_write_5m":  6.25, "cache_write_1h": 10.0,  "cache_read": 0.50},
    "claude-opus-4-5":               {"input":  5.0,  "output": 25.0,  "cache_write_5m":  6.25, "cache_write_1h": 10.0,  "cache_read": 0.50},
    "claude-sonnet-4-6":             {"input":  3.0,  "output": 15.0,  "cache_write_5m":  3.75, "cache_write_1h":  6.0,  "cache_read": 0.30},
    "claude-sonnet-4-5-20250929":    {"input":  3.0,  "output": 15.0,  "cache_write_5m":  3.75, "cache_write_1h":  6.0,  "cache_read": 0.30},
    "claude-haiku-4-5":              {"input":  1.0,  "output":  5.0,  "cache_write_5m":  1.25, "cache_write_1h":  2.0,  "cache_read": 0.10},
    "claude-haiku-4-5-20251001":     {"input":  1.0,  "output":  5.0,  "cache_write_5m":  1.25, "cache_write_1h":  2.0,  "cache_read": 0.10},
    # Claude 3.x fallbacks
    "claude-3-5-sonnet-20241022":    {"input":  3.0,  "output": 15.0,  "cache_write_5m":  3.75, "cache_write_1h":  6.0,  "cache_read": 0.30},
    "claude-3-opus-20240229":        {"input": 15.0,  "output": 75.0,  "cache_write_5m": 18.75, "cache_write_1h": 30.0,  "cache_read": 1.50},
    "claude-3-haiku-20240307":       {"input":  0.25, "output":  1.25, "cache_write_5m":  0.30, "cache_write_1h":  0.50, "cache_read": 0.03},
}

_SONNET_FALLBACK = PRICING["claude-sonnet-4-6"]

_warned_stale = False
_warned_unknown: set[str] = set()


def _check_staleness() -> None:
    global _warned_stale
    if _warned_stale:
        return
    updated = datetime.date.fromisoformat(PRICING_UPDATED)
    age = (datetime.date.today() - updated).days
    if age > 90:
        log.warning("cc_usage.py pricing table has not been updated in %d days — costs may be inaccurate", age)
        _warned_stale = True


def rates_for(model: str) -> dict[str, float]:
    """Return rate dict for *model*, falling back to sonnet rates with a one-time warning."""
    _check_staleness()
    # Normalize: strip trailing revision suffixes like -20250929 if exact key not found
    if model in PRICING:
        return PRICING[model]
    # Try prefix match (e.g. "claude-sonnet-4-6-20260101" → "claude-sonnet-4-6")
    for key in PRICING:
        if model.startswith(key):
            return PRICING[key]
    if model not in _warned_unknown:
        log.warning("Unknown model %r — using sonnet-4-6 rates as fallback", model)
        _warned_unknown.add(model)
    return _SONNET_FALLBACK


def _cache_write_split(usage: dict) -> tuple:
    """(5m_tokens, 1h_tokens) cache-write split for one usage block.

    DEVIATION from aimd: its ``or``-fallback re-added the legacy
    ``cache_creation_input_tokens`` total whenever the granular 5m bucket was
    0, double-charging 1h cache writes on modern transcripts (which carry BOTH
    the legacy total and the granular ``cache_creation`` block on every line).
    The granular block wins when present; the legacy field (assumed 5m, its
    historical meaning) only fills in when the granular block is absent.
    """
    cw_data = usage.get("cache_creation") or {}
    if cw_data:
        return (
            cw_data.get("ephemeral_5m_input_tokens", 0),
            cw_data.get("ephemeral_1h_input_tokens", 0),
        )
    return (usage.get("cache_creation_input_tokens", 0), 0)


def cost_usd(model: str, usage: dict) -> float:
    """Compute total USD cost for a single assistant turn's usage block."""
    r = rates_for(model)
    inp = usage.get("input_tokens", 0)
    out = usage.get("output_tokens", 0)
    cw_5m, cw_1h = _cache_write_split(usage)
    cr = usage.get("cache_read_input_tokens", 0)

    return (
        inp   * r["input"]           / 1_000_000
        + out * r["output"]          / 1_000_000
        + cw_5m * r["cache_write_5m"] / 1_000_000
        + cw_1h * r["cache_write_1h"] / 1_000_000
        + cr  * r["cache_read"]      / 1_000_000
    )


# --------------------------------------------------------------------------- #
# Transcript parsing — ported from aimd/cc/transcript.py
# --------------------------------------------------------------------------- #

def _projects_dir() -> pathlib.Path:
    """The transcripts root, env-overridable at CALL time (tests point it at tmp)."""
    override = os.getenv("CLAUDE_PROJECTS_DIR")
    if override:
        return pathlib.Path(override).expanduser()
    return pathlib.Path.home() / ".claude" / "projects"


# Cache: path -> ((path, mtime, size), parsed result). Ported from aimd, with
# an LRU cap on top: real projects dirs hold 1000+ transcripts, so unbounded
# growth in a long-lived server adds up (and entries for deleted/rotated
# transcripts would never be evicted). Entries hold only the usage events
# (never raw text). Locked because /cc readers run in asyncio.to_thread.
_CACHE_MAX = 512
_cache: "collections.OrderedDict[str, tuple[tuple, dict]]" = collections.OrderedDict()
_cache_lock = threading.Lock()


def find_transcript(session_id: str) -> Optional[pathlib.Path]:
    """Find the .jsonl file for a CC session id (bare, no 'cc:' prefix)."""
    root = _projects_dir()
    if not root.exists():
        return None
    target = f"{session_id}.jsonl"
    try:
        proj_dirs = list(root.iterdir())
    except OSError:
        return None
    for proj_dir in proj_dirs:
        if not proj_dir.is_dir():
            continue
        candidate = proj_dir / target
        if candidate.exists():
            return candidate
    return None


def _cache_key(path: pathlib.Path) -> tuple:
    st = path.stat()
    return (str(path), st.st_mtime, st.st_size)


def parse_usage(path: pathlib.Path) -> dict:
    """Parse a transcript JSONL and return aggregated token/cost data.

    Result shape:
    {
      "by_model": [{"model": str, "input": int, "output": int, ...tokens..., "usd": float}],
      "totals": {"input": int, "output": int, "cache_write": int, "cache_read": int, "usd": float},
      "events": [{"ts": str, "model": str, "usage": {...}, "usd": float}]
    }
    Memoized on (path, mtime, size) to avoid re-reading unchanged files.
    """
    key = _cache_key(path)
    with _cache_lock:
        cache_entry = _cache.get(str(path))
        if cache_entry and cache_entry[0] == key:
            _cache.move_to_end(str(path))
            return cache_entry[1]

    by_model: dict[str, dict] = {}
    events: list[dict] = []

    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Hardening beyond aimd: a valid-JSON non-object line (e.g. a bare
            # array) must not raise and zero out the whole session.
            if not isinstance(obj, dict):
                continue
            if obj.get("type") != "assistant":
                continue
            message = obj.get("message")
            if not isinstance(message, dict):
                continue
            usage = message.get("usage")
            if not isinstance(usage, dict) or not usage:
                continue
            model = message.get("model") or obj.get("model") or "unknown"
            ts = obj.get("timestamp") or ""
            turn_usd = cost_usd(model, usage)

            events.append({"ts": ts, "model": model, "usage": usage, "usd": turn_usd})

            agg = by_model.setdefault(model, {
                "model": model, "input": 0, "output": 0,
                "cache_write": 0, "cache_read": 0, "usd": 0.0,
            })
            agg["input"]  += usage.get("input_tokens", 0)
            agg["output"] += usage.get("output_tokens", 0)
            # DEVIATION from aimd (see _cache_write_split): granular buckets
            # win; aimd summed granular + legacy and double-counted.
            agg["cache_write"] += sum(_cache_write_split(usage))
            agg["cache_read"] += usage.get("cache_read_input_tokens", 0)
            agg["usd"] += turn_usd

    totals: dict = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "usd": 0.0}
    for m in by_model.values():
        totals["input"]       += m["input"]
        totals["output"]      += m["output"]
        totals["cache_write"] += m["cache_write"]
        totals["cache_read"]  += m["cache_read"]
        totals["usd"]         += m["usd"]

    result = {"by_model": list(by_model.values()), "totals": totals, "events": events}
    with _cache_lock:
        _cache[str(path)] = (key, result)
        _cache.move_to_end(str(path))
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return result


def _safe_parse(path: pathlib.Path) -> Optional[dict]:
    """parse_usage that never raises (corrupt file / vanished file -> None)."""
    try:
        return parse_usage(path)
    except Exception as exc:  # noqa: BLE001 - degrade, never 500 an endpoint
        log.warning("Failed to parse transcript %s: %s", path, exc)
        return None


# --------------------------------------------------------------------------- #
# Endpoint-shape aggregation (new for Atelier; consumes the ported parser)
# --------------------------------------------------------------------------- #

# A session whose transcript was written within this window counts as "active".
_ACTIVE_WINDOW_S = 300


def _iter_transcripts():
    """Yield (project_name, path, stat) for every one-level session transcript.

    Never raises: unreadable dirs/files are skipped. Deterministic order
    (sorted names) so shapes are stable across calls.
    """
    root = _projects_dir()
    try:
        proj_dirs = sorted(d for d in root.iterdir() if d.is_dir())
    except OSError:
        return
    for proj_dir in proj_dirs:
        try:
            files = sorted(proj_dir.glob("*.jsonl"))
        except OSError:
            continue
        for path in files:
            try:
                st = path.stat()
            except OSError:
                continue
            yield proj_dir.name, path, st


def _parse_ts(ts: str) -> Optional[datetime.datetime]:
    """Transcript ISO timestamp ('...Z') -> aware LOCAL datetime, or None."""
    try:
        dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return None
    return dt.astimezone()


def _event_tokens(usage: dict) -> int:
    """Total tokens for one usage block: input + output + cache read + cache write."""
    return (
        usage.get("input_tokens", 0)
        + usage.get("output_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + sum(_cache_write_split(usage))
    )


def _window_events(window_days: int):
    """Yield (local_dt, model, usage, usd) for events in the last *window_days*.

    PERF: files whose mtime predates the window are skipped WITHOUT parsing —
    an event's timestamp can never exceed its file's mtime — so a cold hit
    only parses transcripts actually touched inside the window, and the
    (path, mtime, size) cache makes warm hits stat-only.
    """
    now_local = datetime.datetime.now().astimezone()
    cutoff = (now_local - datetime.timedelta(days=max(1, window_days) - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    cutoff_ts = cutoff.timestamp()
    for _project, path, st in _iter_transcripts():
        if st.st_mtime < cutoff_ts:
            continue
        parsed = _safe_parse(path)
        if not parsed:
            continue
        for ev in parsed["events"]:
            dt = _parse_ts(ev.get("ts") or "")
            if dt is None or dt < cutoff:
                continue
            yield dt, ev.get("model") or "unknown", ev.get("usage") or {}, ev.get("usd", 0.0)


# ---- fixed empty shapes (the never-500 degradation targets) ---------------- #

def empty_status() -> dict:
    return {
        "active": False,
        "conversations": 0,
        "projects": 0,
        "storage_mb": 0.0,
        "this_month_usd": 0.0,
        "this_week_tokens": 0,
    }


def empty_session_detail(session_id: str = "") -> dict:
    return {
        "session_id": session_id,
        "totals": {"usd": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
        "by_model": [],
        "timeline": [],
    }


def empty_aggregate() -> dict:
    return {
        "daily": [],
        "by_model": [],
        "cache": {"read": 0, "write": 0, "saved_usd": 0.0, "pct": 0.0},
        "peak_hours": [0] * 24,
    }


def empty_heatmap() -> dict:
    return {"days": [], "hours": [0] * 24}


# ---- endpoint shapes -------------------------------------------------------- #

def status_summary() -> dict:
    """GET /cc/status shape: fleet counts + this-month USD + this-week tokens.

    Counting/stat is a pure directory walk; only files touched inside the
    month/week windows get parsed (same mtime prefilter as _window_events).
    """
    now = time.time()
    now_local = datetime.datetime.now().astimezone()
    month_start = now_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    week_cutoff = now_local - datetime.timedelta(days=7)
    parse_cutoff = min(month_start.timestamp(), week_cutoff.timestamp())

    conversations = 0
    projects: set[str] = set()
    total_bytes = 0
    active = False
    month_usd = 0.0
    week_tokens = 0

    for project, path, st in _iter_transcripts():
        conversations += 1
        projects.add(project)
        total_bytes += st.st_size
        if now - st.st_mtime < _ACTIVE_WINDOW_S:
            active = True
        if st.st_mtime < parse_cutoff:
            continue
        parsed = _safe_parse(path)
        if not parsed:
            continue
        for ev in parsed["events"]:
            dt = _parse_ts(ev.get("ts") or "")
            if dt is None:
                continue
            if dt >= month_start:
                month_usd += ev.get("usd", 0.0)
            if dt >= week_cutoff:
                week_tokens += _event_tokens(ev.get("usage") or {})

    return {
        "active": active,
        "conversations": conversations,
        "projects": len(projects),
        "storage_mb": round(total_bytes / (1024 * 1024), 1),
        "this_month_usd": round(month_usd, 4),
        "this_week_tokens": week_tokens,
    }


def recent_sessions(limit: int = 20) -> list:
    """GET /cc/usage shape: the *limit* most recently written sessions.

    Only the returned files are parsed (mtime sort needs stats alone), so a
    big projects dir costs limit-many parses, not a full sweep.
    """
    entries = sorted(_iter_transcripts(), key=lambda e: e[2].st_mtime, reverse=True)
    out: list[dict] = []
    for project, path, st in entries[: max(0, limit)]:
        parsed = _safe_parse(path) or {
            "by_model": [],
            "totals": {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "usd": 0.0},
            "events": [],
        }
        totals = parsed["totals"]
        events = parsed["events"]
        top = max(
            parsed["by_model"],
            key=lambda m: m["input"] + m["output"] + m["cache_read"] + m["cache_write"],
            default=None,
        )
        if events:
            started = events[0].get("ts") or ""
        else:
            started = (
                datetime.datetime.fromtimestamp(st.st_mtime)
                .astimezone()
                .isoformat(timespec="seconds")
            )
        out.append({
            "session_id": path.stem,
            "project": project,
            "model": top["model"] if top else "",
            "total_tokens": (
                totals["input"] + totals["output"]
                + totals["cache_read"] + totals["cache_write"]
            ),
            "total_usd": round(totals["usd"], 6),
            "started_at": started,
            "turns": len(events),
        })
    return out


def session_detail(session_id: str) -> Optional[dict]:
    """GET /cc/usage/{id} shape, or None when no transcript exists for the id.

    The caller MUST have validated *session_id* (lite_server enforces
    ^[A-Za-z0-9_-]+$) — find_transcript only ever joins it as a filename.
    """
    path = find_transcript(session_id)
    if path is None:
        return None
    parsed = _safe_parse(path)
    if not parsed:
        # The transcript exists but is unreadable: a zero shape, not a 404.
        return empty_session_detail(session_id)
    t = parsed["totals"]
    return {
        "session_id": session_id,
        "totals": {
            "usd": round(t["usd"], 6),
            "input": t["input"],
            "output": t["output"],
            "cache_read": t["cache_read"],
            "cache_write": t["cache_write"],
        },
        "by_model": [
            {
                "model": m["model"],
                "tokens": m["input"] + m["output"] + m["cache_read"] + m["cache_write"],
                "usd": round(m["usd"], 6),
            }
            for m in parsed["by_model"]
        ],
        "timeline": [
            {
                "ts": ev.get("ts") or "",
                "tokens": _event_tokens(ev.get("usage") or {}),
                "usd": round(ev.get("usd", 0.0), 6),
            }
            for ev in parsed["events"]
        ],
    }


def aggregate_summary(window_days: int = 30) -> dict:
    """GET /cc/aggregate shape over the last *window_days* local days.

    cache.saved_usd = what the cache-read tokens would have cost as fresh
    input minus what they cost as reads (per that event's model rates);
    cache.pct = share of all prompt-side tokens (input + reads + writes)
    served from cache.
    """
    daily: dict[str, list] = {}
    by_model: dict[str, list] = {}
    hours = [0] * 24
    cache_read_tokens = 0
    cache_write_tokens = 0
    input_tokens = 0
    saved_usd = 0.0

    for dt, model, usage, usd in _window_events(window_days):
        tokens = _event_tokens(usage)
        day = daily.setdefault(dt.date().isoformat(), [0, 0.0])
        day[0] += tokens
        day[1] += usd
        agg = by_model.setdefault(model, [0, 0.0])
        agg[0] += tokens
        agg[1] += usd
        hours[dt.hour] += tokens
        cr = usage.get("cache_read_input_tokens", 0)
        cache_read_tokens += cr
        cache_write_tokens += sum(_cache_write_split(usage))
        input_tokens += usage.get("input_tokens", 0)
        r = rates_for(model)
        saved_usd += cr * (r["input"] - r["cache_read"]) / 1_000_000

    prompt_tokens = input_tokens + cache_read_tokens + cache_write_tokens
    return {
        "daily": [
            {"date": d, "tokens": v[0], "usd": round(v[1], 6)}
            for d, v in sorted(daily.items())
        ],
        "by_model": [
            {"model": m, "tokens": v[0], "usd": round(v[1], 6)}
            for m, v in sorted(by_model.items(), key=lambda kv: kv[1][0], reverse=True)
        ],
        "cache": {
            "read": cache_read_tokens,
            "write": cache_write_tokens,
            "saved_usd": round(saved_usd, 6),
            "pct": round(cache_read_tokens / prompt_tokens * 100, 1) if prompt_tokens else 0.0,
        },
        "peak_hours": hours,
    }


def heatmap_summary(window_days: int = 90) -> dict:
    """GET /cc/heatmap shape: per-day tokens/usd + tokens per local hour-of-day."""
    days: dict[str, list] = {}
    hours = [0] * 24
    for dt, _model, usage, usd in _window_events(window_days):
        tokens = _event_tokens(usage)
        day = days.setdefault(dt.date().isoformat(), [0, 0.0])
        day[0] += tokens
        day[1] += usd
        hours[dt.hour] += tokens
    return {
        "days": [
            {"date": d, "tokens": v[0], "usd": round(v[1], 6)}
            for d, v in sorted(days.items())
        ],
        "hours": hours,
    }
