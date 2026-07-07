// Project Files — per-project SharePoint document repository.
//
// One edge function dispatches every project-file operation via an `op` field
// in the POST body. Same app-only Graph pattern as sharepoint-cutsheet: every
// caller hits SharePoint as the registered application, and authorization is
// enforced in-code against the verified Supabase JWT. SharePoint holds the
// bytes; public.project_files is the canonical index the app and MCP browse.
// See Product Spec/04-project-files.md.
//
// Required env vars (Supabase function secrets — Graph creds shared with
// sharepoint-cutsheet):
//   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET
//
// After the first `bootstrap` call, set:
//   SHAREPOINT_PROJECTS_SITE_ID   — Graph site ID of the Projects site
//   SHAREPOINT_PROJECTS_DRIVE_ID  — document library drive ID

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT_ID     = Deno.env.get('GRAPH_TENANT_ID') ?? '';
const CLIENT_ID     = Deno.env.get('GRAPH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? '';
const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL     = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

const SITE_ID  = Deno.env.get('SHAREPOINT_PROJECTS_SITE_ID') ?? '';
const DRIVE_ID = Deno.env.get('SHAREPOINT_PROJECTS_DRIVE_ID') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TEMP_BUCKET = 'project-files-temp';

// Category key (stored in project_files.category) → SharePoint folder name.
const CATEGORY_FOLDERS: Record<string, string> = {
  contracts:     'Contracts',
  drawings:      'Drawings',
  submittals:    'Submittals',
  meeting_notes: 'Meeting Notes',
  photos:        'Photos',
  closeout:      'Closeout',
  general:       'General',
};

/** Reverse lookup: SharePoint folder name (case-insensitive) → category key. */
function categoryForFolderName(name: string): string {
  const lower = name.trim().toLowerCase();
  for (const [key, folder] of Object.entries(CATEGORY_FOLDERS)) {
    if (folder.toLowerCase() === lower) return key;
  }
  return 'general';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

// ─── Token cache ──────────────────────────────────────────────────────────────
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cachedToken.token;
  }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Graph credentials missing — set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token request failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

async function graphFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAppToken();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init?.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${GRAPH_BASE}${path}`, { ...init, headers });
}

async function graphJson<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await graphFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Graph ${res.status} ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

/** Sanitize a string so it's safe as a filename/folder name in SharePoint. */
function fsSafe(s: string): string {
  return s.replace(/[\\\/:*?"<>|]+/g, '-').trim().slice(0, 120);
}

// ─── Graph item helpers ───────────────────────────────────────────────────────

interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  parentReference?: { path?: string };
}

function itemPath(item: DriveItem): string {
  return `${item.parentReference?.path ?? ''}/${item.name}`.replace(/^\/drives\/[^/]+\/root:/, '');
}

/** List every child of a folder, following @odata.nextLink pagination. */
async function listChildren(folderId: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let url: string | null =
    `/drives/${DRIVE_ID}/items/${folderId}/children?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference&$top=200`;
  while (url) {
    const page = await graphJson<{ value: DriveItem[]; '@odata.nextLink'?: string }>(url);
    items.push(...page.value);
    // nextLink is absolute; strip the base so graphJson can re-prefix it.
    url = page['@odata.nextLink'] ? page['@odata.nextLink'].replace(GRAPH_BASE, '') : null;
  }
  return items;
}

/**
 * Find-or-create a folder named `name` under `parentId`. Handles the
 * create-race by re-looking-up on 409 nameAlreadyExists.
 */
async function ensureFolder(parentId: string, name: string): Promise<DriveItem> {
  const lookup = await graphFetch(
    `/drives/${DRIVE_ID}/items/${parentId}:/${encodeURIComponent(name)}`,
  );
  if (lookup.ok) return await lookup.json();
  if (lookup.status !== 404) {
    const text = await lookup.text();
    throw new Error(`Folder lookup failed (${lookup.status}): ${text.slice(0, 300)}`);
  }
  const createRes = await graphFetch(`/drives/${DRIVE_ID}/items/${parentId}/children`, {
    method: 'POST',
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
  if (createRes.ok) return await createRes.json();
  if (createRes.status === 409) {
    // Someone else created it between our lookup and create — fetch theirs.
    return await graphJson<DriveItem>(
      `/drives/${DRIVE_ID}/items/${parentId}:/${encodeURIComponent(name)}`,
    );
  }
  const text = await createRes.text();
  throw new Error(`Folder create failed (${createRes.status}): ${text.slice(0, 300)}`);
}

// ─── Authorization helpers ────────────────────────────────────────────────────

type Supa = ReturnType<typeof createClient>;

interface ProjectRow {
  id: string;
  name: string;
  number: string | null;
  project_code: string | null;
  created_by: string | null;
  sharepoint_folder_id: string | null;
}

async function loadProject(supabase: Supa, projectId: string): Promise<ProjectRow> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, number, project_code, created_by, sharepoint_folder_id')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new Error(`Project lookup failed: ${error.message}`);
  if (!data) throw new Error('Project not found');
  return data as unknown as ProjectRow;
}

/**
 * Mirror of public.is_project_member(): admin, project creator, or a
 * project_members row. Runs against the service-role client because RLS
 * (and auth.uid()) don't apply on this connection.
 */
async function isMember(
  supabase: Supa,
  project: ProjectRow,
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;
  if (project.created_by === userId) return true;
  const { data } = await supabase
    .from('project_members')
    .select('user_id')
    .eq('project_id', project.id)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

// ─── Operations ───────────────────────────────────────────────────────────────

interface BootstrapInput {
  siteUrl: string;      // e.g. https://instrata.sharepoint.com/sites/Projects
  libraryName: string;  // e.g. "Project Files" or "Documents"
}

/** Resolve SharePoint URL → Graph IDs. Run once at setup, never in the hot path. */
async function bootstrap(input: BootstrapInput) {
  const url = new URL(input.siteUrl);
  const sitePath = url.pathname.replace(/^\/+/, '');
  const site = await graphJson<{ id: string; displayName: string; webUrl: string }>(
    `/sites/${url.hostname}:/${sitePath}`,
  );
  const drives = await graphJson<{ value: { id: string; name: string; webUrl: string }[] }>(
    `/sites/${site.id}/drives`,
  );
  const drive = drives.value.find((d) => d.name.toLowerCase() === input.libraryName.toLowerCase());
  if (!drive) {
    return {
      site,
      drives: drives.value,
      error: `Drive "${input.libraryName}" not found in site. Available: ${drives.value.map((d) => d.name).join(', ')}`,
    };
  }
  return {
    site: { id: site.id, displayName: site.displayName, webUrl: site.webUrl },
    drive: { id: drive.id, name: drive.name, webUrl: drive.webUrl },
    envVarsToSet: {
      SHAREPOINT_PROJECTS_SITE_ID: site.id,
      SHAREPOINT_PROJECTS_DRIVE_ID: drive.id,
    },
  };
}

/** "{number} - {name}", falling back gracefully when number is missing. */
function projectFolderName(project: ProjectRow): string {
  const num = (project.number ?? project.project_code ?? '').trim();
  const name = project.name.trim();
  return fsSafe(num ? `${num} - ${name}` : name);
}

/**
 * Find-or-create the project's root folder, persisting its Graph id on the
 * projects row so later ops skip the path lookup. With createIfMissing=false
 * (sync path) returns null instead of creating — folders are only created
 * when someone actually puts a file in them.
 */
async function resolveProjectFolder(
  supabase: Supa,
  project: ProjectRow,
  createIfMissing: boolean,
): Promise<DriveItem | null> {
  if (!DRIVE_ID) throw new Error('SHAREPOINT_PROJECTS_DRIVE_ID env var not set — run bootstrap first');

  // Cached id — verify it still exists (folder may have been deleted natively).
  if (project.sharepoint_folder_id) {
    const res = await graphFetch(`/drives/${DRIVE_ID}/items/${project.sharepoint_folder_id}`);
    if (res.ok) return await res.json();
    if (res.status !== 404) {
      const text = await res.text();
      throw new Error(`Folder fetch failed (${res.status}): ${text.slice(0, 300)}`);
    }
    // Stale pointer — fall through to path lookup / create.
  }

  const name = projectFolderName(project);
  const lookup = await graphFetch(`/drives/${DRIVE_ID}/root:/${encodeURIComponent(name)}`);
  let folder: DriveItem | null = null;
  if (lookup.ok) {
    folder = await lookup.json();
  } else if (lookup.status !== 404) {
    const text = await lookup.text();
    throw new Error(`Folder lookup failed (${lookup.status}): ${text.slice(0, 300)}`);
  } else if (createIfMissing) {
    folder = await ensureFolder('root', name);
  }

  if (folder && folder.id !== project.sharepoint_folder_id) {
    await supabase.from('projects')
      .update({ sharepoint_folder_id: folder.id })
      .eq('id', project.id);
  }
  return folder;
}

interface EnsureFolderInput { projectId: string; category?: string }

async function ensureProjectFolder(input: EnsureFolderInput, supabase: Supa) {
  const project = await loadProject(supabase, input.projectId);
  const root = await resolveProjectFolder(supabase, project, true);
  if (!root) throw new Error('Project folder resolution failed');
  const result: {
    projectFolder: { id: string; webUrl?: string };
    categoryFolder?: { id: string; webUrl?: string };
  } = { projectFolder: { id: root.id, webUrl: root.webUrl } };
  if (input.category) {
    const folderName = CATEGORY_FOLDERS[input.category];
    if (!folderName) throw new Error(`Unknown category: ${input.category}`);
    const cat = await ensureFolder(root.id, folderName);
    result.categoryFolder = { id: cat.id, webUrl: cat.webUrl };
  }
  return result;
}

interface UploadInput {
  projectId: string;
  category?: string;      // default 'general'
  filename: string;
  /** Path within the project-files-temp bucket. Preferred — bypasses the
   *  edge-function body-size limit. Downloaded, forwarded, then deleted. */
  storagePath?: string;
  /** Base64 bytes (no data: prefix). Fallback for small files (~<5MB). */
  fileBase64?: string;
  mimeType?: string;
  /** 'upload' (default) or 'generated' for auto-filed exports. */
  source?: string;
  /** For generated docs: submittal_package, rfi, closeout, sign_off, ... */
  docType?: string;
  /** Bound to the verified JWT by the handler — never trusted from the body. */
  uploadedByUserId?: string;
}

async function upload(input: UploadInput, supabase: Supa) {
  if (!input.projectId) throw new Error('projectId required');
  if (!input.filename) throw new Error('filename required');
  if (!input.storagePath && !input.fileBase64) throw new Error('storagePath or fileBase64 required');
  const category = input.category ?? 'general';
  if (!CATEGORY_FOLDERS[category]) throw new Error(`Unknown category: ${category}`);
  const source = input.source === 'generated' ? 'generated' : 'upload';

  try {
    // 1. Resolve bytes.
    let binary: Uint8Array;
    if (input.storagePath) {
      const { data, error } = await supabase.storage.from(TEMP_BUCKET).download(input.storagePath);
      if (error || !data) throw new Error(`Temp storage download failed: ${error?.message ?? 'no data'}`);
      binary = new Uint8Array(await data.arrayBuffer());
    } else {
      binary = Uint8Array.from(atob(input.fileBase64!), (c) => c.charCodeAt(0));
    }

    // 2. Ensure the destination folder chain exists.
    const project = await loadProject(supabase, input.projectId);
    const root = await resolveProjectFolder(supabase, project, true);
    if (!root) throw new Error('Project folder resolution failed');
    const catFolder = await ensureFolder(root.id, CATEGORY_FOLDERS[category]);

    // 3. PUT the file. conflictBehavior=rename gives "name (2).ext" instead
    //    of overwriting when a same-named file already exists.
    const safeName = fsSafe(input.filename) || 'file';
    const uploadRes = await graphFetch(
      `/drives/${DRIVE_ID}/items/${catFolder.id}:/${encodeURIComponent(safeName)}:/content` +
        `?@microsoft.graph.conflictBehavior=rename`,
      {
        method: 'PUT',
        headers: { 'Content-Type': input.mimeType || 'application/octet-stream' },
        body: binary,
      },
    );
    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) {
      throw new Error(`SharePoint upload failed (${uploadRes.status}): ${uploadText.slice(0, 500)}`);
    }
    const uploaded = JSON.parse(uploadText) as DriveItem;

    // 4. Write the index row.
    const { data: row, error } = await supabase
      .from('project_files')
      .insert({
        project_id: input.projectId,
        category,
        filename: uploaded.name,
        sharepoint_item_id: uploaded.id,
        sharepoint_path: itemPath(uploaded),
        sharepoint_web_url: uploaded.webUrl ?? null,
        size_bytes: uploaded.size ?? binary.byteLength,
        mime_type: uploaded.file?.mimeType ?? input.mimeType ?? null,
        source,
        doc_type: input.docType ?? null,
        uploaded_by: input.uploadedByUserId ?? null,
        sharepoint_modified_at: uploaded.lastModifiedDateTime ?? null,
      })
      .select('*')
      .single();
    if (error || !row) {
      // Roll back the SharePoint upload so we don't leave unindexed files.
      try {
        await graphFetch(`/drives/${DRIVE_ID}/items/${uploaded.id}`, { method: 'DELETE' });
      } catch (cleanupErr) {
        console.error('[upload] failed to roll back SharePoint upload:', cleanupErr);
      }
      throw new Error(`Index insert failed: ${error?.message ?? 'unknown'}`);
    }
    return { file: row };
  } finally {
    if (input.storagePath) {
      await supabase.storage.from(TEMP_BUCKET).remove([input.storagePath])
        .catch((e: unknown) => console.warn('[upload] temp cleanup failed:', e));
    }
  }
}

interface FileRefInput { fileId: string }

async function loadFileRow(supabase: Supa, fileId: string) {
  const { data, error } = await supabase
    .from('project_files')
    .select('*')
    .eq('id', fileId)
    .maybeSingle();
  if (error) throw new Error(`File lookup failed: ${error.message}`);
  if (!data) throw new Error('File not found');
  return data;
}

/** Fresh ~1h pre-authenticated download URL — safe to hand to the browser. */
async function getDownloadUrl(input: FileRefInput, supabase: Supa) {
  const row = await loadFileRow(supabase, input.fileId);
  const item = await graphJson<{ '@microsoft.graph.downloadUrl'?: string }>(
    `/drives/${DRIVE_ID}/items/${row.sharepoint_item_id}?select=@microsoft.graph.downloadUrl`,
  );
  const url = item['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('Graph response missing download URL');
  return {
    downloadUrl: url,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    webUrl: row.sharepoint_web_url,
  };
}

async function deleteFile(input: FileRefInput, supabase: Supa) {
  const row = await loadFileRow(supabase, input.fileId);
  // Delete the SharePoint item first; tolerate 404 (already gone natively).
  const delRes = await graphFetch(`/drives/${DRIVE_ID}/items/${row.sharepoint_item_id}`, {
    method: 'DELETE',
  });
  if (!delRes.ok && delRes.status !== 404) {
    const text = await delRes.text();
    throw new Error(`SharePoint delete failed (${delRes.status}): ${text.slice(0, 300)}`);
  }
  const { error } = await supabase.from('project_files').delete().eq('id', input.fileId);
  if (error) throw new Error(`Index delete failed: ${error.message}`);
  return { deleted: true };
}

interface SyncInput { projectId: string }

/**
 * Reconcile the index with what's actually in SharePoint. Walks the project
 * folder root plus one level of subfolders (files nested deeper aren't
 * indexed — Phase 1 limitation). SharePoint wins every conflict: unknown
 * items are inserted as source='sharepoint_sync', changed items are updated,
 * and index rows whose SharePoint item vanished are removed.
 */
async function sync(input: SyncInput, supabase: Supa) {
  if (!input.projectId) throw new Error('projectId required');
  const project = await loadProject(supabase, input.projectId);
  const root = await resolveProjectFolder(supabase, project, false);
  if (!root) {
    return { folderExists: false, added: 0, updated: 0, removed: 0 };
  }

  // Collect every file we can see: root-level files count as 'general';
  // files inside a first-level subfolder get that folder's category (unknown
  // folder names also map to 'general', but keep their real path).
  type Seen = {
    category: string; filename: string; path: string; webUrl?: string;
    size?: number; mimeType?: string; modified?: string;
  };
  const seen = new Map<string, Seen>();
  const rootChildren = await listChildren(root.id);
  const subfolders: DriveItem[] = [];
  for (const item of rootChildren) {
    if (item.folder) subfolders.push(item);
    else seen.set(item.id, toSeen(item, 'general'));
  }
  for (const folder of subfolders) {
    const category = categoryForFolderName(folder.name);
    const children = await listChildren(folder.id);
    for (const item of children) {
      if (item.folder) continue; // nested folders not walked in Phase 1
      seen.set(item.id, toSeen(item, category));
    }
  }

  function toSeen(item: DriveItem, category: string): Seen {
    return {
      category,
      filename: item.name,
      path: itemPath(item),
      webUrl: item.webUrl,
      size: item.size,
      mimeType: item.file?.mimeType,
      modified: item.lastModifiedDateTime,
    };
  }

  // Diff against the index.
  const { data: existing, error } = await supabase
    .from('project_files')
    .select('id, sharepoint_item_id, category, filename, sharepoint_path, sharepoint_modified_at, size_bytes')
    .eq('project_id', input.projectId);
  if (error) throw new Error(`Index query failed: ${error.message}`);

  const byItemId = new Map((existing ?? []).map((r) => [r.sharepoint_item_id as string, r]));
  let added = 0, updated = 0, removed = 0;

  for (const [itemId, s] of seen) {
    const row = byItemId.get(itemId);
    if (!row) {
      const { error: insErr } = await supabase.from('project_files').insert({
        project_id: input.projectId,
        category: s.category,
        filename: s.filename,
        sharepoint_item_id: itemId,
        sharepoint_path: s.path,
        sharepoint_web_url: s.webUrl ?? null,
        size_bytes: s.size ?? null,
        mime_type: s.mimeType ?? null,
        source: 'sharepoint_sync',
        uploaded_by: null,
        sharepoint_modified_at: s.modified ?? null,
      });
      if (insErr) console.warn('[sync] insert failed:', s.filename, insErr.message);
      else added++;
    } else {
      const changed =
        row.filename !== s.filename ||
        row.category !== s.category ||
        row.sharepoint_path !== s.path ||
        (s.modified ?? null) !== (row.sharepoint_modified_at as string | null) ||
        (s.size ?? null) !== (row.size_bytes as number | null);
      if (changed) {
        const { error: updErr } = await supabase.from('project_files').update({
          filename: s.filename,
          category: s.category,
          sharepoint_path: s.path,
          sharepoint_web_url: s.webUrl ?? null,
          size_bytes: s.size ?? null,
          sharepoint_modified_at: s.modified ?? null,
        }).eq('id', row.id);
        if (updErr) console.warn('[sync] update failed:', s.filename, updErr.message);
        else updated++;
      }
    }
  }

  const goneIds = (existing ?? [])
    .filter((r) => !seen.has(r.sharepoint_item_id as string))
    .map((r) => r.id);
  if (goneIds.length > 0) {
    const { error: delErr } = await supabase.from('project_files').delete().in('id', goneIds);
    if (delErr) console.warn('[sync] removal failed:', delErr.message);
    else removed = goneIds.length;
  }

  return {
    folderExists: true,
    folderWebUrl: root.webUrl ?? null,
    added, updated, removed,
    total: seen.size,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const op = String(body?.op ?? '');
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Authorization ─────────────────────────────────────────────────────────
  // Service-role + app-only Graph means RLS never runs here — enforce in code.
  // Require a real authenticated user; reads (getDownloadUrl, sync) are open
  // to any authenticated user to match the org-wide project_files SELECT
  // policy, while mutations (upload, delete, ensureProjectFolder) require
  // project membership. bootstrap is admin-only.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return jsonResponse({ error: 'Missing Authorization header' }, 401);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return jsonResponse({ error: 'Invalid or anonymous token' }, 401);

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).maybeSingle();
  const isAdmin = profile?.role === 'admin';

  if (op === 'bootstrap' && !isAdmin) {
    return jsonResponse({ error: 'Admin role required' }, 403);
  }

  // Bind identity to the verified caller — never trust the body.
  body.uploadedByUserId = user.id;

  // Membership gate for mutating ops.
  const MEMBER_OPS = new Set(['upload', 'delete', 'ensureProjectFolder']);
  if (MEMBER_OPS.has(op)) {
    const projectId = op === 'delete'
      ? (await loadFileRow(supabase, String(body.fileId ?? '')).catch(() => null))?.project_id
      : body.projectId;
    if (!projectId) return jsonResponse({ error: 'projectId (or valid fileId) required' }, 400);
    const project = await loadProject(supabase, String(projectId)).catch(() => null);
    if (!project) return jsonResponse({ error: 'Project not found' }, 404);
    if (!(await isMember(supabase, project, user.id, isAdmin))) {
      return jsonResponse({ error: 'Project membership required' }, 403);
    }
  }

  try {
    switch (op) {
      case 'bootstrap': {
        if (!body.siteUrl || !body.libraryName) {
          return jsonResponse({ error: 'siteUrl and libraryName required' }, 400);
        }
        return jsonResponse(await bootstrap(body));
      }
      case 'ensureProjectFolder':
        return jsonResponse(await ensureProjectFolder(body, supabase));
      case 'upload':
        return jsonResponse(await upload(body, supabase));
      case 'getDownloadUrl': {
        if (!body.fileId) return jsonResponse({ error: 'fileId required' }, 400);
        return jsonResponse(await getDownloadUrl(body, supabase));
      }
      case 'delete': {
        if (!body.fileId) return jsonResponse({ error: 'fileId required' }, 400);
        return jsonResponse(await deleteFile(body, supabase));
      }
      case 'sync':
        return jsonResponse(await sync(body, supabase));
      default:
        return jsonResponse({ error: `Unknown op: ${op}` }, 400);
    }
  } catch (err) {
    console.error('[sharepoint-project-files] op failed:', op, err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
