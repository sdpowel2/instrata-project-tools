// Gross Margin Form computation — pure, offline-testable (mirrors the approach
// of utils/reviewEngine.ts). Turns a synced project + its BoM into the
// auto-filled GM Form, then merges any manual per-field overrides on top.
//
// Business rules (verified against real DTools payloads — see
// scripts/verify-gm-form.mts):
//
//   • Labor buckets (summed hours / cost / price):
//       Install      = Cabling + Install + Finish + Mobilization
//       Programming  = Bench + Commissioning + Programming + Training + Engineering
//       Travel       = Travel
//     Labor Totals = the three buckets summed.
//
//   • The four special lines are matched by exact BoM Model (NOT labor type —
//     DTools carries them as fixed-cost LABOR with a real type like "Install",
//     so a labor-type sum would wrongly absorb them):
//       Subcontractor / Equipment Rental / Permits → moved into EQUIPMENT,
//         excluded from Labor entirely. Absent line ⇒ $0.
//       Premiere Protect → carved out of Labor, Equipment AND Project Totals;
//         shown only in Job Information.
//
//   • PROJECT TOTALS = Labor Totals + Equipment Totals = DTools root − Premiere
//     Protect. Headline totals are anchored to the transform's verified
//     equipment/labor split (projects.dtools_sync_delta) so they tie to the
//     penny; the three buckets are the supporting breakdown.

import type {
  Project, ProjectBoMItem, GrossMarginForm, GmAmount, GmMeta,
} from '../types';

export const INSTALL_LABOR_TYPES = ['Cabling', 'Install', 'Finish', 'Mobilization'];
export const PROGRAMMING_LABOR_TYPES = ['Bench', 'Commissioning', 'Programming', 'Training', 'Engineering'];
export const TRAVEL_LABOR_TYPES = ['Travel'];

export interface SpecialModels {
  subcontractor: string;
  equipmentRental: string;
  permits: string;
  premiereProtect: string;
}

export const DEFAULT_SPECIAL_MODELS: SpecialModels = {
  subcontractor: 'Subcontractor',
  equipmentRental: 'Equipment Rental',
  permits: 'Permits',
  premiereProtect: 'Premiere Protect',
};

const ANCHOR_TOLERANCE = 1.0; // dollars — matches the transform's own tolerance

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s: string) => s.trim().toLowerCase();

const EMPTY_META: GmMeta = {
  header: { quoteNumber: '', poNumber: '', salesRep: '', engineer: '', clientName: '', clientEmail: '', projectName: '', siteAddress: '', billingAddress: '' },
  custom: { subsidiary: '', branch: '', projectType: '', aiaInvoicing: '', prevailingWage: '', timeAndMaterials: '', materialOnly: '' },
  tax: { rate: 0, materialsTax: 0, laborTax: 0, total: 0 },
};

/** A BoM row's labor dollars — hour-based rows price at hours × rate; fixed
 *  rows (Subcontractor/Rental/Permits/Premiere Protect, Airfare, …) carry a
 *  flat amount. */
function rowLaborDollars(row: ProjectBoMItem): { cost: number; price: number } {
  if (row.laborHours > 0) {
    return { cost: r2(row.laborHours * row.laborUnitCost), price: r2(row.laborHours * row.laborUnitPrice) };
  }
  return { cost: r2(row.fixedLaborCost), price: r2(row.fixedLaborPrice) };
}

function bucketFor(type: string): 'install' | 'programming' | 'travel' | null {
  if (INSTALL_LABOR_TYPES.includes(type)) return 'install';
  if (PROGRAMMING_LABOR_TYPES.includes(type)) return 'programming';
  if (TRAVEL_LABOR_TYPES.includes(type)) return 'travel';
  return null;
}

/** Compute the auto-filled Gross Margin Form from a synced project + BoM. */
export function computeGrossMarginForm(
  project: Project,
  bomItems: ProjectBoMItem[],
  special: SpecialModels = DEFAULT_SPECIAL_MODELS,
): GrossMarginForm {
  const meta = project.dtoolsGmMeta ?? EMPTY_META;

  const specialKeys = {
    [norm(special.subcontractor)]: 'subcontractor',
    [norm(special.equipmentRental)]: 'equipmentRental',
    [norm(special.permits)]: 'permits',
    [norm(special.premiereProtect)]: 'premiereProtect',
  } as Record<string, 'subcontractor' | 'equipmentRental' | 'permits' | 'premiereProtect'>;

  const zero = (): GmAmount => ({ hours: 0, cost: 0, price: 0 });
  const buckets = { install: zero(), programming: zero(), travel: zero() };
  const specials = { subcontractor: zero(), equipmentRental: zero(), permits: zero(), premiereProtect: zero() };

  // Sum the bare equipment (product unit dollars) directly as a fallback for
  // projects synced before dtools_sync_delta existed.
  let prodEquipCost = 0, prodEquipPrice = 0;

  for (const row of bomItems) {
    const special = specialKeys[norm(row.model)];
    if (special) {
      const { cost, price } = rowLaborDollars(row);
      specials[special].cost = r2(specials[special].cost + cost);
      specials[special].price = r2(specials[special].price + price);
      continue;
    }

    if (row.itemType === 'Product') {
      prodEquipCost += r2(row.qty * row.unitCost);
      prodEquipPrice += r2(row.qty * row.unitPrice);
      // Attached labor, split by type into the display buckets.
      for (const e of row.laborBreakdown ?? []) {
        const b = bucketFor(e.type);
        if (!b) continue;
        buckets[b].hours = r2((buckets[b].hours ?? 0) + e.hours);
        buckets[b].cost = r2(buckets[b].cost + r2(e.hours * e.costRate));
        buckets[b].price = r2(buckets[b].price + r2(e.hours * e.priceRate));
      }
    } else {
      // Standalone labor row (companion / phase residual).
      const b = bucketFor(row.laborType);
      if (!b) continue; // non-bucketed labor (e.g. Premiere Protect type) — ignored here
      const { cost, price } = rowLaborDollars(row);
      buckets[b].hours = r2((buckets[b].hours ?? 0) + row.laborHours);
      buckets[b].cost = r2(buckets[b].cost + cost);
      buckets[b].price = r2(buckets[b].price + price);
    }
  }

  // ── Authoritative equipment & labor (penny-tied to DTools root) ───────────
  const delta = project.dtoolsSyncDelta;
  const equipBase = {
    cost: delta?.equipmentCost ?? r2(prodEquipCost),
    price: delta?.equipmentPrice ?? r2(prodEquipPrice),
  };
  const bucketSum: GmAmount = {
    hours: r2((buckets.install.hours ?? 0) + (buckets.programming.hours ?? 0) + (buckets.travel.hours ?? 0)),
    cost: r2(buckets.install.cost + buckets.programming.cost + buckets.travel.cost),
    price: r2(buckets.install.price + buckets.programming.price + buckets.travel.price),
  };
  const sp = specials.subcontractor, rn = specials.equipmentRental, pm = specials.permits, pp = specials.premiereProtect;
  // The transform folds Subcontractor/Rental/Permits/Premiere Protect into its
  // laborCost; the GM Form pulls them back out.
  const laborAll = {
    cost: delta?.laborCost ?? r2(bucketSum.cost + sp.cost + rn.cost + pm.cost + pp.cost),
    price: delta?.laborPrice ?? r2(bucketSum.price + sp.price + rn.price + pm.price + pp.price),
  };
  const laborTotals: GmAmount = {
    hours: bucketSum.hours,
    cost: r2(laborAll.cost - sp.cost - rn.cost - pm.cost - pp.cost),
    price: r2(laborAll.price - sp.price - rn.price - pm.price - pp.price),
  };

  // Reconcile the display buckets to the authoritative labor total: any
  // sub-dollar drift from per-type rounding lands on the largest bucket so the
  // three rows always sum to Labor Totals exactly.
  const residCost = r2(laborTotals.cost - bucketSum.cost);
  const residPrice = r2(laborTotals.price - bucketSum.price);
  const largest = (['install', 'programming', 'travel'] as const)
    .reduce((a, b) => (buckets[b].price >= buckets[a].price ? b : a), 'install');
  buckets[largest].cost = r2(buckets[largest].cost + residCost);
  buckets[largest].price = r2(buckets[largest].price + residPrice);

  const equipmentTotals: GmAmount = {
    cost: r2(equipBase.cost + sp.cost + rn.cost + pm.cost),
    price: r2(equipBase.price + sp.price + rn.price + pm.price),
  };
  const projectTotals: GmAmount = {
    cost: r2(laborTotals.cost + equipmentTotals.cost),
    price: r2(laborTotals.price + equipmentTotals.price),
  };

  // ── Penny-anchor: project totals should equal DTools root − Premiere Protect
  const rootCost = project.dtoolsCost;
  const rootPrice = project.dtoolsPriceWithoutTax;
  let verified = true;
  let drift = { cost: 0, price: 0 };
  if (rootCost != null && rootPrice != null) {
    drift = { cost: r2(projectTotals.cost - (rootCost - pp.cost)), price: r2(projectTotals.price - (rootPrice - pp.price)) };
    verified = Math.abs(drift.cost) <= ANCHOR_TOLERANCE && Math.abs(drift.price) <= ANCHOR_TOLERANCE;
  }

  return {
    installHours: buckets.install,
    programmingHours: buckets.programming,
    travel: buckets.travel,
    laborTotals,
    equipment: equipBase,
    subcontractor: { cost: sp.cost, price: sp.price },
    equipmentRental: { cost: rn.cost, price: rn.price },
    permits: { cost: pm.cost, price: pm.price },
    equipmentTotals,
    projectTotals,
    premiereProtect: { cost: pp.cost, price: pp.price },
    tax: { rate: meta.tax.rate, materialsTax: meta.tax.materialsTax, laborTax: meta.tax.laborTax },
    header: { ...meta.header },
    custom: { ...meta.custom },
    verified,
    drift,
  };
}

/** Recompute the derived totals (Labor / Equipment / Project) and the
 *  penny-anchor verdict after components have been edited. The three labor
 *  buckets, the equipment base, the special lines and Premiere Protect are the
 *  editable inputs; the totals always follow so the form stays internally
 *  consistent (what accounting requires) no matter how numbers are nudged. */
export function recomputeForm(form: GrossMarginForm, project: Project): GrossMarginForm {
  const laborTotals: GmAmount = {
    hours: r2((form.installHours.hours ?? 0) + (form.programmingHours.hours ?? 0) + (form.travel.hours ?? 0)),
    cost: r2(form.installHours.cost + form.programmingHours.cost + form.travel.cost),
    price: r2(form.installHours.price + form.programmingHours.price + form.travel.price),
  };
  const equipmentTotals: GmAmount = {
    cost: r2(form.equipment.cost + form.subcontractor.cost + form.equipmentRental.cost + form.permits.cost),
    price: r2(form.equipment.price + form.subcontractor.price + form.equipmentRental.price + form.permits.price),
  };
  const projectTotals: GmAmount = {
    cost: r2(laborTotals.cost + equipmentTotals.cost),
    price: r2(laborTotals.price + equipmentTotals.price),
  };
  let verified = true;
  let drift = { cost: 0, price: 0 };
  if (project.dtoolsCost != null && project.dtoolsPriceWithoutTax != null) {
    drift = {
      cost: r2(projectTotals.cost - (project.dtoolsCost - form.premiereProtect.cost)),
      price: r2(projectTotals.price - (project.dtoolsPriceWithoutTax - form.premiereProtect.price)),
    };
    verified = Math.abs(drift.cost) <= ANCHOR_TOLERANCE && Math.abs(drift.price) <= ANCHOR_TOLERANCE;
  }
  return { ...form, laborTotals, equipmentTotals, projectTotals, verified, drift };
}

// ── Override merge ─────────────────────────────────────────────────────────
// Overrides are stored as flat dotted paths ("installHours.cost",
// "header.salesRep", "tax.rate") so the edit UI can address any field.

/** Read a dotted path off the computed form. */
export function getFormValue(form: GrossMarginForm, path: string): number | string | undefined {
  let o: unknown = form;
  for (const k of path.split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o as number | string | undefined;
}

/** Return a copy of the form with stored overrides applied. Recomputes the
 *  derived totals so an edited bucket flows into Labor/Project Totals unless
 *  those totals were themselves overridden. */
export function mergeOverrides(
  base: GrossMarginForm,
  overrides: Record<string, number | string> | undefined,
): GrossMarginForm {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const form: GrossMarginForm = structuredClone(base);
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let o: Record<string, unknown> = form as unknown as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) o = o?.[keys[i]] as Record<string, unknown>;
    if (o && keys[keys.length - 1] in o) o[keys[keys.length - 1]] = value;
  }
  return form;
}

/** Which dotted paths have an active override (for the "edited" indicator). */
export function overriddenPaths(overrides: Record<string, number | string> | undefined): Set<string> {
  return new Set(Object.keys(overrides ?? {}));
}
