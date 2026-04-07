import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT_ID = Deno.env.get('MS_GRAPH_TENANT_ID') ?? 'd633c932-8a52-4aeb-a755-c0f1ffaf103c';
const CLIENT_ID = Deno.env.get('MS_GRAPH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('MS_GRAPH_CLIENT_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// Session time windows (hours, local-ish — the client passes its local date)
const SESSION_WINDOWS: Record<string, { startHour: number; endHour: number }> = {
  morning: { startHour: 0, endHour: 12 },
  midday:  { startHour: 8, endHour: 16 },
  eod:     { startHour: 12, endHour: 24 },
};

async function refreshTokenIfNeeded(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  tokenRow: { access_token: string; refresh_token: string; expires_at: string },
): Promise<string> {
  const expiresAt = new Date(tokenRow.expires_at);
  const bufferMs = 5 * 60 * 1000; // 5 minutes

  if (expiresAt.getTime() - Date.now() > bufferMs) {
    return tokenRow.access_token;
  }

  console.log(`[ms-graph-emails] Refreshing token for user ${userId}`);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
      grant_type: 'refresh_token',
      scope: 'Mail.Read Calendars.Read User.Read offline_access',
    }),
  });

  const data = await res.json();
  if (data.error) {
    console.error('[ms-graph-emails] Token refresh failed:', data.error_description);
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await supabase.from('ms_graph_tokens').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokenRow.refresh_token,
    expires_at: newExpiresAt,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);

  return data.access_token;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  // Auth: extract user from Supabase JWT
  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), {
      status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin access required' }), {
      status: 403, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Get stored tokens
  const { data: tokenRow } = await supabase
    .from('ms_graph_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', user.id)
    .single();

  if (!tokenRow) {
    return new Response(JSON.stringify({ error: 'Email not connected. Please connect via OAuth first.' }), {
      status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Refresh if needed
  let accessToken: string;
  let tokenStatus = 'valid';
  try {
    const original = tokenRow.access_token;
    accessToken = await refreshTokenIfNeeded(supabase, user.id, tokenRow);
    if (accessToken !== original) tokenStatus = 'refreshed';
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Parse request params
  let session = 'morning';
  let date = new Date().toISOString().split('T')[0];

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      session = body.session || session;
      date = body.date || date;
    } catch { /* use defaults */ }
  } else {
    const url = new URL(req.url);
    session = url.searchParams.get('session') || session;
    date = url.searchParams.get('date') || date;
  }

  // Build time filter
  const window = SESSION_WINDOWS[session] || SESSION_WINDOWS.morning;
  const startDate = `${date}T${String(window.startHour).padStart(2, '0')}:00:00Z`;
  const endDate = `${date}T${String(window.endHour).padStart(2, '0')}:00:00Z`;

  const filter = `receivedDateTime ge ${startDate} and receivedDateTime lt ${endDate}`;
  const select = 'id,subject,from,receivedDateTime,bodyPreview,importance,isRead,hasAttachments,conversationId';

  const graphUrl = `${GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$orderby=receivedDateTime desc&$top=50`;

  const graphRes = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!graphRes.ok) {
    const errText = await graphRes.text();
    console.error(`[ms-graph-emails] Graph API error (${graphRes.status}):`, errText);
    return new Response(JSON.stringify({ error: 'Graph API error', details: errText }), {
      status: graphRes.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const graphData = await graphRes.json();

  return new Response(JSON.stringify({
    emails: graphData.value || [],
    tokenStatus,
    session,
    date,
  }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
