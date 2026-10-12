import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffItem, etDate, formatInstant, toCsv } from '../src/report/fieldDiff.ts';
import { lightningBase } from '../src/report/run.ts';
import type { MondayItemSnapshot, PlannerConfig, PlannerMaps } from '../src/reconcile/types.ts';
import { opp } from './helpers/fixtures.mts';

const cfg = {
  columns: {}, groups: {},
  labels: { 'presales.status.won': 1, 'presales.status.follow_up': 6 },
  creationStages: [], confirmedWinPcts: ['99%', '100%'], blockedColumns: [],
} as unknown as PlannerConfig;
const maps: PlannerMaps = {
  businessUnit: { Northeast: 4, Southeast: 2 },
  winPct: { '50%': 2, '75%': 3 },
  salesRep: { 'Luke Wood': 1, 'Marisa Wooten': 3 },
  stageAction: { Engineering: { action: 'none', params: {} }, 'Closed Lost': { action: 'lost', params: {} } },
};
const names: Record<string, Record<number, string>> = {
  'presales.win_pct': { 2: '50%', 3: '75%' },
  'presales.business_unit': { 2: 'Instrata SE', 4: 'Instrata NE' },
  'presales.sales_person': { 1: 'Luke Wood', 3: 'Marisa Wooten' },
  'presales.status': { 1: 'Won', 6: 'Follow Up' },
};
const labelText = (k: string, id: number) => names[k]?.[id] ?? `label ${id}`;
const snap = (fieldValues: Record<string, string | null>, statusLabelId = 6): MondayItemSnapshot =>
  ({ id: '1', state: 'active', groupId: 'g', statusLabelId, quotedPrice: null, engineerUserIds: [], fieldValues });

const allMatch = {
  'presales.due_date': '{"date":"2026-10-15","time":"18:00:00"}',
  'presales.quote_number': '"Q-1001"',
  'presales.win_pct': '{"ids":[2]}',
  'presales.business_unit': '{"ids":[4]}',
  'presales.sales_person': '{"ids":[1]}',
};

test('ET formatting and dates', () => {
  assert.equal(formatInstant('2026-10-15T18:00:00Z'), 'Oct 15, 2026, 2:00 PM ET');
  assert.equal(etDate('2026-10-16T01:30:00Z'), '2026-10-15', '9:30 PM ET is still the 15th in ET');
});

test('nothing to report when monday already matches', () => {
  assert.deepEqual(diffItem(opp(), snap(allMatch), cfg, maps, labelText), []);
});

test('readable rows: labels by name, dates in ET, and a note saying what kind of date change it is', () => {
  const rows = diffItem(opp({ Sales_Rep__r: { Name: 'Marisa Wooten' } }), snap({
    ...allMatch,
    'presales.due_date': '{"date":"2026-10-15"}',
    'presales.sales_person': '{"ids":[1]}',
    'presales.quote_number': null,
  }), cfg, maps, labelText);
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.deepEqual(by['Sales Person'], { field: 'Sales Person', mondayNow: 'Luke Wood', salesforce: 'Marisa Wooten', note: '' });
  assert.equal(by['Due Date'].mondayNow, '2026-10-15 (no time)');
  assert.equal(by['Due Date'].salesforce, 'Oct 15, 2026, 2:00 PM ET');
  assert.equal(by['Due Date'].note, 'Same date — adds the time of day');
  assert.equal(by['Quote Number'].mondayNow, '(blank)');

  const moved = diffItem(opp(), snap({ ...allMatch, 'presales.due_date': '{"date":"2026-10-20"}' }), cfg, maps, labelText);
  assert.equal(moved[0].note, 'Date differs');
});

test('unmapped values are listed, not hidden', () => {
  const rows = diffItem(opp({ Business_Unit__c: 'Louisiana' }), snap(allMatch), cfg, maps, labelText);
  assert.equal(rows.length, 1);
  assert.match(rows[0].note, /Unmapped/);
});

test('Confirmed to Win shows as a status review row (not a Win % change)', () => {
  const rows = diffItem(opp({ Win_Likelihood__c: '99%' }), snap(allMatch, 6), cfg, maps, labelText);
  assert.deepEqual(rows.map((r) => [r.field, r.mondayNow, r.salesforce]), [['Status (Confirmed to Win)', 'Follow Up', 'Won — Win % is 99%']]);
  assert.match(rows[0].note, /Hope decides/);
  assert.deepEqual(diffItem(opp({ Win_Likelihood__c: '99%' }), snap(allMatch, 1), cfg, maps, labelText), [], 'already Won');
  assert.deepEqual(diffItem(opp({ Win_Likelihood__c: '99%', StageName: 'Closed Lost' }), snap(allMatch, 6), cfg, maps, labelText), [], 'terminal stage');
});

test('blank in Salesforce never shows as a change', () => {
  assert.deepEqual(diffItem(opp({ Estimate_Number__c: null }), snap({ ...allMatch, 'presales.quote_number': '"Q-OLD"' }), cfg, maps, labelText), []);
});

test('CSV escaping and Salesforce links', () => {
  assert.equal(toCsv(['a', 'b'], [['Acme, Inc.', 'say "hi"']]), 'a,b\r\n"Acme, Inc.","say ""hi"""\r\n');
  assert.equal(lightningBase('https://instrata--partial.sandbox.my.salesforce.com'), 'https://instrata--partial.sandbox.lightning.force.com');
  assert.equal(lightningBase('https://instrata.my.salesforce.com'), 'https://instrata.lightning.force.com');
});
