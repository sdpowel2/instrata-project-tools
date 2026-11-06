import pytest
from sqlalchemy import select

from leadfinder.db.models import Office, OfficeDistance, Opportunity
from leadfinder.pipeline.distance import active_located_offices, compute_for, haversine, recompute_all


def test_one_degree_latitude_is_69_1_miles():
    assert haversine(35.0, -78.0, 36.0, -78.0) == pytest.approx(69.1, abs=0.05)


def test_same_point_is_zero():
    assert haversine(35.77, -78.58, 35.77, -78.58) == 0


def _opp(**kw):
    base = dict(source_id="sam_gov", source_record_id="x", group_key="g", title="t", content_hash="h")
    base.update(kw)
    return Opportunity(**base)


def test_one_row_per_active_office_and_one_nearest(seeded):
    s = seeded
    opp = _opp(lat=35.99, lon=-78.90)  # Durham
    s.add(opp)
    s.flush()
    compute_for(s, opp, active_located_offices(s))
    s.flush()
    rows = s.execute(select(OfficeDistance).where(OfficeDistance.opportunity_id == opp.id)).scalars().all()
    assert len(rows) == 3
    assert sum(r.is_nearest for r in rows) == 1
    assert next(r for r in rows if r.is_nearest).office.name == "Raleigh"
    assert all(r.distance_miles == round(r.distance_miles, 1) for r in rows)


def test_recompute_after_deactivating_office(seeded):
    s = seeded
    opp = _opp(lat=35.99, lon=-78.90)
    s.add(opp)
    s.flush()
    recompute_all(s)
    raleigh = s.execute(select(Office).where(Office.name == "Raleigh")).scalar_one()
    raleigh.active = False
    s.flush()
    recompute_all(s)
    s.flush()
    rows = s.execute(select(OfficeDistance).where(OfficeDistance.opportunity_id == opp.id)).scalars().all()
    assert len(rows) == 2
    assert next(r for r in rows if r.is_nearest).office.name == "Tidewater"


def test_unlocated_opportunity_gets_no_rows(seeded):
    s = seeded
    s.add(_opp())
    s.flush()
    recompute_all(s)
    s.flush()
    assert s.execute(select(OfficeDistance)).first() is None
