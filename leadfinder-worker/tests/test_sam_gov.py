import json
from datetime import date
from pathlib import Path

import httpx
import pytest
import respx

from leadfinder.adapters.base import BudgetExhaustedError, DateWindow
from leadfinder.adapters.sam_gov import SEARCH_URL, SamGovAdapter
from leadfinder.http import CallBudget, Client, HttpError

FIX = Path(__file__).parent / "fixtures" / "sam_gov"
WINDOW = DateWindow(date(2026, 11, 2), date(2026, 11, 2))
KEY = "TESTKEY1234567890"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def adapter(limit=2):
    return SamGovAdapter(Client(), api_key=KEY, page_limit=limit)


def by_offset(request):
    off = int(request.url.params["offset"])
    return httpx.Response(200, json=load("page_1.json" if off == 0 else "page_2.json"))


@respx.mock
def test_pagination_and_malformed_item_skipped():
    route = respx.get(SEARCH_URL).mock(side_effect=by_offset)
    budget = CallBudget(8)
    items = list(adapter().fetch(WINDOW, budget, None))
    assert len(items) == 3  # 4 records, one malformed
    assert route.call_count == 2 and budget.used == 2
    p = route.calls[0].request.url.params
    assert p["postedFrom"] == "11/02/2026" and p["postedTo"] == "11/02/2026" and p["limit"] == "2"
    assert "naics" not in str(route.calls[0].request.url).lower()


@respx.mock
def test_empty_page():
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=load("empty_page.json")))
    assert list(adapter(1000).fetch(WINDOW, CallBudget(8), None)) == []


@respx.mock
def test_429_with_retry_after_then_success(monkeypatch):
    slept = []
    import leadfinder.http as h
    monkeypatch.setattr(h, "sleep", slept.append)
    respx.get(SEARCH_URL).mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "7"}),
        httpx.Response(200, json=load("empty_page.json")),
    ])
    budget = CallBudget(8)
    list(adapter(1000).fetch(WINDOW, budget, None))
    assert slept == [7.0]
    assert budget.used == 2  # retries count against the budget


@respx.mock
def test_persistent_5xx_raises_redacted():
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(HttpError) as ei:
        list(adapter(1000).fetch(WINDOW, CallBudget(8), None))
    assert KEY not in str(ei.value) and "REDACTED" in str(ei.value)


@respx.mock
def test_budget_exhausted_saves_cursor_and_resume_continues():
    route = respx.get(SEARCH_URL).mock(side_effect=by_offset)
    got = []
    with pytest.raises(BudgetExhaustedError) as ei:
        for it in adapter().fetch(WINDOW, CallBudget(1), None):
            got.append(it)
    assert len(got) == 2
    cursor = ei.value.cursor
    assert cursor == {"posted_from": "2026-11-02", "posted_to": "2026-11-02", "offset": 1}
    # Next run, different requested window: cursor's window wins.
    later = DateWindow(date(2026, 11, 3), date(2026, 11, 4))
    rest = list(adapter().fetch(later, CallBudget(8), cursor))
    assert len(rest) == 1
    last = route.calls[-1].request.url.params
    assert last["offset"] == "1" and last["postedFrom"] == "11/02/2026"


def test_normalize_mapping():
    a = adapter()
    items = load("e2e_page.json")["opportunitiesData"]
    from leadfinder.adapters.base import RawItem
    d = a.normalize(RawItem(items[1]["noticeId"], items[1]))  # real NSWC Dahlgren item
    assert d.agency_name == "DEPT OF DEFENSE"
    assert d.sub_agency.startswith("DEPT OF THE NAVY / NAVSEA")
    assert d.solicitation_number == "N0017827Q6613"
    assert d.psc_code == "7B22" and d.naics_codes == ["334111"]
    assert d.contact_name == "Susan Madison" and d.contact_phone == "5406133296"
    assert d.location.zip in ("", None) and d.fallback_location.city == "DAHLGREN"
    assert d.fallback_basis == "contracting_office"
    assert d.description is None and d.description_url.endswith("noticeid=ffe0238fb4fe4c849c3b81d11fec3427")
    nav = a.normalize(RawItem(items[3]["noticeId"], items[3]))
    assert nav.location.state == "VA" and nav.location.city == "Norfolk" and nav.location_basis == "place_of_performance"
    # Contact "name" paragraphs are truncated
    dla = a.normalize(RawItem(items[2]["noticeId"], items[2]))
    assert len(dla.contact_name) <= 200


@respx.mock
def test_description_fetch_strips_html_and_spends_budget():
    respx.get(url__startswith="https://api.sam.gov/prod/opportunities/v1/noticedesc").mock(
        return_value=httpx.Response(200, json=load("noticedesc_av.json")))
    b = CallBudget(1)
    text = adapter().fetch_description("https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=x", b)
    assert text.startswith("Furnish and install Crestron control") and "<" not in text
    assert b.used == 1


def test_missing_key_fails_cleanly():
    from leadfinder.adapters.sam_gov import SamConfigError
    with pytest.raises(SamConfigError):
        list(SamGovAdapter(Client(), api_key="").fetch(WINDOW, CallBudget(8), None))


@pytest.mark.live
def test_live_one_call():
    from leadfinder.settings import get_settings
    if not get_settings().sam_api_key:
        pytest.skip("SAM_API_KEY not set")
    b = CallBudget(1)
    a = SamGovAdapter(Client(), page_limit=1)
    with pytest.raises(BudgetExhaustedError):  # one page of 1, then budget stops it
        items = list(a.fetch(WINDOW, b, None))
    assert b.used == 1
