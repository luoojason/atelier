"""Pure functions for a small append-only persistent memory store.

The store mirrors the user's goalcycle CONTEXT.md pattern: a durable file the
swarm reads at the start of a run and appends to at the end. It is a plain JSON
list of entries, each shaped {ts, kind, text, project}.

No dependency on agency_swarm or pydantic so it can be unit tested with the
standard library alone. RememberFact.py / RecallMemory.py wrap these functions.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MEMORY_PATH = "~/.openswarm/swarm_memory.json"


def memory_path() -> Path:
    """Return the memory file path from env SWARM_MEMORY_PATH (with default)."""
    return Path(os.getenv("SWARM_MEMORY_PATH", DEFAULT_MEMORY_PATH)).expanduser()


def _load(path: Path):
    """Load the JSON list of entries, tolerating a missing/empty/corrupt file."""
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "[]")
    except (ValueError, OSError):
        return []
    return data if isinstance(data, list) else []


def remember(kind: str, text: str, project: str | None = None) -> dict:
    """Append one entry to the memory store and return it.

    Creates the parent directory and file if missing. `kind` categorizes the
    entry (e.g. "decision", "fact", "state"); `project` is an optional tag.
    """
    path = memory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": (kind or "note").strip(),
        "text": (text or "").strip(),
        "project": (project or "").strip() or None,
    }
    entries = _load(path)
    entries.append(entry)
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False),
                    encoding="utf-8")
    return entry


def recall(query: str | None = None, limit: int = 20):
    """Return recent memory entries, optionally filtered by a substring query.

    With no query, returns the most recent `limit` entries (newest last is the
    file order; this returns the last `limit` preserving chronological order).
    With a query, filters entries whose text/kind/project contain it
    (case-insensitive), then returns the most recent `limit` of those.
    """
    path = memory_path()
    entries = _load(path)
    if query:
        q = query.strip().lower()
        entries = [
            e for e in entries
            if q in str(e.get("text", "")).lower()
            or q in str(e.get("kind", "")).lower()
            or q in str(e.get("project") or "").lower()
        ]
    if limit is not None and limit >= 0:
        entries = entries[-limit:]
    return entries
