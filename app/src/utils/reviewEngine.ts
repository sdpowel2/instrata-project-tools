// ─── Review Engine ────────────────────────────────────────────────────────────
// Pure TypeScript — no runtime dependencies.
// Built around the exact D-Tools "AV Package Items" CSV export format.
//
// D-Tools CSV headers (exact):
//   Item Type | Manufacturer | Model | Quantity | Location | Part Number |
//   Short Description | Unit Cost | Unit Price | Margin | Labor Types |
//   Unit Labor Hours | Fixed Labor Cost | Fixed Labor Price |
//   Labor Unit Cost | Labor Unit Price | Owner Furnished Equipment | Non-Billable |
//   Component ID
//
// Rules:
//   - Item Type = "Product" → equipment row (may carry embedded labor hours)
//   - Item Type = "Labor"   → dedicated labor row (variable or fixed)
//   - Labor Types can be comma-separated (e.g. "Install, Cabling")
//   - Owner Furnished = true → $0 cost/price expected; labor still required
//   - Non-Billable = true   → excluded from all rules and margin math
//   - Part Number and Component ID are skipped

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CsvRow {
  itemType:        string;   // "Product" | "Labor"
  manufacturer:    string;
  modelNumber:     string;   // "Model" column
  description:     string;   // "Short Description" column
  quantity:        number | null;
  location:        string;   // room / location
  unitCost:        number | null;
  unitPrice:       number | null;
  marginPct:       number | null;  // "Margin" column × 100 (stored as 0.15 → 15)
  laborTypes:      string[];  // "Labor Types" column — split on comma, may be multi-value
  laborHours:      number | null;  // "Unit Labor Hours" — UNIT hours (multiply by qty)
  fixedLaborCost:  number | null;  // "Fixed Labor Cost"  — fixed $ cost, no hours
  fixedLaborPrice: number | null;  // "Fixed Labor Price" — fixed $ price, no hours
  laborUnitCost:   number | null;  // "Labor Unit Cost"   — $/hr incl. non-productive factor
  laborUnitPrice:  number | null;  // "Labor Unit Price"  — $/hr incl. non-productive factor
  ownerFurnished:  boolean;  // "Owner Furnished Equipment" — $0 cost/price OK; labor still required
  nonBillable:     boolean;  // "Non-Billable"    — excluded from all rules and margin math
}

export interface EngineFlag {
  rule_id:       string;
  severity:      'high' | 'moderate' | 'low';
  category:      'margin' | 'pricing' | 'labor' | 'data' | 'catalog' | 'project';
  flag_name:     string;
  description:   string;
  line_item_ref: string | null;
  diff_status:   'new' | 'recurring' | null;
}

export interface ReviewConfig {
  marginFloorProject:   number;
  marginFloorPhase:     number;
  marginFloorLabor:     number;
  costDeviationPct:     number;
  miscMaterialsFloor:   number;   // min % of materials cost for misc items (default 3)
  miscMaterialsCeiling: number;   // max % of materials cost for misc items (default 5)
  preferredVendors:     string[];
  freeItemModels:       string[];
}

/** Returns true if a product row is a miscellaneous/MHCC line item */
export function isMiscItem(r: CsvRow): boolean {
  const m = r.modelNumber.trim().toLowerCase();
  const d = r.description.toLowerCase();
  return m === 'mhcc' || m === 'misc' || m === 'miscellaneous'
    || d.includes('miscellaneous cables') || d.includes('miscellaneous hardware')
    || d.includes('misc cables') || d.includes('misc hardware');
}

export interface LaborRate {
  labor_type:     string;
  cost_per_hour:  number | null;
  price_per_hour: number | null;
  hours_ceiling:  number | null;
}

export interface CatalogItem {
  model_number: string;
  cost:         number | null;
  list_price:   number | null;
}

export interface BomRowInput {
  project_id:   string;
  manufacturer: string;
  model:        string;
  description:  string;
  category:     string;
  qty:          number;
  notes:        string;
  locations:    { room: string; qty: number }[];
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(field.trim()); field = ''; }
        else { field += ch; }
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function toNum(v: string | undefined): number | null {
  if (!v || v.trim() === '') return null;
  const n = parseFloat(v.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function toBool(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'x';
}

// Maps a raw D-Tools CSV row to a typed CsvRow.
export function mapRow(raw: Record<string, string>): CsvRow {
  const marginRaw = toNum(raw['margin']);
  // Labor Types can be comma-separated — split and trim each value, drop blanks
  const laborTypesRaw = (raw['labor types'] ?? '').trim();
  const laborTypes = laborTypesRaw
    ? laborTypesRaw.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  return {
    itemType:        (raw['item type']         ?? '').trim(),
    manufacturer:    (raw['manufacturer']       ?? '').trim(),
    modelNumber:     (raw['model']              ?? '').trim(),
    description:     (raw['short description']  ?? '').trim(),
    quantity:        toNum(raw['quantity']),
    location:        (raw['location']           ?? '').trim(),
    unitCost:        toNum(raw['unit cost']),
    unitPrice:       toNum(raw['unit price']),
    marginPct:       marginRaw !== null ? marginRaw * 100 : null,
    laborTypes,
    laborHours:      toNum(raw['unit labor hours']),
    fixedLaborCost:  toNum(raw['fixed labor cost']),
    fixedLaborPrice: toNum(raw['fixed labor price']),
    laborUnitCost:   toNum(raw['labor unit cost']),
    laborUnitPrice:  toNum(raw['labor unit price']),
    ownerFurnished:  toBool(raw['owner furnished equipment']),
    nonBillable:     toBool(raw['non-billable']),
  };
}

// ─── Category Inference ───────────────────────────────────────────────────────
// Inferred from Short Description + Model since D-Tools has no Category column.

export type ItemCategory = 'Display' | 'Audio' | 'Control' | 'Networking' | 'Cabling' | 'Other';

const CATEGORY_RULES: [ItemCategory, RegExp][] = [
  ['Display',    /display|tv\b|uhd|monitor|screen|projector|signage/i],
  ['Audio',      /speaker|audio|amplifier|\bamp\b|microphone|\bdsp\b|subwoofer|soundbar|bgm|sound bar/i],
  ['Control',    /control|processor|wall plate|touch panel|airmedia|uc video|media presentation|button station/i],
  ['Networking', /\bswitch\b|network|router|\bap\b|access point|wireless|wi-fi|wifi/i],
  ['Cabling',    /cable|cabling|wire|connector|\bhdmi\b|miscellaneous.*cable|misc.*hardware/i],
];

export function inferCategory(description: string, model: string): ItemCategory {
  const text = `${description} ${model}`;
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(text)) return cat;
  }
  return 'Other';
}

// ─── Rules Engine ─────────────────────────────────────────────────────────────

export function runRules(
  rows:    CsvRow[],
  config:  ReviewConfig,
  catalog: CatalogItem[],
): EngineFlag[] {
  const flags: EngineFlag[] = [];

  const flag = (
    rule_id: string, severity: EngineFlag['severity'], category: EngineFlag['category'],
    flag_name: string, description: string, line_item_ref: string | null = null,
  ) => flags.push({ rule_id, severity, category, flag_name, description, line_item_ref, diff_status: null });

  // Separate equipment (Product) rows from dedicated labor rows
  const equipRows = rows.filter(r => r.itemType.toLowerCase() === 'product');
  const laborRows = rows.filter(r => r.itemType.toLowerCase() === 'labor');

  // realEquip: exclude S&H, MISC, and non-billable rows from item-level rules and margin math.
  // Owner-furnished rows ARE included (so location/quantity checks still fire), but
  // pricing-specific rules (ZERO_UNIT_PRICE, COST_DEVIATION) skip them individually.
  const realEquip = equipRows.filter(r =>
    r.modelNumber !== 'S&H' && r.modelNumber !== 'MISC' && !r.nonBillable,
  );

  // ── Pre-compute total labor cost/price directly from CSV columns ──────────
  // Two sources:
  //   1. Dedicated Labor rows
  //      • Variable: unit labor hours × labor unit cost/price × quantity
  //      • Fixed:    fixed labor cost/price × quantity (e.g. finder's fees, equipment rental)
  //   2. Embedded labor on Product rows
  //      • unit labor hours × labor unit cost/price × quantity
  //        (D-Tools lets you attach install hours to individual product line items)
  // Labor Types can be comma-separated — handled per item where needed.
  let totalLaborCost = 0, totalLaborPrice = 0;
  for (const r of rows) {
    if (r.nonBillable) continue;  // non-billable rows carry $0 cost everywhere — skip entirely
    const qty = r.quantity ?? 1;
    // Variable labor (dedicated Labor rows OR embedded on Product rows)
    if ((r.laborHours ?? 0) > 0 && (r.laborUnitCost ?? 0) > 0) {
      totalLaborCost  += (r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty;
      totalLaborPrice += (r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty;
    }
    // Fixed labor (dedicated Labor rows only)
    if (r.itemType.toLowerCase() === 'labor' && (r.fixedLaborCost ?? 0) > 0) {
      totalLaborCost  += (r.fixedLaborCost  ?? 0) * qty;
      totalLaborPrice += (r.fixedLaborPrice ?? 0) * qty;
    }
  }

  // ── HIGH: Project Margin Below Floor ─────────────────────────────────────
  // Equipment cost/price: realEquip rows (unit cost/price × qty, excl S&H/MISC).
  // Labor cost/price: computed above from CSV columns directly.
  const equipCost  = realEquip.reduce((s, r) => s + (r.unitCost  ?? 0) * (r.quantity ?? 0), 0);
  const equipPrice = realEquip.reduce((s, r) => s + (r.unitPrice ?? 0) * (r.quantity ?? 0), 0);
  const projectCost  = equipCost  + totalLaborCost;
  const projectPrice = equipPrice + totalLaborPrice;
  if (projectPrice > 0) {
    const margin = ((projectPrice - projectCost) / projectPrice) * 100;
    if (margin < config.marginFloorProject) {
      flag('PROJECT_MARGIN_BELOW_FLOOR', 'high', 'margin',
        'Project Margin Below Floor',
        `Project margin is ${margin.toFixed(1)}%, below the configured ${config.marginFloorProject}% floor. ` +
        `(Equip: $${equipCost.toFixed(0)} cost / $${equipPrice.toFixed(0)} price · ` +
        `Labor: $${totalLaborCost.toFixed(0)} cost / $${totalLaborPrice.toFixed(0)} price)`);
    }
  }

  // ── HIGH: Labor Row Missing Rate in D-Tools ───────────────────────────────
  // A dedicated Labor row has hours but no labor unit cost set — means the
  // engineer left the rate blank in D-Tools, so it contributes $0 to the project.
  // line_item_ref is location-qualified so the flag only appears on the specific
  // labor row in the specific location that has the issue.
  const seenMissingRate = new Set<string>();
  for (const r of laborRows.filter(r => !r.nonBillable)) {
    if ((r.laborHours ?? 0) > 0 && !(r.laborUnitCost ?? 0) && !(r.fixedLaborCost ?? 0)) {
      const types = r.laborTypes.length ? r.laborTypes : [r.modelNumber || 'Unknown'];
      for (const lt of types) {
        const dedup = `${lt}::${r.location}`;
        if (!seenMissingRate.has(dedup)) {
          seenMissingRate.add(dedup);
          flag('LABOR_MISSING_RATE', 'high', 'labor',
            'Labor Row Missing Rate',
            `"${lt}" in "${r.location}" has ${r.laborHours} hours but no unit cost/price set in D-Tools — contributes $0 to the project.`,
            `${lt} @ ${r.location}`);
        }
      }
    }
  }

  // ── HIGH: Labor Row With No Hours and No Fixed Cost ───────────────────────
  // A dedicated Labor row that contributes nothing ($0 hours, $0 fixed).
  // Skipped for Mobilization which is sometimes intentionally $0.
  // Deduplicated by labor type + location; line_item_ref is location-qualified.
  const seenZeroContrib = new Set<string>();
  for (const r of laborRows.filter(r => !r.nonBillable)) {
    const types = r.laborTypes.length ? r.laborTypes : [];
    const isMobilization = types.some(t => t.toLowerCase() === 'mobilization');
    if (!isMobilization && !(r.laborHours ?? 0) && !(r.fixedLaborCost ?? 0)) {
      const label = r.modelNumber || r.laborTypes.join(', ');
      if (label) {
        const dedup = `${label.toLowerCase()}::${r.location}`;
        if (!seenZeroContrib.has(dedup)) {
          seenZeroContrib.add(dedup);
          flag('LABOR_ZERO_CONTRIBUTION', 'high', 'labor',
            'Labor Row With Zero Contribution',
            `Labor item "${label}" in "${r.location}" has no hours and no fixed cost — verify in D-Tools.`,
            `${label} @ ${r.location}`);
        }
      }
    }
  }

  // ── HIGH: Zero or Null Quantity ───────────────────────────────────────────
  // Deduplicated: one flag per unique model. The flag shows on every row with
  // that model; resolving it resolves all appearances.
  const seenZeroQty = new Set<string>();
  for (const r of realEquip) {
    if (r.quantity === null || r.quantity === 0) {
      const ref = r.modelNumber || r.description;
      if (seenZeroQty.has(ref.toLowerCase())) continue;
      seenZeroQty.add(ref.toLowerCase());
      flag('ZERO_OR_NULL_QUANTITY', 'high', 'data',
        'Zero or Null Quantity',
        `Equipment line "${ref}" has a quantity of ${r.quantity ?? 'blank'}.`,
        ref);
    }
  }

  // ── HIGH: Zero Unit Price ─────────────────────────────────────────────────
  // Skipped for owner-furnished items ($0 price is expected and correct).
  // Deduplicated: one flag per unique model.
  const freeModels = new Set(config.freeItemModels.map(m => m.toLowerCase().trim()));
  const seenZeroPrice = new Set<string>();
  for (const r of realEquip) {
    if (r.ownerFurnished) continue;
    if ((r.unitPrice === null || r.unitPrice === 0) && !freeModels.has(r.modelNumber.toLowerCase())) {
      const ref = r.modelNumber || r.description;
      if (seenZeroPrice.has(ref.toLowerCase())) continue;
      seenZeroPrice.add(ref.toLowerCase());
      flag('ZERO_UNIT_PRICE', 'high', 'data',
        'Zero Unit Price',
        `Equipment line "${ref}" has a unit price of $0.`,
        ref);
    }
  }

  // ── HIGH: Owner-Furnished Item Missing Labor ───────────────────────────────
  // Owner-furnished items carry $0 product cost/price — that's expected.
  // But labor (installation) should still be captured on the row.
  // Deduplicated: one flag per unique model.
  const seenOFNoLabor = new Set<string>();
  for (const r of realEquip) {
    if (!r.ownerFurnished) continue;
    if (!(r.laborHours ?? 0)) {
      const ref = r.modelNumber || r.description;
      if (seenOFNoLabor.has(ref.toLowerCase())) continue;
      seenOFNoLabor.add(ref.toLowerCase());
      flag('OWNER_FURNISHED_NO_LABOR', 'high', 'labor',
        'Owner-Furnished Item Missing Labor',
        `"${ref}" is marked owner-furnished but has no embedded labor hours. ` +
        `Verify that install labor is captured on a dedicated labor row.`,
        ref);
    }
  }

  // NOTE: MISSING_SITE_ADDRESS and MISSING_SCOPE_OF_WORK deferred —
  // Monday pre-sales board does not have these columns yet.

  // ── MODERATE: Cost Deviation from Catalog ────────────────────────────────
  // Compare BoM unit cost against catalog cost (preferred) or list_price (fallback).
  // Deduplicated: one flag per unique model.
  const catalogCostMap = new Map<string, { value: number; label: string }>();
  for (const c of catalog) {
    const key = c.model_number.trim().toLowerCase();
    if (c.cost !== null && c.cost > 0) {
      catalogCostMap.set(key, { value: c.cost, label: 'catalog cost' });
    } else if (c.list_price !== null && c.list_price > 0) {
      catalogCostMap.set(key, { value: c.list_price, label: 'catalog list price' });
    }
  }
  const seenCostDev = new Set<string>();
  for (const r of realEquip) {
    if (r.ownerFurnished) continue;
    if (isMiscItem(r)) continue;
    const modelKey = r.modelNumber.trim().toLowerCase();
    if (seenCostDev.has(modelKey)) continue;
    const cat = catalogCostMap.get(modelKey);
    if (cat && r.unitCost !== null) {
      const dev = (Math.abs(r.unitCost - cat.value) / cat.value) * 100;
      if (dev > config.costDeviationPct) {
        seenCostDev.add(modelKey);
        flag('COST_DEVIATION_FROM_CATALOG', 'moderate', 'pricing',
          'Cost Deviation from Catalog',
          `"${r.modelNumber}" unit cost ($${r.unitCost.toFixed(2)}) deviates ${dev.toFixed(1)}% from ${cat.label} ($${cat.value.toFixed(2)}), exceeding the ${config.costDeviationPct}% threshold.`,
          r.modelNumber);
      }
    }
  }

  // ── MODERATE: Labor Margin Below Floor ───────────────────────────────────
  // Uses totalLaborCost/Price computed above directly from CSV columns.
  if (totalLaborPrice > 0) {
    const laborMargin = ((totalLaborPrice - totalLaborCost) / totalLaborPrice) * 100;
    if (laborMargin < config.marginFloorLabor) {
      flag('LABOR_MARGIN_BELOW_FLOOR', 'moderate', 'labor',
        'Labor Margin Below Floor',
        `Overall labor margin is ${laborMargin.toFixed(1)}%, below the configured ${config.marginFloorLabor}% floor. ` +
        `(Cost: $${totalLaborCost.toFixed(0)} / Price: $${totalLaborPrice.toFixed(0)})`,
      );
    }
  }

  // ── MODERATE: Area Margin Below Floor ─────────────────────────────────────
  // Groups by top-level location (everything before the first ": ").
  // Includes both equipment cost/price AND embedded labor on product rows,
  // since embedded labor is already attributed to the product's location.
  const locationGroups = new Map<string, { price: number; cost: number }>();
  for (const r of realEquip) {
    const topLevel = r.location.split(':')[0].trim() || 'Unknown';
    const g = locationGroups.get(topLevel) ?? { price: 0, cost: 0 };
    const qty = r.quantity ?? 0;
    g.cost  += (r.unitCost  ?? 0) * qty;
    g.price += (r.unitPrice ?? 0) * qty;
    // Add embedded labor (product rows with labor hours attached)
    if ((r.laborHours ?? 0) > 0 && (r.laborUnitCost ?? 0) > 0) {
      g.cost  += (r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty;
      g.price += (r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty;
    }
    locationGroups.set(topLevel, g);
  }
  for (const [area, { price, cost }] of locationGroups) {
    if (price > 0) {
      const m = ((price - cost) / price) * 100;
      if (m < config.marginFloorPhase) {
        flag('AREA_MARGIN_BELOW_FLOOR', 'moderate', 'margin',
          'Area Margin Below Floor',
          `Area "${area}" margin is ${m.toFixed(1)}%, below the ${config.marginFloorPhase}% floor.`,
          area);
      }
    }
  }

  // ── MODERATE: Miscellaneous Materials Out of Range ──────────────────────────
  // Total misc item cost should be 3-5% of non-misc materials cost.
  // Misc items: MHCC, MISC, Miscellaneous, etc.
  let miscCost = 0;
  let nonMiscMaterialsCost = 0;
  for (const r of realEquip) {
    if (r.nonBillable) continue;
    if (r.modelNumber === 'S&H') continue;
    const qty = r.quantity ?? 0;
    const cost = (r.unitCost ?? 0) * qty;
    if (isMiscItem(r)) {
      miscCost += cost;
    } else {
      nonMiscMaterialsCost += cost;
    }
  }
  if (nonMiscMaterialsCost > 0 && miscCost > 0) {
    const miscPct = (miscCost / nonMiscMaterialsCost) * 100;
    if (miscPct < config.miscMaterialsFloor || miscPct > config.miscMaterialsCeiling) {
      const direction = miscPct < config.miscMaterialsFloor ? 'below' : 'above';
      const threshold = miscPct < config.miscMaterialsFloor ? config.miscMaterialsFloor : config.miscMaterialsCeiling;
      flag('MISC_MATERIALS_OUT_OF_RANGE', 'moderate', 'pricing',
        'Miscellaneous Materials Out of Range',
        `Miscellaneous items total $${miscCost.toFixed(0)} (${miscPct.toFixed(2)}% of $${nonMiscMaterialsCost.toFixed(0)} materials cost), ` +
        `${direction} the ${threshold}% ${direction === 'below' ? 'floor' : 'ceiling'}. Expected range: ${config.miscMaterialsFloor}–${config.miscMaterialsCeiling}%.`,
        'MHCC');
    }
  }

  // ── LOW: Model Not in Catalog ─────────────────────────────────────────────
  // Skipped for owner-furnished items — we're not pricing them, so catalog presence is irrelevant.
  // Deduplicated: one flag per unique model.
  const catalogModels = new Set(catalog.map(c => c.model_number.trim().toLowerCase()));
  const seenNotInCatalog = new Set<string>();
  for (const r of realEquip) {
    if (r.ownerFurnished) continue;
    if (isMiscItem(r)) continue;
    const modelKey = r.modelNumber.trim().toLowerCase();
    if (seenNotInCatalog.has(modelKey)) continue;
    if (r.modelNumber && !catalogModels.has(modelKey)) {
      seenNotInCatalog.add(modelKey);
      flag('MODEL_NOT_IN_CATALOG', 'low', 'catalog',
        'Model Not in Catalog',
        `"${r.modelNumber}" was not found in the product catalog. Pricing cannot be verified.`,
        r.modelNumber);
    }
  }

  // ── LOW: Missing Room / Location ──────────────────────────────────────────
  // These items have no location, so lineItemRef is just the model (no " @ " suffix).
  const seenMissingRoom = new Set<string>();
  for (const r of realEquip) {
    if (!r.location || r.location === 'Labor and Services') {
      const ref = r.modelNumber || r.description;
      const dedup = ref.toLowerCase();
      if (seenMissingRoom.has(dedup)) continue;
      seenMissingRoom.add(dedup);
      flag('MISSING_ROOM_LOCATION', 'low', 'data',
        'Missing Room / Location',
        `Equipment line "${ref}" has no room or location assigned.`,
        ref);
    }
  }

  return flags;
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

export function applyDiff(
  newFlags:   EngineFlag[],
  priorFlags: { rule_id: string; line_item_ref: string | null }[],
): EngineFlag[] {
  const priorKeys = new Set(priorFlags.map(f => `${f.rule_id}::${f.line_item_ref ?? ''}`));
  return newFlags.map(f => ({
    ...f,
    diff_status: priorKeys.has(`${f.rule_id}::${f.line_item_ref ?? ''}`) ? 'recurring' : 'new',
  }));
}

// ─── BoM Builder ─────────────────────────────────────────────────────────────
// Consolidates Product rows into BoM items (by manufacturer + model).
// Skips Labor rows, S&H, and MISC placeholder rows.
// Accumulates room/location quantities.

export function buildBomRows(rows: CsvRow[], projectId: string): BomRowInput[] {
  const map = new Map<string, BomRowInput>();

  for (const r of rows) {
    if (r.itemType.toLowerCase() !== 'product') continue;
    if (r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
    if (!r.manufacturer && !r.modelNumber) continue;

    const key      = `${r.manufacturer.toLowerCase()}|||${r.modelNumber.toLowerCase()}`;
    const qty      = r.quantity ?? 0;
    const location = r.location && r.location !== 'Labor and Services' ? r.location : '';
    const existing = map.get(key);

    if (existing) {
      existing.qty += qty;
      if (location) {
        const loc = existing.locations.find(l => l.room === location);
        if (loc) loc.qty += qty;
        else existing.locations.push({ room: location, qty });
      }
    } else {
      map.set(key, {
        project_id:   projectId,
        manufacturer: r.manufacturer,
        model:        r.modelNumber,
        description:  r.description,
        category:     inferCategory(r.description, r.modelNumber),
        qty,
        notes:        '',
        locations:    location ? [{ room: location, qty }] : [],
      });
    }
  }

  return Array.from(map.values());
}

// ─── Config Builder ───────────────────────────────────────────────────────────

export function buildReviewConfig(configMap: Record<string, string>): ReviewConfig {
  return {
    marginFloorProject:  parseFloat(configMap['margin_floor_project']    ?? '30'),
    marginFloorPhase:    parseFloat(configMap['margin_floor_phase']      ?? '25'),
    marginFloorLabor:    parseFloat(configMap['margin_floor_labor']      ?? '25'),
    costDeviationPct:    parseFloat(configMap['cost_deviation_pct']      ?? '15'),
    miscMaterialsFloor:  parseFloat(configMap['misc_materials_floor']    ?? '3'),
    miscMaterialsCeiling:parseFloat(configMap['misc_materials_ceiling']  ?? '5'),
    preferredVendors:    (configMap['preferred_vendors'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    freeItemModels:      (configMap['free_item_models']  ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}
