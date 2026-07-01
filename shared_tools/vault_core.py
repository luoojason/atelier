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
import re
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

    def _readable_note(candidate: Path) -> bool:
        """A candidate is readable only if it is a .md file safely inside the
        vault and not under a skipped dir (Sources/.git/.obsidian/.trash).

        This is the SAME guard for the absolute and the relative branch. Without
        it either branch is an arbitrary-file-read (exfiltration) primitive: the
        relative branch previously returned ANY file inside the vault, so idents
        like ".git/config" (tokenized remote URLs), "secret.txt"/".env", or
        ".obsidian/workspace.json" leaked straight off disk even though the
        absolute branch already rejected the same files. The suffix check is on
        the resolved path so a symlink note.md -> secret.txt can't slip through.
        """
        if not _inside_vault(candidate):
            return False
        c = candidate.resolve()
        if c.suffix.lower() != ".md" or not c.is_file():
            return False
        try:
            rel_parts = c.relative_to(root_res).parts
        except ValueError:
            return False
        return not _is_skipped(rel_parts[:-1])

    # 1) absolute path — only honored when it is a .md note INSIDE the vault.
    # Absolute idents that fail the guard raise immediately rather than falling
    # through to the relative branch (where `root / "/abs"` would collapse back
    # to the abs path).
    p = Path(ident).expanduser()
    if p.is_absolute():
        if _readable_note(p):
            return p.read_text(encoding="utf-8", errors="replace")
        raise FileNotFoundError(f"Note not found: {path_or_title}")

    # 2) relative to vault root (with or without .md suffix), guarded IDENTICALLY
    # to the absolute branch so the relative form is not a weaker exfil path. The
    # resolve()-based containment check also blocks '..' traversal.
    candidates = [root / ident]
    if not ident.endswith(".md"):
        candidates.append(root / f"{ident}.md")
    for cand in candidates:
        if _readable_note(cand):
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


# ── Convention-honoring catalog writeback (log.md + index.md) ────────────────
# The vault's own CLAUDE.md rule: after creating a page, append to log.md and
# update index.md so notes are never orphaned. These are PURE helpers (stdlib
# only) so they unit-test without agency_swarm / pydantic.

_WIKILINK_TARGET_RE = re.compile(r"\[\[([^\[\]|\\]+)")
_HEADER_RE = re.compile(r"^\s*#{1,6}\s+(\S.*?)\s*$")


def append_log(vault_root, line: str, date: str) -> str:
    """Append one ``- {date} — {line}`` bullet to the vault's log.md.

    Creates log.md when missing and guarantees the file ends with a trailing
    newline so the next append lands on its own line. Returns the log path.
    """
    log_path = Path(vault_root) / "log.md"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    log_path.write_text(f"{existing}- {date} — {line}\n", encoding="utf-8")
    return str(log_path)


def _row_wikilink_target(line: str):
    """Return the wikilink target (`[[target|name]]` -> `target`) in a row, or None."""
    m = _WIKILINK_TARGET_RE.search(line)
    return m.group(1).strip() if m else None


def _escape_table_cell(value: str) -> str:
    """Collapse whitespace and escape ``|`` so a value is safe in a table cell.

    A raw pipe inside a Markdown table cell starts a new column, so a summary
    such as ``'cost | benefit'`` (realistic: the default summary is the note's
    first body line) would otherwise inject a spurious column and corrupt the
    two-column index row. GFM / Obsidian render ``\\|`` as a literal pipe. This
    mirrors publisher_agent/tools/PublishToVault._escape_table_cell.
    """
    return " ".join((value or "").split()).replace("|", "\\|")


def _escape_wikilink_name(value: str) -> str:
    """Escape a display name for use inside ``[[target\\|name]]`` in a table cell.

    A raw ``|`` in the name would read as another alias separator AND inject a
    table column; ``]]`` would close the wikilink early and spill the rest of the
    name into the row as broken markup. Both are neutralized so the row stays a
    single, well-formed two-column entry.
    """
    return (value or "").replace("]]", "] ]").replace("|", "\\|")


def upsert_index_row(index_text: str, section: str, wikilink: str,
                     name: str, summary: str) -> str:
    """Idempotently insert/update a ``| [[wikilink\\|name]] | summary |`` index row.

    The row is keyed by ``wikilink`` (the note's path/target). If a row for that
    wikilink already exists under the ``## {section}`` table its summary is
    replaced in place (running twice makes no duplicate); otherwise the row is
    appended to that section's table, creating the header + table when the
    section is absent. All other rows and surrounding formatting are preserved.
    Returns the new index text and performs no file IO.
    """
    wikilink = (wikilink or "").strip()
    name = (name or "").strip() or wikilink
    # The wikilink target stays raw (it is dedupe-keyed and _catalog_note derives
    # it from a sanitized filename, so it carries no table-breaking chars); the
    # free-text name and summary are escaped so user body text can't corrupt the
    # row's column layout or close the wikilink early.
    new_row = f"| [[{wikilink}\\|{_escape_wikilink_name(name)}]] | {_escape_table_cell(summary)} |"

    lines = index_text.split("\n")

    # Locate the section header (any heading level whose text == section).
    section_idx = None
    for i, line in enumerate(lines):
        m = _HEADER_RE.match(line)
        if m and m.group(1).strip() == section:
            section_idx = i
            break

    if section_idx is not None:
        # Bound the section: up to the next heading (any level) or end of file.
        end = len(lines)
        for j in range(section_idx + 1, len(lines)):
            if _HEADER_RE.match(lines[j]):
                end = j
                break

        # 1) Replace an existing row for this wikilink (dedupe-safe update).
        for j in range(section_idx + 1, end):
            row = lines[j]
            if row.lstrip().startswith("|") and _row_wikilink_target(row) == wikilink:
                lines[j] = new_row
                return "\n".join(lines)

        # 2) Append after the last existing table row in the section.
        last_row = None
        for j in range(section_idx + 1, end):
            if lines[j].lstrip().startswith("|"):
                last_row = j
        if last_row is not None:
            lines.insert(last_row + 1, new_row)
            return "\n".join(lines)

        # 3) Section exists but has no table — insert one before the next header.
        table = ["| Page | Summary |", "|------|---------|", new_row]
        block = table if (end > 0 and lines[end - 1].strip() == "") else [""] + table
        lines[end:end] = block
        return "\n".join(lines)

    # 4) Section absent — append a new section + table at the end of the file.
    while lines and lines[-1].strip() == "":
        lines.pop()
    block = []
    if lines:
        block.append("")
    block += [f"## {section}", "", "| Page | Summary |", "|------|---------|", new_row]
    lines.extend(block)
    return "\n".join(lines) + "\n"


def _first_line(text: str) -> str:
    """First non-empty, non-heading line of a body (used as a default summary)."""
    for ln in (text or "").splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            return s
    return ""


def _catalog_note(root: Path, folder: str, title: str, *, section=None,
                  name=None, summary=None, when=None) -> None:
    """Honor the vault convention: upsert an index.md row + append a log.md line.

    Section defaults to the note's folder; the display name defaults to the
    title; the summary defaults to the note's first body line (else the title).
    Best-effort: a filesystem hiccup on the catalog files must not fail the note
    write itself.
    """
    when = when or date.today().isoformat()
    section = (section or folder).strip("/") or folder
    display = name or title
    # The note is saved as _safe_filename(title) (line in write_note), which
    # rewrites '/ \\ : * ? " < > | \\n \\t' to '-'. Obsidian resolves [[...]]
    # against the FILENAME, not the frontmatter title, so the index/log wikilink
    # target must be built from that sanitized stem -- otherwise any title with a
    # sanitized char (colons/slashes are common) yields a dead link. The raw
    # title is kept only as the human-readable display name.
    wikilink = f"{folder}/{Path(_safe_filename(title)).stem}"
    summary = summary or display
    try:
        index_path = root / "index.md"
        index_text = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
        index_path.write_text(
            upsert_index_row(index_text, section, wikilink, display, summary),
            encoding="utf-8",
        )
        # log bullets are prose, not table cells, so the wikilink pipe is bare.
        append_log(root, f"Created note [[{wikilink}|{display}]]", when)
    except OSError:
        pass


def write_note(folder: str, title: str, body: str, tags=None, *,
               catalog: bool = True, section=None, name=None, summary=None) -> str:
    """Write a note with proper frontmatter into a vault subfolder.

    Returns the absolute path of the written file. Refuses to write anywhere
    under Sources/ (immutable) or outside the vault. Creates the target folder
    if needed.

    When ``catalog`` is True (default) the vault convention is honored after the
    write: a dated bullet is appended to log.md and a table row is upserted into
    index.md (section defaults to ``folder``, the row name to ``title``, and the
    summary to the note's first body line). Pass ``catalog=False`` for ephemeral
    or memory-style writes that should not be catalogued.
    """
    folder = (folder or "Analysis").strip().strip("/")
    root = vault_root()
    target_dir = resolve_write_dir(root, folder)

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / _safe_filename(title)
    today = date.today().isoformat()
    frontmatter = _format_frontmatter(title, tags, today)
    content = f"{frontmatter}\n{body.rstrip()}\n" if body else f"{frontmatter}\n"
    path.write_text(content, encoding="utf-8")

    if catalog:
        _catalog_note(root, folder, title, section=section, name=name,
                      summary=summary or _first_line(body), when=today)
    return str(path)
