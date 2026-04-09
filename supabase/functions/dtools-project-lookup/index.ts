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

interface DToolsProjectItem {
  Id: string;
  TypeId: number;
  Manufacturer: string;
  Model: string;
  Category?: string;
  Description?: string;
  Quantity: number;
  TotalQuantity?: number;
  LocationId?: string;
  LocationName?: string;
  Phase?: string;
}

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

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  // Handle CORS preflight
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
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DTOOLS_API_KEY not set' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
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

    // Find exact match or take first result
    const match = projects.find(
      (p: any) => p.Number?.toLowerCase() === projectNumber.toLowerCase(),
    ) ?? projects[0];

    const dtoolsProjectId = match.Id;
    console.log(`[dtools-lookup] Found DTools project: ${dtoolsProjectId} (${match.Name})`);

    // ── Step 2: Fetch project items with location aggregation ────────────────
    const detailData = await dtoolsFetch(
      apiKey,
      `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}&aggregateBy=Location`,
    );

    const project = detailData?.Project ?? detailData;
    const items: DToolsProjectItem[] = project?.Items ?? detailData?.Items ?? [];
    const locations: DToolsLocation[] = project?.Locations ?? [];

    // Build location ID → FullName map (preserves hierarchy via backslash path)
    const locationMap = new Map<string, string>();
    for (const loc of locations) {
      locationMap.set(loc.Id, loc.FullName || loc.Name);
    }

    // Enrich items with location names
    for (const item of items) {
      if (item.LocationId && !item.LocationName) {
        item.LocationName = locationMap.get(item.LocationId) ?? item.LocationId;
      }
    }

    // ── Step 3: Filter to products and group by manufacturer+model ───────────
    const products = items.filter((i) => i.TypeId === 1);
    console.log(`[dtools-lookup] Found ${items.length} total items, ${products.length} products`);

    const grouped = new Map<string, {
      manufacturer: string;
      model: string;
      description: string;
      category: string;
      qty: number;
      notes: string;
      locations: Map<string, number>;
    }>();

    for (const item of products) {
      const key = `${item.Manufacturer}||${item.Model}`;
      const itemQty = item.TotalQuantity ?? item.Quantity ?? 1;
      const locName = item.LocationName || '';
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
        });
      }
    }

    // ── Step 4: Insert BoM items into project_bom_items ──────────────────────
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
    }));

    if (bomRows.length > 0) {
      // Clear any existing BoM items for this project before importing
      await supabase.from('project_bom_items').delete().eq('project_id', projectId);

      // Insert in batches of 100
      for (let i = 0; i < bomRows.length; i += 100) {
        const batch = bomRows.slice(i, i + 100);
        const { error } = await supabase.from('project_bom_items').insert(batch);
        if (error) {
          console.error(`[dtools-lookup] Insert batch error:`, error);
        }
      }
    }

    // ── Step 5: Update project with DTools info ──────────────────────────────
    await supabase.from('projects').update({
      dtools_project_id: dtoolsProjectId,
      dtools_bom_status: 'found',
      updated_at: new Date().toISOString(),
    }).eq('id', projectId);

    console.log(`[dtools-lookup] Imported ${bomRows.length} BoM items for project ${projectId}`);

    return new Response(JSON.stringify({
      status: 'found',
      dtoolsProjectId,
      dtoolsProjectName: match.Name,
      itemsImported: bomRows.length,
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
