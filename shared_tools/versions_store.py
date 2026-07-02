"""Content-addressed version history for vault notes.

Every overwrite of a note through ``vault_core.write_note`` captures the
superseded text here (the hook lives in write_note; this module is the store).
Storage works the way git stores history: each unique content is written ONCE
as a blob named by its sha256 (zlib-compressed), and a version is a tiny
manifest pointing at its blob, so fifty near-identical revisions of a note
cost one blob per distinct text, not fifty copies.

Layout, per note (keyed by sha256 of the note's absolute path, first 16 hex):

    <root>/<key>/meta.json                  {"path": <abs note path>}
    <root>/<key>/blobs/<sha256-of-content>  zlib-compressed utf-8 bytes
    <root>/<key>/manifests/<id>.json        {"id","ts","source","label","digest","size"}

``<root>`` is env ATELIER_VERSIONS_DIR else ``~/.atelier/versions``. All
writes are atomic (tmp + os.replace). Every public function degrades
silently: corrupt or missing files never raise to callers, because a broken
history store must never block a note write, a read view, or the server.

Pure stdlib. vault_core is imported lazily (inside restore's validation
only), mirroring write_note's lazy import of this module, so neither side
creates an import cycle and the tests can load either file standalone.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import zlib
from datetime import datetime
from pathlib import Path
from uuid import uuid4

# Prune target: a note keeps at most this many versions (newest win).
_KEEP_VERSIONS = 50

# Version ids are uuid4().hex (32 hex) and digests sha256 (64 hex). Anything
# else is rejected before it can name a file, so a hostile id like
# "../../etc/passwd" can never traverse out of the manifests/ or blobs/ dirs.
_HEX_NAME_RE = re.compile(r"[0-9a-f]{8,64}")


def versions_root() -> Path:
    """Store root from env ATELIER_VERSIONS_DIR (default ~/.atelier/versions)."""
    return Path(os.getenv("ATELIER_VERSIONS_DIR") or "~/.atelier/versions").expanduser()


def _abs(note_path: str) -> str:
    """Normalize a note path to the absolute form used for keying + meta.json.

    abspath (not resolve) so the key is a pure string normalization: the note
    does not have to exist yet, and all callers that name the same path get
    the same history directory.
    """
    return os.path.abspath(os.path.expanduser(note_path or ""))


def _note_dir(note_path: str) -> Path:
    return versions_root() / hashlib.sha256(_abs(note_path).encode("utf-8")).hexdigest()[:16]


def _atomic_write(path: Path, data: bytes) -> None:
    """tmp + os.replace so readers never observe a half-written file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _read_json(path: Path):
    """Parsed JSON dict/list, or None for missing/corrupt/undecodable files."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _manifest_files(note_dir: Path) -> list[Path]:
    """Manifest paths, newest first.

    Ordered by st_mtime_ns, not the manifest's ``ts``: ts is second-resolution
    and captures in a tight loop tie within one second, while the file write
    times stay strictly increasing (and ordering must survive a corrupt
    manifest whose ts is unreadable).
    """
    try:
        files = [p for p in (note_dir / "manifests").iterdir() if p.suffix == ".json"]
    except OSError:
        return []

    def _mtime(p: Path) -> int:
        try:
            return p.stat().st_mtime_ns
        except OSError:
            return 0

    return sorted(files, key=_mtime, reverse=True)


def _prune(note_dir: Path) -> None:
    """Cap a note's history at the newest _KEEP_VERSIONS manifests, then drop
    every blob no surviving manifest references (which also sweeps stray .tmp
    files left by a crash).

    Ponytail note: this re-reads every surviving manifest on each capture, an
    O(n) sweep -- at n=50 tiny JSON files that is microseconds, so no side
    index is maintained. Best-effort throughout: a failed unlink just leaves
    an orphan for the next sweep.
    """
    try:
        files = _manifest_files(note_dir)
        for stale in files[_KEEP_VERSIONS:]:
            try:
                stale.unlink()
            except OSError:
                pass
        keep = set()
        for p in files[:_KEEP_VERSIONS]:
            m = _read_json(p)
            if isinstance(m, dict) and isinstance(m.get("digest"), str):
                keep.add(m["digest"])
        try:
            blobs = list((note_dir / "blobs").iterdir())
        except OSError:
            return
        for blob in blobs:
            if blob.name not in keep:
                try:
                    blob.unlink()
                except OSError:
                    pass
    except Exception:
        pass


def capture(note_path: str, content: str, source: str = "overwrite", label: str = "") -> str | None:
    """Store one version of a note's content; return its id.

    Content-addressed dedupe: when the LATEST manifest's digest already equals
    this content's digest the capture is a no-op returning None -- repeated
    identical writes never pile up versions. The blob write is skipped when
    the digest exists (same text seen in an older version costs one manifest,
    zero bytes of content). Returns None on any failure; never raises.
    """
    try:
        data = (content or "").encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        note_dir = _note_dir(note_path)

        manifests = _manifest_files(note_dir)
        if manifests:
            latest = _read_json(manifests[0])
            if isinstance(latest, dict) and latest.get("digest") == digest:
                return None  # unchanged since the newest version: dedupe

        (note_dir / "blobs").mkdir(parents=True, exist_ok=True)
        (note_dir / "manifests").mkdir(parents=True, exist_ok=True)

        # meta.json maps the opaque dir key back to the note path for
        # list_notes; (re)written when missing or corrupt so it self-heals.
        meta_path = note_dir / "meta.json"
        if not isinstance(_read_json(meta_path), dict):
            _atomic_write(meta_path, json.dumps({"path": _abs(note_path)}).encode("utf-8"))

        blob_path = note_dir / "blobs" / digest
        if not blob_path.exists():
            _atomic_write(blob_path, zlib.compress(data, 6))

        vid = uuid4().hex
        manifest = {
            "id": vid,
            "ts": datetime.now().isoformat(timespec="seconds"),
            "source": str(source or ""),
            "label": str(label or ""),
            "digest": digest,
            "size": len(data),
        }
        _atomic_write(note_dir / "manifests" / f"{vid}.json",
                      json.dumps(manifest).encode("utf-8"))
        _prune(note_dir)
        return vid
    except Exception:
        return None


def list_notes(limit: int = 50) -> list[dict]:
    """Every note with history: [{"path","versions","latest_ts"}], most
    recently captured first. [] on any failure; never raises."""
    try:
        out = []
        try:
            note_dirs = [d for d in versions_root().iterdir() if d.is_dir()]
        except OSError:
            return []
        for d in note_dirs:
            meta = _read_json(d / "meta.json")
            path = meta.get("path") if isinstance(meta, dict) else None
            if not isinstance(path, str) or not path:
                continue  # corrupt/missing meta: the note is invisible, not fatal
            manifests = _manifest_files(d)
            if not manifests:
                continue
            newest = _read_json(manifests[0])
            ts = newest.get("ts") if isinstance(newest, dict) else ""
            out.append({
                "path": path,
                "versions": len(manifests),
                "latest_ts": str(ts or ""),
            })
        # ISO timestamps sort lexicographically == chronologically.
        out.sort(key=lambda n: n["latest_ts"], reverse=True)
        return out[: max(0, int(limit))]
    except Exception:
        return []


def list_versions(note_path: str) -> list[dict]:
    """A note's versions, newest first: [{"id","ts","source","label","size"}].
    [] for an unknown note or on any failure; corrupt manifests are skipped."""
    try:
        out = []
        for p in _manifest_files(_note_dir(note_path)):
            m = _read_json(p)
            if not isinstance(m, dict):
                continue
            try:
                size = int(m.get("size") or 0)
            except (TypeError, ValueError):
                size = 0
            out.append({
                "id": str(m.get("id") or p.stem),
                "ts": str(m.get("ts") or ""),
                "source": str(m.get("source") or ""),
                "label": str(m.get("label") or ""),
                "size": size,
            })
        return out
    except Exception:
        return []


def read_version(note_path: str, version_id: str) -> str | None:
    """The stored content of one version, or None (unknown/corrupt/failure)."""
    try:
        vid = str(version_id or "")
        if not _HEX_NAME_RE.fullmatch(vid):
            return None
        m = _read_json(_note_dir(note_path) / "manifests" / f"{vid}.json")
        digest = m.get("digest") if isinstance(m, dict) else None
        if not isinstance(digest, str) or not _HEX_NAME_RE.fullmatch(digest):
            return None  # also blocks a doctored digest from naming a path
        blob = (_note_dir(note_path) / "blobs" / digest).read_bytes()
        return zlib.decompress(blob).decode("utf-8", errors="replace")
    except Exception:
        return None


def _vault_root() -> Path:
    """vault_core.vault_root(), imported at call time.

    Lazy for symmetry with write_note's lazy import of this module (neither
    side imports the other at module level, so there is no cycle). Prefers an
    already-imported ``shared_tools.vault_core``; otherwise loads the sibling
    file directly, which keeps this module usable under the stdlib-only
    file-path test loading (shared_tools/__init__ pulls in agency_swarm).
    """
    import importlib.util
    import sys

    mod = sys.modules.get("shared_tools.vault_core")
    if mod is None:
        name = "_versions_store_vault_core"
        mod = sys.modules.get(name)
        if mod is None:
            spec = importlib.util.spec_from_file_location(
                name, Path(__file__).with_name("vault_core.py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            sys.modules[name] = mod
    return mod.vault_root()


def restore(note_path: str, version_id: str) -> bool:
    """Write an earlier version's content back over the note file.

    Refuses any target outside the vault root or under the immutable Sources/
    tree -- the Sources check is case-folded on the first path component,
    the same discipline as vault_core.resolve_write_dir, and resolve()
    collapses '..' and symlinks before either check so normalization tricks
    cannot bypass them. The file's CURRENT content is captured first
    (source="pre_restore") so a restore is always undoable. Returns False on
    any failure; never raises.
    """
    try:
        target = Path(note_path or "").expanduser().resolve()
        root_res = _vault_root().resolve()
        if root_res not in target.parents:
            return False
        rel_parts = target.relative_to(root_res).parts
        if rel_parts and rel_parts[0].casefold() == "sources":
            return False

        content = read_version(note_path, version_id)
        if content is None:
            return False

        if target.is_file():
            capture(note_path, target.read_text(encoding="utf-8", errors="replace"),
                    source="pre_restore", label=f"before restore of {version_id}")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return True
    except Exception:
        return False
