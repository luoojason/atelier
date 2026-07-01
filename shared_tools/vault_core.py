"""Pure functions for reading and writing an Obsidian vault of Markdown notes.

This module has NO dependency on agency_swarm or pydantic so it can be unit
tested with the standard library alone. The BaseTool wrappers in
VaultSearch.py / VaultRead.py / VaultWrite.py call these functions directly.

The vault is a plain directory of `.md` files (the user's "AI Brain" Obsidian
vault). Notes carry YAML frontmatter with `title`, `tags`, and `last_updated`.
Anything under `Sources/` is immutable and must never be written to.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

DEFAULT_VAULT = "/Users/jasonluo08/Desktop/AI Brain"

# Directories that are skipped when scanning / searching the vault.
_SKIP_DIRS = {"Sources", ".obsidian", ".git", ".trash"}


def vault_root() -> Path:
    """Return the vault root directory from env OBSIDIAN_VAULT (with default)."""
    return Path(os.getenv("OBSIDIAN_VAULT", DEFAULT_VAULT)).expanduser()


def _is_skipped(rel_parts) -> bool:
    """True if any path component names a skipped directory."""
    return any(part in _SKIP_DIRS for part in rel_parts)


def _iter_notes(root: Path):
    """Yield (path, relative_path_str) for every non-skipped .md file."""
    if not root.exists():
        return
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(root)
        # rel.parts includes the filename; only directory parts should be checked.
        if _is_skipped(rel.parts[:-1]):
            continue
        yield path, str(rel)


def parse_frontmatter(text: str):
    """Split a note into (frontmatter_dict, body).

    Handles a leading `---` fenced YAML block with simple `key: value` lines.
    Only flat scalar keys are parsed (enough for title/tags/last_updated).
    Returns ({}, text) when no frontmatter is present.
    """
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    meta = {}
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
        line = lines[i]
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    if end is None:
        return {}, text
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return meta, body


def _title_for(path: Path, text: str) -> str:
    """Best-effort note title: frontmatter `title` else filename stem."""
    meta, _ = parse_frontmatter(text)
    title = meta.get("title", "").strip().strip('"').strip("'")
    return title or path.stem


def _make_snippet(text: str, query: str, width: int = 160) -> str:
    """Return a one-line excerpt around the first match of query (or the head)."""
    _, body = parse_frontmatter(text)
    flat = " ".join(body.split())
    if not flat:
        flat = " ".join(text.split())
    if query:
        idx = flat.lower().find(query.lower())
        if idx != -1:
            start = max(0, idx - width // 2)
            end = min(len(flat), idx + width // 2)
            prefix = "..." if start > 0 else ""
            suffix = "..." if end < len(flat) else ""
            return f"{prefix}{flat[start:end]}{suffix}"
    return flat[:width] + ("..." if len(flat) > width else "")


def search_vault(query: str, limit: int = 5):
    """Scan vault .md files for query, returning a list of hit dicts.

    Each hit is {"path": <relative path>, "title": <title>, "snippet": <excerpt>}.
    Matching is case-insensitive substring over the whole note (title + body).
    Directories in _SKIP_DIRS (notably Sources/) are skipped. Results are ordered
    with title matches first, then body matches, and capped at `limit`.
    """
    q = (query or "").strip().lower()
    root = vault_root()
    title_hits = []
    body_hits = []
    for path, rel in _iter_notes(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        title = _title_for(path, text)
        if not q:
            body_hits.append({"path": rel, "title": title,
                              "snippet": _make_snippet(text, q)})
            continue
        in_title = q in title.lower()
        in_body = q in text.lower()
        if not (in_title or in_body):
            continue
        hit = {"path": rel, "title": title, "snippet": _make_snippet(text, q)}
        (title_hits if in_title else body_hits).append(hit)
    return (title_hits + body_hits)[: max(0, limit)]


def read_note(path_or_title: str) -> str:
    """Return the full text of a note, resolved by relative path or by title.

    Resolution order:
      1. Absolute path, if it exists and is a .md under the vault.
      2. Path relative to the vault root.
      3. First note whose filename stem or frontmatter title matches (case-insensitive).
    Raises FileNotFoundError when nothing matches.
    """
    ident = (path_or_title or "").strip()
    if not ident:
        raise FileNotFoundError("No note identifier provided.")
    root = vault_root()
    root_res = root.resolve()

    def _inside_vault(candidate: Path) -> bool:
        c = candidate.resolve()
        return c == root_res or root_res in c.parents

    # 1) absolute path — only honored when it is a .md file INSIDE the vault.
    # Without this containment/extension check an absolute ident like
    # "/etc/hosts" or "~/.pypirc" would be read straight off disk, turning this
    # into an arbitrary-file-read (exfiltration) primitive. Absolute idents that
    # fail the check raise immediately rather than falling through to the
    # relative branch (where `root / "/abs"` would collapse back to the abs path).
    p = Path(ident).expanduser()
    if p.is_absolute():
        if _inside_vault(p) and p.suffix.lower() == ".md" and p.is_file():
            return p.read_text(encoding="utf-8", errors="replace")
        raise FileNotFoundError(f"Note not found: {path_or_title}")

    # 2) relative to vault root (with or without .md suffix). resolve() the
    # candidate and require it to stay inside the vault so that '..' traversal
    # (e.g. "../../etc/hosts") cannot escape.
    candidates = [root / ident]
    if not ident.endswith(".md"):
        candidates.append(root / f"{ident}.md")
    for cand in candidates:
        if _inside_vault(cand) and cand.is_file():
            return cand.read_text(encoding="utf-8", errors="replace")

    # 3) match by filename stem or frontmatter title
    wanted = ident[:-3] if ident.endswith(".md") else ident
    wanted_l = wanted.lower()
    for path, _ in _iter_notes(root):
        if path.stem.lower() == wanted_l:
            return path.read_text(encoding="utf-8", errors="replace")
    for path, _ in _iter_notes(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        if _title_for(path, text).lower() == wanted_l:
            return text

    raise FileNotFoundError(f"Note not found: {path_or_title}")


def _safe_filename(title: str) -> str:
    """Turn a title into a safe .md filename (Obsidian allows spaces)."""
    name = (title or "note").strip()
    for bad in ("/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\t"):
        name = name.replace(bad, "-")
    name = name.strip(". ") or "note"
    return name if name.endswith(".md") else f"{name}.md"


def _format_frontmatter(title: str, tags, updated: str) -> str:
    """Build a YAML frontmatter block with title, tags, last_updated."""
    tags = tags or []
    tag_list = ", ".join(str(t).strip() for t in tags if str(t).strip())
    return (
        "---\n"
        f"title: {title}\n"
        f"tags: [{tag_list}]\n"
        f"last_updated: {updated}\n"
        "---\n"
    )


def resolve_write_dir(root: Path, folder: str) -> Path:
    """Resolve `folder` under the vault `root` for writing, with safety guards.

    Returns the resolved absolute target directory. Raises ValueError when the
    target would escape the vault OR land inside the immutable Sources/ tree.

    resolve() collapses '..', '.', and symlinks before either check, so
    normalization tricks ('../evil', './Sources', 'x/../Sources') cannot bypass
    them. The Sources comparison is CASE-FOLDED because the vault lives on a
    case-insensitive filesystem (macOS), where 'sources' and 'Sources' name the
    same directory; a case-sensitive check would let 'sources' mutate the
    immutable tree.
    """
    root_res = root.resolve()
    target = (root_res / folder).resolve()

    # Containment: the target must be the vault root itself or strictly inside it.
    if target != root_res and root_res not in target.parents:
        raise ValueError(f"Refusing to write outside the vault: {target}")

    rel_parts = target.relative_to(root_res).parts
    if rel_parts and rel_parts[0].casefold() == "sources":
        raise ValueError("Refusing to write under Sources/ (immutable).")
    return target


def write_note(folder: str, title: str, body: str, tags=None) -> str:
    """Write a note with proper frontmatter into a vault subfolder.

    Returns the absolute path of the written file. Refuses to write anywhere
    under Sources/ (immutable) or outside the vault. Creates the target folder
    if needed.
    """
    folder = (folder or "Analysis").strip().strip("/")
    root = vault_root()
    target_dir = resolve_write_dir(root, folder)

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / _safe_filename(title)
    frontmatter = _format_frontmatter(title, tags, date.today().isoformat())
    content = f"{frontmatter}\n{body.rstrip()}\n" if body else f"{frontmatter}\n"
    path.write_text(content, encoding="utf-8")
    return str(path)
