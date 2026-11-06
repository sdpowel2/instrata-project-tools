"""Field normalization shared by all adapters and the pipeline."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from dateutil import parser as dateparser

STATE_CODES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
    "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "puerto rico": "PR", "guam": "GU", "virgin islands": "VI", "american samoa": "AS",
    "northern mariana islands": "MP",
}
VALID_CODES = set(STATE_CODES.values())

# Representative time zone per state, used when a source gives a time with no zone.
STATE_TZ = {
    "AZ": "America/Phoenix", "NJ": "America/New_York", "MD": "America/New_York",
    "VA": "America/New_York", "NC": "America/New_York", "SC": "America/New_York",
    "DC": "America/New_York", "PA": "America/New_York", "NY": "America/New_York",
    "DE": "America/New_York", "WV": "America/New_York", "GA": "America/New_York",
    "FL": "America/New_York", "OH": "America/New_York", "MI": "America/Detroit",
    "TN": "America/Chicago", "KY": "America/New_York", "IL": "America/Chicago",
    "TX": "America/Chicago", "CA": "America/Los_Angeles", "WA": "America/Los_Angeles",
    "OR": "America/Los_Angeles", "NV": "America/Los_Angeles", "CO": "America/Denver",
    "UT": "America/Denver", "NM": "America/Denver", "HI": "Pacific/Honolulu", "AK": "America/Anchorage",
}
DEFAULT_TZ = "America/New_York"

_WS = re.compile(r"\s+")


def clean(text: str | None) -> str | None:
    """Trim and collapse whitespace; empty -> None."""
    if text is None:
        return None
    out = _WS.sub(" ", str(text)).strip()
    return out or None


def state_code(value: str | None) -> str | None:
    v = clean(value)
    if not v:
        return None
    if len(v) == 2 and v.upper() in VALID_CODES:
        return v.upper()
    # SAM sometimes gives "US-VA" style or full names.
    m = re.fullmatch(r"(?:US-)?([A-Za-z]{2})", v)
    if m and m.group(1).upper() in VALID_CODES:
        return m.group(1).upper()
    return STATE_CODES.get(v.lower())


def zip5(value: str | int | None) -> str | None:
    if value is None:
        return None
    digits = re.sub(r"[^0-9]", "", str(value))
    if len(digits) >= 5:
        return digits[:5]
    if 3 <= len(digits) < 5:  # leading zeros lost upstream (e.g. 8619 -> 08619)
        return digits.zfill(5)
    return None


def parse_datetime(value: str | None, state: str | None = None) -> datetime | None:
    """Parse to an aware UTC datetime. Naive values get the state's time zone."""
    v = clean(value)
    if not v:
        return None
    try:
        dt = dateparser.parse(v)
    except (ValueError, OverflowError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(STATE_TZ.get(state or "", DEFAULT_TZ)))
    return dt.astimezone(timezone.utc)


_NOTICE_MAP = [
    (r"combined synopsis|combined", "combined"),
    (r"pre-?solicitation", "presolicitation"),
    (r"sources? sought|request for information|\brfi\b", "sources_sought"),
    (r"special notice", "special"),
    (r"award|intent to award|justification", "award"),
    (r"\brfq\b|request for quot", "rfq"),
    (r"\brfp\b|request for proposal", "rfp"),
    (r"\bifb\b|invitation (?:for|to) bid|\bitb\b", "ifb"),
    (r"solicitation|\bbid\b|tender", "solicitation"),
]


def notice_type(value: str | None) -> str:
    v = (clean(value) or "").lower()
    if not v:
        return "other"
    for pattern, mapped in _NOTICE_MAP:
        if re.search(pattern, v):
            return mapped
    return "other"


def normalized_key_text(text: str | None) -> str:
    """Lowercase alnum-only form used in dedup/group keys and address cache keys."""
    if not text:
        return ""
    t = text.lower()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return _WS.sub(" ", t).strip()


_AGENCY_NOISE = re.compile(r"\b(the|of|dept|department|county|city|town|purchasing|procurement)\b")


def normalized_agency(text: str | None) -> str:
    return _WS.sub(" ", _AGENCY_NOISE.sub(" ", normalized_key_text(text))).strip()


def normalized_address(street: str | None, city: str | None, state: str | None, zip_: str | None) -> str:
    parts = [normalized_key_text(p) for p in (street, city, state, zip_) if p]
    return ", ".join(p for p in parts if p)
