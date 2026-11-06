"""One-time move of the standalone app's data into Supabase (`leadfinder migrate-to-supabase`).

Copies every table from the old SQLite file (old, unprefixed table names) into the lf_* tables,
mirrors each lead's document folder to Storage + lf_document / lf_lead_docs / lf_triage_run
(the triage reports are read from the paths recorded in the folder manifests), and moves the
BuildingConnected tokens and triage agent ids into lf_secret. Upserts throughout, so it can be
run again safely. --verify then checks lf_results() against the Python query on the same data."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

from sqlalchemy import MetaData, Table, create_engine, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from leadfinder.db.models import Base

# (new table, old table) in foreign-key order
TABLES = [
    ("lf_source", "source"), ("lf_office", "office"), ("lf_zip_centroid", "zip_centroid"),
    ("lf_place_centroid", "place_centroid"), ("lf_geocode_cache", "geocode_cache"), ("lf_run", "run"),
    ("lf_source_run", "source_run"), ("lf_source_target", "source_target"), ("lf_raw_record", "raw_record"),
    ("lf_opportunity", "opportunity"), ("lf_opportunity_score", "opportunity_score"),
    ("lf_office_distance", "office_distance"), ("lf_lead_review", "lead_review"),
]
BATCH = 100
# Raw payloads are large; keep each INSERT statement modest. LF_MIGRATE_BATCH_BYTES overrides it
# (the PGlite stand-in used for local testing needs very small statements).
BATCH_BYTES = int(os.environ.get("LF_MIGRATE_BATCH_BYTES") or 256_000)


def _batches(rows: list[dict]):
    chunk: list[dict] = []
    size = 0
    for r in rows:
        n = sum(len(v) for v in r.values() if isinstance(v, str))
        if chunk and (len(chunk) >= BATCH or size + n > BATCH_BYTES):
            yield chunk
            chunk, size = [], 0
        chunk.append(r)
        size += n
    if chunk:
        yield chunk


def copy_tables(sqlite_path: Path, pg: Session, echo: Callable[[str], None] = print) -> dict[str, int]:
    src = create_engine(f"sqlite:///{sqlite_path.as_posix()}")
    old_md = MetaData()
    counts: dict[str, int] = {}
    try:
        with src.connect() as conn:
            for new_name, old_name in TABLES:
                new_t: Table = Base.metadata.tables[new_name]
                # Same columns and types (UTC datetimes, JSON) under the old name, for reading.
                old_t = new_t.to_metadata(old_md, name=old_name)
                for fk in list(old_t.foreign_key_constraints):
                    old_t.constraints.discard(fk)
                rows = [dict(r._mapping) for r in conn.execute(select(old_t))]
                if new_name == "lf_opportunity":  # rows another row points at go first
                    rows.sort(key=lambda r: r.get("duplicate_of") is not None)
                pk = [c.name for c in new_t.primary_key.columns]
                for chunk in _batches(rows):
                    stmt = pg_insert(new_t).values(chunk)
                    cols = [c.name for c in new_t.columns if c.name not in pk and c.name in chunk[0]]
                    stmt = stmt.on_conflict_do_update(index_elements=pk,
                                                      set_={c: stmt.excluded[c] for c in cols}) if cols \
                        else stmt.on_conflict_do_nothing(index_elements=pk)
                    pg.execute(stmt)
                pg.commit()
                counts[new_name] = len(rows)
                echo(f"  {new_name:<22} {len(rows):>7,} rows")
    finally:
        src.dispose()
    return counts


def copy_documents(docs_dir: Path, pg: Session, echo: Callable[[str], None] = print) -> int:
    """Mirror every lead folder under docs_dir to Storage and the document tables."""
    from leadfinder import documents as D
    from leadfinder.db.models import Opportunity
    from leadfinder.mirror import mirror_lead
    from leadfinder.storage import Storage

    if not docs_dir.is_dir():
        echo(f"  no documents folder at {docs_dir}")
        return 0
    saved = D.DOCS_DIR
    D.DOCS_DIR = docs_dir  # read the old folders in place
    n = 0
    try:
        with Storage() as storage:
            if not storage.configured:
                echo("  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: listing files without uploading them")
            for folder in D.iter_folders(docs_dir):
                opp_id = D.load_manifest(folder).get("opportunity_id")
                opp = pg.get(Opportunity, opp_id) if opp_id else None
                if opp is None:
                    echo(f"  skipped {folder.name}: no matching lead")
                    continue
                r = mirror_lead(pg, opp, storage)
                echo(f"  {folder.name[:60]:<60} {r['files']:>4} files, {r['uploaded']:>4} uploaded")
                n += 1
    finally:
        D.DOCS_DIR = saved
    return n


def copy_state(data_dir: Path, echo: Callable[[str], None] = print) -> None:
    from leadfinder import kv
    from leadfinder.aps_auth import TokenStore
    from leadfinder.config import offices_config

    tok = data_dir / "aps_token.json"
    if tok.is_file():
        ts = TokenStore(tok).load()
        if ts is not None:
            TokenStore().save(ts)
            echo("  BuildingConnected tokens moved to lf_secret")
    agent = data_dir / "triage_agent.json"
    if agent.is_file():
        kv.set_secret("triage_agent", json.loads(agent.read_text(encoding="utf-8")))
        echo("  triage agent ids moved to lf_secret")
    kv.set_setting("default_radius_miles", int(offices_config().get("default_radius_miles", 100)))


def verify(pg: Session, echo: Callable[[str], None] = print) -> bool:
    """Compare lf_results() with the Python query (web/queries.py) for a few filter sets."""
    from leadfinder.web.queries import Filters, query_results

    admin = pg.execute(text("select id from public.profiles where role = 'admin' limit 1")).scalar()
    if admin is None:
        echo("  no admin profile to run lf_results() as")
        return False
    cases = [
        {},
        {"submitted": "1", "lane": ["direct_av", "likely_av_scope", "none"], "status": "all"},
        {"submitted": "1", "in_range_only": "1", "lane": ["direct_av"], "location_unknown": "1"},
        {"submitted": "1", "in_range_only": "1", "lane": ["direct_av", "likely_av_scope"], "changed": "new_or_updated"},
    ]
    ok = True
    for params in cases:
        f = Filters.from_params(params)
        py = [r.opp.id for r in query_results(pg, f)]
        body = {"office_id": f.office_id, "office_mode": f.office_mode, "in_range_only": f.in_range_only,
                "lanes": f.lanes, "min_score": f.min_score, "status": f.status,
                "due_after": f.due_after.isoformat() if f.due_after else None, "changed": f.changed,
                "review": f.review, "source": f.source, "bb_status": f.bb_status,
                "location_unknown": f.location_unknown}
        pg.execute(text("select set_config('request.jwt.claims', :c, true)"),
                   {"c": json.dumps({"sub": str(admin), "role": "authenticated"})})
        res = pg.execute(text("select public.lf_results(cast(:p as jsonb))"), {"p": json.dumps(body)}).scalar()
        pg.rollback()
        sql = [r["id"] for r in res["rows"]]
        same = py == sql
        ok &= same
        echo(f"  {json.dumps(params)[:70]:<70} python={len(py):>5} sql={len(sql):>5} {'OK' if same else 'DIFFERENT'}")
        if not same:
            echo(f"    only python: {sorted(set(py) - set(sql))[:5]}  only sql: {sorted(set(sql) - set(py))[:5]}")
            if set(py) == set(sql):
                echo("    same rows, different order")
    return ok
