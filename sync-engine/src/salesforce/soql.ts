/**
 * SOQL builders + record mapping. Pure — tested by test/salesforce.test.mts.
 *
 * Field-name traps live here and only here (spec §12):
 *   - Sold_in_Margin__c (lowercase i) is the LINE ITEM field we write;
 *     Sold_In_Margin__c (capital I) on Opportunity is never touched.
 *   - The quote number is Estimate_Number__c (Quote_Number__c is always null).
 *   - The rep is Sales_Rep__c / Sales_Rep__r.Name, NOT OwnerId.
 */
import type { SfLineItem, SfOpportunity } from '../reconcile/types.ts';

export const LINE_ITEM_MARGIN_FIELD = 'Sold_in_Margin__c';

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export function assertSfId(id: string): string {
  if (!SF_ID.test(id)) throw new Error(`Not a Salesforce id: "${id}"`);
  return id;
}

/** SOQL datetime literal: unquoted, second precision, UTC. */
export function soqlDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Spec §4.2 — one query per batch of opportunity ids (≤ 100 per call). */
export function opportunityQuery(ids: string[]): string {
  if (ids.length === 0 || ids.length > 100) throw new Error(`opportunityQuery takes 1–100 ids, got ${ids.length}`);
  const list = ids.map((id) => `'${assertSfId(id)}'`).join(', ');
  return [
    'SELECT Id, Name, StageName, Estimate_Due_Date_Time__c, Estimate_Number__c,',
    '       Win_Likelihood__c, Business_Unit__c, Sales_Rep__c, Sales_Rep__r.Name,',
    '       Lost_Reason__c, Other_lost_reason__c, Lost_To__c, SystemModstamp, LastModifiedById,',
    `       (SELECT Id, isAVProduct__c, Technology__c, UnitPrice, Quantity, ${LINE_ITEM_MARGIN_FIELD}, CreatedDate`,
    '          FROM OpportunityLineItems',
    "         WHERE isAVProduct__c = true OR Technology__c = 'AV')",
    `FROM Opportunity WHERE Id IN (${list})`,
  ].join('\n');
}

/** Hourly safety sweep (spec §4.1): ids of everything touched since the watermark. */
export function sweepQueries(since: Date): { opportunities: string; lineItems: string; deletedLineItems: string } {
  const t = soqlDateTime(since);
  return {
    // Only opportunities that have an AV line. Line-item edits (incl. the AV flag
    // flipping off) and deletes are caught by the other two queries.
    opportunities: `SELECT Id FROM Opportunity WHERE SystemModstamp >= ${t} AND Id IN (SELECT OpportunityId FROM OpportunityLineItem WHERE isAVProduct__c = true OR Technology__c = 'AV')`,
    lineItems: `SELECT OpportunityId FROM OpportunityLineItem WHERE SystemModstamp >= ${t}`,
    // Run through /queryAll. Backstop for OLI deletes, which a delete-triggered
    // Flow can't call out for (plan §8.1).
    deletedLineItems: `SELECT OpportunityId FROM OpportunityLineItem WHERE IsDeleted = true AND SystemModstamp >= ${t}`,
  };
}

export function lineItemQuery(lineItemId: string): string {
  return `SELECT Id, OpportunityId, UnitPrice, Quantity, ${LINE_ITEM_MARGIN_FIELD} FROM OpportunityLineItem WHERE Id = '${assertSfId(lineItemId)}'`;
}

/** Raw REST record → planner input (subquery flattened). */
export function mapOpportunity(r: any): SfOpportunity {
  const lines: SfLineItem[] = (r.OpportunityLineItems?.records ?? []).map((li: any) => ({
    Id: li.Id,
    isAVProduct__c: li.isAVProduct__c ?? null,
    Technology__c: li.Technology__c ?? null,
    UnitPrice: li.UnitPrice ?? null,
    Quantity: li.Quantity ?? null,
    Sold_in_Margin__c: li[LINE_ITEM_MARGIN_FIELD] ?? null,
    CreatedDate: li.CreatedDate,
  }));
  return {
    Id: r.Id,
    Name: r.Name,
    StageName: r.StageName,
    Estimate_Due_Date_Time__c: r.Estimate_Due_Date_Time__c ?? null,
    Estimate_Number__c: r.Estimate_Number__c ?? null,
    Win_Likelihood__c: r.Win_Likelihood__c ?? null,
    Business_Unit__c: r.Business_Unit__c ?? null,
    Sales_Rep__c: r.Sales_Rep__c ?? null,
    Sales_Rep__r: r.Sales_Rep__r ? { Name: r.Sales_Rep__r.Name ?? null } : null,
    Lost_Reason__c: r.Lost_Reason__c ?? null,
    Other_lost_reason__c: r.Other_lost_reason__c ?? null,
    Lost_To__c: r.Lost_To__c ?? null,
    SystemModstamp: r.SystemModstamp,
    LastModifiedById: r.LastModifiedById ?? null,
    lineItems: lines,
  };
}
