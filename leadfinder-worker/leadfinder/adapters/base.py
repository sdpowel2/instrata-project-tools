"""Adapter interface. Adapters only fetch and map fields; geocoding, scoring,
distance and dedup live in the shared pipeline."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Iterator, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from leadfinder.http import CallBudget


@dataclass(frozen=True)
class DateWindow:
    posted_from: date
    posted_to: date


@dataclass
class RawItem:
    source_record_id: str
    payload: dict[str, Any] | str
    # Adapter-supplied context that isn't part of the published payload
    # (e.g. which Bonfire source_target the item came from).
    context: dict[str, Any] = field(default_factory=dict)

    @property
    def payload_text(self) -> str:
        if isinstance(self.payload, str):
            return self.payload
        return json.dumps(self.payload, sort_keys=True, ensure_ascii=False)

    @property
    def payload_hash(self) -> str:
        return hashlib.sha256(self.payload_text.encode("utf-8")).hexdigest()


class AddressDraft(BaseModel):
    street: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None


class OpportunityDraft(BaseModel):
    """What an adapter hands the pipeline. Unnormalized values are fine; the
    pipeline normalizes everything."""

    source_id: str
    source_record_id: str
    solicitation_number: str | None = None
    title: str
    description: str | None = None
    agency_name: str | None = None
    sub_agency: str | None = None
    notice_type_raw: str | None = None
    naics_codes: list[str] = Field(default_factory=list)
    psc_code: str | None = None
    set_aside: str | None = None
    posted_at_raw: str | None = None
    response_due_at_raw: str | None = None
    active: bool | None = None  # source says open/active
    status_hint: str | None = None  # e.g. "cancelled", "awarded", "unknown"
    url: str | None = None
    documents_url: str | None = None
    contact_name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    location: AddressDraft | None = None
    location_basis: str = "none"  # basis if `location` resolves
    fallback_location: AddressDraft | None = None
    fallback_basis: str = "none"
    fallback_latlon: tuple[float, float] | None = None  # pre-geocoded fallback (e.g. agency)
    state_hint: str | None = None  # time-zone / "location unknown" state tagging
    description_url: str | None = None  # SAM: description is a URL costing one call
    # Coordinates published by the source for `location` (BuildingConnected). Used before
    # geocoding when present; geocode_method becomes "source_coords".
    source_latlon: tuple[float, float] | None = None
    # Source-defined grouping (BuildingConnected opportunity groups: one project, many GCs).
    # Overrides the computed group_key so the group collapses to one row.
    group_hint: str | None = None
    source_status: str | None = None   # status in the source's own workflow (e.g. Bid Board UNDECIDED)
    est_value: float | None = None     # estimated dollar value, when the source has one
    trade: str | None = None           # trade / scope the invite is for (scored separately)
    extra: dict[str, Any] = Field(default_factory=dict)  # display-only source fields


class BudgetExhaustedError(Exception):
    """Adapter stopped because the call budget ran out. Carries the resume cursor."""

    def __init__(self, cursor: dict[str, Any]):
        super().__init__("call budget exhausted")
        self.cursor = cursor


@runtime_checkable
class SourceAdapter(Protocol):
    source_id: str

    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]: ...

    def normalize(self, raw: RawItem) -> OpportunityDraft: ...


def utc_iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None
