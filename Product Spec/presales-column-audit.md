# Pre-Sales board column audit

Board: **AV Pre-Sales Project Summary** (`3477536693`, production, 1,814 items). Audited 2026-10-15, read-only. Nothing was changed on monday, in the repo, or in any setting. This document decides nothing: the verdict column is a suggestion for Seth.

## Summary

The board has **29 columns** (including the built-in Name and Subitems). Of these:

| Group | Count | Columns |
|---|---|---|
| Engine reads or writes it | 11 | Name, Pre-Sales Engineer, Due Date, Quote Number, Win Percentage, Business Unit, Status, Quoted Price, Estimated GM %, Sales Person, Salesforce ID |
| In the engine's config registry but the engine never touches it; something else uses it | 4 | Project ID, Contract Date, Premiere Protect $, Programming |
| Derived or reporting only (7 formulas plus the two date columns that feed *Duration*) | 9 | Labor+Materials Price, Estimated GM $, Est. PP GM $, $ Category, Duration, Quarter Won, Effort Level, Delivered, Received On |
| Only the Change Order form (and one native workflow) uses it | 2 | Client, Long text |
| **No consumer found anywhere I could look** | **3** | **Subitems, RFI Due Date, Proposal Type** |

So **3 of 29 columns (10%) have no consumer found**, and another 11 (38%) exist only for reporting, derived math or a form. Counting both, 14 of 29 (48%) are not used by the sync engine, the edge functions or the app, which is more than Seth's 25% guess. That 14 is not a delete list. Several are read by the `avss-monthly-report` skill, and monday dashboards are unreadable from here (see the limits below).

### What could not be checked (read this before trusting "none found")

1. **monday dashboards/widgets: unknown for every column.** The connector can list dashboards by name but exposes no widget settings or board/column bindings (the Dashboard and Widget types have no such fields, and the Objects relations query returned nothing). 11 shared dashboards look related by name and about 11 private "<name> - In Process" dashboards exist (list below). Open each one in monday to see which columns its widgets use. Until then, no column's "none found" is final.
2. **Zapier: unknown for every column.** The three Zaps exist and act on the board (plan M-8 in `sync-and-queue-implementation-plan.md`, which is not yet filled in; `sync-build-handoff.md` item 5 notes the Zap monday user id is still missing). Their column use cannot be read from here. The plan's dry-run diff (A11) is meant to reveal what the Zaps write, so Seth can use that to close this gap. The engine's spec says the Zaps are create-only and fed by Salesforce, so the five Salesforce-owned columns and Salesforce ID are the likely ones.
3. **Skills and reports outside this repo.** I read `avss-monthly-report` (synced to Seth's machine). I could not find the `weekly-presales-by-salesperson` skill on disk, so I only know its description: it groups by Sales Person, uses Win Percentage and the New Requests / Follow Up groups, and reads `#update` comments. Treat that skill as using Sales Person, Win Percentage and Status/group, unconfirmed.
4. **Saved filters, personal views, and monday Docs** were not inspected beyond the board's four views.
5. **Formula fill rates** could not be measured (the connector returns empty text for formulas without a fragment). Their fill follows their inputs.

## Column table

"Fill" is the share of the 1,814 items with a non-empty value, then in brackets the share among the newest 200 items (ids 13.0B to 18.4B), a rough sign of whether people still use the column. Automation numbers are ids from `list_automations`. "Engine" means `sync-engine/src`; "registry" means the `config_field_registry` seed in `supabase/migrations/add_sync_and_queue.sql` (unchanged by `sync_intake_boards.sql`, which reuses the same ids on the intake boards).

| Column id | Title | Type | Used by | Notes | Suggested verdict |
|---|---|---|---|---|---|
| `name` | Name | name | engine, edge fn, app, automation | Built-in. Engine matches and titles tasks by it; Won to Post-Sales copies it. | keep |
| `subitems` | Subitems | subtasks | none found | Points at board 3655282941 ("Subitems of AV Pre-Sales Project Summary", 7 items). The engine's move mapping skips subtasks. | candidate to remove (check the 7 subitems first) |
| `person` | Pre-Sales Engineer | people | engine, edge fn | Registry `presales.presales_engineer`; engine snapshot reads it (`reconcile/snapshot.ts`). `monday-manager-dashboard` uses it for the Admin Triage card (due date set and no assignee). The live Won to Post-Sales automation does **not** copy it (Post-Sales and Programming each have their own Pre-Sales Engineer column). Fill 89% (81%). | keep |
| `date7` | Due Date | date | engine, edge fn, automation, form | Registry `presales.due_date` (Salesforce-owned, written by the engine, with first-link review logic in `plan.ts`). Edge fn uses it as the Triage sort key. Review-status email #412056014 prints it. Visible question on the Change Order form. Fill 59% (86%). | keep |
| `text8` | Quote Number | text | engine, skill | Registry `presales.quote_number` (Salesforce-owned). `avss-monthly-report` filters on `text8` starting with the year. Fill 85% (86%). | keep |
| `dropdown_mkt9zhb9` | Programming | dropdown | automation | Registry `presales.programming` (monday-owned; engine never reads or writes it). Automation #451928469: status to Won **and** Programming = Yes creates an item on the Programming board (9358385694) and sends three emails. Planned data-cleanliness rule in the sync spec (§7), not built. Fill 38% (64%). | keep |
| `dropdown__1` | Win Percentage | dropdown | engine, skill | Registry `presales.win_pct` (Salesforce-owned). Drives the confirmed-win logic and `map_win_pct`. `avss-monthly-report` groups the Follow Up pipeline by it. Fill 80% (95%). | keep |
| `dropdown2` | Business Unit | dropdown | engine, automation, skill, form | Registry `presales.business_unit` (`map_business_unit`). Live Won to Post-Sales automation #143056407 copies it to Post-Sales Business Unit. Monthly report groups by it. Visible on the form. Fill 93% (97%). | keep |
| `status9` | Status | status | engine, edge fn, automation, skill | Registry `presales.status`. Engine reads and writes it; `monday-webhook` and `monday-backfill` read it; the `create_pulse` and `change_status_column_value` webhooks (#603823824, #603824562, #603824632) fire on it. About 30 native automations key on it (group moves, emails, Won copy, date stamps, review email). | keep |
| `numbers9` | Quoted Price | numbers | engine, automation, formula, skill | Registry `presales.quoted_price`; triggers the Salesforce writeback. Won to Post-Sales copies it. Inputs to four formulas. Printed in emails #266125415, #412056014, #412057724. Old webhook #463066419 fires on it (PROJECT_DOCS §6 says current code ignores that webhook). Monthly report sums it. Fill 88%. | keep |
| `formula6__1` | Labor+Materials Price | formula | formula, skill | `{numbers9}-{numbers4__1}`. Read by `avss-monthly-report`. Pure derived value. | move reporting into Project Tools |
| `numbers__1` | Estimated GM % | numbers | engine, formula, skill | Registry `presales.gm_pct`; triggers the writeback. Input to Estimated GM $. Fill 82%. | keep |
| `formula__1` | Estimated GM $ | formula | formula, skill | `({numbers9}-{numbers4__1})*{numbers__1}`. Read by the monthly report. | move reporting into Project Tools |
| `numbers4__1` | Premiere Protect $ | numbers | formula, skill, dashboard (by name) | Registry `presales.premiere_protect` (engine never reads or writes it; the spec says the sync never writes it). Input to Labor+Materials Price, Estimated GM $ and Est. PP GM $. Monthly report sums it and splits Premiere Protect out as service-contract lines. A "Premiere Protect" dashboard exists. Fill 76% (67%). | keep until the reports that sum it move; it is a data input, not just reporting |
| `formula0__1` | Est. PP GM $ | formula | formula, skill | `{numbers4__1}*0.7`. The 70% is hard-coded. Read by the monthly report. | move reporting into Project Tools |
| `dropdown3` | Sales Person | dropdown | engine, skill, form | Registry `presales.sales_person` (`map_sales_rep`). Monthly report and the weekly presales skill (description only) group by it. 79 labels, including junk labels such as "c", "doug" and "TON". Visible on the form. Fill 96%. | keep |
| `text9` | Client | text | form | Visible question "Client Contact" on the Change Order form. No code, engine or automation use. Post-Sales has its own Client column and is not fed from this one. Fill 21% (26%). | candidate to remove (after the form question) |
| `date9` | Contract Date | date | automation, formula, skill | Registry `presales.contract_date` (monday-owned; the spec says the engine never writes it). Live Won to Post-Sales automation copies it to Post-Sales Win Date. Automation #142128870 also stamps it with today when status becomes Lost, which is why 463 of 499 Lost items have one. Drives Quarter Won. The monthly report defines Confirmed-to-Win as Won group **and** empty `date9`. Fill 70% (43%). | keep (the Won/Confirmed-to-Win definition depends on it) |
| `date_mkkymq9d` | Delivered | date | automation, formula | Automation #375165951 stamps it with today when status becomes Follow Up. Only reader found: Duration. Hidden question on the form. Fill 52% (68%). | move reporting into Project Tools |
| `formula5__1` | $ Category | formula | formula | Buckets `{numbers9}` into $50k / $100k / $200k / $500k bands. No code consumer found. Dashboards unknown. | move reporting into Project Tools |
| `date_Mjj46eII` | Received On | date | automation, formula | Automation #368120093 stamps it with today on item creation. Only reader found: Duration. Salesforce creation date could replace it. Hidden question on the form. Fill 66% (100%). | move reporting into Project Tools |
| `date_mkzznx91` | RFI Due Date | date | none found | Only 29 items (2%; 4 of the newest 200). Appears only in the board's own table views' column order. | candidate to remove |
| `formula_mkkyf7eq` | Duration | formula | formula | `DAYS({date_mkkymq9d}, {date_Mjj46eII})`. No consumer found beyond dashboards (unknown). | move reporting into Project Tools |
| `formula_mkkaswha` | Quarter Won | formula | formula, dashboard (by name, "2025 AV Dashboard"/"2026 AV Dashboard") | Uses `date9` with **hard-coded 2025 thresholds**: any contract date on or after 2025-10-01, including all of 2026, returns "Q4". It is wrong for 2026 as written. | candidate to remove, or rebuild in Project Tools |
| `formula_mkpp4jef` | Effort Level | formula | formula, dashboard (by name, "AVSS Effort Levels") | Tiers `{numbers9}` into a 1-20 score. Post-Sales has its own different formula (1-5 scale) on its copied price. | move reporting into Project Tools |
| `text_mkv2656m` | Salesforce ID | text | engine | Registry `presales.sf_id`. The engine's link key: written at item creation, read by backfill and reconcile. Fill 27% (60%; it is only filled since the sync). | keep |
| `text_mm2rcnav` | Project ID | text | edge fn, automation, skill | Registry `presales.project_id` (monday-owned). Written by `monday-webhook` and `monday-backfill`; copied to Post-Sales Project ID by the live Won automation, which keeps the `project_code` link alive. Monthly report uses it to look up Post-Sales Project Numbers. Fill 47% (74%). | keep |
| `long_texti86ie75q` | Long text | long_text | form, automation | Question "Change Order Details" on the Change Order form, and the only native workflow (#7919517848, "When column changes, create an update on item with this text"). 4 items have a value. **This is not the planned Win/Loss Notes column** (`presales.win_loss_notes`, no column id yet; handoff step 9 still has it to create on prod). | candidate to remove (with the change-order workflow); do not reuse for Win/Loss Notes by accident |
| `dropdown_mm5xxd5m` | Proposal Type | dropdown | none found | Labels Bid / Negotiated. Hidden in the board's "Table" view. No code, engine, automation or formula use found, but 70% filled and 88% of the newest 200, so people fill it in, probably for a filter or a dashboard widget. | review: ask who uses it before deciding |

## Evidence by area

### Sync engine (`sync-engine/src`, registry seeds)

The registry seeds 15 `presales.*` keys (`add_sync_and_queue.sql`, lines 520-536). Their real use in code:

- **Salesforce to monday, read and written:** `due_date`, `quote_number`, `win_pct`, `business_unit`, `sales_person` (`reconcile/normalize.ts`, `plan.ts`). `sf_id` is written when an item is created or linked.
- **Read for logic or writeback:** `status`, `quoted_price`, `gm_pct`, `presales_engineer` (`reconcile/snapshot.ts`, `writeback/run.ts`, `worker/mondayEvents.ts`).
- **Seeded but never used by code:** `project_id`, `contract_date`, `premiere_protect`, `programming`, and `win_loss_notes` (null column id on prod; used only by tests and reconcile once configured). The sync spec says the engine never writes the first four.
- The engine fetches only the snapshot columns by id (`getItems(..., snapshotColumnIds)`), so unregistered columns are never read. Its monday webhook subscribes to all column changes and filters in code.
- **Cross-board moves:** `columnMappingFor` (`monday/client.ts`) lists every source column and sets the target to null if the column is missing on the target. Formula, name and subtasks columns are skipped. Removing a column on Pre-Sales therefore does not break moves.
- The Salesforce-to-board side relies on column **titles** only in report text (`plan.ts` field labels); ids come from the registry.

### Edge functions and app

- `monday-manager-dashboard`: `date7`, `person`, `status9`, plus the group titled "New Requests".
- `monday-webhook`: `status9` and `text_mm2rcnav` only.
- `monday-backfill`: `status9` and `text_mm2rcnav` only.
- `app/`: no column ids. The Settings modal only links to the board and items (`ProjectSettingsModal.tsx`), and "Premiere Protect" and "Quote Number" in `app/` are DTools gross-margin concepts, not board reads.
- `mcp-server/`, `procore-mcp-server/`, `scripts/`: no Pre-Sales column ids.
- `PROJECT_DOCS.md` §6 documents `status9`, `text_mm2rcnav`, `date7`, `person`, `numbers9` (the old webhook only) for the board.

### Native automations (42 total on the board)

41 older-style automations (28 active, 10 deactivated, 2 in error, 1 disabled by user) plus 1 workflow.

- **Won to Post-Sales (live):** #143056407, active, edited 2026-04-25. On status = Won it creates a Post-Sales item (group `new_group12986`) copying: Name; Status; Business Unit (`dropdown2` to Post-Sales `dropdown6`); Quoted Price (`numbers9`); Contract Date (`date9` to Post-Sales Win Date `date__1`); Project ID (`text_mm2rcnav` to `text_mm2rsn`). **Nothing else is copied.**
- **Two other automations still point at Post-Sales and use columns that no longer exist on Pre-Sales:**
  - #143054939 (2022, active): on Won, duplicate with updates and move to Post-Sales; mapping lists `dropdown5`, `dropdown`, `dropdown6`, `email`, `person`, `numbers`, `files`.
  - #143058725 (2024, active): on Service Contract, moves to group `new_group31806` (not one of the five current groups) and creates a Post-Sales item with the same old mapping.
  - Worth checking whether #143054939 and #143056407 both firing on Won produces duplicates on Post-Sales. I could not tell from here.
- **Notification emails (all active):** #266125415 (Follow Up: name, Quoted Price), #412056014 (Review: name, Quoted Price, Due Date), #412057724 (Won: name, Quoted Price, two recipients), #451928469 (Won with Programming = Yes: creates a Programming board item and sends three emails).
- **Date stamps:** #368120093 (creation: Received On), #375165951 (Follow Up: Delivered), #142128870 (Lost: Contract Date and move to Lost group).
- **Orphaned date triggers:** #146083551, #146083621, #146083657 (active) fire on a column id `date`, which is not on the board now. Presumably no-ops.
- **Status to group moves:** about 13 automations key only on `status9`. Two are in error pointing at groups that no longer exist.
- **Webhooks:** #463066419 (numbers9, old), #603823824 and #603824632 (status9), #603824562 (item created) feed Project Tools.
- **Workflow:** #7919517848 on `long_texti86ie75q`.
- Run statistics (which of these still fire) could not be read: the statistics tool failed on the 10-digit board id.

### Board views and the Change Order form

The "Change Order Request" form shows: Name, Due Date, Business Unit, Sales Person, Client, and Change Order Details (`long_texti86ie75q`). It also lists as hidden: Subitems, Pre-Sales Engineer, Programming, Win Percentage, Status, Quoted Price, GM %, Premiere Protect, Contract Date, Delivered, Received On, Salesforce ID. Deleting a hidden question's column only removes that hidden entry. The "Due Dates" and "Table" views list column ids of columns that are already deleted (`hard_date`, `text1`, `text`, `numbers2__1`, `files5`, `priority`, `color_mkqcp56g`, `text_mkqcpzzt`, `long_text_mm3awjq0`), so the board has been cleaned up before and old ids linger in view settings.

### Formula dependency map

| Formula | Reads |
|---|---|
| Labor+Materials Price `formula6__1` | `numbers9`, `numbers4__1` |
| Estimated GM $ `formula__1` | `numbers9`, `numbers4__1`, `numbers__1` |
| Est. PP GM $ `formula0__1` | `numbers4__1` |
| $ Category `formula5__1` | `numbers9` |
| Duration `formula_mkkyf7eq` | `date_mkkymq9d`, `date_Mjj46eII` |
| Quarter Won `formula_mkkaswha` | `date9` |
| Effort Level `formula_mkpp4jef` | `numbers9` |

No formula reads another formula. Deleting `numbers4__1`, `numbers9`, `numbers__1`, `date9`, `date_mkkymq9d` or `date_Mjj46eII` breaks the formulas above (and Post-Sales has its own Effort Level formula reading its own copy of `numbers9`).

### monday dashboards found by name (column bindings not readable)

- Likely Pre-Sales: Pre-Sales List (14645888), Pre-Sales Trajectory (27963928), RF Pre-Sales Project Summary Dashboard (34918817), Premiere Protect (30838198).
- Management/AV reporting: 2025 AV Dashboard (28229367, updated 2026-09-04), 2026 AV Dashboard (34920206), 2025 AV Review Dashboard (34647469), AV Contracted By Month (35164910), AVSS Effort Levels (29931871, updated 2026-06-23), two "Premiere Dashboard" (21179435, 27949918), AV Post-Sales (28045267).
- Private per-person "In Process" dashboards in the Pre-Sales workspace (about 11, for example Seth Powell, Isaac Garner, Kelina Bauman). They most likely filter on Pre-Sales Engineer and Status.
- The dashboards I could not match to a column are the main risk for the "none found" claim.

### Skills outside the repo

`avss-monthly-report` reads `date9`, `text_mm2rcnav`, `numbers9`, `formula6__1`, `numbers__1`, `formula__1`, `numbers4__1`, `formula0__1`, `dropdown3`, plus `dropdown2`, `dropdown__1`, `text8` and the Won/Follow Up group ids, and relies on three formulas and the Premiere Protect column. It must be repointed before those columns go.

## Other things noticed (not acted on)

- Win/Loss Notes (`presales.win_loss_notes`) and the Pre-Engineering group are not on the prod board yet, so do not treat `long_texti86ie75q` as that column.
- `formula_mkkaswha` (Quarter Won) is wrong for 2026 dates as written.
- Sales Person has 79 labels, including junk ones ("c", "doug", "TON") and a deactivated one.
- The Programming board (9358385694) has its own Pre-Sales Engineer, Business Unit and Project Number columns, and Post-Sales has its own Pre-Sales Engineer, Client and Business Unit columns. Nothing mirrors or relates to the Pre-Sales board, so removing Pre-Sales columns cannot break a mirror or board-relation column on those two boards.
