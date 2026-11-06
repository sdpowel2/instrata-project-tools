"""Office management, shared by the web UI and the CLI."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.db.models import Office
from leadfinder.http import Client
from leadfinder.pipeline.distance import recompute_all
from leadfinder.pipeline.geocode import geocode_office
from leadfinder.pipeline.normalize import clean, state_code, zip5

RADIUS_MIN, RADIUS_MAX = 5, 500


class OfficeError(ValueError):
    pass


@dataclass
class OfficeInput:
    name: str
    street: str
    city: str
    state: str
    zip: str
    radius_miles: int = 100
    manual_lat: float | None = None
    manual_lon: float | None = None


def _validate(inp: OfficeInput) -> OfficeInput:
    name, street, city = clean(inp.name), clean(inp.street), clean(inp.city)
    st, z = state_code(inp.state), zip5(inp.zip)
    if not name:
        raise OfficeError("Name is required.")
    if not street or not city:
        raise OfficeError("Street and city are required.")
    if not st:
        raise OfficeError(f"Unknown state {inp.state!r}; use a 2-letter code.")
    if not z:
        raise OfficeError("ZIP must be 5 digits.")
    try:
        radius = int(inp.radius_miles)
    except (TypeError, ValueError):
        raise OfficeError("Radius must be a whole number of miles.")
    if not RADIUS_MIN <= radius <= RADIUS_MAX:
        raise OfficeError(f"Radius must be between {RADIUS_MIN} and {RADIUS_MAX} miles.")
    if (inp.manual_lat is None) != (inp.manual_lon is None):
        raise OfficeError("Manual override needs both latitude and longitude.")
    if inp.manual_lat is not None and not (-90 <= inp.manual_lat <= 90 and -180 <= inp.manual_lon <= 180):
        raise OfficeError("Latitude/longitude out of range.")
    return OfficeInput(name, street, city, st, z, radius, inp.manual_lat, inp.manual_lon)


def save_office(s: Session, inp: OfficeInput, office_id: str | None = None, client: Client | None = None) -> tuple[Office, bool]:
    """Create or update. Geocodes when the address changes. Returns (office, distances_recomputed)."""
    inp = _validate(inp)
    clash = s.execute(select(Office).where(Office.name == inp.name)).scalar_one_or_none()
    office = s.get(Office, office_id) if office_id else None
    if office_id and office is None:
        raise OfficeError("Office not found.")
    if clash is not None and clash is not office:
        raise OfficeError(f"An office named {inp.name!r} already exists.")

    is_new = office is None
    if is_new:
        office = Office(name=inp.name, active=True)
        s.add(office)
    addr_changed = is_new or (office.street, office.city, office.state, office.zip) != (inp.street, inp.city, inp.state, inp.zip)
    old_pos = (office.lat, office.lon)
    office.name, office.street, office.city, office.state, office.zip = inp.name, inp.street, inp.city, inp.state, inp.zip
    office.radius_miles = inp.radius_miles  # radius alone never triggers a recompute

    if inp.manual_lat is not None:
        office.lat, office.lon = inp.manual_lat, inp.manual_lon
        office.geocode_method, office.geocode_match = "manual", "Manual override"
    elif addr_changed:
        own_client = client is None
        client = client or Client()
        try:
            r = geocode_office(s, client, inp.street, inp.city, inp.state, inp.zip)
        finally:
            if own_client:
                client.close()
        office.lat, office.lon = r.lat, r.lon
        office.geocode_method = r.method if r.ok else None
        office.geocode_match = r.matched_address if r.ok else "No match - set a manual lat/lon"
    s.flush()
    moved = is_new or (office.lat, office.lon) != old_pos
    if moved and office.active:
        recompute_all(s)
    return office, moved and office.active


def set_active(s: Session, office_id: str, active: bool) -> Office:
    office = s.get(Office, office_id)
    if office is None:
        raise OfficeError("Office not found.")
    if office.active != active:
        office.active = active
        s.flush()
        recompute_all(s)
    return office
