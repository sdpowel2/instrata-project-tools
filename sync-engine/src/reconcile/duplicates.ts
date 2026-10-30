/**
 * Duplicate check before the engine creates an item (Seth 2026-10-30). Pure.
 *
 * Old monday items often mirror a deal whose Salesforce record they can't be
 * linked to: entered by hand before the Zaps, or the rep later moved the AV scope
 * to a new opportunity (Cardinal Infrastructure, Oct 29). When that opportunity
 * next changes, the engine would create a second item on Triage. Before creating,
 * it looks for an UNLINKED item on the three pre-sales boards that matches:
 *   salesforce_id  the item's Salesforce ID column already holds this line / opportunity
 *   quote_number   same quote number (case and spaces ignored)
 *   name           same words, or every word of one name is in the other, sharing
 *                  at least two words of which one isn't generic ("conference room")
 */

export interface PoolItem {
  id: string;
  name: string;
  boardKey: string;
  groupId: string | null;
  quote: string | null;
  sfId: string | null;
}

export type MatchReason = 'salesforce_id' | 'quote_number' | 'name';

export interface DuplicateMatch {
  item: PoolItem;
  why: MatchReason;
}

export interface NewDeal {
  opportunityId: string;
  lineItemId: string;
  name: string;
  quote: string | null;
}

/** Filler that says nothing about which project it is. */
const STOP = new Set(['a', 'an', 'the', 'and', 'of', 'at', 'for', 'to', 'in', 'on', 'with', 'av', 'budget', 'budgetary', 'phase', 'base', 'bid', 'inc', 'llc']);
/** Words shared by many unrelated projects: a match needs at least one word that isn't one of these. */
const GENERIC = new Set([
  'room', 'rooms', 'conference', 'office', 'offices', 'building', 'floor', 'new', 'upgrade', 'upgrades', 'refresh', 'display', 'displays',
  'system', 'systems', 'audio', 'video', 'hq', 'center', 'centre', 'suite', 'hall', 'meeting', 'training', 'boardroom', 'classroom',
  'classrooms', 'lobby', 'renovation', 'addition', 'adds', 'add', 'cabling', 'security', 'service', 'services', 'install', 'school',
  'campus', 'st', 'street', 'north', 'south', 'east', 'west', 'level', 'large', 'small', 'main', 'first', 'second', 'third', 'fourth',
]);

const key15 = (id: string) => id.trim().slice(0, 15);

/** Hope's "Possible duplicate" task for an opportunity whose create is held. */
export const possibleDuplicateKey = (opportunityId: string) => `sync_failure:possible_duplicate:${opportunityId}:create`;

export function normalizeQuote(q: string | null): string | null {
  const s = (q ?? '').toLowerCase().replace(/\s+/g, '');
  return s.length >= 5 ? s : null;
}

export function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t !== '' && !STOP.has(t)));
}

/** 0 = no match; otherwise the share of words in common (higher = closer). */
export function nameScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter((t) => b.has(t));
  const same = shared.length === a.size && shared.length === b.size;
  const contained = shared.length === Math.min(a.size, b.size);
  if (!same && !(contained && shared.length >= 2)) return 0;
  if (!shared.some((t) => !GENERIC.has(t))) return 0;
  return shared.length / new Set([...a, ...b]).size;
}

const RANK: Record<MatchReason, number> = { salesforce_id: 0, quote_number: 1, name: 2 };

/** Candidates, strongest first. `pool` must already exclude linked and set-aside items. */
export function findDuplicates(deal: NewDeal, pool: PoolItem[]): DuplicateMatch[] {
  const quote = normalizeQuote(deal.quote);
  const tokens = nameTokens(deal.name);
  const ids = new Set([key15(deal.lineItemId), key15(deal.opportunityId)]);
  const scored: { m: DuplicateMatch; score: number }[] = [];
  for (const item of pool) {
    const sf = (item.sfId ?? '').trim();
    if (sf !== '' && ids.has(key15(sf))) {
      scored.push({ m: { item, why: 'salesforce_id' }, score: 1 });
      continue;
    }
    if (quote && normalizeQuote(item.quote) === quote) {
      scored.push({ m: { item, why: 'quote_number' }, score: 1 });
      continue;
    }
    const s = nameScore(tokens, nameTokens(item.name));
    if (s > 0) scored.push({ m: { item, why: 'name' }, score: s });
  }
  return scored
    .sort((x, y) => RANK[x.m.why] - RANK[y.m.why] || y.score - x.score || (BigInt(y.m.item.id) > BigInt(x.m.item.id) ? 1 : -1))
    .map((s) => s.m);
}
