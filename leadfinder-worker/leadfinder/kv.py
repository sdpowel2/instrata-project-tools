"""Small key/value state in the database.

lf_secret  worker-only (no RLS policy): BuildingConnected OAuth tokens, triage agent ids.
lf_setting readable by the tab: default radius, worker status, BuildingConnected status.

Each call uses its own short session so callers (token refresh, triage setup) don't have to
thread one through."""
from __future__ import annotations

from typing import Any, Callable

from sqlalchemy.orm import Session

from leadfinder.db.models import Secret, Setting, utcnow

SessionFactory = Callable[[], Session]


def _factory(session_factory: SessionFactory | None) -> SessionFactory:
    if session_factory is not None:
        return session_factory
    from leadfinder.db.session import SessionLocal
    return SessionLocal


def _get(model, key: str, default: Any, session_factory: SessionFactory | None) -> Any:
    s = _factory(session_factory)()
    try:
        row = s.get(model, key)
        return default if row is None else row.value
    finally:
        s.close()


def _set(model, key: str, value: Any, session_factory: SessionFactory | None) -> None:
    s = _factory(session_factory)()
    try:
        row = s.get(model, key)
        if value is None:
            if row is not None:
                s.delete(row)
        elif row is None:
            s.add(model(key=key, value=value, updated_at=utcnow()))
        else:
            row.value = value
            row.updated_at = utcnow()
        s.commit()
    finally:
        s.close()


def get_secret(key: str, default: Any = None, session_factory: SessionFactory | None = None) -> Any:
    return _get(Secret, key, default, session_factory)


def set_secret(key: str, value: Any, session_factory: SessionFactory | None = None) -> None:
    """Store a value; None deletes the key."""
    _set(Secret, key, value, session_factory)


def get_setting(key: str, default: Any = None, session_factory: SessionFactory | None = None) -> Any:
    return _get(Setting, key, default, session_factory)


def set_setting(key: str, value: Any, session_factory: SessionFactory | None = None) -> None:
    _set(Setting, key, value, session_factory)
