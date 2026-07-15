// Export BoM → Excel. Rebuilds the two-tab, Instrata-branded workbook the
// Claude cowork skill produced (see Reference/HualapaiTribeAdmin_BillOfMaterials_v2.xlsx)
// from the already-ingested project BoM:
//   • "BoM by Manufacturer" — Manufacturer, Model, Quantity, Vendor, Unit Cost,
//     CO Number, CO Type — grouped by manufacturer.
//   • "BoM by Location" — Manufacturer, Model, Quantity, Labor Type,
//     Unit Labor Hours, CO Number, CO Type — grouped by room.
//
// Uses ExcelJS (not the bundled SheetJS community build, which can't write cell
// styling) so the sheet carries the reference's branding: navy title, orange
// accent bar + section headers, navy column-header band with white text, and
// bordered gray data rows. Palette + layout mirror the reference file exactly.
//
// CO attribution: the ingested ProjectBoMItem carries no per-item CO tag, so
// contract lines all read "Base Bid / Base Bid". We append only the CO lines
// that are NOT yet in the contract BoM — pending COs plus approved COs the SI
// hasn't republished into the project payload yet (the same "ghost" set the
// Project Quote card surfaces). Approved+merged CO items are indistinguishable
// from base-bid lines in our model, so they stay under Base Bid — this keeps
// the export from double-counting them.
import ExcelJS from 'exceljs';
import type {
  Project, ProjectBoMItem, ProjectChangeOrder, LaborBreakdownEntry,
} from '../types';

// ---- Instrata palette (ARGB, opaque) — lifted from the reference styles.xml.
const NAVY = 'FF1B3A5C';
const ORANGE = 'FFE8872B';
const SECTION_BG = 'FFD6E0EA'; // light blue-gray section-header fill
const DATA_TEXT = 'FF333333';
const BORDER_GRAY = 'FFCCCCCC';
const WHITE = 'FFFFFFFF';

const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: BORDER_GRAY } };
const CELL_BORDER: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };

const TITLE_FONT: Partial<ExcelJS.Font> = { name: 'Arial', bold: true, size: 14, color: { argb: NAVY } };
const SECTION_FONT: Partial<ExcelJS.Font> = { name: 'Arial', bold: true, size: 12, color: { argb: ORANGE } };
const HEADER_FONT: Partial<ExcelJS.Font> = { name: 'Arial', bold: true, size: 10, color: { argb: WHITE } };
const DATA_FONT: Partial<ExcelJS.Font> = { name: 'Arial', size: 10, color: { argb: DATA_TEXT } };

const LEFT_MID: Partial<ExcelJS.Alignment> = { horizontal: 'left', vertical: 'middle' };
const CENTER_MID: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle' };

const COST_FMT = '$#,##0.00';
const NCOLS = 7;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** DTools "Priced From" reads "VENDOR MM/DD/YY" — strip the trailing date so
 *  only the vendor name lands in the Vendor column. */
function vendorFromPricedFrom(pricedFrom?: string): string {
  if (!pricedFrom) return '';
  return pricedFrom.replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, '').trim();
}

/** Per-unit labor type + hours for a PRODUCT row, shown on the by-Location tab.
 *  Products carry per-type hours in laborBreakdown (line-total raw hours). */
function productLaborForLocation(item: ProjectBoMItem): { type: string; unitHours: number | '' } {
  const active = (item.laborBreakdown || []).filter((b: LaborBreakdownEntry) => b.hours > 0);
  if (active.length === 0) {
    // CSV-imported products may have no breakdown — fall back to the line field.
    const per = item.qty > 0 ? item.laborHours / item.qty : item.laborHours;
    return { type: '', unitHours: per ? round2(per) : '' };
  }
  const totalHours = active.reduce((s, b) => s + b.hours, 0);
  const per = item.qty > 0 ? totalHours / item.qty : totalHours;
  return { type: active.map((b) => b.type).join(' / '), unitHours: round2(per) };
}

/** Resolve QTY + Unit Labor Hours for a LABOR line. DTools quantifies
 *  time-based labor in hours — the line's Quantity field IS its hours — so we
 *  render it the way the reference does: QTY 1, hours in the hours column.
 *  Expense-type labor (Airfare, S&H, Premiere Protect: zero labor hours) is a
 *  real count instead, so it keeps its quantity and shows no hours. */
function laborQtyHours(quantity: number, laborHours: number): { qty: number; hours: number | '' } {
  return (laborHours || 0) > 0
    ? { qty: 1, hours: quantity }
    : { qty: quantity, hours: '' };
}

/** Approved in DTools but approved AFTER the parent project last published —
 *  its items aren't in the synced BoM yet. Mirrors ProjectOverview's copy. */
function isApprovedUnmerged(co: ProjectChangeOrder, publishedOn?: string): boolean {
  if (co.status !== 'Approved' || !co.resolvedAt || !publishedOn) return false;
  const resolved = new Date(co.resolvedAt).getTime();
  const published = new Date(publishedOn).getTime();
  if (isNaN(resolved) || isNaN(published)) return false;
  return resolved > published;
}

/** CO product/labor lines that are NOT already in the contract BoM. Removed
 *  lines (negated prices) are skipped — a BoM lists what's installed. */
function ghostCOItems(changeOrders: ProjectChangeOrder[], publishedOn?: string) {
  const out: {
    coNumber: string; coType: string;
    manufacturer: string; model: string; qty: number;
    unitCost: number; itemType: 'Product' | 'Labor';
    laborHours: number; location: string;
  }[] = [];
  for (const co of changeOrders) {
    const awaitingRepublish = isApprovedUnmerged(co, publishedOn);
    if (co.status !== 'Pending' && !awaitingRepublish) continue;
    for (const item of co.items ?? []) {
      if (item.changeType === 'Removed') continue;
      out.push({
        coNumber: co.number,
        coType: co.category,
        manufacturer: item.manufacturer,
        model: item.model,
        qty: item.qty,
        unitCost: item.unitCost,
        itemType: item.itemType,
        laborHours: item.laborHours,
        location: item.location,
      });
    }
  }
  return out;
}

// =============================================================================
// Styled row writers — each appends one row and paints it per the reference.
// =============================================================================

type Cell = string | number;

function styleRange(ws: ExcelJS.Worksheet, rowNum: number, fn: (c: ExcelJS.Cell, col: number) => void) {
  for (let col = 1; col <= NCOLS; col++) fn(ws.getCell(rowNum, col), col);
}

function addTitleBlock(ws: ExcelJS.Worksheet, title: string) {
  // Row 1: navy bold title on white, merged across the table width.
  const titleRow = ws.addRow([title]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, NCOLS);
  const tc = ws.getCell(titleRow.number, 1);
  tc.font = TITLE_FONT;
  tc.fill = solid(WHITE);
  tc.alignment = LEFT_MID;
  // Row 2: thin orange brand bar. Row 3: blank spacer.
  const bar = ws.addRow(new Array(NCOLS).fill(''));
  styleRange(ws, bar.number, (c) => { c.fill = solid(ORANGE); });
  ws.addRow([]);
}

function addSectionHeader(ws: ExcelJS.Worksheet, name: string) {
  const row = ws.addRow([name]);
  ws.mergeCells(row.number, 1, row.number, NCOLS);
  styleRange(ws, row.number, (c, col) => {
    c.fill = solid(SECTION_BG);
    if (col === 1) { c.font = SECTION_FONT; c.alignment = LEFT_MID; }
  });
}

function addColumnHeader(ws: ExcelJS.Worksheet, headers: string[]) {
  const row = ws.addRow(headers);
  styleRange(ws, row.number, (c) => {
    c.font = HEADER_FONT;
    c.fill = solid(NAVY);
    c.border = CELL_BORDER;
    c.alignment = CENTER_MID;
  });
}

function addDataRow(ws: ExcelJS.Worksheet, values: Cell[], costCol?: number) {
  const row = ws.addRow(values);
  styleRange(ws, row.number, (c, col) => {
    c.font = DATA_FONT;
    c.border = CELL_BORDER;
    // Manufacturer + Model read left; everything else centers (reference).
    c.alignment = col <= 2 ? LEFT_MID : CENTER_MID;
    if (costCol && col === costCol) c.numFmt = COST_FMT;
  });
}

// =============================================================================
// Data grouping
// =============================================================================

interface ManuLine {
  manufacturer: string; model: string; qty: number;
  vendor: string; unitCost: number; coNumber: string; coType: string;
}
interface LocLine {
  manufacturer: string; model: string; qty: number;
  laborType: string; unitLaborHours: number | ''; coNumber: string; coType: string;
  itemType: 'Product' | 'Labor';
}

const MANU_HEADERS = ['Manufacturer', 'Model', 'Quantity', 'Vendor', 'Unit Cost', 'CO Number', 'CO Type'];
const LOC_HEADERS = ['Manufacturer', 'Model', 'Quantity', 'Labor Type', 'Unit Labor Hours', 'CO Number', 'CO Type'];

function buildByManufacturer(ws: ExcelJS.Worksheet, projectName: string, lines: ManuLine[]) {
  ws.columns = [24, 42, 12, 18, 14, 14, 14].map((w) => ({ width: w }));
  addTitleBlock(ws, `${projectName} — Bill of Materials by Manufacturer`);

  const groups = new Map<string, ManuLine[]>();
  for (const line of lines) {
    const key = line.manufacturer || '(No Manufacturer)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  }
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    addSectionHeader(ws, key);
    addColumnHeader(ws, MANU_HEADERS);
    for (const row of groups.get(key)!.sort((a, b) => a.model.localeCompare(b.model))) {
      addDataRow(ws, [row.manufacturer, row.model, row.qty, row.vendor, row.unitCost, row.coNumber, row.coType], 5);
    }
    ws.addRow([]);
  }
}

function buildByLocation(ws: ExcelJS.Worksheet, projectName: string, byRoom: Map<string, LocLine[]>) {
  ws.columns = [24, 42, 12, 18, 18, 14, 14].map((w) => ({ width: w }));
  addTitleBlock(ws, `${projectName} — Bill of Materials by Location`);

  for (const room of [...byRoom.keys()].sort((a, b) => a.localeCompare(b))) {
    const rows = byRoom.get(room)!.sort((a, b) => {
      // Labor lines (phase labor) lead, then products alpha — matches the
      // reference ordering within each room.
      if (a.itemType !== b.itemType) return a.itemType === 'Labor' ? -1 : 1;
      return a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model);
    });
    addSectionHeader(ws, room);
    addColumnHeader(ws, LOC_HEADERS);
    for (const row of rows) {
      addDataRow(ws, [row.manufacturer, row.model, row.qty, row.laborType, row.unitLaborHours, row.coNumber, row.coType]);
    }
    ws.addRow([]);
  }
}

// =============================================================================
// Public API
// =============================================================================

function safeStem(name: string): string {
  return (name || 'Project').replace(/[^A-Za-z0-9]+/g, '').slice(0, 60) || 'Project';
}

export interface GeneratedBoM {
  bytes: Uint8Array;
  filename: string;
}

/**
 * Build the two-tab, branded BoM workbook from the ingested project data.
 * Async because ExcelJS serializes off-thread. Returns the raw xlsx bytes plus
 * a suggested filename; the caller handles download and/or filing.
 */
export async function generateBoMWorkbook(
  project: Project,
  bomItems: ProjectBoMItem[],
  changeOrders: ProjectChangeOrder[],
): Promise<GeneratedBoM> {
  const publishedOn = project.dtoolsSyncDelta?.publishedOn;
  const ghosts = ghostCOItems(changeOrders, publishedOn);

  // ---- by Manufacturer: contract products + ghost CO products ----
  const manuLines: ManuLine[] = bomItems
    .filter((i) => i.itemType !== 'Labor')
    .map((i) => ({
      manufacturer: i.manufacturer, model: i.model, qty: i.qty,
      vendor: vendorFromPricedFrom(i.pricedFrom), unitCost: i.unitCost || 0,
      coNumber: 'Base Bid', coType: 'Base Bid',
    }));
  for (const g of ghosts) {
    if (g.itemType === 'Labor') continue;
    manuLines.push({
      manufacturer: g.manufacturer, model: g.model, qty: g.qty,
      vendor: '', unitCost: g.unitCost || 0, coNumber: g.coNumber, coType: g.coType,
    });
  }

  // ---- by Location: every contract line at its room(s) + ghost CO lines ----
  const byRoom = new Map<string, LocLine[]>();
  const pushRoom = (room: string, line: LocLine) => {
    const key = room.trim() || (line.itemType === 'Labor' ? 'Project Labor' : 'Unassigned');
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key)!.push(line);
  };
  for (const item of bomItems) {
    if (item.itemType === 'Labor') {
      // Labor's location "quantity" is really its hours (see laborQtyHours),
      // so resolve QTY/hours per location rather than treating it as a count.
      const pushLabor = (room: string, quantity: number) => {
        const { qty, hours } = laborQtyHours(quantity, item.laborHours);
        pushRoom(room, {
          manufacturer: item.manufacturer, model: item.model, qty,
          laborType: item.laborType || '', unitLaborHours: hours,
          coNumber: 'Base Bid', coType: 'Base Bid', itemType: 'Labor',
        });
      };
      if (item.locations.length === 0) pushLabor('', item.qty);
      else for (const loc of item.locations) pushLabor(loc.room, loc.qty);
      continue;
    }
    const { type, unitHours } = productLaborForLocation(item);
    const base = {
      manufacturer: item.manufacturer, model: item.model,
      laborType: type, unitLaborHours: unitHours,
      coNumber: 'Base Bid', coType: 'Base Bid', itemType: 'Product' as const,
    };
    if (item.locations.length === 0) pushRoom('', { ...base, qty: item.qty });
    else for (const loc of item.locations) pushRoom(loc.room, { ...base, qty: loc.qty });
  }
  for (const g of ghosts) {
    pushRoom(g.location, {
      manufacturer: g.manufacturer, model: g.model, qty: g.qty,
      laborType: g.itemType === 'Labor' ? 'Labor' : '',
      unitLaborHours: g.itemType === 'Labor' ? (g.laborHours || '') : '',
      coNumber: g.coNumber, coType: g.coType, itemType: g.itemType,
    });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Instrata Project Tools';
  buildByManufacturer(wb.addWorksheet('BoM by Manufacturer'), project.name, manuLines);
  buildByLocation(wb.addWorksheet('BoM by Location'), project.name, byRoom);

  const buf = await wb.xlsx.writeBuffer();
  return { bytes: new Uint8Array(buf as ArrayBuffer), filename: `${safeStem(project.name)}_BillOfMaterials.xlsx` };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Trigger a browser download of the generated workbook. */
export function downloadBoM(gen: GeneratedBoM): void {
  const blob = new Blob([gen.bytes as Uint8Array<ArrayBuffer>], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = gen.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { XLSX_MIME };
