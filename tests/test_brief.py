"""Tests for the structured brief subsystem.

Runs with the system python3 (no agency_swarm / pydantic needed): it imports
ONLY the pure functions in shared_tools/brief_core.py + shared_tools/memory_core.py.

    python3 tests/test_brief.py

shared_tools/ is put on sys.path so brief_core's reuse of memory_core._load
resolves as a plain top-level import, deliberately bypassing shared_tools/__init__.py
(which imports agency_swarm and would fail under the system python3).

Isolation rule (do NOT weaken): no test may read or mutate a real memory vault.
memory_core.remember()/recall() take no injected path -- they resolve the vault
from the SWARM_MEMORY_PATH env var via memory_core.memory_path(). So every test
that can touch the store runs inside `temp_memory()`, which unconditionally pins
SWARM_MEMORY_PATH at a throwaway temp file and restores the caller's original
value on exit. That keeps isolation independent of test run order and of any
SWARM_MEMORY_PATH already present in the ambient environment, and guarantees the
process-global env var never leaks past the suite.
"""

import contextlib
import os
import sys
import tempfile
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[1] / "shared_tools"
sys.path.insert(0, str(_SHARED))

import memory_core  # noqa: E402
import brief_core  # noqa: E402

build_brief = brief_core.build_brief
save_brief = brief_core.save_brief
load_brief = brief_core.load_brief
memory_path = memory_core.memory_path

_UNSET = object()


@contextlib.contextmanager
def temp_memory(*, nested=False):
    """Pin SWARM_MEMORY_PATH at a fresh temp file for the duration of the block.

    Yields the temp memory Path. On the way in it sets the env var to a file
    inside a throwaway temp dir; on the way out it restores whatever value the
    caller had (removing the var entirely if it was previously unset). Because
    the pin happens unconditionally, every path resolved via memory_path() --
    including the env-only reads inside memory_core.remember()/recall() -- lands
    in the temp dir, no matter the run order or any pre-existing external
    SWARM_MEMORY_PATH. Because the restore happens in `finally`, the global env
    var never leaks past the test (which otherwise would dangle at a deleted
    temp dir).
    """
    previous = os.environ.get("SWARM_MEMORY_PATH", _UNSET)
    with tempfile.TemporaryDirectory() as tmp:
        mem = Path(tmp)
        if nested:
            mem = mem / "nested"
        mem = mem / "swarm_memory.json"
        os.environ["SWARM_MEMORY_PATH"] = str(mem)
        # the tools resolve the path via env; confirm ours is what they'll see
        assert memory_path() == mem
        try:
            yield mem
        finally:
            if previous is _UNSET:
                os.environ.pop("SWARM_MEMORY_PATH", None)
            else:
                os.environ["SWARM_MEMORY_PATH"] = previous


def test_build_brief_goal_only():
    brief = build_brief("Write a launch blog post")
    assert brief["goal"] == "Write a launch blog post"
    # every optional field defaults empty; the three lists default to []
    assert brief["fmt"] is None
    assert brief["must_include"] == []
    assert brief["must_avoid"] == []
    assert brief["done_criteria"] == []
    assert brief["project"] is None
    print("ok test_build_brief_goal_only")


def test_build_brief_all_fields():
    brief = build_brief(
        goal="Draft the Q3 investor update",
        fmt="markdown report",
        must_include=["revenue", "churn"],
        must_avoid=["forward-looking guidance"],
        done_criteria=["under 800 words", "3 sections"],
        project="investor-relations",
    )
    assert brief["goal"] == "Draft the Q3 investor update"
    assert brief["fmt"] == "markdown report"
    assert brief["must_include"] == ["revenue", "churn"]
    assert brief["must_avoid"] == ["forward-looking guidance"]
    assert brief["done_criteria"] == ["under 800 words", "3 sections"]
    assert brief["project"] == "investor-relations"
    # empty items are dropped, real ones survive, whitespace trimmed
    noisy = build_brief("g", must_include=["  keep ", "", "  ", "also"])
    assert noisy["must_include"] == ["keep", "also"]
    print("ok test_build_brief_all_fields")


def test_save_then_load_roundtrips_latest():
    with temp_memory(nested=True) as mem:
        # the tools resolve the path via env; mirror that here
        mp = memory_path()
        assert mp == mem
        assert not mem.exists()

        first = build_brief("Ship v1", fmt="checklist", project="acme")
        entry1 = save_brief(first, mp)
        assert mem.exists(), "save_brief must auto-create the memory file"
        assert entry1["kind"] == "brief"
        assert entry1["project"] == "acme"
        assert entry1["text"] == "Ship v1"
        assert "ts" in entry1 and entry1["ts"]

        # a second, newer brief for the same project supersedes the first
        second = build_brief(
            "Ship v2",
            fmt="report",
            must_include=["migration notes"],
            done_criteria=["all tests green"],
            project="acme",
        )
        save_brief(second, mp)

        loaded = load_brief("acme", mp)
        assert loaded is not None
        assert loaded["goal"] == "Ship v2", loaded
        assert loaded["fmt"] == "report"
        assert loaded["must_include"] == ["migration notes"]
        assert loaded["done_criteria"] == ["all tests green"]
        print("ok test_save_then_load_roundtrips_latest")


def test_load_unknown_project_returns_none():
    with temp_memory() as mem:
        mp = memory_path()
        assert mp == mem

        # no file yet -> None, no crash
        assert load_brief("ghost", mp) is None

        save_brief(build_brief("Do a thing", project="known"), mp)
        # a brief exists, but not for this project
        assert load_brief("unknown-project", mp) is None
        # sanity: the known project still loads
        assert load_brief("known", mp)["goal"] == "Do a thing"
        print("ok test_load_unknown_project_returns_none")


def test_briefs_are_scoped_by_project():
    with temp_memory() as mem:
        mp = memory_path()
        assert mp == mem

        save_brief(build_brief("alpha goal", project="alpha"), mp)
        save_brief(build_brief("beta goal", project="beta"), mp)
        save_brief(build_brief("unscoped goal"), mp)  # project None

        assert load_brief("alpha", mp)["goal"] == "alpha goal"
        assert load_brief("beta", mp)["goal"] == "beta goal"
        # empty string and None address the same unscoped brief
        assert load_brief("", mp)["goal"] == "unscoped goal"
        assert load_brief(None, mp)["goal"] == "unscoped goal"
        print("ok test_briefs_are_scoped_by_project")


def test_save_coexists_with_plain_memory_entries():
    # briefs share the file with memory_core entries; each must ignore the other.
    with temp_memory() as mem:
        mp = memory_path()
        # remember()/recall() take no injected path -- they read the vault from
        # the env alone. temp_memory has pinned it at `mem`, so these calls
        # provably cannot touch a real vault. Assert that pin holds right here.
        assert mp == mem

        memory_core.remember("decision", "picked postgres", project="acme")
        save_brief(build_brief("Ship it", project="acme"), mp)
        memory_core.remember("fact", "deadline friday", project="acme")

        # the brief is still found despite non-brief entries around it
        assert load_brief("acme", mp)["goal"] == "Ship it"
        # and the memory entries are all intact (2 non-brief + the brief entry)
        all_entries = memory_core.recall()
        kinds = [e.get("kind") for e in all_entries]
        assert kinds == ["decision", "brief", "fact"], kinds
        print("ok test_save_coexists_with_plain_memory_entries")


def _run():
    tests = [
        test_build_brief_goal_only,
        test_build_brief_all_fields,
        test_save_then_load_roundtrips_latest,
        test_load_unknown_project_returns_none,
        test_briefs_are_scoped_by_project,
        test_save_coexists_with_plain_memory_entries,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
