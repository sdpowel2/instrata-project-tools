import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeColumnValue, encodeColumnValues, mondayValueMatches, parseColumnLabels, readDropdownIds, readNumber, readPersonIds, readStatusLabelId, readText,
} from '../src/monday/encode.ts';
import { toSnapshot, snapshotColumnIds } from '../src/reconcile/snapshot.ts';
import type { PlannerConfig } from '../src/reconcile/types.ts';

test('encodes every planner value type', () => {
  assert.deepEqual(encodeColumnValue({ type: 'status', labelId: 8 }), { index: 8 });
  assert.deepEqual(encodeColumnValue({ type: 'dropdown', labelIds: [25] }), { ids: [25] });
  assert.deepEqual(encodeColumnValue({ type: 'datetime', iso: '2026-10-15T18:00:00Z' }), { date: '2026-10-15', time: '18:00:00' });
  assert.equal(encodeColumnValue({ type: 'text', text: 'Q-1001' }), 'Q-1001');
  assert.deepEqual(encodeColumnValue({ type: 'long_text', text: 'notes' }), { text: 'notes' });
});

test('datetime encoding refuses anything but second-precision UTC (no silent tz conversion)', () => {
  assert.throws(() => encodeColumnValue({ type: 'datetime', iso: '2026-10-15T18:00:00-04:00' }));
});

test('encodeColumnValues resolves semantic keys to column ids and fails loudly when unconfigured', () => {
  const ids: Record<string, string | null> = { 'presales.status': 'status9', 'presales.win_loss_notes': null };
  assert.deepEqual(
    encodeColumnValues([{ semanticKey: 'presales.status', value: { type: 'status', labelId: 2 } }], (k) => ids[k]),
    { status9: { index: 2 } },
  );
  assert.throws(() => encodeColumnValues([{ semanticKey: 'presales.win_loss_notes', value: { type: 'long_text', text: 'x' } }], (k) => ids[k]));
});

test('reads monday column value JSON', () => {
  assert.equal(readStatusLabelId('{"index":1,"post_id":null,"changed_at":"2026-10-01T00:00:00Z"}'), 1);
  assert.equal(readStatusLabelId(null), null);
  assert.equal(readNumber('"125000"'), 125000);
  assert.equal(readNumber('""'), null);
  assert.equal(readNumber(null), null);
  assert.deepEqual(readPersonIds('{"personsAndTeams":[{"id":555,"kind":"person"},{"id":9,"kind":"team"}]}'), ['555']);
  assert.deepEqual(readDropdownIds('{"ids":[4]}'), [4]);
  assert.equal(readText('"Q-1001"'), 'Q-1001');
  assert.equal(readText('{"text":"long"}'), 'long');
});

test('parses label settings — the shape the live Pre-Sales board returned on 2026-10-10', () => {
  const live = { labels: [
    { id: 5, label: 'High', is_deactivated: false }, { id: 1, label: '25%', is_deactivated: false },
    { id: 10, label: 'Matthew Krone', is_deactivated: true },
  ] };
  assert.deepEqual(parseColumnLabels(live), [
    { id: 5, label: 'High', deactivated: false }, { id: 1, label: '25%', deactivated: false },
    { id: 10, label: 'Matthew Krone', deactivated: true },
  ]);
});

test('parses the older label-settings shapes too', () => {
  assert.deepEqual(parseColumnLabels('{"labels":{"0":"In Progress","1":"Won"}}'), [
    { id: 0, label: 'In Progress', deactivated: false }, { id: 1, label: 'Won', deactivated: false },
  ]);
  assert.deepEqual(parseColumnLabels({ labels: [{ id: 1, name: 'Yes' }, { id: 2, name: 'No' }], deactivated_labels: [2] }), [
    { id: 1, label: 'Yes', deactivated: false }, { id: 2, label: 'No', deactivated: true },
  ]);
  assert.deepEqual(parseColumnLabels(null), []);
});

test('mondayValueMatches: same value → true, anything else or unknown → false', () => {
  assert.equal(mondayValueMatches({ type: 'dropdown', labelIds: [4] }, '{"ids":[4]}'), true);
  assert.equal(mondayValueMatches({ type: 'dropdown', labelIds: [4] }, '{"ids":[3]}'), false);
  assert.equal(mondayValueMatches({ type: 'dropdown', labelIds: [4] }, null), false);
  assert.equal(mondayValueMatches({ type: 'text', text: 'Q-1' }, '"Q-1"'), true);
  assert.equal(mondayValueMatches({ type: 'text', text: 'Q-1' }, '"Q-2"'), false);
  assert.equal(mondayValueMatches({ type: 'datetime', iso: '2026-10-15T18:00:00Z' }, '{"date":"2026-10-15","time":"18:00:00","changed_at":"x"}'), true);
  assert.equal(mondayValueMatches({ type: 'datetime', iso: '2026-10-15T18:00:00Z' }, '{"date":"2026-10-15"}'), false, 'date without time ≠ instant');
  assert.equal(mondayValueMatches({ type: 'datetime', iso: '2026-10-15T18:00:00Z' }, '{"date":"2026-10-15","time":"14:00:00"}'), false);
  assert.equal(mondayValueMatches({ type: 'status', labelId: 1 }, '{"index":1}'), true);
  assert.equal(mondayValueMatches({ type: 'text', text: 'x' }, undefined), false, 'unknown → write');
});

test('builds planner snapshots from raw items', () => {
  const cfg = { columns: {
    'presales.status': { columnId: 'status9', type: 'status', owner: 'shared' },
    'presales.quoted_price': { columnId: 'numbers9', type: 'numbers', owner: 'monday' },
    'presales.presales_engineer': { columnId: 'person', type: 'people', owner: 'monday' },
  } } as unknown as PlannerConfig;
  assert.deepEqual(snapshotColumnIds(cfg), ['status9', 'numbers9', 'person']);
  const snap = toSnapshot({
    id: '13092716583', name: 'x', state: 'active', group: { id: 'new_group66048' },
    column_values: [
      { id: 'status9', value: '{"index":6}', text: 'Follow Up' },
      { id: 'numbers9', value: '"98000"', text: '98000' },
      { id: 'person', value: '{"personsAndTeams":[{"id":42,"kind":"person"}]}', text: 'Someone' },
    ],
  }, cfg);
  assert.deepEqual(snap, { id: '13092716583', state: 'active', groupId: 'new_group66048', statusLabelId: 6, quotedPrice: 98000, engineerUserIds: ['42'], fieldValues: {} });
});
