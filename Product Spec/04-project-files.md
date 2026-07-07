# Project Files
## Instrata Project Tools — Feature Specification

**Version:** 1.0
**Status:** Ready for Development
**Module:** Post-Sales / Project Management
**Dependencies:** Project record, User accounts, Microsoft Graph app registration (shared with Cutsheet Repository), company SharePoint site

---

## 1. Overview

Project Files replaces the "coming soon" placeholder on the Project Log's Files tab with a real per-project document repository. Files physically live in a **company-browsable SharePoint site** (one folder per project, standard subfolders); the app keeps a **Supabase index** (`project_files`) that powers in-app browsing, search, metadata, and MCP access.

Design principles, agreed 2026-07-06:

1. **SharePoint stores bytes, Supabase stores truth for the app.** The app and MCP server never list SharePoint in the hot path — they read the `project_files` index. Fresh download URLs are minted on demand via Microsoft Graph.
2. **The repo is company property, not app property.** Anyone at the company can open the SharePoint site in Teams/Explorer/browser and add or read files directly. The app reconciles on view, so files added outside the app appear in-app the next time someone opens the project's Files tab.
3. **Documents the app generates file themselves.** Submittal packages, RFIs, closeout documents, sign-offs, warranties, punch lists, and manuals are automatically uploaded into the project folder when exported — making the SharePoint repo the queryable system of record for project deliverables.
4. **Financial documents are never auto-filed.** Gross-margin and any other cost/margin-revealing exports stay download-only. The SharePoint site is company-browsable; app-level RLS is an organizational convenience there, not a security boundary.

---

## 2. SharePoint Structure

New dedicated site (URL provided at setup; resolved to Graph IDs once via a `bootstrap` op, then pinned as edge-function env vars — same pattern as the Cutsheet Repository).

```
{Site}/
  {Document Library}/
    {Project Number} - {Project Name}/
      Contracts/
      Drawings/
      Submittals/
      Meeting Notes/
      Photos/
      Closeout/
      General/          ← default for uncategorized uploads & loose files
```

- Project folders and subfolders are created **lazily** — on first upload or first Files-tab open, not at project creation.
- Folder names are sanitized for SharePoint (`[\\/:*?"<>|]` → `-`, trimmed, length-capped).
- If a project is renamed in the app, the folder is **not** renamed automatically (Phase 1). The index tracks the folder by immutable Graph item ID, so nothing breaks; a rename op is a future enhancement.

### Auth model

App-only Microsoft Graph (client-credentials), reusing the existing `GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET` app registration. If the registration uses `Sites.Selected`, the new site must be granted to the app explicitly. All Graph calls happen server-side in the edge function; the browser and MCP server never hold Graph credentials.

---

## 3. Data Model

### `project_files` table

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `project_id` | uuid | FK → projects, cascade delete of index rows only (SharePoint files are retained) |
| `category` | text | One of the standard subfolders: `contracts`, `drawings`, `submittals`, `meeting_notes`, `photos`, `closeout`, `general` |
| `filename` | text | Display filename |
| `sharepoint_item_id` | text | Graph driveItem id — canonical pointer, unique |
| `sharepoint_path` | text | Human-readable path within the drive (for display / "Open in SharePoint") |
| `sharepoint_web_url` | text | Direct browser link to the item |
| `size_bytes` | bigint | |
| `mime_type` | text | nullable |
| `source` | enum | `upload` (through the app) / `generated` (auto-filed export) / `sharepoint_sync` (discovered by reconcile) |
| `doc_type` | text | nullable — for generated docs: `submittal_package`, `rfi`, `closeout`, `sign_off`, `warranty`, `punch_list`, `manuals` |
| `uploaded_by` | uuid | nullable FK → profiles — null for `sharepoint_sync` rows |
| `sharepoint_modified_at` | timestamptz | lastModifiedDateTime from Graph — drives reconcile change detection |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Also: `projects.sharepoint_folder_id text` — the project's root folder Graph item ID, set on first `ensureProjectFolder`.

### RLS

Same posture as other project-scoped tables: SELECT/INSERT/DELETE for project members, project creator, and admins. The edge function runs service-role and enforces the same checks in code (verify caller JWT → membership) since Graph operations bypass RLS by nature.

---

## 4. Edge Function — `sharepoint-project-files`

Single function, `op`-dispatched POST body, cloned from `sharepoint-cutsheet` (token cache, `graphFetch`/`graphJson` helpers, JWT auth gate). All ops require an authenticated user who is a member of the target project (or admin).

| Op | Behavior |
|---|---|
| `bootstrap` | Admin-only, run once. Resolves site URL + library name → `SHAREPOINT_PROJECTS_SITE_ID` / `SHAREPOINT_PROJECTS_DRIVE_ID` env values. |
| `ensureProjectFolder` | Find-or-create `{number} - {name}/` and requested category subfolder. Persists `projects.sharepoint_folder_id`. Returns folder item IDs. |
| `upload` | Body: `projectId, category, filename, storagePath` (temp Supabase Storage path — same large-file bypass as cutsheets) or `fileBase64` fallback; optional `docType`, `source`. Ensures folders, PUTs the file, inserts the `project_files` row. Filename collisions get a ` (2)`-style suffix via Graph `@microsoft.graph.conflictBehavior: rename`. |
| `getDownloadUrl` | Body: `fileId` (project_files uuid). Verifies membership, returns a fresh ~1h pre-authenticated download URL. |
| `delete` | Deletes the SharePoint item (404 tolerated) and the index row. |
| `sync` | Reconcile: lists the project folder tree via Graph (one `children` call per subfolder, or `delta` later), upserts unknown items as `source='sharepoint_sync'`, updates `sharepoint_modified_at`/`size_bytes` on changed items, and removes index rows whose items vanished from SharePoint. Returns counts so the UI can toast "3 new files found in SharePoint." |

### Reconcile-on-view contract

The Files tab fires `sync` on open (throttled client-side to at most once per project per 5 minutes per session). Sync is additive-safe and idempotent; conflicts resolve in SharePoint's favor (it holds the bytes).

---

## 5. UI — Files Tab (`ProjectLog.tsx`)

Replaces `FilesTabPlaceholder`:

- **Category-grouped list** (Contracts, Drawings, Submittals, Meeting Notes, Photos, Closeout, General) — collapsible groups with counts; empty categories collapsed by default.
- Per file: icon by type, filename, size, uploaded-by (or "via SharePoint"), date, `generated` badge for auto-filed docs.
- **Actions:** download (fresh URL via `getDownloadUrl`), open in SharePoint (`sharepoint_web_url`), delete (member/admin, confirm dialog).
- **Upload:** button + drag-and-drop onto a category group; category picker defaults to General. Multi-file supported; files stage through the existing temp-bucket path.
- **Header actions:** "Open project folder in SharePoint" link; the existing "Download all" button wires to sequential downloads (zip is a future enhancement).
- **Reconcile indicator:** subtle spinner on tab open; toast when sync discovers new external files.

---

## 6. Auto-Filed Generated Documents

Export utilities gain an optional post-export step: after producing the PDF bytes, upload via `op: upload` with `source: 'generated'` and the mapped category/doc_type. Export never blocks on filing — if the upload fails, the user still gets their download and a non-blocking warning toast.

| Export util | Category | doc_type | Auto-file |
|---|---|---|---|
| `exportSubmittalPDF` | Submittals | `submittal_package` | ✅ |
| `exportRFIPDF` | General | `rfi` | ✅ |
| `exportCloseoutPDF` | Closeout | `closeout` | ✅ |
| `exportSignOffPDF` | Closeout | `sign_off` | ✅ |
| `exportWarrantyPDF` | Closeout | `warranty` | ✅ |
| `exportPunchListPDF` | Closeout | `punch_list` | ✅ |
| `exportManualsPDF` | Closeout | `manuals` | ✅ |
| `exportGrossMarginPDF` | — | — | ❌ never (financial) |

Filenames are timestamped (`Submittal Package — 2026-07-06 1432.pdf`) so re-exports version side-by-side rather than overwrite. SharePoint's native version history additionally covers true overwrites.

---

## 7. MCP Server Tools

Two read-only additions to `mcp-server/src/tools.ts`, both flowing through the caller's per-user Supabase client (RLS-scoped) — the MCP server holds **no Graph credentials**:

- **`list_project_files`** — `project_id`, optional `category`, `search` (ilike on filename/doc_type), `limit`. Reads the `project_files` index.
- **`get_project_file`** — `file_id`. Invokes the `sharepoint-project-files` edge function (`getDownloadUrl`) with the user's JWT; returns filename, metadata, and a fresh ~1h download URL the client can fetch directly.

This lets any MCP client answer "pull the signed contract for the Council Chamber project" — `list_projects` → `list_project_files` → `get_project_file`.

---

## 8. Security Notes

- The SharePoint site is company-browsable **by design**; do not file anything there that shouldn't be company-visible. The only enforced boundary is at the tenant/site level.
- Edge function: service-role + app-only Graph ⇒ every op must verify the caller's JWT and project membership in code (mirrors the `sharepoint-cutsheet` authorization block).
- `bootstrap` is admin-only. Identity audit fields are always bound to the verified JWT, never the request body.
- Download URLs are short-lived (~1h) Graph pre-authenticated URLs; they are returned to authorized callers only and never persisted.

## 9. Out of Scope (Phase 1)

- Folder rename on project rename; per-file permissions; zip "download all"; Graph delta/webhook push sync; filing change-order documents (blocked on CO modeling); content search inside files (SharePoint/Copilot already covers native search).

## 10. Rollout / Setup Checklist

1. Create SharePoint site + document library; grant the existing Graph app registration access if `Sites.Selected`.
2. Apply `add_project_files.sql` in the Supabase dashboard SQL editor (manual, per deploy workflow).
3. Deploy `sharepoint-project-files`; run `bootstrap` with the site URL; set the two resolved env vars as function secrets.
4. Ship app UI + export hooks; then MCP tools.
