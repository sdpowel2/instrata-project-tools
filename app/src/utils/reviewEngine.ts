// ─── Review Engine ────────────────────────────────────────────────────────────
// Pure TypeScript — no runtime dependencies.
// Built around the exact D-Tools "AV Package Items" CSV export format.
//
// D-Tools CSV headers (exact):
//   Item Type | Manufacturer | Model | Quantity | Location | Part Number |
//   Short Description | Unit Cost | Unit Price | Margin | Labor Types |
//   Unit Labor Hours | Component ID
//
// Rules:
//   - Item Type = "Product" → equipment row
//   - Item Type = "Labor"   → labor row
//   - Part Number and Component ID are skipped

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CsvRow {
  itemType:     string;   // "Product" | "Labor"
  manufacturer: string;
  modelNumber:  string;   // "Model" column
  description:  string;   // "Short Description" column
  quantity:     number | null;
  location:     string;   // room / location
  unitCost:     number | null;
  unitPrice:    number | null;
  marginPct:    number | null;  // "Margin" column × 100 (stored as 0.15 → 15)
  laborType:    string;   // "Labor Types" column
  laborHours:   number | null;  // "Unit Labor Hours" column
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
  preferredVendors:     string[];
  freeItemModels:       string[];
}

export interface LaborRate {
  labor_type:     string;
  cost_per_hour:  number | null;
  price_per_hour: number | null;
  hours_ceiling:  number | null;
}

export interface CatalogItem {
  model_number: string;
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

// Maps a raw D-Tools CSV row to a typed CsvRow.
export function mapRow(raw: Record<string, string>): CsvRow {
  const marginRaw = toNum(raw['margin']);
  return {
    itemType:    (raw['item type'] ?? '').trim(),
    manufacturer:(raw['manufacturer'] ?? '').trim(),
    modelNumber: (raw['model'] ?? '').trim(),
    description: (raw['short description'] ?? '').trim(),
    quantity:    toNum(raw['quantity']),
    location:    (raw['location'] ?? '').trim(),
    unitCost:    toNum(raw['unit cost']),
    unitPrice:   toNum(raw['unit price']),
    marginPct:   marginRaw !== null ? marginRaw * 100 : null,
    laborType:   (raw['labor types'] ?? '').trim(),
    laborHours:  toNum(raw['unit labor hours']),
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
  rows:        CsvRow[],
  config:      ReviewConfig,
  laborRates:  LaborRate[],
  catalog:     CatalogItem[],
): EngineFlag[] {
  const flags: EngineFlag[] = [];

  const flag = (
    rule_id: string, severity: EngineFlag['severity'], category: EngineFlag['category'],
    flag_name: string, description: string, line_item_ref: string | null = null,
  ) => flags.push({ rule_id, severity, category, flag_name, description, line_item_ref, diff_status: null });

  // Separate equipment (Product) rows from labor rows
  const equipRows  = rows.filter(r => r.itemType.toLowerCase() === 'product');
  const laborRows  = rows.filter(r => r.itemType.toLowerCase() === 'labor');

  // Real product rows: exclude S&H and MISC from BoM rules (but keep in margin calc)
  const realEquip  = equipRows.filter(r => r.modelNumber !== 'S&H' && r.modelNumber !== 'MISC');

  // ── HIGH: Project Margin Below Floor ─────────────────────────────────────
  // Includes both equipment and labor rows so the margin reflects the full
  // project (blended equipment + labor), not just the equipment sell.
  const allBillable = [...equipRows, ...laborRows];
  const totalPrice  = allBillable.reduce((s, r) => s + (r.unitPrice ?? 0) * (r.quantity ?? 0), 0);
  const totalCost   = allBillable.reduce((s, r) => s + (r.unitCost  ?? 0) * (r.quantity ?? 0), 0);
  if (totalPrice > 0) {
    const margin = ((totalPrice - totalCost) / totalPrice) * 100;
    if (margin < config.marginFloorProject) {
      flag('PROJECT_MARGIN_BELOW_FLOOR', 'high', 'margin',
        'Project Margin Below Floor',
        `Project margin is ${margin.toFixed(1)}%, below the configured ${config.marginFloorProject}% floor. ` +
        `(Equipment + Labor — Cost: $${totalCost.toFixed(0)} / Price: $${totalPrice.toFixed(0)})`);
    }
  }

  // ── HIGH: Unmatched Labor Type ────────────────────────────────────────────
  const knownTypes = new Set(laborRates.map(r => r.labor_type.toLowerCase()));
  const seenTypes  = new Set<string>();
  for (const r of laborRows) {
    if (!r.laborType) continue;
    const lt = r.laborType.toLowerCase();
    if (!seenTypes.has(lt)) {
      seenTypes.add(lt);
      if (!knownTypes.has(lt)) {
        flag('UNMATCHED_LABOR_TYPE', 'high', 'labor',
          'Unmatched Labor Type',
          `Labor type "${r.laborType}" has no matching entry in the labor rate table.`,
          r.laborType);
      }
    }
  }

  // ── HIGH: Labor Row With Zero Hours ──────────────────────────────────────
  for (const r of laborRows) {
    if (r.laborType && r.laborType.toLowerCase() !== 'mobilization') {
      if (r.laborHours === null || r.laborHours === 0) {
        flag('LABOR_ZERO_HOURS', 'high', 'labor',
          'Labor Row With Zero Hours',
          `Labor type "${r.laborType}" in "${r.location}" has 0 hours logged.`,
          r.laborType);
      }
    }
  }

  // ── HIGH: Zero or Null Quantity ───────────────────────────────────────────
  for (const r of realEquip) {
    if (r.quantity === null || r.quantity === 0) {
      flag('ZERO_OR_NULL_QUANTITY', 'high', 'data',
        'Zero or Null Quantity',
        `Equipment line "${r.modelNumber || r.description}" has a quantity of ${r.quantity ?? 'blank'}.`,
        r.modelNumber || r.description);
    }
  }

  // ── HIGH: Zero Unit Price ─────────────────────────────────────────────────
  const freeModels = new Set(config.freeItemModels.map(m => m.toLowerCase().trim()));
  for (const r of realEquip) {
    if ((r.unitPrice === null || r.unitPrice === 0) && !freeModels.has(r.modelNumber.toLowerCase())) {
      flag('ZERO_UNIT_PRICE', 'high', 'data',
        'Zero Unit Price',
        `Equipment line "${r.modelNumber || r.description}" has a unit price of $0.`,
        r.modelNumber || r.description);
    }
  }

  // NOTE: MISSING_SITE_ADDRESS and MISSING_SCOPE_OF_WORK deferred —
  // Monday pre-sales board does not have these columns yet.

  // ── MODERATE: Cost Deviation from Catalog ────────────────────────────────
  const catalogMap = new Map<string, number>();
  for (const c of catalog) {
    if (c.list_price !== null) catalogMap.set(c.model_number.toLowerCase(), c.list_price);
  }
  for (const r of realEquip) {
    const catPrice = catalogMap.get(r.modelNumber.toLowerCase());
    if (catPrice !== undefined && catPrice > 0 && r.unitCost !== null) {
      const dev = (Math.abs(r.unitCost - catPrice) / catPrice) * 100;
      if (dev > config.costDeviationPct) {
        flag('COST_DEVIATION_FROM_CATALOG', 'moderate', 'pricing',
          'Cost Deviation from Catalog',
          `"${r.modelNumber}" unit cost ($${r.unitCost.toFixed(2)}) deviates ${dev.toFixed(1)}% from catalog price ($${catPrice.toFixed(2)}), exceeding the ${config.costDeviationPct}% threshold.`,
          r.modelNumber);
      }
    }
  }

  // ── MODERATE: Labor Hours Exceed Ceiling ──────────────────────────────────
  const ceilingMap = new Map<string, number>();
  for (const rate of laborRates) {
    if (rate.hours_ceiling !== null) ceilingMap.set(rate.labor_type.toLowerCase(), rate.hours_ceiling);
  }
  // Sum hours per labor type across all labor rows
  const hoursByType = new Map<string, number>();
  for (const r of laborRows) {
    if (r.laborType && r.laborHours) {
      const lt = r.laborType.toLowerCase();
      hoursByType.set(lt, (hoursByType.get(lt) ?? 0) + r.laborHours);
    }
  }
  for (const [lt, totalHours] of hoursByType) {
    const ceil = ceilingMap.get(lt);
    if (ceil !== undefined && totalHours > ceil) {
      flag('LABOR_HOURS_EXCEED_CEILING', 'moderate', 'labor',
        'Labor Hours Exceed Ceiling',
        `Labor type "${lt}" has ${totalHours.toFixed(1)} total hours, exceeding the configured ceiling of ${ceil} hours.`,
        lt);
    }
  }

  // ── MODERATE: Labor Margin Below Floor ───────────────────────────────────
  // Uses cost_per_hour and price_per_hour from labor_rates × hours per type
  const laborRateMap = new Map<string, { cost: number; price: number }>();
  for (const rate of laborRates) {
    laborRateMap.set(rate.labor_type.toLowerCase(), {
      cost:  rate.cost_per_hour  ?? 0,
      price: rate.price_per_hour ?? 0,
    });
  }
  let totalLaborCost = 0, totalLaborPrice = 0;
  for (const r of laborRows) {
    if (!r.laborType || !r.laborHours) continue;
    const rate = laborRateMap.get(r.laborType.toLowerCase());
    if (rate) {
      totalLaborCost  += r.laborHours * rate.cost;
      totalLaborPrice += r.laborHours * rate.price;
    }
  }
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

  // ── MODERATE: Phase / Location Margin Below Floor ─────────────────────────
  // Group by top-level location (floor/area before the first ": ").
  // Includes labor rows so per-area margin reflects blended equipment + labor.
  const locationGroups = new Map<string, { price: number; cost: number }>();
  for (const r of allBillable) {
    const topLevel = r.location.split(':')[0].trim() || 'Unknown';
    const g = locationGroups.get(topLevel) ?? { price: 0, cost: 0 };
    g.price += (r.unitPrice ?? 0) * (r.quantity ?? 0);
    g.cost  += (r.unitCost  ?? 0) * (r.quantity ?? 0);
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

  // ── LOW: Model Not in Catalog ─────────────────────────────────────────────
  const catalogModels = new Set(catalog.map(c => c.model_number.toLowerCase()));
  for (const r of realEquip) {
    if (r.modelNumber && !catalogModels.has(r.modelNumber.toLowerCase())) {
      flag('MODEL_NOT_IN_CATALOG', 'low', 'catalog',
        'Model Not in Catalog',
        `"${r.modelNumber}" was not found in the product catalog. Pricing cannot be verified.`,
        r.modelNumber);
    }
  }

  // ── LOW: Missing Room / Location ──────────────────────────────────────────
  for (const r of realEquip) {
    if (!r.location || r.location === 'Labor and Services') {
      flag('MISSING_ROOM_LOCATION', 'low', 'data',
        'Missing Room / Location',
        `Equipment line "${r.modelNumber || r.description}" has no room or location assigned.`,
        r.modelNumber || r.description);
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
    marginFloorProject: parseFloat(configMap['margin_floor_project'] ?? '30'),
    marginFloorPhase:   parseFloat(configMap['margin_floor_phase']   ?? '25'),
    marginFloorLabor:   parseFloat(configMap['margin_floor_labor']   ?? '25'),
    costDeviationPct:   parseFloat(configMap['cost_deviation_pct']   ?? '15'),
    preferredVendors:   (configMap['preferred_vendors'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    freeItemModels:     (configMap['free_item_models']  ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}
