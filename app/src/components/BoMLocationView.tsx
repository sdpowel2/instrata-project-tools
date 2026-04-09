import { useMemo, useState } from 'react';
import { X as XIcon, MapPin, Package, ChevronDown, ChevronRight } from 'lucide-react';
import type { ProjectBoMItem } from '../types';

interface BoMLocationViewProps {
  items: ProjectBoMItem[];
  onRemove?: (itemId: string) => void;
  showCutsheet?: boolean;
}

interface LocationEntry { item: ProjectBoMItem; qty: number }

/** A node in the location tree. Leaf nodes have entries; parent nodes have children. */
interface LocationNode {
  name: string;        // display name (last segment)
  fullPath: string;    // full backslash-delimited path
  entries: LocationEntry[];
  children: LocationNode[];
}

/** Parse flat room strings into a tree using `\` as the hierarchy delimiter. */
function buildLocationTree(
  flatGroups: Map<string, LocationEntry[]>,
): LocationNode[] {
  const rootNodes: LocationNode[] = [];

  // Helper to find or create a node at a given path
  function ensureNode(segments: string[], siblings: LocationNode[], pathSoFar: string): LocationNode {
    const name = segments[0];
    const fullPath = pathSoFar ? `${pathSoFar}\\${name}` : name;
    let node = siblings.find((n) => n.fullPath === fullPath);
    if (!node) {
      node = { name, fullPath, entries: [], children: [] };
      siblings.push(node);
    }
    if (segments.length > 1) {
      return ensureNode(segments.slice(1), node.children, fullPath);
    }
    return node;
  }

  // Sort keys so parents are processed before children
  const sortedKeys = Array.from(flatGroups.keys()).sort();

  for (const room of sortedKeys) {
    if (room === 'Unassigned') continue;
    const segments = room.split('\\').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    const node = ensureNode(segments, rootNodes, '');
    node.entries = flatGroups.get(room) || [];
  }

  // Sort children alphabetically at each level
  function sortTree(nodes: LocationNode[]) {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortTree(n.children);
  }
  sortTree(rootNodes);

  return rootNodes;
}

/** Count all entries in a node and its descendants. */
function countEntries(node: LocationNode): number {
  let count = node.entries.length;
  for (const child of node.children) count += countEntries(child);
  return count;
}

function ItemTable({
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
          <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
          <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider">Model</th>
          <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider">Description</th>
          <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-center">Qty</th>
          {showCutsheet && (
            <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider">Cutsheet</th>
          )}
          {onRemove && (
            <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider w-10" />
          )}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {entries.map((entry, idx) => (
          <tr key={`${entry.item.id}-${idx}`} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
            <td className="px-4 py-2 font-medium text-text-primary">{entry.item.manufacturer}</td>
            <td className="px-4 py-2 font-mono text-text-secondary">{entry.item.model}</td>
            <td className="px-4 py-2 text-text-secondary">{entry.item.description || '—'}</td>
            <td className="px-4 py-2 text-center font-semibold text-navy">{entry.qty}</td>
            {showCutsheet && (
              <td className="px-4 py-2 text-xs text-text-secondary">
                {entry.item.cutSheetName || '—'}
              </td>
            )}
            {onRemove && (
              <td className="px-4 py-2 text-center">
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
        ))}
      </tbody>
    </table>
  );
}

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
  const hasContent = node.entries.length > 0 || hasChildren;

  return (
    <div className={depth > 0 ? 'ml-6' : ''}>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Location header — always collapsible */}
        <div
          className={`px-4 py-2.5 flex items-center justify-between cursor-pointer ${
            hasChildren ? 'bg-navy/10' : 'bg-navy/5'
          }`}
          onClick={hasContent ? () => setExpanded(!expanded) : undefined}
        >
          <div className="flex items-center gap-2">
            {hasContent ? (
              expanded ? <ChevronDown size={14} className="text-navy" /> : <ChevronRight size={14} className="text-navy" />
            ) : (
              <MapPin size={14} className="text-navy" />
            )}
            <span className={`text-sm font-semibold text-navy ${hasChildren ? 'text-base' : ''}`}>
              {node.name}
            </span>
          </div>
          <span className="text-xs text-text-secondary font-medium">
            {hasChildren
              ? `${totalItems} ${totalItems === 1 ? 'item' : 'items'} across ${node.children.length} sub-location${node.children.length === 1 ? '' : 's'}`
              : `${node.entries.length} ${node.entries.length === 1 ? 'item' : 'items'}`
            }
          </span>
        </div>

        {/* Items directly in this location */}
        {node.entries.length > 0 && expanded && (
          <ItemTable entries={node.entries} onRemove={onRemove} showCutsheet={showCutsheet} />
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

export function BoMLocationView({ items, onRemove, showCutsheet }: BoMLocationViewProps) {
  const { tree, unassigned, flatGroupCount } = useMemo(() => {
    const map = new Map<string, LocationEntry[]>();

    for (const item of items) {
      if (item.locations.length === 0) {
        const key = 'Unassigned';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ item, qty: item.qty });
      } else {
        for (const loc of item.locations) {
          const key = loc.room;
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({ item, qty: loc.qty });
        }
      }
    }

    const unassignedEntries = map.get('Unassigned') || [];
    const locationTree = buildLocationTree(map);
    // Count all unique location groups (for summary)
    const groupCount = map.size - (unassignedEntries.length > 0 ? 0 : 0);

    return { tree: locationTree, unassigned: unassignedEntries, flatGroupCount: groupCount };
  }, [items]);

  const totalQty = items.reduce((sum, i) => sum + i.qty, 0);
  const locationCount = flatGroupCount;

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        <Package size={32} className="mx-auto mb-2 opacity-40" />
        <p className="text-sm">No items in the Bill of Materials yet.</p>
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
      {unassigned.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="bg-navy/5 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="text-navy" />
              <span className="text-sm font-semibold text-navy">Unassigned</span>
            </div>
            <span className="text-xs text-text-secondary font-medium">
              {unassigned.length} {unassigned.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <ItemTable entries={unassigned} onRemove={onRemove} showCutsheet={showCutsheet} />
        </div>
      )}

      {/* Summary footer */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface rounded-lg border border-border text-sm">
        <span className="text-text-secondary">
          <span className="font-semibold text-text-primary">{items.length}</span> unique{' '}
          {items.length === 1 ? 'item' : 'items'} across{' '}
          <span className="font-semibold text-text-primary">{locationCount}</span>{' '}
          {locationCount === 1 ? 'location' : 'locations'}
        </span>
        <span className="text-text-secondary">
          Total quantity: <span className="font-semibold text-navy">{totalQty}</span>
        </span>
      </div>
    </div>
  );
}
