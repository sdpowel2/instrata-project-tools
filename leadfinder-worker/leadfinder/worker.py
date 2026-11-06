"""The Lead Finder worker (Fly app instrata-leadfinder).

The Project Tools tab queues work in lf_job; this process:

  - claims queued jobs (FOR UPDATE SKIP LOCKED) and runs each in a thread pool: fetch runs,
    SAM attachment downloads, uploaded-file intake, rescans, triage, office saves, rescoring,
  - mirrors live progress into lf_job.progress every couple of seconds (the tab gets it over
    realtime) and the outcome into lf_job.result / error,
  - after any document or triage change, mirrors the lead folder to lf_document /
    lf_lead_docs / lf_triage_run and Storage (leadfinder.mirror),
  - queues the daily scheduled run (SCHEDULE_HOUR_ET, default 06:00 Eastern),
  - on boot, marks jobs a restart cut off and resumes triage sessions still running at Anthropic,
  - writes a heartbeat + capability flags to lf_setting 'worker_status' every minute,
  - serves /healthz and the BuildingConnected OAuth endpoints (see web())."""
from __future__ import annotations

import logging
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from leadfinder import documents as D
from leadfinder import kv
from leadfinder import triage as T
from leadfinder.db.models import Job, Opportunity, TriageRun, utcnow
from leadfinder.mirror import hydrate_lead, mirror_lead
from leadfinder.settings import DATA_DIR, get_settings, redact
from leadfinder.storage import Storage, StorageError

log = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")
POLL_SECONDS = 2.0
PROGRESS_SECONDS = 2.0
HEARTBEAT_SECONDS = 60.0
MAX_PARALLEL = 3
VERSION = "1"


class JobFailed(Exception):
    """A handled failure: the message is shown to the person in the tab."""


@dataclass
class Ctx:
    job_id: str
    kind: str
    opportunity_id: str | None
    params: dict[str, Any]
    session_factory: Callable[[], Session]
    storage_factory: Callable[[], Storage]
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
    if not sources or "sam_gov" in sources:
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
        with ctx.storage_factory() as storage:
            def done(opp: Opportunity, r: dict) -> None:
                counts["leads"] += 1
                counts["downloaded"] += r["downloaded"]
                counts["failed"] += r["failed"]
                if r["downloaded"] or r["failed"]:
                    mirror_lead(s, opp, storage)
            D.sync_pursued(s, progress=done)
    except Exception:  # never fail a run over documents
        log.exception("document sync after run failed")
    finally:
        s.close()
    return counts


def h_sam_docs(ctx: Ctx) -> dict:
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        if not D.sam_links(s, opp):
            raise JobFailed("This notice has no SAM.gov attachments.")
        job = D.claim(opp.id)
        if job is None:
            raise JobFailed("A download is already running for this lead.")
        try:
            with ctx.storage_factory() as storage:
                hydrate_lead(s, opp, storage)
                ctx.watch(lambda: {"total": job.total, "done": job.done, "failed": job.failed})
                with D.sam_client() as c:
                    r = D.fetch_sam(s, opp, c, force=bool(ctx.params.get("force")), job=job)
                mirror_lead(s, opp, storage)
        finally:
            D.release(opp.id)
        return r
    finally:
        s.close()


def h_ingest_upload(ctx: Ctx) -> dict:
    """Files the tab uploaded to Storage under <opp>/_inbox/: move them into the lead folder
    (unpacking zips), then delete the inbox copies."""
    files = [f for f in (ctx.params.get("files") or []) if isinstance(f, dict) and f.get("key")]
    if not files:
        raise JobFailed("No files to add.")
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        prefix = f"{opp.id}/_inbox/"
        if any(not str(f["key"]).startswith(prefix) for f in files):
            raise JobFailed("Upload paths don't belong to this lead.")
        with ctx.storage_factory() as storage:
            if not storage.configured:
                raise JobFailed("Storage isn't configured on the worker (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
            hydrate_lead(s, opp, storage)
            folder = D.lead_folder(opp, create=True)
            assert folder is not None
            added, notes, errors = 0, [], []
            state = {"done": 0, "total": len(files)}
            ctx.watch(lambda: dict(state))
            tmp_root = DATA_DIR / "tmp"
            tmp_root.mkdir(parents=True, exist_ok=True)
            for f in files:
                with tempfile.TemporaryDirectory(dir=tmp_root) as td:
                    local = Path(td) / "upload"
                    try:
                        storage.download(str(f["key"]), local)
                        with open(local, "rb") as fh:
                            rel, unpack = D.save_upload(folder, f.get("name") or Path(str(f["key"])).name, fh)
                        added += 1
                        if unpack is not None:
                            if unpack.get("status") == "ok":
                                notes.append(f"unpacked {rel} ({unpack['files']} files)")
                            else:
                                errors.append(f"Couldn't unpack {rel}: {unpack.get('error')}")
                    except (StorageError, OSError) as exc:
                        errors.append(f"{f.get('name') or f['key']}: {redact(str(exc))}")
                state["done"] += 1
            try:
                storage.delete([str(f["key"]) for f in files])
            except StorageError as exc:
                log.warning("inbox cleanup failed", extra={"opp": opp.id, "error": str(exc)})
            mirror_lead(s, opp, storage)
        message = (f"Added {added} file{'s' if added != 1 else ''}" + (f"; {'; '.join(notes)}" if notes else "")
                   + ".") if added else "No files added."
        if errors and not added:
            raise JobFailed(" ".join(errors))
        return {"message": message, "errors": errors}
    finally:
        s.close()


def h_rescan(ctx: Ctx) -> dict:
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        with ctx.storage_factory() as storage:
            hydrate_lead(s, opp, storage)
            folder = D.lead_folder(opp)
            done = D.unpack_pending(folder) if folder else []
            mirror_lead(s, opp, storage)
        ok = [rel for rel, r in done if r.get("status") == "ok"]
        return {"message": f"Unpacked {', '.join(ok)}." if ok else "Rescanned; nothing new to unpack."}
    finally:
        s.close()


def h_triage(ctx: Ctx) -> dict:
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
            with ctx.storage_factory() as storage:
                hydrate_lead(s, opp, storage)
                client = T.make_client()
                try:
                    run = T.start(s, opp, client, nda_ok=bool(ctx.params.get("nda_ok")), job=tjob)
                except T.TriageError as exc:
                    mirror_lead(s, opp, storage)
                    raise JobFailed(str(exc))
                mirror_lead(s, opp, storage)
                run = T.wait(opp, run, client, job=tjob)
                mirror_lead(s, opp, storage)
        finally:
            T.release(opp.id)
        if run.get("status") != "done":
            raise JobFailed(run.get("error") or "Triage ended without a report.")
        return {k: run.get(k) for k in ("id", "rating", "tier", "estimate", "cost_usd")}
    finally:
        s.close()


def h_triage_resume(ctx: Ctx) -> dict:
    """Pick up the latest unfinished triage (after a restart); never re-collects a finished run."""
    s = ctx.session_factory()
    try:
        opp = _opp(s, ctx)
        with ctx.storage_factory() as storage:
            hydrate_lead(s, opp, storage)
            folder = D.lead_folder(opp)
            latest = T.runs(folder)[:1]
            if not latest or latest[0].get("status") not in ("running", "uploading"):
                mirror_lead(s, opp, storage)
                return {"message": "Nothing to resume."}
            run = latest[0]
            if run.get("status") == "uploading" or not run.get("session_id"):
                T._record(folder, run["id"], status="failed", finished_at=T._now(),
                          error="The worker stopped while uploading the documents; run triage again.")
                mirror_lead(s, opp, storage)
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
            mirror_lead(s, opp, storage)
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


def execute(job: Job, session_factory: Callable[[], Session], storage_factory: Callable[[], Storage],
            active: dict[str, Ctx] | None = None) -> None:
    """Run one claimed job to completion and record the outcome."""
    ctx = Ctx(job.id, job.kind, job.opportunity_id, dict(job.params or {}), session_factory, storage_factory)
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
        opp_ids = {r.opportunity_id for r in s.execute(
            select(TriageRun).where(TriageRun.status.in_(("running", "uploading")))).scalars()}
        for oid in sorted(opp_ids):
            if enqueue(s, "triage_resume", opportunity_id=oid):
                queued.append(oid)
        return queued
    finally:
        s.close()


def enqueue(s: Session, kind: str, opportunity_id: str | None = None, params: dict | None = None) -> bool:
    """Queue a job from the worker itself. False if an equivalent one is already live."""
    try:
        s.add(Job(kind=kind, opportunity_id=opportunity_id, params=params or {}))
        s.commit()
        return True
    except IntegrityError:
        s.rollback()
        return False


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
    def __init__(self, session_factory: Callable[[], Session] | None = None,
                 storage_factory: Callable[[], Storage] = Storage):
        if session_factory is None:
            from leadfinder.db.session import SessionLocal
            session_factory = SessionLocal
        self.session_factory = session_factory
        self.storage_factory = storage_factory
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
                        self.active[job.id] = Ctx(job.id, job.kind, job.opportunity_id, {}, self.session_factory,
                                                  self.storage_factory)  # reserve the slot
                        self.pool.submit(execute, job, self.session_factory, self.storage_factory, self.active)
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
    return {
        "heartbeat_at": utcnow().isoformat(),
        "version": VERSION,
        "public_url": st.public_url,
        "sam_key": bool(st.sam_api_key),
        "aps_configured": aps_configured,
        "aps_callback": st.aps_callback_url,
        "triage_configured": T.configured(),
        "triage_budget_usd": st.triage_budget_usd,
        "storage_configured": Storage().configured,
        "scorer_version": scoring_config().get("scorer_version"),
        "schedule_hour_et": st.schedule_hour_et,
    }


# ---------------------------------------------------------------- HTTP

def web(worker: Worker | None = None):
    """FastAPI app: health check plus the BuildingConnected OAuth round trip.

    POST /bc/authorize   the tab sends the signed-in admin's Supabase access token; returns the
                         Autodesk sign-in URL (the user's password goes to Autodesk only).
    GET  /oauth/callback Autodesk redirects here; tokens are stored in lf_secret and the
                         browser is sent back to the Lead Finder Settings tab."""
    from contextlib import asynccontextmanager
    from urllib.parse import quote

    import httpx
    from fastapi import FastAPI, Header
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, RedirectResponse, Response

    st = get_settings()

    @asynccontextmanager
    async def lifespan(_app):
        if worker is not None:
            worker.start()
        yield
        if worker is not None:
            worker.stop()

    app = FastAPI(title="Lead Finder worker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    origins = [o for o in {st.app_url.rstrip("/"), "http://localhost:5173"} if o]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["POST"],
                       allow_headers=["Authorization", "Content-Type"])

    def back(msg: str | None = None, err: str | None = None) -> RedirectResponse:
        q = f"msg={quote(msg)}" if msg else f"err={quote(err or '')}"
        return RedirectResponse(f"{st.app_url.rstrip('/')}/lead-finder?tab=settings&{q}", status_code=303)

    @app.get("/healthz")
    def healthz() -> Response:
        return Response("ok")

    @app.post("/bc/authorize")
    def bc_authorize(authorization: str = Header("")):
        from leadfinder.aps_auth import ApsAuth, new_state
        from leadfinder.http import Client

        token = authorization.removeprefix("Bearer ").strip()
        if not token or not is_admin_token(token, httpx):
            return JSONResponse({"error": "Admins only."}, status_code=403)
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


def is_admin_token(token: str, httpx_mod=None) -> bool:
    """Check a Supabase access token with the Auth server, then the user's role in profiles."""
    import httpx as _httpx

    from sqlalchemy import text

    httpx_mod = httpx_mod or _httpx
    st = get_settings()
    if not (st.supabase_url and st.supabase_service_role_key):
        return False
    try:
        resp = httpx_mod.get(f"{st.supabase_url.rstrip('/')}/auth/v1/user", timeout=10.0,
                             headers={"Authorization": f"Bearer {token}", "apikey": st.supabase_service_role_key})
    except httpx_mod.HTTPError:
        return False
    if resp.status_code != 200:
        return False
    uid = (resp.json() or {}).get("id")
    if not uid:
        return False
    from leadfinder.db.session import SessionLocal
    s = SessionLocal()
    try:
        role = s.execute(text("select role from public.profiles where id = cast(:id as uuid)"), {"id": uid}).scalar()
        return role == "admin"
    finally:
        s.close()


def serve(host: str = "0.0.0.0", port: int = 8080) -> None:
    import uvicorn

    from leadfinder.db.migrate import upgrade

    upgrade()  # on Postgres: only checks the schema exists
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(web(Worker()), host=host, port=port, log_config=None)
