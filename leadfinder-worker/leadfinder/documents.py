"""Bid documents for leads worth a closer look (DECISIONS D-19).

Each lead gets one folder, data/documents/<title-slug>__<id8>/, holding everything known
about the package: SAM.gov attachments (downloaded automatically when a SAM lead is marked
Pursue, and re-checked after every run for amendments) and files people add (the drawer's
drop zone, or copied straight into the folder followed by "Rescan"). Zips are unpacked next
to themselves. BuildingConnected has no API for invite files, so for Bid Board leads someone
uses "Download all" in Bid Board and drops the zip in.

The folder is the source of truth; _leadfinder.json in it records which SAM links were
fetched and which zips were unpacked. This folder is what the triage step will read."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable, Iterable
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from leadfinder.db.models import LeadReview, Opportunity, RawRecord
from leadfinder.http import Client, HttpError
from leadfinder.settings import DATA_DIR, redact

log = logging.getLogger(__name__)

DOCS_DIR = DATA_DIR / "documents"
MANIFEST = "_leadfinder.json"
MAX_DOWNLOAD_BYTES = 500 * 2**20          # per SAM attachment
MAX_UNPACK_BYTES = 8 * 2**30              # per zip, uncompressed
MAX_UNPACK_FILES = 10_000                 # per zip
MAX_ZIP_DEPTH = 2                         # a zip inside a zip is unpacked; deeper ones are left alone
SAM_MIN_INTERVAL = 1.0                    # seconds between attachment downloads
SAM_HOSTS = ("sam.gov", "api.sam.gov")
PATH_BUDGET = 240                         # stay under Windows' 260-char MAX_PATH

_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- naming

_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_name(name: str | None, fallback: str = "file", limit: int = 100) -> str:
    """A filename that is safe on Windows: no path parts, no reserved names, bounded length,
    extension kept when truncating."""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = _BAD.sub("_", name).strip().strip(".")
    if not name:
        name = fallback
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.upper() in _RESERVED:
        stem = f"_{stem}"
    ext = ext[:12]
    room = max(8, limit - (len(ext) + 1 if ext else 0))
    return f"{stem[:room].rstrip()}.{ext}" if ext else stem[:limit].rstrip()


def slug(text: str | None, n: int = 40) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-")
    return (s[:n].rstrip("-") or "lead")


def unique_path(folder: Path, name: str) -> Path:
    p = folder / name
    if not p.exists():
        return p
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for i in range(2, 1000):
        cand = folder / (f"{stem} ({i}).{ext}" if ext else f"{stem} ({i})")
        if not cand.exists():
            return cand
    raise OSError(f"too many files named {name} in {folder}")


# ---------------------------------------------------------------- folders + manifest

def lead_folder(opp: Opportunity, create: bool = False, root: Path | None = None) -> Path | None:
    root = root or DOCS_DIR
    if root.exists():
        for cand in (root / f"{slug(opp.title)}__{opp.id[:8]}", *root.glob(f"*__{opp.id[:8]}"), root / opp.id):
            if cand.is_dir() and load_manifest(cand).get("opportunity_id") in (None, opp.id):
                return cand
    if not create:
        return None
    folder = root / f"{slug(opp.title)}__{opp.id[:8]}"
    if folder.exists():  # an 8-char prefix collision with another lead
        folder = root / opp.id
    folder.mkdir(parents=True, exist_ok=True)
    with _lock:
        m = load_manifest(folder)
        m.update({"opportunity_id": opp.id, "title": opp.title, "source_id": opp.source_id,
                  "source_record_id": opp.source_record_id, "created_at": m.get("created_at") or _now()})
        save_manifest(folder, m)
    return folder


def load_manifest(folder: Path) -> dict:
    try:
        return json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_manifest(folder: Path, m: dict) -> None:
    tmp = folder / (MANIFEST + ".tmp")
    tmp.write_text(json.dumps(m, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, folder / MANIFEST)


def _rel(folder: Path, p: Path) -> str:
    return p.relative_to(folder).as_posix()


@dataclass
class DocFile:
    rel: str
    size: int
    is_zip: bool = False
    unpacked: bool = False


def list_files(folder: Path | None) -> list[DocFile]:
    if folder is None or not folder.is_dir():
        return []
    unpacked = load_manifest(folder).get("unpacked", {})
    out = []
    for p in sorted(folder.rglob("*"), key=lambda x: x.relative_to(folder).as_posix().lower()):
        if not p.is_file() or p.name.startswith(MANIFEST) or p.suffix == ".part" or p.name.startswith(".dl-"):
            continue
        rel = _rel(folder, p)
        is_zip = p.suffix.lower() == ".zip"
        out.append(DocFile(rel=rel, size=p.stat().st_size, is_zip=is_zip,
                           unpacked=is_zip and unpacked.get(rel, {}).get("status") == "ok"))
    return out


# ---------------------------------------------------------------- zips

class UnpackError(Exception):
    pass


def _member_target(dest: Path, member: str) -> Path | None:
    """Map a zip member name to a path under dest, or None if it must be skipped
    (absolute, drive-qualified, or escaping with ..)."""
    member = member.replace("\\", "/")
    if member.startswith("/") or re.match(r"^[A-Za-z]:", member):
        return None
    parts = [p for p in PurePosixPath(member).parts if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    safe = [safe_name(p, fallback="_", limit=80) for p in parts]
    target = dest.joinpath(*safe)
    if len(str(target)) > PATH_BUDGET:  # deep nesting: keep the file, flatten the path
        target = dest / safe_name(safe[-1], limit=max(20, PATH_BUDGET - len(str(dest)) - 1))
    return target


def unpack_zip(zip_path: Path, folder: Path, depth: int = 1) -> dict:
    """Unpack zip_path into a sibling directory named after it. Enforces member-path safety,
    a file-count limit and an uncompressed-size limit (counted while writing, not trusted from
    the header). Nested zips are unpacked up to MAX_ZIP_DEPTH. Records the result in the
    manifest and returns it."""
    rel = _rel(folder, zip_path)
    dest = unique_path(zip_path.parent, safe_name(zip_path.stem, limit=60))
    result: dict = {"at": _now(), "bytes": zip_path.stat().st_size}
    nested: list[Path] = []
    try:
        with zipfile.ZipFile(zip_path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            if len(infos) > MAX_UNPACK_FILES:
                raise UnpackError(f"{len(infos):,} files is over the {MAX_UNPACK_FILES:,} file limit")
            if sum(i.file_size for i in infos) > MAX_UNPACK_BYTES:
                raise UnpackError(f"unpacked size is over the {MAX_UNPACK_BYTES // 2**30} GB limit")
            written = files = skipped = 0
            dest.mkdir(parents=True)
            for info in infos:
                target = _member_target(dest, info.filename)
                if target is None:
                    skipped += 1
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target = unique_path(target.parent, target.name)
                try:
                    with zf.open(info) as src, open(target, "wb") as out:
                        while chunk := src.read(1 << 16):
                            written += len(chunk)
                            if written > MAX_UNPACK_BYTES:
                                raise UnpackError(f"unpacked size is over the {MAX_UNPACK_BYTES // 2**30} GB limit")
                            out.write(chunk)
                except OSError as exc:
                    log.warning("zip member skipped", extra={"zip": rel, "member": info.filename, "error": str(exc)})
                    skipped += 1
                    continue
                files += 1
                if target.suffix.lower() == ".zip":
                    nested.append(target)
        result.update(status="ok", into=_rel(folder, dest), files=files, skipped=skipped)
    except (zipfile.BadZipFile, UnpackError, OSError, RuntimeError) as exc:
        # RuntimeError: encrypted member. Leave the zip in place for a person to deal with.
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        result.update(status="error", error=str(exc) or exc.__class__.__name__)
    with _lock:
        m = load_manifest(folder)
        m.setdefault("unpacked", {})[rel] = result
        save_manifest(folder, m)
    for inner in nested:
        if depth < MAX_ZIP_DEPTH:
            unpack_zip(inner, folder, depth + 1)
        else:
            with _lock:
                m = load_manifest(folder)
                m.setdefault("unpacked", {})[_rel(folder, inner)] = {
                    "at": _now(), "status": "skipped", "error": "nested too deep; unpack by hand if needed"}
                save_manifest(folder, m)
    return result


def unpack_pending(folder: Path) -> list[tuple[str, dict]]:
    """Unpack every zip in the folder not yet recorded (e.g. one copied in through Explorer)."""
    done = load_manifest(folder).get("unpacked", {})
    out = []
    for z in sorted(folder.rglob("*.zip")):
        rel = _rel(folder, z)
        if rel not in done:
            out.append((rel, unpack_zip(z, folder)))
    return out


def save_upload(folder: Path, filename: str | None, fh: BinaryIO) -> tuple[str, dict | None]:
    """Copy an uploaded file into the folder; unpack it if it's a zip."""
    target = unique_path(folder, safe_name(filename, fallback="upload"))
    with open(target, "wb") as out:
        shutil.copyfileobj(fh, out, 1 << 20)
    unpack = unpack_zip(target, folder) if target.suffix.lower() == ".zip" else None
    with _lock:
        m = load_manifest(folder)
        m.setdefault("uploads", []).append({"file": _rel(folder, target), "at": _now(),
                                            "bytes": target.stat().st_size})
        save_manifest(folder, m)
    return _rel(folder, target), unpack


# ---------------------------------------------------------------- SAM.gov attachments

def sam_links(session: Session, opp: Opportunity) -> list[str]:
    """Attachment links from the latest stored SAM payload (public, no API key, no budget)."""
    if opp.source_id != "sam_gov":
        return []
    raw = session.execute(select(RawRecord).where(RawRecord.source_id == opp.source_id,
                                                  RawRecord.source_record_id == opp.source_record_id)
                          .order_by(RawRecord.fetched_at.desc()).limit(1)).scalar_one_or_none()
    if raw is None:
        return []
    try:
        payload = json.loads(raw.payload)
    except (TypeError, ValueError):
        return []
    links = payload.get("resourceLinks") if isinstance(payload, dict) else None
    out = []
    for u in links or []:
        if not isinstance(u, str):
            continue
        parts = urlsplit(u)
        if parts.scheme == "https" and parts.hostname in SAM_HOSTS and u not in out:
            out.append(u)
    return out


@dataclass
class Job:
    total: int = 0
    done: int = 0
    failed: int = 0
    started_at: str = field(default_factory=_now)


JOBS: dict[str, Job] = {}


def claim(opp_id: str) -> Job | None:
    """Mark a lead as having a document job running; None if one already is."""
    with _lock:
        if opp_id in JOBS:
            return None
        JOBS[opp_id] = job = Job()
        return job


def release(opp_id: str) -> None:
    with _lock:
        JOBS.pop(opp_id, None)


def fetch_sam(session: Session, opp: Opportunity, client: Client, force: bool = False,
              root: Path | None = None, job: Job | None = None) -> dict:
    """Download any SAM attachments not already in the lead's folder (all of them with
    force). Returns counts. `job`, if given, is updated as files arrive."""
    links = sam_links(session, opp)
    if not links:
        return {"links": 0, "downloaded": 0, "failed": 0, "already": 0}
    folder = lead_folder(opp, create=True, root=root)
    assert folder is not None
    have = load_manifest(folder).get("sam", {})
    todo = [u for u in links if force or have.get(u, {}).get("status") != "ok"
            or not (folder / have[u].get("file", "")).is_file()]
    job = job or Job()
    job.total, job.done, job.failed = len(todo), 0, 0
    downloaded = failed = 0
    for url in todo:
        file_id = urlsplit(url).path.rstrip("/").split("/")[-2] if url.endswith("/download") else "attachment"
        tmp = folder / f".dl-{safe_name(file_id, limit=40)}"
        try:
            name = client.download(url, tmp, max_bytes=MAX_DOWNLOAD_BYTES)
            old = have.get(url, {}).get("file")
            if old and (folder / old).is_file():
                (folder / old).unlink()  # a forced re-download replaces the earlier copy
            final = unique_path(folder, safe_name(name, fallback=f"{file_id}.bin"))
            os.replace(tmp, final)
            entry = {"status": "ok", "file": _rel(folder, final), "bytes": final.stat().st_size, "at": _now()}
            downloaded += 1
            if final.suffix.lower() == ".zip":
                unpack_zip(final, folder)
        except (HttpError, OSError) as exc:
            if tmp.exists():
                tmp.unlink()
            entry = {"status": "error", "error": redact(str(exc)), "at": _now()}
            failed += 1
            job.failed += 1
            log.warning("sam attachment failed", extra={"opp": opp.id, "url": url, "error": redact(str(exc))})
        with _lock:
            m = load_manifest(folder)
            m.setdefault("sam", {})[url] = entry
            save_manifest(folder, m)
        job.done += 1
    return {"links": len(links), "downloaded": downloaded, "failed": failed, "already": len(links) - len(todo)}


def sam_client() -> Client:
    return Client(min_interval_per_host=SAM_MIN_INTERVAL, timeout=300.0)


def start_sam_fetch(opp_id: str, session_factory: Callable[[], Session] | None = None,
                    client_factory: Callable[[], Client] = sam_client, force: bool = False) -> bool:
    """Run fetch_sam in a background thread. False if one is already running for this lead."""
    job = claim(opp_id)
    if job is None:
        return False

    def work() -> None:
        from leadfinder.db.session import SessionLocal
        s = (session_factory or SessionLocal)()
        try:
            opp = s.get(Opportunity, opp_id)
            if opp is not None:
                with client_factory() as c:
                    fetch_sam(s, opp, c, force=force, job=job)
        except Exception:  # pragma: no cover - logged, shown as "not downloaded" in the drawer
            log.exception("sam attachment job failed", extra={"opp": opp_id})
        finally:
            s.close()
            release(opp_id)

    threading.Thread(target=work, daemon=True, name=f"sam-docs-{opp_id[:8]}").start()
    return True


def pursued(session: Session, source_id: str | None = None) -> list[Opportunity]:
    q = select(Opportunity).join(LeadReview, LeadReview.opportunity_id == Opportunity.id) \
        .where(LeadReview.status == "pursue")
    if source_id:
        q = q.where(Opportunity.source_id == source_id)
    return list(session.execute(q).scalars())


def sync_pursued(session: Session, client: Client | None = None,
                 progress: Callable[[Opportunity, dict], None] | None = None) -> list[tuple[Opportunity, dict]]:
    """Fetch new or missing SAM attachments for every Pursue lead (amendments add files)."""
    out = []
    own = client is None
    client = client or sam_client()
    try:
        for opp in pursued(session, "sam_gov"):
            job = claim(opp.id)
            if job is None:  # already downloading from the drawer
                continue
            try:
                r = fetch_sam(session, opp, client, job=job)
            finally:
                release(opp.id)
            out.append((opp, r))
            if progress:
                progress(opp, r)
    finally:
        if own:
            client.close()
    return out


# ---------------------------------------------------------------- drawer view

def summary(session: Session, opp: Opportunity, root: Path | None = None) -> dict:
    folder = lead_folder(opp, root=root)
    files = list_files(folder)
    manifest = load_manifest(folder) if folder else {}
    links = sam_links(session, opp)
    sam = manifest.get("sam", {})
    unpack_errors = [(rel, r.get("error")) for rel, r in manifest.get("unpacked", {}).items()
                     if r.get("status") != "ok"]
    return {
        "folder": folder,
        "folder_display": str(folder) if folder else str((root or DOCS_DIR) / f"{slug(opp.title)}__{opp.id[:8]}"),
        "files": [f for f in files if not f.is_zip or not f.unpacked],
        "zips": [f for f in files if f.is_zip and f.unpacked],
        "count": sum(1 for f in files if not f.is_zip),
        "total_bytes": sum(f.size for f in files if not f.is_zip),
        "sam_links": len(links),
        "sam_ok": sum(1 for u in links if sam.get(u, {}).get("status") == "ok"),
        "sam_errors": [(u, sam[u].get("error")) for u in links if sam.get(u, {}).get("status") == "error"],
        "unpack_errors": unpack_errors,
        "job": JOBS.get(opp.id),
        "pursue": bool(opp.review and opp.review.status == "pursue"),
    }


def human_bytes(n: int | float | None) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit in ("B", "KB") else f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"  # pragma: no cover


def iter_folders(root: Path | None = None) -> Iterable[Path]:
    root = root or DOCS_DIR
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []
