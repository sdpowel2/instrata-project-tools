# Purchasing & Equipment Status Module
## Instrata Project Tools — Feature Specification

**Version:** 1.0  
**Status:** Ready for Development  
**Module:** Post-Sales / Purchasing  
**Dependencies:** Auto Reviewer (BoM import), Submittal module (approval status), Project record

---

## 1. Overview

The Purchasing & Equipment Status module bridges the gap between an approved submittal and material arriving on a job site. It serves two distinct but tightly coupled functions:

1. **Purchasing Export** — Generates manufacturer-grouped Excel workbooks from the project BoM that purchasing agents, engineers, or PMs use as the basis for creating purchase orders in their external system. Respects submittal approval status and base bid vs. CO flags.

2. **Equipment Status Tracking** — Provides per-line-item lifecycle tracking from ordered through installed, with a daily pick list feature that allows PMs to generate field dispatch documents and auto-advance equipment status when items are checked out for site.

These two functions share the same underlying equipment records and are presented as two views within one module.

---

## 2. Data Model

### `equipment_items` table

This table is populated from the Auto Reviewer BoM import. Each row represents one line item from the D-Tools quote.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `project_id` | uuid | FK → projects |
| `dtools_item_id` | text | Original D-Tools item reference |
| `manufacturer` | text | |
| `model_number` | text | |
| `description` | text | |
| `quantity` | integer | |
| `unit_cost` | decimal | Dealer cost from D-Tools |
| `extended_cost` | decimal | unit_cost × quantity |
| `item_type` | enum | `material` / `labor` / `other` |
| `location` | text | Room/zone from D-Tools |
| `submittal_status` | enum | See below — synced from Submittal module |
| `bid_type` | enum | `base_bid` / `change_order` |
| `co_reference` | text | nullable — CO number if bid_type = change_order |
| `purchase_status` | enum | See below |
| `ordered_date` | date | nullable |
| `received_date` | date | nullable |
| `inspected_date` | date | nullable — separate from received |
| `on_site_date` | date | nullable |
| `installed_date` | date | nullable |
| `commissioned_date` | date | nullable |
| `po_number` | text | nullable — PO reference entered manually |
| `vendor` | text | nullable — who it was ordered from |
| `notes` | text | nullable |
| `flagged` | boolean | For exceptions/issues — see 6.1 |
| `flag_reason` | text | nullable |
| `updated_by` | uuid | FK → users |
| `updated_at` | timestamp | |

### Submittal Status (enum — read from Submittal module, not editable here)
- `pending` — Not yet submitted
- `submitted` — Submitted, awaiting response
- `approved` — Approved as submitted
- `approved_as_noted` — Approved with conditions
- `revise_resubmit` — Returned, revision required
- `rejected` — Rejected

### Purchase Status (enum — editable in this module)
- `not_ordered` — Default state
- `approved_to_order` — Submittal approved, cleared to order
- `ordered` — PO placed
- `received` — Delivered to shop/warehouse
- `inspected` — Received and verified against PO, no damage
- `on_site` — Delivered to job site
- `installed` — Physically installed
- `commissioned` — Tested and commissioned

> **Note:** `approved_to_order` is auto-set when `submittal_status` moves to `approved` or `approved_as_noted`. It is a computed transition, not manually set. However, a PM can manually override to `approved_to_order` with a confirmation prompt (for items ordered without submittal approval — must log a reason).

---

## 3. Purchasing Export View

### 3.1 Access & Layout

Accessed from the project sidebar under **Purchasing → Purchase Order Export**.

Default view shows the full project BoM in a table grouped by manufacturer, sorted alphabetically within each group. Labor items are excluded from this view by default (toggle to include).

**Table columns:**
| Column | Notes |
|---|---|
| Manufacturer | Group header row |
| Model Number | |
| Description | |
| Qty | |
| Unit Cost | Dealer cost |
| Extended Cost | |
| Submittal Status | Colored badge |
| Bid Type | Base Bid / CO badge |
| CO Reference | Shown if CO |
| Approved to Order | Yes / No — derived from submittal status |

### 3.2 Filtering

Filter bar above the table:
- **By Manufacturer** (multi-select)
- **By Submittal Status** (multi-select)
- **By Bid Type** (Base Bid / CO / All)
- **Show Approved Only** (toggle — most common use case before placing a PO)
- **Show Unordered Only** (toggle — to see what still needs to be ordered)

Filters are combinable. Filter state persists per user session.

### 3.3 Excel Export

**"Export PO Sheet"** button generates an Excel workbook with the following structure:

**Workbook structure:**
- One worksheet per manufacturer (tab named by manufacturer)
- Each sheet contains only that manufacturer's items from the current filtered view
- A summary sheet ("All Items") with the full filtered list

**Per-sheet columns:**
- Model Number
- Description
- Qty
- Unit Cost
- Extended Cost
- Submittal Status
- Bid Type
- CO Reference
- Notes (blank column for purchasing agent use)
- PO Number (blank column for entry)

**Sheet formatting:**
- Instrata navy header row with white text
- Alternating row shading
- Manufacturer name and project name in the header
- Export date in the footer
- Totals row at bottom (Qty sum, Extended Cost sum)

**Export scope options** (modal before export):
- All items in current filtered view
- Approved-to-order items only
- Selected items only (if rows are checked)

### 3.4 PO Number Write-Back

After placing POs externally, a purchasing agent can return to this view and enter PO numbers against line items in bulk:
- Select multiple rows from the same manufacturer
- Click "Assign PO Number" → enter PO number → applies to all selected rows
- PO number is stored on each `equipment_item` record
- PO number surfaces in Equipment Status view and on the pick list

---

## 4. Equipment Status View

### 4.1 Access & Layout

Accessed from **Purchasing → Equipment Status** (same module, different tab).

Displays all material items (labor excluded) with their current purchase status. Grouped by status tier by default (section headers: Not Ordered / Ordered / Received / Inspected / On Site / Installed / Commissioned).

**Table columns:**
| Column | Notes |
|---|---|
| Status | Colored badge + icon |
| Manufacturer | |
| Model Number | |
| Description | |
| Location (Room) | From D-Tools |
| Qty | |
| PO Number | If assigned |
| Ordered Date | |
| Received Date | |
| Inspected Date | |
| On-Site Date | |
| Installed Date | |
| Flag | Icon indicator if flagged |
| Actions | Status advance / flag / note |

**Alternative grouping options** (toggle):
- By Manufacturer
- By Location/Room
- By Status (default)
- By Bid Type (Base Bid vs CO)

### 4.2 Status Advancement

**Single item:** Click the status badge → dropdown to select new status → confirm. Sets the corresponding date field to today automatically (overridable).

**Bulk advancement:** Select multiple rows via checkboxes → "Advance Status" button → select target status → confirm with optional note. Useful for "we received a full shipment from one vendor" scenarios.

**Partial quantity handling:**
- If a line item has quantity > 1, advancing status prompts: "How many units? (X of Y)"
- Partial advances split the row into two records: one at the new status for the advanced quantity, one remaining at the prior status
- Both rows retain the same `dtools_item_id` reference and are displayed as a grouped set

### 4.3 Received vs. Inspected Two-Step

When advancing status to `received`:
- Sets `received_date` to today
- Prompts: "Mark as inspected? (Verify qty and condition match PO)"
- If Yes → also sets `inspected_date` to today, status advances to `inspected`
- If No → status stays at `received`, `inspected_date` left null, item remains in "Received - Pending Inspection" sub-group

Items in received-but-not-inspected state are visually distinguished (amber badge) and surfaced as an action item on the Project Room summary.

### 4.4 Flagging

Any item can be flagged with a reason:
- Damaged on receipt
- Wrong item shipped
- Quantity discrepancy
- Long lead delay
- Substitution required
- Other (freeform)

Flagged items appear with a warning icon in all views and are surfaced in the Project Room summary. Flags are resolved by a PM with a resolution note.

---

## 5. Daily Pick List

### 5.1 Purpose

A PM generates a pick list before a field crew departs for a job site. The pick list specifies exactly what equipment is leaving the shop that day, tied to a specific work order or site visit. When the PM finalizes the pick list, items on it auto-advance from `inspected` to `on_site`.

### 5.2 Pick List Creation

Accessed from **Purchasing → Generate Pick List**.

**Wizard flow:**

**Step 1 — Site Visit Details**
- Date
- Site address (auto-filled from project)
- Lead technician (user dropdown)
- Additional crew (multi-select)
- Work order reference (optional — freeform or linked to schedule in Phase 2)

**Step 2 — Select Items**
- Filtered view of all items in `inspected` status (ready to ship)
- Grouped by location/room
- PM checks items being loaded for this visit
- Quantity selector per row (partial loads supported)
- Running total of items selected

**Step 3 — Review & Confirm**
- Summary of selected items grouped by room
- Confirm crew and date
- Option to add notes to the pick list

**Step 4 — Generate**
- Creates a `pick_list` record linked to the project
- Sets selected items' status to `on_site` with today's date
- Generates a PDF pick list document (see 5.3)

### 5.3 Pick List PDF

Formatted as a field dispatch document:

- Header: Project name, site address, date, lead tech, crew
- Body: Items grouped by room, with model, description, qty
- Checkbox column (for techs to manually verify as they unload)
- Footer: "Generated by Instrata Project Tools — [timestamp]"
- QR code or reference number linking back to the project record (optional, Phase 2)

### 5.4 Pick List History

All generated pick lists are stored and accessible from **Purchasing → Pick List History**. Useful for:
- Reviewing what went to site on a given date
- Resolving disputes about whether equipment was delivered
- Reference if an item's `on_site` date is questioned

---

## 6. Additional Features

### 6.1 Status Summary Dashboard (module-level)

Top of the Equipment Status view shows a summary bar:

```
Total Items: 847    Not Ordered: 124    Ordered: 203    Received/Inspected: 156    
On-Site: 89    Installed: 241    Commissioned: 34    Flagged: 6
```

Each number is a clickable filter shortcut.

### 6.2 Long-Lead Item Tagging

Items can be tagged as "long lead" (manually or via a rule — e.g., any item from manufacturers on a configurable long-lead list). Long-lead items:
- Appear in a dedicated filter view
- Surface on the Project Room summary as a watch item
- Feed into Milestone auto-suggestions (system can suggest a "material order deadline" milestone based on expected lead time)

### 6.3 Purchasing Notes Log

Each equipment item has a notes thread — not just a single notes field. Multiple timestamped entries can be added by any team member. This creates an audit trail for items that have had issues (e.g., "reordered after damage 4/15 — ETA 4/28").

---

## 7. Mobile (PWA)

**Purchasing Export:** Not available on mobile.

**Equipment Status:** Limited mobile view available:
- Read-only list of items by room, filterable by status
- Ability to advance status on individual items (single tap → confirm)
- Ability to mark received/inspected on delivery
- Flag an item with a reason
- No pick list generation on mobile (PM workflow, desktop only)

**Pick List View:** Read-only on mobile — techs can pull up their pick list for the day as a reference document.

---

## 8. Integration Points

| System | Direction | Data |
|---|---|---|
| Auto Reviewer (BoM import) | → Equipment Items | Populates all item records on project creation |
| Submittal Module | → Equipment Items | `submittal_status` sync — updates `approved_to_order` flag |
| Milestone Module | ← Equipment Status | Long-lead flags can trigger milestone suggestions |
| Gantt Module (Phase 2) | ← Equipment Status | Equipment status feeds into schedule health indicators |
| Project Room | → Summary widget | Flagged items, pending inspections, pick list activity |

---

## 9. Out of Scope for v1

- Direct integration with external purchasing/ERP systems
- Barcode scanning for receiving (Phase 2 — mobile enhancement)
- Automated PO generation (would require vendor API integrations)
- Price lock / cost-at-time-of-order tracking (future finance module)
- Equipment repair ticketing (post-project service module, separate spec)

---

## 10. Open Questions

1. Should the system enforce that items cannot advance to `on_site` without going through `received` → `inspected`? Recommendation: yes, with a PM override available.
2. Should labor items be completely hidden from this module or just filtered out by default? Recommendation: hidden by default, toggle to show — some PMs may want to track subcontractor labor deliverables.
3. Is PO number a single field per item, or can one item span multiple POs (e.g., partial shipment)? Recommendation: allow multiple PO references per item via the notes log initially; proper multi-PO support in a future purchasing enhancement.
4. Who can generate a pick list? PM and above only, or can lead techs generate their own? Recommendation: PM and above for now — keeps status advancement controlled.
