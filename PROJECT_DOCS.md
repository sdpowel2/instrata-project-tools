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
| **Monday.com** | Live phase + status sync across two boards (Pre-Sales + Post-Sales) via webhook + one-shot backfill function. Manager Dashboard feed (Pre-Sales board). |
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
- **RLS:** users read/update own row; admins have full access via `is_admin()`. **Note:** admin policies must use the `is_admin()` SECURITY DEFINER function — inline `EXISTS (SELECT 1 FROM profiles …)` subqueries inside a profiles policy cause infinite recursion and silently fall back to the user's own row only.

#### `projects`
- `id` uuid PK
- `name`, `number`, `client`, `address`, `business_unit` text (default `''`)
- `status` text default `'Not Started'` — **free-text**, no CHECK. Spans the union of both Monday boards' statuses: `Not Started`, `In Progress`, `On Hold`, `Review`, `Follow Up`, `Won`, `Lost`, `Declined to Bid`, `Rebid`, `Install`, `Close Out`, `Completed`. App layer enforces typing via `ProjectStatus` union in `app/src/types.ts`.
- `monday_item_id` bigint **UNIQUE** — *deprecated*; legacy single-board pointer retained for backward compatibility, replaced by `project_code` + the two new id columns.
- `created_by` uuid → `profiles`
- `created_at`, `updated_at` timestamptz (auto-touched by `set_updated_at` trigger)
- **Migration extensions:**
  - `phase` text default `'Pre-Sales'` — CHECK ∈ `('Pre-Sales', 'Post-Sales')` — drives sidebar grouping. Default flipped from `'Post-Sales'` by `add_monday_link_and_status_expansion.sql`.
  - `value` text default `''` — human-formatted dollar string (e.g. `"$505,432.50"`); D-Tools `Price` is source of truth.
  - `owner_id` uuid → `auth.users` — engineer for "My Projects"; indexed.
  - `dtools_project_id` text
  - `dtools_bom_status` text default `''` — `'' | 'loading' | 'found' | 'not_found' | 'error'`
  - `project_code` text **UNIQUE** — `INST-YYYY-NNNN` persistent identifier written to both Monday boards' Project ID text columns. Generated by `generate_project_code()`. Indexed.
  - `monday_presales_item_id` bigint **UNIQUE** — cached pointer to the AV Pre-Sales Summary board item.
  - `monday_postsales_item_id` bigint **UNIQUE** — cached pointer to the Post-Sales board item.
- **RLS:** any authenticated user SELECT (all projects visible org-wide); any authenticated user INSERT; project members UPDATE; only admins DELETE.

#### `project_code_counters`
- `year` int PK
- `last_seq` int default 0
- Atomic counter table backing `generate_project_code()`. UPSERT-with-RETURNING pattern guarantees unique sequence per call without depending on the `projects` table's insert timing — fixes the race that produced duplicate codes in the original implementation.

#### `project_members` (junction)
- PK (`project_id`, `user_id`); both FK with ON DELETE CASCADE
- Indexed by `user_id`
- **RLS:** project members can read and manage members.

#### `project_comments` (`add_project_comments.sql`)
- `id` uuid PK
- `project_id` uuid → `projects` CASCADE
- `parent_id` uuid → `project_comments` CASCADE — `null` for top-level comments; non-null points at the top-level comment for a reply. Replies are flat (one level only) — the frontend hides the Reply control on existing replies; no DB-level depth check.
- `author_id` uuid → `profiles` CASCADE
- `body` text, `reactions` jsonb default `'[]'` — array of `{emoji, userIds[]}` so toggling a reaction adds/removes the current user from the bucket. Empty buckets are dropped.
- `edited` boolean default false; `created_at`, `updated_at` timestamptz
- Indexed by (`project_id`, `created_at`) and `parent_id`.
- **RLS:** any authenticated user can read and insert (project membership intentionally **not** required so a teammate can drop in to help on a project they aren't formally assigned to). Authors and admins can update/delete their own; cascade drops replies when a parent goes.

#### `project_bom_items`
Base columns: `id`, `project_id` (FK), `manufacturer`, `model`, `description`, `category` (default `'Other'`), `qty` numeric, `notes`, `cut_sheet_url`, `cut_sheet_name`, `sort_order` int, `locations` jsonb (`[{room, qty}]`).

Pricing/labor (added in base + `add_bom_pricing.sql`): `item_type` (default `'Product'`), `unit_cost`, `unit_price`, `labor_hours`, `labor_unit_cost`, `labor_unit_price`, `fixed_labor_cost`, `fixed_labor_price`, `margin_pct` (all numeric, default 0), `owner_furnished`, `optional` boolean.

Vendor (`add_priced_from_to_bom.sql`): `priced_from` text — DTools "Custom Field 1", typically `"VENDOR MM/DD/YY"` (e.g. `"ADI 4/11/26"`). Surfaces in the Purchasing module's Vendor column only — intentionally hidden from the project overview BoM.
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
- **Per-item approval** (`add_submittal_item_approval.sql`):
  - `approval_state` text default `'pending'` — CHECK ∈ `('pending', 'approved', 'revise')`
  - `approval_changed_at` timestamptz, `approval_changed_by` uuid → `profiles`
  - Coexists with the package-level `submittals.status`. Cascade rules live in the store, not the DB:
    - Package → `Approved`: cascade all items to `'approved'`
    - Package → `Draft`: cascade all items to `'pending'`
    - Package → `Submitted` / `Revise & Resubmit`: preserve existing item marks
    - All items `'approved'` (per-item edit): auto-promote package to `'Approved'`
    - Any item `'revise'` (per-item edit): auto-demote package to `'Revise & Resubmit'`
- **Delete is blocked** in `store.deleteSubmittalItem` if any linked `purchasing_items` row has `purchase_status != 'not_ordered'`. Caller surfaces the error.
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

#### `quick_start_rooms` (`add_quick_start_guide.sql`)
- `id` uuid PK, `closeout_id` uuid → `closeout_packages` CASCADE, `name`, `sort_order`, `created_at`.
- One row per "room" in a closeout's Quick Start Guide. The `name` is either a verbatim BoM location (incl. sub-locations like `1st Floor\Conference Room A`) or a custom string typed by the user when the BoM isn't keyed by room.
- **RLS:** project members read/manage (gated via `closeout_packages.project_id` + `is_project_member`). Indexed by `closeout_id`.

#### `quick_start_steps` (`add_quick_start_guide.sql`)
- `id` uuid PK, `room_id` uuid → `quick_start_rooms` CASCADE, `text`, `note`, `sort_order`.
- Ordered operating-instruction steps inside a Quick Start room. `text` is the action ("Press the start button"), `note` is optional clarifying context shown beneath it.
- **RLS:** project members read/manage (gated by joining through `quick_start_rooms` → `closeout_packages` → `is_project_member`). Indexed by `room_id`.

#### `project_milestones` (`add_project_milestones.sql`)
- `id` uuid PK, `project_id` uuid → `projects` CASCADE
- `title`, `description`, `notes` text
- `milestone_type` text — open enum (no DB CHECK); 17 canonical values defined in `app/src/types.ts` (`MILESTONE_TYPES`) split between contractual project-tier (e.g. `submittal_due`, `substantial_completion`, `closeout_package_due`) and operational phase-tier (e.g. `rough_in_complete`, `programming_complete`, `commissioning_complete`)
- `tier` text CHECK ∈ `('project', 'phase')`
- `phase` text nullable — free-form for phase-tier rows (e.g. `'Floor 2'`, `'Wing A'`, `'all'`)
- `due_date`, `completed_date` date (`completed_date` set when marked complete)
- `owner_id`, `created_by` uuid → `profiles`
- `created_at`, `updated_at` timestamptz
- **Status is computed client-side** by `computeMilestoneStatus()` in `types.ts` from `due_date` / `completed_date`: `complete` / `overdue` / `at_risk` (within 7 days) / `upcoming`. Never persisted — single source of truth lives in the dates.
- **RLS:** project members read/manage. Indexed by `project_id` and `due_date`.

#### `warehouses` (`add_warehouses.sql`)
- `id` uuid PK, `name` text NOT NULL
- `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `notes` text (default `''`)
- `is_active` boolean default `true` — soft-delete; inactive rows hide from purchasing dropdowns but historical purchasing rows still resolve the name
- `created_by` uuid → `profiles`, `created_at`, `updated_at` timestamptz
- **Org-wide table**, not project-scoped — Phase 1 assumption is one warehouse list shared across all Instrata projects.
- **RLS:** any authenticated user reads (`auth.uid() is not null`); admin only (`profiles.role='admin'`) for INSERT/UPDATE/DELETE. Settings UI exposes the CRUD; non-admins won't see the section.
- Indexed by `is_active`.

#### `purchasing_modules` (`add_purchasing.sql`)
- `id` uuid PK, `project_id` uuid → `projects` CASCADE
- `title`, `notes` text (default `''`)
- `created_by` uuid → `profiles`, `created_at`, `updated_at` timestamptz
- A purchasing module is the work surface that converts one or more linked submittals into POs. Multiple modules per project are allowed (e.g. one per submittal, or one aggregating several).
- **RLS:** project members read/manage. Indexed by `project_id`.

#### `purchasing_module_submittals` (`add_purchasing.sql`)
- Junction: `purchasing_module_id` uuid → `purchasing_modules` CASCADE, `submittal_id` uuid → `submittals` CASCADE, `linked_at`, `linked_by`. Unique on (`purchasing_module_id`, `submittal_id`).
- Lets one purchasing module live-link many submittals and one submittal feed many modules. Items flow through automatically — there's no per-item snapshot.
- **RLS:** project members (resolved via the module's `project_id`).

#### `purchasing_items` (`add_purchasing.sql`)
- `id` uuid PK
- `purchasing_module_id` uuid → `purchasing_modules` CASCADE
- `submittal_item_id` uuid → `submittal_items` CASCADE — ties each persisted purchaser row to the underlying submittal item; cascade-delete keeps the table clean if the upstream item is removed (deletion of ordered+ submittal items is blocked at the store layer)
- Purchaser-entered: `purchase_unit_price` numeric, `ship_to_warehouse_id` uuid → `warehouses` ON DELETE SET NULL, `ship_to_custom_address` text, `need_by_date` date, `po_number` text, `notes` text
- `purchase_status` text CHECK ∈ `('not_ordered', 'ordered', 'received')` default `'not_ordered'`. The `'draft'` and `'pending_approval'` visual states are computed at render from the submittal's package status + the item's `approval_state` — never persisted here.
- `ordered_date`, `received_date` date — auto-set to today by the store when status advances; overridable
- `updated_by` uuid → `profiles`, `created_at`, `updated_at` timestamptz
- **Lazy persistence** — a row is only written once the purchaser interacts with the line. Display data (mfr, model, qty, sold-in price, vendor) is always live-resolved from the linked `submittal_items` + `project_bom_items`.
- Unique on (`purchasing_module_id`, `submittal_item_id`). **RLS:** project members (resolved via the module's `project_id`). Indexed by both module id and submittal item id.

#### `purchasing_freight` (`add_purchasing.sql`)
- One row per (`purchasing_module_id`, `manufacturer`) — same shape as `purchasing_items` minus the submittal item link, plus a `manufacturer` text column.
- Columns: `purchase_unit_price`, `ship_to_warehouse_id`, `ship_to_custom_address`, `need_by_date`, `purchase_status`, `ordered_date`, `received_date`, `po_number`, `notes`.
- The detail page **always renders a freight row** per manufacturer; the DB row is created lazily on first edit.
- Phase 1 captures actuals only; future "freight margin vs. quoted" math will hang off this table.
- Unique on (`purchasing_module_id`, `manufacturer`). **RLS:** project members.

#### `purchasing_manufacturer_defaults` (`add_purchasing.sql`)
- One row per (`purchasing_module_id`, `manufacturer`).
- Columns: `ship_to_warehouse_id`, `ship_to_custom_address`, `need_by_date`.
- Per-manufacturer default ship-to and need-by — `purchasing_items` rows inherit these unless explicitly overridden. The detail-page UI greys-out an inherited value to make the override behavior obvious.
- Unique on (`purchasing_module_id`, `manufacturer`). **RLS:** project members.

### Database Functions

| Function | Type | Purpose |
|---|---|---|
| `is_admin() → boolean` | SECURITY DEFINER, STABLE | Returns true if `auth.uid()` has `role = 'admin'` in `profiles`. Must be SECURITY DEFINER so the internal `profiles` query bypasses RLS — inline subqueries inside profiles policies cause infinite recursion. Used by the admin SELECT/ALL policies on `profiles`. |
| `is_project_member(_project_id uuid) → boolean` | SECURITY DEFINER, STABLE | Reused everywhere as the canonical "can see this project" check: admin, OR `projects.created_by = auth.uid()`, OR a row in `project_members`. |
| `set_updated_at()` | trigger fn | Generic — sets `NEW.updated_at = now()`. Wired to `projects` only. |
| `handle_new_user()` | SECURITY DEFINER | After-insert trigger on `auth.users` — inserts a `profiles` row with `email` + `full_name` from `raw_user_meta_data`. |
| `cutsheet_is_admin() → boolean` | SECURITY DEFINER | Mirrors the `profiles.role='admin'` check, used inside cutsheet RLS policies. |
| `search_catalog(search_term, page_from, page_to)` | RPC | Paginated catalog search; each word must match mfr/model/description; mfr/model hits rank above description-only. Returns `total_count`. |
| `generate_project_code() → text` | atomic UPSERT | Returns the next `INST-YYYY-NNNN` value. UPSERTs `project_code_counters` for the current year, returning the incremented `last_seq` in the same statement. Per-year sequence reset. Race-safe under concurrent calls (used by both `monday-backfill` parallel workers and the `monday-webhook` create handler). |
| `seed_project_code_counter(year int, min_seq int)` | RPC | Bumps `project_code_counters.last_seq` to at least `min_seq` for the given year. Idempotent — never decreases. Used by `monday-backfill` to absorb codes already written to Monday from prior partial runs so we don't regenerate values that already exist on the Monday side. |

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

### Change Orders (`add_change_orders.sql`)

| Table | Purpose |
|---|---|
| `change_orders` | Read-only mirror of DTools COs. Owned by `dtools-project-lookup` Edge Function (service role writes; project members read). Columns: `number`, `title`, `description`, `amount` (signed delta), `status` ∈ `Pending`/`Approved`/`Rejected`, `category` ∈ `Internal`/`External`, `requested_at`, `resolved_at`, `dtools_id`. UNIQUE (`project_id`, `dtools_id`) so re-syncs upsert without duplicates. CASCADE delete with parent project. |

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
- **Vendor extraction:** `extractPricedFrom()` walks each item's custom-fields shape (array `CustomFields[]` / `ItemCustomFields[]` plus flat fallbacks `CustomField1` / `customField1` / `PricedFrom`) and writes the value to `project_bom_items.priced_from`. The Purchasing module displays this verbatim in the Vendor column. When the item is grouped (same mfr+model+unit_cost across rows), the first non-empty `priced_from` wins.
- **Change Orders:** Step 9 of the same sync re-queries `/Subscribe/Projects?projectNumber={N}&pageSize=200` and filters for `IsChangeOrder=true`. Each surviving row is a CO Project record with the metadata flat on the row (`CONumber`, `COName`, `CONotes`, `COType`, `COStatus`, `COCreatedOn`, `COAcceptedOn`, `CORejectedOn`, `Price`); `mapCOStatus()` and `mapCOCategory()` normalize. Wipes + re-inserts `change_orders` rows for the project so re-syncs are idempotent and prune COs DTools removed. Wrapped in try/catch — a CO sync failure logs but doesn't fail the BoM import. **Gotcha:** DTools is pure publish/subscribe. A CO only enters our subscription queue when a SI user explicitly publishes it (`POST /Publish/Projects/NewChangeOrder`). If a CO exists in DTools desktop but was never published to the API integration, the cloud API has no record of it and `coCount` will be 0 — that's expected, not a bug. The fix is on the SI user's side: publish the CO, then re-sync.
- **External APIs:** D-Tools
- **Tables touched:** `project_bom_items` (DELETE/INSERT), `change_orders` (DELETE/INSERT), `projects` (UPDATE)

### `monday-manager-dashboard`
- **Purpose:** Pull "New Requests" group from Pre-Sales board, return two buckets: `triage` (date set, no engineer) and `review` (status="Review"). Both sorted by due date asc. Optional `debugNameQuery` dumps raw column data for matching item names.
- **External APIs:** Monday GraphQL v2024-10
- **Tables touched:** none (read-only Monday → response)

### `monday-webhook`
- **Purpose:** Live sync from Monday → Project Tools. Handles two event types from both Pre-Sales (3477536693) and Post-Sales (3523133226) boards:
  - `create_pulse` (new item) — Pre-sales: assigns Project ID via `generate_project_code()`, writes back to Monday's Project ID column, upserts a Supabase row with `phase='Pre-Sales'`. Post-sales: looks up by `project_code` (Monday's pre-sales→post-sales duplication automation copies the Project ID along with the item), flips phase to `Post-Sales` and links the post-sales item id. Generates a fresh code if the duplicated item somehow arrives without one.
  - `change_status_column_value` on `status9` — looks up the Supabase row by the right item-id column for the firing board and updates `status`. If no row is linked yet (race between create and status events), falls through to the create handler. Idempotent.
- Compatible with both **native API webhooks** and the **"When X happens, send a webhook"** Monday automation payload shape (sniffed via field presence; `event.type` is sometimes absent on automation payloads).
- Echoes `{challenge}` for Monday subscription handshake.
- **External APIs:** Monday GraphQL v2024-10
- **Tables touched:** `projects` (UPSERT), `project_code_counters` (via `generate_project_code()` RPC)

### `monday-backfill`
- **Purpose:** Admin-only one-shot recovery / first-time-population. Walks both Monday boards, normalizes statuses, filters to active subset, detects + clears duplicate codes (recovers from race-leftover state), generates fresh codes for items missing them (writes back to Monday), reconciles to one Supabase row per `project_code` via bulk upsert.
- **Active filter:** Pre-sales `{Not Started, In Progress, On Hold, Review, Follow Up, Rebid}`; Post-sales `{Won, Not Started, In Progress, Install, Close Out}`. Items in any other status stay in Monday and are not synced. Re-bids / status flips into an active state are picked up later by the webhook on demand.
- **Sibling matching** (post-sales item ↔ pre-sales item with shared identity): exact name match first; falls back to fuzzy Jaccard token overlap (≥0.7 with ≥3 shared tokens). Catches cases where Monday's duplication automation kept a slightly-different name (e.g. dropping `"80%"` from `"GMP - 80%CD Drawing Set"`).
- **Concurrency** capped at 3 to stay under Monday's 10M-complexity-per-minute rate limit (each `change_simple_column_value` mutation costs ~30k complexity → ~333 writes/min ceiling). Retries on `COMPLEXITY_BUDGET_EXHAUSTED` 429s, honoring Monday's `retry_in_seconds` with jitter.
- **Modes:** `{}` for real run; `{dryRun:true}` simulates without any Monday or Supabase writes and returns synthetic match counts plus an `unmatchedPostsales` list and a `fuzzyMatches` review set; `{forceClear:true}` (scaffolded) wipes all codes from active items before regenerating.
- Idempotent — safe to re-run; items that already have unique codes are skipped from regeneration.
- **External APIs:** Monday GraphQL v2024-10
- **Tables touched:** `projects` (bulk UPSERT on conflict `project_code`), `project_code_counters` (via `generate_project_code()` and `seed_project_code_counter()` RPCs), `profiles` (admin gate)

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
| Monday Live Phase + Status Sync | Complete | `monday-webhook` handles `create_pulse` + `change_status_column_value` on both Pre-Sales (3477536693) and Post-Sales (3523133226) boards. `monday-backfill` for one-shot population/recovery. `INST-YYYY-NNNN` `project_code` is the persistent link across boards, written to Monday's Project ID text column on both sides. Dashboard Pipeline Bar is phase-aware with separate tile sets per board. |
| D-Tools Project Import | Complete | `ProjectNew` "Import from DTools" modal → `dtools-list-projects` + `dtools-import-project`. Idempotent on `dtools_project_id`. Picker extracted to `DToolsImportPicker.tsx` and reused by the BoM sync flow. |
| D-Tools BoM Sync | Complete | `dtools-project-lookup` writes per-line cost/price/labor/margin/owner-furnished/optional flags. The "Sync from DTools" button on the BoM page opens `DToolsImportPicker` for Monday-imported projects that aren't yet linked (`linkDToolsAndSyncBoM` store action records `dtools_project_id` + DTools number/value, then triggers the sync); already-linked projects re-sync directly. Same sync also pulls Change Orders (see row below). |
| Change Orders (Project Quote) | Complete | Read-only mirror of DTools COs, rendered inside the existing Project Quote card on Project Overview. Three collapsible groups (**Approved** green / **Pending** orange / **Rejected** gray, all collapsed by default) under the BoM table, each row showing the CO number, title, Internal/External category chip (navy = Internal, orange = External — both modify the bottom line), description, dates, DTools id, and signed dollar delta. Pending rows carry a "Not in contract" pill; rejected rows render with line-through + muted opacity. Below the groups, a Contract Value summary band: `Original Contract + Approved CO Δ = Current Contract Value` equation, with a separate orange Pending Exposure callout when pending COs exist. Pulled by the same "Sync from DTools" button as the BoM (see Edge Function row in §4). Backed by `change_orders` table (`add_change_orders.sql`). |
| D-Tools Sync Indicator | Complete | `DToolsSyncDot.tsx` — green/red status dot rendered next to every project name on the dashboard's My Projects list and the Projects table. Driven by `project.dtoolsProjectId` presence. |
| BoM Location View | Complete | `BoMLocationView.tsx` — qty per room. |
| Catalog (Products) | Complete | `ProductsPage.tsx`, `CatalogImportModal`, `CatalogViewerModal`, `CSVImportModal`, `CellMapperModal`, `search_catalog` RPC. |
| Catalog Sync from D-Tools | Complete | `app/src/lib/dtools/api-sync.ts` + `import-catalog.ts`; uses `last_synced_at` / `dtools_updated_on` for incremental. `CatalogSyncStatus.tsx` UI. |
| Cutsheet Repository (Browse) | Complete | `CutsheetRepository.tsx` page; `cutsheet_repository` + SharePoint download URLs on demand. |
| Cutsheet Staging Upload (Phase 2) | Complete | `sharepoint-cutsheet` `uploadStaging` op — auto-attached during submittal builder. |
| Cutsheet Triage (Admin Review) | Complete | `CutsheetReview.tsx` — list/approve/reject/duplicate via `sharepoint-cutsheet`. Promotes pending submittal links to canonical repo links on approval. |
| Cutsheet My Uploads | Complete | `CutsheetMyUploads.tsx` — uploader can track their own pending items. |
| Submittals | Complete | `SubmittalList`, `SubmittalDetail`, `exportSubmittalPDF`, `submittalExclusions.ts`. Items link to repo or staging cutsheets via the two FK columns. **Per-item approval** (`add_submittal_item_approval.sql`): `Approve` / `R&R` / `Reset` actions render in the items table when status is Submitted or R&R, hidden in Draft, locked-as-approved badges in Approved. Package status auto-promotes to Approved when every item is approved and auto-demotes to R&R when an item is reverted; package marks preserved across Approved → Submitted transitions. Item delete is blocked downstream if any linked Purchasing module has the item ordered+. |
| Closeout Package | Complete | `CloseoutDashboard.tsx`, `exportCloseoutPDF.ts`, `exportSignOffPDF.ts`. Six tabs: Warranties, Punch List, Test & Sign-Off, As-Built Drawings, Manuals, Quick Start Guide. Closeout cover-page + punch section restyled to match the standalone Punch List PDF (grouped by location with checkboxes); items with empty location now group under `Unassigned` instead of being silently dropped. |
| Punch List PDF Export | Complete | `exportPunchListPDF.ts` — Instrata-branded cover, items grouped by location with hollow checkboxes for field walkthroughs, item numbers, wrapped descriptions, red-bold `Critical` priority, pre-checked + green for `Complete` rows. Wired to the Closeout → Punch List tab. |
| Test & Sign-Off PDF | Complete | `exportSignOffPDF.ts` — one page per room with a navy band header, items table with `Done` checkboxes, then the room sign-off statement (*"Instrata has completed the full scope of this room…"*) and a dual signature block (Client Representative + Instrata Representative — signature, printed name, date lines for each). |
| Quick Start Guide | Complete | New tool on the closeout dashboard. `quick_start_rooms` + `quick_start_steps` tables. Add Room modal accepts a custom name (for projects whose BoM is keyed by equipment) or picks from the project's BoM location list (incl. sub-locations); already-added rooms are dimmed. Each room renders as a card with inline-editable steps, each step has a `text` field and an optional `note` field. |
| O&M / Owner Manual | Complete | `OwnerManual.tsx`, `exportManualsPDF.ts`, `extractBookmarks.ts`. Skill-equivalent in-app. |
| RFI List | Complete | `RFIList.tsx`, `exportRFIPDF.ts`. |
| Auto Reviewer | Complete (schema + page) | `AutoReview.tsx`, `ReviewQueue.tsx`, `reviewEngine.ts`, `reviewReport.ts`. Backed by `review_runs`, `review_flags`, `review_config`, `labor_rates`. |
| Bid Leveling Generator | In Progress | Schema + `BidLevelingPage.tsx` + `bidLevelingEngine.ts` exist; spec is `BidLevelingGenerator_Phase1_Spec.docx` (Phase 1). |
| Personal Ops Dashboard | In Progress | `PersonalOpsPage.tsx`, `usePersonalOps.ts`, `EmailDigestCard`, `ConnectEmailBanner`, `EmailActionBar`, `SessionSelector`. Functions wired (`ms-graph-auth`, `ms-graph-emails`, `email-triage`). Spec at `personal_ops_feature_spec.html`. |
| Effort Survey | Complete | `EffortSurvey.tsx`. |
| Project Sections — Operations | Live (Schedule + Purchasing) | Sidebar group + Overview tool card render alongside Pre-Sales / Post-Sales with green accent. Schedule & Milestones and Purchasing are now live links with real counts; Inventory is still scaffolded (`SidebarDisabledLink`, dimmed in the Overview card). |
| Project Log card (Activity, Files & History) | Live (Comments) | `ProjectLog.tsx` on the Overview between the tool grid and BoM. Three tabs (Comments / Files / Client GC Log) with full header, tab pills with live counts, and per-tab CTAs (Export PDF on Client/GC Log, Download all on Files). Comments tab is fully wired (see row below); Files and Client / GC Log render empty-state placeholders. |
| Schedule & Milestones | Complete | `pages/operations/ScheduleMilestones.tsx` — two-tier list (project / phase) with computed status badges (`upcoming` / `at_risk` / `overdue` / `complete`), 7-day at-risk window, mark-complete prompt with optional note, edit/delete with confirmation, read-only Timeline view toggle, "Apply Default Commercial AV Template" wizard (12 milestones, +14 to +150 day offsets defined in `utils/milestoneTemplates.ts`). Project Overview surfaces a Next-3 milestones widget below the tool group cards. Phase 1 spec at `Product Spec/milestone-tracking.md`. |
| Purchasing | Complete | `pages/operations/PurchasingList.tsx` (modules per project) + `pages/operations/PurchasingDetail.tsx` (manufacturer-grouped table). Each module live-links one or more submittals with a persistent `+ Add Submittal` button. Detail view shows mfr/model/desc/qty/sold-in price (`unit_cost`)/vendor (`priced_from`) live-resolved, with inline-editable purchase price, ship-to (warehouse picker + custom address), need-by date, and PO number. Per-manufacturer header carries default ship-to + need-by; per-item rows inherit (greyed) unless overridden. Status advances `not_ordered → ordered → received` with auto-set dates. Always-visible freight row per manufacturer. Persistent red warning banner lists ordered items whose submittal-side approval has been reverted, until re-approved. Phase 1 spec at `Product Spec/02-purchasing-equipment-status.md`; deferred items tracked in `Product Spec/future_features.md`. |
| Warehouses | Complete | Org-wide ship-to destinations with name + address + active flag. Settings page exposes admin-only CRUD (`SettingsPage.tsx → WarehousesSection`). Backed by `warehouses` table; consumed by Purchasing module ship-to dropdowns. |
| Inventory | Future | `app/src/pages/operations/Inventory.tsx` exists with full styling but is not wired to a route. |
| Comments (Project Log) | Complete | Live chat thread on every project. Composer with ⌘+Enter shortcut, deterministic colored avatar chip + name + timestamp on every post, flat replies that default collapsed behind a blue notification badge showing the reply count, edit/delete on your own (admins on any), 6-emoji reaction picker (👍 ❤️ 😂 🎉 🚀 👀) with toggle semantics. Scrollable history bounded at 480px with an Expand toggle to 820px once the thread overflows. Any authenticated user can read and post — project membership is not required. Backed by `project_comments` (`add_project_comments.sql`); demo mode renders a "requires Supabase" notice in the tab. Lazy-loaded per project on `ProjectLog` mount. |
| Files (Project Log) | Future | Standardized project file repository (Contracts / Drawings / Submittals / Meeting Notes / Photos / Closeout). Tab placeholder lives in `ProjectLog.tsx`. |
| Client / GC Log | Future | Auto-generated timeline of client-level changes — meetings, base-bid contracts, change-order tracking (Requested / Proposed / Rejected / On Hold / Accepted), milestone completions. Branded PDF export. Tab placeholder lives in `ProjectLog.tsx`. |
| Monday Auto Project Creation | Replaced | Was deliberately no-op; `monday-webhook` now actively creates Project Tools rows on `create_pulse` events from either Monday board (different from the old "create on status=Review" behavior — every new Monday item lands in Project Tools). |
| Settings | Complete | `SettingsPage.tsx`. |
| Auth (Login / Register) | Complete | `Login.tsx`, `Register.tsx`, `AuthContext.tsx`. |

---

## 6. Monday.com Reference

### Boards
| Board | ID | Used by |
|---|---|---|
| AV Pre-Sales Summary | `3477536693` | `monday-backfill`, `monday-webhook`, `monday-manager-dashboard` |
| Post-Sales (Project Delivery) | `3523133226` | `monday-backfill`, `monday-webhook` |

### Project ID convention
Format: `INST-YYYY-NNNN` (e.g. `INST-2026-0042`). Year-prefixed sequence with per-year reset, generated atomically via `generate_project_code()`. The same code is written to **both boards' Project ID text columns** when a sibling pair is identified, so the link survives Monday's pre-sales→post-sales duplication automation. `project_code` (not `monday_item_id`) is the canonical key in `projects`.

### Columns
| Board | Column ID | Type | Meaning |
|---|---|---|---|
| Pre-Sales | `status9` | Status | Workflow status — values: `Not Started`, `In Progress`, `On Hold`, `Review`, `Follow Up`, `Won`, `Lost`, `Declined to Bid`, `Rebid` (Monday "ON HOLD" gets normalized to `On Hold` in Project Tools). |
| Pre-Sales | `text_mm2rcnav` | Text | Project ID — written by `monday-backfill` and `monday-webhook`. |
| Pre-Sales | `date7` | Date | Due date — Manager Dashboard triage sort key. |
| Pre-Sales | `person` | People | Pre-sales engineer assignment. Empty / `personsAndTeams: []` = unassigned. |
| Pre-Sales | `numbers9` | Number | Subscribed by an older legacy webhook (id `463066419`); not used by current code. |
| Post-Sales | `status9` | Status | Workflow status — values: `Won` (landing state from pre-sales duplication), `Not Started`, `In Progress`, `Install`, `Close Out`, `Completed`. |
| Post-Sales | `text_mm2rsn` | Text | Project ID — mirrors the pre-sales sibling's code. Copied automatically by Monday's pre-sales→post-sales duplication automation. |

### Groups
| Board | Group Title | Used by |
|---|---|---|
| Pre-Sales | `New Requests` | `monday-manager-dashboard` (case-insensitive title match) |

### Webhook subscriptions (per board)
Both boards subscribe to two events pointing at the `monday-webhook` edge function:
- `create_pulse` (any new item, no filter) — triggers Project Tools row creation + Project ID assignment.
- `change_status_column_value` on `status9` (any value, no filter) — keeps the Project Tools `status` field in sync.

Compatible with both **native API webhooks** (`webhooks` GraphQL mutation) and **automation-recipe webhooks** ("When X happens, send a webhook"); the function sniffs payload shape via field presence.

### Embedded Business Rules
- **Active set for Project Tools sync:**
  - Pre-Sales: `Not Started`, `In Progress`, `On Hold`, `Review`, `Follow Up`, `Rebid`
  - Post-Sales: `Won`, `Not Started`, `In Progress`, `Install`, `Close Out`
  - Excluded (stay in Monday only, not synced): pre-sales `Won` / `Lost` / `Declined to Bid`; post-sales `Completed`. Pre-sales `Won` items already have post-sales duplicates per the Monday automation, so they enter Project Tools via the post-sales side.
- **Phase derivation:** items appearing on the Post-Sales board get `phase='Post-Sales'`; items only on Pre-Sales get `phase='Pre-Sales'`. Enforced by `monday-backfill`'s merge step and `monday-webhook`'s `create_pulse` handler.
- **Manager Dashboard triage:** `dueDate set AND person column has no assignees` → "Triage" bucket.
- **Manager Dashboard review:** `status9.text === 'review'` (case-insensitive) → "Review" queue, sorted by due date asc.
- **Status normalization:** `"ON HOLD"` → `"On Hold"`. Other values pass through unchanged so a new Monday status flows through without code changes (renders with default StatusBadge styling until colors are wired).
- **Rate limiting:** every Monday GraphQL mutation costs ~30k complexity against the 10M/min budget (≈333 writes/min ceiling). `mondayQuery()` retries on `COMPLEXITY_BUDGET_EXHAUSTED` 429s, honoring Monday's `retry_in_seconds` with jitter; `monday-backfill` uses a concurrency cap of 3 to stay under the ceiling.
- **API version pinned** to `2024-10` in every function.

### Monday-side automation (configured manually, not in code)
- When status on a pre-sales item changes to **Won**, Monday duplicates the item to the Post-Sales board, copying selected columns including the Project ID text column. This is what makes the cross-board `project_code` link self-sustaining.

---

## 7. Environment & Secrets

> Names only. Set as Supabase function secrets (server-side) or build-time vars (client-side, `VITE_*`).

### Supabase Edge Function Secrets

| Secret | Used by |
|---|---|
| `SUPABASE_URL` | every function |
| `SUPABASE_SERVICE_ROLE_KEY` | every function |
| `DTOOLS_API_KEY` | `dtools-list-projects`, `dtools-import-project`, `dtools-project-lookup` |
| `MONDAY_API_TOKEN` | `monday-manager-dashboard`, `monday-webhook`, `monday-backfill` |
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
- Monday board id `3477536693` falls back in code if env unset. Post-sales board `3523133226` is hard-coded in `monday-backfill` and `monday-webhook` (not wired to env).
- Project ID column ids (`text_mm2rcnav` pre-sales, `text_mm2rsn` post-sales) and the status column id (`status9`, same on both boards) are hard-coded in `monday-backfill` and `monday-webhook`.
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
- `monday-webhook` accepts any signed Monday payload — webhook **signature verification is not implemented**. Anyone with the function URL could POST arbitrary events. Mitigate by enabling Monday's signed-webhook feature and verifying the `Authorization` / signature header before processing.
- `monday-backfill` `forceClear` mode is scaffolded (the body flag is parsed) but the wipe-then-regenerate behavior wasn't needed in the recovery path that shipped — kept as a safety hatch for future re-syncs.
- Status field on `projects` is **free-text** (no DB CHECK). Status normalization is intentionally minimal — only `"ON HOLD"` gets case-corrected. New Monday status values flow through verbatim; the app falls back to default StatusBadge styling for unknown values until colors are wired in `app/src/components/StatusBadge.tsx`.
- 7 post-sales items (per the most recent backfill) don't match any pre-sales sibling and exist as standalone Project Tools rows. If any of those should later be merged into a pre-sales project, no UI exists yet — must be done by hand in SQL by updating `project_code`.
- `monday_item_id` (legacy single-board pointer) is retained on the `projects` row for backward compatibility but is no longer the canonical link. Drop it once we're confident nothing reads it.

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

### 2026-05-26
- **Bug fix — admin RLS infinite recursion on `profiles`.** Admins could see their own role correctly (Settings showed "admin") but the Team Members list and the project member dropdown still returned only the current user's own row. Root cause: the `"Admins can view all profiles"` and `"Admins full access to profiles"` policies used an inline `EXISTS (SELECT 1 FROM public.profiles …)` subquery — querying `profiles` from within a `profiles` policy triggers Supabase's RLS recursion guard, which silently falls back to only the policies that don't self-reference. Fix: introduced `public.is_admin()` as a SECURITY DEFINER function (same pattern as the existing `is_project_member()`), then dropped and recreated both admin policies to call it instead. Migration: `supabase/migrations/fix_admin_rls_recursion.sql`. `migration.sql` updated to include `is_admin()` for fresh installs.
- **Project visibility opened to all authenticated users.** Monday-created projects were invisible to anyone not explicitly added as a `project_members` row, because the SELECT policy on `public.projects` was gated to `is_project_member()`. Changed to `auth.uid() IS NOT NULL` so every logged-in user sees all projects. UPDATE, DELETE, INSERT policies are unchanged. Migration: `supabase/migrations/open_project_visibility.sql`. The Dashboard's `myProjects` filter (which scopes the list to projects owned by the current user, falling back to all projects if none match) is intentionally left in place — that frontend filtering is a separate upcoming refactor.
- **`ProjectMembersModal` — Add button layout fix.** The Add button was overflowing the right edge of the modal. The `<select>` lacked `min-w-0`, preventing it from shrinking below its intrinsic width in the flex row and pushing the button outside the modal boundary. Added `min-w-0` to the select and `flex-shrink-0` to the button.
- **`ProjectMembersModal` — improved dropdown states.** The available-users fetch previously had no loading state of its own and swallowed errors silently, making "still loading", "fetch failed", and "no users to add" all look identical (empty select). Added `loadingUsers` and `userFetchFailed` flags with distinct placeholder text for each state: *"Loading team members…"* / *"Failed to load users — try reopening"* / *"All users are already on this project"*.

### 2026-05-03
- **Change Orders on Project Quote — feature shipped.** New section inside the existing Project Quote card on Project Overview. Three collapsible groups (Approved / Pending / Rejected, all collapsed by default) sit between the BoM table and a new **Contract Value summary** band (`Original + Approved Δ = Current Contract Value`, hero number in navy). Each CO row shows number, title, Internal/External category chip, description, dates, DTools id, signed dollar delta. Pending rows carry a "Not in contract" pill; rejected rows render line-through + muted. A separate orange Pending Exposure callout surfaces unresolved capital so it can never be confused with the contract total. Implementation matches the design handoff verbatim while preserving the existing Project Quote card styling otherwise. Type added (`ProjectChangeOrder`), store hydrates from `change_orders` table on `fetchAllData` and refreshes per-project after `syncDToolsBoM`.
- **DTools sync — change-order import.** `dtools-project-lookup` Edge Function now also pulls COs after the BoM step. Re-queries `/Subscribe/Projects?projectNumber={N}&pageSize=200`, filters `IsChangeOrder=true`, fetches detail by Id when summaries are returned, maps DTools' flat `CO*` fields (`CONumber` / `COName` / `CONotes` / `COType` / `COStatus` / `COCreatedOn` / `COAcceptedOn` / `CORejectedOn` / `Price`) to the new `change_orders` table, wipes + re-inserts per project. CO sync wrapped in try/catch so failure never blocks BoM import. Migration: `add_change_orders.sql` (UNIQUE on `(project_id, dtools_id)`, RLS via `is_project_member`, service-role writes only).
- **DTools — publish/subscribe gotcha documented.** Discovered through 8 iterations of probing (parent CO* values, item `COChangeTypeId` markers, `OriginalApprovedItemId`, `IntegrationProjectId` linked siblings, `scIdNumber`-based enumeration, custom-field value scan, alternate endpoints `revision=all` / `includeChangeOrders=true` / `Estimates` / `ProjectRevisions`, list-call permutations across `progresses` / `suiteImported` / `includeDeleted`) that COs in this DTools tenant don't surface via the cloud API at all — even though they appear in the desktop CSV export with `CO Number` and `CO Type` columns. The DTools SI API doc confirms the answer: `/Subscribe/Projects` is described as "projects **and change orders** published by a SI user" — emphasis on *published*. A CO only enters our subscription when a SI user explicitly publishes it via `POST /Publish/Projects/NewChangeOrder`. Existing approved COs that were never published won't appear, no matter what filter combination is used. Fix is on the SI user's side: publish the CO from DTools, then re-sync. Edge Function comment block in `Step 9` documents this so the next person who sees `0 change orders imported` knows it's expected behavior, not a bug.

### 2026-04-30
- **Project Comments — feature shipped.** Live chat thread on the Project Overview, replacing the empty-state placeholder in `ProjectLog.tsx`'s Comments tab. New `project_comments` table with `parent_id` self-reference for flat (one-level) replies, JSONB `reactions` array of `{emoji, userIds[]}` so toggle is just bucket membership. **RLS is explicitly relaxed**: any authenticated user can read + post — project membership is not required, so a teammate can drop in to help on a project they aren't formally assigned to. Authors and admins can edit/delete their own; cascades to replies. UI: composer with ⌘+Enter, deterministic per-user avatar color (8-color palette hashed off user id), name + friendly timestamp, replies collapsed by default behind a blue notification badge showing the reply count, 6-emoji reaction picker (👍 ❤️ 😂 🎉 🚀 👀) with active-mine highlighting, edit-in-place / delete-with-confirm on your own posts. Scrollable history bounded at 480px with an Expand toggle to 820px that surfaces once the thread overflows. Lazy-loaded per project on `ProjectLog` mount so the tab badge count is accurate before the user opens the tab. Demo mode (no Supabase) renders a "requires Supabase" notice in the tab. Migration: `add_project_comments.sql`.
- **Project Overview — top row alignment.** Switched the Timeline / Team row from `grid-cols-[2fr_1fr]` to `grid-cols-3` with `col-span-2` on the Timeline card. The 2fr/1fr split was leaving Timeline's right edge G/3 short of Post-Sales' right edge below; the unified 3-col grid lines them up edge-to-edge and Team aligns with Operations.
- **Project Overview — equal-height tool group headers.** Pre-Sales / Post-Sales / Operations card headers were rendering at different heights because Post-Sales' shorter description text wraps to one line while the other two wrap to two. Pinned `line-height: 1.45` and set `min-height: calc(2 * 1.45 * 13px)` on the description div so single-line copy occupies the same vertical box as 2-line copy. Also flipped the header flex from `items-center` to `items-start` so the eyebrow aligns at the same y across all three cards.

### 2026-04-29
- **Milestones — feature shipped.** Two-tier model (project + phase) with the 17-value type registry split between contractual project-tier and operational phase-tier. Status (`upcoming` / `at_risk` / `overdue` / `complete`) is **computed client-side** from `due_date` / `completed_date` so it can't drift from reality. Default Commercial AV template (12 milestones, +14 to +150 day offsets, anchored off a project start date) lives in `app/src/utils/milestoneTemplates.ts`. New page `pages/operations/ScheduleMilestones.tsx` replaces the staged scaffold with a list view (sectioned project / phase, action menu per row, mark-complete prompt with optional note) and a read-only Timeline toggle. Project Overview surfaces a Next-3 widget below the tool group cards. Spec: `Product Spec/milestone-tracking.md`. Migration: `add_project_milestones.sql`.
- **Submittal item-level approval (refactor of the Submittals module).** New `submittal_items.approval_state` column (`pending` / `approved` / `revise`) with `approval_changed_at/by`. SubmittalDetail renders a new Approval column with `Approve` / `R&R` / `Reset` actions visible only when package status is Submitted or R&R, locked-as-approved badges in Approved, hidden in Draft. Cascade rules live in `store.updateSubmittal` and `store.setSubmittalItemApproval`: package → Approved cascades all items to `'approved'`; package → Draft resets all to `'pending'`; package → Submitted/R&R preserves item marks (so an Approved → Submitted revert keeps history). Per-item edits auto-promote the package to Approved when all items hit `'approved'` and auto-demote to R&R when any item is reverted. `deleteSubmittalItem` now throws if any linked Purchasing module already has the item ordered; the SubmittalDetail UI surfaces the message via alert. Migration: `add_submittal_item_approval.sql`.
- **Warehouses (Settings, admin-only).** New `warehouses` table — org-wide ship-to destinations with `name`, address fields, `is_active` flag, soft-delete (inactive hides from dropdowns but historical purchasing rows still resolve the name). RLS: any authenticated read, admin-only write. Surfaced in SettingsPage as a new admin-gated section with create / edit / delete. Migration: `add_warehouses.sql`.
- **Purchasing & Equipment Status — feature shipped (Phase 1 scope).** New routes `/projects/:projectId/purchasing` (list) and `/purchasing/:purchasingId` (detail). A purchasing module live-links one or more submittals via `purchasing_module_submittals` junction; persistent `+ Add Submittal` button on the detail page lets a PA aggregate or split as needed. The detail page renders manufacturer-grouped tables: each header carries default ship-to (warehouse picker or custom address) + need-by date that rows inherit, with per-item overrides taking precedence (greyed out on inherited rows for visual clarity). Per-row inline edits: purchase unit price, ship-to, need-by, PO number. Status advances `not_ordered → ordered → received` via badge dropdown with auto-set dates (overridable). Display data (mfr / model / desc / qty / sold-in price / vendor) is **live-resolved** from `submittal_items` + `project_bom_items` — never snapshotted, so changes to the upstream submittal flow through automatically. Always-visible freight row per manufacturer captures actuals (margin-vs-quoted math deferred). Persistent red warning banner lists every item that's been ordered but whose submittal approval has been reverted; clears automatically when the item is re-approved. Spec: `Product Spec/02-purchasing-equipment-status.md`. Migrations: `add_purchasing.sql`, `add_priced_from_to_bom.sql`. Deferred items (Excel PO export, pick list wizard + PDF, partial-qty splits, notes thread per item, long-lead tagging, mobile views, change-order linkage, freight margin math, PO bulk-assign, full equipment status `received → inspected → on_site → installed → commissioned` chain, summary dashboard) are tracked under feature 2 in `Product Spec/future_features.md`.
- **DTools sync — `priced_from` extraction.** `dtools-project-lookup` now extracts each item's Custom Field 1 ("Priced From", typically `"VENDOR MM/DD/YY"`) via `extractPricedFrom()` (handles `CustomFields[]` / `ItemCustomFields[]` array shapes plus `CustomField1` / `customField1` / `PricedFrom` flat fallbacks) and writes it to `project_bom_items.priced_from`. The Purchasing module renders the value verbatim in the Vendor column. Intentionally hidden from the project overview BoM table — purchasing-only. Edge function deploy required for the new field to populate on next sync; existing rows backfill on the next BoM sync per project.
- **Operations sidebar/overview — Schedule and Purchasing now live.** `Layout.tsx` operations group entries flipped from `SidebarDisabledLink` to live `SidebarLink` for Schedule & Milestones and Purchasing (Inventory remains scaffolded/dimmed). ProjectOverview's Operations tool card now shows real counts for both: Schedule shows next-up summary (`N overdue` / `N at risk` / `N open · N complete`); Purchasing shows `N modules · N ordered · N received`. Per-item `enabled?: boolean` flag on `ToolItem` lets the Operations card mix live and disabled entries within a single section.

### 2026-04-28
- **Project Overview — Operations section + Project Log card.** Tools grid is now 3-up (Pre-Sales / Post-Sales / Operations) with a new green-accent Operations card listing Schedule & Milestones, Purchasing, and Inventory. Inserted a new Project Log card (`components/ProjectLog.tsx`) between the tool grid and the Bill of Materials with three tabs: Comments, Files, Client / GC Log. Tabs render styled empty-state placeholders today; the full design scaffolding (composer, comment row, file repo, change-order timeline meta) is kept in the file for the next push that wires the underlying features.
- **Sidebar — Operations group.** Added a third group below Post-Sales with a green rail (`#22C55E`) and three entries: Schedule & Milestones, Purchasing, Inventory. Entries render via a new `SidebarDisabledLink` (cursor-not-allowed, dimmed) since the tools aren't wired yet. `PhaseGroup` rail color is now keyed off the accent so the green rail picks up automatically without a hardcoded branch.
- **PhaseRibbon — third section.** `PhaseRibbon.tsx` now accepts a `ProjectSection` (`'Pre-Sales' | 'Post-Sales' | 'Operations'`) and renders the breadcrumb dot row generically for an arbitrary set of sections. Operations gets the same green accent as the sidebar group.
- **Operations tool pages — scaffolded but unwired.** Created `pages/operations/ScheduleMilestones.tsx`, `Purchasing.tsx`, `Inventory.tsx` with full design styling (PhaseRibbon, KPI strip, milestone timeline / data table empty states). Intentionally **not** added to `App.tsx` routes — they exist in the tree so we can borrow shapes when each tool ships, but no link in the app reaches them yet.

### 2026-04-27
- **DTools — relink UX from the BoM page.** Extracted `DToolsImportPicker` into a reusable component with a generic `onSelect` callback so the New Project flow and the BoM page's "Sync from DTools" button share the same picker. Monday-imported projects no longer need to be created from DTools to use BoM sync — the button now opens the picker, and the new `linkDToolsAndSyncBoM` store action records `dtools_project_id` + DTools number/value before delegating to the existing sync. Already-linked projects re-sync directly with no modal.
- **DTools — sync indicator dot.** Added `DToolsSyncDot.tsx` (green = linked, red = not linked) next to every project name on the dashboard's My Projects list and the Projects table.
- **Closeout — render crash fix.** `CloseoutDashboard` had a `useState` call after the `if (!closeout) return ...` early return; when the closeout was created the hook order shifted and React unmounted the entire tree (no error boundary, so the page went blank with no sidebar). Hook hoisted above the return. Same drift potential exists elsewhere — this is the canonical reason hooks belong above early returns.
- **PDF exports — WinAnsi sanitize layer.** Multi-line descriptions imported from DTools/CSV crashed `drawText` with `WinAnsi cannot encode " " (0x000a)` because pdf-lib's `StandardFonts.Helvetica` uses WinAnsi encoding which rejects control chars. Added a narrow `sanitize()` helper to all five PDF utils (`exportSignOffPDF`, `exportPunchListPDF`, `exportSubmittalPDF`, `exportCloseoutPDF`, `exportRFIPDF`) that collapses CR/LF/TAB/etc. into a single space; smart quotes, em-dashes, ellipsis, and other WinAnsi-supported Unicode pass through untouched.
- **PDF exports — long project name overflow.** Long project names ran past the page edges on every cover page. Added a `wrapText` helper with a `HERO_MAX_W = CONTENT_W - 80` cap and an auto-fallback to 18pt if a single overlong word still doesn't fit. Title / subtitle / details now anchor to the bottom of the wrapped name block instead of fixed `y` offsets, so a 2-line name pushes everything below down. Applied to punch list, sign-off, and closeout package PDFs.
- **PDF — new `exportPunchListPDF.ts`.** Instrata-branded cover, items grouped by location with hollow checkboxes for field walkthroughs, item numbers, wrapped descriptions, red-bold `Critical` priority. Pre-checked + green status for already-`Complete` rows. Continuation pages reprint the location header with `(continued)` so context is preserved across page breaks. Wired to a new `Export Punch List PDF` button on the Closeout → Punch List tab.
- **PDF — rewrote `exportSignOffPDF.ts`.** One page per room (matches the field-walkthrough printable use case). Per room: navy band header, items table with `Done` checkboxes, the sign-off statement *"Instrata has completed the full scope of this room, including installing, configuring, programming and testing all components."*, then a dual signature block — `Client Representative` and `Instrata Representative` side-by-side, each with signature, printed name, and date lines. The whole sign-off block (~130pt) is checked against remaining space and pushed to a fresh continuation page atomically so statement and signatures never split.
- **PDF — closeout package punch section restyled.** The flat `Description / Location / Status / Priority / Assigned To` table is replaced with the same grouped layout used in the standalone Punch List PDF (orange-accent location header, navy column band, hollow checkboxes). Items with empty `location` strings were being silently dropped; they now group under `Unassigned` instead.
- **Closeout — restyle to current design tokens.** `Export Closeout PDF` button moved from `btn-primary` (navy) to `btn-orange` (matches `OwnerManual.tsx`, `RFIList.tsx` convention for the page primary CTA). Migrated 46 instances of `text-text-primary` → `text-fg` and `text-text-secondary` → `text-fg-2`. Warranty row hover went from `hover:bg-blue-50/50` to `hover:bg-surface/50` to match the Submittals pattern. Legacy aliases in `index.css` still work for other pages that haven't migrated.
- **Closeout — Quick Start Guide tool (new).** Schema migration: `quick_start_rooms` (closeout-scoped, `name`, `sort_order`) and `quick_start_steps` (`text`, optional `note`, `sort_order`) — RLS via `is_project_member()` joining through `closeout_packages`. New tab on the closeout dashboard: "Add a Room" modal accepts a custom name (for projects whose BoM is keyed by equipment, e.g. `display, rack, credenza` rather than rooms) or picks from the project's BoM location list with sub-locations; already-added rooms are dimmed. Each room renders as a card; steps are inline-editable with a base text and an optional note, plus delete buttons for both rooms and steps. PDF export not yet wired — follow-up.

### 2026-04-26
- **Monday.com — live phase + status sync.** Wired Project Tools to both Monday boards (Pre-Sales `3477536693`, Post-Sales `3523133226`) for real-time tracking, replacing the old "everything defaults to Post-Sales" behavior. Added `INST-YYYY-NNNN` `project_code` as the persistent project link across boards; written to both boards' Project ID text columns so it survives Monday's pre-sales→post-sales duplication automation.
- **Monday — new edge function `monday-backfill`.** Admin-only one-shot reconciliation. Walks both boards, filters to the active status set, generates Project IDs for items missing them, fuzzy-matches sibling pairs (Jaccard ≥0.7), bulk-upserts to Supabase. Concurrency capped at 3 with retry-on-rate-limit (Monday's `COMPLEXITY_BUDGET_EXHAUSTED` 429s) since each mutation costs ~30k complexity against a 10M/min budget.
- **Monday — rewrote `monday-webhook`.** Was a no-op since the auto-creation rollback. Now handles `create_pulse` and `change_status_column_value` events on both boards: pre-sales create assigns a fresh Project ID, post-sales create flips phase via inherited code, status changes update the Supabase row. Compatible with both native API webhooks and "When X, send a webhook" automation payloads.
- **Schema — atomic project code generator.** Replaced an initial `generate_project_code()` implementation that read MAX from the `projects` table (race-prone under parallel writes — produced duplicate codes that contaminated the first backfill run) with an UPSERT-and-RETURN against a new `project_code_counters(year, last_seq)` table. Added `seed_project_code_counter(year, min_seq)` so the backfill can absorb codes already on Monday from earlier partial runs.
- **Schema — `projects` table extensions.** Added `project_code text UNIQUE`, `monday_presales_item_id bigint UNIQUE`, `monday_postsales_item_id bigint UNIQUE`. Flipped `phase` default from `'Post-Sales'` to `'Pre-Sales'`. Status default changed from legacy `'Active'` to `'Not Started'`. Status field stays free-text covering 12 values across both boards (no CHECK).
- **Frontend — phase-aware Pipeline Bar.** `Dashboard.tsx` now has a Pre-Sales / Post-Sales toggle in the Pipeline Bar that swaps between two pipeline tile sets (Pre-Sales: Not Started / In Progress / Review / Follow Up / Won / Lost; Post-Sales: Won / Not Started / In Progress / Install / Close Out / Completed) and filters the projects list accordingly.
- **Frontend — phase-aware PhaseTimeline.** `ProjectOverview.tsx` stepper renders the matching pipeline based on the project's current phase.
- **Frontend — Phase pills replace Status pills.** `ProjectsList.tsx` filters by Phase (All / Pre-Sales / Post-Sales) now that status proliferated across two boards.
- **Frontend — Project Settings.** Replaced the manual `mondayItemId` numeric input with a read-only Monday Link panel showing the `project_code` and clickable links to both Monday board items. Status dropdown now lists all 12 valid values.
- **Recovery context** — first backfill attempt hit the race in the original code generator; second attempt hit Monday rate limits; third attempt landed cleanly after adding atomic counter, dup-clear sweep across both boards (cross-board duplicates from race artifacts cleared, not just same-board), bulk Supabase upsert (replacing the per-row select-then-write that timed out partway through), and retry-with-backoff on `COMPLEXITY_BUDGET_EXHAUSTED`. Final state: 545 active projects synced; 5 fuzzy matches eyeballed for correctness; 7 standalone post-sales items confirmed as legitimate (service work / change orders that never went through pre-sales).

