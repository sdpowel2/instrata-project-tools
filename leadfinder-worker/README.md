# AV Lead Finder worker

Surfaces open bids with likely AV scope within a set radius of each Instrata office (SAM.gov and the BuildingConnected Bid Board). It is the engine behind the admin-only **Lead Finder** tab in Project Tools (`/lead-finder`). See `docs/` for the original build spec and **`DECISIONS.md` for every deviation from it** (read D-9, D-12 and D-21 first).

## How it fits together

| Piece | Where |
| --- | --- |
| Data | Supabase Postgres, `lf_*` tables (`supabase/migrations/add_lead_finder.sql`), admin-only RLS |
| UI | Project Tools, `app/src/pages/LeadFinderPage.tsx` (Leads, Run, Offices, Run log, Settings) |
| Engine | This package, run as the Fly app `instrata-leadfinder` (`leadfinder worker`) |
| Bid documents | Worker volume `/data/documents/` only; the tab uploads and downloads through the worker |

The tab reads the tables and the `lf_results()` RPC directly and queues work in `lf_job` (runs, SAM attachment downloads, uploaded files, rescans, triage, office saves). The worker claims jobs, mirrors progress back over realtime, runs every enabled source each morning at 06:00 Eastern, and serves the BuildingConnected OAuth callback.

## Local setup (Windows)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
copy .env.example .env   # DATABASE_URL etc.; leave DATABASE_URL empty for a local SQLite file
.\.venv\Scripts\leadfinder init       # SQLite: creates tables. Postgres: checks the schema, loads gazetteers, seeds
.\.venv\Scripts\leadfinder worker     # http://localhost:8080/healthz
```

## Commands

| Command | What it does |
| --- | --- |
| `leadfinder worker` | The worker: job queue, daily run, `/healthz`, `/bc/authorize`, `/oauth/callback` |
| `leadfinder init` | Check the schema (create it on SQLite), load the Census gazetteers, seed offices, sources and Bonfire agencies |
| `leadfinder run [--source sam_gov] [--since YYYY-MM-DD] [--until YYYY-MM-DD]` | Fetch, normalize, locate, score, dedup. Default window: since each source's last success |
| `leadfinder rescore` | Re-apply `config/scoring.yaml` to stored opportunities |
| `leadfinder reprocess --source buildingconnected` | Re-map stored raw payloads after a mapping change (no API calls) |
| `leadfinder export [--view default\|all_open]` | Write `exports/AV-Lead-Finder_Leads_vN.csv` (the tab has its own Export CSV) |
| `leadfinder office list \| save NAME … \| deactivate NAME \| activate NAME` | Manage offices |
| `leadfinder review OPPORTUNITY_ID STATUS [--notes …]` | Set review status |
| `leadfinder triage setup \| run OPPORTUNITY_ID [--nda-ok]` | Upload the av-triage skill and create the agent; triage one lead from the command line |
| `leadfinder docs sync \| fetch OPPORTUNITY_ID \| list` | Bid documents on the worker's disk |
| `leadfinder bc-status` | Show the BuildingConnected connection |
| `leadfinder migrate-to-supabase --sqlite PATH [--verify-only]` | One-time copy of the standalone app's SQLite data, documents, tokens and triage ids into Supabase, then a check of `lf_results()` against the Python query |

## Deploy

**Interim Fly deploy: leads only.** Until the worker moves to the company Docker host, it runs on Fly with no volume and `DOCUMENTS_ENABLED=false`: fetching, scoring, offices, reviews, the run log, map and CSV all work; bid documents (SAM attachment downloads, uploads, downloads) and triage are switched off, and the tab hides them. To turn them back on: mount persistent disk at `LEADFINDER_DATA_DIR`, set `DOCUMENTS_ENABLED=true`, add `ANTHROPIC_API_KEY`, and load the old documents with `leadfinder docs import` (below). Secrets are staged by `scripts/set-fly-secrets.ps1`.

`fly.toml` lists the secrets and the volume. Pushes to `main` that touch `leadfinder-worker/` run the tests and deploy (`.github/workflows/deploy-leadfinder.yml`, secret `FLY_API_TOKEN_LEADFINDER`). By hand: `fly deploy --remote-only` from this directory.

### Bid documents

Each lead with documents has a folder on the worker's volume, `/data/documents/<title>__<id>/`; `lf_document` lists the files for the tab. Documents are not in Supabase Storage (the free plan caps files at 50 MB and storage at 1 GB): the tab uploads with `POST /documents/<lead>/upload` and opens files through 5-minute signed links from `POST /documents/<lead>/link`, both checked against the signed-in admin's Supabase token.

- **SAM.gov:** marking a lead **Pursue** queues a download of its attachments (a database trigger). Every run afterwards fetches attachments that amendments add. Up to 500 MB per file.
- **BuildingConnected:** the API has no endpoint for invite files. Use **Open in Bid Board → Files → Download all** and drop the zip on the lead's drop zone in the tab.
- **Anything else:** drop files on the drop zone. They land in `/data/inbox/<lead>/` and an `ingest_upload` job moves them into the folder and unpacks zips.

Zips are unpacked beside themselves, nested zips one level deep, with safe paths, a 10,000-file limit and an 8 GB limit. The volume is the only copy: Fly keeps daily snapshots for 5 days (`fly volumes snapshots list`). To load documents onto a new volume, tar the `documents` folder, `fly ssh sftp shell` → `put`, then `leadfinder docs import /data/documents.tar` (`docs reindex` re-records folders already there).

### Triage (Claude API)

**Run triage** on a lead sends its files to Claude Managed Agents and runs the av-triage skill from `Skills/` on them.

- **Setup:** `ANTHROPIC_API_KEY` on the worker. The first triage uploads the skill and creates the agent and sandbox; their ids are kept in `lf_secret`. After editing the skill, deploy and run `leadfinder triage setup` (`fly ssh console`).
- **Sandbox:** no internet access; the files are mounted read-only as `PROJECTS/<Project>/`.
- **Output:** the report is stored in `lf_triage_run.report_md` (shown in the tab) and on the volume under `CLAUDE OUTPUTS/<Project>/Wiki/`.
- **Cost:** each run is capped at `TRIAGE_BUDGET_USD` (default $10). Uploaded copies are deleted from Anthropic's file storage afterwards.
- **NDAs:** Bid Board invites marked NDA-required need a confirmation tick first.
- **Restarts:** a session still running when the worker restarts is picked up again (a `triage_resume` job).

## Source status

| Source | Status |
| --- | --- |
| SAM.gov | Working. Verified live 2026-11-03: ~1,100–1,250 notices/day ≈ 2 calls/day at `limit=1000`. Default budget 8 calls/day, enforced across runs. |
| BuildingConnected (Bid Board Pro) | Built, read-only (D-17). Needs `APS_CLIENT_ID`/`APS_CLIENT_SECRET` on the worker and a one-time **Connect** on the Lead Finder Settings tab by a Bid Board Pro user (sign-in on autodesk.com). First live pull 2026-11-03: 620 open invites (455 projects); see D-18. |
| Bonfire | **Blocked.** Every `*.bonfirehub.com` portal serves `robots.txt: Disallow: /`. The adapter is built and tested, but it checks robots.txt and refuses. It ships disabled (D-12). |
| Vendor-alert email | Built with a generic parser. Reads `.eml` files from `data/email_inbox/`, or IMAP if `IMAP_*` is set. Disabled until a mailbox exists. |

## Acceptance criteria of the standalone POC (checked 2026-11-03)

| Criterion | Result |
| --- | --- |
| `init` builds DB + both gazetteers in < 2 min | ✅ 5 s on a fresh clone |
| Offices: add in UI, geocode shows matched address, manual override | ✅ (web test + live CLI check). Raleigh misses the Census geocoder → ZIP centroid until a manual lat/lon is set |
| SAM.gov 1-day run within budget; identical re-run creates zero rows | ✅ live: 2 calls for 1,136 notices; re-run 0 new / 0 updated for the first 1,000 already stored; fixture e2e test |
| Budget-exhausted run is `partial`; next run resumes from cursor | ✅ fixture e2e test |
| Bonfire succeeds or logs per-agency errors without failing the run | ✅ logs per-agency robots.txt errors (source `failed` only when all agencies fail) |
| One `office_distance` row per active office, exactly one nearest | ✅ verified on live DB (1,118 located opportunities, 0 violations) |
| Changing a radius changes Results immediately | ✅ radius applied at query time (web test) |
| Scorer passes 100% of `scoring_cases.yaml` | ✅ 59/59 |
| Filters, map, drawer work; CSV matches screen row-for-row | ✅ web tests + live smoke test |
| No API key in logs, DB or UI | ✅ grep of DB, server log, repo, all pages |

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest            # 173 offline tests, fixtures only
.\.venv\Scripts\python.exe -m pytest -m live    # 1 SAM.gov call + Bonfire robots.txt re-check
```

Fixtures: `tests/fixtures/sam_gov/` holds a real recorded response (key redacted) plus items derived from it; `scripts/build_sam_fixtures.py` regenerates them. The Bonfire, email and BuildingConnected fixtures are synthetic (BuildingConnected follows the APS API reference schema).

## Caveat

A lot of federal AV buying moves through GSA schedules and BPAs and never appears on SAM.gov.
