"""Dedup keys, content hashing and cross-source duplicate detection."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta

from rapidfuzz import fuzz
from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.db.models import Opportunity
from leadfinder.pipeline.normalize import normalized_agency, normalized_key_text

# Lower rank = more structured = preferred primary.
SOURCE_RANK = {"sam_gov": 0, "buildingconnected": 1, "bonfire": 1, "email_alerts": 2}
DEFAULT_RANK = 1  # other portals / paid feeds
TITLE_SIMILARITY_MIN = 90
DUE_TOLERANCE = timedelta(days=1)


def group_key(source_id: str, agency_name: str | None, solicitation_number: str | None,
              title: str | None, response_due_at: datetime | None) -> str:
    agency = normalized_agency(agency_name)
    sol = normalized_key_text(solicitation_number).replace(" ", "")
    if sol:
        return f"{source_id}:{agency}:{sol}"
    due = response_due_at.date().isoformat() if response_due_at else "nodue"
    return f"{source_id}:{agency}:t:{normalized_key_text(title)}:{due}"


def content_hash(title: str | None, response_due_at: datetime | None, status: str | None,
                 notice_type: str | None, loc: tuple[str | None, str | None, str | None, str | None],
                 extra: dict | None = None) -> str:
    data = {
        "title": title or "",
        "due": response_due_at.isoformat() if response_due_at else None,
        "status": status,
        "notice_type": notice_type,
        "loc": list(loc),
    }
    # Only non-empty extras are hashed, so existing SAM/email hashes are unchanged.
    extra = {k: v for k, v in (extra or {}).items() if v is not None}
    if extra:
        data["extra"] = extra
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def is_cross_source_duplicate(a: Opportunity, b: Opportunity) -> bool:
    if a.source_id == b.source_id:
        return False
    if not a.loc_state or a.loc_state != b.loc_state:
        return False
    if not normalized_agency(a.agency_name) or normalized_agency(a.agency_name) != normalized_agency(b.agency_name):
        return False
    if a.response_due_at is None or b.response_due_at is None:
        return False
    if abs(a.response_due_at - b.response_due_at) > DUE_TOLERANCE:
        return False
    return fuzz.token_set_ratio(normalized_key_text(a.title), normalized_key_text(b.title)) >= TITLE_SIMILARITY_MIN


def _rank(o: Opportunity) -> tuple[int, datetime]:
    return (SOURCE_RANK.get(o.source_id, DEFAULT_RANK), o.first_seen_at)


def link_cross_source(s: Session, opp: Opportunity) -> None:
    """Find a same-bid record from another source; mark the less structured one as duplicate_of."""
    if not opp.loc_state or opp.response_due_at is None:
        return
    lo, hi = opp.response_due_at - DUE_TOLERANCE, opp.response_due_at + DUE_TOLERANCE
    candidates = s.execute(select(Opportunity).where(
        Opportunity.id != opp.id,
        Opportunity.source_id != opp.source_id,
        Opportunity.loc_state == opp.loc_state,
        Opportunity.response_due_at.between(lo, hi),
    )).scalars()
    for other in candidates:
        if not is_cross_source_duplicate(opp, other):
            continue
        # Resolve to the root primary of the other record's cluster.
        root = other if other.duplicate_of is None else (s.get(Opportunity, other.duplicate_of) or other)
        if root.id == opp.id:
            return
        primary, secondary = (root, opp) if _rank(root) <= _rank(opp) else (opp, root)
        secondary.duplicate_of = primary.id
        primary.duplicate_of = None
        # Re-point anything that pointed at the demoted record.
        for child in s.execute(select(Opportunity).where(Opportunity.duplicate_of == secondary.id)).scalars():
            if child.id != primary.id:
                child.duplicate_of = primary.id
        return
