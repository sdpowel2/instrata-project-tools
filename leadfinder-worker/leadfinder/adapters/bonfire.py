"""Bonfire public portal adapter.

Reads the public, unauthenticated open-opportunities JSON endpoint for each enabled
source_target. Honours robots.txt (checked once per host per run) and throttles to one
request every 2 seconds per host.

STATUS: as of 2026-11-03 every bonfirehub.com host checked serves `Disallow: /`, so this
adapter refuses to fetch and logs a per-agency error. The response shape below is
UNVERIFIED (no live fixture could be recorded without violating robots.txt) - see
DECISIONS.md D-12.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterator

from leadfinder.adapters.base import AddressDraft, DateWindow, OpportunityDraft, RawItem
from leadfinder.http import CallBudget, Client, HttpError
from leadfinder.robots import RobotsCache

log = logging.getLogger(__name__)

OPEN_PATH = "/PublicPortal/getOpenPublicOpportunitiesSectionData"


@dataclass
class Target:
    id: str
    slug: str
    agency_name: str
    street: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    lat: float | None = None
    lon: float | None = None


@dataclass
class TargetError:
    slug: str
    error: str


@dataclass
class BonfireAdapter:
    client: Client
    targets: list[Target]
    robots: RobotsCache | None = None
    errors: list[TargetError] = field(default_factory=list)
    source_id: str = "bonfire"

    def __post_init__(self) -> None:
        if self.robots is None:
            self.robots = RobotsCache(self.client)

    @staticmethod
    def base_url(slug: str) -> str:
        return f"https://{slug}.bonfirehub.com"

    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]:
        """Open opportunities are fetched regardless of posted date (Bonfire lists only
        what's open); the window is not applied server-side."""
        done = set((cursor or {}).get("done_slugs", []))
        for t in self.targets:
            if t.slug in done:
                continue
            url = self.base_url(t.slug) + OPEN_PATH
            try:
                if not self.robots.allowed(url):
                    raise PermissionError(f"robots.txt disallows {url}")
                resp = self.client.get(url, budget=budget)
                items = list(parse_open_projects(resp.json()))
            except (HttpError, PermissionError, ValueError) as exc:
                self.errors.append(TargetError(t.slug, str(exc)))
                log.warning("bonfire agency failed", extra={"slug": t.slug, "error": str(exc)})
                continue
            for p in items:
                pid = str(p.get("ProjectID") or p.get("projectId") or p.get("id") or "")
                if not pid:
                    continue
                yield RawItem(source_record_id=f"{t.slug}:{pid}", payload=p,
                              context={"target_id": t.id, "slug": t.slug})

    def normalize(self, raw: RawItem) -> OpportunityDraft:
        p: dict[str, Any] = raw.payload if isinstance(raw.payload, dict) else {}
        slug = raw.context.get("slug") or raw.source_record_id.split(":", 1)[0]
        t = next((x for x in self.targets if x.slug == slug), None)
        pid = raw.source_record_id.split(":", 1)[-1]

        def g(*keys: str) -> Any:
            for k in keys:
                if p.get(k) not in (None, ""):
                    return p[k]
            return None

        agency_addr = AddressDraft(street=t.street, city=t.city, state=t.state, zip=t.zip) if t else None
        return OpportunityDraft(
            source_id=self.source_id,
            source_record_id=raw.source_record_id,
            solicitation_number=g("ReferenceID", "referenceId", "ReferenceNumber"),
            title=g("ProjectName", "projectName", "name") or "(untitled)",
            description=g("ProjectDescription", "description"),
            agency_name=(t.agency_name if t else None) or g("OrganizationName"),
            sub_agency=g("DepartmentName", "departmentName"),
            notice_type_raw=g("ProjectType", "projectType", "Type"),
            response_due_at_raw=g("DateClose", "dateClose", "CloseDate"),
            posted_at_raw=g("DateOpen", "dateOpen", "OpenDate"),
            active=True,
            url=f"{self.base_url(slug)}/opportunities/{pid}",
            location=None,  # bids usually carry no site address
            location_basis="none",
            fallback_location=agency_addr,
            fallback_basis="agency_address",
            fallback_latlon=(t.lat, t.lon) if t and t.lat is not None else None,
            state_hint=t.state if t else None,
        )


def parse_open_projects(data: Any) -> Iterator[dict]:
    """Tolerant of the shapes reported by third-party tools: payload.projects as a dict
    keyed by id or a list; or a bare list."""
    if isinstance(data, list):
        yield from (x for x in data if isinstance(x, dict))
        return
    if not isinstance(data, dict):
        raise ValueError("unexpected Bonfire response")
    payload = data.get("payload", data)
    projects = payload.get("projects") if isinstance(payload, dict) else None
    if projects is None:
        raise ValueError("Bonfire response has no projects")
    if isinstance(projects, dict):
        yield from (v for v in projects.values() if isinstance(v, dict))
    else:
        yield from (x for x in projects if isinstance(x, dict))
