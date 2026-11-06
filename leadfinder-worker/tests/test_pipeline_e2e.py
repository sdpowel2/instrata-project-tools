"""End-to-end: recorded fixtures -> run() -> opportunities, scores and distances in SQLite."""
import json
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import pytest
import respx
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from leadfinder.adapters.sam_gov import SEARCH_URL, SamGovAdapter
from leadfinder.db.models import (
    Office, OfficeDistance, Opportunity, OpportunityScore, RawRecord, Source, SourceRun, ZipCentroid,
)
from leadfinder.http import Client
from leadfinder.pipeline import run as run_mod
from leadfinder.pipeline.run import rescore_all, run

FIX = Path(__file__).parent / "fixtures" / "sam_gov"
NOW = datetime(2026, 11, 3, 15, 0, tzinfo=timezone.utc)
KEY = "TESTKEY1234567890"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


@pytest.fixture
def factory(engine, seeded):
    seeded.add_all([
        ZipCentroid(zip="23511", lat=36.9400, lon=-76.3000, vintage="t"),   # Norfolk
        ZipCentroid(zip="23801", lat=37.2100, lon=-77.4000, vintage="t"),   # Petersburg
        ZipCentroid(zip="22448", lat=38.3300, lon=-77.0400, vintage="t"),   # Dahlgren
        ZipCentroid(zip="85309", lat=33.5400, lon=-112.3600, vintage="t"),  # Luke AFB
    ])
    seeded.commit()
    return sessionmaker(bind=engine, expire_on_commit=False)


def sam(limit=1000):
    return {"sam_gov": SamGovAdapter(Client(), api_key=KEY, page_limit=limit)}


def go(factory, **kw):
    kw.setdefault("adapters", sam())
    return run(sources=["sam_gov"], since=date(2026, 11, 2), until=date(2026, 11, 2), trigger="cli",
               session_factory=factory, geocode_online=False, now=kw.pop("now", NOW), **kw)


@respx.mock
def test_end_to_end_and_idempotent(factory):
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=load("e2e_page.json")))
    desc = respx.get(url__startswith="https://api.sam.gov/prod/opportunities/v1/noticedesc").mock(
        return_value=httpx.Response(200, json=load("noticedesc_av.json")))

    r1 = go(factory)
    assert r1.status == "succeeded"
    sr = r1.source_runs[0]
    assert (sr.records_fetched, sr.records_new, sr.records_updated) == (7, 7, 0)

    s = factory()
    opps = {o.source_record_id: o for o in s.execute(select(Opportunity)).scalars()}
    nav = opps["a0000000000000000000000000000001"]
    assert nav.score.lane == "direct_av" and nav.score.score == 100
    assert nav.loc_state == "VA" and nav.location_basis == "place_of_performance" and nav.geocode_method == "zip_centroid"
    assert nav.description.startswith("Furnish and install Crestron")  # AV + in range -> description fetched
    likely = opps["a0000000000000000000000000000002"]
    assert likely.score.lane == "likely_av_scope" and likely.notice_type == "presolicitation"
    az = opps["a0000000000000000000000000000004"]
    assert az.location_basis == "contracting_office" and az.score.lane == "direct_av"
    # Amendment shares the group with the original notice
    assert opps["a0000000000000000000000000000003"].group_key == nav.group_key
    # Past-due real item (due 2026-11-04 is still open; nothing past due in fixture)
    assert opps["ffe0238fb4fe4c849c3b81d11fec3427"].status == "open"
    # Distances: every located opp has one row per active office and exactly one nearest
    n_off = s.execute(select(func.count()).select_from(Office).where(Office.active.is_(True))).scalar_one()
    for o in opps.values():
        if o.lat is not None:
            rows = s.execute(select(OfficeDistance).where(OfficeDistance.opportunity_id == o.id)).scalars().all()
            assert len(rows) == n_off and sum(r.is_nearest for r in rows) == 1
    assert next(d for d in nav.distances if d.is_nearest).office.name == "Tidewater"
    # Descriptions only for AV-lane + in-range: nav, amendment, likely (Petersburg is 100mi-ish of Raleigh/Tidewater)
    assert desc.call_count <= 4
    raw_count = s.execute(select(func.count()).select_from(RawRecord)).scalar_one()
    s.close()

    r2 = go(factory, now=NOW.replace(hour=16))
    sr2 = r2.source_runs[0]
    assert sr2.records_new == 0 and sr2.records_updated == 0
    s = factory()
    assert s.execute(select(func.count()).select_from(Opportunity)).scalar_one() == 7
    assert s.execute(select(func.count()).select_from(RawRecord)).scalar_one() == raw_count
    s.close()


@respx.mock
def test_changed_payload_marks_updated(factory):
    page = load("e2e_page.json")
    route = respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=page))
    respx.get(url__startswith="https://api.sam.gov/prod/opportunities/v1/noticedesc").mock(
        return_value=httpx.Response(200, json={"description": ""}))
    go(factory)
    page2 = json.loads(json.dumps(page))
    page2["opportunitiesData"][3]["responseDeadLine"] = "2026-12-08T14:00:00-05:00"
    route.mock(return_value=httpx.Response(200, json=page2))
    later = NOW.replace(hour=18)
    r = go(factory, now=later)
    assert r.source_runs[0].records_updated == 1
    s = factory()
    o = s.execute(select(Opportunity).where(Opportunity.source_record_id == "a0000000000000000000000000000001")).scalar_one()
    assert o.last_changed_at == later and o.first_seen_at == NOW
    s.close()


@respx.mock
def test_budget_exhausted_is_partial_and_next_run_resumes(factory):
    def by_offset(request):
        off = int(request.url.params["offset"])
        return httpx.Response(200, json=load("page_1.json" if off == 0 else "page_2.json"))
    route = respx.get(SEARCH_URL).mock(side_effect=by_offset)
    s = factory()
    s.get(Source, "sam_gov").daily_call_budget = 1
    s.commit()
    s.close()

    r1 = go(factory, adapters=sam(limit=2))
    sr = r1.source_runs[0]
    assert r1.status == "partial" and sr.status == "partial"
    assert sr.resume_cursor == {"posted_from": "2026-11-02", "posted_to": "2026-11-02", "offset": 1}
    assert sr.api_calls_used == 1 and sr.records_fetched == 2

    # Same day: budget is spent across runs, so a second run can't make any call.
    r_same = go(factory, adapters=sam(limit=2), now=NOW.replace(hour=20))
    assert r_same.source_runs[0].status == "partial" and r_same.source_runs[0].api_calls_used == 0

    # Next day: budget resets; resumes at page 1.
    tomorrow = datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)
    r2 = run(sources=["sam_gov"], trigger="cli", session_factory=factory, adapters=sam(limit=2),
             geocode_online=False, now=tomorrow)
    assert r2.source_runs[0].status == "succeeded"
    assert route.calls[-1].request.url.params["offset"] == "1"
    s = factory()
    assert s.get(Source, "sam_gov").last_success_at.date() == date(2026, 11, 2)  # the resumed window
    s.close()


@respx.mock
def test_source_failure_is_recorded_redacted(factory):
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(503))
    r = go(factory)
    sr = r.source_runs[0]
    assert r.status == "failed" and sr.status == "failed"
    assert KEY not in (sr.error or "") and "REDACTED" in sr.error


def test_one_run_at_a_time(factory):
    assert run_mod._RUN_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(run_mod.RunInProgress):
            go(factory)
    finally:
        run_mod._RUN_LOCK.release()


@respx.mock
def test_rescore_and_expiry(factory):
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=load("e2e_page.json")))
    respx.get(url__startswith="https://api.sam.gov/prod/opportunities/v1/noticedesc").mock(
        return_value=httpx.Response(200, json={"description": ""}))
    go(factory)
    assert rescore_all(factory) == 7
    # A run after the due date closes the notice.
    later = datetime(2026, 11, 5, 15, 0, tzinfo=timezone.utc)
    respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=load("empty_page.json")))
    go(factory, now=later)
    s = factory()
    o = s.execute(select(Opportunity).where(Opportunity.source_record_id == "ffe0238fb4fe4c849c3b81d11fec3427")).scalar_one()
    assert o.status == "closed"
    s.close()
