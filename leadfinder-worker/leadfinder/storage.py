"""Supabase Storage (bucket lead-documents) with the service-role key.

The worker's lead folders on its volume are the working copy; Storage holds a mirror the
Lead Finder tab can list and download, plus the _inbox/ area where the tab uploads files
for the worker to pick up."""
from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from pathlib import Path
from urllib.parse import quote

import httpx

from leadfinder.settings import get_settings, redact

log = logging.getLogger(__name__)


class StorageError(Exception):
    pass


def object_key(opportunity_id: str, rel: str) -> str:
    """Storage key for a file in a lead folder: stable per relative path, ASCII-only (Storage
    rejects many characters that bid file names contain). The original path stays in
    lf_document.path and is used as the download name."""
    digest = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    name = unicodedata.normalize("NFKD", rel.rsplit("/", 1)[-1]).encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._ ()-]+", "_", name).strip(" .") or "file"
    return f"{opportunity_id}/{digest}-{name[-120:]}"


class Storage:
    def __init__(self, url: str | None = None, key: str | None = None, bucket: str | None = None,
                 client: httpx.Client | None = None):
        st = get_settings()
        self.url = (url if url is not None else st.supabase_url).rstrip("/")
        self.key = key if key is not None else st.supabase_service_role_key
        self.bucket = bucket or st.documents_bucket
        self._client = client

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key)

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(30.0, read=600.0, write=600.0))
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "Storage":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _headers(self, **extra: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}", "apikey": self.key, **extra}

    def _obj_url(self, key: str) -> str:
        return f"{self.url}/storage/v1/object/{self.bucket}/{quote(key, safe='/')}"

    def _check(self, resp: httpx.Response, what: str) -> None:
        if resp.status_code >= 300:
            raise StorageError(redact(f"{what} failed: HTTP {resp.status_code} {resp.text[:300]}"))

    def upload(self, key: str, path: Path, content_type: str = "application/octet-stream") -> None:
        with open(path, "rb") as fh:
            resp = self.client.post(self._obj_url(key), content=fh,
                                    headers=self._headers(**{"x-upsert": "true", "Content-Type": content_type,
                                                             "Content-Length": str(path.stat().st_size)}))
        self._check(resp, f"upload {key}")

    def download(self, key: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self.client.stream("GET", self._obj_url(key), headers=self._headers()) as resp:
            if resp.status_code >= 300:
                resp.read()
                self._check(resp, f"download {key}")
            with open(dest, "wb") as out:
                for chunk in resp.iter_bytes(1 << 20):
                    out.write(chunk)

    def delete(self, keys: list[str]) -> None:
        for i in range(0, len(keys), 500):
            resp = self.client.request("DELETE", f"{self.url}/storage/v1/object/{self.bucket}",
                                       json={"prefixes": keys[i:i + 500]}, headers=self._headers())
            self._check(resp, "delete")
