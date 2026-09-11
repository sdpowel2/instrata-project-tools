# Project Tools MCP — Cutsheet Submittal Write Access — Development Spec

**Version:** 1.0 (build approved and implemented — see `mcp-server/src/submittalTools.ts`)
**Owner:** Instrata AV
**Target:** Existing `mcp-server` (TypeScript / Express / MCP SDK) reusing the existing `sharepoint-cutsheet` edge function
**Access model:** Read-only today → scoped writes for the cutsheet submittal workflow only

---

## 1. Scope

A Claude skill should be able to, via MCP:

1. Create a submittal package on a project (title, prepared by, submitted to).
2. Populate its line items from the BoM.
3. **Determine which line items do and do not have a cutsheet** (the core capability).
4. **For missing ones, check the repository, fetch the PDF from wherever the skill finds it, and attach it to the item** (the core capability).

**Explicitly out of scope (v1):** serving the final submittal PDF through MCP. The user opens the app and clicks Export as the last step. This removes the largest work item (porting the ~550-line client-side `exportSubmittalPDF.ts` to a server context) — it can return as a v2 phase if wanted.

## 2. Key codebase facts this design rests on

- **Match state already exists in the DB — no migration needed.** `submittal_items` has three nullable columns: `cutsheet_repository_id` (approved repo match), `cutsheet_staging_id` (uploaded, pending admin approval), `cut_sheet_url` (legacy). The app derives "has a cutsheet" as any-of-three (`app/src/utils/cutsheetSource.ts:15`). The MCP's `list_submittals` just doesn't select these columns (`mcp-server/src/tools.ts:130`).
- **Per-user auth + RLS already gates writes correctly.** The MCP server mints a per-user Supabase JWT (`mcp-server/src/auth.ts`); RLS policies `"Members can manage submittals"` / `"...submittal items"` (`supabase/migration.sql:334-344`) mean write tools automatically only work on projects the token's user is a member of.
- **The `sharepoint-cutsheet` edge function already does the heavy lifting** (`supabase/functions/sharepoint-cutsheet/index.ts`):
  - `lookupBatch` — case-insensitive mfr+model match against `cutsheet_repository`.
  - `uploadStaging` (lines 254-413) — accepts `storagePath` in the `cutsheet-temp` Storage bucket (preferred; bypasses body-size limits) or `fileBase64` (~5 MB cap); **dedupes against the repository first** and returns `{matched: {repositoryId}}` on a hit, otherwise uploads to SharePoint `/Staging/`, inserts a pending `cutsheet_staging` row, and returns `{staged: {stagingId}}`. Takes `uploadedByUserId`, `projectId`, `sourceContext` for traceability. Cleans up the temp file in all paths.
  - The caller is responsible for stamping the returned id onto the submittal item (the app does this client-side today; the MCP tool will do it under the user JWT).
- **`cutsheet-temp` bucket** allows uploads by any authenticated user, so the MCP server can stage bytes there with the per-user client.
- **`cutsheet_repository` SELECT** is open to all authenticated users, so a repository search tool needs no policy change.

## 3. New / changed MCP tools

### 3.1 `list_submittals` — expose cutsheet status (change, read-only)

Add to the `include_items` select: `cutsheet_repository_id, cutsheet_staging_id, cut_sheet_url, cut_sheet_name`, and compute per item:

```json
{ "has_cutsheet": true, "cutsheet_source": "repository" | "staging" | "legacy" | null }
```

mirroring `hasCutsheet()`. This alone answers "what still needs a cutsheet." One-line-ish change in `mcp-server/src/tools.ts`.

### 3.2 `get_me` (new, read-only)

Returns `{user_id, full_name, email}` from `profiles` for the caller — feeds "Prepared By" without asking the user.

### 3.3 `create_submittal` (new, write)

`(project_id, submitted_to, title?, revision?, notes?)` → direct insert into `submittals` under the user JWT. Defaults: `title = "AV Submittals"`, `prepared_by = caller's profiles.full_name`, `status = 'Draft'`, `revision = 'Rev 0'`. Returns the new submittal id. RLS rejects non-members — map that failure to a clear `"you are not a member of this project"` error (reads are org-wide, so the skill *can* see projects it can't write to).

### 3.4 `update_submittal` (new, write)

`(submittal_id, {title?, submitted_to?, revision?, notes?})` — lets the skill fill Submitted To after asking the user. (No client contact exists in the data model — `projects.client` is a company-name text field — so ask-the-user is the expected path for now; see §5.2.)

### 3.5 `populate_submittal_from_bom` (new, write)

Server-side equivalent of the app's Autopopulate button (`app/src/store/index.ts:1697-1759`): filter out Labor + house manufacturers (`utils/submittalExclusions.ts`), dedup by mfr+model consolidating qty, insert `submittal_items`, then invoke `sharepoint-cutsheet lookupBatch` and stamp `cutsheet_repository_id` on repo matches. Returns the item list with `has_cutsheet` per item so the skill immediately has its work list.

Guards (differences from the app version, which delete-all-and-reinserts):
- Refuse to run if the submittal already has items unless `replace: true` is passed.
- v1 implementation: reimplement in the MCP server (the exclusion list is small and stable). Port the exclusion constants verbatim and add a code comment in both places pointing at the twin. Consolidating into one shared RPC used by both app and MCP is a fast-follow if drift ever bites (§5.3).

### 3.6 `search_cutsheet_repository` (new, read-only)

`(manufacturer?, model?, query?)` → ilike select over `cutsheet_repository` (id, manufacturer, model_number, display_name, category, sharepoint_path). Lets the skill check the repo for near-miss matches (model number variants) before hunting externally, and attach by `repository_id` when it finds one that `lookupBatch`'s exact-ish match missed.

### 3.7 `attach_cutsheet` (new, write — the core tool)

```
attach_cutsheet(
  submittal_item_id: string,
  source:
    | { repository_id: string }          // skill found it via 3.6
    | { url: string }                    // skill found a PDF on the web / SharePoint
    | { base64_pdf: string },            // small local file fallback (~4 MB cap)
  manufacturer?: string,                 // defaults from the item row
  model?: string,
  filename?: string
)
```

Server behavior:

1. Load the item (under user JWT — RLS proves membership); default mfr/model/filename from it.
2. `repository_id` path: verify the repo row exists, then update the item's `cutsheet_repository_id` + `cut_sheet_name`. Done.
3. `url` path: server-side fetch with guards — require `application/pdf` content type or `%PDF` magic bytes, cap size (25 MB), timeout, and **block private-network hosts (SSRF guard)**. Upload bytes to `cutsheet-temp` under the user client.
4. `base64_pdf` path: decode, same PDF/size validation, upload to `cutsheet-temp`.
5. Invoke `sharepoint-cutsheet` `uploadStaging` with `{storagePath, filename, manufacturer, model, projectId, sourceContext: 'mcp_skill', uploadedByUserId: <caller>}`.
6. On `{matched}` → set item `cutsheet_repository_id` (the repo already had it — dedup win). On `{staged}` → set item `cutsheet_staging_id` + `cut_sheet_name`.
7. Return `{attached: 'repository' | 'staging', pending_admin_approval: boolean}` so the skill can report staging counts to the user.

Also record `cutsheet_project_usage` analytics for repo attaches (any authenticated user may insert), matching app behavior.

### 3.8 `detach_cutsheet` (new, write — added during build)

`(submittal_item_id)` — clears all cutsheet links on the item so a different one can be attached (the skill's remove-and-re-add correction loop). A staged file stays in the admin review queue for rejection.

## 4. Target skill flow

1. `get_me` → Prepared By.
2. `list_projects` / `get_project` → locate project; ask user for Submitted To (nothing in the data model to auto-fill from yet).
3. `create_submittal` → package id.
4. `populate_submittal_from_bom` → items with `has_cutsheet`; repo matches auto-attached.
5. For each item with `has_cutsheet: false`: `search_cutsheet_repository` (fuzzy) → else hunt externally → `attach_cutsheet` with the URL.
6. Report results: N attached from repository, M staged pending admin approval, K not found (listed for the user).
7. User opens the app and clicks **Export Submittal PDF**. (The app's export already includes staged and repo cutsheets.)

## 5. Hangups / decisions

1. **Token scoping.** Adding write tools makes every existing MCP token write-capable within RLS. v1 recommendation: accept RLS as the boundary (writes mirror the user's app permissions; "cutsheets only" is enforced by only shipping these tools). If opt-in is wanted, add `scopes text[]` to `mcp_tokens` and gate write tools — small migration, easy to retrofit.
2. **Submitted To auto-fill has no data source.** Fine for v1 (skill asks). Adding `client_contact_name`/`client_contact_email` to `projects` later makes the flow fully autonomous.
3. **Autopopulate logic duplication.** The filter/dedup rules live in frontend TS; v1 duplicates them in the MCP server (small, stable list). If the exclusion list starts changing, consolidate into one shared RPC that the app button also calls.
4. **Staging approval loop.** Skill-fetched cutsheets land in `cutsheet_staging` pending admin approval. They attach and export fine immediately, but the skill must surface "M cutsheets pending admin approval" so the review queue doesn't silently grow. Consider `sourceContext: 'mcp_skill'` filtering in the admin review UI later.
5. **URL fetch safety.** `attach_cutsheet`'s URL path makes the MCP server fetch arbitrary URLs — needs the SSRF guard, PDF validation, and size cap listed in §3.7. Skill-quality risk too: the skill may confidently attach the *wrong* PDF (wrong revision, wrong model variant). Mitigation is skill-side (echo what it attached and from where) plus the existing admin staging review as the human backstop.
6. **App session staleness.** The app store doesn't subscribe to realtime; an open browser session won't show MCP-created packages until refresh. Cosmetic — worth a line in the skill's final report ("refresh the app to see the package").
7. **Legacy JWT secret.** MCP JWT minting depends on the legacy HS256 `SUPABASE_JWT_SECRET` (known migration item, `mcp-server/README.md`). Writes raise the stakes; no new work now, but keep the migration on the roadmap.

## 6. Sizing

| Item | Size |
|---|---|
| 3.1 expose cutsheet columns + 3.2 `get_me` | Hours |
| 3.3/3.4 create + update submittal | ~½ day |
| 3.5 populate from BoM (server-side port + guards) | ~1 day |
| 3.6 repository search | Hours |
| 3.7 `attach_cutsheet` (temp-bucket upload, uploadStaging glue, URL fetch guards) | ~1 day |
| Token scoping (if opted into) | ~½ day |

Total: roughly 3–4 focused days, no schema migrations required for the core path.
