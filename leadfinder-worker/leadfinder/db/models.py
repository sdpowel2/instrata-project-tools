"""SQLAlchemy 2.x models. Kept Postgres-compatible: text UUIDs, JSON columns,
non-native enums (VARCHAR + CHECK), timezone-aware timestamps stored in UTC."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.types import TypeDecorator
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC datetimes on every backend. SQLite has no zone support,
    so values are stored as naive UTC and re-tagged as UTC on read."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


def enum(*values: str, name: str) -> Enum:
    return Enum(*values, name=name, native_enum=False, create_constraint=True, length=32)


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------- offices

OFFICE_GEOCODE_METHODS = ("census_address", "zip_centroid", "manual")


class Office(Timestamped, Base):
    __tablename__ = "lf_office"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    street: Mapped[str] = mapped_column(String(200))
    city: Mapped[str] = mapped_column(String(100))
    state: Mapped[str] = mapped_column(String(2))
    zip: Mapped[str] = mapped_column(String(5))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    geocode_method: Mapped[str | None] = mapped_column(enum(*OFFICE_GEOCODE_METHODS, name="office_geocode_method"))
    geocode_match: Mapped[str | None] = mapped_column(Text)
    radius_miles: Mapped[int] = mapped_column(Integer, default=100)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


# ---------------------------------------------------------------- sources

class Source(Timestamped, Base):
    __tablename__ = "lf_source"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(enum("api", "portal", "email", "paid_feed", name="source_kind"))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    daily_call_budget: Mapped[int | None] = mapped_column(Integer)
    last_success_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


AGENCY_TYPES = ("city", "county", "state", "k12", "higher_ed", "special_district", "other")


class SourceTarget(Timestamped, Base):
    __tablename__ = "lf_source_target"
    __table_args__ = (UniqueConstraint("source_id", "slug"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_id: Mapped[str] = mapped_column(ForeignKey("lf_source.id"))
    slug: Mapped[str] = mapped_column(String(100))
    agency_name: Mapped[str] = mapped_column(String(200))
    agency_type: Mapped[str] = mapped_column(enum(*AGENCY_TYPES, name="agency_type"), default="other")
    street: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(2))
    zip: Mapped[str | None] = mapped_column(String(5))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


# ---------------------------------------------------------------- runs

RUN_STATUS = ("running", "succeeded", "partial", "failed")


class Run(Timestamped, Base):
    __tablename__ = "lf_run"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    trigger: Mapped[str] = mapped_column(enum("manual", "scheduled", "cli", name="run_trigger"))
    status: Mapped[str] = mapped_column(enum(*RUN_STATUS, name="run_status"), default="running")
    window_from: Mapped[date | None] = mapped_column(Date)
    window_to: Mapped[date | None] = mapped_column(Date)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    source_runs: Mapped[list["SourceRun"]] = relationship(back_populates="run", cascade="all, delete-orphan")


class SourceRun(Timestamped, Base):
    __tablename__ = "lf_source_run"
    run_id: Mapped[str] = mapped_column(ForeignKey("lf_run.id"), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("lf_source.id"), primary_key=True)
    status: Mapped[str] = mapped_column(enum(*RUN_STATUS, name="source_run_status"), default="running")
    records_fetched: Mapped[int] = mapped_column(Integer, default=0)
    records_new: Mapped[int] = mapped_column(Integer, default=0)
    records_updated: Mapped[int] = mapped_column(Integer, default=0)
    api_calls_used: Mapped[int] = mapped_column(Integer, default=0)
    resume_cursor: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    run: Mapped[Run] = relationship(back_populates="source_runs")


class RawRecord(Timestamped, Base):
    __tablename__ = "lf_raw_record"
    __table_args__ = (Index("ix_raw_source_record", "source_id", "source_record_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_id: Mapped[str] = mapped_column(ForeignKey("lf_source.id"))
    source_record_id: Mapped[str] = mapped_column(String(200))
    run_id: Mapped[str] = mapped_column(ForeignKey("lf_run.id"))
    payload: Mapped[str] = mapped_column(Text)
    payload_hash: Mapped[str] = mapped_column(String(64))
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


# ---------------------------------------------------------------- opportunities

NOTICE_TYPES = (
    "solicitation", "presolicitation", "sources_sought", "combined", "rfq", "rfp",
    "ifb", "special", "award", "other",
)
OPP_STATUS = ("open", "closed", "cancelled", "awarded", "unknown")
LOCATION_BASIS = ("place_of_performance", "agency_address", "contracting_office", "none")
OPP_GEOCODE_METHODS = ("census_address", "zip_centroid", "city_centroid", "source_coords", "none")


class Opportunity(Timestamped, Base):
    __tablename__ = "lf_opportunity"
    __table_args__ = (
        UniqueConstraint("source_id", "source_record_id"),
        Index("ix_opp_group_key", "group_key"),
        Index("ix_opp_due", "response_due_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_id: Mapped[str] = mapped_column(ForeignKey("lf_source.id"))
    source_record_id: Mapped[str] = mapped_column(String(200))
    group_key: Mapped[str] = mapped_column(String(500))
    duplicate_of: Mapped[str | None] = mapped_column(ForeignKey("lf_opportunity.id"))
    solicitation_number: Mapped[str | None] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    agency_name: Mapped[str | None] = mapped_column(String(300))
    sub_agency: Mapped[str | None] = mapped_column(Text)
    notice_type: Mapped[str] = mapped_column(enum(*NOTICE_TYPES, name="notice_type"), default="other")
    naics_codes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    psc_code: Mapped[str | None] = mapped_column(String(10))
    set_aside: Mapped[str | None] = mapped_column(String(200))
    posted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    response_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    status: Mapped[str] = mapped_column(enum(*OPP_STATUS, name="opp_status"), default="unknown")
    url: Mapped[str | None] = mapped_column(Text)
    documents_url: Mapped[str | None] = mapped_column(Text)
    contact_name: Mapped[str | None] = mapped_column(String(200))
    contact_email: Mapped[str | None] = mapped_column(String(200))
    contact_phone: Mapped[str | None] = mapped_column(String(50))
    loc_street: Mapped[str | None] = mapped_column(String(300))
    loc_city: Mapped[str | None] = mapped_column(String(100))
    loc_state: Mapped[str | None] = mapped_column(String(2))
    loc_zip: Mapped[str | None] = mapped_column(String(5))
    location_basis: Mapped[str] = mapped_column(enum(*LOCATION_BASIS, name="location_basis"), default="none")
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    geocode_method: Mapped[str] = mapped_column(enum(*OPP_GEOCODE_METHODS, name="opp_geocode_method"), default="none")
    content_hash: Mapped[str] = mapped_column(String(64))
    first_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_changed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    # Internal: description URL fetched for SAM (not in spec table; avoids re-spending calls)
    description_fetched: Mapped[bool] = mapped_column(Boolean, default=False)
    # Source-workflow fields (added for BuildingConnected; null for other sources).
    source_status: Mapped[str | None] = mapped_column(String(64))  # e.g. Bid Board UNDECIDED / WILL_SUBMIT
    est_value: Mapped[float | None] = mapped_column(Float)          # estimated $ value (Bid Board ROM / bid)
    extra: Mapped[dict[str, Any] | None] = mapped_column(JSON)      # trade, GC count, architect, sq ft ...

    score: Mapped["OpportunityScore | None"] = relationship(back_populates="opportunity", cascade="all, delete-orphan")
    distances: Mapped[list["OfficeDistance"]] = relationship(back_populates="opportunity", cascade="all, delete-orphan")
    review: Mapped["LeadReview | None"] = relationship(back_populates="opportunity", cascade="all, delete-orphan")


class OpportunityScore(Timestamped, Base):
    __tablename__ = "lf_opportunity_score"
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"), primary_key=True)
    lane: Mapped[str] = mapped_column(enum("direct_av", "likely_av_scope", "none", name="lane"))
    score: Mapped[int] = mapped_column(Integer)
    matched_codes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    matched_keywords: Mapped[list[Any]] = mapped_column(JSON, default=list)
    negative_hits: Mapped[list[Any]] = mapped_column(JSON, default=list)
    scorer_version: Mapped[str] = mapped_column(String(50))
    opportunity: Mapped[Opportunity] = relationship(back_populates="score")


class OfficeDistance(Timestamped, Base):
    __tablename__ = "lf_office_distance"
    __table_args__ = (Index("ix_dist_office", "office_id", "distance_miles"),)
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"), primary_key=True)
    office_id: Mapped[str] = mapped_column(ForeignKey("lf_office.id"), primary_key=True)
    distance_miles: Mapped[float] = mapped_column(Float)
    is_nearest: Mapped[bool] = mapped_column(Boolean, default=False)
    opportunity: Mapped[Opportunity] = relationship(back_populates="distances")
    office: Mapped[Office] = relationship()


REVIEW_STATUS = ("new", "watch", "pursue", "pass", "already_known")


class LeadReview(Timestamped, Base):
    __tablename__ = "lf_lead_review"
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"), primary_key=True)
    status: Mapped[str] = mapped_column(enum(*REVIEW_STATUS, name="review_status"), default="new")
    notes: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    opportunity: Mapped[Opportunity] = relationship(back_populates="review")


# ---------------------------------------------------------------- reference

class ZipCentroid(Timestamped, Base):
    __tablename__ = "lf_zip_centroid"
    zip: Mapped[str] = mapped_column(String(5), primary_key=True)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    vintage: Mapped[str] = mapped_column(String(10))


class PlaceCentroid(Timestamped, Base):
    __tablename__ = "lf_place_centroid"
    state: Mapped[str] = mapped_column(String(2), primary_key=True)
    place_name: Mapped[str] = mapped_column(String(200), primary_key=True)  # normalized lowercase
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)


class GeocodeCache(Timestamped, Base):
    __tablename__ = "lf_geocode_cache"
    normalized_address: Mapped[str] = mapped_column(String(400), primary_key=True)
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String(32))
    matched_address: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


# ---------------------------------------------------------------- Project Tools port
# Tables added when the app moved into Project Tools (supabase/migrations/add_lead_finder.sql).
# The worker writes them; the Lead Finder tab reads them and queues LfJob rows.

class LeadDocs(Timestamped, Base):
    """Per-lead document summary shown in the tab (documents.summary() minus the live job)."""
    __tablename__ = "lf_lead_docs"
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"), primary_key=True)
    folder: Mapped[str] = mapped_column(Text)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Document(Timestamped, Base):
    __tablename__ = "lf_document"
    __table_args__ = (UniqueConstraint("opportunity_id", "path"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"))
    path: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(Integer, default=0)
    is_zip: Mapped[bool] = mapped_column(Boolean, default=False)
    unpacked: Mapped[bool] = mapped_column(Boolean, default=False)
    storage_key: Mapped[str | None] = mapped_column(Text)


class TriageRun(Timestamped, Base):
    __tablename__ = "lf_triage_run"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("lf_opportunity.id"))
    status: Mapped[str] = mapped_column(String(16))
    rating: Mapped[str | None] = mapped_column(Text)
    tier: Mapped[str | None] = mapped_column(Text)
    estimate: Mapped[str | None] = mapped_column(Text)
    bid_due: Mapped[str | None] = mapped_column(Text)
    rfi_due: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    files: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[float | None] = mapped_column(Float)
    budget_usd: Mapped[float | None] = mapped_column(Float)
    session_id: Mapped[str | None] = mapped_column(Text)
    report_md: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class Setting(Base):
    """Settings the tab edits or reads (default radius, worker status, BuildingConnected status)."""
    __tablename__ = "lf_setting"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class Secret(Base):
    """Worker-only state: OAuth tokens, triage agent ids. No RLS policy, so the tab can't read it."""
    __tablename__ = "lf_secret"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


JOB_KINDS = ("run", "sam_docs", "ingest_upload", "rescan", "triage", "triage_resume", "office_save",
             "office_active", "rescore", "bc_disconnect")
JOB_STATUS = ("queued", "running", "done", "failed")


class Job(Base):
    __tablename__ = "lf_job"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(enum(*JOB_KINDS, name="job_kind"))
    opportunity_id: Mapped[str | None] = mapped_column(ForeignKey("lf_opportunity.id"))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(enum(*JOB_STATUS, name="job_status"), default="queued")
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)
