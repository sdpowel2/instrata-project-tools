"""Download and parse the Census Bureau ZCTA and Places Gazetteer files."""
from __future__ import annotations

import csv
import io
import logging
import zipfile
from pathlib import Path

from leadfinder.http import Client
from leadfinder.settings import DATA_DIR

log = logging.getLogger(__name__)

BASE = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_{kind}_national.zip"
VINTAGES = ("2025", "2024")
CACHE_DIR = DATA_DIR / "gazetteer"


def _download(client: Client, kind: str) -> tuple[bytes, str]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for y in VINTAGES:
        cached = CACHE_DIR / f"{y}_Gaz_{kind}_national.zip"
        if cached.exists() and cached.stat().st_size > 0:
            return cached.read_bytes(), y
    last_err: Exception | None = None
    for y in VINTAGES:
        try:
            resp = client.get(BASE.format(y=y, kind=kind))
            data = resp.content
            (CACHE_DIR / f"{y}_Gaz_{kind}_national.zip").write_bytes(data)
            return data, y
        except Exception as exc:  # try the older vintage
            last_err = exc
            log.warning("gazetteer download failed", extra={"kind": kind, "vintage": y, "error": str(exc)})
    raise RuntimeError(f"could not download {kind} gazetteer: {last_err}")


def _rows(data: bytes) -> list[dict[str, str]]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".txt"))
        text = zf.read(name).decode("latin-1")
    header = text.split("\n", 1)[0]
    delim = "|" if header.count("|") > header.count("\t") else "\t"  # 2025 switched tab -> pipe
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    # Header names sometimes carry trailing whitespace (INTPTLONG).
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def zcta(client: Client) -> tuple[list[tuple[str, float, float]], str]:
    data, vintage = _download(client, "zcta")
    out = []
    for r in _rows(data):
        try:
            out.append((r["GEOID"].zfill(5), float(r["INTPTLAT"]), float(r["INTPTLONG"])))
        except (KeyError, ValueError):
            continue
    return out, vintage


def places(client: Client) -> list[tuple[str, str, float, float]]:
    data, _ = _download(client, "place")
    out = []
    for r in _rows(data):
        try:
            out.append((r["USPS"], r["NAME"], float(r["INTPTLAT"]), float(r["INTPTLONG"])))
        except (KeyError, ValueError):
            continue
    return out
