"""The Lead Finder worker (Fly app instrata-leadfinder).

The Project Tools tab queues work in lf_job; this process:

  - claims queued jobs (FOR UPDATE SKIP LOCKED) and runs each in a thread pool: fetch runs,
    SAM attachment downloads, uploaded-file intake, rescans, triage, office saves, rescoring,
  - mirrors live progress into lf_job.progress every couple of seconds (the tab gets it over
    realtime) and the outcome into lf_job.result / error,
  - after any document or triage change, mirrors the lead folder to lf_document /
    lf_lead_docs / lf_triage_run (leadfinder.mirror),
  - queues the daily scheduled run (SCHEDULE_HOUR_ET, default 06:00 Eastern),
  - on boot, marks jobs a restart cut off and resumes triage sessions still running at Anthropic,
  - writes a heartbeat + capability flags to lf_setting 'worker_status' every minute,
  - serves the HTTP endpoints in web(): health check, document upload and download (the bid
    documents live only on this worker's volume), and the BuildingConnected OAuth round trip."""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from fastapi import File, Header, UploadFile
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from leadfinder import documents as D
from leadfinder import kv
from leadfinder import triage as T
from leadfinder.db.models import Job, Opportunity, TriageRun, utcnow
from leadfinder.mirror import mirror_lead
from leadfinder.settings import DATA_DIR, get_settings, redact

log = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")
POLL_SECONDS = 2.0
PROGRESS_SECONDS = 2.0
HEARTBEAT_SECONDS = 60.0
MAX_PARALLEL = 3
VERSION = "2"
INBOX_DIR = DATA_DIR / "inbox"          # uploads land here, then an ingest_upload job files them
LINK_SECONDS = 300                      # signed download links


class JobFailed(Exception):
    """A handled failure: the message is shown to the person in the tab."""


DOCUMENTS_OFF = ("Bid documents and triage are switched off on this worker (no persistent disk yet). "
                 "They come back when the worker moves to a host with storage.")


def documents_enabled() -> bool:
    return get_settings().documents_enabled


def _require_documents() -> None:
    if not documents_enabled():
        raise JobFailed(DOCUMENTS_OFF)


@dataclass
class Ctx:
    job_id: str
    kind: str
    opportunity_id: str | None
    params: dict[str, Any]
    session_factory: Callable[[], Session]
    watch_fn: Callable[[], dict] | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def watch(self, fn: Callable[[], dict]) -> None:
        """Register a callable whose result is copied to lf_job.progress while the job runs."""
        self.watch_fn = fn


# ---------------------------------------------------------------- handlers

def _opp(s: Session, ctx: Ctx) -> Opportunity:
    opp = s.get(Opportunity, ctx.opportunity_id) if ctx.opportunity_id else None
    if opp is None:
        raise JobFailed("Lead not found.")
    return opp


def _date(v: Any) -> date | None:
    return date.fromisoformat(str(v)) if v else None


def h_run(ctx: Ctx) -> dict:
    from leadfinder.pipeline import run as pipeline

    p = ctx.params
    sources = [str(x) for x in (p.get("sources") or [])] or None
    ctx.watch(lambda: {"run_id": pipeline.PROGRESS.run_id,
                       "sources": {k: dict(v) for k, v in pipeline.PROGRESS.sources.items()}})
    try:
        r = pipeline.run(sources=sources, since=_date(p.get("since")), until=_date(p.get("until")),
                         trigger=p.get("trigger") if p.get("trigger") in ("manual", "scheduled") else "manual",
                         session_factory=ctx.session_factory)
    except pipeline.RunInProgress:
        raise JobFailed("A run is already in progress.")
    except ValueError as exc:
        raise JobFailed(str(exc))
    result = {"run_id": r.id, "status": r.status,
              "sources": {sr.source_id: {"status": sr.status, "fetched": sr.records_fetched, "new": sr.records_new,
                                         "updated": sr.records_updated, "calls": sr.api_calls_used,
                                         "error": sr.error} for sr in r.source_runs}}
    if documents_enabled() and (not sources or "sam_gov" in sources):
        result["documents"] = _sync_pursued(ctx)
    if r.status == "failed":
        errs = "; ".join(f"{k}: {v['error']}" for k, v in result["sources"].items() if v.get("error"))
        raise JobFailed(f"Run failed. {errs}".strip())
    return result


def _sync_pursued(ctx: Ctx) -> dict:
    """After a run: fetch attachments that amendments added to Pursue SAM leads."""
    s = ctx.session_factory()
    counts = {"leads": 0, "downloaded": 0, "failed": 0}
    try:
        def done(opp: Opportunity, r: dict) -> None:
            counts["leads"] += 1
            counts["downloaded"] += r["downloaded"]
            counts["failed"] += r["failed"]
            if r["downloaded"] or r["failed"]:
                mirror_lead(s, opp)
        D.sync_pursued(s, progress=done)
    except Exception:  # never fail a run over documents
        log.exception("document sync after run failed")
    finally:
        s.close()
    return counts


def h_sam_docs(ctx: Ctx) -> dict:
    if not documents_enabled():
        # Queued automatically when a SAM lead is marked Pursue; nothing to do without a disk.
        return {"skipped": True, "message": DOCUMENTS_OFF}
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        if not D.sam_links(s, opp):
            raise JobFailed("This notice has no SAM.gov attachments.")
        job = D.claim(opp.id)
        if job is None:
            raise JobFailed("A download is already running for this lead.")
        try:
            ctx.watch(lambda: {"total": job.total, "done": job.done, "failed": job.failed})
            with D.sam_client() as c:
                r = D.fetch_sam(s, opp, c, force=bool(ctx.params.get("force")), job=job)
            mirror_lead(s, opp)
        finally:
            D.release(opp.id)
        return r
    finally:
        s.close()


def h_ingest_upload(ctx: Ctx) -> dict:
    """Files the tab uploaded to this worker (saved under INBOX_DIR/<lead>/): move them into
    the lead folder, unpacking zips, then remove the inbox copies."""
    _require_documents()
    files = [f for f in (ctx.params.get("files") or []) if isinstance(f, dict) and f.get("local")]
    if not files:
        raise JobFailed("No files to add.")
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        lead_inbox = (INBOX_DIR / opp.id).resolve()
        paths = [(INBOX_DIR / str(f["local"])).resolve() for f in files]
        if any(not p.is_relative_to(lead_inbox) for p in paths):
            raise JobFailed("Upload paths don't belong to this lead.")
        folder = D.lead_folder(opp, create=True)
        assert folder is not None
        added, notes, errors = 0, [], []
        state = {"done": 0, "total": len(files)}
        ctx.watch(lambda: dict(state))
        for f, path in zip(files, paths):
            try:
                with open(path, "rb") as fh:
                    rel, unpack = D.save_upload(folder, f.get("name") or path.name, fh)
                added += 1
                if unpack is not None:
                    if unpack.get("status") == "ok":
                        notes.append(f"unpacked {rel} ({unpack['files']} files)")
                    else:
                        errors.append(f"Couldn't unpack {rel}: {unpack.get('error')}")
            except OSError as exc:
                errors.append(f"{f.get('name') or path.name}: {redact(str(exc))}")
            finally:
                path.unlink(missing_ok=True)
            state["done"] += 1
        for p in {p.parent for p in paths}:
            shutil.rmtree(p, ignore_errors=True)
        mirror_lead(s, opp)
        message = (f"Added {added} file{'s' if added != 1 else ''}" + (f"; {'; '.join(notes)}" if notes else "")
                   + ".") if added else "No files added."
        if errors and not added:
            raise JobFailed(" ".join(errors))
        return {"message": message, "errors": errors}
    finally:
        s.close()


def h_rescan(ctx: Ctx) -> dict:
    _require_documents()
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        folder = D.lead_folder(opp)
        done = D.unpack_pending(folder) if folder else []
        mirror_lead(s, opp)
        ok = [rel for rel, r in done if r.get("status") == "ok"]
        return {"message": f"Unpacked {', '.join(ok)}." if ok else "Rescanned; nothing new to unpack."}
    finally:
        s.close()


def h_triage(ctx: Ctx) -> dict:
    _require_documents()
    if not T.configured():
        raise JobFailed("Triage isn't set up on the worker: ANTHROPIC_API_KEY and the av-triage skill are needed.")
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        tjob = T.claim(opp.id)
        if tjob is None:
            raise JobFailed("A triage is already running for this lead.")
        try:
            ctx.watch(lambda: {"stage": tjob.stage, "session_id": tjob.session_id})
            client = T.make_client()
            try:
                run = T.start(s, opp, client, nda_ok=bool(ctx.params.get("nda_ok")), job=tjob)
            except T.TriageError as exc:
                mirror_lead(s, opp)
                raise JobFailed(str(exc))
            mirror_lead(s, opp)
            run = T.wait(opp, run, client, job=tjob)
            mirror_lead(s, opp)
        finally:
            T.release(opp.id)
        if run.get("status") != "done":
            raise JobFailed(run.get("error") or "Triage ended without a report.")
        return {k: run.get(k) for k in ("id", "rating", "tier", "estimate", "cost_usd")}
    finally:
        s.close()


def h_triage_resume(ctx: Ctx) -> dict:
    """Pick up the latest unfinished triage (after a restart); never re-collects a finished run."""
    _require_documents()
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        folder = D.lead_folder(opp)
        latest = T.runs(folder)[:1]
        if not latest or latest[0].get("status") not in ("running", "uploading"):
            mirror_lead(s, opp)
            return {"message": "Nothing to resume."}
        run = latest[0]
        if run.get("status") == "uploading" or not run.get("session_id"):
            T._record(folder, run["id"], status="failed", finished_at=T._now(),
                      error="The worker stopped while uploading the documents; run triage again.")
            mirror_lead(s, opp)
            return {"message": "The interrupted upload was marked failed."}
        tjob = T.claim(opp.id)
        if tjob is None:
            raise JobFailed("A triage is already running for this lead.")
        try:
            tjob.session_id = run["session_id"]
            ctx.watch(lambda: {"stage": tjob.stage, "session_id": tjob.session_id})
            run = T.wait(opp, run, T.make_client(), job=tjob)
        finally:
            T.release(opp.id)
        mirror_lead(s, opp)
        return {k: run.get(k) for k in ("id", "status", "rating", "tier", "estimate", "cost_usd")}
    finally:
        s.close()


def _float(v: Any) -> float | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        raise JobFailed(f"{v!r} isn't a number.")


def h_office_save(ctx: Ctx) -> dict:
    from leadfinder.offices import OfficeError, OfficeInput, save_office

    p = ctx.params
    s = ctx.session_factory()
    try:
        try:
            inp = OfficeInput(str(p.get("name") or ""), str(p.get("street") or ""), str(p.get("city") or ""),
                              str(p.get("state") or ""), str(p.get("zip") or ""), p.get("radius_miles") or 100,
                              _float(p.get("manual_lat")), _float(p.get("manual_lon")))
            office, recomputed = save_office(s, inp, p.get("office_id") or None)
        except OfficeError as exc:
            s.rollback()
            raise JobFailed(str(exc))
        s.commit()
        note = f"Saved {office.name}. Geocode: {office.geocode_method or 'none'} — {office.geocode_match or ''}."
        if recomputed:
            note += " Distances recomputed."
        return {"message": note, "office_id": office.id}
    finally:
        s.close()


def h_office_active(ctx: Ctx) -> dict:
    from leadfinder.offices import OfficeError, set_active

    s = ctx.session_factory()
    try:
        try:
            o = set_active(s, str(ctx.params.get("office_id") or ""), bool(ctx.params.get("active")))
        except OfficeError as exc:
            raise JobFailed(str(exc))
        s.commit()
        return {"message": f"{o.name} {'reactivated' if o.active else 'deactivated'}; distances recomputed."}
    finally:
        s.close()


def h_rescore(ctx: Ctx) -> dict:
    from leadfinder.pipeline.run import rescore_all

    return {"message": f"Rescored {rescore_all(session_factory=ctx.session_factory)} opportunities."}


def h_bc_disconnect(ctx: Ctx) -> dict:
    from leadfinder.aps_auth import ApsAuth
    from leadfinder.http import Client

    with Client() as c:
        ApsAuth(c).disconnect()
    return {"message": "BuildingConnected disconnected; stored tokens deleted."}


HANDLERS: dict[str, Callable[[Ctx], dict]] = {
    "run": h_run, "sam_docs": h_sam_docs, "ingest_upload": h_ingest_upload, "rescan": h_rescan,
    "triage": h_triage, "triage_resume": h_triage_resume, "office_save": h_office_save,
    "office_active": h_office_active, "rescore": h_rescore, "bc_disconnect": h_bc_disconnect,
}


# ---------------------------------------------------------------- queue

def claim_next(session_factory: Callable[[], Session]) -> Job | None:
    s = session_factory()
    try:
        job = s.execute(select(Job).where(Job.status == "queued").order_by(Job.created_at).limit(1)
                        .with_for_update(skip_locked=True)).scalar_one_or_none()
        if job is None:
            s.rollback()
            return None
        job.status, job.started_at = "running", utcnow()
        s.commit()
        return job
    finally:
        s.close()


def _finish(session_factory: Callable[[], Session], job_id: str, **fields: Any) -> None:
    s = session_factory()
    try:
        s.execute(update(Job).where(Job.id == job_id).values(finished_at=utcnow(), updated_at=utcnow(), **fields))
        s.commit()
    finally:
        s.close()


def execute(job: Job, session_factory: Callable[[], Session], active: dict[str, Ctx] | None = None) -> None:
    """Run one claimed job to completion and record the outcome."""
    ctx = Ctx(job.id, job.kind, job.opportunity_id, dict(job.params or {}), session_factory)
    if active is not None:
        active[job.id] = ctx
    try:
        handler = HANDLERS.get(job.kind)
        if handler is None:
            raise JobFailed(f"Unknown job kind {job.kind!r}.")
        result = handler(ctx)
        _finish(session_factory, job.id, status="done", result=result, progress=_safe_progress(ctx))
    except JobFailed as exc:
        _finish(session_factory, job.id, status="failed", error=str(exc)[:2000], progress=_safe_progress(ctx))
    except Exception as exc:  # noqa: BLE001 - recorded on the job
        log.exception("job failed", extra={"job": job.id, "kind": job.kind})
        _finish(session_factory, job.id, status="failed",
                error=redact(f"Unexpected error: {exc.__class__.__name__}: {exc}")[:2000])
    finally:
        if active is not None:
            active.pop(job.id, None)


def _safe_progress(ctx: Ctx) -> dict:
    if ctx.watch_fn is None:
        return {}
    try:
        return ctx.watch_fn()
    except Exception:  # noqa: BLE001
        return {}


def recover(session_factory: Callable[[], Session]) -> list[str]:
    """At boot: jobs left 'running' by a previous process are failed; triage still running at
    Anthropic (lf_triage_run running/uploading) gets a triage_resume job."""
    s = session_factory()
    queued: list[str] = []
    try:
        s.execute(update(Job).where(Job.status == "running")
                  .values(status="failed", finished_at=utcnow(), error="The worker restarted while this was running."))
        s.commit()
        if not documents_enabled():
            return queued
        opp_ids = {r.opportunity_id for r in s.execute(
            select(TriageRun).where(TriageRun.status.in_(("running", "uploading")))).scalars()}
        for oid in sorted(opp_ids):
            if enqueue(s, "triage_resume", opportunity_id=oid):
                queued.append(oid)
        return queued
    finally:
        s.close()


def enqueue(s: Session, kind: str, opportunity_id: str | None = None, params: dict | None = None) -> str | None:
    """Queue a job from the worker itself. Returns its id, or None if an equivalent one is live."""
    try:
        job = Job(kind=kind, opportunity_id=opportunity_id, params=params or {})
        s.add(job)
        s.commit()
        return job.id
    except IntegrityError:
        s.rollback()
        return None


def scheduled_due(s: Session, now: datetime, hour_et: int) -> bool:
    """True once today's scheduled run time (Eastern) has passed and no scheduled run job was
    queued since then."""
    if hour_et < 0:
        return False
    local = now.astimezone(ET)
    slot = local.replace(hour=hour_et, minute=0, second=0, microsecond=0)
    if local < slot:
        return False
    since = slot.astimezone(timezone.utc)
    for job in s.execute(select(Job).where(Job.kind == "run", Job.created_at >= since)).scalars():
        if (job.params or {}).get("trigger") == "scheduled":
            return False
    return True


class Worker:
    def __init__(self, session_factory: Callable[[], Session] | None = None):
        if session_factory is None:
            from leadfinder.db.session import SessionLocal
            session_factory = SessionLocal
        self.session_factory = session_factory
        self.pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL, thread_name_prefix="job")
        self.active: dict[str, Ctx] = {}
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        resumed = recover(self.session_factory)
        if resumed:
            log.info("queued triage resumes", extra={"leads": resumed})
        for target, name in ((self._loop, "job-loop"), (self._progress_loop, "job-progress"),
                             (self._clock_loop, "clock")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self.threads.append(t)

    def stop(self) -> None:
        self.stop_event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                if len(self.active) < MAX_PARALLEL:
                    job = claim_next(self.session_factory)
                    if job is not None:
                        # reserve the slot until execute() registers the real context
                        self.active[job.id] = Ctx(job.id, job.kind, job.opportunity_id, {}, self.session_factory)
                        self.pool.submit(execute, job, self.session_factory, self.active)
                        continue
            except Exception:  # noqa: BLE001 - database blip; try again shortly
                log.exception("job claim failed")
            self.stop_event.wait(POLL_SECONDS)

    def _progress_loop(self) -> None:
        last: dict[str, dict] = {}
        while not self.stop_event.wait(PROGRESS_SECONDS):
            for job_id, ctx in list(self.active.items()):
                prog = _safe_progress(ctx)
                if not prog or last.get(job_id) == prog:
                    continue
                last[job_id] = prog
                try:
                    s = self.session_factory()
                    try:
                        s.execute(update(Job).where(Job.id == job_id, Job.status == "running")
                                  .values(progress=prog, updated_at=utcnow()))
                        s.commit()
                    finally:
                        s.close()
                except Exception:  # noqa: BLE001
                    log.exception("progress update failed")
            for gone in set(last) - set(self.active):
                last.pop(gone, None)

    def _clock_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.heartbeat()
                s = self.session_factory()
                try:
                    if scheduled_due(s, utcnow(), get_settings().schedule_hour_et):
                        enqueue(s, "run", params={"trigger": "scheduled"})
                finally:
                    s.close()
            except Exception:  # noqa: BLE001
                log.exception("clock tick failed")
            self.stop_event.wait(HEARTBEAT_SECONDS)

    def heartbeat(self) -> None:
        kv.set_setting("worker_status", worker_status(), session_factory=self.session_factory)


def worker_status() -> dict:
    """Capability flags for the tab's Settings page. Booleans only; never secret values."""
    from leadfinder.aps_auth import ApsAuth
    from leadfinder.config import scoring_config
    from leadfinder.http import Client

    st = get_settings()
    with Client() as c:
        aps = ApsAuth(c)
        aps_configured = aps.configured
    try:
        usage = shutil.disk_usage(DATA_DIR)
        disk = {"free_bytes": usage.free, "total_bytes": usage.total}
    except OSError:
        disk = None
    return {
        "heartbeat_at": utcnow().isoformat(),
        "version": VERSION,
        "public_url": st.public_url,
        "sam_key": bool(st.sam_api_key),
        "aps_configured": aps_configured,
        "aps_callback": st.aps_callback_url,
        "documents_enabled": documents_enabled(),
        "triage_configured": documents_enabled() and T.configured(),
        "triage_budget_usd": st.triage_budget_usd,
        "auth_configured": bool(st.supabase_url and st.supabase_anon_key),
        "disk": disk,
        "scorer_version": scoring_config().get("scorer_version"),
        "schedule_hour_et": st.schedule_hour_et,
    }


# ---------------------------------------------------------------- signed download links

_signing_key: bytes | None = None


def _key() -> bytes:
    global _signing_key
    if _signing_key is None:
        configured = get_settings().download_signing_key
        # Without a configured key, links are signed per process (a restart expires them).
        _signing_key = configured.encode() if configured else secrets.token_bytes(32)
    return _signing_key


def sign_link(opportunity_id: str, rel: str, expires: int) -> str:
    msg = f"{opportunity_id}\n{rel}\n{expires}".encode("utf-8")
    return hmac.new(_key(), msg, hashlib.sha256).hexdigest()


def verify_link(opportunity_id: str, rel: str, expires: int, sig: str, now: float | None = None) -> bool:
    if expires < (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(sign_link(opportunity_id, rel, expires), sig or "")


def document_path(opp: Opportunity, rel: str) -> Path | None:
    """The file at rel inside the lead's folder, or None (missing, or outside the folder)."""
    folder = D.lead_folder(opp)
    if folder is None or not rel:
        return None
    root = folder.resolve()
    p = (folder / rel).resolve()
    if not p.is_relative_to(root) or not p.is_file() or p.name.startswith(D.MANIFEST):
        return None
    return p


# ---------------------------------------------------------------- HTTP

def web(worker: Worker | None = None, session_factory: Callable[[], Session] | None = None):
    """FastAPI app.

    GET  /healthz
    POST /documents/{lead}/upload   multipart files (admin token); saved to the inbox and an
                                    ingest_upload job queued. Returns {job_id}.
    POST /documents/{lead}/link     {"path": rel, "inline": bool} (admin token); returns a signed
                                    URL valid for 5 minutes.
    GET  /documents/{lead}/file     ?path&exp&sig[&inline=1]: the file itself (signed URL only).
    POST /bc/authorize              admin token; returns the Autodesk sign-in URL (the user's
                                    password goes to Autodesk only).
    GET  /oauth/callback            Autodesk redirects here; tokens go to lf_secret and the browser
                                    returns to the Lead Finder Settings tab.

    "Admin token" = the signed-in Project Tools user's Supabase access token, checked with the
    Supabase Auth server, and profiles.role = 'admin'."""
    from contextlib import asynccontextmanager
    from urllib.parse import quote, urlencode

    from fastapi import Body, FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

    st = get_settings()
    if session_factory is None:
        from leadfinder.db.session import SessionLocal
        session_factory = SessionLocal

    @asynccontextmanager
    async def lifespan(_app):
        if worker is not None:
            worker.start()
        yield
        if worker is not None:
            worker.stop()

    app = FastAPI(title="Lead Finder worker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    origins = [o for o in {st.app_url.rstrip("/"), "http://localhost:5173", "http://localhost:5174"} if o]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"])

    def back(msg: str | None = None, err: str | None = None) -> RedirectResponse:
        q = f"msg={quote(msg)}" if msg else f"err={quote(err or '')}"
        return RedirectResponse(f"{st.app_url.rstrip('/')}/lead-finder?tab=settings&{q}", status_code=303)

    def admin(authorization: str) -> str | None:
        token = authorization.removeprefix("Bearer ").strip()
        return admin_user(token) if token else None

    def forbidden() -> JSONResponse:
        return JSONResponse({"error": "Admins only. Sign in to Project Tools again if this persists."},
                            status_code=403)

    @app.get("/healthz")
    def healthz() -> Response:
        return Response("ok")

    def documents_off() -> JSONResponse:
        return JSONResponse({"error": DOCUMENTS_OFF}, status_code=409)

    @app.post("/documents/{lead_id}/upload")
    def upload(lead_id: str, files: list[UploadFile] = File(...), authorization: str = Header("")):
        if admin(authorization) is None:
            return forbidden()
        if not documents_enabled():
            return documents_off()
        s = session_factory()
        try:
            if s.get(Opportunity, lead_id) is None:
                return JSONResponse({"error": "Lead not found."}, status_code=404)
            batch = INBOX_DIR / lead_id / uuid.uuid4().hex
            batch.mkdir(parents=True, exist_ok=True)
            entries = []
            for i, up in enumerate(files):
                if not up.filename:
                    continue
                target = batch / f"{i}-{D.safe_name(up.filename, fallback='upload')}"
                with open(target, "wb") as out:
                    shutil.copyfileobj(up.file, out, 1 << 20)
                entries.append({"local": target.relative_to(INBOX_DIR).as_posix(), "name": up.filename})
            if not entries:
                shutil.rmtree(batch, ignore_errors=True)
                return JSONResponse({"error": "No files received."}, status_code=400)
            job_id = enqueue(s, "ingest_upload", opportunity_id=lead_id, params={"files": entries})
            return {"job_id": job_id, "files": len(entries)}
        finally:
            s.close()

    @app.post("/documents/{lead_id}/link")
    def link(lead_id: str, body: dict = Body(...), authorization: str = Header("")):
        if admin(authorization) is None:
            return forbidden()
        if not documents_enabled():
            return documents_off()
        rel = str(body.get("path") or "")
        s = session_factory()
        try:
            opp = s.get(Opportunity, lead_id)
            if opp is None or document_path(opp, rel) is None:
                return JSONResponse({"error": "That file isn't on the worker."}, status_code=404)
        finally:
            s.close()
        exp = int(time.time()) + LINK_SECONDS
        q = {"path": rel, "exp": exp, "sig": sign_link(lead_id, rel, exp)}
        if body.get("inline"):
            q["inline"] = 1
        return {"url": f"{st.public_url.rstrip('/')}/documents/{lead_id}/file?{urlencode(q)}"}

    @app.get("/documents/{lead_id}/file")
    def file(lead_id: str, path: str = "", exp: int = 0, sig: str = "", inline: int = 0):
        if not documents_enabled():
            return Response(DOCUMENTS_OFF, status_code=409)
        if not verify_link(lead_id, path, exp, sig):
            return Response("This link has expired. Open the file again from Project Tools.", status_code=403)
        s = session_factory()
        try:
            opp = s.get(Opportunity, lead_id)
            p = document_path(opp, path) if opp else None
        finally:
            s.close()
        if p is None:
            return Response("File not found.", status_code=404)
        return FileResponse(p, filename=p.name, content_disposition_type="inline" if inline else "attachment")

    @app.post("/bc/authorize")
    def bc_authorize(authorization: str = Header("")):
        from leadfinder.aps_auth import ApsAuth, new_state
        from leadfinder.http import Client

        if admin(authorization) is None:
            return forbidden()
        with Client() as c:
            auth = ApsAuth(c)
            if not auth.configured:
                return JSONResponse({"error": "APS_CLIENT_ID and APS_CLIENT_SECRET aren't set on the worker."},
                                    status_code=400)
            return {"url": auth.authorize_url(new_state())}

    @app.get("/oauth/callback")
    def oauth_callback(code: str | None = None, state: str | None = None, error: str | None = None,
                       error_description: str | None = None):
        from leadfinder.adapters.buildingconnected import BuildingConnectedAdapter
        from leadfinder.aps_auth import ApsAuth, consume_state
        from leadfinder.http import Client, HttpError

        if error:
            return back(err=f"Autodesk sign-in was not completed: {error_description or error}")
        if not consume_state(state):
            return back(err="That sign-in link expired or didn't start from Project Tools. Click Connect again.")
        if not code:
            return back(err="Autodesk didn't return an authorization code. Click Connect again.")
        with Client() as c:
            auth = ApsAuth(c)
            try:
                auth.exchange_code(code)
            except HttpError as exc:
                return back(err=f"Couldn't complete the connection (token exchange failed: HTTP {exc.status}). "
                                "Check the client ID/secret and that the callback URL matches the APS app.")
            bc = BuildingConnectedAdapter(c, auth)
            who = ""
            try:
                me = bc.users_me()
                name = " ".join(x for x in (me.get("firstName"), me.get("lastName")) if x)
                who = f"{name} <{me['email']}>" if me.get("email") else name
            except Exception:  # noqa: BLE001 - display nicety only
                pass
            try:
                access = bc.probe()
            except Exception:  # noqa: BLE001
                access = None
            auth.update_profile(connected_as=who, bid_board_access=access)
        if access is False:
            return back(err=f"Connected{' as ' + who if who else ''}, but BuildingConnected refused access to "
                            "Bid Board opportunities (403). That account's office needs Bid Board Pro.")
        return back(msg=f"BuildingConnected connected{' as ' + who if who else ''}. "
                        "Run a fetch on the Run tab to pull the Bid Board.")

    return app


def admin_user(token: str) -> str | None:
    """The user id behind a Supabase access token if that user is a Project Tools admin."""
    import httpx

    from sqlalchemy import text

    st = get_settings()
    if not (st.supabase_url and st.supabase_anon_key):
        return None
    try:
        resp = httpx.get(f"{st.supabase_url.rstrip('/')}/auth/v1/user", timeout=10.0,
                         headers={"Authorization": f"Bearer {token}", "apikey": st.supabase_anon_key})
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    uid = (resp.json() or {}).get("id")
    if not uid:
        return None
    from leadfinder.db.session import SessionLocal
    s = SessionLocal()
    try:
        role = s.execute(text("select role from public.profiles where id = cast(:id as uuid)"), {"id": uid}).scalar()
        return uid if role == "admin" else None
    finally:
        s.close()


def serve(host: str = "0.0.0.0", port: int = 8080) -> None:
    import uvicorn

    from leadfinder.db.migrate import upgrade

    upgrade()  # on Postgres: only checks the schema exists
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(web(Worker()), host=host, port=port, log_config=None)
