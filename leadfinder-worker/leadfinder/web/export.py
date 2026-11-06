"""CSV export of the current filtered view (same query as the Results page)."""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Callable

from sqlalchemy.orm import Session

from leadfinder.settings import ROOT
from leadfinder.web.queries import Filters, ResultRow, query_results

COLUMNS = ["lane", "score", "title", "agency", "solicitation_number", "notice_type", "loc_city", "loc_state",
           "loc_zip", "location_basis", "nearest_office", "distance_miles", "posted_at", "response_due_at",
           "status", "source", "url", "review_status", "first_seen_at",
           # Added for BuildingConnected (empty for other sources); kept at the end so the
           # original column order doesn't change.
           "est_value", "bid_board_status", "trades", "bb_invites", "bb_gcs"]
EXPORT_DIR = ROOT / "exports"
BASENAME = "AV-Lead-Finder_Leads_v{n}.csv"

VIEWS: dict[str, Callable[[], Filters]] = {
    "default": lambda: Filters.from_params({}),
    "all_open": lambda: Filters.from_params({"submitted": "1", "lane": ["direct_av", "likely_av_scope", "none"],
                                             "status": "open"}),
}


def _iso(dt) -> str:
    return dt.isoformat() if dt else ""


def row_values(r: ResultRow) -> list:
    o = r.opp
    return [r.lane, r.score, o.title, o.agency_name or "", o.solicitation_number or "", o.notice_type,
            o.loc_city or "", o.loc_state or "", o.loc_zip or "", o.location_basis, r.nearest_office or "",
            "" if r.nearest_distance is None else f"{r.nearest_distance:.1f}", _iso(o.posted_at),
            _iso(o.response_due_at), o.status, o.source_id, o.url or "", r.review, _iso(o.first_seen_at),
            "" if r.est_value is None else f"{r.est_value:.0f}", o.source_status or "",
            "; ".join(r.trades), r.notices if o.source_id == "buildingconnected" else "",
            r.gcs or ""]


def to_csv(rows: list[ResultRow]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(COLUMNS)
    for r in rows:
        w.writerow(row_values(r))
    return buf.getvalue()


def next_path(directory: Path | None = None) -> Path:
    directory = directory or EXPORT_DIR  # resolved at call time (tests patch EXPORT_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    n = 1
    while (directory / BASENAME.format(n=n)).exists():
        n += 1
    return directory / BASENAME.format(n=n)


def write_export(s: Session, f: Filters, directory: Path | None = None) -> tuple[Path, int]:
    rows = query_results(s, f)
    path = next_path(directory)
    # utf-8-sig so Excel opens accented agency names correctly
    path.write_text(to_csv(rows), encoding="utf-8-sig")
    return path, len(rows)


def export_view(view: str = "default") -> tuple[Path, int]:
    from leadfinder.db.session import SessionLocal

    if view not in VIEWS:
        raise ValueError(f"unknown view {view!r}; choose from {', '.join(VIEWS)}")
    s = SessionLocal()
    try:
        return write_export(s, VIEWS[view]())
    finally:
        s.close()
