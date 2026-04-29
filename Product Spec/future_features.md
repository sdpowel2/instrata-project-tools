# Instrata Project Tools — Project Management Module
## Feature Tracking & Roadmap Overview

**Document Type:** Feature Planning Reference  
**Status:** Living Document  
**Last Updated:** 2026-04-29  
**Scope:** Post-Sales Project Management features surfaced through PM/ops research and competitive analysis

---

## Background

This document tracks the full scope of the Project Management module for Instrata Project Tools. It was developed through a combination of direct pain point interviews with internal ops staff, competitive analysis of existing AV-specific PM platforms (D-Tools, ProjX360, Jetbuilt, Specifi, XTEN-AV X-PRO), and internal product design discussions.

The guiding philosophy for this module is a **project room model** — one landing place per project where all project collaborators (PMs, engineers, programmers, techs) have visibility into project health without needing to navigate between disconnected tools. Most users have broad read access; edit access is role- and module-scoped.

Full data model specs exist as separate documents for Phase 1 features. This document provides directional planning context for all phases.

---

## Competitive Landscape Summary

| Platform | Strengths | Gaps Relevant to Instrata |
|---|---|---|
| **D-Tools SI** | 25+ years of AV-specific data, Gantt, scheduling | Clunky UI, slow update cycle, on-prem limitations |
| **ProjX360** | Project-centric (location-based), COs, work orders, inventory, barcode scanning | No AV-specific milestone types, weak programming sub-project support |
| **Jetbuilt** | AI schematic generation, large product DB, service desk | Execution/PM side thinner than pre-sales side |
| **Specifi** | Clean UI, client portal, proposal tools | Lighter on deep post-sales PM |
| **XTEN-AV X-PRO** | Clock-in/out, field mobile, task management | Not purpose-built for commercial integrators at Instrata's project scale |

**Key whitespace Instrata can own:**
- AV-specific milestone templates (submittal, bench, commissioning, closeout gates)
- Labor-to-Gantt auto-build pipeline from D-Tools quote data
- Subcontract capacity trigger (resource look-ahead)
- Programming sub-project with asset/code repository
- Communication log as a first-class legal/audit tool

---

## Feature Index

| # | Feature | Phase | Full Spec | Status |
|---|---|---|---|---|
| 1 | Milestone Tracking | 1 | ✅ `milestone-tracking.md` | **Shipped 2026-04-29** |
| 2 | Purchasing & Equipment Status | 1 | ✅ `02-purchasing-equipment-status.md` | **Shipped 2026-04-29** (v1 scope; deferred items below) |
| 3 | Client & GC Communication Log | 1 | ✅ `03-communication-log.md` | Ready for dev |
| 4 | Gantt Chart / Schedule Builder | 2 | ⬜ Pending | Design phase |
| 5 | Change Order Management | 2 | ⬜ Pending | Pre-req work needed |
| 6 | Punchlist Module | — | ✅ Already built | Complete |
| 7 | Closeout Module | — | ✅ Already built | Complete — needs milestone date binding |
| 8 | Programming Sub-Project | 2 | ⬜ Pending | Direction defined |
| 9 | Resource / Capacity Tracking | 3 | ⬜ Pending | Future |
| 10 | Mobile PWA | Cross-cutting | ⬜ Pending | Prototype in progress |
| 11 | Project Room Landing Page | Cross-cutting | ⬜ Pending | Design discussion needed |

---

---

## Phase 1 Features

### 1. Milestone Tracking
**Full spec:** `milestone-tracking.md`

**Status:** **Shipped 2026-04-29** (v1).

**Pain point:** Internal ops check confirmed zero meaningful milestone tracking exists across active projects. Confirmed gap.

**Direction:** Two-tier milestone model — project-level contractual milestones (submittal due, substantial completion, closeout) and phase-level operational milestones (bench complete, rough-in complete, commissioning sign-off). Auto-status logic (upcoming / at-risk / overdue) based on due date proximity. AV-specific milestone template that auto-populates on project creation with relative date offsets. Timeline visualization (read-only — not a Gantt). Feeds Project Room summary widget. Milestone date binding also closes the gap in the existing Closeout module.

**Mobile:** Read-only list + single-tap mark-complete in PWA Phase 1.

**Key decisions made:**
- Two tiers (project + phase) with per-project phase label configuration
- 7-day at-risk window (admin configurable)
- Template is a starting point, all dates editable after generation
- Cross-project milestone dashboard deferred to future ops dashboard feature

**Deferred:** Notifications (email + in-app) on at-risk / overdue / mark-complete events; mobile read-only view + single-tap mark-complete; per-project configurable phase labels; admin-configurable at-risk window; PM-saved custom templates (today the template is hard-coded in `app/src/utils/milestoneTemplates.ts`); cross-project milestone dashboard for ops manager.

---

### 2. Purchasing & Equipment Status
**Full spec:** `02-purchasing-equipment-status.md`

**Pain point:** No structured way to track what's been ordered, what's arrived, and where equipment lives across a project lifecycle.

**Direction:** Two views within one module. **Purchasing Export** generates manufacturer-grouped Excel workbooks from the BoM for external PO creation — respects submittal approval status and base bid vs. CO flags, with PO number write-back after ordering. **Equipment Status** tracks per-line-item lifecycle: not ordered → approved to order → ordered → received → inspected → on-site → installed → commissioned.

`received` and `inspected` are intentionally separate steps to create a freight claim paper trail and catch damage/discrepancy before rack build. Partial quantity handling splits line items when only some units of a multi-quantity item advance status.

**Daily Pick List** feature allows PMs to generate a field dispatch document before a crew departs. Selecting items from the pick list auto-advances their status to `on_site`, eliminating manual status updates for bulk moves. Pick list PDF serves as the tech's field reference document.

**Downstream connection:** Equipment status eventually feeds into the Gantt module as a schedule health indicator, and into the Project Room summary. Long-lead item tagging can trigger Milestone suggestions.

**Mobile:** Status advancement and item flagging available in PWA. Pick list is read-only on mobile (generation is a PM/desktop workflow).

**Key decisions made:**
- `approved_to_order` is computed from submittal status, not manually set (PM override available with reason log)
- Partial loads supported on pick list (line-item selectable, not all-or-nothing)
- Labor items hidden from this module by default
- Purchasing notes log is a thread, not a single field, for audit trail support

#### v1 Shipped (2026-04-29)

What's live today in the Purchasing module:
- Multi-submittal linking per module with persistent "Add Submittal" amendment flow
- Manufacturer-grouped detail view; per-manufacturer default ship-to + need-by with per-item override precedence
- Inline editable purchaser fields: purchase unit price, ship-to (warehouse picker or custom address), need-by date, PO number
- Live-resolved display data from `submittal_items` + `project_bom_items` (mfr / model / desc / qty / sold-in price / vendor) — no snapshotting, edits flow through automatically
- Per-item submittal approval state machine (`pending` / `approved` / `revise`) with package status auto-promotion / demotion (see `submittal_items` schema doc)
- Status states: `not_ordered → ordered → received` with auto-set dates (overridable). Computed visual states `draft` (submittal not submitted yet) and `pending_approval` (submitted but item not yet approved) gate purchaser fields read-only.
- Always-visible freight row per manufacturer (actuals capture only — no quoted comparison yet)
- Persistent warning banner for ordered-then-reverted approvals; clears automatically when re-approved
- Block on submittal item delete when downstream purchasing row is ordered+
- DTools "Custom Field 1" (`priced_from`) extracted by `dtools-project-lookup` and surfaced as the Vendor column
- Org-wide warehouses table (admin-only CRUD in Settings) backing the ship-to dropdowns

#### Deferred to Phase 1.5 / Phase 2

Tracked here so they can be picked up in priority order. Most are explicitly called out in `02-purchasing-equipment-status.md`:

**Status tracking depth**
- Extend the status chain past `received`: `inspected` (separate two-step from received with a "Mark as inspected? Verify qty + condition" prompt — surfaces freight-claim paper trail), `on_site`, `installed`, `commissioned`. Project-level inventory module (planned later) takes over from `received` onward; this is the bridge until that ships.
- **Partial-quantity splits.** Advancing status on a multi-qty item prompts "How many units? (X of Y)" and splits the row — one record at the new status, one staying at the prior status. Both retain the same `submittal_item_id` reference and group visually.
- **Item flagging** with reason enum (Damaged / Wrong item / Qty discrepancy / Long lead delay / Substitution required / Other). PM-resolves with a note; warning icon in all views; surfaces on Project Room summary.

**Pick list workflow (entire feature)**
- 4-step wizard (site visit details → select items in `inspected` status grouped by location → review → generate). Selecting items auto-advances them to `on_site` and produces a branded PDF dispatch document with checkboxes for techs to verify. Pick list history persists for dispute resolution. PM/admin only.

**Excel PO export**
- "Export PO Sheet" button on the purchasing detail view → Excel workbook with one tab per manufacturer + a summary "All Items" sheet. Instrata navy header, alternating row shading, totals row at bottom. Export scope modal (filtered view / approved-to-order only / selected rows only).

**PO number write-back & bulk-assign**
- Multi-select rows from one manufacturer → "Assign PO Number" → applies to all selected. Surfaces on equipment status view and pick list.

**Notes thread per item**
- Replace single `notes` field with timestamped thread (any team member can add). Audit trail for items with issues ("reordered after damage 4/15 — ETA 4/28"). New table `purchasing_item_notes` (`id`, `purchasing_item_id`, `body`, `created_by`, `created_at`).

**Filtering & view options**
- Filter bar: by manufacturer (multi-select), by submittal status (multi-select), by bid type (Base Bid / CO / All), Show Approved Only toggle, Show Unordered Only toggle. State persists per user session.
- Alternative grouping: by manufacturer (current default) / by location/room / by status / by bid type.

**Status summary dashboard (module-level)**
- Top-of-page KPI strip: Total / Not Ordered / Ordered / Received / Inspected / On-Site / Installed / Commissioned / Flagged. Each number is a clickable filter shortcut.

**Long-lead item tagging**
- Per-item "long lead" flag (manual, plus rule-based via configurable manufacturer list). Long-lead filter view, Project Room watch widget, and feeds Milestone module auto-suggestions ("Add a Material Order Deadline milestone for X days out").

**Freight margin tracking**
- Pair the actuals captured in `purchasing_freight` with a "quoted freight" value from the BoM (or DTools "Freight" line). Margin-fade dashboard at the project + module level. Same math eventually wraps purchase-vs-cost variance per line item.

**Change Order linkage**
- Each `purchasing_items` row carries `bid_type` (`base_bid` / `change_order`) + `co_reference` (CO number). Filter / group by bid type. Auto-set on import once the CO management module ships.

**Mobile (PWA)**
- Equipment Status: read-only list by room with status filter, single-tap status advance, mark received / inspected on delivery, flag with reason. No pick list generation on mobile (PM/desktop workflow).
- Pick list: read-only daily reference document for techs.

**Module dashboard surface**
- Project Room widget: count of flagged items, count of received-but-not-inspected, recent pick list activity, long-lead watch list.

---

### 3. Client & GC Communication Log
**Full spec:** `03-communication-log.md`

**Pain point:** No structured record of external communications, directives, or meeting notes. High-friction contract disputes and GC conflicts are currently undefended because nothing is logged. Confirmed urgent.

**Direction:** Timestamped, immutable (soft-delete only) project-level log with structured entry types: meeting notes, site walk, phone call, email summary, directive, RFI, submittal note, CO log, issue, decision, notice, general. Rich text body with clipboard paste support. Quick entry templates for meeting notes and site walk types reduce friction.

**Directives** have elevated structure: source, delivery method, action required flag, response required flag, response due date. Open directive action items surface on the Project Room summary.

**Issues** function as lightweight tickets with severity and status — a simple issue tracker that doesn't require a separate module.

**RFIs** include `ball_in_court` tracking with configurable aging alerts — surfaces RFIs waiting on GC/consultant responses past a threshold date.

**Confidential flag** allows PM/admin-only entries for sensitive internal notes (legal strategy, GC relationship context, pricing discussions).

**Mobile is a primary use case.** Target: meeting note entry in under 60 seconds on mobile. Offline draft support with sync on reconnect. The mobile entry flow is the recommended starting point for PWA prototyping.

**Key decisions made:**
- Soft delete only — preserves audit trail integrity
- Edits are tracked with history (original body preserved), not blocked after a time window
- Participants field is freeform text in v1 (structured contacts/stakeholders module deferred)
- No email auto-capture in v1
- External client portal access deferred

---

---

## Phase 2 Features

### 4. Gantt Chart / Schedule Builder
**Full spec:** Pending — `04-gantt-schedule.md`

**Pain point:** No schedule tooling exists. PMs are working from spreadsheets or mental models. This is the highest-impact PM feature and warrants the most careful design before rollout, as teams will become reliant on it quickly.

**Direction:** The key insight is that the D-Tools quote already contains all the raw ingredients for auto-building a schedule: labor hours per device, labor type (rough-in, pull/terminate, rack mount, program, commission), and room/location groupings. The Gantt wizard uses this data to auto-build an initial schedule from a small set of PM inputs rather than requiring manual construction from scratch.

**Wizard inputs:**
- Project start date
- Crew size
- Priority mode: room-priority (one room at a time, fully) or phase-priority (all rough-in first, then all install, etc.)
- Labor efficiency factor (e.g., 80% — adjusts theoretical hours to real-world durations)
- Programming start offset (e.g., programming begins when field installation is X% complete — models the real-world partial concurrency of programming and field work)

**Auto-build output:**
- Phase bars with calculated start/end dates derived from labor hours ÷ crew size × efficiency factor
- Standard AV phase dependency chain: rough-in → pull/terminate → rack build (parallel) → rack install → programming → commissioning → training
- Major project milestones plotted as diamond markers (from Milestone module)
- Substantial completion derived as a milestone from the last phase end date, with optional buffer input

**Post-build:** Fully editable down to the task/item level. Drag to resize bars. Individual task adjustments. Dependency locking (if upstream phase isn't signed off, downstream can't start — configurable, not enforced).

**Tech stack:** Likely DHTMLX Gantt or Bryntum Gantt (production-grade libraries that handle drag-resize, dependencies, and baseline comparison). FieldStack Gantt prototype used a similar library — codebase to be checked for reuse. Rolling a custom Gantt renderer is not recommended.

**Relationship to Milestones:** Milestone module markers render on the Gantt chart as non-editable reference points. Changes to milestone dates in the Milestone module are reflected on the Gantt automatically.

**Pre-requisites before dev:**
- Milestone module stable
- Equipment status module stable (eventually feeds schedule health indicators)
- CO workflow defined (COs introduce scope that affects schedule)

**Key open questions:**
- Baseline comparison (original schedule vs. current) — important for claiming delay damages but adds complexity. Recommend including from v1 given the legal value.
- Should the Gantt export to PDF/image for client-facing schedule sharing? Recommendation: yes.
- Should techs have read-only Gantt access on mobile? Recommendation: yes — read-only daily/weekly view only.

---

### 5. Change Order Management
**Full spec:** Pending — `05-change-order-management.md`

**Pain point:** No structured CO workflow. COs are currently tracked informally and the handoff between field-identified scope and pre-sales quoting is manual and lossy.

**Direction:** CO management is two-headed and needs to model both directions:

- **CO Request (outbound):** Scope discovered in the field or directed by GC/owner → logged in Project Tools → creates a linked pre-sales record for quoting → returns to post-sales on approval and merges into the BoM and schedule
- **CO Tracking:** Once a CO is approved, it flows into equipment status (items tagged `change_order` in the BoM import), milestone adjustments, and schedule impacts

**State machine (proposed):**
`Identified → Quoted → Submitted to GC/Owner → Approved / Rejected / On Hold → Added to Contract`

Each status transition is a loggable event (date, person, note) which feeds the Communication Log automatically as a `co_log` entry.

**Pre-requisite work:** CO logic in Monday.com and D-Tools needs to be solidified before the Project Tools tracking layer is built. The pre-sales/post-sales partition already exists via the Monday "Won" webhook — CO requests would create a new pre-sales record linked to the parent project rather than a standalone opportunity, then merge back on approval. This architecture needs to be designed and tested before the PM tracking layer is layered on top.

**Downstream connections:** CO items in the BoM are already tagged `base_bid` vs `change_order` from the D-Tools import. Purchasing module and equipment status already respect this flag. The CO management module formalizes what creates and closes those flags.

---

### 6. Programming Sub-Project
**Full spec:** Pending — `06-programming-subproject.md`

**Pain point:** Programming tasks exist in a Monday.com board but aren't connected to the project record in Project Tools. No asset repository for client branding, GUI files, or code.

**Direction:** A programming sub-project section within a project that connects to the existing Monday programming board and adds a project-scoped asset/resource repository.

**Monday integration:** Programming board already exists. The sub-project view in Project Tools surfaces that board's data within the project context — tasks, assignees, status — without duplicating it. Bi-directional status sync via existing webhook infrastructure.

**Client Resource Repository:** A file store attached to each project specifically for programming assets:
- Client logos and branding assets
- Default and custom button images
- Color schemes / theme files
- Reference photos
- No admin approval gate (unlike cutsheet repository) — programmer self-manages
- Persists for the life of the project and into service history

**Code Repository:** Version-controlled (or at minimum, timestamped) storage for:
- Control system code (Crestron, AMX, etc.)
- DSP configurations (Q-SYS, Biamp, etc.)
- AV-over-IP configuration files
- Named by version/date, with notes field per upload
- Critical for service calls years later — eliminates archaeology

**GUI Flow Tool:** Rather than building a drawing tool, the recommendation is a lightweight screenshot-based flow viewer. Programmer uploads screenshots of each GUI page/layer, then draws navigation arrows between screenshots and adds pin annotations on specific controls with text labels. Creates a simple interactive prototype reference document — "connect these screenshots with arrows and notes" rather than a drawing canvas. This is significantly simpler to build than a markup tool and serves the same practical need of documenting control flow for future reference.

---

---

## Phase 3 Features

### 7. Resource / Capacity Tracking
**Full spec:** Pending — future

**Pain point:** No visibility into what techs are committed to what jobs on a weekly/monthly look-ahead. Subcontracting decisions are reactive rather than planned.

**Direction:** A capacity planning view that compares total committed tech-hours per week against available hours by role/certification level. The key differentiator vs. what exists in other tools is a **subcontract trigger indicator** — when projected utilization for a given week exceeds a configurable threshold (e.g., 90% of available hours), the system flags it as a sub risk window so PM leadership can proactively plan.

Feeds from: Gantt module (scheduled labor by phase and date), work orders, and a tech roster with role/cert tags.

**Why Phase 3:** Requires Gantt to be stable and populated with real project data. Needs a meaningful install base of projects in the system before the look-ahead view is meaningful. Data quality from the Gantt directly determines the quality of this view.

---

---

## Cross-Cutting Features

### 8. Mobile PWA
**Full spec:** Pending — prototype in progress

**Philosophy:** Mobile Instrata is not a scaled-down version of the full app. It is a **field capture interface** that feeds data into the full app. The majority of the app (submittal building, project planning, Gantt editing) is desktop-only. Mobile surfaces are limited to capture-or-consume workflows.

**Recommended approach:** Responsive PWA built into the existing React stack rather than a separate React Native app. Covers all field use cases with dramatically less overhead — camera access, offline capability, installable to home screen. Avoids maintaining a separate codebase alongside QuietFeed.

**Phase 1 mobile scope (targeting alongside Communication Log build):**
- Communication log new entry (primary use case — target 60-second meeting note)
- Communication log read/browse
- Punch list item creation and photo capture (module already built on desktop)
- Equipment status advancement (mark received, inspected, installed)
- Pick list read-only view (daily reference for techs)
- Milestone read-only + single-tap mark complete

**Phase 2 mobile scope:**
- Gantt read-only view (daily/weekly window — not full project view)
- Issue logging from field

**Offline support:** Communication log draft, punch list items, and status updates should queue locally and sync on reconnect. Critical for basement/remote site scenarios.

---

### 9. Project Room Landing Page
**Full spec:** Pending — design discussion in progress

**Philosophy:** The project landing page is the frame everything else lives inside. It surfaces cross-module health data so any collaborator can understand project status at a glance without drilling into individual modules.

**Planned summary widgets (feeds from active modules):**
- Next 3 milestones (date, owner, status)
- Overdue milestone count (red badge)
- Equipment status summary (X of Y items at each stage)
- Flagged equipment items
- Open punch list item count
- Open issues count (with critical severity indicator)
- Open RFIs with ball-in-court not on Instrata
- Open directive action items
- Recent communication log entries (3 most recent)
- Open CO count and total value (Phase 2)
- Programming sub-project status (Phase 2)

**Note:** This is an expansion of the existing project overview page, not a replacement. The visual design refactor is a separate design discussion before dev work begins. Individual module specs are written assuming the Project Room surface exists — summary widget data contracts will be defined as part of the landing page spec.

---

## Open Items / Decisions Needed

| Item | Context | Owner |
|---|---|---|
| Project Room design refactor | Existing overview page needs expansion — design discussion before dev | Seth |
| Gantt library selection | DHTMLX vs Bryntum — check FieldStack codebase for existing implementation | Seth |
| CO architecture in Monday/D-Tools | Pre-requisite for CO management module | Seth |
| Phase label configuration | Per-project custom phase labels vs. system-level enum — milestone + Gantt both need this resolved | Seth + dev |
| Mobile PWA prototype | Communication log entry flow as starting point for design testing | Seth |
| Cross-project milestone dashboard | Ops manager use case — deferred from v1 but confirmed need | Future |