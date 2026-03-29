import { useMemo } from 'react';
import { X as XIcon, MapPin, Package } from 'lucide-react';
import type { ProjectBoMItem } from '../types';

interface BoMLocationViewProps {
  items: ProjectBoMItem[];
  onRemove?: (itemId: string) => void;
  showCutsheet?: boolean;
}

interface RoomGroup {
  room: string;
  entries: { item: ProjectBoMItem; qty: number }[];
}

export function BoMLocationView({ items, onRemove, showCutsheet }: BoMLocationViewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, { item: ProjectBoMItem; qty: number }[]>();

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

    const result: RoomGroup[] = [];
    const sorted = Array.from(map.entries()).sort(([a], [b]) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    });
    for (const [room, entries] of sorted) {
      result.push({ room, entries });
    }
    return result;
  }, [items]);

  const totalQty = items.reduce((sum, i) => sum + i.qty, 0);

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        <Package size={32} className="mx-auto mb-2 opacity-40" />
        <p className="text-sm">No items in the Bill of Materials yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.room} className="border border-border rounded-lg overflow-hidden">
          {/* Room header */}
          <div className="bg-navy/5 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="text-navy" />
              <span className="text-sm font-semibold text-navy">{group.room}</span>
            </div>
            <span className="text-xs text-text-secondary font-medium">
              {group.entries.length} {group.entries.length === 1 ? 'item' : 'items'}
            </span>
          </div>

          {/* Table */}
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
              {group.entries.map((entry, idx) => (
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
        </div>
      ))}

      {/* Summary footer */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface rounded-lg border border-border text-sm">
        <span className="text-text-secondary">
          <span className="font-semibold text-text-primary">{items.length}</span> unique{' '}
          {items.length === 1 ? 'item' : 'items'} across{' '}
          <span className="font-semibold text-text-primary">{groups.length}</span>{' '}
          {groups.length === 1 ? 'location' : 'locations'}
        </span>
        <span className="text-text-secondary">
          Total quantity: <span className="font-semibold text-navy">{totalQty}</span>
        </span>
      </div>
    </div>
  );
}
