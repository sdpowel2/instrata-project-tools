# Milestone Tracking Module
## Instrata Project Tools — Feature Specification

**Version:** 1.0  
**Status:** Ready for Development  
**Module:** Post-Sales / Project Management  
**Dependencies:** Project record (Monday.com webhook), BoM import (Auto Reviewer)

---

## 1. Overview

The Milestone Tracking module gives PMs and engineers a structured, AV-specific timeline of contractual and operational checkpoints for each project. It is the first post-sales PM feature and feeds directly into the Project Room landing page summary.

Milestones exist at two tiers:
- **Project-level milestones** — contractual dates and major handoffs (submittal due, substantial completion, closeout)
- **Phase-level milestones** — operational checkpoints tied to installation phases (rough-in complete, bench staging complete, programming sign-off)

Both tiers surface in a unified timeline view per project.

---

## 2. Data Model

### `project_milestones` table

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `project_id` | uuid | FK → projects |
| `title` | text | Display name |
| `description` | text | Optional detail |
| `milestone_type` | enum | See types below |
| `tier` | enum | `project` or `phase` |
| `phase` | enum | nullable — see phases below |
| `due_date` | date | Target date |
| `completed_date` | date | nullable — set on completion |
| `status` | enum | `upcoming` / `at_risk` / `complete` / `overdue` |
| `owner_id` | uuid | FK → users — person responsible |
| `created_by` | uuid | FK → users |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |
| `notes` | text | Optional — any context on the milestone |
| `linked_co_id` | uuid | nullable — FK → change_orders (Phase 2) |

### Milestone Types (enum)

**Contractual / Project-level:**
- `submittal_due` — Submittal package due to GC/consultant
- `submittal_approval_expected` — Expected return of approved submittals
- `material_order_deadline` — Last date to order to hit schedule
- `substantial_completion` — Contractual substantial completion date
- `final_completion` — Final acceptance / punch list closed
- `closeout_package_due` — O&M manuals, as-builts, warranty letters due
- `training_scheduled` — Client training session
- `ahj_inspection` — Authority Having Jurisdiction inspection date
- `custom` — Freeform project-specific milestone

**Operational / Phase-level:**
- `rough_in_complete` — All rough-in cabling complete for a phase/floor
- `bench_staging_complete` — Rack build and staging complete in shop
- `pull_terminate_complete` — All field cabling pulled and terminated
- `rack_install_complete` — Racks installed and powered on-site
- `programming_complete` — Control/DSP programming finished and tested offline
- `commissioning_complete` — System commissioned and signed off on-site
- `punchlist_issued` — Punch list issued to field team
- `punchlist_closed` — All punch list items resolved

### Phase (enum, nullable)
Used when a phase-level milestone applies to a subset of the project:
`floor_1` / `floor_2` / `floor_3` / `wing_a` / `wing_b` / `all` / `custom`

> Note: Phase labels should be configurable per project to match how the GC/consultant has broken out the scope. Default is `all` for single-phase projects.

---

## 3. Status Logic

Status is computed automatically based on `due_date` and `completed_date`:

| Condition | Status |
|---|---|
| `completed_date` is set | `complete` |
| `due_date` > today + 7 days | `upcoming` |
| `due_date` within 7 days, not complete | `at_risk` |
| `due_date` < today, not complete | `overdue` |

The 7-day at-risk window should be configurable at the system level (admin setting).

---

## 4. Milestone Templates

When a new project is created (via Monday.com webhook), the system offers to auto-populate a default milestone set based on project type. Templates are admin-configurable.

### Default Commercial AV Template

Generates the following milestones with relative due dates based on a `project_start_date` input:

| Milestone | Default Offset |
|---|---|
| Submittal package due | +14 days |
| Submittal approval expected | +35 days |
| Material order deadline | +42 days (configurable based on longest lead time) |
| Bench staging complete | +60 days |
| Rough-in complete | +75 days |
| Rack install complete | +90 days |
| Programming complete | +100 days |
| Commissioning complete | +110 days |
| Punch list issued | +112 days |
| Substantial completion | +120 days |
| Closeout package due | +135 days |
| Final completion | +150 days |

All template dates are editable after generation. The template is a starting point, not a commitment.

---

## 5. UI — Desktop

### 5.1 Milestone List View (primary view)

Accessed from the project sidebar under **Project Management → Milestones**.

**Layout:**
- Two-section layout: Project Milestones (top) / Phase Milestones (bottom)
- Each section is a sortable table with columns: Status badge | Title | Type | Phase | Due Date | Owner | Completed Date | Actions
- Status badge uses color coding: green (complete), yellow (at_risk), red (overdue), grey (upcoming)
- Rows are sorted by due date ascending by default
- Overdue rows are visually elevated (subtle red left border or row tint)

**Actions per row:**
- Mark Complete (sets `completed_date` to today, prompts for optional note)
- Edit (inline or modal — all fields editable)
- Delete (soft delete with confirmation)

**Header actions:**
- Add Milestone (opens modal — see 5.3)
- Apply Template (only shown if no milestones exist yet, or via overflow menu)
- Export to PDF / CSV

### 5.2 Milestone Timeline View (secondary view)

Toggle between List and Timeline view in the module header.

Timeline is a horizontal date-based view:
- X-axis: date range from earliest milestone to latest + 2 weeks buffer
- Y-axis: milestone rows grouped by tier (Project / Phase)
- Each milestone renders as a labeled point/diamond on the timeline
- Color-coded by status
- Hover shows tooltip with title, owner, due date, status
- Click opens the edit modal
- "Today" line rendered as a vertical marker

> This is a read-only visualization, not a drag-to-edit Gantt. The Gantt module (Phase 2) handles schedule editing. This timeline is milestone awareness only.

### 5.3 Add / Edit Milestone Modal

Fields:
- Title (text, required)
- Milestone Type (dropdown — grouped by Contractual / Operational)
- Tier (auto-set based on type, but overridable)
- Phase (dropdown, shown only for phase-tier milestones)
- Due Date (date picker, required)
- Owner (user dropdown — project team members only)
- Description / Notes (textarea, optional)

---

## 6. Project Room Surface

The Milestone module feeds a summary widget on the project landing page showing:
- Next 3 upcoming/at-risk milestones with due dates and owners
- Count of overdue milestones (red badge if > 0)
- Overall milestone completion percentage (X of Y complete)

---

## 7. Notifications

Email and in-app notifications triggered by:

| Event | Recipients |
|---|---|
| Milestone enters `at_risk` (7-day window) | Owner + Project PM |
| Milestone becomes `overdue` | Owner + Project PM + Engineering lead |
| Milestone marked complete | Project PM |
| New milestone created | Project PM |

Notification preferences configurable per user in account settings.

---

## 8. Mobile (PWA — Phase 1 scope)

Milestone module is **read-only on mobile** in Phase 1.

Mobile surfaces:
- List of upcoming/at-risk/overdue milestones for the project (simplified card view)
- Ability to mark a milestone complete with a single tap + optional note
- No create/edit on mobile in Phase 1

---

## 9. Future / Out of Scope for v1

- Milestone dependency linking (if submittal approval is late, auto-shift material order deadline)
- Cross-project milestone dashboard (all projects, all milestones in one view — useful for operations manager)
- Integration with Gantt module (Phase 2) — milestones will render as diamond markers on the Gantt chart
- CO-linked milestones (Phase 2) — milestone tied to a specific change order approval date

---

## 10. Open Questions

1. Should milestone templates be global (admin-defined) only, or can PMs save their own templates from a configured project?
2. Is `phase` labeling per-project (Board Room, Lobby, Floor 2) or system-level (rough-in, install, finish)? Recommendation: per-project, set during project setup.
3. Does the operations manager need a cross-project milestone view in v1, or is per-project sufficient to start?