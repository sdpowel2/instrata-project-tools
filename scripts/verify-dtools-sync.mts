// Offline verification of the DTools → BoM transform against saved payloads.
// Runs the exact module the edge function uses (no Deno APIs in transform.ts).
//
//   node scripts/verify-dtools-sync.mts

import { readFileSync } from 'node:fs';
import { buildBomFromDtools, buildChangeOrderItems } from '../supabase/functions/dtools-project-lookup/transform.ts';

interface Fixture {
  name: string;
  path: string;
  expect: {
    equipmentPrice: number;
    laborPrice: number;
    echoModels: string[];
  };
}

const fixtures: Fixture[] = [
  {
    name: 'Ak Chin Admin SS - AV - CISCO',
    path: 'Reference/AkChinOutputDTools.json',
    expect: { equipmentPrice: 419815.07, laborPrice: 133820.76, echoModels: ['Airfare'] },
  },
  {
    name: 'Brooklyn Canarsie Library',
    path: 'Reference/DTools Research/TestProject2.json',
    // 86120.63 is what the DTools UI displays for this project's labor —
    // per-row round2 convention reproduces it exactly.
    expect: { equipmentPrice: 197703.26, laborPrice: 86120.63, echoModels: ['Airfare'] },
  },
];

let failures = 0;

// Fixtures saved from PowerShell carry a UTF-8 BOM — strip before parsing.
const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

function check(label: string, actual: number, expected: number, tolerance = 0.01) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual.toFixed(2)} (expected ${expected.toFixed(2)})`);
}

for (const f of fixtures) {
  const payload = loadJson(f.path);
  const project = payload?.Project ?? payload;
  const { bomRows, totals, log } = buildBomFromDtools(project);

  console.log(`\n=== ${f.name} ===`);
  for (const line of log) console.log(`  ${line}`);
  console.log(`  rows: ${bomRows.length} (${bomRows.filter(r => r.item_type === 'Product').length} product, ${bomRows.filter(r => r.item_type === 'Labor').length} labor)`);

  check('equipment price', totals.equipmentPrice, f.expect.equipmentPrice);
  check('labor price', totals.laborPrice, f.expect.laborPrice);
  check('total price vs root PriceWithoutTax', totals.totalPrice, totals.rootPriceWithoutTax, 1.0);
  check('total cost vs root Cost', totals.totalCost, totals.rootCost, 1.0);

  const echoOk = JSON.stringify(totals.echoModels.map(m => m.trim()).sort())
    === JSON.stringify(f.expect.echoModels.map(m => m.trim()).sort());
  if (!echoOk) failures++;
  console.log(`  ${echoOk ? 'PASS' : 'FAIL'}  echo companions: [${totals.echoModels.join(', ')}] (expected [${f.expect.echoModels.join(', ')}])`);
  console.log(`  verified flag: ${totals.verified} (Δcost ${totals.costDelta}, Δprice ${totals.priceDelta})`);
  if (!totals.verified) failures++;
}

// ── Zero-priced (post-approval) payload flavor ───────────────────────────────
// DTools republishes approved projects with zero-priced phase rows and
// adjusted hours. Pricing them requires the LaborMeta captured from the
// earlier priced payload. Totals must still anchor to root.
{
  console.log('\n=== Ak Chin zero-priced payload (with meta from priced payload) ===');
  const flavorA = buildBomFromDtools(loadJson('Reference/AkChinOutputDTools.json'));
  if (flavorA.payloadFlavor !== 'priced' || !flavorA.laborMeta) { failures++; console.log('  FAIL  expected priced flavor + meta from AkChinOutputDTools.json'); }
  const flavorB = buildBomFromDtools(loadJson('Reference/AkChinApproved.json'), flavorA.laborMeta);
  for (const line of flavorB.log) console.log(`  ${line}`);
  if (flavorB.payloadFlavor !== 'zeroPriced') { failures++; console.log('  FAIL  expected zeroPriced flavor'); }
  check('B equipment price', flavorB.totals.equipmentPrice, 419815.07);
  check('B labor price ≈ root remainder', flavorB.totals.laborPrice, 553635.87 - 419815.07, 1.0);
  check('B total price vs root', flavorB.totals.totalPrice, flavorB.totals.rootPriceWithoutTax, 1.0);
  check('B total cost vs root', flavorB.totals.totalCost, flavorB.totals.rootCost, 1.0);
  console.log(`  unattributed labor: $${flavorB.totals.unattributedLaborCost} / $${flavorB.totals.unattributedLaborPrice}`);
  if (!flavorB.totals.verified) failures++;
  console.log(`  verified flag: ${flavorB.totals.verified}`);
}

{
  console.log('\n=== Maricopa zero-priced payload (with meta from priced payload) ===');
  const flavorA = buildBomFromDtools(loadJson('Reference/MaricopaDunlapID.json'));
  const flavorB = buildBomFromDtools(loadJson('Reference/MaricopaApproved.json'), flavorA.laborMeta);
  for (const line of flavorB.log) console.log(`  ${line}`);
  check('B total price vs root', flavorB.totals.totalPrice, flavorB.totals.rootPriceWithoutTax, 1.0);
  check('B total cost vs root', flavorB.totals.totalCost, flavorB.totals.rootCost, 1.0);
  console.log(`  unattributed labor: $${flavorB.totals.unattributedLaborCost} / $${flavorB.totals.unattributedLaborPrice}`);
  if (!flavorB.totals.verified) failures++;
  console.log(`  verified flag: ${flavorB.totals.verified}`);
}

// ── Change order fixture: AVCO-4 on Maricopa Dunlap ─────────────────────────
// A negative (credit) CO containing one Added line and four Removed lines —
// exercises the deletion representation end to end.
{
  console.log('\n=== Change Order AVCO-4 (Maricopa Dunlap) ===');
  const parent = loadJson('Reference/MaricopaDunlapID.json');
  const co = loadJson('Reference/MaricopaCO-AVCO-4.json');
  const result = buildChangeOrderItems(co?.Project ?? co, parent?.Project ?? parent);
  for (const line of result.log) console.log(`  ${line}`);

  check('CO net price', result.priceDelta, -7384.43);
  check('CO net cost', result.costDelta, -5067.43, 0.02);
  check('CO net hours', result.hoursDelta, -6);
  check('CO root price match', result.priceDelta, result.rootPrice);

  const added = result.items.filter(i => i.change_type === 'Added').length;
  const removed = result.items.filter(i => i.change_type === 'Removed').length;
  const typesOk = added === 1 && removed === 4;
  if (!typesOk) failures++;
  console.log(`  ${typesOk ? 'PASS' : 'FAIL'}  change types: ${added} Added / ${removed} Removed (expected 1 / 4)`);
  if (!result.verified) failures++;
  console.log(`  verified flag: ${result.verified}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
