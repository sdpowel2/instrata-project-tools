import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

const SYSTEM_PROMPT = `You are an email urgency scorer and reply drafter for a director at an AV/low-voltage integration company (Instrata Sound & Security). Your job is to score each email's urgency from 0–100, give a brief reason, and for urgent emails, draft a suggested reply.

Scoring guidelines:
- 90–100: Requires immediate action. Client escalations, safety issues, legal deadlines, critical system failures.
- 70–89: High urgency. Active project blockers, vendor deadline responses needed today, key stakeholder requests.
- 50–69: Moderate. Needs attention within 1–2 days. Internal coordination, scheduling, routine client follow-ups.
- 25–49: Low. Informational, newsletters, FYI threads, non-urgent internal updates.
- 0–24: Noise. Marketing, automated notifications, spam-adjacent, no action needed.

Consider: sender importance (clients > vendors > internal > automated), time sensitivity implied by subject/preview, thread activity level, and whether the director is likely the decision-maker.

Draft reply guidelines:
- Generate a "draftReply" for any email scored 50 or above (moderate urgency and higher).
- Write as the director — professional, concise, decisive tone. No fluff.
- The reply should be ready to send with minimal editing. Address the sender by first name.
- If the email is informational and no reply is truly needed, set draftReply to null.
- Keep replies under 150 words. Get to the point.

Respond with a JSON array. Each element must have exactly these fields:
- "id": the email's id (string)
- "urgencyScore": integer 0–100
- "urgencyReason": string, 1 sentence max
- "draftReply": string or null — a suggested reply for urgent/moderate emails, null for low-priority or no-reply-needed`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Auth
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

  // Parse email batch
  let body: { emails: Array<{ id: string; subject: string; from: string; bodyPreview: string; receivedDateTime: string; importance: string; isRead: boolean }> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  if (!body.emails || !Array.isArray(body.emails) || body.emails.length === 0) {
    return new Response(JSON.stringify({ scored: [] }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Build user message with email summaries
  const emailSummaries = body.emails.map((e, i) => {
    return `[${i + 1}] ID: ${e.id}
From: ${e.from}
Subject: ${e.subject}
Preview: ${e.bodyPreview}
Received: ${e.receivedDateTime}
Importance: ${e.importance}
Read: ${e.isRead}`;
  }).join('\n\n---\n\n');

  const userMessage = `Score the urgency of these ${body.emails.length} emails:\n\n${emailSummaries}`;

  // Call Claude API
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error(`[email-triage] Claude API error (${claudeRes.status}):`, errText);
    return new Response(JSON.stringify({ error: 'Claude API error', details: errText }), {
      status: 502, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const claudeData = await claudeRes.json();
  const responseText = claudeData.content?.[0]?.text || '[]';

  // Extract JSON from response (handle markdown code blocks)
  let scored: Array<{ id: string; urgencyScore: number; urgencyReason: string; draftReply: string | null }>;
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    scored = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) {
    console.error('[email-triage] Failed to parse Claude response:', responseText);
    scored = [];
  }

  return new Response(JSON.stringify({ scored }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
