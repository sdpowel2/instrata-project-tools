// Monday webhook — currently a no-op.
//
// Project creation has been moved to an explicit "Import from DTools" flow
// in the app, so we no longer auto-create projects when a Monday item flips
// to "Review" status. This file is kept (with the challenge handshake intact)
// so the existing Monday integration subscription doesn't 404, and so we can
// later re-add status-sync behavior on top of the same wiring without
// touching the Monday-side configuration.
//
// To re-enable any auto-handling, branch on `event.type` and add the desired
// behavior below the handshake response.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: { challenge?: string; event?: { type?: string; pulseId?: number; boardId?: number } };
  try { body = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  // Monday handshake — must echo the challenge for subscription verification.
  if (body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Log the event so we can confirm the webhook is firing while disabled.
  console.log('[monday-webhook] Event received (no-op):', JSON.stringify({
    type: body.event?.type,
    boardId: body.event?.boardId,
    pulseId: body.event?.pulseId,
  }));

  return new Response(JSON.stringify({ status: 'noop' }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
