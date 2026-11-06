# AV Lead Finder — Data & Build Spec (POC v1)

Nov 3, 2026 · @Seth Powell

## Purpose and scope

The POC proves one thing: from free sources, we can surface open bids with likely AV scope within a set radius of each Instrata office. The user manages offices (name, address, radius), clicks Run, and gets a filtered list and map of candidate leads. This doc is the build spec for Claude Code.

**In scope (POC v1)**

- Office management: add, edit and deactivate offices, each with an address, geocoded coordinates and its own radius in miles.
- Source adapters: SAM.gov Get Opportunities API (required), Bonfire public agency portals (required), vendor-alert email inbox (optional, build last).
- Normalization of every source into one opportunity record.
- Location resolution and straight-line distance from every opportunity to every active office.
- Rule-based AV relevance scoring that splits results into two lanes: **Direct AV** and **Likely AV scope**.
- Dedup and change detection across runs.
- Web UI with a results table, a map, filters, review status and a CSV export. A CLI drives the same functions.

**Out of scope (later iterations)**

- Downloading and parsing bid documents, such as Division 27 spec sections.
- ML or LLM relevance scoring.
- Pushing results to monday.com or Project Tools, and cross-checking the AV Pre-Sales board automatically.
- Paid feeds (ConstructConnect, Dodge, aggregators). The adapter interface must make these drop-in additions.
- Multi-user auth. The POC is single-user, run locally.

**Success metric:** over a 3–4 week trial, the number of **net-new relevant leads per office per week**. A lead counts as net-new when the reviewer marks it Pursue or Watch and it was not already on the AV Pre-Sales board. The review status field in the data model exists to capture this.

## Decisions and defaults

Build on these defaults unless a row says Open. Open rows need an answer from the user, but they do not block the build: the code treats them as configuration.

| # | Decision | Default for the build | Alternatives considered | Status |
| --- | --- | --- | --- | --- |
| 1 | Language and framework | Python 3.12, FastAPI, SQLAlchemy 2.x, Pydantic v2 | Node/TypeScript | Decided |
| 2 | Database | SQLite file (`data/leadfinder.db`); schema kept Postgres-compatible | Postgres from day one | Decided |
| 3 | UI | Server-rendered Jinja2 + HTMX, Leaflet map with OpenStreetMap tiles | Streamlit; React SPA | Decided |
| 4 | Hosting | Runs locally first. Later deployed to Fly.io next to Project Tools | Monday-hosted app | Decided |
| 5 | Radius model | Radius set per office, default 100 mi, straight-line (great-circle) distance | Drive time; one global radius | Decided |
| 6 | Radius timing | Distances to all offices are stored at ingest; the radius is applied when results are viewed, so changing a radius needs no re-run | Filter at scrape time | Decided |
| 7 | Where results land | Built-in UI + CSV export | monday.com Leads board; Project Tools page | Open (phase 2) |
| 8 | POC sources | SAM.gov + Bonfire required; email alerts optional | Paid aggregator as a bridge | Decided |
| 9 | Office list and radii | 11 offices in `config/offices.yaml` (see Office seed list), all at 100 mi to start | — | Decided; radii tunable in UI |
| 10 | Bonfire agency seed list | Agency slugs in AZ, NJ, MD, VA, NC, SC, listed in `config/sources.yaml` | Crawl all Bonfire agencies | States decided; slug list to build |

If a default turns out wrong during the build, Claude Code should note the change in `DECISIONS.md` in the repo rather than silently diverge.

### Office seed list

`init` loads these 11 offices from `config/offices.yaml`. Every office starts at 100 mi. Three office names differ from their street-address city (Baltimore, Tidewater, Richmond), so the UI shows the office name and geocodes the address.

| Office name | Street | City | State | ZIP | Radius (mi) |
| --- | --- | --- | --- | --- | --- |
| Chandler | 450 N. 54th Street, Suite 4 | Chandler | AZ | 85226 | 100 |
| Trenton | 572 Whitehead Road, Suite 201 | Trenton | NJ | 08619 | 100 |
| Baltimore | 1340 Charwood Rd | Hanover | MD | 21076 | 100 |
| Stuarts Draft | 2412 Stuarts Draft Hwy | Stuarts Draft | VA | 22980 | 100 |
| Tidewater | 5257 Cleveland Street, Suite 101 | Virginia Beach | VA | 23462 | 100 |
| Richmond | 5500 Cox Road, Suite A | Glen Allen | VA | 23060 | 100 |
| Chantilly | 3675 Concorde Parkway, Suite 800 | Chantilly | VA | 20151 | 100 |
| Raleigh | 516 South New Hope Road | Raleigh | NC | 27610 | 100 |
| Charlotte | 5019 West W.T. Harris Boulevard, Suite A | Charlotte | NC | 28269 | 100 |
| Charleston | 5828 Robinson Street | Charleston | SC | 29410 | 100 |
| Myrtle Beach | 1609 Executive Boulevard | Myrtle Beach | SC | 29577 | 100 |

ZIP codes are stored as text so leading zeros survive (08619). The Mid-Atlantic offices sit close together, so most VA and NC leads fall inside several radii. The Results page should therefore filter by nearest office as well as "any office in range".

## Architecture

Adapters fetch; one shared pipeline does all the thinking; the UI only reads and filters stored results.

&#91;embedded content: architecture · 3 sources, 5 pipeline steps, 3 outputs\]

Dashed boxes are optional or later. The Run page and the CLI both call the same `pipeline.run()`. The Offices page writes to the database and triggers a distance recompute, but never a re-scrape.

## Data model

There are ten tables. Raw payloads are kept verbatim so any field can be re-derived later without re-fetching. Distances and scores are stored per opportunity so the UI only filters and never recomputes. Conventions:

- IDs are UUIDv4 text unless noted.
- Timestamps are stored in UTC, ISO 8601.
- List fields are JSON arrays.
- Every table has `created_at` and `updated_at`.

### office

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| name | text, unique | e.g. "Raleigh" |
| street, city, state, zip | text | state = 2-letter code; zip = 5-digit |
| lat, lon | real | from geocoder or manual override |
| geocode\_method | enum | `census_address`, `zip_centroid`, `manual` |
| geocode\_match | text | geocoder's matched address, shown for confirmation |
| radius\_miles | int | default 100, allowed 5–500 |
| active | bool | deactivate instead of delete |

### source

| Field | Type | Notes |
| --- | --- | --- |
| id | text | PK slug: `sam_gov`, `bonfire`, `email_alerts` |
| name | text | display name |
| kind | enum | `api`, `portal`, `email`, `paid_feed` |
| enabled | bool |  |
| daily\_call\_budget | int, nullable | SAM.gov default 8 |
| last\_success\_at | timestamp | drives the default "since" window |

### source\_target

One row per portal-hosted agency (Bonfire slug, later OpenGov and PlanetBids). The agency address is the location fallback for its bids.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| source\_id | fk → source |  |
| slug | text | e.g. `wake` for `wake.bonfirehub.com` (example only) |
| agency\_name | text |  |
| agency\_type | enum | `city`, `county`, `state`, `k12`, `higher_ed`, `special_district`, `other` |
| street, city, state, zip, lat, lon | text / real | geocoded once |
| enabled | bool |  |

### run and source\_run

| Table.Field | Type | Notes |
| --- | --- | --- |
| run.id | uuid | PK |
| run.trigger | enum | `manual`, `scheduled`, `cli` |
| run.status | enum | `running`, `succeeded`, `partial`, `failed` |
| run.window\_from, run.window\_to | date | posted-date window requested |
| run.started\_at, run.finished\_at | timestamp |  |
| source\_run.run\_id, source\_run.source\_id | fk | composite PK |
| source\_run.status | enum | same as run.status |
| source\_run.records\_fetched, records\_new, records\_updated | int |  |
| source\_run.api\_calls\_used | int | counted against the budget |
| source\_run.resume\_cursor | json, nullable | where to continue if the budget ran out |
| source\_run.error | text, nullable | first error, redacted |

### raw\_record

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| source\_id | fk |  |
| source\_record\_id | text | SAM `noticeId`, Bonfire project id, email Message-ID |
| run\_id | fk | run that fetched it |
| payload | json / text | verbatim response item or email body |
| payload\_hash | text | sha256 of payload; skip insert if unchanged |
| fetched\_at | timestamp |  |

### opportunity

This is the normalized record, with one row per source record.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| source\_id, source\_record\_id | text | unique together |
| group\_key | text | dedup key (see Dedup) |
| duplicate\_of | fk → opportunity, nullable | cross-source duplicate |
| solicitation\_number | text, nullable |  |
| title | text |  |
| description | text, nullable | first 4,000 chars if available |
| agency\_name, sub\_agency | text |  |
| notice\_type | enum | `solicitation`, `presolicitation`, `sources_sought`, `combined`, `rfq`, `rfp`, `ifb`, `special`, `award`, `other` |
| naics\_codes | json array |  |
| psc\_code | text, nullable | federal only |
| set\_aside | text, nullable |  |
| posted\_at, response\_due\_at | timestamp | due date with its time zone when known |
| status | enum | `open`, `closed`, `cancelled`, `awarded`, `unknown` |
| url | text | public listing link |
| documents\_url | text, nullable | not downloaded in POC |
| contact\_name, contact\_email, contact\_phone | text, nullable | buyer contact as published |
| loc\_street, loc\_city, loc\_state, loc\_zip | text | as published |
| location\_basis | enum | `place_of_performance`, `agency_address`, `contracting_office`, `none` |
| lat, lon | real, nullable |  |
| geocode\_method | enum | `census_address`, `zip_centroid`, `city_centroid`, `none` |
| content\_hash | text | over normalized fields, for change detection |
| first\_seen\_at, last\_seen\_at, last\_changed\_at | timestamp |  |

### opportunity\_score

| Field | Type | Notes |
| --- | --- | --- |
| opportunity\_id | fk, PK |  |
| lane | enum | `direct_av`, `likely_av_scope`, `none` |
| score | int 0–100 |  |
| matched\_codes, matched\_keywords, negative\_hits | json arrays | shown in the UI as "why" |
| scorer\_version | text | from `config/scoring.yaml` |

### office\_distance

| Field | Type | Notes |
| --- | --- | --- |
| opportunity\_id, office\_id | fk | composite PK; one row per active office |
| distance\_miles | real | 1 decimal |
| is\_nearest | bool | exactly one true per located opportunity |

Recompute this table when an office is added, moved or reactivated. Radius is not stored here; it is applied as `distance_miles <= office.radius_miles` at query time.

### lead\_review

| Field | Type | Notes |
| --- | --- | --- |
| opportunity\_id | fk, PK |  |
| status | enum | `new`, `watch`, `pursue`, `pass`, `already_known` |
| notes | text |  |
| reviewed\_at | timestamp |  |

### Reference tables

- `zip_centroid` (zip PK, lat, lon, vintage): loaded from the Census Bureau ZCTA Gazetteer file during `init`.
- `place_centroid` (state, place\_name, lat, lon): loaded from the Census Places Gazetteer file.
- `geocode_cache` (normalized\_address PK, lat, lon, method, matched\_address, fetched\_at): no address is geocoded twice.

## Source adapters

Every source is a plug-in behind one interface, so paid feeds like ConstructConnect or Dodge drop in later with no pipeline changes. Adapters only fetch and map fields. Geocoding, scoring, distance and dedup live in shared pipeline code.

```python
class SourceAdapter(Protocol):
    source_id: str
    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]: ...
    def normalize(self, raw: RawItem) -> OpportunityDraft: ...
```

Rules that apply to all adapters:

- Call `budget.spend()` before each request. When the budget is exhausted, stop cleanly, save `resume_cursor` and mark the source\_run `partial`.
- Retry 429 and 5xx with exponential backoff, at most 3 tries, honouring `Retry-After`.
- Send a descriptive User-Agent with a contact email from config.
- Put HTTP request/response fixtures in `tests/fixtures/<source>/` so tests never hit the network.

### SAM.gov (required)

- **Endpoint:** `GET https://api.sam.gov/opportunities/v2/search`. Docs: [open.gsa.gov/api/get-opportunities-public-api](https://open.gsa.gov/api/get-opportunities-public-api/).
- **Auth:** a public API key requested from the SAM.gov Account Details page, sent as `api_key` in the query string. Redact it from every log line and stored URL.
- **Required params:** `postedFrom` and `postedTo` in `MM/dd/yyyy` format, with a window of 1 year or less. Use `limit=1000`, the maximum, and page with `offset`.
- **Rate limit:** personal non-federal keys are capped at roughly 10–40 calls per day; reports differ. Default `daily_call_budget = 8`, configurable. The budget is the reason to pull broadly and filter locally.
- **Pull strategy:** one unfiltered pull of everything posted since the last successful run, paginated. Do not filter by NAICS or PSC server-side; that costs one call per code and drops keyword-only matches. A first-time backfill (default 14 days) runs across several days using `resume_cursor`.
- **Description text:** the `description` field is a URL that costs one call per notice. In the POC, fetch it only for opportunities that are Direct AV or Likely AV scope, are within some office's radius, and only while budget remains. Otherwise score on title, codes and agency.
- **Field mapping** (verify names against a live response and record a fixture):

| SAM.gov field | opportunity field |
| --- | --- |
| `noticeId` | source\_record\_id |
| `solicitationNumber` | solicitation\_number |
| `title` | title |
| `fullParentPathName` | agency\_name (first segment), sub\_agency (rest) |
| `type` / `baseType` | notice\_type (mapped) |
| `naicsCode`, `classificationCode` | naics\_codes, psc\_code |
| `typeOfSetAside` | set\_aside |
| `postedDate`, `responseDeadLine` | posted\_at, response\_due\_at |
| `active` | status (`Yes` → open unless due date passed) |
| `uiLink` | url |
| `resourceLinks` | documents\_url (first link) |
| `pointOfContact[0]` | contact\_\* |
| `placeOfPerformance.*` | loc\_\* with basis `place_of_performance` |
| `officeAddress.*` | fallback loc\_\* with basis `contracting_office` |

- **Caveat for the UI help text:** a lot of federal AV buying moves through GSA schedules and BPAs and never appears on SAM.gov.

### Bonfire public portals (required)

- Each agency has a portal at `https://{slug}.bonfirehub.com`. Open opportunities load from a public, no-login JSON endpoint. Third-party tools reference `GET /PublicPortal/getOpenPublicOpportunitiesSectionData`. Claude Code must confirm the current path and response shape in the browser network tab, then record fixtures.
- Iterate over enabled `source_target` rows. Throttle to 1 request every 2 seconds per host. Check `robots.txt` once per host per run.
- Map: project id → source\_record\_id; reference number → solicitation\_number; name → title; close date → response\_due\_at; portal project URL → url.
- Bids usually carry no site address. Use the agency's geocoded address with location\_basis `agency_address`.
- Seed `config/sources.yaml` with 5–10 agency slugs per state that has an office. A helper script `scripts/find_bonfire_agencies.py` can test candidate slugs: a slug is valid if its portal URL returns 200.

### Vendor alert email (optional, build last)

- Many state and local portals email vendors who register under audio-visual commodity codes. These emails go to a dedicated mailbox.
- POC input is IMAP (host, user, app password from env) or a folder of `.eml` files for testing. Microsoft Graph comes later.
- Use one parser per sender domain, with a generic fallback that extracts title, agency, due date and the first portal link. Mark low-confidence parses as `status = unknown`.
- Location: the agency city and state from the email, resolved to a place centroid.

### Planned later (interface must allow)

These are not built in the POC:

- OpenGov Procurement and PlanetBids adapters, using the same `source_target` pattern.
- State eProcurement portals.
- A paid aggregator via Apify as a bridge.
- ConstructConnect and Dodge APIs.
- USASpending awards, used for recompete signals rather than open bids.

## Normalization, geocoding and distance

Every opportunity is located with the most precise data available. Its distance is then computed to every active office. No paid geocoder is used.

**Normalization** runs before location and scoring:

- Trim and collapse whitespace.
- Convert state names to 2-letter codes.
- Cut ZIP+4 to 5 digits.
- Parse dates to UTC; when a source gives no zone, use the agency's state time zone.
- Map notice types to the enum.
- Set status to `closed` when `response_due_at` is in the past.

**Location precedence** (the first one that resolves wins; record `location_basis` and `geocode_method`):

1. Full street address → US Census Bureau geocoder, `onelineaddress` endpoint, `benchmark=Public_AR_Current`, no key needed. Cache the result.
2. ZIP code → `zip_centroid` table.
3. City + state → `place_centroid` table.
4. The source's fallback address (agency or contracting office), resolved by steps 1–3.
5. Nothing resolves → `lat/lon = null`, `geocode_method = none`. The result still appears under a "Location unknown" filter, tagged with any office in the same state.

Offices use step 1, with a manual lat/lon override in the UI when the geocoder misses.

**Distance** is the haversine great-circle distance in statute miles, R = 3958.8:

```latex
d = 2R \arcsin\sqrt{\sin^2\frac{\varphi_2-\varphi_1}{2} + \cos\varphi_1\cos\varphi_2\sin^2\frac{\lambda_2-\lambda_1}{2}}
```

Write one `office_distance` row per located opportunity per active office, and set `is_nearest` on the smallest distance. An opportunity is **in range** when `distance_miles <= radius_miles` for at least one active office.

The UI labels ZIP-centroid and agency-address matches as approximate, because a county agency's bid can be 30+ miles from its office.

## AV relevance scoring

Scoring is rule-based and fully driven by `config/scoring.yaml`, so rules can be tuned without code changes. Each result records *why* it matched. Every opportunity gets a lane and a 0–100 score; `leadfinder rescore` re-applies new rules to stored data.

**Lanes**

- **Direct AV:** the procurement itself is AV, such as equipment, a room upgrade, or AV services. Rule: score ≥ 50.
- **Likely AV scope:** a construction or renovation project for a building type that almost always carries Division 27. Rule: at least one building-type term AND at least one construction term, and not already Direct AV.
- **None:** everything else. These rows are stored but hidden by default.

**Signals and starting weights** (all matching is case-insensitive with word boundaries, unless noted)

| Signal | Matches (seed list) | Weight |
| --- | --- | --- |
| PSC strong | 5830, 5835, 5836 | +60 |
| PSC / service code candidate | 5820, 5895, N058, J058, T016 (verify each against the PSC manual before enabling) | +30 |
| NAICS strong | 334310 | +25 |
| NAICS weak | 238210, 423690 | +5 |
| Keyword strong, in title | audiovisual, audio visual, audio-visual, video conferencing, videoconference, video wall, digital signage, sound reinforcement, public address, assistive listening, lecture capture, AV integration, AV system(s), Crestron, Extron, Q-SYS, Biamp, Division 27, "27 41" | +40 each, cap +60 |
| Keyword strong, in description only | same list | +15 each, cap +30 |
| Keyword medium | projector, projection system, display(s), LED wall, conference room, council chamber, boardroom, auditorium, classroom technology, broadcast, paging, intercom | +10 each, cap +20 |
| Token `AV` or `A/V` | uppercase only, standalone token | +20 |
| Negative | avenue, Ave., aviation, avionics, anti-virus, antivirus, autonomous vehicle, AV-8B, aircraft, fuel, janitorial, landscaping | −50 each |

Cap the final score to 0–100.

**Likely AV scope terms**

- Building types: school, elementary, middle school, high school, university, college, campus, library, courthouse, justice center, city hall, municipal building, county administration, hospital, medical center, clinic, performing arts, auditorium, arena, stadium, convention center, emergency operations center, 911 center, training center, headquarters.
- Construction terms: new construction, renovation, addition, construction manager at risk, CMAR, design-build, GMP, general contractor, bid package, prequalification. NAICS 236220 also counts as a construction term.

Ship a labelled fixture file, `tests/fixtures/scoring_cases.yaml`, with at least 40 real-style titles and their expected lanes. Include traps such as "Pine Ave Paving", "Avionics repair" and "AV-8B parts". The scorer must pass them all.

## Dedup and change detection

Re-running any window must be idempotent: no duplicate rows, and new or changed opportunities flagged correctly.

1. **Same record:** upsert on `(source_id, source_record_id)`. If `payload_hash` is unchanged, update only `last_seen_at`.
2. **Same solicitation, new notice:** SAM.gov issues a new `noticeId` for each amendment. Set `group_key = source_id + ':' + normalized(agency_name) + ':' + normalized(solicitation_number)`. When there is no solicitation number, use the normalized title plus the due date. The UI shows one row per `group_key` (the latest notice) with an "N notices" badge.
3. **Same bid, different sources:** Bonfire and an email alert can describe the same bid. Mark `duplicate_of` when all three of these hold:
   - same `loc_state`
   - agency names match after normalization
   - due dates within 1 day, and title token-set similarity ≥ 90 (rapidfuzz)

   Prefer the more structured source as the primary record: SAM.gov, then portal, then email.
4. **Change flags:** `content_hash` covers title, due date, status, notice type and location. A changed hash sets `last_changed_at`.
   - The UI badge **New** means `first_seen_at` is within the latest successful run.
   - The badge **Updated** means `last_changed_at` is within that run.
5. **Expiry:** a nightly pass (or the start of each run) sets `status = closed` once the due date passes. Closed rows stay in the database and are hidden by default.

## UI and outputs

The UI has five pages. Every action is also available from the CLI.

| Page | What the user does | Key behaviour |
| --- | --- | --- |
| Offices | Add, edit, deactivate offices; set each radius | Geocode on save and show the matched address for confirmation. Manual lat/lon override. Saving a new or moved office recomputes `office_distance`. |
| Run | Pick sources and posted-date window (default: since last success), click Run | Runs in a background task. A live status shows each source's fetched/new/updated counts and API calls used against budget. Only one run at a time. |
| Results | Review candidate leads | Table + map toggle; filters and columns below; set review status inline. |
| Run log | Check what happened | One row per run and source: status, counts, calls used, redacted first error, resume cursor. |
| Settings | Tune without code | Default radius, enabled sources, SAM.gov budget, Bonfire agency list (read from config, editable), scoring config version shown. SAM.gov key status shown as set or missing, never the value. |

**Results filters:**

- Office: any office, a specific office in range, or a specific office as nearest only. In range only (default on).
- Lane (default Direct AV + Likely AV scope); minimum score.
- Status (default open); due after (default today).
- New or updated since last run; review status.
- Location unknown (default off).

**Results columns:** lane badge, score, title (links to source), agency, location + basis (approximate marked), nearest office + distance, due date, posted date, source, New/Updated badge, review status. Default sort is due date ascending.

**Detail drawer:** all fields, matched codes and keywords, distance to every office, notice history for the group, raw payload (collapsed).

**Map:** office markers with radius circles, opportunity pins colored by lane, and pin popups that mirror the row.

**CSV export:** exports the current filtered view, one row per opportunity. Columns:

```csv
lane,score,title,agency,solicitation_number,notice_type,loc_city,loc_state,loc_zip,location_basis,nearest_office,distance_miles,posted_at,response_due_at,status,source,url,review_status,first_seen_at
```

File name follows the user's convention: `AV-Lead-Finder_Leads_v1.csv`, incrementing the version if the file exists.

## Config, secrets, operations and compliance

Secrets live in environment variables only. Everything tunable lives in YAML under `config/`, checked into the repo.

**Environment (`.env`, git-ignored; ship `.env.example`)**

- `SAM_API_KEY`
- `DATABASE_URL`: default `sqlite:///data/leadfinder.db`
- `HTTP_USER_AGENT_CONTACT`: email shown in the User-Agent
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`: only if the email adapter is enabled

**Config files**

- `config/offices.yaml`: seed offices, loaded on `init`. After that the database is the source of truth.
- `config/sources.yaml`: enabled sources, budgets, Bonfire agency slugs with addresses and types.
- `config/scoring.yaml`: lanes, signal lists, weights, thresholds, `scorer_version`.

**Repo layout**

```
leadfinder/
  adapters/   sam_gov.py  bonfire.py  email_alerts.py  base.py
  pipeline/   normalize.py  geocode.py  distance.py  score.py  dedup.py  run.py
  web/        app.py  templates/  static/
  db/         models.py  migrations/   (Alembic)
  cli.py
config/  data/  scripts/  tests/  DECISIONS.md  README.md
```

**CLI (Typer)**

- `leadfinder init`: create the database, load the ZCTA and Places gazetteers, seed offices and sources.
- `leadfinder run [--source sam_gov] [--since 2026-10-20] [--until …]`: fetch, normalize, locate, score, dedup.
- `leadfinder rescore`: re-apply `scoring.yaml` to all stored opportunities.
- `leadfinder export --view default`: write the CSV.
- `leadfinder serve`: start the web UI on `localhost:8000`.

**Operations**

- Runs are manual in the POC. Scheduling is one cron line calling `leadfinder run` (or a Fly scheduled machine later).
- Write structured JSON logs. Redact `api_key` from URLs and never log email bodies.
- Exit non-zero only when every source fails. A partial run still writes what it got.

**Compliance (non-negotiable)**

- Use official APIs where they exist.
- For portals, read only public, unauthenticated pages and endpoints. No logins, no CAPTCHA solving, no paywalled detail pages.
- Honour `robots.txt` and each site's terms. Throttle as specified and identify the client in the User-Agent.
- Keep `raw_record` so every lead traces back to what the source published.
- Store buyer contacts only as published on the listing.

## Acceptance criteria, tests and later iterations

The POC is done when every box below is ticked against a fresh clone with only `.env` filled in.

**Acceptance criteria**

- [ ] `leadfinder init` builds the database and loads both gazetteers, all in under 2 minutes.
- [ ] Offices can be added in the UI. A valid street address geocodes and shows its matched address. Manual override works.
- [ ] A SAM.gov run for a 1-day window completes within the call budget. A second identical run creates zero new rows.
- [ ] A budget-exhausted run is marked `partial`, and the next run resumes from `resume_cursor`.
- [ ] Bonfire runs succeed for every seeded agency, or log a per-agency error without failing the run.
- [ ] Every located opportunity has one `office_distance` row per active office and exactly one nearest.
- [ ] Changing an office radius changes the Results view immediately, without a re-run.
- [ ] The scorer passes 100% of `scoring_cases.yaml`.
- [ ] Results filters, map and detail drawer work. CSV export matches the on-screen filtered view row-for-row.
- [ ] No API key appears in logs, the database or the UI.

**Tests**

- Unit tests: haversine (two points 1° of latitude apart ≈ 69.1 mi; same point = 0), normalization, location precedence, scoring cases, `group_key` and duplicate rules.
- Adapter tests: replay recorded fixtures for SAM.gov and Bonfire, including pagination, a 429 with `Retry-After`, an empty page and a malformed item.
- One end-to-end test: fixtures → `run` → expected opportunities, scores and distances in SQLite.
- Live smoke test (`pytest -m live`, skipped by default): one SAM.gov call and one Bonfire agency.

**Later iterations**

These stay out of the POC but shape the interfaces:

1. Document retrieval: download solicitation files, find Division 27 sections, and extract scope and manufacturer signals.
2. LLM or Jev classifier relevance scoring, alongside the rules.
3. monday.com Leads board push. Auto-flag `already_known` by matching against the AV Pre-Sales board.
4. Hand Pursue leads to the av-triage skill and then the bid pipeline.
5. More adapters: OpenGov, PlanetBids, state portals, then paid feeds (ConstructConnect, Dodge).
6. Upstream signals: building permits, school bond referendums, USASpending recompetes.
