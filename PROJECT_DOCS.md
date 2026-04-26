# Instrata Project Tools — Project Documentation

> Internal tooling suite for Instrata Sound & Security covering pre-sales bid leveling, post-sales project execution, submittals, closeouts, cutsheet management, auto-review, and director-level operations dashboards.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Browser (SPA)                                  │
│  React 19 + Vite 8 + TypeScript 5.9                                       │
│  Tailwind 4 · Zustand · React Router 7 · jsPDF · pdf-lib · xlsx           │
│  Routes: /projects, /project/:id/*, /personal-ops, /manager-dashboard,    │
│          /cutsheets/*, /products, /settings, /login, /register            │
└────────┬─────────────────────────────────────────────────────────────────┘
         │  HTTPS (served by nginx)
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Fly.io  (Dockerfile + nginx.conf)                     │
│  Static SPA build behind nginx                                            │
└────────┬─────────────────────────────────────────────────────────────────┘
         │  supabase-js (REST + RPC + Auth + Storage + Functions)
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            Supabase                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │  Postgres   │  │   Auth      │  │   Storage    │  │ Edge Functions │ │
│  │  (RLS)      │  │  (JWT)      │  │  manuals/    │  │   (Deno)       │ │
│  └─────────────┘  └─────────────┘  └──────────────┘  └───────┬────────┘ │
└─────────────────────────────────────────────────────────────────┼────────┘
                                                                  │
   ┌──────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐
│   D-Tools SI     │  │  Microsoft Graph │  │   Monday.com     │  │  Anthropic     │
│  Subscribe API   │  │  (SharePoint +   │  │   GraphQL v2     │  │  Claude API    │
│                  │  │   Mail/Cal)      │  │                  │  │                │
└──────────────────┘  └──────────────────┘  └──────────────────┘  └────────────────┘
```

**Flow patterns**

- **UI → Postgres direct** for normal CRUD against RLS-protected tables (`projects`, `project_bom_items`, `cutsheet_repository`, etc.).
- **UI → Edge Function → External API** whenever a third-party secret is needed (D-Tools, Graph app-only, Monday, Claude). The browser only ever holds the Supabase JWT.
- **Edge function → Edge function** is used once: `dtools-import-project` delegates BoM sync to `dtools-project-lookup` to avoid duplicating the location/labor logic.
- **Cutsheet PDFs** live in SharePoint, not Supabase Storage. Only OEM manuals/closeout artifacts use Supabase's `manuals` bucket.

---

## 2. Tech Stack

### Frontend (`app/`)
| Concern | Choice |
|---|---|
| Framework | React 19.2 |
| Build | Vite 8.0 |
| Language | TypeScript 5.9 (strict; `tsc -b && vite build`) |
| Routing | react-router-dom 7.13 |
| State | Zustand 5 (`app/src/store/index.ts`), Context for auth |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite` |
| Icons | lucide-react |
| PDF generation | jspdf, pdf-lib |
| Spreadsheet | xlsx (SheetJS) |
| Linting | eslint 9 + typescript-eslint, react-hooks, react-refresh |

### Backend / Data
| Concern | Choice |
|---|---|
| Database | Supabase Postgres (RLS enforced everywhere) |
| Auth | Supabase Auth (JWT). Roles via `profiles.role` (`admin` is the privileged tier) |
| Server logic | Supabase Edge Functions (Deno, `std@0.177.0`, `@supabase/supabase-js@2` via esm.sh) |
| Object storage | Supabase Storage bucket `manuals` (private, project-scoped path prefix) for OEM PDFs; SharePoint for cutsheets |
| CLI | `supabase` ^2.85 (root `package.json` devDep) |

### Deployment
| Concern | Choice |
|---|---|
| Host | Fly.io |
| Container | `Dockerfile` (multi-stage build → nginx) |
| Reverse proxy | `nginx.conf` |
| Config | `fly.toml` |
| Public URL | `https://instrata-project-tools.fly.dev` (referenced as `APP_ORIGIN` in `ms-graph-auth`) |

### External Integrations
| System | Use |
|---|---|
| **D-Tools SI Subscribe API** | Project list/import, BoM sync (qty per location, per-item labor), project total ("Price") |
| **Microsoft Graph (delegated)** | Personal Ops dashboard — read user's mail and calendar |
| **Microsoft Graph (app-only)** | SharePoint Cutsheet Repository — upload/move/delete PDFs |
| **Monday.com** | Manager Dashboard feed (AV Pre-Sales Summary board), webhook (currently no-op) |
| **Anthropic Claude API** | Email urgency scoring + reply drafts |

---

## 3. Database Schema

> Base schema in `supabase/migration.sql`. Incremental migrations in `supabase/migrations/`. All tables have RLS enabled.

### Core (base schema — `migration.sql`)

#### `profiles`
- `id` uuid PK → `auth.users` ON DELETE CASCADE
- `email` text NOT NULL
- `full_name` text default `''`
- `role` text default `'member'` — CHECK ∈ `('admin', 'member')`
- `created_at` timestamptz
- **Auto-created** by `handle_new_user()` trigger on `auth.users` insert (pulls `full_name` from `raw_user_meta_data`).
- **RLS:** users read/update own row; admins have full access.

#### `projects`
- `id` uuid PK
- `name`, `number`, `client`, `address`, `business_unit`, `status` text (defaults `''` / `'Active'`)
- `monday_item_id` bigint **UNIQUE** — webhook idempotency
- `created_by` uuid → `profiles`
- `created_at`, `updated_at` timestamptz (auto-touched by `set_updated_at` trigger)
- **Migration extensions:**
  - `phase` text default `'Post-Sales'` — CHECK ∈ `('Pre-Sales', 'Post-Sales')` — drives sidebar grouping
  - `value` text default `''` — human-formatted dollar string (e.g. `"$505,432.50"`); D-Tools `Price` is source of truth
  - `owner_id` uuid → `auth.users` — engineer for "My Projects"; indexed
  - `dtools_project_id` text
  - `dtools_bom_status` text default `''` — `'' | 'loading' | 'found' | 'not_found' | 'error'`
- **RLS:** members can SELECT/UPDATE; any authenticated user INSERT; only admins DELETE.

#### `project_members` (junction)
- PK (`project_id`, `user_id`); both FK with ON DELETE CASCADE
- Indexed by `user_id`
- **RLS:** project members can read and manage members.

#### `project_bom_items`
Base columns: `id`, `project_id` (FK), `manufacturer`, `model`, `description`, `category` (default `'Other'`), `qty` numeric, `notes`, `cut_sheet_url`, `cut_sheet_name`, `sort_order` int, `locations` jsonb (`[{room, qty}]`).

Pricing/labor (added in base + `add_bom_pricing.sql`): `item_type` (default `'Product'`), `unit_cost`, `unit_price`, `labor_hours`, `labor_unit_cost`, `labor_unit_price`, `fixed_labor_cost`, `fixed_labor_price`, `margin_pct` (all numeric, default 0), `owner_furnished`, `optional` boolean.
- **RLS:** project members read/manage.
- Indexed by `project_id`.

#### `submittals`
- `id` uuid PK
- `project_id` uuid → `projects` CASCADE
- `title`, `revision`, `prepared_by`, `submitted_to`, `status` (default `'Draft'`), `notes` text
- `created_at` timestamptz
- **RLS:** project members read/manage. Indexed by `project_id`.

#### `submittal_items`
- `id` uuid PK
- `submittal_id` uuid → `submittals` CASCADE
- Columns mirror BoM display: `manufacturer`, `model`, `description`, `category`, `qty`, `notes`, `cut_sheet_url`, `cut_sheet_name`, `locations` jsonb, `sort_order`
- **Cutsheet repository links** (added by cutsheet migrations):
  - `cutsheet_repository_id` uuid → `cutsheet_repository` ON DELETE SET NULL — auto-attached match
  - `cutsheet_staging_id` uuid → `cutsheet_staging` ON DELETE SET NULL — pending admin review
- **RLS:** member-of-parent-project's submittal. Indexed by `submittal_id`.

#### `rfis`
- `id`, `project_id` (FK CASCADE), `number`, `subject`, `spec_section`, `description`, `status` (default `'Open'`), `response_due`, `answered_at`, `answered_by`, `response_summary`, `location_ref`, `product_ref`, `created_at`, `attachments` jsonb.
- **RLS:** project members read/manage. Indexed by `project_id`.

#### `closeout_packages`
- `id`, `project_id` (FK CASCADE), `status` (default `'Draft'`), `created_at`
- **Migration:** `product_manual_url`, `product_manual_name` text (`add_product_manuals.sql`)
- Acts as parent for warranties / punch / sign-offs / as-builts. Indexed by `project_id`.

#### `warranties`
- FK `closeout_id` → `closeout_packages` CASCADE
- `bom_item_id` text (loose link), `system`, `manufacturer`, `model`, `vendor`, `start_date` text, `duration_months` int, contact fields (`contact_name`, `contact_email`, `contact_phone`), `coverage_notes`.
- **RLS:** member-of-closeout's-project. Indexed by `closeout_id`.

#### `punch_items`
- FK `closeout_id` CASCADE
- `description`, `location`, `assigned_to`, `status` (default `'Open'`), `priority` (default `'Standard'`), `resolved_at`, `product_ref`.
- **RLS:** member-of-closeout's-project. Indexed by `closeout_id`.

#### `sign_off_sheets`
- FK `closeout_id` CASCADE
- `zone`, `system`, `tested_by`, `tested_date`, `witnessed_by`, `status` (default `'Pending'`), `notes`, `custom_items` jsonb.
- **RLS:** member-of-closeout's-project. Indexed by `closeout_id`.

#### `as_built_drawings`
- FK `closeout_id` CASCADE
- `title`, `file_name`, `file_url`, `revision`, `uploaded_at`.
- **RLS:** member-of-closeout's-project. Indexed by `closeout_id`.

#### `owner_manuals`
- `id`, `project_id` (FK CASCADE), `title`, `revision`, `overview_text`, `created_at`, `sections` jsonb.
- **RLS:** project members read/manage. Indexed by `project_id`.

### Database Functions

| Function | Type | Purpose |
|---|---|---|
| `is_project_member(_project_id uuid) → boolean` | SECURITY DEFINER, STABLE | Reused everywhere as the canonical "can see this project" check: admin, OR `projects.created_by = auth.uid()`, OR a row in `project_members`. |
| `set_updated_at()` | trigger fn | Generic — sets `NEW.updated_at = now()`. Wired to `projects` only. |
| `handle_new_user()` | SECURITY DEFINER | After-insert trigger on `auth.users` — inserts a `profiles` row with `email` + `full_name` from `raw_user_meta_data`. |
| `cutsheet_is_admin() → boolean` | SECURITY DEFINER | Mirrors the `profiles.role='admin'` check, used inside cutsheet RLS policies. |
| `search_catalog(search_term, page_from, page_to)` | RPC | Paginated catalog search; each word must match mfr/model/description; mfr/model hits rank above description-only. Returns `total_count`. |

### Triggers
- `projects.before update` → `set_updated_at`
- `auth.users.after insert` → `handle_new_user`

### Auto Reviewer (`add_auto_reviewer.sql`)

| Table | Purpose |
|---|---|
| `product_catalog` | Master product list. Unique on (`manufacturer`, `model_number`). |
| `review_runs` | One row per Auto-Review pass on a project. `status` ∈ pending_review, in_review, changes_requested, quick_fix, approved. Holds CSV snapshot + Monday payload. |
| `review_flags` | Findings produced by a run. `severity` ∈ high/moderate/low. `category` ∈ margin/pricing/labor/data/catalog/project. `status` ∈ open/resolved/waived/commented. `diff_status` tracks new/recurring/resolved across runs. |
| `review_config` | Tunable thresholds, seeded with: `margin_floor_project=30%`, `margin_floor_phase=25%`, `pricing_staleness_days=90`, `cost_deviation_pct=15%`, `preferred_vendors`, `free_item_models`. |
| `labor_rates` | `labor_type` UNIQUE, `rate_per_hour`, optional `hours_ceiling`. |

**RLS:** authenticated read; admin (`profiles.role='admin'`) write.

### Product Catalog Extensions

`add_catalog_cost_uom.sql` adds `cost`, `unit_of_measure`, `price_date`.

`add_dtools_catalog_fields.sql` extends `product_catalog` to the full D-Tools SI shape — classification (`subcategory`, `phase`, `part_number`, `system_name`, `product_url`), descriptions (`short_description`, `long_description`, `tags`, `accounting_item_name`), labor (`labor_types`, `unit_labor_hours`), pricing (`unit_price`, `margin`, `markup`, `map_price`, `purchase_cost`, `partner_set_cost`, `uom_for_partner_cost`, `preferred_vendor`, `alternate_vendors`, `priced_from`, `partner_updated_on`), physical specs (dimensions, weight, rack mounting, power: `amps`/`volts`/`watts`/`btu`, PoE flags), ordering (`order_uom`, `do_not_order`), and flags (`bulk_item`, `include_in_submittal` default true, `include_in_service_plan`, `owner_furnished`, `taxable`, `discontinued` default false, `approved`, `taa_compliant`, `bulk_wire`, `has_thumbnail`, `has_files`). Audit fields: `dtools_created_on/by`, `dtools_updated_on/by`, `last_synced_at`. Indexes on `dtools_updated_on` (incremental sync) and `discontinued` (active filter).

#### `search_catalog(search_term, page_from, page_to)` RPC
SQL function returning paginated catalog matches. Each space-delimited word must hit at least one of `manufacturer`, `model_number`, `description`. Manufacturer/model hits rank above description-only matches. Returns `total_count` for pagination.

### Bid Leveling (`add_bid_leveling.sql`)

| Table | Purpose |
|---|---|
| `bid_leveling_mapping_templates` | Reusable cell-mapping templates per GC/consultant. `cell_mappings` jsonb. Creator-or-admin can edit/delete. |
| `bid_leveling_sessions` | Per-project run. Inputs (`bom_csv_url`, `template_xlsx_url`), chosen `mapping_template_id` + frozen `cell_mappings_snapshot`, output `generated_xlsx_url` + `generation_report` jsonb. `status` ∈ draft/mapped/generated. |

### Cutsheet Repository (`add_cutsheet_repository.sql`, `add_cutsheet_staging_link.sql`)

| Table | Purpose |
|---|---|
| `cutsheet_repository` | Approved canonical cutsheets. Unique index on `lower(manufacturer)`,`lower(model_number)`. Stores SharePoint `sharepoint_item_id` (durable) + `sharepoint_path` (display only). |
| `cutsheet_staging` | Pending admin review. `status` ∈ pending/approved/rejected/duplicate. `duplicate_of` → repository. Source context tracked (`submittal_builder`, `manual_upload`, etc.). |
| `cutsheet_project_usage` | Analytics: which projects used which approved cutsheets, where (`submittal`, `om_manual`, `product_lookup`). |

Helper function `cutsheet_is_admin()` (SECURITY DEFINER) replicates the `profiles.role='admin'` check inside policies.

**RLS:**
- Repository: any authenticated reads; admin writes only.
- Staging: uploader sees own pending rows + admin sees all; any authenticated insert; admin update/delete.
- Usage: any authenticated read/write of own rows.

### Personal Ops (`add_personal_ops.sql`) — admin-only

| Table | Purpose |
|---|---|
| `ms_graph_tokens` | Per-user OAuth tokens. UNIQUE(`user_id`). Stores `access_token`, `refresh_token`, `expires_at`. RLS: own row + admin only. |
| `personal_ops_email_flags` | Triage state per Graph `message_id`. `status` ∈ active/flagged/deferred/dismissed. `session_type` and `deferred_to` ∈ morning/midday/eod. `urgency_score` numeric, `urgency_reason` text. Indexed by (`user_id`, `message_id`). |

### Storage Buckets

| Bucket | Visibility | Path convention | Policies |
|---|---|---|---|
| `cutsheets` | private | `{project_id}/...` | Authenticated INSERT; SELECT/DELETE gated by `is_project_member((path[0])::uuid)`. |
| `as-builts` | private | `{project_id}/...` | Authenticated INSERT; SELECT/DELETE gated by `is_project_member`. |
| `manuals` | private | `{project_id}/...` | Authenticated INSERT; SELECT/DELETE gated by `is_project_member` (added by `add_product_manuals.sql`). |

> Note: cutsheet **PDFs** for the Cutsheet Repository feature live in **SharePoint**, not the `cutsheets` bucket. The bucket appears to predate the SharePoint repository and likely backs `project_bom_items.cut_sheet_url` for legacy / project-local uploads.

---

## 4. Edge Functions Inventory

All under `supabase/functions/`. Deno runtime. CORS allowed from `*`.

### `dtools-list-projects`
- **Purpose:** Page through D-Tools Subscribe `/Projects` (200/page, 5000 cap), normalize each into `{dtoolsId, name, number, client, businessUnit, siteAddress, projectTotal, status}`. Sorted by project number desc. Optional `{debug:true}` short-circuit returns raw list+detail shape.
- **External APIs:** D-Tools (`X-DTSI-ApiKey`)
- **Tables touched:** none

### `dtools-import-project`
- **Purpose:** One-shot import. Given `dtoolsProjectId`, fetch metadata, idempotency-check on `projects.dtools_project_id`, INSERT new project (mapping subsidiary→`business_unit`, `Approved`→`phase`, `Price`→`value`), add creator as project member, then **delegate** BoM sync to `dtools-project-lookup`.
- **External APIs:** D-Tools, calls `dtools-project-lookup` over HTTPS using service-role JWT
- **Tables touched:** `projects` (INSERT), `project_members` (INSERT)

### `dtools-project-lookup`
- **Purpose:** Search D-Tools by project number, double-fetch detail (aggregated by Location for qty + non-aggregated for `ItemLaborTypes` and `TypeId=2` rate map), compute per-line labor as `hours × rate` with Install fallback, write `project_bom_items` (DELETE then 100-row batches), update `projects.dtools_bom_status`/`value`.
- **External APIs:** D-Tools
- **Tables touched:** `project_bom_items` (DELETE/INSERT), `projects` (UPDATE)

### `monday-manager-dashboard`
- **Purpose:** Pull "New Requests" group from Pre-Sales board, return two buckets: `triage` (date set, no engineer) and `review` (status="Review"). Both sorted by due date asc. Optional `debugNameQuery` dumps raw column data for matching item names.
- **External APIs:** Monday GraphQL v2024-10
- **Tables touched:** none (read-only Monday → response)

### `monday-webhook`
- **Purpose:** No-op. Echoes `{challenge}` for Monday subscription handshake; logs `event.type/boardId/pulseId`. Auto project-creation was deliberately removed — kept so the existing Monday subscription doesn't 404.
- **External APIs:** none
- **Tables touched:** none

### `email-triage`
- **Purpose:** Admin-only batch urgency scoring. Sends an email batch to Claude with a director-voice system prompt; returns per-email `{id, urgencyScore (0–100), urgencyReason, draftReply}` (reply drafted for score ≥50).
- **External APIs:** Anthropic `/v1/messages` — pinned to `claude-sonnet-4-20250514`, `max_tokens: 8192`
- **Tables touched:** `profiles` (SELECT for admin gate)

### `ms-graph-auth`
- **Purpose:** OAuth handler with three actions:
  - `authorize` (POST, admin-only): builds Microsoft consent URL with userId-encoded `state`. Scopes: `Mail.Read Calendars.Read User.Read offline_access`. Forces `prompt=consent`.
  - `callback` (GET): exchanges auth code → tokens → upserts to `ms_graph_tokens`, redirects to `${APP_ORIGIN}/personal-ops?connected=true`.
  - `disconnect`: deletes the user's token row.
- **External APIs:** Microsoft `login.microsoftonline.com/{TENANT}/oauth2/v2.0/{authorize,token}`
- **Tables touched:** `profiles` (admin gate), `ms_graph_tokens` (UPSERT/DELETE)

### `ms-graph-emails`
- **Purpose:** Admin-only. Loads stored Graph tokens, refreshes if within 5 min of expiry (writes back to `ms_graph_tokens`), queries `/me/messages` with a session-window filter (morning 0–12 / midday 8–16 / eod 12–24 UTC) for a given date. Top 50 by `receivedDateTime` desc. Returns `{emails, tokenStatus}`.
- **External APIs:** Microsoft Graph `/me/messages`
- **Tables touched:** `profiles` (admin gate), `ms_graph_tokens` (SELECT/UPDATE)

### `sharepoint-cutsheet`
Single endpoint, op dispatcher (`body.op`). App-only Graph token (client_credentials), module-scoped cache with 5-min refresh buffer.

| `op` | Purpose |
|---|---|
| `bootstrap` | One-time setup: resolve site URL → `{siteId, driveId, stagingFolderId, repositoryFolderId}` to set as env vars. |
| `lookup` | Case-insensitive mfr+model match against `cutsheet_repository`. Optional fresh download URL. |
| `lookupBatch` | Same, but for a list of pairs — pulls full repo into memory, indexes, and matches. Used by populate-from-BoM. |
| `getDownloadUrl` | Issues a fresh ~1h pre-authenticated Graph download URL by item id. |
| `uploadStaging` | Dedupe vs repo. Otherwise PUT base64 PDF to `/Staging/`, INSERT `cutsheet_staging` (rolls back SharePoint upload if DB insert fails). |
| `listStaging` | Fetch staging rows by status; parallel-resolves download URLs for inline preview. |
| `approveStaging` | Ensure `/Repository/{Manufacturer}/`, PATCH-move file, INSERT `cutsheet_repository`, mark staging approved, **promote** `submittal_items` from staging→repo links. Rolls move back on DB failure. |
| `markStagingDuplicate` | Delete the `/Staging/` file, mark `duplicate_of`, redirect linked submittal items to the existing repo row. |
| `rejectStaging` | Delete file, mark rejected, detach (`cutsheet_staging_id=null`, `cut_sheet_name=null`) any linked submittal items. |

- **External APIs:** Microsoft Graph (Sites/Drives/Items)
- **Tables touched:** `cutsheet_repository`, `cutsheet_staging`, `submittal_items`

---

## 5. Feature Inventory

> Status reflects what's visible from the file tree, migrations, and edge functions. Verify against actual UI before relying on this for planning.

| Feature | Status | Description |
|---|---|---|
| Project list & CRUD | Complete | `ProjectsList`, `ProjectNew`, `ProjectHome`, `ProjectOverview`, `ProjectSettingsModal`, `ProjectMembersModal`. Phase/value/owner displayed; sidebar grouped by Pre-Sales/Post-Sales. |
| Dashboard ("My Projects") | Complete | `Dashboard.tsx` filters by `owner_id`. |
| Manager Dashboard | Complete | `ManagerDashboard.tsx` + `monday-manager-dashboard` function. Pulls Monday triage + review queues. |
| D-Tools Project Import | Complete | `ProjectNew` "Import from DTools" modal → `dtools-list-projects` + `dtools-import-project`. Idempotent on `dtools_project_id`. |
| D-Tools BoM Sync | Complete | `dtools-project-lookup` writes per-line cost/price/labor/margin/owner-furnished/optional flags. |
| BoM Location View | Complete | `BoMLocationView.tsx` — qty per room. |
| Catalog (Products) | Complete | `ProductsPage.tsx`, `CatalogImportModal`, `CatalogViewerModal`, `CSVImportModal`, `CellMapperModal`, `search_catalog` RPC. |
| Catalog Sync from D-Tools | Complete | `app/src/lib/dtools/api-sync.ts` + `import-catalog.ts`; uses `last_synced_at` / `dtools_updated_on` for incremental. `CatalogSyncStatus.tsx` UI. |
| Cutsheet Repository (Browse) | Complete | `CutsheetRepository.tsx` page; `cutsheet_repository` + SharePoint download URLs on demand. |
| Cutsheet Staging Upload (Phase 2) | Complete | `sharepoint-cutsheet` `uploadStaging` op — auto-attached during submittal builder. |
| Cutsheet Triage (Admin Review) | Complete | `CutsheetReview.tsx` — list/approve/reject/duplicate via `sharepoint-cutsheet`. Promotes pending submittal links to canonical repo links on approval. |
| Cutsheet My Uploads | Complete | `CutsheetMyUploads.tsx` — uploader can track their own pending items. |
| Submittals | Complete | `SubmittalList`, `SubmittalDetail`, `exportSubmittalPDF`, `submittalExclusions.ts`. Items link to repo or staging cutsheets via the two FK columns. |
| Closeout Package | Complete | `CloseoutDashboard.tsx`, `exportCloseoutPDF.ts`, `exportSignOffPDF.ts`. Now includes optional product manual upload. |
| O&M / Owner Manual | Complete | `OwnerManual.tsx`, `exportManualsPDF.ts`, `extractBookmarks.ts`. Skill-equivalent in-app. |
| RFI List | Complete | `RFIList.tsx`, `exportRFIPDF.ts`. |
| Auto Reviewer | Complete (schema + page) | `AutoReview.tsx`, `ReviewQueue.tsx`, `reviewEngine.ts`, `reviewReport.ts`. Backed by `review_runs`, `review_flags`, `review_config`, `labor_rates`. |
| Bid Leveling Generator | In Progress | Schema + `BidLevelingPage.tsx` + `bidLevelingEngine.ts` exist; spec is `BidLevelingGenerator_Phase1_Spec.docx` (Phase 1). |
| Personal Ops Dashboard | In Progress | `PersonalOpsPage.tsx`, `usePersonalOps.ts`, `EmailDigestCard`, `ConnectEmailBanner`, `EmailActionBar`, `SessionSelector`. Functions wired (`ms-graph-auth`, `ms-graph-emails`, `email-triage`). Spec at `personal_ops_feature_spec.html`. |
| Effort Survey | Complete | `EffortSurvey.tsx`. |
| Monday Auto Project Creation | Removed | `monday-webhook` is intentionally a no-op; replaced by explicit "Import from DTools". |
| Settings | Complete | `SettingsPage.tsx`. |
| Auth (Login / Register) | Complete | `Login.tsx`, `Register.tsx`, `AuthContext.tsx`. |

---

## 6. Monday.com Reference

### Boards
| Board | ID | Source |
|---|---|---|
| AV Pre-Sales Summary | `3477536693` | `monday-manager-dashboard/index.ts` (default for `MONDAY_PRESALES_BOARD_ID`) |

### Groups
| Board | Group Title | Used by |
|---|---|---|
| AV Pre-Sales Summary | `New Requests` | `monday-manager-dashboard` (matched case-insensitively against `groups.title`) |

### Columns (AV Pre-Sales Summary)
| Column ID | Type | Meaning |
|---|---|---|
| `date7` | Date | Due date — drives sort; presence required for triage bucket |
| `person` | People | Pre-sales engineer assignment — empty/no `personsAndTeams` means triage |
| `status9` | Status | Workflow status — value `"Review"` (case-insensitive) puts the item in the review bucket |

### Webhook
- `monday-webhook` echoes `{challenge}` for subscription verification; otherwise logs `event.type / boardId / pulseId` and returns `{status:'noop'}`. No DB writes.

### Embedded Business Rules
- **Triage rule:** `dueDate set AND person column has no assignees` → surfaces on Manager Dashboard "Triage".
- **Review rule:** `status9.text === 'review'` (case-insensitive) → "Review" queue. Sorted by due date asc; items without a date sort last.
- **API version pinned** to `2024-10` in the function header.

---

## 7. Environment & Secrets

> Names only. Set as Supabase function secrets (server-side) or build-time vars (client-side, `VITE_*`).

### Supabase Edge Function Secrets

| Secret | Used by |
|---|---|
| `SUPABASE_URL` | every function |
| `SUPABASE_SERVICE_ROLE_KEY` | every function |
| `DTOOLS_API_KEY` | `dtools-list-projects`, `dtools-import-project`, `dtools-project-lookup` |
| `MONDAY_API_TOKEN` | `monday-manager-dashboard` |
| `MONDAY_PRESALES_BOARD_ID` (optional, default `3477536693`) | `monday-manager-dashboard` |
| `MS_GRAPH_TENANT_ID` (default in code: `d633c932-8a52-4aeb-a755-c0f1ffaf103c`) | `ms-graph-auth`, `ms-graph-emails` |
| `MS_GRAPH_CLIENT_ID` | `ms-graph-auth`, `ms-graph-emails` |
| `MS_GRAPH_CLIENT_SECRET` | `ms-graph-auth`, `ms-graph-emails` |
| `APP_ORIGIN` (default `https://instrata-project-tools.fly.dev`) | `ms-graph-auth` (callback redirect target) |
| `GRAPH_TENANT_ID` | `sharepoint-cutsheet` |
| `GRAPH_CLIENT_ID` | `sharepoint-cutsheet` |
| `GRAPH_CLIENT_SECRET` | `sharepoint-cutsheet` |
| `SHAREPOINT_SITE_ID` | `sharepoint-cutsheet` (resolve once via `bootstrap` op) |
| `SHAREPOINT_DRIVE_ID` | `sharepoint-cutsheet` |
| `SHAREPOINT_STAGING_FOLDER_ID` | `sharepoint-cutsheet` |
| `SHAREPOINT_REPOSITORY_FOLDER_ID` | `sharepoint-cutsheet` |
| `ANTHROPIC_API_KEY` | `email-triage` |

### Frontend (`app/.env`, build-time)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- (Plus any other `VITE_*` referenced from `app/src/lib/supabase.ts`.)

### Fly.io
- App-level secrets are scoped per Fly app; deployment uses `fly.toml` + `Dockerfile`. The Supabase service-role key **must not** appear here — it stays in Supabase function secrets.

### Notable in-code defaults (consider moving to env)
- D-Tools subsidiary→business-unit map is hard-coded in three functions (`SUBSIDIARY_TO_BU`).
- Tenant ID `d633c932-8a52-4aeb-a755-c0f1ffaf103c` is a hard-coded fallback in two functions.
- Monday board id `3477536693` falls back in code if env unset.
- The Claude model ID `claude-sonnet-4-20250514` is hard-coded.

---

## 8. Known Limitations & Tech Debt

**Auth & Authorization**
- `monday-manager-dashboard` does not enforce admin role server-side — it trusts that the UI hides it. A signed-in non-admin who knew the function name could call it.
- Several Bid Leveling RLS policies (`Authenticated users can update bid leveling sessions`) are intentionally permissive — any authenticated user can update any session. May tighten when concurrency matters.

**Schema / Data Model**
- `projects.value` is stored as a **formatted string** (`"$505,432.50"`), not a numeric. Re-formatting requires a parser. D-Tools `Price` is the source of truth.
- `cutsheet_project_usage` table exists but isn't yet read anywhere observable in the file tree.
- `submittal_items` carries two cutsheet pointers (`cutsheet_repository_id`, `cutsheet_staging_id`) — invariant is "at most one set"; nothing in the schema enforces it (no CHECK constraint).
- D-Tools subsidiary parsing relies on three different field shapes — robust but adds maintenance surface.

**Edge Functions**
- `email-triage` is pinned to **`claude-sonnet-4-20250514`**, which is older than the Claude 4.6/4.7 generation. Worth bumping.
- `email-triage` parses Claude output via regex (`/\[[\s\S]*\]/`) rather than structured outputs / tool use — silently returns `[]` on a malformed response.
- `dtools-import-project` calls `dtools-project-lookup` over public HTTPS using the service-role JWT. Works, but couples deploy of one to the other and adds round-trip latency vs. shared module.
- `sharepoint-cutsheet.uploadStaging` accepts base64 PDFs in the JSON body — capped by Supabase function body limit (~5 MB). Larger cutsheets need a different path (signed upload URL or chunked Graph upload).
- `monday-manager-dashboard` builds GraphQL via string concatenation — safe today (board id is from env, group id is matched server-side), but adopt parameterized queries before exposing user-supplied input.
- Monday pagination caps at 10k items via a hard loop limit (`HARD_CAP_LOOPS=20 * 500`).

**SharePoint Integration**
- `sharepoint-cutsheet` ops aren't admin-gated server-side — RLS on the Postgres tables protects writes, but the Graph operations (move, delete, upload) are gated only by whoever can reach the function.
- Manufacturer subfolder names are sanitized with a single regex; collisions on different inputs that sanitize the same way (e.g. `AB:CD` and `AB-CD`) merge silently.

**Frontend**
- `app/src/store/index.ts` is a single Zustand store — no slicing observable; large pages may re-render aggressively.
- React 19 + Vite 8 + Tailwind 4 is the bleeding edge; expect ecosystem friction (some libs still emit React 18-era warnings).

**Deployment**
- No CI/CD wiring observable in the tree — deploys are manual (`fly deploy`) per the recent fix-build commit.
- `supabase` CLI is a root devDep; migrations are run **manually in the SQL Editor** per migration file headers — no `supabase db push` flow documented.

**Docs**
- This file. Keep it honest.

---

## 9. Changelog

<!-- Maintained manually. Add entries top-down (newest first). Format suggestion:
### YYYY-MM-DD
- **Area** — what changed and why.
-->

