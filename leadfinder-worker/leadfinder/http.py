"""Shared HTTP client: descriptive User-Agent, retry/backoff on 429/5xx honouring
Retry-After (max 3 tries), per-host throttle, and API-key redaction in logs."""
from __future__ import annotations

import logging
import re
import threading
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from leadfinder.settings import get_settings, redact

log = logging.getLogger(__name__)

MAX_TRIES = 3
BASE_BACKOFF = 2.0
MAX_RETRY_AFTER = 120.0

# Tests set this to a no-op so backoff doesn't slow them down.
sleep = time.sleep


class BudgetExhausted(Exception):
    """Raised by CallBudget.spend() when no calls remain."""


class CallBudget:
    def __init__(self, limit: int | None):
        self.limit = limit
        self.used = 0

    @property
    def remaining(self) -> int | None:
        return None if self.limit is None else max(0, self.limit - self.used)

    def can_spend(self) -> bool:
        return self.limit is None or self.used < self.limit

    def spend(self) -> None:
        if not self.can_spend():
            raise BudgetExhausted(f"call budget of {self.limit} exhausted")
        self.used += 1


class HttpError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(redact(message))
        self.status = status


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    if not value:
        return None
    try:
        return min(float(value), MAX_RETRY_AFTER)
    except ValueError:
        try:
            dt = parsedate_to_datetime(value)
            return max(0.0, min(dt.timestamp() - time.time(), MAX_RETRY_AFTER))
        except Exception:
            return None


class Client:
    def __init__(self, min_interval_per_host: float = 0.0, timeout: float = 60.0,
                 transport: httpx.BaseTransport | None = None):
        self._client = httpx.Client(
            headers={"User-Agent": get_settings().user_agent, "Accept": "application/json, text/html;q=0.9, */*;q=0.5"},
            timeout=timeout,
            follow_redirects=True,
            transport=transport,
        )
        self.min_interval = min_interval_per_host
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _throttle(self, url: str) -> None:
        if self.min_interval <= 0:
            return
        host = urlsplit(url).netloc
        with self._lock:
            last = self._last.get(host)
            now = time.monotonic()
            if last is not None and now - last < self.min_interval:
                sleep(self.min_interval - (now - last))
            self._last[host] = time.monotonic()

    def get(self, url: str, *, params: dict | None = None, budget: CallBudget | None = None,
            headers: dict | None = None) -> httpx.Response:
        """GET with retry. Each attempt (including retries) spends one budget call."""
        return self.request("GET", url, params=params, budget=budget, headers=headers)

    def post(self, url: str, *, data: dict | None = None, budget: CallBudget | None = None,
             headers: dict | None = None, auth: tuple[str, str] | None = None) -> httpx.Response:
        """Form POST with the same retry rules (used for the OAuth token endpoint)."""
        return self.request("POST", url, data=data, budget=budget, headers=headers, auth=auth)

    def request(self, method: str, url: str, *, params: dict | None = None, data: dict | None = None,
                budget: CallBudget | None = None, headers: dict | None = None,
                auth: tuple[str, str] | None = None) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(1, MAX_TRIES + 1):
            if budget is not None:
                budget.spend()
            self._throttle(url)
            try:
                kwargs: dict = {"params": params, "headers": headers}
                if data is not None:
                    kwargs["data"] = data
                if auth is not None:
                    kwargs["auth"] = auth
                resp = self._client.request(method, url, **kwargs)
            except httpx.TransportError as exc:
                last_exc = exc
                log.warning("http transport error", extra={"url": redact(url), "attempt": attempt, "error": redact(str(exc))})
                if attempt < MAX_TRIES:
                    sleep(BASE_BACKOFF ** attempt)
                    continue
                raise HttpError(f"transport error for {url}: {exc}") from exc

            if resp.status_code == 429 or resp.status_code >= 500:
                wait = _retry_after_seconds(resp)
                if wait is None:
                    wait = BASE_BACKOFF ** attempt
                log.warning("http retryable status", extra={"url": redact(str(resp.request.url)), "status": resp.status_code, "attempt": attempt, "wait": wait})
                if attempt < MAX_TRIES:
                    sleep(wait)
                    continue
                raise HttpError(f"HTTP {resp.status_code} after {MAX_TRIES} tries for {resp.request.url}", resp.status_code)
            if resp.status_code >= 400:
                raise HttpError(f"HTTP {resp.status_code} for {resp.request.url}: {resp.text[:300]}", resp.status_code)
            return resp
        raise HttpError(f"request failed: {last_exc}")  # pragma: no cover

    def download(self, url: str, dest: Path, *, max_bytes: int, budget: CallBudget | None = None) -> str | None:
        """Stream a GET to `dest` (written as dest.part, then renamed), following redirects,
        with the same retry rules. Returns the server's filename (Content-Disposition on the
        first redirect hop that has one, else the final response), or None. Raises HttpError if the body exceeds
        max_bytes or the server refuses."""
        part = dest.with_name(dest.name + ".part")
        last_exc: Exception | None = None
        for attempt in range(1, MAX_TRIES + 1):
            if budget is not None:
                budget.spend()
            self._throttle(url)
            try:
                with self._client.stream("GET", url, headers={"Accept": "*/*"}) as resp:
                    if resp.status_code == 429 or resp.status_code >= 500:
                        wait = _retry_after_seconds(resp) or BASE_BACKOFF ** attempt
                        log.warning("download retryable status", extra={"url": redact(url), "status": resp.status_code, "attempt": attempt})
                        if attempt < MAX_TRIES:
                            sleep(wait)
                            continue
                        raise HttpError(f"HTTP {resp.status_code} after {MAX_TRIES} tries for {url}", resp.status_code)
                    if resp.status_code >= 400:
                        raise HttpError(f"HTTP {resp.status_code} for {url}", resp.status_code)
                    declared = resp.headers.get("Content-Length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise HttpError(f"file is {int(declared):,} bytes, over the {max_bytes:,} byte limit")
                    written = 0
                    with open(part, "wb") as fh:
                        for chunk in resp.iter_bytes(1 << 16):
                            written += len(chunk)
                            if written > max_bytes:
                                raise HttpError(f"file exceeds the {max_bytes:,} byte limit")
                            fh.write(chunk)
                    name = None
                    for r in [*resp.history, resp]:  # SAM's own header first; S3 echoes it with + for spaces
                        name = filename_from_disposition(r.headers.get("Content-Disposition"))
                        if name:
                            break
                part.replace(dest)
                return name
            except httpx.TransportError as exc:
                last_exc = exc
                log.warning("download transport error", extra={"url": redact(url), "attempt": attempt, "error": redact(str(exc))})
                if attempt < MAX_TRIES:
                    sleep(BASE_BACKOFF ** attempt)
                    continue
                raise HttpError(f"transport error for {url}: {exc}") from exc
            finally:
                if part.exists():
                    part.unlink()
        raise HttpError(f"download failed: {last_exc}")  # pragma: no cover


def filename_from_disposition(value: str | None) -> str | None:
    """filename*=UTF-8''... wins over filename="..."; returns the bare name or None."""
    if not value:
        return None
    from urllib.parse import unquote

    m = re.search(r"filename\*\s*=\s*([^']*)'[^']*'([^;]+)", value, re.I)
    if m:
        try:
            return unquote(m.group(2).strip().strip('"'), encoding=m.group(1) or "utf-8") or None
        except LookupError:
            return unquote(m.group(2).strip().strip('"')) or None
    m = re.search(r'filename\s*=\s*"([^"]*)"', value, re.I) or re.search(r"filename\s*=\s*([^;]+)", value, re.I)
    return (m.group(1).strip() or None) if m else None
