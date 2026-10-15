# Sync Engine Build — Handoff

**Read this first in a new session**, together with `PROJECT_DOCS.md`.
Last updated: Oct 15, 2026 (end of session 2) · Branch: `salesforce-automations-and-dashboards` (local, not pushed; branched from `dev`)

Specs: `project-tools-sync-and-queue-spec.md` (the build spec) · `monday-build-guide.md` (manual monday config) · `sync-and-queue-implementation-plan.md` (the plan; §9 is the full manual checklist) · `salesforce-sandbox-setup-guide.md` (Salesforce clicks; Parts A and B done)

---

## 1. How Seth wants to work

- **One step at a time, in chat.** Number them ("Step 20"). Seth replies "Step N done". He found bouncing between the chat and the guide confusing, so don't send him to the guide.
- **Windows + PowerShell 5.1.** Give PowerShell commands, not bash. `openssl` isn't available. The `fly` CLI is installed and logged in on his machine.
- **Secrets live in his password manager.** Never ask him to paste a secret into chat. Scripts read secrets from the **clipboard** (`sync-engine/scripts/*.ps1`). He pastes into prompts with right-click; Ctrl+V doesn't work in hidden prompts.
- **Ask before committing**, every round. He has always said yes, but ask. Commit message footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Explain monday/Salesforce UI steps concretely. Salesforce Setup labels differ from docs, so give Quick Find terms.

## 2. Where things stand

**Engine (`sync-engine/`, Node/TS).** Built: reconcile planner + executor, Salesforce and monday clients, dry-run write gate, webhooks + inbox worker, writeback (30 s debounce in the DB), hourly sweep, monday webhook self-registration, backfill, skip-writes-when-monday-matches, first-pass Won review, and the field-diff review report. Tests: `cd sync-engine && npm test` (68) and `node scripts/verify-sync-reconcile.mts` (36 planner cases). **Everything is committed.**

**Commits on the branch:** d9f70b9 schema + planner → e728389 clients/gate/executor → cacda63 webhooks/worker/writeback/sweep → baeba4c 99%/100% + grouped tasks + reps → ed55d28 backfill + skip-unchanged → fc262ac first-pass Won review + diff report.

**Staging is LIVE in DRY RUN.** Fly app `instrata-sync-engine-staging` (one machine, `iad`, `personal` org), `DB_SCHEMA=sync_sandbox`, `SYNC_MODE=dry_run`. It is connected to:
- the Salesforce `partial` sandbox: `https://instrata--partial.sandbox.my.salesforce.com`, user `avsfintegration@instrata.com.partial`, External Client App "AVSS Project Tools", Client Credentials flow
- the monday sandbox board `18435017528` ("AV Pre-Sales Project Summary - Sandbox", zero automations)

It registered its own 3 monday webhooks on the sandbox board. The backfill ran: 420 linked, 52 problems as grouped tasks. The measured drift on those 420 items: Due Date 380 (mostly adding the time), Win % 128, Quote # 47, Sales Person 37, BU 9, Status 1.

**Production Supabase:** both `public` and `sync_sandbox` schemas have the sync tables (migration `add_sync_and_queue.sql` + `sync_confirmed_win_and_new_reps.sql`; both applied). The `sync_engine` DB role has a password (in Seth's password manager).

**Not started yet:** the production engine app, the Salesforce Flows (guide Part C), Project Tools UI (Hope's Dashboard + Sync Admin), MCP tools, the queue engine (Phase 1B), and the Hope's Queue monday board.

## 3. Environment facts (no secrets)

| Thing | Value |
|---|---|
| Supabase project ref | `zeuceafbaufpuwpczcth` (session pooler, port 5432; user `sync_engine.zeuceafbaufpuwpczcth`) |
| monday prod Pre-Sales / Post-Sales | `3477536693` / `3523133226` (account slug `premiere5`) |
| monday sandbox board | `18435017528` (same column + group IDs as prod; no Project ID column). **Private, owners-only edit** since Oct 13 (owners: Seth, AV Integrations). Erik Benson had edited a real item on it by mistake (Pre-Sales workspace owners could edit it while it was public). |
| Intake boards (Oct 14, workspace "Pre-Qualification" `18023927`) | Pre-Qualification prod `18435527184` / sandbox `18435527458` (groups Lead `new_group12986`, Qualified Opportunity `new_group66048`); Triage prod `18435527543` / sandbox `18435527768` (groups Triage `new_group12986`, Bid/No-Bid `new_group66048`, New Assignment `group_mm84ys96`). Duplicated from Pre-Sales: **same 29 column ids and same label ids**. All four private, owners Seth + AV Integrations, **0 automations** (the copy brought 20 each, incl. create-item on prod Post-Sales and Project Tools webhooks; deleted Oct 14). Group ids are reused with different meanings: always resolve per board. |
| monday integration user | "AV Integrations" `119228546` (avsfintegration@instrata.com); member of both prod boards + sandbox; in `fly.toml [env]` |
| monday API version | `2026-07` (current). Edge functions still pin unsupported `2024-10`; a side task was spawned |
| Salesforce prod | `https://instrata.my.salesforce.com`, API v66.0. Opportunity sharing is Public Read/Write |
| Staging Fly secrets (names) | DATABASE_URL, DB_SCHEMA, SYNC_MODE, MONDAY_API_TOKEN, MONDAY_WEBHOOK_PATH_SECRET, SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_WEBHOOK_SECRET, ENGINE_INTERNAL_SECRET (set via `sync-engine/scripts/set-secrets.ps1`) |
| Sales Person labels added | ids 67–79 on BOTH boards (Johnny Price … Robert Lewis), mapped |
| Due Date column | "Include time" (`show_time_by_default`) turned ON on both boards; existing values unchanged |

## 4. Decisions Seth has made (don't re-ask)

1. **Win % 99% and 100% both mean Confirmed to Win** → the sync sets status Won and writes no Win % label. There's no "99%" label. Setting: `config_settings.confirmed_win_pcts`.
2. **Failure tasks are one per missing value** (grouped), listing the opportunities to check, and close when the last one syncs.
3. **First pass on a newly linked item at 99/100% does NOT auto-set Won.** It opens a review task for Hope. Later moves to 99/100% do set Won.
4. **Sound masking etc.:** an AV line is `isAVProduct__c = true OR Technology__c = 'AV'`, as in the spec. 22 lines have AV ticked with another Technology. *(Never explicitly answered — keep the spec rule unless Seth says otherwise.)*
5. Architecture as recommended: a separate Fly app, the `sync_engine` login role, a `sync_sandbox` schema for staging, Hope gets `profiles.is_ops_coordinator`, and tasks are editable from both monday and Project Tools.
6. Erik Benson's Pre-Sales owner role was removed intentionally. Ignore it.
7. **First pass skips closed groups** (Oct 13). A newly linked item in Won / Lost / Declined to Bid gets no writes and no failure tasks; the baseline records Salesforce's values, so later Salesforce edits sync.
8. **First pass keeps monday's Due Date when the DAY differs** (Oct 13). It joins one grouped review task ("Due Date differs from Salesforce"). Same day (adds the time) or blank still writes. An item leaves the task once the dates agree, or when Salesforce changes the date (that writes as usual). Why: monday is usually ~a week later than `Estimate_Due_Date_Time__c` and no other Salesforce date field matches; people move the date in monday.
9. **New intake flow (Oct 14, Seth + Lee).** Two new monday boards, **Pre-Qualification** and **Triage** (Hope + leadership only), stage items BEFORE the Pre-Sales Summary. Source: Seth's "SF to Monday Flow" doc (R1–R7, EC1–EC2). Engine-side: R1 create on Pre-Qual (Lead / Qualified Opportunity), R2 create on Triage/Triage group (Engineering+), R3 Pre-Qual → Triage on stage → Engineering, EC1 Triage → Pre-Qual on stage back to Qualified Opportunity ("Qualified Lead" in the doc), EC2 = Hope task while pre-engineering with an estimate due date (closes on Engineering or date removed). The Pre-Engineering group on the prod Pre-Sales board is **no longer needed**.
10. **Intake still requires an AV product.** No AV line → nothing in monday, at any stage.
11. **Lost / Canceled / Declined while on Pre-Qual or Triage → move to the Pre-Sales Summary's Lost / Declined to Bid group** (status + Win/Loss notes), same as R5.
12. **No-Bid in monday NEVER touches Salesforce, and no reminder task.** The rep's record is theirs (contentious). The engine must not fight it: SF can stay at Engineering while the item sits in Declined to Bid. A No-Bid that becomes a Bid is moved back by hand to Triage / New Assignment; the engine follows.
13. **R4–R7 (Hope's Triage moves): decide later, with Claude, when the boards exist.** Don't treat the doc's automation list as settled.
14. **Boards:** Seth creates both by duplicating the Pre-Sales board structure (same column ids, so cross-board moves keep item id + values), plus sandbox copies, and will send all four board ids.

## 5. Operating the engine (from the repo folder, in PowerShell)

Every command first asks him to copy `Staging – ENGINE_INTERNAL_SECRET`, then press Enter:

```
powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 <command>
```

`status` · `backfill-preview` · `backfill` · `requeue-linked` · `measure-diff` (dry run: reset dry baseline + re-check all) · `diff-report` (CSV to Desktop) · `sweep` · `reconcile 006…`

- **Deploy:** `cd sync-engine; fly deploy -a instrata-sync-engine-staging --remote-only --ha=false`. Always pass `--ha=false`, because Fly otherwise starts two machines.
- **Logs:** Claude can run `/c/Users/Seth.Powell/.fly/bin/fly.exe logs -a instrata-sync-engine-staging --no-tail` from Bash. The buffer is only about 100 lines.
- **Data:** Claude can't query Supabase directly. Give Seth SQL for the SQL Editor (schema `sync_sandbox`). Run one statement at a time; the editor shows only the last result.
- **Read-only checks Claude can run:** the monday connector (`all_api_read`, `get_board_info`) and the Salesforce connector (`dispatch_readonly`, connected to **production**). Board/column writes via `all_api_write` need Seth's OK first.

## 6. Next steps (in order)

1. ~~Review the diff report~~ Done Oct 13: 24 sampled rows matched production Salesforce exactly (sandbox is current, drift is real). Led to decisions 7 and 8.
2. **Deploy + `measure-diff` + `diff-report`** to confirm the new first-pass rules on staging (and get the Confirmed-to-Win review task into the sandbox queue).
3. **Salesforce Flows in the sandbox:** C1–C5 built and active Oct 14 (guide Part C rewritten to match). Verified: Opportunity edit → webhook → reconcile; product add → OppProduct webhook + Amount webhook → multi-AV task; product delete → Amount webhook → task closed. Non-admin callout (C6.2): failed until the credential's principal access was added to the 4 Opportunity-editor profiles (guide C3.4), then worked (Luke Wood login-as, Oct 14). GM% units confirmed Oct 14 (monday 35 → Salesforce 35.00%), after adding **Edit Opportunity Product Sales Price** to the integration permission set (guide A3).
4. ~~Flip staging to LIVE~~ **Done Oct 14** (with `creation_stages` = `[]` in `sync_sandbox` so nothing is created until the intake build; restore/replace it then). First live write: First Tee Charleston quote number. Writeback verified on AGBO AV. Original text: **Flip staging to LIVE** (`fly secrets set SYNC_MODE=live -a instrata-sync-engine-staging`, then restart) so Seth can watch real writes land on the **sandbox board**. Test writeback by editing Quoted Price / GM% on the sandbox board.
4b. **Intake flow (Pre-Qualification + Triage) — built Oct 14, VERIFIED on staging Oct 15** with test opp "AVSS Sync Test - Intake" (`006bb000012DFxGAAW`, item `13296162818`): Lead + AV product → Pre-Qual/Lead; due date added later → written + EC2 task; Engineering → moved to Triage/Triage (same item id, values kept, quote number assigned by SF and synced); Closed Lost → status Lost, then moved to Pre-Sales sandbox / Lost. Fix needed on the way: `move_item_to_board` mapping must list every source column (missing → null). Sandbox `create_items` is now **true**. Details: Planner: create on Pre-Qual (Lead / Qualified, group per stage) or Triage/Triage (Engineering+); on StageName change R3 (Pre-Qual → Triage), EC1 (Triage → Pre-Qual), Lead ↔ Qualified group move; early loss on an intake board → status + notes, then move to Pre-Sales Lost / Declined to Bid; Won (Closed Won or Confirmed to Win) on an intake board → `won_on_intake` task, no status (undecided, ask Seth); EC2 = `sync_failure:prequal_estimate_due:<item>:due_date`, self-closing. All group checks are per board (group ids repeat). Executor: writes to the item's current board, cross-board moves via `move_item_to_board` with an identity column mapping. Webhooks registered on all three boards. Migration `sync_intake_boards.sql` (boards, groups, `prequal_stages`, `create_items` off switch; sandbox starts with create_items = false). **Deploy BEFORE running the migration** (old code ignores create_items). Tests: planner cases 39–48, `test/intake.test.mts`. Still to decide with Seth: R4–R7 (Hope's Triage moves), Won-on-intake behaviour.
4c. **NEW (Seth, Oct 15) — Estimator writeback: Pre-Sales Engineer (monday) → Salesforce Estimator.** Execs keep asking why AV projects never have an Estimator; Seth told his team NOT to fill it in by hand because this automates it. Findings (production, read-only, Oct 15):
   - Field: **`OpportunityLineItem.Estimator__c`, Lookup(User), ONE user per line** (on the line, not the Opportunity). AV opps have one AV line → **one estimator per opportunity**.
   - The org's existing **"Record-trigger: Opportunity Product After Save"** flow reacts to it: when Estimator__c changes it **emails the estimator** ("Estimator Assignment Alert: <opp>"), logs an Opportunity Product History row, and rolls every line's estimator into **`Opportunity.Estimator_IDs__c`** (Text 255, comma-separated; recomputed on every line save, so don't write it directly). Also `isAssignedEstimator__c` / `Opportunity_Products_with_Estimator__c` derive from it.
   - Today's AV-line values are inconsistent (Lee 80, Johnny Price 63, Seth 50, then salespeople), ~60% filled.
   - monday Pre-Sales Engineer (people column `person`) → Salesforce users, matched by NAME (emails differ: several monday accounts are @kane.com). 14 of 16 engineers seen on the board have an active SF user; **no SF user: Chris Garrett, Mitch Barbato**; Dustin Fatherley is inactive in both.
   - **Multiple engineers:** ~10% of items have 2–3 people. Salesforce can hold only one per line → need a rule (e.g. first person in the column = Estimator) — decide with Seth.
   - Needs: integration permission set **Edit on `Estimator__c`** (A3 today allows only UnitPrice + Sold_in_Margin__c); a monday-user → SF-user mapping table (like map_sales_rep); decide unassign/change behaviour, the first-pass rule for existing values, and whether the estimator email is wanted.
5. **Daily dry-run comparison vs Zapier** (plan A11). It needs the monday user ID the three Zaps act as (plan M-8, not yet given).
6. **Project Tools UI:** Hope's Dashboard (`/ops-queue`) + Sync Admin (mappings, cleanliness rules, schedules, activity, the diff report). It needs the small `sync-admin` edge function to reach the engine. Plan §6.
7. **MCP tools** (plan A12): queue_list, queue_set_status, reconcile_opportunity, sync_failures_list, events_query.
8. **Phase 1B queue engine:** the Hope's Queue monday board (ask whether Claude should build it via the connector), task push/placement, recurring report tasks, cleanliness counts. Waiting on Seth for open items O-2, O-3, O-5, O-6, O-7, O-8.
9. **Production:** Salesforce prod integration user + app (repeat Part A in prod), Part C including **principal access on the 4 profiles** (C3.4), `instrata-sync-engine` Fly app with `DB_SCHEMA=public`, backfill on the prod board, the Pre-Engineering group + Win/Loss Notes column on the prod board (Build Guide §2), Flows to prod, ≥5 business days of dry run, then the switch (Zaps off + live in the same hour).

## 7. Lessons learned (avoid re-discovering)

- **monday API:** `Column.settings_str` is gone, use `settings`. Dropdown label edits (`update_dropdown_column`) take the **full** label list, so re-send every existing label with its id (sandbox first, verify after). Date column "Include time" is `settings.show_time_by_default`. `create_update` supports `mentions_list`.
- **Windows PowerShell 5.1:** script files must be **ASCII** (an en-dash becomes a smart quote and breaks parsing). Piping to a native exe **prepends a BOM** even with a no-BOM encoding, so pass arguments instead. Ctrl+V types one character into `Read-Host -AsSecureString`. Don't name variables `$args`. Enable TLS 1.2 for `Invoke-RestMethod`.
- **Claude's shell:** never put backticks or `${}` inside `node -e "…"`. Bash runs them as commands. Edit code with the Edit tool. Validate `.ps1` files with the PowerShell parser before handing them over.
- **Salesforce Flow (Oct 14):** an async path on "created or updated" activates only if every entry condition is **Is Changed**; "only when updated to meet the condition requirements" does **not** fire on create (use a create-only trigger); External Service names are alphanumeric only; a Flow callout treats any HTTP status as success (watch `salesforce webhook rejected` in the engine log). The engine logs a reconcile only when it plans a monday write; check `webhook_inbox` for silent ones.
- **The Salesforce "Developer Console"** now opens the VS Code-style Web Console, which has no query editor.
- **Supabase SQL Editor** shows a false "RLS not enabled" warning on migrations that enable RLS in a `DO` loop.
- **Fly** creates two machines on a first deploy. Use `--ha=false` / `fly scale count 1`.
- **Stale line-item IDs on the board are real:** some "not found" IDs are purged in production too, probably products removed and re-added. They will appear as backfill tasks in production.
- **The sandbox's Salesforce data is a partial sample**, so the sandbox can't confirm whether an ID is missing in production. Check production read-only.
