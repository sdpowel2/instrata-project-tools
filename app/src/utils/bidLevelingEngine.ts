// ─── Bid Leveling Engine ─────────────────────────────────────────────────────
// Parses D-Tools CSV exports, aggregates costs by location, resolves cell
// mapping tags, and generates the output XLSX from a GC/consultant template.
//
// Reuses parseCsv() from reviewEngine.ts for CSV parsing.
// Uses SheetJS (xlsx) for XLSX read/write.

import * as XLSX from 'xlsx';
import { parseCsv } from './reviewEngine';
import type { CellMapping, GenerationReportEntry } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BomLineItem {
  itemDescription: string;
  location: string;
  qty: number;
  unitPrice: number;
  extendedPrice: number;
  laborHours: number;
  laborCost: number;
}

export interface LocationAggregation {
  location: string;
  equipmentTotal: number;
  laborTotal: number;
  laborHours: number;
  grandTotal: number;
}

export interface BomAggregations {
  byLocation: Map<string, LocationAggregation>;
  all: LocationAggregation;
  locations: string[];
}

export interface ParsedBomResult {
  rows: BomLineItem[];
  aggregations: BomAggregations;
  warnings: string[];
}

export interface GenerationResult {
  buffer: ArrayBuffer;
  report: GenerationReportEntry[];
}

// ─── Column Aliases ──────────────────────────────────────────────────────────
// D-Tools exports vary in header naming. These aliases map common variants
// to canonical field names.

const COLUMN_ALIASES: Record<string, string[]> = {
  item_description: ['short description', 'item description', 'description', 'item name'],
  location: ['location', 'room', 'area'],
  qty: ['quantity', 'qty'],
  unit_price: ['unit price', 'price'],
  extended_price: ['extended price', 'ext price', 'total price', 'ext. price'],
  unit_cost: ['unit cost', 'cost'],
  labor_hours: ['unit labor hours', 'labor hours', 'labour hours'],
  labor_cost: ['fixed labor cost', 'labor cost', 'labour cost'],
  labor_unit_cost: ['labor unit cost'],
  item_type: ['item type', 'type'],
};

function findColumn(headers: string[], aliases: string[]): string | null {
  for (const alias of aliases) {
    const match = headers.find(h => h === alias);
    if (match) return match;
  }
  return null;
}

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

export function parseBomCsv(text: string, columnOverrides?: Record<string, string>): ParsedBomResult {
  const rawRows = parseCsv(text);
  if (rawRows.length === 0) {
    return { rows: [], aggregations: emptyAggregations(), warnings: ['CSV file is empty or has no data rows.'] };
  }

  const headers = Object.keys(rawRows[0]);
  const warnings: string[] = [];

  // Resolve column mappings
  const colMap: Record<string, string | null> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (columnOverrides?.[field]) {
      colMap[field] = columnOverrides[field];
    } else {
      colMap[field] = findColumn(headers, aliases);
    }
  }

  if (!colMap.location) warnings.push('No "Location" column found. All items will be grouped under "Unassigned".');
  if (!colMap.extended_price && !colMap.unit_price) warnings.push('No pricing column found. Equipment totals will be $0.');

  const rows: BomLineItem[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];

    // Skip non-product rows (Labor rows, S&H, etc.) unless no item_type column
    const itemType = colMap.item_type ? (raw[colMap.item_type] ?? '').trim().toLowerCase() : '';
    if (colMap.item_type && itemType !== 'product' && itemType !== '') {
      // Keep only Product rows; skip Labor, S&H, Tax, etc.
      if (itemType !== 'product') continue;
    }

    const description = colMap.item_description ? (raw[colMap.item_description] ?? '').trim() : `Row ${i + 2}`;
    const location = colMap.location ? (raw[colMap.location] ?? '').trim() : 'Unassigned';
    const qty = toNum(colMap.qty ? raw[colMap.qty] : undefined) ?? 0;
    const unitPrice = toNum(colMap.unit_price ? raw[colMap.unit_price] : undefined) ?? 0;
    const extendedPrice = toNum(colMap.extended_price ? raw[colMap.extended_price] : undefined) ?? (qty * unitPrice);
    const laborHours = toNum(colMap.labor_hours ? raw[colMap.labor_hours] : undefined) ?? 0;

    // Labor cost: try fixed labor cost first, then derive from labor_unit_cost × hours × qty
    let laborCost = toNum(colMap.labor_cost ? raw[colMap.labor_cost] : undefined) ?? 0;
    if (laborCost === 0 && laborHours > 0) {
      const laborUnitCost = toNum(colMap.labor_unit_cost ? raw[colMap.labor_unit_cost] : undefined) ?? 0;
      if (laborUnitCost > 0) laborCost = laborUnitCost * laborHours * qty;
    }

    if (!location && !colMap.location) {
      if (qty === 0 && extendedPrice === 0) continue; // skip empty rows
    }

    rows.push({
      itemDescription: description,
      location: location || 'Unassigned',
      qty,
      unitPrice,
      extendedPrice,
      laborHours: laborHours * qty,
      laborCost,
    });
  }

  // Flag rows with issues
  for (const row of rows) {
    if (!row.location || row.location === 'Unassigned') {
      // Already warned above
    }
    if (row.extendedPrice === 0 && row.qty > 0) {
      warnings.push(`"${row.itemDescription}" has qty=${row.qty} but $0 price.`);
    }
  }

  const aggregations = aggregateByLocation(rows);
  return { rows, aggregations, warnings };
}

function toNum(v: string | undefined): number | null {
  if (!v || v.trim() === '') return null;
  const n = parseFloat(v.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export function aggregateByLocation(rows: BomLineItem[]): BomAggregations {
  const map = new Map<string, LocationAggregation>();

  for (const row of rows) {
    const loc = row.location;
    let agg = map.get(loc);
    if (!agg) {
      agg = { location: loc, equipmentTotal: 0, laborTotal: 0, laborHours: 0, grandTotal: 0 };
      map.set(loc, agg);
    }
    agg.equipmentTotal += row.extendedPrice;
    agg.laborTotal += row.laborCost;
    agg.laborHours += row.laborHours;
    agg.grandTotal += row.extendedPrice + row.laborCost;
  }

  // Compute ALL totals
  let allEquipment = 0, allLabor = 0, allHours = 0;
  for (const agg of map.values()) {
    allEquipment += agg.equipmentTotal;
    allLabor += agg.laborTotal;
    allHours += agg.laborHours;
  }

  return {
    byLocation: map,
    all: {
      location: 'ALL',
      equipmentTotal: allEquipment,
      laborTotal: allLabor,
      laborHours: allHours,
      grandTotal: allEquipment + allLabor,
    },
    locations: Array.from(map.keys()).sort(),
  };
}

function emptyAggregations(): BomAggregations {
  return {
    byLocation: new Map(),
    all: { location: 'ALL', equipmentTotal: 0, laborTotal: 0, laborHours: 0, grandTotal: 0 },
    locations: [],
  };
}

// ─── Tag Resolution ──────────────────────────────────────────────────────────

export function resolveTag(tag: string, aggregations: BomAggregations): number | string | null {
  const [field, ...locParts] = tag.split(':');
  const locationKey = locParts.join(':').trim();

  if (field === 'location_label') {
    return locationKey === 'ALL' ? 'All Locations' : locationKey;
  }

  const agg = locationKey.toUpperCase() === 'ALL'
    ? aggregations.all
    : fuzzyMatchLocation(locationKey, aggregations);

  if (!agg) return null;

  switch (field) {
    case 'equipment_total': return agg.equipmentTotal;
    case 'labor_total': return agg.laborTotal;
    case 'labor_hours': return agg.laborHours;
    case 'grand_total': return agg.grandTotal;
    default: return null;
  }
}

export function fuzzyMatchLocation(tagLocation: string, aggregations: BomAggregations): LocationAggregation | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
  const target = normalize(tagLocation);

  // Exact match first
  const exact = aggregations.byLocation.get(tagLocation);
  if (exact) return exact;

  // Fuzzy match
  for (const [loc, agg] of aggregations.byLocation) {
    if (normalize(loc) === target) return agg;
  }

  // Partial match: tag location is a substring of BoM location or vice versa
  for (const [loc, agg] of aggregations.byLocation) {
    const normLoc = normalize(loc);
    if (normLoc.includes(target) || target.includes(normLoc)) return agg;
  }

  return null;
}

// ─── Available Tags ──────────────────────────────────────────────────────────

const TAG_FIELDS = [
  { value: 'equipment_total', label: 'Equipment Total', type: 'currency' as const },
  { value: 'labor_total', label: 'Labor Total', type: 'currency' as const },
  { value: 'labor_hours', label: 'Labor Hours', type: 'number' as const },
  { value: 'grand_total', label: 'Grand Total', type: 'currency' as const },
  { value: 'location_label', label: 'Location Name', type: 'text' as const },
];

export function getAvailableTags(locations: string[]): { value: string; label: string; group: string }[] {
  const tags: { value: string; label: string; group: string }[] = [];

  // Per-location tags
  for (const loc of locations) {
    for (const field of TAG_FIELDS) {
      tags.push({
        value: `${field.value}:${loc}`,
        label: `${field.label} — ${loc}`,
        group: loc,
      });
    }
  }

  // ALL tags
  for (const field of TAG_FIELDS) {
    tags.push({
      value: `${field.value}:ALL`,
      label: `${field.label} — All Locations`,
      group: 'All Locations',
    });
  }

  return tags;
}

// ─── XLSX Template Parsing ───────────────────────────────────────────────────

export interface ParsedTemplate {
  workbook: XLSX.WorkBook;
  sheetNames: string[];
  sheetData: Map<string, string[][]>;
}

export function parseTemplate(buffer: ArrayBuffer): ParsedTemplate {
  const workbook = XLSX.read(buffer, { type: 'array', cellStyles: true });
  const sheetData = new Map<string, string[][]>();

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
    sheetData.set(name, data);
  }

  return { workbook, sheetNames: workbook.SheetNames, sheetData };
}

// ─── XLSX Generation ─────────────────────────────────────────────────────────

export function generateXlsx(
  templateBuffer: ArrayBuffer,
  mappings: CellMapping[],
  aggregations: BomAggregations,
): GenerationResult {
  const workbook = XLSX.read(templateBuffer, { type: 'array', cellStyles: true });
  const report: GenerationReportEntry[] = [];

  for (const mapping of mappings) {
    const sheet = workbook.Sheets[mapping.sheet];
    if (!sheet) {
      report.push({
        cell: mapping.cell,
        sheet: mapping.sheet,
        tag: mapping.tag,
        value: 0,
        status: 'skipped',
        note: `Sheet "${mapping.sheet}" not found in template.`,
      });
      continue;
    }

    const resolved = resolveTag(mapping.tag, aggregations);

    if (resolved === null) {
      // No matching BoM data — write 0
      const cellRef = mapping.cell;
      const existingCell = sheet[cellRef];
      const hadFormula = existingCell?.f !== undefined;

      sheet[cellRef] = { t: 'n', v: 0 };
      report.push({
        cell: mapping.cell,
        sheet: mapping.sheet,
        tag: mapping.tag,
        value: 0,
        status: 'skipped',
        note: `No matching BoM data for tag "${mapping.tag}". Wrote 0.`,
      });

      if (hadFormula) {
        report[report.length - 1].status = 'formula_overwritten';
        report[report.length - 1].note += ` (formula overwritten)`;
      }
      continue;
    }

    const cellRef = mapping.cell;
    const existingCell = sheet[cellRef];
    const hadFormula = existingCell?.f !== undefined;

    if (typeof resolved === 'string') {
      sheet[cellRef] = { t: 's', v: resolved };
    } else {
      sheet[cellRef] = { t: 'n', v: resolved };
    }

    // Preserve existing number format if present
    if (existingCell?.z) {
      sheet[cellRef].z = existingCell.z;
    }

    const status = hadFormula ? 'formula_overwritten' as const : 'written' as const;
    report.push({
      cell: mapping.cell,
      sheet: mapping.sheet,
      tag: mapping.tag,
      value: resolved,
      status,
      note: hadFormula ? 'Cell contained a formula that was overwritten.' : undefined,
    });
  }

  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return { buffer, report };
}

// ─── Column Detection ────────────────────────────────────────────────────────

export function detectColumns(csvText: string): {
  headers: string[];
  detected: Record<string, string | null>;
  unmapped: string[];
} {
  const rawRows = parseCsv(csvText);
  if (rawRows.length === 0) return { headers: [], detected: {}, unmapped: [] };

  const headers = Object.keys(rawRows[0]);
  const detected: Record<string, string | null> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    detected[field] = findColumn(headers, aliases);
  }

  const mappedCols = new Set(Object.values(detected).filter(Boolean));
  const unmapped = headers.filter(h => !mappedCols.has(h));

  return { headers, detected, unmapped };
}
