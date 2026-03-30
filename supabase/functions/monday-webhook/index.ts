import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VALID_BUSINESS_UNITS = ['Instrata SE', 'Instrata SW', 'Instrata NE', 'Instrata MA'];

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  console.log('[monday-webhook] Received payload:', JSON.stringify(body));

  // ── Monday.com webhook challenge (sent during webhook registration) ──
  if (body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Extract item ID from event ──
  const event = body.event;
  if (!event) {
    console.log('[monday-webhook] No event in payload');
    return new Response(JSON.stringify({ status: 'no_event' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('[monday-webhook] Event type:', event.type, 'Board:', event.boardId, 'Pulse:', event.pulseId);

  const allowedTypes = ['create_pulse', 'update_column_value', 'column_change'];
  if (!allowedTypes.includes(event.type)) {
    console.log('[monday-webhook] Ignored event type:', event.type);
    return new Response(JSON.stringify({ status: 'ignored', type: event.type }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const expectedBoard = Deno.env.get('MONDAY_BOARD_ID');
  if (expectedBoard && String(event.boardId) !== expectedBoard) {
    console.log('[monday-webhook] Wrong board. Expected:', expectedBoard, 'Got:', event.boardId);
    return new Response(JSON.stringify({ status: 'wrong_board' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Monday uses "pulseId" for all event types
  const itemId = event.pulseId;
  if (!itemId) {
    console.log('[monday-webhook] No pulseId in event');
    return new Response(JSON.stringify({ status: 'no_item_id' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Fetch column values from Monday GraphQL API ──
  const apiToken = Deno.env.get('MONDAY_API_TOKEN');
  if (!apiToken) {
    return new Response(JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Use the 2024-10 API version for compatibility
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
            column {
              title
            }
            text
            value
          }
        }
      }`,
    }),
  });

  const gqlData = await gqlRes.json();
  console.log('[monday-webhook] Monday API response:', JSON.stringify(gqlData));

  if (gqlData.errors) {
    console.error('[monday-webhook] Monday API errors:', JSON.stringify(gqlData.errors));
    return new Response(JSON.stringify({ error: 'Monday API error', details: gqlData.errors }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const item = gqlData.data?.items?.[0];
  if (!item) {
    return new Response(JSON.stringify({ error: 'Item not found in Monday' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build a lookup by column title (lowercased) → text value
  const cols: Record<string, string> = {};
  for (const c of item.column_values) {
    const title = c.column?.title || c.id;
    cols[title.toLowerCase()] = c.text || '';
    console.log(`[monday-webhook] Column: "${title}" = "${c.text}" (id: ${c.id})`);
  }

  const projectName = item.name;
  const projectNumber = cols['project number'] || cols['number'] || '';
  const client = cols['client'] || '';
  const rawBU = cols['business unit'] || '';

  console.log('[monday-webhook] Extracted — name:', projectName, 'number:', projectNumber, 'client:', client, 'BU:', rawBU);

  // Normalize business unit to one of the valid values (case-insensitive match)
  const businessUnit =
    VALID_BUSINESS_UNITS.find((bu) => bu.toLowerCase() === rawBU.toLowerCase()) || '';

  // ── Supabase: idempotency check + insert ──
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('monday_item_id', itemId)
    .maybeSingle();

  if (existing) {
    console.log('[monday-webhook] Duplicate — already synced as:', existing.id);
    return new Response(
      JSON.stringify({ status: 'duplicate', id: existing.id }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: projectName,
      number: projectNumber,
      client,
      business_unit: businessUnit,
      address: '',
      status: 'Active',
      monday_item_id: itemId,
      created_by: null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[monday-webhook] Supabase insert error:', JSON.stringify(error));
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('[monday-webhook] Created project:', data.id);
  return new Response(
    JSON.stringify({ status: 'created', id: data.id }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
