"""SAM.gov Get Opportunities API adapter.

One unfiltered pull of everything posted in the window, paginated with limit=1000.
No server-side NAICS/PSC filtering (costs a call per code and drops keyword matches).
"""
from __future__ import annotations

import html
import logging
import re
from datetime import date
from typing import Any, Iterator

from leadfinder.adapters.base import AddressDraft, BudgetExhaustedError, DateWindow, OpportunityDraft, RawItem
from leadfinder.http import BudgetExhausted, CallBudget, Client, HttpError
from leadfinder.settings import get_settings, redact

log = logging.getLogger(__name__)

SEARCH_URL = "https://api.sam.gov/opportunities/v2/search"
DESCRIPTION_MAX = 4000


class SamConfigError(Exception):
    pass


def _fmt(d: date) -> str:
    return d.strftime("%m/%d/%Y")


def _sub(obj: Any, *keys: str) -> Any:
    """Safe nested get; SAM returns {code,name} objects for state/city/country."""
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


def _code_or_name(v: Any) -> str | None:
    if isinstance(v, dict):
        return v.get("code") or v.get("name")
    return v or None


def _name_or_code(v: Any) -> str | None:
    if isinstance(v, dict):
        return v.get("name") or v.get("code")
    return v or None


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</li>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()


class SamGovAdapter:
    source_id = "sam_gov"

    def __init__(self, client: Client, api_key: str | None = None, page_limit: int = 1000,
                 base_url: str = SEARCH_URL):
        self.client = client
        self.api_key = api_key if api_key is not None else get_settings().sam_api_key
        self.page_limit = page_limit
        self.base_url = base_url

    # ------------------------------------------------------------------ fetch
    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]:
        if not self.api_key:
            raise SamConfigError("SAM_API_KEY is not set")
        if (window.posted_to - window.posted_from).days > 365:
            raise ValueError("SAM.gov window must be 1 year or less")

        # A resume cursor pins the original window so offsets stay valid.
        if cursor:
            posted_from = date.fromisoformat(cursor["posted_from"])
            posted_to = date.fromisoformat(cursor["posted_to"])
            offset = int(cursor.get("offset", 0))
        else:
            posted_from, posted_to, offset = window.posted_from, window.posted_to, 0

        # NOTE: SAM's `offset` is a 0-based PAGE INDEX, not a record offset (verified live 2026-11-03).
        def cur(off: int) -> dict:
            return {"posted_from": posted_from.isoformat(), "posted_to": posted_to.isoformat(), "offset": off}

        while True:
            if not budget.can_spend():
                raise BudgetExhaustedError(cur(offset))
            params = {"api_key": self.api_key, "postedFrom": _fmt(posted_from), "postedTo": _fmt(posted_to),
                      "limit": self.page_limit, "offset": offset}
            try:
                resp = self.client.get(self.base_url, params=params, budget=budget)
            except BudgetExhausted:
                # Ran out mid-retry: resume from this same page.
                raise BudgetExhaustedError(cur(offset))
            data = resp.json()
            items = data.get("opportunitiesData") or []
            total = int(data.get("totalRecords") or 0)
            for it in items:
                nid = it.get("noticeId") if isinstance(it, dict) else None
                if not nid:
                    log.warning("sam item without noticeId skipped", extra={"offset": offset})
                    continue
                yield RawItem(source_record_id=str(nid), payload=it)
            offset += 1
            if not items or offset * self.page_limit >= total:
                return

    # -------------------------------------------------------------- normalize
    def normalize(self, raw: RawItem) -> OpportunityDraft:
        p: dict[str, Any] = raw.payload if isinstance(raw.payload, dict) else {}
        path = [seg.strip() for seg in (p.get("fullParentPathName") or "").split(".") if seg.strip()]
        agency = path[0] if path else None
        sub = " / ".join(path[1:]) if len(path) > 1 else None

        naics = p.get("naicsCodes") or ([p["naicsCode"]] if p.get("naicsCode") else [])
        poc = (p.get("pointOfContact") or [None])[0] or {}
        links = p.get("resourceLinks") or []

        pop = p.get("placeOfPerformance") or {}
        pop_addr = AddressDraft(
            street=" ".join(x for x in [pop.get("streetAddress"), pop.get("streetAddress2")] if x) or None,
            city=_name_or_code(pop.get("city")),
            state=_code_or_name(pop.get("state")),
            zip=pop.get("zip"),
        )
        country = _code_or_name(pop.get("country"))
        if country and country not in ("USA", "US"):
            pop_addr = AddressDraft()  # foreign place of performance: no US location
        off = p.get("officeAddress") or {}
        off_addr = AddressDraft(street=off.get("streetAddress"), city=off.get("city"),
                                state=off.get("state"), zip=off.get("zipcode"))

        ntype = p.get("type") or p.get("baseType")
        status_hint = None
        if ntype and re.search(r"award", ntype, re.I):
            status_hint = "awarded"
        elif ntype and re.search(r"cancel", ntype, re.I):
            status_hint = "cancelled"

        desc_url = p.get("description")
        desc_url = desc_url if isinstance(desc_url, str) and desc_url.startswith("http") else None

        def trunc(v: Any, n: int) -> str | None:
            v = (str(v).strip() if v else "") or None
            return v[:n] if v else None

        return OpportunityDraft(
            source_id=self.source_id,
            source_record_id=raw.source_record_id,
            solicitation_number=p.get("solicitationNumber"),
            title=p.get("title") or "(untitled)",
            description=None if desc_url or not p.get("description") else str(p.get("description")),
            agency_name=agency,
            sub_agency=sub,
            notice_type_raw=ntype,
            naics_codes=[str(n) for n in naics if n],
            psc_code=p.get("classificationCode"),
            set_aside=p.get("typeOfSetAsideDescription") or p.get("typeOfSetAside"),
            posted_at_raw=p.get("postedDate"),
            response_due_at_raw=p.get("responseDeadLine"),
            active=(str(p.get("active", "")).lower() == "yes"),
            status_hint=status_hint,
            url=p.get("uiLink"),
            documents_url=links[0] if links else None,
            contact_name=trunc(poc.get("fullName"), 200),
            contact_email=trunc(poc.get("email"), 200),
            contact_phone=trunc(poc.get("phone"), 50),
            location=pop_addr,
            location_basis="place_of_performance",
            fallback_location=off_addr,
            fallback_basis="contracting_office",
            state_hint=pop_addr.state or off_addr.state,
            description_url=desc_url,
        )

    # ------------------------------------------------------------- description
    def fetch_description(self, url: str, budget: CallBudget) -> str | None:
        """One call per notice. Caller decides whether it's worth spending."""
        sep = "&" if "?" in url else "?"
        try:
            resp = self.client.get(f"{url}{sep}api_key={self.api_key}", budget=budget)
        except HttpError as exc:
            log.warning("sam description fetch failed", extra={"error": redact(str(exc))})
            return None
        try:
            text = resp.json().get("description") or ""
        except ValueError:
            text = resp.text
        text = strip_html(text)
        return text[:DESCRIPTION_MAX] or None
