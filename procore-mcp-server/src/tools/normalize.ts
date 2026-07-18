/**
 * Defensive helpers for shrinking Procore's verbose payloads into compact,
 * token-efficient fields. Procore returns people as objects/arrays and dates in
 * varied shapes across resources; these read them tolerantly.
 *
 * NOTE: exact Procore field names per resource should be confirmed against the
 * sandbox during integration testing — normalizers fall back gracefully when a
 * field is absent, so a wrong guess degrades to `undefined` rather than throwing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** A person's display name from a Procore user object, string, or login. */
export function personName(p: Any): string | undefined {
  if (!p) return undefined;
  if (typeof p === 'string') return p;
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ');
  return p.name ?? (full || undefined) ?? p.login ?? undefined;
}

/** Procore "ball in court" can be a single party or an array; join to names. */
export function ballInCourt(v: Any): string | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const names = arr.map(personName).filter(Boolean);
  return names.length ? names.join(', ') : undefined;
}

/** Is an ISO timestamp at or after the `since` ISO bound? Missing dates pass. */
export function withinSince(updatedAt: string | undefined, sinceIso: string): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  return Number.isNaN(t) ? true : t >= Date.parse(sinceIso);
}

/** First non-empty string among candidates. */
export function firstStr(...vals: Array<unknown>): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v;
  return undefined;
}
