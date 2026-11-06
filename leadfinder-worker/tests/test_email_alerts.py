from datetime import date, datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from leadfinder.adapters.base import DateWindow
from leadfinder.adapters.email_alerts import EmailAlertsAdapter
from leadfinder.db.models import Opportunity, Source
from leadfinder.http import CallBudget
from leadfinder.pipeline.run import run

FIX = Path(__file__).parent / "fixtures" / "email_alerts"
WINDOW = DateWindow(date(2026, 11, 1), date(2026, 11, 3))


def test_generic_parser_high_and_low_confidence():
    a = EmailAlertsAdapter(eml_folder=FIX)
    items = {i.source_record_id: i for i in a.fetch(WINDOW, CallBudget(None), None)}
    assert set(items) == {"<alert-001@notify.example-portal.com>", "<alert-002@alerts.example.org>"}
    good = a.normalize(items["<alert-001@notify.example-portal.com>"])
    assert good.title == "Courthouse Audio Visual Upgrade"
    assert good.agency_name == "Wake County"
    assert good.solicitation_number == "RFP 27-0042"
    assert good.response_due_at_raw == "December 4, 2026 2:00 PM"
    assert good.url == "https://portal.example.gov/bids/27-0042"  # unsubscribe link skipped
    assert (good.location.city, good.location.state) == ("Raleigh", "NC")
    assert good.status_hint is None and good.active is True
    low = a.normalize(items["<alert-002@alerts.example.org>"])
    assert low.status_hint == "unknown"
    assert low.title == "something posted"
    assert low.location.state == "NC"


def test_window_filters_by_sent_date():
    a = EmailAlertsAdapter(eml_folder=FIX)
    assert list(a.fetch(DateWindow(date(2026, 11, 5), date(2026, 11, 6)), CallBudget(None), None)) == []


def test_email_through_pipeline_and_cross_source_dup(engine, seeded):
    s = seeded
    s.get(Source, "email_alerts").enabled = True
    s.commit()
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)
    # A Bonfire record of the same bid already exists.
    s.add(Opportunity(source_id="bonfire", source_record_id="wake:1", group_key="g", title="Courthouse Audio-Visual Upgrade",
                      agency_name="Wake County", loc_state="NC", status="open", content_hash="x",
                      response_due_at=datetime(2026, 12, 4, 19, 0, tzinfo=timezone.utc), first_seen_at=now))
    s.commit()
    r = run(sources=["email_alerts"], since=date(2026, 11, 2), until=date(2026, 11, 2), session_factory=factory,
            adapters={"email_alerts": EmailAlertsAdapter(eml_folder=FIX)}, geocode_online=False, now=now)
    assert r.status == "succeeded" and r.source_runs[0].records_new == 2
    s2 = factory()
    em = s2.execute(select(Opportunity).where(Opportunity.source_record_id == "<alert-001@notify.example-portal.com>")).scalar_one()
    bf = s2.execute(select(Opportunity).where(Opportunity.source_record_id == "wake:1")).scalar_one()
    assert em.score.lane == "direct_av"
    assert em.duplicate_of == bf.id  # portal preferred over email
    assert em.geocode_method == "zip_centroid" or em.geocode_method == "city_centroid" or em.lat is None
    low = s2.execute(select(Opportunity).where(Opportunity.source_record_id == "<alert-002@alerts.example.org>")).scalar_one()
    assert low.status == "unknown"
    s2.close()
