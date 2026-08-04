/**
 * Document tools: list_recent_documents, read_document (spec §6.9, §6.10).
 *
 * Procore's Documents tool is a folder tree. We fetch the root folder via
 * GET /rest/v1.0/folders?project_id= and recurse into subfolders via
 * GET /rest/v1.0/folders/{id}?project_id=, collecting each folder's files[].
 * read_document reuses that same walk to locate a file, then downloads the
 * latest version's URL and extracts text from an in-memory buffer (no disk).
 *
 * NOTE: file-object fields (file_versions/url/size) are coded defensively; verify
 * against a real file once the sandbox has documents.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectRef } from '../procore/types.js';
import { ok, fail, clampLimit, resolveSince, MAX_LIMIT } from './helpers.js';
import { personName, withinSince, firstStr } from './normalize.js';
import { resolveProject, orientation } from './scope.js';
import { extractText } from '../extract/text.js';

const MAX_FOLDERS = 500; // cap folder fetches so a huge tree can't run away
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB hard ceiling (spec §6.10)
const DEFAULT_MAX_CHARS = 40_000;

type RawFolder = {
  id: number;
  name?: string;
  name_with_path?: string;
  folders?: Array<{ id: number }>;
  files?: any[];
};

export type DocItem = {
  file_id: number;
  filename?: string;
  folder_path?: string;
  size_bytes?: number;
  updated_at?: string;
  updated_by?: string;
};

const latestVersion = (f: any): any =>
  Array.isArray(f.file_versions) && f.file_versions.length ? f.file_versions[0] : undefined;

function fetchFolder(ctx: AppContext, ref: ProjectRef, folderId?: number): Promise<RawFolder> {
  const path = folderId ? `/rest/v1.0/folders/${folderId}` : `/rest/v1.0/folders`;
  return ctx.rest.get<RawFolder>(path, { companyId: ref.company_id, query: { project_id: ref.project_id } });
}

/** Walk the Documents tree breadth-first, collecting files with their folder path. */
async function collectFiles(
  ctx: AppContext,
  ref: ProjectRef,
): Promise<{ files: Array<{ raw: any; folderPath: string }>; truncated: boolean }> {
  const files: Array<{ raw: any; folderPath: string }> = [];
  const queue: number[] = [];
  let fetched = 0;

  const process = (folder: RawFolder) => {
    const folderPath = folder.name_with_path ?? folder.name ?? '';
    for (const f of folder.files ?? []) files.push({ raw: f, folderPath });
    for (const sub of folder.folders ?? []) queue.push(sub.id);
  };

  process(await fetchFolder(ctx, ref)); // root
  while (queue.length && fetched < MAX_FOLDERS) {
    const id = queue.shift()!;
    fetched++;
    try {
      process(await fetchFolder(ctx, ref, id));
    } catch {
      // A single unreadable folder shouldn't sink the whole listing.
    }
  }
  return { files, truncated: queue.length > 0 };
}

function normalizeFile(raw: any, folderPath: string): DocItem {
  const v = latestVersion(raw);
  return {
    file_id: raw.id,
    filename: firstStr(raw.name, raw.filename, v?.name),
    folder_path: folderPath || undefined,
    size_bytes: raw.size ?? v?.size,
    updated_at: raw.updated_at,
    updated_by: personName(raw.updated_by ?? raw.created_by),
  };
}

export async function fetchRecentDocuments(
  ctx: AppContext,
  ref: ProjectRef,
  opts: { since: string; limit: number; folderPath?: string },
): Promise<{ items: DocItem[]; has_more: boolean; truncated_traversal: boolean }> {
  const { files, truncated } = await collectFiles(ctx, ref);
  let items = files.map(({ raw, folderPath }) => normalizeFile(raw, folderPath)).filter((d) => withinSince(d.updated_at, opts.since));
  if (opts.folderPath) {
    items = items.filter((d) => (d.folder_path ?? '').toLowerCase().includes(opts.folderPath!.toLowerCase()));
  }
  items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return { items: items.slice(0, opts.limit), has_more: items.length > opts.limit, truncated_traversal: truncated };
}

export async function readDocument(
  ctx: AppContext,
  ref: ProjectRef,
  fileId: number,
  maxChars: number,
): Promise<unknown> {
  // The single-file GET works even though the flat /files list 404s. It carries
  // the latest version's signed download URL.
  const f = await ctx.rest.get<any>(`/rest/v1.0/files/${fileId}`, {
    companyId: ref.company_id,
    query: { project_id: ref.project_id },
  });
  const v = latestVersion(f);
  const url = firstStr(v?.url, v?.prostore_file?.url, f.url);
  const filename = firstStr(f.name, f.filename) ?? `file-${fileId}`;
  const declaredSize = f.size ?? v?.size;
  if (!url) return { ...orientation(ref), filename, extracted: false, note: 'No downloadable version found for this file.' };
  if (declaredSize && declaredSize > MAX_FILE_BYTES) {
    return { ...orientation(ref), filename, extracted: false, note: `File is ~${Math.round(declaredSize / 1e6)} MB, above the ${MAX_FILE_BYTES / 1e6} MB limit.` };
  }

  // Procore FAS download URLs sit on the API host and require the bearer token.
  // On a cross-origin redirect to blob storage, fetch drops Authorization itself.
  const token = await ctx.procore.accessTokenFor(ctx.userId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Procore-Company-Id': String(ref.company_id) },
  });
  if (!res.ok) throw new Error(`Failed to download file ${fileId} (${res.status}).`);
  const contentLength = Number(res.headers.get('content-length') ?? '');
  if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_BYTES) {
    return { ...orientation(ref), filename, extracted: false, note: `File exceeds the ${MAX_FILE_BYTES / 1e6} MB limit.` };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { ...orientation(ref), filename, extracted: false, note: `File exceeds the ${MAX_FILE_BYTES / 1e6} MB limit.` };
  }

  const mime = firstStr(res.headers.get('content-type') ?? undefined, f.content_type);
  const extraction = await extractText(buffer, filename, mime, maxChars);
  return { ...orientation(ref), filename, ...extraction };
}

export function registerDocumentTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_recent_documents',
    {
      title: 'List recent documents',
      description:
        'Files in the project Documents tool created/updated within the window (default 14 days), newest first. ' +
        'Optionally filter by a folder path substring (e.g. "Specifications").',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        since: z.string().optional().describe('ISO date (default 14 days ago)'),
        folder_path: z.string().optional().describe('Substring match on folder path'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ project_id, since, folder_path, limit }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const res = await fetchRecentDocuments(ctx, ref, {
          since: resolveSince(Date.now(), since),
          limit: clampLimit(limit),
          folderPath: folder_path,
        });
        return ok({ ...orientation(ref), ...res });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'read_document',
    {
      title: 'Read a document (extract text)',
      description:
        'Extract and return the text of a project file (PDF, DOCX, or plain text). Because this is a shared ' +
        'remote server, the text is returned inline. Scanned/vector drawings report extracted:false (no OCR in v1).',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        file_id: z.number().int().describe('File id (from list_recent_documents)'),
        max_chars: z.number().int().min(1000).max(200_000).optional().describe('Max characters to return (default 40000)'),
        page_range: z.string().optional().describe('Reserved for future use; ignored in v1'),
      },
    },
    async ({ project_id, file_id, max_chars }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        return ok(await readDocument(ctx, ref, file_id, max_chars ?? DEFAULT_MAX_CHARS));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
