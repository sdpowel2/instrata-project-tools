import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT_ID = Deno.env.get('MS_GRAPH_TENANT_ID') ?? 'd633c932-8a52-4aeb-a755-c0f1ffaf103c';
const CLIENT_ID = Deno.env.get('MS_GRAPH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('MS_GRAPH_CLIENT_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// The app's frontend origin — used for the final redirect after OAuth
const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? 'https://instrata-project-tools.fly.dev';

const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const SCOPES = 'Mail.Read Calendars.Read User.Read offline_access';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ── OAuth state signing ───────────────────────────────────────────────────────
// The `state` round-trips the initiating user's id through Microsoft, and the
// callback trusts it to decide whose ms_graph_tokens row is written. An
// unsigned state lets a crafted/replayed value bind a mailbox's tokens to
// another user's row, so we HMAC-sign it and verify the signature + a short
// expiry on the way back. Key: a dedicated secret if set, else the MS Graph
// client secret (already required for the flow, so no new config needed).
const STATE_SECRET = Deno.env.get('MS_GRAPH_STATE_SECRET') || CLIENT_SECRET;
const STATE_TTL_MS = 15 * 60 * 1000; // consent must complete within 15 minutes

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}
async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(STATE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}
async function signState(payload: { userId: string; ts: number }): Promise<string> {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(payloadB64)));
  return `${payloadB64}.${b64url(sig)}`;
}
async function verifyState(state: string): Promise<{ userId: string } | null> {
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = state.slice(0, dot);
  const sigBytes = b64urlToBytes(state.slice(dot + 1));
  // crypto.subtle.verify performs a constant-time comparison internally.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(), sigBytes, new TextEncoder().encode(payloadB64));
  if (!ok) return null;
  let payload: { userId?: unknown; ts?: unknown };
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))); }
  catch { return null; }
  if (typeof payload.userId !== 'string' || typeof payload.ts !== 'number') return null;
  if (Date.now() - payload.ts > STATE_TTL_MS) return null; // expired / replayed
  return { userId: payload.userId };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // ── ACTION: authorize ──────────────────────────────────────────────────────
  // Called from frontend. Returns the Microsoft authorize URL.
  if (req.method === 'POST' || (req.method === 'GET' && action === 'authorize')) {
    // Extract user ID from Supabase JWT
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Verify admin role
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

    // Build the redirect URI (this edge function's callback)
    const redirectUri = `${SUPABASE_URL}/functions/v1/ms-graph-auth?action=callback`;

    // Sign the user id into the state so the callback can trust it (HMAC + expiry).
    const state = await signState({ userId: user.id, ts: Date.now() });

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      response_mode: 'query',
      prompt: 'consent',
    });

    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

    return new Response(JSON.stringify({ authorizeUrl }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // ── ACTION: callback ───────────────────────────────────────────────────────
  // Microsoft redirects the browser here after user consent.
  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      const errorDesc = url.searchParams.get('error_description') || error;
      console.error('[ms-graph-auth] OAuth error:', errorDesc);
      return Response.redirect(`${APP_ORIGIN}/personal-ops?error=${encodeURIComponent(errorDesc)}`, 302);
    }

    if (!code || !state) {
      return Response.redirect(`${APP_ORIGIN}/personal-ops?error=missing_code_or_state`, 302);
    }

    // Verify the signed state and extract the user id. A missing/forged/expired
    // signature is rejected so tokens can't be bound to an attacker-chosen user.
    const verified = await verifyState(state);
    if (!verified) {
      return Response.redirect(`${APP_ORIGIN}/personal-ops?error=invalid_state`, 302);
    }
    const userId = verified.userId;

    // Exchange authorization code for tokens
    const redirectUri = `${SUPABASE_URL}/functions/v1/ms-graph-auth?action=callback`;

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: SCOPES,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error('[ms-graph-auth] Token exchange error:', tokenData.error_description);
      return Response.redirect(
        `${APP_ORIGIN}/personal-ops?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`,
        302,
      );
    }

    // Store tokens in Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    const { error: upsertError } = await supabase
      .from('ms_graph_tokens')
      .upsert({
        user_id: userId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('[ms-graph-auth] Token storage error:', upsertError);
      return Response.redirect(`${APP_ORIGIN}/personal-ops?error=token_storage_failed`, 302);
    }

    console.log(`[ms-graph-auth] Tokens stored for user ${userId}`);
    return Response.redirect(`${APP_ORIGIN}/personal-ops?connected=true`, 302);
  }

  // ── ACTION: disconnect ─────────────────────────────────────────────────────
  // Removes stored tokens (user disconnects email)
  if (action === 'disconnect') {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    await supabase.from('ms_graph_tokens').delete().eq('user_id', user.id);

    return new Response(JSON.stringify({ status: 'disconnected' }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
