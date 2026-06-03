/**
 * Read-only MCP tools. Each is a thin wrapper over the same Supabase tables the
 * React app reads (see app/src/store/index.ts). Every query runs through the
 * per-user client, so RLS decides what comes back: project-scoped tables
 * (BoM, RFIs, submittals, purchasing, milestones) return rows only for projects
 * the user is a member of (or admin/creator); org-wide tables (projects,
 * catalog, vendor contacts) are visible to any authenticated user.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

/** Escape a free-text term for use inside a PostgREST `.or()` ilike pattern. */
function sanitize(term: string): string {
  return term.replace(/[(),*%]/g, ' ').trim();
}

export function registerTools(server: McpServer, supa: SupabaseClient): void {
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
      description: 'List submittal packages for a project. Set include_items to also return each package’s line items.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        include_items: z.boolean().optional().describe('Embed submittal line items (default false)'),
      },
    },
    async ({ project_id, include_items }) => {
      const cols = include_items
        ? 'id, title, revision, prepared_by, submitted_to, status, notes, created_at, submittal_items(id, manufacturer, model, description, category, qty, approval_state, sort_order)'
        : 'id, title, revision, prepared_by, submitted_to, status, notes, created_at';
      const { data, error } = await supa
        .from('submittals')
        .select(cols)
        .eq('project_id', project_id)
        .order('created_at', { ascending: false });
      return error ? fail(error.message) : ok(data);
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
}
