import type { SfOpportunity } from '../../src/reconcile/types.ts';

export const OPP = '006AAA000000001';
export const LINE = '00kAAA000000001';
export const PRESALES = '3477536693';
export const INTEGRATION_USER = '119228546';

export function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Acme HQ – Boardroom', StageName: 'Engineering',
    Estimate_Due_Date_Time__c: '2026-10-15T18:00:00.000+0000', Estimate_Number__c: 'Q-1001',
    Win_Likelihood__c: '50%', Business_Unit__c: 'Northeast', Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER',
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: 'c' }],
    ...over,
  };
}

/** A monday change_column_value webhook body. */
export function mondayColumnEvent(over: Record<string, unknown> = {}) {
  return {
    event: {
      type: 'update_column_value', boardId: Number(PRESALES), pulseId: 13092716583, columnId: 'numbers9',
      userId: 33940282, value: { value: 125000 }, previousValue: null, triggerUuid: `t-${Math.random()}`,
      ...over,
    },
  };
}
