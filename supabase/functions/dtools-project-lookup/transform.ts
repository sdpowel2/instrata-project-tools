// Pure DTools → BoM transform. No Deno/Node APIs so the exact production
// logic can be replayed offline against saved payloads
// (scripts/verify-dtools-sync.mts) before/after any change.
//
// Input is the SINGLE unaggregated fetch (GET /Subscribe/Projects?id=…).
// Aggregated fetches (aggregateBy=Location/Item) return rows with EMPTY
// ItemLaborTypes, so they cannot price labor; the unaggregated rows carry
// LocationId themselves, which gives per-location quantities for free.
//
// ── DTools publishes TWO payload flavors (discovered 2026-06-11) ────────────
//
// PRICED ("flavor A", pre-approval publishes): phase rollup rows carry the
//   $/hr rates (UnitCost/UnitPrice) and RAW hours, including hours converted
//   from rolled-up fixed-price companion labor (e.g. Airfare → Travel hours).
//
// ZERO-PRICED ("flavor B", seen after approval/CO publishing): phase rows
//   have UnitCost = UnitPrice = 0 and ADJUSTED hours (raw × per-type hour
//   adjustment, e.g. 1.03), with converted companion hours EXCLUDED. The
//   rates are simply gone from the payload — labor dollars exist only inside
//   item InstallPrice embeddings and the root totals.
//
// To price flavor B we persist a LaborMeta snapshot (rates + adjustment
// factors + raw phase hours) whenever we see flavor A, and fall back to
// deriving price rates from item InstallPrice deltas when no snapshot
// exists. Any residue that still can't be attributed lands on an explicit
// "unattributed" labor line anchored to the root totals — never silently
// dropped, never silently invented.
//
// Pricing model (verified to the penny against Ak Chin, Brooklyn, Maricopa):
//   Equipment line price = round2(qty × UnitPrice); cost analog.
//   Product labor        = qty × Σ(ItemLaborTypes.Hours × rate(type)).
//   Phase rollup (A)     = Σ(item hours) + manual + converted companions.
//   Phase rollup (B)     = (Σ item hours + manual) × adjFactor, rates zeroed.

export interface LaborBreakdownEntry {
  type: string;
  hours: number;       // RAW hours for this BoM line (pricing basis)
  totalHours: number;  // DTools display hours (raw × per-type adjustment)
  costRate: number;
  priceRate: number;
}

export interface LaborRate { costPerHour: number; pricePerHour: number; }

/** Persisted per-project labor knowledge, captured from priced (flavor A)
 *  payloads and reused to price zero-priced (flavor B) payloads. */
export interface LaborMeta {
  /** type → $/hr (cost & price), from flavor-A phase rows */
  rates: Record<string, { cost: number; price: number }>;
  /** type → hour-adjustment factor (TotalHours ÷ raw hours), from items */
  factors: Record<string, number>;
  /** type → RAW phase hours excluding converted companion hours */
  phaseRaw: Record<string, number>;
}

export interface BomRow {
  manufacturer: string;
  model: string;
  description: string;
  category: string;
  qty: number;
  notes: string;
  locations: { room: string; qty: number }[];
  sort_order: number;
  item_type: string;
  unit_cost: number;
  unit_price: number;
  labor_hours: number;      // LINE-total hours (products: attached labor;
                            // phase residual rows: the manual hours)
  labor_unit_cost: number;  // blended $/hr for the line
  labor_unit_price: number;
  fixed_labor_cost: number; // fixed-dollar labor lines (companions)
  fixed_labor_price: number;
  margin_pct: number;
  owner_furnished: boolean;
  optional: boolean;
  priced_from: string | null;
  labor_type: string;
  labor_breakdown: LaborBreakdownEntry[];
  included_in_phase: boolean;
}

export interface SyncTotals {
  // Headline numbers. On priced payloads these follow DTools' own row
  // convention (Σ round2 per row; labor minus rolled-up echo lines) and
  // reproduce the DTools UI to the penny. On zero-priced payloads they are
  // reconstructed from components and anchored to the root fields via the
  // unattributed adjustment.
  equipmentCost: number;
  equipmentPrice: number;
  laborCost: number;
  laborPrice: number;
  totalCost: number;
  totalPrice: number;
  // Sums over the BoM rows we actually store (table-footer truth).
  rowSumCost: number;
  rowSumPrice: number;
  // Root fields straight from DTools (authoritative)
  rootCost: number;
  rootPriceWithoutTax: number;
  rootTax: number;
  rootPrice: number;
  rootHours: number;
  costDelta: number;    // totalCost − rootCost
  priceDelta: number;   // totalPrice − rootPriceWithoutTax
  rowCostDelta: number; // rowSumCost − totalCost
  rowPriceDelta: number;// rowSumPrice − totalPrice
  verified: boolean;
  echoModels: string[]; // companion labor lines DTools rolled into a phase
  /** Labor dollars we could not attribute to a line (zero-priced payloads
   *  with incomplete rate knowledge / DTools hour drift). Carried on an
   *  explicit BoM line so totals stay anchored to root. */
  unattributedLaborCost: number;
  unattributedLaborPrice: number;
}

export type PayloadFlavor = 'priced' | 'zeroPriced';

export interface TransformResult {
  bomRows: BomRow[];
  totals: SyncTotals;
  log: string[];
  payloadFlavor: PayloadFlavor;
  /** Fresh meta on priced payloads; the passed-in prior meta otherwise. */
  laborMeta: LaborMeta | null;
}

const VERIFY_TOLERANCE = 1.0; // dollars; expected drift is per-line rounding cents

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function mapCategory(cat?: string): string {
  if (!cat) return 'Other';
  const c = cat.toLowerCase();
  if (c.includes('display') || c.includes('monitor') || c.includes('screen') || c.includes('projector')) return 'Display';
  if (c.includes('audio') || c.includes('speaker') || c.includes('microphone') || c.includes('amplifier') || c.includes('dsp')) return 'Audio';
  if (c.includes('control') || c.includes('processor') || c.includes('switcher') || c.includes('matrix')) return 'Control';
  if (c.includes('network') || c.includes('switch') || c.includes('router') || c.includes('wireless')) return 'Networking';
  if (c.includes('cable') || c.includes('wire') || c.includes('connector') || c.includes('adapter')) return 'Cabling';
  return 'Other';
}

function extractPricedFrom(item: any): string {
  const candidates: any[] = [];
  if (Array.isArray(item?.CustomFields)) candidates.push(...item.CustomFields);
  if (Array.isArray(item?.ItemCustomFields)) candidates.push(...item.ItemCustomFields);
  for (const cf of candidates) {
    const id = String(cf?.Id ?? cf?.id ?? '');
    const name = String(cf?.Name ?? cf?.name ?? '').toLowerCase();
    if (id === '1' || name === 'priced from' || name === 'pricedfrom') {
      const v = cf?.Value ?? cf?.value;
      return v ? String(v).trim() : '';
    }
  }
  const flat = item?.CustomField1 ?? item?.customField1 ?? item?.PricedFrom ?? item?.pricedFrom;
  return flat ? String(flat).trim() : '';
}

/** Find which companion labor lines DTools rolled into phase rollups
 *  (priced payloads only — zero-priced payloads drop the conversion).
 *
 * The JSON gives no per-row discriminator (verified: rolled-up "Airfare" and
 * standalone "Hotel" are field-for-field identical), so we derive it from the
 * totals: authoritative labor price = PriceWithoutTax − equipment price; the
 * naive labor sum overshoots it by exactly the rolled-up companions' line
 * totals. Find the companion subset matching that overshoot (singles, then
 * pairs, then triples — rolled-up companions are rare).
 */
function detectEchoCompanions(
  companions: { idx: number; lineTotal: number }[],
  overshoot: number,
  tolerance: number,
  log: string[],
): Set<number> {
  const result = new Set<number>();
  if (overshoot <= tolerance) return result; // nothing rolled up

  const n = companions.length;
  const within = (sum: number) => Math.abs(sum - overshoot) <= tolerance;

  for (let i = 0; i < n; i++) {
    if (within(companions[i].lineTotal)) return new Set([companions[i].idx]);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (within(companions[i].lineTotal + companions[j].lineTotal)) {
        return new Set([companions[i].idx, companions[j].idx]);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        if (within(companions[i].lineTotal + companions[j].lineTotal + companions[k].lineTotal)) {
          return new Set([companions[i].idx, companions[j].idx, companions[k].idx]);
        }
      }
    }
  }
  log.push(`[transform] WARNING: labor overshoot $${overshoot.toFixed(2)} matched no companion subset — leaving all companions standalone (totals will overshoot)`);
  return result;
}

/** Labor rates from a project's phase rollup rows (priced payloads). */
export function extractLaborRates(project: any): Map<string, LaborRate> {
  const rates = new Map<string, LaborRate>();
  for (const i of project?.Items ?? []) {
    if (i.TypeId != 2 || i.LaborType !== 'Phase') continue;
    const typeName = String(i.Model ?? '').trim();
    if (!typeName) continue;
    const cost = num(i.UnitCost);
    const price = num(i.UnitPrice);
    if ((cost > 0 || price > 0) && !rates.has(typeName)) {
      rates.set(typeName, { costPerHour: cost, pricePerHour: price });
    }
  }
  return rates;
}

/** Per-type hour-adjustment factor from items: Σ TotalHours ÷ Σ raw hours. */
function factorsFromItems(items: any[]): Map<string, number> {
  const raw = new Map<string, number>();
  const adj = new Map<string, number>();
  for (const it of items) {
    if (it.TypeId == 2) continue;
    for (const lt of it.ItemLaborTypes ?? []) {
      const name = String(lt.Name ?? '').trim();
      const hours = num(it.Quantity) * num(lt.Hours);
      const total = num(lt.TotalHours);
      if (!name || hours <= 0 || total <= 0) continue;
      raw.set(name, (raw.get(name) ?? 0) + hours);
      adj.set(name, (adj.get(name) ?? 0) + total);
    }
  }
  const factors = new Map<string, number>();
  for (const [name, r] of raw) {
    const a = adj.get(name) ?? 0;
    if (r > 0 && a > 0) factors.set(name, round6(a / r));
  }
  return factors;
}

/** Derive a type's price $/hr from items: InstallPrice embeds attached labor
 *  (delta = qty × rawHours × priceRate). Only single-labor-type items give an
 *  unambiguous read; we take the median across them. Cost rates are NOT
 *  derivable this way (no cost-side InstallPrice equivalent exists). */
function derivePriceRatesFromItems(items: any[], log: string[]): Map<string, number> {
  const samples = new Map<string, number[]>();
  for (const it of items) {
    if (it.TypeId == 2) continue;
    const ilt = (it.ItemLaborTypes ?? []).filter((lt: any) => num(lt.Hours) > 0);
    if (ilt.length !== 1) continue;
    const name = String(ilt[0].Name ?? '').trim();
    const qty = num(it.Quantity);
    const hours = qty * num(ilt[0].Hours);
    if (!name || hours <= 0) continue;
    const delta = num(it.InstallPrice) - round2(qty * num(it.UnitPrice));
    if (delta <= 0) continue;
    const rate = delta / hours;
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name)!.push(rate);
  }
  const rates = new Map<string, number>();
  for (const [name, list] of samples) {
    list.sort((a, b) => a - b);
    rates.set(name, round6(list[Math.floor(list.length / 2)]));
  }
  if (rates.size > 0) {
    log.push(`[transform] Derived price rates from item InstallPrice deltas: ${Array.from(rates.entries()).map(([k, v]) => `${k}=$${round2(v)}`).join(', ')}`);
  }
  return rates;
}

// ─── Change Orders ────────────────────────────────────────────────────────────
//
// A published CO payload (GET ?id={parentId}&coNumber={CONumber}) is a small
// project whose items carry COChangeTypeId: 1 = Added, 2 = Removed (same item
// with NEGATED unit cost/price/hours and positive Qty), 3 = presumed Modified
// (no example yet). Root Price/Cost/PriceWithoutTax are the CO's NET signed
// delta. Root Hours echoes the PARENT project — ignore it.
// Verified on AVCO-4: Σ item lines + (net raw hours × parent rate) equals the
// CO root Price exactly; cost within 1¢.
//
// Phase rollup rows in a CO mirror the parent payload's two flavors
// (AVCO-1 on AlphaDetect 2026-06-11 arrived PRICED): each carries the type's
// total CO hours — item-attached hours PLUS any manual hours added directly
// to the phase. The item-attached share is an echo of ItemLaborTypes (already
// priced on the item lines); the residual is real labor-only work that must
// become its own line or the CO under-counts. Lines sum to the CO's
// PriceWithoutTax; root Price additionally includes Tax.

export interface CoItemRow {
  change_type: 'Added' | 'Removed' | 'Adjusted' | 'Other';
  manufacturer: string;
  model: string;
  description: string;
  qty: number;
  unit_cost: number;   // signed, as DTools publishes them
  unit_price: number;
  /** 'Labor' for located labor items and phase residuals — their dollars
   *  belong in the Labor column even when carried in unit_price. */
  item_type: 'Product' | 'Labor';
  /** Room name resolved from the CO payload's own Locations map; '' when the
   *  row has no LocationId (phase rollups, residual labor lines). */
  location: string;
  labor_hours: number; // signed line-total raw hours
  labor_cost: number;  // signed line dollars at parent rates
  labor_price: number;
  labor_breakdown: LaborBreakdownEntry[];
  sort_order: number;
}

export interface CoTransformResult {
  items: CoItemRow[];
  costDelta: number;   // our derived net cost
  priceDelta: number;  // our derived net price (pre-tax, like the lines)
  hoursDelta: number;  // net signed raw labor hours
  rootCost: number;    // CO payload's own (authoritative) net numbers
  rootPrice: number;   // tax-inclusive grand total
  rootPriceWithoutTax: number;
  rootTax: number;
  verified: boolean;
  log: string[];
}

function mapCoChangeType(id: any): CoItemRow['change_type'] {
  const n = Number(id);
  if (n === 1) return 'Added';
  if (n === 2) return 'Removed';
  if (n === 3) return 'Adjusted';
  return 'Other';
}

/** Assemble the rate lookup for a CO: live parent phase rows first, then the
 *  persisted meta, then item-derived price rates from the parent. */
function coRateLookup(parentProject: any, priorMeta: LaborMeta | null, log: string[]): Map<string, LaborRate> {
  const rates = extractLaborRates(parentProject);
  if (priorMeta) {
    for (const [name, r] of Object.entries(priorMeta.rates)) {
      if (!rates.has(name)) rates.set(name, { costPerHour: r.cost, pricePerHour: r.price });
    }
  }
  const derived = derivePriceRatesFromItems(parentProject?.Items ?? [], log);
  for (const [name, price] of derived) {
    if (!rates.has(name)) rates.set(name, { costPerHour: 0, pricePerHour: price });
  }
  return rates;
}

/**
 * Transform a published CO payload into signed delta lines + verified totals.
 *
 * @param coProject      the CO payload (IsChangeOrder=true)
 * @param parentProject  the parent project payload — labor-rate source
 * @param priorMeta      persisted LaborMeta for zero-priced parents
 */
export function buildChangeOrderItems(coProject: any, parentProject: any, priorMeta: LaborMeta | null = null): CoTransformResult {
  const log: string[] = [];
  const rates = coRateLookup(parentProject, priorMeta, log);
  const coNumber = String(coProject?.CONumber ?? '').trim();

  // CO payloads carry their own Locations map (including rooms the CO itself
  // introduces, e.g. a new lobby display location) — resolve per-item rooms
  // from it so the UI can show where each delta lands in the BoM.
  const coLocationMap = new Map<string, string>();
  for (const loc of coProject?.Locations ?? []) {
    coLocationMap.set(String(loc.Id), loc.FullName || loc.Name || String(loc.Id));
  }
  const coLocName = (item: any): string =>
    item.LocationId ? (coLocationMap.get(String(item.LocationId)) ?? String(item.LocationId)) : '';

  const items: CoItemRow[] = [];
  let costDelta = 0, priceDelta = 0, hoursDelta = 0, sort = 0;

  const coItems: any[] = coProject?.Items ?? [];
  const phaseRows = coItems.filter((i) => i.TypeId == 2 && i.LaborType === 'Phase');
  // Item-attached hours per type — the echo share of each phase rollup.
  // Counted regardless of rate availability: attached hours are never
  // labor-only work, even when we can't price them.
  const itemHoursByType = new Map<string, number>();

  for (const it of coItems) {
    if (it.TypeId == 2 && it.LaborType === 'Phase') continue; // handled after the loop
    for (const lt of it.ItemLaborTypes ?? []) {
      const typeName = String(lt.Name ?? '').trim();
      if (!typeName) continue;
      itemHoursByType.set(typeName, (itemHoursByType.get(typeName) ?? 0) + num(it.Quantity) * num(lt.Hours));
    }
    const qty = num(it.Quantity);
    const unitCost = num(it.UnitCost);
    const unitPrice = num(it.UnitPrice);
    const lineCost = round2(qty * unitCost);
    const linePrice = round2(qty * unitPrice);

    // Located labor items (TypeId 2 — SI's "send labor items as individual"
    // setting) carry their dollars on the line itself (qty × unit price);
    // their ItemLaborTypes hours are the same labor, NOT extra — count the
    // hours, never price them, or the CO double-counts.
    const isLaborItem = it.TypeId == 2;

    let laborHours = 0, laborCost = 0, laborPrice = 0;
    const breakdown: LaborBreakdownEntry[] = [];
    for (const lt of it.ItemLaborTypes ?? []) {
      const typeName = String(lt.Name ?? '').trim();
      const hours = num(lt.Hours); // signed on removals
      if (!typeName || hours === 0) continue;
      if (isLaborItem) {
        // Labor items publish Hours as the LINE-total raw hours (qty is the
        // adjusted hours) — no qty multiplication.
        laborHours += hours;
        breakdown.push({
          type: typeName,
          hours: round6(hours),
          totalHours: round6(num(lt.TotalHours)),
          costRate: round6(hours !== 0 ? lineCost / hours : 0),
          priceRate: round6(hours !== 0 ? linePrice / hours : 0),
        });
        continue;
      }
      const lineHours = qty * hours;
      const rate = rates.get(typeName);
      if (!rate) {
        log.push(`[transform] WARNING: CO ${coNumber} item "${it.Model}" has labor type "${typeName}" with no known rate — labor unpriced`);
        continue;
      }
      laborHours += lineHours;
      laborCost += lineHours * rate.costPerHour;
      laborPrice += lineHours * rate.pricePerHour;
      breakdown.push({
        type: typeName,
        hours: round6(lineHours),
        totalHours: round6(num(lt.TotalHours)),
        costRate: rate.costPerHour,
        priceRate: rate.pricePerHour,
      });
    }

    items.push({
      change_type: mapCoChangeType(it.COChangeTypeId),
      manufacturer: it.Manufacturer || '',
      model: it.Model || '',
      description: it.Description || '',
      qty,
      unit_cost: unitCost,
      unit_price: unitPrice,
      item_type: isLaborItem ? 'Labor' : 'Product',
      location: coLocName(it),
      labor_hours: round6(laborHours),
      labor_cost: round2(laborCost),
      labor_price: round2(laborPrice),
      labor_breakdown: breakdown,
      sort_order: sort++,
    });

    costDelta += lineCost + round2(laborCost);
    priceDelta += linePrice + round2(laborPrice);
    hoursDelta += laborHours;
  }

  // ── Phase rollups: split echo share from labor-only residual ──────────────
  // The item-attached share is already priced on the lines above; any
  // remaining hours are manual labor-only work that needs its own line.
  // Zero-priced CO payloads carry ADJUSTED phase hours (same as the parent
  // flavor) — un-adjust with the per-type factor before differencing.
  const coZeroPriced =
    phaseRows.length > 0 && phaseRows.every((p) => num(p.UnitPrice) === 0 && num(p.UnitCost) === 0);
  const coFactors = factorsFromItems(coItems);
  for (const p of phaseRows) {
    const typeName = String(p.Model ?? '').trim();
    if (!typeName) continue;
    let phaseHours = num(p.Quantity);
    if (coZeroPriced) {
      const factor = coFactors.get(typeName) ?? (priorMeta?.factors?.[typeName] ?? 1);
      phaseHours = phaseHours / (factor > 0 ? factor : 1);
    }
    const residual = round6(phaseHours - (itemHoursByType.get(typeName) ?? 0));
    if (Math.abs(residual) <= 0.01) continue; // pure echo of item-attached hours
    // Priced CO phase rows carry the rates themselves; fall back to parent.
    const own: LaborRate = { costPerHour: num(p.UnitCost), pricePerHour: num(p.UnitPrice) };
    const rate = own.costPerHour > 0 || own.pricePerHour > 0 ? own : rates.get(typeName);
    if (!rate) {
      log.push(`[transform] WARNING: CO ${coNumber} has ${residual}h labor-only "${typeName}" with no known rate — labor unpriced`);
      continue;
    }
    const laborCost = round2(residual * rate.costPerHour);
    const laborPrice = round2(residual * rate.pricePerHour);
    items.push({
      change_type: residual > 0 ? 'Added' : 'Removed',
      manufacturer: '',
      model: `${typeName} Labor`,
      description: String(p.Description ?? '').trim() || `${typeName} labor (hours not attached to items)`,
      qty: Math.abs(residual),
      unit_cost: 0,
      unit_price: 0,
      item_type: 'Labor',
      location: coLocName(p),
      labor_hours: residual,
      labor_cost: laborCost,
      labor_price: laborPrice,
      labor_breakdown: [{
        type: typeName,
        hours: residual,
        totalHours: round6(num(p.TotalHours)),
        costRate: rate.costPerHour,
        priceRate: rate.pricePerHour,
      }],
      sort_order: sort++,
    });
    costDelta += laborCost;
    priceDelta += laborPrice;
    hoursDelta += residual;
    log.push(`[transform] CO ${coNumber}: labor-only residual ${residual}h "${typeName}" → $${laborCost}/$${laborPrice}`);
  }

  costDelta = round2(costDelta);
  priceDelta = round2(priceDelta);
  hoursDelta = round6(hoursDelta);

  const rootCost = num(coProject?.Cost);
  const rootPrice = num(coProject?.Price);
  // Lines are pre-tax, so reconcile against PriceWithoutTax; root Price adds
  // Tax on top (older payloads without the field: Price IS pre-tax).
  const rootPriceWithoutTax =
    coProject?.PriceWithoutTax != null ? num(coProject.PriceWithoutTax) : rootPrice;
  const rootTax = num(coProject?.Tax);
  const verified =
    Math.abs(priceDelta - rootPriceWithoutTax) <= VERIFY_TOLERANCE &&
    Math.abs(costDelta - rootCost) <= VERIFY_TOLERANCE;

  log.push(`[transform] CO ${coNumber}: ${items.length} lines, Δ $${costDelta}/$${priceDelta} (${hoursDelta}h) vs root $${rootCost}/$${rootPriceWithoutTax} (+$${rootTax} tax = $${rootPrice}) → ${verified ? 'VERIFIED' : 'MISMATCH'}`);

  return { items, costDelta, priceDelta, hoursDelta, rootCost, rootPrice, rootPriceWithoutTax, rootTax, verified, log };
}

// ─── Gross Margin Form metadata ────────────────────────────────────────────────
//
// Project-level fields the GM Form needs that don't already live on the
// projects row / project_bom_items. Pure extraction so it can be replayed
// offline against saved payloads. Field map verified against real payloads
// (ChathamCounty.json, TestProject.json):
//   Subsidiary=CustomField27, Branch=CustomField28, Project Type=CustomField29,
//   AIA Invoicing=CustomField1, Prevailing Wage=CustomField30,
//   T&M?=CustomField23, Material Only?=CustomField24.
//   Tax split from Taxes[]: ProductTotal→materials, LaborTotal→labor.
//   Engineer←Designer (fallback AssignedTo). Quote#←Number, PO←ClientPONumber.

export interface GmMeta {
  header: {
    quoteNumber: string;
    poNumber: string;
    salesRep: string;
    engineer: string;
    clientName: string;
    clientEmail: string;
    projectName: string;
    siteAddress: string;
    billingAddress: string;
  };
  custom: {
    subsidiary: string;
    branch: string;
    projectType: string;
    aiaInvoicing: string;       // Yes/No
    prevailingWage: string;     // Yes/No
    timeAndMaterials: string;   // Yes/No
    materialOnly: string;       // Yes/No
  };
  tax: {
    rate: number;          // fractional, e.g. 0.0725
    materialsTax: number;  // Σ Taxes[].ProductTotal
    laborTax: number;      // Σ Taxes[].LaborTotal
    total: number;         // root Tax
  };
}

/** Read a project-level DTools custom field by numeric id, tolerating both the
 *  array shape ({Id,Name,Value}) and the flat-key shape (CustomField27). */
function projectCustomField(p: any, id: number, ...names: string[]): unknown {
  const candidates: any[] = [];
  if (Array.isArray(p?.CustomFields)) candidates.push(...p.CustomFields);
  if (Array.isArray(p?.ProjectCustomFields)) candidates.push(...p.ProjectCustomFields);
  for (const cf of candidates) {
    const cid = String(cf?.Id ?? cf?.id ?? '');
    const nm = String(cf?.Name ?? cf?.name ?? '').toLowerCase();
    if (cid === String(id) || names.includes(nm)) return cf?.Value ?? cf?.value;
  }
  return p?.[`CustomField${id}`] ?? p?.[`customField${id}`];
}

/** Normalise a DTools boolean/string custom field to a Yes/No display string. */
function yesNo(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v ?? '').trim();
  if (s === '') return '';
  if (/^(true|1)$/i.test(s)) return 'Yes';
  if (/^(false|0)$/i.test(s)) return 'No';
  return s; // already 'Yes'/'No' or other free text
}

/** Join a DTools address object into one line, including Suite (Street2). */
function gmJoinAddress(addr: any): string {
  if (!addr || typeof addr !== 'object') return typeof addr === 'string' ? addr.trim() : '';
  const line1 = [addr.Street1 ?? addr.street1, addr.Street2 ?? addr.street2]
    .filter((p) => typeof p === 'string' && p.trim()).join(' ');
  const cityLine = [addr.City ?? addr.city, addr.State ?? addr.state, addr.PostalCode ?? addr.postalCode]
    .filter((p) => typeof p === 'string' && p.trim()).join(', ');
  return [line1, cityLine].filter((p) => p.trim()).join(', ');
}

function firstContactEmail(p: any): string {
  for (const c of p?.Contacts ?? []) {
    const e = c?.Email ?? c?.email ?? c?.EmailAddress;
    if (e && String(e).trim()) return String(e).trim();
  }
  return '';
}

export function extractGmMeta(project: any): GmMeta {
  const taxes: any[] = Array.isArray(project?.Taxes) ? project.Taxes : [];
  const materialsTax = round2(taxes.reduce((s, t) => s + num(t?.ProductTotal), 0));
  const laborTax = round2(taxes.reduce((s, t) => s + num(t?.LaborTotal), 0));
  const rate = taxes.length > 0 ? num(taxes[0]?.Rate) : 0;

  return {
    header: {
      quoteNumber: String(project?.Number ?? '').trim(),
      poNumber: String(project?.ClientPONumber ?? '').trim(),
      salesRep: String(project?.SalesRep ?? '').trim(),
      engineer: String(project?.Designer ?? project?.AssignedTo ?? '').trim(),
      clientName: String(project?.Client ?? '').trim(),
      clientEmail: firstContactEmail(project),
      projectName: String(project?.Name ?? '').trim(),
      siteAddress: gmJoinAddress(project?.SiteAddress),
      billingAddress: gmJoinAddress(project?.BillingAddress),
    },
    custom: {
      subsidiary: String(projectCustomField(project, 27, 'subsidiary') ?? '').trim(),
      branch: String(projectCustomField(project, 28, 'branch') ?? '').trim(),
      projectType: String(projectCustomField(project, 29, 'project type', 'projecttype') ?? '').trim(),
      aiaInvoicing: yesNo(projectCustomField(project, 1, 'aia invoicing required', 'aia')),
      prevailingWage: yesNo(projectCustomField(project, 30, 'prevailing wage')),
      timeAndMaterials: yesNo(projectCustomField(project, 23, 't&m?', 't&m', 'time and materials')),
      materialOnly: yesNo(projectCustomField(project, 24, 'material only?', 'material only')),
    },
    tax: { rate, materialsTax, laborTax, total: round2(num(project?.Tax)) },
  };
}

// ─── Main BoM transform ──────────────────────────────────────────────────────

/** Build BoM rows + verified totals from the unaggregated DTools project.
 *  @param priorMeta  persisted LaborMeta from an earlier priced payload —
 *                    required to fully price zero-priced (post-approval)
 *                    payloads. */
export function buildBomFromDtools(fullProject: any, priorMeta: LaborMeta | null = null): TransformResult {
  const log: string[] = [];
  const fullItems: any[] = fullProject?.Items ?? [];
  const locations: any[] = fullProject?.Locations ?? [];

  const locationMap = new Map<string, string>();
  for (const loc of locations) locationMap.set(String(loc.Id), loc.FullName || loc.Name || String(loc.Id));
  const locName = (item: any): string =>
    item.LocationId ? (locationMap.get(String(item.LocationId)) ?? String(item.LocationId)) : '';

  // ── Flavor detection + labor rates ────────────────────────────────────────
  const phaseRows = fullItems.filter((i) => i.TypeId == 2 && i.LaborType === 'Phase');
  const flavor: PayloadFlavor =
    phaseRows.length > 0 && phaseRows.every((p) => num(p.UnitPrice) === 0 && num(p.UnitCost) === 0)
      ? 'zeroPriced'
      : 'priced';

  const laborRateMap = new Map<string, LaborRate>();
  const missingRateTypes = new Set<string>();
  if (flavor === 'priced') {
    for (const [name, r] of extractLaborRates(fullProject)) laborRateMap.set(name, r);
  } else {
    // Zero-priced payload: rates from persisted meta, then item derivation.
    if (priorMeta) {
      for (const [name, r] of Object.entries(priorMeta.rates)) {
        laborRateMap.set(name, { costPerHour: r.cost, pricePerHour: r.price });
      }
      log.push(`[transform] Zero-priced payload: using ${laborRateMap.size} persisted labor rates`);
    } else {
      log.push('[transform] Zero-priced payload with NO persisted labor meta — deriving what we can from items');
    }
    const derived = derivePriceRatesFromItems(fullItems, log);
    for (const [name, price] of derived) {
      if (!laborRateMap.has(name)) laborRateMap.set(name, { costPerHour: 0, pricePerHour: price });
    }
  }
  log.push(`[transform] Payload flavor: ${flavor}. Labor rates: ${Array.from(laborRateMap.entries()).map(([k, v]) => `${k}=$${v.costPerHour}/$${v.pricePerHour}`).join(', ') || '(none)'}`);

  // ── Item-attached raw hours per labor type (for phase residuals) ──────────
  const itemHoursByType = new Map<string, number>();
  for (const fi of fullItems) {
    if (fi.TypeId == 2) continue;
    for (const lt of fi.ItemLaborTypes ?? []) {
      const name = String(lt.Name ?? '').trim();
      if (!name) continue;
      itemHoursByType.set(name, (itemHoursByType.get(name) ?? 0) + num(fi.Quantity) * num(lt.Hours));
    }
  }

  // ── Equipment totals (DTools row convention) ──────────────────────────────
  let equipPriceFull = 0, equipCostFull = 0;
  for (const fi of fullItems) {
    if (fi.TypeId == 2) continue;
    equipPriceFull += round2(num(fi.Quantity) * num(fi.UnitPrice));
    equipCostFull += round2(num(fi.Quantity) * num(fi.UnitCost));
  }
  equipPriceFull = round2(equipPriceFull);
  equipCostFull = round2(equipCostFull);

  const rootPriceWithoutTax = num(fullProject?.PriceWithoutTax);
  const rootCost = num(fullProject?.Cost);

  // ── Echo detection (priced payloads only — zero-priced ones drop the
  // converted hours from the phases, so nothing double-counts) ──────────────
  const companionRows = fullItems.filter((i) => i.TypeId == 2 && i.LaborType !== 'Phase');
  let naiveLaborPrice = 0, naiveLaborCost = 0;
  for (const i of fullItems) {
    if (i.TypeId != 2) continue;
    naiveLaborPrice += round2(num(i.Quantity) * num(i.UnitPrice));
    naiveLaborCost += round2(num(i.Quantity) * num(i.UnitCost));
  }
  let echoIdx = new Set<number>();
  const echoModels: string[] = [];
  const convertedHoursByType = new Map<string, number>();
  if (flavor === 'priced') {
    const targetLaborPrice = rootPriceWithoutTax - equipPriceFull;
    const overshoot = round2(naiveLaborPrice - targetLaborPrice);
    echoIdx = detectEchoCompanions(
      companionRows.map((c, idx) => ({ idx, lineTotal: round2(num(c.Quantity) * num(c.UnitPrice)) })),
      overshoot,
      VERIFY_TOLERANCE,
      log,
    );
    companionRows.forEach((c, idx) => {
      if (!echoIdx.has(idx)) return;
      const model = String(c.Model ?? '').trim();
      echoModels.push(model);
      const typeName = String(c.LaborTypes ?? '').trim();
      const rate = laborRateMap.get(typeName);
      if (rate && rate.pricePerHour > 0) {
        const hrs = round2(num(c.Quantity) * num(c.UnitPrice)) / rate.pricePerHour;
        convertedHoursByType.set(typeName, (convertedHoursByType.get(typeName) ?? 0) + hrs);
      } else {
        log.push(`[transform] WARNING: echo companion "${model}" has no phase rate for type "${typeName}" — cannot remove converted hours`);
      }
    });
    if (echoModels.length > 0) {
      log.push(`[transform] Rolled-up companion labor detected (overshoot $${overshoot.toFixed(2)}): ${echoModels.join(', ')}`);
    }
  }

  // ── Product rows: group by mfr+model+unitCost, accumulate labor per row ───
  interface Grouped {
    row: BomRow;
    laborCost: number;   // unrounded line totals, rounded once at the end
    laborPrice: number;
    breakdownByType: Map<string, LaborBreakdownEntry>;
  }
  const grouped = new Map<string, Grouped>();

  for (const item of fullItems) {
    if (item.TypeId == 2) continue; // labor handled below
    const itemQty = num(item.Quantity) || 1;
    const room = locName(item);
    const key = `${item.Manufacturer}||${item.Model}||${num(item.UnitCost)}`;

    let g = grouped.get(key);
    if (!g) {
      const margin = num(item.Margin);
      g = {
        laborCost: 0,
        laborPrice: 0,
        breakdownByType: new Map(),
        row: {
          manufacturer: item.Manufacturer || '',
          model: item.Model || '',
          description: item.Description || '',
          category: mapCategory(item.Category),
          qty: 0,
          notes: item.Phase ? `Phase: ${item.Phase}` : '',
          locations: [],
          sort_order: 0,
          item_type: 'Product',
          unit_cost: num(item.UnitCost),
          unit_price: num(item.UnitPrice),
          labor_hours: 0,
          labor_unit_cost: 0,
          labor_unit_price: 0,
          fixed_labor_cost: 0,
          fixed_labor_price: 0,
          margin_pct: margin > 0 && margin <= 1 ? margin * 100 : margin,
          owner_furnished: item.IsOfe === true,
          optional: item.IsOptional === true,
          priced_from: null,
          labor_type: '',
          labor_breakdown: [],
          included_in_phase: false,
        },
      };
      grouped.set(key, g);
    }

    g.row.qty += itemQty;
    if (room) {
      const loc = g.row.locations.find((l) => l.room === room);
      if (loc) loc.qty += itemQty;
      else g.row.locations.push({ room, qty: itemQty });
    }
    const pf = extractPricedFrom(item);
    if (pf && !g.row.priced_from) g.row.priced_from = pf;

    // Labor from THIS row's ItemLaborTypes (same model can differ per row)
    for (const lt of item.ItemLaborTypes ?? []) {
      const typeName = String(lt.Name ?? '').trim();
      const hours = num(lt.Hours);
      const rate = laborRateMap.get(typeName);
      if (!typeName || hours <= 0) continue;
      if (!rate) { missingRateTypes.add(typeName); continue; }
      const lineHours = itemQty * hours;
      g.laborCost += lineHours * rate.costPerHour;
      g.laborPrice += lineHours * rate.pricePerHour;
      g.row.labor_hours += lineHours;
      const entry = g.breakdownByType.get(typeName);
      if (entry) {
        entry.hours += lineHours;
        entry.totalHours += num(lt.TotalHours);
      } else {
        g.breakdownByType.set(typeName, {
          type: typeName,
          hours: lineHours,
          totalHours: num(lt.TotalHours),
          costRate: rate.costPerHour,
          priceRate: rate.pricePerHour,
        });
      }
    }
  }

  // ── Companion labor rows (REAL cost/price, echo or not) ───────────────────
  // With SI's "send labor items as individual" integration setting on,
  // located labor items arrive here carrying ItemLaborTypes (and their own
  // LocationId) instead of being flattened into location-less phase rollups.
  // For these rows Quantity IS the (adjusted) hours and UnitPrice the $/hr —
  // unlike products, ItemLaborTypes.Hours is the LINE-total raw hours, not
  // per-unit. Dollars stay qty × unit price either way; the hour fields just
  // let the row display as "N hr @ $X/hr" in its room.
  const laborRows: BomRow[] = [];
  companionRows.forEach((c, idx) => {
    const qty = num(c.Quantity);
    const lineTotal = round2(qty * num(c.UnitPrice));
    const lineCost = round2(qty * num(c.UnitCost));
    if (qty === 0 && lineTotal === 0 && lineCost === 0) return; // empty placeholder
    const room = locName(c);
    const rawHours = round6((c.ItemLaborTypes ?? []).reduce((s: number, lt: any) => s + num(lt.Hours), 0));
    const hourly = rawHours > 0;
    laborRows.push({
      manufacturer: c.Manufacturer || '',
      model: c.Model || '',
      description: c.Description || '',
      category: 'Other',
      qty,
      notes: c.Phase ? `Phase: ${c.Phase}` : '',
      locations: room ? [{ room, qty }] : [],
      sort_order: 0,
      item_type: 'Labor',
      unit_cost: num(c.UnitCost),
      unit_price: num(c.UnitPrice),
      labor_hours: hourly ? qty : 0, // qty = adjusted hours at unit $/hr
      labor_unit_cost: hourly ? num(c.UnitCost) : 0,
      labor_unit_price: hourly ? num(c.UnitPrice) : 0,
      fixed_labor_cost: hourly ? 0 : lineCost,
      fixed_labor_price: hourly ? 0 : lineTotal,
      margin_pct: 0,
      owner_furnished: false,
      optional: c.IsOptional === true,
      priced_from: null,
      labor_type: String(c.LaborTypes ?? '').trim(),
      labor_breakdown: hourly
        ? (c.ItemLaborTypes ?? [])
            .filter((lt: any) => num(lt.Hours) !== 0)
            .map((lt: any) => ({
              type: String(lt.Name ?? '').trim(),
              hours: round6(num(lt.Hours)), // line-total raw hours
              totalHours: round6(num(lt.TotalHours)),
              costRate: round6(lineCost / rawHours),
              priceRate: round6(lineTotal / rawHours),
            }))
        : [],
      included_in_phase: echoIdx.has(idx), // informational (priced payloads)
    });
  });

  // ── Phase residual rows (manual hours only) ───────────────────────────────
  // priced:     phaseQty is RAW hours incl. converted companions.
  // zeroPriced: phaseQty is ADJUSTED hours excl. converted companions —
  //             un-adjust via the per-type factor before differencing.
  const liveFactors = factorsFromItems(fullItems);
  for (const p of phaseRows) {
    const typeName = String(p.Model ?? '').trim();
    const phaseQty = num(p.Quantity);
    const itemHours = itemHoursByType.get(typeName) ?? 0;

    let rawPhaseHours = phaseQty;
    if (flavor === 'zeroPriced') {
      const factor =
        liveFactors.get(typeName) ??
        (priorMeta?.factors?.[typeName] ??
          (priorMeta?.phaseRaw?.[typeName] && priorMeta.phaseRaw[typeName] > 0
            ? round6(phaseQty / priorMeta.phaseRaw[typeName])
            : 1));
      rawPhaseHours = phaseQty / (factor > 0 ? factor : 1);
    }

    const converted = flavor === 'priced' ? (convertedHoursByType.get(typeName) ?? 0) : 0;
    const residual = round6(rawPhaseHours - itemHours - converted);
    if (residual <= 0.005) {
      if (residual < -0.05) log.push(`[transform] NOTE: phase "${typeName}" has ${round2(-residual)}h more item-attached labor than the rollup — skipping residual (hours drift in DTools)`);
      continue;
    }
    const rate = laborRateMap.get(typeName);
    if (!rate) { missingRateTypes.add(typeName); continue; }
    laborRows.push({
      manufacturer: '',
      model: `${typeName} Labor`,
      description: String(p.Description ?? '').trim() || `Project ${typeName.toLowerCase()} labor (hours not attached to items)`,
      category: 'Other',
      qty: residual,
      notes: '',
      locations: [], // project-level — UI shows under "Project Labor"
      sort_order: 0,
      item_type: 'Labor',
      unit_cost: rate.costPerHour,
      unit_price: rate.pricePerHour,
      labor_hours: residual, // hour-based line
      labor_unit_cost: rate.costPerHour,
      labor_unit_price: rate.pricePerHour,
      fixed_labor_cost: 0,
      fixed_labor_price: 0,
      margin_pct: 0,
      owner_furnished: false,
      optional: false,
      priced_from: null,
      labor_type: typeName,
      labor_breakdown: [],
      included_in_phase: false,
    });
  }

  // ── Assemble rows + component sums ────────────────────────────────────────
  const bomRows: BomRow[] = [];
  let sort = 0;
  let itemLaborCost = 0, itemLaborPrice = 0;
  let laborRowCost = 0, laborRowPrice = 0;

  for (const g of grouped.values()) {
    g.row.sort_order = sort++;
    g.row.labor_breakdown = Array.from(g.breakdownByType.values()).map((e) => ({
      ...e,
      hours: round6(e.hours),
      totalHours: round6(e.totalHours),
    }));
    g.row.labor_hours = round6(g.row.labor_hours);
    g.row.labor_unit_cost = g.row.labor_hours > 0 ? round6(g.laborCost / g.row.labor_hours) : 0;
    g.row.labor_unit_price = g.row.labor_hours > 0 ? round6(g.laborPrice / g.row.labor_hours) : 0;
    bomRows.push(g.row);
    itemLaborCost += round2(g.laborCost);
    itemLaborPrice += round2(g.laborPrice);
  }
  for (const r of laborRows) {
    r.sort_order = sort++;
    bomRows.push(r);
    if (r.labor_hours > 0) {
      laborRowCost += round2(r.labor_hours * r.labor_unit_cost);
      laborRowPrice += round2(r.labor_hours * r.labor_unit_price);
    } else {
      laborRowCost += r.fixed_labor_cost;
      laborRowPrice += r.fixed_labor_price;
    }
  }

  // ── Headline labor totals ─────────────────────────────────────────────────
  let laborCost: number, laborPrice: number;
  let unattributedLaborCost = 0, unattributedLaborPrice = 0;

  if (flavor === 'priced') {
    // DTools' own row convention: Σ TypeId=2 rows minus the rolled-up echo
    // line totals (price side) / their converted-hours cost (cost side).
    let echoPrice = 0, echoConvertedCost = 0;
    companionRows.forEach((c, idx) => {
      if (!echoIdx.has(idx)) return;
      echoPrice += round2(num(c.Quantity) * num(c.UnitPrice));
    });
    for (const [typeName, hrs] of convertedHoursByType) {
      const rate = laborRateMap.get(typeName);
      if (rate) echoConvertedCost += round2(hrs * rate.costPerHour);
    }
    laborPrice = round2(naiveLaborPrice - echoPrice);
    laborCost = round2(naiveLaborCost - echoConvertedCost);
  } else {
    // Zero-priced payload: phases contribute $0, so the headline is the
    // reconstruction — anchored to root via an explicit unattributed line.
    laborPrice = round2(itemLaborPrice + laborRowPrice);
    laborCost = round2(itemLaborCost + laborRowCost);
    const targetPrice = round2(rootPriceWithoutTax - equipPriceFull);
    const targetCost = round2(rootCost - equipCostFull);
    unattributedLaborPrice = round2(targetPrice - laborPrice);
    unattributedLaborCost = round2(targetCost - laborCost);
    if (Math.abs(unattributedLaborPrice) > VERIFY_TOLERANCE || Math.abs(unattributedLaborCost) > VERIFY_TOLERANCE) {
      log.push(`[transform] Unattributed labor on zero-priced payload: $${unattributedLaborCost}/$${unattributedLaborPrice}${missingRateTypes.size > 0 ? ` (no rate for: ${Array.from(missingRateTypes).join(', ')})` : ' (DTools hours drift / rate gaps)'} — adding anchor line`);
      bomRows.push({
        manufacturer: '',
        model: 'Labor (unattributed)',
        description: 'Labor dollars present in the DTools totals that could not be attributed to specific lines from a post-approval payload. Re-publish the project from DTools (pre-approval style) or keep prior sync data to refine.',
        category: 'Other',
        qty: 1,
        notes: '',
        locations: [],
        sort_order: sort++,
        item_type: 'Labor',
        unit_cost: unattributedLaborCost,
        unit_price: unattributedLaborPrice,
        labor_hours: 0,
        labor_unit_cost: 0,
        labor_unit_price: 0,
        fixed_labor_cost: unattributedLaborCost,
        fixed_labor_price: unattributedLaborPrice,
        margin_pct: 0,
        owner_furnished: false,
        optional: false,
        priced_from: null,
        labor_type: '',
        labor_breakdown: [],
        included_in_phase: false,
      });
      laborRowCost += unattributedLaborCost;
      laborRowPrice += unattributedLaborPrice;
      laborPrice = round2(laborPrice + unattributedLaborPrice);
      laborCost = round2(laborCost + unattributedLaborCost);
    } else {
      unattributedLaborCost = 0;
      unattributedLaborPrice = 0;
    }
  }

  const rowSumCost = round2(equipCostFull + itemLaborCost + laborRowCost);
  const rowSumPrice = round2(equipPriceFull + itemLaborPrice + laborRowPrice);

  const rootTax = num(fullProject?.Tax);
  const rootPrice = num(fullProject?.Price);
  const rootHours = num(fullProject?.Hours);
  const totalCost = round2(equipCostFull + laborCost);
  const totalPrice = round2(equipPriceFull + laborPrice);
  const costDelta = round2(totalCost - rootCost);
  const priceDelta = round2(totalPrice - rootPriceWithoutTax);
  const rowCostDelta = round2(rowSumCost - totalCost);
  const rowPriceDelta = round2(rowSumPrice - totalPrice);
  const verified =
    Math.abs(costDelta) <= VERIFY_TOLERANCE && Math.abs(priceDelta) <= VERIFY_TOLERANCE &&
    Math.abs(rowCostDelta) <= VERIFY_TOLERANCE && Math.abs(rowPriceDelta) <= VERIFY_TOLERANCE;

  log.push(`[transform] Equipment $${equipCostFull}/$${equipPriceFull}, Labor $${laborCost}/$${laborPrice}, Total $${totalCost}/$${totalPrice} vs root $${rootCost}/$${rootPriceWithoutTax} (Δ cost ${costDelta}, Δ price ${priceDelta}; rows Δ ${rowCostDelta}/${rowPriceDelta}) → ${verified ? 'VERIFIED' : 'MISMATCH'}`);

  // ── LaborMeta: persist fresh knowledge from priced payloads ───────────────
  let laborMeta: LaborMeta | null = priorMeta;
  if (flavor === 'priced' && laborRateMap.size > 0) {
    const rates: LaborMeta['rates'] = {};
    for (const [name, r] of laborRateMap) rates[name] = { cost: r.costPerHour, price: r.pricePerHour };
    const factors: LaborMeta['factors'] = {};
    for (const [name, f] of liveFactors) factors[name] = f;
    const phaseRaw: LaborMeta['phaseRaw'] = {};
    for (const p of phaseRows) {
      const typeName = String(p.Model ?? '').trim();
      if (!typeName) continue;
      phaseRaw[typeName] = round6(num(p.Quantity) - (convertedHoursByType.get(typeName) ?? 0));
    }
    laborMeta = { rates, factors, phaseRaw };
  }

  return {
    bomRows,
    payloadFlavor: flavor,
    laborMeta,
    totals: {
      equipmentCost: equipCostFull, equipmentPrice: equipPriceFull,
      laborCost, laborPrice, totalCost, totalPrice,
      rowSumCost, rowSumPrice,
      rootCost, rootPriceWithoutTax, rootTax, rootPrice, rootHours,
      costDelta, priceDelta, rowCostDelta, rowPriceDelta, verified, echoModels,
      unattributedLaborCost, unattributedLaborPrice,
    },
    log,
  };
}
