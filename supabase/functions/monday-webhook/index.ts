import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_BUSINESS_UNITS = ['Instrata SE', 'Instrata SW', 'Instrata NE', 'Instrata MA'];
const STATUS_COLUMN_ID = 'status9';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CsvRow {
  manufacturer: string;
  modelNumber: string;
  description: string;
  category: string;
  quantity: number | null;
  unitCost: number | null;
  unitPrice: number | null;
  extendedPrice: number | null;
  roomLocation: string;
  phase: string;
  laborType: string;
  laborHours: number | null;
  pricedFrom: string;
}

interface Flag {
  rule_id: string;
  severity: 'high' | 'moderate' | 'low';
  category: 'margin' | 'pricing' | 'labor' | 'data' | 'catalog' | 'project';
  flag_name: string;
  description: string;
  line_item_ref: string | null;
  diff_status: 'new' | 'recurring' | null;
}

interface ReviewConfig {
  marginFloorProject: number;
  marginFloorPhase: number;
  pricingStalenessDays: number;
  costDeviationPct: number;
  preferredVendors: string[];
  freeItemModels: string[];
}

interface LaborRate {
  labor_type: string;
  hours_ceiling: number | null;
}

interface CatalogItem {
  model_number: string;
  list_price: number | null;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(field.trim()); field = ''; }
        else { field += ch; }
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function toNum(v: string | undefined): number | null {
  if (!v || v.trim() === '') return null;
  const n = parseFloat(v.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function mapRow(raw: Record<string, string>): CsvRow {
  // Try multiple header name variants for flexibility
  const get = (...keys: string[]) => {
    for (const k of keys) {
      if (raw[k] !== undefined) return raw[k];
    }
    return '';
  };

  return {
    manufacturer:  get('manufacturer'),
    modelNumber:   get('model number', 'model_number', 'model#', 'model no'),
    description:   get('description'),
    category:      get('category'),
    quantity:      toNum(get('quantity', 'qty')),
    unitCost:      toNum(get('unit cost', 'unit_cost')),
    unitPrice:     toNum(get('unit price', 'unit_price')),
    extendedPrice: toNum(get('extended price', 'extended_price', 'ext price')),
    roomLocation:  get('room / location', 'room/location', 'room', 'location'),
    phase:         get('phase'),
    laborType:     get('labor type', 'labor_type'),
    laborHours:    toNum(get('labor hours', 'labor_hours')),
    pricedFrom:    get('priced from', 'priced_from'),
  };
}

// ─── Rules Engine ─────────────────────────────────────────────────────────────

function runRules(
  rows: CsvRow[],
  config: ReviewConfig,
  laborRates: LaborRate[],
  catalog: CatalogItem[],
  projectData: { siteAddress: string; scopeOfWork: string },
): Flag[] {
  const flags: Flag[] = [];

  const flag = (
    rule_id: string, severity: Flag['severity'], category: Flag['category'],
    flag_name: string, description: string, line_item_ref: string | null = null,
  ) => flags.push({ rule_id, severity, category, flag_name, description, line_item_ref, diff_status: null });

  const equipRows = rows.filter(r => !r.laborType);
  const allRows   = rows;

  // ── HIGH: Project Margin Below Floor ──────────────────────────────────────
  const totalPrice = equipRows.reduce((s, r) => s + (r.extendedPrice ?? (r.unitPrice ?? 0) * (r.quantity ?? 0)), 0);
  const totalCost  = equipRows.reduce((s, r) => s + (r.unitCost ?? 0) * (r.quantity ?? 0), 0);
  if (totalPrice > 0) {
    const margin = ((totalPrice - totalCost) / totalPrice) * 100;
    if (margin < config.marginFloorProject) {
      flag('PROJECT_MARGIN_BELOW_FLOOR', 'high', 'margin',
        'Project Margin Below Floor',
        `Project margin is ${margin.toFixed(1)}%, below the configured ${config.marginFloorProject}% floor.`);
    }
  }

  // ── HIGH: Unmatched Labor Type ─────────────────────────────────────────────
  const knownTypes = new Set(laborRates.map(r => r.labor_type.toLowerCase()));
  const seenTypes  = new Set<string>();
  for (const r of allRows) {
    if (r.laborType && !seenTypes.has(r.laborType.toLowerCase())) {
      seenTypes.add(r.laborType.toLowerCase());
      if (!knownTypes.has(r.laborType.toLowerCase())) {
        flag('UNMATCHED_LABOR_TYPE', 'high', 'labor',
          'Unmatched Labor Type',
          `Labor type "${r.laborType}" has no matching entry in the labor rate table.`,
          r.modelNumber || r.description);
      }
    }
  }

  // ── HIGH: Labor Hours Without Type ────────────────────────────────────────
  for (const r of allRows) {
    const hasHours = r.laborHours !== null && r.laborHours > 0;
    const hasType  = !!r.laborType;
    if (hasHours && !hasType) {
      flag('LABOR_HOURS_WITHOUT_TYPE', 'high', 'labor',
        'Labor Hours Without Type',
        `Line "${r.description}" has ${r.laborHours} labor hours but no Labor Type specified.`,
        r.modelNumber || r.description);
    } else if (!hasHours && hasType) {
      flag('LABOR_HOURS_WITHOUT_TYPE', 'high', 'labor',
        'Labor Type Without Hours',
        `Line "${r.description}" has Labor Type "${r.laborType}" but no labor hours.`,
        r.modelNumber || r.description);
    }
  }

  // ── HIGH: Zero or Null Quantity ───────────────────────────────────────────
  for (const r of equipRows) {
    if (r.quantity === null || r.quantity === 0) {
      flag('ZERO_OR_NULL_QUANTITY', 'high', 'data',
        'Zero or Null Quantity',
        `Equipment line "${r.modelNumber || r.description}" has a quantity of ${r.quantity ?? 'blank'}.`,
        r.modelNumber || r.description);
    }
  }

  // ── HIGH: Zero Unit Price ─────────────────────────────────────────────────
  const freeModels = new Set(config.freeItemModels.map(m => m.toLowerCase().trim()));
  for (const r of equipRows) {
    if ((r.unitPrice === null || r.unitPrice === 0) && !freeModels.has(r.modelNumber.toLowerCase())) {
      flag('ZERO_UNIT_PRICE', 'high', 'data',
        'Zero Unit Price',
        `Equipment line "${r.modelNumber || r.description}" has a unit price of $0.`,
        r.modelNumber || r.description);
    }
  }

  // ── HIGH: Missing Site Address ────────────────────────────────────────────
  if (!projectData.siteAddress.trim()) {
    flag('MISSING_SITE_ADDRESS', 'high', 'project',
      'Missing Site Address',
      'The site address field in Monday.com is blank.');
  }

  // ── HIGH: Missing Scope of Work ───────────────────────────────────────────
  if (!projectData.scopeOfWork.trim()) {
    flag('MISSING_SCOPE_OF_WORK', 'high', 'project',
      'Missing Scope of Work',
      'The scope of work field in Monday.com is blank.');
  }

  // ── MODERATE: Missing Priced From ────────────────────────────────────────
  for (const r of equipRows) {
    if (!r.pricedFrom) {
      flag('MISSING_PRICED_FROM', 'moderate', 'pricing',
        'Missing Priced From',
        `Equipment line "${r.modelNumber || r.description}" has no Priced From value.`,
        r.modelNumber || r.description);
    }
  }

  // ── MODERATE: Stale Pricing ───────────────────────────────────────────────
  const stalenessMs = config.pricingStalenessDays * 86400000;
  const now = Date.now();
  for (const r of equipRows) {
    if (r.pricedFrom) {
      const m = r.pricedFrom.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) {
        const d = new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
        if (!isNaN(d.getTime()) && now - d.getTime() > stalenessMs) {
          flag('STALE_PRICING', 'moderate', 'pricing',
            'Stale Pricing',
            `"${r.modelNumber || r.description}" was priced on ${m[0]}, more than ${config.pricingStalenessDays} days ago.`,
            r.modelNumber || r.description);
        }
      }
    }
  }

  // ── MODERATE: Cost Deviation from Catalog ────────────────────────────────
  const catalogMap = new Map<string, number>();
  for (const c of catalog) {
    if (c.list_price !== null) catalogMap.set(c.model_number.toLowerCase(), c.list_price);
  }
  for (const r of equipRows) {
    const catPrice = catalogMap.get(r.modelNumber.toLowerCase());
    if (catPrice !== undefined && catPrice > 0 && r.unitCost !== null) {
      const dev = (Math.abs(r.unitCost - catPrice) / catPrice) * 100;
      if (dev > config.costDeviationPct) {
        flag('COST_DEVIATION_FROM_CATALOG', 'moderate', 'pricing',
          'Cost Deviation from Catalog',
          `"${r.modelNumber}" unit cost ($${r.unitCost}) deviates ${dev.toFixed(1)}% from catalog price ($${catPrice}), exceeding the ${config.costDeviationPct}% threshold.`,
          r.modelNumber);
      }
    }
  }

  // ── MODERATE: Labor Hours Exceed Ceiling ──────────────────────────────────
  const ceilingMap = new Map<string, number>();
  for (const rate of laborRates) {
    if (rate.hours_ceiling !== null) ceilingMap.set(rate.labor_type.toLowerCase(), rate.hours_ceiling);
  }
  for (const r of allRows) {
    if (r.laborType && r.laborHours !== null) {
      const ceil = ceilingMap.get(r.laborType.toLowerCase());
      if (ceil !== undefined && r.laborHours > ceil) {
        flag('LABOR_HOURS_EXCEED_CEILING', 'moderate', 'labor',
          'Labor Hours Exceed Ceiling',
          `Labor type "${r.laborType}" has ${r.laborHours} hours, exceeding the configured ceiling of ${ceil} hours per line.`,
          r.modelNumber || r.description);
      }
    }
  }

  // ── MODERATE: Phase Margin Below Floor ───────────────────────────────────
  const phases = new Map<string, { price: number; cost: number }>();
  for (const r of equipRows) {
    if (r.phase) {
      const p = phases.get(r.phase) ?? { price: 0, cost: 0 };
      p.price += r.extendedPrice ?? (r.unitPrice ?? 0) * (r.quantity ?? 0);
      p.cost  += (r.unitCost ?? 0) * (r.quantity ?? 0);
      phases.set(r.phase, p);
    }
  }
  for (const [phase, { price, cost }] of phases) {
    if (price > 0) {
      const m = ((price - cost) / price) * 100;
      if (m < config.marginFloorPhase) {
        flag('PHASE_MARGIN_BELOW_FLOOR', 'moderate', 'margin',
          'Phase Margin Below Floor',
          `Phase "${phase}" margin is ${m.toFixed(1)}%, below the ${config.marginFloorPhase}% phase floor.`,
          phase);
      }
    }
  }

  // ── LOW: Model Not in Catalog ─────────────────────────────────────────────
  const catalogModels = new Set(catalog.map(c => c.model_number.toLowerCase()));
  for (const r of equipRows) {
    if (r.modelNumber && !catalogModels.has(r.modelNumber.toLowerCase())) {
      flag('MODEL_NOT_IN_CATALOG', 'low', 'catalog',
        'Model Not in Catalog',
        `"${r.modelNumber}" was not found in the product catalog. Pricing cannot be verified.`,
        r.modelNumber);
    }
  }

  // ── LOW: Missing Room / Location ──────────────────────────────────────────
  for (const r of equipRows) {
    if (!r.roomLocation) {
      flag('MISSING_ROOM_LOCATION', 'low', 'data',
        'Missing Room / Location',
        `Equipment line "${r.modelNumber || r.description}" has no room or location assigned.`,
        r.modelNumber || r.description);
    }
  }

  // ── LOW: Non-Preferred Vendor ─────────────────────────────────────────────
  if (config.preferredVendors.length > 0) {
    const preferred = new Set(config.preferredVendors.map(v => v.toLowerCase().trim()));
    for (const r of equipRows) {
      if (r.pricedFrom) {
        const vendor = r.pricedFrom.split(/\s*[—–-]\s*/)[0].trim();
        if (vendor && !preferred.has(vendor.toLowerCase())) {
          flag('NON_PREFERRED_VENDOR', 'low', 'pricing',
            'Non-Preferred Vendor',
            `"${r.modelNumber || r.description}" is priced from "${vendor}", which is not on the preferred vendor list.`,
            r.modelNumber || r.description);
        }
      }
    }
  }

  return flags;
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

function applyDiff(newFlags: Flag[], priorFlags: { rule_id: string; line_item_ref: string | null }[]): Flag[] {
  const priorKeys = new Set(priorFlags.map(f => `${f.rule_id}::${f.line_item_ref ?? ''}`));
  return newFlags.map(f => ({
    ...f,
    diff_status: priorKeys.has(`${f.rule_id}::${f.line_item_ref ?? ''}`) ? 'recurring' : 'new',
  }));
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  console.log('[monday-webhook] Received payload:', JSON.stringify(body));

  // ── Monday challenge handshake ─────────────────────────────────────────────
  if (body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const event = body.event;
  if (!event) {
    return new Response(JSON.stringify({ status: 'no_event' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const allowedTypes = ['create_pulse', 'update_column_value', 'column_change'];
  if (!allowedTypes.includes(event.type)) {
    return new Response(JSON.stringify({ status: 'ignored', type: event.type }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const expectedBoard = Deno.env.get('MONDAY_BOARD_ID');
  if (expectedBoard && String(event.boardId) !== expectedBoard) {
    return new Response(JSON.stringify({ status: 'wrong_board' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const itemId = event.pulseId;
  if (!itemId) {
    return new Response(JSON.stringify({ status: 'no_item_id' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiToken = Deno.env.get('MONDAY_API_TOKEN');
  if (!apiToken) {
    return new Response(JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Fetch item from Monday ─────────────────────────────────────────────────
  const gqlRes = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': apiToken,
      'Content-Type': 'application/json',
      'API-Version': '2024-10',
    },
    body: JSON.stringify({
      query: `query {
        items(ids: [${itemId}]) {
          name
          assets { id name url file_extension }
          column_values {
            id
            column { title }
            text
            value
          }
        }
      }`,
    }),
  });

  const gqlData = await gqlRes.json();
  if (gqlData.errors) {
    console.error('[monday-webhook] Monday API errors:', JSON.stringify(gqlData.errors));
    return new Response(JSON.stringify({ error: 'Monday API error', details: gqlData.errors }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const item = gqlData.data?.items?.[0];
  if (!item) {
    return new Response(JSON.stringify({ error: 'Item not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build column lookup by title AND by ID
  const cols: Record<string, string>     = {};
  const colsById: Record<string, string> = {};
  for (const c of item.column_values) {
    const title = c.column?.title || c.id;
    cols[title.toLowerCase()]  = c.text || '';
    colsById[c.id]             = c.text || '';
    console.log(`[monday-webhook] Column "${title}" (${c.id}) = "${c.text}"`);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const projectName  = item.name;
  const projectNum   = cols['project number'] || cols['number'] || '';
  const client       = cols['client'] || '';
  const rawBU        = cols['business unit'] || '';
  const siteAddress  = cols['site address'] || cols['address'] || '';
  const scopeOfWork  = cols['scope of work'] || cols['scope'] || '';
  const businessUnit = VALID_BUSINESS_UNITS.find(bu => bu.toLowerCase() === rawBU.toLowerCase()) || '';

  // ── Route: status changed to "Review" → trigger auto-review ───────────────
  const currentStatus = colsById[STATUS_COLUMN_ID] || cols['status'] || '';
  if (currentStatus.toLowerCase() === 'review') {
    console.log('[monday-webhook] Status is "Review" — triggering auto-review pipeline');
    return await runAutoReview({
      supabase, apiToken, itemId, item, projectName, projectNum, client,
      businessUnit, siteAddress, scopeOfWork, mondayPayload: body,
    });
  }

  // ── Route: create or update project ───────────────────────────────────────
  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('monday_item_id', itemId)
    .maybeSingle();

  if (existing) {
    // Update mutable project fields on column changes
    await supabase.from('projects').update({
      name: projectName, number: projectNum, client, business_unit: businessUnit,
      address: siteAddress, updated_at: new Date().toISOString(),
    }).eq('monday_item_id', itemId);
    return new Response(JSON.stringify({ status: 'updated', id: existing.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // New project
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: projectName, number: projectNum, client,
      business_unit: businessUnit, address: siteAddress,
      status: 'Active', monday_item_id: itemId, created_by: null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[monday-webhook] Insert error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ status: 'created', id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// ─── Auto-Review Pipeline ─────────────────────────────────────────────────────

async function runAutoReview(ctx: {
  supabase: any; apiToken: string; itemId: number; item: any;
  projectName: string; projectNum: string; client: string;
  businessUnit: string; siteAddress: string; scopeOfWork: string;
  mondayPayload: any;
}): Promise<Response> {
  const { supabase, apiToken, itemId, item } = ctx;

  // 1. Ensure project record exists (upsert)
  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('monday_item_id', itemId)
    .maybeSingle();

  let projectId: string;
  if (existing) {
    projectId = existing.id;
    await supabase.from('projects').update({
      name: ctx.projectName, number: ctx.projectNum, client: ctx.client,
      business_unit: ctx.businessUnit, address: ctx.siteAddress,
      updated_at: new Date().toISOString(),
    }).eq('id', projectId);
  } else {
    const { data, error } = await supabase
      .from('projects')
      .insert({
        name: ctx.projectName, number: ctx.projectNum, client: ctx.client,
        business_unit: ctx.businessUnit, address: ctx.siteAddress,
        status: 'Active', monday_item_id: itemId, created_by: null,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[auto-review] Failed to create project:', error);
      return new Response(JSON.stringify({ error: 'Failed to create project' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    projectId = data.id;
  }

  // 2. Find the CSV asset from item.assets
  const csvAsset = (item.assets ?? []).find(
    (a: any) => a.file_extension?.toLowerCase() === 'csv',
  );
  if (!csvAsset) {
    console.warn('[auto-review] No CSV asset found on item');
    return new Response(JSON.stringify({ status: 'no_csv', projectId }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Download CSV (Monday files require Authorization header)
  let csvText = '';
  try {
    const fileRes = await fetch(csvAsset.url, {
      headers: { 'Authorization': apiToken },
    });
    if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
    csvText = await fileRes.text();
  } catch (err) {
    console.error('[auto-review] Failed to download CSV:', err);
    return new Response(JSON.stringify({ error: 'Failed to download CSV' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Load review config
  const { data: configRows } = await supabase.from('review_config').select('key,value');
  const configMap: Record<string, string> = {};
  for (const r of configRows ?? []) configMap[r.key] = r.value;

  const reviewConfig: ReviewConfig = {
    marginFloorProject:   parseFloat(configMap['margin_floor_project']   ?? '30'),
    marginFloorPhase:     parseFloat(configMap['margin_floor_phase']     ?? '25'),
    pricingStalenessDays: parseFloat(configMap['pricing_staleness_days'] ?? '90'),
    costDeviationPct:     parseFloat(configMap['cost_deviation_pct']     ?? '15'),
    preferredVendors: (configMap['preferred_vendors'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    freeItemModels:   (configMap['free_item_models']  ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };

  // 5. Load labor rates
  const { data: laborRates } = await supabase
    .from('labor_rates')
    .select('labor_type,hours_ceiling')
    .eq('is_active', true);

  // 6. Load product catalog (model + price only — no full descriptions needed)
  const { data: catalog } = await supabase
    .from('product_catalog')
    .select('model_number,list_price');

  // 7. Parse CSV and run rules engine
  const rawRows = parseCsv(csvText);
  const rows = rawRows.map(mapRow);
  let flags = runRules(rows, reviewConfig, laborRates ?? [], catalog ?? [], {
    siteAddress: ctx.siteAddress,
    scopeOfWork: ctx.scopeOfWork,
  });

  // 8. Get prior runs for this project (for run_number + diff)
  const { data: priorRuns } = await supabase
    .from('review_runs')
    .select('id,run_number,status')
    .eq('project_id', projectId)
    .order('run_number', { ascending: false })
    .limit(1);

  const latestPrior = priorRuns?.[0];
  const runNumber = latestPrior ? latestPrior.run_number + 1 : 1;
  const isResubmission = latestPrior?.status === 'changes_requested';

  // 9. Diff against prior run if resubmission
  if (isResubmission && latestPrior) {
    const { data: priorFlags } = await supabase
      .from('review_flags')
      .select('rule_id,line_item_ref')
      .eq('review_run_id', latestPrior.id);
    if (priorFlags?.length) {
      flags = applyDiff(flags, priorFlags);
      // Mark prior open flags as resolved if they don't appear in new run
      const newKeys = new Set(flags.map(f => `${f.rule_id}::${f.line_item_ref ?? ''}`));
      const resolvedIds = (priorFlags as any[])
        .filter(pf => !newKeys.has(`${pf.rule_id}::${pf.line_item_ref ?? ''}`))
        .map((pf: any) => pf.id);
      if (resolvedIds.length) {
        await supabase.from('review_flags')
          .update({ diff_status: 'resolved' })
          .in('id', resolvedIds);
      }
    } else {
      flags = flags.map(f => ({ ...f, diff_status: 'new' as const }));
    }
  }

  // 10. Insert review_run
  const { data: runData, error: runError } = await supabase
    .from('review_runs')
    .insert({
      project_id:     projectId,
      run_number:     runNumber,
      csv_snapshot:   csvText,
      monday_payload: ctx.mondayPayload,
      status:         'pending_review',
      triggered_at:   new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runError) {
    console.error('[auto-review] Failed to insert review_run:', runError);
    return new Response(JSON.stringify({ error: 'Failed to create review run' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // 11. Insert flags
  if (flags.length > 0) {
    const flagRows = flags.map(f => ({
      review_run_id: runData.id,
      rule_id:       f.rule_id,
      severity:      f.severity,
      category:      f.category,
      flag_name:     f.flag_name,
      description:   f.description,
      line_item_ref: f.line_item_ref,
      diff_status:   f.diff_status,
      status:        'open',
    }));
    const { error: flagError } = await supabase.from('review_flags').insert(flagRows);
    if (flagError) console.error('[auto-review] Failed to insert flags:', flagError);
  }

  console.log(`[auto-review] Run ${runNumber} created for project ${projectId} with ${flags.length} flags`);
  return new Response(
    JSON.stringify({ status: 'review_created', projectId, runId: runData.id, flagCount: flags.length }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
