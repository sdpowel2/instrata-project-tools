import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildBomFromDtools, buildChangeOrderItems, extractGmMeta, type LaborMeta } from './transform.ts';

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ─── D-Tools API helpers ─────────────────────────────────────────────────────

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

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

/** Map a DTools change-order status string to our enum.
 *  DTools commonly returns "Pending" / "Approved" / "Rejected" verbatim, but
 *  also surfaces "Open" / "Submitted" (treated as Pending) and "Denied"
 *  (treated as Rejected) on older records. Anything we don't recognise
 *  defaults to Pending so the row is at least visible to the PM. */
function mapCOStatus(raw: any): 'Pending' | 'Approved' | 'Rejected' {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('approve')) return 'Approved';
  if (s.includes('reject') || s.includes('denied') || s.includes('decline')) return 'Rejected';
  return 'Pending';
}

/** Map DTools' internal/external flag. In our tenant the canonical field
 *  is COType ("Internal" / "External"), but we keep older shapes in the
 *  fallback chain so a tenant migration can't silently break the read.
 *  Anything that doesn't read as Internal is treated as External (the
 *  contract-facing case) so we never lose track of a contract impact. */
function mapCOCategory(co: any): 'Internal' | 'External' {
  if (typeof co?.IsInternal === 'boolean') return co.IsInternal ? 'Internal' : 'External';
  if (typeof co?.IsExternal === 'boolean') return co.IsExternal ? 'External' : 'Internal';
  const flag = String(co?.COType ?? co?.Category ?? co?.Type ?? co?.Kind ?? '').toLowerCase();
  if (flag.includes('internal')) return 'Internal';
  return 'External';
}

/** ISO date (YYYY-MM-DD) or null. DTools serializes dates a few different
 *  ways depending on the field; we normalise to a calendar date so the
 *  client doesn't have to think about timezones. */
function toDate(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

    // ── Step 2: Fetch the project, unaggregated ─────────────────────────────
    // The unaggregated payload is the only shape that populates ItemLaborTypes
    // (aggregateBy=Location/Item return them empty), and its rows carry
    // LocationId, so per-location quantities come along for free.
    const fullData = await dtoolsFetch(
      apiKey,
      `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}`,
    );
    const fullProject = fullData?.Project ?? fullData;

    // ── Step 3: Transform (pure, offline-verified — see transform.ts and
    // scripts/verify-dtools-sync.mts) ────────────────────────────────────────
    // Post-approval payloads zero out the phase-row labor rates, so we feed
    // the transform the LaborMeta persisted from the last priced payload.
    const { data: projectRow } = await supabase
      .from('projects')
      .select('dtools_labor_meta')
      .eq('id', projectId)
      .maybeSingle();
    const priorMeta: LaborMeta | null = projectRow?.dtools_labor_meta ?? null;

    const { bomRows, totals, log, payloadFlavor, laborMeta } = buildBomFromDtools(fullProject, priorMeta);
    for (const line of log) console.log(`[dtools-lookup] ${line}`);

    // ── Step 4: Insert BoM items ─────────────────────────────────────────────
    const insertRows = bomRows.map((r) => ({ ...r, project_id: projectId }));
    if (insertRows.length > 0) {
      await supabase.from('project_bom_items').delete().eq('project_id', projectId);

      for (let i = 0; i < insertRows.length; i += 100) {
        const batch = insertRows.slice(i, i + 100);
        const { error } = await supabase.from('project_bom_items').insert(batch);
        if (error) {
          console.error(`[dtools-lookup] Insert batch error:`, error);
        }
      }
    }

    // ── Step 5: Update project status + authoritative DTools totals ─────────
    // Headline `value` keeps the root Price (what the customer sees). The
    // dtools_* columns carry the full root snapshot; dtools_sync_delta records
    // the reconciliation between our line math and DTools' roots.
    const formattedValue = totals.rootPrice > 0
      ? '$' + totals.rootPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';

    const projectUpdate: Record<string, any> = {
      dtools_project_id: dtoolsProjectId,
      dtools_bom_status: 'found',
      dtools_cost: totals.rootCost,
      dtools_price_without_tax: totals.rootPriceWithoutTax,
      dtools_tax: totals.rootTax,
      dtools_price: totals.rootPrice,
      dtools_hours: totals.rootHours,
      dtools_synced_at: new Date().toISOString(),
      dtools_sync_delta: {
        equipmentCost: totals.equipmentCost,
        equipmentPrice: totals.equipmentPrice,
        laborCost: totals.laborCost,
        laborPrice: totals.laborPrice,
        costDelta: totals.costDelta,
        priceDelta: totals.priceDelta,
        rowCostDelta: totals.rowCostDelta,
        rowPriceDelta: totals.rowPriceDelta,
        echoModels: totals.echoModels,
        verified: totals.verified,
        payloadFlavor,
        unattributedLaborCost: totals.unattributedLaborCost,
        unattributedLaborPrice: totals.unattributedLaborPrice,
        // When the parent project last published to the API. COs approved
        // AFTER this moment cannot be merged into the synced totals yet —
        // the UI uses it to flag the drift and prompt an SI republish.
        publishedOn: String(fullProject?.PublishedOn ?? ''),
      },
      // Project-level metadata the Gross Margin Form needs (custom fields,
      // header fields, tax split). Refreshed every sync; the GM Form's manual
      // overrides live separately in project_documents.
      dtools_gm_meta: extractGmMeta(fullProject),
      updated_at: new Date().toISOString(),
    };
    if (formattedValue) projectUpdate.value = formattedValue;
    // Persist fresh labor knowledge from priced payloads; keep the existing
    // snapshot when DTools sends a zero-priced one.
    if (payloadFlavor === 'priced' && laborMeta) projectUpdate.dtools_labor_meta = laborMeta;

    await supabase.from('projects').update(projectUpdate).eq('id', projectId);

    if (!totals.verified) {
      console.error(`[dtools-lookup] VERIFICATION MISMATCH: Δcost ${totals.costDelta}, Δprice ${totals.priceDelta}, rows Δ ${totals.rowCostDelta}/${totals.rowPriceDelta}`);
    }

    // ── Step 6: Fetch + upsert change orders ───────────────────────────────
    // A published CO appears in the project-number list as a row with the
    // SAME Id as the parent project and a non-empty CONumber (verified on
    // Maricopa Dunlap 2026-06-11 — list rows carry NO IsChangeOrder field).
    // Full CO detail comes from ?id={parentId}&coNumber={CONumber}: a small
    // project payload whose items carry COChangeTypeId (1=Added, 2=Removed
    // with negated prices/hours) and whose root Price/Cost are the CO's net
    // signed delta.
    //
    // GOTCHA: DTools' API is pure publish/subscribe. A CO only enters the
    // subscription when its status transition fires the SI tenant's
    // "send CO to API" setting (or it's explicitly published). Unpublished
    // COs are invisible here — ?coNumber returns 404 — even if they're
    // merged into the approved project's payload as placeholder items.
    // Fix is on the SI side: toggle the CO's status, then re-sync.
    let coCount = 0;
    try {
      const siblingSearch = await dtoolsFetch(
        apiKey,
        `/Subscribe/Projects?projectNumber=${encodeURIComponent(projectNumber)}&pageSize=200&pageNumber=1`,
      );
      const siblings = Array.isArray(siblingSearch)
        ? siblingSearch
        : (siblingSearch?.Projects ?? siblingSearch?.projects ?? []);
      const coListRows: any[] = siblings.filter((p: any) =>
        String(p?.CONumber ?? '').trim() !== '' || p?.IsChangeOrder === true,
      );

      // Fetch each CO's full payload by parent id + CO number.
      const fetched: { listRow: any; detail: any | null }[] = [];
      for (const listRow of coListRows) {
        const coNumber = String(listRow?.CONumber ?? '').trim();
        const parentId = String(listRow?.Id ?? dtoolsProjectId);
        if (!coNumber) { fetched.push({ listRow, detail: null }); continue; }
        try {
          const detail = await dtoolsFetch(
            apiKey,
            `/Subscribe/Projects?id=${encodeURIComponent(parentId)}&coNumber=${encodeURIComponent(coNumber)}`,
          );
          fetched.push({ listRow, detail: detail?.Project ?? detail });
        } catch (detailErr) {
          console.warn(`[dtools-lookup] CO detail fetch failed for ${coNumber}, using list row:`, detailErr instanceof Error ? detailErr.message : detailErr);
          fetched.push({ listRow, detail: null });
        }
      }

      // Wipe + re-insert (items cascade with their CO rows): prunes COs
      // DTools removed and keeps re-syncs idempotent.
      await supabase.from('change_orders').delete().eq('project_id', projectId);

      for (const { listRow, detail } of fetched) {
        const co = detail ?? listRow;
        const number = String(co.CONumber ?? listRow.CONumber ?? '').trim();
        if (!number) continue;
        const status = mapCOStatus(co.COStatus ?? co.Status);
        const resolvedAt = status === 'Approved'
          ? toDate(co.COAcceptedOn ?? co.ApprovedOn ?? co.ResolvedOn)
          : status === 'Rejected'
            ? toDate(co.CORejectedOn ?? co.RejectedOn ?? co.ResolvedOn)
            : null;

        // Signed delta lines, priced with the parent project's labor rates
        // (the CO's own phase rows are zero-priced).
        const coResult = detail ? buildChangeOrderItems(detail, fullProject, laborMeta ?? priorMeta) : null;
        if (coResult) for (const line of coResult.log) console.log(`[dtools-lookup] ${line}`);

        const { data: coInserted, error: coErr } = await supabase
          .from('change_orders')
          .insert({
            project_id: projectId,
            number,
            title: String(co.COName ?? '').trim(),
            description: String(co.CONotes ?? '').trim(),
            amount: num(co.Price ?? listRow.Price ?? 0),
            cost: detail ? num(co.Cost) : null,
            tax: co.Tax != null ? num(co.Tax) : null,
            labor_hours: coResult ? coResult.hoursDelta : null,
            dtools_verified: coResult ? coResult.verified : null,
            items_synced: !!coResult,
            status,
            category: mapCOCategory(co),
            requested_at: toDate(co.COCreatedOn ?? co.CreatedOn),
            resolved_at: resolvedAt,
            // CO list rows reuse the parent project's Id, so the stable
            // per-project identity is the CO number itself.
            dtools_id: number,
            updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (coErr || !coInserted) {
          console.error(`[dtools-lookup] CO insert error for ${number}:`, coErr);
          continue;
        }
        if (coResult && coResult.items.length > 0) {
          const itemRows = coResult.items.map((it) => ({ ...it, change_order_id: coInserted.id }));
          const { error: itemErr } = await supabase.from('change_order_items').insert(itemRows);
          if (itemErr) console.error(`[dtools-lookup] CO items insert error for ${number}:`, itemErr);
        }
        coCount++;
      }
    } catch (coErr) {
      // Don't fail the whole sync over COs — the BoM is the user's primary
      // ask. Surface the issue in logs so we can diagnose it later.
      console.error('[dtools-lookup] CO sync failed (BoM still imported):', coErr);
    }

    console.log(`[dtools-lookup] Imported ${insertRows.length} line items, ${coCount} change orders for project ${projectId}${formattedValue ? ` (value=${formattedValue})` : ''}`);

    return new Response(JSON.stringify({
      status: 'found',
      dtoolsProjectId,
      dtoolsProjectName: match.Name,
      itemsImported: insertRows.length,
      changeOrdersImported: coCount,
      value: formattedValue,
      totals: {
        equipmentCost: totals.equipmentCost,
        equipmentPrice: totals.equipmentPrice,
        laborCost: totals.laborCost,
        laborPrice: totals.laborPrice,
        totalCost: totals.totalCost,
        totalPrice: totals.totalPrice,
        verified: totals.verified,
      },
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
