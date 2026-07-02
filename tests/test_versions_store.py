"""Tests for the note versions store + the write_note capture hook.

Runs with the system python3 (no agency_swarm / pydantic needed): it imports
ONLY the pure functions in shared_tools/versions_store.py and
shared_tools/vault_core.py, loaded by file path to bypass
shared_tools/__init__.py.

    python3 tests/test_versions_store.py
"""

import hashlib
import importlib.util
import json
import os
import tempfile
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[1] / "shared_tools"


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, _SHARED / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_store = _load("versions_store", "versions_store.py")
_vault = _load("vault_core", "vault_core.py")

capture = _store.capture
list_notes = _store.list_notes
list_versions = _store.list_versions
read_version = _store.read_version
restore = _store.restore
write_note = _vault.write_note


def _note_dir(root, note_path):
    """The store's per-note directory (mirror of the module's keying rule)."""
    key = hashlib.sha256(os.path.abspath(note_path).encode("utf-8")).hexdigest()[:16]
    return Path(root) / key


def test_capture_list_read_roundtrip():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault
        note = str(Path(vault) / "Analysis" / "N.md")

        vid1 = capture(note, "alpha content", source="overwrite", label="first")
        assert vid1, "capture must return a version id"
        vid2 = capture(note, "beta content")
        assert vid2 and vid2 != vid1

        versions = list_versions(note)
        assert [v["id"] for v in versions] == [vid2, vid1], "newest first"
        assert versions[0]["source"] == "overwrite"
        assert versions[1]["label"] == "first"
        assert versions[1]["size"] == len(b"alpha content")
        # ts is local ISO seconds (date T time)
        for v in versions:
            assert "T" in v["ts"] and len(v["ts"]) == 19, v["ts"]

        assert read_version(note, vid1) == "alpha content"
        assert read_version(note, vid2) == "beta content"
        # unknown id / hostile id / unknown note all degrade to None
        assert read_version(note, "0" * 32) is None
        assert read_version(note, "../../etc/passwd") is None
        assert read_version(note, "") is None
        assert read_version(str(Path(vault) / "nope.md"), vid1) is None

        notes = list_notes()
        assert len(notes) == 1, notes
        assert notes[0]["path"] == note
        assert notes[0]["versions"] == 2
        assert notes[0]["latest_ts"] == versions[0]["ts"]

        # limit caps the note list; non-positive returns nothing
        assert list_notes(limit=0) == []
        assert len(list_notes(limit=1)) == 1
    print("ok test_capture_list_read_roundtrip")


def test_capture_dedupes_identical_latest():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault
        note = str(Path(vault) / "Analysis" / "D.md")

        vid1 = capture(note, "same text")
        assert vid1
        # identical content while it is the LATEST version: no new manifest
        assert capture(note, "same text") is None
        assert len(list_versions(note)) == 1

        # A, B, A: the third capture differs from the latest so it IS a new
        # version, but the content-addressed blob for A is reused.
        vid2 = capture(note, "other text")
        vid3 = capture(note, "same text")
        assert vid2 and vid3
        assert len(list_versions(note)) == 3
        blobs = list((_note_dir(vers, note) / "blobs").iterdir())
        assert len(blobs) == 2, "two distinct contents = two blobs"
        assert read_version(note, vid3) == "same text"
    print("ok test_capture_dedupes_identical_latest")


def test_prune_keeps_newest_50():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault
        note = str(Path(vault) / "Analysis" / "P.md")

        ids = [capture(note, f"content {i}") for i in range(55)]
        assert all(ids), "every distinct capture returns an id"

        versions = list_versions(note)
        assert len(versions) == 50, "history is capped at the newest 50"
        kept = {v["id"] for v in versions}
        assert kept == set(ids[5:]), "exactly the oldest 5 were pruned"
        assert versions[0]["id"] == ids[-1], "newest capture listed first"

        # orphaned blobs of the pruned manifests were swept best-effort
        blobs = list((_note_dir(vers, note) / "blobs").iterdir())
        assert len(blobs) == 50, blobs
        assert read_version(note, ids[0]) is None, "pruned version is gone"
        assert read_version(note, ids[-1]) == "content 54"
    print("ok test_prune_keeps_newest_50")


def test_restore_roundtrip_with_pre_restore_capture():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault
        (Path(vault) / "Analysis").mkdir(parents=True)
        p = Path(vault) / "Analysis" / "R.md"
        p.write_text("version one", encoding="utf-8")

        vid1 = capture(str(p), "version one")
        p.write_text("version two", encoding="utf-8")

        assert restore(str(p), vid1) is True
        assert p.read_text(encoding="utf-8") == "version one"

        # the file's pre-restore content was captured first, labeled with the
        # target version, so the restore is undoable.
        versions = list_versions(str(p))
        assert len(versions) == 2, versions
        pre = versions[0]
        assert pre["source"] == "pre_restore"
        assert vid1 in pre["label"], pre
        assert read_version(str(p), pre["id"]) == "version two"

        # undo: restoring the pre_restore version brings version two back
        assert restore(str(p), pre["id"]) is True
        assert p.read_text(encoding="utf-8") == "version two"

        # unknown version id restores nothing
        assert restore(str(p), "f" * 32) is False
        assert p.read_text(encoding="utf-8") == "version two"
    print("ok test_restore_roundtrip_with_pre_restore_capture")


def test_restore_refuses_outside_vault_and_sources():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault, \
            tempfile.TemporaryDirectory() as elsewhere:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault

        # a file OUTSIDE the vault: capture is path-agnostic (the hook decides
        # what to capture) but restore is the guarded door and must refuse.
        outside = Path(elsewhere) / "other.md"
        outside.write_text("outside original", encoding="utf-8")
        vid = capture(str(outside), "evil payload")
        assert vid
        assert restore(str(outside), vid) is False
        assert outside.read_text(encoding="utf-8") == "outside original"

        # the immutable Sources/ tree, in every case variant (macOS is
        # case-insensitive) and nested
        for sub in ("Sources", "sources", "SOURCES", "Sources/Nested"):
            sp = str(Path(vault) / sub / "Immutable.md")
            vid2 = capture(sp, "payload")
            assert vid2
            assert restore(sp, vid2) is False, f"must refuse {sub!r}"
        assert not (Path(vault) / "Sources").exists()
        assert not (Path(vault) / "sources").exists()

        # '..' traversal that lexically escapes the vault
        sneaky = str(Path(vault) / "Analysis" / ".." / ".." / "escape.md")
        vid3 = capture(sneaky, "x")
        assert restore(sneaky, vid3) is False
        assert not (Path(vault).parent / "escape.md").exists()

        # the vault root itself is not a restorable note
        assert restore(vault, vid) is False
    print("ok test_restore_refuses_outside_vault_and_sources")


def test_corrupt_manifest_blob_and_meta_tolerated():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault
        note = str(Path(vault) / "Analysis" / "C.md")
        ndir = _note_dir(vers, note)

        vid1 = capture(note, "good one")
        vid2 = capture(note, "good two")

        # corrupt vid1's manifest: it is skipped everywhere, never raising
        (ndir / "manifests" / f"{vid1}.json").write_text("{not json", encoding="utf-8")
        assert [v["id"] for v in list_versions(note)] == [vid2]
        assert read_version(note, vid1) is None

        # corrupt vid2's blob: reads degrade to None
        digest2 = json.loads(
            (ndir / "manifests" / f"{vid2}.json").read_text(encoding="utf-8"))["digest"]
        (ndir / "blobs" / digest2).write_bytes(b"\x00garbage not zlib")
        assert read_version(note, vid2) is None

        # capture still works after corruption (a corrupt latest manifest
        # cannot satisfy the dedupe check, so a fresh version is written)
        vid3 = capture(note, "good three")
        assert vid3
        assert read_version(note, vid3) == "good three"

        # corrupt meta.json hides the note from list_notes without raising,
        # and the next capture self-heals it
        (ndir / "meta.json").write_text("][", encoding="utf-8")
        assert all(n["path"] != note for n in list_notes())
        assert capture(note, "good four")
        assert any(n["path"] == note for n in list_notes())

        # missing store root: every read degrades to its empty shape
        os.environ["ATELIER_VERSIONS_DIR"] = str(Path(vers) / "does" / "not" / "exist")
        assert list_notes() == []
        assert list_versions(note) == []
        assert read_version(note, vid3) is None
        assert restore(note, vid3) is False
    print("ok test_corrupt_manifest_blob_and_meta_tolerated")


def test_write_note_hook_captures_old_content_on_overwrite():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault

        # first write: nothing to supersede, nothing captured
        path = write_note("Analysis", "Hooked", "first body", tags=["t"], catalog=False)
        assert Path(path).is_file()
        assert list_versions(path) == [], "first write must capture nothing"

        # overwrite: the FULL old file (frontmatter + body) is captured
        write_note("Analysis", "Hooked", "second body", catalog=False)
        versions = list_versions(path)
        assert len(versions) == 1, versions
        assert versions[0]["source"] == "overwrite"
        old = read_version(path, versions[0]["id"])
        assert "first body" in old and "title: Hooked" in old, old
        assert "second body" not in old
        assert "second body" in Path(path).read_text(encoding="utf-8")

        # each further overwrite captures the content it supersedes
        write_note("Analysis", "Hooked", "third body", catalog=False)
        versions = list_versions(path)
        assert len(versions) == 2
        assert "second body" in read_version(path, versions[0]["id"])
    print("ok test_write_note_hook_captures_old_content_on_overwrite")


def test_write_note_hook_failure_never_blocks_the_write():
    with tempfile.TemporaryDirectory() as vers, tempfile.TemporaryDirectory() as vault:
        os.environ["ATELIER_VERSIONS_DIR"] = vers
        os.environ["OBSIDIAN_VAULT"] = vault

        write_note("Analysis", "Fragile", "v1", catalog=False)

        # monkeypatch capture on the exact module instance write_note resolves
        store_used = _vault._load_versions_store()
        orig = store_used.capture

        def _boom(*args, **kwargs):
            raise RuntimeError("versions store exploded")

        store_used.capture = _boom
        try:
            path = write_note("Analysis", "Fragile", "v2", catalog=False)
        finally:
            store_used.capture = orig

        # the overwrite landed despite the raising capture
        assert "v2" in Path(path).read_text(encoding="utf-8")
        # and no version was recorded by the exploding capture
        assert list_versions(path) == []

        # with the store healthy again, the hook resumes capturing
        write_note("Analysis", "Fragile", "v3", catalog=False)
        versions = list_versions(path)
        assert len(versions) == 1
        assert "v2" in read_version(path, versions[0]["id"])
    print("ok test_write_note_hook_failure_never_blocks_the_write")


def _run():
    tests = [
        test_capture_list_read_roundtrip,
        test_capture_dedupes_identical_latest,
        test_prune_keeps_newest_50,
        test_restore_roundtrip_with_pre_restore_capture,
        test_restore_refuses_outside_vault_and_sources,
        test_corrupt_manifest_blob_and_meta_tolerated,
        test_write_note_hook_captures_old_content_on_overwrite,
        test_write_note_hook_failure_never_blocks_the_write,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
