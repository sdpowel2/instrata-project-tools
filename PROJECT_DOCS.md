# Instrata Project Tools — Project Documentation

> Internal tooling suite for Instrata Sound & Security covering pre-sales bid leveling, post-sales project execution, submittals, closeouts, cutsheet management, auto-review, and director-level operations dashboards.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Browser (SPA)                                  │
│  React 19 + Vite 8 + TypeScript 5.9                                       │
│  Tailwind 4 · Zustand · React Router 7 · jsPDF · pdf-lib · xlsx           │
│  Routes: /projects, /projects/:id/* (incl. /wiki), /personal-ops,        │
│          /products, /settings, /login, /register                          │
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
- **UI → Supabase Realtime** for live push to connected clients. Currently used for the notification inbox badge count — a channel per `user_id` subscribes to `INSERT` events on the `notifications` table so the bell updates without polling.

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

> **Project access model (org-wide view-only, member-gated writes).** As of `open_project_view_access.sql`, every authenticated user has **read-only** access to all project-scoped data — projects and all their children (BoM / DTools sync items, submittals, RFIs, change orders, milestones, closeout, purchasing, quick-start, cutsheet/as-built/manuals storage). **Writes** (INSERT/UPDATE/DELETE) remain gated to project-team members via the `is_project_member()` "manage" policies. Users join a team themselves with the **Add me** button (`allow_self_add_to_project.sql`), then can modify. This mirrors our Monday security parameters. Below, "project members read/manage" describes the *write* gate — reads are open per this model.

### Core (base schema — `migration.sql`)

#### `profiles`
- `id` uuid PK → `auth.users` ON DELETE CASCADE
- `email` text NOT NULL
- `full_name` text default `''`
- `role` text default `'member'` — CHECK ∈ `('admin', 'member')`
- `created_at` timestamptz
- **Auto-created** by `handle_new_user()` trigger on `auth.users` insert (pulls `full_name` from `raw_user_meta_data`).
- **RLS:** users read/update own row; admins have full access via `is_admin()`. **Note:** admin policies must use the `is_admin()` SECURITY DEFINER function — inline `EXISTS (SELECT 1 FROM profiles …)` subqueries inside a profiles policy cause infinite recursion and silently fall back to the user's own row only.
- **Role-change guard (`fix_profile_role_escalation.sql`, 2026-07):** the self-update policy has no `WITH CHECK` and RLS can't compare OLD/NEW, so a `BEFORE UPDATE` trigger (`enforce_profile_role_immutable`) blocks a non-admin end-user session from changing its own `role`. Admins and trusted backend contexts (`auth.uid()` null — service role / SQL editor) are exempt. Closes the one-request self-promote-to-admin escalation.

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
  - **DTools root snapshot** (`add_dtools_pricing_parity.sql`): `dtools_cost`, `dtools_price_without_tax`, `dtools_tax`, `dtools_price`, `dtools_hours` numeric + `dtools_synced_at` timestamptz — the authoritative DTools root totals captured at sync time (headline numbers display these; BoM lines sum within cents). `dtools_sync_delta` jsonb — reconciliation snapshot: derived equipment/labor cost+price split, deltas vs the root fields, row-sum deltas, rolled-up echo companion names, payload flavor, unattributed labor, and a `verified` flag (everything within $1).
  - `dtools_labor_meta` jsonb (`add_dtools_labor_meta.sql`) — persisted labor knowledge from "priced" DTools payloads (`{rates, factors, phaseRaw}` per labor type), required to price the zero-priced payload flavor DTools publishes after approval/CO activity. See the `dtools-project-lookup` entry.
  - `dtools_gm_meta` jsonb (`add_project_documents.sql`) — project-level metadata snapshot for the Gross Margin Form, captured each sync by `extractGmMeta()`: `{header, custom, tax}`. `header` = quoteNumber (`Number`), poNumber (`ClientPONumber`), salesRep (`SalesRep`), engineer (`Designer`→`AssignedTo`), clientName, clientEmail (first `Contacts[]` email), projectName, site/billing address. `custom` = subsidiary (`CustomField27`), branch (`CustomField28`), projectType (`CustomField29`), aiaInvoicing (`CustomField1`), prevailingWage (`CustomField30`), timeAndMaterials (`CustomField23`), materialOnly (`CustomField24`). `tax` = rate / materialsTax (Σ `Taxes[].ProductTotal`) / laborTax (Σ `Taxes[].LaborTotal`) / total. Field map verified against `Reference/ChathamCounty.json` + `TestProject.json`.
- **RLS:** any authenticated user SELECT (all projects visible org-wide); any authenticated user INSERT; project members UPDATE; only admins DELETE.

#### `project_code_counters`
- `year` int PK
- `last_seq` int default 0
- Atomic counter table backing `generate_project_code()`. UPSERT-with-RETURNING pattern guarantees unique sequence per call without depending on the `projects` table's insert timing — fixes the race that produced duplicate codes in the original implementation.
- **RLS:** enabled with **no policies** — internal table, only ever reached via the `generate_project_code()` / `seed_project_code_counter()` RPCs called by service-role edge functions (which bypass RLS). All direct anon/authenticated PostgREST access is denied.

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

DTools pricing parity (`add_dtools_pricing_parity.sql`): `labor_type` text — for `item_type='Labor'` rows, the DTools labor type (Install, Cabling, Travel, …); `labor_breakdown` jsonb — for products, per-labor-type attribution from DTools `ItemLaborTypes` (`[{type, hours, totalHours, costRate, priceRate}]`; `hours` are LINE-total raw hours, the pricing basis; `totalHours` are DTools' display hours which may include a per-type hour adjustment like ×1.03); `included_in_phase` boolean — labor line whose dollars DTools also folded into a phase rollup as converted hours (informational; the line still counts normally because phase residual rows have the converted hours removed).
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
- `owner_furnished` boolean default false (`add_submittal_item_owner_furnished.sql`) — DTools `IsOfe` carried through from `project_bom_items`. Populate-from-BoM keeps an OFE copy of a part as a **separate row** from the Instrata-supplied copy (dedupe key manufacturer+model+ofe), so one model can appear twice in a submittal; the PDF flags the OFE lines and prints the shared cutsheet once.
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

#### `bug_reports` (`add_bug_reports.sql`)
- `id` uuid PK, `reporter_id` uuid → `profiles` ON DELETE SET NULL
- `title` text NOT NULL, `body` text NOT NULL
- `image_url` text — public URL of an uploaded screenshot in the `bug-screenshots` Storage bucket; null if none attached
- `page_url` text NOT NULL default `''` — `window.location.pathname` captured when the modal opens
- `status` text NOT NULL default `'open'` — CHECK ∈ `('open', 'in_progress', 'resolved', 'wont_fix', 'duplicate')`
- `resolution_note` text — admin-written response, shown to the reporter when notifications are delivered
- `created_at`, `updated_at` timestamptz
- **RLS:** any authenticated user can INSERT. Reporters can SELECT their own rows. Admins can SELECT all and UPDATE (status + resolution_note).
- Indexes on `status`, `reporter_id`, `created_at desc`.

#### `notifications` (`add_notifications.sql`)
- `id` uuid PK, `user_id` uuid NOT NULL → `profiles` ON DELETE CASCADE
- `type` text NOT NULL — e.g. `'bug_status_changed'`; open enum, no DB CHECK
- `title` text NOT NULL, `message` text — optional longer body (the admin's resolution note)
- `related_id` uuid — `bug_report.id`; reserved for future deep-linking
- `read` boolean NOT NULL default `false`
- `created_at` timestamptz
- **RLS:** users SELECT/UPDATE their own rows only (for marking read). Admins INSERT on behalf of any user.
- Composite index on `(user_id, read, created_at desc)` for the unread-badge query.

#### `notification_preferences` (`add_notifications.sql`)
- PK (`user_id`, `type`). `user_id` uuid → `profiles` ON DELETE CASCADE, `type` text, `enabled` boolean NOT NULL default `true`.
- A **missing row means opted-in** — the application treats absence as the default-enabled state so new notification types surface automatically without requiring a seed step.
- **RLS:** users can SELECT, INSERT, UPDATE, DELETE their own rows.

### Database Functions

| Function | Type | Purpose |
|---|---|---|
| `is_admin() → boolean` | SECURITY DEFINER, STABLE | Returns true if `auth.uid()` has `role = 'admin'` in `profiles`. Must be SECURITY DEFINER so the internal `profiles` query bypasses RLS — inline subqueries inside profiles policies cause infinite recursion. Used by the admin SELECT/ALL policies on `profiles`. |
| `is_project_member(_project_id uuid) → boolean` | SECURITY DEFINER, STABLE, `search_path=public` | Canonical "can modify this project" check: admin, OR `projects.created_by = auth.uid()`, OR a row in `project_members`. Gates **writes** on project child tables (reads are open org-wide — see the project access model note above). `search_path` pinned in the 2026-07 security pass. |
| `set_updated_at()` | trigger fn | Generic — sets `NEW.updated_at = now()`. Wired to `projects` only. |
| `handle_new_user()` | SECURITY DEFINER | After-insert trigger on `auth.users` — inserts a `profiles` row with `email` + `full_name` from `raw_user_meta_data`. |
| `cutsheet_is_admin() → boolean` | SECURITY DEFINER | Mirrors the `profiles.role='admin'` check, used inside cutsheet RLS policies. |
| `search_catalog(search_term, page_from, page_to)` | RPC | Paginated catalog search; each word must match mfr/model/description; mfr/model hits rank above description-only. Returns `total_count`. |
| `generate_project_code() → text` | SECURITY DEFINER, `search_path=public`, atomic UPSERT | Returns the next `INST-YYYY-NNNN` value. UPSERTs `project_code_counters` for the current year, returning the incremented `last_seq` in the same statement. Per-year sequence reset. Race-safe under concurrent calls (used by both `monday-backfill` parallel workers and the `monday-webhook` create handler). Made DEFINER in the 2026-07 pass so it works under the now-RLS-enabled counter table for any caller. |
| `seed_project_code_counter(year int, min_seq int)` | SECURITY DEFINER, `search_path=public` | Bumps `project_code_counters.last_seq` to at least `min_seq` for the given year. Idempotent — never decreases. Used by `monday-backfill` to absorb codes already written to Monday from prior partial runs so we don't regenerate values that already exist on the Monday side. Made DEFINER in the 2026-07 pass (see `generate_project_code`). |

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

### Change Orders (`add_change_orders.sql`, `add_change_order_items.sql`, `add_change_order_tax.sql`, `add_change_order_item_type.sql`, `add_change_order_item_location.sql`)

| Table | Purpose |
|---|---|
| `change_orders` | Read-only mirror of DTools COs. Owned by `dtools-project-lookup` Edge Function (service role writes; reads open org-wide). Columns: `number`, `title`, `description`, `amount` (signed price delta), `status` ∈ `Pending`/`Approved`/`Rejected`, `category` ∈ `Internal`/`External`, `requested_at`, `resolved_at`, `dtools_id`. Extended by `add_change_order_items.sql` with `cost` (signed net cost delta), `labor_hours` (net signed raw hours), `dtools_verified` (our priced lines reconcile with the CO's own root totals), `items_synced`; and by `add_change_order_tax.sql` with `tax` (line items are pre-tax — Σ lines + `tax` = `amount`). **`dtools_id` = the CO number** (e.g. `AVCO-4`) — CO list rows reuse the parent project's `Id`, so the number is the only stable per-project identity. UNIQUE (`project_id`, `dtools_id`). CASCADE delete with parent project. |
| `change_order_items` | Signed line-item deltas from a published CO payload. `change_type` ∈ `Added`/`Removed`/`Adjusted`/`Other` (DTools `COChangeTypeId` 1/2/3). Removals carry DTools' own NEGATED `unit_cost`/`unit_price`/labor hours with positive `qty`. `labor_cost`/`labor_price` are priced at the CO's own phase-row rates when the payload arrives priced, else the **parent project's** rates. Manual labor-only hours (phase-rollup hours beyond the item-attached echo share) get their own `"{Type} Labor"` rows with `unit_price=0` and dollars in `labor_price`. `labor_breakdown` jsonb mirrors the BoM shape. `item_type` ∈ `Product`/`Labor` (labor rows render dollars under the Labor column). `location` is the room name resolved from the CO payload's own Locations map (CO payloads can introduce new rooms) — drives the location chip in the CO table and the ghost rows in the BoM tree. Wiped + re-inserted with the CO rows on every sync (FK CASCADE). RLS: authenticated read; service-role write. |

### Project Documentation (`add_project_documents.sql`)

| Table | Purpose |
|---|---|
| `project_documents` | Auto-generated reports built from a synced BoM. UNIQUE (`project_id`, `doc_type`); Phase 1 `doc_type = 'gross_margin'`. Stores **only** the per-field manual `overrides` jsonb (flat dotted paths, e.g. `installHours.cost` / `header.salesRep` / `tax.rate`) so the form keeps re-deriving fresh defaults from the BoM on every re-sync while preserving accounting's nudges. `status` text (default `draft`), `edited_by`. RLS: reads open org-wide; writes gated to project members (`is_project_member`). `updated_at` auto-touched. The form's values are computed live by `app/src/utils/grossMargin.ts` (pure, regression-tested by `scripts/verify-gm-form.mts`); this table never stores the computed numbers, only deltas. |

### Personal Ops (`add_personal_ops.sql`) — admin-only

| Table | Purpose |
|---|---|
| `ms_graph_tokens` | Per-user OAuth tokens. UNIQUE(`user_id`). Stores `access_token`, `refresh_token`, `expires_at`. RLS: own row + admin only. |
| `personal_ops_email_flags` | Triage state per Graph `message_id`. `status` ∈ active/flagged/deferred/dismissed. `session_type` and `deferred_to` ∈ morning/midday/eod. `urgency_score` numeric, `urgency_reason` text. Indexed by (`user_id`, `message_id`). |

### Project Files (`add_project_files.sql`)

| Table | Purpose |
|---|---|
| `project_files` | Canonical **index** of the per-project document repository; the bytes live in the company-browsable **ProjectFiles SharePoint site** (`/sites/ProjectFiles`, library "Project Files", one folder per project `{number} - {name}/` with standard category subfolders). Columns: `category` ∈ `contracts`/`drawings`/`submittals`/`meeting_notes`/`photos`/`closeout`/`general`, `filename`, `sharepoint_item_id` (UNIQUE — the immutable Graph pointer), `sharepoint_path`, `sharepoint_web_url`, `size_bytes`, `mime_type`, `source` ∈ `upload` (through the app) / `generated` (auto-filed PDF export) / `sharepoint_sync` (discovered by reconcile), `doc_type` (for generated docs: `submittal_package`/`rfi`/`closeout`/`sign_off`/`warranty`/`punch_list`/`manuals`), `uploaded_by`, `sharepoint_modified_at`. RLS: reads open org-wide (the backing SharePoint site is company-browsable anyway); writes gated to project members. Rows are written by the `sharepoint-project-files` edge function, whose `sync` op reconciles the index against the actual folder contents on Files-tab open — so files dropped in natively via Explorer/Teams appear, and files deleted natively disappear. Also adds `projects.sharepoint_folder_id` (cached Graph folder id, set on first use; folders are created lazily). Spec: `Product Spec/04-project-files.md`. |

### Project Wiki (`add_project_wiki.sql`)

Per-project knowledge base written by engineers in the app **and** by agents over MCP (`mcp-server/src/wikiTools.ts`) — both first-class; `origin` (`agent` / `human` / `agent_human_edited`) is provenance only and never gates validity. Spec: `Product Spec/project-tools-wiki-spec.md` (companions `labor-estimating-rules.md`, `review-checklist.md`). House-style deviations from the spec: enums are **text + CHECK** (not Postgres enums), tables carry a `wiki_` prefix, and every child table denormalises `project_id` (kept in sync from the room by the `wiki_sync_project_id_from_room` trigger) so RLS and project-wide queries never join.

| Table | Purpose |
|---|---|
| `project_wiki` | One row per project (`project_id` UNIQUE). Project-level context: `summary`, `scope_summary`, `design_basis` (markdown), `status` ∈ `draft`/`in_progress`/`awaiting_review`/`reviewed`/`final` (`awaiting_review` is the explicit human-gate marker), `pipeline_run_at` (null on hand-authored wikis). Created lazily — rooms can exist without it. |
| `wiki_rooms` | **One row per room or subsystem — the unit of the index guarantee.** `status` (`pending`/`clean`/`noted`/`escalated`/`resolved`/`authored`) and `headline` are **NOT NULL**, so an un-indexed room is structurally impossible. `entry_kind` ∈ `room`/`subsystem`/`head_end`/`zone`/`project_wide`; `room_number`, `room_name`, `floor`, `dtools_location` (plain string, mirrors D-Tools; **partial UNIQUE on `(project_id, dtools_location)`** — the agent re-run reconciliation key), `sort_order`, `room_type`, `area_sqft`, `size_class` / `size_basis`, `has_conferencing`, `typical_of_count` + `typical_of_rooms text[]` (roster so no room in a "Typical of N" is silently unmentioned — mismatch warns, doesn't reject), `detail` + `validation_notes` (markdown), `origin`. Generated `search_tsv` (weighted: number/name/headline A, detail B, validation C) + GIN index. |
| `wiki_decisions` | The queryable rationale layer. `room_id` nullable (null = project-level). `kind` ∈ `validated`/`deviation_accepted`/`assumption`/`rationale`/`escalation_outcome`; `title` (the decision, one line), `rationale` (markdown — **the field the retrieval case reads**), `source_ref`, `assumption_confirmed`, `origin`. Append-mostly. Generated `search_tsv`. |
| `wiki_questions` | Questions log with the two-tier split: `severity` ∈ `functional_conflict` (interrupts a pipeline run one at a time) / `estimating_escalation` (batched "needs your input"); `status` ∈ `open`/`answered`/`resolved`/`withdrawn`; `question`, `context`, `answer` (verbatim), `resolution`, `resulting_decision_id` → `wiki_decisions` (answer → logged decision link), `raised_by` / `answered_by`, `raised_at` / `answered_at`. Generated `search_tsv`. |
| `wiki_labor` | Calculated labor by bucket per room. `labor_type` ∈ exactly the D-Tools vocabulary (`install`/`cabling`/`bench`/`commissioning`/`programming`/`engineering`/`mobilization`/`training`; travel deliberately absent), `hours numeric(8,2) NOT NULL` (**0.00 is a real row — absence ≠ zero**), `basis`, `origin`. UNIQUE `(room_id, labor_type)`. |
| `wiki_room_bom_lines` / `wiki_room_files` | Link tables: room ↔ `project_bom_items` id, room ↔ `project_files` id, each with a nullable `note`. UNIQUE per pair; cascade on either side. |

- **View `wiki_room_index`** (`security_invoker`): the §5.1 one-line-per-room list as a query — `decision_count`, `open_question_count`, `answered_question_count`, `labor_hours` per room. Rooms at `escalated` plus any room with an open question are the blocking set.
- **RPC `search_project_wiki(p_project_id, p_query, p_limit)`**: SECURITY INVOKER full-text search (`websearch_to_tsquery`) across rooms, decisions, questions and the project context; returns `kind`, `id`, `room_id`, `room_label`, `title`, `snippet` (`ts_headline`, `<b>` marks), `rank`. Powers both the page's search card and the MCP `search_project_wiki` tool.
- **RLS:** open SELECT to any authenticated user; INSERT/UPDATE/DELETE gated by `is_project_member(project_id)` (same model as every other project child table). `created_by` / `raised_by` default to `auth.uid()`.
- **Status side-effects live in code, not triggers** (app `lib/projectWiki.ts` and MCP `wikiTools.ts`, kept in parity): raising a question on a room sets it `escalated`; answering with a logged decision sets the question `resolved` and, if nothing else is open, an `escalated` room becomes `resolved`. A human edit to an `agent` row flips `origin` to `agent_human_edited`.

### Directory — Vendor Contacts (`add_vendor_contacts.sql`)

| Table | Purpose |
|---|---|
| `vendor_contacts` | Shared, org-wide directory of manufacturer / distributor / rep contacts surfaced under the **Directory** sidebar entry. Columns: `company` (required), `company_type` ∈ `manufacturer`/`distributor`/`rep`/`other` (nullable), `rep_for` (comma-separated brands), `name`, `title`, `email`, `phone`, `website`, `role` ("what they do for us"), `notes`, `technical` bool, `active` bool (deactivate = soft hide; delete = hard remove), `created_by`, `created_at`, `updated_at`. **Open access model** — RLS grants any authenticated user SELECT/INSERT/UPDATE/DELETE (no admin gate, no approval queue). Migration seeds ~80 contacts on an empty table only (guarded by `if not exists (select 1 …)` so re-runs don't duplicate). Replaces the old standalone `Vendor Contacts.html` (localStorage + mailto approval queue). Logos are fetched client-side from the website domain (Clearbit → favicon → initials), so nothing logo-related is stored. |

### Salesforce ↔ monday Sync + Hope's Queue (`add_sync_and_queue.sql`)

Data model for the sync engine (`sync-engine/`, separate Fly app — see §5) per `Product Spec/project-tools-sync-and-queue-spec.md`; build plan in `Product Spec/sync-and-queue-implementation-plan.md`. **Schema-parameterised:** the file sets `search_path` at the top — run as-is for `public`, then again with `sync_sandbox` for the sandbox engine. Shared pieces (`profiles.is_ops_coordinator`, `is_ops_coordinator()`, `is_sync_viewer()`, the extended `enforce_profile_role_immutable` guard, schema-agnostic trigger functions, the `sync_engine` role) live in `public` and are idempotent. Verified against PGlite (runs twice cleanly, RLS/grant/trigger behavior) and applied to production `public` on 2026-10-11 (`sync_sandbox` not yet created).

| Table | Purpose |
|---|---|
| `config_boards` / `config_field_registry` / `config_groups` / `config_labels` | The config layer (spec §2): semantic keys → monday board / column / group / label IDs. Business logic never holds a raw ID. Label IDs seeded from the live Pre-Sales board 2026-10-10. Admin-editable. |
| `config_cleanliness_rule`, `config_settings` | Data-cleanliness rules (spec §7) and tunables (creation stages, excluded groups, report schedules O-6/O-7, handoff SLA O-3). Coordinator-editable. `SYNC_MODE` is deliberately **not** here — it's a Fly secret. |
| `map_business_unit` / `map_win_pct` / `map_sales_rep` / `map_stage_action` | Salesforce value → monday label ID (spec §3.2). `monday_label_id` null = known but unmapped → failure task. `map_sales_rep` reserves `(blank)` → House. Coordinator-editable; every edit is audited into `event_log`. |
| `map_estimator` (`sync_triage_and_estimator.sql`) | monday Pre-Sales Engineer (user id) → Salesforce user **name**, resolved to an active user at write time (so one seed serves sandbox and production). `ignore` = never an estimator of record (skipped, no task); no row / no name → "map this engineer" task. Coordinator-editable, audited. |
| `item_set_aside` (`sync_set_aside.sql`) | monday items the coordinator set aside (reason `change_order` / `other`, note, who / when): skipped by backfill, reconcile writes, writeback tasks and the cleanliness count. Coordinator-editable, audited; Restore = delete. |
| `sf_link` | One row per pre-sales item mirroring a Salesforce AV line item. `last_synced_values` is the comparison baseline (last SF value the sync wrote, plus `sf.stage` and `miss:*` markers); `dry_run_synced_values` is the separate baseline used in dry run so dry-run never advances the live one. |
| `task` | Hope's Queue (spec §3.3). App/MCP may update `status` only (column grant); a BEFORE trigger sets `monday_dirty` and `pg_notify('sync_task_changed')`. Everything else is engine-owned. |
| `webhook_inbox`, `event_log`, `watermark`, `engine_status`, `cleanliness_snapshot`, `dry_run_report` | Inbound webhooks (persist-then-process), the append-only event log (UPDATE/DELETE rejected by trigger), sweep watermarks, engine heartbeat, daily cleanliness counts, daily dry-run diff. |

- **Access:** read = admins + ops coordinators (`is_sync_viewer()`); plain members see nothing. The engine connects as login role `sync_engine` (password set manually after the migration) with explicit `to sync_engine` policies, plus read-only `projects` / `profiles`.

### Lead Finder (`add_lead_finder.sql`) — admin-only

Data for the Lead Finder tab (`/lead-finder`), ported from the standalone LeadFinder app (SQLite). The Python worker (`leadfinder-worker/`, Fly app `instrata-leadfinder`) writes most of it; every table is admin-only through `is_admin()`. Ids are text uuids (the SQLite rows carried over as-is). Verified against PGlite (runs twice cleanly; `lf_results` filters, grouping, the Pursue trigger and the admin guard).

| Table | Purpose |
|---|---|
| `lf_office` | Instrata offices leads are measured from: address, geocode (`census_address` / `zip_centroid` / `manual`), radius, active. Saved through the worker (`office_save` job) so it can geocode and recompute distances. |
| `lf_source`, `lf_source_target` | Sources (SAM.gov, BuildingConnected, Bonfire, email alerts) with enabled flag, daily call budget, last success; Bonfire agencies. The tab may toggle `enabled` / `daily_call_budget` only (no insert/delete grant). |
| `lf_run`, `lf_source_run`, `lf_raw_record` | Run log per source (counts, API calls, first error, resume cursor) and every raw payload as published. |
| `lf_opportunity`, `lf_opportunity_score`, `lf_office_distance` | Normalized bids (group_key collapses amendments / one-invite-per-trade; `duplicate_of` links the same bid across sources), lane + score + matched terms, distance to every office with the nearest flagged. |
| `lf_lead_review` | Review status (new / watch / pursue / pass / already_known) + notes, written by the tab. Trigger `lf_review_queue_docs`: Pursue on a SAM.gov lead queues a `sam_docs` job. |
| `lf_lead_docs`, `lf_document`, `lf_triage_run` | Per-lead document summary (SAM attachment status, unpack errors, folder manifest), one row per file, and av-triage runs (rating, tier, estimate, dates, cost, report markdown). Mirrored by the worker from its volume, which holds the files themselves (not Supabase Storage). |
| `lf_job` | The tab's command queue: `run`, `sam_docs`, `ingest_upload`, `rescan`, `triage`, `triage_resume`, `office_save`, `office_active`, `rescore`, `bc_disconnect`. Admins insert (`status = 'queued'`, `requested_by = auth.uid()`); only the worker updates. Partial unique index: one live run, one live document/triage job per lead. Realtime-published with `lf_lead_docs` and `lf_triage_run`. |
| `lf_setting` | Tab-readable settings: `default_radius_miles`, `worker_status` (heartbeat + capability flags, written every minute), `bc_status` (BuildingConnected connection without tokens). |
| `lf_secret` | Worker-only (RLS on, **no policies**, grants revoked): BuildingConnected OAuth tokens, triage agent/skill/environment ids. |
| `lf_zip_centroid`, `lf_place_centroid`, `lf_geocode_cache` | Census gazetteer centroids and the geocoder cache (misses cached too). |

- **`lf_results(p jsonb)`** (SECURITY INVOKER, raises for non-admins): the Leads table/map/CSV query, a SQL port of the worker's `web/queries.py` — lanes, min score, status, due-after, New/Updated since the last successful run, review, source, Bid Board state, office / in-range / nearest, location-unknown; one row per `group_key` (latest notice) with notice count, trades, GC count, group max estimated value and nearest office. Returns one jsonb value (`{last_run, rows}`) so PostgREST's max-rows cap never truncates it. `leadfinder migrate-to-supabase --verify-only` compares it with the Python query.

### Storage Buckets

| Bucket | Visibility | Path convention | Policies |
|---|---|---|---|
| `cutsheets` | private | `{project_id}/...` | Authenticated INSERT; authenticated SELECT (open view, `open_project_view_access.sql`); DELETE gated by `is_project_member((path[0])::uuid)`. |
| `as-builts` | private | `{project_id}/...` | Authenticated INSERT; authenticated SELECT (open view); DELETE gated by `is_project_member`. |
| `manuals` | private | `{project_id}/...` | Authenticated INSERT; authenticated SELECT (open view); DELETE gated by `is_project_member` (added by `add_product_manuals.sql`). |
| `bug-screenshots` | public | `{uuid}.{ext}` | Any authenticated user INSERT; public SELECT. URLs are stored verbatim on `bug_reports.image_url` and rendered directly — no signed tokens needed. 5 MB limit; PNG/JPEG/GIF/WebP only. |
| `project-files-temp` | private | `{uuid}_{filename}` | Pass-through staging for Project Files uploads (browser → bucket → edge function → SharePoint → temp object deleted); bypasses the edge-function body-size limit. Authenticated INSERT only; the function reads/deletes with service role. 100 MB limit. Same pattern as `cutsheet-temp`. |

> Note: cutsheet **PDFs** for the Cutsheet Repository feature live in **SharePoint**, not the `cutsheets` bucket. The bucket appears to predate the SharePoint repository and likely backs `project_bom_items.cut_sheet_url` for legacy / project-local uploads.

---

## 4. Edge Functions Inventory

All under `supabase/functions/`. Deno runtime. CORS allowed from `*`.

> **Gateway `verify_jwt` is pinned in `supabase/config.toml`** (added 2026-07). `monday-webhook` and `ms-graph-auth` run with `verify_jwt=false` (they receive no Supabase JWT and enforce their own auth); all others `true`. Without this file `functions deploy` defaults everything to `true`, which breaks the two public endpoints — so deploy with the config present. Note `verify_jwt=true` only means "a valid project JWT" — the public anon key qualifies, so functions still enforce their own user/admin/membership checks in code.

### `dtools-list-projects`
- **Purpose:** Page through D-Tools Subscribe `/Projects` (200/page, 5000 cap), normalize each into `{dtoolsId, name, number, client, businessUnit, siteAddress, projectTotal, status}`. Sorted by project number desc. Optional `{debug:true}` short-circuit returns raw list+detail shape.
- **External APIs:** D-Tools (`X-DTSI-ApiKey`)
- **Tables touched:** none
- **Auth:** requires a real authenticated user; rejects the public anon key (security pass 2026-07).

### `dtools-import-project`
- **Purpose:** One-shot import. Given `dtoolsProjectId`, fetch metadata, idempotency-check on `projects.dtools_project_id`, INSERT new project (mapping subsidiary→`business_unit`, `Approved`→`phase`, `Price`→`value`), add creator as project member, then **delegate** BoM sync to `dtools-project-lookup`.
- **External APIs:** D-Tools, calls `dtools-project-lookup` over HTTPS using service-role JWT
- **Tables touched:** `projects` (INSERT), `project_members` (INSERT)
- **Auth:** requires a real authenticated user; `created_by` is taken from the verified JWT (not the request body) so projects can't be attributed to arbitrary users (security pass 2026-07).

### `dtools-project-lookup`
- **Purpose:** Search D-Tools by project number, fetch the project **unaggregated** (single fetch — `aggregateBy` variants return empty `ItemLaborTypes` and cannot price labor; unaggregated rows carry `LocationId` for per-location qty), run the pure transform, write `project_bom_items` (DELETE then 100-row batches), store the DTools root snapshot + reconciliation delta on `projects`, then pull published change orders.
- **Transform (`transform.ts`):** pure module (no Deno APIs) holding the entire verified pricing model, replayed offline by `scripts/verify-dtools-sync.mts` against saved payloads in `Reference/` — run it after ANY transform change. Key behaviors:
  - **Two DTools payload flavors.** *Priced* (pre-approval publishes): phase rollups carry $/hr rates and raw hours including hours converted from rolled-up fixed-price companion labor (e.g. Airfare → Travel hours). *Zero-priced* (post-approval/CO publishes): phase rollups have `UnitCost=UnitPrice=0` and ADJUSTED hours (×1.03-style per-type factor) with converted hours excluded — the rates are gone from the payload. The transform detects the flavor, persists a `LaborMeta` snapshot (`projects.dtools_labor_meta`) from priced payloads, and prices zero-priced ones from the snapshot (falling back to deriving price rates from item `InstallPrice` deltas; cost rates are not derivable). Residue lands on an explicit "Labor (unattributed)" line anchored to root totals.
  - **Headline split** (priced flavor) follows DTools' own row convention — Σ round2 per row, labor minus rolled-up echo lines (detected by overshoot subset-match vs `PriceWithoutTax − equipment`) — and reproduces the DTools UI to the penny. Echo companions keep their REAL cost/price as their own line; the converted hours are removed from the phase residual instead (the only representation that reconciles cost and price simultaneously).
  - **Per-product labor** accumulates per ROW (`qty × ItemLaborTypes.Hours × rate`) since the same model can carry different hours on different rows; phase residual rows carry the manually-added hours; companion labor (travel/per-diem/service plans) are fixed-dollar lines.
  - **Located labor items** (SI integration setting "send labor items as individual" = yes, enabled 2026-06-11): manual labor publishes as TypeId 2 items WITH `LocationId` + `ItemLaborTypes` instead of location-less phase rollups, so labor rooms itself in the quote view. **Payload quirk:** on labor items `ItemLaborTypes.Hours` is the LINE-total raw hours (`Quantity` is the adjusted hours, `UnitPrice` the $/hr) — unlike products, where `Hours` is per-unit. Their dollars are the line total; the attached hours are the same labor and must never be priced on top (double-count). Hour-carrying companion rows become hour-based BoM lines ("16.48 hr @ $95.00/hr"); ILT-less ones (travel/service plans) stay fixed-dollar. Without the SI setting, manual labor still arrives as project-level phase rollups → "Project Labor" bucket (location never published — confirmed across unaggregated/Location/Item/System fetches). **Hybrid guard (2026-06-25):** a companion is only hour-priced when `Quantity` ≈ its attached adjusted hours (Σ `TotalHours`). A fixed/unit lump that merely carries labor metadata — e.g. an Equipment Rental entered as `1 unit @ $1,800` with 4 attached Install hours — would otherwise read as "1 hr @ $1,800/hr"; it's stored fixed instead (its hours echo the companion hourly line). Dollar-neutral.
  - **Self-verification:** equipment/labor/total cost+price are compared against root `Cost`/`PriceWithoutTax` and against the stored rows ($1 tolerance, expected drift is rounding cents); result stored in `projects.dtools_sync_delta.verified` and surfaced as a badge in the BoM footer.
- **Vendor extraction:** `extractPricedFrom()` walks each item's custom-fields shape (array `CustomFields[]` / `ItemCustomFields[]` plus flat fallbacks `CustomField1` / `customField1` / `PricedFrom`) and writes the value to `project_bom_items.priced_from`. The Purchasing module displays this verbatim in the Vendor column. When the item is grouped (same mfr+model+unit_cost across rows), the first non-empty `priced_from` wins.
- **Change Orders:** re-queries `/Subscribe/Projects?projectNumber={N}&pageSize=200`; CO rows are detected by **non-empty `CONumber`** (list rows carry NO `IsChangeOrder` field and reuse the parent project's `Id`). Each CO's full payload comes from `?id={parentId}&coNumber={CONumber}`; `buildChangeOrderItems()` produces signed delta lines (`COChangeTypeId` 1=Added, 2=Removed with negated prices/hours) priced at parent rates and verified against the CO's own root `PriceWithoutTax`/`Cost` (lines are pre-tax; root `Price` adds `Tax`, persisted on `change_orders.tax` so the UI footer can sum lines → subtotal → tax → CO total). CO phase rollup rows mirror the parent's two flavors (AVCO-1 on AlphaDetect arrived PRICED, carrying the rates) and hold item-attached hours PLUS manual labor-only hours: the item-attached share is an echo of `ItemLaborTypes` (already priced on the item lines) and is skipped, while the per-type residual becomes its own labor-only `"{Type} Labor"` line (e.g. added Bench/Cabling hours) — dropping it under-counted the CO by exactly those dollars. Wipes + re-inserts `change_orders` + `change_order_items` per project. Wrapped in try/catch — a CO sync failure logs but doesn't fail the BoM import. **Gotcha:** DTools is pure publish/subscribe — a CO only becomes addressable after its status transition fires the SI tenant's "send CO to API" setting (or it's explicitly published); unpublished COs 404 on `?coNumber=` even when their effects are already merged into the approved project payload (as `TypeId=5` "Change Order AVCO-n Placeholder" lump items and/or a dedicated "Change Order - Install" phase). Fix is on the SI side: toggle the CO's status, then re-sync. The reverse drift (CO approved AFTER the parent last published → its dollars missing from synced totals) is detected client-side: `dtools_sync_delta.publishedOn` vs the CO's `resolved_at`. The Contract Value summary backs merged approved COs out of the synced value to display the true Original Contract, flags unmerged ones with an "Awaiting DTools Republish" banner (remedy: open + re-close the CO in SI, re-sync), and the BoM tree renders pending/unmerged CO items as status-tinted ghost rows in their rooms (excluded from all subtotals).
- **GM metadata:** `extractGmMeta()` (in `transform.ts`) pulls the project-level fields the Gross Margin Form needs (header, custom fields, tax split) into `projects.dtools_gm_meta` on every sync. Pure + verified offline alongside the BoM transform.
- **External APIs:** D-Tools
- **Tables touched:** `project_bom_items` (DELETE/INSERT), `change_orders` + `change_order_items` (DELETE/INSERT), `projects` (UPDATE incl. root snapshot, sync delta, labor meta, **gm meta**)
- **Auth:** accepts the internal service-role call from `dtools-import-project`; otherwise requires an authenticated user who is a member/admin of the target `projectId` — closing the arbitrary-UUID overwrite (security pass 2026-07).

### `monday-manager-dashboard`
- **Purpose:** Pull "New Requests" group from Pre-Sales board, return two buckets: `triage` (date set, no engineer) and `review` (status="Review"). Both sorted by due date asc. Optional `debugNameQuery` dumps raw column data for matching item names.
- **External APIs:** Monday GraphQL v2024-10
- **Tables touched:** none (read-only Monday → response)

### `monday-webhook`
- **Purpose:** Live sync from Monday → Project Tools. Handles two event types from both Pre-Sales (3477536693) and Post-Sales (3523133226) boards:
  - `create_pulse` (new item) — Pre-sales: assigns Project ID via `generate_project_code()`, writes back to Monday's Project ID column, upserts a Supabase row with `phase='Pre-Sales'`. Post-sales: looks up by `project_code` (Monday's pre-sales→post-sales duplication automation copies the Project ID along with the item), flips phase to `Post-Sales` and links the post-sales item id. Generates a fresh code if the duplicated item somehow arrives without one.
  - `change_status_column_value` on `status9` — looks up the Supabase row by the right item-id column for the firing board and updates `status`. If no row is linked yet (race between create and status events), falls through to the create handler. Idempotent.
- Compatible with both **native API webhooks** and the **"When X happens, send a webhook"** Monday automation payload shape (sniffed via field presence; `event.type` is sometimes absent on automation payloads).
- **Auth:** requires a `MONDAY_WEBHOOK_SECRET` shared secret (constant-time compare; `?token=` query param or `x-webhook-secret` header), checked before anything else. Fails closed (503) if unset. The secret is appended to the delivery URL configured in Monday (security pass 2026-07). Runs `verify_jwt=false` (Monday sends no Supabase JWT) per `config.toml`.
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
  - `authorize` (POST, admin-only): builds Microsoft consent URL with an **HMAC-SHA256-signed** `state` carrying `{userId, ts}` (key `MS_GRAPH_STATE_SECRET`, falls back to `MS_GRAPH_CLIENT_SECRET`). Scopes: `Mail.Read Calendars.Read User.Read offline_access`. Forces `prompt=consent`.
  - `callback` (GET): **verifies the signed state** (signature + 15-min expiry) before trusting `userId` — a forged/replayed state is rejected, preventing token mis-binding — then exchanges auth code → tokens → upserts to `ms_graph_tokens`, redirects to `${APP_ORIGIN}/personal-ops?connected=true`. Runs `verify_jwt=false` per `config.toml`.
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
- **Auth (security pass 2026-07):** every op requires a real authenticated user (rejects the anon key). `bootstrap`, `listStaging`, `approveStaging`, `rejectStaging`, `markStagingDuplicate` additionally require `role='admin'`; the read/upload ops (`lookup`, `lookupBatch`, `getDownloadUrl`, `uploadStaging`) stay open to any authenticated user. `uploadedByUserId`/`reviewedByUserId` come from the verified JWT, not the body.

### `sharepoint-project-files`
Single endpoint, op dispatcher (`body.op`). Same app-only Graph pattern as `sharepoint-cutsheet` (client_credentials token, module-scoped cache), pointed at the **ProjectFiles site** via its own `SHAREPOINT_PROJECTS_*` env vars. Backs the Files tab on Project Overview and the MCP file tools. Spec: `Product Spec/04-project-files.md`.

| `op` | Purpose |
|---|---|
| `bootstrap` | One-time setup: resolve site URL + library name → `{SHAREPOINT_PROJECTS_SITE_ID, SHAREPOINT_PROJECTS_DRIVE_ID}` to set as env vars. Admin-only. |
| `ensureProjectFolder` | Find-or-create `{number} - {name}/` (+ optional category subfolder); persists `projects.sharepoint_folder_id`; handles the create race via 409 → re-lookup. |
| `upload` | Bytes from `project-files-temp` storage path (preferred) or base64; ensures folder chain; PUT with `conflictBehavior=rename`; INSERT `project_files` (rolls back the SharePoint upload if the insert fails); always deletes the temp object. |
| `getDownloadUrl` | Fresh ~1h pre-authenticated Graph download URL by `project_files` id. |
| `delete` | Deletes the SharePoint item (404 tolerated) + the index row. |
| `sync` | Reconcile: walks the project folder root + one level of subfolders (paginated), upserts unknown items as `source='sharepoint_sync'`, updates changed ones, removes index rows whose items vanished. SharePoint wins conflicts. Find-only — never creates folders. Returns `{added, updated, removed, folderWebUrl}`. |

- **External APIs:** Microsoft Graph (Sites/Drives/Items)
- **Tables touched:** `project_files`, `projects` (`sharepoint_folder_id`), `profiles` (role check), `project_members` (membership check), Storage `project-files-temp`
- **Auth:** every op requires a real authenticated user. `bootstrap` is admin-only; mutations (`upload`, `delete`, `ensureProjectFolder`) require project membership (mirror of `is_project_member`, enforced in code since the function runs service-role); reads (`getDownloadUrl`, `sync`) are open to any authenticated user, matching the org-wide `project_files` SELECT policy. `uploadedByUserId` comes from the verified JWT.

---

## 5. Feature Inventory

> Status reflects what's visible from the file tree, migrations, and edge functions. Verify against actual UI before relying on this for planning.

| Feature | Status | Description |
|---|---|---|
| Projects page (global registry) | Complete | `ProjectsList.tsx` — single workspace-wide registry of every project visible to every authenticated user. Hosts the org-wide `PipelineBar` (Pre/Post toggle + per-status tiles drive a status filter on the table), search across name/number/client/BU, BU dropdown, and an **Add me** button per row that inserts a `project_members` row via the store's `addSelfToProject` action. `ProjectsList`, `ProjectNew`, `ProjectHome`, `ProjectOverview`, `ProjectSettingsModal`, `ProjectMembersModal`. |
| Dashboard (user-scoped + admin section) | Complete | `Dashboard.tsx` — IC view + admin section folded in. IC view scopes to `myProjectIds` (membership Set derived from `project_members` for the current user, loaded in `fetchAllData`); pipeline tile counts reflect *only* your projects. Zero-memberships path renders an `EmptyMembershipsState` card with a link to the global Projects page. Admin section (`AdminDashboardSection.tsx`, rendered when `isAdmin`): Cutsheet Review card, Needs Triage card (monday-fed), Needs Review card (driven by internal `review_runs`, statuses `submitted_for_review` / `in_review` / `changes_requested`), Team Bandwidth card (active projects grouped by `owner_id` with profile name lookup, Pre/Post toggle, unassigned-count footer). The cutsheet-pending badge is now on the Dashboard sidebar link for admins. |
| Manager Dashboard | Removed | Was `ManagerDashboard.tsx` at `/manager-dashboard`. Folded into the admin section on Dashboard on 2026-05-27. The `monday-manager-dashboard` edge function still backs the Triage card; its `review` array is no longer surfaced (the manager review queue moved to `review_runs`). |
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
| Submittals | Complete | `SubmittalList`, `SubmittalDetail`, `exportSubmittalPDF`, `submittalExclusions.ts`. Items link to repo or staging cutsheets via the two FK columns. **Populate-from-BoM** dedupes BoM rows by manufacturer+model, summing `qty` **and merging per-room `locations`** (`mergeLocations`) — the DTools sync splits one part into several rows when its unit cost differs (OFE / CO copies), and before 2026-09-18 only the first row's rooms survived onto the printed BoM-by-Room. **Per-item approval** (`add_submittal_item_approval.sql`): `Approve` / `R&R` / `Reset` actions render in the items table when status is Submitted or R&R, hidden in Draft, locked-as-approved badges in Approved. Package status auto-promotes to Approved when every item is approved and auto-demotes to R&R when an item is reverted; package marks preserved across Approved → Submitted transitions. Item delete is blocked downstream if any linked Purchasing module has the item ordered+. |
| Closeout Package | Complete | `CloseoutDashboard.tsx`, `exportCloseoutPDF.ts`, `exportSignOffPDF.ts`. Six tabs: Warranties, Punch List, Test & Sign-Off, As-Built Drawings, Manuals, Quick Start Guide. Closeout cover-page + punch section restyled to match the standalone Punch List PDF (grouped by location with checkboxes); items with empty location now group under `Unassigned` instead of being silently dropped. |
| Punch List PDF Export | Complete | `exportPunchListPDF.ts` — Instrata-branded cover, items grouped by location with hollow checkboxes for field walkthroughs, item numbers, wrapped descriptions, red-bold `Critical` priority, pre-checked + green for `Complete` rows. Wired to the Closeout → Punch List tab. |
| Test & Sign-Off PDF | Complete | `exportSignOffPDF.ts` — one page per room with a navy band header, items table with `Done` checkboxes, then the room sign-off statement (*"Instrata has completed the full scope of this room…"*) and a dual signature block (Client Representative + Instrata Representative — signature, printed name, date lines for each). |
| Quick Start Guide | Complete | New tool on the closeout dashboard. `quick_start_rooms` + `quick_start_steps` tables. Add Room modal accepts a custom name (for projects whose BoM is keyed by equipment) or picks from the project's BoM location list (incl. sub-locations); already-added rooms are dimmed. Each room renders as a card with inline-editable steps, each step has a `text` field and an optional `note` field. |
| O&M / Owner Manual | Complete | `OwnerManual.tsx`, `exportManualsPDF.ts`, `extractBookmarks.ts`. Skill-equivalent in-app. |
| Export BoM (Excel) | Complete | `utils/exportBoMExcel.ts` — **Export BoM** button in the Project Quote header (visible once a BoM exists). Rebuilds the two-tab, Instrata-branded workbook from the cowork skill (see `Reference/HualapaiTribeAdmin_BillOfMaterials_v2.xlsx`): **BoM by Manufacturer** (Manufacturer, Model, Quantity, Vendor, Unit Cost, CO Number, CO Type — grouped by mfr) and **BoM by Location** (Manufacturer, Model, Quantity, Labor Type, Unit Labor Hours, CO Number, CO Type — grouped by room). Built with **ExcelJS** (the bundled SheetJS is the community build and can't write cell styling) — palette + layout lifted verbatim from the reference `styles.xml`: navy (`#1B3A5C`) title + column-header band with white text, orange (`#E8872B`) brand bar + section-header text, light-blue (`#D6E0EA`) section fill, gray (`#333333`) bordered data rows, Arial throughout; section headers merged A:G, Unit Cost as `$#,##0.00`, Vendor parsed from `pricedFrom`. **Labor rows on the by-Location tab:** DTools quantifies time-based labor in *hours* (a labor line's `Quantity` field == its hours, so our synced rows carry `qty == laborHours`), so those render as **QTY 1** with the hours in the Unit Labor Hours column — matching the reference. Expense-type labor (Airfare, S&H, Premiere Protect: zero labor hours) keeps its real count in QTY with blank hours (`laborQtyHours` helper). CO attribution: contract lines read `Base Bid / Base Bid` (the ingested `ProjectBoMItem` has no per-item CO tag); only *ghost* CO lines — pending + approved-not-yet-republished, the same set the Quote card flags "not in contract" — are appended tagged with `co.number` + Internal/External, so approved+merged COs aren't double-counted. Downloads client-side and auto-files a timestamped copy to Project Files (`general` / docType `bom`) via the new generic `fileGeneratedFile` in `lib/projectFiles.ts`. |
| RFI List | Complete | `RFIList.tsx`, `exportRFIPDF.ts`. |
| Auto Reviewer (pre-review + manager review) | Complete | `AutoReview.tsx`, `ReviewQueue.tsx`, `reviewEngine.ts`, `reviewReport.ts`. Backed by `review_runs`, `review_flags`, `review_config`, `labor_rates`. **State machine after 2026-05-27 split:** `pending_review` (engineer's private pre-review on the project page — not in any manager queue) → engineer clicks **Send to Manager** → `submitted_for_review` (enters admin Needs Review card on Dashboard + `/review-queue` page) → admin opens → `in_review` (auto-promoted only when an admin opens a `submitted_for_review` run) → `approved` or `changes_requested`. Same `review_runs` record carries through every state — pre-review history is preserved across submissions. Engineer-side `MyWorkCard` count tallies `pending_review` + `changes_requested`; `in_review` is on the manager's plate and excluded. Migration: `supabase/migrations/add_submitted_for_review.sql` (extends CHECK; backfills any existing `pending_review` rows to `submitted_for_review` since under the old semantics they were already manager-queued). |
| Bid Leveling Generator | In Progress | Schema + `BidLevelingPage.tsx` + `bidLevelingEngine.ts` exist; spec is `BidLevelingGenerator_Phase1_Spec.docx` (Phase 1). |
| Personal Ops Dashboard | In Progress | `PersonalOpsPage.tsx`, `usePersonalOps.ts`, `EmailDigestCard`, `ConnectEmailBanner`, `EmailActionBar`, `SessionSelector`. Functions wired (`ms-graph-auth`, `ms-graph-emails`, `email-triage`). Spec at `personal_ops_feature_spec.html`. |
| Effort Survey | Complete | `EffortSurvey.tsx`. |
| Engineer Assignment Sync (Monday → DB) | Future | Today users only land on a project via: project creation (creator auto-added), DTools import (importing user auto-added), or manual self-add via the **Add me** button on the global Projects page. Monday's per-board engineer person columns are **not yet synced** to `project_members` / `projects.owner_id`. Planned: a webhook on the Pre-Sales `person` and a parallel Post-Sales person column → a receiver edge function that resolves the monday user → our `profiles` row → upserts into `project_members` and writes `projects.owner_id`. On Post-Sales rows, also write the carried-forward Pre-Sales engineer into `projects.legacy_engineer_id` (already added in `supabase/migrations/add_legacy_engineer.sql`; null until this sync ships). Backfill via a one-shot script that walks both boards and reconciles current assignments. The whole admin section (Triage, Needs Review, Team Bandwidth) is sized for what this sync will unlock — Triage stays on the monday-manager-dashboard feed in the meantime, Team Bandwidth will populate once `owner_id` is real on most rows. |
| Effort-Weighted Team Bandwidth | Future | Today the admin Team Bandwidth card on Dashboard counts active projects per engineer (active = `Not Started`/`In Progress`/`Review`/`Follow Up` on Pre-Sales; `Won`/`Not Started`/`In Progress`/`Install`/`Close Out` on Post-Sales). Planned: layer an effort *score* from `EffortSurvey` responses on top of the count, so the bar reflects load not just headcount. Post-Sales rows would also weight the legacy Pre-Sales engineer (`projects.legacy_engineer_id`) at a reduced multiplier (TBD) since that engineer still carries some responsibility post-contract. Implementation hook: `bandwidthRows()` in `AdminDashboardSection.tsx` is already pure — the row builder just needs to consume effort scores instead of (or alongside) project counts when the data is wired in. |
| Project Sections — Operations | Live (Schedule + Purchasing) | Sidebar group + Overview tool card render alongside Pre-Sales / Post-Sales with green accent. Schedule & Milestones and Purchasing are now live links with real counts; Inventory is still scaffolded (`SidebarDisabledLink`, dimmed in the Overview card). |
| Project Log card (Activity, Files & History) | Live (Comments + Files) | `ProjectLog.tsx` on the Overview between the tool grid and BoM. Three tabs (Comments / Files / Client GC Log) with full header, tab pills with live counts, and per-tab CTAs (Export PDF on Client/GC Log, "Open in SharePoint" on Files). Comments and Files tabs are fully wired (see rows below); Client / GC Log renders an empty-state placeholder. |
| Schedule & Milestones | Complete | `pages/operations/ScheduleMilestones.tsx` — two-tier list (project / phase) with computed status badges (`upcoming` / `at_risk` / `overdue` / `complete`), 7-day at-risk window, mark-complete prompt with optional note, edit/delete with confirmation, read-only Timeline view toggle, "Apply Default Commercial AV Template" wizard (12 milestones, +14 to +150 day offsets defined in `utils/milestoneTemplates.ts`). Project Overview surfaces a Next-3 milestones widget below the tool group cards. Phase 1 spec at `Product Spec/milestone-tracking.md`. |
| Purchasing | Complete | `pages/operations/PurchasingList.tsx` (modules per project) + `pages/operations/PurchasingDetail.tsx` (manufacturer-grouped table). Each module live-links one or more submittals with a persistent `+ Add Submittal` button. Detail view shows mfr/model/desc/qty/sold-in price (`unit_cost`)/vendor (`priced_from`) live-resolved, with inline-editable purchase price, ship-to (warehouse picker + custom address), need-by date, and PO number. Per-manufacturer header carries default ship-to + need-by; per-item rows inherit (greyed) unless overridden. Status advances `not_ordered → ordered → received` with auto-set dates. Always-visible freight row per manufacturer. Persistent red warning banner lists ordered items whose submittal-side approval has been reverted, until re-approved. Phase 1 spec at `Product Spec/02-purchasing-equipment-status.md`; deferred items tracked in `Product Spec/future_features.md`. |
| Warehouses | Complete | Org-wide ship-to destinations with name + address + active flag. Settings page exposes admin-only CRUD (`SettingsPage.tsx → WarehousesSection`). Backed by `warehouses` table; consumed by Purchasing module ship-to dropdowns. |
| Inventory | Future | `app/src/pages/operations/Inventory.tsx` exists with full styling but is not wired to a route. |
| Comments (Project Log) | Complete | Live chat thread on every project. Composer with ⌘+Enter shortcut, deterministic colored avatar chip + name + timestamp on every post, flat replies that default collapsed behind a blue notification badge showing the reply count, edit/delete on your own (admins on any), 6-emoji reaction picker (👍 ❤️ 😂 🎉 🚀 👀) with toggle semantics. Scrollable history bounded at 480px with an Expand toggle to 820px once the thread overflows. Any authenticated user can read and post — project membership is not required. Backed by `project_comments` (`add_project_comments.sql`); demo mode renders a "requires Supabase" notice in the tab. Lazy-loaded per project on `ProjectLog` mount. |
| Files (Project Log) | Complete | Per-project document repository backed by the company-browsable **ProjectFiles SharePoint site** (bytes) + the `project_files` Supabase index (browse/search/RLS). `FilesTab` in `ProjectLog.tsx`: category-grouped list (Contracts / Drawings / Submittals / Meeting Notes / Photos / Closeout / General), multi-file upload with category picker (staged through `project-files-temp`), download via fresh ~1h Graph URLs, per-file + header "Open in SharePoint" links, delete with confirm, live tab count badge. **Reconcile-on-open** (throttled to 5 min/project/session) picks up files added or deleted natively in SharePoint. **Auto-filing:** all non-financial PDF exports (submittal, RFI, RFI log, closeout, sign-off, warranty, punch list, manuals) also file a timestamped copy into the project folder via `fileGeneratedPdf` (`lib/projectFiles.ts`) — fire-and-forget, never blocks the download; gross margin is deliberately excluded (the site is company-browsable). MCP tools `list_project_files` / `get_project_file` expose the repo to Claude clients. Spec: `Product Spec/04-project-files.md`; migration `add_project_files.sql`; edge function `sharepoint-project-files`. |
| Client / GC Log | Future | Auto-generated timeline of client-level changes — meetings, base-bid contracts, change-order tracking (Requested / Proposed / Rejected / On Hold / Accepted), milestone completions. Branded PDF export. Tab placeholder lives in `ProjectLog.tsx`. |
| Monday Auto Project Creation | Replaced | Was deliberately no-op; `monday-webhook` now actively creates Project Tools rows on `create_pulse` events from either Monday board (different from the old "create on status=Review" behavior — every new Monday item lands in Project Tools). |
| Bug Reporting & Notifications | Complete | Three-phase feature. **Phase 1 — Bug Collection:** `BugReportModal.tsx` (title + body + optional screenshot upload); "Report a Bug" button at the bottom of the sidebar in `Layout.tsx` opens the modal from any page; page URL is captured silently. `add_bug_reports.sql` migration creates the `bug_reports` table and `bug-screenshots` Storage bucket. **Phase 2 — Admin Triage Panel:** `BugReportsCard.tsx` added to the Management section of `AdminDashboardSection`; expandable rows show description, screenshot thumbnail, status dropdown (Open / In Progress / Resolved / Won't Fix / Duplicate), resolution note textarea, and Save; closed issues toggle-hidden for a tidy default view. **Phase 3 — Notifications:** `NotificationBell.tsx` in the sidebar user strip — Supabase Realtime subscription on `notifications WHERE user_id = me` drives the live unread badge; panel marks all read on open. When admin saves Resolved / Won't Fix the reporter's `notification_preferences` are checked (default enabled), then a `notifications` row is inserted for the reporter. Settings → Notifications card (all users): toggle per notification type backed by `notification_preferences`. Migrations: `add_notifications.sql`. |
| Directory — Vendor Contacts | Complete | `DirectoryPage.tsx` at `/directory` (Workspace sidebar group, `BookUser` icon). Shared org-wide vendor/distributor/rep contact list, ported from the standalone `Vendor Contacts.html`. List view grouped by company + card view, full-text search across company/name/email/phone/title/brands, show-inactive toggle. Add/edit modal with two tabs — manual entry and **Paste signature** (auto-fills name/title/company/email/phone from a pasted email signature via `parseSignature` in `lib/vendorContacts.ts`). Company logos resolved client-side (`VendorLogo.tsx`: Clearbit → Google favicon → initials). **Any signed-in user can add, edit, deactivate, or delete any contact** — no admin gate and no email-approval queue (both removed from the original). Queries Supabase directly (not in the global Zustand store); demo mode renders read-only. Backed by `vendor_contacts` (`add_vendor_contacts.sql`), seeded with ~80 contacts. The route name is intentionally generic to host a future client/CRM database. |
| Project Documentation — Gross Margin Form | Complete | `ProjectDocumentation.tsx` — "Project Documentation" card at the bottom of Project Overview, below the Project Quote. Until the project is synced with DTools it shows a "sync with DTools first" note; once synced it lists the reports (Phase 1: the **Gross Margin Form**). The GM Form auto-fills from the BoM + `dtools_gm_meta`: labor collapsed into Install (`Cabling/Install/Finish/Mobilization`), Programming (`Bench/Commissioning/Programming/Training/Engineering`) and Travel buckets; **Subcontractor / Equipment Rental / Permits** (matched by exact DTools `Model`, even though carried as fixed-cost labor) reclassified into Equipment; **Premiere Protect** carved out into Job Information. PROJECT TOTALS = DTools root − Premiere Protect, anchored to the transform's verified split (a review banner shows if it drifts >$1). View/Edit toggle with per-field overrides (only deltas persisted to `project_documents`), per-field + global reset-to-synced, an orange dot on edited fields, and an Instrata-branded **Print PDF** (`exportGrossMarginPDF.ts`). Compute is pure (`utils/grossMargin.ts`), regression-tested by `scripts/verify-gm-form.mts`. Edit gated to project members. |
| Settings | Complete | `SettingsPage.tsx`. Sections: Company Information, PDF Export Defaults, Team Members (admin), Auto Review Thresholds (admin), Labor Rates (admin), Warehouses (admin), **GM Form Special Lines** (admin — the four DTools `Model` match strings, backed by `review_config` `gm_model_*` keys via `lib/gmSettings.ts`), Notifications (all users), About. |
| Auth (Login / Register) | Complete | `Login.tsx`, `Register.tsx`, `AuthContext.tsx`. |
| Project Wiki | Scaffold (testing) | `ProjectWiki.tsx` at `/projects/:id/wiki` (persistent sidebar link under Overview — the wiki straddles both phases; `WikiSummaryCard` on the Overview). Per-project knowledge base per `Product Spec/project-tools-wiki-spec.md`: **Project context** card (summary / scope / design basis / wiki status, markdown), **Needs your input** card (open + answered questions grouped by severity, blocking-room count), **Search** card (the same `search_project_wiki` RPC Claude uses over MCP, highlighted snippets), and the **room index** table (status filter chips incl. "Blocking"; red left bar on blocking rooms). Row click → `?room=<id>` drill-down (`components/wiki/WikiRoomDetail.tsx`): headline + status editor, details grid (floor, D-Tools location, type, area, size class/basis, conferencing, typical-of roster with mismatch warning), Design notes + Validation notes (markdown, rendered by a minimal safe `MarkdownText`), Decisions (add/edit/delete, kind chips, assumption confirmed flag, source ref), Questions (raise → room escalated; answer with optional logged decision → resolved), Labor (8 D-Tools buckets, the 4 CSV-required ones pre-enabled at 0.00, basis text), BoM line links (picker suggests lines whose D-Tools locations mention the room) and Project File links. **Export markdown** downloads a one-file snapshot in the brief's `wiki.md` → `01-Design/room-*.md` → `_questions-log.md` → `02-Estimating` shape (one-way; Project Tools is the source of truth). Writes are member-gated (view-only banner otherwise); data layer `lib/projectWiki.ts` (fetched on demand, not in the store). Agent-written rows carry an origin tag. Not yet: markdown import / round-trip, re-run reconciliation policy, review-isolation of `validation_notes` (spec §8 open items). |
| Lead Finder | Built (pending cut-over) | Admin-only page `pages/LeadFinderPage.tsx` at `/lead-finder` (sidebar `Radar` icon next to My Day), ported from the standalone LeadFinder app and redesigned in the Project Tools style. Tabs: **Leads** (summary tiles, search + office / lane / review / source filters with More filters for match mode, status, due-after, min score, since-last-run, Bid Board state, in-range and location-unknown; table or Leaflet map with office radius circles; inline review; CSV export identical to the old export), **Run** (sources, date window, live per-source progress, daily-run status), **Offices** (geocode badges, add/edit/deactivate through the worker), **Run log**, **Settings** (default radius, SAM budget, enabled sources, worker health, BuildingConnected Connect/Disconnect). Row click opens a slide-over (`components/leadfinder/LeadDrawer.tsx`): review + notes, documents (SAM download, drag-and-drop upload incl. zips through the worker, 5-minute signed download links from the worker, rescan), triage (cost-capped confirm, NDA tick, history, report), Bid Board fields, why it matched, details, office distances, notice history, raw payload. Data via `hooks/useLeadFinder.ts` (tables + `lf_results`, realtime on jobs). Engine: `leadfinder-worker/` (Python, Fly app `instrata-leadfinder`) — see its README and DECISIONS D-21. Schema `add_lead_finder.sql`. |
| Salesforce ↔ monday Sync + Hope's Queue | In Progress | Replaces the three Zapier automations and adds Hope's task queue. Spec `Product Spec/project-tools-sync-and-queue-spec.md` + `monday-build-guide.md`; plan `Product Spec/sync-and-queue-implementation-plan.md`. **Done:** schema migration (`add_sync_and_queue.sql`, applied 2026-10-11); `sync-engine/` package scaffold; the pure reconcile planner (`sync-engine/src/reconcile/plan.ts` — create eligibility, field sync against the last-synced baseline, blank-never-clears, mapping-miss failure tasks, all §4.6 stage actions, Win 100% → Won, Pre-Engineering move) regression-tested by `scripts/verify-sync-reconcile.mts` (31 cases incl. idempotency); Salesforce client (Client Credentials, SOQL builders, field names verified against the production org 2026-10-11) and monday client (queries/mutations verified against the live GraphQL schema — note `settings_str` is gone, `settings` replaces it); config loader + label drift check; the `writeGate` (the only path to outbound writes; dry run journals instead of sending); executor (create-then-save-link crash safety, dry-run baseline, failure-only tasks in dry run) and `reconcileOpportunities`; internal `POST /admin/reconcile/:id`; Dockerfile + `fly.toml`. `npm test` in `sync-engine/` (28 tests, the store + executor run against the real migration in PGlite). **Webhooks + worker (2026-10-12):** `POST /webhooks/salesforce` (X-AVSS-Secret) and `/webhooks/monday/:secret` (challenge handshake) persist to `webhook_inbox` and return; a lease-based worker drains it (5 attempts with backoff, then a failure task); Salesforce events batch into one reconcile per opportunity; monday events route to writeback (DB-backed 30 s debounce, newer edits supersede older), rework logging of hand edits to Salesforce-owned fields/status, or link archiving; own echoes ignored. Writeback patches only `UnitPrice` + `Sold_in_Margin__c` and refuses Quantity ≠ 1. Hourly sweep enqueues AV opportunities changed since the watermark (−10 min), changed and `queryAll`-deleted line items, and opportunities behind open unmapped-value tasks (so mapping fixes self-apply). monday webhooks self-register at boot (ids + URL hash in `engine_status`). Monday API pinned to 2026-07. 52 tests. **Next:** backfill + dry-run report, Sync Admin + Hope's Dashboard pages, MCP tools, queue engine. |

---

## 6. Monday.com Reference

### Boards
| Board | ID | Used by |
|---|---|---|
| AV Pre-Sales Summary | `3477536693` | `monday-backfill`, `monday-webhook`, `monday-manager-dashboard` |
| Post-Sales (Project Delivery) | `3523133226` | `monday-backfill`, `monday-webhook` |

### Integration identity
The sync engine writes to monday as the dedicated user **"AV Integrations"** (`119228546`, avsfintegration@instrata.com), set as `MONDAY_INTEGRATION_USER_ID` in `sync-engine/fly.toml`. Webhook events from this user are the engine's own echoes and are ignored. It must be a member of every board the engine writes to (Pre-Sales and Post-Sales are collaborators-only). The edge functions still use `MONDAY_API_TOKEN` (Seth's token).

### Project ID convention
Format: `INST-YYYY-NNNN` (e.g. `INST-2026-0042`). Year-prefixed sequence with per-year reset, generated atomically via `generate_project_code()`. The same code is written to **both boards' Project ID text columns** when a sibling pair is identified, so the link survives Monday's pre-sales→post-sales duplication automation. `project_code` (not `monday_item_id`) is the canonical key in `projects`.

### Columns
| Board | Column ID | Type | Meaning |
|---|---|---|---|
| Pre-Sales | `status9` | Status | Workflow status — values: `Not Started`, `In Progress`, `On Hold`, `Review`, `Follow Up`, `Won`, `Lost`, `Declined to Bid`, `Rebid` (Monday "ON HOLD" gets normalized to `On Hold` in Project Tools). |
| Pre-Sales | `text_mm2rcnav` | Text | Project ID — written by `monday-backfill` and `monday-webhook`. |
| Pre-Sales | `date7` | Date | Due date — Dashboard admin-section Triage sort key. |
| Pre-Sales | `person` | People | Pre-sales engineer assignment. Empty / `personsAndTeams: []` = unassigned. **Not yet synced** to `projects.owner_id` / `project_members` (planned — see Engineer Assignment Sync in §5). Today's Triage card surfaces unassigned items so an admin can act on them in Monday; downstream cards (Team Bandwidth) populate only once the sync ships. |
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
- **Admin Triage card (Dashboard):** `dueDate set AND person column has no assignees` → "Triage" bucket from `monday-manager-dashboard`. Source-of-truth swap planned: once Engineer Assignment Sync ships, this card moves to a DB query against `projects` LEFT JOIN `project_members` filtered on no assignment.
- **Admin Needs Review card (Dashboard):** driven by `review_runs` where `status IN ('submitted_for_review','in_review','changes_requested')`. The `review` array still returned by `monday-manager-dashboard` (items with monday `status9.text === 'review'`) is no longer consumed by the UI — kept in the edge function output to avoid touching the function during the cutover.
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
| `MONDAY_WEBHOOK_SECRET` | `monday-webhook` — shared secret gating inbound webhook calls (added 2026-07). Must match the `?token=` on the delivery URL configured in Monday. |
| `MONDAY_PRESALES_BOARD_ID` (optional, default `3477536693`) | `monday-manager-dashboard` |
| `MS_GRAPH_TENANT_ID` (default in code: `d633c932-8a52-4aeb-a755-c0f1ffaf103c`) | `ms-graph-auth`, `ms-graph-emails` |
| `MS_GRAPH_CLIENT_ID` | `ms-graph-auth`, `ms-graph-emails` |
| `MS_GRAPH_CLIENT_SECRET` | `ms-graph-auth`, `ms-graph-emails` |
| `MS_GRAPH_STATE_SECRET` (optional; falls back to `MS_GRAPH_CLIENT_SECRET`) | `ms-graph-auth` — HMAC key for signing the OAuth `state` (added 2026-07). |
| `APP_ORIGIN` (default `https://instrata-project-tools.fly.dev`) | `ms-graph-auth` (callback redirect target) |
| `GRAPH_TENANT_ID` | `sharepoint-cutsheet`, `sharepoint-project-files` |
| `GRAPH_CLIENT_ID` | `sharepoint-cutsheet`, `sharepoint-project-files` |
| `GRAPH_CLIENT_SECRET` | `sharepoint-cutsheet`, `sharepoint-project-files` |
| `SHAREPOINT_SITE_ID` | `sharepoint-cutsheet` (resolve once via `bootstrap` op) |
| `SHAREPOINT_DRIVE_ID` | `sharepoint-cutsheet` |
| `SHAREPOINT_STAGING_FOLDER_ID` | `sharepoint-cutsheet` |
| `SHAREPOINT_REPOSITORY_FOLDER_ID` | `sharepoint-cutsheet` |
| `SHAREPOINT_PROJECTS_SITE_ID` | `sharepoint-project-files` (resolved via its `bootstrap` op 2026-07-06; ProjectFiles site) |
| `SHAREPOINT_PROJECTS_DRIVE_ID` | `sharepoint-project-files` ("Project Files" library drive) |
| `ANTHROPIC_API_KEY` | `email-triage` |

### Frontend (`app/.env`, build-time)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- (Plus any other `VITE_*` referenced from `app/src/lib/supabase.ts`.)

### Fly.io
- App-level secrets are scoped per Fly app; deployment uses `fly.toml` + `Dockerfile`. The Supabase service-role key **must not** appear here — it stays in Supabase function secrets.

### MCP server (`mcp-server/`, separate Fly app `instrata-project-tools-mcp`)
Runtime secrets (set via `fly secrets set`, read at **runtime** — not build args):

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | project URL |
| `SUPABASE_ANON_KEY` | PostgREST apikey (public, same as `VITE_SUPABASE_ANON_KEY`) |
| `SUPABASE_JWT_SECRET` | **legacy HS256 secret** — mints short-lived per-user JWTs and the server's own `mcp_service` role JWT. SENSITIVE; treat like service-role. No service-role key is used by this server. |
| `PUBLIC_BASE_URL` | this server's public origin (`https://instrata-project-tools-mcp.fly.dev`). OAuth issuer + protected-resource identity; must match the URL clients use exactly. Server refuses to boot without it. |
| `OAUTH_ADMIN_CLIENT_ID` / `OAUTH_ADMIN_CLIENT_SECRET` | optional pre-registered OAuth client for the claude.ai connector's Advanced settings (bypasses DCR). Secret lives only here, never in the DB. |

Optional client override: `VITE_MCP_SERVER_URL` (frontend build-time) points the Settings "Connected apps" card at a non-default server URL; defaults to `https://instrata-project-tools-mcp.fly.dev/mcp`.

### Lead Finder worker (`leadfinder-worker/`, separate Fly app `instrata-leadfinder`)
Runtime secrets (`fly secrets set -a instrata-leadfinder ...`); non-secret config is `[env]` in `leadfinder-worker/fly.toml` (`APP_URL`, `PUBLIC_URL`, `APS_CALLBACK_URL`, `SCHEDULE_HOUR_ET`, `TRIAGE_BUDGET_USD`, `LEADFINDER_DATA_DIR=/data`). One always-on machine with volume `leadfinder_data` at `/data`, which is the only copy of the bid documents (Fly daily snapshots; Supabase Storage isn't used because the free plan caps files at 50 MB and storage at 1 GB). CI: `.github/workflows/deploy-leadfinder.yml` (tests, then deploy) with `FLY_API_TOKEN_LEADFINDER`.

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres (session pooler). The worker connects as `postgres` and bypasses RLS. SENSITIVE. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Checking the caller's Supabase token on the document endpoints and `POST /bc/authorize` (then `profiles.role = 'admin'`). |
| `DOWNLOAD_SIGNING_KEY` | Optional HMAC key for the 5-minute document download links; random per boot if unset. |
| `SAM_API_KEY` | SAM.gov public API key (expires every 90 days). |
| `HTTP_USER_AGENT_CONTACT` | Contact email in the User-Agent sent to SAM.gov and the Census geocoder. |
| `APS_CLIENT_ID` / `APS_CLIENT_SECRET` | Autodesk app for BuildingConnected (callback `https://instrata-leadfinder.fly.dev/oauth/callback`). |
| `ANTHROPIC_API_KEY` | Triage of bid documents (Claude Managed Agents, av-triage skill). |

### Notable in-code defaults (consider moving to env)
- D-Tools subsidiary→business-unit map is hard-coded in three functions (`SUBSIDIARY_TO_BU`).
- Tenant ID `d633c932-8a52-4aeb-a755-c0f1ffaf103c` is a hard-coded fallback in two functions.
- Monday board id `3477536693` falls back in code if env unset. Post-sales board `3523133226` is hard-coded in `monday-backfill` and `monday-webhook` (not wired to env).
- Project ID column ids (`text_mm2rcnav` pre-sales, `text_mm2rsn` post-sales) and the status column id (`status9`, same on both boards) are hard-coded in `monday-backfill` and `monday-webhook`.
- The Claude model ID `claude-sonnet-4-20250514` is hard-coded.

---

## 8. MCP Server (OAuth 2.1 · read tools + scoped writes: submittals, project wiki)

A standalone Node/TypeScript service in `mcp-server/`, deployed as a **separate Fly app** (`instrata-project-tools-mcp`) alongside the SPA. It lets internal staff connect a Claude client (claude.ai, Desktop, Code, Inspector) to their project data and work with it in natural language. Read tools cover everything; **write tools are limited to the cutsheet submittal workflow** (`src/submittalTools.ts`, spec `Product Spec/cutsheet-submittal-mcp-writes-spec.md`) **and the project wiki** (`src/wikiTools.ts`, spec `Product Spec/project-tools-wiki-spec.md` — the write surface the AVSS bid pipeline and notes-aggregation skills target).

**Auth: the server is its own OAuth 2.1 authorization server** (spec `Product Spec/project-tools-mcp-auth-spec.md`, design `…-implementation-plan.md`). Clients hit `POST /mcp`, get a 401 with `WWW-Authenticate: resource_metadata=…`, discover the AS at the same origin (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), register — in practice **claude.ai and Claude Code both use CIMD** (`client_id` = `https://claude.ai/oauth/mcp-oauth-client-metadata` / `…/claude-code-client-metadata`; DCR at `/oauth/register` serves Inspector-style clients; an admin pre-registered client id from env is the fallback) — and send the user to `/oauth/authorize`. claude.ai's edge returns 403 to our CIMD fetch from Fly, so both Anthropic documents are **pinned** in `src/oauth/clients.ts` and used whenever the live fetch fails. Because the SPA and this server are different origins with no shared session, `/oauth/authorize` renders the server's **own login + consent page**: the user enters their Project Tools email/password (verified against Supabase Auth — same identity store as the app) and approves the requested scopes; `POST /oauth/consent` issues a one-time code and `POST /oauth/token` exchanges it (PKCE S256 mandatory) for an opaque access token (1 h) + refresh token (30 d, rotated on every use, family revoked on replay). The protocol plumbing is `@modelcontextprotocol/sdk`'s `server/auth` handlers; `src/oauth/` supplies the Supabase-backed provider, client store, consent page and metadata. The old personal-token scheme (`mcp_tokens`, `?key=`, `/mcp/<token>`) is gone.

**Security model (same as the app).** A verified access token resolves to a `user_id`; the server mints a short-lived (~5 min) Supabase JWT for that user and queries PostgREST **as them**, so the existing RLS policies are the sole authority — for writes too (member-gated, like the UI). **Scopes gate tool visibility:** `mcp:read` → the 19 read tools, `mcp:write` → the 14 write tools (5 submittal + 9 wiki), `offline_access` → a refresh token; a token lacking a scope doesn't see those tools in `tools/list`, and calling one returns an `isError` tool result, never a 401. OAuth state lives in `oauth_clients` / `oauth_auth_codes` / `oauth_access_tokens` / `oauth_refresh_tokens` (hashes only), owned by a dedicated PostgREST role **`mcp_service`** that only this server can assume (it mints the role's JWT with the legacy secret) — chosen over service-role or `authenticated`-callable RPCs so no app user can reach token-issuing functions. Redirect URIs are allowlisted to `https://claude.ai/api/mcp/auth_callback` and loopback `/callback` (any port). The server holds **no service-role key**.

```
Claude client ──401──▶ discovery ──▶ DCR/CIMD ──▶ browser: /oauth/authorize (login + consent) ──▶ code ──▶ /oauth/token ──▶ tokens
Claude client ──(Streamable HTTP, Authorization: Bearer <access token>)──▶ mcp-server
                                                                             │ token hash → user_id + scopes (oauth_access_tokens, as mcp_service)
                                                                             │ mint {sub:user_id, role:authenticated} JWT
                                                                             ▼ register only scope-permitted tools; query AS user
                                                                         Supabase ── RLS ──▶ only that user's data
```

**Tools.** Read (`mcp:read`): `get_me`, `list_projects`, `get_project`, `get_project_bom`, `list_rfis`, `list_submittals`, `list_purchasing`, `list_milestones`, `search_catalog`, `search_vendor_contacts`, `search_cutsheet_repository`, `list_project_files`, `get_project_file`, and the project-wiki reads `get_project_wiki`, `list_project_rooms`, `get_project_room`, `list_room_decisions`, `list_project_questions`, `search_project_wiki`. Write (`mcp:write`): submittals — `create_submittal`, `update_submittal`, `populate_submittal_from_bom`, `attach_cutsheet`, `detach_cutsheet`; project wiki (`src/wikiTools.ts`) — `upsert_project_wiki`, `upsert_project_room` (idempotent on `(project_id, dtools_location)` or `id`, so pipeline re-runs reconcile rather than duplicate), `set_room_status`, `append_room_decision`, `set_room_labor` (stores `0.00`; fills the four CSV-required buckets by default), `raise_room_question`, `answer_room_question` (optionally logs + links the resulting decision), `link_room_bom_lines`, `link_room_files`. The file tools mint download URLs by invoking the `sharepoint-project-files` edge function **with the caller's minted JWT** — the server holds no Graph credentials. Every tool must have an entry in `src/oauth/scopes.ts`; the server refuses to boot otherwise.

**User-facing:** **Settings → Connected apps** lists the user's approved connections (one per refresh-token family: client, read-only vs read & write, connected/last used) with Disconnect / Disconnect all via the `oauth_disconnect` RPC (SECURITY INVOKER, own rows only).

**Transport:** stateless MCP Streamable HTTP (`POST /mcp`), `@modelcontextprotocol/sdk` 1.30. Per-access-token in-memory rate limit on `/mcp`; per-IP limits on the OAuth endpoints. `GET /healthz` for Fly. **No redirects anywhere** (a redirect drops `Authorization` on hosted Claude).

⚠️ **Legacy-key dependency (unchanged by OAuth).** Both minted JWTs (per-user, and `mcp_service`) are signed with the project's **legacy HS256 secret** (dashboard "Previous Key" — still trusted for verification, and the same key the app's anon key depends on). OAuth changed how the caller is identified, not how the server talks to Supabase. **When you rotate Supabase keys / revoke the legacy HS256 secret, this server's Supabase access must be upgraded at the same time.** See `mcp-server/README.md`.

**Migrations:** `add_oauth_server.sql` (tables, `mcp_service` role + grants, RPCs, nightly `pg_cron` job `oauth-cleanup-nightly`) — applied 2026-09-17. `drop_mcp_tokens.sql` removes `mcp_tokens` + its RPCs after cutover.

**Deploy:** CI (`deploy-mcp.yml`) on push to `main` touching `mcp-server/**`; secrets (`PUBLIC_BASE_URL`, optional admin client) must be set first. Manual: `cd mcp-server && fly deploy --remote-only`. Dev scripts: `scripts/verify-mcp-service-role.mts` (PostgREST honours the role), `scripts/oauth-smoke.mts` (full token lifecycle without a browser).

---

## 9. Known Limitations & Tech Debt

**Auth & Authorization**
- `monday-manager-dashboard` does not enforce admin role server-side — it trusts that the UI hides it. A signed-in non-admin who knew the function name could call it. Also has a `debugNameQuery` path that echoes raw Monday column data. **Open** — deferred from the 2026-07 security pass.
- `bug-screenshots` is a **public** Storage bucket — screenshots are readable by anyone with the object URL. **Open** — deferred from the 2026-07 security pass.
- Several Bid Leveling RLS policies (`Authenticated users can update bid leveling sessions`) are intentionally permissive — any authenticated user can update any session. May tighten when concurrency matters.
- **Design decision (intended):** every authenticated user can read all projects and self-add to any project team (see the project access model note in §3). Safe against escalation now that self-promote-to-admin is closed (2026-07), but confirm org-wide visibility is acceptable for the team.
- **MCP consent page handles passwords on the MCP origin.** Because the SPA and `mcp-server` are separate Fly apps with no shared session, the OAuth consent page collects the user's Project Tools email/password itself (verified via Supabase Auth's password grant, session signed out immediately). It's branded, rate-limited (10/min/IP), `no-store`, `no-referrer`, frame-denied — but it is a second place staff type their password, on a `fly.dev` host. A custom Instrata domain would remove the "looks unfamiliar" concern; SSO/MFA later would mean switching to the SPA-redirect variant described in the implementation plan §2. **Open by design.**
- **MCP pinned CIMD documents can drift.** `KNOWN_CIMD_CLIENTS` in `mcp-server/src/oauth/clients.ts` is a hand copy of `https://claude.ai/oauth/mcp-oauth-client-metadata` and `…/claude-code-client-metadata`, used because claude.ai's edge 403s our fetch from Fly. If Anthropic changes those documents (new redirect URI, new client id URL) the live fetch would pick it up only if the 403 stops; otherwise Connect breaks until the pinned copy is updated. Re-`curl` them when a Claude client update coincides with connect failures. **Open.**
- **MCP `mcp:write` denial shape.** The auth spec asked for a JSON-RPC error (`-32003`); the SDK reports a scope-hidden tool as an `isError` tool result (`MCP error -32602: Tool … disabled`). Same intent (never a 401), documented in the README. **Accepted deviation.**
- *Resolved 2026-09-17 (OAuth cutover):* placeholder MCP auth — pasted personal tokens, `?key=` and `/mcp/<token>` URL forms, `mcp_tokens` + `resolve_mcp_token` — replaced by the OAuth 2.1 server in §8.
- *Resolved in the 2026-07 security pass:* self-promote-to-admin (profiles trigger); unauthenticated D-Tools + `sharepoint-cutsheet` functions; `monday-webhook` forgery (shared secret); `resolve_mcp_token` anon grant; OAuth state signing; `review_runs`/`review_flags` `with check(true)`. See §10.

**Schema / Data Model**
- `projects.value` is stored as a **formatted string** (`"$505,432.50"`), not a numeric. Re-formatting requires a parser. D-Tools `Price` is the source of truth.
- `cutsheet_project_usage` table exists but isn't yet read anywhere observable in the file tree.
- `submittal_items` carries two cutsheet pointers (`cutsheet_repository_id`, `cutsheet_staging_id`) — invariant is "at most one set"; nothing in the schema enforces it (no CHECK constraint).
- D-Tools subsidiary parsing relies on three different field shapes — robust but adds maintenance surface.

**DTools sync**
- The offline verification harness (`scripts/verify-dtools-sync.mts`) depends on saved DTools payloads in `Reference/`, which are **intentionally untracked** (real customer pricing). Harness runs only on machines that have the fixtures.
- Zero-priced payloads for projects never synced pre-approval can't recover per-type **cost** rates (price rates derive from item `InstallPrice` deltas; cost has no equivalent field) — labor cost lands on the unattributed anchor line. Ak Chin + Maricopa labor meta was backfilled from fixtures via `scripts/backfill-labor-meta.mts`.
- Maricopa carries a −$391 "Labor (unattributed)" line — ~4h of hour drift between DTools' published phase rollups and Σ item hours (DTools edits after approval). Anchored to root totals, so project totals are exact; per-phase attribution is best-effort on merged-CO projects.
- `COChangeTypeId = 3` (presumed "Adjusted"/Modified) has never been observed in a real CO payload — mapping is speculative until one shows up.

**Edge Functions**
- `email-triage` is pinned to **`claude-sonnet-4-20250514`**, which is older than the Claude 4.6/4.7 generation. Worth bumping.
- `email-triage` parses Claude output via regex (`/\[[\s\S]*\]/`) rather than structured outputs / tool use — silently returns `[]` on a malformed response.
- `dtools-import-project` calls `dtools-project-lookup` over public HTTPS using the service-role JWT. Works, but couples deploy of one to the other and adds round-trip latency vs. shared module.
- `sharepoint-cutsheet.uploadStaging` accepts base64 PDFs in the JSON body — capped by Supabase function body limit (~5 MB). Larger cutsheets need a different path (signed upload URL or chunked Graph upload).
- `monday-manager-dashboard` builds GraphQL via string concatenation — safe today (board id is from env, group id is matched server-side), but adopt parameterized queries before exposing user-supplied input.
- `monday-manager-dashboard` still returns a `review` array (items where monday `status9.text === 'review'`) but the frontend no longer renders it — the Needs Review card now runs off internal `review_runs`. Trim the function body once we're confident nothing external depends on the field.
- Monday pagination caps at 10k items via a hard loop limit (`HARD_CAP_LOOPS=20 * 500`).
- `monday-backfill` `forceClear` mode is scaffolded (the body flag is parsed) but the wipe-then-regenerate behavior wasn't needed in the recovery path that shipped — kept as a safety hatch for future re-syncs.
- Status field on `projects` is **free-text** (no DB CHECK). Status normalization is intentionally minimal — only `"ON HOLD"` gets case-corrected. New Monday status values flow through verbatim; the app falls back to default StatusBadge styling for unknown values until colors are wired in `app/src/components/StatusBadge.tsx`.
- 7 post-sales items (per the most recent backfill) don't match any pre-sales sibling and exist as standalone Project Tools rows. If any of those should later be merged into a pre-sales project, no UI exists yet — must be done by hand in SQL by updating `project_code`.
- `monday_item_id` (legacy single-board pointer) is retained on the `projects` row for backward compatibility but is no longer the canonical link. Drop it once we're confident nothing reads it.

**SharePoint Integration**
- Manufacturer subfolder names are sanitized with a single regex; collisions on different inputs that sanitize the same way (e.g. `AB:CD` and `AB-CD`) merge silently.

**Frontend**
- Project-tool membership gate (`JoinProjectModal` on `ProjectOverview`): a non-member who opens a tool or tries to edit BoM data is prompted to join the project or continue view-only. The **"view only" choice is persisted only for the session** via `sessionStorage` (`viewOnly:{projectId}`), so it re-prompts after a reload or in a new tab. Decision held intentionally — revisit whether to persist this per-user durably (e.g. a `dismissed_view_only` preference) so users who routinely browse other teams' projects aren't re-prompted each session. Note the flag only suppresses the prompt for read-only navigation; edit actions still prompt every time until the user joins.
- `app/src/store/index.ts` is a single Zustand store — no slicing observable; large pages may re-render aggressively.
- React 19 + Vite 8 + Tailwind 4 is the bleeding edge; expect ecosystem friction (some libs still emit React 18-era warnings).

**Deployment**
- **Two CI deploys.** `.github/workflows/deploy.yml` runs `flyctl deploy` (root `fly.toml` → app `instrata-project-tools`) on every push to `main`; `.github/workflows/deploy-mcp.yml` deploys `mcp-server/` (its own `fly.toml` → `instrata-project-tools-mcp`, token `FLY_API_TOKEN_MCP`) on pushes to `main` that touch `mcp-server/**`. Because the MCP deploy fires on merge, any new Fly secret or migration the server needs must be in place **before** merging. Edge functions deploy separately via `npx supabase functions deploy <name>` (config in `supabase/config.toml`); `functions deploy` never deletes server-side functions — removing one requires `functions delete`.
- `supabase` CLI is a root devDep (run via `npx supabase`); migrations are run **manually in the SQL Editor** per migration file headers — files use non-timestamped names so `supabase db push` is a no-op.

**Docs**
- This file. Keep it honest.

---

## 10. Changelog

<!-- Maintained manually. Add entries top-down (newest first). Format suggestion:
### YYYY-MM-DD
- **Area** — what changed and why.
-->

### 2026-10-23 — Coordinator: set aside items that can never match Salesforce
- **Set aside** (Seth): change orders and other monday items that will never agree with a Salesforce record can be set aside from the Coordinator page, from the Data Cleanliness item lists or from a backfill / "isn't linked" task's item list, with a reason (Change order / Other) and a note. The sync then skips them: no blank-field count (the count shows how many were set aside), no backfill link or problem, no writes, no "isn't linked" task; open tasks drop them within a minute. A new **Set aside** tab lists them with who / when and a **Restore** button. A set-aside item that holds a Salesforce link hands it to the other item with the same Salesforce ID at the next backfill (the real deal behind a change order). Proposal Type (Bid / Negotiated) is untouched because management reporting uses it. Migration `sync_set_aside.sql` (both schemas; table `item_set_aside`, audited).

### 2026-10-21 — Sync production rollout: engine in dry run; Hope's Queue live during the dry run
- **Production engine** `instrata-sync-engine` deployed in dry run against production Salesforce and the production monday boards (rollout P1–P10: integration user and permission sets, External Client App, credentials, both Flows, board columns, backfill of 440 links and 50 problem tasks, diff report).
- **Hope's Queue writes in dry run** (Seth): the queue push has its own always-live write gate, switched only by `queue_push`, so Hope can work backfill problems and reviews before the switch. All other writes still follow `SYNC_MODE`.
- **Fix:** queue items were re-sent every minute because the "is it still clean" check compared a millisecond JS timestamp with Postgres's microseconds. It now compares the exact value.
- **Fix:** dry run no longer saves tasks about intake items it only pretended to create (they showed up on Hope's Queue as "still on Triage" / "estimate due date" items that didn't exist).
- **Project Tools deployed** with the Coordinator page (v76).

### 2026-10-20 — Coordinator page in Project Tools
- New page **Coordinator** (`/ops-queue`, sidebar; role-based so any engineering workflow coordinator gets it) for admins and ops coordinators (`profiles.is_ops_coordinator`, now in the auth context as `isSyncViewer`): KPI tiles, the sync task queue grouped like the monday board with status edits, Data Cleanliness item lists with monday links, and a Mappings screen (Sales Rep / Business Unit / Win % / Estimators) where Fix Mapping tasks get resolved. Admin-only Sandbox data switch reads the `sync_sandbox` schema. Data layer `app/src/lib/syncQueue.ts`; the engine publishes the cleanliness lists and monday label names to `engine_status`.

### 2026-10-20 — Hope's Queue board (sync engine pushes tasks to monday)
- **Data cleanliness:** an hourly count of blank required fields on active work (Pre-Sales Follow Up + this year's Won, Post-Sales In Progress / Install / Close Out, Programming On Radar / Active / Close Out) becomes one "Data Cleanliness" row in Hope's Queue, with a daily snapshot per field for trends. Rules and exemptions live in `config_cleanliness_rule`. Migration `sync_cleanliness.sql`.
- **Won tasks:** a Pre-Sales item set to Won (by the sync or a person) opens **Won – Handoff** (due 5 business days later) and **Won – Open Job** (no due date, in a new "Job Opening" group on Hope's Queue, Lee's confirmed-to-win list). Open Job closes itself once the deal's Post-Sales item has a Project Number. If the deal leaves Won, still-open Won tasks are withdrawn (archived off the queue, not counted as done) and return if it's Won again. Migration `sync_won_tasks.sql`.
- **Report tasks:** the queue now opens Hope's recurring report tasks: PM weekly (Thursday 5 pm ET), weekly pre-sales report by salesperson (Friday 5 pm ET) and the AVSS monthly report to Lee (3rd business day, 5 pm ET). One per week / month; Done means sent. Migration `sync_report_schedules.sql`.
- New private monday boards **Hope's Queue** (`18436259969`) and **Hope's Queue - Sandbox** (`18436259977`) in the Pre-Qualification workspace, built through the API with fixed column ids. The engine (`sync-engine/src/queue/`) keeps them in step with the `task` table every minute: creates items for open tasks, pushes changes, and places items in Today / Overdue, This Week, As Needed, Background or Done (Eastern time). Hope's Status edits come back by webhook (Done closes the task, moving off Done reopens it, archiving an open item closes it). Task Type labels group the engine's task kinds by what Hope does (Fix Mapping, Review, Sync Problem, …). Setting `queue_push` (production off until the rollout). Migration `sync_hopes_queue.sql`.

### 2026-10-19 — Sync: Triage engineer pick (engineers off the intake boards)
- Engineers are no longer members of the Pre-Qualification and Triage boards, so they can't start work before a deal is triaged. On Triage the Pre-Sales Engineer people column is replaced by a single-select dropdown (fixed id `engineer_pick`); the people column is removed from Pre-Qualification too. At R7 (Bid + a pick) the engine moves the item to the Pre-Sales Summary and assigns the real people column there, which is when the engineer gets monday's notification; the Salesforce Estimator and rep email follow in the same step. `map_estimator.triage_label_id` links each dropdown label to an engineer; an unmapped label keeps the item on Triage and raises a task for Hope. Migration `sync_triage_engineer_pick.sql`.
- **Estimator refinements (Oct 16):** a current Estimator who is one of the item's engineers is kept, and only removing the engineer in monday clears Salesforce.

### 2026-10-15 — Sync: Triage moves (R4–R7), Estimator writeback, Win/Loss Notes
- **Triage moves (Seth).** New **Bid Decision** status column on the Triage board only (fixed id `bid_decision`; 1 = Bid, 2 = No-Bid). R4 = Hope drags Triage → Bid/No-Bid. R5 No-Bid → the engine moves the item to the Pre-Sales Summary's Declined to Bid with that status (Salesforce untouched). R6 Bid → native monday automation to New Assignment. R7 Bid + an engineer → the engine moves it to the Pre-Sales Summary's New Requests. The decision is kept in `event_log` (field `triage.bid_decision`) because the column drops off at the move.
- **Estimator writeback (Seth).** A Pre-Sales Engineer change in monday writes the AV line's `OpportunityLineItem.Estimator__c` (first person in the column, unless Salesforce already holds one of the item's engineers; ignored people skipped; follows monday while the deal is open, but only an engineer removal clears it; Won / Lost / Declined items untouched). The org's existing "Estimator Assignment Alert" flow keeps emailing the estimator; the engine also emails the opportunity's Sales Rep through Salesforce's standard Send Email action. `map_estimator` maps monday users to Salesforce users by name; unknown engineers become one grouped task for Hope, retried hourly. First pass over existing values (open deals, overwrite differences, no rep emails) via `engine.ps1 estimator-preview` / `estimator-first-pass`. Integration permission set needs Estimator Edit + Send Email. Settings `estimator_writeback` (production off until the switch) and `estimator_rep_email`.
- **Won while on an intake board** stays a task for Hope; it now also closes when Salesforce stops saying Won.
- **Win/Loss Notes** created on the three sandbox boards through the API with the fixed id `win_loss_notes`, so notes written on an intake board survive the move to the Pre-Sales Summary.
- Migration `sync_triage_and_estimator.sql` (both schemas). Code in `sync-engine/src/assign/`; 13 new tests. All paths verified on staging with sandbox test opportunities.

### 2026-10-14 — Sync: staging live; intake boards (Pre-Qualification + Triage)
- **Staging live** on the monday sandbox board + Salesforce `partial` sandbox. Salesforce Flows built and tested (edit, product add/delete, non-admin user); writeback + GM% units verified (35 → 35.00%). Production prerequisites found: integration user needs **Edit Opportunity Product Sales Price**; every Opportunity-editor profile needs principal access to the `AVSS_ProjectTools` credential (setup guide A3, C3.4).
- **New intake flow (Seth + Lee).** New AV opportunities start on two new private boards in the "Pre-Qualification" workspace, duplicated from the Pre-Sales board (same column + label ids, group ids reused with different meanings): **Pre-Qualification** (Lead / Qualified Opportunity groups) and **Triage** (Triage → Bid/No-Bid → New Assignment). The engine creates there (still only with an AV product), moves items on stage changes (R3, EC1, Lead ↔ Qualified), moves early losses to the Pre-Sales board's Lost / Declined to Bid, raises the EC2 task (estimate due date while pre-engineering), and follows items across all three boards. No-Bid in monday never writes to Salesforce. Migration `sync_intake_boards.sql`; `create_items` setting is the creation off switch.

### 2026-10-13 — Sync first pass: skip closed groups, keep monday's Due Date when the day differs
- **Diff report reviewed.** 602 differences on 392 linked sandbox items; 24 sampled rows matched production Salesforce exactly, so the drift is real, not a stale sandbox. Quote #, Sales Person and BU: Salesforce is right (typos, old `INSTR-` numbers, "House"). Due Date: monday is usually about a week **later** than `Estimate_Due_Date_Time__c`, and no other Opportunity date field matches.
- **Decision (Seth): the first pass over a linked item in Won / Lost / Declined to Bid writes nothing** (410 of the 602 changes). The baseline still records Salesforce's values, so later edits sync.
- **Decision (Seth): the first pass keeps monday's Due Date when the ET day differs.** Those items join one grouped review task (`sync_failure:due_date_differs:…`, members listed with both dates), which they leave once the dates agree or Salesforce changes the date. Same-day and blank dates still write. Marker `review:due_date` in the baseline. The diff report notes both rules. Planner cases 37–38.

### 2026-10-12 — Sync engine on staging; 99%/100% = Confirmed to Win; grouped failure tasks
- **Staging live (dry run).** `instrata-sync-engine-staging` on Fly (one machine, `sync_sandbox` schema, Salesforce `partial` sandbox via the "AVSS Project Tools" External Client App, monday sandbox board `18435017528`). First sweep reconciled 92 sandbox opportunities with no errors. Secrets are set with `sync-engine/scripts/set-secrets.ps1`, which reads from the clipboard (Windows PowerShell 5.1 adds a BOM to piped stdin, which broke `fly secrets import`).
- **Decision (Seth): Win % 99% and 100% both mean Confirmed to Win.** The sync sets status Won and writes no Win % label; there is no "99%" label in monday. Driven by `config_settings.confirmed_win_pcts`.
- **Decision (Seth): one failure task per missing value**, not per opportunity. Tasks keep a member list (`source_ref.members`), render "Opportunities to check" in the details, and close when the last member syncs.
- **monday labels:** 13 reps (found by comparing production Salesforce reps on AV opportunities against monday) added to the Sales Person dropdown on both pre-sales boards, ids 67–79, existing labels untouched. Mapped by `sync_confirmed_win_and_new_reps.sql`, which also updates both schemas.
- **monday API:** `settings_str` is gone in current versions (use `settings`). Edge functions still pin the unsupported `2024-10`; flagged as a separate task.

### 2026-10-11 — Salesforce ↔ monday sync + Hope's Queue: schema + reconcile planner
First slice of `Product Spec/project-tools-sync-and-queue-spec.md` (plan: `Product Spec/sync-and-queue-implementation-plan.md`). Nothing talks to Salesforce or monday yet.

- **Schema — `add_sync_and_queue.sql` (applied to production `public` 2026-10-11).** Config layer, mapping tables, `sf_link`, `task`, `webhook_inbox`, append-only `event_log`, watermarks, cleanliness snapshots, dry-run reports; `profiles.is_ops_coordinator` + `is_sync_viewer()`; the `sync_engine` login role (password set manually). Schema-parameterised so the same file builds `sync_sandbox` for the staging engine. Seeds use label IDs read from the live Pre-Sales board. The SQL Editor's "RLS not enabled" warning is a false positive — RLS is enabled in a `DO` loop the static check can't see (verified: 18/18 tables). See §3.
- **`sync-engine/` package** (Node/TS, separate Fly app to come). Source imports use `.ts` extensions (`rewriteRelativeImportExtensions`) so pure modules run directly under Node type stripping.
- **Reconcile planner** (`src/reconcile/plan.ts`) — all of spec §4 as a pure function; `scripts/verify-sync-reconcile.mts` (31 cases, each re-run for idempotency; mutation-tested).
- **Design notes recorded in the plan:** dry run uses its own baseline (`dry_run_synced_values`) so it never advances the live one; the backfill must seed `sf.stage` so historical stage actions don't replay; mapping edits trigger re-reconciles of affected opportunities.

### 2026-09-21 — Project Wiki scaffold: per-project knowledge base, in-app editing, MCP read/write tools
First cut of the wiki described in `Product Spec/project-tools-wiki-spec.md`, built so knowledge-base accumulation and MCP question-answering can be tested before the AVSS bid pipeline and notes-aggregation skills write into it. Everything the spec's data model calls for is in place; the §8 open items (markdown round-trip, re-run reconciliation policy, review isolation of `validation_notes`, wiki-specific permissions) are deliberately left open.

- **Schema — `add_project_wiki.sql` (run in the SQL Editor before deploying).** `project_wiki`, `wiki_rooms` (status + headline NOT NULL = the index guarantee; partial UNIQUE on `(project_id, dtools_location)`), `wiki_decisions`, `wiki_questions`, `wiki_labor` (UNIQUE per room + bucket; `0.00` is stored), `wiki_room_bom_lines`, `wiki_room_files`. Text + CHECK instead of Postgres enums; child `project_id` synced from the room by trigger; weighted generated `tsvector` columns + GIN; `wiki_room_index` view (security_invoker) and `search_project_wiki()` RPC (SECURITY INVOKER, `websearch_to_tsquery`, `ts_headline` snippets). RLS = open read / member-gated writes, same as every other project child table. See §3 Project Wiki.
- **App.** `/projects/:id/wiki` (`ProjectWiki.tsx`, persistent sidebar entry under Overview, `WikiSummaryCard` on the Overview). Context card, needs-your-input card, search card, room index with filters, and a full room editor (`components/wiki/WikiRoomDetail.tsx`) for headline/status, details, markdown notes, decisions, questions (raise → escalated; answer + decision → resolved), labor buckets, BoM-line and file links. One-file markdown snapshot export. Data layer `lib/projectWiki.ts` (on-demand, not in the store); vocabulary duplicated in `wikiTools.ts` — keep in sync. Human edits to agent rows flip `origin` to `agent_human_edited`.
- **MCP.** `src/wikiTools.ts`: 6 read tools (`get_project_wiki`, `list_project_rooms`, `get_project_room`, `list_room_decisions`, `list_project_questions`, `search_project_wiki`) and 9 write tools (`upsert_project_wiki`, `upsert_project_room`, `set_room_status`, `append_room_decision`, `set_room_labor`, `raise_room_question`, `answer_room_question`, `link_room_bom_lines`, `link_room_files`), all under the existing `mcp:read` / `mcp:write` scopes (consent copy updated; no new scope was added, so already-connected clients see the new tools without re-consenting). `upsert_project_room` is select-then-insert/update because PostgREST can't infer a partial unique index for `ON CONFLICT`. Server refuses to boot if any tool lacks a scope, as before. Deploy: push to `main` touching `mcp-server/**`.
- **Not verified live:** the migration has not been applied to the production database in this session, and the MCP tools have not been exercised against real data yet — both are the next step.

### 2026-09-18 — Submittal builder: owner-furnished (OFE) gear now flagged per line on the printed BoM
Follow-up to the room-merge fix below, same project. On Nasdaq DC the Samsung displays and Logitech Rally kit are **owner-furnished in some rooms and Instrata-supplied in others**; DTools carries that as `IsOfe` per item and the sync already lands it on `project_bom_items.owner_furnished` (verified: every `$0` duplicate row is `owner_furnished=true`, its priced twin `false`). Populate-from-BoM was merging the OFE and non-OFE copies into one submittal line, so the flag never reached the submittal or the PDF.

- **Populate keeps OFE and non-OFE copies as separate line items.** Dedupe key is now manufacturer + model + owner-furnished (`submittalDedupKey` in `utils/submittalExclusions.ts`; MCP twin `dedupKey` in `submittalTools.ts`). Rows that differ only by unit cost still merge (qty summed, rooms merged via `mergeLocations`); an OFE copy becomes its own item carrying its own rooms. Nasdaq DC: 62 → 70 line items, 15 of them OFE, 0 rooms missing.
- **New column `submittal_items.owner_furnished`** (`add_submittal_item_owner_furnished.sql`, boolean default false — **run in the SQL Editor before deploying**; PostgREST rejects inserts naming an unknown column). `SubmittalItem.ownerFurnished` in `types.ts`; store row mappers read/write it; populate sets it.
- **Where it shows.** `SubmittalDetail` items table: purple **OFE** badge beside the model (same styling as the BoM-by-location view). **Submittal PDF** "Bill of Materials by Room": new right-hand **OFE** column (widths rebalanced to 115/130/170/40/45 of 504), "OFE = Owner Furnished Equipment" legend in the section header when any line is flagged, and room subtotals read `… total qty (N OFE)`. Within a room the same model can now appear twice — once supplied by Instrata, once by the owner — which is the intended "different listing".
- **Cutsheets print once per model.** The OFE and non-OFE items both get the same repository cutsheet from auto-attach; the PDF's TOC + cutsheet section dedupe by manufacturer+model so the package doesn't embed the same PDF twice.
- **Purchasing lookup.** `PurchasingDetail`'s vendor / sold-in-price lookup now keys `manufacturer|model|ofe` with a plain-key fallback that prefers the priced (non-OFE) BoM row, so an OFE line resolves to its `$0` row and older single-line items never pick up the `$0` copy by accident.
- **MCP.** `populate_submittal_from_bom` selects/consolidates/inserts `owner_furnished`; `list_submittals` (`include_items`) returns it per item.
- **Not changed.** The DTools transform's `Manufacturer||Model||UnitCost` grouping — OFE rows already split naturally at `$0`, and the Gross Margin math depends on that key. Existing submittals need a re-pull from BoM to pick up the split + flag.

### 2026-09-18 — Submittal builder: BoM-by-Room dropped rooms when a part was split across BoM rows
Reported on **Nasdaq DC (26-MA-0463)**: the Samsung QB55C sits in Office 303 on the project BoM, but the printed submittal's "Bill of Materials by Room" section only listed it under the two huddle rooms. The PDF was faithful to the saved submittal items — the rooms were lost earlier, at populate time.

- **Root cause.** The DTools transform (`dtools-project-lookup/transform.ts`) groups product rows by `Manufacturer||Model||UnitCost`, so a part priced two ways in DTools (here a `$0` copy alongside the `$730` row — the pattern on every affected model, i.e. OFE / change-order duplicates) lands as **two `project_bom_items` rows, each with its own `locations` list**. `populateSubmittalFromBoM` then dedupes by manufacturer+model and summed `qty` correctly (11) but kept only the **first row's** `locations` (the two huddles), silently discarding the second row's nine offices. Nasdaq DC had 8 customer-facing models split this way and 69 room entries missing from the printed BoM.
- **Fix (both populate entry points).** New `mergeLocations()` in `app/src/utils/submittalExclusions.ts` combines per-room lists, summing `qty` where the same room appears in both. `store.populateSubmittalFromBoM` (app) and the MCP `populate_submittal_from_bom` tool (`mcp-server/src/submittalTools.ts`, which carries a local twin of the helper) both merge rooms when consolidating duplicate rows, and carry a cutsheet forward if only a later row had one. Verified read-only against the live Nasdaq DC BoM: QB55C → 11 rooms, 0 models missing rooms. The transform's unit-cost grouping is **intentionally unchanged** — the Gross Margin math depends on it.
- **Data note.** The fix is forward-looking: submittals populated before it still carry the truncated room lists in `submittal_items.locations` until re-pulled from the BoM (which replaces all items and re-runs repository auto-attach; manual per-item cutsheet uploads would need re-uploading). Nasdaq DC's "AV Submittals" (Rev 0, Draft) needs that re-pull. MCP server needs a redeploy to pick up its half.

### 2026-09-17 — MCP server: OAuth 2.1 replaces placeholder token auth
The placeholder MCP auth (a personal token pasted as a header, or embedded in the URL as `?key=` / `/mcp/<token>`) stopped working with claude.ai custom connectors, which only offer OAuth or no-auth and start OAuth discovery on the first 401. `mcp-server` is now its own OAuth 2.1 authorization server. Spec `Product Spec/project-tools-mcp-auth-spec.md`; design + status `Product Spec/project-tools-mcp-auth-implementation-plan.md`; §8 rewritten.

- **Flow.** 401 on `/mcp` with `WWW-Authenticate: resource_metadata=…` → RFC 9728 / 8414 discovery at the same origin → client registration (DCR at `/oauth/register`; CIMD for Claude Code; or an env-configured admin client for claude.ai Advanced settings) → `/oauth/authorize` renders the server's **own login + consent page** (Project Tools email/password verified against Supabase Auth; scopes and redirect host shown, loopback warning) → `POST /oauth/consent` issues a one-time code → `/oauth/token` (PKCE S256 required, form-urlencoded, Basic or body client auth) → opaque access token 1 h + refresh token 30 d. Refresh tokens rotate; replaying a rotated one revokes the family. `/oauth/revoke` per RFC 7009. Redirect URIs allowlisted to the claude.ai callback + loopback `/callback` (any port). No redirects on any path.
- **Built on the SDK.** `@modelcontextprotocol/sdk` bumped 1.29 → 1.30; its `server/auth` handlers (authorize/token/register/revoke/metadata, `requireBearerAuth`) do the protocol work. `mcp-server/src/oauth/` (`provider`, `clients`, `store`, `consent`, `metadata`, `scopes`, `tokens`) supplies the Supabase-backed provider and our page. Metadata documents are hand-built because the SDK router can't emit `/oauth/*` paths, a root-level PRM, or `client_id_metadata_document_supported`.
- **Storage + access model — `add_oauth_server.sql` (applied).** Four hash-only tables (`oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens`, `oauth_access_tokens`) owned by a new PostgREST role **`mcp_service`** (nologin, granted to `authenticator`); the server mints that role's JWT with the legacy secret, so only it can read/write OAuth state — no service-role key, and no `authenticated`-callable token RPCs an app user could abuse. Atomic RPCs `oauth_consume_auth_code`, `oauth_rotate_refresh_token` (rotation + reuse detection in one transaction), `oauth_revoke_family`; `oauth_disconnect` for the app; `oauth_cleanup()` scheduled nightly via `pg_cron` (`oauth-cleanup-nightly`, extension enabled same day). Supabase's default table grants to anon/authenticated are explicitly revoked. Verified through PostgREST with `scripts/verify-mcp-service-role.mts` (200 as `mcp_service`, 403 as `authenticated`, 401 as `anon`).
- **Scopes gate tools.** `mcp:read` (13 read tools), `mcp:write` (5 submittal write tools), `offline_access`. `toolHelpers.scopedRegistrar` registers-then-disables tools the token lacks, so `tools/list` reflects the grant; startup asserts every tool has a scope in `src/oauth/scopes.ts`. Tool bodies unchanged.
- **Removed.** `resolveToken`, the `?key=` and `/mcp/:key` routes, the Settings "Connect Claude" token card. New **Settings → Connected apps** card lists the user's grants (client, read-only vs read & write, connected / last used) with Disconnect / Disconnect all. `drop_mcp_tokens.sql` (table + `create_mcp_token` / `resolve_mcp_token`) to run after production cutover.
- **Config.** New required `PUBLIC_BASE_URL` (issuer; server won't boot without it), optional `OAUTH_ADMIN_CLIENT_ID` / `_SECRET`, TTL overrides. `deploy-mcp.yml` deploys on merge, so secrets go in first.
- **Verified locally against production Supabase:** spec acceptance A + D (37 probes), and the full token lifecycle via `scripts/oauth-smoke.mts` (code exchange, replay → `invalid_grant`, `tools/list` = 18 tools, refresh rotation, family revocation on reuse, scope narrowing/widening, read-only grant hides write tools, revoke).
- **Production cutover, same day** (`0396e02` → `19180dd`, single hard cutover, no preview app — one active user). Acceptance A + D re-run clean against `instrata-project-tools-mcp.fly.dev`. The first real claude.ai Connect then surfaced **three bugs no curl test could see**, each fixed and redeployed within the hour:
  1. **`invalid_client` on Connect** (`52b07ec`). claude.ai doesn't use DCR when CIMD is advertised — it sends `client_id=https://claude.ai/oauth/mcp-oauth-client-metadata`, and our fetch of that document got **HTTP 403 from Fly's egress** (200 from a laptop; edge bot protection). Fix: pinned copies of both Anthropic documents (`KNOWN_CIMD_CLIENTS`) used when the live fetch fails; safe because their redirect URIs are exactly our allowlist. Pinned/live cache both 1 h — each failed live attempt was costing ~2 s on the token endpoint.
  2. **No visibility into the flow** (`0d3a3a9`). SDK token errors are returned as JSON, not logged. Added an access log for `/oauth/*`, `/mcp`, `/.well-known/*` (status, ms, grant, client id, redirect host, OAuth error code; never tokens/codes/passwords, email → domain only). Also RFC 9207 `iss` on authorization responses.
  3. **Sign-in "spun and stayed on the page"** (`19180dd`). Codes were being issued but claude.ai never called `/oauth/token`: the consent page's CSP said `form-action 'self'`, and **Chrome applies `form-action` to the 302 after a form POST**, silently blocking the hop to `claude.ai/api/mcp/auth_callback`. Fix: `form-action 'self' https://claude.ai http://localhost:* http://127.0.0.1:*`.
- **Result (test C3 passed):** claude.ai Enterprise connector added with URL only → Connect → consent → connected; a fresh chat lists all 18 tools incl. the write tools; DB shows the code consumed, one access + one refresh token, `/mcp` calls from `Claude-User` succeeding. Still to run: C1 Inspector, C2 Claude Code (CIMD + loopback path), C4 admin pre-registered client (not configured yet); `drop_mcp_tokens.sql`.

### 2026-07-14 — Export BoM to Excel (branded, from the Project Quote)
An **Export BoM** button in the Project Quote header rebuilds the two-tab, Instrata-branded workbook the Claude cowork skill produced, straight from the already-ingested BoM. Commit `b72425f`.

- **`utils/exportBoMExcel.ts` (new) — built with ExcelJS, not the bundled SheetJS.** The app's `xlsx` is the SheetJS *community* build, which can't write cell styling (fills/fonts/bold are Pro-only) — that's why the first cut came out unstyled. Switched the writer to **ExcelJS** (added to `app/package.json`) and lifted the palette + layout verbatim from the reference file's `styles.xml`: navy `#1B3A5C` title + column-header band with white text, orange `#E8872B` brand bar + section-header text, light-blue `#D6E0EA` section fill, gray `#333333` bordered data rows, Arial throughout; section headers merged A:G, Unit Cost as `$#,##0.00`.
- **Two tabs.** *BoM by Manufacturer* (Manufacturer, Model, Quantity, Vendor, Unit Cost, CO Number, CO Type — grouped by mfr; Vendor parsed from `pricedFrom`) and *BoM by Location* (Manufacturer, Model, Quantity, Labor Type, Unit Labor Hours, CO Number, CO Type — grouped by room).
- **CO attribution is double-count-safe.** The ingested `ProjectBoMItem` carries no per-item CO tag, so contract lines all read `Base Bid`; only the *ghost* CO lines (pending + approved-not-yet-republished — the same set the Quote card flags "not in contract") are appended, tagged with `co.number` + Internal/External. Approved+merged COs stay under Base Bid so their items aren't counted twice.
- **Labor rows on the by-Location tab.** DTools quantifies time-based labor in *hours* (a labor line's `Quantity` field == its hours, so our synced rows carry `qty == laborHours`) — those now render as **QTY 1** with the hours in the Unit Labor Hours column, matching the reference; expense-type labor (Airfare, S&H, Premiere Protect: zero hours) keeps its real count in QTY with blank hours (`laborQtyHours` helper). Fixes a bug where labor QTY mirrored the hours (e.g. QTY 3.09).
- **Delivery.** Downloads client-side and auto-files a timestamped copy into Project Files (`general` / `doc_type='bom'`) via a new generic `fileGeneratedFile` in `lib/projectFiles.ts` (mime-aware sibling of `fileGeneratedPdf`).
- **Project Quote header layout.** DTools Project Total is pinned left and made more prominent (divider + larger figure); the action buttons stay grouped on the right (`ml-auto`) so adding Export didn't shove the row around.
- **Build gotcha caught pre-merge.** `exceljs` had initially been installed into the *repo-root* `package.json`; the local build only worked because Node walks up to root `node_modules`, but the Dockerfile runs `npm ci` against `app/package*.json` — so it's now a dependency of `app/` (root change reverted).

### 2026-07-06 — Project Files (SharePoint-backed repository, Files tab live)
The Files tab on the Project Log card is real: a per-project document repository where **SharePoint holds the bytes and Supabase holds the index**. Full design in `Product Spec/04-project-files.md`; commits `c9fdb50`, `97097ab`.

- **Storage model.** New company-browsable SharePoint site `/sites/ProjectFiles` (library "Project Files"), one folder per project `{number} - {name}/` with standard category subfolders, created lazily on first use. Anyone at the company can work in it natively (Explorer/Teams); the app's `project_files` index (new migration `add_project_files.sql`, applied 2026-07-06) is what the UI and MCP browse. A **reconcile-on-view** `sync` op keeps the two honest — files added or deleted directly in SharePoint show up/disappear on the next Files-tab open (verified both directions in production).
- **Edge function `sharepoint-project-files`** — cloned from the `sharepoint-cutsheet` pattern (app-only Graph, op dispatcher, in-code auth): `bootstrap` / `ensureProjectFolder` / `upload` / `getDownloadUrl` / `delete` / `sync`. Bootstrapped against the ProjectFiles site same day; `SHAREPOINT_PROJECTS_SITE_ID` + `SHAREPOINT_PROJECTS_DRIVE_ID` set as function secrets. Uploads stage through a new private `project-files-temp` bucket (100 MB) to bypass the function body-size limit.
- **Files tab UI** (`FilesTab` in `ProjectLog.tsx` + `lib/projectFiles.ts`): category-grouped list, multi-upload with category picker, download via fresh ~1h Graph URLs, open-in-SharePoint links (per file + project folder in the card header), delete with confirm, live tab count, background reconcile throttled to 5 min/project/session.
- **Auto-filing of generated docs.** All non-financial PDF exports (submittal package, RFI, RFI log, closeout, sign-off, warranty, punch list, manuals) now also file a timestamped copy into the project's SharePoint folder under the right category (`source='generated'`, typed `doc_type`) — fire-and-forget so a filing failure never blocks the user's download. **Gross margin is deliberately excluded**: the site is company-browsable, financials stay download-only.
- **MCP tools `list_project_files` / `get_project_file`.** The Fly MCP server exposes the repository to Claude clients; download URLs are minted by calling the edge function with the caller's per-user JWT, so the server continues to hold no Graph credentials and no service-role key. Redeployed + verified end-to-end (token → list → URL → bytes).
- `config.toml` pins `sharepoint-project-files` to `verify_jwt = true` alongside the other authenticated functions.

### 2026-07-05 — Pre-rollout security hardening pass (2026-07-02 → 07-05)
A full security audit ahead of the team-wide rollout, then fixes for every critical/high finding (all deployed + verified in production) plus low-severity cleanups. The root theme: several Edge Functions ran with the service-role key (RLS bypassed) but did **no in-code authorization**, and because the public anon key is itself a valid JWT, they were reachable by anyone on the internet.

- **Privilege escalation (CRITICAL) — `fix_profile_role_escalation.sql`.** Any authenticated user could `update profiles set role='admin' where id=auth.uid()` — the self-update policy had no `WITH CHECK` and RLS can't compare OLD/NEW. Added a `BEFORE UPDATE` trigger (`enforce_profile_role_immutable`) blocking non-admin end-user sessions from changing their own `role`; admins and trusted backend contexts (`auth.uid()` null) are exempt.
- **D-Tools functions (CRITICAL) — auth added.** `dtools-list-projects`, `dtools-import-project`, `dtools-project-lookup` now require a real authenticated user (reject the anon key). `dtools-import-project` takes `created_by` from the verified JWT instead of a spoofable body field; `dtools-project-lookup` requires project membership/admin (or the internal service-role call from the import chain), closing the arbitrary-UUID BoM/financials overwrite.
- **`dtools-probe` DELETED (HIGH).** The temporary open D-Tools API proxy was removed entirely (both the local folder and the deployed function via `supabase functions delete`).
- **`monday-webhook` forgery (CRITICAL) — shared secret.** The webhook did no signature verification. Added a `MONDAY_WEBHOOK_SECRET` shared-secret gate (constant-time compare, via `?token=` query param or `x-webhook-secret` header) checked before the challenge handshake; fails closed if unset. The secret is appended to the webhook URL configured in Monday.
- **`verify_jwt` config gap (HIGH) — `supabase/config.toml` added.** Without it, `functions deploy` defaults every function to `verify_jwt=true`, which silently broke `monday-webhook` at the gateway (Monday sends no Supabase JWT) mid-pass. `config.toml` now pins `monday-webhook` + `ms-graph-auth` to `false` and the other eight to `true`, so deploys are repeatable.
- **`sharepoint-cutsheet` (CRITICAL) — auth + admin gate.** Every op now requires an authenticated user; the destructive/review ops (`bootstrap`, `listStaging`, `approveStaging`, `rejectStaging`, `markStagingDuplicate`) require `role='admin'`; `uploadedByUserId`/`reviewedByUserId` come from the verified JWT.
- **INSERT-side RLS gaps (MED) — `fix_rls_with_check_gaps.sql`.** `review_runs`/`review_flags` INSERT policies were `with check (true)` (any user could fabricate runs/flags) — restricted to admin (the reviewer writes via service role, which bypasses RLS). Added explicit `WITH CHECK` to the `ms_graph_tokens`/`personal_ops_email_flags` for-all policies (Postgres was reusing `USING`, but now it's unambiguous).
- **OAuth state signing (MED) — `ms-graph-auth`.** The `state` was unsigned base64 and the callback trusted its `userId`, allowing token mis-binding. Now HMAC-SHA256 signed (key: `MS_GRAPH_STATE_SECRET`, falls back to `MS_GRAPH_CLIENT_SECRET`) with a 15-min expiry, verified on callback.
- **`xlsx` dependency (HIGH) — patched.** Moved off the abandoned npm `xlsx@0.18.5` (unpatched Prototype Pollution + ReDoS, parses user-uploaded spreadsheets) to the official SheetJS CDN build `0.20.3`. API-identical; build passes, `npm audit` no longer flags xlsx.
- **`resolve_mcp_token` off `anon` (HIGH) — `revoke_resolve_mcp_token_anon.sql` + `mcp-server/src/auth.ts`.** The SECURITY DEFINER RPC was executable by `anon`. The MCP server now mints a short-lived `authenticated` JWT (`mintServiceJwt`) to call it, and the grant is revoked from `PUBLIC` + `anon` (Postgres grants EXECUTE to PUBLIC by default, so revoking from anon alone wasn't enough), re-granted to `authenticated` only.
- **Low-severity hardening — `fix_low_severity_hardening.sql`.** Enabled RLS on `project_code_counters` (no policy — functions only); made `generate_project_code` + `seed_project_code_counter` SECURITY DEFINER with pinned `search_path`; pinned `search_path` on `is_project_member`. Untracked `supabase/.temp` (CLI scratch: project ref, pooler host) and added it to `.gitignore`.
- **Still open (deferred, non-blocking for a trusted internal team):** `monday-manager-dashboard` has no server-side role check + a `debugNameQuery` data-leak path; `bug-screenshots` is a public Storage bucket. **Design decision to confirm:** every authenticated user can read all projects and self-add to any project (the intended org-wide model — safe now that admin escalation is closed).

### 2026-06-25
- **Project Documentation — Gross Margin Form.** New extensible "Project Documentation" card at the bottom of Project Overview (below the Project Quote). Until a project is synced with DTools it shows a "sync with DTools first" note; once synced it lists the report series — Phase 1 ships the **Gross Margin Form** that accounting uses to open a project.
  - **Auto-fill from the synced BoM.** `app/src/utils/grossMargin.ts` (pure, regression-tested by `scripts/verify-gm-form.mts`) collapses labor into Install (`Cabling/Install/Finish/Mobilization`), Programming (`Bench/Commissioning/Programming/Training/Engineering`) and Travel buckets. **Subcontractor / Equipment Rental / Permits** are matched by exact DTools `Model` and reclassified into Equipment even though DTools carries them as fixed-cost *labor* with a real labor type (e.g. `Install`) — model-match overrides labor-type bucketing, the gotcha that previously distorted these forms. An absent special line counts as `$0`. **Premiere Protect** is carved out of Labor/Equipment/PROJECT TOTALS into a Job Information callout. PROJECT TOTALS = DTools root − Premiere Protect, anchored to the transform's verified equipment/labor split so the headline ties to the penny; a review banner appears if it drifts >$1 (e.g. when the underlying sync itself didn't reconcile).
  - **Edit + match-the-quote.** View/Edit toggle; every number and header/custom field is editable. Only the deltas from the synced defaults persist (`project_documents.overrides`, flat dotted paths), so a re-sync refreshes the underlying numbers while keeping accounting's nudges. Per-field and global reset-to-synced, an orange dot marks edited fields, and derived totals reflow as line items change. Edit gated to project members.
  - **Branded PDF.** `exportGrossMarginPDF.ts` prints an Instrata-branded GM form (mirrors the warranty/closeout exporters) with a "figures edited" footnote when values were overridden.
  - **Plumbing.** `add_project_documents.sql` adds the `project_documents` table (overrides-only, RLS mirrors the project model) + `projects.dtools_gm_meta`. `extractGmMeta()` in the DTools transform captures header/custom/tax-split metadata each sync (field map verified against real `ChathamCounty.json` + `TestProject.json` payloads — tax split comes straight from `Taxes[].ProductTotal`/`.LaborTotal`). The four special-line `Model` strings are admin-editable in Settings → *GM Form Special Lines* (`review_config` `gm_model_*` keys via `lib/gmSettings.ts`), seeded with `Subcontractor` / `Equipment Rental` / `Permits` / `Premiere Protect`.
  - **PDF polish (same day).** Header now uses `instrata-logo-white.png` (the navy-text color logo was invisible on the navy band); Premiere Protect moved to its own full-width row so the dollar value no longer overlaps the label.
  - **Labor-hours accuracy (same day, verified on Arizona Country Club 25-SW-0450).** Two fixes so the form's hours tie to DTools:
    - *Adjusted-hours display.* Product attached-labor buckets now sum DTools' adjusted `TotalHours` (the displayed number, e.g. Cabling 104→107.12) instead of raw hours; cost/price stay on raw hours (the pricing basis). Located labor rows already carried adjusted hours via `qty`. `lt.TotalHours` is the LINE-total adjusted hours (already includes qty); `lt.Hours` is per-unit raw.
    - *Hybrid fixed-labor line guard (transform).* A companion labor line is treated as hour-priced ONLY when its `Quantity` equals its attached adjusted hours. A fixed/unit lump that also carries labor metadata — e.g. an Equipment Rental entered as `1 unit @ $1,800` with 4 attached Install hours — was read as "1 hr @ $1,800/hr", losing the real hours and inventing a bogus rate; it's now stored as a fixed line (its hours echo the companion hourly line, counted once). **Dollar-neutral** — line totals unchanged, sync still VERIFIED. Arizona's Install bucket reads 314.42 hrs = DTools' 318.5275 minus the 4.12 rental hours intentionally carved out of labor. Added Arizona as a third `verify-gm-form.mts` fixture.

### 2026-06-24
- **Submittal PDF export — fixed a hard crash on non-WinAnsi characters.** The "Export PDF" button on a submittal silently did nothing when an item field contained a typographic Unicode glyph pdf-lib's Helvetica can't encode — the reported case was the **non-breaking hyphen (U+2011)** pasted in from Word/web inside a model number (e.g. `DM‑NVX‑363`), which threw `WinAnsi cannot encode "‑" (0x2011)` on the first `drawText`/`widthOfTextAtSize`. The original narrow `sanitize()` (see 2026-04-28) only stripped ASCII control chars, so typographic glyphs slipped through. `sanitize()` now maps the common offenders (hyphens/dashes, smart quotes, primes `′ ″`, `×`, bullets, ellipsis, non-breaking/zero-width spaces) to ASCII look-alikes and drops anything still outside the WinAnsi-safe band (printable ASCII + Latin-1, so accented text like `café` survives). Status change was a red herring — the export never reads `submittal.status`.
- **PDF exporters — shared the hardened sanitizer.** Extracted the hardened logic into `app/src/utils/pdfText.ts` (`sanitizePdfText`) and reused it across **all six** exporters — submittal, RFI, closeout, punch list, sign-off, and manuals. The other five each had their own naive copy and were vulnerable to the same crash; the **manuals** exporter had no sanitizer at all and now cleans the project name and bookmark titles (which come straight from the embedded PDF). The file must stay UTF-8 for its literal-codepoint character classes to match.
- **PDF export failures now surface to the user.** `SubmittalDetail`'s export handler only `console.error`'d on failure (button appeared to do nothing); the two RFI exports in `RFIList` were fire-and-forget with no `catch`. All now `alert()` on failure, matching the existing closeout export buttons.
- **Submittal items no longer inherit BoM notes on import.** `populateSubmittalFromBoM` was copying `project_bom_items.notes` onto new submittal items, but that field is written by the DTools sync with internal estimating metadata (e.g. `"Phase: Install"`) that was bleeding onto client-facing submittals. New items now start with **blank notes**; users add their own per item. (Forward-looking — submittals built before this still carry the old notes until cleared or re-imported.)
- **Submittal PDF — item notes now render.** The "Bill of Materials by Room" section draws each item's notes word-wrapped and indented beneath its row (italic, gray, `Note:` prefix, per-line page-break handling) via a new `wrapText` helper. Previously typed notes never appeared anywhere in the export.
- **Closeout — standalone Warranties PDF.** New `app/src/utils/exportWarrantyPDF.ts` + an "Export Warranty PDF" button on the closeout Warranties tab, so the warranty list can be printed on its own without the full closeout package. Branded cover matches the punch-list / sign-off exports; the warranty table (Manufacturer / Model / Vendor / Start / Dur. / Expiry / Contact, with computed expiry) is the same layout as the Warranties section in `exportCloseoutPDF`. Button is disabled when there are no warranties and surfaces failures via `alert()`. The Warranties table columns in both the standalone and the closeout-package PDF were split from `System` + `Mfr / Model` into separate `Manufacturer` and `Model` columns. The Start date now renders in the same `Feb 25, 2036` format as Expiry (both via a shared `formatWarrantyDate` helper that parses bare `YYYY-MM-DD` as a *local* date — fixes a UTC-midnight off-by-one that previously showed the day before in US timezones).

### 2026-06-11
- **DTools pricing parity + Change Orders — sync now reproduces DTools quotes to the penny and pulls published COs with line items.** Two sessions of API reverse-engineering (verified against Ak Chin, Brooklyn Canarsie, and Maricopa Dunlap payloads) landed in one feature set:
  - **Pure transform module** (`supabase/functions/dtools-project-lookup/transform.ts`) holding the whole pricing model: equipment `round2(qty×UnitPrice)`, per-product labor `qty × ItemLaborTypes.Hours × phase rate` (accumulated per row — same model can carry different hours), phase-residual labor rows for manually-added hours, fixed-dollar companion labor, and rolled-up-companion ("Airfare echo") detection via overshoot subset-match. Headline equipment/labor split follows DTools' own row convention and matches the DTools UI exactly (e.g. Brooklyn labor $86,120.63).
  - **Two payload flavors handled.** DTools zeroes out phase-row rates after approval/CO publishing (adjusted hours, converted hours dropped). New `projects.dtools_labor_meta` persists rates/factors/raw-hours from priced payloads for reuse; item-`InstallPrice` derivation + an explicit "Labor (unattributed)" anchor line cover the gaps. Live meta for both real projects backfilled from saved fixtures.
  - **Self-verifying syncs.** `projects` now stores the DTools root snapshot (`dtools_cost/_price_without_tax/_tax/_price/_hours/_synced_at`) and `dtools_sync_delta` (derived split + deltas + `verified` flag, $1 tolerance). Live results: Ak Chin Δ −$0.68, Maricopa exact.
  - **Change orders end-to-end.** New `change_order_items` table + CO columns (`cost`, `labor_hours`, `dtools_verified`, `items_synced`). Sync detects CO list rows by non-empty `CONumber` (they carry no `IsChangeOrder` field and reuse the parent's `Id` — two latent bugs fixed), fetches `?id={parentId}&coNumber={n}`, decodes `COChangeTypeId` (1=Added, 2=Removed with negated prices/hours), prices labor at parent rates, and verifies each CO against its own root totals. Verified live: AVCO-1 (Ak Chin +$4,092.12) and AVCO-4 (Maricopa −$7,384.43, 1 add + 4 removals).
  - **BoM UI rollups.** Project Quote table gains Unit Price / Ext. Price / Labor columns, per-location subtotals, a "Project Labor" bucket for phase-residual hours, and an Equipment/Labor/Tax/Total footer with Cost + GP% columns anchored to the DTools root total, with a "Reconciled with DTools quote" badge. CO rows expand to show signed line items (Added green / Removed red).
  - **Offline verification harness** (`scripts/verify-dtools-sync.mts`, Node 24 type-stripping): replays the exact production transform against saved payloads in `Reference/` (untracked — customer pricing) across 6 scenarios; run after any transform change. `scripts/backfill-labor-meta.mts` regenerates labor-meta UPDATEs from fixtures.
  - **Temporary `dtools-probe` function** deployed for API exploration — read-only proxy, flagged in §9 for deletion.
  - **Migrations run (in order):** `add_dtools_pricing_parity.sql`, `add_change_order_items.sql`, `add_dtools_labor_meta.sql` (all applied to live via `supabase db query --linked`).
  - **DTools operational notes:** COs only become addressable via the API after their status transition fires the tenant's "send CO to API" setting — unapprove/re-approve once to backfill old COs. CO numbering: `AVCO-n` = External, `AVCOI-n` = Internal. Approved-but-unpublished COs surface inside the project payload only as `TypeId=5` placeholder lumps + a "Change Order - Install" phase.

### 2026-06-05
- **Submittal PDF** — Table of Contents now paginates instead of overlapping the footer and getting cut off after page one.
- **Cutsheets / Auth** — Non-members opening a project tool (or editing BoM data) on `ProjectOverview` now get a `JoinProjectModal` to add themselves to the team or continue view-only, instead of having their writes silently fail under RLS. Root cause: `submittal_items`/BoM writes are gated to project members (admins bypass), and the client swallowed the rejected writes.
- **Cutsheets** — `SubmittalDetail` now re-runs repository cutsheet auto-attach when an existing submittal is opened (previously only at populate-from-BoM time), plus a manual "Sync cutsheets from repository" button. Gated to editors so view-only users don't trigger silently-failing writes.

### 2026-06-03
- **MCP server — read-only Claude connector (new `mcp-server/` service).** Standalone Node/TS MCP server (Streamable HTTP, `@modelcontextprotocol/sdk`) deployed as a separate Fly app, letting internal staff connect a Claude client to their project data. See new **§8** for the full design.
  - **Security = RLS reuse.** Per-user opaque tokens (`add_mcp_tokens.sql`: `mcp_tokens` table storing only SHA-256 hashes, plus `create_mcp_token` / `resolve_mcp_token` RPCs). The server resolves a token to a user, mints a short-lived HS256 JWT for them, and queries PostgREST as that user — existing RLS is the only authority. No service-role key; read-only.
  - **9 read-only tools** mirroring `app/src/store/index.ts` queries: projects, BoM, RFIs, submittals, purchasing, milestones, catalog search, vendor-contact search.
  - **Settings → Connect Claude** card (`SettingsPage.tsx`, all signed-in users): generate (shown once), list, and revoke personal tokens; surfaces the server URL + how-to.
  - **Legacy-key dependency (known):** minted JWTs are signed with the project's legacy HS256 secret (dashboard "Previous Key"). Must upgrade this server's auth whenever Supabase keys are rotated / the legacy secret is revoked.
  - **Migration to run:** `add_mcp_tokens.sql`. **Deploy:** separate Fly app `instrata-project-tools-mcp` (see `mcp-server/README.md`).

### 2026-06-02
- **Directory — Vendor Contacts page added; standalone HTML retired.** Folded the standalone `Vendor Contacts.html` (vanilla JS, localStorage-backed, with a mailto "send for approval" queue for non-admins) into the app as a first-class **Directory** feature.
  - **Server-side persistence.** New `vendor_contacts` table (`add_vendor_contacts.sql`): full contact field set (`company`, `company_type` ∈ manufacturer/distributor/rep/other, `rep_for`, `name`, `title`, `email`, `phone`, `website`, `role`, `notes`, `technical`, `active`) plus `created_by` / `created_at` / `updated_at`. **Open RLS** — any authenticated user can SELECT/INSERT/UPDATE/DELETE (no admin gate). Migration seeds ~80 existing contacts, guarded by `if not exists (select 1 …)` so re-runs never duplicate. Replaces localStorage entirely.
  - **No admin gate, no approval gateway.** Removed the admin-mode toggle and the mailto/pending-approval queue from the original. Anyone signed in can add/edit/deactivate/delete; "deactivate" soft-hides (`active=false`), delete is permanent.
  - **New sidebar entry "Directory"** (`/directory`, Workspace group, `BookUser` icon) — for now it opens straight to Vendor Contacts; the generic name reserves room for a future client/CRM database.
  - **Files.** `app/src/pages/DirectoryPage.tsx` (list-grouped-by-company + card views, search, show-inactive, view/add/edit modal with manual + paste-signature tabs), `app/src/lib/vendorContacts.ts` (ported pure helpers: phone/domain normalization, Clearbit/favicon logo URLs, `parseSignature`, search/sort/group, row mappers), `app/src/components/VendorLogo.tsx` (Clearbit → favicon → initials fallback chain, client-side). Route added in `App.tsx`; sidebar link in `Layout.tsx`. Self-contained — queries Supabase directly rather than going through the global Zustand store.
  - **Migration to run:** `add_vendor_contacts.sql`.

### 2026-05-30
- **Bug Reporting & Notifications — feature shipped (all three phases).**
  - **Phase 1 — Bug Collection.** New `bug_reports` table (`add_bug_reports.sql`) with a 5-status CHECK (`open / in_progress / resolved / wont_fix / duplicate`), `reporter_id`, `image_url`, `page_url`, and RLS (any authenticated user INSERT; own rows SELECT; admin SELECT+UPDATE all). New `bug-screenshots` Storage bucket (public, 5 MB limit, PNG/JPEG/GIF/WebP). New `BugReportModal.tsx` with required Title + Description fields, optional screenshot upload with inline preview and remove action, silent page-URL capture, and a success state that auto-closes after 2 seconds. "Report a Bug" button (Bug icon) added to the bottom of the sidebar in `Layout.tsx` between the nav and the user strip — renders on every authenticated page.
  - **Phase 2 — Admin Triage Panel.** New `BugReportsCard.tsx` added to the Management section of `AdminDashboardSection.tsx` (between Cutsheet Review and Triage). Shows open count in the header; lists all non-closed reports newest-first with reporter name, date, page URL, and a status chip. Click any row to expand inline: full description, screenshot thumbnail (click to open full-size), status dropdown, resolution note textarea with context-aware placeholder, and a Save button. Closed issues (Resolved / Won't Fix / Duplicate) are hidden behind a "Show N closed" toggle. Save writes `status` + `resolution_note` + `updated_at` to `bug_reports`; a Phase 3 notification write stub was left at the exact insertion point for wiring later (now wired — see Phase 3 below).
  - **Phase 3 — Notification System.** New `notifications` and `notification_preferences` tables (`add_notifications.sql`). RLS: users own their rows; admins INSERT on behalf of any user. `notification_preferences` absence = opted-in (no seed step required for new types). New `NotificationBell.tsx` component in the sidebar user strip: bell icon with an orange unread badge, Supabase Realtime channel per `user_id` pushing live INSERT events to the badge count; click opens a fixed panel to the right of the sidebar listing recent notifications with unread dot indicators; marks all read on open. BugReportsCard's Save handler now checks the reporter's `notification_preferences` (defaulting to enabled on missing row) before inserting a `notifications` row when status advances to `resolved` or `wont_fix`. New `NotificationsSection` in `SettingsPage.tsx` (visible to all users, not admin-only): toggle for "Bug report status updates" backed by an upsert to `notification_preferences`. Notification preferences are respected immediately — the toggle controls whether the next admin triage action delivers a notification.
  - **Migrations to run (in order):** `add_bug_reports.sql`, then `add_notifications.sql`. Storage bucket creation is included in `add_bug_reports.sql`.

### 2026-05-27
- **Dashboard + Projects refactor — workspace-vs-personal split, admin section folded in, review system split.** Six-phase refactor of the main menu.
  - **Phase 1 — Foundation.** New `projects.legacy_engineer_id` column (`add_legacy_engineer.sql`) reserved for the carried-forward pre-sales engineer on post-sales rows (null until the future monday sync). New store state `myProjectIds: Set<string>` loaded from `project_members` filtered to the current user during `fetchAllData`; new action `addSelfToProject(projectId)` with optimistic update + rollback. Demo mode pre-fills the set with every seed project id.
  - **Phase 2 — Projects page = global registry.** Extracted `PipelineBar` to a shared component (`app/src/components/PipelineBar.tsx`, with `tilesForPhase()` + `buildPipelineCounts()` helpers). Added it above the search row on `ProjectsList.tsx`, removed the now-redundant Pre/Post pill row. Per-row **Add me** button (uses `addSelfToProject`); existing members show a green "On" pill instead.
  - **Phase 3 — Dashboard = user-scoped.** Replaced the `ownerId === user.id` filter (with "show all" fallback) by a strict `myProjectIds`-based filter — no fallback. Pipeline tile counts now reflect *only* the current user's projects. Empty-memberships path renders `EmptyMembershipsState` (icon + copy + Browse-all CTA). Removed the redundant "All Projects" header button.
  - **Phase 4 — Fold ManagerDashboard into Dashboard for admins.** Deleted `app/src/pages/ManagerDashboard.tsx` and the `/manager-dashboard` route. New `app/src/components/AdminDashboardSection.tsx` renders below the IC view when `isAdmin`: Cutsheet Review card (relocated), Needs Triage card (still monday-fed), Needs Review card (driven by internal `review_runs` — see Phase 5), and a new **Team Bandwidth** card that groups active projects per engineer with profile-name lookup, Pre/Post toggle, and an unassigned-count footer. Sidebar's cutsheet-pending badge moved onto the Dashboard link (admin-only).
  - **Phase 5 — Review split.** Added `submitted_for_review` to `review_runs.status` (`add_submitted_for_review.sql`, with backfill of existing `pending_review` rows so the manager queue doesn't empty out post-deploy). Re-purposed `pending_review` to mean "engineer's private pre-review on the project page" — auto-promote-on-open now only happens when an admin opens a `submitted_for_review` run. New engineer-side **Send to Manager** button on the AutoReview page flips `pending_review → submitted_for_review`. Approve / Changes Requested buttons gated to `isAdmin`. `/review-queue` filters dropped `pending_review` and added `submitted_for_review`; copy and stat-card labels updated. Dashboard `MyWorkCard` count for engineers now excludes `in_review` (manager's plate). The admin `NeedsReviewCard` consumes `review_runs` directly and replaces the previously monday-fed card.
  - **Phase 6 — Docs.** This entry, plus the feature-inventory rewrites for Dashboard, Projects, the removed Manager Dashboard, and the Auto Reviewer state machine. Added Future rows for **Engineer Assignment Sync (Monday → DB)** and **Effort-Weighted Team Bandwidth**.
  - **Migrations to run (in order):** `add_legacy_engineer.sql`, then `add_submitted_for_review.sql`. Both safe to re-run.

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

