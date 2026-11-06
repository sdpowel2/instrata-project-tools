"""Location resolution. Free sources only:
1. full street address -> US Census geocoder (cached)
2. ZIP -> zip_centroid
3. city + state -> place_centroid
4. caller supplies fallback address (agency / contracting office) -> 1-3 again
5. nothing -> none
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.db.models import GeocodeCache, PlaceCentroid, ZipCentroid, utcnow
from leadfinder.http import Client, HttpError
from leadfinder.pipeline.normalize import clean, normalized_address, state_code, zip5

log = logging.getLogger(__name__)

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
CENSUS_BENCHMARK = "Public_AR_Current"
CENSUS_MAX_CHARS = 100

# Suffixes the Census Places gazetteer appends to NAME ("Raleigh city", "Cary town").
_PLACE_SUFFIX = re.compile(
    r"\s+(city and borough|consolidated government|unified government|metropolitan government|"
    r"metro government|urban county|city|town|village|borough|township|CDP|municipality|"
    r"comunidad|zona urbana|plantation|corporation)(\s*\(.*\))?$",
    re.IGNORECASE,
)


def normalize_place_name(name: str) -> str:
    n = _PLACE_SUFFIX.sub("", name.strip())
    n = re.sub(r"\(.*?\)", "", n)
    n = n.lower().replace("saint ", "st ").replace("st. ", "st ")
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


@dataclass
class Address:
    street: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None

    def cleaned(self) -> "Address":
        return Address(clean(self.street), clean(self.city), state_code(self.state), zip5(self.zip))

    @property
    def is_empty(self) -> bool:
        return not any([self.street, self.city, self.state, self.zip])


@dataclass
class GeoResult:
    lat: float | None
    lon: float | None
    method: str  # census_address | zip_centroid | city_centroid | none
    matched_address: str | None = None

    @property
    def ok(self) -> bool:
        return self.lat is not None and self.lon is not None


NONE = GeoResult(None, None, "none")


class Geocoder:
    """Resolves addresses using the Census geocoder plus local gazetteer tables.

    `online=False` skips the Census call (used by tests and when offline)."""

    def __init__(self, session: Session, client: Client | None = None, online: bool = True):
        self.s = session
        self.client = client
        self.online = online and client is not None

    # -- step 1
    def census(self, addr: Address) -> GeoResult:
        if not addr.street or not (addr.zip or (addr.city and addr.state)):
            return NONE
        key = normalized_address(addr.street, addr.city, addr.state, addr.zip)
        cached = self.s.get(GeocodeCache, key)
        if cached is not None:
            return GeoResult(cached.lat, cached.lon, cached.method if cached.lat is not None else "none",
                             cached.matched_address)
        if not self.online:
            return NONE
        oneline = ", ".join(p for p in [addr.street, addr.city, " ".join(x for x in [addr.state, addr.zip] if x)] if p)
        if len(oneline) > CENSUS_MAX_CHARS:
            # Census rejects >100 chars (SAM often puts building names in the street). Use ZIP/city instead.
            return NONE
        try:
            resp = self.client.get(CENSUS_URL, params={"address": oneline, "benchmark": CENSUS_BENCHMARK, "format": "json"})
            matches = resp.json().get("result", {}).get("addressMatches", [])
        except (HttpError, ValueError) as exc:
            log.warning("census geocode failed", extra={"error": str(exc)})
            return NONE  # do not cache transient failures
        if matches:
            m = matches[0]
            res = GeoResult(float(m["coordinates"]["y"]), float(m["coordinates"]["x"]), "census_address", m.get("matchedAddress"))
        else:
            res = NONE
        # Cache misses too, so no address is geocoded twice.
        self.s.merge(GeocodeCache(normalized_address=key, lat=res.lat, lon=res.lon,
                                  method=res.method, matched_address=res.matched_address, fetched_at=utcnow()))
        return res

    # -- step 2
    def zip_centroid(self, z: str | None) -> GeoResult:
        if not z:
            return NONE
        row = self.s.get(ZipCentroid, z)
        if row is None:
            return NONE
        return GeoResult(row.lat, row.lon, "zip_centroid", f"ZIP {z} centroid")

    # -- step 3
    def place_centroid(self, city: str | None, state: str | None) -> GeoResult:
        if not city or not state:
            return NONE
        row = self.s.get(PlaceCentroid, (state, normalize_place_name(city)))
        if row is None:
            return NONE
        return GeoResult(row.lat, row.lon, "city_centroid", f"{city}, {state} centroid")

    def resolve(self, addr: Address) -> GeoResult:
        a = addr.cleaned()
        for step in (lambda: self.census(a), lambda: self.zip_centroid(a.zip), lambda: self.place_centroid(a.city, a.state)):
            r = step()
            if r.ok:
                return r
        return NONE

    def locate(self, primary: Address | None, primary_basis: str,
               fallback: Address | None = None, fallback_basis: str = "none") -> tuple[GeoResult, str, Address]:
        """Apply the full precedence. Returns (result, location_basis, address used)."""
        if primary is not None and not primary.is_empty:
            r = self.resolve(primary)
            if r.ok:
                return r, primary_basis, primary.cleaned()
        if fallback is not None and not fallback.is_empty:
            r = self.resolve(fallback)
            if r.ok:
                return r, fallback_basis, fallback.cleaned()
        # Nothing resolved: keep whatever published address we had for display/state tagging.
        used = primary.cleaned() if primary is not None and not primary.is_empty else (fallback.cleaned() if fallback else Address())
        return NONE, "none", used


def geocode_office(session: Session, client: Client | None, street: str, city: str, state: str, zip_: str) -> GeoResult:
    """Offices: Census first, then ZIP centroid as a labelled fallback."""
    g = Geocoder(session, client, online=client is not None)
    a = Address(street, city, state, zip_).cleaned()
    r = g.census(a)
    if r.ok:
        return r
    return g.zip_centroid(a.zip)


def load_zip_centroids(session: Session, rows: list[tuple[str, float, float]], vintage: str) -> int:
    session.query(ZipCentroid).delete()
    session.bulk_insert_mappings(ZipCentroid, [{"zip": z, "lat": la, "lon": lo, "vintage": vintage,
                                                 "created_at": utcnow(), "updated_at": utcnow()} for z, la, lo in rows])
    return len(rows)


def load_place_centroids(session: Session, rows: list[tuple[str, str, float, float]]) -> int:
    session.query(PlaceCentroid).delete()
    seen: dict[tuple[str, str], tuple[float, float]] = {}
    for st, name, la, lo in rows:
        k = (st, normalize_place_name(name))
        if k[1] and k not in seen:  # first wins (incorporated places sort before CDPs rarely matter)
            seen[k] = (la, lo)
    now = utcnow()
    session.bulk_insert_mappings(PlaceCentroid, [{"state": k[0], "place_name": k[1], "lat": v[0], "lon": v[1],
                                                   "created_at": now, "updated_at": now} for k, v in seen.items()])
    return len(seen)


def has_place(session: Session, state: str, name: str) -> bool:
    return session.execute(select(PlaceCentroid.state).where(
        PlaceCentroid.state == state, PlaceCentroid.place_name == normalize_place_name(name))).first() is not None
