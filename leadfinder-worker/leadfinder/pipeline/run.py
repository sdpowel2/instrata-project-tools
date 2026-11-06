"""The shared pipeline. The Run page and the CLI both call `run()`.

fetch (adapter) -> raw_record -> normalize -> locate -> score -> distance -> dedup
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Iterable

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from leadfinder.adapters.base import (
    AddressDraft, BudgetExhaustedError, DateWindow, OpportunityDraft, RawItem, SourceAdapter,
)
from leadfinder.config import sources_config
from leadfinder.db.models import (
    LeadReview, Office, OfficeDistance, Opportunity, OpportunityScore, RawRecord, Run, Source, SourceRun,
    SourceTarget, utcnow,
)
from leadfinder.http import CallBudget, Client
from leadfinder.pipeline import dedup
from leadfinder.pipeline.distance import active_located_offices, compute_for
from leadfinder.pipeline.geocode import Address, Geocoder
from leadfinder.pipeline.normalize import clean, notice_type, parse_datetime, state_code, zip5
from leadfinder.pipeline.score import Scorer
from leadfinder.settings import redact

log = logging.getLogger(__name__)

_RUN_LOCK = threading.Lock()
STALE_RUN_AFTER = timedelta(hours=6)
COMMIT_EVERY = 200


class RunInProgress(Exception):
    pass


@dataclass
class RunProgress:
    """Live status, read by the web UI while a run is in progress."""
    run_id: str | None = None
    sources: dict[str, dict] = field(default_factory=dict)
    done: bool = True


PROGRESS = RunProgress()


def _as_addr(a: AddressDraft | None) -> Address | None:
    return Address(a.street, a.city, a.state, a.zip) if a else None


# ---------------------------------------------------------------- per-item

class Processor:
    def __init__(self, s: Session, geocoder: Geocoder, scorer: Scorer, now: datetime):
        self.s = s
        self.geo = geocoder
        self.scorer = scorer
        self.now = now
        self.offices = active_located_offices(s)

    def ingest_raw(self, source_id: str, run_id: str, raw: RawItem) -> bool:
        """Store the verbatim payload unless unchanged. Returns True if the payload changed."""
        latest = self.s.execute(
            select(RawRecord.payload_hash).where(RawRecord.source_id == source_id,
                                                 RawRecord.source_record_id == raw.source_record_id)
            .order_by(RawRecord.fetched_at.desc()).limit(1)).scalar_one_or_none()
        h = raw.payload_hash
        if latest == h:
            return False
        self.s.add(RawRecord(source_id=source_id, source_record_id=raw.source_record_id, run_id=run_id,
                             payload=raw.payload_text, payload_hash=h, fetched_at=self.now))
        return True

    def apply(self, d: OpportunityDraft, payload_changed: bool) -> tuple[Opportunity, str]:
        """Upsert one opportunity. Returns (opp, 'new'|'updated'|'seen')."""
        opp = self.s.execute(select(Opportunity).where(
            Opportunity.source_id == d.source_id, Opportunity.source_record_id == d.source_record_id)
        ).scalar_one_or_none()
        if opp is not None and not payload_changed:
            opp.last_seen_at = self.now
            if opp.status == "open" and opp.response_due_at and opp.response_due_at < self.now:
                opp.status = "closed"
            return opp, "seen"

        state_hint = state_code(d.state_hint) or state_code(d.location.state if d.location else None)
        due = parse_datetime(d.response_due_at_raw, state_hint)
        posted = parse_datetime(d.posted_at_raw, state_hint)
        status = d.status_hint or ("open" if d.active else ("closed" if d.active is False else "unknown"))
        if status == "open" and due is not None and due < self.now:
            status = "closed"
        ntype = notice_type(d.notice_type_raw)

        if d.source_latlon is not None:
            # Source-published coordinates for the project site: no geocoding call needed.
            lat, lon = d.source_latlon
            method, basis = "source_coords", d.location_basis
            used = (_as_addr(d.location) or Address()).cleaned()
            geo = None
        else:
            geo, basis, used = self.geo.locate(_as_addr(d.location), d.location_basis,
                                               _as_addr(d.fallback_location), d.fallback_basis)
            lat, lon, method = geo.lat, geo.lon, geo.method
        if geo is not None and not geo.ok and d.fallback_latlon:
            lat, lon = d.fallback_latlon
            basis, method = d.fallback_basis, "city_centroid"
            used = _as_addr(d.fallback_location).cleaned() if d.fallback_location else used
        loc_state = used.state or state_hint

        title = clean(d.title) or "(untitled)"
        chash = dedup.content_hash(title, due, status, ntype, (used.street, used.city, loc_state, used.zip),
                                   {"source_status": d.source_status, "est_value": d.est_value})

        is_new = opp is None
        if is_new:
            opp = Opportunity(source_id=d.source_id, source_record_id=d.source_record_id,
                              first_seen_at=self.now, last_seen_at=self.now, last_changed_at=self.now)
            self.s.add(opp)
        changed = is_new or opp.content_hash != chash

        opp.group_key = (f"{d.source_id}:group:{d.group_hint}" if d.group_hint
                         else dedup.group_key(d.source_id, d.agency_name, d.solicitation_number, title, due))
        opp.solicitation_number = clean(d.solicitation_number)
        opp.title = title
        if d.description is not None or not opp.description_fetched:
            opp.description = (clean(d.description) or None) and clean(d.description)[:4000]
        opp.agency_name = clean(d.agency_name)
        opp.sub_agency = clean(d.sub_agency)
        opp.notice_type = ntype
        opp.naics_codes = [str(n).strip() for n in d.naics_codes if n]
        opp.psc_code = clean(d.psc_code)
        opp.set_aside = clean(d.set_aside)
        opp.posted_at = posted
        opp.response_due_at = due
        opp.status = status
        opp.url = d.url
        opp.documents_url = d.documents_url
        opp.contact_name, opp.contact_email, opp.contact_phone = clean(d.contact_name), clean(d.contact_email), clean(d.contact_phone)
        opp.loc_street, opp.loc_city, opp.loc_state, opp.loc_zip = used.street, used.city, loc_state, zip5(used.zip)
        opp.location_basis = basis
        opp.lat, opp.lon = lat, lon
        opp.geocode_method = method
        opp.source_status = d.source_status
        opp.est_value = d.est_value
        extra = dict(d.extra or {})
        if d.trade:
            extra.setdefault("trade", d.trade)
        opp.extra = extra or None
        opp.content_hash = chash
        opp.last_seen_at = self.now
        if changed:
            opp.last_changed_at = self.now

        self.s.flush()
        self.score(opp)
        compute_for(self.s, opp, self.offices)
        if opp.review is None:
            opp.review = LeadReview(status="new")
        dedup.link_cross_source(self.s, opp)
        return opp, ("new" if is_new else ("updated" if changed else "seen"))

    def score(self, opp: Opportunity) -> OpportunityScore:
        trade = (opp.extra or {}).get("trade") if isinstance(opp.extra, dict) else None
        r = self.scorer.score(opp.title, opp.description, opp.psc_code, opp.naics_codes, trade=trade)
        sc = opp.score or OpportunityScore()
        sc.lane, sc.score = r.lane, r.score
        sc.matched_codes, sc.matched_keywords, sc.negative_hits = r.matched_codes, r.matched_keywords, r.negative_hits
        sc.scorer_version = r.scorer_version
        opp.score = sc
        return sc


def in_any_radius(s: Session, opp_id: str) -> bool:
    return s.execute(select(OfficeDistance.office_id).join(Office, Office.id == OfficeDistance.office_id).where(
        OfficeDistance.opportunity_id == opp_id, Office.active.is_(True),
        OfficeDistance.distance_miles <= Office.radius_miles).limit(1)).first() is not None


# ---------------------------------------------------------------- adapters

def build_adapter(source_id: str, s: Session, client_factory: Callable[[float], Client]) -> SourceAdapter:
    cfg = sources_config().get("sources", {}).get(source_id, {})
    if source_id == "sam_gov":
        from leadfinder.adapters.sam_gov import SEARCH_URL, SamGovAdapter
        return SamGovAdapter(client_factory(0.0), page_limit=int(cfg.get("page_limit", 1000)),
                             base_url=cfg.get("base_url", SEARCH_URL))
    if source_id == "bonfire":
        from leadfinder.adapters.bonfire import BonfireAdapter, Target
        rows = s.execute(select(SourceTarget).where(SourceTarget.source_id == "bonfire",
                                                    SourceTarget.enabled.is_(True))).scalars()
        targets = [Target(r.id, r.slug, r.agency_name, r.street, r.city, r.state, r.zip, r.lat, r.lon) for r in rows]
        return BonfireAdapter(client_factory(float(cfg.get("min_seconds_between_requests", 2.0))), targets)
    if source_id == "email_alerts":
        from leadfinder.adapters.email_alerts import EmailAlertsAdapter
        return EmailAlertsAdapter.from_config(cfg)
    if source_id == "buildingconnected":
        from leadfinder.adapters.buildingconnected import BuildingConnectedAdapter
        from leadfinder.aps_auth import ApsAuth
        client = client_factory(float(cfg.get("min_seconds_between_requests", 0.25)))
        skip = cfg.get("skip_due_before_days", 30)
        return BuildingConnectedAdapter(client, ApsAuth(client), page_limit=int(cfg.get("page_limit", 100)),
                                        skip_due_before_days=None if skip is None else int(skip))
    raise ValueError(f"no adapter for source {source_id!r}")


# ---------------------------------------------------------------- run

def expire(s: Session, now: datetime) -> int:
    res = s.execute(update(Opportunity).where(Opportunity.status == "open", Opportunity.response_due_at.is_not(None),
                                              Opportunity.response_due_at < now).values(status="closed"))
    return res.rowcount or 0


def calls_used_today(s: Session, source_id: str, now: datetime) -> int:
    start = datetime.combine(now.date(), time.min, tzinfo=timezone.utc)
    return int(s.execute(select(func.coalesce(func.sum(SourceRun.api_calls_used), 0)).join(Run).where(
        SourceRun.source_id == source_id, Run.started_at >= start)).scalar_one())


def pending_cursor(s: Session, source_id: str) -> dict | None:
    last = s.execute(select(SourceRun).join(Run).where(SourceRun.source_id == source_id, SourceRun.status != "running")
                     .order_by(Run.started_at.desc()).limit(1)).scalar_one_or_none()
    if last is not None and last.status == "partial" and last.resume_cursor:
        return last.resume_cursor
    return None


def default_window(src: Source, since: date | None, until: date | None, today: date, backfill_days: int) -> DateWindow:
    if since is None:
        since = src.last_success_at.date() if src.last_success_at else today - timedelta(days=backfill_days)
    until = until or today
    if since > until:
        since = until
    return DateWindow(since, until)


def run(sources: Iterable[str] | None = None, since: date | None = None, until: date | None = None,
        trigger: str = "manual", *, session_factory: Callable[[], Session] | None = None,
        adapters: dict[str, SourceAdapter] | None = None, client_factory: Callable[[float], Client] | None = None,
        geocode_online: bool = True, now: datetime | None = None) -> Run:
    if not _RUN_LOCK.acquire(blocking=False):
        raise RunInProgress("a run is already in progress")
    try:
        return _run(sources, since, until, trigger, session_factory, adapters, client_factory, geocode_online, now)
    finally:
        PROGRESS.done = True
        _RUN_LOCK.release()


def is_running() -> bool:
    return _RUN_LOCK.locked()


def _run(sources, since, until, trigger, session_factory, adapters, client_factory, geocode_online, now) -> Run:
    if session_factory is None:
        from leadfinder.db.session import SessionLocal
        session_factory = SessionLocal
    client_factory = client_factory or (lambda interval: Client(min_interval_per_host=interval))
    now = now or utcnow()
    today = now.date()
    cfg_sources = sources_config().get("sources", {})

    s = session_factory()
    try:
        # Stale "running" rows from a crashed process don't block anything; mark them failed.
        s.execute(update(Run).where(Run.status == "running", Run.started_at < now - STALE_RUN_AFTER)
                  .values(status="failed", finished_at=now))
        expire(s, now)

        if sources:
            selected = [s.get(Source, sid) for sid in sources]
            missing = [sid for sid, row in zip(sources, selected) if row is None]
            if missing:
                raise ValueError(f"unknown source(s): {', '.join(missing)}")
        else:
            selected = list(s.execute(select(Source).where(Source.enabled.is_(True)).order_by(Source.id)).scalars())

        windows = {src.id: default_window(src, since, until, today, int(cfg_sources.get(src.id, {}).get("backfill_days", 14)))
                   for src in selected}
        run_row = Run(trigger=trigger, status="running", started_at=now,
                      window_from=min((w.posted_from for w in windows.values()), default=today),
                      window_to=max((w.posted_to for w in windows.values()), default=today))
        s.add(run_row)
        s.commit()
        PROGRESS.run_id, PROGRESS.done = run_row.id, False
        PROGRESS.sources = {src.id: {"status": "pending", "fetched": 0, "new": 0, "updated": 0, "calls": 0,
                                     "budget": src.daily_call_budget} for src in selected}

        geo_client = client_factory(0.0) if geocode_online else None
        scorer = Scorer()
        for src in selected:
            _run_source(s, run_row, src, windows[src.id], adapters, client_factory, geo_client, scorer, now)

        statuses = [sr.status for sr in run_row.source_runs]
        if not statuses or all(x == "succeeded" for x in statuses):
            run_row.status = "succeeded"
        elif all(x == "failed" for x in statuses):
            run_row.status = "failed"
        else:
            run_row.status = "partial"
        run_row.finished_at = utcnow()
        s.commit()
        s.refresh(run_row)
        _ = list(run_row.source_runs)
        return run_row
    finally:
        s.close()


def _run_source(s: Session, run_row: Run, src: Source, window: DateWindow, adapters, client_factory,
                geo_client, scorer: Scorer, now: datetime) -> None:
    sr = SourceRun(run_id=run_row.id, source_id=src.id, status="running")
    run_row.source_runs.append(sr)
    s.commit()
    prog = PROGRESS.sources[src.id]
    prog["status"] = "running"

    limit = src.daily_call_budget
    if limit is not None:
        limit = max(0, limit - calls_used_today(s, src.id, now))
    budget = CallBudget(limit)
    cursor = pending_cursor(s, src.id)
    proc = Processor(s, Geocoder(s, geo_client, online=geo_client is not None), scorer, now)
    adapter = None
    desc_candidates: list[tuple[str, str]] = []
    completed = False
    try:
        adapter = (adapters or {}).get(src.id) or build_adapter(src.id, s, client_factory)
        n = 0
        for raw in adapter.fetch(window, budget, cursor):
            sr.records_fetched += 1
            changed = proc.ingest_raw(src.id, run_row.id, raw)
            draft = adapter.normalize(raw)
            opp, outcome = proc.apply(draft, changed)
            if outcome == "new":
                sr.records_new += 1
            elif outcome == "updated":
                sr.records_updated += 1
            if draft.description_url and not opp.description_fetched and outcome != "seen":
                desc_candidates.append((opp.id, draft.description_url))
            n += 1
            prog.update(fetched=sr.records_fetched, new=sr.records_new, updated=sr.records_updated, calls=budget.used)
            if n % COMMIT_EVERY == 0:
                sr.api_calls_used = budget.used
                s.commit()
        completed = True
        sr.resume_cursor = None
        sr.status = "succeeded"
    except BudgetExhaustedError as exc:
        sr.status = "partial"
        sr.resume_cursor = exc.cursor
        where = f"offset {exc.cursor['offset']}" if "offset" in exc.cursor else "the saved cursor"
        sr.error = f"call budget exhausted after {budget.used} calls; will resume at {where}"
    except Exception as exc:  # noqa: BLE001 - one source failing must not stop the others
        s.rollback()
        log.exception("source failed", extra={"source": src.id})
        sr = s.get(SourceRun, (run_row.id, src.id))
        sr.status = "failed"
        sr.error = redact(f"{type(exc).__name__}: {exc}")[:1000]

    # Per-target errors (Bonfire): partial if some failed, failed if all did.
    t_errors = getattr(adapter, "errors", None)
    if t_errors and sr.status == "succeeded":
        n_targets = len(getattr(adapter, "targets", []) or [])
        sr.status = "failed" if n_targets and len(t_errors) >= n_targets else "partial"
        sr.error = redact(f"{len(t_errors)} target(s) failed; first: {t_errors[0].slug}: {t_errors[0].error}")[:1000]
        completed = sr.status != "failed"

    # SAM descriptions: only AV-lane, in-range opportunities, only while budget remains.
    if desc_candidates and hasattr(adapter, "fetch_description") and sr.status in ("succeeded", "partial"):
        for opp_id, url in desc_candidates:
            if not budget.can_spend():
                break
            opp = s.get(Opportunity, opp_id)
            if opp is None or opp.score is None or opp.score.lane == "none" or not in_any_radius(s, opp_id):
                continue
            text = adapter.fetch_description(url, budget)
            opp.description_fetched = True
            if text:
                opp.description = text
                proc.score(opp)

    sr.api_calls_used = budget.used
    if completed and sr.status == "succeeded":
        # Next default window starts from the end of the window just covered.
        # A resumed run covered the cursor's (older) window, not the requested one.
        covered = date.fromisoformat(cursor["posted_to"]) if cursor and "posted_to" in cursor else window.posted_to
        src.last_success_at = now if covered >= now.date() else datetime.combine(covered, time.max, tzinfo=timezone.utc)
    prog.update(status=sr.status, calls=budget.used, fetched=sr.records_fetched, new=sr.records_new,
                updated=sr.records_updated, error=sr.error)
    s.commit()


def reprocess_source(source_id: str, session_factory: Callable[[], Session] | None = None,
                     geocode_online: bool = False, now: datetime | None = None) -> int:
    """Re-run normalize/locate/score/dedup for a source from its latest stored raw payloads,
    without fetching. Use after changing an adapter's field mapping or grouping."""
    import json as _json

    if session_factory is None:
        from leadfinder.db.session import SessionLocal
        session_factory = SessionLocal
    now = now or utcnow()
    s = session_factory()
    try:
        adapter = build_adapter(source_id, s, lambda interval: Client(min_interval_per_host=interval))
        geo_client = Client() if geocode_online else None
        proc = Processor(s, Geocoder(s, geo_client, online=geocode_online), Scorer(), now)
        n = 0
        for opp in list(s.execute(select(Opportunity).where(Opportunity.source_id == source_id)).scalars()):
            raw = s.execute(select(RawRecord).where(RawRecord.source_id == source_id,
                                                    RawRecord.source_record_id == opp.source_record_id)
                            .order_by(RawRecord.fetched_at.desc()).limit(1)).scalar_one_or_none()
            if raw is None:
                continue
            try:
                payload = _json.loads(raw.payload)
            except ValueError:
                payload = raw.payload
            draft = adapter.normalize(RawItem(source_record_id=opp.source_record_id, payload=payload))
            keep_seen, keep_changed = opp.last_seen_at, opp.last_changed_at
            proc.apply(draft, payload_changed=True)
            opp.last_seen_at = keep_seen  # reprocessing isn't a sighting or a source change
            opp.last_changed_at = keep_changed
            n += 1
            if n % COMMIT_EVERY == 0:
                s.commit()
        s.commit()
        return n
    finally:
        s.close()


def rescore_all(session_factory: Callable[[], Session] | None = None) -> int:
    if session_factory is None:
        from leadfinder.db.session import SessionLocal
        session_factory = SessionLocal
    s = session_factory()
    try:
        proc = Processor.__new__(Processor)
        proc.scorer = Scorer()
        n = 0
        for opp in s.execute(select(Opportunity)).scalars():
            Processor.score(proc, opp)
            n += 1
        s.commit()
        return n
    finally:
        s.close()
