"""Keep the database in step with the lead folders on the worker's volume.

The bid documents themselves live only on the worker's volume (/data/documents); the tab
uploads and downloads them through the worker (worker.web()). After every document or triage
action the worker calls mirror_lead(), which

  - upserts lf_document (one row per file in the folder) and removes rows for files that are gone,
  - writes lf_lead_docs.summary (counts, SAM status, unpack errors, the folder manifest),
  - copies the triage run history from the manifest into lf_triage_run, with the report text."""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder import documents as D
from leadfinder.db.models import Document, LeadDocs, Opportunity, TriageRun

log = logging.getLogger(__name__)

_TRIAGE_FIELDS = ("status", "rating", "tier", "estimate", "bid_due", "rfi_due", "summary", "error", "files",
                  "cost_usd", "budget_usd", "session_id")


def _dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _summary_json(session: Session, opp: Opportunity, folder: Path) -> dict:
    s = D.summary(session, opp)
    return {
        "folder": folder.name,
        "count": s["count"],
        "total_bytes": s["total_bytes"],
        "sam_links": s["sam_links"],
        "sam_ok": s["sam_ok"],
        "sam_errors": [[u, e] for u, e in s["sam_errors"]],
        "unpack_errors": [[r, e] for r, e in s["unpack_errors"]],
        "zips": [z.rel for z in s["zips"]],
        "manifest": D.load_manifest(folder),
    }


def mirror_lead(session: Session, opp: Opportunity) -> dict:
    """Bring lf_document / lf_lead_docs / lf_triage_run in line with the lead's folder.
    Returns counts. Commits."""
    folder = D.lead_folder(opp)
    if folder is None:
        return {"files": 0, "added": 0, "removed": 0}
    files = D.list_files(folder)
    existing = {d.path: d for d in session.execute(
        select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    added = 0
    seen: set[str] = set()
    for f in files:
        seen.add(f.rel)
        row = existing.get(f.rel)
        if row is None:
            session.add(Document(opportunity_id=opp.id, path=f.rel, size=f.size, is_zip=f.is_zip, unpacked=f.unpacked))
            added += 1
        else:
            row.size, row.is_zip, row.unpacked = f.size, f.is_zip, f.unpacked
    removed = 0
    for path, row in existing.items():
        if path not in seen:
            session.delete(row)
            removed += 1

    docs = session.get(LeadDocs, opp.id) or LeadDocs(opportunity_id=opp.id, folder=folder.name)
    docs.folder = folder.name
    docs.summary = _summary_json(session, opp, folder)
    session.add(docs)
    _mirror_triage(session, opp, docs.summary["manifest"])
    session.commit()
    return {"files": len(files), "added": added, "removed": removed}


def _mirror_triage(session: Session, opp: Opportunity, manifest: dict) -> None:
    for r in manifest.get("triage", []) or []:
        rid = r.get("id")
        if not rid:
            continue
        row = session.get(TriageRun, rid) or TriageRun(id=rid, opportunity_id=opp.id)
        for k in _TRIAGE_FIELDS:
            setattr(row, k, r.get(k))
        if row.status not in ("uploading", "running", "done", "failed"):
            row.status = "failed"
        row.started_at = _dt(r.get("started_at"))
        row.finished_at = _dt(r.get("finished_at"))
        report = r.get("report")
        if report and not row.report_md:
            try:
                row.report_md = Path(report).read_text(encoding="utf-8")
            except OSError:
                pass
        session.add(row)


def mirror_all(session: Session) -> int:
    """Re-mirror every lead folder (after importing documents onto a new volume)."""
    n = 0
    for folder in D.iter_folders():
        opp_id = D.load_manifest(folder).get("opportunity_id")
        opp = session.get(Opportunity, opp_id) if opp_id else None
        if opp is None:
            log.warning("folder without a matching lead", extra={"folder": folder.name})
            continue
        mirror_lead(session, opp)
        n += 1
    return n
