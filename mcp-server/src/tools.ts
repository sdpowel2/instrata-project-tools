/**
 * Read-only MCP tools. Each is a thin wrapper over the same Supabase tables the
 * React app reads (see app/src/store/index.ts). Every query runs through the
 * per-user client, so RLS decides what comes back: project-scoped tables
 * (BoM, RFIs, submittals, purchasing, milestones) return rows only for projects
 * the user is a member of (or admin/creator); org-wide tables (projects,
 * catalog, vendor contacts) are visible to any authenticated user.
 *
 * Write tools for the cutsheet submittal workflow live in submittalTools.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ok, fail, sanitize, cutsheetStatus, type ToolRegistrar } from './toolHelpers.js';

export function registerTools(server: ToolRegistrar, supa: SupabaseClient, userId: string): void {
  // ── Caller identity ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_me',
    {
      title: 'Get the current user',
      description:
        'Return the calling user\'s profile (id, full name, email). Use the full name ' +
        'for fields like a submittal\'s "Prepared By".',
      inputSchema: {},
    },
    async () => {
      const { data, error } = await supa
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', userId)
        .maybeSingle();
      if (error) return fail(error.message);
      if (!data) return fail('No profile found for the current user.');
      return ok(data);
    },
  );

  // ── Projects ────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List projects, newest first. Optionally filter by a free-text search ' +
        '(matches name, number, client, or project code) and/or status. Use this ' +
        'first to find a project_id for the other tools.',
      inputSchema: {
        search: z.string().optional().describe('Free-text match on name/number/client/project code'),
        status: z.string().optional().describe('Exact status, e.g. "In Progress", "Install", "Won"'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50)'),
      },
    },
    async ({ search, status, limit }) => {
      let q = supa.from('projects').select('*').order('updated_at', { ascending: false }).limit(limit ?? 50);
      if (status) q = q.eq('status', status);
      if (search) {
        const s = sanitize(search);
        if (s) q = q.or(`name.ilike.*${s}*,number.ilike.*${s}*,client.ilike.*${s}*,project_code.ilike.*${s}*`);
      }
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project details',
      description: 'Fetch the full record for one project by its id (uuid). Use list_projects to find the id.',
      inputSchema: { project_id: z.string().describe('Project uuid') },
    },
    async ({ project_id }) => {
      const { data, error } = await supa.from('projects').select('*').eq('id', project_id).maybeSingle();
      if (error) return fail(error.message);
      if (!data) return fail('No project found (it may not exist, or you may not have access).');
      return ok(data);
    },
  );

  // ── Bill of Materials ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_project_bom',
    {
      title: 'Get project bill of materials',
      description: 'List the equipment / labor line items (BoM) for a project, in display order.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max rows (default 500)'),
      },
    },
    async ({ project_id, limit }) => {
      const { data, error } = await supa
        .from('project_bom_items')
        .select('id, manufacturer, model, description, category, qty, item_type, unit_cost, unit_price, labor_hours, owner_furnished, optional, notes, sort_order, locations')
        .eq('project_id', project_id)
        .order('sort_order', { ascending: true })
        .limit(limit ?? 500);
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── RFIs ────────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_rfis',
    {
      title: 'List RFIs',
      description: 'List requests-for-information for a project. Set open_only to return just Open RFIs.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        open_only: z.boolean().optional().describe('Only RFIs with status "Open" (default false)'),
      },
    },
    async ({ project_id, open_only }) => {
      let q = supa
        .from('rfis')
        .select('id, number, subject, spec_section, description, status, response_due, answered_at, answered_by, response_summary, location_ref, product_ref, created_at')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false });
      if (open_only) q = q.eq('status', 'Open');
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── Submittals ────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_submittals',
    {
      title: 'List submittals',
      description:
        'List submittal packages for a project. Set include_items to also return each ' +
        'package’s line items, including per-item cutsheet match status: has_cutsheet is ' +
        'true when a cutsheet PDF is already attached, and cutsheet_source says where it ' +
        'came from ("repository" = approved SharePoint repo, "staging" = uploaded and ' +
        'pending admin approval, "legacy" = direct upload). Items with has_cutsheet false ' +
        'still need a cutsheet.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        include_items: z.boolean().optional().describe('Embed submittal line items (default false)'),
      },
    },
    async ({ project_id, include_items }) => {
      const cols = include_items
        ? 'id, title, revision, prepared_by, submitted_to, status, notes, created_at, ' +
          'submittal_items(id, manufacturer, model, description, category, qty, owner_furnished, approval_state, sort_order, ' +
          'cutsheet_repository_id, cutsheet_staging_id, cut_sheet_url, cut_sheet_name)'
        : 'id, title, revision, prepared_by, submitted_to, status, notes, created_at';
      const { data, error } = await supa
        .from('submittals')
        .select(cols)
        .eq('project_id', project_id)
        .order('created_at', { ascending: false });
      if (error) return fail(error.message);
      if (!include_items) return ok(data);
      const withStatus = ((data ?? []) as unknown as Record<string, unknown>[]).map((s) => ({
        ...s,
        submittal_items: ((s.submittal_items as Record<string, unknown>[]) ?? []).map((it) => ({
          ...it,
          ...cutsheetStatus(it),
        })),
      }));
      return ok(withStatus);
    },
  );

  // ── Purchasing ────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_purchasing',
    {
      title: 'List purchasing',
      description:
        'List purchasing modules for a project with their purchase line items (status, PO number, ' +
        'need-by/ordered/received dates) and the linked equipment details.',
      inputSchema: { project_id: z.string().describe('Project uuid') },
    },
    async ({ project_id }) => {
      const { data, error } = await supa
        .from('purchasing_modules')
        .select(
          'id, title, notes, created_at, ' +
            'purchasing_items(id, purchase_status, po_number, purchase_unit_price, need_by_date, ordered_date, received_date, notes, ' +
            'submittal_items(manufacturer, model, description, qty))',
        )
        .eq('project_id', project_id)
        .order('created_at', { ascending: false });
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── Milestones ────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_milestones',
    {
      title: 'List schedule milestones',
      description: 'List schedule milestones for a project, earliest due date first.',
      inputSchema: { project_id: z.string().describe('Project uuid') },
    },
    async ({ project_id }) => {
      const { data, error } = await supa
        .from('project_milestones')
        .select('id, title, description, milestone_type, tier, phase, due_date, completed_date, owner_id, notes')
        .eq('project_id', project_id)
        .order('due_date', { ascending: true, nullsFirst: false });
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── Product catalog ────────────────────────────────────────────────────────────
  server.registerTool(
    'search_catalog',
    {
      title: 'Search product catalog',
      description: 'Full-text search the shared product catalog by manufacturer, model number, or description.',
      inputSchema: {
        query: z.string().describe('Search terms, e.g. "Shure ceiling microphone"'),
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ query, limit }) => {
      const n = limit ?? 25;
      const { data, error } = await supa.rpc('search_catalog', {
        search_term: query,
        page_from: 0,
        page_to: n - 1,
      });
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── Vendor contacts ──────────────────────────────────────────────────────────
  server.registerTool(
    'search_vendor_contacts',
    {
      title: 'Search vendor contacts',
      description:
        'Search the shared vendor / distributor / manufacturer-rep directory. Filter by free text ' +
        '(company, name, brands repped, or role) and/or company type.',
      inputSchema: {
        query: z.string().optional().describe('Free-text match on company/name/brands/role'),
        company_type: z.enum(['manufacturer', 'distributor', 'rep', 'other']).optional(),
        include_inactive: z.boolean().optional().describe('Include deactivated contacts (default false)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50)'),
      },
    },
    async ({ query, company_type, include_inactive, limit }) => {
      let q = supa
        .from('vendor_contacts')
        .select('id, company, company_type, rep_for, name, title, email, phone, website, role, notes, technical, active')
        .order('company', { ascending: true })
        .limit(limit ?? 50);
      if (!include_inactive) q = q.eq('active', true);
      if (company_type) q = q.eq('company_type', company_type);
      if (query) {
        const s = sanitize(query);
        if (s) q = q.or(`company.ilike.*${s}*,name.ilike.*${s}*,rep_for.ilike.*${s}*,role.ilike.*${s}*`);
      }
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  // ── Project files ────────────────────────────────────────────────────────────
  server.registerTool(
    'list_project_files',
    {
      title: 'List project files',
      description:
        'List the files in a project\'s document repository (contracts, drawings, ' +
        'submittals, meeting notes, photos, closeout docs). Files live in the company ' +
        'SharePoint site; this reads the index. Use get_project_file to fetch one.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        category: z
          .enum(['contracts', 'drawings', 'submittals', 'meeting_notes', 'photos', 'closeout', 'general'])
          .optional()
          .describe('Filter to one folder category'),
        search: z.string().optional().describe('Free-text match on filename or document type'),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100)'),
      },
    },
    async ({ project_id, category, search, limit }) => {
      let q = supa
        .from('project_files')
        .select('id, category, filename, doc_type, source, size_bytes, mime_type, sharepoint_path, sharepoint_web_url, created_at')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false })
        .limit(limit ?? 100);
      if (category) q = q.eq('category', category);
      if (search) {
        const s = sanitize(search);
        if (s) q = q.or(`filename.ilike.*${s}*,doc_type.ilike.*${s}*`);
      }
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    'get_project_file',
    {
      title: 'Get a project file download URL',
      description:
        'Get a fresh, short-lived (~1 hour) download URL for a project file by its id ' +
        '(from list_project_files). Fetch the URL directly to retrieve the file bytes.',
      inputSchema: { file_id: z.string().describe('File uuid from list_project_files') },
    },
    async ({ file_id }) => {
      // The edge function verifies this user's JWT (sent automatically by the
      // per-user client) and mints the pre-authenticated Graph URL — no Graph
      // credentials ever live on this server.
      const { data, error } = await supa.functions.invoke('sharepoint-project-files', {
        body: { op: 'getDownloadUrl', fileId: file_id },
      });
      if (error) return fail(`Download URL request failed: ${error.message}`);
      return ok(data);
    },
  );
}
