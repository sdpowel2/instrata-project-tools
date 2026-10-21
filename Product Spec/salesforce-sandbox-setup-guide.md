# Salesforce Sandbox + Staging Engine Setup Guide

**For:** Seth · **Covers:** plan tasks M-10 to M-15 (sandbox), plus standing up the staging engine
**Sandbox:** `partial` (refreshed and activated Oct 12, 2026). Login at **test.salesforce.com** with your username + `.partial`.

Three parts, done in order:

| Part | What | When |
|---|---|---|
| **A** | Integration user + External Client App (lets the engine *read and write* Salesforce) | Now |
| **B** | Create the staging engine on Fly and smoke-test it against the sandbox | Right after A |
| **C** | Named Credential + the two Flows (lets Salesforce *notify* the engine) | After Part B's smoke test passes. The endpoint is built; the Flows just need a running staging engine to call, or every Opportunity save in the sandbox would fire a callout that fails. |

**Secrets rule:** anything marked 🔒 goes in your password manager and later into a Fly secret. **Never paste a 🔒 value into the chat.** Things marked 📨 aren't secret; send them to Claude.

Salesforce rearranges its Setup screens from release to release. If a label doesn't match exactly, use the Setup **Quick Find** box with the bold name given in each step.

---

## Part A — Integration user and External Client App

### A0. Check the sandbox data came across (2 min)

1. Log in to the sandbox: test.salesforce.com, username + `.partial`.
2. Open the **App Launcher** (9-dot grid), then **Opportunities**, and switch the list view to **All Opportunities**.
3. Open a few recent opportunities. Look for one at **Engineering** with an AV product in its **Products** related list.
   - Found one: data came across. 📨 Note its 18-character ID (from the URL, starts with `006`). It's the record for the smoke test in **B5**.
   - The list is empty, or nothing has products: tell Claude. We'll create test opportunities by hand instead.

> The gear menu's **Developer Console** now opens the VS Code-style **Web Console**, which has no simple query box. You don't need it for this guide.

### A1. Check how Opportunities are shared (1 min)

This decides whether step A3.5 is needed.

**Instrata: already done.** Opportunity Default Internal Access is **Public Read/Write** (production, checked Oct 12, 2026; the sandbox copies it). Skip to A2.

For other orgs: Quick Find **Sharing Settings**. Under **Organization-Wide Defaults**, find **Opportunity**. Note the **Default Internal Access**: Private, Public Read Only, or Public Read/Write.

### A2. Create the integration user

1. Quick Find **Users**, then **New User**.
2. Fill in:
   - **First / Last name:** `AVSS` / `Integration`
   - **Email:** `avsfintegration@instrata.com` (the same mailbox as the monday user)
   - **Username:** `avss.integration@instrata.com.partial`. It must be unique across all of Salesforce; add a suffix if it's taken.
   - **User License:** **Salesforce Integration**
   - **Profile:** **Minimum Access - API Only Integrations**
3. Save.
4. On the user's page, scroll to **Permission Set License Assignments**, click **Edit Assignments**, tick **Salesforce API Integration**, and Save.

> If **Salesforce Integration** isn't in the license list, Quick Find **Company Information** and check the licenses table. Enterprise and above include a few free ones. Tell Claude if there are none.

### A3. Permission set for the integration user

1. Quick Find **Permission Sets**, then **New**.
   - **Label:** `AVSS ProjectTools Integration`
   - **License:** **Salesforce API Integration**
   - Save.
2. Open **Object Settings** and set the following.

   | Object | Object access | Field access |
   |---|---|---|
   | **Opportunities** | Read, Edit, **View All Records** | **Read only** on every field: tick "Read", untick "Edit". Some standard fields can't be made read-only; that's expected. |
   | **Opportunity Products** | Read, Edit | **Edit** on **Sales Price** (`UnitPrice`) and **Sold in Margin** (`Sold_in_Margin__c`) only. **Read** on Quantity, isAVProduct, Technology. Everything else read-only. |
   | **Products** | Read | Read |
   | **Price Books** | Read | Read |

   - **System Permissions:** tick **Edit Opportunity Product Sales Price**. Without it Salesforce rejects every Sales Price write with `FIELD_INTEGRITY_EXCEPTION: User may not specify unit price different from list price`, and the whole PATCH (GM % too) fails (found Oct 14).
   - **Estimator writeback (Oct 15):** on **Opportunity Products**, also **Edit** on **Estimator** (`Estimator__c`). Under **System Permissions**, tick **Send Email** (the sync emails the Sales Rep when it sets an Estimator, through the standard Send Email action). Both done in the partial sandbox Oct 15.
3. **API Enabled** comes from the **Minimum Access - API Only Integrations** profile set in A2, not from this permission set. To confirm, open the user's **Profile**: **API Enabled** is checked under System Permissions. If the permission set's **Find Settings** box does find "API Enabled", ticking it there too is harmless.
4. Back on the integration user: **Permission Set Assignments**, then **Edit Assignments**. Add **AVSS ProjectTools Integration** and Save.
5. **Instrata: SKIP.** Checked Oct 12, 2026: Opportunity sharing is **Public Read/Write**, so no group or rule is needed. For orgs where A1 is *Private* or *Public Read Only* (in the group's member picker, switch the **Search** dropdown to "Users" to add one person): the user can read every opportunity (View All) but can't edit their products yet. Editing a product needs write access to its parent opportunity. Grant it with a sharing rule:
   1. Quick Find **Public Groups**, then New. **Label:** `AVSS Integration`. Add the integration user as the only member. Save.
   2. Quick Find **Sharing Settings**, then **Opportunity Sharing Rules**, then New.
      - **Label:** `AVSS Integration Read Write`
      - **Rule type:** based on record owner
      - **Owned by members of:** Roles and Subordinates, at your top role (or "All Internal Users", if offered)
      - **Share with:** Public Group `AVSS Integration`
      - **Access:** Read/Write
   3. Save. Salesforce recalculates sharing in the background.

> **Honest limit:** Salesforce never lets you make a few standard Opportunity fields (Name, Stage, Close Date) read-only for a user who has Edit. The engine never writes them; the code can only patch the two line-item fields. The protection is that the credential lives only in Fly secrets.

### A4. External Client App (the engine's API login)

1. Quick Find **External Client App Manager**, then **New External Client App**.
   - **Name:** `AVSS Project Tools`
   - **Contact Email:** yours
   - **Distribution State:** **Local**
2. Under **API (Enable OAuth Settings)**, tick **Enable OAuth**.
   - **Callback URL:** `https://instrata-sync-engine-staging.fly.dev/oauth/callback`. Salesforce requires one, but this flow never uses it.
   - **OAuth Scopes:** **Manage user data via APIs (api)**
   - **Flow Enablement:** tick **Enable Client Credentials Flow**
   - Leave the other security checkboxes at their defaults.
3. Create.
4. Open the app's **Policies** tab, then **Edit**.
   - **OAuth Flows and External Client App Enhancements:** tick **Enable Client Credentials Flow** and set **Run As** to the integration user from A2.
   - **App Policies / Permitted Users:** "Admin approved users are pre-authorized". Under selected permission sets, add **AVSS ProjectTools Integration**.
   - Save.
5. Open the **Settings** tab, then **OAuth Settings**, then **Consumer Key and Secret**. Salesforce emails you a verification code first.
   - 🔒 Save the **Consumer Key** and **Consumer Secret** to your password manager as "SF sandbox – AVSS Project Tools".
6. Wait about 10 minutes before the first login; new apps take a few minutes to propagate.

### A5. Get the sandbox's My Domain URL

Quick Find **My Domain**. Copy the URL under **Current My Domain URL**, which will look like `https://instrata--partial.sandbox.my.salesforce.com`.

📨 **Send Claude:** the My Domain URL and the integration user's username. Neither is secret.

> **Instrata sandbox values (recorded Oct 12, 2026):**
> - My Domain: `https://instrata--partial.sandbox.my.salesforce.com` (this is `SF_LOGIN_URL` for staging)
> - Integration username: `avsfintegration@instrata.com.partial`. The production user will be the same without `.partial`.

---

## Part B — Staging engine on Fly

Run these in **PowerShell**, from the repo folder. `fly` is already installed (v0.4.57).

### B1. Generate three random secrets

Run this **three times**. Each run prints a new 64-character value.

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

🔒 Save them as:

| Name | What it's for |
|---|---|
| `SF_WEBHOOK_SECRET` (staging) | The header Salesforce sends; also goes into Part C |
| `MONDAY_WEBHOOK_PATH_SECRET` (staging) | Part of the URL monday calls |
| `ENGINE_INTERNAL_SECRET` (staging) | Lets you, the MCP server and the app call the engine's admin endpoints |

### B2. Build the database connection string

1. In Supabase, click **Connect** (top of the project), then **Session pooler**. Copy the URI. It looks like:
   `postgresql://postgres.zeuceafbaufpuwpczcth:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
2. Change the **user** from `postgres.zeuceafbaufpuwpczcth` to `sync_engine.zeuceafbaufpuwpczcth`.
3. Replace `[YOUR-PASSWORD]` with the `sync_engine` password you set earlier.
4. Keep port **5432** (session mode). The engine's instant-notification feature needs session mode.

🔒 This full string is `DATABASE_URL`.

### B3. Create the app and set its secrets

```powershell
fly apps create instrata-sync-engine-staging
```

If it asks for an organization, pick the same one `instrata-project-tools-mcp` lives in.

Set the secrets. Paste your values in place of each `<...>`, and keep the double quotes:

```powershell
fly secrets set -a instrata-sync-engine-staging --stage `
  "DATABASE_URL=<B2 connection string>" `
  "DB_SCHEMA=sync_sandbox" `
  "SYNC_MODE=dry_run" `
  "MONDAY_API_TOKEN=<AV Integrations API token>" `
  "MONDAY_WEBHOOK_PATH_SECRET=<B1 value>" `
  "SF_LOGIN_URL=<A5 My Domain URL>" `
  "SF_CLIENT_ID=<A4 Consumer Key>" `
  "SF_CLIENT_SECRET=<A4 Consumer Secret>" `
  "SF_WEBHOOK_SECRET=<B1 value>" `
  "ENGINE_INTERNAL_SECRET=<B1 value>"
```

`--stage` stores them without restarting anything, since nothing is deployed yet. `MONDAY_INTEGRATION_USER_ID` is already in `fly.toml`.

### B4. Deploy

```powershell
cd sync-engine
fly deploy -a instrata-sync-engine-staging --remote-only
```

Then watch it boot:

```powershell
fly logs -a instrata-sync-engine-staging
```

✅ Healthy looks like a line containing `"msg":"sync-engine listening"` with `"mode":"dry_run","schema":"sync_sandbox"`.

❌ If it exits instead, copy the error line (it's never a secret) and send it to Claude. The most likely causes:
- **Database user/password** → re-check B2.
- **Salesforce auth** → Client Credentials must use the **My Domain** URL, and the A4 Run As user must be set.

### B5. Smoke test: one real sandbox opportunity, in dry run

1. In the sandbox, open any Opportunity at **Engineering** with exactly one AV product. Copy its 18-character ID from the URL (starts with `006`).
2. In PowerShell (it prompts for the internal secret, so nothing lands in your history):
   ```powershell
   $s = Read-Host 'ENGINE_INTERNAL_SECRET'
   Invoke-RestMethod -Method Post -Uri "https://instrata-sync-engine-staging.fly.dev/admin/reconcile/<OPP_ID>" -Headers @{ 'x-internal-secret' = $s } | ConvertTo-Json -Depth 6
   ```
3. Send Claude the output. It contains IDs and counts, no secrets.

It's a dry run, so **nothing is written** to the sandbox board or to Salesforce. Claude will check the `sync_sandbox.event_log` entries showing what the engine *would* have done. Links from the existing board items don't exist yet; the backfill comes in the next build slice. So this first test should show a planned "create item".

---

## Part C — Named Credential + Flows (after Part B passes)

The staging engine already serves `/webhooks/salesforce` (and registers its own monday webhooks on the sandbox board at boot). Once B5 works:

### C1. External Credential (holds the secret header)

1. Quick Find **Named Credentials**, then the **External Credentials** tab, then **New**.
   - **Label:** `AVSS ProjectTools` · **Name:** `AVSS_ProjectTools`
   - **Authentication Protocol:** **Custom**
   - Save.
2. Under **Principals**, click **New**.
   - **Parameter Name:** `AVSS_Principal` · **Identity Type:** **Named Principal**
   - **Authentication Parameters**, then Add: **Name** `Secret`, **Value** = 🔒 the staging `SF_WEBHOOK_SECRET` from B1.
   - Save.
3. Under **Custom Headers**, click **New**.
   - **Name:** `X-AVSS-Secret`
   - **Value:** `{!$Credential.AVSS_ProjectTools.Secret}`
   - Save.

### C2. Named Credential (the engine's address)

On the **Named Credentials** tab, click **New**.
- **Label:** `AVSS ProjectTools` · **Name:** `AVSS_ProjectTools`
- **URL:** `https://instrata-sync-engine-staging.fly.dev`
- **Enabled for Callouts:** ✓
- **External Credential:** `AVSS_ProjectTools`
- **Generate Authorization Header:** untick (we use the custom header)
- **Allow Formulas in HTTP Header:** ✓
- Save.

### C3. Permission to use the credential

1. Quick Find **Permission Sets**, then New. **Label:** `AVSS ProjectTools Callout` (no license). Save.
2. Open **External Credential Principal Access**, then Edit. Add **AVSS_ProjectTools - AVSS_Principal**. Save.
3. Assign it to **yourself and the integration user** (the engine's writebacks fire the Flows as that user).
4. **Every Opportunity editor needs principal access too** (verified Oct 14: a non-admin's edit saved fine but the callout silently never left Salesforce). Add **External Credential Principal Access → `AVSS_ProjectTools - AVSS_Principal`** to the profiles **Instrata Standard User**, **Instrata Standard User - SSO Opt**, **Standard User** and **System Administrator** (production's Opportunity editors over the last 90 days, Oct 14). Profiles, not the permission set, so new hires are covered.

### C4. Flow: `AVSS_Opportunity_Changed`

*(Rewritten Oct 14 after the sandbox build; this is what actually activates.)*

1. Quick Find **Flows**, then **New Flow → Start From Scratch → Record-Triggered Flow**.
2. **Object:** Opportunity · **Trigger:** A record is created or updated · **Optimize for:** Actions and Related Records · tick the **Run Asynchronously** path.
3. **Entry conditions (required):** Salesforce won't activate an async path on "created or updated" unless every condition uses **Is Changed**. Use *Any Condition Is Met (OR)*, each row `Is Changed = True`, on: `StageName`, `Estimate_Due_Date_Time__c`, `Estimate_Number__c`, `Win_Likelihood__c`, `Business_Unit__c`, `Sales_Rep__c`, `Lost_Reason__c`, `Other_lost_reason__c`, `Lost_To__c`, `Amount`. **Amount** is what catches product adds and deletes. When to run: every time a record is updated and meets the conditions.
4. On the async path, **Action → Create HTTP Callout**:
   - External Service name: `AVSSWebhook` (**alphanumeric only**, no spaces or underscores) · Named Credential `AVSS_ProjectTools`.
   - Invocable action: Label `Notify Project Tools`, POST, URL Path `/webhooks/salesforce`. **Next** → request body sample `{"object":"Opportunity","record_id":"006000000000000AAA","opportunity_id":"006000000000000AAA"}` → **Next** → response entered manually `{"ok":true}`, 200.
   - If the canvas box still says "Action 1", the action wasn't attached: open it → **External Services → AVSSWebhook → Notify Project Tools**. The panel has no Done button; changes apply as you make them.
5. In the action, body **Value → + New Resource**: API Name `oppBody` (type Apex-Defined, class auto-filled).
6. Add an **Assignment** `Build Body` *before* the action: `oppBody.object` = `Opportunity`, `oppBody.record_id` = `{!$Record.Id}`, `oppBody.opportunity_id` = `{!$Record.Id}`.
7. Save as **AVSS Opportunity Changed** (`AVSS_Opportunity_Changed`), **Activate**.

### C5. Flow: `AVSS_OppProduct_Changed`

- **Object:** Opportunity Product · **Trigger: A record is created** (create only; "only when a record is updated to meet the condition requirements" does **not** fire on new records) · conditions *Any (OR)*: `isAVProduct__c` Equals True, `Technology__c` Equals AV (Flow Builder shows them by label: isAVProduct, Technology). Run Asynchronously path ticked.
- The org's existing before-save flow sets `isAVProduct__c` from `Product2.Type__c` on create, so the condition sees the final value.
- Action: **External Services → AVSSWebhook → Notify Project Tools** (reuse), body → new resource `oppBody`; `Build Body`: `object` = `OpportunityLineItem`, `record_id` = `{!$Record.Id}` (Line Item ID), `opportunity_id` = `{!$Record.OpportunityId}`.
- A product that later becomes / stops being AV is caught by the hourly sweep.

**No delete Flow.** Delete-triggered Flows can't make callouts. A delete changes the opportunity's Amount, which fires C4 (verified Oct 14).

**A Flow treats any HTTP reply as success**, including a 400/401 from the engine: no error email, no failed interview. The engine logs `salesforce webhook rejected` for those. Use Flow Builder **Debug** (run as Created, pick a record) to see the response code.

### C6. Tests (with Claude watching the engine logs)

1. **Edit an Opportunity** (change its due date). The engine should log a reconcile within seconds.
2. **Run the same edit logged in as a non-admin sales user** (Setup → Users → Login, if login-as is enabled). If that edit doesn't reach the engine, C3's permission set has to go to all Opportunity editors.
3. **Delete a product from an opportunity.** Claude checks whether the Opportunity Flow fired because the Amount changed. If not, the hourly sweep's deleted-records check covers it.
4. **Percent units:** Claude will have you change GM% on one test item and confirm Salesforce shows the same number (35 stays 35%, not 3500%).
