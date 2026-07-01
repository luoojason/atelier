"""Tests for the campaign subsystem (the Campaign meta-agent's pure core).

Runs with the system python3 (no agency_swarm / pydantic needed): it imports
ONLY the pure functions in campaign_agent/campaign_core.py +
shared_tools/memory_core.py.

    python3 tests/test_campaign.py

Both the shared_tools/ dir and the campaign_agent/ dir are put on sys.path so
campaign_core's reuse of memory_core._append_entry / _load resolves as a plain
top-level import (`from memory_core import ...`), deliberately bypassing
shared_tools/__init__.py (which imports agency_swarm and would fail under the
system python3).

Isolation rule (do NOT weaken): no test may read or mutate a real memory vault.
save_campaign / load_campaign take an injected path, and every test that touches
the store runs inside `temp_memory()`, which pins SWARM_MEMORY_PATH at a throwaway
temp file and restores the caller's original value on exit — so nothing ever
touches ~/.openswarm or any real store, independent of run order.
"""

import contextlib
import os
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "shared_tools"))
sys.path.insert(0, str(_ROOT / "campaign_agent"))

import memory_core  # noqa: E402
import campaign_core  # noqa: E402

plan_campaign = campaign_core.plan_campaign
record_result = campaign_core.record_result
gate = campaign_core.gate
ready_to_publish = campaign_core.ready_to_publish
campaign_status = campaign_core.campaign_status
save_campaign = campaign_core.save_campaign
load_campaign = campaign_core.load_campaign
memory_path = memory_core.memory_path

_UNSET = object()


@contextlib.contextmanager
def temp_memory():
    """Pin SWARM_MEMORY_PATH at a fresh temp file for the duration of the block."""
    previous = os.environ.get("SWARM_MEMORY_PATH", _UNSET)
    with tempfile.TemporaryDirectory() as tmp:
        mem = Path(tmp) / "swarm_memory.json"
        os.environ["SWARM_MEMORY_PATH"] = str(mem)
        assert memory_path() == mem
        try:
            yield mem
        finally:
            if previous is _UNSET:
                os.environ.pop("SWARM_MEMORY_PATH", None)
            else:
                os.environ["SWARM_MEMORY_PATH"] = previous


_SPECS = [
    {"type": "docs", "spec": "800-word launch post"},
    {"type": "slides", "spec": "10-slide deck"},
    "image",  # bare-string spec form
]


def test_plan_campaign_shape_all_planned():
    camp = plan_campaign("cmp1", "Launch acme", "acme", _SPECS, ts="2026-07-01T00:00:00Z")
    assert camp["id"] == "cmp1"
    assert camp["goal"] == "Launch acme"
    assert camp["project"] == "acme"
    assert camp["stage"] == "planned"
    assert camp["created_ts"] == "2026-07-01T00:00:00Z"  # caller-supplied, not the clock
    assert camp["brief"] is None
    assert len(camp["deliverables"]) == 3
    for d in camp["deliverables"]:
        assert d["status"] == "planned"
        assert d["path"] is None
        assert d["verdict"] is None
    # dict specs and the bare-string spec both normalize into typed deliverables
    types = [d["type"] for d in camp["deliverables"]]
    assert types == ["docs", "slides", "image"]
    assert camp["deliverables"][0]["spec"] == "800-word launch post"
    assert camp["deliverables"][2]["spec"] == ""  # bare string -> empty spec
    # a brief is carried when supplied
    withbrief = plan_campaign("c2", "g", "p", [], brief={"goal": "g"})
    assert withbrief["brief"] == {"goal": "g"}
    print("ok test_plan_campaign_shape_all_planned")


def test_record_result_transitions_planned_produced_gated():
    camp = plan_campaign("cmp1", "Launch", "acme", _SPECS)
    # planned -> produced (a result path arrives, no verdict yet)
    c1 = record_result(camp, "docs", path="/out/post.md")
    docs1 = c1["deliverables"][0]
    assert docs1["status"] == "produced"
    assert docs1["path"] == "/out/post.md"
    assert docs1["verdict"] is None
    # input campaign is not mutated (record_result returns a new campaign)
    assert camp["deliverables"][0]["status"] == "planned"
    # produced -> gated (the Critic's verdict is recorded)
    c2 = record_result(c1, "docs", verdict="ship")
    docs2 = c2["deliverables"][0]
    assert docs2["status"] == "gated"
    assert docs2["verdict"] == "ship"
    assert docs2["path"] == "/out/post.md"  # earlier path preserved
    # stage tracks the deliverables' collective state
    assert c2["stage"] == "producing"  # only 1 of 3 gated
    # unknown dtype is a no-op, never raises
    same = record_result(c2, "nonexistent", verdict="ship")
    assert [d["status"] for d in same["deliverables"]] == [d["status"] for d in c2["deliverables"]]
    print("ok test_record_result_transitions_planned_produced_gated")


def test_gate_verdict_rules():
    # missing / None verdict -> block
    assert gate({"type": "docs", "verdict": None}) == "block"
    assert gate({"type": "docs"}) == "block"
    # explicit block -> block
    assert gate({"type": "docs", "verdict": "block"}) == "block"
    # ship -> ship, revise -> revise
    assert gate({"type": "docs", "verdict": "ship"}) == "ship"
    assert gate({"type": "docs", "verdict": "revise"}) == "revise"
    # garbage verdict and non-dict fail safe to block
    assert gate({"type": "docs", "verdict": "yolo"}) == "block"
    assert gate(None) == "block"
    assert gate("not a dict") == "block"
    print("ok test_gate_verdict_rules")


def test_ready_to_publish_only_ship():
    camp = plan_campaign("cmp1", "Launch", "acme", _SPECS)
    camp = record_result(camp, "docs", path="/out/post.md", verdict="ship")
    camp = record_result(camp, "slides", path="/out/deck.pptx", verdict="revise")
    camp = record_result(camp, "image", path="/out/hero.png", verdict="block")
    ready = ready_to_publish(camp)
    assert len(ready) == 1
    assert ready[0]["type"] == "docs"
    assert ready[0]["path"] == "/out/post.md"
    # a produced-but-unreviewed deliverable is NOT ready
    camp2 = plan_campaign("cmp2", "g", "p", [{"type": "docs", "spec": "x"}])
    camp2 = record_result(camp2, "docs", path="/out/x.md")  # produced, no verdict
    assert ready_to_publish(camp2) == []
    print("ok test_ready_to_publish_only_ship")


def test_new_path_after_ship_invalidates_stale_verdict():
    # Regression (path-swap-after-ship gap): once a deliverable is gated 'ship'
    # against a reviewed path, writing a NEW path with NO fresh verdict must not
    # keep the stale 'ship' gate — the Critic never saw the new artifact. The
    # deliverable drops back to 'produced' and must be re-gated.
    camp = plan_campaign("cmp1", "Launch", "acme", [{"type": "docs", "spec": "x"}])
    camp = record_result(camp, "docs", path="/reviewed.md", verdict="ship")
    assert ready_to_publish(camp)[0]["path"] == "/reviewed.md"

    # swap in an un-reviewed artifact with an empty/absent verdict
    camp = record_result(camp, "docs", path="/UNREVIEWED.md")
    docs = camp["deliverables"][0]
    assert docs["path"] == "/UNREVIEWED.md"
    assert docs["verdict"] is None            # stale 'ship' cleared
    assert docs["status"] == "produced"       # dropped back for re-gating
    assert gate(docs) == "block"
    assert ready_to_publish(camp) == []       # the un-reviewed path never publishes
    assert camp["stage"] == "producing"       # no longer collectively gated

    # re-recording the SAME reviewed path with no verdict does NOT invalidate it
    keep = plan_campaign("cmp2", "g", "p", [{"type": "docs", "spec": "x"}])
    keep = record_result(keep, "docs", path="/reviewed.md", verdict="ship")
    keep = record_result(keep, "docs", path="/reviewed.md")  # identical path, no verdict
    assert keep["deliverables"][0]["verdict"] == "ship"
    assert ready_to_publish(keep)[0]["path"] == "/reviewed.md"

    # after invalidation, a fresh Critic 'ship' re-gates the new artifact
    camp = record_result(camp, "docs", verdict="ship")
    assert camp["deliverables"][0]["status"] == "gated"
    assert ready_to_publish(camp)[0]["path"] == "/UNREVIEWED.md"
    print("ok test_new_path_after_ship_invalidates_stale_verdict")


def test_campaign_status_counts():
    camp = plan_campaign("cmp1", "Launch", "acme", _SPECS)
    camp = record_result(camp, "docs", path="/out/post.md", verdict="ship")
    camp = record_result(camp, "slides", path="/out/deck.pptx")  # produced only
    # image stays planned
    s = campaign_status(camp)
    assert s["id"] == "cmp1"
    assert s["total"] == 3
    assert s["by_status"] == {"gated": 1, "produced": 1, "planned": 1}
    assert s["by_gate"] == {"ship": 1, "revise": 0, "block": 2}  # produced+planned block
    assert s["ready_to_publish"] == 1
    print("ok test_campaign_status_counts")


def test_save_then_load_roundtrips_latest():
    with temp_memory() as mem:
        assert load_campaign("cmp1", mem) is None  # nothing yet, no crash

        camp = plan_campaign("cmp1", "Launch v1", "acme", _SPECS, ts="t0")
        save_campaign(camp, mem)
        assert mem.exists(), "save_campaign must auto-create the memory file"

        # a later save for the SAME id supersedes the earlier one
        camp = record_result(camp, "docs", path="/out/post.md", verdict="ship")
        save_campaign(camp, mem)

        by_id = load_campaign("cmp1", mem)
        assert by_id is not None
        assert by_id["deliverables"][0]["verdict"] == "ship", by_id
        # the same latest campaign is addressable by its project too
        by_project = load_campaign("acme", mem)
        assert by_project is not None
        assert by_project["id"] == "cmp1"
        assert by_project["deliverables"][0]["verdict"] == "ship"
        # unknown id/project -> None
        assert load_campaign("ghost", mem) is None
        print("ok test_save_then_load_roundtrips_latest")


def test_load_ignores_other_kinds_and_returns_latest_across_ids():
    with temp_memory() as mem:
        # a brief/memory entry sharing the store must not be mistaken for a campaign
        memory_core.remember("decision", "picked postgres", project="acme")
        save_campaign(plan_campaign("cmpA", "goal A", "acme", []), mem)
        save_campaign(plan_campaign("cmpB", "goal B", "beta", []), mem)
        assert load_campaign("cmpA", mem)["goal"] == "goal A"
        assert load_campaign("cmpB", mem)["goal"] == "goal B"
        assert load_campaign("beta", mem)["id"] == "cmpB"
        print("ok test_load_ignores_other_kinds_and_returns_latest_across_ids")


def test_malformed_stored_campaign_does_not_raise():
    with temp_memory() as mem:
        # hand-write a store with entries that are missing keys / wrong shapes
        import json

        entries = [
            {"kind": "campaign"},  # no 'campaign' key
            {"kind": "campaign", "campaign": "not a dict"},
            {"kind": "campaign", "campaign": {"id": "good", "project": "p",
                                              "deliverables": [None, "oops",
                                                               {"type": "docs", "verdict": "ship",
                                                                "path": "/x.md"}]}},
            "totally not an entry",
        ]
        mem.write_text(json.dumps(entries), encoding="utf-8")

        # load must not raise on any of the malformed entries, and still find 'good'
        camp = load_campaign("good", mem)
        assert camp is not None and camp["id"] == "good"
        # status / gate / ready_to_publish over the malformed campaign never raise
        s = campaign_status(camp)
        assert s["total"] == 1  # only the one real dict deliverable counts
        assert s["ready_to_publish"] == 1
        assert ready_to_publish(camp)[0]["path"] == "/x.md"
        # a wholly malformed campaign is still safe
        assert campaign_status({"deliverables": "nope"})["total"] == 0
        assert campaign_status(None)["total"] == 0
        assert ready_to_publish({"deliverables": None}) == []
        print("ok test_malformed_stored_campaign_does_not_raise")


def _run():
    tests = [
        test_plan_campaign_shape_all_planned,
        test_record_result_transitions_planned_produced_gated,
        test_gate_verdict_rules,
        test_ready_to_publish_only_ship,
        test_new_path_after_ship_invalidates_stale_verdict,
        test_campaign_status_counts,
        test_save_then_load_roundtrips_latest,
        test_load_ignores_other_kinds_and_returns_latest_across_ids,
        test_malformed_stored_campaign_does_not_raise,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
