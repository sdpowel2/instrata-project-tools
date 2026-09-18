// Rules for which BoM line items NEVER auto-populate into a submittal.
//
// Submittals are equipment-only documents the AV team sends to the customer
// for approval. Two classes of BoM rows don't belong:
//
//   1. Labor entries (engineering time, travel, airfare, etc.) — these
//      represent service hours, not deliverable equipment.
//   2. House manufacturers (Instrata, Premiere, Cable Solutions, Net100,
//      Kane). These are internal labor/service line items even when DTools
//      models them as products, so they shouldn't ship to the customer for
//      review.
//
// The auto-populate flow filters these out by default. The submittal page
// surfaces the excluded list so the user can add anything back manually
// when an edge case warrants it.

import type { ProjectBoMItem, SubmittalItem, SubmittalItemLocation } from '../types';

// Twin: mcp-server/src/submittalTools.ts copies this list for its server-side
// populate_submittal_from_bom tool. Keep the two in sync.
export const EXCLUDED_MANUFACTURERS = [
  'Instrata',
  'Premiere',
  'Cable Solutions',
  'Net100',
  'Kane',
] as const;

const EXCLUDED_MANUFACTURERS_NORMALIZED = new Set(
  EXCLUDED_MANUFACTURERS.map((m) => m.toLowerCase()),
);

export interface ExclusionResult {
  excluded: boolean;
  /** Human-readable reason. Empty when not excluded. */
  reason: string;
}

export function evaluateExclusion(item: ProjectBoMItem): ExclusionResult {
  if (item.itemType === 'Labor') {
    return { excluded: true, reason: 'Labor item' };
  }
  const mfr = item.manufacturer.trim().toLowerCase();
  if (EXCLUDED_MANUFACTURERS_NORMALIZED.has(mfr)) {
    return { excluded: true, reason: `Excluded manufacturer: ${item.manufacturer.trim()}` };
  }
  return { excluded: false, reason: '' };
}

export function isExcludedFromSubmittal(item: ProjectBoMItem): boolean {
  return evaluateExclusion(item).excluded;
}

/**
 * Submittal items are deduped by manufacturer+model. To decide which excluded
 * BoM rows to surface in the "add back" list, compare the same key.
 */
function submittalKey(manufacturer: string, model: string): string {
  return `${manufacturer.trim().toLowerCase()}|||${model.trim().toLowerCase()}`;
}

export interface ExcludedBoMRow {
  bomItemId: string;
  manufacturer: string;
  model: string;
  description: string;
  qty: number;
  reason: string;
}

/**
 * Returns the BoM rows that the auto-populate would have skipped, minus any
 * that the user has already manually added to the submittal. Sums quantities
 * across duplicate manufacturer+model rows (matching how populate consolidates).
 */
export function listExcludedForSubmittal(
  bomItems: ProjectBoMItem[],
  submittalItems: SubmittalItem[],
): ExcludedBoMRow[] {
  const inSubmittal = new Set(submittalItems.map((s) => submittalKey(s.manufacturer, s.model)));
  const grouped = new Map<string, ExcludedBoMRow>();

  for (const item of bomItems) {
    const { excluded, reason } = evaluateExclusion(item);
    if (!excluded) continue;
    const key = submittalKey(item.manufacturer, item.model);
    if (inSubmittal.has(key)) continue; // user re-added this one already

    const existing = grouped.get(key);
    if (existing) {
      existing.qty += item.qty;
    } else {
      grouped.set(key, {
        bomItemId: item.id,
        manufacturer: item.manufacturer,
        model: item.model,
        description: item.description,
        qty: item.qty,
        reason,
      });
    }
  }

  return Array.from(grouped.values()).sort((a, b) =>
    a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model),
  );
}

/**
 * Merge two per-room quantity lists, summing qty where the same room appears
 * in both. Used when populate consolidates duplicate manufacturer+model BoM
 * rows: the DTools sync splits one part into several rows when it is priced
 * differently per row (e.g. a $0 OFE/CO copy next to the priced one), and
 * each row carries only its own rooms.
 */
export function mergeLocations(
  a: SubmittalItemLocation[],
  b: SubmittalItemLocation[],
): SubmittalItemLocation[] {
  const merged: SubmittalItemLocation[] = a.map((l) => ({ ...l }));
  for (const loc of b) {
    const hit = merged.find((l) => l.room === loc.room);
    if (hit) hit.qty += loc.qty;
    else merged.push({ ...loc });
  }
  return merged;
}
