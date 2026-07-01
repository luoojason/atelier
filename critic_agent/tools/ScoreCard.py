"""Turn the Critic's dimension scores + defects into a gated verdict.

Thin BaseTool wrapper: all real logic (the deterministic verdict, the rendered
scorecard) lives in critic_core. The point of routing through this tool is that
the ship/revise/block decision is computed from the scores, not chosen by the
agent — a low score cannot be shipped by fiat. The gate thresholds are NOT
exposed here on purpose: they are an operator/config value, so the agent cannot
lower the ship bar to wave a weak deliverable through.
"""

from agency_swarm.tools import BaseTool
from pydantic import Field

from .critic_core import format_scorecard, rubric, verdict_from_scores


class ScoreCard(BaseTool):
    """
    Finalize a pre-publish review. Given the per-dimension scores you assigned
    (brief_adherence, factual_support, format, completeness on a 0-10 scale) and
    the defects you found, this returns the DETERMINISTIC verdict — ship, revise,
    or block — computed from those scores plus a rendered scorecard. You cannot
    override the verdict, and you cannot set the gate thresholds (they are fixed
    by the operator). Score EVERY rubric dimension honestly and cite evidence for
    every defect: omitting a dimension does not sneak a ship — an unscored rubric
    dimension can never pass, and the scorecard shows it as "not scored". Scores
    are validated to the 0-10 domain (anything non-numeric, non-finite, or out of
    range is treated as 0, so a huge number cannot manufacture a ship), and the
    defects you list feed the gate: a CRITICAL defect forces block and a HIGH
    defect can never ship, so you cannot report a blocking problem and still wave
    it through with high numbers. Use this as the last step of a review, after
    loading the brief with ReadBrief and checking the deliverable against goal /
    must_include / must_avoid / done_criteria.
    """

    scores: dict = Field(
        ...,
        description=(
            "Per-dimension scores on a 0-10 scale. Provide EVERY rubric "
            f"dimension {rubric()}; a missing dimension can never ship (it "
            "downgrades the verdict to at best revise). Lower is worse; any "
            "dimension below the block threshold forces a block verdict."
        ),
    )
    defects: list[str] = Field(
        default_factory=list,
        description=(
            "Defects found, each a short string ideally prefixed with severity "
            "and the evidence that supports it, ordered most severe first. "
            "e.g. 'HIGH: omits Q3 churn required by must_include (section 2)'."
        ),
    )

    def run(self) -> str:
        verdict = verdict_from_scores(self.scores, defects=self.defects)
        return format_scorecard(self.scores, verdict, self.defects)
