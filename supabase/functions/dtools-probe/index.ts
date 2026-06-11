// TEMPORARY read-only probe for DTools API exploration during CO development.
// POST { path: "/Subscribe/..." } → proxies the GET with our API key.
// DELETE THIS FUNCTION when CO work ships — it has no business in production.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders() });

  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'DTOOLS_API_KEY not set' }), { status: 500, headers: corsHeaders() });

  let path = '';
  try { path = (await req.json())?.path ?? ''; } catch { /* fall through */ }
  const allowed = ['/Subscribe/', '/SubscribePartialProjects/', '/Message/'];
  if (!allowed.some((p) => path.startsWith(p))) {
    return new Response(JSON.stringify({ error: `path must start with one of: ${allowed.join(', ')}` }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(`${DTOOLS_BASE}${path}`, { headers: { 'X-DTSI-ApiKey': apiKey } });
  const text = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: text.length > 0 ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
