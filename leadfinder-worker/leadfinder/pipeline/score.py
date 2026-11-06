"""Rule-based AV relevance scoring, fully driven by config/scoring.yaml."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable

from leadfinder.config import scoring_config

# Word boundary on alphanumerics only, so "Ave." and "27 41" work as terms.
_L = r"(?<![A-Za-z0-9])"
_R = r"(?![A-Za-z0-9])"


def _term_regex(term: str, case_sensitive: bool = False, plural: bool = False) -> re.Pattern[str]:
    # Spaces in a term match any run of whitespace so "video  wall" still hits.
    parts = [re.escape(p) for p in re.split(r"\s+", term.strip())]
    body = r"\s+".join(parts)
    if term.endswith("."):
        right = ""
    elif plural:
        right = r"(?:e?s)?" + _R
    else:
        right = _R
    return re.compile(_L + body + right, 0 if case_sensitive else re.IGNORECASE)


def _token_regex(token: str) -> re.Pattern[str]:
    # Standalone uppercase token: not touching letters, digits, '/' or '-'
    # (so "AV-8B" and "AV/IT" style compounds don't count; "A/V" itself is allowed).
    return re.compile(r"(?<![A-Za-z0-9/\-])" + re.escape(token) + r"(?![A-Za-z0-9/\-])")


@dataclass
class ScoreResult:
    lane: str
    score: int
    matched_codes: list[str] = field(default_factory=list)
    matched_keywords: list[str] = field(default_factory=list)
    negative_hits: list[str] = field(default_factory=list)
    scorer_version: str = ""


class Scorer:
    def __init__(self, cfg: dict[str, Any] | None = None):
        cfg = cfg or scoring_config()
        self.cfg = cfg
        self.version = str(cfg.get("scorer_version", "unversioned"))
        self.direct_min = int(cfg.get("lanes", {}).get("direct_av_min_score", 50))

        psc = cfg.get("psc", {})
        self.psc_rules: list[tuple[str, set[str], int]] = []
        for name in ("strong", "candidate"):
            r = psc.get(name) or {}
            if r.get("enabled", True) and r.get("codes"):
                self.psc_rules.append((f"PSC {name}", {str(c).upper() for c in r["codes"]}, int(r["weight"])))

        naics = cfg.get("naics", {})
        self.naics_rules: list[tuple[str, set[str], int]] = []
        for name in ("strong", "weak"):
            r = naics.get(name) or {}
            if r.get("enabled", True) and r.get("codes"):
                self.naics_rules.append((f"NAICS {name}", {str(c) for c in r["codes"]}, int(r["weight"])))

        kw = cfg.get("keywords", {})
        st = kw.get("strong", {})
        self.strong = [(t, _term_regex(t)) for t in st.get("terms", [])]
        self.strong_title_w, self.strong_title_cap = int(st.get("title_weight", 40)), int(st.get("title_cap", 60))
        self.strong_desc_w, self.strong_desc_cap = int(st.get("description_weight", 15)), int(st.get("description_cap", 30))
        md = kw.get("medium", {})
        self.medium = [(t, _term_regex(t)) for t in md.get("terms", [])]
        self.medium_w, self.medium_cap = int(md.get("weight", 10)), int(md.get("cap", 20))

        tok = cfg.get("av_token", {})
        self.tokens = [(t, _token_regex(t)) for t in tok.get("tokens", [])]
        self.token_title_w = int(tok.get("title_weight", tok.get("weight", 20)))
        self.token_desc_w = int(tok.get("description_weight", tok.get("weight", 20)))

        neg = cfg.get("negative", {})
        self.negatives = [(t, _term_regex(t)) for t in neg.get("terms", [])]
        self.neg_w = int(neg.get("weight", -50))

        tr = cfg.get("trade", {})
        self.trade_w = int(tr.get("strong_weight", 60))
        self.trade_strong = [(x, _term_regex(x)) for x in tr.get("strong_terms", [])]
        self.trade_tokens = [(x, _token_regex(x)) for x in tr.get("strong_tokens", [])]
        self.trade_likely = [(x, _term_regex(x)) for x in tr.get("likely_terms", [])]

        lk = cfg.get("likely_av_scope", {})
        # Likely-lane terms also match plurals ("Renovations", "Additions", "Schools") - D-10.
        self.building = [(t, _term_regex(t, plural=True)) for t in lk.get("building_types", [])]
        self.construction = [(t, _term_regex(t, plural=True)) for t in lk.get("construction_terms", [])]
        self.construction_naics = {str(c) for c in lk.get("construction_naics", [])}

    @staticmethod
    def _hits(rules: Iterable[tuple[str, re.Pattern[str]]], text: str) -> list[str]:
        return [t for t, rx in rules if text and rx.search(text)]

    def score(self, title: str | None, description: str | None = None,
              psc_code: str | None = None, naics_codes: Iterable[str] | None = None,
              trade: str | None = None) -> ScoreResult:
        title = title or ""
        desc = description or ""
        both = f"{title}\n{desc}"
        naics = {str(n).strip() for n in (naics_codes or []) if n}
        psc = (psc_code or "").strip().upper()

        total = 0
        codes: list[str] = []
        keywords: list[str] = []

        for label, set_, w in self.psc_rules:
            if psc and psc in set_:
                total += w
                codes.append(f"{label}: {psc}")
                break  # one PSC per notice
        for label, set_, w in self.naics_rules:
            hit = sorted(naics & set_)
            if hit:
                total += w
                codes.append(f"{label}: {', '.join(hit)}")
                break

        # Trade the invite is for (BuildingConnected). Authoritative, so negatives in the
        # project description don't pull an AV-trade invite out of Direct AV.
        trade = (trade or "").strip()
        trade_strong = bool(trade) and bool(self._hits(self.trade_strong, trade) or self._hits(self.trade_tokens, trade))
        trade_likely = bool(trade) and not trade_strong and bool(self._hits(self.trade_likely, trade))
        if trade_strong:
            total += self.trade_w
            codes.append(f"trade: {trade}")

        strong_title = self._hits(self.strong, title)
        if strong_title:
            total += min(self.strong_title_w * len(strong_title), self.strong_title_cap)
            keywords += [f"title: {t}" for t in strong_title]
        strong_desc = [t for t in self._hits(self.strong, desc) if t not in strong_title]
        if strong_desc:
            total += min(self.strong_desc_w * len(strong_desc), self.strong_desc_cap)
            keywords += [f"description: {t}" for t in strong_desc]

        medium = self._hits(self.medium, both)
        if medium:
            total += min(self.medium_w * len(medium), self.medium_cap)
            keywords += [f"medium: {t}" for t in medium]

        # Counted once, however many tokens; title beats description.
        tokens_title = self._hits(self.tokens, title)
        tokens_desc = self._hits(self.tokens, desc)
        if tokens_title:
            total += self.token_title_w
            keywords += [f"title token: {t}" for t in tokens_title]
        elif tokens_desc:
            total += self.token_desc_w
            keywords += [f"description token: {t}" for t in tokens_desc]

        negatives = self._hits(self.negatives, both)
        total += self.neg_w * len(negatives)

        if trade_strong:
            total = max(total, self.trade_w)
        total = max(0, min(100, total))

        if total >= self.direct_min:
            lane = "direct_av"
        elif trade_likely:  # the invite's trade outranks negatives in the GC's project text (D-18)
            lane = "likely_av_scope"
            keywords.append(f"trade: {trade}")
        else:
            buildings = self._hits(self.building, both)
            constr = self._hits(self.construction, both)
            constr_naics = sorted(naics & self.construction_naics)
            # Any negative hit (aviation, janitorial, ...) blocks the Likely lane (DECISIONS D-8).
            if buildings and (constr or constr_naics) and not negatives:
                lane = "likely_av_scope"
                keywords += [f"building: {t}" for t in buildings] + [f"construction: {t}" for t in constr]
                if constr_naics:
                    codes.append(f"NAICS construction: {', '.join(constr_naics)}")
            else:
                lane = "none"

        return ScoreResult(lane, total, codes, keywords, negatives, self.version)


@lru_cache
def default_scorer() -> Scorer:
    return Scorer()
