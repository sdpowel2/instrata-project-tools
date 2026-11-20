/**
 * Second brain tools (My Day 2.6): the nightly filing reads the inbox (brain_raw)
 * and files each note into a page (brain_pages) or, for project notes, into the
 * project wiki's Notes section (project_notes). See
 * supabase/migrations/add_brain_pages.sql and Product Spec/my-day-roadmap.md 2.6.
 *
 *   get_brain_inbox     unfiled notes, oldest first, with scope and project
 *   search_brain        pages you can see + your unfiled notes (full text)
 *   list_brain_pages    page directory: slug, title, kind, scope, summary
 *   get_brain_page      one page in full, with its [[links]] and recent versions
 *   file_brain_notes    create or append to a personal / general page, mark notes filed
 *   file_project_notes  project notes → the project wiki's Notes, mark notes filed
 *   discard_brain_raw   duplicates and noise out of the inbox, with a reason
 *   restore_brain_page  undo: put a page back to an earlier version
 *
 * Scope rules live in the database: personal pages are owner-only, general pages
 * are readable by every signed-in user, a note is only ever filed within its own
 * scope, and non-index pages can only be appended to. Registered with the worklist
 * tools (index.ts, isWorklistUser). Summaries and links only, never message bodies.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ok, fail, type ToolRegistrar } from './toolHelpers.js';

const PAGE_KINDS = ['topic', 'person', 'project', 'company', 'index', 'note'] as const;
const PAGE_SCOPES = ['personal', 'general'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

const INBOX_COLS =
  'id, captured_at, source, text, link, briefing_date, readme_source, scope, project_id, ' +
  'project:projects(project_code, number, name)';
const PAGE_LIST_COLS = 'id, slug, title, kind, scope, summary, tags, project_id, user_id, updated_at, last_writer';
const PAGE_COLS = `${PAGE_LIST_COLS}, body, created_at`;
const VERSION_COLS = 'id, written_by, written_at, replaced_at';

/** "relation/function does not exist": the 2.6 migration hasn't been applied yet. */
function notMigrated(error: { code?: string } | null): boolean {
  return !!error && (error.code === '42P01' || error.code === '42883' || error.code === 'PGRST202' || error.code === 'PGRST205');
}
const PENDING = 'second brain not set up yet (add_brain_pages.sql pending)';

/** [[slug]] links in a page body, deduplicated, in order. */
export function pageLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([a-z0-9][a-z0-9-]{0,99})(?:\|[^\]]*)?\]\]/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function registerBrainTools(server: ToolRegistrar, supa: SupabaseClient, userId: string): void {
  server.registerTool(
    'get_brain_inbox',
    {
      title: 'Second brain inbox',
      description:
        'Personal My Day second brain (2.6). Notes waiting to be filed (status new), oldest first: read-me lines ' +
        'the user logged and quick notes. Each has a scope: personal (only the user; file into a personal page), ' +
        'general (the whole team; file into a general page) or project (file with file_project_notes; it lands in ' +
        'that project\'s wiki Notes). Never change a note\'s scope. total is the full inbox count.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Max notes (default 20)') },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const [rows, count] = await Promise.all([
        supa.from('brain_raw').select(INBOX_COLS).eq('user_id', userId).eq('status', 'new')
          .order('captured_at', { ascending: true }).limit(limit ?? 20),
        supa.from('brain_raw').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'new'),
      ]);
      if (rows.error) return notMigrated(rows.error) ? ok({ total: 0, notes: [], note: PENDING }) : fail(rows.error.message);
      return ok({ total: count.count ?? (rows.data ?? []).length, notes: rows.data ?? [] });
    },
  );

  server.registerTool(
    'search_brain',
    {
      title: 'Search the second brain',
      description:
        'Personal My Day second brain (2.6). Full-text search over the pages you can see (your personal pages and ' +
        'the team\'s general pages) and your unfiled inbox notes. kind is page or inbox. Use it to find the right ' +
        'home page for a note before filing, and to answer questions from the brain. Web-style syntax: quoted ' +
        'phrases, OR, -excluded. Snippets mark matches with <b>…</b>.',
      inputSchema: {
        query: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(100).optional().describe('Max hits (default 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const { data, error } = await supa.rpc('search_brain', { p_query: query, p_limit: limit ?? 20 });
      if (error) return notMigrated(error) ? ok({ query, hits: [], note: PENDING }) : fail(error.message);
      return ok({ query, hits: data ?? [] });
    },
  );

  server.registerTool(
    'list_brain_pages',
    {
      title: 'List second brain pages',
      description:
        'Personal My Day second brain (2.6). The page directory, newest edit first: slug, title, kind, scope, ' +
        'one-line summary. Filter by kind or scope. Use it to keep the index pages current.',
      inputSchema: {
        kind: z.enum(PAGE_KINDS).optional(),
        scope: z.enum(PAGE_SCOPES).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Max pages (default 200)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, scope, limit }) => {
      let q = supa.from('brain_pages').select(PAGE_LIST_COLS).order('updated_at', { ascending: false }).limit(limit ?? 200);
      if (kind) q = q.eq('kind', kind);
      if (scope) q = q.eq('scope', scope);
      const { data, error } = await q;
      if (error) return notMigrated(error) ? ok({ pages: [], note: PENDING }) : fail(error.message);
      return ok({ pages: data ?? [] });
    },
  );

  server.registerTool(
    'get_brain_page',
    {
      title: 'Get a second brain page',
      description:
        'Personal My Day second brain (2.6). One page by slug, in full: body (markdown), summary, tags, its ' +
        '[[links]], and its 10 most recent versions (each is the content before an edit; restore_brain_page puts ' +
        'one back). Without scope, your personal page wins over a general page with the same slug.',
      inputSchema: {
        slug: z.string().regex(SLUG),
        scope: z.enum(PAGE_SCOPES).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ slug, scope }) => {
      let q = supa.from('brain_pages').select(PAGE_COLS).eq('slug', slug);
      if (scope) q = q.eq('scope', scope);
      const { data, error } = await q;
      if (error) return notMigrated(error) ? fail(PENDING) : fail(error.message);
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const page =
        rows.find((r) => r.scope === 'personal' && r.user_id === userId) ?? rows.find((r) => r.scope === 'general');
      if (!page) return fail(`No page "${slug}"${scope ? ` (${scope})` : ''}.`);
      const versions = await supa.from('brain_page_versions').select(VERSION_COLS).eq('page_id', page.id as string)
        .order('replaced_at', { ascending: false }).limit(10);
      return ok({
        page,
        links: pageLinks(String(page.body ?? '')),
        versions: versions.error ? [] : versions.data ?? [],
      });
    },
  );

  server.registerTool(
    'file_brain_notes',
    {
      title: 'File notes into a brain page',
      description:
        'Personal My Day second brain (2.6). Create a page or add to one, and mark the inbox notes it files as ' +
        'filed. page.scope must match the notes\' scope (personal or general; project notes use ' +
        'file_project_notes). An existing page is found by slug within its scope. append adds markdown to the end ' +
        '(use a dated heading, "### YYYY-MM-DD", and the source link); summary replaces the 1-3 sentence summary. ' +
        'body replaces the whole body and is allowed ONLY on kind index pages. A new page needs a title. Every ' +
        'edit keeps a version, so it can be undone. Max 20 notes per call; never copy a message body.',
      inputSchema: {
        page: z.object({
          scope: z.enum(PAGE_SCOPES),
          slug: z.string().regex(SLUG).describe('lowercase-with-dashes, short, stable'),
          title: z.string().min(1).max(200).optional(),
          kind: z.enum(PAGE_KINDS).optional(),
          summary: z.string().max(1000).optional(),
          append: z.string().max(8000).optional(),
          body: z.string().max(200000).optional().describe('Index pages only: the whole new body'),
          tags: z.array(z.string().min(1).max(60)).max(20).optional(),
          project_id: z.string().uuid().optional().describe('Tag the page with a project (for search; does not share it)'),
        }),
        raw_ids: z.array(z.string().uuid()).max(20).default([]),
      },
    },
    async ({ page, raw_ids }) => {
      const { data, error } = await supa.rpc('file_brain_notes', { p_page: page, p_raw_ids: raw_ids });
      if (error) return fail(notMigrated(error) ? PENDING : error.message);
      return ok(data);
    },
  );

  server.registerTool(
    'file_project_notes',
    {
      title: 'File project notes into the project wiki',
      description:
        'Personal My Day second brain (2.6). Files inbox notes of scope project into their project\'s wiki Notes ' +
        'section, where everyone who can see the project reads them, and marks them filed. text is a tidied one- ' +
        'or two-line summary (max 2000 chars, never a message body); link defaults to the note\'s own link. Each ' +
        'note goes to the project it was logged under. Max 20 per call.',
      inputSchema: {
        notes: z
          .array(
            z.object({
              raw_id: z.string().uuid(),
              text: z.string().min(1).max(2000),
              link: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    async ({ notes }) => {
      const { data, error } = await supa.rpc('file_project_notes', { p_notes: notes });
      if (error) return fail(notMigrated(error) ? PENDING : error.message);
      return ok(data);
    },
  );

  server.registerTool(
    'discard_brain_raw',
    {
      title: 'Discard inbox notes',
      description:
        'Personal My Day second brain (2.6). Marks unfiled inbox notes as discarded, with a reason (duplicate of ' +
        'an existing page entry, noise). Use sparingly: when in doubt, file.',
      inputSchema: {
        ids: z.array(z.string().uuid()).min(1).max(50),
        reason: z.string().min(1).max(300),
      },
    },
    async ({ ids, reason }) => {
      const { data, error } = await supa.rpc('discard_brain_raw', { p_ids: ids, p_reason: reason });
      if (error) return fail(notMigrated(error) ? PENDING : error.message);
      return ok(data);
    },
  );

  server.registerTool(
    'restore_brain_page',
    {
      title: 'Restore a brain page version',
      description:
        'Personal My Day second brain (2.6). Undo: puts a page back to an earlier version (version ids come from ' +
        'get_brain_page). The current content is saved as a version first, so a restore can be undone too. Only ' +
        'when the user asks.',
      inputSchema: { version_id: z.number().int().positive() },
    },
    async ({ version_id }) => {
      const { data, error } = await supa.rpc('restore_brain_page', { p_version_id: version_id });
      if (error) return fail(notMigrated(error) ? PENDING : error.message);
      return ok(data);
    },
  );
}
