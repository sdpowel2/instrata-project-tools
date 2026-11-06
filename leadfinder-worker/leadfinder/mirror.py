"""Keep the database and Storage in step with the lead folders on the worker's volume.

After every document or triage action the worker calls mirror_lead(): it

  - upserts lf_document (one row per file) and uploads new or changed files to Storage
    (zips that were unpacked are listed but not uploaded: their contents are),
  - removes rows and objects for files that are gone,
  - writes lf_lead_docs.summary (counts, SAM status, unpack errors, the folder manifest),
  - copies the triage run history from the manifest into lf_triage_run, with the report text.

hydrate_lead() is the reverse, for a worker whose volume was replaced: it restores the
manifest and downloads mirrored files that are missing locally."""
from __future__ import annotations

import logging
import mimetypes
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder import documents as D
from leadfinder.db.models import Document, LeadDocs, Opportunity, TriageRun
from leadfinder.storage import Storage, StorageError, object_key

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
        "folder": str(folder),
        "count": s["count"],
        "total_bytes": s["total_bytes"],
        "sam_links": s["sam_links"],
        "sam_ok": s["sam_ok"],
        "sam_errors": [[u, e] for u, e in s["sam_errors"]],
        "unpack_errors": [[r, e] for r, e in s["unpack_errors"]],
        "zips": [z.rel for z in s["zips"]],
        "manifest": D.load_manifest(folder),
    }


def mirror_lead(session: Session, opp: Opportunity, storage: Storage | None = None) -> dict:
    """Bring lf_document / lf_lead_docs / lf_triage_run (and Storage, if configured) in line
    with the lead's folder. Returns counts. Commits."""
    folder = D.lead_folder(opp)
    if folder is None:
        return {"files": 0, "uploaded": 0, "removed": 0}
    use_storage = storage is not None and storage.configured
    files = D.list_files(folder)
    existing = {d.path: d for d in session.execute(
        select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    uploaded = 0
    stale_keys: list[str] = []
    seen: set[str] = set()
    for f in files:
        seen.add(f.rel)
        row = existing.get(f.rel)
        mirror = not (f.is_zip and f.unpacked)
        key = row.storage_key if row is not None else None
        if use_storage:
            want = object_key(opp.id, f.rel) if mirror else None
            if want and (row is None or row.size != f.size or row.storage_key != want):
                ctype = mimetypes.guess_type(f.rel)[0] or "application/octet-stream"
                try:
                    storage.upload(want, folder / f.rel, ctype)
                    uploaded += 1
                except (StorageError, OSError) as exc:
                    log.warning("document upload failed", extra={"opp": opp.id, "file": f.rel, "error": str(exc)})
                    want = None
            if key and key != want:
                stale_keys.append(key)
            key = want
        if row is None:
            session.add(Document(opportunity_id=opp.id, path=f.rel, size=f.size, is_zip=f.is_zip,
                                 unpacked=f.unpacked, storage_key=key))
        else:
            row.size, row.is_zip, row.unpacked, row.storage_key = f.size, f.is_zip, f.unpacked, key
    removed = 0
    for path, row in existing.items():
        if path not in seen:
            if row.storage_key:
                stale_keys.append(row.storage_key)
            session.delete(row)
            removed += 1
    if use_storage and stale_keys:
        try:
            storage.delete(stale_keys)
        except StorageError as exc:
            log.warning("document cleanup failed", extra={"opp": opp.id, "error": str(exc)})

    docs = session.get(LeadDocs, opp.id) or LeadDocs(opportunity_id=opp.id, folder=str(folder))
    docs.folder = str(folder)
    docs.summary = _summary_json(session, opp, folder)
    session.add(docs)
    _mirror_triage(session, opp, docs.summary["manifest"])
    session.commit()
    return {"files": len(files), "uploaded": uploaded, "removed": removed}


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


def hydrate_lead(session: Session, opp: Opportunity, storage: Storage | None = None) -> int:
    """Restore a lead folder from the database and Storage when the local copy is missing
    pieces (a new volume). Returns the number of files downloaded."""
    docs = session.get(LeadDocs, opp.id)
    if docs is None:
        return 0
    folder = D.lead_folder(opp, create=True)
    assert folder is not None
    manifest = (docs.summary or {}).get("manifest") or {}
    if manifest and not (folder / D.MANIFEST).exists():
        D.save_manifest(folder, manifest)
    if storage is None or not storage.configured:
        return 0
    n = 0
    for d in session.execute(select(Document).where(Document.opportunity_id == opp.id)).scalars():
        target = folder / d.path
        if d.storage_key and not target.exists():
            try:
                storage.download(d.storage_key, target)
                n += 1
            except (StorageError, OSError) as exc:
                log.warning("document restore failed", extra={"opp": opp.id, "file": d.path, "error": str(exc)})
    return n
