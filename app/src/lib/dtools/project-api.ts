/**
 * D-Tools SI API — Project lookup and BoM retrieval
 *
 * Endpoints used:
 *   GET /SI/Subscribe/Projects?projectNumber={num}  — search by project number
 *   GET /SI/Subscribe/Projects?id={id}&aggregateBy=Location — project items by location
 *
 * Auth: X-DTSI-ApiKey header
 */

const DTOOLS_BASE = 'https://api.d-tools.com/SI';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DToolsProjectSummary {
  Id: string;
  Number: string;
  Name: string;
  Client: string;
  Progress?: string;
}

export interface DToolsLocation {
  Id: string;
  Name: string;
  FullName?: string;
  ParentId?: string | null;
}

export interface DToolsProjectItem {
  Id: string;
  TypeId: number;           // 1=Product, 2=Labor, 3=Allowance, 4=BundledCable, 5=Placeholder
  Manufacturer: string;
  Model: string;
  PartNumber?: string;
  Category?: string;
  Subcategory?: string;
  Description?: string;
  Quantity: number;
  TotalQuantity?: number;
  LocationId?: string;
  LocationName?: string;    // populated when aggregateBy=Location
  Phase?: string;
  UnitCost?: number;
  UnitPrice?: number;
  OrderUom?: string;
}

export interface DToolsProjectDetail {
  Id: string;
  Number: string;
  Name: string;
  Client: string;
  Locations?: DToolsLocation[];
  Items?: DToolsProjectItem[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function dtoolsFetch(apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${DTOOLS_BASE}${path}`, {
    headers: { 'X-DTSI-ApiKey': apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DTools API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search DTools for a project matching the given project number.
 * Returns the first matching project summary, or null if none found.
 */
export async function searchDToolsProject(
  apiKey: string,
  projectNumber: string,
): Promise<DToolsProjectSummary | null> {
  const data = await dtoolsFetch(
    apiKey,
    `/Subscribe/Projects?projectNumber=${encodeURIComponent(projectNumber)}&pageSize=5&pageNumber=1`,
  );

  // The response is either an array of projects or an object with a Projects array
  const projects: DToolsProjectSummary[] = Array.isArray(data)
    ? data
    : (data?.Projects ?? data?.projects ?? []);

  if (projects.length === 0) return null;

  // Exact match on project number (case-insensitive)
  const exact = projects.find(
    (p) => p.Number?.toLowerCase() === projectNumber.toLowerCase(),
  );
  return exact ?? projects[0];
}

/**
 * Fetch full project detail including items, aggregated by Location.
 * Also resolves location names from the project's Locations array.
 */
export async function fetchDToolsProjectItems(
  apiKey: string,
  dtoolsProjectId: string,
): Promise<{ project: DToolsProjectDetail; items: DToolsProjectItem[] }> {
  const data = await dtoolsFetch(
    apiKey,
    `/Subscribe/Projects?id=${encodeURIComponent(dtoolsProjectId)}&aggregateBy=Location`,
  );

  // The response may be the project directly or wrapped
  const project: DToolsProjectDetail = data?.Project ?? data;
  const items: DToolsProjectItem[] = project.Items ?? data?.Items ?? [];

  // Build a location ID → FullName lookup (preserves hierarchy via backslash path)
  const locationMap = new Map<string, string>();
  if (project.Locations) {
    for (const loc of project.Locations) {
      locationMap.set(loc.Id, loc.FullName || loc.Name);
    }
  }

  // Enrich items with resolved location names
  for (const item of items) {
    if (item.LocationId && !item.LocationName) {
      item.LocationName = locationMap.get(item.LocationId) ?? item.LocationId;
    }
  }

  return { project, items };
}

/**
 * Map DTools category strings to our ItemCategory type.
 */
function mapCategory(dtoolsCategory?: string): string {
  if (!dtoolsCategory) return 'Other';
  const cat = dtoolsCategory.toLowerCase();
  if (cat.includes('display') || cat.includes('monitor') || cat.includes('screen') || cat.includes('projector')) return 'Display';
  if (cat.includes('audio') || cat.includes('speaker') || cat.includes('microphone') || cat.includes('amplifier') || cat.includes('dsp')) return 'Audio';
  if (cat.includes('control') || cat.includes('processor') || cat.includes('switcher') || cat.includes('matrix')) return 'Control';
  if (cat.includes('network') || cat.includes('switch') || cat.includes('router') || cat.includes('wireless')) return 'Networking';
  if (cat.includes('cable') || cat.includes('wire') || cat.includes('connector') || cat.includes('adapter')) return 'Cabling';
  return 'Other';
}

/**
 * Convert DTools project items (products only, TypeId=1) into our BoM item shape.
 * Groups items by manufacturer+model and aggregates locations.
 */
export function mapDToolsItemsToBoM(
  items: DToolsProjectItem[],
): Array<{
  manufacturer: string;
  model: string;
  description: string;
  category: string;
  qty: number;
  notes: string;
  locations: Array<{ room: string; qty: number }>;
}> {
  // Filter to products only (TypeId 1)
  const products = items.filter((i) => i.TypeId === 1);

  // Group by manufacturer+model to consolidate locations
  const grouped = new Map<string, {
    manufacturer: string;
    model: string;
    description: string;
    category: string;
    qty: number;
    notes: string;
    locations: Map<string, number>;
  }>();

  for (const item of products) {
    const key = `${item.Manufacturer}||${item.Model}`;
    const existing = grouped.get(key);
    const itemQty = item.TotalQuantity ?? item.Quantity ?? 1;
    const locationName = item.LocationName || '';

    if (existing) {
      existing.qty += itemQty;
      if (locationName) {
        existing.locations.set(locationName, (existing.locations.get(locationName) ?? 0) + itemQty);
      }
    } else {
      const locations = new Map<string, number>();
      if (locationName) {
        locations.set(locationName, itemQty);
      }
      const notes = item.Phase ? `Phase: ${item.Phase}` : '';
      grouped.set(key, {
        manufacturer: item.Manufacturer || '',
        model: item.Model || '',
        description: item.Description || '',
        category: mapCategory(item.Category),
        qty: itemQty,
        notes,
        locations,
      });
    }
  }

  return Array.from(grouped.values()).map((g) => ({
    manufacturer: g.manufacturer,
    model: g.model,
    description: g.description,
    category: g.category,
    qty: g.qty,
    notes: g.notes,
    locations: Array.from(g.locations.entries()).map(([room, qty]) => ({ room, qty })),
  }));
}
