# Switch Day Handoff — Salesforce ↔ monday sync goes live

**For:** the agent running the production switch with Seth on **Wed Oct 28, 2026, morning ET**.
**Read this first.** Background and every decision live in `Product Spec/sync-build-handoff.md` (decisions 1–27, runbook P1–P23, dry-run log, lessons). You shouldn't need it for the steps below, but check it before improvising.
Written Oct 27, 2026 at the end of a long session. Branch `salesforce-automations-and-dashboards` (pushed).

---

## 1. How Seth works (follow this exactly)

- **One step at a time, in chat.** Number them ("Step 1"), give exact clicks / commands, then stop and wait for "Step N done". Don't send him to a doc.
- **Windows PowerShell 5.1.** Give PowerShell, not bash. Run everything from the repo folder `C:\Users\Seth.Powell\CLAUDECODE\InstrataProjectTools\instrata-project-tools-main`.
- **Secrets stay in his password manager.** Never ask him to paste one into chat. `sync-engine\scripts\engine.ps1` reads the engine secret from his **clipboard** (entry **"Prod – ENGINE_INTERNAL_SECRET"**).
- **Ask before every git commit** (he always says yes, but ask). Footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Anything he must copy (SQL, commands) goes in your closing message after the next-step box**, never only above a box with a question (the box hides it).
- He answers questions in short replies; give a recommendation, not a menu.

## 2. Where things stand (end of Oct 27)

| Thing | State |
|---|---|
| Production engine | Fly app `instrata-sync-engine`, one machine `iad`, **v6**, `SYNC_MODE=dry_run`, `DB_SCHEMA=public`. Healthy. |
| Staging engine | `instrata-sync-engine-staging`, v32, live on the sandboxes. Leave it alone. |
| Salesforce prod | Integration user AVIntegration (`005QO00000GZ72DYAT`), permission sets, External Client App, Named Credential, Flows `AVSS_Opportunity_Changed` + `AVSS_OppProduct_Changed` — all live and verified. |
| `public.config_settings` | `queue_push` = **true** (Hope's Queue already live), `create_items` = true, `estimator_rep_email` = true, **`estimator_writeback` = false** (turned on in Step 6). |
| Links | ~453 Pre-Sales items linked (`sf_link`); backfill run daily by Seth during the dry run. |
| Estimators | First pass already applied Oct 26 (68 written, 0 failed). Step 7 is the catch-up. |
| Hope's Queue (monday `18436259969`) | Live, ~37 items; Hope works it, plus the **Coordinator** page in Project Tools (v77, `/ops-queue`) with Set aside. |
| Zaps | Still ON (three Zaps; they act as Seth's monday account, create-only into Pre-Sales / New Requests). |

**Seth's "day before" list (ask him what got done; none of it blocks the switch):** close the two test opportunities *Test AV Opportunity Flow* and *Test For Notification* (Closed Lost needs a Lost Reason; otherwise they get created on Triage), check the *Rutgers Cape Shore* cabling line tagged Technology = AV with Joe Collis, Hope sets aside 5 change-order "isn't linked" items, heads-up to the team.

## 3. Tools you have

- **Fly CLI** from Bash: `/c/Users/Seth.Powell/.fly/bin/fly.exe` (logged in). Logs: `fly.exe logs -a instrata-sync-engine --no-tail` (buffer ≈ 100 lines; grep `'"level"'` and filter out `"msg":"reconciled"` to see the rest). Deploys need `--remote-only --ha=false` and sometimes a retry loop (his network drops Fly calls). **`fly ssh console` was blocked by the auto-mode classifier** — don't rely on it.
- **Salesforce connector** (`mcp__5688ad4d-…__dispatch_readonly`, load via ToolSearch): read-only SOQL against **production** at `/services/data/v66.0/query` (tooling at `/tooling/query`).
- **monday connector** (`mcp__7e1d821f-…__all_api_read`): read-only GraphQL. Writes (`all_api_write`) need Seth's OK first.
- **Supabase:** you can't query it. Give Seth one SQL statement at a time for the SQL Editor (it shows only the last result; an UPDATE says "No rows returned" — use `returning`).
- Files Seth produces land on `C:\Users\Seth.Powell\Desktop\` (when he uses `Out-File "$env:USERPROFILE\Desktop\…"`) or the **OneDrive Desktop** `C:\Users\Seth.Powell\OneDrive - Kane Holdings\Seth.Powell\Desktop\` (`diff-report`, `estimator-preview` CSVs). Read them with PowerShell `Import-Csv`.

## 4. The switch — in this order

Commands below are what Seth runs; you check results.

**Step 1 — Zaps off.** Seth turns off all three Zaps in Zapier. Nothing to verify from your side.

**Step 2 — backfill (must be after Step 1, before Step 3).** Links anything the Zap created overnight; otherwise the engine treats those deals as new and **creates duplicates on Triage** once live.
```powershell
powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 -App instrata-sync-engine backfill | Out-File -Encoding utf8 "$env:USERPROFILE\Desktop\backfill-prod.json"
```
Check the file: `linked` (new links), problems (~49 expected: 44 not found, 1 opp unresolved, 4 duplicates), `unlinkedTasksClosed`, `setAside`, `handedOver`.

**Step 3 — go live.**
```powershell
fly secrets set SYNC_MODE=live -a instrata-sync-engine
```
It restarts the machine. Confirm in the logs: `"msg":"sync-engine listening" … "mode":"live","schema":"public"` and webhooks "kept" on presales / prequal / triage / queue.

**Step 4 — re-check every linked deal.**
```powershell
powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 -App instrata-sync-engine requeue-linked
```
Without it only opportunities changed since the last hourly sweep get the first live pass. Expect it to queue ~350–450 opportunities; the inbox drains in a few minutes.

**Step 5 — watch (~30 min).** What should happen (first live pass rules, decisions 3, 7, 8):
- About **120–150 field writes on open items** (Follow Up / New Requests): Win %, quote number, Sales Person, BU, due-date time. The 9+ Zap items from Oct 27 (e.g. *Monarch HQ*, *Deriva - 5th Floor Hallway Display*, *Coastal Carolina HHP*, *Cleveland County - Justice Center*) should get BU / rep / quote / Win %. Spot-check two with the monday connector.
- **Nothing** written to items in Won / Lost / Declined to Bid.
- Due Date that differs by a day+ is **kept** and stays on Hope's "Due Date differs" review task; Confirmed-to-Win (99/100%) on these already-linked items stays a **review**, not auto-Won.
- Unlinked AV opportunities that get touched are **created** on Pre-Qualification (Lead / Qualified) or Triage (Engineering+).
- Watch logs for `"level":"error"`, `queue push failed`, `salesforce webhook rejected`, `writeback`. Seth can check failures with:
  ```sql
  select status, count(*) from public.webhook_inbox where received_at > now() - interval '1 hour' group by status;
  ```
- Hope's Queue gets a burst of review / mapping tasks; that's expected.

**Step 6 — Estimator writeback on.**
```sql
update public.config_settings set value = 'true'::jsonb where key = 'estimator_writeback' returning key, value;
```
From now on a Pre-Sales Engineer change in monday writes the Salesforce Estimator (30 s debounce) and emails the opportunity's Sales Rep ("Estimator assigned: <opp>"); the org flow emails the estimator.

**Step 7 — Estimator catch-up (P18).**
```powershell
powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 -App instrata-sync-engine estimator-preview
```
Review the CSV (OneDrive Desktop `estimator-preview-instrata-sync-engine-*.csv`): counts by Action, emails per engineer (`Estimator after` on replace / fill blank). Expect only a handful of writes. Then, with Seth's OK:
```powershell
powershell -ExecutionPolicy Bypass -File sync-engine\scripts\engine.ps1 -App instrata-sync-engine estimator-first-pass | Out-File -Encoding utf8 "$env:USERPROFILE\Desktop\estimator-apply-prod.json"
```
(It asks him to type YES.) Verify in Salesforce: `SELECT COUNT(Id) FROM OpportunityLineItem WHERE LastModifiedById = '005QO00000GZ72DYAT' AND LastModifiedDate = TODAY`.

**Step 8 — notifications + announcement (P19, can be later in the day).** In monday (Seth, by hand; Build Guide `Product Spec/monday-build-guide.md` §2.4): update the existing **Won** notification to include Salesperson, Quoted Price, Estimated GM % and Business Unit; add a **Lost** notification (Status → Lost → notify Lee + leadership with item name, Quoted Price, Salesperson, **Win/Loss Notes**); optional same for Declined to Bid. Then the team announcement (Follow Up toggle retired, fields follow Salesforce, intake through Pre-Qualification / Triage).

**Rollback (any time):** `fly secrets set SYNC_MODE=dry_run -a instrata-sync-engine` and turn the Zaps back on. Writes already made stay (they're Salesforce's values).

## 5. After the switch

- Update `Product Spec/sync-build-handoff.md`: mark P15–P19 done with what you saw, and add a "Live since" line; update `PROJECT_DOCS.md` changelog. Ask Seth before committing.
- The daily dry-run routine (backfill / diff report / engine-only creates) is no longer needed once live: the Zaps are off and the engine creates items itself. P20 instead: daily look at Hope's Queue / Coordinator for Sync Problems.
- Latest engine commits are on the branch (and deployed via Fly) but not merged to `dev` / `main`; the Project Tools app hasn't changed since v77, so a merge is housekeeping, not urgent.
- Open ideas parked by Seth: a standalone **change order board** (link to a Won project, roll CO totals up to Salesforce); Estimators on **this year's closed deals** (120 blank AV lines — a scope decision, it would email engineers about old jobs); P21–P23 in the runbook.

## 6. Gotchas that bit us

- Engine code paths that write go through the **write gate**; Hope's Queue has its own always-live gate and the Estimator first pass an Estimator-only gate in dry run. Once live, everything writes.
- The queue push "settle" compares `updated_at` as text (microseconds matter) — fixed; if items re-push every minute again, that's the first suspect.
- Windows PowerShell 5.1 scripts must stay **ASCII** and pass the parser (`[Management.Automation.Language.Parser]::ParseFile`). Piping to a native exe adds a BOM.
- Fly drops ~1 in 4 API calls from Seth's network; retry deploys / secrets commands.
- Salesforce flows treat any HTTP reply as success; a rejected webhook only shows as `salesforce webhook rejected` in the engine log.
