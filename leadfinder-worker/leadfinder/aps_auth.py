"""Autodesk Platform Services (APS) 3-legged OAuth for the BuildingConnected API.

Flow: Settings -> "Connect BuildingConnected" -> Autodesk sign-in (the user types their
own password on autodesk.com; this app never sees it) -> /oauth/callback?code=... ->
code exchanged for an access token (1 h) + refresh token. Read-only scope (`data:read`).

APS rotates the refresh token on every refresh, so each new one is saved before it is used.
Tokens live in the lf_secret table (worker-only; no RLS policy, so the tab can't read them) and
are registered with `redact()` so they never reach logs or error messages. A non-secret status
(who connected, when, Bid Board access) is mirrored to lf_setting 'bc_status' for the tab.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

from leadfinder.http import Client, HttpError
from leadfinder import kv
from leadfinder.settings import get_settings, register_secret

log = logging.getLogger(__name__)

AUTHORIZE_URL = "https://developer.api.autodesk.com/authentication/v2/authorize"
TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token"
REVOKE_URL = "https://developer.api.autodesk.com/authentication/v2/revoke"
SCOPE = "data:read"
TOKEN_KEY = "aps_token"
STATUS_KEY = "bc_status"
REFRESH_MARGIN = timedelta(minutes=5)
STATE_TTL_SECONDS = 600

_LOCK = threading.Lock()
_pending_states: dict[str, float] = {}


class ApsNotConfigured(Exception):
    """APS_CLIENT_ID / APS_CLIENT_SECRET missing from .env."""


class ApsNotConnected(Exception):
    """No stored authorization, or Autodesk rejected the refresh token: reconnect in Settings."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str
    expires_at: str            # ISO-8601 UTC
    scope: str = SCOPE
    connected_at: str = ""
    refreshed_at: str = ""
    connected_as: str = ""     # "First Last <email>" from /users/me, display only
    bid_board_access: bool | None = None  # result of the connect-time opportunities probe
    note: str = ""

    @property
    def expires(self) -> datetime:
        return datetime.fromisoformat(self.expires_at)

    def register(self) -> None:
        register_secret(self.access_token)
        register_secret(self.refresh_token)


class TokenStore:
    """Token persistence. Default: the database (lf_secret). With a path: a JSON file (tests)."""

    def __init__(self, path: Path | None = None, session_factory=None):
        self.path = path
        self.session_factory = session_factory

    def _read(self) -> dict | None:
        if self.path is None:
            data = kv.get_secret(TOKEN_KEY, session_factory=self.session_factory)
            return data if isinstance(data, dict) else None
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def load(self) -> TokenSet | None:
        data = self._read()
        if not data:
            return None
        try:
            ts = TokenSet(**{k: v for k, v in data.items() if k in TokenSet.__dataclass_fields__})
        except TypeError:
            return None
        ts.register()
        return ts

    def save(self, ts: TokenSet) -> None:
        ts.register()
        if self.path is None:
            kv.set_secret(TOKEN_KEY, asdict(ts), session_factory=self.session_factory)
            kv.set_setting(STATUS_KEY, public_status(ts), session_factory=self.session_factory)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(ts), indent=2), encoding="utf-8")
        os.replace(tmp, self.path)  # atomic: a crash never leaves a half-written token file

    def clear(self) -> None:
        if self.path is None:
            kv.set_secret(TOKEN_KEY, None, session_factory=self.session_factory)
            kv.set_setting(STATUS_KEY, None, session_factory=self.session_factory)
            return
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def public_status(ts: TokenSet) -> dict:
    """What the tab may see about the connection: no tokens."""
    return {"connected_as": ts.connected_as, "connected_at": ts.connected_at, "refreshed_at": ts.refreshed_at,
            "scope": ts.scope, "bid_board_access": ts.bid_board_access, "note": ts.note}


# ---------------------------------------------------------------- CSRF state

def new_state() -> str:
    now = time.monotonic()
    for k, exp in list(_pending_states.items()):
        if exp < now:
            _pending_states.pop(k, None)
    state = secrets.token_urlsafe(24)
    _pending_states[state] = now + STATE_TTL_SECONDS
    return state


def consume_state(state: str | None) -> bool:
    if not state:
        return False
    exp = _pending_states.pop(state, None)
    return exp is not None and exp >= time.monotonic()


# ---------------------------------------------------------------- auth

class ApsAuth:
    def __init__(self, client: Client, client_id: str | None = None, client_secret: str | None = None,
                 callback_url: str | None = None, store: TokenStore | None = None):
        st = get_settings()
        self.client = client
        self.client_id = client_id if client_id is not None else st.aps_client_id
        self.client_secret = client_secret if client_secret is not None else st.aps_client_secret
        self.callback_url = callback_url or st.aps_callback_url
        self.store = store or TokenStore()

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def _require_config(self) -> None:
        if not self.configured:
            raise ApsNotConfigured("APS_CLIENT_ID and APS_CLIENT_SECRET must be set in .env")

    def authorize_url(self, state: str) -> str:
        self._require_config()
        q = {"response_type": "code", "client_id": self.client_id, "redirect_uri": self.callback_url,
             "scope": SCOPE, "state": state}
        return f"{AUTHORIZE_URL}?{urlencode(q)}"

    def _token_request(self, form: dict) -> dict:
        self._require_config()
        resp = self.client.post(TOKEN_URL, data=form, auth=(self.client_id, self.client_secret),
                                headers={"Accept": "application/json"})
        data = resp.json()
        if not data.get("access_token"):
            raise HttpError("token endpoint returned no access_token")
        return data

    def _tokenset(self, data: dict, previous: TokenSet | None = None) -> TokenSet:
        now = _utcnow()
        refresh = data.get("refresh_token") or (previous.refresh_token if previous else "")
        if not refresh:
            raise HttpError("token endpoint returned no refresh_token (is the app a Traditional Web App?)")
        ts = TokenSet(
            access_token=data["access_token"], refresh_token=refresh,
            expires_at=(now + timedelta(seconds=int(data.get("expires_in") or 3600))).isoformat(),
            scope=data.get("scope") or SCOPE,
            connected_at=previous.connected_at if previous else now.isoformat(),
            refreshed_at=now.isoformat(),
            connected_as=previous.connected_as if previous else "",
            bid_board_access=previous.bid_board_access if previous else None,
            note=previous.note if previous else "",
        )
        ts.register()
        return ts

    def exchange_code(self, code: str) -> TokenSet:
        data = self._token_request({"grant_type": "authorization_code", "code": code,
                                    "redirect_uri": self.callback_url})
        ts = self._tokenset(data)
        self.store.save(ts)
        return ts

    def _refresh(self, ts: TokenSet) -> TokenSet:
        try:
            data = self._token_request({"grant_type": "refresh_token", "refresh_token": ts.refresh_token,
                                        "scope": ts.scope or SCOPE})
        except HttpError as exc:
            if exc.status in (400, 401, 403):
                # Refresh token expired (unused ~15 days), revoked, or the app's secret changed.
                raise ApsNotConnected("BuildingConnected authorization has expired or was revoked; "
                                      "reconnect on the Settings page") from exc
            raise
        new = self._tokenset(data, previous=ts)
        self.store.save(new)  # persist the rotated refresh token before anything else can fail
        return new

    def access_token(self, force_refresh: bool = False) -> str:
        with _LOCK:
            ts = self.store.load()
            if ts is None:
                raise ApsNotConnected("BuildingConnected is not connected; use Connect on the Settings page")
            if force_refresh or ts.expires - REFRESH_MARGIN <= _utcnow():
                ts = self._refresh(ts)
            return ts.access_token

    def status(self) -> TokenSet | None:
        return self.store.load()

    def update_profile(self, connected_as: str | None = None, bid_board_access: bool | None = None,
                       note: str | None = None) -> None:
        with _LOCK:
            ts = self.store.load()
            if ts is None:
                return
            if connected_as is not None:
                ts.connected_as = connected_as
            if bid_board_access is not None:
                ts.bid_board_access = bid_board_access
            if note is not None:
                ts.note = note
            self.store.save(ts)

    def disconnect(self) -> None:
        """Forget the stored tokens and, best effort, revoke the refresh token at Autodesk."""
        with _LOCK:
            ts = self.store.load()
            self.store.clear()
        if ts is None or not self.configured:
            return
        try:
            self.client.post(REVOKE_URL, data={"token": ts.refresh_token, "token_type_hint": "refresh_token"},
                             auth=(self.client_id, self.client_secret))
        except Exception as exc:  # noqa: BLE001 - local disconnect already done
            log.warning("APS token revoke failed", extra={"error": str(exc)[:200]})
