"""Pure functions for a small append-only persistent memory store.

The store mirrors the user's goalcycle CONTEXT.md pattern: a durable file the
swarm reads at the start of a run and appends to at the end. It is a plain JSON
list of entries, each shaped {ts, kind, text, project}.

No dependency on agency_swarm or pydantic so it can be unit tested with the
standard library alone. RememberFact.py / RecallMemory.py wrap these functions.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
import warnings
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MEMORY_PATH = "~/.openswarm/swarm_memory.json"


def memory_path() -> Path:
    """Return the memory file path from env SWARM_MEMORY_PATH (with default)."""
    return Path(os.getenv("SWARM_MEMORY_PATH", DEFAULT_MEMORY_PATH)).expanduser()


def _read_entries(path: Path):
    """Return (entries, corrupt_bytes) for the store at `path`.

    A missing, empty, or all-whitespace file is a normal cold start: it yields
    ([], None). A file that exists with real content that is NOT a JSON list is
    CORRUPT and must be distinguished from empty — returning [] for it (as the
    old loader did) is exactly what let the next append silently overwrite and
    destroy every prior entry. For a corrupt file this returns ([], raw_text) so
    the append path can preserve those bytes instead of clobbering them.
    """
    if not path.exists():
        return [], None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return [], None
    if not raw.strip():
        return [], None
    try:
        data = json.loads(raw)
    except ValueError:
        return [], raw
    if isinstance(data, list):
        return data, None
    return [], raw


def _load(path: Path):
    """Load the JSON list of entries, tolerating a missing/empty/corrupt file.

    Read-side helper (recall / load_brief): a missing, empty, or corrupt file all
    read as "no entries" so a reader never crashes. This is deliberately NOT the
    gate for a write: _append_entry inspects corruption separately so an append
    can never mistake a corrupt store for an empty one and wipe it. See
    _append_entry for the durable write path.
    """
    entries, _corrupt = _read_entries(path)
    return entries


def _atomic_write(path: Path, entries) -> None:
    """Write the JSON list to `path` atomically (temp file, fsync, os.replace).

    A crash, kill, or full disk mid-write can only ever leave a discarded temp
    file behind; the live file is swapped in with a single os.replace, so a
    reader or the next writer never observes a truncated/half-written file. This
    is the same durable pattern the run ledger uses (scheduler/run_store.py).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(entries, indent=2, ensure_ascii=False)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent),
                               prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def _locked(path: Path):
    """Hold an exclusive cross-process lock for a read-modify-write on `path`.

    The store is a single global file shared by every agent, tool call, and
    process, and the orchestrator runs workstreams in parallel. Without a lock,
    two overlapping load->append->write cycles each read the same base list and
    the last writer wins, silently dropping the other's entry (a lost update).
    The lock lives on a sibling `<name>.lock` file so it is unaffected by the
    atomic replace of the data file itself.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with open(lock_path, "w", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _append_entry(path: Path, entry: dict) -> dict:
    """Durably append one entry to the append-only JSON list at `path`.

    This is the single write path for the store (memory entries AND briefs share
    the file), and it closes the durability holes the naive read-modify-write
    had:

      - **Locked.** The whole load->append->write runs under an exclusive
        cross-process lock, so concurrent appends never lose an entry.
      - **Atomic.** The new list is written to a temp file and os.replace'd in,
        so an interrupted/killed write can never truncate the store.
      - **Corruption is preserved, never wiped.** If the existing file is
        non-empty but unreadable/not a list, its bytes are moved aside to a
        `<name>.corrupt-<ts>` sibling and a RuntimeWarning is raised, instead of
        being silently overwritten with just this one entry (which used to
        destroy every prior brief and memory entry with no error).
    """
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _locked(path):
        entries, corrupt = _read_entries(path)
        if corrupt is not None:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = path.with_name(f"{path.name}.corrupt-{stamp}")
            os.replace(path, backup)
            warnings.warn(
                f"memory store {path} was corrupt; its contents were preserved "
                f"to {backup} rather than overwritten. Starting a fresh store.",
                RuntimeWarning,
                stacklevel=2,
            )
            entries = []
        entries.append(entry)
        _atomic_write(path, entries)
    return entry


def remember(kind: str, text: str, project: str | None = None) -> dict:
    """Append one entry to the memory store and return it.

    Creates the parent directory and file if missing. `kind` categorizes the
    entry (e.g. "decision", "fact", "state"); `project` is an optional tag. The
    append is durable: locked against concurrent writers, atomic against an
    interrupted write, and non-destructive if the store is already corrupt.
    """
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": (kind or "note").strip(),
        "text": (text or "").strip(),
        "project": (project or "").strip() or None,
    }
    return _append_entry(memory_path(), entry)


def recall(query: str | None = None, limit: int = 20):
    """Return recent memory entries, optionally filtered by a substring query.

    With no query, returns the most recent `limit` entries (newest last is the
    file order; this returns the last `limit` preserving chronological order).
    With a query, filters entries whose text/kind/project contain it
    (case-insensitive), then returns the most recent `limit` of those.

    `limit` semantics mirror search_vault's ``max(0, limit)`` guard: a positive
    limit returns the last N; ``limit == 0`` or a negative limit returns NONE
    (an empty list) -- NOT the whole store, which is what ``entries[-0:]`` /
    ``entries[-(-1):]`` used to do; ``limit is None`` disables the cap.
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
    if limit is not None:
        entries = entries[-limit:] if limit > 0 else []
    return entries
