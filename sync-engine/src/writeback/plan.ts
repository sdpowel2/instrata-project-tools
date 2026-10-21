/**
 * monday → Salesforce writeback decision (spec §5). Pure — tested by test/writeback.test.mts.
 *
 * Writes ONLY OpportunityLineItem.UnitPrice and .Sold_in_Margin__c (lowercase i).
 * Never Opportunity header fields (Estimate_Total__c, Margin_of_Project__c,
 * Sold_In_Margin__c with a capital I) — they affect other trades.
 */
import type { SfLineItemState } from '../salesforce/client.ts';

export interface WritebackInput {
  mondayItemId: string;
  link: { sfLineItemId: string; sfOpportunityId: string; linkState: 'active' | 'archived' | 'conflict' } | null;
  lineItem: SfLineItemState | null;
  /** Current monday values, re-read at processing time (not from the webhook payload). */
  quotedPrice: number | null;
  gmPct: number | null;
}

export type WritebackDecision =
  | { kind: 'patch'; lineItemId: string; values: { UnitPrice?: number; Sold_in_Margin__c?: number }; old: { UnitPrice: number | null; Sold_in_Margin__c: number | null } }
  | { kind: 'task'; taskType: 'writeback_no_link' | 'writeback_quantity' | 'sync_failure'; dedupeKey: string; title: string; details: string }
  | { kind: 'none'; reason: string };

/** Keys of the tasks a successful writeback closes (spec §6.2: "next writeback for that item succeeds"). */
export function writebackTaskKeys(mondayItemId: string): string[] {
  return [`writeback_no_link:${mondayItemId}`, `writeback_quantity:${mondayItemId}`, `sync_failure:writeback_line_missing:${mondayItemId}:line_item`];
}

const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.005;

export function planWriteback(i: WritebackInput): WritebackDecision {
  if (!i.link) {
    return {
      kind: 'task', taskType: 'writeback_no_link', dedupeKey: `writeback_no_link:${i.mondayItemId}`,
      title: `Price/GM% not sent to Salesforce: item ${i.mondayItemId} isn't linked`,
      details: 'Quoted Price or GM % changed on a pre-sales item with no Salesforce link, so nothing was written back. Link it (Salesforce ID column) or ignore if it has no opportunity.',
    };
  }
  if (i.link.linkState !== 'active') return { kind: 'none', reason: `link is ${i.link.linkState}` };
  if (!i.lineItem) {
    return {
      kind: 'task', taskType: 'sync_failure', dedupeKey: `sync_failure:writeback_line_missing:${i.mondayItemId}:line_item`,
      title: `Price/GM% not sent: AV line item ${i.link.sfLineItemId} not found`,
      details: `The Salesforce line item linked to item ${i.mondayItemId} was deleted or isn't visible to the integration user.`,
    };
  }
  // Writing UnitPrice on a multi-quantity line would multiply the total (spec §5.3).
  if (i.lineItem.Quantity !== 1) {
    return {
      kind: 'task', taskType: 'writeback_quantity', dedupeKey: `writeback_quantity:${i.mondayItemId}`,
      title: `Price/GM% not sent: line item quantity is ${i.lineItem.Quantity}`,
      details: `The AV line item on opportunity ${i.link.sfOpportunityId} has Quantity ${i.lineItem.Quantity}. Writing the quoted price as Sales Price would multiply it. Set Quantity to 1 in Salesforce, then change the price in monday again.`,
    };
  }

  const values: { UnitPrice?: number; Sold_in_Margin__c?: number } = {};
  if (i.quotedPrice !== null && !same(i.quotedPrice, i.lineItem.UnitPrice)) values.UnitPrice = i.quotedPrice;
  // Percent units: monday stores 35 for 35%, and Salesforce percent fields take 35 too
  // (spec §5.4 — confirm on one sandbox record).
  if (i.gmPct !== null && !same(i.gmPct, i.lineItem.Sold_in_Margin__c)) values.Sold_in_Margin__c = i.gmPct;

  if (Object.keys(values).length === 0) return { kind: 'none', reason: 'Salesforce already matches' };
  return { kind: 'patch', lineItemId: i.link.sfLineItemId, values, old: { UnitPrice: i.lineItem.UnitPrice, Sold_in_Margin__c: i.lineItem.Sold_in_Margin__c } };
}
