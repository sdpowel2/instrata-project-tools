import { useState, useEffect, useRef } from 'react';
import { Upload, RefreshCw, Package, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { importDToolsCatalogCSV, type ImportSummary } from '@/lib/dtools/import-catalog';

interface CatalogStats {
  total: number;
  withPricing: number;
  discontinued: number;
  lastSyncedAt: string | null;
}

type ImportState = 'idle' | 'reading' | 'importing' | 'done' | 'error';

export function CatalogSyncStatus() {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [importState, setImportState] = useState<ImportState>('idle');
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function fetchStats() {
    setLoadingStats(true);
    try {
      const [totalRes, pricingRes, discontinuedRes, syncRes] = await Promise.all([
        supabase.from('product_catalog').select('id', { count: 'exact', head: true }),
        supabase
          .from('product_catalog')
          .select('id', { count: 'exact', head: true })
          .not('cost', 'is', null),
        supabase
          .from('product_catalog')
          .select('id', { count: 'exact', head: true })
          .eq('discontinued', true),
        supabase
          .from('product_catalog')
          .select('last_synced_at')
          .not('last_synced_at', 'is', null)
          .order('last_synced_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      setStats({
        total: totalRes.count ?? 0,
        withPricing: pricingRes.count ?? 0,
        discontinued: discontinuedRes.count ?? 0,
        lastSyncedAt: syncRes.data?.last_synced_at ?? null,
      });
    } finally {
      setLoadingStats(false);
    }
  }

  useEffect(() => {
    fetchStats();
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    runImport(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }

  async function runImport(file: File) {
    setImportState('reading');
    setSummary(null);
    setErrorMsg(null);
    setProgress({ processed: 0, total: 0 });

    try {
      const text = await file.text();
      setImportState('importing');

      const result = await importDToolsCatalogCSV(text, (processed, total) => {
        setProgress({ processed, total });
      });

      setSummary(result);
      setImportState('done');
      await fetchStats();
    } catch (err) {
      setErrorMsg(String(err));
      setImportState('error');
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString();
  }

  const pricingPct =
    stats && stats.total > 0
      ? Math.round((stats.withPricing / stats.total) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total Products"
          value={loadingStats ? '…' : stats?.total.toLocaleString() ?? '0'}
          icon={<Package className="w-5 h-5 text-blue-500" />}
        />
        <StatCard
          label="With Pricing"
          value={loadingStats ? '…' : `${stats?.withPricing.toLocaleString() ?? 0} (${pricingPct}%)`}
          icon={<CheckCircle className="w-5 h-5 text-green-500" />}
        />
        <StatCard
          label="Discontinued"
          value={loadingStats ? '…' : stats?.discontinued.toLocaleString() ?? '0'}
          icon={<AlertTriangle className="w-5 h-5 text-yellow-500" />}
        />
        <StatCard
          label="Last Synced"
          value={loadingStats ? '…' : formatDate(stats?.lastSyncedAt ?? null)}
          icon={<RefreshCw className="w-5 h-5 text-slate-400" />}
          small
        />
      </div>

      {/* Import Action */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-700">Import D-Tools CSV Export</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Upload the full catalog CSV exported from D-Tools SI. Existing products will be updated; new ones added.
            </p>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importState === 'reading' || importState === 'importing'}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <Upload className="w-4 h-4" />
            {importState === 'reading' ? 'Reading…' : importState === 'importing' ? 'Importing…' : 'Upload CSV'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Progress */}
        {importState === 'importing' && progress.total > 0 && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-slate-500 mb-1">
              <span>Processing rows…</span>
              <span>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div
                className="h-2 rounded-full bg-blue-500 transition-all"
                style={{ width: `${Math.round((progress.processed / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Result */}
        {importState === 'done' && summary && (
          <div className="mt-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 flex items-start gap-2">
            <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
            <div className="text-xs text-green-800 space-y-0.5">
              <p className="font-medium">Import complete</p>
              <p>
                {summary.updated.toLocaleString()} rows synced
                {summary.skipped > 0 ? `, ${summary.skipped} skipped` : ''}
                {summary.errors > 0 ? `, ${summary.errors} errors` : ''}
              </p>
              {summary.errorDetails.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-green-700 hover:underline">
                    Show details ({summary.errorDetails.length})
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-green-700 max-h-32 overflow-y-auto">
                    {summary.errorDetails.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        {importState === 'error' && errorMsg && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 flex items-start gap-2">
            <XCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            <p className="text-xs text-red-800">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  small = false,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className={`font-semibold text-slate-800 truncate ${small ? 'text-xs' : 'text-base'}`}>{value}</p>
      </div>
    </div>
  );
}
