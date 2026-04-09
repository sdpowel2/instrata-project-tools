import { supabase } from '@/lib/supabase';

// ─── Transform Helpers ────────────────────────────────────────────────────────

function parseDToolsBool(val: string): boolean | null {
  if (val === 'True') return true;
  if (val === 'False') return false;
  return null;
}

function parseDToolsDate(val: string): string | null {
  if (!val || val.trim() === '') return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDToolsNumeric(val: string, zeroIsNull = false): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  if (zeroIsNull && n === 0) return null;
  return n;
}

function parseDToolsInt(val: string, zeroIsNull = false): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseInt(val, 10);
  if (isNaN(n)) return null;
  if (zeroIsNull && n === 0) return null;
  return n;
}

function trim(val: string): string {
  return (val ?? '').trim();
}

// ─── Row Mapping ──────────────────────────────────────────────────────────────

// Maps a single parsed CSV row (keyed by header name) to a product_catalog record.
// Returns null if the row is missing both Manufacturer and Model.
function mapRowToRecord(row: Record<string, string>): Record<string, unknown> | null {
  const manufacturer = trim(row['Manufacturer']);
  const modelNumber = trim(row['Model']);

  if (!manufacturer && !modelNumber) return null;

  const shortDesc = trim(row['Short Description']);
  const longDesc = trim(row['Long Description']);

  return {
    manufacturer,
    model_number:           modelNumber,
    category:               trim(row['Category']),
    subcategory:            trim(row['Subcategory']) || null,
    phase:                  trim(row['Phase']) || null,
    part_number:            trim(row['Part Number']) || null,
    system_name:            trim(row['System']) || null,
    product_url:            trim(row['URL']) || null,

    // Descriptions: Short → description (primary); Long → long_description
    description:            shortDesc || longDesc || '',
    short_description:      shortDesc || null,
    long_description:       longDesc || null,
    tags:                   trim(row['Tags']) || null,
    accounting_item_name:   trim(row['Accounting Item Name']) || null,

    // Labor
    labor_types:            trim(row['Labor Types']) || null,
    unit_labor_hours:       parseDToolsNumeric(row['Unit Labor Hours']),

    // Pricing
    list_price:             parseDToolsNumeric(row['MSRP']),
    cost:                   parseDToolsNumeric(row['Unit Cost']),
    unit_price:             parseDToolsNumeric(row['Unit Price']),
    margin:                 parseDToolsNumeric(row['Margin']),
    markup:                 parseDToolsNumeric(row['Markup']),
    map_price:              parseDToolsNumeric(row['MAP']),
    purchase_cost:          parseDToolsNumeric(row['Purchase Cost']),
    partner_set_cost:       parseDToolsBool(row['Partner Set Cost']),
    uom_for_partner_cost:   trim(row['UOM for Partner Cost']) || null,
    preferred_vendor:       trim(row['Preferred Vendor']) || null,
    alternate_vendors:      trim(row['Alternate Vendors']) || null,
    priced_from:            trim(row['Priced From']) || null,
    partner_updated_on:     parseDToolsDate(row['Partner Updated On']),

    // UOM — Order UOM is the closest D-Tools equivalent
    unit_of_measure:        trim(row['Order UOM']) || '',
    order_uom:              trim(row['Order UOM']) || null,

    // Physical Specs (0.0000 → null)
    height_inches:          parseDToolsNumeric(row['Height'], true),
    width_inches:           parseDToolsNumeric(row['Width'], true),
    depth_inches:           parseDToolsNumeric(row['Depth'], true),
    weight_lbs:             parseDToolsNumeric(row['Weight'], true),
    rack_mounted:           parseDToolsBool(row['Rack Mounted']),
    rack_units:             parseDToolsInt(row['Rack Units'], true),
    amps:                   parseDToolsNumeric(row['Amps'], true),
    volts:                  parseDToolsNumeric(row['Volts'], true),
    watts:                  parseDToolsNumeric(row['Watts'], true),
    btu:                    parseDToolsNumeric(row['BTU'], true),
    poe:                    parseDToolsBool(row['PoE (Power Over Ethernet)']),
    poe_class:              trim(row['PoE Class']) || null,

    // Ordering
    do_not_order:           parseDToolsBool(row['Do Not Order']),

    // Flags
    bulk_item:              parseDToolsBool(row['Bulk Item']),
    include_in_submittal:   parseDToolsBool(row['Include in Submittal']) ?? true,
    include_in_service_plan: parseDToolsBool(row['Include in Service Plan']),
    owner_furnished:        parseDToolsBool(row['Owner Furnished Equipment']),
    taxable:                parseDToolsBool(row['Taxable']),
    discontinued:           parseDToolsBool(row['Discontinued']) ?? false,
    approved:               parseDToolsBool(row['Approved']),
    taa_compliant:          parseDToolsBool(row['TAA compliant?']),
    bulk_wire:              parseDToolsBool(row['Bulk Wire']),
    has_thumbnail:          parseDToolsBool(row['Has Thumbnail']),
    has_files:              parseDToolsBool(row['Has Files']),

    // D-Tools audit fields
    dtools_created_on:      parseDToolsDate(row['Created On']),
    dtools_created_by:      trim(row['Created By']) || null,
    dtools_updated_on:      parseDToolsDate(row['Updated On']),
    dtools_updated_by:      trim(row['Updated By']) || null,

    // Instrata sync metadata
    last_synced_at:         new Date().toISOString(),
    last_updated:           new Date().toISOString().split('T')[0],
    price_date:             new Date().toISOString().split('T')[0],
  };
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Parse a single CSV line respecting quoted fields
  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] ?? '';
    });
    rows.push(row);
  }

  return rows;
}

// ─── Import Summary ───────────────────────────────────────────────────────────

export interface ImportSummary {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
}

// ─── Main Import Function ─────────────────────────────────────────────────────

const BATCH_SIZE = 500;

export async function importDToolsCatalogCSV(
  csvText: string,
  onProgress?: (processed: number, total: number) => void
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
  };

  const rows = parseCSV(csvText);
  const total = rows.length;

  // Map rows to DB records, collecting parse errors
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const record = mapRowToRecord(rows[i]);
      if (!record) {
        summary.skipped++;
        summary.errorDetails.push(`Row ${i + 2}: skipped — missing Manufacturer and Model`);
        continue;
      }
      records.push(record);
    } catch (err) {
      summary.errors++;
      summary.errorDetails.push(`Row ${i + 2}: parse error — ${String(err)}`);
    }
  }

  // Upsert in batches
  for (let start = 0; start < records.length; start += BATCH_SIZE) {
    const batch = records.slice(start, start + BATCH_SIZE);

    const { error, count } = await supabase
      .from('product_catalog')
      .upsert(batch as Parameters<typeof supabase.from>[0][], {
        onConflict: 'manufacturer,model_number',
        ignoreDuplicates: false,
        count: 'exact',
      });

    if (error) {
      summary.errors += batch.length;
      summary.errorDetails.push(`Batch ${start}–${start + batch.length}: ${error.message}`);
    } else {
      // Supabase upsert count reflects rows affected; we can't cleanly split
      // inserted vs updated without a separate query, so attribute all to updated.
      summary.updated += count ?? batch.length;
    }

    onProgress?.(Math.min(start + BATCH_SIZE, records.length), total);
  }

  return summary;
}
