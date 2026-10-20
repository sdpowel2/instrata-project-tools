# monday Build Guide: Salesforce Sync + Hope's Queue

**Manual configuration checklist** · Version 1.0 · October 9, 2026 · Owner: Seth Powell

This is everything done by hand in monday to support the *Project Tools: Salesforce ↔ monday Sync + Hope's Queue Engine* spec. Each section says **when** it has to happen relative to the cutover steps in that spec (§11). Anything marked **⚠ breaks code if skipped** must be done before the step listed.

Already done on Oct 9, 2026:

- Raleigh BU label removed; its 6 items moved to Instrata SE
- "New Group" and "No Award" groups deleted
- No Award status label removed; its items resolved
- In Progress status label moved to the end of the status order

---

## 1. Pre-Sales board: label cleanup (`AV Pre-Sales Project Summary`, 3477536693)

**When:** before cutover step 5 (mapping prerequisites). ⚠ Unmapped values become failure tasks during dry run until done.

### 1.1 Win Percentage (`dropdown__1`)

- [ ] Rename label "0" → **"0%"**. The label ID stays the same.
- [ ] Add label **"99%"**.
- [ ] Filter the board for Win % = "High". Reassign those items to 75% or 99% as appropriate, then **deactivate "High"**.
- [ ] Do **not** add 100%. In Salesforce, 100% means Confirmed to Win, and the sync sets status = Won instead.
- [ ] Send the final label IDs to whoever is configuring `map_win_pct`.

### 1.2 Business Unit (`dropdown2`): rename to match Salesforce exactly

Target labels: **Northeast, Mid-Atlantic, Southeast, Southwest** (add **Louisiana** only if you want it to sync rather than raise a failure task).

- **Timing rule:** you can do this any time before *or* after go-live. The one hard rule is that **the same day you rename, Hope updates `map_business_unit`.** Otherwise every new opportunity raises an "unmapped BU" failure task. Nothing gets corrupted either way, because the sync refuses to write unmapped values.
- [ ] Before renaming, list every dashboard, report, formula, and Claude skill that filters on "Instrata XX" text. Update them in the same sitting. The avss-monthly-report skill is the likely one.

### 1.3 Sales Person (`dropdown3`)

- [ ] Reassign items currently tagged **"c", "doug", "TON"** to the correct rep, then deactivate those labels.
- [ ] Add missing reps: Johnny Price, Scott Woodlief, Jerry Bates, David Poore, Rithom Success. Re-check against the dry-run failure log; it will list every unmapped name.
- [ ] Leave "Michelle Scheller-Bravo" and "Paul Nolan" as-is. The mapping table translates the Salesforce spellings.
- [ ] Keep **"House"**. The sync uses it whenever Salesforce has no Sales Rep.

---

## 2. Pre-Sales board: new structure and automations

**When:** before cutover step 4 (dry run in production).

### 2.1 New column

- [ ] **Win/Loss Notes**: Long Text. The sync fills it with the Salesforce lost/canceled reason, detail, and competitor. **Create it through the API with the fixed column id `win_loss_notes`** on the Pre-Sales, Pre-Qualification and Triage boards (all three), after Status, so a cross-board move keeps the notes. The UI can't choose a column id. Description: *"Filled by the Salesforce sync when a deal is Lost, Canceled or Declined: reason, detail and competitor from Salesforce. Edits here aren't sent back to Salesforce."* Then set `presales.win_loss_notes` to `win_loss_notes` in `public.config_field_registry`. Sandbox boards done Oct 15 (tested: notes written on Pre-Qualification, kept through the move to Pre-Sales / Lost).

### 2.2 New group

- [x] ~~**Pre-Engineering**~~: **no longer needed** (Oct 14). Pre-engineering opportunities live on the Pre-Qualification board.

### 2.2b Triage board (production `18435527543`)

- [ ] **Bid Decision**: Status column, created through the API with the fixed id `bid_decision`, labels **1 = Bid** (green) and **2 = No-Bid** (red), after Status. Triage board only; it drops off when the item moves to the Pre-Sales board (the decision is kept in the sync's event log). Then set `triage.bid_decision` to `bid_decision` in `public.config_field_registry`. Sandbox done Oct 15.
- [ ] **R6 automation:** When **Bid Decision** changes to **Bid** → move item to group **New Assignment**. Sandbox done Oct 15.
- R4 (Triage → Bid/No-Bid) is Hope dragging the item. R5 (No-Bid → Pre-Sales / Declined to Bid) and R7 (Bid + engineer → Pre-Sales / New Requests) are done by the sync, not monday automations.
- **Pre-Sales Engineer on Triage is a dropdown, not a people column (Oct 19).** Engineers must NOT be members of Triage or Pre-Qualification (they were grabbing untriaged work), and a people column can only assign members. Delete the people column (`person`) on both boards; on Triage create a Dropdown through the API with the fixed id `engineer_pick`, title "Pre-Sales Engineer", **single select** (`limit_select`), labels with ids 1–12: Cameron Bell, Erik Benson, Garry Gilchrist, Isaac Garner, Jason Price, Jerry Bates, Johnny Price, Kelina Bauman, Lee Thompson, Seth Powell, Shaun Lee, Tim Giguere. The sync sets the real people column on the Pre-Sales Summary at R7. A new engineer = a new dropdown label + a `map_estimator` row with its `triage_label_id`. Sandbox done Oct 19.
- Hope and leadership are **members** of Triage and Pre-Qualification; engineers are not.

### 2.3 Status → group automations

Confirm these exist. Create any that are missing:

| When Status changes to | Move item to group |
|---|---|
| Follow Up | Follow Up *(exists)* |
| Won | Won |
| Lost | Lost |
| Declined to Bid | Declined to Bid |

Rebid, ON HOLD, Review, and In Progress do **not** move groups.

### 2.4 Leadership notifications

- [ ] **Update the existing "Won" notification** to include Salesperson, Quoted Price, Estimated GM %, and Business Unit.
- [ ] **New "Lost" notification:** When Status changes to Lost → notify Lee and leadership. Include the item name, Quoted Price, Salesperson, and **Win/Loss Notes**. The sync writes the notes and the status in the same update, so the notes are present when the automation fires.
- [ ] Optional: the same notification for Declined to Bid.

### 2.5 Retire the old writeback habit

- [ ] Once live, the Follow Up status toggle is no longer needed to push price and GM% to Salesforce. Any change to Quoted Price or GM % pushes automatically. Tell the pre-sales team.

### 2.6 Zapier

- [ ] **At cutover step 6 only:** turn off all three Zaps in the same hour Project Tools goes live. Leave them **on** during the dry run.

---

## 3. Integration identity

**When:** before cutover step 1.

- [ ] Decide which monday identity Project Tools writes as. **Preferred: a dedicated user** ("AVSS Integration"). Its user ID lets the engine ignore its own webhook echoes, and the board activity log shows "AVSS Integration" instead of you. If a seat isn't available, use your token. Loop prevention then falls back to comparing values (it still works, but your name appears on every sync write).
- [ ] Generate the API token. Store it **only** as a Fly secret.
- [ ] Webhooks are registered by Project Tools through the API. Nothing to click, but confirm the identity has access to every board involved.

---

## 4. Hope's Queue board (new)

> **Built Oct 20 by Claude through the API** (prod `18436259969`, sandbox `18436259977`, Pre-Qualification workspace). What's left by hand: **hide the Engine Key column** in the main view. Task Type labels differ from 4.1 below (Seth, Oct 19): Fix Mapping, Review, Sync Problem, Stage Check, Won – Handoff, Won – Open Job, Report, Triage, Data Cleanliness; the single Source link became two (monday item, Salesforce).

**When:** before Phase 1B.

**Workspace:** wherever the AVSS boards live, with visibility for all AVSS leadership.

### 4.1 Columns

| Column | Type | Notes |
|---|---|---|
| Name | name | Written by engine (task title) |
| Status | status | Labels exactly: **Not Started**, **In Progress**, **Waiting on Someone**, **Done**. Send label IDs to config. |
| Task Type | dropdown | Sync Failure, Stage Check, Won – Handoff, Won – Open Job, Report, Triage, Data Cleanliness. Hope picks "Triage" when adding a triage item by hand. |
| Due | date (time on) | Engine-set |
| Source | link | Engine-set link to the pre-sales/post-sales item or Salesforce opportunity |
| Project | text | Engine-set project name / quote number for scanning |
| Details | long text | What's wrong or what to do (e.g. "Unmapped Sales Rep: Johnny Price → add to map_sales_rep") |
| Count | numbers | Used only by the Data Cleanliness row |
| Opened | date | Engine-set |
| Reopens | numbers | Engine-set (rework visibility) |
| Engine Key | text | Engine-set dedupe key. **Hide this column** in the main view; do not edit. |

### 4.2 Groups (in this order)

**Today / Overdue** → **This Week** → **As Needed** → **Background** → **Done**

The engine moves items between groups. Hope only changes Status.

### 4.3 Board automations

- [ ] None needed. The engine handles placement and closing. Do **not** add status → group automations here; they would fight the engine.

---

## 5. Hope's Dashboard

**When:** after section 4, and after section 6 views exist.

Create a dashboard named **"Hope – Daily"** with:

1. **Battery widget**: Hope's Queue, by Status (shows progress through open work).
2. **Numbers widget: Overdue**: Hope's Queue items in Today/Overdue with status ≠ Done.
3. **Numbers widget: Sync Failures open**: Task Type = Sync Failure, status ≠ Done.
4. **Table widget: Hope's Queue**, main view.
5. **Three Numbers widgets: Data Cleanliness**, one per board, each pointed at that board's "Data Cleanliness" view from section 6.
6. **Three Table widgets**, the same three views, so Hope can click straight into items.

---

## 6. Data-cleanliness views and ping buttons

**When:** any time. These work today without the engine.

### 6.1 Saved views (one per board, named "Data Cleanliness")

Use **advanced filters** with a condition group:

- **Pre-Sales.** Group is not any of [New Requests, Lost, Declined to Bid, Pre-Engineering] **AND** (any of these is empty: Quoted Price, Estimated GM %, Premiere Protect $, Programming, Quote Number, Win Percentage, Business Unit, Sales Person)
- **Post-Sales.** Not in the intake/first group **AND** (any empty: Project Manager, Pre-Sales Engineer, Programmer, Cutsheet Submittals Date, Shop Drawing Due Date, Project Number)
- **Programming.** Not in the intake/first group **AND** (any empty: Pre-Sales Engineer, Post-Sales Engineer, Business Unit, Project Manager, Manufacturer)

Known false positives until exemption rules are decided (spec O-8): Programmer is blank where Programming = No; Project Number is blank before a job is opened.

### 6.2 "Request Update" button (default ping mechanism)

On each of the three boards:

- [ ] Add a **Button** column, "Request Update".
- [ ] Automation: **When button clicked → notify** [Pre-Sales Engineer on pre-sales; Post-Sales Engineer on post-sales and programming] with the message: *"Data cleanup: this item has blank required fields. Please fill them in or reply here."*

Hope clicks the button from the Data Cleanliness view; the engineer gets a monday notification on the exact item.

---

## 7. Post-Sales and Programming boards

**When:** before Phase 1B (data-cleanliness counts and open-job auto-close).

- [ ] Send the board IDs and the column IDs for every field listed in 6.1 to config (spec O-2).
- [ ] Confirm how a post-sales item links back to its pre-sales item: the Project ID text column (`text_mm2rcnav` on pre-sales) or a connected-boards column. The open-job auto-close depends on it (spec O-5).
- [ ] (From your earlier notes, separate from this build) Add the **"Stuck"** status on post-sales: external stuck requires a #update note; internal stuck is not reported to PMs. The PM report skill will need it.

---

## 8. Salesforce admin tasks (for reference; detailed in spec §10)

- [ ] Email the other admins about using the `partial` sandbox; refresh it once cleared.
- [ ] Build the Named Credential `AVSS_ProjectTools` and the two record-triggered Flows in the sandbox, then deploy to production at cutover step 6.
- [ ] Create the Project Tools integration user and connected app.
- [ ] Rep timezones fixed Oct 9, 2026 (Cavallaro, Hullner, Lash → Pacific; Bates corrected). Apply the same check to new SW hires.

---

## 9. Sequence at a glance

| Order | Task | Section |
|---|---|---|
| 1 | Integration identity + token | 3 |
| 2 | Win/Loss Notes column, Pre-Engineering group, status → group automations | 2.1–2.3 |
| 3 | Sandbox build + test (with spec team) | 8 |
| 4 | Label cleanup: Win %, Sales Person (BU rename optional, any time) | 1 |
| 5 | Dry run ≥ 5 business days, review diffs | — |
| 6 | Lost/Won notifications | 2.4 |
| 7 | **Cutover:** Zaps off + sync live, same hour | 2.6 |
| 8 | Tell pre-sales team the status toggle is retired | 2.5 |
| 9 | Hope's Queue board + dashboard + views + buttons | 4–7 |
