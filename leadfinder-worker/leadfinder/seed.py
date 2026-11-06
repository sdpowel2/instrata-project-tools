"""Seed offices, sources and Bonfire targets from config/*.yaml."""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.config import offices_config, sources_config
from leadfinder.db.models import Office, Source, SourceTarget
from leadfinder.http import Client
from leadfinder.pipeline.geocode import Address, Geocoder, geocode_office
from leadfinder.pipeline.normalize import state_code, zip5

log = logging.getLogger(__name__)


def seed_sources(s: Session, config_dir: Path | None = None) -> int:
    cfg = sources_config(config_dir).get("sources", {})
    for sid, c in cfg.items():
        row = s.get(Source, sid)
        if row is None:
            row = Source(id=sid)
            s.add(row)
        row.name = c.get("name", sid)
        row.kind = c.get("kind", "api")
        row.enabled = bool(c.get("enabled", True))
        row.daily_call_budget = c.get("daily_call_budget")
    s.flush()
    return len(cfg)


def seed_offices(s: Session, client: Client | None, config_dir: Path | None = None) -> list[Office]:
    """Insert offices that don't exist yet (by name). Existing rows are left alone:
    after init the database is the source of truth."""
    cfg = offices_config(config_dir)
    default_radius = int(cfg.get("default_radius_miles", 100))
    created = []
    for o in cfg.get("offices", []):
        if s.execute(select(Office).where(Office.name == o["name"])).scalar_one_or_none():
            continue
        office = Office(name=o["name"], street=o["street"], city=o["city"], state=state_code(o["state"]),
                        zip=zip5(o["zip"]), radius_miles=int(o.get("radius_miles", default_radius)), active=True)
        r = geocode_office(s, client, office.street, office.city, office.state, office.zip)
        office.lat, office.lon = r.lat, r.lon
        office.geocode_method = r.method if r.ok else None
        office.geocode_match = r.matched_address
        s.add(office)
        created.append(office)
    s.flush()
    return created


def sync_bonfire_targets(s: Session, client: Client | None, config_dir: Path | None = None) -> int:
    """Upsert source_target rows from config. Geocodes each agency once."""
    agencies = sources_config(config_dir).get("bonfire_agencies") or []
    g = Geocoder(s, client, online=client is not None)
    n = 0
    for a in agencies:
        row = s.execute(select(SourceTarget).where(SourceTarget.source_id == "bonfire",
                                                   SourceTarget.slug == a["slug"])).scalar_one_or_none()
        if row is None:
            row = SourceTarget(source_id="bonfire", slug=a["slug"])
            s.add(row)
        addr_changed = (row.street, row.city, row.state, row.zip) != (
            a.get("street"), a.get("city"), state_code(a.get("state")), zip5(a.get("zip")))
        row.agency_name = a.get("agency_name", a["slug"])
        row.agency_type = a.get("agency_type", "other")
        row.street, row.city = a.get("street"), a.get("city")
        row.state, row.zip = state_code(a.get("state")), zip5(a.get("zip"))
        row.enabled = bool(a.get("enabled", True))
        if addr_changed or row.lat is None:
            r = g.resolve(Address(row.street, row.city, row.state, row.zip))
            row.lat, row.lon = r.lat, r.lon
        n += 1
    # Agencies removed from config are disabled, not deleted (their bids keep their location).
    keep = {a["slug"] for a in agencies}
    for row in s.execute(select(SourceTarget).where(SourceTarget.source_id == "bonfire")).scalars():
        if row.slug not in keep:
            row.enabled = False
    s.flush()
    return n
