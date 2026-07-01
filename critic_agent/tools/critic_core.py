"""Pure scoring logic for the Critic agent — no agency_swarm / pydantic.

The Critic reviews a finished deliverable against a persisted Brief and produces
a scorecard of per-dimension scores. The *verdict* (ship / revise / block) is not
left to the agent's discretion: it is computed deterministically from those
scores here, so a low score can never be shipped by fiat. Two things are locked
down so the gate cannot be talked around: (1) the agent must score every rubric
dimension — omitting a dimension it would fail can never produce a ship, and the
scorecard renders the missing dimension explicitly rather than hiding it; and
(2) the gate thresholds are an operator/config value, not an agent input, and any
override is validated (clamped to the 0-10 score domain, block < ship enforced)
before it is used.

All real logic lives in these plain module-level functions. ScoreCard.py is a
thin BaseTool wrapper, and tests import ONLY these functions + stdlib under the
system python3.
"""

from __future__ import annotations

import math
import re

# Scores are on a 0-10 scale. A dimension strictly below `block` is a hard fail;
# every dimension at or above `ship` is clean. Anything in between is a revise.
# These are the operator/server defaults; the agent cannot change them.
DEFAULT_THRESHOLDS = {"block": 4.0, "ship": 8.0}

# The valid score domain. Any threshold override is clamped into this range so
# the gate can never be pushed outside the scale the scores live on.
_SCORE_MIN = 0.0
_SCORE_MAX = 10.0


def rubric() -> list:
    """The ordered list of review dimensions the Critic scores against.

    - brief_adherence: does the deliverable satisfy the Brief's goal /
      must_include / must_avoid / done_criteria?
    - factual_support: are claims backed by evidence, not asserted?
    - format: does the output match the requested shape / length / structure?
    - completeness: is every part of the ask actually delivered?
    """
    return ["brief_adherence", "factual_support", "format", "completeness"]


def _coerce_thresholds(thresholds) -> tuple:
    """Return (block_threshold, ship_threshold) as validated floats.

    Thresholds are an operator/config knob, never an agent input (the agent-
    facing ScoreCard tool exposes no thresholds field). An override is honored
    only when it keeps the gate meaningful:

      - each recognized value is coerced to a float and clamped into the
        [0, 10] score domain (out-of-range or malformed values are rejected),
      - the resulting pair must satisfy block < ship.

    If the override collapses or inverts the gate (block >= ship) — the exact
    shape that would let a low score ship or turn a clean score into a block —
    the whole override is discarded and the defaults are used. A caller can
    therefore shift the gate within a still-meaningful range, but can never
    silently disable, invert, or push it outside the score domain.
    """
    t = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        for key in ("block", "ship"):
            value = thresholds.get(key)
            if value is None:
                continue
            try:
                num = float(value)
            except (TypeError, ValueError):
                continue
            t[key] = min(_SCORE_MAX, max(_SCORE_MIN, num))
    if not (t["block"] < t["ship"]):
        return DEFAULT_THRESHOLDS["block"], DEFAULT_THRESHOLDS["ship"]
    return t["block"], t["ship"]


def _numeric_scores(scores) -> list:
    """Coerce a {dimension: score} mapping into a list of valid float scores.

    A score that is not a readable, finite number inside the [0, 10] domain fails
    safe: it is treated as 0.0 so it can never be counted as a passing dimension.
    This is deliberate — the gate exists to stop a bad review from shipping, so
    garbage input errs toward blocking. "Garbage" here covers three things that
    all used to slip through:

      - non-numeric input (e.g. "n/a") -> ValueError on float(), coerced to 0.0;
      - a non-finite float (NaN, +/-inf) -> float() accepts it, but NaN silently
        satisfies neither `< block` nor `>= ship`, which used to launder a hard
        failure down to "revise"; isfinite() rejects it to 0.0 so it blocks like
        any other unreadable score;
      - an out-of-domain number (e.g. 999 or -1) -> the scale is 0-10, so a value
        outside it is not a real score. It is coerced to 0.0 (never clamped UP to
        10), so typing a huge number can never manufacture a ship.
    """
    values = []
    for raw in (scores or {}).values():
        try:
            num = float(raw)
        except (TypeError, ValueError):
            values.append(0.0)
            continue
        if not math.isfinite(num) or not (_SCORE_MIN <= num <= _SCORE_MAX):
            values.append(0.0)
            continue
        values.append(num)
    return values


def _defect_severity_rank(defects) -> int:
    """Highest self-reported defect severity: 2=critical, 1=high, 0=none/other.

    The instructions require every defect to be prefixed with its severity
    ("CRITICAL: ...", "HIGH: ..."). Only the label before the first ':' is
    inspected, so a severity word appearing later in the evidence prose cannot
    trip a false positive. Unlabeled or lower-severity ("MEDIUM"/"LOW") defects
    return 0 and do not move the gate on their own.
    """
    rank = 0
    for defect in defects or []:
        label = str(defect).split(":", 1)[0].lower()
        words = set(re.findall(r"[a-z]+", label))
        if "critical" in words:
            rank = max(rank, 2)
        elif "high" in words:
            rank = max(rank, 1)
    return rank


def verdict_from_scores(scores: dict, thresholds: dict = None,
                        defects=None) -> str:
    """Deterministically derive the publish verdict from dimension scores.

    Rules (0-10 scale, defaults block<4, ship>=8):
      - any scored dimension strictly below the block threshold -> "block"
      - otherwise, if any rubric dimension was left unscored -> "revise"
        (an incomplete review is never shippable: a dimension that was never
        scored was never verified, so it can never count as passing)
      - otherwise every dimension at/above the ship threshold -> "ship"
      - otherwise -> "revise"

    The SET of scored dimensions is not left to the agent's discretion: the full
    rubric must be covered before a ship is even possible, so omitting a
    dimension you would fail downgrades to revise rather than sneaking a ship.
    Block still wins over an incomplete review — an actually-present low score is
    a proven hard failure, whereas a missing dimension is merely unverified.

    An empty / unscored review can never ship (all() over an empty list is a trap
    that would silently pass): it returns "revise", the safest non-shipping
    verdict, since there is nothing blocking but also nothing verified.

    `thresholds` is an operator/config input only; see _coerce_thresholds. It is
    validated (clamped to 0-10, block < ship) before use, so a low score can
    never be shipped by fiat.

    `defects` is a defect-floor cross-check so the evidence channel actually
    gates instead of being decorative. A review that itself reports a blocking
    problem cannot be shipped by typing high numbers next to it:
      - a CRITICAL defect is a hard failure -> "block", overriding the scores;
      - a HIGH defect can never ship -> a score-derived "ship" is downgraded to
        "revise".
    The floor only ever tightens the verdict (it never turns a block/revise into
    a ship), and MEDIUM/LOW/unlabeled defects do not move it on their own.
    """
    block_t, ship_t = _coerce_thresholds(thresholds)
    scores = scores or {}
    values = _numeric_scores(scores)
    verdict = _verdict_from_values(values, scores, block_t, ship_t)

    severity = _defect_severity_rank(defects)
    if severity >= 2:
        return "block"
    if severity >= 1 and verdict == "ship":
        return "revise"
    return verdict


def _verdict_from_values(values, scores, block_t, ship_t) -> str:
    """The score-only verdict, before the defect floor is applied."""
    if any(v < block_t for v in values):
        return "block"
    missing = [dim for dim in rubric() if dim not in scores]
    if missing:
        return "revise"
    if not values:
        return "revise"
    if all(v >= ship_t for v in values):
        return "ship"
    return "revise"


def format_scorecard(scores, verdict, defects=None) -> str:
    """Render a readable scorecard: per-dimension scores, defects, then verdict.

    Every rubric dimension is listed in canonical order; a dimension that was
    never scored is rendered explicitly as "not scored" rather than silently
    dropped, so a reader can always tell a partial review from a full one (the
    misleading-omission analog of a misleading zero). Any extra scored dimension
    is appended and flagged. Defects are printed in the order given (the agent is
    responsible for severity-ranking them). The verdict is shown last, uppercased,
    so it reads as the final gate decision.
    """
    dims = rubric()
    scores = scores or {}
    lines = ["Scorecard", "========="]
    for dim in dims:
        if dim in scores:
            lines.append(f"- {dim}: {scores[dim]}")
        else:
            lines.append(f"- {dim}: not scored")
    for dim, value in scores.items():
        if dim not in dims:
            lines.append(f"- {dim}: {value} (non-rubric)")
    if defects:
        lines.append("")
        lines.append("Defects (severity-ranked):")
        for i, defect in enumerate(defects, 1):
            lines.append(f"  {i}. {defect}")
    lines.append("")
    lines.append(f"Verdict: {str(verdict).upper()}")
    return "\n".join(lines)
