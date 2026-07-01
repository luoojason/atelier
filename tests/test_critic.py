"""Assert-based tests for the Critic subsystem — run with system python3.

These import ONLY the pure functions from critic_agent/tools/critic_core.py plus
stdlib, so they pass without agency_swarm / pydantic and touch nothing external.

    python3 tests/test_critic.py

The tools directory is put on sys.path so critic_core imports as a bare
top-level module, bypassing critic_agent/__init__.py (which imports
agency_swarm and would fail under the system python3).
"""

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOLS_DIR = os.path.join(_REPO_ROOT, "critic_agent", "tools")
sys.path.insert(0, _TOOLS_DIR)

from critic_core import (  # noqa: E402
    DEFAULT_THRESHOLDS,
    format_scorecard,
    rubric,
    verdict_from_scores,
)


def _all(value):
    """A full scorecard with every rubric dimension set to `value`."""
    return {dim: value for dim in rubric()}


def test_rubric_shape():
    dims = rubric()
    assert dims == ["brief_adherence", "factual_support", "format", "completeness"], dims
    # stable: a fresh call returns an equal but independent list
    assert rubric() == dims
    assert rubric() is not dims
    # every dimension is a non-empty string, no duplicates
    assert all(isinstance(d, str) and d for d in dims)
    assert len(set(dims)) == len(dims)
    print("ok test_rubric_shape")


def test_all_high_ships():
    assert verdict_from_scores(_all(9)) == "ship"
    assert verdict_from_scores(_all(10)) == "ship"
    print("ok test_all_high_ships")


def test_blocking_low_score_blocks():
    # one dimension well below the block threshold -> block, regardless of others
    scores = _all(9)
    scores["factual_support"] = 2
    assert verdict_from_scores(scores) == "block"
    # even a single all-low dimension blocks
    assert verdict_from_scores(_all(1)) == "block"
    print("ok test_blocking_low_score_blocks")


def test_mixed_revises():
    # nothing blocking, but not everything is clean -> revise
    scores = _all(9)
    scores["format"] = 6  # >= block (4), < ship (8)
    assert verdict_from_scores(scores) == "revise"
    print("ok test_mixed_revises")


def test_threshold_boundaries():
    block_t = DEFAULT_THRESHOLDS["block"]  # 4
    ship_t = DEFAULT_THRESHOLDS["ship"]    # 8
    # exactly at the block threshold is NOT blocking (block is strict <)
    scores = _all(9)
    scores["completeness"] = block_t
    assert verdict_from_scores(scores) == "revise", "score == block threshold must not block"
    # just below the block threshold IS blocking
    scores["completeness"] = block_t - 0.1
    assert verdict_from_scores(scores) == "block"
    # exactly at the ship threshold ships (ship is inclusive >=)
    assert verdict_from_scores(_all(ship_t)) == "ship"
    # just below the ship threshold revises
    assert verdict_from_scores(_all(ship_t - 0.1)) == "revise"
    print("ok test_threshold_boundaries")


def test_operator_thresholds_are_validated():
    # thresholds are an operator/config knob (the agent tool exposes no such
    # field). A well-formed override inside the score domain with block < ship
    # is honored; anything that would disable, invert, or escape the gate is not.
    scores = _all(6)
    # default (ship=8) -> revise; an operator lowering ship to 6 -> ship
    assert verdict_from_scores(scores) == "revise"
    assert verdict_from_scores(scores, {"block": 3, "ship": 6}) == "ship"
    # raise the block bar so 6 now blocks
    assert verdict_from_scores(scores, {"block": 7, "ship": 9}) == "block"
    # a malformed / partial override falls back to defaults, gate not disabled
    assert verdict_from_scores(_all(2), {"block": None}) == "block"
    assert verdict_from_scores(_all(2), {"bogus": 0}) == "block"
    # a collapsed gate {block==ship} cannot ship a floor score: it is rejected
    # and the defaults apply, so all-zero blocks instead of shipping
    assert verdict_from_scores(_all(0), {"block": 0, "ship": 0}) == "block"
    # an inverted gate {block>ship} is nonsense and must not gate on inversion;
    # it is discarded, defaults apply -> mid scores revise (not a bogus block)
    assert verdict_from_scores(_all(5), {"block": 9, "ship": 2}) == "revise"
    # out-of-range values are clamped into 0-10, not honored raw
    # block -5 -> 0, ship 50 -> 10, so 9s revise (short of the clamped ship=10)
    assert verdict_from_scores(_all(9), {"block": -5, "ship": 50}) == "revise"
    print("ok test_operator_thresholds_are_validated")


def test_partial_rubric_never_ships():
    # a review that scores only some rubric dimensions can never ship, even if
    # the scored dimensions are perfect: the omitted ones were never verified
    assert verdict_from_scores({"brief_adherence": 10}) == "revise"
    assert verdict_from_scores({"format": 9}) == "revise"
    # three of four high, one omitted -> still cannot ship
    scores = _all(9)
    del scores["completeness"]
    assert verdict_from_scores(scores) == "revise"
    # a present low score still blocks even when a dimension is missing
    assert verdict_from_scores({"brief_adherence": 1, "factual_support": 9}) == "block"
    print("ok test_partial_rubric_never_ships")


def test_empty_scores_never_ship():
    # the all()-over-empty trap must not silently ship an unscored review
    assert verdict_from_scores({}) == "revise"
    assert verdict_from_scores(None) == "revise"
    print("ok test_empty_scores_never_ship")


def test_non_numeric_score_fails_safe():
    # an unreadable score is treated as 0.0 -> blocking, never passing
    scores = _all(9)
    scores["format"] = "n/a"
    assert verdict_from_scores(scores) == "block"
    print("ok test_non_numeric_score_fails_safe")


def test_format_scorecard_renders_verdict_and_defects():
    scores = _all(9)
    scores["format"] = 6
    verdict = verdict_from_scores(scores)
    out = format_scorecard(scores, verdict, defects=["HIGH: missing churn", "LOW: typo"])
    # every rubric dimension appears
    for dim in rubric():
        assert dim in out, dim
    # defects are numbered and present
    assert "1. HIGH: missing churn" in out
    assert "2. LOW: typo" in out
    # verdict is shown uppercased as the final gate
    assert "Verdict: REVISE" in out
    # a non-rubric score is flagged rather than dropped
    tagged = format_scorecard({"vibes": 10}, "block")
    assert "vibes" in tagged and "non-rubric" in tagged
    assert "Verdict: BLOCK" in tagged
    print("ok test_format_scorecard_renders_verdict_and_defects")


def test_format_scorecard_marks_unscored_dims():
    # an incomplete review must render every rubric dimension; the ones that were
    # never scored are shown as "not scored", not silently omitted, so a reader
    # can tell a 1-dimension review from a 4-dimension one
    out = format_scorecard({"brief_adherence": 10}, "revise")
    assert "brief_adherence: 10" in out
    for dim in ("factual_support", "format", "completeness"):
        assert f"{dim}: not scored" in out, dim
    assert "Verdict: REVISE" in out
    print("ok test_format_scorecard_marks_unscored_dims")


def _run():
    tests = [
        test_rubric_shape,
        test_all_high_ships,
        test_blocking_low_score_blocks,
        test_mixed_revises,
        test_threshold_boundaries,
        test_operator_thresholds_are_validated,
        test_partial_rubric_never_ships,
        test_empty_scores_never_ship,
        test_non_numeric_score_fails_safe,
        test_format_scorecard_renders_verdict_and_defects,
        test_format_scorecard_marks_unscored_dims,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} tests passed.")


if __name__ == "__main__":
    _run()
