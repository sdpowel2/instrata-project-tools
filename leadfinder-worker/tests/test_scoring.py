from pathlib import Path

import pytest
import yaml

from leadfinder.pipeline.score import Scorer

CASES = yaml.safe_load((Path(__file__).parent / "fixtures" / "scoring_cases.yaml").read_text(encoding="utf-8"))["cases"]
SCORER = Scorer()


def test_at_least_40_cases():
    assert len(CASES) >= 40


@pytest.mark.parametrize("case", CASES, ids=[c["title"][:50] for c in CASES])
def test_scoring_case(case):
    r = SCORER.score(case["title"], case.get("description"), case.get("psc"), case.get("naics"))
    assert r.lane == case["lane"], f"score={r.score} codes={r.matched_codes} kw={r.matched_keywords} neg={r.negative_hits}"


def test_score_is_clamped():
    assert SCORER.score("Audiovisual Video Wall Crestron Extron AV system", psc_code="5830", naics_codes=["334310"]).score == 100
    assert SCORER.score("Aviation Fuel Janitorial Landscaping").score == 0


def test_why_is_recorded():
    r = SCORER.score("Crestron upgrade", "Replace aviation lounge projector", psc_code="5836")
    assert any("PSC strong" in c for c in r.matched_codes)
    assert "title: Crestron" in r.matched_keywords
    assert r.negative_hits == ["aviation"]
    assert r.scorer_version
