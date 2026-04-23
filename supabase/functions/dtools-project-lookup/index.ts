import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ─── D-Tools API helpers ─────────────────────────────────────────────────────

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

interface DToolsLocation {
  Id: string;
  Name: string;
  FullName?: string;
  ParentId?: string | null;
}

async function dtoolsFetch(apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${DTOOLS_BASE}${path}`, {
    headers: { 'X-DTSI-ApiKey': apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DTools API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Safely extract a number from untyped API data. */
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return isNaN(n) ? 0 : n;
}

function mapCategory(cat?: string): string {
  if (!cat) return 'Other';
  const c = cat.toLowerCase();
  if (c.includes('display') || c.includes('monitor') || c.includes('screen') || c.includes('projector')) return 'Display';
  if (c.includes('audio') || c.includes('speaker') || c.includes('microphone') || c.includes('amplifier') || c.includes('dsp')) return 'Audio';
  if (c.includes('control') || c.includes('processor') || c.includes('switcher') || c.includes('matrix')) return 'Control';
  if (c.includes('network') || c.includes('switch') || c.includes('router') || c.includes('wireless')) return 'Networking';
  if (c.includes('cable') || c.includes('wire') || c.includes('connector') || c.includes('adapter')) return 'Cabling';
  return 'Other';
}

interface GroupedItem {
  manufacturer: string;
  model: string;
  description: string;
  category: string;
  qty: number;
  notes: string;
  locations: Map<string, number>;
  itemType: string;
  unitCost: number;
  unitPrice: number;
  laborHours: number;
  laborUnitCost: number;
  laborUnitPrice: number;
  fixedLaborCost: number;
  fixedLaborPrice: number;
  marginPct: number;
  ownerFurnished: boolean;
  optional: boolean;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  let body: { projectId: string; projectNumber: string };
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400, headers: corsHeaders() });
  }

  const { projectId, projectNumber } = body;
  if (!projectId || !projectNumber) {
    return new Response(JSON.stringify({ error: 'projectId and projectNumber required' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DTOOLS_API_KEY not set' }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // ── Step 1: Search DTools for project by number ──────────────────────────
    console.log(`[dtools-lookup] Searching for project number: ${projectNumber}`);

    const searchData = await dtoolsFetch(
      apiKey,
      `/Subscribe/Projects?projectNumber=${encodeURIComponent(projectNumber)}&pageSize=5&pageNumber=1`,
    );

    const projects = Array.isArray(searchData)
      ? searchData
      : (searchData?.Projects ?? searchData?.projects ?? []);

    if (projects.length === 0) {
      console.log(`[dtools-lookup] No project found for number: ${projectNumber}`);
      await supabase.from('projects').update({
        dtools_bom_status: 'not_found',
        updated_at: new Date().toISOString(),
      }).eq('id', projectId);

      return new Response(JSON.stringify({ status: 'not_found' }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const match = projects.find(
      (p: any) => p.Number?.toLowerCase() === projectNumber.toLowerCase(),
    ) ?? projects[0];

    const dtoolsProjectId = match.Id;
    console.log(`[dtools-lookup] Found DTools project: ${dtoolsProjectId} (${match.Name})`);

    // ── Step 2a: Fetch WITH location aggregation (for qty per location) ─────
    const detailData = await dtoolsFetch(
      apiKey,
      `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}&aggregateBy=Location`,
    );
    const project = detailData?.Project ?? detailData;
    const aggItems: any[] = project?.Items ?? detailData?.Items ?? [];
    const locations: DToolsLocation[] = project?.Locations ?? [];

    // ── Step 2b: Fetch WITHOUT aggregation (for labor types + rates) ────────
    const fullData = await dtoolsFetch(
      apiKey,
      `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}`,
    );
    const fullProject = fullData?.Project ?? fullData;
    const fullItems: any[] = fullProject?.Items ?? fullData?.Items ?? [];

    // ── Step 3: Build labor rate map from TypeId=2 items ────────────────────
    // TypeId=2 items carry: Model = labor type name, UnitCost = cost/hr, UnitPrice = price/hr
    const laborRateMap = new Map<string, { costPerHour: number; pricePerHour: number }>();
    for (const item of fullItems) {
      if (item.TypeId != 2) continue;
      const typeName = (item.Model || '').trim();
      if (!typeName) continue;
      const cost = num(item.UnitCost);
      const price = num(item.UnitPrice);
      // Only store if it has actual rates (skip unpopulated travel items)
      if ((cost > 0 || price > 0) && !laborRateMap.has(typeName)) {
        laborRateMap.set(typeName, { costPerHour: cost, pricePerHour: price });
      }
    }
    console.log(`[dtools-lookup] Labor rate map: ${laborRateMap.size} types — ${Array.from(laborRateMap.entries()).map(([k, v]) => `${k}=$${v.costPerHour}/$${v.pricePerHour}`).join(', ')}`);

    // ── Step 4: Build per-item labor lookup from non-aggregated items ──────
    // Each non-aggregated item has its own ItemLaborTypes (labor type + hours breakdown).
    // Key by Manufacturer||Model since Ids may differ between agg and non-agg fetches.
    // If same product has different labor at different locations, we take the first occurrence
    // (this is rare — most products have the same labor config everywhere).
    const itemLaborByKey = new Map<string, any[]>();
    for (const fi of fullItems) {
      if (fi.TypeId != 1) continue;
      const ilt = fi.ItemLaborTypes ?? [];
      if (ilt.length > 0) {
        const key = `${fi.Manufacturer}||${fi.Model}`;
        if (!itemLaborByKey.has(key)) {
          itemLaborByKey.set(key, ilt);
        }
      }
    }
    console.log(`[dtools-lookup] Products with ItemLaborTypes: ${itemLaborByKey.size}`);

    // Default Install rate for items without specific labor type info
    const installRate = laborRateMap.get('Install');

    // ── Step 5: Build location map and enrich aggregated items ───────────────
    const locationMap = new Map<string, string>();
    for (const loc of locations) {
      locationMap.set(loc.Id, loc.FullName || loc.Name);
    }
    for (const item of aggItems) {
      if (item.LocationId && !item.LocationName) {
        item.LocationName = locationMap.get(item.LocationId) ?? item.LocationId;
      }
    }

    // ── Step 6: Process each item individually ──────────────────────────────
    // Include products (1, 3, 4) and location-specific labor (2 with LocationId)
    const billableItems = aggItems.filter((i: any) =>
      i.TypeId == 1 || i.TypeId == 3 || i.TypeId == 4 ||
      (i.TypeId == 2 && i.LocationId)
    );
    console.log(`[dtools-lookup] ${aggItems.length} total agg items, ${billableItems.length} billable`);

    const grouped = new Map<string, GroupedItem>();
    let pathILT = 0, pathInstallRate = 0, pathNoLabor = 0, pathLabor = 0;

    for (const item of billableItems) {
      const isLabor = item.TypeId == 2;
      const itemQty = num(item.Quantity) || 1;
      const locName = item.LocationName || '';

      // Products: group by manufacturer+model+unitCost (same product, same price = merge)
      // Labor: unique per type+location
      const key = isLabor
        ? `Labor||${item.Model || item.Description || 'Unknown'}||${locName}`
        : `${item.Manufacturer}||${item.Model}||${num(item.UnitCost)}`;

      let unitCost = 0;
      let unitPrice = 0;
      let laborHours = 0;
      let laborUnitCost = 0;
      let laborUnitPrice = 0;
      let fixedLaborCost = 0;
      let fixedLaborPrice = 0;
      let itemType = 'Product';

      if (isLabor) {
        // TypeId=2 with location: standalone labor item
        itemType = 'Labor';
        laborHours = itemQty;
        laborUnitCost = num(item.UnitCost);
        laborUnitPrice = num(item.UnitPrice);
        pathLabor++;
      } else {
        // Product — equipment pricing
        unitCost = num(item.UnitCost);
        unitPrice = num(item.UnitPrice);

        // Compute labor: look up this product's ItemLaborTypes, then hours × rate
        const iltKey = `${item.Manufacturer}||${item.Model}`;
        const ilt = itemLaborByKey.get(iltKey) ?? [];
        if (ilt.length > 0) {
          let totalCost = 0, totalPrice = 0, totalHours = 0;
          for (const lt of ilt) {
            const typeName = (lt.Name || '').trim();
            const hours = num(lt.Hours);
            const rate = laborRateMap.get(typeName);
            if (rate && hours > 0) {
              totalCost += hours * rate.costPerHour;
              totalPrice += hours * rate.pricePerHour;
              totalHours += hours;
            }
          }
          if (totalHours > 0) {
            laborHours = totalHours;
            laborUnitCost = totalCost / totalHours;
            laborUnitPrice = totalPrice / totalHours;
          }
          pathILT++;
        } else if (num(item.LaborHours) > 0 && installRate) {
          laborHours = num(item.LaborHours);
          laborUnitCost = installRate.costPerHour;
          laborUnitPrice = installRate.pricePerHour;
          pathInstallRate++;
        } else {
          pathNoLabor++;
        }
      }

      const margin = num(item.Margin);
      const ownerFurnished = item.IsOfe === true;
      const isOptional = item.IsOptional === true;

      const existing = grouped.get(key);

      if (existing) {
        existing.qty += itemQty;
        if (locName) {
          existing.locations.set(locName, (existing.locations.get(locName) ?? 0) + itemQty);
        }
      } else {
        const locs = new Map<string, number>();
        if (locName) locs.set(locName, itemQty);
        grouped.set(key, {
          manufacturer: item.Manufacturer || '',
          model: item.Model || '',
          description: item.Description || '',
          category: mapCategory(item.Category),
          qty: itemQty,
          notes: item.Phase ? `Phase: ${item.Phase}` : '',
          locations: locs,
          itemType,
          unitCost,
          unitPrice,
          laborHours,
          laborUnitCost,
          laborUnitPrice,
          fixedLaborCost,
          fixedLaborPrice,
          marginPct: margin > 0 && margin <= 1 ? margin * 100 : margin,
          ownerFurnished,
          optional: isOptional,
        });
      }
    }

    console.log(`[dtools-lookup] Labor paths: ${pathILT} via ItemLaborTypes, ${pathInstallRate} via Install rate fallback, ${pathNoLabor} no labor, ${pathLabor} standalone labor items`);

    // ── Step 7: Insert BoM items ─────────────────────────────────────────────
    const bomRows = Array.from(grouped.values()).map((g, idx) => ({
      project_id: projectId,
      manufacturer: g.manufacturer,
      model: g.model,
      description: g.description,
      category: g.category,
      qty: g.qty,
      notes: g.notes,
      locations: Array.from(g.locations.entries()).map(([room, qty]) => ({ room, qty })),
      sort_order: idx,
      item_type: g.itemType,
      unit_cost: g.unitCost,
      unit_price: g.unitPrice,
      labor_hours: g.laborHours,
      labor_unit_cost: g.laborUnitCost,
      labor_unit_price: g.laborUnitPrice,
      fixed_labor_cost: g.fixedLaborCost,
      fixed_labor_price: g.fixedLaborPrice,
      margin_pct: g.marginPct,
      owner_furnished: g.ownerFurnished,
      optional: g.optional,
    }));

    if (bomRows.length > 0) {
      await supabase.from('project_bom_items').delete().eq('project_id', projectId);

      for (let i = 0; i < bomRows.length; i += 100) {
        const batch = bomRows.slice(i, i + 100);
        const { error } = await supabase.from('project_bom_items').insert(batch);
        if (error) {
          console.error(`[dtools-lookup] Insert batch error:`, error);
        }
      }
    }

    // ── Step 8: Update project status + value ──────────────────────────────
    // DTools exposes the authoritative project total as `Price` on both list
    // and detail endpoints. Format to match our stored `value` convention
    // ("$XXXk" / "$X.XM" / etc.).
    // Full precision with grouping + cents — matches dtools-import-project
    // so a re-sync can't change the formatting style of an existing project.
    const dtoolsPrice = num(fullProject?.Price ?? fullProject?.ProjectTotal ?? fullProject?.Total);
    const formattedValue = dtoolsPrice > 0
      ? '$' + dtoolsPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';

    const projectUpdate: Record<string, any> = {
      dtools_project_id: dtoolsProjectId,
      dtools_bom_status: 'found',
      updated_at: new Date().toISOString(),
    };
    if (formattedValue) projectUpdate.value = formattedValue;

    await supabase.from('projects').update(projectUpdate).eq('id', projectId);

    console.log(`[dtools-lookup] Imported ${bomRows.length} line items for project ${projectId}${formattedValue ? ` (value=${formattedValue})` : ''}`);

    return new Response(JSON.stringify({
      status: 'found',
      dtoolsProjectId,
      dtoolsProjectName: match.Name,
      itemsImported: bomRows.length,
      value: formattedValue,
    }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[dtools-lookup] Error:', err);

    await supabase.from('projects').update({
      dtools_bom_status: 'error',
      updated_at: new Date().toISOString(),
    }).eq('id', projectId);

    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
});
