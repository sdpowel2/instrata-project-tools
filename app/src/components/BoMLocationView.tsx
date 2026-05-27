import { useMemo, useState } from 'react';
import { X as XIcon, MapPin, Package, ChevronDown, ChevronRight, DollarSign, Wrench } from 'lucide-react';
import type { ProjectBoMItem } from '../types';

interface BoMLocationViewProps {
  items: ProjectBoMItem[];
  onRemove?: (itemId: string) => void;
  showCutsheet?: boolean;
}

interface LocationEntry { item: ProjectBoMItem; qty: number }

/** A node in the location tree. */
interface LocationNode {
  name: string;
  fullPath: string;
  entries: LocationEntry[];       // Product entries at this leaf
  laborEntries: LocationEntry[];  // Labor entries at this leaf
  children: LocationNode[];
  equipCost: number;   // aggregated: own + descendants
  equipPrice: number;
  laborCost: number;
  laborPrice: number;
}

// ─── Pricing helpers (mirrors ReviewBoMTable patterns) ──────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

const fmt = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtUnit = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number) => `${v.toFixed(1)}%`;

function marginClass(price: number, cost: number): string {
  if (price <= 0) return 'text-text-secondary';
  const m = ((price - cost) / price) * 100;
  if (m < 20) return 'text-red-600 font-semibold';
  if (m < 30) return 'text-amber-600 font-medium';
  return 'text-green-700';
}

function marginPctStr(price: number, cost: number): string {
  if (price <= 0) return '\u2014';
  return fmtPct(((price - cost) / price) * 100);
}

// ─── Compute pricing for entries at a single node ───────────────────────────

function computeNodePricing(entries: LocationEntry[], laborEntries: LocationEntry[]) {
  let equipCost = 0, equipPrice = 0, laborCost = 0, laborPrice = 0;

  for (const e of entries) {
    const { item, qty } = e;
    equipCost  += round2((item.unitCost  ?? 0) * qty);
    equipPrice += round2((item.unitPrice ?? 0) * qty);
    // Embedded labor on product items
    if ((item.laborHours ?? 0) > 0) {
      laborCost  += round2((item.laborHours ?? 0) * (item.laborUnitCost  ?? 0) * qty);
      laborPrice += round2((item.laborHours ?? 0) * (item.laborUnitPrice ?? 0) * qty);
    }
  }

  for (const e of laborEntries) {
    const { item, qty } = e;
    if ((item.laborHours ?? 0) > 0) {
      laborCost  += round2((item.laborHours ?? 0) * (item.laborUnitCost  ?? 0) * qty);
      laborPrice += round2((item.laborHours ?? 0) * (item.laborUnitPrice ?? 0) * qty);
    }
    if ((item.fixedLaborCost ?? 0) > 0) {
      laborCost  += round2((item.fixedLaborCost  ?? 0) * qty);
      laborPrice += round2((item.fixedLaborPrice ?? 0) * qty);
    }
  }

  return { equipCost, equipPrice, laborCost, laborPrice };
}

// ─── Build location tree ────────────────────────────────────────────────────

function buildLocationTree(
  flatGroups: Map<string, LocationEntry[]>,
  flatLaborGroups: Map<string, LocationEntry[]>,
): LocationNode[] {
  const rootNodes: LocationNode[] = [];

  function ensureNode(segments: string[], siblings: LocationNode[], pathSoFar: string): LocationNode {
    const name = segments[0];
    const fullPath = pathSoFar ? `${pathSoFar}\\${name}` : name;
    let node = siblings.find((n) => n.fullPath === fullPath);
    if (!node) {
      node = { name, fullPath, entries: [], laborEntries: [], children: [],
               equipCost: 0, equipPrice: 0, laborCost: 0, laborPrice: 0 };
      siblings.push(node);
    }
    if (segments.length > 1) {
      return ensureNode(segments.slice(1), node.children, fullPath);
    }
    return node;
  }

  const allKeys = new Set([...flatGroups.keys(), ...flatLaborGroups.keys()]);
  const sortedKeys = Array.from(allKeys).filter(k => k !== 'Unassigned').sort();

  for (const room of sortedKeys) {
    const segments = room.split('\\').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    const node = ensureNode(segments, rootNodes, '');
    node.entries = flatGroups.get(room) || [];
    node.laborEntries = flatLaborGroups.get(room) || [];
  }

  // Sort children alphabetically, then compute pricing bottom-up
  function processTree(nodes: LocationNode[]) {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) {
      processTree(n.children);
      const own = computeNodePricing(n.entries, n.laborEntries);
      n.equipCost  = own.equipCost;
      n.equipPrice = own.equipPrice;
      n.laborCost  = own.laborCost;
      n.laborPrice = own.laborPrice;
      // Roll up children
      for (const child of n.children) {
        n.equipCost  += child.equipCost;
        n.equipPrice += child.equipPrice;
        n.laborCost  += child.laborCost;
        n.laborPrice += child.laborPrice;
      }
    }
  }
  processTree(rootNodes);

  return rootNodes;
}

function countEntries(node: LocationNode): number {
  let count = node.entries.length + node.laborEntries.length;
  for (const child of node.children) count += countEntries(child);
  return count;
}

// ─── Equipment Table ────────────────────────────────────────────────────────

function EquipmentTable({
  entries,
  onRemove,
  showCutsheet,
}: {
  entries: LocationEntry[];
  onRemove?: (itemId: string) => void;
  showCutsheet?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-navy text-white text-left">
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Model</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider hidden lg:table-cell">Description</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center">Qty</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Unit Cost</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Ext Cost</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Unit Price</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Ext Price</th>
          <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Margin</th>
          {showCutsheet && (
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Cutsheet</th>
          )}
          {onRemove && (
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider w-10" />
          )}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {entries.map((entry, idx) => {
          const extCost = round2((entry.item.unitCost ?? 0) * entry.qty);
          const extPrice = round2((entry.item.unitPrice ?? 0) * entry.qty);
          return (
            <tr key={`${entry.item.id}-${idx}`} className={`${idx % 2 === 1 ? 'bg-surface/30' : ''} ${entry.item.ownerFurnished || entry.item.optional ? 'opacity-70' : ''}`}>
              <td className="px-3 py-2 font-medium text-text-primary">
                {entry.item.manufacturer}
                {entry.item.ownerFurnished && <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">OFE</span>}
                {entry.item.optional && <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded">OPT</span>}
              </td>
              <td className="px-3 py-2 font-mono text-text-secondary">{entry.item.model}</td>
              <td className="px-3 py-2 text-text-secondary hidden lg:table-cell">{entry.item.description || '\u2014'}</td>
              <td className="px-3 py-2 text-center font-semibold text-navy">{entry.qty}</td>
              <td className="px-3 py-2 text-right text-text-secondary">{fmtUnit(entry.item.unitCost ?? 0)}</td>
              <td className="px-3 py-2 text-right font-medium">{fmt(extCost)}</td>
              <td className="px-3 py-2 text-right text-text-secondary">{fmtUnit(entry.item.unitPrice ?? 0)}</td>
              <td className="px-3 py-2 text-right font-medium">{fmt(extPrice)}</td>
              <td className={`px-3 py-2 text-right ${marginClass(extPrice, extCost)}`}>
                {marginPctStr(extPrice, extCost)}
              </td>
              {showCutsheet && (
                <td className="px-3 py-2 text-xs text-text-secondary">
                  {entry.item.cutSheetName || '\u2014'}
                </td>
              )}
              {onRemove && (
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => onRemove(entry.item.id)}
                    className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
                    title="Remove item"
                  >
                    <XIcon size={14} />
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Labor Table ────────────────────────────────────────────────────────────

function LaborTable({
  entries,
  onRemove,
}: {
  entries: LocationEntry[];
  onRemove?: (itemId: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="bg-gray-50 px-3 py-1.5 border-t border-border flex items-center gap-1.5">
        <Wrench size={12} className="text-text-secondary" />
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Labor</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-navy/80 text-white text-left">
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Labor Type</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider hidden lg:table-cell">Description</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center">Qty</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Hours</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Ext Cost</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Ext Price</th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Margin</th>
            {onRemove && (
              <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider w-10" />
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry, idx) => {
            const qty = entry.qty;
            const hours = (entry.item.laborHours ?? 0) * qty;
            let extCost = 0, extPrice = 0;
            if ((entry.item.laborHours ?? 0) > 0) {
              extCost  = round2((entry.item.laborHours ?? 0) * (entry.item.laborUnitCost  ?? 0) * qty);
              extPrice = round2((entry.item.laborHours ?? 0) * (entry.item.laborUnitPrice ?? 0) * qty);
            }
            if ((entry.item.fixedLaborCost ?? 0) > 0) {
              extCost  += round2((entry.item.fixedLaborCost  ?? 0) * qty);
              extPrice += round2((entry.item.fixedLaborPrice ?? 0) * qty);
            }
            return (
              <tr key={`${entry.item.id}-labor-${idx}`} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
                <td className="px-3 py-2 font-medium text-text-primary">{entry.item.model || entry.item.manufacturer || 'Labor'}</td>
                <td className="px-3 py-2 text-text-secondary hidden lg:table-cell">{entry.item.description || '\u2014'}</td>
                <td className="px-3 py-2 text-center font-semibold">{qty}</td>
                <td className="px-3 py-2 text-right">{hours > 0 ? hours.toFixed(1) : '\u2014'}</td>
                <td className="px-3 py-2 text-right font-medium">{fmt(extCost)}</td>
                <td className="px-3 py-2 text-right font-medium">{fmt(extPrice)}</td>
                <td className={`px-3 py-2 text-right ${marginClass(extPrice, extCost)}`}>
                  {marginPctStr(extPrice, extCost)}
                </td>
                {onRemove && (
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => onRemove(entry.item.id)}
                      className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
                      title="Remove item"
                    >
                      <XIcon size={14} />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ─── Location Node ──────────────────────────────────────────────────────────

function LocationNodeView({
  node,
  depth,
  onRemove,
  showCutsheet,
}: {
  node: LocationNode;
  depth: number;
  onRemove?: (itemId: string) => void;
  showCutsheet?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const totalItems = countEntries(node);
  const hasContent = node.entries.length > 0 || node.laborEntries.length > 0 || hasChildren;
  const sectionTotal = node.equipCost + node.laborCost;
  const sectionPrice = node.equipPrice + node.laborPrice;

  return (
    <div className={depth > 0 ? 'ml-6' : ''}>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Location header */}
        <div
          className={`px-4 py-2.5 cursor-pointer ${
            hasChildren ? 'bg-navy/10' : 'bg-navy/5'
          }`}
          onClick={hasContent ? () => setExpanded(!expanded) : undefined}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {hasContent ? (
                expanded ? <ChevronDown size={14} className="text-navy" /> : <ChevronRight size={14} className="text-navy" />
              ) : (
                <MapPin size={14} className="text-navy" />
              )}
              <span className={`text-sm font-semibold text-navy ${hasChildren ? 'text-base' : ''}`}>
                {node.name}
              </span>
              <span className="text-xs text-text-secondary font-medium">
                {hasChildren
                  ? `${totalItems} ${totalItems === 1 ? 'item' : 'items'} across ${node.children.length} sub-location${node.children.length === 1 ? '' : 's'}`
                  : `${totalItems} ${totalItems === 1 ? 'item' : 'items'}`
                }
              </span>
            </div>
          </div>
          {/* Pricing summary line */}
          {(sectionTotal > 0 || sectionPrice > 0) && (
            <div className="flex items-center gap-4 mt-1 ml-6 text-[11px] text-text-secondary flex-wrap">
              <span className="flex items-center gap-1">
                <DollarSign size={10} />
                Equip: {fmt(node.equipCost)} / {fmt(node.equipPrice)}
                <span className={marginClass(node.equipPrice, node.equipCost)}>
                  ({marginPctStr(node.equipPrice, node.equipCost)})
                </span>
              </span>
              {(node.laborCost > 0 || node.laborPrice > 0) && (
                <span className="flex items-center gap-1">
                  <Wrench size={10} />
                  Labor: {fmt(node.laborCost)} / {fmt(node.laborPrice)}
                  <span className={marginClass(node.laborPrice, node.laborCost)}>
                    ({marginPctStr(node.laborPrice, node.laborCost)})
                  </span>
                </span>
              )}
              <span className="font-medium text-text-primary">
                Total: {fmt(sectionTotal)} / {fmt(sectionPrice)}
              </span>
            </div>
          )}
        </div>

        {/* Items directly in this location */}
        {expanded && node.entries.length > 0 && (
          <EquipmentTable entries={node.entries} onRemove={onRemove} showCutsheet={showCutsheet} />
        )}

        {/* Labor items in this location */}
        {expanded && node.laborEntries.length > 0 && (
          <LaborTable entries={node.laborEntries} onRemove={onRemove} />
        )}
      </div>

      {/* Child locations */}
      {hasChildren && expanded && (
        <div className="mt-2 space-y-2">
          {node.children.map((child) => (
            <LocationNodeView
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              onRemove={onRemove}
              showCutsheet={showCutsheet}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function BoMLocationView({ items, onRemove, showCutsheet }: BoMLocationViewProps) {
  const { tree, unassigned, unassignedLabor, totals } = useMemo(() => {
    const equipMap = new Map<string, LocationEntry[]>();
    const laborMap = new Map<string, LocationEntry[]>();

    for (const item of items) {
      const isLabor = item.itemType === 'Labor';
      const targetMap = isLabor ? laborMap : equipMap;

      if (item.locations.length === 0) {
        const key = 'Unassigned';
        if (!targetMap.has(key)) targetMap.set(key, []);
        targetMap.get(key)!.push({ item, qty: item.qty });
      } else {
        for (const loc of item.locations) {
          const key = loc.room;
          if (!targetMap.has(key)) targetMap.set(key, []);
          targetMap.get(key)!.push({ item, qty: loc.qty });
        }
      }
    }

    const unassignedEntries = equipMap.get('Unassigned') || [];
    const unassignedLaborEntries = laborMap.get('Unassigned') || [];
    const locationTree = buildLocationTree(equipMap, laborMap);

    // Compute project totals from root nodes + unassigned
    let equipCost = 0, equipPrice = 0, laborCost = 0, laborPrice = 0;
    for (const node of locationTree) {
      equipCost  += node.equipCost;
      equipPrice += node.equipPrice;
      laborCost  += node.laborCost;
      laborPrice += node.laborPrice;
    }
    // Add unassigned items
    const unassignedPricing = computeNodePricing(unassignedEntries, unassignedLaborEntries);
    equipCost  += unassignedPricing.equipCost;
    equipPrice += unassignedPricing.equipPrice;
    laborCost  += unassignedPricing.laborCost;
    laborPrice += unassignedPricing.laborPrice;

    return {
      tree: locationTree,
      unassigned: unassignedEntries,
      unassignedLabor: unassignedLaborEntries,
      totals: { equipCost, equipPrice, laborCost, laborPrice },
    };
  }, [items]);

  const totalCost = totals.equipCost + totals.laborCost;
  const totalPrice = totals.equipPrice + totals.laborPrice;

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        <Package size={32} className="mx-auto mb-2 opacity-40" />
        <p className="text-sm">No line items yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {tree.map((node) => (
        <LocationNodeView
          key={node.fullPath}
          node={node}
          depth={0}
          onRemove={onRemove}
          showCutsheet={showCutsheet}
        />
      ))}

      {/* Unassigned items */}
      {(unassigned.length > 0 || unassignedLabor.length > 0) && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="bg-navy/5 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="text-navy" />
              <span className="text-sm font-semibold text-navy">Unassigned</span>
            </div>
            <span className="text-xs text-text-secondary font-medium">
              {unassigned.length + unassignedLabor.length} {(unassigned.length + unassignedLabor.length) === 1 ? 'item' : 'items'}
            </span>
          </div>
          {unassigned.length > 0 && (
            <EquipmentTable entries={unassigned} onRemove={onRemove} showCutsheet={showCutsheet} />
          )}
          {unassignedLabor.length > 0 && (
            <LaborTable entries={unassignedLabor} onRemove={onRemove} />
          )}
        </div>
      )}

      {/* Project totals footer */}
      {(totalCost > 0 || totalPrice > 0) ? (
        <div className="bg-surface rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 bg-navy/5 border-b border-border">
            <span className="text-sm font-semibold text-navy">Project Totals</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-4 text-sm">
            {/* Equipment */}
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1 flex items-center gap-1">
                <DollarSign size={10} /> Equipment
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Cost:</span>
                <span className="font-semibold">{fmt(totals.equipCost)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Price:</span>
                <span className="font-semibold">{fmt(totals.equipPrice)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Margin:</span>
                <span className={`font-semibold ${marginClass(totals.equipPrice, totals.equipCost)}`}>
                  {marginPctStr(totals.equipPrice, totals.equipCost)}
                </span>
              </div>
            </div>
            {/* Labor */}
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1 flex items-center gap-1">
                <Wrench size={10} /> Labor
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Cost:</span>
                <span className="font-semibold">{fmt(totals.laborCost)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Price:</span>
                <span className="font-semibold">{fmt(totals.laborPrice)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-text-secondary">Margin:</span>
                <span className={`font-semibold ${marginClass(totals.laborPrice, totals.laborCost)}`}>
                  {marginPctStr(totals.laborPrice, totals.laborCost)}
                </span>
              </div>
            </div>
            {/* Total Cost */}
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Total Cost</div>
              <div className="text-xl font-bold text-navy">{fmt(totalCost)}</div>
            </div>
            {/* Total Price */}
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Total Price</div>
              <div className="text-xl font-bold text-navy">{fmt(totalPrice)}</div>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-xs text-text-secondary">Margin:</span>
                <span className={`text-sm font-bold ${marginClass(totalPrice, totalCost)}`}>
                  {marginPctStr(totalPrice, totalCost)}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-4 py-3 bg-surface rounded-lg border border-border text-sm">
          <span className="text-text-secondary">
            <span className="font-semibold text-text-primary">{items.length}</span> unique{' '}
            {items.length === 1 ? 'item' : 'items'}
          </span>
          <span className="text-text-secondary">
            Total quantity: <span className="font-semibold text-navy">{items.reduce((sum, i) => sum + i.qty, 0)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
