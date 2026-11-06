"""Results filtering. Shared by the Results page, the map, and CSV export so the export
always matches the on-screen view row-for-row. Radius is applied here, at query time."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from typing import Any

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session, selectinload

from leadfinder.db.models import (
    LeadReview, Office, OfficeDistance, Opportunity, OpportunityScore, Run, SourceRun,
)

LANES = ("direct_av", "likely_av_scope", "none")
LANE_LABEL = {"direct_av": "Direct AV", "likely_av_scope": "Likely AV scope", "none": "None"}
REVIEW = ("new", "watch", "pursue", "pass", "already_known")
REVIEW_LABEL = {"new": "New", "watch": "Watch", "pursue": "Pursue", "pass": "Pass", "already_known": "Already known"}
STATUSES = ("open", "closed", "cancelled", "awarded", "unknown")
APPROX_METHODS = {"zip_centroid", "city_centroid"}
# BuildingConnected Bid Board states (opportunity.source_status) and the Results filter for them.
BB_LABEL = {"UNDECIDED": "Undecided", "WILL_SUBMIT": "Accepted", "SUBMITTED": "Submitted", "DECLINED": "Declined",
            "ARCHIVED": "Archived", "WON": "Won", "LOST": "Lost", "CANCELED": "Cancelled", "OTHER": "Closed (other)"}
BB_FILTERS = {"": "Any", "active": "Undecided or accepted", "UNDECIDED": "Undecided only",
              "WILL_SUBMIT": "Accepted only", "SUBMITTED": "Submitted", "DECLINED": "Declined"}
MAX_ROWS = 2000


@dataclass
class Filters:
    office_id: str = ""            # "" = any office
    office_mode: str = "in_range"  # in_range | nearest
    in_range_only: bool = True
    lanes: list[str] = field(default_factory=lambda: ["direct_av", "likely_av_scope"])
    min_score: int = 0
    status: str = "open"           # one of STATUSES or "all"
    due_after: date | None = None  # default today (set in from_params)
    changed: str = ""              # "" | new | updated | new_or_updated
    review: str = ""               # "" | one of REVIEW
    location_unknown: bool = False
    source: str = ""               # "" = all sources
    bb_status: str = ""            # key of BB_FILTERS; only BuildingConnected rows have a Bid Board state

    @classmethod
    def from_params(cls, p: dict[str, Any], today: date | None = None) -> "Filters":
        """Build from query params. A submitted form always includes `submitted=1`, so
        unchecked checkboxes can be told apart from first page load (defaults)."""
        today = today or datetime.now(timezone.utc).date()
        submitted = bool(p.get("submitted"))

        def getlist(k: str) -> list[str]:
            v = p.get(k)
            if v is None:
                return []
            return v if isinstance(v, list) else [v]

        f = cls()
        f.office_id = str(p.get("office_id") or "")
        f.office_mode = "nearest" if p.get("office_mode") == "nearest" else "in_range"
        f.in_range_only = (p.get("in_range_only") in ("1", "on", "true")) if submitted else True
        lanes = [x for x in getlist("lane") if x in LANES]
        f.lanes = lanes if submitted else f.lanes
        try:
            f.min_score = max(0, min(100, int(p.get("min_score") or 0)))
        except ValueError:
            f.min_score = 0
        st = p.get("status")
        f.status = st if st in STATUSES or st == "all" else "open"
        due = p.get("due_after")
        if due is None and not submitted:
            f.due_after = today
        elif due:
            try:
                f.due_after = date.fromisoformat(str(due))
            except ValueError:
                f.due_after = today
        else:
            f.due_after = None
        ch = p.get("changed") or ""
        f.changed = ch if ch in ("new", "updated", "new_or_updated") else ""
        rv = p.get("review") or ""
        f.review = rv if rv in REVIEW else ""
        f.location_unknown = p.get("location_unknown") in ("1", "on", "true")
        src = str(p.get("source") or "")
        f.source = src if re.fullmatch(r"[a-z0-9_]{1,32}", src) else ""
        bb = str(p.get("bb_status") or "")
        f.bb_status = bb if bb in BB_FILTERS else ""
        return f

    def to_params(self) -> list[tuple[str, str]]:
        out = [("submitted", "1"), ("office_id", self.office_id), ("office_mode", self.office_mode),
               ("min_score", str(self.min_score)), ("status", self.status),
               ("due_after", self.due_after.isoformat() if self.due_after else ""),
               ("changed", self.changed), ("review", self.review), ("source", self.source),
               ("bb_status", self.bb_status)]
        if self.in_range_only:
            out.append(("in_range_only", "1"))
        if self.location_unknown:
            out.append(("location_unknown", "1"))
        out += [("lane", l) for l in self.lanes]
        return out


@dataclass
class ResultRow:
    opp: Opportunity
    lane: str
    score: int
    review: str
    notices: int
    nearest_office: str | None
    nearest_distance: float | None
    badge: str | None  # New | Updated | None
    approximate: bool
    est_value: float | None = None  # largest estimate in the group (one GC's invite may carry the ROM)
    trades: list[str] = field(default_factory=list)  # BuildingConnected: every trade invited in the group
    gcs: int = 0                                      # BuildingConnected: distinct inviting GCs


def latest_successful_run(s: Session) -> Run | None:
    return s.execute(select(Run).where(Run.status.in_(("succeeded", "partial")), Run.finished_at.is_not(None))
                     .order_by(Run.started_at.desc()).limit(1)).scalar_one_or_none()


def _badge(o: Opportunity, run: Run | None) -> str | None:
    if run is None:
        return None
    lo, hi = run.started_at, run.finished_at or run.started_at
    if lo <= o.first_seen_at <= hi:
        return "New"
    if lo <= o.last_changed_at <= hi:
        return "Updated"
    return None


def query_results(s: Session, f: Filters) -> list[ResultRow]:
    q = (select(Opportunity, OpportunityScore.lane, OpportunityScore.score, LeadReview.status)
         .join(OpportunityScore, OpportunityScore.opportunity_id == Opportunity.id)
         .outerjoin(LeadReview, LeadReview.opportunity_id == Opportunity.id)
         .where(Opportunity.duplicate_of.is_(None)))
    if f.lanes:
        q = q.where(OpportunityScore.lane.in_(f.lanes))
    else:
        q = q.where(False)
    if f.min_score:
        q = q.where(OpportunityScore.score >= f.min_score)
    if f.status != "all":
        q = q.where(Opportunity.status == f.status)
    if f.due_after:
        start = datetime.combine(f.due_after, time.min, tzinfo=timezone.utc)
        q = q.where(or_(Opportunity.response_due_at.is_(None), Opportunity.response_due_at >= start))
    if f.source:
        q = q.where(Opportunity.source_id == f.source)
    if f.bb_status:
        states = ["UNDECIDED", "WILL_SUBMIT"] if f.bb_status == "active" else [f.bb_status]
        q = q.where(Opportunity.source_status.in_(states))
    if f.review:
        if f.review == "new":
            q = q.where(or_(LeadReview.status.is_(None), LeadReview.status == "new"))
        else:
            q = q.where(LeadReview.status == f.review)

    run = latest_successful_run(s)
    if f.changed and run is not None:
        lo, hi = run.started_at, run.finished_at or run.started_at
        new_c = Opportunity.first_seen_at.between(lo, hi)
        upd_c = and_(Opportunity.last_changed_at.between(lo, hi), ~new_c)
        q = q.where({"new": new_c, "updated": upd_c, "new_or_updated": or_(new_c, upd_c)}[f.changed])

    # ----- office / radius
    d, o = OfficeDistance, Office
    conds = [d.opportunity_id == Opportunity.id, o.id == d.office_id, o.active.is_(True)]
    if f.office_id:
        conds.append(o.id == f.office_id)
    if f.office_mode == "nearest" and f.office_id:
        conds.append(d.is_nearest.is_(True))
    if f.in_range_only:
        conds.append(d.distance_miles <= o.radius_miles)
    office_clause = exists(select(d.opportunity_id).select_from(d).join(o, o.id == d.office_id).where(*conds))
    apply_office = f.in_range_only or bool(f.office_id)

    if f.location_unknown:
        states_q = select(Office.state).where(Office.active.is_(True))
        if f.office_id:
            states_q = states_q.where(Office.id == f.office_id)
        unknown = and_(Opportunity.lat.is_(None), Opportunity.loc_state.in_(states_q))
        q = q.where(or_(office_clause, unknown) if apply_office else or_(Opportunity.lat.is_not(None), unknown))
    else:
        q = q.where(office_clause) if apply_office else q.where(Opportunity.lat.is_not(None))

    rows = s.execute(q).all()

    # ----- one row per group_key (latest notice) with a notice count
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(r[0].group_key, []).append(r)
    # Counts include notices in the group that were filtered out (e.g. older closed amendments).
    keys = list(groups)
    counts: dict[str, int] = {}
    trades: dict[str, list[str]] = {}
    gcs: dict[str, set[str]] = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        for gk, src, extra, agency in s.execute(
                select(Opportunity.group_key, Opportunity.source_id, Opportunity.extra, Opportunity.agency_name)
                .where(Opportunity.group_key.in_(chunk), Opportunity.duplicate_of.is_(None))):
            counts[gk] = counts.get(gk, 0) + 1
            if src == "buildingconnected":
                t = (extra or {}).get("trade") if isinstance(extra, dict) else None
                if t and t not in trades.setdefault(gk, []):
                    trades[gk].append(t)
                gcs.setdefault(gk, set()).add((agency or "").strip().lower())

    def recency(r) -> tuple:
        o_ = r[0]
        return (o_.posted_at or datetime.min.replace(tzinfo=timezone.utc), o_.last_seen_at, o_.source_record_id)

    picked = [max(v, key=recency) for v in groups.values()]
    group_value = {gk: max((r[0].est_value for r in v if r[0].est_value), default=None) for gk, v in groups.items()}

    ids = [r[0].id for r in picked]
    nearest: dict[str, tuple[str, float]] = {}
    for i in range(0, len(ids), 500):
        for oid, name, dist in s.execute(
                select(OfficeDistance.opportunity_id, Office.name, OfficeDistance.distance_miles)
                .join(Office, Office.id == OfficeDistance.office_id)
                .where(OfficeDistance.opportunity_id.in_(ids[i:i + 500]), OfficeDistance.is_nearest.is_(True))):
            nearest[oid] = (name, dist)

    out = []
    for opp, lane, score, review in picked:
        n = nearest.get(opp.id)
        out.append(ResultRow(
            opp=opp, lane=lane, score=score, review=review or "new", notices=counts.get(opp.group_key, 1),
            nearest_office=n[0] if n else None, nearest_distance=n[1] if n else None,
            badge=_badge(opp, run),
            approximate=(opp.geocode_method in APPROX_METHODS) or opp.location_basis == "agency_address",
            est_value=group_value.get(opp.group_key),
            trades=trades.get(opp.group_key, []), gcs=len(gcs.get(opp.group_key, ())),
        ))
    far = datetime.max.replace(tzinfo=timezone.utc)
    out.sort(key=lambda r: (r.opp.response_due_at or far, -r.score, r.opp.title))
    return out


def detail(s: Session, opp_id: str) -> dict[str, Any] | None:
    from leadfinder.db.models import RawRecord

    opp = s.execute(select(Opportunity).where(Opportunity.id == opp_id)
                    .options(selectinload(Opportunity.distances))).scalar_one_or_none()
    if opp is None:
        return None
    dists = sorted(((d.office, d.distance_miles, d.is_nearest) for d in opp.distances if d.office.active),
                   key=lambda x: x[1])
    history = list(s.execute(select(Opportunity).where(Opportunity.group_key == opp.group_key)
                             .order_by(Opportunity.posted_at.desc())).scalars())
    dupes = list(s.execute(select(Opportunity).where(Opportunity.duplicate_of == opp.id)).scalars())
    raw = s.execute(select(RawRecord).where(RawRecord.source_id == opp.source_id,
                                            RawRecord.source_record_id == opp.source_record_id)
                    .order_by(RawRecord.fetched_at.desc()).limit(1)).scalar_one_or_none()
    return {"opp": opp, "distances": dists, "history": history, "duplicates": dupes, "raw": raw}


def source_runs_for(s: Session, run_id: str) -> list[SourceRun]:
    return list(s.execute(select(SourceRun).where(SourceRun.run_id == run_id).order_by(SourceRun.source_id)).scalars())
