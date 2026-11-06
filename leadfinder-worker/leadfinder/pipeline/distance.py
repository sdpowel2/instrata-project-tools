"""Great-circle distance from opportunities to offices."""
from __future__ import annotations

import math

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.db.models import Office, OfficeDistance, Opportunity

EARTH_RADIUS_MI = 3958.8


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(a)))


def active_located_offices(s: Session) -> list[Office]:
    return list(s.execute(select(Office).where(Office.active.is_(True), Office.lat.is_not(None),
                                               Office.lon.is_not(None))).scalars())


def compute_for(s: Session, opp: Opportunity, offices: list[Office]) -> None:
    """Replace the opportunity's office_distance rows: one per active office, one nearest."""
    existing = {d.office_id: d for d in opp.distances}
    if opp.lat is None or opp.lon is None or not offices:
        for d in existing.values():
            opp.distances.remove(d)
        return
    rows = [(o, round(haversine(opp.lat, opp.lon, o.lat, o.lon), 1)) for o in offices]
    # Exactly one nearest; ties broken by office name for determinism.
    nearest = min(rows, key=lambda r: (r[1], r[0].name))[0]
    keep = set()
    for o, d in rows:
        keep.add(o.id)
        row = existing.get(o.id)
        if row is None:
            opp.distances.append(OfficeDistance(office_id=o.id, distance_miles=d, is_nearest=o is nearest))
        else:
            row.distance_miles, row.is_nearest = d, o is nearest
    for oid, row in existing.items():
        if oid not in keep:
            opp.distances.remove(row)


def recompute_all(s: Session) -> int:
    """Rebuild office_distance for every located opportunity. Called when an office is
    added, moved, deactivated or reactivated. Radius changes need no recompute."""
    offices = active_located_offices(s)
    n = 0
    for opp in s.execute(select(Opportunity)).scalars():
        compute_for(s, opp, offices)
        n += opp.lat is not None
    s.flush()
    return n
