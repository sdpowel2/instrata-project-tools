import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_BUSINESS_UNITS = ['Instrata SE', 'Instrata SW', 'Instrata NE', 'Instrata MA'];
const STATUS_COLUMN_ID     = 'status9';

// ─── D-Tools project lookup (fire-and-forget) ────────────────────────────────

async function triggerDToolsLookup(
  supabaseClient: any,
  projectId: string,
  projectNumber: string,
) {
  if (!projectNumber) return;
  const apiKey = Deno.env.get('DTOOLS_API_KEY');
  if (!apiKey) {
    console.log('[monday-webhook] DTOOLS_API_KEY not set — skipping DTools lookup');
    return;
  }

  try {
    // Call the dtools-project-lookup edge function
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const res = await fetch(`${supabaseUrl}/functions/v1/dtools-project-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ projectId, projectNumber }),
    });
    const result = await res.json();
    console.log(`[monday-webhook] DTools lookup result:`, JSON.stringify(result));
  } catch (err) {
    console.error('[monday-webhook] DTools lookup failed (non-blocking):', err);
  }
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

  // ── Board routing ──────────────────────────────────────────────────────────
  const presalesBoardId  = Deno.env.get('MONDAY_PRESALES_BOARD_ID')  ?? '3477536693';
  const postsalesBoardId = Deno.env.get('MONDAY_BOARD_ID');
  const incomingBoardId  = String(event.boardId);

  const isPresales  = incomingBoardId === presalesBoardId;
  const isPostsales = postsalesBoardId ? incomingBoardId === postsalesBoardId : false;

  if (!isPresales && !isPostsales) {
    console.log(`[monday-webhook] Wrong board. Expected presales=${presalesBoardId} or postsales=${postsalesBoardId}. Got: ${incomingBoardId}`);
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
          column_values {
            id
            column { title }
            text
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
    cols[title.toLowerCase()] = c.text || '';
    colsById[c.id]            = c.text || '';
    console.log(`[monday-webhook] Column "${title}" (${c.id}) = "${c.text}"`);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const projectName  = item.name;
  const projectNum   = cols['quote number'] || cols['project number'] || cols['number'] || '';
  const client       = cols['client'] || '';
  const rawBU        = cols['business unit'] || '';
  const businessUnit = VALID_BUSINESS_UNITS.find(bu => bu.toLowerCase() === rawBU.toLowerCase()) || '';

  // ── PRE-SALES board: only create project when status = "Review" ────────────
  if (isPresales) {
    const currentStatus = colsById[STATUS_COLUMN_ID] || cols['status'] || '';
    console.log(`[monday-webhook] Pre-sales board — status is "${currentStatus}"`);

    if (currentStatus.toLowerCase() !== 'review') {
      // Not a Review trigger — ignore
      return new Response(JSON.stringify({ status: 'ignored', reason: 'not_review_status', currentStatus }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Status is "Review" — upsert the project record
    // CSV upload and auto-review are now handled inside Project Tools by the manager
    const { data: existing } = await supabase
      .from('projects')
      .select('id')
      .eq('monday_item_id', itemId)
      .maybeSingle();

    if (existing) {
      await supabase.from('projects').update({
        name: projectName, number: projectNum, client, business_unit: businessUnit,
        updated_at: new Date().toISOString(),
      }).eq('monday_item_id', itemId);
      console.log(`[monday-webhook] Pre-sales "Review" — updated existing project ${existing.id}`);
      return new Response(JSON.stringify({ status: 'updated', id: existing.id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        name: projectName, number: projectNum, client,
        business_unit: businessUnit, status: 'Active',
        monday_item_id: itemId, created_by: null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[monday-webhook] Insert error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[monday-webhook] Pre-sales "Review" — created new project ${data.id}`);

    // Fire-and-forget DTools BoM lookup
    await triggerDToolsLookup(supabase, data.id, projectNum);

    return new Response(JSON.stringify({ status: 'created', id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── POST-SALES board: create or update project (legacy — will be deprecated) ─
  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('monday_item_id', itemId)
    .maybeSingle();

  if (existing) {
    await supabase.from('projects').update({
      name: projectName, number: projectNum, client, business_unit: businessUnit,
      updated_at: new Date().toISOString(),
    }).eq('monday_item_id', itemId);
    return new Response(JSON.stringify({ status: 'updated', id: existing.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: projectName, number: projectNum, client,
      business_unit: businessUnit, status: 'Active',
      monday_item_id: itemId, created_by: null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[monday-webhook] Insert error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fire-and-forget DTools BoM lookup
  await triggerDToolsLookup(supabase, data.id, projectNum);

  return new Response(JSON.stringify({ status: 'created', id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
