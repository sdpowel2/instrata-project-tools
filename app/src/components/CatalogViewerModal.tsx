// ─── CatalogViewerModal ──────────────────────────────────────────────────────
// Read-only searchable product catalog viewer with server-side search & pagination.

import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, ChevronLeft, ChevronRight, Loader2, PackageSearch, AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { supabase } from '../lib/supabase';

interface CatalogViewerModalProps {
  open: boolean;
  onClose: () => void;
}

interface CatalogRow {
  id: string;
  manufacturer: string;
  model_number: string;
  description: string;
  cost: number | null;
  list_price: number | null;
  unit_of_measure: string;
  category: string;
  price_date: string | null;
}

const PAGE_SIZE = 50;
const STALE_DAYS = 90;

const isStale = (priceDate: string | null): boolean => {
  if (!priceDate) return true;
  const diff = Date.now() - new Date(priceDate).getTime();
  return diff > STALE_DAYS * 24 * 60 * 60 * 1000;
};

const fmt = (n: number | null) =>
  n !== null && n !== undefined
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';

export function CatalogViewerModal({ open, onClose }: CatalogViewerModalProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input
  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [search]);

  // Fetch with prioritized search using an RPC for multi-word, cross-column matching.
  // Falls back to a simple query when the RPC doesn't exist yet.
  // Words are matched independently: "Extron DTP" finds items where every word
  // appears in at least one of manufacturer, model_number, or description.
  // Priority: items matching on manufacturer/model ranked above description-only.
  const fetchData = useCallback(async () => {
    if (!open) return;
    setLoading(true);

    const COLS = 'id, manufacturer, model_number, description, cost, list_price, unit_of_measure, category, price_date';
    const term = debouncedSearch.trim();
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    if (!term) {
      const { data, count, error } = await supabase
        .from('product_catalog')
        .select(COLS, { count: 'exact' })
        .order('manufacturer')
        .order('model_number')
        .range(from, to);

      if (!error) {
        setRows((data as CatalogRow[]) ?? []);
        setTotal(count ?? 0);
      }
    } else {
      // Try RPC first (prioritized multi-word search)
      const { data: rpcData, error: rpcError } = await supabase
        .rpc('search_catalog', { search_term: term, page_from: from, page_to: to });

      if (!rpcError && rpcData) {
        const results = rpcData as (CatalogRow & { total_count: number })[];
        setRows(results);
        setTotal(results.length > 0 ? results[0].total_count : 0);
      } else {
        // Fallback: simple OR across all three columns, each word as a separate filter
        const words = term.split(/\s+/).filter(Boolean);
        let query = supabase
          .from('product_catalog')
          .select(COLS, { count: 'exact' })
          .order('manufacturer')
          .order('model_number')
          .range(from, to);

        // Each word must appear in at least one of the three columns
        for (const word of words) {
          const p = `%${word}%`;
          query = query.or(`manufacturer.ilike.${p},model_number.ilike.${p},description.ilike.${p}`);
        }

        const { data, count } = await query;
        setRows((data as CatalogRow[]) ?? []);
        setTotal(count ?? 0);
      }
    }
    setLoading(false);
  }, [open, page, debouncedSearch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset on close
  const handleClose = () => {
    setSearch('');
    setDebouncedSearch('');
    setPage(0);
    setRows([]);
    onClose();
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <Modal open={open} onClose={handleClose} title="Product Catalog" wide>
      <div className="min-h-[400px]">

        {/* Search bar */}
        <div className="relative mb-4">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/50" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by manufacturer, model, or description…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
            autoFocus
          />
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-navy" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
            <PackageSearch size={40} className="mb-3 opacity-30" />
            <p className="text-sm font-medium">
              {debouncedSearch ? 'No items match your search' : 'Catalog is empty'}
            </p>
            {debouncedSearch && (
              <p className="text-xs mt-1">Try a different search term</p>
            )}
          </div>
        ) : (
          <>
            <div className="border border-border rounded-lg overflow-hidden mb-3">
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-navy text-white text-left">
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Model</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Description</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">Cost</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right">MSRP</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">UOM</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Category</th>
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Price Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row, idx) => (
                      <tr key={row.id} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
                        <td className="px-3 py-2 font-medium text-text-primary whitespace-nowrap">{row.manufacturer}</td>
                        <td className="px-3 py-2 font-mono text-xs text-text-secondary whitespace-nowrap">{row.model_number}</td>
                        <td className="px-3 py-2 text-text-secondary max-w-[260px] truncate" title={row.description}>
                          {row.description || '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-text-primary whitespace-nowrap">{fmt(row.cost)}</td>
                        <td className="px-3 py-2 text-right text-text-primary whitespace-nowrap">{fmt(row.list_price)}</td>
                        <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{row.unit_of_measure || '—'}</td>
                        <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{row.category || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="flex items-center gap-1.5">
                            <span className="text-text-secondary">
                              {row.price_date
                                ? new Date(row.price_date + 'T00:00:00').toLocaleDateString()
                                : '—'}
                            </span>
                            {isStale(row.price_date) && (
                              <span title={row.price_date ? `Pricing is over ${STALE_DAYS} days old` : 'No price date set'}>
                                <AlertTriangle size={13} className="text-amber-500" />
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span>
                Showing {from}–{to} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => p - 1)}
                  disabled={page === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={12} /> Prev
                </button>
                <span className="px-2">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={page + 1 >= totalPages}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight size={12} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
