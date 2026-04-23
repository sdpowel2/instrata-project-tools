// Manager Dashboard — surfaces items from the AV Pre-Sales Summary board's
// "New Requests" group that need a manager's attention.
//
//   - Needs Triage: has a due date but no pre-sales engineer assigned
//   - Needs Review: status column set to "Review", listed by closest due date
//
// Data comes from the monday-manager-dashboard edge function. This page does
// not link out to Monday — it's explicitly a "what needs doing in Monday"
// worklist that the user will act on inside Monday itself.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, RefreshCw, Loader2, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Eyebrow, PageHeader } from '../components/ui';

interface ManagerItem {
  id: string;
  name: string;
  dueDate: string;
}

interface FeedResponse {
  triage: ManagerItem[];
  review: ManagerItem[];
  fetchedAt: string;
  warning?: string;
}

export function ManagerDashboardPage() {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke<FeedResponse>(
        'monday-manager-dashboard',
        { body: {} },
      );
      if (error) throw error;
      if (!data) throw new Error('Empty response');
      setData(data);
    } catch (err) {
      console.error('[ManagerDashboard] refresh failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const lastFetched = data?.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : null;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1200px]">
      <PageHeader
        eyebrow="Monday.com · Pre-Sales Summary"
        title="Manager Dashboard"
        subtitle={
          <>
            Items from the <strong>New Requests</strong> group that need a manager's attention.
            {lastFetched && <> · Last refreshed {lastFetched}</>}
          </>
        }
        actions={
          <button
            onClick={refresh}
            disabled={loading}
            className="btn-secondary disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong className="font-semibold">Couldn't load feed:</strong> {error}
        </div>
      )}

      {data?.warning && (
        <div className="mb-5 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          {data.warning}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">
        <CategoryCard
          eyebrow="Needs Triage"
          title="Unassigned with due date"
          description="Has a due date set in Monday but no pre-sales engineer assigned yet."
          accent="#B91C1C"
          accentBg="rgba(185,28,28,0.08)"
          icon={Users}
          items={data?.triage ?? []}
          loading={loading && !data}
          emptyMessage="All requests with due dates have an engineer assigned."
          renderMeta={(item) => <DueDatePill dueDate={item.dueDate} />}
        />

        <CategoryCard
          eyebrow="Needs Review"
          title="Status: Review"
          description="Assigned engineer has flagged these for manager review."
          accent="#1D4ED8"
          accentBg="rgba(29,78,216,0.08)"
          icon={ClipboardList}
          items={data?.review ?? []}
          loading={loading && !data}
          emptyMessage="Nothing in the review queue."
          renderMeta={(item) => <DueDatePill dueDate={item.dueDate} emphasisWhenSoon />}
        />
      </div>
    </div>
  );
}

interface CategoryCardProps {
  eyebrow: string;
  title: string;
  description: string;
  accent: string;
  accentBg: string;
  icon: React.ComponentType<{ size?: number }>;
  items: ManagerItem[];
  loading: boolean;
  emptyMessage: string;
  renderMeta: (item: ManagerItem) => React.ReactNode;
}

function CategoryCard({ eyebrow, title, description, accent, accentBg, icon: Icon, items, loading, emptyMessage, renderMeta }: CategoryCardProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-border" style={{ background: accentBg }}>
        <div
          className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: accent, color: '#fff' }}
        >
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow color={accent}>{eyebrow}</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">
            {title}
            <span className="ml-2.5 text-sm font-medium text-fg-2">{items.length}</span>
          </h2>
          <div className="text-[13px] text-fg-2 mt-0.5">{description}</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-fg-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading from Monday.com…
        </div>
      ) : items.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-fg-2">
          {emptyMessage}
        </div>
      ) : (
        <div>
          {items.map((item, i) => (
            <div
              key={item.id}
              className={`flex items-center gap-4 px-5 py-3.5 ${i === 0 ? '' : 'border-t border-border'}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-fg truncate">{item.name}</div>
                <div className="text-[11px] font-mono text-fg-2 mt-0.5">Monday item {item.id}</div>
              </div>
              {renderMeta(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DueDatePill({ dueDate, emphasisWhenSoon }: { dueDate: string; emphasisWhenSoon?: boolean }) {
  if (!dueDate) {
    return <span className="text-xs text-fg-3 italic">No due date</span>;
  }
  const daysUntil = daysFromToday(dueDate);
  const soon = emphasisWhenSoon && daysUntil != null && daysUntil <= 3;
  const overdue = daysUntil != null && daysUntil < 0;

  const { bg, fg, label } = (() => {
    if (overdue)         return { bg: '#FEE2E2', fg: '#B91C1C', label: `Overdue · ${dueDate}` };
    if (soon)            return { bg: '#FEF9C3', fg: '#A16207', label: `Due ${dueDate}` };
    return { bg: '#F3F4F6', fg: '#4B5563', label: `Due ${dueDate}` };
  })();

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: bg, color: fg }}
    >
      {overdue && <AlertTriangle size={12} />}
      {label}
    </span>
  );
}

function daysFromToday(dateStr: string): number | null {
  // dateStr is YYYY-MM-DD from Monday. Compare against today's date in local time.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}
