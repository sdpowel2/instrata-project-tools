/**
 * Salesforce value normalization. Baselines store these normalized forms, so a
 * value that only differs in formatting (e.g. '.000+0000' vs 'Z') never causes
 * a write.
 */
import type { SfLineItem, SfOpportunity } from './types.ts';

/** Reserved map_sales_rep key for a blank Sales_Rep__c (seeded → House). */
export const BLANK_SALES_REP = '(blank)';

/** Salesforce-owned field keys the reconciler keeps in sync (spec §4.4). */
export const SF_FIELD_KEYS = [
  'presales.due_date',
  'presales.quote_number',
  'presales.win_pct',
  'presales.business_unit',
  'presales.sales_person',
] as const;
export type SfFieldKey = (typeof SF_FIELD_KEYS)[number];

export const STAGE_KEY = 'sf.stage';
export const missKey = (field: string) => `miss:${field}`;

function blankToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Salesforce datetimes arrive as '2026-10-15T18:00:00.000+0000'. Normalize to a
 * second-precision UTC ISO string. No timezone conversion — the instant passes
 * through unchanged (spec §4.4, §12).
 */
export function normalizeDateTime(v: string | null): string | null {
  const s = blankToNull(v);
  if (!s) return null;
  // Date can't parse '+0000' (no colon) in every runtime; add it.
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  if (Number.isNaN(d.getTime())) return s; // unparseable: keep verbatim, never silently drop
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** '25%', '25', 25, 25.0 → '25%'. Non-numeric values pass through trimmed (→ mapping miss). */
export function normalizeWinPct(v: string | number | null): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/%$/, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? `${n}%` : String(v).trim();
}

/** AV means isAVProduct__c, with Technology__c = 'AV' as the fallback (spec §4.3). */
export function isAvLineItem(li: SfLineItem): boolean {
  return li.isAVProduct__c === true || (li.Technology__c ?? '').trim().toUpperCase() === 'AV';
}

/** Current Salesforce values for the synced fields, normalized. */
export function extractSfFields(opp: SfOpportunity): Record<SfFieldKey, string | null> {
  const repBlank = blankToNull(opp.Sales_Rep__c) === null;
  return {
    'presales.due_date': normalizeDateTime(opp.Estimate_Due_Date_Time__c),
    'presales.quote_number': blankToNull(opp.Estimate_Number__c),
    'presales.win_pct': normalizeWinPct(opp.Win_Likelihood__c),
    'presales.business_unit': blankToNull(opp.Business_Unit__c),
    // A blank rep is a value here, not a blank: it maps to House (spec §3.2).
    'presales.sales_person': repBlank ? BLANK_SALES_REP : blankToNull(opp.Sales_Rep__r?.Name) ?? BLANK_SALES_REP,
  };
}

/**
 * Win/Loss Notes (spec §4.6): "Lost/Canceled Reason: Price · Detail: … · Lost to: Acme AV".
 * Blank parts are skipped; '' when everything is blank.
 */
export function buildWinLossNotes(opp: SfOpportunity): string {
  const parts: string[] = [];
  const reason = blankToNull(opp.Lost_Reason__c);
  const detail = blankToNull(opp.Other_lost_reason__c);
  const lostTo = blankToNull(opp.Lost_To__c);
  if (reason) parts.push(`Lost/Canceled Reason: ${reason}`);
  if (detail) parts.push(`Detail: ${detail}`);
  if (lostTo) parts.push(`Lost to: ${lostTo}`);
  return parts.join(' · ');
}
