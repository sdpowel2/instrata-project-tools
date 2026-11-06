"""Typer CLI. Every UI action is also available here."""
from __future__ import annotations

import time
from datetime import date
from typing import Optional

import typer

from leadfinder.logging_setup import setup_logging

app = typer.Typer(help="AV Lead Finder CLI", no_args_is_help=True, add_completion=False)


@app.callback()
def _main() -> None:
    setup_logging()


@app.command()
def init(skip_gazetteers: bool = typer.Option(False, help="Skip loading the Census gazetteers")) -> None:
    """Create the database, load the ZCTA and Places gazetteers, seed offices and sources."""
    from leadfinder import gazetteer
    from leadfinder.db.migrate import upgrade
    from leadfinder.db.session import session_scope
    from leadfinder.http import Client
    from leadfinder.pipeline.geocode import load_place_centroids, load_zip_centroids
    from leadfinder.seed import seed_offices, seed_sources, sync_bonfire_targets
    from leadfinder.settings import DATA_DIR

    t0 = time.monotonic()
    DATA_DIR.mkdir(exist_ok=True)
    upgrade()
    typer.echo("Database schema at head.")
    with Client() as client:
        if not skip_gazetteers:
            zips, vintage = gazetteer.zcta(client)
            pl = gazetteer.places(client)
            with session_scope() as s:
                nz = load_zip_centroids(s, zips, vintage)
                npl = load_place_centroids(s, pl)
            typer.echo(f"Loaded {nz:,} ZIP centroids ({vintage}) and {npl:,} place centroids.")
        with session_scope() as s:
            seed_sources(s)
            created = seed_offices(s, client)
            nt = sync_bonfire_targets(s, client)
            for o in created:
                flag = "" if o.geocode_method == "census_address" else "  <-- approximate, check in Offices page"
                typer.echo(f"  office {o.name:<14} {o.geocode_method or 'NOT GEOCODED':<15} {o.geocode_match or ''}{flag}")
        typer.echo(f"Seeded sources, {len(created)} new offices, {nt} Bonfire agencies.")
    typer.echo(f"init finished in {time.monotonic() - t0:.1f}s")


@app.command()
def run(
    source: Optional[list[str]] = typer.Option(None, "--source", help="Limit to these source ids (repeatable)"),
    since: Optional[str] = typer.Option(None, help="Posted-from date YYYY-MM-DD (default: since last success)"),
    until: Optional[str] = typer.Option(None, help="Posted-to date YYYY-MM-DD (default: today)"),
) -> None:
    """Fetch, normalize, locate, score, dedup."""
    from leadfinder.pipeline.run import run as pipeline_run

    result = pipeline_run(
        sources=source or None,
        since=date.fromisoformat(since) if since else None,
        until=date.fromisoformat(until) if until else None,
        trigger="cli",
    )
    for sr in result.source_runs:
        typer.echo(f"  {sr.source_id:<13} {sr.status:<10} fetched={sr.records_fetched} new={sr.records_new} "
                   f"updated={sr.records_updated} calls={sr.api_calls_used}"
                   + (f"  error: {sr.error}" if sr.error else ""))
    typer.echo(f"run {result.id} {result.status}")
    if not source or "sam_gov" in source:
        _sync_docs()
    if result.status == "failed":
        raise typer.Exit(code=1)


def _sync_docs() -> None:
    from leadfinder import documents
    from leadfinder.db.session import session_scope

    def show(opp, r):
        if r["downloaded"] or r["failed"]:
            typer.echo(f"  docs {opp.title[:60]}: {r['downloaded']} new attachment(s)"
                       + (f", {r['failed']} failed" if r["failed"] else ""))

    with session_scope() as s:
        documents.sync_pursued(s, progress=show)


@app.command()
def rescore() -> None:
    """Re-apply config/scoring.yaml to all stored opportunities."""
    from leadfinder.pipeline.run import rescore_all

    n = rescore_all()
    typer.echo(f"Rescored {n} opportunities.")


@app.command()
def reprocess(source: str = typer.Option(..., "--source", help="Source id, e.g. buildingconnected")) -> None:
    """Re-map stored raw payloads for a source (no API calls). Use after a mapping change."""
    from leadfinder.pipeline.run import reprocess_source

    n = reprocess_source(source)
    typer.echo(f"Reprocessed {n} {source} opportunities.")


@app.command()
def export(view: str = typer.Option("default", help="Named filter view")) -> None:
    """Write the CSV of the current filtered view."""
    from leadfinder.web.export import export_view

    path, n = export_view(view)
    typer.echo(f"Wrote {n} rows to {path}")


docs_app = typer.Typer(help="Bid documents for Pursue leads (data/documents/)", no_args_is_help=True)
app.add_typer(docs_app, name="docs")


@docs_app.command("sync")
def docs_sync() -> None:
    """Download new or missing SAM.gov attachments for every Pursue lead."""
    _sync_docs()
    typer.echo("Document sync finished.")


@docs_app.command("fetch")
def docs_fetch(opportunity_id: str, force: bool = typer.Option(False, help="Download every attachment again")) -> None:
    """Download one SAM.gov lead's attachments now (any review status)."""
    from leadfinder import documents
    from leadfinder.db.models import Opportunity
    from leadfinder.db.session import session_scope

    with session_scope() as s:
        opp = s.get(Opportunity, opportunity_id)
        if opp is None:
            raise typer.BadParameter("opportunity not found")
        if opp.source_id != "sam_gov":
            raise typer.BadParameter("only SAM.gov leads can be fetched; for Bid Board use Download all and the drop zone")
        with documents.sam_client() as c:
            r = documents.fetch_sam(s, opp, c, force=force)
        typer.echo(f"{r['links']} attachment(s): {r['downloaded']} downloaded, {r['already']} already here, "
                   f"{r['failed']} failed -> {documents.lead_folder(opp)}")


@docs_app.command("import")
def docs_import(archive: str) -> None:
    """Unpack a .tar of the old data/documents folder into this worker's documents folder and
    record every lead folder in the database (the one-time move onto the Fly volume)."""
    import tarfile
    from pathlib import Path

    from leadfinder import documents
    from leadfinder.db.session import session_scope
    from leadfinder.mirror import mirror_all

    dest = documents.DOCS_DIR
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        prefix = "documents/" if members and all(m.name.startswith("documents") for m in members) else ""
        for m in members:
            if prefix and m.name == "documents":
                continue
            if prefix:
                m.name = m.name[len(prefix):]
        tf.extractall(dest, members=[m for m in members if m.name], filter="data")
    with session_scope() as s:
        n = mirror_all(s)
    typer.echo(f"Imported into {dest}; {n} lead folder(s) recorded.")
    Path(archive).unlink(missing_ok=True)


@docs_app.command("reindex")
def docs_reindex() -> None:
    """Re-record every lead folder in the database (lf_document, lf_lead_docs, lf_triage_run)."""
    from leadfinder.db.session import session_scope
    from leadfinder.mirror import mirror_all

    with session_scope() as s:
        typer.echo(f"{mirror_all(s)} lead folder(s) recorded.")


@docs_app.command("list")
def docs_list() -> None:
    """Pursue leads and how many document files each has."""
    from leadfinder import documents
    from leadfinder.db.session import session_scope

    with session_scope() as s:
        for opp in documents.pursued(s):
            files = [f for f in documents.list_files(documents.lead_folder(opp)) if not f.is_zip]
            typer.echo(f"{opp.id}  {opp.source_id:<17} {len(files):>4} files  {opp.title[:70]}")


triage_app = typer.Typer(help="AV triage of a lead's documents via the Claude API", no_args_is_help=True)
app.add_typer(triage_app, name="triage")


@triage_app.command("setup")
def triage_setup() -> None:
    """Upload the av-triage skill and create (or update) the triage agent. Safe to re-run."""
    import anthropic

    from leadfinder import triage

    try:
        state = triage.setup(log_fn=typer.echo)
    except triage.TriageError as exc:
        raise typer.BadParameter(str(exc))
    except anthropic.APIStatusError as exc:  # billing, permissions: say so plainly
        msg = (exc.body or {}).get("error", {}).get("message") if isinstance(exc.body, dict) else None
        typer.echo(f"Setup stopped: {msg or exc.message} (progress so far is saved; run setup again)", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"Ready: agent {state['agent_id']} v{state['agent_version']}, environment {state['environment_id']}")


@triage_app.command("run")
def triage_run(opportunity_id: str,
               nda_ok: bool = typer.Option(False, "--nda-ok", help="Confirm an NDA invite's documents may be sent"),
               budget: Optional[float] = typer.Option(None, help="Dollar cap for this run (default TRIAGE_BUDGET_USD)")) -> None:
    """Triage one lead's documents now and wait for the report."""
    from leadfinder import triage
    from leadfinder.db.models import Opportunity
    from leadfinder.db.session import session_scope

    with session_scope() as s:
        opp = s.get(Opportunity, opportunity_id)
        if opp is None:
            raise typer.BadParameter("opportunity not found")
        client = triage.make_client()
        job = triage.Job()
        try:
            run = triage.start(s, opp, client, nda_ok=nda_ok, job=job, budget_usd=budget)
        except triage.TriageError as exc:
            raise typer.BadParameter(str(exc))
        typer.echo(f"Session {run['session_id']} started with {run['files']} files; waiting "
                   f"(https://platform.claude.com/workspaces/default/sessions/{run['session_id']})")
        run = triage.wait(opp, run, client, job=job)
        if run["status"] == "done":
            typer.echo(f"{run.get('rating')} · {run.get('tier')} · {run.get('estimate')} · "
                       f"${run.get('cost_usd') or 0:.2f}\nReport: {run['report']}\n\n{run.get('summary') or ''}")
        else:
            typer.echo(f"Failed: {run.get('error')} (cost ${run.get('cost_usd') or 0:.2f})")
            raise typer.Exit(code=1)


office_app = typer.Typer(help="Manage offices (same rules as the Offices page)", no_args_is_help=True)
app.add_typer(office_app, name="office")


@office_app.command("list")
def office_list() -> None:
    """List offices with geocode status and radius."""
    from sqlalchemy import select

    from leadfinder.db.models import Office
    from leadfinder.db.session import session_scope

    with session_scope() as s:
        for o in s.execute(select(Office).order_by(Office.name)).scalars():
            pos = f"{o.lat:.5f},{o.lon:.5f}" if o.lat is not None else "not located"
            typer.echo(f"{o.name:<14} {'active' if o.active else 'INACTIVE':<9} {o.radius_miles:>4} mi  "
                       f"{o.geocode_method or '-':<15} {pos:<22} {o.geocode_match or ''}")


@office_app.command("save")
def office_save(
    name: str,
    street: Optional[str] = typer.Option(None), city: Optional[str] = typer.Option(None),
    state: Optional[str] = typer.Option(None), zip: Optional[str] = typer.Option(None),
    radius: Optional[int] = typer.Option(None, help="Radius in miles (5-500)"),
    lat: Optional[float] = typer.Option(None, help="Manual latitude override"),
    lon: Optional[float] = typer.Option(None, help="Manual longitude override"),
) -> None:
    """Add an office, or update an existing one by name (omitted fields keep their value)."""
    from sqlalchemy import select

    from leadfinder.config import offices_config
    from leadfinder.db.models import Office
    from leadfinder.db.session import session_scope
    from leadfinder.offices import OfficeError, OfficeInput, save_office

    with session_scope() as s:
        cur = s.execute(select(Office).where(Office.name == name)).scalar_one_or_none()
        inp = OfficeInput(
            name=name, street=street or (cur.street if cur else ""), city=city or (cur.city if cur else ""),
            state=state or (cur.state if cur else ""), zip=zip or (cur.zip if cur else ""),
            radius_miles=radius if radius is not None else (cur.radius_miles if cur else int(offices_config().get("default_radius_miles", 100))),
            manual_lat=lat, manual_lon=lon)
        try:
            o, recomputed = save_office(s, inp, cur.id if cur else None)
        except OfficeError as exc:
            raise typer.BadParameter(str(exc))
        typer.echo(f"Saved {o.name}: {o.geocode_method} {o.geocode_match or ''}" + ("; distances recomputed" if recomputed else ""))


@office_app.command("deactivate")
def office_deactivate(name: str) -> None:
    """Deactivate an office (kept, but excluded from distances)."""
    _office_active(name, False)


@office_app.command("activate")
def office_activate(name: str) -> None:
    """Reactivate an office."""
    _office_active(name, True)


def _office_active(name: str, active: bool) -> None:
    from sqlalchemy import select

    from leadfinder.db.models import Office
    from leadfinder.db.session import session_scope
    from leadfinder.offices import set_active

    with session_scope() as s:
        o = s.execute(select(Office).where(Office.name == name)).scalar_one_or_none()
        if o is None:
            raise typer.BadParameter(f"no office named {name!r}")
        set_active(s, o.id, active)
        typer.echo(f"{name} {'activated' if active else 'deactivated'}; distances recomputed.")


@app.command()
def review(opportunity_id: str, status: str = typer.Argument(..., help="new|watch|pursue|pass|already_known"),
           notes: Optional[str] = typer.Option(None)) -> None:
    """Set the review status of an opportunity."""
    from leadfinder.db.models import LeadReview, Opportunity, utcnow
    from leadfinder.db.session import session_scope
    from leadfinder.web.queries import REVIEW

    if status not in REVIEW:
        raise typer.BadParameter(f"status must be one of {', '.join(REVIEW)}")
    with session_scope() as s:
        if s.get(Opportunity, opportunity_id) is None:
            raise typer.BadParameter("opportunity not found")
        rv = s.get(LeadReview, opportunity_id) or LeadReview(opportunity_id=opportunity_id)
        rv.status, rv.reviewed_at = status, utcnow()
        if notes is not None:
            rv.notes = notes
        s.add(rv)
    typer.echo(f"{opportunity_id}: {status}")


@app.command("bc-status")
def bc_status() -> None:
    """Show the BuildingConnected connection (connect/disconnect on the Lead Finder Settings tab)."""
    from leadfinder.aps_auth import ApsAuth
    from leadfinder.http import Client

    with Client() as c:
        auth = ApsAuth(c)
        if not auth.configured:
            typer.echo("Not configured: add APS_CLIENT_ID and APS_CLIENT_SECRET to .env.")
            raise typer.Exit(code=1)
        ts = auth.status()
        if ts is None:
            typer.echo("Configured but not connected: use Connect on the Lead Finder Settings tab in Project Tools.")
            raise typer.Exit(code=1)
        access = {True: "yes", False: "NO (403 - needs Bid Board Pro)", None: "not checked"}[ts.bid_board_access]
        typer.echo(f"Connected as {ts.connected_as or '(unknown)'}; connected {ts.connected_at}; "
                   f"token refreshed {ts.refreshed_at}; Bid Board access: {access}")


@app.command()
def worker(host: str = "0.0.0.0", port: int = 8080) -> None:
    """Run the worker: job queue, daily schedule, /healthz and the BuildingConnected OAuth endpoints."""
    from leadfinder.worker import serve

    serve(host=host, port=port)


@app.command("migrate-to-supabase")
def migrate_to_supabase(
    sqlite: str = typer.Option(..., help="Path to the standalone app's data/leadfinder.db"),
    docs: Optional[str] = typer.Option(None, help="Its data/documents folder (default: next to the database)"),
    skip_documents: bool = typer.Option(False, help="Copy the tables only"),
    verify_only: bool = typer.Option(False, "--verify-only", help="Only compare lf_results() with the Python query"),
) -> None:
    """One-time copy of the standalone app's data into Supabase (DATABASE_URL must point at it). Safe to re-run."""
    from pathlib import Path

    from leadfinder import migrate_sqlite as M
    from leadfinder.db.migrate import upgrade
    from leadfinder.db.session import SessionLocal, get_engine

    if get_engine().dialect.name != "postgresql":
        raise typer.BadParameter("DATABASE_URL must point at the Supabase Postgres database")
    upgrade()
    db = Path(sqlite)
    s = SessionLocal()
    try:
        if not verify_only:
            if not db.is_file():
                raise typer.BadParameter(f"no database at {db}")
            typer.echo("Tables:")
            M.copy_tables(db, s, typer.echo)
            typer.echo("Settings and tokens:")
            M.copy_state(db.parent, typer.echo)
            if not skip_documents:
                typer.echo("Documents:")
                M.copy_documents(Path(docs) if docs else db.parent / "documents", s, typer.echo)
        typer.echo("Verify lf_results() against the Python query:")
        ok = M.verify(s, typer.echo)
    finally:
        s.close()
    if not ok:
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
