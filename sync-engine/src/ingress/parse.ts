/**
 * Inbound webhook parsing. Pure — tested by test/ingress.test.mts.
 *
 * Thin events, fat fetch (spec §1): we only pull IDs out of payloads. Everything
 * else is re-read from the source system when the event is processed, so the
 * raw payload is stored for debugging and rework analysis, never trusted.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sha256(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export interface SalesforceEvent {
  object: string;
  recordId: string | null;
  opportunityId: string;
}

/** The Flow body: {"object":"Opportunity","record_id":"006…","opportunity_id":"006…"}. */
export function parseSalesforceEvent(body: unknown): SalesforceEvent | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const opp = typeof b.opportunity_id === 'string' ? b.opportunity_id.trim() : '';
  if (!SF_ID.test(opp)) return null;
  const rec = typeof b.record_id === 'string' && SF_ID.test(b.record_id.trim()) ? b.record_id.trim() : null;
  return { object: typeof b.object === 'string' ? b.object : 'unknown', recordId: rec, opportunityId: opp };
}

/**
 * Bursts of saves on one opportunity (a rep editing several fields) collapse
 * into one inbox row per 10-second window. Reconcile is idempotent, so this
 * only saves work.
 */
export function salesforceDedupeHash(e: SalesforceEvent, now: Date): string {
  return sha256('salesforce', e.opportunityId, String(Math.floor(now.getTime() / 10_000)));
}

export interface MondayEvent {
  type: string;
  boardId: string;
  itemId: string | null;
  columnId: string | null;
  userId: string | null;
  groupId: string | null;
  triggerUuid: string | null;
  value: unknown;
  previousValue: unknown;
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** monday native webhook payload: {"event": {type, boardId, pulseId, columnId, userId, value, previousValue, triggerUuid, …}}. */
export function parseMondayEvent(body: unknown): MondayEvent | null {
  const ev = (body as { event?: Record<string, unknown> } | null)?.event;
  if (!ev || typeof ev !== 'object') return null;
  const boardId = str(ev.boardId);
  if (!boardId) return null;
  return {
    type: str(ev.type) ?? 'unknown',
    boardId,
    itemId: str(ev.pulseId ?? ev.itemId),
    columnId: str(ev.columnId),
    userId: str(ev.userId),
    groupId: str(ev.groupId),
    triggerUuid: str(ev.triggerUuid),
    value: ev.value ?? null,
    previousValue: ev.previousValue ?? null,
  };
}

/** monday retries deliver the same triggerUuid; fall back to the whole body. */
export function mondayDedupeHash(body: unknown, ev: MondayEvent): string {
  return ev.triggerUuid ? sha256('monday', ev.triggerUuid) : sha256('monday', JSON.stringify(body));
}

/** Archive / delete events, whatever exact type string the API version uses. */
export function isMondayRemoval(ev: MondayEvent): boolean {
  return /archive|delete/i.test(ev.type);
}
