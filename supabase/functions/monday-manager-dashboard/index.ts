// Manager Dashboard feed — pulls items from the AV Pre-Sales Summary board's
// "New Requests" group and returns two triage buckets to the client:
//   - triage: due date set, no pre-sales engineer assigned
//   - review: status column set to "Review", sorted by due date ascending
//
// Called from the app via supabase.functions.invoke('monday-manager-dashboard').
// Admin-only gating is enforced client-side today; this function trusts the
// Supabase JWT so any signed-in user can hit it. Tighten with a profile
// lookup here if/when the feed needs to be hidden from non-admins server-side.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const BOARD_ID = Deno.env.get('MONDAY_PRESALES_BOARD_ID') ?? '3477536693';
const GROUP_TITLE = 'New Requests';
const COL_DATE   = 'date7';
const COL_PERSON = 'person';
const COL_STATUS = 'status9';
const REVIEW_LABEL = 'review'; // matched case-insensitively

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

interface MondayColumnValue {
  id: string;
  text: string | null;
  value: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}

interface MondayGroup {
  id: string;
  title: string;
  items_page: {
    cursor: string | null;
    items: MondayItem[];
  };
}

interface ManagerDashboardItem {
  id: string;
  name: string;
  dueDate: string; // YYYY-MM-DD or '' if unset
}

// Monday returns the person column as JSON:
//   { "personsAndTeams": [{ "id": 123, "kind": "person" }] }  ← assigned
//   { "personsAndTeams": [] } or null                         ← unassigned
// The `text` field is usually a comma-separated name list; empty string means
// unassigned. We trust `value` first (structured) and fall back to `text`.
function isPersonAssigned(col: MondayColumnValue | undefined): boolean {
  if (!col) return false;
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      const arr = parsed?.personsAndTeams;
      if (Array.isArray(arr) && arr.length > 0) return true;
    } catch { /* fall through */ }
  }
  return !!col.text && col.text.trim().length > 0;
}

function colById(item: MondayItem, id: string): MondayColumnValue | undefined {
  return item.column_values.find((c) => c.id === id);
}

function dueDateOf(item: MondayItem): string {
  const col = colById(item, COL_DATE);
  return col?.text?.trim() ?? '';
}

function statusOf(item: MondayItem): string {
  const col = colById(item, COL_STATUS);
  return col?.text?.trim() ?? '';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiToken = Deno.env.get('MONDAY_API_TOKEN');
  if (!apiToken) {
    return new Response(JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // --- Parse optional debug flag from the request body ---
  let debugNameQuery = '';
  try {
    const body = await req.json();
    if (body && typeof body.debugNameQuery === 'string') debugNameQuery = body.debugNameQuery.trim().toLowerCase();
  } catch { /* empty body is fine */ }

  async function runQuery(q: string): Promise<any> {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Authorization': apiToken!,
        'Content-Type': 'application/json',
        'API-Version': '2024-10',
      },
      body: JSON.stringify({ query: q }),
    });
    return res.json();
  }

  // --- Step 1: find the target group's id by title ---
  // Pulling groups first (no items) keeps this lightweight; we then page items
  // within that single group using items_page_by_column_values? Actually the
  // cleanest available API is `groups.items_page` with pagination via cursor.
  const groupsQuery = `query {
    boards(ids: [${BOARD_ID}]) {
      groups {
        id
        title
      }
    }
  }`;

  let groupsData;
  try {
    groupsData = await runQuery(groupsQuery);
  } catch (err) {
    console.error('[monday-manager-dashboard] groups fetch failed:', err);
    return new Response(JSON.stringify({ error: 'Monday API request failed' }), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
  if (groupsData.errors) {
    console.error('[monday-manager-dashboard] groups GraphQL errors:', JSON.stringify(groupsData.errors));
    return new Response(JSON.stringify({ error: 'Monday GraphQL error', details: groupsData.errors }), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const allGroups: { id: string; title: string }[] = groupsData.data?.boards?.[0]?.groups ?? [];
  const targetGroup = allGroups.find((g) => g.title.trim().toLowerCase() === GROUP_TITLE.toLowerCase());
  if (!targetGroup) {
    console.warn(`[monday-manager-dashboard] Group "${GROUP_TITLE}" not found. Available:`, allGroups.map((g) => g.title));
    return new Response(JSON.stringify({ triage: [], review: [], warning: `Group "${GROUP_TITLE}" not found` }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // --- Step 2: page through items in that group (cursor-based) ---
  const PAGE_SIZE = 500;
  let cursor: string | null = null;
  const items: MondayItem[] = [];

  for (let loop = 0; loop < 20; loop++) { // hard safety cap: 10k items max
    const itemsQuery: string = cursor
      ? `query { next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") {
          cursor
          items {
            id name
            column_values(ids: ["${COL_DATE}", "${COL_PERSON}", "${COL_STATUS}"]) { id text value }
          }
        } }`
      : `query { boards(ids: [${BOARD_ID}]) {
          groups(ids: ["${targetGroup.id}"]) {
            items_page(limit: ${PAGE_SIZE}) {
              cursor
              items {
                id name
                column_values(ids: ["${COL_DATE}", "${COL_PERSON}", "${COL_STATUS}"]) { id text value }
              }
            }
          }
        } }`;

    const res: any = await runQuery(itemsQuery);
    if (res.errors) {
      console.error('[monday-manager-dashboard] items GraphQL errors:', JSON.stringify(res.errors));
      return new Response(JSON.stringify({ error: 'Monday GraphQL error', details: res.errors }), {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    const page = cursor
      ? res.data?.next_items_page
      : res.data?.boards?.[0]?.groups?.[0]?.items_page;

    if (!page) break;
    items.push(...(page.items ?? []));
    cursor = page.cursor;
    if (!cursor) break;
  }

  console.log(`[monday-manager-dashboard] Fetched ${items.length} items from "${GROUP_TITLE}" (${targetGroup.id})`);

  const triage: ManagerDashboardItem[] = [];
  const review: ManagerDashboardItem[] = [];

  for (const it of items) {
    const dueDate = dueDateOf(it);
    const assigned = isPersonAssigned(colById(it, COL_PERSON));
    const status = statusOf(it);

    // Triage: due date set + no pre-sales engineer assigned
    if (dueDate && !assigned) {
      triage.push({ id: it.id, name: it.name, dueDate });
    }

    // Review: status === "Review" (case-insensitive), carries due date for display
    if (status.toLowerCase() === REVIEW_LABEL) {
      review.push({ id: it.id, name: it.name, dueDate });
    }
  }

  // Review list: closest due date first. Items without a due date sort last.
  review.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  // Triage: also sort by closest due date first — same rationale.
  triage.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // --- Optional debug payload ---
  // When the client passes { debugNameQuery: "rosie" } we include the raw
  // Monday column data for any item whose name contains that substring, plus
  // why our filter accepted/rejected it. Lets us diagnose missing items
  // without blind redeploys.
  const debug = debugNameQuery
    ? items
        .filter((it) => it.name.toLowerCase().includes(debugNameQuery))
        .map((it) => {
          const personCol = colById(it, COL_PERSON);
          const dueDate = dueDateOf(it);
          const assigned = isPersonAssigned(personCol);
          const status = statusOf(it);
          return {
            id: it.id,
            name: it.name,
            dueDate,
            status,
            assigned,
            triageMatch: !!dueDate && !assigned,
            reviewMatch: status.toLowerCase() === REVIEW_LABEL,
            personColumnRaw: { text: personCol?.text ?? null, value: personCol?.value ?? null },
            allReturnedColumns: it.column_values.map((c) => ({ id: c.id, text: c.text, value: c.value })),
          };
        })
    : undefined;

  return new Response(JSON.stringify({
    triage,
    review,
    fetchedAt: new Date().toISOString(),
    totalItemsScanned: items.length,
    ...(debug ? { debug } : {}),
  }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
