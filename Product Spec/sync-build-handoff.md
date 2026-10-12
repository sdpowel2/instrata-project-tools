# Sync Engine Build — Handoff

**Read this first in a new session**, together with `PROJECT_DOCS.md`.
Last updated: Oct 12, 2026 (end of session 1) · Branch: `salesforce-automations-and-dashboards` (local, not pushed; branched from `dev`)

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
| monday sandbox board | `18435017528` (same column + group IDs as prod; no Project ID column) |
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

1. **Review the diff report** (Step 19, in progress when this was written). Seth opens the CSV and reports anything surprising. Adjust the sync rules if needed.
2. **Optional:** run `measure-diff` once more, so the sandbox queue gets the first-pass "Confirmed to Win" review task (the earlier pass predates that feature).
3. **Salesforce Flows in the sandbox:** guide Part C (C1–C6). Walk Seth through it step by step, then test edit → webhook → reconcile, OLI delete behavior, the non-admin user callout, and **GM% percent units** on one record.
4. **Flip staging to LIVE** (`fly secrets set SYNC_MODE=live -a instrata-sync-engine-staging`, then restart) so Seth can watch real writes land on the **sandbox board**. Test writeback by editing Quoted Price / GM% on the sandbox board.
5. **Daily dry-run comparison vs Zapier** (plan A11). It needs the monday user ID the three Zaps act as (plan M-8, not yet given).
6. **Project Tools UI:** Hope's Dashboard (`/ops-queue`) + Sync Admin (mappings, cleanliness rules, schedules, activity, the diff report). It needs the small `sync-admin` edge function to reach the engine. Plan §6.
7. **MCP tools** (plan A12): queue_list, queue_set_status, reconcile_opportunity, sync_failures_list, events_query.
8. **Phase 1B queue engine:** the Hope's Queue monday board (ask whether Claude should build it via the connector), task push/placement, recurring report tasks, cleanliness counts. Waiting on Seth for open items O-2, O-3, O-5, O-6, O-7, O-8.
9. **Production:** Salesforce prod integration user + app (repeat Part A in prod), `instrata-sync-engine` Fly app with `DB_SCHEMA=public`, backfill on the prod board, the Pre-Engineering group + Win/Loss Notes column on the prod board (Build Guide §2), Flows to prod, ≥5 business days of dry run, then the switch (Zaps off + live in the same hour).

## 7. Lessons learned (avoid re-discovering)

- **monday API:** `Column.settings_str` is gone, use `settings`. Dropdown label edits (`update_dropdown_column`) take the **full** label list, so re-send every existing label with its id (sandbox first, verify after). Date column "Include time" is `settings.show_time_by_default`. `create_update` supports `mentions_list`.
- **Windows PowerShell 5.1:** script files must be **ASCII** (an en-dash becomes a smart quote and breaks parsing). Piping to a native exe **prepends a BOM** even with a no-BOM encoding, so pass arguments instead. Ctrl+V types one character into `Read-Host -AsSecureString`. Don't name variables `$args`. Enable TLS 1.2 for `Invoke-RestMethod`.
- **Claude's shell:** never put backticks or `${}` inside `node -e "…"`. Bash runs them as commands. Edit code with the Edit tool. Validate `.ps1` files with the PowerShell parser before handing them over.
- **The Salesforce "Developer Console"** now opens the VS Code-style Web Console, which has no query editor.
- **Supabase SQL Editor** shows a false "RLS not enabled" warning on migrations that enable RLS in a `DO` loop.
- **Fly** creates two machines on a first deploy. Use `--ha=false` / `fly scale count 1`.
- **Stale line-item IDs on the board are real:** some "not found" IDs are purged in production too, probably products removed and re-added. They will appear as backfill tasks in production.
- **The sandbox's Salesforce data is a partial sample**, so the sandbox can't confirm whether an ID is missing in production. Check production read-only.
