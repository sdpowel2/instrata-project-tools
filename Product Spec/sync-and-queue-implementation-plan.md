# Implementation Plan: Salesforce ↔ monday Sync + Hope's Queue

**Plan for:** `project-tools-sync-and-queue-spec.md` (v1.0) and `monday-build-guide.md` (v1.0)
**Drafted:** October 10, 2026 · **Owner:** Seth Powell
**Status:** Draft for review. No code written yet.

The plan has two kinds of work running side by side:

- **[CODE]** is work Claude builds in this repo.
- **[MANUAL]** is work Seth, Hope, or the other Salesforce admins do by hand in Salesforce, monday, Zapier, Fly, or Supabase.

Each manual task says who does it and which step it blocks. §9 lists every manual task in order, as one checklist.

---

## 0. How this fits the current codebase

What already exists and gets reused:

| Existing piece | How the sync/queue build uses it |
|---|---|
| `mcp-server/` (Node + Express on its own Fly app, CI via `deploy-mcp.yml`) | The pattern for the new engine service: Dockerfile, `fly.toml`, CI workflow, `/healthz`, config loader. The 5 new MCP tools (spec §6.4) go into this server. |
| `monday-webhook` edge function | **Keeps running unchanged.** It assigns `INST-YYYY-NNNN` Project IDs on `create_pulse` and syncs `status9` into `projects`. When the engine creates a pre-sales item, this function stamps the Project ID on it. The engine never writes Project ID (spec §4.4), so the two don't conflict. |
| `projects.monday_presales_item_id` / `monday_postsales_item_id` / `project_code` | Already link each pre-sales item to its post-sales sibling. This likely answers most of **O-5**: the `open_job` auto-close can find the post-sales item through `projects` instead of needing a new link. |
| `monday-backfill`'s `mondayQuery()` retry on `COMPLEXITY_BUDGET_EXHAUSTED` | Port the retry logic into the engine's monday client. |
| `notifications` + Supabase Realtime pattern | Live updates on Hope's dashboard page in Project Tools. |
| `scripts/verify-*.mts` offline harness convention | The model for the reconciler and queue-engine regression tests. |
| `AdminDashboardSection.tsx` cards | Add a small "Hope's Queue" summary card here. |

What's new:

1. A new **sync engine** service (§1). The spec calls it "the Project Tools engine (Fly.io)". Today Project Tools has no long-running backend process: the SPA is static nginx, and server logic is Supabase edge functions.
2. About 15 new database tables (§2).
3. Two new pages in Project Tools: **Hope's Dashboard** and **Sync Admin** (§6).
4. A new monday board (Hope's Queue) and a monday dashboard (Hope – Daily), plus the board edits in the Build Guide.
5. Salesforce configuration: sandbox, integration user, External Client App, Named/External Credential, two Flows.

---

## 1. Architecture decisions (recommendations; see Questions at the end)

### 1.1 Where the engine runs: a new Fly app, `sync-engine/`

**Recommendation:** a new Node/TypeScript service in `sync-engine/`, deployed as its own Fly app `instrata-sync-engine`, with the same layout as `mcp-server/`.

Why not Supabase edge functions:

- The engine needs **in-process schedulers**: a 15-minute queue sweep, an hourly Salesforce sweep, a daily cleanliness snapshot, and a daily dry-run diff.
- It needs a **30-second per-item debounce** on writeback (spec §5.6).
- It needs a **continuous inbox drain worker** (spec §3.4).
- The backfill (1,813 items) can run for several minutes.

Edge functions have wall-clock limits and no memory between calls, so each of these would need a workaround. Every one of them is simple in a long-running Node process.

Why not inside `mcp-server`: that server is interactive and user-scoped, and its OAuth surface is security-sensitive. Mixing in background jobs and service-level database access would blur its security model ("holds no service-role key"). Keep them separate. The MCP server calls the engine over Fly's private network when a tool needs it (for example, `reconcile_opportunity`).

Fly settings:

- `auto_stop_machines = "off"` and exactly **one** machine, because the schedulers must always be running.
- A Postgres advisory lock around each scheduled job, so an accidental second machine can't double-run a sweep.

### 1.2 Database access: dedicated Postgres login role over a direct connection

**Recommendation:** create a least-privilege login role, `sync_engine`, and connect with `pg` through the Supabase connection pooler.

- **Grants:** full access to the new sync/queue tables; `SELECT` on `projects` and `profiles`; nothing else.
- **Why not the service-role key:** PROJECT_DOCS §7 says it must not live in Fly.
- **Why not a minted `mcp_service`-style JWT:** that deepens the dependency on the legacy HS256 secret, which PROJECT_DOCS §8 already flags as a rotation risk.
- **What a direct connection adds:**
  - Real transactions. A reconcile pass writes `sf_link` and `event_log` atomically.
  - `SELECT … FOR UPDATE SKIP LOCKED` for the inbox worker.
  - `LISTEN/NOTIFY`, so the engine reacts immediately when Hope changes a task in Project Tools (§6.1).

### 1.3 Sandbox isolation: a separate Postgres schema for the test environment

The spec's cutover step 1 tests against the `partial` sandbox and a **copy** of the pre-sales board. Project Tools has one Supabase project. If the sandbox engine wrote to the same `sf_link`/`task` tables as production, the two datasets would mix.

**Recommendation:** run a second Fly app, `instrata-sync-engine-staging`, with:

- the same code
- `DB_SCHEMA=sync_sandbox`
- sandbox Salesforce credentials
- the board-copy IDs in its own config tables

The migration creates the sync tables in a schema chosen by a parameter, so `public` and `sync_sandbox` get identical structure. The staging app is destroyed after cutover.

### 1.4 Who can see and edit sync data in Project Tools

Hope needs to edit mapping tables and task status. `profiles.role` is only `admin | member`.

**Recommendation:** add a capability flag, `profiles.is_ops_coordinator boolean`, rather than making Hope a full admin.

- RLS on all sync tables: `is_admin() OR is_ops_coordinator()`.
- Both functions are SECURITY DEFINER, the same pattern as `is_admin()`.
- The `enforce_profile_role_immutable` trigger is extended so users can't set the flag on themselves.

### 1.5 monday API identity and version

- **Identity:** the engine writes to monday as the dedicated **AVSS Integration** user (Build Guide §3). Loop prevention ignores webhook events whose `userId` is that user.
- **API version:** the existing edge functions pin `2024-10`, which is probably past monday's support window by now. Pin the engine to a currently supported version, confirmed at build time. Upgrading the edge functions is a separate task.
- **Webhooks:** registered by the engine itself (`create_webhook`). An idempotent `ensureWebhooks()` runs at startup and lists existing webhooks per board, so nothing is clicked in monday.
- **Webhook auth:** a shared secret in the URL path (spec §9). This is the same pattern `monday-webhook` uses, because the token is a personal or integration token, not an app.

---

## 2. Data model ([CODE] — one migration, run manually in the SQL Editor per house convention)

File: `supabase/migrations/add_sync_and_queue.sql`, written as a function `create_sync_schema(target_schema text)`, then called for `public` (and `sync_sandbox` during testing).

| Table | Spec ref | Notes |
|---|---|---|
| `config_boards` | §2.2 | `board_key` → monday board ID. Rows: `presales`, `postsales`, `programming`, `queue`. |
| `config_field_registry` | §2.1 | `semantic_key`, `board_key`, `monday_column_id`, `type`, `owner`. Seeded with the 15 pre-sales rows from the spec. Post-sales, programming, and queue rows are added when the IDs arrive (O-2). |
| `config_groups` | §2.2 | `board_key` + `group_key` → `monday_group_id`. |
| `config_labels` | §2.2 | `board_key` + `column_semantic_key` + `label_key` → `monday_label_id`. Covers `status9` and the queue status/type labels. |
| `config_cleanliness_rule` | §7 | `board_key`, `semantic_key`, `applies_when` jsonb, `exempt_when` jsonb. |
| `config_settings` | §1 | `SYNC_MODE` lives in a Fly secret (the source of truth). This table records its *observed* value for display only; it isn't editable from the UI, so nobody can flip the engine live by accident. Also holds recurring-report schedules (O-6, O-7) and SLA days (O-3) so they can change without a deploy. |
| `map_business_unit`, `map_win_pct`, `map_sales_rep` | §3.2 | `sf_value`, `monday_label_id`, `active`, `updated_by`, `updated_at`. Seeded per spec. Label IDs are filled in through the admin UI, which reads live labels from monday. |
| `map_stage_action` | §3.2 / §4.6 | `stage` → `action` enum + params jsonb. Seeded with the §4.6 table. |
| `sf_link` | §3.1 | As specified. `sf_line_item_id` unique, `monday_item_id` unique. |
| `task` | §3.3 | As specified, plus `details text`, `monday_dirty boolean` (needs push to monday), and `group_key`. |
| `webhook_inbox` | §3.4 | As specified. Unique `dedupe_hash`. |
| `event_log` | §3.5 | Append-only, enforced by a trigger that rejects UPDATE/DELETE, plus a revoke. Adds `applied boolean` (spec §4.4 uses `applied = false`). Indexed on `(entity_type, entity_id, occurred_at)`, `correlation_id`, and `event_type`. |
| `watermark` | §3.6 | As specified. |
| `cleanliness_snapshot` | §7 | `(date, board_key, field, count)`, unique per day. |

Triggers and functions:

- Mapping and config tables get an audit trigger. Every edit inserts an `event_log` row: `source = 'hope'` or `'admin'`, `entity_type = 'mapping'`, `actor = auth.uid()`.
- A trigger on `task` UPDATE from the app or MCP (not the engine role) sets `monday_dirty = true` and runs `pg_notify('task_changed', id)`.
- `is_ops_coordinator()` SECURITY DEFINER.

RLS:

- Read access for admins and coordinators on everything.
- Write access only to mapping tables, `config_cleanliness_rule`, `config_settings` (except SYNC_MODE), and `task.status`.
- The engine role bypasses RLS through its grants.

PROJECT_DOCS §3 gets a new "Sync & Queue" section.

---

## 3. Phase 1A: the sync engine ([CODE])

### A1. Service scaffold

`sync-engine/` contains:

- `package.json` with express, pg, zod, and luxon (ET scheduling)
- `tsconfig`, `Dockerfile`, `fly.toml`
- `src/config.ts`: env validation; the server refuses to boot on missing secrets
- `src/db.ts`: pool, `search_path` set from `DB_SCHEMA`, advisory-lock helper
- `src/log.ts`
- `GET /healthz` and `GET /status` (last sweep times, inbox depth, mode)

`.github/workflows/deploy-sync-engine.yml` mirrors `deploy-mcp.yml`, with a `FLY_API_TOKEN_SYNC` deploy token.

**`SYNC_MODE` gate:** every outbound write (monday mutation, Salesforce PATCH) goes through a single `writeGate` module. In `dry_run` it logs a `dry_run_write` event with the full intended payload and returns. The gate is the **only** path to the external clients' write methods, which makes it easy to review and to test.

### A2. Salesforce client (`src/salesforce/`)

- **Auth:** OAuth 2.0 **Client Credentials** flow against the External Client App, running as the integration user. The token is cached and refreshed on a 401.
- `query(soql)` with pagination (`nextRecordsUrl`).
- `queryAll(soql)` for deleted records (the OLI-delete fallback; see the Salesforce gotchas in §8).
- `patchLineItem(id, {UnitPrice, Sold_in_Margin__c})`.
- `describePicklist(object, field)`, used to pre-fill the `sf_value` column of the mapping tables.
- A field-name constants module, so the two-margin-field trap (spec §12) is in exactly one place.

### A3. monday client (`src/monday/`)

- GraphQL with the complexity-budget retry ported from `monday-backfill`, and a concurrency cap.
- **Writes:** `change_multiple_column_values` (always `create_labels_if_missing: false`), `create_item`, `archive_item`, `move_item_to_group`, `create_update` with an @mention, plus item reads by ID and by board page.
- **Column value encoders by registry type:**

  | Type | Encoding |
  |---|---|
  | status | `{index}` |
  | dropdown | `{ids:[…]}` |
  | date with time | `{date, time}` in UTC |
  | long text | `{text}` |
  | numbers | string |

- **Webhook management:** `ensureWebhooks()` creates any missing subscriptions; the set is listed in A5.
- **Label introspection:** `getColumnLabels(board, column)` powers config-drift checks and the mapping UI.

### A4. Config layer (`src/config/`)

- Loads registry, groups, labels, and maps into memory. Reloads on `NOTIFY config_changed` and on every sweep.
- Business logic only ever calls `col('presales.due_date')`, `label('presales.status','won')`, and so on. **No raw IDs anywhere outside the seed SQL.** A lint-style test greps `src/` for numeric board IDs and column-ID patterns.
- **Drift check** (startup and every sweep): every configured label ID must still exist on its board. A missing one opens a `sync_failure:config_drift:…` task and marks that column write-blocked in memory.

### A5. Webhook ingress and inbox (`src/ingress/`, `src/worker/`)

**Endpoints:**

- `POST /webhooks/salesforce`: checks `X-AVSS-Secret` (constant-time) → inserts into `webhook_inbox` → returns 200.
- `POST /webhooks/monday/:secret`: answers the `challenge` handshake → checks the path secret → inserts into the inbox → returns 200.

Persist first, process later. The handler never calls an external API.

**Worker:** claims `pending` rows with `SKIP LOCKED`, dispatches by source and event, and marks them `done` or `error`. After N retries, an error opens a `sync_failure:webhook_error:…` task.

**monday subscriptions:**

| Board | Event | Purpose |
|---|---|---|
| Pre-Sales | `change_column_value` (all columns, filtered in code) | Writeback on quoted price / GM%; logging monday edits to Salesforce-owned fields (§4.5); status bounces (§8); Won detection |
| Pre-Sales | `item_archived`, `item_deleted` | `link_state` maintenance |
| Hope's Queue | `change_status_column_value` | Hope's status edits → `task.status` |
| Hope's Queue | `create_item` + `change_specific_column_value` (Task Type) | Adopt hand-made Triage items |
| Post-Sales | `change_specific_column_value` (Project Number) | `open_job` auto-close (the sweep also catches it) |

### A6. Reconciler (`src/reconcile/`)

The core is split into a **pure planner** and an **effects executor**, so the whole decision table is testable offline:

```
plan = planReconcile({ opportunity, avLineItems, link, mondayItem, config, maps })
  → { creates[], fieldWrites[], stageAction?, tasksToOpen[], tasksToClose[], events[] }
execute(plan)  // via writeGate, in one DB transaction for link + events
```

The planner implements:

- **Eligibility to create (§4.3).** Exactly one AV line item (`isAVProduct__c` with a `Technology__c = 'AV'` fallback), the stage is in the creation set, and no link exists. Two or more AV line items open a `multi_av_product` failure task.
- **On create:** the item name is written once, the item goes to the New Requests group, Salesforce-owned fields and `sf_id` are written, the `sf_link` row is inserted, then the stage action runs.
- **Field updates (§4.4).** Compare against `last_synced_values`, not current monday values. A blank Salesforce value never clears monday (it's logged with `applied=false`). A mapping miss opens a failure task, skips that field, and continues with the rest.
- **Win % = 100% → status action Won** instead of writing a label.
- **Stage actions (§4.6)** run only when `StageName` differs from the last synced stage (or on create). Status and `win_loss_notes` are written in **one** `change_multiple_column_values`.
- **Canceled-with-no-price branch:** @mention update (if an engineer is assigned) → archive → `link_state = archived`.
- **Pre-Engineering exception (cutover step 3):** a linked item sitting in the Pre-Engineering group whose stage reaches the creation set is moved to New Requests. This is the only group move the sync makes.
- **Auto-closing `sync_failure` tasks** when an entity+field now reconciles cleanly.
- **Idempotency:** a second run produces zero writes. This is asserted in tests (A13).

**Triggers:**

- The Salesforce webhook enqueues a reconcile for its `opportunity_id`.
- The hourly sweep queries Opportunity and OLI where `SystemModstamp >= watermark − 10 min`, plus `queryAll` for deleted OLIs, and advances the watermark only after the batch succeeds.
- The manual admin endpoint `POST /admin/reconcile/:oppId`.

All events from one pass share a `correlation_id`.

### A7. Writeback (`src/writeback/`)

On a pre-sales change to quoted price or GM%:

1. Debounce 30 seconds per item, in memory and keyed by item. A restart loses at most one pending writeback; the inbox row stays `pending` until the debounce fires, so it's retried.
2. Look up the link. If there isn't one, open `writeback_no_link`.
3. Re-read the OLI. If `Quantity ≠ 1`, open `writeback_quantity`.
4. PATCH `UnitPrice` + `Sold_in_Margin__c`.
5. Log a `writeback` event and auto-close prior writeback tasks for that item.

Events from the integration user are logged and otherwise ignored (loop prevention, §4.7).

### A8. Schedulers (`src/schedule/`)

| Job | Cadence |
|---|---|
| Salesforce safety sweep | Hourly |
| Config drift check | Every sweep |
| Dry-run diff report (A11) | Daily at 6 am ET |
| Queue sweep (1B) | Every 15 min |
| Cleanliness snapshot (1B) | Daily |

Each job runs under an advisory lock and records `last_run` / `last_ok` for `/status`.

### A9. Admin API (internal)

Endpoints on the engine, reached only through Fly private networking (`instrata-sync-engine.internal`) and authenticated with an `ENGINE_INTERNAL_SECRET` plus a forwarded user ID. The MCP server and the app's edge layer use them:

- `POST /admin/reconcile/:opportunityId`
- `POST /admin/backfill` (dry-run flag)
- `POST /admin/preengineering-cleanup` (dry-run flag)
- `GET /admin/monday-labels?semantic_key=…` (for the mapping UI)
- `POST /admin/ensure-webhooks`

The app can't reach Fly's private network from the browser. So **one small new edge function, `sync-admin`**, proxies UI actions (Reconcile now, Refresh labels) to the engine after checking that the caller is an admin or coordinator. It follows the house pattern: secrets stay out of the browser.

### A10. Backfill and cleanup commands (cutover steps 2–3)

**Backfill** reads all 1,813 pre-sales items:

- `00k…` IDs → insert into `sf_link`.
- `006…` IDs → resolve to the opportunity's single AV line item, or open a failure task.
- Blank IDs → left alone. No name matching in v1.

**Baseline decision:** seed `last_synced_values` with **only** `sf.stage` = the opportunity's current stage, and leave the field keys empty.

- Empty field keys mean the first live reconcile writes every non-blank Salesforce value that differs from what's in monday, which is exactly the "fix stale data" outcome. Blank Salesforce values still never clear anything.
- Seeding the stage is required. Without it, the first reconcile would treat every backfilled link as a stage change and replay historical stage actions: archiving old canceled items, @mentioning their engineers, and opening stage-check tasks for years-old deals.

All of these first-pass writes are visible in the dry-run report before anything goes live. Dry run writes its baseline to `sf_link.dry_run_synced_values`, so the live baseline is untouched at the switch.

**Mapping fixes:** a mapping edit doesn't change the opportunity, so the watermark sweep won't revisit it. On `NOTIFY sync_config_changed` for a `map_*` table, the engine re-reconciles the opportunities behind open `sync_failure:unmapped_value:*` tasks for that field.

**Pre-engineering cleanup:** linked items whose opportunity is at Lead or Qualified Opportunity are moved to the Pre-Engineering group. Dry-run first, then live.

### A11. Dry-run diff report (cutover step 4)

A daily job compares:

- (a) the engine's `dry_run_write` events for the day, with
- (b) what Zapier actually wrote, from monday `activity_logs` on the pre-sales board filtered to the Zapier connection's user ID.

The result is stored as a report row and shown in Sync Admin → Dry-Run Report (§6.2):

- Agreements
- Engine-only writes (data Zapier missed, which is the expected big category)
- Zapier-only writes (possible engine bugs)
- Unmapped values

### A12. MCP tools (in `mcp-server/`, new `src/syncTools.ts`)

| Tool | Scope | Implementation |
|---|---|---|
| `queue_list(status?, type?)` | `mcp:read` | Query `task` as the user. RLS limits results to admins and coordinators. |
| `sync_failures_list()` | `mcp:read` | Same, filtered to the failure types. |
| `events_query(entity_id?, type?, since?)` | `mcp:read` | Query `event_log` as the user, with a limit. |
| `queue_set_status(task_id, status)` | `mcp:write` | Update `task.status` as the user. The DB trigger notifies the engine, which pushes to monday. |
| `reconcile_opportunity(opportunity_id)` | `mcp:write` | Checks admin/coordinator, then calls the engine admin API over the private network. |

Also:

- Add the tools to `TOOL_SCOPES`; the server refuses to boot otherwise.
- Update the consent copy in `SCOPE_LABELS`.
- Update the smoke script (33 → 38 tools).
- New MCP secrets: `ENGINE_INTERNAL_URL` and `ENGINE_INTERNAL_SECRET`.

### A13. Tests

New `scripts/verify-sync-reconcile.mts`, an offline harness of fixture opportunities → expected plan. It covers:

- every row of the §4.6 stage table
- blank-never-clears
- a mapping miss on one field while the other fields still write
- multi-AV
- `006…` backfill resolution
- Win 100% → Won
- canceled with and without a price
- re-running the same input → zero writes (idempotency)
- the baseline comparison ignoring a monday hand-edit

`scripts/verify-sync-config-lint.mts`: no raw IDs in `sync-engine/src`.

---

## 4. Phase 1B: Hope's Queue engine ([CODE])

### B1. Task state machine (`src/queue/tasks.ts`, pure)

Functions `openOrReopen(dedupeKey, …)`, `close(mode)`, and `applyHopeStatus(status)`. They implement the §6.1 rules:

- Reopen the *same* row and increment `reopen_count`.
- Track `open_since` and `total_open_seconds`.
- Manual vs. auto close.
- Hope's manual items (no engine key) are only logged.

Every transition writes an `event_log` row.

### B2. Queue board sync (`src/queue/board.ts`)

- Push the task to the Hope's Queue board on create/update and whenever `monday_dirty` is set. Fields: Name, Status, Task Type, Due, Source link, Project, Details, Count, Opened, Reopens, Engine Key.
- **Group placement every sweep:** Today/Overdue, This Week, As Needed, Background, Done (all in ET).
- Hope's status edits come back through the A5 webhook.

### B3. Task generators

| Generator | Hook |
|---|---|
| `sync_failure`, `writeback_*` | Already emitted by 1A. 1B only adds the board push. |
| `stage_check_delivered`, `stage_check_contract` | Emitted by the reconciler's stage actions. Auto-close is evaluated each sweep (item in Follow Up group / status = Won). |
| `won_handoff`, `open_job` | Fired on pre-sales status → Won, whether from the webhook or the engine's own Won write. The engine ignores its own webhook echoes, so it fires these directly when it writes Won. `open_job` closes when the post-sales item (found through `projects.monday_postsales_item_id`, pending O-5) has a Project Number. `due_at` comes from the `config_settings` SLA (O-3); until that's decided, due is null and the task lands in As Needed. |
| `report_pm_weekly` | Every Thursday, due 5 pm ET, keyed by ISO week. |
| `report_presales_weekly`, `report_avss_monthly` | Schedules read from `config_settings` (O-6, O-7). The generator stays off until a value is set. |
| `triage` | Adopts Hope-created items with Task Type = Triage. |
| `data_cleanliness` | A singleton row, created once, with Count updated every sweep. |

### B4. Data-cleanliness counts (`src/queue/cleanliness.ts`)

- Each sweep pages through the pre-sales, post-sales, and programming boards, reading only the registry columns plus group.
- The `config_cleanliness_rule` rows are evaluated with terminal-group and intake-group exclusions and the `exempt_when` clauses (O-8).
- The engine writes the singleton's Count and stores the counts per field.
- A daily `cleanliness_snapshot` row is written for trends.
- **Optional:** also store the actual exception item list (`cleanliness_exception`), so Project Tools can show *which* items without sending Hope to monday. The engine already reads the data, so this is cheap.

### B5. MCP

The queue tools already ship in A12. Nothing new is needed.

---

## 5. Project Tools ↔ monday surface for Hope

Hope gets **two dashboards**, as you asked:

1. **monday "Hope – Daily"** (Build Guide §5). This is where she works day to day.
2. **Project Tools "Hope's Dashboard"**. The engine-side view: sync health, failure triage, mapping fixes, trends, and rework data that monday can't show.

Both read the same `task` table. Status edits in either place sync to the other: monday → webhook → engine; Project Tools → DB trigger → engine → monday.

---

## 6. Project Tools UI ([CODE], `app/`)

### 6.1 Hope's Dashboard: `/ops-queue`

Sidebar entry under Workspace, visible to admins and coordinators.

- **KPI strip:**
  - Overdue
  - Due this week
  - Open sync failures
  - Data cleanliness count per board, with a 30-day sparkline from `cleanliness_snapshot`
  - Engine status chip: **DRY RUN** / **LIVE**, last Salesforce sweep, last webhook received, inbox errors
- **Queue table,** grouped the same way as monday (Today/Overdue → This Week → As Needed → Background → Done):
  - inline status dropdown that writes through to monday
  - task type chip
  - Source deep links (monday item, Salesforce opportunity)
  - details, open time, reopen count
- **Live updates** through a Supabase Realtime subscription on `task`, the same pattern as the notification bell.
- **Failure rows** carry a **"Fix mapping →"** button that opens the matching mapping tab, pre-filtered to the unmapped value.
- **Cleanliness panel:** counts per board and field. If B4's optional list is built, it shows the items, with links to monday where Hope can click "Request Update".
- An **"Hope's Queue" summary card** in `AdminDashboardSection.tsx` links here.

### 6.2 Sync Admin: `/ops-queue/admin`

Tabs:

- **Mappings:** Business Unit, Win %, Sales Rep, Stage Actions.
  - Each row: Salesforce value (pre-filled from the Salesforce picklist describe where possible) → monday label picker (live labels from `GET /admin/monday-labels`, stored by **ID**, displayed by text), plus the active toggle.
  - An "Unmapped values seen" list at the top, built from open failure tasks.
- **Cleanliness Rules:** edit `config_cleanliness_rule` (exemptions, O-8).
- **Schedules & SLAs:** report days (O-6, O-7) and handoff SLA days (O-3).
- **Field Registry / Boards / Labels:** read-only for coordinators, editable by admins. This is where post-sales and programming column IDs go when O-2 is resolved, and where the board-restructure remap happens later.
- **Activity:** `event_log` search by opportunity ID, monday item ID, or type, plus a "Reconcile now" button (through the `sync-admin` edge function).
- **Dry-Run Report:** daily diff from A11 (cutover step 4).

Data layer: `app/src/lib/syncQueue.ts`, fetched on demand and kept out of the global store, like `projectWiki.ts`.

---

## 7. Cutover sequence (spec §11), with code and manual steps interleaved

| Step | Code ready | Manual tasks at this step | Exit criteria |
|---|---|---|---|
| **0. Prereqs** | — | M-1 to M-9 (§9) | Integration identities exist; sandbox refreshed |
| **1. Sandbox build** | A1–A9, A13; migration run in `sync_sandbox`; staging Fly app | M-10 to M-18 | Flows fire → reconcile creates/updates the item on the board copy; a writeback round-trips to the sandbox OLI; percent units confirmed |
| **2. Backfill (prod, dry run)** | A10; migration run in `public`; prod Fly app in `dry_run` | M-19, M-20 | Every `00k` linked; `006` resolved or flagged |
| **3. Pre-Engineering cleanup** | A10 | M-21 (group exists) | Lead/QO items moved (this one is a real write, run deliberately) |
| **4. Prod dry run ≥ 5 business days** | A11, §6.2 Dry-Run Report, Salesforce Flows deployed to prod **pointing at the dry-run engine** | M-22 to M-26 | Daily diffs reviewed; Zapier-only diffs explained |
| **5. Mapping prereqs** | Mapping UI | M-27 to M-30 | Zero unmapped Win % / BU in the dry-run log |
| **6. Switch** | `fly secrets set SYNC_MODE=live` | M-31 to M-34 (same hour) | First live reconcile has zero errors |
| **7. Hope's Queue live** | B1–B4, §6.1 | M-35 to M-42 | Recurring tasks appear; failures route to the board |

**Note on step 4 vs. spec §10.** The Build Guide says to deploy the Flows to production at step 6. But a production dry run needs real Salesforce events, otherwise it only exercises the hourly sweep. **Recommendation:** deploy the Flows at step 4, pointed at the prod engine in `dry_run` mode. Nothing is written while in dry run, so this is safe. The step-6 switch is then only "Zaps off + SYNC_MODE=live".

**Failure visibility during 1A.** The spec delivers the Hope's Queue board in 1B, but failure tasks are generated from step 1 onward. Until the board exists, they show on the Project Tools dashboard (§6.1), which is why §6 ships with 1A. Alternatively, create the monday board early (M-35), so it's ready when 1B code lands.

---

## 8. Gotchas to handle (beyond spec §12)

**Salesforce**

1. **OLI-delete Flows can't make callouts.** A record-triggered flow on delete runs *before* delete, and before-delete flows can't have async paths or callouts. So `AVSS_OppProduct_Changed` can't call out on delete as the spec describes. Options, verified in the sandbox in this order:
   - (a) Deleting a product recalculates `Opportunity.Amount`, which should fire the Opportunity after-update Flow, so the opportunity reconciles anyway.
   - (b) The hourly sweep uses `queryAll` (`IsDeleted = true`) on OLI as a backstop.
   - (c) If (a) doesn't fire, the delete Flow publishes a Platform Event, and a platform-event-triggered Flow makes the callout.
2. **Named/External Credential principal access.** Users running the Flow callout need External Credential Principal Access through a permission set. Confirm in the sandbox whether async paths run as the triggering user or the Automated Process user. If it's the triggering user, the permission set must go to *every* user who edits Opportunities or Products. That's a permission-set-group task.
3. **OLI permissions come from the parent Opportunity.** OpportunityLineItem has no object permissions of its own: editing an OLI needs Edit on the parent Opportunity record. So "edit only UnitPrice and Sold_in_Margin__c" has to be enforced with **field-level security**:
   - Opportunity: Read + Edit, but View All rather than Modify All where possible.
   - Every other Opportunity and OLI field: read-only.
   - Sharing access to every opportunity.
4. **Connected Apps vs. External Client Apps.** Recent Salesforce releases steer new integrations to **External Client Apps**, and creating a new Connected App may be disabled by default. Build an External Client App with the Client Credentials flow.
5. **Sandbox → prod deployment.** Flows and the Named Credential deploy through a change set. External Credential principal secrets and the External Client App's consumer secret **don't** move with it; re-enter them in prod.
6. **Partial Copy sandbox template.** It must include Opportunity, OpportunityLineItem, Product2, PricebookEntry, Pricebook2, User, and Account so the board copy's `sf_id` values resolve. Partial Copy keeps production record IDs.

**monday**

7. **A duplicated board copies its automations.** The pre-sales board copy used for testing will carry the Won → duplicate-to-Post-Sales automation and the leadership notifications. **Disable them on the copy**, or sandbox tests create real post-sales items and email leadership.
8. When the engine creates an item in live mode, `monday-webhook` stamps a Project ID on it. That write echoes to the engine as a non-integration-user column change and gets logged. This is harmless and expected.
9. Engine Won writes also trigger the Won → Post-Sales duplication and the leadership notification. That's intended, but it means the first live hour may send a burst of notifications if backfill Won writes are pending. Review the dry-run report for Won writes before switching.
10. Leaving `MONDAY_API_TOKEN` in the edge functions as Seth's token works. Optionally switch it to the AVSS Integration token too, so all automated writes show one name.

---

## 9. Manual task checklist (in order)

**Owners:** S = Seth, H = Hope, A = other Salesforce admins, PS = pre-sales team. "Blocks" gives the cutover step or code workstream.

### Phase 0: Prereqs (before any build testing)

| # | Owner | Task | Blocks |
|---|---|---|---|
| M-1 | S | Email the other Salesforce admins: confirm nobody is using the `partial` sandbox (O-1). | Step 1 |
| M-2 | S | Check the Partial Copy **sandbox template** includes the objects in §8.6, then **refresh** `partial`. Login: test.salesforce.com, username + `.partial`. | Step 1 |
| M-3 | S | monday: get a seat for the **AVSS Integration** user (or decide to use your token). Give it access to Pre-Sales, Post-Sales, Programming, and (later) Hope's Queue, and to the board copy. Generate its API token. Note its monday **user ID**. | A3, A5 |
| M-4 | S | Create the Fly apps `instrata-sync-engine-staging` and `instrata-sync-engine` (`fly apps create`), and a deploy token `FLY_API_TOKEN_SYNC`, added as a GitHub repo secret. | A1 |
| M-5 | S | Supabase: run the new migration in the SQL Editor (Claude writes it; you run it): first `sync_sandbox`, later `public`. Create the `sync_engine` login role password and note the pooler connection string. | A1 |
| M-6 | S | Set Fly secrets on staging (Claude gives you the exact command): `DATABASE_URL`, `DB_SCHEMA=sync_sandbox`, `SYNC_MODE=dry_run`, `MONDAY_API_TOKEN`, `MONDAY_INTEGRATION_USER_ID`, `MONDAY_WEBHOOK_PATH_SECRET`, `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_WEBHOOK_SECRET`, `ENGINE_INTERNAL_SECRET`. | A1 |
| M-7 | S | Set `is_ops_coordinator = true` on Hope's profile (she needs a Project Tools account first). | §6 |
| M-8 | S | Document the three Zaps: what each one triggers on and writes, and **which monday user they act as**. The dry-run diff (A11) needs that user ID. | A11 |
| M-9 | S | Answer the open questions at the end of this doc. | Design |

### Step 1: Sandbox build (Salesforce + board copy)

| # | Owner | Task |
|---|---|---|
| M-10 | S | **Integration user** in the sandbox: "Salesforce Integration" user license + "Salesforce API Integration" permission set license. Create a permission set `AVSS_ProjectTools_Integration` with Opportunity Read/Edit + View All, read-only FLS everywhere except OLI `UnitPrice` and `Sold_in_Margin__c` (edit). See §8.3. |
| M-11 | S | **External Client App** `AVSS Project Tools`: enable OAuth, Client Credentials flow, run-as = the integration user, scopes `api` + `refresh_token`. Send Claude the consumer key and secret to put in Fly secrets (you run the `fly secrets set` yourself). |
| M-12 | S | **External Credential + Named Credential** `AVSS_ProjectTools`: base URL = the **staging** engine host, custom header `X-AVSS-Secret` = `SF_WEBHOOK_SECRET` (stored as an External Credential principal parameter). |
| M-13 | S | Permission set granting **External Credential Principal Access**, assigned to whoever the async Flow runs as (§8.2). Test with a non-admin sales user. |
| M-14 | S | **Flow `AVSS_Opportunity_Changed`**: Opportunity, after create/update, no entry condition, **Run Asynchronously** path, HTTP Callout action POST `/webhooks/salesforce` with body `{"object":"Opportunity","record_id":…,"opportunity_id":…}`. |
| M-15 | S | **Flow `AVSS_OppProduct_Changed`**: OLI, after create/update, async callout with `opportunity_id = $Record.OpportunityId`. For **delete**, test §8.1(a) first. If deleting a product doesn't fire the Opportunity Flow, build the Platform Event variant (c); Claude will write up the exact steps. |
| M-16 | S | monday: **duplicate the Pre-Sales board** (structure + items) as "Pre-Sales SANDBOX COPY". **Turn off every automation on the copy** (§8.7). Send Claude the copy's board ID. |
| M-17 | S | Pick 5–10 sandbox opportunities that cover the test matrix (AV/no AV, multi-AV, each stage, canceled with/without price, multi-quantity line). Claude provides the matrix. |
| M-18 | S | Test with Claude: edit those opportunities in the sandbox and watch the board copy plus the Project Tools Activity tab. Confirm GM% **percent units** on one OLI (spec §5.4). |

### Steps 2–4: Prod backfill and dry run

| # | Owner | Task |
|---|---|---|
| M-19 | S | Run the migration in `public`. Set prod Fly secrets (prod Salesforce credentials, `DB_SCHEMA=public`, `SYNC_MODE=dry_run`). |
| M-20 | S | Repeat M-10 to M-13 in **production** Salesforce (integration user, External Client App, credentials pointing at the **prod** engine, permission sets). |
| M-21 | S | monday Pre-Sales: add the **Pre-Engineering** group below Declined to Bid (Build Guide §2.2) → send the group ID. Approve the cleanup run. |
| M-22 | S | monday Pre-Sales: add the **Win/Loss Notes** long-text column (§2.1) → send the column ID. |
| M-23 | S | monday Pre-Sales: confirm or create the status → group automations: Won, Lost, Declined to Bid, Follow Up (§2.3). |
| M-24 | S | Deploy both Flows to production through a change set (§8.5), pointing at the prod engine in dry run. Re-enter the secrets. |
| M-25 | S | Turn on Field History Tracking for `StageName`, `Estimate_Due_Date_Time__c`, `Estimate_Number__c` (`Win_Likelihood__c` is already on). |
| M-26 | S | Review the Dry-Run Report daily for at least 5 business days. Flag anything in "Zapier-only". |

### Step 5: Mapping prerequisites (label cleanup, Build Guide §1)

| # | Owner | Task |
|---|---|---|
| M-27 | S/H | Win %: rename "0" → "0%", add "99%", reassign the "High" items, then deactivate "High". Don't add 100%. |
| M-28 | S/H | Sales Person: reassign "c"/"doug"/"TON" items, then deactivate those labels. Add Johnny Price, Scott Woodlief, Jerry Bates, David Poore, Rithom Success, and anyone else the dry-run log lists. Keep "House". |
| M-29 | H | Fill the mapping tables in Sync Admin (labels are chosen from a picker, so there are no IDs to copy by hand). Clear every unmapped value in the dry-run log. |
| M-30 | S/H | (Optional, any time) BU rename to Northeast/Mid-Atlantic/Southeast/Southwest. **The same day:** update `map_business_unit`, and update the avss-monthly-report skill and any dashboards or filters that use the "Instrata XX" text. |

### Step 6: Switch (same hour)

| # | Owner | Task |
|---|---|---|
| M-31 | S | Turn off all three Zaps. |
| M-32 | S | `fly secrets set SYNC_MODE=live -a instrata-sync-engine` (restarts the engine). Watch `/status` and the Activity tab for the first live reconcile. |
| M-33 | S | Update the "Won" leadership notification (Salesperson, Quoted Price, GM%, BU) and create the new "Lost" notification that includes Win/Loss Notes (§2.4). Doing this just before the switch is fine. |
| M-34 | S | Tell the pre-sales team that the Follow Up toggle is retired: any price or GM% change now pushes automatically (§2.5). |

### Step 7: Hope's Queue (Phase 1B)

| # | Owner | Task |
|---|---|---|
| M-35 | S | Create the **Hope's Queue** board (Build Guide §4): columns, exact status labels, the Task Type dropdown, and groups in order. **No automations.** Hide Engine Key. Send Claude the board, column, group, and label IDs. *(Claude can build this through the monday connector with your approval; see Questions.)* |
| M-36 | S | Send the Post-Sales and Programming board IDs and column IDs for the cleanliness fields and Project Number (O-2). |
| M-37 | S | Decide O-3 (handoff SLA), O-5 (open-job trigger), O-6 (pre-sales report day), O-7 (monthly report day). Enter them in Sync Admin → Schedules. |
| M-38 | S/H | Decide the O-8 exemptions; Hope enters them in Cleanliness Rules. |
| M-39 | S | Create the "Data Cleanliness" saved view on each of the three boards (Build Guide §6.1). |
| M-40 | S | Add a "Request Update" button column plus its notify automation on each of the three boards (§6.2). |
| M-41 | S/H | Build the monday dashboard **"Hope – Daily"** (§5): battery, Overdue, Sync Failures, the queue table, 3 cleanliness numbers, and 3 cleanliness tables. *(Can also be built through the connector.)* |
| M-42 | S | (Separate from this build) Add the "Stuck" status on Post-Sales (Build Guide §7). |

### After go-live

- Destroy `instrata-sync-engine-staging`, drop the `sync_sandbox` schema, and archive the board copy.
- Rotate `SF_WEBHOOK_SECRET` and `MONDAY_WEBHOOK_PATH_SECRET` once, to exercise the rotation runbook.

---

## 10. Build order and rough sizing

| # | Workstream | Size | Depends on |
|---|---|---|---|
| 1 | Migration + RLS + `is_ops_coordinator` (§2) | M | — |
| 2 | Engine scaffold, writeGate, config layer (A1, A4) | M | 1 |
| 3 | Salesforce + monday clients (A2, A3) | M | M-3, M-10/11 for live testing |
| 4 | Pure reconcile planner + harness (A6 core, A13) | L | 2 (no external deps; can start first) |
| 5 | Ingress/inbox/worker, executor, writeback, sweeps (A5–A8) | L | 3, 4 |
| 6 | Admin API, `sync-admin` edge fn, MCP tools (A9, A12) | M | 5 |
| 7 | Sync Admin UI + Hope's Dashboard skeleton (§6) | L | 1, 6 |
| 8 | Backfill, cleanup, dry-run diff (A10, A11) | M | 5, M-8 |
| 9 | Queue engine + board sync + generators + cleanliness (B1–B4) | L | 5, M-35, M-36 |
| 10 | Docs: PROJECT_DOCS §3/§4/§5/§6/§7/§8, new §"Sync Engine", changelog | S | each step |

**Suggested PR slices:**

1. Schema
2. Engine core + planner + harness (dry-run only, no webhooks)
3. Ingress + writeback + sweeps
4. Admin UI + MCP
5. Backfill/diff
6. Queue engine
7. Hope's Dashboard polish

Each slice is shippable in dry run.

---

## 11. Phase 2 / later (not in this plan)

- Morning brief (likely a Claude skill over `queue_list`; O-11)
- Salesforce-triggered triage
- Rework reporting UI (the data is captured from day one, §8 of the spec)
- Auto-ping for data cleanliness (O-10)
- SE accounting job-opening flow (O-9)
- CMIC
- Drift-check skill
- monday board restructure (absorbed by the config tables)
