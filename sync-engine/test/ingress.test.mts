/** Webhook endpoints, exercised over real HTTP against the real router + PGlite. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { ingressRouter } from '../src/ingress/routes.ts';
import { isMondayRemoval, parseMondayEvent, parseSalesforceEvent } from '../src/ingress/parse.ts';
import { OPP, mondayColumnEvent } from './helpers/fixtures.mts';

let db: TestDb;
let base = '';
let close: () => void;
let ingests = 0;

before(async () => {
  db = await createTestDb();
  const app = express();
  app.use(express.json());
  app.use(ingressRouter({ db, salesforceSecret: 'sf-secret', mondayPathSecret: 'path-secret', onIngest: () => { ingests++; } }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(async () => { close(); await db.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const inboxCount = async (source: string) => (await db.query<{ n: number }>('select count(*)::int as n from webhook_inbox where source = $1', [source])).rows[0].n;

test('parsers pull ids only and reject junk', () => {
  assert.deepEqual(parseSalesforceEvent({ object: 'Opportunity', record_id: OPP, opportunity_id: OPP }), { object: 'Opportunity', recordId: OPP, opportunityId: OPP });
  assert.equal(parseSalesforceEvent({ opportunity_id: "006' OR 1=1" }), null);
  assert.equal(parseSalesforceEvent(null), null);
  const ev = parseMondayEvent(mondayColumnEvent())!;
  assert.equal(ev.itemId, '13092716583');
  assert.equal(ev.userId, '33940282');
  assert.equal(parseMondayEvent({ nope: 1 }), null);
  assert.equal(isMondayRemoval({ ...ev, type: 'archive_pulse' }), true);
  assert.equal(isMondayRemoval(ev), false);
});

test('salesforce: rejects a missing / wrong secret', async () => {
  assert.equal((await post('/webhooks/salesforce', { opportunity_id: OPP })).status, 401);
  assert.equal((await post('/webhooks/salesforce', { opportunity_id: OPP }, { 'X-AVSS-Secret': 'nope' })).status, 401);
  assert.equal(await inboxCount('salesforce'), 0);
});

test('salesforce: valid event lands in the inbox; a burst of saves collapses to one row', async () => {
  const body = { object: 'Opportunity', record_id: OPP, opportunity_id: OPP };
  const before = ingests;
  for (let i = 0; i < 3; i++) {
    const res = await post('/webhooks/salesforce', body, { 'X-AVSS-Secret': 'sf-secret' });
    assert.equal(res.status, 200);
  }
  assert.equal(await inboxCount('salesforce'), 1, 'same opportunity within 10 s → one row');
  assert.equal(ingests - before, 3, 'worker woken each time');
  assert.equal((await post('/webhooks/salesforce', { opportunity_id: 'bad' }, { 'X-AVSS-Secret': 'sf-secret' })).status, 400);
});

test('monday: wrong path secret is a 404 (no challenge echo for strangers)', async () => {
  assert.equal((await post('/webhooks/monday/wrong', { challenge: 'abc' })).status, 404);
});

test('monday: answers the subscription challenge', async () => {
  const res = await post('/webhooks/monday/path-secret', { challenge: 'abc123' });
  assert.deepEqual(await res.json(), { challenge: 'abc123' });
  assert.equal(await inboxCount('monday'), 0);
});

test('monday: events land in the inbox; a redelivery (same triggerUuid) does not duplicate', async () => {
  const body = mondayColumnEvent({ triggerUuid: 'fixed-uuid' });
  assert.equal((await post('/webhooks/monday/path-secret', body)).status, 200);
  assert.equal((await post('/webhooks/monday/path-secret', body)).status, 200);
  assert.equal(await inboxCount('monday'), 1);
  assert.equal((await post('/webhooks/monday/path-secret', { something: 'else' })).status, 200, 'unusable payloads are acknowledged, not retried');
  assert.equal(await inboxCount('monday'), 1);
});
