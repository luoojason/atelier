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

import json
import os
import re
from datetime import date
from pathlib import Path

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


def publish_to_vault(title, body, folder="Analysis", tags=None, vault_root=None, updated=None):
    """Write a note into the Obsidian vault and return the absolute path written.

    Args:
        title: note title (also drives the filename).
        body: markdown body (without frontmatter).
        folder: subfolder under the vault root (default ``Analysis``).
        tags: list of tag strings.
        vault_root: override the vault root (defaults to env OBSIDIAN_VAULT).
        updated: ISO date string for ``last_updated`` (defaults to today).

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

        def run(self) -> str:
            try:
                path = publish_to_vault(
                    title=self.title,
                    body=self.body,
                    folder=self.folder,
                    tags=self.tags,
                )
            except ValueError as exc:
                return f"Error: {exc}"
            return f"Published note to vault: {path}"

except ImportError:  # pragma: no cover - exercised only under the plain-python3 test env
    pass
