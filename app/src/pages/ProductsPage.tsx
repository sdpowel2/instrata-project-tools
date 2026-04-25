// Products — unified page for browsing cutsheets, tracking personal uploads,
// and managing the product catalog. Replaces three standalone sidebar entries.
// Uses tabs because each sub-section has its own dense interior UI (the
// repository's list+preview layout especially) that benefits from owning the
// full viewport when active.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, Upload, Database, Loader2, Plus, Search,
  ChevronLeft, ChevronRight, PackageSearch, AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { PageHeader } from '../components/ui';
import { CatalogImportModal } from '../components/CatalogImportModal';
import { CutsheetMyUploadsSection } from './CutsheetMyUploads';
import { CutsheetRepositorySection } from './CutsheetRepository';

type TabKey = 'repository' | 'uploads' | 'catalog';

interface TabDef {
  key: TabKey;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  adminOnly?: boolean;
}

const TABS: TabDef[] = [
  { key: 'repository', label: 'Cutsheet Repository', icon: BookOpen },
  { key: 'uploads',    label: 'My Uploads',          icon: Upload },
  { key: 'catalog',    label: 'Product Catalog',     icon: Database, adminOnly: true },
];

export function ProductsPage() {
  const { isAdmin } = useAuth();
  const visibleTabs = TABS.filter((t) => !t.adminOnly || isAdmin);
  const [active, setActive] = useState<TabKey>('repository');

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="Workspace"
        title="Products"
        subtitle="Browse the cutsheet repository, track your own uploads, and manage the product catalog."
      />

      <div className="flex items-center gap-1 border-b border-border mb-6">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActive(tab.key)}
              className={[
                'flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-orange text-navy'
                  : 'border-transparent text-fg-2 hover:text-navy',
              ].join(' ')}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {active === 'repository' && <CutsheetRepositorySection />}
      {active === 'uploads'    && <CutsheetMyUploadsSection />}
      {active === 'catalog'    && isAdmin && <ProductCatalogSection />}
    </div>
  );
}

// Inlined from SettingsPage — admin-only catalog import + inline search/browse.
// Catalog search used to live in a modal; inside a dedicated Products tab the
// modal was just an extra click for no gain, so the browser renders inline.
function ProductCatalogSection() {
  const [modalOpen, setModalOpen] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured()) return;
    supabase.from('product_catalog').select('id', { count: 'exact', head: true }).then(({ count }) => {
      setCatalogCount(count ?? 0);
    });
  }, []);

  useEffect(() => { refreshCount(); }, [refreshCount]);

  const handleComplete = (count: number) => {
    setResult(count);
    refreshCount();
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-border rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-navy">Product Catalog</div>
            <p className="text-xs text-fg-2 mt-0.5">
              Reference list of products used for bid leveling, auto-review, and submittal lookups.
              Import from CSV or Excel; existing items (matched by manufacturer + model) are updated automatically.
            </p>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-fg-2">Catalog size</div>
            <div className="text-lg font-bold text-navy mt-0.5">
              {catalogCount === null ? (
                <Loader2 size={16} className="animate-spin inline text-fg-2" />
              ) : (
                `${catalogCount.toLocaleString()} items`
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-4 mt-4 border-t border-border">
          <button
            onClick={() => { setResult(null); setModalOpen(true); }}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={14} /> Import from CSV
          </button>
        </div>

        {result !== null && (
          <div className="mt-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            Import complete — {result.toLocaleString()} items processed.
          </div>
        )}
      </div>

      <CatalogBrowser />

      <CatalogImportModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onComplete={handleComplete}
      />
    </div>
  );
}

// ─── Inline catalog browser ────────────────────────────────────────────────
// Lifted from CatalogViewerModal so the catalog is searchable inline on the
// Products page instead of hidden behind a "Browse Catalog" button.

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

const CATALOG_PAGE_SIZE = 50;
const CATALOG_STALE_DAYS = 90;

const catalogIsStale = (priceDate: string | null): boolean => {
  if (!priceDate) return true;
  const diff = Date.now() - new Date(priceDate).getTime();
  return diff > CATALOG_STALE_DAYS * 24 * 60 * 60 * 1000;
};

const fmtMoney = (n: number | null) =>
  n !== null && n !== undefined
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';

function CatalogBrowser() {
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

  // Fetch with prioritized search using an RPC for multi-word, cross-column
  // matching. Falls back to a plain OR query when the RPC doesn't exist yet.
  const fetchData = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setLoading(true);

    const COLS = 'id, manufacturer, model_number, description, cost, list_price, unit_of_measure, category, price_date';
    const term = debouncedSearch.trim();
    const from = page * CATALOG_PAGE_SIZE;
    const to = from + CATALOG_PAGE_SIZE - 1;

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
      const { data: rpcData, error: rpcError } = await supabase
        .rpc('search_catalog', { search_term: term, page_from: from, page_to: to });

      if (!rpcError && rpcData) {
        const results = rpcData as (CatalogRow & { total_count: number })[];
        setRows(results);
        setTotal(results.length > 0 ? results[0].total_count : 0);
      } else {
        const words = term.split(/\s+/).filter(Boolean);
        let query = supabase
          .from('product_catalog')
          .select(COLS, { count: 'exact' })
          .order('manufacturer')
          .order('model_number')
          .range(from, to);
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
  }, [page, debouncedSearch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const showingFrom = page * CATALOG_PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * CATALOG_PAGE_SIZE, total);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm p-5">
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/50" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by manufacturer, model, or description…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
        />
      </div>

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
          {debouncedSearch && <p className="text-xs mt-1">Try a different search term</p>}
          {!debouncedSearch && <p className="text-xs mt-1">Import a CSV to populate the catalog.</p>}
        </div>
      ) : (
        <>
          <div className="border border-border rounded-lg overflow-hidden mb-3">
            <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
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
                      <td className="px-3 py-2 text-right text-text-primary whitespace-nowrap">{fmtMoney(row.cost)}</td>
                      <td className="px-3 py-2 text-right text-text-primary whitespace-nowrap">{fmtMoney(row.list_price)}</td>
                      <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{row.unit_of_measure || '—'}</td>
                      <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{row.category || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          <span className="text-text-secondary">
                            {row.price_date
                              ? new Date(row.price_date + 'T00:00:00').toLocaleDateString()
                              : '—'}
                          </span>
                          {catalogIsStale(row.price_date) && (
                            <span title={row.price_date ? `Pricing is over ${CATALOG_STALE_DAYS} days old` : 'No price date set'}>
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

          <div className="flex items-center justify-between text-xs text-text-secondary">
            <span>Showing {showingFrom}–{showingTo} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => p - 1)}
                disabled={page === 0}
                className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={12} /> Prev
              </button>
              <span className="px-2">Page {page + 1} of {totalPages}</span>
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
  );
}
