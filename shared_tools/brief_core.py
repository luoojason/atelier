"""Pure functions for a structured task brief and its acceptance criteria.

A brief records what a run is trying to achieve: the goal, an optional output
format, things that must be included or avoided, and explicit done_criteria. The
point is that a later run (or a specialist an agent hands off to) can reload the
exact intent instead of re-deriving it from a fuzzy chat history.

Briefs are persisted into the SAME append-only memory JSON that memory_core
owns, tagged kind="brief" and keyed by project, so the latest brief for a
project can be recalled at the start of a task. We reuse memory_core._load so
the on-disk format stays byte-for-byte compatible with the rest of the store.

No dependency on agency_swarm or pydantic: CaptureBrief.py / ReadBrief.py wrap
these functions, and the tests import only these pure helpers + stdlib.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

# Reuse the memory store's loader so briefs live in the identical JSON list.
# In production this resolves via the shared_tools package. Under the system
# python3 test (which has no agency_swarm, so importing the shared_tools package
# fails) the loader is imported directly from memory_core, which the test puts
# on sys.path.
try:  # pragma: no cover - exercised by both paths across environments
    from shared_tools.memory_core import _load
except ImportError:  # pragma: no cover
    from memory_core import _load


def _norm(value) -> str | None:
    """Strip a string; collapse empty/None to None."""
    return (value or "").strip() or None


def _clean_list(items) -> list:
    """Coerce an optional iterable of strings into a list of non-empty items."""
    if not items:
        return []
    return [s for s in (str(x).strip() for x in items) if s]


def build_brief(goal, fmt=None, must_include=None, must_avoid=None,
                done_criteria=None, project=None) -> dict:
    """Build a structured brief dict.

    Only `goal` carries required intent; every other field is optional. The
    three lists default to []. Empty strings normalize to None (fmt, project).
    """
    return {
        "goal": (goal or "").strip(),
        "fmt": _norm(fmt),
        "must_include": _clean_list(must_include),
        "must_avoid": _clean_list(must_avoid),
        "done_criteria": _clean_list(done_criteria),
        "project": _norm(project),
    }


def save_brief(brief, memory_path) -> dict:
    """Append `brief` to the memory JSON at `memory_path` and return the entry.

    Uses the same append-only pattern as memory_core.remember: load the JSON
    list (tolerating a missing/corrupt file), append one entry, write it back.
    The entry is shaped like a memory entry ({ts, kind, text, project}) plus a
    `brief` key holding the full structured dict; kind is "brief" and the entry
    is keyed by the brief's project.
    """
    path = Path(memory_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": "brief",
        "text": (brief.get("goal") if isinstance(brief, dict) else "") or "",
        "project": _norm(brief.get("project") if isinstance(brief, dict) else None),
        "brief": dict(brief) if isinstance(brief, dict) else {},
    }
    entries = _load(path)
    entries.append(entry)
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False),
                    encoding="utf-8")
    return entry


def load_brief(project, memory_path):
    """Return the most-recent brief dict stored for `project`, or None.

    The store is append-only, so the last matching entry is the latest brief.
    Project matching is normalized (empty/None are the same, whitespace-trimmed).
    """
    path = Path(memory_path).expanduser()
    want = _norm(project)
    latest = None
    for entry in _load(path):
        if not isinstance(entry, dict) or entry.get("kind") != "brief":
            continue
        if _norm(entry.get("project")) != want:
            continue
        brief = entry.get("brief")
        if isinstance(brief, dict):
            latest = brief
    return latest
