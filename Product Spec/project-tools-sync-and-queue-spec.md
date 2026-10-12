# Project Tools: Salesforce ↔ monday Sync + Hope's Queue Engine

**Data spec for implementation** · Version 1.0 · October 9, 2026 · Owner: Seth Powell (AVSS)

This document is the build spec for two tightly coupled pieces of the Project Tools engine (Fly.io):

1. **The Salesforce ↔ monday sync**, which replaces the three Zapier automations.
2. **The Hope's Queue engine**, a living task board for the Engineering Workflow Coordinator (Hope).

They share infrastructure (Salesforce connection, link table, event log, failure handling), so build them together. A companion document, *monday Build Guide*, covers everything configured by hand in monday.

---

## 0. Context the implementer needs

**Systems and who owns them**

| System | Users | Role |
|---|---|---|
| Salesforce | Sales team | Record of truth for opportunities, stages, due dates, quote numbers, reps |
| monday.com | AVSS (engineering) | Working system for pre-sales, post-sales, programming |
| CMIC | Operations (future) | Will become ops record of truth; **out of scope now**, design so a third system can be added later |

**Why this exists**

- **The Zap is create-only.** The current Zap fires once, at opportunity creation. If the AV product or due date is missing at that moment, the data never arrives. If a salesperson adds or changes it later, monday never hears about it.
- **It floods the board with leads.** The Zap pulls in Lead and Qualified Opportunity stages, which need no engineering work.
- **AVSS can't enforce data entry outside its own team.** It has no authority over sales or ops data entry. The integration must therefore assume upstream data is incomplete and keep re-syncing for the life of the record.
- **It feeds the rework metrics.** Rework reduction is an explicit goal of the AVSS restructure presented to the ELT. Everything this engine does must be logged so rework can be measured later (§8).

**Phasing**

| Phase | Contents |
|---|---|
| **1A** | Salesforce → monday reconciler, monday → Salesforce writeback, link table, mapping tables, event log, failure tasks |
| **1B** | Hope's Queue engine: task model, recurring report tasks, stage-check tasks, won-triggered tasks, data-cleanliness counts |
| **2** | Morning brief (likely an on-demand Claude skill, not notifications), Salesforce-triggered triage, rework reporting UI |
| Later | CMIC integration, drift-check skill, monday board restructure (handled by the config layer in §2) |

---

## 1. Architecture

```
Salesforce                      Project Tools (Fly.io)                       monday.com
──────────                      ──────────────────────                       ──────────
Record-triggered Flows ──POST──▶ /webhooks/salesforce ─┐
 (Opportunity, Opp Product)      (thin event: IDs)      │
                                                        ▼
Hourly safety sweep ◀──SOQL──── Reconciler ──────────────────GraphQL──────▶ Pre-Sales board
 (LastModifiedDate)              │   ▲                                      (create/update/status)
                                 │   │
                                 ▼   │                                       
                           Link table, Mapping tables,                       
                           Event log, Tasks                                  
                                 ▲   │                                       
                                 │   └──────────────GraphQL──────────────▶ Hope's Queue board
                                 │
monday webhooks ──POST──▶ /webhooks/monday ──▶ Writeback (price/GM% → Salesforce)
 (column changes, status)                  └──▶ Queue status changes (Hope's edits)

Engine sweep (every 15 min) ──▶ recurring tasks, close/reopen checks, due-group placement,
                                data-cleanliness counts
```

**Design principles**

- **Thin events, fat fetch.** Webhooks carry only record IDs. Project Tools always re-reads current state from the source system before acting. This makes handling idempotent and makes order of arrival irrelevant.
- **Safety sweep behind every webhook.** Salesforce does not retry failed Flow callouts, and monday webhooks can drop. The hourly sweep makes missed events self-healing.
- **Never write a value you can't map.** Unknown labels never auto-create in monday (`createLabelsIfMissing: false`, always). A mapping miss becomes a failure task (§6.3) and the field is left untouched.
- **Everything is an event.** Every create, field change, status change, task open/close/reopen, and failure is appended to the event log (§3.5).
- **Dry-run mode.** A global flag (`SYNC_MODE = dry_run | live`). In dry run, the engine computes and logs every intended write but performs none. Required for cutover (§11).

---

## 2. Configuration layer (no hard-coded board structure)

A monday board restructure is planned after this ships. **No board ID, column ID, group ID, or label ID may appear in business logic.** Logic refers to semantic names; a config table resolves them.

### 2.1 `config_field_registry`

| semantic_key | board_key | monday_column_id | type | owner |
|---|---|---|---|---|
| `presales.due_date` | presales | `date7` | date (time-enabled) | salesforce |
| `presales.quote_number` | presales | `text8` | text | salesforce |
| `presales.win_pct` | presales | `dropdown__1` | dropdown | salesforce |
| `presales.business_unit` | presales | `dropdown2` | dropdown | salesforce |
| `presales.sales_person` | presales | `dropdown3` | dropdown | salesforce |
| `presales.sf_id` | presales | `text_mkv2656m` | text | salesforce (link key) |
| `presales.project_id` | presales | `text_mm2rcnav` | text | monday |
| `presales.status` | presales | `status9` | status | shared (see §4.6) |
| `presales.quoted_price` | presales | `numbers9` | numbers | monday |
| `presales.gm_pct` | presales | `numbers__1` | numbers | monday |
| `presales.presales_engineer` | presales | `person` | people | monday |
| `presales.contract_date` | presales | `date9` | date | monday (never written by sync) |
| `presales.win_loss_notes` | presales | *(new column, see Build Guide)* | long_text | salesforce |
| `presales.premiere_protect` | presales | `numbers4__1` | numbers | monday |
| `presales.programming` | presales | `dropdown_mkt9zhb9` | dropdown | monday |

Post-sales and Programming board columns are added to the registry at build time (see Build Guide §6 for the field list).

### 2.2 `config_boards` / `config_groups` / `config_labels`

- **Boards.** Pre-Sales Project Summary is `3477536693`. The AV Post-Sales Project Summary, Programming, and Hope's Queue boards are resolved at build time.
- **Pre-sales groups:**

| Group | ID |
|---|---|
| New Requests | `new_group12986` |
| Follow Up | `new_group66048` |
| Won | `new_group52602` |
| Lost | `new_group64129` |
| Declined to Bid | `new_group` |
| Pre-Engineering | *(new, see Build Guide)* |

- **Pre-sales `status9` labels by ID:**

| Label | ID |
|---|---|
| Won | 1 |
| Lost | 2 |
| Service Contract | 4 |
| Not Started | 5 |
| Follow Up | 6 |
| Declined to Bid | 7 |
| Rebid | 8 |
| ON HOLD | 9 |
| Review | 10 |
| In Progress | 0 |

- **Always reference labels by ID, never by text.** On startup and every sweep, verify every configured label ID still exists. If one is missing, open a `config_drift` failure task and halt writes to that column.

---

## 3. Data model

### 3.1 `sf_link`: one row per monday item that mirrors a Salesforce AV line item

| column | type | notes |
|---|---|---|
| id | pk | |
| monday_item_id | bigint unique | |
| monday_board_key | text | `presales` |
| sf_opportunity_id | text | `006…` |
| sf_line_item_id | text unique | `00k…`, the primary sync key |
| link_state | enum | `active`, `archived`, `conflict` |
| last_synced_values | jsonb | per semantic_key: last value written by sync |
| last_sf_modstamp | timestamptz | SystemModstamp at last successful reconcile |
| created_at / updated_at | timestamptz | |

### 3.2 Mapping tables (editable by Hope via a simple admin screen in Project Tools)

Every mapping table has `sf_value`, `monday_label_id`, `active`, `updated_by`, and `updated_at`. Edits are logged as events.

- **`map_business_unit`**
  - Salesforce `Business_Unit__c` → monday `dropdown2` label ID.
  - Seed with today's labels: Northeast → Instrata NE, Mid-Atlantic → Instrata MA, Southeast → Instrata SE, Southwest → Instrata SW. Louisiana is unmapped (this produces a failure task).
  - Seth will later rename the monday labels to match Salesforce exactly. Only the mapping rows change; code does not.
- **`map_win_pct`**
  - `Win_Likelihood__c` → `dropdown__1` label ID, for 0%, 25%, 50%, 75%, and 99%.
  - **100% is special:** it is not a label. It triggers the status action "Won" (§4.6).
- **`map_sales_rep`**
  - `Opportunity.Sales_Rep__r.Name` (source of truth is `Sales_Rep__c`, **not** `OwnerId`) → `dropdown3` label ID.
  - Blank `Sales_Rep__c` → the "House" label.
  - Known mismatches to seed: "Michelle Bravo" → "Michelle Scheller-Bravo", "Wm. Paul Nolan" → "Paul Nolan".
- **`map_stage_action`**: stage → action. Seeded per §4.6 and editable without a deploy.

### 3.3 `task`: Hope's Queue

| column | type | notes |
|---|---|---|
| id | pk | |
| task_type | text | see §6.2 |
| dedupe_key | text unique | e.g. `open_job:13092716583`, `report_pm_weekly:2026-W42` |
| title | text | shown as the monday item name |
| source_ref | jsonb | e.g. `{board_key, monday_item_id, sf_opportunity_id}` |
| queue_item_id | bigint | item on Hope's Queue board |
| status | enum | `not_started`, `in_progress`, `waiting`, `done` |
| due_at | timestamptz null | |
| close_mode | enum | `auto` or `manual` (how it was last closed) |
| reopen_count | int default 0 | |
| open_since | timestamptz null | set on open/reopen, cleared on close |
| total_open_seconds | bigint default 0 | accumulated across open periods |
| created_at / closed_at | timestamptz | |

### 3.4 `webhook_inbox`

Stores the raw payload, source, `received_at`, `processed_at`, `status` (`pending`, `done`, `error`), `error_text`, and `dedupe_hash`. Every inbound webhook is persisted before processing, and a processing worker drains it.

### 3.5 `event_log`: append-only, never updated or deleted

| column | notes |
|---|---|
| id, occurred_at | |
| source | `salesforce`, `monday`, `engine`, `hope`, `admin` |
| entity_type / entity_id | `opportunity`, `line_item`, `monday_item`, `task`, `mapping` |
| event_type | `created`, `field_changed`, `status_changed`, `stage_changed`, `writeback`, `task_opened`, `task_closed`, `task_reopened`, `sync_failure`, `archived`, `notified`, `dry_run_write` |
| field / old_value / new_value | |
| actor | Salesforce user ID, monday user ID, or `engine` |
| correlation_id | ties together all events from one reconcile pass |

### 3.6 `watermark`

Holds `name` and `value` (last successful sweep timestamp per object).

---

## 4. Inbound: Salesforce → monday reconciler

### 4.1 Triggers

1. **Salesforce webhook** (primary). Fires on any create or update of an Opportunity, and on insert, update, or delete of an OpportunityLineItem (§10). The payload is `{object, record_id, opportunity_id}`. Enqueue a reconcile for that `opportunity_id`.
2. **Hourly safety sweep.**
   - Query Opportunities and OpportunityLineItems where `SystemModstamp >= watermark − 10 min`.
   - Collect the distinct opportunity IDs and reconcile each one.
   - Advance the watermark only after the batch succeeds.
3. **Manual reconcile.** An admin endpoint and MCP tool, `reconcile_opportunity(opportunity_id)`, for Hope and Seth.

Reconcile is idempotent. Running it twice in a row must produce zero writes the second time.

### 4.2 Fetch (one query per batch)

```sql
SELECT Id, Name, StageName, Estimate_Due_Date_Time__c, Estimate_Number__c,
       Win_Likelihood__c, Business_Unit__c, Sales_Rep__c, Sales_Rep__r.Name,
       Lost_Reason__c, Other_lost_reason__c, Lost_To__c, SystemModstamp,
       (SELECT Id, isAVProduct__c, Technology__c, UnitPrice, Quantity,
               Sold_in_Margin__c, CreatedDate
          FROM OpportunityLineItems
         WHERE isAVProduct__c = true OR Technology__c = 'AV')
FROM Opportunity WHERE Id IN (:ids)
```

### 4.3 Eligibility to CREATE a monday item

An item is created only when **all** of these hold:

- No `sf_link` exists for the AV line item.
- Exactly one AV line item exists, where AV means `isAVProduct__c = true`, or `Technology__c = 'AV'` as a fallback. Two or more AV line items produce a `multi_av_product` failure task and no item is created.
- The stage is in the creation set: **Engineering, Budget, Rebid, Delivered to Customer, Contract In House.** (Lead and Qualified Opportunity are never created. Closed or terminal stages are never created from scratch.)

Effective rule: *the first time an AV opportunity is seen at Engineering or any later active stage.* This also covers an AV product added after the opportunity already exists, because the OpportunityLineItem Flow fires on insert.

**On create:**

- Item name = `Opportunity.Name`. This is written **once and never updated again**; engineers rename items freely.
- Group = New Requests.
- Write all Salesforce-owned fields (§4.4) and `sf_id` = line item ID.
- Insert the `sf_link` row and log a `created` event.
- Then apply the stage action for the current stage (§4.6).

### 4.4 UPDATE: Salesforce-owned fields (continuous, for the life of the link)

For each linked item, compare the current Salesforce value with `last_synced_values`. If it differs, write it to monday and log the event.

| Salesforce field | monday semantic_key | rule |
|---|---|---|
| `Estimate_Due_Date_Time__c` | `presales.due_date` | Pass the UTC instant through unchanged. **No timezone conversion in code**; rep timezones were corrected in Salesforce on Oct 9, 2026. Write date + time. |
| `Estimate_Number__c` | `presales.quote_number` | Ignore `Quote_Number__c` (always null) |
| `Win_Likelihood__c` | `presales.win_pct` | Via `map_win_pct`. 100% → status action Won (§4.6) instead of a label |
| `Business_Unit__c` | `presales.business_unit` | Via `map_business_unit` |
| `Sales_Rep__r.Name` | `presales.sales_person` | Via `map_sales_rep`; blank → House |
| `StageName` | status / group | Via `map_stage_action` (§4.6), only on stage *change* |

**Rules:**

- **A blank Salesforce value never clears a populated monday value.** Log it as `field_changed` with `new_value = null, applied = false`. This protects values engineers filled in by hand.
- **Never write** item name, quoted price, GM%, Premiere Protect, Programming, engineer columns, Contract Date, or Project ID.
- **Mapping miss:** leave the monday field unchanged, open a `sync_failure` task (§6.3), and continue with the other fields.

### 4.5 Comparison baseline

The baseline is `last_synced_values`, not the current monday value. If someone hand-edits a Salesforce-owned field in monday and Salesforce hasn't changed, the sync does not fight them. The next real Salesforce change wins. (Monday edits to Salesforce-owned fields are logged via webhook as `field_changed` events, source `monday`, for rework visibility.)

### 4.6 Stage actions (`map_stage_action` seed)

These are applied only when `StageName` changes (or on create), not on every reconcile.

| Salesforce stage | Action on monday item | Queue side effect |
|---|---|---|
| Engineering, Budget | none (item stays where it is) | none |
| Rebid | status → Rebid (8) | none |
| On Hold | status → ON HOLD (9), group unchanged | none |
| Delivered to Customer | **no write** | If the item is not in the Follow Up group → task `stage_check_delivered` |
| Contract In House | **no write** | If status ≠ Won → task `stage_check_contract` ("possible automation misfire") |
| Closed Won, or Win_Likelihood = 100% | status → Won (1). Do not touch Contract Date. | won-triggered tasks (§6.2) |
| Closed Lost | Write `win_loss_notes` **and** status → Lost (2) in the **same mutation** | none |
| Declined to Bid | Write `win_loss_notes` (if any reason) + status → Declined to Bid (7) | none |
| Canceled, quoted price populated | Write `win_loss_notes` prefixed "CANCELED — " + status → Lost (2) | none |
| Canceled, quoted price blank | (1) If a pre-sales engineer is assigned, post an item update that @mentions them: "This opportunity was canceled in Salesforce. Please stop work." (2) **Archive** the item (not delete). (3) Set `link_state = archived`. | none |

**`win_loss_notes` format.** Built from `Lost_Reason__c` (picklist, always populated on Lost and Canceled), `Other_lost_reason__c`, and `Lost_To__c`. Skip blank parts. Example:

```
Lost/Canceled Reason: Price · Detail: client went with incumbent · Lost to: Acme AV
```

`Loss_Reason__c` is unused in this org; ignore it.

**Why a single mutation.** The monday notification automation fires on the status change and must be able to include the notes column. Use `change_multiple_column_values` with both columns. Group moves are handled by monday's own status → group automations (Build Guide §2). The sync does not move groups, except to restore an archived item if needed.

**"Won" semantics.** Today, "Won" status with no Contract Date means *Confirmed to Win*. Adding a Contract Date (done by humans) moves it into the sales "Won" pipeline. The sync sets status only and never sets Contract Date. A future "Confirmed to Win" board is part of the restructure; the config layer absorbs that change.

### 4.7 Loop prevention

- **Monday side.** All Project Tools writes to monday use a dedicated API identity (see Build Guide §8). Monday webhook events whose `userId` matches that identity are logged and otherwise ignored.
- **Salesforce side.** Writebacks (§5) trigger the Salesforce Flow, which triggers a reconcile. Because only monday-owned fields changed, §4.4 finds no differences and makes zero writes. This is acceptable and expected.

---

## 5. Outbound: monday → Salesforce writeback

**Trigger.** A monday webhook `change_column_value` on the pre-sales board for `presales.quoted_price` or `presales.gm_pct`, **any time either changes, in any group** (Seth's decision: always override). This replaces the old "status → Follow Up" trigger and removes the need to toggle status to force a push.

**Action:**

1. Look up `sf_link` by `monday_item_id`. If none, open task `writeback_no_link` and stop.
2. Re-read the line item: `UnitPrice`, `Quantity`, `Sold_in_Margin__c`.
3. If `Quantity ≠ 1`, open task `writeback_quantity` and stop. (Writing UnitPrice on a multi-quantity line would multiply the total.)
4. PATCH `OpportunityLineItem`:
   - `UnitPrice` ("Sales Price") = monday quoted price.
   - `Sold_in_Margin__c` (**lowercase "i"**, on the line item) = monday GM%.
   - **Verify percent units at build:** monday stores `35` for 35%, and Salesforce percent fields also take `35`. Confirm against one live record in the sandbox.
5. **Never write Opportunity header fields** (`Estimate_Total__c`, `Margin_of_Project__c`, `Sold_In_Margin__c` with a capital "I"). They affect other trades; that's out of scope by decision.
6. Log a `writeback` event. Debounce per item for 30 seconds so typing in a number field doesn't fire multiple PATCHes.

---

## 6. Hope's Queue engine

### 6.1 Behavior

- **Ownership.** Project Tools owns task state. The Hope's Queue monday board is the display surface.
- **Statuses** (monday labels resolved by ID through config): Not Started, In Progress, Waiting on Someone, Done.
- **Hope edits status in monday.** A webhook updates `task.status`. Hope setting Done counts as a manual close (`close_mode = manual`).
- **Auto-close.** When a task's close condition becomes true, set Done silently (`close_mode = auto`).
- **Reopen.** If a closed task's close condition becomes false again, or its trigger fires again for the same `dedupe_key`:
  - reopen the **same** task
  - increment `reopen_count`
  - set `open_since = now`
  - log `task_reopened`
  - Do not create a duplicate.
- **Open-time accounting.** On close, add `now − open_since` to `total_open_seconds`.
- **Group placement** (every sweep): Today/Overdue (`due_at` ≤ end of today), This Week (`due_at` within 7 days), As Needed (no `due_at`), Background (the data-cleanliness row), Done. On close, a task moves to Done. Hope can archive Done items.
- **Manual items.** Items Hope creates by hand (no engine key) are ignored by the engine except for status event logging.
- **Sweep cadence:** every 15 minutes.

### 6.2 Task types

| task_type | Trigger (creates/reopens) | dedupe_key | due_at | Auto-close condition |
|---|---|---|---|---|
| `sync_failure` | Unmapped value, multi-AV product, config drift, webhook processing error | `sync_failure:{kind}:{entity_id}:{field}` | none | Next reconcile of that entity succeeds for that field |
| `writeback_no_link` / `writeback_quantity` | §5 | `{type}:{monday_item_id}` | none | Next writeback for that item succeeds |
| `stage_check_delivered` | §4.6 | `{type}:{monday_item_id}` | none | Item is in the Follow Up group |
| `stage_check_contract` | §4.6 | `{type}:{monday_item_id}` | none | Item status = Won |
| `won_handoff` | Pre-sales status → Won (from any source) | `won_handoff:{monday_item_id}` | ⚠ open item O-3 | **Manual for v1**: package not yet defined (O-4) |
| `open_job` | Pre-sales status → Won | `open_job:{monday_item_id}` | ⚠ O-3 | Project Number populated on the linked post-sales item (O-5) |
| `report_presales_weekly` | Recurring, weekly on ⚠ O-6 | `report_presales_weekly:{ISO week}` | that day 5 pm ET | Manual (Hope marks sent) |
| `report_pm_weekly` | Recurring, every **Thursday** | `report_pm_weekly:{ISO week}` | Thursday 5 pm ET | Manual |
| `report_avss_monthly` | Recurring, monthly on ⚠ O-7 | `report_avss_monthly:{YYYY-MM}` | that day 5 pm ET | Manual |
| `triage` | **v1: manual** (Hope or Seth creates the item; engine adopts it via a "Task Type = Triage" label). v2: Salesforce-triggered (Phase 2) | `triage:{monday_item_id}` | none | Manual |
| `data_cleanliness` | Single persistent row, created once | `data_cleanliness:singleton` | none | Never closes. The engine writes the current exception count to its Count column every sweep |

**Report tasks.** The Claude report skills may also mark their task "In Progress" via MCP when generated. Hope sets Done when sent. "Sent" is the real done, so the engine never auto-closes report tasks.

### 6.3 Failure tasks

Failure tasks are how integration problems surface: Hope's board is the place they appear, not a log nobody reads. Each one includes:

- the entity link
- the unmapped value or the error
- the mapping table to fix

Hope owns mapping-table maintenance and uses the data dictionary (a separate living document Seth is building) as the source of truth.

### 6.4 MCP tools to add

| tool | purpose |
|---|---|
| `queue_list(status?, type?)` | read Hope's queue (also used by the Phase 2 brief skill) |
| `queue_set_status(task_id, status)` | skills mark report tasks in progress |
| `reconcile_opportunity(opportunity_id)` | manual re-sync |
| `sync_failures_list()` | open failure tasks |
| `events_query(entity_id?, type?, since?)` | rework analysis and debugging |

---

## 7. Data-cleanliness exception counts

The *lists* of exceptions are monday filtered views (Build Guide §6), so they maintain themselves. The engine only computes the **count**, for the Background row and for dashboard trend tracking.

**Rule** (v1, from Hope's working guide): an item counts as an exception if it is outside the New Requests group and one of the fields below is blank.

| Board | Fields |
|---|---|
| Pre-Sales | Quoted Price, Estimated GM %, Premiere Protect, Programming (Y/N), Quote Number, Win %, Business Unit, Salesperson |
| Post-Sales | Project Manager, Pre-Sales Engineer, Programmer, Cutsheet Submittals Date, Shop Drawing Due Date, Project Number |
| Programming | Pre-Sales Engineer, Post-Sales Engineer, Business Unit, Project Manager, Manufacturer |

**Details:**

- **Store rules in config** (`config_cleanliness_rule`: board_key, semantic_key, applies_when, exempt_when) so legitimately blank cases can be added without a deploy. Example: Programmer is blank when Programming = No. See open item O-8.
- **Exclude terminal groups** (Lost, Declined to Bid) from pre-sales exceptions.
- **Snapshot daily.** Store one row per day in `cleanliness_snapshot` (date, board_key, field, count) for trend reporting.
- **Expect counts to drop at cutover.** Quote Number and Salesperson are filled by the sync once it is live, so those counts should fall sharply.

---

## 8. Rework data (capture now, report later)

Seth will build rework metrics for pre-sales, post-sales, and Hope's queue. **This phase only guarantees the raw data exists**; there is no reporting UI. From `event_log` and `task` it must be possible to derive:

- task reopen counts and total open time, per task type and per project
- due-date change count per opportunity, and the size of each change
- stage regressions (e.g. Delivered to Customer → Rebid)
- quoted price / GM% change count after the first writeback (re-pricing)
- monday status bounces (e.g. Follow Up → In Progress → Follow Up)

Turn on Salesforce Field History Tracking for `StageName`, `Estimate_Due_Date_Time__c`, `Estimate_Number__c`, and `Win_Likelihood__c` (already on) and leave it on. It is no longer the trigger, but it is a second source for before/after values.

---

## 9. Security and secrets

- **Salesforce → Project Tools.**
  - Salesforce authenticates with a shared secret header, configured on the Named Credential / External Credential.
  - Project Tools rejects requests without it.
  - Rotate the secret via a Fly secret plus the External Credential.
- **monday → Project Tools.**
  - Answer monday's webhook `challenge` handshake.
  - Verify the `Authorization` JWT using the app signing secret, when registering via an app. If registering with a personal token, use the shared-path-secret pattern.
- **Project Tools → Salesforce.** Use a connected app with OAuth client credentials or JWT bearer flow, running as a dedicated integration user with least-privilege permissions:
  - read Opportunity and OpportunityLineItem
  - edit OpportunityLineItem `UnitPrice` and `Sold_in_Margin__c` only
- **Secrets** live only in Fly secrets. Never in the repo or in config tables.

---

## 10. Salesforce-side configuration (built by Seth as admin; build in the `partial` sandbox first)

1. **Named Credential + External Credential:**
   - Name: `AVSS_ProjectTools`.
   - Base URL: the Project Tools webhook host. Use the **test** endpoint for the sandbox.
   - Custom header: `X-AVSS-Secret`.
2. **Record-triggered Flow `AVSS_Opportunity_Changed`:**
   - Object: Opportunity. Runs after create or update.
   - Entry condition: none. Project Tools decides relevance, which keeps the Flow trivially simple.
   - **Run asynchronously** (async path is required for callouts).
   - Action: HTTP Callout POST `/webhooks/salesforce` with body `{"object":"Opportunity","record_id":{!$Record.Id},"opportunity_id":{!$Record.Id}}`.
   - Optional optimization: entry condition "has an AV line item" via a roll-up or formula field. Not required.
3. **Record-triggered Flow `AVSS_OppProduct_Changed`:**
   - Object: OpportunityLineItem. Runs after create, update, or delete. (Delete is needed so removing the AV product is seen; for delete, use `$Record__Prior`.)
   - Same callout with `opportunity_id = {!$Record.OpportunityId}`.
4. **Integration user + connected app** for Project Tools API access (§9).
5. **Sandbox notes:**
   - The Partial Copy sandbox `partial` was last modified Oct 2025. Confirm with the other admins that nobody is using it, then **refresh** before testing.
   - Login is at test.salesforce.com with your username plus `.partial`.

---

## 11. Cutover plan

| Step | What | Exit criteria |
|---|---|---|
| 1 | Build against the `partial` sandbox plus a **copy** of the pre-sales board (or the dry-run flag against the real board) | Flows fire; reconcile and writeback round-trip correctly |
| 2 | **Backfill link table** from the existing board (1,813 items; ~461 have a Salesforce ID) | Every `00k…` ID is linked. `006…` (opportunity) IDs are resolved to their single AV line item, or flagged. Unresolvable items get a `sync_failure` task. Items without an ID are left alone (no auto-matching by name in v1). |
| 3 | **Pre-engineering cleanup**: linked items whose opportunity stage is Lead or Qualified Opportunity | Moved to the new Pre-Engineering group, not deleted. The reconciler moves them to New Requests the first time they reach a creation-set stage. |
| 4 | **Dry run in production** for at least 5 business days, Zapier still live | Daily diff report: intended writes vs. what Zapier did. Seth reviews. |
| 5 | **Mapping prerequisites** done (Build Guide §1) | No unmapped Win % or BU values in the dry-run log |
| 6 | **Switch:** turn off all three Zaps, then set `SYNC_MODE = live` (same hour) | First live reconcile has zero errors |
| 7 | Hope's Queue engine live (Phase 1B) | Recurring tasks appear; failure tasks route correctly |

---

## 12. Known gotchas (read before coding)

- **Field history filters.** `OpportunityFieldHistory.NewValue` / `OldValue` cannot be used in SOQL WHERE or GROUP BY. Filter on `Field` and `CreatedDate` only, then evaluate in code. (This only matters for rework queries now; it's no longer the trigger.)
- **Two margin fields.** `Sold_In_Margin__c` (Opportunity, capital I) and `Sold_in_Margin__c` (OpportunityLineItem, lowercase i) are **different fields on different objects.** Only the line-item one is written.
- **Quote number field.** `Quote_Number__c` is null everywhere. The quote number is `Estimate_Number__c`.
- **Salesforce ID column.** Monday's Salesforce ID column holds **line item IDs** (`00k…`). At least one item holds an opportunity ID (`006…`, e.g. "UC Water – Soundmasking"); handle that in the backfill.
- **Junk labels.** The Sales Person dropdown contains junk labels ("c", "doug", "TON") from past auto-creation. Never auto-create labels.
- **Win % "0" label.** The monday label is currently "0", not "0%". The Build Guide renames it; map by label **ID** so the rename doesn't matter.
- **Due date time.** Monday date columns with time store UTC and display in each viewer's timezone. Pass the Salesforce instant through; do not convert.
- **Status label order.** The In Progress status label (ID 0) was moved to the end of the label order on Oct 9, 2026. IDs are unchanged.

---

## 13. Open items (do not block Phase 1A)

| # | Item | Blocks |
|---|---|---|
| O-1 | Sandbox use confirmed by other admins (Seth emailing) | Step 1 testing |
| O-2 | Post-Sales and Programming board IDs and column IDs added to config | §7 counts |
| O-3 | Due-date rule (SLA) for `won_handoff` and `open_job` tasks, e.g. N business days after Won | §6.2 due_at |
| O-4 | Pre-to-post handoff package definition (Seth → approved by Kelina, Isaac, Chris) | `won_handoff` auto-close |
| O-5 | Where Project Number originates and how the post-sales item links to the pre-sales item (Project ID column?); trigger point for open job: Won (confirmed to win) or Contract Date added? | `open_job` trigger + close |
| O-6 | Day of week for the pre-sales-by-salesperson report | recurring schedule |
| O-7 | Which business day the monthly AVSS report goes to Lee | recurring schedule |
| O-8 | Legitimate-blank exemptions per data-cleanliness field (e.g. Programmer when Programming = No; Project Number before job opened) | §7 accuracy |
| O-9 | Should SE accounting take over opening jobs, `open_job` becomes "request + confirm" | future |
| O-10 | Ping mechanism for data cleanliness: Hope-initiated button (Build Guide default) vs. engine auto-ping after N days | Phase 2 |
| O-11 | Morning brief format (on-demand skill vs. notification), to discuss with Hope | Phase 2 |

## 14. Explicitly out of scope

- CMIC integration
- Writing Opportunity header totals
- Syncing Salesforce opportunity Comments / Description (too inconsistent to be useful)
- Timezone conversion
- Updating item names from Salesforce
- Rework reporting UI
- The drift-check skill
- The monday board restructure (accommodated through §2, not performed)
