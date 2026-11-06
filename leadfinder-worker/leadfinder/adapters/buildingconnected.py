"""BuildingConnected Bid Board Pro adapter (Autodesk Platform Services API, read-only).

GET /construction/buildingconnected/v2/opportunities, cursor-paginated (`cursorState`),
incremental via `filter[updatedAt]=<from>..`. Needs a user-context (3-legged) token from
leadfinder.aps_auth and a Bid Board Pro subscription on the connected user's office.

These records are bid *invitations* GCs sent to Instrata, not public notices:
- agency_name is the inviting GC (client.company.name);
- group parents (isParent) are skipped; their children (one per GC) share parentId as the
  group key, so a project invited by several GCs collapses to one Results row;
- the project location comes with coordinates, used directly (geocode "source_coords");
- source_status keeps the Bid Board state (UNDECIDED / WILL_SUBMIT / SUBMITTED / ...);
- est_value is the team's ROM estimate, else the final value, else the last bid total.
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from typing import Any, Iterator

from leadfinder.adapters.base import AddressDraft, BudgetExhaustedError, DateWindow, OpportunityDraft, RawItem
from leadfinder.adapters.sam_gov import strip_html
from leadfinder.aps_auth import ApsAuth
from leadfinder.http import BudgetExhausted, CallBudget, Client, HttpError
from leadfinder.pipeline.normalize import normalized_key_text

log = logging.getLogger(__name__)

BASE_URL = "https://developer.api.autodesk.com/construction/buildingconnected/v2"
OPPORTUNITIES_URL = f"{BASE_URL}/opportunities"
USERS_ME_URL = f"{BASE_URL}/users/me"
APP_URL = "https://app.buildingconnected.com/opportunities/{id}/info"
MIN_PRECISION = 4  # precisionLevel below this (country/state-level) -> geocode the address instead

STATUS_LABEL = {
    "UNDECIDED": "Undecided", "WILL_SUBMIT": "Accepted", "SUBMITTED": "Submitted", "DECLINED": "Declined",
    "ARCHIVED": "Archived", "WON": "Won", "LOST": "Lost", "CANCELED": "Cancelled", "OTHER": "Closed (other)",
}


class BuildingConnectedAccessError(Exception):
    """403 from the API: the connected user/office lacks Bid Board Pro (or API access)."""


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _get(obj: Any, *keys: str) -> Any:
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN


def coords(loc: dict | None) -> tuple[float, float] | None:
    """Validated (lat, lon) from a BuildingConnected location, or None."""
    if not isinstance(loc, dict):
        return None
    lat, lng = _num(_get(loc, "coords", "lat")), _num(_get(loc, "coords", "lng"))
    if lat is None or lng is None or (lat == 0 and lng == 0):
        return None
    # The API reference example has lat/lng swapped; be tolerant. For US locations use a
    # bounding box (incl. AK/HI/PR), which also catches swaps where both values are < 90.
    def in_us(a: float, o: float) -> bool:
        return 17.5 <= a <= 71.5 and -180 <= o <= -64
    if str(loc.get("country") or "US").upper() in ("US", "USA"):
        if not in_us(lat, lng):
            if in_us(lng, lat):
                lat, lng = lng, lat
            else:
                return None
    elif abs(lat) > 90 >= abs(lng):
        lat, lng = lng, lat
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    prec = loc.get("precisionLevel")
    if isinstance(prec, (int, float)) and prec < MIN_PRECISION:
        return None
    return lat, lng


def project_group(p: dict) -> str:
    """Group key for invites to the same project. Bid Board groups (parentId) win; otherwise
    same normalized project name + state + due date (Instrata's board doesn't use groups, and
    a GC often sends one invite per trade)."""
    if p.get("parentId"):
        return str(p["parentId"])
    state = (_get(p, "location", "state") or "").upper()
    due = str(p.get("dueAt") or "")[:10] or "nodue"
    return f"p:{normalized_key_text(p.get('name'))}:{state}:{due}"


def bid_board_state(p: dict) -> str:
    """One status for filtering: outcome beats archive beats submission state."""
    outcome = _get(p, "outcome", "state")
    if outcome in ("WON", "LOST"):
        return outcome
    if outcome == "OTHER":
        return "CANCELED" if _get(p, "outcome", "otherReason") == "CANCELED" else "OTHER"
    if p.get("isArchived"):
        return "ARCHIVED"
    return p.get("submissionState") or "UNDECIDED"


def _status(state: str) -> tuple[bool | None, str | None]:
    """(active, status_hint) for the pipeline. Undecided/accepted invites are open until due."""
    if state in ("UNDECIDED", "WILL_SUBMIT"):
        return True, None
    if state in ("WON", "LOST"):
        return False, "awarded"
    if state == "CANCELED":
        return False, "cancelled"
    return False, None  # SUBMITTED, DECLINED, ARCHIVED, OTHER -> closed


class BuildingConnectedAdapter:
    source_id = "buildingconnected"

    def __init__(self, client: Client, auth: ApsAuth, page_limit: int = 100, skip_due_before_days: int | None = 30,
                 now: datetime | None = None):
        self.client = client
        self.auth = auth
        self.page_limit = page_limit
        self.skip_due_before_days = skip_due_before_days
        self.now = now
        self.skipped_old = 0
        self.skipped_parents = 0

    # ------------------------------------------------------------------ http
    def _api_get(self, url: str, params: dict | None, budget: CallBudget | None):
        token = self.auth.access_token()
        try:
            return self.client.get(url, params=params, budget=budget, headers={"Authorization": f"Bearer {token}"})
        except HttpError as exc:
            if exc.status == 401:  # token revoked/expired early: refresh once and retry
                token = self.auth.access_token(force_refresh=True)
                return self.client.get(url, params=params, budget=budget,
                                       headers={"Authorization": f"Bearer {token}"})
            if exc.status == 403:
                raise BuildingConnectedAccessError(
                    "BuildingConnected returned 403: the connected user's office needs a Bid Board Pro "
                    "subscription (and API access) to read opportunities") from exc
            raise

    def users_me(self) -> dict:
        return self._api_get(USERS_ME_URL, None, None).json()

    def probe(self) -> bool:
        """True if the connected user can read opportunities (one call, limit=1)."""
        try:
            self._api_get(OPPORTUNITIES_URL, {"limit": 1}, None)
            return True
        except BuildingConnectedAccessError:
            return False

    # ------------------------------------------------------------------ fetch
    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]:
        """All opportunities updated since window.posted_from (open-ended: window.posted_to is
        ignored, an invite updated today must not be missed)."""
        if cursor:
            updated_from = cursor["updated_from"]
            cs = cursor.get("cursorState")
        else:
            updated_from = _iso_z(datetime.combine(window.posted_from, time.min, tzinfo=timezone.utc))
            cs = None
        now = self.now or datetime.now(timezone.utc)
        cutoff = now - timedelta(days=self.skip_due_before_days) if self.skip_due_before_days is not None else None
        restarted = False

        while True:
            if not budget.can_spend():
                raise BudgetExhaustedError({"updated_from": updated_from, "cursorState": cs})
            params: dict[str, Any] = {"limit": self.page_limit, "filter[updatedAt]": f"{updated_from}.."}
            if cs:
                params["cursorState"] = cs
            try:
                resp = self._api_get(OPPORTUNITIES_URL, params, budget)
            except BudgetExhausted:
                raise BudgetExhaustedError({"updated_from": updated_from, "cursorState": cs})
            except HttpError as exc:
                if exc.status == 400 and cs and cursor and not restarted:
                    # A saved cursor from an earlier run may have expired: restart this window.
                    log.warning("buildingconnected cursor rejected; restarting window")
                    cs, restarted = None, True
                    continue
                raise
            data = resp.json()
            results = data.get("results") or []
            for it in results:
                if not isinstance(it, dict) or not it.get("id"):
                    log.warning("buildingconnected item without id skipped")
                    continue
                if it.get("isParent"):
                    self.skipped_parents += 1  # group container; its children are the real invites
                    continue
                due = it.get("dueAt")
                if cutoff and due:
                    try:
                        if datetime.fromisoformat(str(due).replace("Z", "+00:00")) < cutoff:
                            self.skipped_old += 1
                            continue
                    except ValueError:
                        pass
                yield RawItem(source_record_id=str(it["id"]), payload=it)
            cs = (data.get("pagination") or {}).get("cursorState")
            if not cs or not results:
                if self.skipped_old or self.skipped_parents:
                    log.info("buildingconnected skipped", extra={"past_due": self.skipped_old,
                                                                  "group_parents": self.skipped_parents})
                return

    # -------------------------------------------------------------- normalize
    def normalize(self, raw: RawItem) -> OpportunityDraft:
        p: dict[str, Any] = raw.payload if isinstance(raw.payload, dict) else {}
        loc = p.get("location") if isinstance(p.get("location"), dict) else {}
        foreign = bool(loc.get("country")) and str(loc.get("country")).upper() not in ("US", "USA")
        street = " ".join(str(x) for x in (loc.get("streetNumber"), loc.get("streetName")) if x) or None
        addr = None if foreign else AddressDraft(street=street, city=loc.get("city"), state=loc.get("state"),
                                                 zip=loc.get("zip"))
        latlon = None if foreign else coords(loc)

        state = bid_board_state(p)
        active, hint = _status(state)

        rom, final, bid_total = _num(p.get("rom")), _num(p.get("finalValue")), _num(_get(p, "bid", "total"))
        est, basis = next(((v, b) for v, b in ((rom, "ROM"), (final, "final value"), (bid_total, "bid total"))
                           if v), (None, None))

        lead = _get(p, "client", "lead") or {}
        lead_name = " ".join(x for x in (lead.get("firstName"), lead.get("lastName")) if x) or None

        parts = []
        if p.get("tradeSpecificInstructions"):
            parts.append(strip_html(str(p["tradeSpecificInstructions"])))
        if p.get("projectInformation"):
            parts.append(strip_html(str(p["projectInformation"])))
        description = "\n\n".join(x for x in parts if x) or None

        extra = {k: v for k, v in {
            "trade": p.get("tradeName"),
            "gc": _get(p, "client", "company", "name"),
            "architect": p.get("architect"),
            "engineer": p.get("engineer"),
            "owner": p.get("propertyOwner"),
            "tenant": p.get("propertyTenant"),
            "market_sector": p.get("marketSector") if p.get("marketSector") not in (None, "NONE") else None,
            "project_sqft": _num(p.get("projectSize")),
            "job_walk_at": p.get("jobWalkAt"),
            "rfis_due_at": p.get("rfisDueAt"),
            "expected_start_at": p.get("expectedStartAt"),
            "priority": p.get("priority") if p.get("priority") not in (None, "UNKNOWN") else None,
            "win_probability": p.get("winProbability"),
            "value_basis": basis,
            "request_type": p.get("requestType"),
            "nda_required": p.get("isNdaRequired") or None,
            "sealed_bidding": p.get("isSealedBidding") or None,
            "address": loc.get("complete"),
            "location_precision": loc.get("precisionLevel"),
        }.items() if v not in (None, "", [])}

        return OpportunityDraft(
            source_id=self.source_id,
            source_record_id=raw.source_record_id,
            solicitation_number=p.get("number") or None,
            title=p.get("name") or _get(p, "clientValues", "name") or "(untitled)",
            description=description,
            agency_name=_get(p, "client", "company", "name"),
            notice_type_raw="Request for Proposal" if p.get("requestType") == "PROPOSAL" else (p.get("requestType") or None),
            posted_at_raw=p.get("invitedAt") or p.get("createdAt"),
            response_due_at_raw=p.get("dueAt"),
            active=active,
            status_hint=hint,
            url=APP_URL.format(id=raw.source_record_id),
            contact_name=lead_name,
            contact_email=lead.get("email"),
            contact_phone=lead.get("phoneNumber"),
            location=addr,
            location_basis="place_of_performance",
            state_hint=None if foreign else loc.get("state"),
            source_latlon=latlon,
            group_hint=project_group(p),
            source_status=state,
            est_value=est,
            trade=p.get("tradeName") or None,
            extra=extra,
        )
