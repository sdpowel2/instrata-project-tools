from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from leadfinder import http as lf_http
from leadfinder.db.models import Base, Office, PlaceCentroid, Source, ZipCentroid


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(lf_http, "sleep", lambda s: None)


@pytest.fixture
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def session(engine):
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    yield s
    s.close()


@pytest.fixture
def seeded(session):
    """Reference rows + three offices + sources, enough for location/distance tests."""
    session.add_all([
        ZipCentroid(zip="27610", lat=35.7449, lon=-78.5466, vintage="test"),
        ZipCentroid(zip="23462", lat=36.8382, lon=-76.1462, vintage="test"),
        ZipCentroid(zip="08619", lat=40.2412, lon=-74.6918, vintage="test"),
        PlaceCentroid(state="NC", place_name="durham", lat=35.9800, lon=-78.9050),
        PlaceCentroid(state="VA", place_name="norfolk", lat=36.9230, lon=-76.2446),
        Office(name="Raleigh", street="516 South New Hope Road", city="Raleigh", state="NC", zip="27610",
               lat=35.7720, lon=-78.5800, geocode_method="manual", radius_miles=100, active=True),
        Office(name="Tidewater", street="5257 Cleveland St", city="Virginia Beach", state="VA", zip="23462",
               lat=36.8440, lon=-76.1300, geocode_method="census_address", radius_miles=100, active=True),
        Office(name="Trenton", street="572 Whitehead Road", city="Trenton", state="NJ", zip="08619",
               lat=40.2350, lon=-74.6900, geocode_method="census_address", radius_miles=50, active=True),
        Source(id="sam_gov", name="SAM.gov", kind="api", enabled=True, daily_call_budget=8),
        Source(id="bonfire", name="Bonfire", kind="portal", enabled=True),
        Source(id="email_alerts", name="Email", kind="email", enabled=False),
    ])
    session.commit()
    return session
