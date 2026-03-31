import { useState, useMemo, Fragment } from 'react';
import {
  AlertCircle, AlertTriangle, Info, ChevronDown, ChevronRight,
  Search, Filter, MapPin, DollarSign, Wrench,
} from 'lucide-react';
import type { ReviewFlag, ReviewFlagStatus } from '../types';
import type { CsvRow } from '../utils/reviewEngine';
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

/** Get flags for an equipment row by model number match */
function getFlagsForModel(model: string, flagsByRef: Map<string, ReviewFlag[]>): ReviewFlag[] {
  return flagsByRef.get(model.trim().toLowerCase()) ?? [];
}

/** Get flags for a labor row by labor type match */
function getFlagsForLabor(row: CsvRow, flagsByRef: Map<string, ReviewFlag[]>): ReviewFlag[] {
  const results: ReviewFlag[] = [];
  const types = row.laborTypes.length ? row.laborTypes : [row.modelNumber || 'Unknown'];
  for (const lt of types) {
    const f = flagsByRef.get(lt.trim().toLowerCase());
    if (f) results.push(...f);
  }
  return results;
}

/** Worst severity from a flag array */
function worstSeverity(flags: ReviewFlag[]): string | null {
  let worst: string | null = null;
  for (const f of flags) {
    if (!worst || SEVERITY_WEIGHT[f.severity] < SEVERITY_WEIGHT[worst]) worst = f.severity;
  }
  return worst;
}

// ─── Location section data ───────────────────────────────────────────────────

interface LocationSection {
  location: string;
  equipRows: CsvRow[];
  laborRows: CsvRow[];
  equipCost: number;
  equipPrice: number;
  laborCost: number;
  laborPrice: number;
  flagCount: number;
  worstSeverity: string | null;
  areaFlag: ReviewFlag | null;  // AREA_MARGIN_BELOW_FLOOR for this location
}

function buildSections(
  csvRows: CsvRow[],
  flags: ReviewFlag[],
  flagsByRef: Map<string, ReviewFlag[]>,
): LocationSection[] {
  // Group rows by top-level location (split on ":" — matches area margin rule)
  const locMap = new Map<string, { equip: CsvRow[]; labor: CsvRow[] }>();

  for (const r of csvRows) {
    if (r.nonBillable) continue;
    if (r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
    const topLevel = (r.location || 'Unassigned').split(':')[0].trim() || 'Unassigned';
    if (!locMap.has(topLevel)) locMap.set(topLevel, { equip: [], labor: [] });
    const bucket = locMap.get(topLevel)!;
    if (r.itemType.toLowerCase() === 'product') bucket.equip.push(r);
    else if (r.itemType.toLowerCase() === 'labor') bucket.labor.push(r);
  }

  // Build area flag map
  const areaFlags = new Map<string, ReviewFlag>();
  for (const f of flags) {
    if (f.ruleId === 'AREA_MARGIN_BELOW_FLOOR' && f.lineItemRef) {
      areaFlags.set(f.lineItemRef.trim().toLowerCase(), f);
    }
  }

  const sections: LocationSection[] = [];
  for (const [location, { equip, labor }] of locMap) {
    const equipCost  = equip.reduce((s, r) => s + (r.unitCost  ?? 0) * (r.quantity ?? 0), 0);
    const equipPrice = equip.reduce((s, r) => s + (r.unitPrice ?? 0) * (r.quantity ?? 0), 0);

    let laborCost = 0, laborPrice = 0;
    // Embedded labor on product rows
    for (const r of equip) {
      if ((r.laborHours ?? 0) > 0) {
        const qty = r.quantity ?? 1;
        laborCost  += (r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty;
        laborPrice += (r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty;
      }
    }
    // Dedicated labor rows
    for (const r of labor) {
      const qty = r.quantity ?? 1;
      if ((r.laborHours ?? 0) > 0) {
        laborCost  += (r.laborHours ?? 0) * (r.laborUnitCost  ?? 0) * qty;
        laborPrice += (r.laborHours ?? 0) * (r.laborUnitPrice ?? 0) * qty;
      }
      if ((r.fixedLaborCost ?? 0) > 0) {
        laborCost  += (r.fixedLaborCost  ?? 0) * qty;
        laborPrice += (r.fixedLaborPrice ?? 0) * qty;
      }
    }

    // Count flags for items in this section
    let sectionFlagCount = 0;
    let sectionWorst: string | null = null;
    for (const r of equip) {
      const fl = getFlagsForModel(r.modelNumber, flagsByRef);
      sectionFlagCount += fl.length;
      const w = worstSeverity(fl);
      if (w && (!sectionWorst || SEVERITY_WEIGHT[w] < SEVERITY_WEIGHT[sectionWorst])) sectionWorst = w;
    }
    for (const r of labor) {
      const fl = getFlagsForLabor(r, flagsByRef);
      sectionFlagCount += fl.length;
      const w = worstSeverity(fl);
      if (w && (!sectionWorst || SEVERITY_WEIGHT[w] < SEVERITY_WEIGHT[sectionWorst])) sectionWorst = w;
    }

    const af = areaFlags.get(location.trim().toLowerCase()) ?? null;
    if (af) {
      sectionFlagCount++;
      const w = af.severity;
      if (!sectionWorst || SEVERITY_WEIGHT[w] < SEVERITY_WEIGHT[sectionWorst]) sectionWorst = w;
    }

    sections.push({
      location, equipRows: equip, laborRows: labor,
      equipCost, equipPrice, laborCost, laborPrice,
      flagCount: sectionFlagCount, worstSeverity: sectionWorst,
      areaFlag: af,
    });
  }

  // Sort: Unassigned last, then alphabetical
  sections.sort((a, b) => {
    if (a.location === 'Unassigned') return 1;
    if (b.location === 'Unassigned') return -1;
    return a.location.localeCompare(b.location);
  });

  return sections;
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
  const worst = worstSeverity(flags)!;
  const dot = SEVERITY_DOT[worst];
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1">
      {expanded
        ? <ChevronDown size={12} className="text-text-secondary" />
        : <ChevronRight size={12} className="text-text-secondary" />
      }
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold ring-2 ${dot.bg} ${dot.ring}`}>
        {flags.length}
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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

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

  const sections = useMemo(
    () => buildSections(csvRows, flags, flagsByRef),
    [csvRows, flags, flagsByRef],
  );

  // Filter sections
  const filteredSections = useMemo(() => {
    let result = sections;

    if (filterMode === 'flagged') {
      result = result.filter(s => s.flagCount > 0);
    }

    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.map(s => ({
        ...s,
        equipRows: s.equipRows.filter(r =>
          r.modelNumber.toLowerCase().includes(q) ||
          r.manufacturer.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
        ),
        laborRows: s.laborRows.filter(r =>
          (r.laborTypes.join(', ') || r.modelNumber).toLowerCase().includes(q),
        ),
      })).filter(s => s.equipRows.length > 0 || s.laborRows.length > 0);
    }

    return result;
  }, [sections, filterMode, searchText]);

  // Project totals
  const totals = useMemo(() => {
    let eC = 0, eP = 0, lC = 0, lP = 0;
    for (const s of sections) {
      eC += s.equipCost;  eP += s.equipPrice;
      lC += s.laborCost;  lP += s.laborPrice;
    }
    return { equipCost: eC, equipPrice: eP, laborCost: lC, laborPrice: lP, totalCost: eC + lC, totalPrice: eP + lP };
  }, [sections]);

  const toggleExpand = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSection = (loc: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(loc)) next.delete(loc); else next.add(loc);
      return next;
    });
  };

  const totalFlagCount = sections.reduce((s, sec) => s + sec.flagCount, 0);

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
            ['all',     `All (${sections.length} areas)`],
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

      {/* ── Location sections ────────────────────────────────────────────── */}
      {filteredSections.length === 0 ? (
        <div className="text-center py-8 text-text-secondary text-sm">
          {searchText ? 'No items match your search.' : 'No line items to display.'}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredSections.map(section => {
            const isCollapsed = collapsedSections.has(section.location);
            const sectionTotal = section.equipCost + section.laborCost;
            const sectionPrice = section.equipPrice + section.laborPrice;
            const EQUIP_COLS = 10;
            const LABOR_COLS = 8;

            return (
              <div key={section.location} className="border border-border rounded-lg overflow-hidden">
                {/* ── Section header ────────────────────────────────────── */}
                <button
                  onClick={() => toggleSection(section.location)}
                  className="w-full bg-navy/5 px-4 py-3 flex items-start gap-3 text-left hover:bg-navy/10 transition-colors"
                >
                  {isCollapsed
                    ? <ChevronRight size={15} className="text-navy mt-0.5 flex-shrink-0" />
                    : <ChevronDown size={15} className="text-navy mt-0.5 flex-shrink-0" />
                  }
                  <MapPin size={14} className="text-navy mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-navy">{section.location}</span>
                      <span className="text-xs text-text-secondary">
                        {section.equipRows.length} equip · {section.laborRows.length} labor
                      </span>
                      {section.flagCount > 0 && section.worstSeverity && (
                        <SeverityBadge count={section.flagCount} severity={section.worstSeverity} />
                      )}
                    </div>
                    {/* Cost/price summary row */}
                    <div className="flex items-center gap-4 mt-1 text-xs text-text-secondary flex-wrap">
                      <span className="flex items-center gap-1">
                        <DollarSign size={11} />
                        Equip: {fmt(section.equipCost)} / {fmt(section.equipPrice)}
                        <span className={marginClass(section.equipPrice, section.equipCost)}>
                          ({marginPct(section.equipPrice, section.equipCost)})
                        </span>
                      </span>
                      {(section.laborCost > 0 || section.laborPrice > 0) && (
                        <span className="flex items-center gap-1">
                          <Wrench size={11} />
                          Labor: {fmt(section.laborCost)} / {fmt(section.laborPrice)}
                          <span className={marginClass(section.laborPrice, section.laborCost)}>
                            ({marginPct(section.laborPrice, section.laborCost)})
                          </span>
                        </span>
                      )}
                      <span className="font-medium text-text-primary">
                        Total: {fmt(sectionTotal)} / {fmt(sectionPrice)}
                      </span>
                    </div>
                  </div>
                </button>

                {/* ── Section body ──────────────────────────────────────── */}
                {!isCollapsed && (
                  <div>
                    {/* Equipment table */}
                    {section.equipRows.length > 0 && (
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
                          {section.equipRows.map((row, idx) => {
                            const rowKey = `equip-${section.location}-${idx}`;
                            const rowFlags = getFlagsForModel(row.modelNumber, flagsByRef);
                            const expanded = expandedKeys.has(rowKey);
                            const qty = row.quantity ?? 0;
                            const extCost = (row.unitCost ?? 0) * qty;
                            const extPrice = (row.unitPrice ?? 0) * qty;

                            return (
                              <Fragment key={rowKey}>
                                <tr className={`${idx % 2 === 1 ? 'bg-surface/30' : ''} ${
                                  rowFlags.length > 0 ? 'cursor-pointer hover:bg-surface/60' : ''
                                } ${expanded ? 'bg-surface/40' : ''} ${row.ownerFurnished ? 'opacity-70' : ''}`}
                                  onClick={() => rowFlags.length > 0 && toggleExpand(rowKey)}
                                >
                                  <td className="px-2 py-1.5 text-center">
                                    <FlagDot flags={rowFlags} expanded={expanded} onClick={() => toggleExpand(rowKey)} />
                                  </td>
                                  <td className="px-2 py-1.5 text-text-primary font-medium truncate max-w-[120px]">
                                    {row.manufacturer}
                                    {row.ownerFurnished && <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">OFE</span>}
                                  </td>
                                  <td className="px-2 py-1.5 text-text-primary font-mono truncate max-w-[140px]">{row.modelNumber}</td>
                                  <td className="px-2 py-1.5 text-text-secondary truncate max-w-[180px] hidden lg:table-cell">{row.description}</td>
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
                                          <FlagCard key={f.id} flag={f} onUpdateStatus={onUpdateStatus} />
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

                    {/* Labor table */}
                    {section.laborRows.length > 0 && (
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
                            {section.laborRows.map((row, idx) => {
                              const rowKey = `labor-${section.location}-${idx}`;
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
                                            <FlagCard key={f.id} flag={f} onUpdateStatus={onUpdateStatus} />
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

                    {/* Area margin flag */}
                    {section.areaFlag && (
                      <div className="px-3 py-2 border-t border-border/50 bg-amber-50/50">
                        <FlagCard flag={section.areaFlag} onUpdateStatus={onUpdateStatus} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
