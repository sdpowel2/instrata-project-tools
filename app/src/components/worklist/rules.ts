// Tuning rules (My Day 2.2): labels, the draft form's defaults, and a twin of
// the database matcher (triage_rule_matches() in
// supabase/migrations/add_triage_rules.sql). Live mode always matches in the
// database; the twin here only powers sample mode's preview. Keep them in sync.

import type { ReviewedOutcome, ReviewedRow, RuleEffect, RuleMatch, TriageRule } from './types';

export const EFFECT_LABEL: Record<RuleEffect, string> = {
  min_task: 'Always put it on the list',
  min_read_me: 'At least a Read me line',
  max_read_me: 'Read me at most (never a task)',
  suppress: 'Set it aside',
};

export const EFFECT_SHORT: Record<RuleEffect, string> = {
  min_task: 'On the list',
  min_read_me: 'Read me+',
  max_read_me: 'Read me max',
  suppress: 'Set aside',
};

export const OUTCOME_LABEL: Record<ReviewedOutcome, string> = {
  respond: 'Respond',
  do: 'Do',
  decide: 'Decide',
  carried: 'Carried',
  read_me: 'Read me',
  set_aside: 'Set aside',
  dropped: 'Dropped',
};

// ── Database shape (snake_case jsonb) ↔ app shape ────────────────────────────
export interface DbMatch {
  source?: RuleMatch['source'];
  sender?: string;
  domain?: string;
  subject_terms?: string[];
  channel?: string;
}

export function toDbMatch(m: RuleMatch): DbMatch {
  const out: DbMatch = {};
  if (m.source) out.source = m.source;
  if (m.sender?.trim()) out.sender = m.sender.trim().toLowerCase();
  if (m.domain?.trim()) out.domain = m.domain.trim().toLowerCase().replace(/^@/, '');
  const terms = (m.subjectTerms ?? []).map((t) => t.trim()).filter(Boolean);
  if (terms.length) out.subject_terms = terms;
  if (m.channel?.trim()) out.channel = m.channel.trim();
  return out;
}

export function fromDbMatch(m: DbMatch | null | undefined): RuleMatch | null {
  if (!m) return null;
  return { source: m.source, sender: m.sender, domain: m.domain, subjectTerms: m.subject_terms, channel: m.channel };
}

// ── Validation (twin of triage_match_valid) ──────────────────────────────────
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Why a match can't be saved as a hard rule, or null when it's fine. */
export function matchProblem(m: RuleMatch): string | null {
  const d = toDbMatch(m);
  if (!d.sender && !d.domain && !d.subject_terms && !d.channel) {
    return 'Pick at least one of sender, domain, subject words, or chat / board.';
  }
  if (d.domain && !DOMAIN_RE.test(d.domain)) return 'The domain should look like "example.com".';
  if (d.subject_terms && d.subject_terms.length > 6) return 'Use at most 6 subject words.';
  if (d.subject_terms?.some((t) => t.length < 2 || t.length > 60)) return 'Subject words must be 2–60 characters.';
  return null;
}

// ── Matching (twin of triage_rule_matches) ───────────────────────────────────
export function ruleMatches(m: RuleMatch, row: Pick<ReviewedRow, 'source' | 'sender' | 'title' | 'channel'>): boolean {
  if (matchProblem(m)) return false;
  const d = toDbMatch(m);
  const sender = (row.sender ?? '').trim().toLowerCase();
  const domain = sender.includes('@') ? sender.split('@')[1] : '';
  if (d.source && d.source !== row.source) return false;
  if (d.sender && (!sender || sender !== d.sender)) return false;
  if (d.domain && !(domain === d.domain || domain.endsWith(`.${d.domain}`))) return false;
  const title = row.title.toLowerCase();
  if (d.subject_terms && !d.subject_terms.every((t) => title.includes(t.toLowerCase()))) return false;
  if (d.channel && !(row.channel ?? '').toLowerCase().includes(d.channel.toLowerCase())) return false;
  return true;
}

const OUTCOME_RANK: Record<ReviewedOutcome, number> = {
  respond: 3, do: 3, decide: 3, carried: 3, read_me: 2, set_aside: 1, dropped: 0,
};

/** Would this effect move a conversation that landed here? (twin of triage_effect_broken) */
export function effectChanges(effect: RuleEffect, outcome: ReviewedOutcome): boolean {
  if (effect === 'min_task') return OUTCOME_RANK[outcome] < 3;
  if (effect === 'min_read_me') return OUTCOME_RANK[outcome] < 2;
  if (effect === 'max_read_me') return OUTCOME_RANK[outcome] >= 3;
  return ['respond', 'do', 'decide', 'read_me'].includes(outcome);
}

// ── Wording ──────────────────────────────────────────────────────────────────
const SOURCE_WORD = { email: 'Email', teams: 'Teams', monday: 'monday' } as const;

/** "Email · from dana@gc.com · subject has "lobby"" */
export function describeMatch(m: RuleMatch | null): string {
  if (!m) return 'No match (lesson only)';
  const d = toDbMatch(m);
  const parts: string[] = [];
  if (d.source) parts.push(SOURCE_WORD[d.source]);
  if (d.sender) parts.push(`from ${d.sender}`);
  if (d.domain) parts.push(`from anyone at ${d.domain}`);
  if (d.subject_terms) parts.push(`subject has ${d.subject_terms.map((t) => `"${t}"`).join(' + ')}`);
  if (d.channel) parts.push(`${d.source === 'monday' ? 'board' : 'chat'} contains "${d.channel}"`);
  return parts.join(' · ') || 'No match';
}

// ── Draft form defaults ──────────────────────────────────────────────────────
const STOP = new Set([
  're', 'fw', 'fwd', 'the', 'and', 'for', 'with', 'from', 'your', 'you', 'our', 'this', 'that', 'about',
  'quick', 'question', 'update', 'updates', 'request', 'please', 'today', 'tomorrow', 'week', 'new',
  'automatic', 'reply', 'external', 'meeting', 'call', 'follow', 'need', 'needs',
]);

/** Up to two words from a subject that would make a reasonable match. */
export function subjectWords(title: string): string[] {
  const words = title.toLowerCase().match(/[a-z0-9][a-z0-9&'-]*/g) ?? [];
  const picked: string[] = [];
  for (const w of words) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || picked.includes(w)) continue;
    picked.push(w);
    if (picked.length === 2) break;
  }
  return picked;
}

export type Direction = 'more' | 'less';

/** What the rule form can turn on, and what it starts with checked. */
export interface MatchSeed {
  /** Every field the example offers. */
  offer: RuleMatch;
  /** Which of them start checked. */
  on: Record<keyof RuleMatch, boolean>;
}

export function seedFromRow(row: Pick<ReviewedRow, 'source' | 'sender' | 'title' | 'channel'> | null): MatchSeed {
  const sender = row?.sender?.trim().toLowerCase();
  const domain = sender?.includes('@') ? sender.split('@')[1] : undefined;
  const offer: RuleMatch = {
    source: row?.source,
    sender: sender || undefined,
    domain,
    subjectTerms: row ? subjectWords(row.title) : [],
    channel: row?.channel || undefined,
  };
  // Narrowest useful default: the exact sender, else the chat/board, else the subject words.
  const on = {
    source: !!row,
    sender: !!offer.sender,
    domain: false,
    subjectTerms: !offer.sender && !offer.channel && (offer.subjectTerms?.length ?? 0) > 0,
    channel: !offer.sender && !!offer.channel,
  };
  return { offer, on };
}

export function seedFromRule(rule: TriageRule): MatchSeed {
  const m = rule.match ?? {};
  return {
    offer: { ...m, subjectTerms: m.subjectTerms ?? [] },
    on: {
      source: !!m.source,
      sender: !!m.sender,
      domain: !!m.domain,
      subjectTerms: (m.subjectTerms?.length ?? 0) > 0,
      channel: !!m.channel,
    },
  };
}

/** The checked fields of a form, as a match. */
export function pickMatch(fields: RuleMatch, on: Record<keyof RuleMatch, boolean>): RuleMatch {
  return {
    source: on.source ? fields.source : undefined,
    sender: on.sender ? fields.sender : undefined,
    domain: on.domain ? fields.domain : undefined,
    subjectTerms: on.subjectTerms ? fields.subjectTerms : undefined,
    channel: on.channel ? fields.channel : undefined,
  };
}
