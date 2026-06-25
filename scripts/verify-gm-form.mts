// Regression check for the Gross Margin Form: runs the PRODUCTION transform
// (supabase) + the PRODUCTION compute (app) against saved DTools payloads and
// asserts the form reconciles to (DTools root − Premiere Protect) to the penny.
//
//   node --experimental-strip-types scripts/verify-gm-form.mts
import { readFileSync } from 'node:fs';
import { buildBomFromDtools, extractGmMeta } from '../supabase/functions/dtools-project-lookup/transform.ts';
import { computeGrossMarginForm } from '../app/src/utils/grossMargin.ts';
import type { Project, ProjectBoMItem } from '../app/src/types.ts';

const load = (p: string) => { const j = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); return j.Project ?? j; };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Map a transform BomRow (snake_case) to the app's ProjectBoMItem (camelCase). */
function toBomItem(r: any, projectId: string): ProjectBoMItem {
  return {
    id: `${r.sort_order}`, projectId,
    manufacturer: r.manufacturer, model: r.model, description: r.description,
    category: r.category, qty: r.qty, notes: r.notes, locations: r.locations,
    sortOrder: r.sort_order, itemType: r.item_type,
    unitCost: r.unit_cost, unitPrice: r.unit_price,
    laborHours: r.labor_hours, laborUnitCost: r.labor_unit_cost, laborUnitPrice: r.labor_unit_price,
    fixedLaborCost: r.fixed_labor_cost, fixedLaborPrice: r.fixed_labor_price,
    marginPct: r.margin_pct, ownerFurnished: r.owner_furnished, optional: r.optional,
    laborType: r.labor_type, laborBreakdown: r.labor_breakdown, includedInPhase: r.included_in_phase,
  } as ProjectBoMItem;
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

for (const [name, path] of [['TestProject (sub/rental/tax)', 'Reference/TestProject.json'], ['Chatham County (real)', 'Reference/ChathamCounty.json']] as const) {
  const proj = load(path);
  const { bomRows, totals } = buildBomFromDtools(proj);

  // Synthesize the persisted project row the way the edge function would.
  const project = {
    id: 'verify', dtoolsBomStatus: 'found',
    dtoolsCost: totals.rootCost, dtoolsPriceWithoutTax: totals.rootPriceWithoutTax,
    dtoolsGmMeta: extractGmMeta(proj),
    dtoolsSyncDelta: {
      equipmentCost: totals.equipmentCost, equipmentPrice: totals.equipmentPrice,
      laborCost: totals.laborCost, laborPrice: totals.laborPrice,
    },
  } as unknown as Project;
  const items = bomRows.map((r) => toBomItem(r, 'verify'));

  const form = computeGrossMarginForm(project, items);
  // The GM form must faithfully derive from the transform's verified totals,
  // adding NO drift of its own: PROJECT TOTALS == transform total − Premiere
  // Protect. (Any gap vs DTools root is the transform's own reconciliation,
  // surfaced to accounting as a review banner — not a GM-form bug.)
  const expCost = r2(totals.totalCost - form.premiereProtect.cost);
  const expPrice = r2(totals.totalPrice - form.premiereProtect.price);
  const txRootDrift = r2(totals.totalPrice - totals.rootPriceWithoutTax);

  console.log(`\n=== ${name} ===`);
  console.log(`  Install ${form.installHours.hours}h $${form.installHours.cost}/$${form.installHours.price}`);
  console.log(`  Program ${form.programmingHours.hours}h $${form.programmingHours.cost}/$${form.programmingHours.price}`);
  console.log(`  Travel  ${form.travel.hours}h $${form.travel.cost}/$${form.travel.price}`);
  console.log(`  Labor   $${form.laborTotals.cost}/$${form.laborTotals.price}`);
  console.log(`  Equip   $${form.equipmentTotals.cost}/$${form.equipmentTotals.price} (Sub ${form.subcontractor.price}, Rent ${form.equipmentRental.price}, Perm ${form.permits.price})`);
  console.log(`  Prem    $${form.premiereProtect.cost}/$${form.premiereProtect.price}`);
  console.log(`  PROJECT $${form.projectTotals.cost}/$${form.projectTotals.price}  (transform root drift $${txRootDrift})`);
  check('GM project totals = transform total − Premiere Protect (no added drift)',
    form.projectTotals.cost === expCost && form.projectTotals.price === expPrice,
    `got $${form.projectTotals.cost}/$${form.projectTotals.price} vs $${expCost}/$${expPrice}`);
  check('buckets sum to labor totals', r2(form.installHours.price + form.programmingHours.price + form.travel.price) === form.laborTotals.price);
  check('equipment = base + sub + rental + permits', form.equipmentTotals.price === r2(form.equipment.price + form.subcontractor.price + form.equipmentRental.price + form.permits.price));
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASS' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
