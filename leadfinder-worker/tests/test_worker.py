"""The Project Tools worker: job queue, handlers, document upload/download endpoints, mirroring
to the document tables, database-backed token/agent state. SQLite + fakes only."""
import io
import tarfile
import time
import zipfile
from datetime import datetime, timezone

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
from leadfinder.mirror import mirror_lead
from tests.test_documents import L1, L2, av_lead, docs_root, sam_redirect  # noqa: F401  (fixtures)
from tests.test_triage import FakeClient, triage_env  # noqa: F401  (fixtures)


def zip_bytes(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, d in members.items():
            zf.writestr(n, d)
    return buf.getvalue()


def run_job(factory, kind, opp_id=None, **params):
    s = factory()
    s.add(Job(kind=kind, opportunity_id=opp_id, params=params))
    s.commit()
    s.close()
    job = W.claim_next(factory)
    assert job is not None and job.status == "running"
    W.execute(job, factory)
    s = factory()
    try:
        return s.get(Job, job.id)
    finally:
        s.close()


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    root = tmp_path / "inbox"
    monkeypatch.setattr(W, "INBOX_DIR", root)
    return root


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

def test_mirror_lists_files_and_removes_gone(av_lead, docs_root):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Spec.pdf").write_bytes(b"%PDF spec")
    (folder / "Dwgs.zip").write_bytes(zip_bytes({"A-101.pdf": b"%PDF a"}))
    D.unpack_pending(folder)
    assert mirror_lead(s, opp) == {"files": 3, "added": 3, "removed": 0}
    docs = {d.path: d for d in s.execute(select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    assert set(docs) == {"Spec.pdf", "Dwgs.zip", "Dwgs/A-101.pdf"}
    assert docs["Dwgs.zip"].unpacked and not docs["Spec.pdf"].is_zip
    summary = s.get(LeadDocs, opp.id).summary
    assert summary["count"] == 2 and summary["zips"] == ["Dwgs.zip"] and summary["sam_links"] == 2
    assert summary["folder"] == folder.name  # never a server path

    assert mirror_lead(s, opp)["added"] == 0
    (folder / "Spec.pdf").unlink()
    assert mirror_lead(s, opp)["removed"] == 1


def test_docs_import_unpacks_tar_and_records_folders(av_lead, docs_root, tmp_path):
    from typer.testing import CliRunner

    from leadfinder.cli import app
    from leadfinder.db import session as dbs

    factory, s, opp = av_lead
    old = tmp_path / "old" / "documents" / f"Lead__{opp.id[:8]}"
    old.mkdir(parents=True)
    (old / "Spec.pdf").write_bytes(b"%PDF")
    D.save_manifest(old, {"opportunity_id": opp.id})
    archive = tmp_path / "documents.tar"
    with tarfile.open(archive, "w") as tf:
        tf.add(tmp_path / "old" / "documents", arcname="documents")
    dbs._SessionLocal, saved = factory, dbs._SessionLocal
    dbs._engine, saved_engine = factory.kw["bind"], dbs._engine
    try:
        r = CliRunner().invoke(app, ["docs", "import", str(archive)])
    finally:
        dbs._SessionLocal, dbs._engine = saved, saved_engine
    assert r.exit_code == 0, r.output
    assert (docs_root / old.name / "Spec.pdf").read_bytes() == b"%PDF"
    assert "1 lead folder(s) recorded" in r.output and not archive.exists()
    assert factory().execute(select(Document.path).where(Document.opportunity_id == opp.id)).scalars().all() == ["Spec.pdf"]


# ---------------------------------------------------------------- jobs

def test_ingest_upload_job_files_inbox_uploads_and_unpacks(av_lead, docs_root, inbox):
    factory, s, opp = av_lead
    batch = inbox / opp.id / "b1"
    batch.mkdir(parents=True)
    (batch / "0-Bid Board.zip").write_bytes(zip_bytes({"Specs/274100.pdf": b"%PDF"}))
    (batch / "1-Addendum 2.pdf").write_bytes(b"%PDF add")
    job = run_job(factory, "ingest_upload", opp.id,
                  files=[{"local": f"{opp.id}/b1/0-Bid Board.zip", "name": "Bid Board.zip"},
                         {"local": f"{opp.id}/b1/1-Addendum 2.pdf", "name": "Addendum 2.pdf"}])
    assert job.status == "done", job.error
    assert job.result["message"].startswith("Added 2 files; unpacked Bid Board.zip (1 files)")
    assert not batch.exists()  # inbox cleared
    paths = {d.path for d in factory().execute(select(Document).where(Document.opportunity_id == opp.id)).scalars()}
    assert paths == {"Bid Board.zip", "Bid Board/Specs/274100.pdf", "Addendum 2.pdf"}


def test_ingest_upload_rejects_another_leads_paths(av_lead, docs_root, inbox):
    factory, s, opp = av_lead
    (inbox / "other").mkdir(parents=True)
    (inbox / "other" / "a.pdf").write_bytes(b"x")
    for local in ("other/a.pdf", f"{opp.id}/../other/a.pdf"):
        job = run_job(factory, "ingest_upload", opp.id, files=[{"local": local, "name": "a.pdf"}])
        assert job.status == "failed" and "don't belong" in job.error


def test_sam_docs_job_downloads_and_mirrors(av_lead, docs_root):
    factory, s, opp = av_lead
    with respx.mock:
        sam_redirect(L1, "aaaa1111.pdf", "spec.pdf", b"%PDF 1")
        sam_redirect(L2, "bbbb2222.pdf", "dwg.pdf", b"%PDF 2")
        job = run_job(factory, "sam_docs", opp.id)
    assert job.status == "done", job.error
    assert job.result["downloaded"] == 2 and job.progress == {"total": 2, "done": 2, "failed": 0}
    assert len(factory().execute(select(Document).where(Document.opportunity_id == opp.id)).scalars().all()) == 2
    assert D.JOBS == {}


def test_rescan_and_unknown_lead(av_lead, docs_root):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Copied.zip").write_bytes(zip_bytes({"Q.pdf": b"%PDF"}))
    job = run_job(factory, "rescan", opp.id)
    assert job.status == "done" and job.result["message"] == "Unpacked Copied.zip."
    assert run_job(factory, "rescan", None).error == "Lead not found."


def test_office_save_job_validates_and_saves(engine, seeded):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    bad = run_job(factory, "office_save", name="X", street="1 Main", city="Y", state="ZZ", zip="1")
    assert bad.status == "failed" and "Unknown state" in bad.error
    ok = run_job(factory, "office_save", name="Columbia", street="1 Main St", city="Columbia",
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
    job = run_job(factory, "triage", opp.id)
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
    job = run_job(factory, "triage", opp.id)
    assert job.status == "failed" and "NDA" in job.error


def test_recover_fails_stale_jobs_and_resumes_triage(av_lead, triage_env, monkeypatch):
    factory, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "a.pdf").write_bytes(b"%PDF")
    T.start(s, opp, FakeClient())  # a session left running by a restart
    mirror_lead(s, opp)
    s.add(Job(kind="rescan", opportunity_id=opp.id, status="running"))
    s.commit()
    assert W.recover(factory) == [opp.id]
    jobs = factory().execute(select(Job).order_by(Job.created_at)).scalars().all()
    assert [(j.kind, j.status) for j in jobs] == [("rescan", "failed"), ("triage_resume", "queued")]

    monkeypatch.setattr(T, "make_client", lambda: FakeClient())
    job = W.claim_next(factory)
    W.execute(job, factory)
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
    job = run_job(factory, "rescore")
    assert job.status == "failed" and job.error.startswith("Unexpected error: ZeroDivisionError")
    assert job.finished_at is not None


# ---------------------------------------------------------------- HTTP

def test_admin_user_rejects_without_supabase(monkeypatch):
    from leadfinder.settings import get_settings
    monkeypatch.setattr(get_settings(), "supabase_url", "")
    assert W.admin_user("tok") is None


def test_signed_links():
    exp = int(time.time()) + 60
    sig = W.sign_link("opp", "a/b.pdf", exp)
    assert W.verify_link("opp", "a/b.pdf", exp, sig)
    assert not W.verify_link("opp", "a/c.pdf", exp, sig)
    assert not W.verify_link("other", "a/b.pdf", exp, sig)
    assert not W.verify_link("opp", "a/b.pdf", exp, sig, now=exp + 1)


@pytest.fixture
def client(av_lead, docs_root, inbox, monkeypatch):
    from fastapi.testclient import TestClient

    from leadfinder.settings import get_settings

    factory, s, opp = av_lead
    monkeypatch.setattr(W, "admin_user", lambda token: "uid-1" if token == "good" else None)
    st = get_settings()
    monkeypatch.setattr(st, "aps_client_id", "cid")
    monkeypatch.setattr(st, "aps_client_secret", "secret-0123456789")
    monkeypatch.setattr(st, "public_url", "https://worker.test")
    with TestClient(W.web(None, session_factory=factory)) as c:
        yield c, factory, opp


GOOD = {"Authorization": "Bearer good"}


def test_bc_authorize_requires_admin(client):
    c, factory, opp = client
    assert c.get("/healthz").text == "ok"
    assert c.post("/bc/authorize").status_code == 403
    assert c.post("/bc/authorize", headers={"Authorization": "Bearer bad"}).status_code == 403
    r = c.post("/bc/authorize", headers=GOOD)
    assert r.status_code == 200 and r.json()["url"].startswith("https://developer.api.autodesk.com/")
    cb = c.get("/oauth/callback", params={"code": "x", "state": "never-issued"}, follow_redirects=False)
    assert cb.status_code == 303 and "/lead-finder?tab=settings&err=" in cb.headers["location"]


def test_upload_endpoint_queues_ingest_job(client, inbox):
    c, factory, opp = client
    files = [("files", ("Bid Board.zip", zip_bytes({"S.pdf": b"%PDF"}), "application/zip")),
             ("files", ("Addendum 2.pdf", b"%PDF add", "application/pdf"))]
    assert c.post(f"/documents/{opp.id}/upload", files=files).status_code == 403
    assert c.post("/documents/nope/upload", files=files, headers=GOOD).status_code == 404
    r = c.post(f"/documents/{opp.id}/upload", files=files, headers=GOOD)
    assert r.status_code == 200 and r.json()["files"] == 2
    job = factory().get(Job, r.json()["job_id"])
    assert job.kind == "ingest_upload" and job.opportunity_id == opp.id
    assert [f["name"] for f in job.params["files"]] == ["Bid Board.zip", "Addendum 2.pdf"]
    assert all((inbox / f["local"]).is_file() for f in job.params["files"])

    claimed = W.claim_next(factory)
    W.execute(claimed, factory)
    assert factory().get(Job, job.id).status == "done"


def test_download_link_and_file(client):
    c, factory, opp = client
    folder = D.lead_folder(opp, create=True)
    (folder / "Specs").mkdir()
    (folder / "Specs" / "274100.pdf").write_bytes(b"%PDF body")
    assert c.post(f"/documents/{opp.id}/link", json={"path": "Specs/274100.pdf"}).status_code == 403
    assert c.post(f"/documents/{opp.id}/link", json={"path": "../../x"}, headers=GOOD).status_code == 404
    assert c.post(f"/documents/{opp.id}/link", json={"path": D.MANIFEST}, headers=GOOD).status_code == 404
    r = c.post(f"/documents/{opp.id}/link", json={"path": "Specs/274100.pdf", "inline": True}, headers=GOOD)
    url = r.json()["url"]
    assert url.startswith(f"https://worker.test/documents/{opp.id}/file?")
    got = c.get(url.replace("https://worker.test", ""))
    assert got.status_code == 200 and got.content == b"%PDF body"
    assert got.headers["content-disposition"].startswith("inline")
    tampered = c.get(url.replace("https://worker.test", "").replace("274100", "274200"))
    assert tampered.status_code == 403
