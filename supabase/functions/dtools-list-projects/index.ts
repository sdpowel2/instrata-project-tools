// Lists projects available via the DTools Subscribe API for the
// "Import from DTools" picker in the New Project flow.
//
// Returns a flat array sized for the modal picker; the client filters by
// name client-side. If the project count grows past a few hundred we'll
// switch to server-side search via the DTools API's projectName param.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

// DTools Custom Field 27 holds the subsidiary code (NE, SE, MA, SW). We map
// it to the Instrata business unit names this app uses everywhere else.
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

interface ListedProject {
  dtoolsId: string;
  name: string;
  number: string;
  client: string;
  businessUnit: string; // Mapped to "Instrata NE/SE/MA/SW" or '' if unmapped
  siteAddress: string;  // One-line concatenation
  projectTotal: number; // Numeric for sorting; client formats for display
  status?: string;      // DTools project status if present
}

// Pulls the subsidiary value (NE/SE/MA/SW) out of DTools custom fields.
// DTools exposes custom fields a few different ways depending on the endpoint
// and SI version. We check the common shapes — list of {Id/Name/Value} or a
// keyed object — and fall back to '' if nothing matches.
function extractSubsidiary(p: any): string {
  const candidates: any[] = [];
  if (Array.isArray(p?.CustomFields)) candidates.push(...p.CustomFields);
  if (Array.isArray(p?.ProjectCustomFields)) candidates.push(...p.ProjectCustomFields);

  for (const cf of candidates) {
    const id = String(cf?.Id ?? cf?.id ?? '');
    const name = String(cf?.Name ?? cf?.name ?? '').toLowerCase();
    if (id === '27' || name === 'subsidiary') {
      const raw = String(cf?.Value ?? cf?.value ?? '').trim().toUpperCase();
      return raw;
    }
  }
  // Some DTools tenants surface custom fields as flat keys: CustomField27, etc.
  const flat = p?.CustomField27 ?? p?.customField27 ?? p?.Subsidiary;
  if (flat) return String(flat).trim().toUpperCase();
  return '';
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

// DTools projects can carry SiteAddress and BillingAddress as separate fields
// inside the project record. Prefer SiteAddress; fall back to BillingAddress.
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DTOOLS_API_KEY not set' }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Debug mode: returns the raw first project from BOTH the list endpoint and
  // the detail endpoint so we can see the actual DTools response shape.
  let debug = false;
  try {
    const body = await req.json();
    if (body?.debug === true) debug = true;
  } catch { /* empty body fine */ }

  // Short-circuit: in debug mode, skip the full pagination and just return
  // the raw shape from list + detail endpoints so the call returns fast.
  if (debug) {
    try {
      const listRaw = await dtoolsFetch(apiKey, `/Subscribe/Projects?pageSize=1&pageNumber=1`);
      const listFirst = Array.isArray(listRaw) ? listRaw[0] : (listRaw?.Projects ?? listRaw?.projects ?? [])[0];
      const firstId = String(listFirst?.Id ?? listFirst?.id ?? '');
      let detailProject = null;
      if (firstId) {
        const detailRaw = await dtoolsFetch(apiKey, `/Subscribe/Projects?id=${encodeURIComponent(firstId)}`);
        detailProject = detailRaw?.Project ?? detailRaw;
      }
      const trimmedDetail = detailProject ? { ...detailProject, Items: '<<truncated>>', Locations: '<<truncated>>' } : null;
      return new Response(JSON.stringify({
        debug: {
          listShapeKeys: listFirst ? Object.keys(listFirst).sort() : [],
          listShapeSample: listFirst,
          detailShapeKeys: detailProject ? Object.keys(detailProject).sort() : [],
          detailShapeSample: trimmedDetail,
        },
      }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    // Page through DTools until exhausted. Cap loops for safety.
    const PAGE_SIZE = 200;
    const HARD_CAP_LOOPS = 25; // 5000 projects max in one call
    const all: ListedProject[] = [];
    const seenIds = new Set<string>();

    for (let page = 1; page <= HARD_CAP_LOOPS; page++) {
      const data = await dtoolsFetch(
        apiKey,
        `/Subscribe/Projects?pageSize=${PAGE_SIZE}&pageNumber=${page}`,
      );

      const batch: any[] = Array.isArray(data)
        ? data
        : (data?.Projects ?? data?.projects ?? []);

      if (batch.length === 0) break;

      for (const p of batch) {
        const id = String(p?.Id ?? p?.id ?? '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const subsidiary = extractSubsidiary(p);
        all.push({
          dtoolsId: id,
          name: String(p?.Name ?? p?.name ?? '').trim(),
          number: String(p?.Number ?? p?.number ?? '').trim(),
          client: String(p?.ClientName ?? p?.clientName ?? p?.Client ?? '').trim(),
          businessUnit: SUBSIDIARY_TO_BU[subsidiary] ?? '',
          siteAddress: extractSiteAddress(p),
          // DTools list endpoint exposes the project total as `Price`.
          projectTotal: num(p?.Price ?? p?.ProjectTotal ?? p?.Total),
          status: typeof p?.Progress === 'string' ? p.Progress : (typeof p?.Status === 'string' ? p.Status : undefined),
        });
      }

      // If we got fewer than the page size, we're done.
      if (batch.length < PAGE_SIZE) break;
    }

    // Newest / largest first feels right by default for the picker.
    // Number is usually monotonic per-region (e.g. INS-2026-XXX), so sort by
    // number desc as a proxy for "most recent".
    all.sort((a, b) => b.number.localeCompare(a.number));

    // Debug mode — also fetch the FIRST raw project from list and detail
    // endpoints so we can see what fields DTools actually returns. Strips
    // Items array to keep response small.
    let debugPayload: unknown = undefined;
    if (debug && all.length > 0) {
      const firstId = all[0].dtoolsId;
      const listRaw = await dtoolsFetch(apiKey, `/Subscribe/Projects?pageSize=1&pageNumber=1`);
      const listFirst = Array.isArray(listRaw) ? listRaw[0] : (listRaw?.Projects ?? listRaw?.projects ?? [])[0];
      const detailRaw = await dtoolsFetch(apiKey, `/Subscribe/Projects?id=${encodeURIComponent(firstId)}`);
      const detailProject = detailRaw?.Project ?? detailRaw;
      // Drop noisy arrays so we can see the shape clearly.
      const trimmedDetail = detailProject ? { ...detailProject, Items: '<<truncated>>', Locations: '<<truncated>>' } : null;
      debugPayload = {
        listShapeKeys: listFirst ? Object.keys(listFirst).sort() : [],
        listShapeSample: listFirst,
        detailShapeKeys: detailProject ? Object.keys(detailProject).sort() : [],
        detailShapeSample: trimmedDetail,
      };
    }

    return new Response(JSON.stringify({
      projects: all,
      fetchedAt: new Date().toISOString(),
      ...(debugPayload ? { debug: debugPayload } : {}),
    }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[dtools-list-projects] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
});
