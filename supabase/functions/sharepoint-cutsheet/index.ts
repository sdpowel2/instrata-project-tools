// SharePoint cutsheet repository — app-only Microsoft Graph integration.
//
// One edge function dispatches every cutsheet operation via an `op` field in
// the POST body. App-only auth (client credentials flow) means every user
// hits SharePoint as the same registered application, regardless of their
// own SharePoint permissions — appropriate for a shared catalog.
//
// Required env vars (Supabase function secrets):
//   GRAPH_TENANT_ID         — Azure AD tenant ID
//   GRAPH_CLIENT_ID         — App registration ID
//   GRAPH_CLIENT_SECRET     — App secret
//
// After the first `bootstrap` call, the resolved IDs should be set as:
//   SHAREPOINT_SITE_ID                — Graph site ID
//   SHAREPOINT_DRIVE_ID               — Cutsheets library drive ID
//   SHAREPOINT_STAGING_FOLDER_ID      — /Cutsheets/Staging item ID
//   SHAREPOINT_REPOSITORY_FOLDER_ID   — /Cutsheets/Repository item ID
//
// All subsequent ops read those IDs directly and skip the resolve step.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT_ID     = Deno.env.get('GRAPH_TENANT_ID') ?? '';
const CLIENT_ID     = Deno.env.get('GRAPH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? '';
const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL     = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

// Resolved-once IDs. Set in Supabase function secrets after running bootstrap.
const SITE_ID                  = Deno.env.get('SHAREPOINT_SITE_ID') ?? '';
const DRIVE_ID                 = Deno.env.get('SHAREPOINT_DRIVE_ID') ?? '';
const STAGING_FOLDER_ID        = Deno.env.get('SHAREPOINT_STAGING_FOLDER_ID') ?? '';
const REPOSITORY_FOLDER_ID     = Deno.env.get('SHAREPOINT_REPOSITORY_FOLDER_ID') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
// App-only access tokens last ~1h. Cache in module scope so repeat invocations
// in the same warm container reuse the token until ~5min before expiry.
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

// ─── Operations ───────────────────────────────────────────────────────────────

interface BootstrapInput {
  siteUrl: string;       // e.g. https://kaneinfrastructureservices.sharepoint.com/sites/CutsheetRepository
  libraryName: string;   // e.g. Cutsheets
  stagingFolder?: string;    // default 'Staging'
  repositoryFolder?: string; // default 'Repository'
}

/**
 * Resolve SharePoint URL → Graph IDs. Returns the IDs the caller should set
 * as Supabase function env vars. This is run once at setup time, never in
 * the hot path.
 */
async function bootstrap(input: BootstrapInput) {
  const { siteUrl, libraryName, stagingFolder = 'Staging', repositoryFolder = 'Repository' } = input;
  const url = new URL(siteUrl);
  const hostname = url.hostname;
  // /sites/foo → "sites/foo" (strip leading slash)
  const sitePath = url.pathname.replace(/^\/+/, '');

  // Site lookup — needs Sites.Read.All
  const site = await graphJson<{ id: string; displayName: string; webUrl: string }>(
    `/sites/${hostname}:/${sitePath}`,
  );

  // List drives in the site, find the one whose name matches the library
  const drives = await graphJson<{ value: { id: string; name: string; webUrl: string }[] }>(
    `/sites/${site.id}/drives`,
  );
  const drive = drives.value.find((d) => d.name.toLowerCase() === libraryName.toLowerCase());
  if (!drive) {
    return {
      site,
      drives: drives.value,
      error: `Drive "${libraryName}" not found in site. Available: ${drives.value.map((d) => d.name).join(', ')}`,
    };
  }

  // Resolve folder IDs by name from the drive root
  const root = await graphJson<{ value: { id: string; name: string; folder?: unknown }[] }>(
    `/drives/${drive.id}/root/children`,
  );
  const findFolder = (name: string) => root.value.find(
    (i) => !!i.folder && i.name.toLowerCase() === name.toLowerCase(),
  );
  const staging = findFolder(stagingFolder);
  const repository = findFolder(repositoryFolder);

  return {
    site: { id: site.id, displayName: site.displayName, webUrl: site.webUrl },
    drive: { id: drive.id, name: drive.name, webUrl: drive.webUrl },
    folders: {
      staging: staging ? { id: staging.id, name: staging.name } : null,
      repository: repository ? { id: repository.id, name: repository.name } : null,
    },
    rootChildren: root.value.map((i) => ({ name: i.name, isFolder: !!i.folder })),
    envVarsToSet: {
      SHAREPOINT_SITE_ID: site.id,
      SHAREPOINT_DRIVE_ID: drive.id,
      SHAREPOINT_STAGING_FOLDER_ID: staging?.id ?? null,
      SHAREPOINT_REPOSITORY_FOLDER_ID: repository?.id ?? null,
    },
  };
}

interface LookupInput {
  manufacturer: string;
  model: string;
  /** When true, also resolves a fresh download URL from Graph. Skip for cheap "exists?" checks. */
  withDownloadUrl?: boolean;
}

/**
 * Find a cutsheet in the repository for the given manufacturer + model.
 * Case- and whitespace-insensitive. Returns the repo record (and a fresh
 * download URL when requested) or null.
 */
async function lookup(input: LookupInput, supabase: ReturnType<typeof createClient>) {
  const mfr = input.manufacturer.trim();
  const model = input.model.trim();
  if (!mfr || !model) return { found: false, reason: 'manufacturer and model required' };

  const { data, error } = await supabase
    .from('cutsheet_repository')
    .select('*')
    .ilike('manufacturer', mfr)
    .ilike('model_number', model)
    .maybeSingle();

  if (error) throw new Error(`Repository query failed: ${error.message}`);
  if (!data) return { found: false };

  if (!input.withDownloadUrl) {
    return { found: true, repository: data };
  }

  const downloadUrl = await getDownloadUrlFor(data.sharepoint_item_id);
  return { found: true, repository: data, downloadUrl };
}

/**
 * Batch variant — pass a list of {manufacturer, model} and get back a map of
 * matches keyed by "lower(mfr)|||lower(model)". Used by the populate-from-BoM
 * flow which checks dozens of items at once.
 */
async function lookupBatch(
  pairs: { manufacturer: string; model: string }[],
  supabase: ReturnType<typeof createClient>,
) {
  const matches: Record<string, { id: string; sharepoint_item_id: string; sharepoint_path: string; manufacturer: string; model_number: string }> = {};
  if (pairs.length === 0) return { matches };

  // Pull the entire repository (small table) and filter in-memory. Cleaner
  // than building a giant OR clause and the table will stay small (hundreds,
  // not millions, of rows).
  const { data, error } = await supabase
    .from('cutsheet_repository')
    .select('id, manufacturer, model_number, sharepoint_item_id, sharepoint_path');
  if (error) throw new Error(`Batch lookup failed: ${error.message}`);

  const repoIndex = new Map<string, typeof data[number]>();
  for (const r of data ?? []) {
    const key = `${r.manufacturer.trim().toLowerCase()}|||${r.model_number.trim().toLowerCase()}`;
    repoIndex.set(key, r);
  }
  for (const pair of pairs) {
    const key = `${pair.manufacturer.trim().toLowerCase()}|||${pair.model.trim().toLowerCase()}`;
    const hit = repoIndex.get(key);
    if (hit) matches[key] = hit;
  }
  return { matches };
}

/**
 * Get a fresh, short-lived (~1h) pre-authenticated download URL for a
 * SharePoint item. Safe to embed in <iframe>/<embed> or hand to the browser
 * for direct download — no proxying through this server required.
 */
async function getDownloadUrlFor(itemId: string): Promise<string> {
  const item = await graphJson<{ '@microsoft.graph.downloadUrl'?: string }>(
    `/drives/${DRIVE_ID}/items/${itemId}?select=@microsoft.graph.downloadUrl`,
  );
  const url = item['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('Graph response missing download URL');
  return url;
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

  try {
    switch (op) {
      case 'bootstrap': {
        if (!body.siteUrl || !body.libraryName) {
          return jsonResponse({ error: 'siteUrl and libraryName required' }, 400);
        }
        return jsonResponse(await bootstrap(body));
      }
      case 'lookup': {
        return jsonResponse(await lookup(body, supabase));
      }
      case 'lookupBatch': {
        if (!Array.isArray(body.pairs)) {
          return jsonResponse({ error: 'pairs (array) required' }, 400);
        }
        return jsonResponse(await lookupBatch(body.pairs, supabase));
      }
      case 'getDownloadUrl': {
        if (!body.sharepointItemId) {
          return jsonResponse({ error: 'sharepointItemId required' }, 400);
        }
        const url = await getDownloadUrlFor(String(body.sharepointItemId));
        return jsonResponse({ downloadUrl: url });
      }
      default:
        return jsonResponse({ error: `Unknown op: ${op}` }, 400);
    }
  } catch (err) {
    console.error('[sharepoint-cutsheet] op failed:', op, err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
