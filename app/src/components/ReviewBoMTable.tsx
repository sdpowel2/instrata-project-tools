import { useState, useMemo, Fragment } from 'react';
import {
  ChevronDown, ChevronRight,
  Search, Filter, MapPin, DollarSign, Wrench,
} from 'lucide-react';
import type { ReviewFlag, ReviewFlagStatus } from '../types';
import { type CsvRow, isMiscItem } from '../utils/reviewEngine';
import { FlagCard } from '../pages/AutoReview';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<string, number> = { high: 0, moderate: 1, low: 2 };

const SEVERITY_DOT: Record<string, { bg: string; ring: string }> = {
  high:     { bg: 'bg-red-500',   ring: 'ring-red-200' },
  moderate: { bg: 'bg-amber-500', ring: 'ring-amber-200' },
  low:      { bg: 'bg-blue-500',  ring: 'ring-blue-200' },
};

const fmt = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtUnit = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${v.toFixed(1)}%`;

type FilterMode = 'all' | 'flagged';

// ─── Flag matching helpers ───────────────────────────────────────────────────

/** Get flags for an equipment row by model number */
function getFlagsForEquip(row: CsvRow, flagsByRef: Map<string, ReviewFlag[]>): ReviewFlag[] {
  return flagsByRef.get(row.modelNumber.trim().toLowerCase()) ?? [];
}

/** Get flags for a labor row by labor type + location compound key */
function getFlagsForLabor(row: CsvRow, flagsByRef: Map<string, ReviewFlag[]>): ReviewFlag[] {
  const results: ReviewFlag[] = [];
  const types = row.laborTypes.length ? row.laborTypes : [row.modelNumber || 'Unknown'];
  for (const lt of types) {
    // Location-qualified lookup (matches engine's "laborType @ location" format)
    const locKey = `${lt.trim()} @ ${row.location}`.toLowerCase();
    const locFlags = flagsByRef.get(locKey);
    if (locFlags) results.push(...locFlags);
    // Also check non-location-qualified key for backward compatibility
    // with any flags that don't use the compound format
    const plainFlags = flagsByRef.get(lt.trim().toLowerCase());
    if (plainFlags) results.push(...plainFlags);
  }
  // Deduplicate in case both lookups return the same flag
  return [...new Map(results.map(f => [f.id, f])).values()];
}

/** Worst severity from a flag array */
function worstSeverity(flags: ReviewFlag[]): string | null {
  let worst: string | null = null;
  for (const f of flags) {
    if (!worst || SEVERITY_WEIGHT[f.severity] < SEVERITY_WEIGHT[worst]) worst = f.severity;
  }
  return worst;
}

// ─── Location tree data ─────────────────────────────────────────────────────

interface LocationNode {
  name: string;           // Display name for this level only
  fullPath: string;       // Full colon-joined path (for keys & area-flag lookup)
  depth: number;
  equipRows: CsvRow[];    // Items directly at this node (leaf)
  laborRows: CsvRow[];
  equipCost: number;      // Aggregated: own + all descendants
  equipPrice: number;
  laborCost: number;
  laborPrice: number;
  flagCount: number;
  worstSeverity: string | null;
  areaFlag: ReviewFlag | null;
  children: LocationNode[];
}

/** Parse a location string into trimmed segments. */
function parseLocationSegments(loc: string): string[] {
  if (!loc) return ['Unassigned'];
  const segs = loc.split(':').map(s => s.trim()).filter(Boolean);
  return segs.length ? segs : ['Unassigned'];
}

/** Compute own costs/flags for a node (not including children). */
/** Round to the penny before accumulating — matches D-Tools row-level rounding. */
const round2 = (n: number) => Math.round(n * 100) / 100;

function computeNodeOwn(
  equip: CsvRow[],
  labor: CsvRow[],
  flagsByRef: Map<string, ReviewFlag[]>,
): { equipCost: number; equipPrice: number; laborCost: number; laborPrice: number; flagCount: number; worst: string | null } {
  const equipCost  = equip.reduce((s, r) => s + round2((r.unitCost  ?? 0) * (r.quantity ?? 0)), 0);
  const equipPrice = equip.reduce((s, r) => s + round2((r.unitPrice ?? 0) * (r.quantity ?? 0)), 0);
  let laborCost = 0, laborPrice = 0;
  for (const r of equip) {
    if ((r.laborHours ?? 0) > 0) {
      const qty = r.quantity ?? 1;
      laborCost  += round2((r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty);
      laborPrice += round2((r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty);
    }
  }
  for (const r of labor) {
    const qty = r.quantity ?? 1;
    if ((r.laborHours ?? 0) > 0) {
      laborCost  += round2((r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty);
      laborPrice += round2((r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty);
    }
    if ((r.fixedLaborCost ?? 0) > 0) {
      laborCost  += round2((r.fixedLaborCost  ?? 0) * qty);
      laborPrice += round2((r.fixedLaborPrice ?? 0) * qty);
    }
  }
  let flagCount = 0;
  let worst: string | null = null;
  for (const r of equip) {
    const fl = getFlagsForEquip(r, flagsByRef);
    flagCount += fl.length;
    const w = worstSeverity(fl);
    if (w && (!worst || SEVERITY_WEIGHT[w] < SEVERITY_WEIGHT[worst])) worst = w;
  }
  for (const r of labor) {
    const fl = getFlagsForLabor(r, flagsByRef);
    flagCount += fl.length;
    const w = worstSeverity(fl);
    if (w && (!worst || SEVERITY_WEIGHT[w] < SEVERITY_WEIGHT[worst])) worst = w;
  }
  return { equipCost, equipPrice, laborCost, laborPrice, flagCount, worst };
}

function buildLocationTree(
  csvRows: CsvRow[],
  flags: ReviewFlag[],
  flagsByRef: Map<string, ReviewFlag[]>,
): LocationNode[] {
  // ── 1. Group rows by full leaf location ────────────────────────────────────
  const leafMap = new Map<string, { equip: CsvRow[]; labor: CsvRow[] }>();

  for (const r of csvRows) {
    if (r.nonBillable) continue;
    if (r.optional) continue;      // optional items excluded from project totals
    if (r.modelNumber === 'MISC') continue;
    // S&H rows are included in the quote view so dollar totals match D-Tools;
    // they are still excluded from review rules in reviewEngine.ts.
    const fullLoc = (r.location || 'Unassigned').trim() || 'Unassigned';
    if (!leafMap.has(fullLoc)) leafMap.set(fullLoc, { equip: [], labor: [] });
    const bucket = leafMap.get(fullLoc)!;
    if (r.itemType.toLowerCase() === 'product') bucket.equip.push(r);
    else if (r.itemType.toLowerCase() === 'labor') bucket.labor.push(r);
  }

  // ── 2. Build area flag map (keyed on top-level location) ───────────────────
  const areaFlags = new Map<string, ReviewFlag>();
  for (const f of flags) {
    if (f.ruleId === 'AREA_MARGIN_BELOW_FLOOR' && f.lineItemRef) {
      areaFlags.set(f.lineItemRef.trim().toLowerCase(), f);
    }
  }

  // ── 3. Build tree with a temporary map ─────────────────────────────────────
  // Key: full colon-joined path, Value: node (may be intermediate or leaf)
  const nodeMap = new Map<string, LocationNode>();

  const getOrCreate = (segments: string[], depth: number): LocationNode => {
    const path = segments.slice(0, depth + 1).map(s => s.trim()).join(': ');
    if (nodeMap.has(path)) return nodeMap.get(path)!;
    const node: LocationNode = {
      name: segments[depth].trim(),
      fullPath: path,
      depth,
      equipRows: [],
      laborRows: [],
      equipCost: 0, equipPrice: 0, laborCost: 0, laborPrice: 0,
      flagCount: 0, worstSeverity: null,
      areaFlag: null,
      children: [],
    };
    nodeMap.set(path, node);
    // Attach to parent
    if (depth > 0) {
      const parent = getOrCreate(segments, depth - 1);
      if (!parent.children.find(c => c.fullPath === path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  for (const [fullLoc, { equip, labor }] of leafMap) {
    const segs = parseLocationSegments(fullLoc);
    // Ensure all intermediate nodes exist
    for (let d = 0; d < segs.length; d++) getOrCreate(segs, d);
    // Attach rows to the leaf node
    const leaf = getOrCreate(segs, segs.length - 1);
    leaf.equipRows.push(...equip);
    leaf.laborRows.push(...labor);
  }

  // ── 4. Aggregate costs & flags bottom-up ───────────────────────────────────
  function aggregate(node: LocationNode): void {
    // Recurse children first
    for (const child of node.children) aggregate(child);
    // Own row costs
    const own = computeNodeOwn(node.equipRows, node.laborRows, flagsByRef);
    node.equipCost  = own.equipCost;
    node.equipPrice = own.equipPrice;
    node.laborCost  = own.laborCost;
    node.laborPrice = own.laborPrice;
    node.flagCount  = own.flagCount;
    node.worstSeverity = own.worst;
    // Add children aggregates
    for (const child of node.children) {
      node.equipCost  += child.equipCost;
      node.equipPrice += child.equipPrice;
      node.laborCost  += child.laborCost;
      node.laborPrice += child.laborPrice;
      node.flagCount  += child.flagCount;
      if (child.worstSeverity && (!node.worstSeverity || SEVERITY_WEIGHT[child.worstSeverity] < SEVERITY_WEIGHT[node.worstSeverity])) {
        node.worstSeverity = child.worstSeverity;
      }
    }
    // Area flag — match on top-level name (depth 0)
    if (node.depth === 0) {
      const af = areaFlags.get(node.name.trim().toLowerCase()) ?? null;
      if (af) {
        node.areaFlag = af;
        node.flagCount++;
        if (!node.worstSeverity || SEVERITY_WEIGHT[af.severity] < SEVERITY_WEIGHT[node.worstSeverity]) {
          node.worstSeverity = af.severity;
        }
      }
    }
    // Sort children: Unassigned last, then alphabetical
    node.children.sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return a.name.localeCompare(b.name);
    });
  }

  // ── 5. Collect root nodes and aggregate ────────────────────────────────────
  const roots: LocationNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.depth === 0) roots.push(node);
  }
  for (const root of roots) aggregate(root);
  roots.sort((a, b) => {
    if (a.name === 'Unassigned') return 1;
    if (b.name === 'Unassigned') return -1;
    return a.name.localeCompare(b.name);
  });

  return roots;
}

// ─── Severity Badge ──────────────────────────────────────────────────────────

function SeverityBadge({ count, severity }: { count: number; severity: string }) {
  const dot = SEVERITY_DOT[severity];
  if (!dot) return null;
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold ring-2 ${dot.bg} ${dot.ring}`}>
      {count}
    </span>
  );
}

// ─── Inline flag expand cell ─────────────────────────────────────────────────

function FlagDot({
  flags, expanded, onClick,
}: {
  flags: ReviewFlag[];
  expanded: boolean;
  onClick: () => void;
}) {
  if (flags.length === 0) return <span className="text-green-400 text-xs">✓</span>;

  const openFlags = flags.filter(f => f.status === 'open' || f.status === 'commented');
  const allResolved = openFlags.length === 0 && flags.some(f => f.status === 'resolved');
  const allWaived = openFlags.length === 0 && flags.every(f => f.status === 'waived');
  const allHandled = openFlags.length === 0;

  // All flags resolved → green check
  if (allResolved && !allWaived) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1">
        {expanded ? <ChevronDown size={12} className="text-text-secondary" /> : <ChevronRight size={12} className="text-text-secondary" />}
        <span className="text-green-500 text-xs font-bold">✓</span>
      </button>
    );
  }

  // All flags waived → purple check
  if (allWaived) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1">
        {expanded ? <ChevronDown size={12} className="text-text-secondary" /> : <ChevronRight size={12} className="text-text-secondary" />}
        <span className="text-purple-500 text-xs font-bold">✓</span>
      </button>
    );
  }

  // Mix of handled + open, or all handled (resolved + waived mix)
  if (allHandled) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1">
        {expanded ? <ChevronDown size={12} className="text-text-secondary" /> : <ChevronRight size={12} className="text-text-secondary" />}
        <span className="text-green-500 text-xs font-bold">✓</span>
      </button>
    );
  }

  // Open flags remain — show severity badge with open count only
  const worst = worstSeverity(openFlags)!;
  const dot = SEVERITY_DOT[worst];
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1">
      {expanded
        ? <ChevronDown size={12} className="text-text-secondary" />
        : <ChevronRight size={12} className="text-text-secondary" />
      }
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold ring-2 ${dot.bg} ${dot.ring}`}>
        {openFlags.length}
      </span>
    </button>
  );
}

// ─── Margin color helper ─────────────────────────────────────────────────────

function marginClass(price: number, cost: number): string {
  if (price <= 0) return 'text-text-secondary';
  const m = ((price - cost) / price) * 100;
  if (m < 20) return 'text-red-600 font-semibold';
  if (m < 30) return 'text-amber-600 font-medium';
  return 'text-green-700';
}

function marginPct(price: number, cost: number): string {
  if (price <= 0) return '—';
  return fmtPct(((price - cost) / price) * 100);
}

// ─── Depth-based styling helpers ─────────────────────────────────────────────

const DEPTH_STYLES: { bg: string; hoverBg: string; icon: string; text: string; border: string }[] = [
  { bg: 'bg-navy/5',   hoverBg: 'hover:bg-navy/10', icon: 'text-navy',         text: 'text-navy',         border: 'border-border' },
  { bg: 'bg-slate-50',  hoverBg: 'hover:bg-slate-100', icon: 'text-slate-600',  text: 'text-slate-700',    border: 'border-slate-200' },
  { bg: 'bg-gray-50/80', hoverBg: 'hover:bg-gray-100', icon: 'text-gray-500', text: 'text-gray-600',       border: 'border-gray-200' },
];

function depthStyle(depth: number) {
  return DEPTH_STYLES[Math.min(depth, DEPTH_STYLES.length - 1)];
}

// ─── Recursive LocationNodeView ─────────────────────────────────────────────

const EQUIP_COLS = 10;
const LABOR_COLS = 8;

function LocationNodeView({
  node,
  expandedSections,
  toggleSection,
  expandedKeys,
  toggleExpand,
  flagsByRef,
  onUpdateStatus,
  searchText,
  filterMode,
  nonMiscMaterialsCost,
  locationCountMap,
}: {
  node: LocationNode;
  expandedSections: Set<string>;
  toggleSection: (key: string) => void;
  expandedKeys: Set<string>;
  toggleExpand: (key: string) => void;
  flagsByRef: Map<string, ReviewFlag[]>;
  onUpdateStatus: (id: string, status: ReviewFlagStatus, comment?: string) => Promise<void>;
  searchText: string;
  filterMode: FilterMode;
  nonMiscMaterialsCost: number;
  locationCountMap: Map<string, Set<string>>;
}) {
  // All sections collapsed by default; expanded when in the set
  const isCollapsed = !expandedSections.has(node.fullPath);
  const sectionTotal = node.equipCost + node.laborCost;
  const sectionPrice = node.equipPrice + node.laborPrice;
  const style = depthStyle(node.depth);


  // Filter own rows by search text
  let filteredEquip = node.equipRows;
  let filteredLabor = node.laborRows;
  if (searchText.trim()) {
    const q = searchText.toLowerCase();
    filteredEquip = node.equipRows.filter(r =>
      r.modelNumber.toLowerCase().includes(q) ||
      r.manufacturer.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q),
    );
    filteredLabor = node.laborRows.filter(r =>
      (r.laborTypes.join(', ') || r.modelNumber).toLowerCase().includes(q),
    );
  }

  // Filter children
  const filteredChildren = node.children.filter(child => {
    if (filterMode === 'flagged' && child.flagCount === 0) return false;
    if (searchText.trim()) {
      // Keep child if it has matching rows anywhere in its subtree
      const q = searchText.toLowerCase();
      const hasMatch = (n: LocationNode): boolean => {
        for (const r of n.equipRows) {
          if (r.modelNumber.toLowerCase().includes(q) || r.manufacturer.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) return true;
        }
        for (const r of n.laborRows) {
          if ((r.laborTypes.join(', ') || r.modelNumber).toLowerCase().includes(q)) return true;
        }
        return n.children.some(hasMatch);
      };
      if (!hasMatch(child)) return false;
    }
    return true;
  });

  // Skip rendering this node entirely if no matching content
  const hasVisibleContent = filteredEquip.length > 0 || filteredLabor.length > 0 || filteredChildren.length > 0;
  if (searchText.trim() && !hasVisibleContent) return null;
  if (filterMode === 'flagged' && node.flagCount === 0) return null;

  // Count own equip+labor including all descendants (for the summary)
  function countAllRows(n: LocationNode): { equip: number; labor: number } {
    let equip = n.equipRows.length, labor = n.laborRows.length;
    for (const c of n.children) { const r = countAllRows(c); equip += r.equip; labor += r.labor; }
    return { equip, labor };
  }
  const allCounts = countAllRows(node);

  return (
    <div className={`${node.depth === 0 ? 'border rounded-lg overflow-hidden' : 'border-t'} ${style.border}`}>
      {/* ── Node header ──────────────────────────────────────────────── */}
      <button
        onClick={() => toggleSection(node.fullPath)}
        className={`w-full ${style.bg} ${style.hoverBg} transition-colors text-left flex items-start gap-2`}
        style={{ paddingLeft: `${node.depth * 16 + 16}px`, paddingRight: '16px', paddingTop: '10px', paddingBottom: '10px' }}
      >
        {isCollapsed
          ? <ChevronRight size={node.depth === 0 ? 15 : 13} className={`${style.icon} mt-0.5 flex-shrink-0`} />
          : <ChevronDown size={node.depth === 0 ? 15 : 13} className={`${style.icon} mt-0.5 flex-shrink-0`} />
        }
        <MapPin size={node.depth === 0 ? 14 : 12} className={`${style.icon} mt-0.5 flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`${node.depth === 0 ? 'text-sm font-semibold' : 'text-xs font-semibold'} ${style.text}`}>
              {node.name}
            </span>
            <span className="text-[10px] text-text-secondary">
              {allCounts.equip} equip · {allCounts.labor} labor
              {node.children.length > 0 && ` · ${node.children.length} sub`}
            </span>
            {node.flagCount > 0 && node.worstSeverity && (
              <SeverityBadge count={node.flagCount} severity={node.worstSeverity} />
            )}
          </div>
          <div className="flex items-center gap-4 mt-0.5 text-[10px] text-text-secondary flex-wrap">
            <span className="flex items-center gap-1">
              <DollarSign size={10} />
              Equip: {fmt(node.equipCost)} / {fmt(node.equipPrice)}
              <span className={marginClass(node.equipPrice, node.equipCost)}>
                ({marginPct(node.equipPrice, node.equipCost)})
              </span>
            </span>
            {(node.laborCost > 0 || node.laborPrice > 0) && (
              <span className="flex items-center gap-1">
                <Wrench size={10} />
                Labor: {fmt(node.laborCost)} / {fmt(node.laborPrice)}
                <span className={marginClass(node.laborPrice, node.laborCost)}>
                  ({marginPct(node.laborPrice, node.laborCost)})
                </span>
              </span>
            )}
            <span className="font-medium text-text-primary">
              Total: {fmt(sectionTotal)} / {fmt(sectionPrice)}
            </span>
          </div>
        </div>
      </button>

      {/* ── Node body (expanded) ─────────────────────────────────────── */}
      {!isCollapsed && (
        <div>
          {/* Own equipment table */}
          {filteredEquip.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-navy text-white text-left">
                  <th className="px-2 py-1.5 w-10 text-center font-semibold"></th>
                  <th className="px-2 py-1.5 font-semibold">Manufacturer</th>
                  <th className="px-2 py-1.5 font-semibold">Model</th>
                  <th className="px-2 py-1.5 font-semibold hidden lg:table-cell">Description</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Qty</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Unit Cost</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Ext Cost</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Unit Price</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Ext Price</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredEquip.map((row, idx) => {
                  const rowKey = `equip-${node.fullPath}-${idx}`;
                  const rowFlags = getFlagsForEquip(row, flagsByRef);
                  const expanded = expandedKeys.has(rowKey);
                  const qty = row.quantity ?? 0;
                  const extCost = (row.unitCost ?? 0) * qty;
                  const extPrice = (row.unitPrice ?? 0) * qty;

                  return (
                    <Fragment key={rowKey}>
                      <tr className={`${idx % 2 === 1 ? 'bg-surface/30' : ''} ${
                        rowFlags.length > 0 ? 'cursor-pointer hover:bg-surface/60' : ''
                      } ${expanded ? 'bg-surface/40' : ''} ${row.ownerFurnished || row.optional ? 'opacity-70' : ''}`}
                        onClick={() => rowFlags.length > 0 && toggleExpand(rowKey)}
                      >
                        <td className="px-2 py-1.5 text-center">
                          <FlagDot flags={rowFlags} expanded={expanded} onClick={() => toggleExpand(rowKey)} />
                        </td>
                        <td className="px-2 py-1.5 text-text-primary font-medium truncate max-w-[120px]">
                          {row.manufacturer}
                          {row.ownerFurnished && <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">OFE</span>}
                          {row.optional && <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded">OPT</span>}
                        </td>
                        <td className="px-2 py-1.5 text-text-primary font-mono truncate max-w-[140px]">
                          {row.modelNumber}
                          {isMiscItem(row) && <span className="ml-1 text-[9px] bg-teal-100 text-teal-700 px-1 rounded">MISC</span>}
                        </td>
                        <td className="px-2 py-1.5 text-text-secondary truncate max-w-[180px] hidden lg:table-cell">
                          {row.description}
                          {isMiscItem(row) && nonMiscMaterialsCost > 0 && (
                            <span className={`ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                              (() => {
                                const pct = (extCost / nonMiscMaterialsCost) * 100;
                                if (pct < 3 || pct > 5) return 'bg-amber-100 text-amber-700';
                                return 'bg-green-100 text-green-700';
                              })()
                            }`}>
                              {((extCost / nonMiscMaterialsCost) * 100).toFixed(2)}% of materials
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium">{qty}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{fmtUnit(row.unitCost ?? 0)}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{fmt(extCost)}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{fmtUnit(row.unitPrice ?? 0)}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{fmt(extPrice)}</td>
                        <td className={`px-2 py-1.5 text-right ${marginClass(extPrice, extCost)}`}>
                          {marginPct(extPrice, extCost)}
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={EQUIP_COLS} className="bg-surface/30 px-3 py-2 border-t border-border/50">
                            <div className="max-w-3xl space-y-1">
                              {rowFlags.map(f => (
                                <FlagCard key={f.id} flag={f} onUpdateStatus={onUpdateStatus}                                  locationCount={f.lineItemRef ? (locationCountMap.get(f.lineItemRef.trim().toLowerCase())?.size ?? 0) : 0} />
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Own labor table */}
          {filteredLabor.length > 0 && (
            <>
              <div className="bg-gray-50 px-3 py-1.5 border-t border-border flex items-center gap-1.5">
                <Wrench size={12} className="text-text-secondary" />
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Labor</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-navy/80 text-white text-left">
                    <th className="px-2 py-1.5 w-10 text-center font-semibold"></th>
                    <th className="px-2 py-1.5 font-semibold">Labor Type</th>
                    <th className="px-2 py-1.5 font-semibold hidden lg:table-cell">Description</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Qty</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Hours</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Ext Cost</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Ext Price</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredLabor.map((row, idx) => {
                    const rowKey = `labor-${node.fullPath}-${idx}`;
                    const rowFlags = getFlagsForLabor(row, flagsByRef);
                    const expanded = expandedKeys.has(rowKey);
                    const qty = row.quantity ?? 1;
                    const hours = (row.laborHours ?? 0) * qty;
                    let extCost = 0, extPrice = 0;
                    if ((row.laborHours ?? 0) > 0) {
                      extCost  = (row.laborHours ?? 0) * (row.laborUnitCost  ?? 0) * qty;
                      extPrice = (row.laborHours ?? 0) * (row.laborUnitPrice ?? 0) * qty;
                    }
                    if ((row.fixedLaborCost ?? 0) > 0) {
                      extCost  += (row.fixedLaborCost  ?? 0) * qty;
                      extPrice += (row.fixedLaborPrice ?? 0) * qty;
                    }
                    const laborLabel = row.laborTypes.join(', ') || row.modelNumber || 'Unknown';

                    return (
                      <Fragment key={rowKey}>
                        <tr className={`${idx % 2 === 1 ? 'bg-surface/30' : ''} ${
                          rowFlags.length > 0 ? 'cursor-pointer hover:bg-surface/60' : ''
                        } ${expanded ? 'bg-surface/40' : ''}`}
                          onClick={() => rowFlags.length > 0 && toggleExpand(rowKey)}
                        >
                          <td className="px-2 py-1.5 text-center">
                            <FlagDot flags={rowFlags} expanded={expanded} onClick={() => toggleExpand(rowKey)} />
                          </td>
                          <td className="px-2 py-1.5 text-text-primary font-medium">{laborLabel}</td>
                          <td className="px-2 py-1.5 text-text-secondary truncate max-w-[180px] hidden lg:table-cell">{row.description || '—'}</td>
                          <td className="px-2 py-1.5 text-right">{qty}</td>
                          <td className="px-2 py-1.5 text-right">{hours > 0 ? hours.toFixed(1) : '—'}</td>
                          <td className="px-2 py-1.5 text-right font-medium">{fmt(extCost)}</td>
                          <td className="px-2 py-1.5 text-right font-medium">{fmt(extPrice)}</td>
                          <td className={`px-2 py-1.5 text-right ${marginClass(extPrice, extCost)}`}>
                            {marginPct(extPrice, extCost)}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={LABOR_COLS} className="bg-surface/30 px-3 py-2 border-t border-border/50">
                              <div className="max-w-3xl space-y-1">
                                {rowFlags.map(f => (
                                  <FlagCard key={f.id} flag={f} onUpdateStatus={onUpdateStatus}                                    locationCount={f.lineItemRef ? (locationCountMap.get(f.lineItemRef.trim().toLowerCase())?.size ?? 0) : 0} />
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {/* Area margin flag (top-level only) */}
          {node.areaFlag && (
            <div className="px-3 py-2 border-t border-border/50 bg-amber-50/50">
              <FlagCard flag={node.areaFlag} onUpdateStatus={onUpdateStatus} locationCount={0} />
            </div>
          )}

          {/* Recurse into children */}
          {filteredChildren.map(child => (
            <LocationNodeView
              key={child.fullPath}
              node={child}
              expandedSections={expandedSections}
              toggleSection={toggleSection}
              expandedKeys={expandedKeys}
              toggleExpand={toggleExpand}
              flagsByRef={flagsByRef}
              onUpdateStatus={onUpdateStatus}
              searchText={searchText}
              filterMode={filterMode}
              nonMiscMaterialsCost={nonMiscMaterialsCost}
                           locationCountMap={locationCountMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ReviewQuoteView({
  csvRows,
  flags,
  onUpdateStatus,
}: {
  csvRows: CsvRow[];
  flags: ReviewFlag[];
  onUpdateStatus: (id: string, status: ReviewFlagStatus, comment?: string) => Promise<void>;
}) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [searchText, setSearchText] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // All sections default to collapsed; this set tracks which are expanded
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // Build flag lookup: lineItemRef (lowercase) → flags
  const flagsByRef = useMemo(() => {
    const map = new Map<string, ReviewFlag[]>();
    for (const f of flags) {
      if (!f.lineItemRef) continue;
      const key = f.lineItemRef.trim().toLowerCase();
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  }, [flags]);

  const tree = useMemo(
    () => buildLocationTree(csvRows, flags, flagsByRef),
    [csvRows, flags, flagsByRef],
  );

  // Project totals (from root nodes)
  const totals = useMemo(() => {
    let eC = 0, eP = 0, lC = 0, lP = 0;
    for (const s of tree) {
      eC += s.equipCost;  eP += s.equipPrice;
      lC += s.laborCost;  lP += s.laborPrice;
    }
    return { equipCost: eC, equipPrice: eP, laborCost: lC, laborPrice: lP, totalCost: eC + lC, totalPrice: eP + lP };
  }, [tree]);

  // Non-misc materials cost (for misc % calculation on MHCC rows)
  const nonMiscMaterialsCost = useMemo(() => {
    let cost = 0;
    for (const r of csvRows) {
      if (r.nonBillable || r.optional) continue;
      if (r.itemType.toLowerCase() !== 'product') continue;
      if (r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
      if (isMiscItem(r)) continue;
      cost += (r.unitCost ?? 0) * (r.quantity ?? 0);
    }
    return cost;
  }, [csvRows]);

  // Location count per model (how many distinct locations each model appears in)
  const locationCountMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of csvRows) {
      if (r.itemType.toLowerCase() !== 'product') continue;
      if (!r.modelNumber || r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
      const key = r.modelNumber.trim().toLowerCase();
      const locs = map.get(key) ?? new Set<string>();
      locs.add(r.location || 'Unassigned');
      map.set(key, locs);
    }
    return map;
  }, [csvRows]);

  const toggleExpand = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSection = (loc: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(loc)) next.delete(loc); else next.add(loc);
      return next;
    });
  };

  const totalFlagCount = tree.reduce((s, n) => s + n.flagCount, 0);

  // Filter roots
  const filteredRoots = useMemo(() => {
    let result = tree;
    if (filterMode === 'flagged') {
      result = result.filter(n => n.flagCount > 0);
    }
    return result;
  }, [tree, filterMode]);

  return (
    <div className="space-y-3">
      {/* ── Filter bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/50" />
          <input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search model, manufacturer, description…"
            className="w-full text-sm border border-border rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy"
          />
        </div>

        <div className="flex items-center gap-1 bg-surface rounded-lg p-0.5 border border-border">
          <Filter size={13} className="text-text-secondary ml-2 mr-1" />
          {([
            ['all',     `All (${tree.length} areas)`],
            ['flagged', `Flagged (${totalFlagCount})`],
          ] as [FilterMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                filterMode === mode
                  ? 'bg-white text-navy shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Location tree ────────────────────────────────────────────────── */}
      {filteredRoots.length === 0 ? (
        <div className="text-center py-8 text-text-secondary text-sm">
          {searchText ? 'No items match your search.' : 'No line items to display.'}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredRoots.map(root => (
            <LocationNodeView
              key={root.fullPath}
              node={root}
              expandedSections={expandedSections}
              toggleSection={toggleSection}
              expandedKeys={expandedKeys}
              toggleExpand={toggleExpand}
              flagsByRef={flagsByRef}
              onUpdateStatus={onUpdateStatus}
              searchText={searchText}
              filterMode={filterMode}
              nonMiscMaterialsCost={nonMiscMaterialsCost}
              locationCountMap={locationCountMap}
            />
          ))}
        </div>
      )}

      {/* ── Project totals footer ────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border border-border shadow-sm px-4 py-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs text-text-secondary font-medium uppercase tracking-wider mb-0.5">Equipment</div>
            <div className="flex items-baseline gap-2">
              <span className="text-text-secondary">{fmt(totals.equipCost)}</span>
              <span className="text-text-primary font-semibold">{fmt(totals.equipPrice)}</span>
              <span className={`text-xs ${marginClass(totals.equipPrice, totals.equipCost)}`}>
                {marginPct(totals.equipPrice, totals.equipCost)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-text-secondary font-medium uppercase tracking-wider mb-0.5">Labor</div>
            <div className="flex items-baseline gap-2">
              <span className="text-text-secondary">{fmt(totals.laborCost)}</span>
              <span className="text-text-primary font-semibold">{fmt(totals.laborPrice)}</span>
              <span className={`text-xs ${marginClass(totals.laborPrice, totals.laborCost)}`}>
                {marginPct(totals.laborPrice, totals.laborCost)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-text-secondary font-medium uppercase tracking-wider mb-0.5">Total Cost</div>
            <div className="text-text-primary font-semibold">{fmt(totals.totalCost)}</div>
          </div>
          <div>
            <div className="text-xs text-text-secondary font-medium uppercase tracking-wider mb-0.5">Total Price</div>
            <div className="flex items-baseline gap-2">
              <span className="text-navy font-bold text-base">{fmt(totals.totalPrice)}</span>
              <span className={`text-xs ${marginClass(totals.totalPrice, totals.totalCost)}`}>
                {marginPct(totals.totalPrice, totals.totalCost)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
