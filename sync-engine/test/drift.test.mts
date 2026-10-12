import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDrift, driftTaskKey } from '../src/config/drift.ts';
import type { LabelRef } from '../src/config/load.ts';

const refs: LabelRef[] = [
  { source: 'config_labels', semanticKey: 'presales.status', key: 'won', labelId: 1 },
  { source: 'config_labels', semanticKey: 'presales.status', key: 'rebid', labelId: 8 },
  { source: 'map_sales_rep', semanticKey: 'presales.sales_person', key: 'Luke Wood', labelId: 1 },
  { source: 'map_sales_rep', semanticKey: 'presales.sales_person', key: 'Matthew Krone', labelId: 10 },
  { source: 'map_win_pct', semanticKey: 'presales.win_pct', key: '50%', labelId: 2 },
];

test('no drift when every id is present and active', () => {
  const r = findDrift(refs, {
    'presales.status': [{ id: 1, label: 'Won', deactivated: false }, { id: 8, label: 'Rebid', deactivated: false }],
    'presales.sales_person': [{ id: 1, label: 'Luke Wood', deactivated: false }, { id: 10, label: 'Matthew Krone', deactivated: false }],
    'presales.win_pct': [{ id: 2, label: '50%', deactivated: false }],
  });
  assert.deepEqual(r, { findings: [], blockedColumns: [], deadMapRows: [] });
});

test('a vanished status label blocks the status column; a deactivated map label only kills that row', () => {
  const r = findDrift(refs, {
    'presales.status': [{ id: 1, label: 'Won', deactivated: false }],
    'presales.sales_person': [{ id: 1, label: 'Luke Wood', deactivated: false }, { id: 10, label: 'Matthew Krone', deactivated: true }],
  });
  assert.deepEqual(r.blockedColumns, ['presales.status']);
  assert.deepEqual(r.deadMapRows, [{ table: 'map_sales_rep', sfValue: 'Matthew Krone' }]);
  assert.equal(r.findings.length, 2);
  assert.equal(driftTaskKey(r.findings[0]), 'sync_failure:config_drift:config_labels:presales.status.rebid');
});

test('columns that were not checked are not reported', () => {
  assert.equal(findDrift(refs, {}).findings.length, 0);
});
