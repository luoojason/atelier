"""Publish a finished note into the user's Obsidian vault.

The vault is a plain directory of ``.md`` files. This tool writes a new note with
proper YAML frontmatter (title, tags, last_updated) into a subfolder of the vault
(default ``Analysis``), never touching anything under ``Sources/`` (immutable).

All real logic lives in the module-level ``publish_to_vault`` function (pure
stdlib, no agency_swarm / pydantic dependency); the BaseTool below is a thin
wrapper. The function is intentionally self-contained so this file does not
depend on any other subsystem. The agency_swarm/pydantic imports are guarded so
the pure functions remain importable under a plain python3 (for tests) even when
the framework is not installed.
"""

import contextlib
import json
import os
import re
from datetime import date
from pathlib import Path

try:  # POSIX-only; the vault lives on macOS. Absent on non-POSIX -> no locking.
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX fallback
    fcntl = None

DEFAULT_VAULT = "/Users/jasonluo08/Desktop/AI Brain"


def resolve_vault_root(env=None):
    """Return the vault root from env OBSIDIAN_VAULT, falling back to the default."""
    env = env if env is not None else os.environ
    return (env.get("OBSIDIAN_VAULT") or "").strip() or DEFAULT_VAULT


def slugify_filename(title):
    """Turn a note title into a safe filename stem (keeps spaces, drops FS-hostile chars)."""
    stem = (title or "").strip()
    stem = re.sub(r"[\\/:*?\"<>|]", "", stem)  # characters illegal on common filesystems
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem or "Untitled Note"


def _yaml_scalar(value):
    """Return an arbitrary string as a valid, double-quoted YAML scalar.

    A raw ``f"title: {title}"`` breaks YAML the moment the title contains a
    ``": "`` (e.g. 'Report: Q3 Results' -> a bogus mapping) and a newline in the
    title can inject extra frontmatter keys. ``json.dumps`` emits a double-quoted
    scalar with every colon, quote, backslash, and control character escaped;
    that syntax is also valid YAML, so ``yaml.safe_load`` round-trips it back to
    the exact original string. Newlines are collapsed to spaces first so the
    frontmatter stays a single tidy line.
    """
    text = str(value if value is not None else "")
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    return json.dumps(text, ensure_ascii=False)


def _format_tags(tags):
    """Render a YAML inline list, always valid even when empty."""
    items = [_yaml_scalar(t) for t in (tags or []) if str(t).strip()]
    if not items:
        return "[]"
    return "[" + ", ".join(items) + "]"


def build_note(title, body, tags=None, updated=None):
    """Return the full markdown text (YAML frontmatter + body) for a vault note."""
    updated = updated or date.today().isoformat()
    frontmatter = (
        "---\n"
        f"title: {_yaml_scalar(title)}\n"
        f"tags: {_format_tags(tags)}\n"
        f"last_updated: {_yaml_scalar(updated)}\n"
        "---\n"
    )
    body = body or ""
    return f"{frontmatter}\n{body.rstrip()}\n"


# ── Convention-honoring catalog writeback (log.md + index.md) ────────────────
# The vault's own CLAUDE.md rule: after creating a page, append to log.md and
# update index.md so notes are never orphaned. These mirror the pure helpers in
# shared_tools/vault_core.py; they are duplicated (not imported) so this file
# stays self-contained and importable under a bare system python3 for tests.

_WIKILINK_TARGET_RE = re.compile(r"\[\[([^\[\]|\\]+)")
_HEADER_RE = re.compile(r"^\s*#{1,6}\s+(\S.*?)\s*$")


def append_log(vault_root, line, date):
    """Append one ``- {date} — {line}`` bullet to the vault's log.md.

    Creates log.md when missing and guarantees a trailing newline so the next
    append lands on its own line. Returns the log path.
    """
    log_path = Path(vault_root) / "log.md"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    log_path.write_text(f"{existing}- {date} — {line}\n", encoding="utf-8")
    return str(log_path)


def _row_wikilink_target(line):
    """Return the wikilink target (`[[target|name]]` -> `target`) in a row, or None."""
    m = _WIKILINK_TARGET_RE.search(line)
    return m.group(1).strip() if m else None


def _escape_table_cell(value):
    """Collapse whitespace and escape ``|`` so a value is safe in a Markdown table cell.

    A raw pipe inside a table cell starts a new column, so a summary such as
    ``'multi space | pipe'`` (realistic: the summary is the note's first body
    line) would otherwise inject a spurious column and corrupt the two-column
    index row. GFM / Obsidian render ``\\|`` as a literal pipe, so every pipe is
    escaped to keep the cell — and the row's column count — intact. This mirrors
    the rigor of ``_yaml_scalar`` on the frontmatter path, where the same class
    of format-breaking character is escaped rather than passed through raw.
    """
    return " ".join((value or "").split()).replace("|", "\\|")


def upsert_index_row(index_text, section, wikilink, name, summary):
    """Idempotently insert/update a ``| [[wikilink\\|name]] | summary |`` index row.

    Keyed by ``wikilink``: an existing row for that wikilink under ``## {section}``
    has its summary replaced in place (running twice makes no duplicate);
    otherwise the row is appended to that section's table, creating the header +
    table when the section is absent. Other rows and formatting are preserved.
    Returns the new index text and does no file IO.
    """
    wikilink = (wikilink or "").strip()
    name = (name or "").strip() or wikilink
    summary = _escape_table_cell(summary)
    new_row = f"| [[{wikilink}\\|{name}]] | {summary} |"

    lines = index_text.split("\n")

    section_idx = None
    for i, line in enumerate(lines):
        m = _HEADER_RE.match(line)
        if m and m.group(1).strip() == section:
            section_idx = i
            break

    if section_idx is not None:
        end = len(lines)
        for j in range(section_idx + 1, len(lines)):
            if _HEADER_RE.match(lines[j]):
                end = j
                break

        for j in range(section_idx + 1, end):
            row = lines[j]
            if row.lstrip().startswith("|") and _row_wikilink_target(row) == wikilink:
                lines[j] = new_row
                return "\n".join(lines)

        last_row = None
        for j in range(section_idx + 1, end):
            if lines[j].lstrip().startswith("|"):
                last_row = j
        if last_row is not None:
            lines.insert(last_row + 1, new_row)
            return "\n".join(lines)

        table = ["| Page | Summary |", "|------|---------|", new_row]
        block = table if (end > 0 and lines[end - 1].strip() == "") else [""] + table
        lines[end:end] = block
        return "\n".join(lines)

    while lines and lines[-1].strip() == "":
        lines.pop()
    block = []
    if lines:
        block.append("")
    block += [f"## {section}", "", "| Page | Summary |", "|------|---------|", new_row]
    lines.extend(block)
    return "\n".join(lines) + "\n"


def _first_line(text):
    """First non-empty, non-heading line of a body (used as a default summary)."""
    for ln in (text or "").splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            return s
    return ""


@contextlib.contextmanager
def _catalog_lock(root):
    """Hold an exclusive advisory lock while mutating the shared catalog files.

    index.md and log.md are each updated by a non-atomic read-modify-write. Two
    concurrent publishes (agency_swarm dispatches sync tools via asyncio.to_thread
    worker threads, and the scheduler serves concurrent requests) would otherwise
    read the same pre-image and the second write would clobber the first's freshly
    added row/bullet — last-writer-wins silently drops a catalog entry. An
    exclusive ``flock`` on a dedicated lockfile serializes the whole catalog
    update (both files) across threads and processes so every entry survives.

    ``flock`` is per-open-file-description, so two threads that each ``open`` the
    lockfile still mutually exclude. Best-effort: if locking is unavailable
    (non-POSIX, or the lockfile cannot be created), proceed without it rather than
    failing the publish.
    """
    if fcntl is None:
        yield
        return
    lock_path = Path(root) / ".catalog.lock"
    try:
        handle = open(lock_path, "w", encoding="utf-8")
    except OSError:
        yield
        return
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _catalog_note(root, folder, title, section=None, name=None, summary=None, when=None):
    """Upsert an index.md row + append a log.md line; best-effort (never fatal)."""
    when = when or date.today().isoformat()
    section = (section or folder).strip("/") or folder
    display = name or title
    # The wikilink target must name the note file that publish_to_vault actually
    # writes, i.e. slugify_filename(title) (line-illegal chars stripped, whitespace
    # collapsed). Building it from the raw title would point a colon/slash title
    # (e.g. 'Report: Q3') at 'Analysis/Report: Q3', a name slugify never produces,
    # leaving a dangling wikilink in index.md/log.md. Display keeps the raw title.
    wikilink = f"{folder}/{slugify_filename(title)}"
    summary = summary or display
    try:
        with _catalog_lock(root):
            index_path = root / "index.md"
            index_text = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
            index_path.write_text(
                upsert_index_row(index_text, section, wikilink, display, summary),
                encoding="utf-8",
            )
            append_log(root, f"Created note [[{wikilink}|{display}]]", when)
    except OSError:
        pass


def publish_to_vault(title, body, folder="Analysis", tags=None, vault_root=None,
                     updated=None, catalog=True, section=None, name=None, summary=None):
    """Write a note into the Obsidian vault and return the absolute path written.

    Args:
        title: note title (also drives the filename).
        body: markdown body (without frontmatter).
        folder: subfolder under the vault root (default ``Analysis``).
        tags: list of tag strings.
        vault_root: override the vault root (defaults to env OBSIDIAN_VAULT).
        updated: ISO date string for ``last_updated`` (defaults to today).
        catalog: when True (default) honor the vault convention after the write —
            append a dated bullet to log.md and upsert a row into index.md
            (section defaults to ``folder``, row name to ``title``, summary to the
            first body line). Pass False for ephemeral writes.
        section / name / summary: overrides for the catalog row.

    Raises ValueError when writing would escape the vault or target the
    immutable ``Sources/`` tree.
    """
    root = Path(vault_root or resolve_vault_root())
    folder = (folder or "Analysis").strip().strip("/") or "Analysis"

    # target_dir is the ACTUAL write location, kept in the caller's (unresolved)
    # path form so the returned path matches what the caller passed. Validation,
    # however, runs against the RESOLVED path: resolve() collapses '..', '.', and
    # symlinks, so 'folder' cannot escape the vault ('../escaped_evil') or slip
    # past the Sources guard via normalization ('./Sources', 'x/../Sources').
    target_dir = root / folder
    root_res = root.resolve()
    resolved = target_dir.resolve()

    # Containment: must be the vault root itself or strictly inside it.
    if resolved != root_res and root_res not in resolved.parents:
        raise ValueError(f"Refusing to write outside the vault: {target_dir}")

    # Sources/ is immutable. Case-FOLD the comparison because the vault lives on
    # a case-insensitive filesystem (macOS): 'sources' and 'Sources' are the same
    # directory, so a case-sensitive check would let 'sources' mutate it.
    rel_parts = resolved.relative_to(root_res).parts
    if rel_parts and rel_parts[0].casefold() == "sources":
        raise ValueError("Refusing to write into Sources/ (immutable).")

    target_dir.mkdir(parents=True, exist_ok=True)

    filename = slugify_filename(title) + ".md"
    path = target_dir / filename
    path.write_text(build_note(title, body, tags, updated), encoding="utf-8")

    if catalog:
        _catalog_note(root, folder, title, section=section, name=name,
                      summary=summary or _first_line(body), when=updated)
    return str(path)


# ── BaseTool wrapper (framework-only) ────────────────────────────────────────
# Guarded so the pure functions above stay importable under a plain python3 that
# does not have agency_swarm installed (the test harness). At runtime the
# framework is present and the tool class is defined normally.
try:
    from agency_swarm.tools import BaseTool
    from pydantic import Field

    class PublishToVault(BaseTool):
        """
        Publish a finished note into the user's Obsidian vault (a directory of .md files).

        Writes a new markdown note with valid YAML frontmatter (title, tags,
        last_updated) into a subfolder of the vault. Use this to deliver written
        deliverables — summaries, analyses, session logs — into the user's
        knowledge base. Never targets Sources/ (immutable). Returns the absolute
        path written.
        """

        title: str = Field(..., description="Note title. Also used to derive the filename.")
        body: str = Field(..., description="Markdown body of the note (without frontmatter).")
        folder: str = Field(
            "Analysis",
            description=(
                "Vault subfolder to write into (e.g. 'Analysis', 'Sessions/Auto Logs'). "
                "Defaults to 'Analysis'. Writing into 'Sources/' is forbidden."
            ),
        )
        tags: list[str] = Field(
            default_factory=list,
            description="List of tag strings for the note's YAML frontmatter.",
        )
        catalog: bool = Field(
            True,
            description=(
                "When true (default) honor the vault convention: append a dated "
                "bullet to log.md and upsert a row into index.md so the note is "
                "catalogued, not orphaned. Set false for ephemeral writes."
            ),
        )

        def run(self) -> str:
            try:
                path = publish_to_vault(
                    title=self.title,
                    body=self.body,
                    folder=self.folder,
                    tags=self.tags,
                    catalog=self.catalog,
                )
            except ValueError as exc:
                return f"Error: {exc}"
            return f"Published note to vault: {path}"

except ImportError:  # pragma: no cover - exercised only under the plain-python3 test env
    pass
