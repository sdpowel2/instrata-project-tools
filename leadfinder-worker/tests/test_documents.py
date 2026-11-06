"""Bid documents (D-19): SAM attachment download, uploads, safe zip unpacking."""
import io
import json
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import pytest
import respx
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from leadfinder import documents as D
from leadfinder.adapters.sam_gov import SEARCH_URL, SamGovAdapter
from leadfinder.db.models import LeadReview, Opportunity
from leadfinder.http import Client, filename_from_disposition
from leadfinder.pipeline.run import run

FIX = Path(__file__).parent / "fixtures" / "sam_gov"
NOW = datetime(2026, 11, 3, 15, 0, tzinfo=timezone.utc)
FILES = "https://sam.gov/api/prod/opps/v3/opportunities/resources/files"
L1, L2 = f"{FILES}/aaaa1111/download", f"{FILES}/bbbb2222/download"
S3 = "https://iae-fbo-attachments.s3.amazonaws.com/fbo/files"


def zip_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def sam_redirect(url: str, s3_name: str, filename: str, body: bytes):
    """SAM answers 303 with the filename; S3 serves the bytes (as observed live)."""
    respx.get(url).mock(return_value=httpx.Response(
        303, headers={"Location": f"{S3}/{s3_name}", "Content-Disposition": f'attachment; filename="{filename}"'}))
    return respx.get(f"{S3}/{s3_name}").mock(return_value=httpx.Response(200, content=body))


@pytest.fixture
def docs_root(tmp_path, monkeypatch):
    root = tmp_path / "documents"
    monkeypatch.setattr(D, "DOCS_DIR", root)
    return root


@pytest.fixture
def av_lead(engine, seeded):
    """The AV upgrade notice from the e2e fixture, with two attachments and one off-site link."""
    page = json.loads((FIX / "e2e_page.json").read_text(encoding="utf-8"))
    notice = next(n for n in page["opportunitiesData"] if n["noticeId"] == "a0000000000000000000000000000001")
    notice["resourceLinks"] = [L1, L2, "https://evil.example/download", L1]
    page = {"totalRecords": 1, "opportunitiesData": [notice]}
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with respx.mock:
        respx.get(SEARCH_URL).mock(return_value=httpx.Response(200, json=page))
        respx.get(url__startswith="https://api.sam.gov/prod/opportunities/v1/noticedesc").mock(
            return_value=httpx.Response(200, json={"description": "AV"}))
        run(sources=["sam_gov"], since=date(2026, 11, 2), until=date(2026, 11, 2), trigger="cli",
            session_factory=factory, geocode_online=False, now=NOW,
            adapters={"sam_gov": SamGovAdapter(Client(), api_key="TESTKEY1234567890")})
    s = factory()
    opp = s.execute(select(Opportunity).where(Opportunity.source_record_id == notice["noticeId"])).scalar_one()
    return factory, s, opp


# ---------------------------------------------------------------- helpers

def test_filename_from_disposition():
    assert filename_from_disposition('attachment; filename="DRFP L Attachments.pdf"') == "DRFP L Attachments.pdf"
    assert filename_from_disposition("attachment; filename*=UTF-8''Spec%20Book%E2%80%93Div27.pdf") == "Spec Book–Div27.pdf"
    assert filename_from_disposition("attachment") is None and filename_from_disposition(None) is None


def test_safe_name():
    assert D.safe_name("../../etc/passwd") == "passwd"
    assert D.safe_name('A:"B"?.pdf') == "A__B__.pdf"
    assert D.safe_name("CON.txt") == "_CON.txt"
    assert D.safe_name("") == "file"
    long = D.safe_name("x" * 300 + ".pdf")
    assert long.endswith(".pdf") and len(long) <= 100


# ---------------------------------------------------------------- zips

def test_unpack_zip_safely_with_nested_zip(tmp_path):
    folder = tmp_path / "lead"
    folder.mkdir()
    inner = zip_bytes({"E-501 AV Riser.pdf": b"%PDF riser"})
    z = folder / "Bid Package.zip"
    z.write_bytes(zip_bytes({
        "Specs/27 41 00 Audiovisual.pdf": b"%PDF spec",
        "Drawings/T-101.pdf": b"%PDF t101",
        "../../escape.txt": b"nope",
        "C:/Windows/evil.txt": b"nope",
        "Addenda/Addendum 1.zip": inner,
    }))
    r = D.unpack_zip(z, folder)
    assert r["status"] == "ok" and r["files"] == 3 and r["skipped"] == 2
    rels = {f.rel for f in D.list_files(folder)}
    assert "Bid Package/Specs/27 41 00 Audiovisual.pdf" in rels
    assert "Bid Package/Addenda/Addendum 1/E-501 AV Riser.pdf" in rels  # nested zip unpacked
    assert not (tmp_path / "escape.txt").exists() and not any("evil" in x for x in rels)
    zips = [f for f in D.list_files(folder) if f.is_zip]
    assert zips and all(f.unpacked for f in zips)
    assert D.unpack_pending(folder) == []  # already recorded


def test_unpack_limits_and_bad_zip(tmp_path, monkeypatch):
    folder = tmp_path / "lead"
    folder.mkdir()
    monkeypatch.setattr(D, "MAX_UNPACK_FILES", 2)
    big = folder / "many.zip"
    big.write_bytes(zip_bytes({f"f{i}.pdf": b"x" for i in range(3)}))
    r = D.unpack_zip(big, folder)
    assert r["status"] == "error" and "file limit" in r["error"] and not (folder / "many").exists()

    monkeypatch.setattr(D, "MAX_UNPACK_FILES", 100)
    monkeypatch.setattr(D, "MAX_UNPACK_BYTES", 1000)
    bomb = folder / "bomb.zip"
    bomb.write_bytes(zip_bytes({"a.bin": b"0" * 5000}))
    assert "GB limit" in D.unpack_zip(bomb, folder)["error"]

    junk = folder / "junk.zip"
    junk.write_bytes(b"not a zip")
    assert D.unpack_zip(junk, folder)["status"] == "error"
    assert junk.exists()  # left for a person to look at


# ---------------------------------------------------------------- SAM attachments

def test_fetch_sam_downloads_once_then_skips(av_lead, docs_root):
    _, s, opp = av_lead
    assert D.sam_links(s, opp) == [L1, L2]  # off-site link and duplicate dropped
    with respx.mock:
        a = sam_redirect(L1, "aaaa1111.pdf", "RFQ W91 Spec 27 41 00.pdf", b"%PDF spec")
        b = sam_redirect(L2, "bbbb2222.zip", "Drawings.zip", zip_bytes({"T-101.pdf": b"%PDF t"}))
        r = D.fetch_sam(s, opp, Client())
    assert r == {"links": 2, "downloaded": 2, "failed": 0, "already": 0}
    folder = D.lead_folder(opp)
    assert folder.parent == docs_root and folder.name.startswith("Audio-Visual-System-Upgrade")
    rels = {f.rel for f in D.list_files(folder)}
    assert {"RFQ W91 Spec 27 41 00.pdf", "Drawings.zip", "Drawings/T-101.pdf"} <= rels
    assert not any(x.startswith(".dl-") or x.endswith(".part") for x in rels)
    m = D.load_manifest(folder)
    assert m["opportunity_id"] == opp.id and m["sam"][L1]["status"] == "ok"

    with respx.mock:  # nothing new: no requests at all
        assert D.fetch_sam(s, opp, Client())["already"] == 2

    with respx.mock:  # forced: replaces, doesn't duplicate
        sam_redirect(L1, "aaaa1111.pdf", "RFQ W91 Spec 27 41 00.pdf", b"%PDF spec v2")
        sam_redirect(L2, "bbbb2222.zip", "Drawings.zip", zip_bytes({"T-101.pdf": b"%PDF t"}))
        D.fetch_sam(s, opp, Client(), force=True)
    assert (folder / "RFQ W91 Spec 27 41 00.pdf").read_bytes() == b"%PDF spec v2"
    assert not (folder / "RFQ W91 Spec 27 41 00 (2).pdf").exists()


def test_fetch_sam_records_failures_and_size_limit(av_lead, docs_root, monkeypatch):
    _, s, opp = av_lead
    monkeypatch.setattr(D, "MAX_DOWNLOAD_BYTES", 10)
    with respx.mock:
        sam_redirect(L1, "aaaa1111.pdf", "big.pdf", b"x" * 50)
        respx.get(L2).mock(return_value=httpx.Response(404))
        r = D.fetch_sam(s, opp, Client())
    assert r["failed"] == 2 and r["downloaded"] == 0
    folder = D.lead_folder(opp)
    assert D.list_files(folder) == []  # no partial files left behind
    summ = D.summary(s, opp)
    assert summ["sam_ok"] == 0 and len(summ["sam_errors"]) == 2


def test_sync_pursued_only_touches_pursue_leads(av_lead, docs_root):
    _, s, opp = av_lead
    with respx.mock:
        assert D.sync_pursued(s, Client()) == []  # not pursued yet: no requests
    rv = s.get(LeadReview, opp.id) or LeadReview(opportunity_id=opp.id)
    rv.status = "pursue"
    s.add(rv)
    s.commit()
    with respx.mock:
        sam_redirect(L1, "aaaa1111.pdf", "spec.pdf", b"%PDF")
        sam_redirect(L2, "bbbb2222.pdf", "dwg.pdf", b"%PDF")
        out = D.sync_pursued(s, Client())
    assert [(o.id, r["downloaded"]) for o, r in out] == [(opp.id, 2)]
    assert D.JOBS == {}
