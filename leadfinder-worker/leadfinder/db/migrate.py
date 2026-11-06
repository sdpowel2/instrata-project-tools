"""Schema setup.

Postgres (Supabase, production): the schema is supabase/migrations/add_lead_finder.sql at the
Project Tools repo root, run in the Supabase SQL Editor. The worker never creates or alters
tables there; upgrade() only checks they exist.

SQLite (local experiments, tests): created from the models."""
from __future__ import annotations

from sqlalchemy import create_engine, inspect

from leadfinder.db.models import Base
from leadfinder.settings import get_settings


class SchemaMissing(RuntimeError):
    pass


def upgrade(url: str | None = None) -> None:
    url = url or get_settings().resolved_database_url
    engine = create_engine(url)
    try:
        if engine.dialect.name == "sqlite":
            Base.metadata.create_all(engine)
            return
        have = set(inspect(engine).get_table_names(schema="public"))
        missing = sorted(set(Base.metadata.tables) - have)
        if missing:
            raise SchemaMissing("Run supabase/migrations/add_lead_finder.sql in the Supabase SQL Editor first; "
                                f"missing tables: {', '.join(missing)}")
    finally:
        engine.dispose()
