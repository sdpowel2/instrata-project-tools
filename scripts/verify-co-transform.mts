// Replay buildChangeOrderItems against a saved CO payload + its parent
// project payload (fetch both via the dtools-probe edge function:
// /Subscribe/Projects?id={parentId}&coNumber={N} and ?id={parentId}).
// First verified on AVCO-1 / AlphaDetect AV Upfit (26-SE-0092).
//
//   node scripts/verify-co-transform.mts <coJson> <parentJson>

import { readFileSync } from 'node:fs';
import { buildChangeOrderItems, buildBomFromDtools } from '../supabase/functions/dtools-project-lookup/transform.ts';

const [coPath, parentPath] = process.argv.slice(2);
const loadJson = (p: string) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

const coRaw = loadJson(coPath);
const parentRaw = loadJson(parentPath);
const co = coRaw?.Project ?? coRaw;
const parent = parentRaw?.Project ?? parentRaw;

const parentResult = buildBomFromDtools(parent);
const result = buildChangeOrderItems(co, parent, parentResult.laborMeta);

for (const line of result.log) console.log(line);
console.log('\nitems:');
for (const it of result.items) {
  console.log(`  [${it.change_type}] ${it.model}  qty=${it.qty}  equip=${(it.qty * it.unit_price).toFixed(2)}  laborH=${it.labor_hours}  labor$=${it.labor_price.toFixed(2)}`);
}
console.log(`\npriceDelta=${result.priceDelta}  costDelta=${result.costDelta}  hoursDelta=${result.hoursDelta}`);
console.log(`rootPrice=${result.rootPrice}  rootCost=${result.rootCost}`);
console.log(`CO root PriceWithoutTax=${co.PriceWithoutTax}  Tax=${co.Tax}`);
console.log(`verified=${result.verified}`);
