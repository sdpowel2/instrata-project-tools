/**
 * Cutsheet submittal workflow tools — the only write-capable tools this server
 * exposes. Everything runs through the per-user client, so the DB's RLS
 * policies ("Members can manage submittals" / "...submittal items") are the
 * authorization boundary: writes only succeed on projects the calling user is
 * a member of. Reads are org-wide, so a user can *see* projects they can't
 * write to — write failures are mapped to an explicit not-a-member error.
 *
 * Uploads reuse the sharepoint-cutsheet edge function's uploadStaging op,
 * which dedupes against the approved repository and otherwise stages the file
 * for admin review. See Product Spec/cutsheet-submittal-mcp-writes-spec.md.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ok, fail, sanitize, cutsheetStatus, type ToolRegistrar } from './toolHelpers.js';

// Twin of EXCLUDED_MANUFACTURERS in app/src/utils/submittalExclusions.ts —
// house manufacturers whose BoM rows are internal labor/service lines, never
// customer-facing equipment. Keep the two lists in sync.
const EXCLUDED_MANUFACTURERS = new Set(
  ['Instrata', 'Premiere', 'Cable Solutions', 'Net100', 'Kane'].map((m) => m.toLowerCase()),
);

const NOT_MEMBER_MSG =
  'You are not a member of this project, so you can\'t modify its submittals. ' +
  'Ask a project admin to add you as a member in the app.';

/** PostgREST surfaces RLS insert/update violations as code 42501. */
function rlsDenied(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42501' || /row-level security/i.test(error.message ?? '');
}

function dedupKey(manufacturer: string, model: string): string {
  return `${manufacturer.trim().toLowerCase()}|||${model.trim().toLowerCase()}`;
}

type RoomQty = { room: string; qty: number };

/** Merge two per-room quantity lists, summing qty where the same room appears
 *  in both. Twin of app/src/utils/submittalExclusions.ts mergeLocations. */
function mergeLocations(a: RoomQty[], b: RoomQty[]): RoomQty[] {
  const merged: RoomQty[] = a.map((l) => ({ ...l }));
  for (const loc of b) {
    const hit = merged.find((l) => l.room === loc.room);
    if (hit) hit.qty += loc.qty;
    else merged.push({ ...loc });
  }
  return merged;
}

/** Display name for a repo cutsheet: the filename tail of its SharePoint path. */
function pathTail(sharepointPath: string): string {
  return sharepointPath.split('/').pop() ?? sharepointPath;
}

const MAX_PDF_BYTES = 25 * 1024 * 1024; // URL fetches
const MAX_BASE64_CHARS = 5_600_000; // ≈ 4 MB decoded
const FETCH_TIMEOUT_MS = 30_000;

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
];

/** Basic SSRF guard for the attach_cutsheet URL path. */
function urlBlocked(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Invalid URL.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http(s) URLs are supported.';
  }
  const host = parsed.hostname;
  if (PRIVATE_HOST_PATTERNS.some((p) => p.test(host))) {
    return 'URLs pointing at local or private-network hosts are not allowed.';
  }
  return null;
}

function isPdf(bytes: Uint8Array): boolean {
  // %PDF-
  return (
    bytes.length > 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
  );
}

async function fetchPdf(url: string): Promise<{ bytes: Uint8Array } | { error: string }> {
  const blocked = urlBlocked(url);
  if (blocked) return { error: blocked };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { error: `Fetch failed with HTTP ${res.status}.` };
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_PDF_BYTES) return { error: `File exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MB limit.` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) return { error: `File exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MB limit.` };
    if (!isPdf(bytes)) return { error: 'The URL did not return a PDF (missing %PDF header).' };
    return { bytes };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'Fetch timed out.' : String(err);
    return { error: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Analytics row matching the app's attach flow. Fire-and-forget: never fatal. */
async function recordUsage(supa: SupabaseClient, cutsheetId: string, projectId: string, userId: string): Promise<void> {
  const { error } = await supa.from('cutsheet_project_usage').insert({
    cutsheet_id: cutsheetId,
    project_id: projectId,
    used_in: 'submittal',
    used_by_user_id: userId,
  });
  if (error) console.warn('[submittalTools] usage insert failed (non-fatal):', error.message);
}

type UploadStagingResult = {
  matched?: { repositoryId: string; sharepointPath: string };
  staged?: { stagingId: string; sharepointItemId: string; sharepointPath: string };
};

export function registerSubmittalTools(server: ToolRegistrar, supa: SupabaseClient, userId: string): void {
  // ── create_submittal ─────────────────────────────────────────────────────────
  server.registerTool(
    'create_submittal',
    {
      title: 'Create a submittal package',
      description:
        'Create a new submittal package on a project. prepared_by defaults to the calling ' +
        'user\'s full name and title defaults to "AV Submittals". Requires project ' +
        'membership. Follow up with populate_submittal_from_bom to add line items.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        submitted_to: z.string().describe('Recipient shown on the package (client contact / GC)'),
        title: z.string().optional().describe('Package title (default "AV Submittals")'),
        revision: z.string().optional().describe('Revision label (default "Rev 0")'),
        notes: z.string().optional().describe('Package notes'),
      },
    },
    async ({ project_id, submitted_to, title, revision, notes }) => {
      const { data: profile } = await supa.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
      const preparedBy = profile?.full_name || profile?.email || '';
      const { data, error } = await supa
        .from('submittals')
        .insert({
          project_id,
          title: title ?? 'AV Submittals',
          revision: revision ?? 'Rev 0',
          prepared_by: preparedBy,
          submitted_to,
          status: 'Draft',
          notes: notes ?? '',
        })
        .select('id, project_id, title, revision, prepared_by, submitted_to, status, notes, created_at')
        .single();
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      return ok(data);
    },
  );

  // ── update_submittal ─────────────────────────────────────────────────────────
  server.registerTool(
    'update_submittal',
    {
      title: 'Update a submittal package',
      description: 'Update fields on an existing submittal package (title, submitted_to, revision, notes).',
      inputSchema: {
        submittal_id: z.string().describe('Submittal uuid'),
        title: z.string().optional(),
        submitted_to: z.string().optional(),
        revision: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ submittal_id, title, submitted_to, revision, notes }) => {
      const patch: Record<string, string> = {};
      if (title !== undefined) patch.title = title;
      if (submitted_to !== undefined) patch.submitted_to = submitted_to;
      if (revision !== undefined) patch.revision = revision;
      if (notes !== undefined) patch.notes = notes;
      if (Object.keys(patch).length === 0) return fail('Provide at least one field to update.');
      const { data, error } = await supa
        .from('submittals')
        .update(patch)
        .eq('id', submittal_id)
        .select('id, title, revision, prepared_by, submitted_to, status, notes');
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      if (!data || data.length === 0) return fail(`Submittal not found — it may not exist, or: ${NOT_MEMBER_MSG}`);
      return ok(data[0]);
    },
  );

  // ── populate_submittal_from_bom ──────────────────────────────────────────────
  server.registerTool(
    'populate_submittal_from_bom',
    {
      title: 'Populate submittal line items from the project BoM',
      description:
        'Server-side equivalent of the app\'s "Autopopulate from BoM" button. Filters out ' +
        'labor and house-manufacturer rows, consolidates duplicate manufacturer+model rows ' +
        '(summing qty), inserts the line items, then auto-attaches cutsheets that already ' +
        'exist in the approved repository. Returns every item with has_cutsheet / ' +
        'cutsheet_source so you know exactly which items still need a cutsheet. Refuses to ' +
        'overwrite a submittal that already has items unless replace is true (replace ' +
        'deletes the existing items first).',
      inputSchema: {
        submittal_id: z.string().describe('Submittal uuid'),
        replace: z.boolean().optional().describe('Delete existing line items first (default false)'),
      },
    },
    async ({ submittal_id, replace }) => {
      const { data: submittal, error: subErr } = await supa
        .from('submittals')
        .select('id, project_id')
        .eq('id', submittal_id)
        .maybeSingle();
      if (subErr) return fail(subErr.message);
      if (!submittal) return fail('Submittal not found (it may not exist, or you may not have access).');
      const projectId = submittal.project_id as string;

      const { count: existingCount, error: countErr } = await supa
        .from('submittal_items')
        .select('id', { count: 'exact', head: true })
        .eq('submittal_id', submittal_id);
      if (countErr) return fail(countErr.message);
      if ((existingCount ?? 0) > 0 && !replace) {
        return fail(
          `This submittal already has ${existingCount} line items. Pass replace: true to delete ` +
            'them and repopulate from the BoM (any manually-added items and attached cutsheets ' +
            'on those items will be lost).',
        );
      }

      const { data: bom, error: bomErr } = await supa
        .from('project_bom_items')
        .select('manufacturer, model, description, category, qty, item_type, locations, cut_sheet_url, cut_sheet_name')
        .eq('project_id', projectId)
        .order('sort_order', { ascending: true });
      if (bomErr) return fail(bomErr.message);
      if (!bom || bom.length === 0) return fail('The project BoM is empty — nothing to populate.');

      // Filter + dedup, mirroring app/src/store/index.ts populateSubmittalFromBoM
      // and utils/submittalExclusions.ts.
      const eligible = bom.filter(
        (b) => b.item_type !== 'Labor' && !EXCLUDED_MANUFACTURERS.has((b.manufacturer ?? '').trim().toLowerCase()),
      );
      const consolidated = new Map<string, (typeof bom)[number] & { qty: number }>();
      for (const item of eligible) {
        const key = dedupKey(item.manufacturer ?? '', item.model ?? '');
        const existing = consolidated.get(key);
        if (existing) {
          existing.qty += item.qty;
          // The DTools sync splits one part into several BoM rows when it is
          // priced differently per row (e.g. a $0 OFE/CO copy next to the
          // priced one). Merge the room lists so the submittal's BoM-by-Room
          // covers every room, not just the first row's.
          existing.locations = mergeLocations(existing.locations ?? [], item.locations ?? []);
          if (!existing.cut_sheet_url && item.cut_sheet_url) {
            existing.cut_sheet_url = item.cut_sheet_url;
            existing.cut_sheet_name = item.cut_sheet_name;
          }
        } else {
          consolidated.set(key, { ...item, locations: [...(item.locations ?? [])] });
        }
      }
      const rows = Array.from(consolidated.values()).map((c, idx) => ({
        submittal_id,
        manufacturer: c.manufacturer,
        model: c.model,
        description: c.description,
        category: c.category,
        qty: c.qty,
        // BoM notes are internal estimating metadata — client-facing items start blank.
        notes: '',
        locations: c.locations ?? [],
        cut_sheet_url: c.cut_sheet_url ?? null,
        cut_sheet_name: c.cut_sheet_name ?? null,
        sort_order: idx,
      }));

      if (replace && (existingCount ?? 0) > 0) {
        const { error: delErr } = await supa.from('submittal_items').delete().eq('submittal_id', submittal_id);
        if (rlsDenied(delErr)) return fail(NOT_MEMBER_MSG);
        if (delErr) return fail(delErr.message);
      }

      const { data: inserted, error: insErr } = await supa
        .from('submittal_items')
        .insert(rows)
        .select('id, manufacturer, model, description, category, qty, sort_order, cutsheet_repository_id, cutsheet_staging_id, cut_sheet_url, cut_sheet_name');
      if (rlsDenied(insErr)) return fail(NOT_MEMBER_MSG);
      if (insErr) return fail(insErr.message);

      // Auto-attach cutsheets already in the approved repository. Non-fatal
      // (matches the app's fire-and-forget behavior) — report the failure so
      // the caller can retry attachment per item.
      let repoMatched = 0;
      let lookupWarning: string | undefined;
      const items = inserted ?? [];
      const candidates = items.filter((it) => !it.cut_sheet_url && !it.cutsheet_repository_id);
      if (candidates.length > 0) {
        const pairs = candidates.map((it) => ({ manufacturer: it.manufacturer, model: it.model }));
        const { data: lookupData, error: lookupErr } = await supa.functions.invoke<{
          matches: Record<string, { id: string; sharepoint_path: string }>;
        }>('sharepoint-cutsheet', { body: { op: 'lookupBatch', pairs } });
        if (lookupErr) {
          lookupWarning = `Repository auto-match failed (items were still created): ${lookupErr.message}`;
        } else {
          const matches = lookupData?.matches ?? {};
          for (const item of candidates) {
            const hit = matches[dedupKey(item.manufacturer, item.model)];
            if (!hit) continue;
            const name = pathTail(hit.sharepoint_path);
            const { error: updErr } = await supa
              .from('submittal_items')
              .update({ cutsheet_repository_id: hit.id, cut_sheet_name: name })
              .eq('id', item.id);
            if (updErr) {
              console.warn('[populate_submittal_from_bom] repo attach failed:', updErr.message);
              continue;
            }
            item.cutsheet_repository_id = hit.id;
            item.cut_sheet_name = name;
            repoMatched++;
            await recordUsage(supa, hit.id, projectId, userId);
          }
        }
      }

      const withStatus = items.map((it) => ({ ...it, ...cutsheetStatus(it) }));
      const missing = withStatus.filter((it) => !it.has_cutsheet).length;
      return ok({
        submittal_id,
        counts: {
          bom_rows: bom.length,
          excluded: bom.length - eligible.length,
          items: withStatus.length,
          repo_matched: repoMatched,
          missing_cutsheets: missing,
        },
        ...(lookupWarning ? { warning: lookupWarning } : {}),
        items: withStatus,
      });
    },
  );

  // ── search_cutsheet_repository ───────────────────────────────────────────────
  server.registerTool(
    'search_cutsheet_repository',
    {
      title: 'Search the approved cutsheet repository',
      description:
        'Search the org-wide approved cutsheet repository by manufacturer and/or model, or a ' +
        'free-text query. Use this to catch model-number variants before hunting for a PDF ' +
        'externally — if a near-match exists, attach it by repository_id with attach_cutsheet.',
      inputSchema: {
        manufacturer: z.string().optional().describe('Manufacturer name (partial ok)'),
        model: z.string().optional().describe('Model number (partial ok)'),
        query: z.string().optional().describe('Free-text match on manufacturer, model, or display name'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50)'),
      },
    },
    async ({ manufacturer, model, query, limit }) => {
      let q = supa
        .from('cutsheet_repository')
        .select('id, manufacturer, model_number, display_name, category, sharepoint_path')
        .order('manufacturer', { ascending: true })
        .limit(limit ?? 50);
      if (manufacturer) q = q.ilike('manufacturer', `%${sanitize(manufacturer)}%`);
      if (model) q = q.ilike('model_number', `%${sanitize(model)}%`);
      if (query) {
        const s = sanitize(query);
        if (s) q = q.or(`manufacturer.ilike.*${s}*,model_number.ilike.*${s}*,display_name.ilike.*${s}*`);
      }
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── attach_cutsheet ──────────────────────────────────────────────────────────
  server.registerTool(
    'attach_cutsheet',
    {
      title: 'Attach a cutsheet PDF to a submittal line item',
      description:
        'Attach a cutsheet to a submittal line item. Provide exactly one source: ' +
        'repository_id (from search_cutsheet_repository), url (a PDF the server fetches — ' +
        'e.g. a manufacturer spec sheet), or base64_pdf (small local file, ~4 MB max). ' +
        'URL/base64 uploads are deduped against the repository automatically; new files go ' +
        'to a staging area pending admin approval but attach and export immediately. ' +
        'Attaching over an existing cutsheet replaces it. Always tell the user how many ' +
        'attachments are pending admin approval when you finish.',
      inputSchema: {
        submittal_item_id: z.string().describe('Submittal line item uuid'),
        repository_id: z.string().optional().describe('Attach an existing approved repository cutsheet'),
        url: z.string().optional().describe('Publicly fetchable PDF URL'),
        base64_pdf: z.string().optional().describe('PDF bytes, base64 (no data: prefix), ~4 MB max'),
        manufacturer: z.string().optional().describe('Override manufacturer (defaults from the item)'),
        model: z.string().optional().describe('Override model (defaults from the item)'),
        filename: z.string().optional().describe('Filename for the uploaded PDF (defaults from URL or mfr_model.pdf)'),
      },
    },
    async ({ submittal_item_id, repository_id, url, base64_pdf, manufacturer, model, filename }) => {
      const sources = [repository_id, url, base64_pdf].filter((s) => s !== undefined);
      if (sources.length !== 1) return fail('Provide exactly one of repository_id, url, or base64_pdf.');

      const { data: item, error: itemErr } = await supa
        .from('submittal_items')
        .select('id, manufacturer, model, submittal_id, submittals(project_id)')
        .eq('id', submittal_item_id)
        .maybeSingle();
      if (itemErr) return fail(itemErr.message);
      if (!item) return fail('Submittal item not found (it may not exist, or you may not have access).');
      const parent = item.submittals as unknown as { project_id: string } | null;
      const projectId = parent?.project_id ?? '';
      const mfr = (manufacturer ?? item.manufacturer ?? '').trim();
      const mdl = (model ?? item.model ?? '').trim();

      const attachRepo = async (repoId: string, name: string) => {
        const { data: updated, error: updErr } = await supa
          .from('submittal_items')
          .update({ cutsheet_repository_id: repoId, cutsheet_staging_id: null, cut_sheet_url: null, cut_sheet_name: name })
          .eq('id', submittal_item_id)
          .select('id');
        if (rlsDenied(updErr)) return fail(NOT_MEMBER_MSG);
        if (updErr) return fail(updErr.message);
        if (!updated || updated.length === 0) return fail(NOT_MEMBER_MSG);
        if (projectId) await recordUsage(supa, repoId, projectId, userId);
        return ok({ attached: 'repository', repository_id: repoId, cut_sheet_name: name, pending_admin_approval: false });
      };

      // Path 1: attach an existing approved repository cutsheet.
      if (repository_id) {
        const { data: repo, error: repoErr } = await supa
          .from('cutsheet_repository')
          .select('id, sharepoint_path')
          .eq('id', repository_id)
          .maybeSingle();
        if (repoErr) return fail(repoErr.message);
        if (!repo) return fail('No repository cutsheet found with that id.');
        return attachRepo(repo.id, pathTail(repo.sharepoint_path));
      }

      // Paths 2/3: get PDF bytes, then run them through the staging upload flow.
      let bytes: Uint8Array;
      let name = filename?.trim() || '';
      if (url) {
        const fetched = await fetchPdf(url);
        if ('error' in fetched) return fail(fetched.error);
        bytes = fetched.bytes;
        if (!name) {
          try {
            const tail = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
            name = tail.toLowerCase().endsWith('.pdf') ? tail : '';
          } catch { /* fall through to default */ }
        }
      } else {
        if (base64_pdf!.length > MAX_BASE64_CHARS) return fail('base64_pdf exceeds the ~4 MB limit — host larger files at a URL instead.');
        try {
          bytes = new Uint8Array(Buffer.from(base64_pdf!, 'base64'));
        } catch {
          return fail('base64_pdf is not valid base64.');
        }
        if (!isPdf(bytes)) return fail('base64_pdf does not decode to a PDF (missing %PDF header).');
      }
      if (!name) name = `${mfr}_${mdl}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '_');

      // Stage bytes in the temp bucket, then hand off to the edge function,
      // which dedupes against the repository, uploads to SharePoint /Staging/,
      // and deletes the temp file in all outcomes.
      const storagePath = `mcp/${randomUUID()}.pdf`;
      const { error: upErr } = await supa.storage
        .from('cutsheet-temp')
        .upload(storagePath, bytes, { contentType: 'application/pdf' });
      if (upErr) return fail(`Temp upload failed: ${upErr.message}`);

      const { data: staging, error: stageErr } = await supa.functions.invoke<UploadStagingResult>('sharepoint-cutsheet', {
        body: {
          op: 'uploadStaging',
          storagePath,
          filename: name,
          manufacturer: mfr,
          model: mdl,
          projectId,
          sourceContext: 'mcp_skill',
          uploadedByUserId: userId,
        },
      });
      if (stageErr) return fail(`Cutsheet upload failed: ${stageErr.message}`);

      if (staging?.matched) {
        // The repository already had this mfr+model — attach the approved copy.
        return attachRepo(staging.matched.repositoryId, pathTail(staging.matched.sharepointPath));
      }
      if (!staging?.staged) return fail('Cutsheet upload returned an unexpected response.');

      const { data: updated, error: updErr } = await supa
        .from('submittal_items')
        .update({ cutsheet_staging_id: staging.staged.stagingId, cutsheet_repository_id: null, cut_sheet_url: null, cut_sheet_name: name })
        .eq('id', submittal_item_id)
        .select('id');
      if (rlsDenied(updErr)) return fail(NOT_MEMBER_MSG);
      if (updErr) return fail(updErr.message);
      if (!updated || updated.length === 0) return fail(NOT_MEMBER_MSG);
      return ok({
        attached: 'staging',
        staging_id: staging.staged.stagingId,
        cut_sheet_name: name,
        pending_admin_approval: true,
      });
    },
  );

  // ── detach_cutsheet ──────────────────────────────────────────────────────────
  server.registerTool(
    'detach_cutsheet',
    {
      title: 'Detach the cutsheet from a submittal line item',
      description:
        'Remove whatever cutsheet is attached to a submittal line item (repository link, ' +
        'staged upload, or legacy file) so a different one can be attached. A staged file ' +
        'stays in the admin review queue for an admin to reject.',
      inputSchema: { submittal_item_id: z.string().describe('Submittal line item uuid') },
    },
    async ({ submittal_item_id }) => {
      const { data, error } = await supa
        .from('submittal_items')
        .update({ cutsheet_repository_id: null, cutsheet_staging_id: null, cut_sheet_url: null, cut_sheet_name: null })
        .eq('id', submittal_item_id)
        .select('id, manufacturer, model');
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      if (!data || data.length === 0) return fail(`Item not found — it may not exist, or: ${NOT_MEMBER_MSG}`);
      return ok({ detached: true, item: data[0] });
    },
  );
}
