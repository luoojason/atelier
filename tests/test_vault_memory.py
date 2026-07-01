"""Tests for the vault knowledge + persistent memory subsystem.

Runs with the system python3 (no agency_swarm / pydantic needed): it imports
ONLY the pure functions in shared_tools/vault_core.py and shared_tools/memory_core.py.

    python3 tests/test_vault_memory.py
"""

import importlib.util
import os
import tempfile
from pathlib import Path

# Load the pure-function modules directly by file path. This deliberately
# bypasses shared_tools/__init__.py (which imports agency_swarm) so the tests
# depend only on stdlib and can run under the system python3.
_SHARED = Path(__file__).resolve().parents[1] / "shared_tools"


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, _SHARED / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_vault = _load("vault_core", "vault_core.py")
_memory = _load("memory_core", "memory_core.py")

parse_frontmatter = _vault.parse_frontmatter
read_note = _vault.read_note
search_vault = _vault.search_vault
write_note = _vault.write_note
vault_root = _vault.vault_root

memory_path = _memory.memory_path
recall = _memory.recall
remember = _memory.remember


def test_write_then_read_roundtrip_and_frontmatter():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        assert str(vault_root()) == tmp

        path = write_note(
            folder="Analysis",
            title="Synthesis Alpha",
            body="This is the body of the note.\nSecond line.",
            tags=["research", "alpha"],
        )
        # written into the right subfolder with a .md name
        assert path.endswith("Analysis/Synthesis Alpha.md"), path
        assert Path(path).is_file()

        text = read_note("Analysis/Synthesis Alpha.md")
        meta, body = parse_frontmatter(text)
        assert meta.get("title") == "Synthesis Alpha", meta
        assert "research" in meta.get("tags", ""), meta
        assert "last_updated" in meta, meta
        # last_updated is an ISO date (YYYY-MM-DD)
        assert len(meta["last_updated"].split("-")) == 3, meta["last_updated"]
        assert "body of the note" in body

        # resolvable by title alone, too
        by_title = read_note("Synthesis Alpha")
        assert "body of the note" in by_title
    print("ok test_write_then_read_roundtrip_and_frontmatter")


def test_write_refuses_sources():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        raised = False
        try:
            write_note("Sources", "Should Fail", "nope", [])
        except ValueError:
            raised = True
        assert raised, "write_note must refuse the immutable Sources/ folder"
        assert not (Path(tmp) / "Sources").exists()
    print("ok test_write_refuses_sources")


def _assert_write_refused(folder):
    """Call write_note(folder, ...) and assert it raises ValueError."""
    raised = False
    try:
        write_note(folder, "Injected", "pwn", [])
    except ValueError:
        raised = True
    assert raised, f"write_note must refuse folder={folder!r}"


def test_write_refuses_sources_case_insensitive():
    # macOS is case-insensitive: lowercase 'sources' names the SAME immutable
    # directory as 'Sources'. A case-sensitive guard would let this through.
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        for folder in ("sources", "SOURCES", "Sources/Immutable", "sources/nested"):
            _assert_write_refused(folder)
        # nothing was created under any case-variant of Sources/
        for name in ("sources", "SOURCES", "Sources"):
            assert not (Path(tmp) / name).exists(), name
    print("ok test_write_refuses_sources_case_insensitive")


def test_write_refuses_path_traversal():
    # A '..' segment must not let a write land OUTSIDE the vault root.
    with tempfile.TemporaryDirectory() as parent:
        vault = Path(parent) / "vault"
        vault.mkdir()
        os.environ["OBSIDIAN_VAULT"] = str(vault)
        _assert_write_refused("../escaped_evil")
        _assert_write_refused("../../escaped_evil")
        # no file escaped into the parent (sibling) directory
        assert not (Path(parent) / "escaped_evil").exists()
        assert list(Path(parent).glob("**/Injected.md")) == []
    print("ok test_write_refuses_path_traversal")


def test_write_refuses_normalized_sources():
    # Normalization tricks ('./Sources', 'x/../Sources') must not bypass the
    # Sources guard.
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        for folder in ("./Sources", "x/../Sources", "./sources"):
            _assert_write_refused(folder)
        assert not (Path(tmp) / "Sources").exists()
        assert list(Path(tmp).glob("**/Injected.md")) == []
    print("ok test_write_refuses_normalized_sources")


def test_read_note_refuses_outside_vault_and_non_md():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        root = Path(tmp)
        (root / "Analysis").mkdir(parents=True)
        (root / "Analysis" / "Real.md").write_text(
            "---\ntitle: Real\ntags: []\nlast_updated: 2026-07-01\n---\n\nbody\n",
            encoding="utf-8",
        )
        # absolute path outside the vault must NOT be read (exfil primitive)
        for bad in ("/etc/hosts", "/etc/passwd"):
            raised = False
            try:
                read_note(bad)
            except FileNotFoundError:
                raised = True
            assert raised, f"read_note must refuse absolute path {bad!r}"

        # a non-.md file that exists INSIDE the vault is still not honored via
        # the absolute-path branch (docstring: '.md under the vault')
        secret = root / "secret.txt"
        secret.write_text("api-key=super-secret\n", encoding="utf-8")
        raised = False
        try:
            read_note(str(secret))
        except FileNotFoundError:
            raised = True
        assert raised, "read_note must refuse a non-.md absolute path"

        # relative '..' traversal must not escape the vault either
        raised = False
        try:
            read_note("../../etc/hosts")
        except FileNotFoundError:
            raised = True
        assert raised, "read_note must refuse relative '..' traversal"

        # legitimate reads still work (regression guard)
        assert "body" in read_note("Analysis/Real.md")
        assert "body" in read_note(str(root / "Analysis" / "Real.md"))
    print("ok test_read_note_refuses_outside_vault_and_non_md")


def test_search_finds_note_and_skips_sources():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        root = Path(tmp)

        # seed a findable note under Analysis/
        (root / "Analysis").mkdir(parents=True)
        (root / "Analysis" / "Findable.md").write_text(
            "---\ntitle: Findable\ntags: []\nlast_updated: 2026-07-01\n---\n\n"
            "The keyword zebrafish appears here.\n",
            encoding="utf-8",
        )
        # seed a note under Sources/ that ALSO contains the keyword — must be skipped
        (root / "Sources").mkdir(parents=True)
        (root / "Sources" / "Immutable.md").write_text(
            "zebrafish should not be returned from Sources\n", encoding="utf-8"
        )

        hits = search_vault("zebrafish", limit=10)
        paths = [h["path"] for h in hits]
        assert any("Findable.md" in p for p in paths), paths
        assert all("Sources" not in p for p in paths), paths
        # snippet carries the matched context
        assert any("zebrafish" in h["snippet"].lower() for h in hits), hits

        # title-match ranking: searching the title returns the note
        title_hits = search_vault("Findable", limit=5)
        assert title_hits and title_hits[0]["title"] == "Findable", title_hits
    print("ok test_search_finds_note_and_skips_sources")


def test_search_no_match_returns_empty():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OBSIDIAN_VAULT"] = tmp
        (Path(tmp) / "Analysis").mkdir(parents=True)
        (Path(tmp) / "Analysis" / "N.md").write_text("hello world\n", encoding="utf-8")
        assert search_vault("nonexistent-term-xyz", limit=5) == []
    print("ok test_search_no_match_returns_empty")


def test_memory_autocreates_and_roundtrips():
    with tempfile.TemporaryDirectory() as tmp:
        mem = Path(tmp) / "nested" / "swarm_memory.json"
        os.environ["SWARM_MEMORY_PATH"] = str(mem)
        assert memory_path() == mem
        # file (and its parent dir) should not exist yet
        assert not mem.exists()

        # recall on a missing file returns [] (no crash)
        assert recall() == []

        e1 = remember("decision", "Adopt the vault subsystem", project="openswarm")
        assert mem.exists(), "remember must auto-create the memory file"
        assert e1["kind"] == "decision"
        assert e1["project"] == "openswarm"
        assert "ts" in e1 and e1["ts"]

        remember("fact", "Vault path comes from OBSIDIAN_VAULT")

        all_entries = recall()
        assert len(all_entries) == 2, all_entries
        # chronological order preserved (append-only)
        assert all_entries[0]["text"] == "Adopt the vault subsystem"

        # query filter is case-insensitive over text/kind/project
        filtered = recall(query="VAULT")
        assert len(filtered) == 2, filtered
        only_decision = recall(query="adopt")
        assert len(only_decision) == 1 and only_decision[0]["kind"] == "decision"

        # limit returns the most recent N
        last_one = recall(limit=1)
        assert len(last_one) == 1 and last_one[0]["kind"] == "fact", last_one
    print("ok test_memory_autocreates_and_roundtrips")


def _run():
    tests = [
        test_write_then_read_roundtrip_and_frontmatter,
        test_write_refuses_sources,
        test_write_refuses_sources_case_insensitive,
        test_write_refuses_path_traversal,
        test_write_refuses_normalized_sources,
        test_read_note_refuses_outside_vault_and_non_md,
        test_search_finds_note_and_skips_sources,
        test_search_no_match_returns_empty,
        test_memory_autocreates_and_roundtrips,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
