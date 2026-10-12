import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSfId, mapOpportunity, opportunityQuery, soqlDateTime, sweepQueries } from '../src/salesforce/soql.ts';
import { createSalesforceClient } from '../src/salesforce/client.ts';

test('SOQL builders only accept real Salesforce ids (no injection through ids)', () => {
  assert.equal(assertSfId('006Hs00001qATbCIAW'), '006Hs00001qATbCIAW');
  assert.equal(assertSfId('006Hs00001qATbC'), '006Hs00001qATbC');
  assert.throws(() => assertSfId("006' OR Name != '"));
  assert.throws(() => opportunityQuery(["006Hs00001qATbCIAW', 'x"]));
  assert.throws(() => opportunityQuery([]));
});

test('opportunity query reads the LINE ITEM margin field (lowercase i) and filters AV lines', () => {
  const q = opportunityQuery(['006Hs00001qATbCIAW']);
  assert.match(q, /Sold_in_Margin__c/);
  assert.doesNotMatch(q, /Sold_In_Margin__c/);
  assert.match(q, /isAVProduct__c = true OR Technology__c = 'AV'/);
  assert.match(q, /Estimate_Number__c/);
  assert.doesNotMatch(q, /Quote_Number__c/);
  assert.match(q, /Sales_Rep__r\.Name/);
});

test('sweep queries use unquoted UTC datetime literals and queryAll for deletes', () => {
  const d = new Date('2026-10-10T12:00:00.123Z');
  assert.equal(soqlDateTime(d), '2026-10-10T12:00:00Z');
  const s = sweepQueries(d);
  assert.equal(s.opportunities, 'SELECT Id FROM Opportunity WHERE SystemModstamp >= 2026-10-10T12:00:00Z');
  assert.match(s.deletedLineItems, /IsDeleted = true/);
});

test('maps a REST record (subquery flattened, missing fields → null)', () => {
  const o = mapOpportunity({
    Id: '006A', Name: 'Acme', StageName: 'Engineering', SystemModstamp: 't',
    Sales_Rep__r: { Name: 'Luke Wood' }, Win_Likelihood__c: '50%',
    OpportunityLineItems: { totalSize: 1, done: true, records: [{ Id: '00kA', isAVProduct__c: true, Technology__c: null, UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: 35, CreatedDate: 'c' }] },
  });
  assert.equal(o.Sales_Rep__r?.Name, 'Luke Wood');
  assert.equal(o.Estimate_Number__c, null);
  assert.equal(o.lineItems.length, 1);
  assert.equal(o.lineItems[0].Sold_in_Margin__c, 35);
  assert.deepEqual(mapOpportunity({ Id: '006B', Name: 'B', StageName: 'Lead', SystemModstamp: 't', OpportunityLineItems: null }).lineItems, []);
});

// ── Client against a fake Salesforce ──
function fakeSalesforce() {
  const calls: { url: string; method: string; body?: string }[] = [];
  let tokenN = 0;
  let expireNext = false;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined || init.body === null ? undefined : String(init.body) });
    if (url.endsWith('/services/oauth2/token')) {
      tokenN++;
      return json(200, { access_token: `tok${tokenN}`, instance_url: 'https://instrata--partial.sandbox.my.salesforce.com' });
    }
    const auth = (init.headers as Record<string, string>).Authorization;
    if (expireNext) {
      expireNext = false;
      return json(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
    }
    if (url.includes('/query?q=')) {
      return json(200, { done: false, nextRecordsUrl: '/services/data/v66.0/query/01g-2000', records: [{ Id: '006A', Name: 'A', StageName: 'Engineering', SystemModstamp: 't', OpportunityLineItems: null, _auth: auth }] });
    }
    if (url.includes('/query/01g-2000')) {
      return json(200, { done: true, records: [{ Id: '006B', Name: 'B', StageName: 'Budget', SystemModstamp: 't', OpportunityLineItems: null }] });
    }
    if (init.method === 'PATCH') return new Response(null, { status: 204 });
    return json(404, {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, expire: () => { expireNext = true; } };
}

test('client: client-credentials auth, pagination, 401 re-auth, PATCH', async () => {
  const sf = fakeSalesforce();
  const client = createSalesforceClient({ loginUrl: 'https://instrata--partial.sandbox.my.salesforce.com', clientId: 'id', clientSecret: 'secret', apiVersion: '66.0', fetchImpl: sf.fetchImpl });

  const rows = await client.query('SELECT Id FROM Opportunity');
  assert.deepEqual(rows.map((r: any) => r.Id), ['006A', '006B'], 'follows nextRecordsUrl');
  assert.match(sf.calls[0].body ?? '', /grant_type=client_credentials/);

  sf.expire();
  await client.patchLineItem('00kAAA000000001', { UnitPrice: 125000, Sold_in_Margin__c: 35 });
  const tokens = sf.calls.filter((c) => c.url.endsWith('/oauth2/token')).length;
  assert.equal(tokens, 2, 're-authenticated once after the 401');
  const patch = sf.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patch.length, 2, 'retried the PATCH after re-auth');
  assert.match(patch[1].url, /sobjects\/OpportunityLineItem\/00kAAA000000001$/);
  assert.deepEqual(JSON.parse(patch[1].body ?? '{}'), { UnitPrice: 125000, Sold_in_Margin__c: 35 });
});
