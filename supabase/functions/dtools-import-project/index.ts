// One-shot "Import from DTools" — given a DTools project id, create the
// Supabase project row with metadata pulled from DTools, then delegate the
// BoM/locations sync to the existing dtools-project-lookup function so we
// reuse its location-hierarchy and labor-rate logic verbatim.
//
// Returns { projectId } so the client can navigate straight to the new
// project's overview after import.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

const SUBSIDIARY_TO_BU: Record<string, string> = {
  NE: 'Instrata NE',
  SE: 'Instrata SE',
  MA: 'Instrata MA',
  SW: 'Instrata SW',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
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

function extractSubsidiary(p: any): string {
  const candidates: any[] = [];
  if (Array.isArray(p?.CustomFields)) candidates.push(...p.CustomFields);
  if (Array.isArray(p?.ProjectCustomFields)) candidates.push(...p.ProjectCustomFields);

  for (const cf of candidates) {
    const id = String(cf?.Id ?? cf?.id ?? '');
    const name = String(cf?.Name ?? cf?.name ?? '').toLowerCase();
    if (id === '27' || name === 'subsidiary') {
      return String(cf?.Value ?? cf?.value ?? '').trim().toUpperCase();
    }
  }
  const flat = p?.CustomField27 ?? p?.customField27 ?? p?.Subsidiary;
  return flat ? String(flat).trim().toUpperCase() : '';
}

function joinAddress(addr: any): string {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [
    addr.Street1 ?? addr.street1,
    addr.City ?? addr.city,
    addr.State ?? addr.state,
    addr.PostalCode ?? addr.postalCode,
  ].filter((p) => typeof p === 'string' && p.trim().length > 0);
  return parts.join(', ');
}

function extractSiteAddress(p: any): string {
  const site = joinAddress(p?.SiteAddress ?? p?.siteAddress);
  if (site) return site;
  return joinAddress(p?.BillingAddress ?? p?.billingAddress ?? p?.Address);
}

function num(v: any): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Format the DTools Price into the canonical `value` string we store.
// Full precision with grouping + cents (e.g. 505432.5 → "$505,432.50") so
// downstream displays can either show it as-is or compact it themselves.
function formatValue(total: number): string {
  if (!total || total <= 0) return '';
  return '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  let body: { dtoolsProjectId?: string; createdBy?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
    status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  }); }

  const { dtoolsProjectId, createdBy } = body;
  if (!dtoolsProjectId) {
    return new Response(JSON.stringify({ error: 'dtoolsProjectId required' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DTOOLS_API_KEY not set' }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // ── Step 1: Pull project metadata from DTools ──────────────────────────────
    const data = await dtoolsFetch(apiKey, `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}`);
    const project = data?.Project ?? data;
    if (!project || !project.Id) {
      return new Response(JSON.stringify({ error: 'DTools project not found' }), {
        status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const name = String(project.Name ?? '').trim();
    const number = String(project.Number ?? '').trim();
    const client = String(project.ClientName ?? project.Client ?? '').trim();
    const subsidiary = extractSubsidiary(project);
    const businessUnit = SUBSIDIARY_TO_BU[subsidiary] ?? '';
    const siteAddress = extractSiteAddress(project);
    // DTools exposes the project total as `Price` on both list and detail.
    const projectTotal = num(project.Price ?? project.ProjectTotal ?? project.Total);
    const value = formatValue(projectTotal);

    // Phase derives from DTools' Approved boolean: true → Post-Sales,
    // false (Budgetary, Quoted, Open, etc.) → Pre-Sales. The user can flip
    // it manually later if needed.
    const phase: 'Pre-Sales' | 'Post-Sales' =
      project.Approved === true ? 'Post-Sales' : 'Pre-Sales';

    if (!number) {
      return new Response(JSON.stringify({ error: 'DTools project has no Number — required for BoM sync' }), {
        status: 422, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // ── Step 2: Idempotency — if a project with this dtools_project_id already
    // exists, return it instead of double-creating.
    const { data: existing } = await supabase
      .from('projects')
      .select('id')
      .eq('dtools_project_id', dtoolsProjectId)
      .maybeSingle();

    if (existing?.id) {
      return new Response(JSON.stringify({
        projectId: existing.id,
        alreadyExisted: true,
      }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
    }

    // ── Step 3: Create the project row ─────────────────────────────────────────
    const { data: inserted, error: insertErr } = await supabase
      .from('projects')
      .insert({
        name,
        number,
        client,
        business_unit: businessUnit,
        address: siteAddress,
        status: 'Not Started',
        phase,
        value,
        dtools_project_id: dtoolsProjectId,
        dtools_bom_status: 'loading',
        created_by: createdBy ?? null,
      })
      .select('id')
      .single();

    if (insertErr || !inserted) {
      console.error('[dtools-import-project] Insert error:', insertErr);
      return new Response(JSON.stringify({ error: insertErr?.message ?? 'Insert failed' }), {
        status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const newProjectId = inserted.id;

    // Add the creator as a project member if we have one. Mirrors what the
    // store's addProject does.
    if (createdBy) {
      const { error: memberErr } = await supabase
        .from('project_members')
        .insert({ project_id: newProjectId, user_id: createdBy });
      if (memberErr) console.error('[dtools-import-project] Member insert failed:', memberErr);
    }

    // ── Step 4: Delegate BoM sync to dtools-project-lookup ────────────────────
    // Reuses location-hierarchy + labor-rate handling without duplication.
    const lookupRes = await fetch(`${supabaseUrl}/functions/v1/dtools-project-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ projectId: newProjectId, projectNumber: number }),
    });
    const lookupResult = await lookupRes.json();
    console.log('[dtools-import-project] BoM lookup result:', JSON.stringify(lookupResult));

    return new Response(JSON.stringify({
      projectId: newProjectId,
      projectNumber: number,
      projectName: name,
      bomStatus: lookupResult?.status ?? 'unknown',
      itemsImported: lookupResult?.itemsImported ?? 0,
    }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[dtools-import-project] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
});
