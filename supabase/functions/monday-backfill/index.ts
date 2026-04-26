// One-shot backfill: walk both Monday boards, assign Project IDs to any items
// missing them (writing the new ID back to Monday's Project ID column), then
// upsert/link Supabase project rows so phase, status, and the two Monday item
// IDs all reflect what's currently in Monday.
//
// Run this once after deploying the project_code migration. It's idempotent —
// safe to re-run; only items missing a Project ID will get a new code, and
// the Supabase upsert won't duplicate rows.
//
// Auth: caller must be an authenticated admin (profile.role === 'admin').
//
// Returns a summary: { projectsLinked, codesAssignedOnMonday, presalesCount,
// postsalesCount, errors }.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Monday board / column wiring ────────────────────────────────────────────
const PRESALES_BOARD_ID  = 3477536693;
const POSTSALES_BOARD_ID = 3523133226;
const STATUS_COLUMN_ID   = 'status9';            // same id on both boards
const PRESALES_PROJECT_ID_COL  = 'text_mm2rcnav';
const POSTSALES_PROJECT_ID_COL = 'text_mm2rsn';

const MONDAY_API = 'https://api.monday.com/v2';
const PAGE_SIZE = 200;
const MAX_PAGES = 50; // hard safety cap → 10k items per board

// Only items in these Monday statuses get pulled into Project Tools.
// Everything else stays untouched in Monday (sales dashboards, history, etc.)
// — but we don't track them here. Re-bids / status flips into an active state
// are picked up later by the webhook on demand.
const ACTIVE_PRESALES_STATUSES = new Set([
  'Not Started', 'In Progress', 'On Hold', 'Review', 'Follow Up', 'Rebid',
]);
const ACTIVE_POSTSALES_STATUSES = new Set([
  'Won', 'Not Started', 'In Progress', 'Install', 'Close Out',
]);

// ── Types ───────────────────────────────────────────────────────────────────
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

interface NormalizedItem {
  itemId: number;
  name: string;
  projectCode: string;     // empty string if not yet assigned
  status: string;          // raw Monday text label, may need normalization
}

interface BackfillSummary {
  projectsLinked: number;
  codesAssignedOnMonday: number;
  /** In dry-run: how many codes WOULD be assigned. */
  codesWouldAssign: number;
  presalesTotalOnBoard: number;
  postsalesTotalOnBoard: number;
  presalesActive: number;
  postsalesActive: number;
  presalesSkippedByStatus: number;
  postsalesSkippedByStatus: number;
  /** Post-sales items that found a pre-sales sibling via exact name match. */
  postsalesMatchedExact: number;
  /** Post-sales items that found a pre-sales sibling via fuzzy token match. */
  postsalesMatchedFuzzy: number;
  /** Post-sales items with no pre-sales sibling — get a fresh code. */
  postsalesUnmatched: number;
  /** Items whose existing Monday code is a duplicate of another item's code —
   *  cleared and regenerated. Recovers from the race in the original
   *  generate_project_code function. */
  duplicateCodesCleared: number;
  duplicatedAcrossBoards: number;
  errors: string[];
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Some Monday status labels need light normalization to match the app's union
// type (e.g. "ON HOLD" → "On Hold"). Add to this map as new edge cases appear.
function normalizeStatus(raw: string): string {
  const s = raw.trim();
  if (!s) return 'Not Started';
  const lower = s.toLowerCase();
  if (lower === 'on hold') return 'On Hold';
  return s;
}

// Tokenize a project name into lowercase alphanumeric words. Punctuation,
// percent signs, hyphens, and other separators all become whitespace so e.g.
// "GMP - 80%CD" tokenizes to ["gmp", "80", "cd"] and "GMP - CD" tokenizes to
// ["gmp", "cd"] — letting Jaccard pick up the near-match.
function tokenize(name: string): Set<string> {
  return new Set(
    name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 0)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Threshold: 70% token overlap + at least 3 shared tokens. Combination keeps
// short generic names ("ABC Project" vs "ABC Project Phase 2") from matching
// while still catching "GMP - CD" ↔ "GMP - 80%CD" type drops.
const FUZZY_JACCARD_THRESHOLD = 0.7;
const FUZZY_MIN_SHARED_TOKENS = 3;

function colById(item: MondayItem, id: string): MondayColumnValue | undefined {
  return item.column_values.find((c) => c.id === id);
}

async function mondayQuery(token: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  // Retry loop for COMPLEXITY_BUDGET_EXHAUSTED (Monday's per-minute rate limit).
  // Monday tells us how long to wait via the retry_in_seconds field on the
  // error extensions; honor that, plus a small jitter to avoid thundering-herd
  // when many parallel workers hit the limit simultaneously.
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'API-Version': '2024-10',
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!json.errors) return json;

    const rateLimitErr = (json.errors as Array<any>).find((e) =>
      e?.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED'
      || e?.extensions?.status_code === 429,
    );
    if (rateLimitErr && attempt < MAX_RETRIES) {
      const waitSec = Math.max(1, Number(rateLimitErr.extensions?.retry_in_seconds) || 30);
      const jitter = Math.random() * 2; // up to +2s spread
      const waitMs = (waitSec + jitter) * 1000;
      console.log(`[monday-backfill] Rate limited; sleeping ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Monday GraphQL: ${JSON.stringify(json.errors)}`);
  }
  throw new Error('Monday GraphQL: retries exhausted');
}

// Pages through every item on a board, returning the normalized projection
// we need (id, name, project_code text, status text).
async function fetchBoardItems(
  token: string,
  boardId: number,
  projectIdColumn: string,
): Promise<NormalizedItem[]> {
  const out: NormalizedItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const itemsBlock = `items {
      id name
      column_values(ids: ["${projectIdColumn}", "${STATUS_COLUMN_ID}"]) { id text value }
    }`;

    const query: string = cursor
      ? `query { next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") { cursor ${itemsBlock} } }`
      : `query { boards(ids: [${boardId}]) {
            items_page(limit: ${PAGE_SIZE}) { cursor ${itemsBlock} }
          } }`;

    const res = await mondayQuery(token, query);
    const pageData = cursor
      ? res.data?.next_items_page
      : res.data?.boards?.[0]?.items_page;
    if (!pageData) break;

    for (const it of (pageData.items as MondayItem[] | undefined) ?? []) {
      const code = colById(it, projectIdColumn)?.text?.trim() ?? '';
      const status = colById(it, STATUS_COLUMN_ID)?.text?.trim() ?? '';
      out.push({
        itemId: Number(it.id),
        name: it.name,
        projectCode: code,
        status,
      });
    }

    cursor = pageData.cursor;
    if (!cursor) break;
  }

  return out;
}

// Writes a project_code value back to Monday's Project ID text column.
async function writeProjectCode(
  token: string,
  boardId: number,
  itemId: number,
  columnId: string,
  code: string,
): Promise<void> {
  // change_simple_column_value handles plain text columns and avoids JSON
  // escaping headaches that change_column_value would introduce.
  const query = `mutation {
    change_simple_column_value(
      board_id: ${boardId},
      item_id: ${itemId},
      column_id: "${columnId}",
      value: "${code}"
    ) { id }
  }`;
  await mondayQuery(token, query);
}

// Confirm the caller is an admin via the JWT in the Authorization header.
async function requireAdmin(supabase: SupabaseClient, jwt: string): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return { ok: false, reason: 'Invalid auth token' };
  }
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (profileErr || !profile) return { ok: false, reason: 'Profile not found' };
  if (profile.role !== 'admin') return { ok: false, reason: 'Admin role required' };
  return { ok: true, userId: userData.user.id };
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

  const mondayToken = Deno.env.get('MONDAY_API_TOKEN');
  if (!mondayToken) {
    return new Response(JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase    = createClient(supabaseUrl, serviceKey);

  // Admin gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
  const auth = await requireAdmin(supabase, jwt);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: 403, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Optional flags:
  //   dryRun:     simulate everything, write nothing
  //   forceClear: wipe every project_code on both boards' active items before
  //               running, so the atomic generator builds the full set from
  //               scratch. Use this to recover from a corrupted state where
  //               race-leftover duplicate codes are causing false sibling
  //               matches in the merge step.
  let dryRun = false;
  let forceClear = false;
  try {
    const body = await req.json();
    if (body?.dryRun === true) dryRun = true;
    if (body?.forceClear === true) forceClear = true;
  } catch { /* empty body OK */ }

  const summary: BackfillSummary = {
    projectsLinked: 0,
    codesAssignedOnMonday: 0,
    codesWouldAssign: 0,
    presalesTotalOnBoard: 0,
    postsalesTotalOnBoard: 0,
    presalesActive: 0,
    postsalesActive: 0,
    presalesSkippedByStatus: 0,
    postsalesSkippedByStatus: 0,
    postsalesMatchedExact: 0,
    postsalesMatchedFuzzy: 0,
    postsalesUnmatched: 0,
    duplicateCodesCleared: 0,
    duplicatedAcrossBoards: 0,
    errors: [],
  };

  // Diagnostic surface for dry-run: track which post-sales items did/didn't
  // match a pre-sales sibling so the user can spot naming-variant duplicates
  // before the real run.
  const unmatchedPostsales: Array<{ itemId: number; name: string; status: string }> = [];
  const matchedPostsales: Array<{ postsalesItemId: number; postsalesName: string; presalesItemId: number; presalesName: string; presalesStatus: string; matchType: 'exact' | 'fuzzy'; score?: number }> = [];

  try {
    // ── Step 1: Pull every item from both boards ─────────────────────────────
    const [presalesAll, postsalesAll] = await Promise.all([
      fetchBoardItems(mondayToken, PRESALES_BOARD_ID, PRESALES_PROJECT_ID_COL),
      fetchBoardItems(mondayToken, POSTSALES_BOARD_ID, POSTSALES_PROJECT_ID_COL),
    ]);
    summary.presalesTotalOnBoard  = presalesAll.length;
    summary.postsalesTotalOnBoard = postsalesAll.length;

    // ── Step 1b: Filter to active statuses only ──────────────────────────────
    // Monday stays the system of record for all items including Lost / old
    // Wons / Completed; Project Tools tracks only the active working set.
    // Re-bids and revivals get picked up by the webhook when status flips.
    //
    // Important: post-sales items are duplicates of pre-sales WON items per
    // the Monday automation, so we keep the FULL pre-sales list available for
    // name-matching even though only the active subset gets synced.
    const presalesItems = presalesAll.filter((it) => {
      const s = normalizeStatus(it.status);
      const keep = ACTIVE_PRESALES_STATUSES.has(s);
      if (!keep) summary.presalesSkippedByStatus++;
      return keep;
    });
    const postsalesItems = postsalesAll.filter((it) => {
      const s = normalizeStatus(it.status);
      const keep = ACTIVE_POSTSALES_STATUSES.has(s);
      if (!keep) summary.postsalesSkippedByStatus++;
      return keep;
    });
    summary.presalesActive  = presalesItems.length;
    summary.postsalesActive = postsalesItems.length;

    // ── Step 1b.5: Detect + clear duplicate codes on Monday ────────────────
    // The original generate_project_code function had a race that produced
    // many-to-many duplicate codes across both boards. We now do strict
    // uniqueness enforcement: any code that appears more than once anywhere
    // (either board, any status) — keep the first occurrence, clear the rest
    // from Monday. After clearing, the assignment phase re-matches by name
    // and re-links legitimate pre-sales/post-sales siblings.
    //
    // We sweep ALL items (presalesAll + postsalesAll), not just the active
    // subset, because race-leftover codes can sit on Won/Lost items and still
    // poison the merge step via post-sales code inheritance.
    {
      const allPresalesIds = new Set(presalesAll.map((i) => i.itemId));
      const isPresalesItem = (it: NormalizedItem) => allPresalesIds.has(it.itemId);

      const codeFirstOwner = new Map<string, NormalizedItem>();
      const toClear: Array<{ item: NormalizedItem; isPre: boolean }> = [];

      for (const item of [...presalesAll, ...postsalesAll]) {
        if (!item.projectCode) continue;
        const existing = codeFirstOwner.get(item.projectCode);
        if (!existing) {
          codeFirstOwner.set(item.projectCode, item);
          continue;
        }
        // Any duplicate — same board or cross-board — gets cleared. The
        // legitimate sibling case (pre-sales Won → post-sales overlay) is
        // re-established by name-matching in the next step.
        toClear.push({ item, isPre: isPresalesItem(item) });
      }

      if (toClear.length > 0) {
        const clearTasks = toClear.map(({ item, isPre }) => async () => {
          const board = isPre ? PRESALES_BOARD_ID : POSTSALES_BOARD_ID;
          const col   = isPre ? PRESALES_PROJECT_ID_COL : POSTSALES_PROJECT_ID_COL;
          if (!dryRun) {
            try {
              await writeProjectCode(mondayToken!, board, item.itemId, col, '');
            } catch (err) {
              summary.errors.push(`clearProjectCode failed for item ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
          }
          item.projectCode = '';
          summary.duplicateCodesCleared++;
        });

        await (async () => {
          let i = 0;
          const workers = Array.from({ length: Math.min(3, clearTasks.length) }, async () => {
            while (i < clearTasks.length) {
              const idx = i++;
              try { await clearTasks[idx](); } catch { /* errors recorded inside */ }
            }
          });
          await Promise.all(workers);
        })();

        console.log(`[monday-backfill] Cleared ${summary.duplicateCodesCleared} duplicate code assignments on Monday.`);
      }
    }

    // ── Step 1c: Seed the code counter from any codes already on Monday ──────
    // Earlier (failed) backfill runs may have written codes to Monday that
    // never landed in Supabase due to the race in the old generate function.
    // Bump the DB counter past the highest existing Monday code so we don't
    // regenerate values that already exist on the Monday side.
    if (!dryRun) {
      const currentYear = new Date().getFullYear();
      const codeRe = new RegExp(`^INST-${currentYear}-(\\d+)$`);
      let maxSeq = 0;
      for (const item of [...presalesAll, ...postsalesAll]) {
        const m = codeRe.exec(item.projectCode);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
        }
      }
      if (maxSeq > 0) {
        const { error } = await supabase.rpc('seed_project_code_counter', {
          p_year: currentYear,
          p_min_seq: maxSeq,
        });
        if (error) {
          summary.errors.push(`seed_project_code_counter failed: ${error.message}`);
        } else {
          console.log(`[monday-backfill] Seeded counter for ${currentYear} to >= ${maxSeq}`);
        }
      }
    }

    // ── Step 2: Assign Project IDs to items that don't have one ──────────────
    // Strategy:
    //   1. Build a name index from the FULL pre-sales list (every status,
    //      including Won) so post-sales items can find their sibling.
    //   2. For each post-sales item missing a code, look up the pre-sales
    //      sibling by name. If found and it has a code, inherit. If found and
    //      it doesn't have one, generate ONE shared code and write it to both.
    //      No sibling → generate a fresh code for post-sales only.
    //   3. For each active pre-sales item missing a code, generate one and
    //      write it back.
    //
    // Codes are written to Monday with a small concurrency cap (8) to fit
    // within the edge function's ~150s timeout while staying well under
    // Monday's API rate limits.
    //
    // Dry-run uses synthetic placeholder codes (visibly distinct) so the merge
    // map populates and the sample output reflects what the real run would do.
    const synthetic = (prefix: 'pre' | 'post', itemId: number) => `(WOULD-ASSIGN-${prefix}-${itemId})`;
    const isSynthetic = (code: string) => code.startsWith('(WOULD-ASSIGN-');
    // Concurrency capped low because each Monday mutation costs ~30k complexity
    // and the per-minute budget is 10M (~333 mutations/min). Higher concurrency
    // bursts the budget and triggers 429s; lower keeps a steady drip.
    const CONCURRENCY = 3;

    // Index ALL pre-sales items (regardless of active filter) so post-sales
    // items can find their Won sibling. Indexed by trimmed lowercase name.
    const presalesByName = new Map<string, NormalizedItem>();
    // Parallel index of token sets for fuzzy fallback when exact match fails.
    const presalesTokens: Array<{ item: NormalizedItem; tokens: Set<string> }> = [];
    for (const item of presalesAll) {
      const key = item.name.trim().toLowerCase();
      if (!presalesByName.has(key)) presalesByName.set(key, item);
      presalesTokens.push({ item, tokens: tokenize(item.name) });
    }

    // Find the best fuzzy match for a post-sales item against ALL pre-sales
    // items. Returns null if no candidate clears the threshold.
    function findFuzzyMatch(name: string): { item: NormalizedItem; score: number } | null {
      const target = tokenize(name);
      if (target.size < FUZZY_MIN_SHARED_TOKENS) return null;
      let best: { item: NormalizedItem; score: number } | null = null;
      for (const candidate of presalesTokens) {
        const score = jaccardSimilarity(target, candidate.tokens);
        if (score < FUZZY_JACCARD_THRESHOLD) continue;
        // Count actual shared tokens to enforce the minimum overlap floor.
        let shared = 0;
        for (const t of target) if (candidate.tokens.has(t)) shared++;
        if (shared < FUZZY_MIN_SHARED_TOKENS) continue;
        if (!best || score > best.score) best = { item: candidate.item, score };
      }
      return best;
    }

    // Helper: generate a fresh code via SQL function. Real-run only; dry-run
    // callers handle their own placeholder.
    async function nextCode(): Promise<string | null> {
      const { data, error } = await supabase.rpc('generate_project_code');
      if (error || !data) return null;
      return String(data);
    }

    // Helper: run an array of async tasks with bounded concurrency.
    async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<void> {
      let i = 0;
      const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (i < tasks.length) {
          const idx = i++;
          try { await tasks[idx](); }
          catch { /* errors are pushed to summary inside the task */ }
        }
      });
      await Promise.all(workers);
    }

    // Build the queue of code-assignment tasks.
    const tasks: Array<() => Promise<void>> = [];

    // Post-sales first so we can short-circuit pre-sales siblings (they may
    // share a generated code).
    for (const item of postsalesItems) {
      if (item.projectCode) continue;
      tasks.push(async () => {
        // 1. Try exact name match first (cheap).
        let sibling = presalesByName.get(item.name.trim().toLowerCase()) ?? null;
        let matchType: 'exact' | 'fuzzy' | 'none' = sibling ? 'exact' : 'none';
        let fuzzyScore: number | undefined;

        // 2. Fall back to fuzzy token matching for items with minor name drift
        //    (e.g. "GMP - 80%CD Drawing Set" vs "GMP - CD Drawing Set").
        if (!sibling) {
          const fuzzy = findFuzzyMatch(item.name);
          if (fuzzy) {
            sibling = fuzzy.item;
            matchType = 'fuzzy';
            fuzzyScore = fuzzy.score;
          }
        }

        if (sibling) {
          if (matchType === 'exact') summary.postsalesMatchedExact++;
          else summary.postsalesMatchedFuzzy++;
          if (dryRun) {
            matchedPostsales.push({
              postsalesItemId: item.itemId,
              postsalesName: item.name,
              presalesItemId: sibling.itemId,
              presalesName: sibling.name,
              presalesStatus: sibling.status,
              matchType,
              ...(fuzzyScore !== undefined ? { score: Math.round(fuzzyScore * 100) / 100 } : {}),
            });
          }
        } else {
          summary.postsalesUnmatched++;
          if (dryRun) {
            unmatchedPostsales.push({
              itemId: item.itemId,
              name: item.name,
              status: item.status,
            });
          }
        }

        if (sibling?.projectCode) {
          // Sibling already has a real code (assigned in a previous run) —
          // just write the inheritance to post-sales.
          item.projectCode = sibling.projectCode;
          if (dryRun) { summary.codesWouldAssign++; return; }
          try {
            await writeProjectCode(mondayToken!, POSTSALES_BOARD_ID, item.itemId, POSTSALES_PROJECT_ID_COL, sibling.projectCode);
            summary.codesAssignedOnMonday++;
          } catch (err) {
            summary.errors.push(`writeProjectCode (inherit) failed for post-sales item ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        if (dryRun) {
          // Synthetic shared code so both sides land in the merged map.
          const synth = sibling ? synthetic('pre', sibling.itemId) : synthetic('post', item.itemId);
          item.projectCode = synth;
          if (sibling) sibling.projectCode = synth;
          summary.codesWouldAssign += sibling ? 2 : 1;
          return;
        }

        const code = await nextCode();
        if (!code) {
          summary.errors.push(`generate_project_code failed for post-sales item ${item.itemId}`);
          return;
        }
        try {
          await writeProjectCode(mondayToken!, POSTSALES_BOARD_ID, item.itemId, POSTSALES_PROJECT_ID_COL, code);
          item.projectCode = code;
          summary.codesAssignedOnMonday++;
        } catch (err) {
          summary.errors.push(`writeProjectCode failed for post-sales item ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (sibling && !sibling.projectCode) {
          // Persist the same code on the pre-sales sibling so the link is
          // captured in Monday for future reference.
          try {
            await writeProjectCode(mondayToken!, PRESALES_BOARD_ID, sibling.itemId, PRESALES_PROJECT_ID_COL, code);
            sibling.projectCode = code;
            summary.codesAssignedOnMonday++;
          } catch (err) {
            summary.errors.push(`writeProjectCode (sibling) failed for pre-sales item ${sibling.itemId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    }

    // Active pre-sales items still missing codes (no post-sales sibling
    // claimed them in the loop above).
    for (const item of presalesItems) {
      if (item.projectCode) continue;
      tasks.push(async () => {
        if (item.projectCode) return; // may have been set by post-sales pass
        if (dryRun) {
          item.projectCode = synthetic('pre', item.itemId);
          summary.codesWouldAssign++;
          return;
        }
        const code = await nextCode();
        if (!code) {
          summary.errors.push(`generate_project_code failed for pre-sales item ${item.itemId}`);
          return;
        }
        try {
          await writeProjectCode(mondayToken!, PRESALES_BOARD_ID, item.itemId, PRESALES_PROJECT_ID_COL, code);
          item.projectCode = code;
          summary.codesAssignedOnMonday++;
        } catch (err) {
          summary.errors.push(`writeProjectCode failed for pre-sales item ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    await runBounded(tasks, CONCURRENCY);

    // ── Step 3: Reconcile to one row per project_code in Supabase ────────────
    // Phase = Post-Sales if the project exists on the post-sales board (the
    // Monday automation duplicates Won items to post-sales, so post-sales
    // presence is the canonical "delivery phase started" signal).
    interface MergedProject {
      projectCode: string;
      name: string;
      status: string;
      phase: 'Pre-Sales' | 'Post-Sales';
      presalesItemId?: number;
      postsalesItemId?: number;
    }

    const merged = new Map<string, MergedProject>();

    for (const item of presalesItems) {
      if (!item.projectCode) continue;
      merged.set(item.projectCode, {
        projectCode: item.projectCode,
        name: item.name,
        status: normalizeStatus(item.status),
        phase: 'Pre-Sales',
        presalesItemId: item.itemId,
      });
    }

    for (const item of postsalesItems) {
      if (!item.projectCode) continue;
      const existing = merged.get(item.projectCode);
      if (existing) {
        // Project lives on both boards — phase flips to Post-Sales, status
        // overrides with the post-sales board (more current state).
        existing.phase = 'Post-Sales';
        existing.status = normalizeStatus(item.status);
        existing.postsalesItemId = item.itemId;
        summary.duplicatedAcrossBoards++;
      } else {
        merged.set(item.projectCode, {
          projectCode: item.projectCode,
          name: item.name,
          status: normalizeStatus(item.status),
          phase: 'Post-Sales',
          postsalesItemId: item.itemId,
        });
      }
    }

    if (dryRun) {
      // Mix the sample so the user sees both Pre-Sales and Post-Sales rows.
      const all = Array.from(merged.values());
      const pre  = all.filter((p) => p.phase === 'Pre-Sales').slice(0, 5);
      const post = all.filter((p) => p.phase === 'Post-Sales').slice(0, 5);
      return new Response(JSON.stringify({
        dryRun: true,
        summary,
        wouldLink: merged.size,
        sample: [...pre, ...post],
        unmatchedPostsales,
        // Surface fuzzy matches separately so the user can review the lower-
        // confidence ones before committing.
        fuzzyMatches: matchedPostsales.filter((m) => m.matchType === 'fuzzy'),
        exactMatchesSample: matchedPostsales.filter((m) => m.matchType === 'exact').slice(0, 5),
      }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
    }

    // In a real run, dry-run-only synthetic codes shouldn't appear, but guard
    // anyway so we never write a placeholder to Supabase.
    for (const code of merged.keys()) {
      if (isSynthetic(code)) {
        summary.errors.push(`Skipping synthetic code in real run: ${code}`);
        merged.delete(code);
      }
    }

    // ── Step 4: Bulk upsert into Supabase ────────────────────────────────────
    // Postgres INSERT ... ON CONFLICT (project_code) DO UPDATE handles both
    // the "row already exists" and "new row" cases atomically in a single
    // query. Chunked at 100 rows so we don't blow past Postgres' parameter
    // limit on very large boards.
    //
    // Note: this replaces the prior per-row select-then-insert-or-update loop
    // which timed out the function before reaching the post-sales overlay
    // entries (they're scattered through merged.values() iteration order, so
    // a partial run silently dropped them).
    const rows = Array.from(merged.values()).map((proj) => ({
      name: proj.name,
      status: proj.status,
      phase: proj.phase,
      project_code: proj.projectCode,
      monday_presales_item_id: proj.presalesItemId ?? null,
      monday_postsales_item_id: proj.postsalesItemId ?? null,
    }));

    // Diagnostic: count what we're about to send so we can see if the merge
    // produced the expected phase distribution before upsert.
    const rowsByPhase = {
      'Pre-Sales':  rows.filter((r) => r.phase === 'Pre-Sales').length,
      'Post-Sales': rows.filter((r) => r.phase === 'Post-Sales').length,
    };
    const samplePostSalesRows = rows.filter((r) => r.phase === 'Post-Sales').slice(0, 3);
    console.log('[monday-backfill] About to upsert:', JSON.stringify({ rowsByPhase, samplePostSalesRows }));

    const CHUNK_SIZE = 100;
    let upsertSucceeded = 0;
    let upsertFailed = 0;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { error: upsertErr } = await supabase
        .from('projects')
        .upsert(chunk, { onConflict: 'project_code' });
      if (upsertErr) {
        summary.errors.push(`upsert chunk ${i / CHUNK_SIZE}: ${upsertErr.message}`);
        upsertFailed += chunk.length;
      } else {
        upsertSucceeded += chunk.length;
        summary.projectsLinked += chunk.length;
      }
    }

    // Verify post-upsert what's actually in the table.
    const { count: postSalesInDb } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('phase', 'Post-Sales')
      .not('project_code', 'is', null);
    const { count: preSalesInDb } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('phase', 'Pre-Sales')
      .not('project_code', 'is', null);

    console.log('[monday-backfill] Summary:', JSON.stringify(summary));
    return new Response(JSON.stringify({
      ok: true,
      summary,
      diagnostics: {
        rowsByPhase,
        samplePostSalesRows,
        upsertSucceeded,
        upsertFailed,
        postSalesInDb: postSalesInDb ?? null,
        preSalesInDb:  preSalesInDb ?? null,
      },
    }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[monday-backfill] Fatal:', err);
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      summary,
    }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
});
