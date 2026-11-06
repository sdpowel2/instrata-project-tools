import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from leadfinder import aps_auth
from leadfinder.adapters.base import BudgetExhaustedError, DateWindow
from leadfinder.adapters.buildingconnected import (
    OPPORTUNITIES_URL, BuildingConnectedAccessError, BuildingConnectedAdapter, coords,
)
from leadfinder.aps_auth import TOKEN_URL, ApsAuth, ApsNotConnected, TokenSet, TokenStore
from leadfinder.db.models import Opportunity, Source
from leadfinder.http import CallBudget, Client
from leadfinder.pipeline.run import run
from leadfinder.settings import redact

FIX = Path(__file__).parent / "fixtures" / "buildingconnected"
NOW = datetime(2026, 11, 3, 15, 0, tzinfo=timezone.utc)
WINDOW = DateWindow(date(2016, 11, 1), date(2026, 11, 3))


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def pages(request):
    cs = request.url.params.get("cursorState")
    return httpx.Response(200, json=load("opportunities_page_2.json" if cs else "opportunities_page_1.json"))


@pytest.fixture
def store(tmp_path):
    st = TokenStore(tmp_path / "aps_token.json")
    st.save(TokenSet(access_token="ACCESS-TOKEN-0001", refresh_token="REFRESH-TOKEN-0001",
                     expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                     connected_at=NOW.isoformat()))
    return st


def make_auth(store):
    return ApsAuth(Client(), client_id="cid-123", client_secret="csecret-xyz-987", store=store,
                   callback_url="http://localhost:8000/oauth/callback")


def adapter(store, **kw):
    auth = make_auth(store)
    return BuildingConnectedAdapter(auth.client, auth, page_limit=5, now=NOW, **kw)


# ---------------------------------------------------------------- auth

def test_authorize_url_and_state():
    auth = make_auth(TokenStore(Path("unused.json")))
    state = aps_auth.new_state()
    q = parse_qs(urlsplit(auth.authorize_url(state)).query)
    assert q["response_type"] == ["code"] and q["client_id"] == ["cid-123"]
    assert q["redirect_uri"] == ["http://localhost:8000/oauth/callback"]
    assert q["scope"] == ["data:read"] and q["state"] == [state]
    assert aps_auth.consume_state(state) is True
    assert aps_auth.consume_state(state) is False  # one-time
    assert aps_auth.consume_state("forged") is False


@respx.mock
def test_exchange_code_saves_tokens(tmp_path):
    route = respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={
        "access_token": "NEW-ACCESS-123456", "refresh_token": "NEW-REFRESH-123456", "expires_in": 3599,
        "token_type": "Bearer"}))
    st = TokenStore(tmp_path / "t.json")
    ts = make_auth(st).exchange_code("the-code")
    req = route.calls[0].request
    form = parse_qs(req.content.decode())
    assert form == {"grant_type": ["authorization_code"], "code": ["the-code"],
                    "redirect_uri": ["http://localhost:8000/oauth/callback"]}
    assert req.headers["Authorization"].startswith("Basic ")  # client credentials, not in the form
    assert st.load().refresh_token == "NEW-REFRESH-123456" and ts.access_token == "NEW-ACCESS-123456"
    assert "NEW-REFRESH-123456" not in redact("token NEW-REFRESH-123456 leaked")


@respx.mock
def test_expiring_token_is_refreshed_and_rotation_persisted(store):
    ts = store.load()
    ts.expires_at = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()  # inside the 5-min margin
    store.save(ts)
    route = respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={
        "access_token": "ACCESS-TOKEN-0002", "refresh_token": "REFRESH-TOKEN-0002", "expires_in": 3599}))
    assert make_auth(store).access_token() == "ACCESS-TOKEN-0002"
    form = parse_qs(route.calls[0].request.content.decode())
    assert form["grant_type"] == ["refresh_token"] and form["refresh_token"] == ["REFRESH-TOKEN-0001"]
    saved = store.load()
    assert saved.refresh_token == "REFRESH-TOKEN-0002"  # rotated token written to disk
    assert saved.connected_at == NOW.isoformat()  # connection metadata kept


@respx.mock
def test_rejected_refresh_means_reconnect(store):
    ts = store.load()
    ts.expires_at = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    store.save(ts)
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ApsNotConnected):
        make_auth(store).access_token()


def test_not_connected(tmp_path):
    with pytest.raises(ApsNotConnected):
        make_auth(TokenStore(tmp_path / "none.json")).access_token()


def test_redact_bearer_and_form_values():
    out = redact('Authorization: Bearer eyJabc.def-ghi refresh_token=XYZ123456789&x=1 {"access_token": "QQQ12345678"}')
    assert "eyJabc" not in out and "XYZ123456789" not in out and "QQQ12345678" not in out


# ---------------------------------------------------------------- fetch

@respx.mock
def test_pagination_filter_header_and_skips(store):
    route = respx.get(OPPORTUNITIES_URL).mock(side_effect=pages)
    a = adapter(store)
    budget = CallBudget(10)
    items = list(a.fetch(WINDOW, budget, None))
    ids = [i.source_record_id for i in items]
    # parent (p1) and the invite >30 days past due (…05) are skipped
    assert ids == ["6650a0000000000000000001", "6650a0000000000000000002", "6650a0000000000000000003",
                   "6650a0000000000000000004", "6650a0000000000000000006", "6650a0000000000000000007",
                   "6650a0000000000000000008"]
    assert a.skipped_parents == 1 and a.skipped_old == 1
    assert route.call_count == 2 and budget.used == 2
    first = route.calls[0].request
    assert first.headers["Authorization"] == "Bearer ACCESS-TOKEN-0001"
    assert first.url.params["filter[updatedAt]"] == "2016-11-01T00:00:00.000Z.."
    assert first.url.params["limit"] == "5" and "cursorState" not in first.url.params
    assert route.calls[1].request.url.params["cursorState"] == "eyJvZmZzZXQiOjV9"


@respx.mock
def test_budget_exhaustion_and_resume(store):
    route = respx.get(OPPORTUNITIES_URL).mock(side_effect=pages)
    a = adapter(store)
    got = []
    with pytest.raises(BudgetExhaustedError) as ei:
        for it in a.fetch(WINDOW, CallBudget(1), None):
            got.append(it)
    assert len(got) == 4
    cur = ei.value.cursor
    assert cur == {"updated_from": "2016-11-01T00:00:00.000Z", "cursorState": "eyJvZmZzZXQiOjV9"}
    rest = list(adapter(store).fetch(WINDOW, CallBudget(5), cur))
    assert len(rest) == 3 and route.calls[-1].request.url.params["cursorState"] == "eyJvZmZzZXQiOjV9"


@respx.mock
def test_401_refreshes_once(store):
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={
        "access_token": "ACCESS-TOKEN-0003", "refresh_token": "REFRESH-TOKEN-0003", "expires_in": 3599}))
    route = respx.get(OPPORTUNITIES_URL).mock(side_effect=[
        httpx.Response(401, json={"message": "expired"}),
        httpx.Response(200, json=load("opportunities_page_2.json")),
    ])
    items = list(adapter(store).fetch(WINDOW, CallBudget(5), None))
    assert len(items) == 3
    assert route.calls[1].request.headers["Authorization"] == "Bearer ACCESS-TOKEN-0003"


@respx.mock
def test_403_is_a_clear_access_error(store):
    respx.get(OPPORTUNITIES_URL).mock(return_value=httpx.Response(403, json={"message": "Forbidden"}))
    with pytest.raises(BuildingConnectedAccessError, match="Bid Board Pro"):
        list(adapter(store).fetch(WINDOW, CallBudget(5), None))


# ---------------------------------------------------------------- normalize

def test_coords_validation():
    assert coords({"coords": {"lat": 35.78, "lng": -78.64}, "precisionLevel": 10}) == (35.78, -78.64)
    assert coords({"coords": {"lat": -122.4, "lng": 37.79}}) == (37.79, -122.4)  # swapped (doc example)
    assert coords({"coords": {"lat": -76.3, "lng": 36.86}}) == (36.86, -76.3)  # swapped, both < 90
    assert coords({"coords": {"lat": 51.5, "lng": -0.12}, "country": "US"}) is None  # not in the US
    assert coords({"coords": {"lat": 35.0, "lng": -78.0}, "precisionLevel": 1}) is None  # country-level
    assert coords({"coords": {"lat": 0, "lng": 0}}) is None
    assert coords({"coords": None}) is None


def _norm(store, idx_page, idx):
    a = adapter(store)
    from leadfinder.adapters.base import RawItem
    it = load(idx_page)["results"][idx]
    return a.normalize(RawItem(source_record_id=it["id"], payload=it))


def test_normalize_mapping(store):
    d = _norm(store, "opportunities_page_1.json", 0)
    assert d.title == "Wake County Justice Center - AV Upgrade"
    assert d.agency_name == "Barnhill Contracting Company"
    assert d.solicitation_number == "BC-2041"
    assert d.url == "https://app.buildingconnected.com/opportunities/6650a0000000000000000001/info"
    assert d.source_latlon == (35.7804, -78.6391)
    assert d.location.street == "2 W Edenton St" and d.location.zip == "27601"
    assert d.group_hint == "6650a00000000000000000p1"
    assert d.source_status == "UNDECIDED" and d.active is True and d.status_hint is None
    assert d.est_value == 450000 and d.extra["value_basis"] == "ROM"
    assert d.trade == "Audio Visual" and d.extra["project_sqft"] == 82000
    assert "video wall" in d.description and "<b>" not in d.description
    assert d.notice_type_raw == "Request for Proposal"
    assert d.contact_name == "Pat Estimator"

    accepted = _norm(store, "opportunities_page_1.json", 3)
    assert accepted.source_status == "WILL_SUBMIT" and accepted.active is True
    assert accepted.est_value == 120000 and accepted.extra["value_basis"] == "final value"
    assert accepted.source_latlon == (36.861, -76.3036)

    declined = _norm(store, "opportunities_page_2.json", 1)
    assert declined.source_status == "DECLINED" and declined.active is False
    archived = _norm(store, "opportunities_page_2.json", 2)
    assert archived.source_status == "ARCHIVED" and archived.active is False
    airport = _norm(store, "opportunities_page_2.json", 3)
    assert airport.est_value == 98000 and airport.extra["value_basis"] == "bid total"


# ---------------------------------------------------------------- pipeline

@pytest.fixture
def bc_seeded(seeded):
    seeded.add(Source(id="buildingconnected", name="BuildingConnected Bid Board", kind="api", enabled=True,
                      daily_call_budget=200))
    seeded.commit()
    return seeded


@respx.mock
def test_pipeline_end_to_end(engine, bc_seeded, store):
    respx.get(OPPORTUNITIES_URL).mock(side_effect=pages)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    r = run(sources=["buildingconnected"], session_factory=factory, adapters={"buildingconnected": adapter(store)},
            geocode_online=False, now=NOW)
    sr = r.source_runs[0]
    assert r.status == "succeeded" and sr.records_new == 7 and sr.api_calls_used == 2
    s = factory()
    by_id = {o.source_record_id: o for o in s.execute(select(Opportunity)).scalars()}

    av = by_id["6650a0000000000000000001"]
    assert av.score.lane == "direct_av" and any(c.startswith("trade:") for c in av.score.matched_codes)
    assert av.geocode_method == "source_coords" and av.lat == 35.7804
    assert av.status == "open" and av.source_status == "UNDECIDED" and av.est_value == 450000
    assert av.extra["trade"] == "Audio Visual"
    near = [d for d in av.distances if d.is_nearest]
    assert len(near) == 1 and near[0].office.name == "Raleigh" and near[0].distance_miles < 10
    # Two GCs, one group
    assert by_id["6650a0000000000000000002"].group_key == av.group_key == "buildingconnected:group:6650a00000000000000000p1"

    lv = by_id["6650a0000000000000000003"]
    assert lv.score.lane == "likely_av_scope" and lv.lat == 36.861  # swapped coords fixed
    school = by_id["6650a0000000000000000004"]
    assert school.geocode_method == "city_centroid" and school.score.lane == "likely_av_scope"
    assert by_id["6650a0000000000000000006"].status == "closed"
    assert by_id["6650a0000000000000000007"].status == "closed"
    airport = by_id["6650a0000000000000000008"]
    assert airport.score.lane == "direct_av" and airport.score.negative_hits == ["aircraft"]
    s.close()

    # Identical re-run: nothing new or updated.
    r2 = run(sources=["buildingconnected"], session_factory=factory, adapters={"buildingconnected": adapter(store)},
             geocode_online=False, now=NOW + timedelta(hours=1))
    assert r2.source_runs[0].records_new == 0 and r2.source_runs[0].records_updated == 0

    # Someone declines the Skanska invite in Bid Board -> updated, closed.
    p1 = load("opportunities_page_1.json")
    p1["results"][1]["submissionState"] = "DECLINED"
    respx.get(OPPORTUNITIES_URL).mock(side_effect=lambda req: httpx.Response(
        200, json=load("opportunities_page_2.json") if req.url.params.get("cursorState") else p1))
    r3 = run(sources=["buildingconnected"], session_factory=factory, adapters={"buildingconnected": adapter(store)},
             geocode_online=False, now=NOW + timedelta(hours=2))
    assert r3.source_runs[0].records_updated == 1
    s = factory()
    sk = s.execute(select(Opportunity).where(Opportunity.source_record_id == "6650a0000000000000000002")).scalar_one()
    assert sk.status == "closed" and sk.source_status == "DECLINED"
    s.close()


def test_not_connected_source_fails_cleanly(engine, bc_seeded, tmp_path):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    auth = ApsAuth(Client(), client_id="cid", client_secret="sec", store=TokenStore(tmp_path / "missing.json"))
    r = run(sources=["buildingconnected"], session_factory=factory,
            adapters={"buildingconnected": BuildingConnectedAdapter(auth.client, auth, now=NOW)},
            geocode_online=False, now=NOW)
    assert r.status == "failed" and "not connected" in r.source_runs[0].error


def test_migration_allows_source_coords(tmp_path):
    import pathlib
    import sqlite3

    from leadfinder.db.migrate import upgrade

    db = tmp_path / "mig.db"
    upgrade(f"sqlite:///{db.as_posix()}")
    sql = sqlite3.connect(db).execute("select sql from sqlite_master where name='lf_opportunity'").fetchone()[0]
    assert "'source_coords'" in sql and "source_status" in sql and "est_value" in sql
    assert "CONSTRAINT opp_status CHECK" in sql and "CONSTRAINT notice_type CHECK" in sql
    # The production schema (Supabase) allows the same values.
    pg = (pathlib.Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "add_lead_finder.sql").read_text(
        encoding="utf-8")
    assert "'source_coords'" in pg and "source_status" in pg and "est_value" in pg


def test_project_grouping_without_bid_board_groups():
    from leadfinder.adapters.buildingconnected import project_group

    a = {"name": "MCSO ASB Renovation", "dueAt": "2026-12-15T19:00:00.000Z", "location": {"state": "NC"}}
    b = dict(a, name="MCSO  ASB renovation!")  # same project, another trade's invite
    assert project_group(a) == project_group(b) == "p:mcso asb renovation:NC:2026-12-15"
    assert project_group(dict(a, dueAt="2026-12-16T19:00:00.000Z")) != project_group(a)
    assert project_group(dict(a, parentId="grp9")) == "grp9"


def test_trade_likely_ignores_description_negatives():
    from leadfinder.pipeline.score import Scorer

    r = Scorer().score("4950 St Elmo Avenue", "Office building at 4950 St Elmo Avenue; landscaping by others.",
                       trade="Data & Telecommunications")
    assert r.lane == "likely_av_scope" and "avenue" in r.negative_hits
    assert Scorer().score("Hotel", None, trade="Voice & Data").lane == "likely_av_scope"
    assert Scorer().score("Hotel", None, trade="DCG Database").lane == "none"
    assert Scorer().score("Hotel", None, trade="Fire Alarm").lane == "none"


@respx.mock
def test_reprocess_regroups_without_api_calls(engine, bc_seeded, store):
    from leadfinder.pipeline.run import reprocess_source

    respx.get(OPPORTUNITIES_URL).mock(side_effect=pages)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    run(sources=["buildingconnected"], session_factory=factory, adapters={"buildingconnected": adapter(store)},
        geocode_online=False, now=NOW)
    s = factory()
    o = s.execute(select(Opportunity).where(Opportunity.source_record_id == "6650a0000000000000000003")).scalar_one()
    o.group_key, changed = "stale", o.last_changed_at
    s.commit()
    s.close()
    calls = respx.calls.call_count
    import leadfinder.pipeline.run as prun
    orig = prun.build_adapter
    prun.build_adapter = lambda sid, sess, cf: adapter(store)
    try:
        assert reprocess_source("buildingconnected", session_factory=factory, now=NOW) == 7
    finally:
        prun.build_adapter = orig
    assert respx.calls.call_count == calls  # no fetches
    s = factory()
    o = s.execute(select(Opportunity).where(Opportunity.source_record_id == "6650a0000000000000000003")).scalar_one()
    assert o.group_key.startswith("buildingconnected:group:p:sentara norfolk general") and o.last_changed_at == changed
    s.close()
