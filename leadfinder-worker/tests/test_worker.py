"""The Project Tools worker: job queue, handlers, mirroring to the document tables + Storage,
database-backed token/agent state. SQLite + fakes only (no Supabase, no network)."""
import io
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import respx
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from leadfinder import documents as D
from leadfinder import kv
from leadfinder import triage as T
from leadfinder import worker as W
from leadfinder.aps_auth import TokenSet, TokenStore, public_status
from leadfinder.db.models import Document, Job, LeadDocs, Office, TriageRun
from leadfinder.mirror import hydrate_lead, mirror_lead
from leadfinder.storage import object_key
from tests.test_documents import L1, L2, av_lead, docs_root, sam_redirect  # noqa: F401  (fixtures)
from tests.test_triage import FakeClient, triage_env  # noqa: F401  (fixtures)


class FakeStorage:
    """In-memory stand-in for leadfinder.storage.Storage."""

    def __init__(self, objects=None, configured=True):
        self.objects: dict[str, bytes] = objects if objects is not None else {}
        self.configured = configured
        self.uploads: list[str] = []
        self.deleted: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None

    def close(self):
        pass

    def upload(self, key, path, content_type="application/octet-stream"):
        self.objects[key] = Path(path).read_bytes()
        self.uploads.append(key)

    def download(self, key, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.objects[key])

    def delete(self, keys):
        for k in keys:
            self.objects.pop(k, None)
            self.deleted.append(k)


def zip_bytes(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, d in members.items():
            zf.writestr(n, d)
    return buf.getvalue()


def run_job(factory, storage, kind, opp_id=None, **params):
    s = factory()
    s.add(Job(kind=kind, opportunity_id=opp_id, params=params))
    s.commit()
    s.close()
    job = W.claim_next(factory)
    assert job is not None and job.status == "running"
    W.execute(job, factory, lambda: storage)
    s = factory()
    try:
        return s.get(Job, job.id)
    finally:
        s.close()


# ---------------------------------------------------------------- key/value + tokens

def test_kv_and_db_token_store(engine):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    assert kv.get_secret("x", "dflt", session_factory=factory) == "dflt"
    kv.set_secret("x", {"a": 1}, session_factory=factory)
    assert kv.get_secret("x", session_factory=factory) == {"a": 1}
    kv.set_secret("x", None, session_factory=factory)
    assert kv.get_secret("x", session_factory=factory) is None

    store = TokenStore(session_factory=factory)
    ts = TokenSet(access_token="acc-0123456789", refresh_token="ref-0123456789", expires_at="2026-11-03T00:00:00+00:00",
                  scope="data:read", connected_at="c", refreshed_at="r", connected_as="Pat <p@x.com>")
    store.save(ts)
    assert store.load().refresh_token == "ref-0123456789"
    status = kv.get_setting("bc_status", session_factory=factory)
    assert status == public_status(ts) and "ref-0123456789" not in str(status)
    store.clear()
    assert store.load() is None and kv.get_setting("bc_status", session_factory=factory) is None


# ---------------------------------------------------------------- mirror

def test_mirror_uploads_files_skips_unpacked_zips_and_removes_gone(av_lead, docs_root):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Spec.pdf").write_bytes(b"%PDF spec")
    (folder / "Dwgs.zip").write_bytes(zip_bytes({"A-101.pdf": b"%PDF a"}))
    D.unpack_pending(folder)
    st = FakeStorage()
    r = mirror_lead(s, opp, st)
    assert r == {"files": 3, "uploaded": 2, "removed": 0}
    docs = {d.path: d for d in s.execute(select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    assert set(docs) == {"Spec.pdf", "Dwgs.zip", "Dwgs/A-101.pdf"}
    assert docs["Dwgs.zip"].unpacked and docs["Dwgs.zip"].storage_key is None
    assert docs["Spec.pdf"].storage_key == object_key(opp.id, "Spec.pdf")
    summary = s.get(LeadDocs, opp.id).summary
    assert summary["count"] == 2 and summary["zips"] == ["Dwgs.zip"] and summary["sam_links"] == 2

    assert mirror_lead(s, opp, st)["uploaded"] == 0  # unchanged: nothing re-uploaded
    (folder / "Spec.pdf").unlink()
    assert mirror_lead(s, opp, st)["removed"] == 1
    assert object_key(opp.id, "Spec.pdf") in st.deleted


def test_object_keys_are_ascii_and_stable():
    k = object_key("opp1", "Sky Harbor/Ítem #3: Plan?.pdf")
    assert k.startswith("opp1/") and k.isascii() and "#" not in k and "?" not in k and ":" not in k.split("/", 1)[1]
    assert k == object_key("opp1", "Sky Harbor/Ítem #3: Plan?.pdf") != object_key("opp1", "other/Ítem #3: Plan?.pdf")


def test_hydrate_restores_a_lost_volume(av_lead, docs_root, tmp_path, monkeypatch):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Spec.pdf").write_bytes(b"%PDF spec")
    st = FakeStorage()
    mirror_lead(s, opp, st)
    monkeypatch.setattr(D, "DOCS_DIR", tmp_path / "new-volume")
    assert hydrate_lead(s, opp, st) == 1
    assert (D.lead_folder(opp) / "Spec.pdf").read_bytes() == b"%PDF spec"


# ---------------------------------------------------------------- jobs

def test_ingest_upload_job_moves_inbox_files_and_unpacks(av_lead, docs_root):
    factory, s, opp = av_lead
    inbox = f"{opp.id}/_inbox/u1"
    st = FakeStorage({f"{inbox}/Bid Board.zip": zip_bytes({"Specs/274100.pdf": b"%PDF"}),
                      f"{inbox}/Addendum 2.pdf": b"%PDF add"})
    job = run_job(factory, st, "ingest_upload", opp.id,
                  files=[{"key": f"{inbox}/Bid Board.zip", "name": "Bid Board.zip"},
                         {"key": f"{inbox}/Addendum 2.pdf", "name": "Addendum 2.pdf"}])
    assert job.status == "done", job.error
    assert job.result["message"].startswith("Added 2 files; unpacked Bid Board.zip (1 files)")
    assert not any(k.startswith(inbox) for k in st.objects)  # inbox cleared
    paths = {d.path for d in factory().execute(select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    assert paths == {"Bid Board.zip", "Bid Board/Specs/274100.pdf", "Addendum 2.pdf"}


def test_ingest_upload_rejects_another_leads_paths(av_lead, docs_root):
    factory, s, opp = av_lead
    job = run_job(factory, FakeStorage({"other/_inbox/x/a.pdf": b"x"}), "ingest_upload", opp.id,
                  files=[{"key": "other/_inbox/x/a.pdf", "name": "a.pdf"}])
    assert job.status == "failed" and "don't belong" in job.error


def test_sam_docs_job_downloads_and_mirrors(av_lead, docs_root):
    factory, s, opp = av_lead
    st = FakeStorage()
    with respx.mock:
        sam_redirect(L1, "aaaa1111.pdf", "spec.pdf", b"%PDF 1")
        sam_redirect(L2, "bbbb2222.pdf", "dwg.pdf", b"%PDF 2")
        job = run_job(factory, st, "sam_docs", opp.id)
    assert job.status == "done", job.error
    assert job.result["downloaded"] == 2 and job.progress == {"total": 2, "done": 2, "failed": 0}
    assert len(st.uploads) == 2 and D.JOBS == {}


def test_rescan_and_unknown_lead(av_lead, docs_root):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Copied.zip").write_bytes(zip_bytes({"Q.pdf": b"%PDF"}))
    job = run_job(factory, FakeStorage(), "rescan", opp.id)
    assert job.status == "done" and job.result["message"] == "Unpacked Copied.zip."
    assert run_job(factory, FakeStorage(), "rescan", None).error == "Lead not found."


def test_office_save_job_validates_and_saves(engine, seeded):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    bad = run_job(factory, FakeStorage(), "office_save", name="X", street="1 Main", city="Y", state="ZZ", zip="1")
    assert bad.status == "failed" and "Unknown state" in bad.error
    ok = run_job(factory, FakeStorage(), "office_save", name="Columbia", street="1 Main St", city="Columbia",
                 state="SC", zip="29201", radius_miles=75, manual_lat="34.0", manual_lon="-81.03")
    assert ok.status == "done", ok.error
    assert "Geocode: manual" in ok.result["message"]
    o = factory().get(Office, ok.result["office_id"])
    assert (o.radius_miles, o.lat, o.geocode_method) == (75, 34.0, "manual")


def test_triage_job_end_to_end(av_lead, triage_env, monkeypatch):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Spec 27 41 00.pdf").write_bytes(b"%PDF spec")
    fake = FakeClient()
    monkeypatch.setattr(T, "make_client", lambda: fake)
    job = run_job(factory, FakeStorage(), "triage", opp.id)
    assert job.status == "done", job.error
    assert job.result["rating"] == "YELLOW" and job.result["cost_usd"] == 3.12
    row = factory().execute(select(TriageRun).where(TriageRun.opportunity_id == opp.id)).scalar_one()
    assert row.status == "done" and row.estimate == "$140K - $210K" and "Rating:   YELLOW" in row.report_md
    assert T.JOBS == {}


def test_triage_job_nda_gate_is_a_readable_failure(av_lead, triage_env, monkeypatch):
    factory, s, opp = av_lead
    opp.extra = {"nda_required": True}
    s.commit()
    folder = D.lead_folder(opp, create=True)
    (folder / "a.pdf").write_bytes(b"%PDF")
    monkeypatch.setattr(T, "make_client", lambda: FakeClient())
    job = run_job(factory, FakeStorage(), "triage", opp.id)
    assert job.status == "failed" and "NDA" in job.error


def test_recover_fails_stale_jobs_and_resumes_triage(av_lead, triage_env, monkeypatch):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "a.pdf").write_bytes(b"%PDF")
    T.start(s, opp, FakeClient())  # a session left running by a restart
    mirror_lead(s, opp, FakeStorage())
    s.add(Job(kind="rescan", opportunity_id=opp.id, status="running"))
    s.commit()
    assert W.recover(factory) == [opp.id]
    jobs = factory().execute(select(Job).order_by(Job.created_at)).scalars().all()
    assert [(j.kind, j.status) for j in jobs] == [("rescan", "failed"), ("triage_resume", "queued")]

    monkeypatch.setattr(T, "make_client", lambda: FakeClient())
    job = W.claim_next(factory)
    W.execute(job, factory, lambda: FakeStorage())
    done = factory().get(Job, job.id)
    assert done.status == "done" and done.result["rating"] == "YELLOW"


def test_scheduled_run_due_once_per_day(engine):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    s = factory()
    early = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)   # 05:00 ET
    late = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)    # 07:00 ET
    assert not W.scheduled_due(s, early, 6)
    assert W.scheduled_due(s, late, 6)
    assert not W.scheduled_due(s, late, -1)
    s.add(Job(kind="run", params={"trigger": "scheduled"}, created_at=datetime(2026, 11, 6, 11, 1, tzinfo=timezone.utc)))
    s.commit()
    assert not W.scheduled_due(s, late, 6)


def test_unknown_handler_and_unexpected_errors_are_recorded(engine, monkeypatch):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setitem(W.HANDLERS, "rescore", lambda ctx: 1 / 0)
    job = run_job(factory, FakeStorage(), "rescore")
    assert job.status == "failed" and job.error.startswith("Unexpected error: ZeroDivisionError")
    assert job.finished_at is not None


def test_is_admin_token_rejects_without_supabase(monkeypatch):
    from leadfinder.settings import get_settings
    monkeypatch.setattr(get_settings(), "supabase_url", "")
    assert W.is_admin_token("tok") is False


def test_bc_authorize_requires_admin(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(W, "is_admin_token", lambda token, httpx_mod=None: token == "good")
    from leadfinder.settings import get_settings
    st = get_settings()
    monkeypatch.setattr(st, "aps_client_id", "cid")
    monkeypatch.setattr(st, "aps_client_secret", "secret-0123456789")
    with TestClient(W.web(None)) as c:
        assert c.get("/healthz").text == "ok"
        assert c.post("/bc/authorize").status_code == 403
        assert c.post("/bc/authorize", headers={"Authorization": "Bearer bad"}).status_code == 403
        r = c.post("/bc/authorize", headers={"Authorization": "Bearer good"})
        assert r.status_code == 200 and r.json()["url"].startswith("https://developer.api.autodesk.com/")
        cb = c.get("/oauth/callback", params={"code": "x", "state": "never-issued"}, follow_redirects=False)
        assert cb.status_code == 303 and "/lead-finder?tab=settings&err=" in cb.headers["location"]


def test_storage_client_against_supabase_api(tmp_path):
    from leadfinder.storage import Storage

    f = tmp_path / "a.pdf"
    f.write_bytes(b"%PDF")
    with respx.mock(base_url="https://proj.supabase.co") as m:
        up = m.post("/storage/v1/object/lead-documents/opp/abc-a.pdf").mock(return_value=httpx.Response(200, json={}))
        m.get("/storage/v1/object/lead-documents/opp/abc-a.pdf").mock(return_value=httpx.Response(200, content=b"%PDF"))
        rm = m.delete("/storage/v1/object/lead-documents").mock(return_value=httpx.Response(200, json=[]))
        with Storage(url="https://proj.supabase.co", key="service-key-0123456789") as st:
            st.upload("opp/abc-a.pdf", f, "application/pdf")
            st.download("opp/abc-a.pdf", tmp_path / "b.pdf")
            st.delete(["opp/abc-a.pdf"])
        assert up.calls[0].request.headers["x-upsert"] == "true"
        assert up.calls[0].request.headers["authorization"] == "Bearer service-key-0123456789"
        assert (tmp_path / "b.pdf").read_bytes() == b"%PDF" and rm.called
