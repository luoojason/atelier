"""Pure filesystem primitives for the agent's sandboxed project workspace.

A single directory (default ``~/.atelier/workspace``) the in-app agent may
create, read, and list files under so it can produce a REAL, runnable
deliverable — a code project, a script, a data file — instead of only text in a
card. It has NO dependency on agency_swarm or pydantic so it unit-tests with the
standard library alone; the BaseTool wrappers WriteFile.py / ReadFile.py /
ListFiles.py call these functions directly.

Containment mirrors vault_core: ``resolve()`` collapses ``..`` and symlinks
BEFORE a containment check, so no relative path, ``..`` traversal, or planted
symlink can escape the workspace. The root is a SUBDIR of ~/.atelier, so the
agent cannot reach the app's own settings.json / jobs.yaml / claude-home in the
parent. The agent has WRITE/READ/LIST here but NO execute or shell tool, so a
prompt-injected write is bounded to inert files in one directory that nothing
auto-runs; the user reviews and runs them by hand.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_WORKSPACE = "~/.atelier/workspace"

_MAX_FILE_BYTES = 2_000_000         # 2 MB per file (generous for code/data)
_MAX_WORKSPACE_BYTES = 200_000_000  # 200 MB total, a runaway-write backstop
_MAX_FILES = 5_000                  # file-count backstop
_MAX_LIST = 1_000                   # cap on files ListFiles returns
_READ_MAX_CHARS = 200_000           # cap on chars ReadFile hands the model


def _settings_workspace():
    """The ``workspace_dir`` override from the Atelier settings file, or None.

    Read directly (NOT via lite_server.load_settings) to avoid an import cycle
    and keep this module stdlib-only. Any failure yields None so workspace_root()
    falls through to env/default.
    """
    path = os.getenv("ATELIER_SETTINGS_PATH") or "~/.atelier/settings.json"
    try:
        data = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get("workspace_dir")
    return value if isinstance(value, str) and value else None


def _unsafe_root(p: Path) -> bool:
    """True if ``p`` must NOT be used as the workspace root.

    A configured root that is the filesystem root, the home dir, or ~/.atelier
    (the app's config dir) OR ANY ANCESTOR of ~/.atelier would put the app's own
    secrets (settings.json's optional API key, jobs.yaml, claude-home's OAuth)
    back inside the sandbox — defeating the whole subdir design. The agent cannot
    set these values, but a misconfigured (or socially-engineered) setting could,
    so reject them and fall back to the safe default. Compared on resolved paths
    so ``..``/symlinks can't dodge the check.
    """
    try:
        r = p.resolve()
    except (OSError, RuntimeError):
        return True
    if r == r.parent:  # the filesystem root '/'
        return True
    if r == Path.home().resolve():
        return True
    atelier = Path("~/.atelier").expanduser().resolve()
    return r == atelier or r in atelier.parents


def workspace_root() -> Path:
    """Workspace root: settings ``workspace_dir`` -> env ATELIER_WORKSPACE ->
    DEFAULT_WORKSPACE. Unlike the vault (an existing user directory), this is the
    app's own scratch space, so a configured path is honored even if absent (the
    write path creates it). A configured root that would expose the app's own
    secrets (see _unsafe_root) is ignored, falling through to the safe default.
    Pure: never creates the directory itself."""
    for candidate in (_settings_workspace(), os.getenv("ATELIER_WORKSPACE")):
        if candidate:
            p = Path(candidate).expanduser()
            if not _unsafe_root(p):
                return p
    return Path(DEFAULT_WORKSPACE).expanduser()


def _resolve_in_workspace(root: Path, rel: str) -> Path:
    """Resolve a RELATIVE path under ``root`` for read/write, or raise ValueError.

    Rejects an empty path, a null byte, and any absolute path; then resolve()s
    the target (collapsing ``..`` and following symlinks) and requires it to be
    the root itself or strictly inside it. Because resolve() runs BEFORE the
    check, ``a/../../etc/passwd`` and a symlink ``a -> /etc`` both fail. root is
    resolved too so the comparison is symlink-consistent on both sides.
    """
    rel = (rel or "").strip()
    if not rel:
        raise ValueError("path is required")
    if "\x00" in rel:
        raise ValueError("path contains a null byte")
    if Path(rel).is_absolute():
        raise ValueError("path must be relative to the workspace (no leading '/')")
    root_res = root.resolve()
    target = (root_res / rel).resolve()
    if target != root_res and root_res not in target.parents:
        raise ValueError("path escapes the workspace")
    return target


def _workspace_usage(root: Path) -> tuple[int, int]:
    """(total bytes, file count) currently in the workspace (best-effort)."""
    total = 0
    count = 0
    if root.exists():
        for p in root.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
                count += 1
    return total, count


def write_file(rel: str, content: str) -> str:
    """Write ``content`` to ``rel`` inside the workspace; return the abs path.

    Creates parent folders as needed. Refuses to escape the workspace, to write
    onto an existing directory, to exceed the per-file / total / count caps.
    Overwriting an existing file is allowed (it is the agent's own scratch).
    """
    root = workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    target = _resolve_in_workspace(root, rel)
    if target == root.resolve():
        raise ValueError("path is required")
    if target.is_dir():
        raise ValueError("a directory already exists at that path")
    data = content if isinstance(content, str) else str(content or "")
    size = len(data.encode("utf-8"))
    if size > _MAX_FILE_BYTES:
        raise ValueError(f"file too large ({size} bytes; max {_MAX_FILE_BYTES})")
    used, count = _workspace_usage(root)
    existing = target.stat().st_size if target.is_file() else 0
    if used - existing + size > _MAX_WORKSPACE_BYTES:
        raise ValueError("workspace storage limit reached; delete files to free space")
    if not target.exists() and count >= _MAX_FILES:
        raise ValueError("workspace file-count limit reached")
    target.parent.mkdir(parents=True, exist_ok=True)
    # INVARIANT: the resolve()-then-write pattern is safe ONLY because the agent
    # has no tool that can plant a symlink, rename, or extract an archive into
    # the workspace between the resolve() above and this write — so the resolved
    # target cannot be swapped for a symlink out. If such a tool is EVER added,
    # this becomes a TOCTOU escape; switch to O_NOFOLLOW / dir-fd-relative opens.
    target.write_text(data, encoding="utf-8")
    return str(target)


def read_file(rel: str) -> str:
    """Return the text of ``rel`` inside the workspace (capped), or raise."""
    root = workspace_root()
    if not root.exists():
        raise FileNotFoundError("the workspace has no files yet")
    target = _resolve_in_workspace(root, rel)
    if not target.is_file():
        raise FileNotFoundError(f"no file at {rel}")
    text = target.read_text(encoding="utf-8", errors="replace")
    if len(text) > _READ_MAX_CHARS:
        text = text[:_READ_MAX_CHARS] + "\n…[file truncated]"
    return text


def list_files() -> list[str]:
    """Relative paths of every file in the workspace (sorted, capped)."""
    root = workspace_root()
    if not root.exists():
        return []
    root_res = root.resolve()
    out: list[str] = []
    for p in sorted(root_res.rglob("*")):
        if p.is_file():
            out.append(str(p.relative_to(root_res)))
            if len(out) >= _MAX_LIST:
                break
    return out
