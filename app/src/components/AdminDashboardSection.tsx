// Admin-only Dashboard tail — folded in from the standalone Manager Dashboard
// page. Surfaces what leadership needs to triage, review, and load-balance:
//
//   - Cutsheet Review: pending uploads waiting for admin approval
//   - Triage: Monday items with a due date but no engineer assigned
//   - Needs Review: pre-sales runs engineers flagged via "Send to Manager"
//   - Team Bandwidth: active projects grouped by owner, by phase
//
// Triage still comes from the monday-manager-dashboard edge function —
// until project_members is synced from Monday's engineer columns, our DB
// can't answer "who's assigned." The Needs Review card runs off the
// internal review_runs table (states: submitted_for_review, in_review,
// changes_requested).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ClipboardList, RefreshCw, Loader2, Users, FolderCheck,
  ChevronRight, UserCircle, Gauge, Clock, Send,
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useStore } from '../store';
import { Eyebrow } from './ui';
import { BugReportsCard } from './BugReportsCard';
import type { Project, ProjectPhase, ProjectStatus, ReviewRun } from '../types';

interface ManagerItem {
  id: string;
  name: string;
  dueDate: string;
}

// The monday-manager-dashboard edge function still returns a `review` array,
// but we no longer surface it — internal review_runs is the source of truth
// for the Needs Review card.
interface FeedResponse {
  triage: ManagerItem[];
  review: ManagerItem[];
  fetchedAt: string;
  warning?: string;
}

// Statuses that consume engineer bandwidth — i.e. the project is currently
// taking real attention. Won-but-not-yet-handed-off projects on the pre-sales
// side aren't counted; the post-sales row picks them up. Completed/Lost/etc.
// drop off the bandwidth view entirely.
const PRE_SALES_ACTIVE: Set<ProjectStatus> = new Set([
  'Not Started', 'In Progress', 'Review', 'Follow Up',
]);
const POST_SALES_ACTIVE: Set<ProjectStatus> = new Set([
  'Won', 'Not Started', 'In Progress', 'Install', 'Close Out',
]);

export function AdminDashboardSection() {
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const pendingCutsheets = usePendingCutsheetCount();

  const refreshFeed = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setFeedLoading(true);
    setFeedError(null);
    try {
      const { data, error } = await supabase.functions.invoke<FeedResponse>(
        'monday-manager-dashboard',
        { body: {} },
      );
      if (error) throw error;
      if (!data) throw new Error('Empty response');
      setFeed(data);
    } catch (err) {
      console.error('[AdminDashboard] feed refresh failed:', err);
      setFeedError(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      setFeedLoading(false);
    }
  }, []);

  useEffect(() => { refreshFeed(); }, [refreshFeed]);

  const lastFetched = feed?.fetchedAt ? new Date(feed.fetchedAt).toLocaleTimeString() : null;

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between mb-4 pb-3 border-b border-border">
        <div>
          <Eyebrow color="var(--color-orange)">Leadership</Eyebrow>
          <h2 className="text-xl font-bold text-navy m-0 mt-1">
            Management
          </h2>
          <div className="text-[13px] text-fg-2 mt-1">
            Triage, review queue, cutsheets, and team bandwidth.
            {lastFetched && <> · Monday feed last refreshed {lastFetched}</>}
          </div>
        </div>
        <button
          onClick={refreshFeed}
          disabled={feedLoading}
          className="btn-secondary disabled:opacity-60"
          title="Refresh Monday feed"
        >
          {feedLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </div>

      {feedError && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong className="font-semibold">Couldn't load Monday feed:</strong> {feedError}
        </div>
      )}
      {feed?.warning && (
        <div className="mb-5 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          {feed.warning}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">
        <CutsheetReviewCard pendingCount={pendingCutsheets} />

        <BugReportsCard />

        <CategoryCard
          eyebrow="Needs Triage"
          title="Unassigned with due date"
          description="Has a due date set in Monday but no pre-sales engineer assigned yet."
          accent="#B91C1C"
          accentBg="rgba(185,28,28,0.08)"
          icon={Users}
          items={feed?.triage ?? []}
          loading={feedLoading && !feed}
          emptyMessage="All requests with due dates have an engineer assigned."
          renderMeta={(item) => <DueDatePill dueDate={item.dueDate} />}
        />

        <NeedsReviewCard />

        <TeamBandwidthCard />
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Needs Review — pulled directly from review_runs. Engineers escalate
// pre-review runs via "Send to Manager" on the AutoReview page, which flips
// the run to submitted_for_review. In Review = a manager already opened it.
// Changes Requested = bounced back to the engineer; listed here so it's
// visible until the engineer resubmits.
// ──────────────────────────────────────────────────────────────────────────

const NEEDS_REVIEW_STATUSES = new Set(['submitted_for_review', 'in_review', 'changes_requested']);

function NeedsReviewCard() {
  const navigate = useNavigate();
  const reviewRuns = useStore((s) => s.reviewRuns);
  const projects = useStore((s) => s.projects);

  // Most-recent run per project, filtered to manager-queue statuses.
  const items = useMemo(() => {
    const latestByProject = new Map<string, ReviewRun>();
    for (const run of [...reviewRuns].sort((a, b) => b.runNumber - a.runNumber)) {
      if (!latestByProject.has(run.projectId)) latestByProject.set(run.projectId, run);
    }
    const queueOrder: Record<string, number> = {
      submitted_for_review: 0,
      in_review: 1,
      changes_requested: 2,
    };
    return Array.from(latestByProject.values())
      .filter((r) => NEEDS_REVIEW_STATUSES.has(r.status))
      .sort((a, b) => {
        const diff = (queueOrder[a.status] ?? 9) - (queueOrder[b.status] ?? 9);
        if (diff !== 0) return diff;
        return new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime();
      });
  }, [reviewRuns]);

  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const accent = '#1D4ED8';
  const accentBg = 'rgba(29,78,216,0.08)';

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-border" style={{ background: accentBg }}>
        <div
          className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: accent, color: '#fff' }}
        >
          <ClipboardList size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow color={accent}>Needs Review</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">
            Manager review queue
            <span className="ml-2.5 text-sm font-medium text-fg-2">{items.length}</span>
          </h2>
          <div className="text-[13px] text-fg-2 mt-0.5">
            Auto-review runs engineers escalated via <strong>Send to Manager</strong>, plus runs currently in review or bounced back.
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-fg-2">
          Manager review queue is clear.
        </div>
      ) : (
        <div>
          {items.map((run, i) => {
            const project = projectsById.get(run.projectId);
            const tone = STATUS_TONE[run.status];
            return (
              <button
                key={run.id}
                onClick={() => navigate(`/projects/${run.projectId}/review`)}
                className={`w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-surface/60 transition-colors ${i === 0 ? '' : 'border-t border-border'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-fg truncate">
                    {project?.name ?? `Project ${run.projectId.slice(0, 8)}`}
                  </div>
                  <div className="text-[11px] font-mono text-fg-2 mt-0.5">
                    {project?.number ?? '—'}
                    {run.runNumber > 1 && <> · Resubmission #{run.runNumber}</>}
                  </div>
                </div>
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap"
                  style={{ background: tone.bg, color: tone.fg }}
                >
                  <tone.icon size={12} /> {tone.label}
                </span>
                <ChevronRight size={14} className="text-fg-2 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, { bg: string; fg: string; label: string; icon: React.ComponentType<{ size?: number }> }> = {
  submitted_for_review: { bg: '#FEF3C7', fg: '#A16207', label: 'Submitted',         icon: Send },
  in_review:            { bg: '#DBEAFE', fg: '#1D4ED8', label: 'In Review',         icon: Clock },
  changes_requested:    { bg: '#FEE2E2', fg: '#B91C1C', label: 'Changes Requested', icon: RefreshCw },
};

// ──────────────────────────────────────────────────────────────────────────
// Team Bandwidth — count active projects per engineer, by phase. Profiles
// are loaded on mount so we can map owner_id → name; failure is silent and
// falls back to the raw user id (still useful as a debugging signal).
// ──────────────────────────────────────────────────────────────────────────

interface ProfileSummary {
  id: string;
  fullName: string;
  email: string;
}

function TeamBandwidthCard() {
  const projects = useStore((s) => s.projects);
  const [phaseView, setPhaseView] = useState<ProjectPhase>('Pre-Sales');
  const [profilesById, setProfilesById] = useState<Map<string, ProfileSummary>>(new Map());

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email');
      if (cancelled) return;
      if (error) {
        console.warn('[TeamBandwidth] profile fetch failed:', error.message);
        return;
      }
      const map = new Map<string, ProfileSummary>();
      for (const row of data ?? []) {
        map.set(row.id, {
          id: row.id,
          fullName: row.full_name ?? row.email ?? row.id,
          email: row.email ?? '',
        });
      }
      setProfilesById(map);
    })();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => bandwidthRows(projects, phaseView, profilesById), [projects, phaseView, profilesById]);
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const unassignedCount = useMemo(
    () => activeForPhase(projects, phaseView).filter((p) => !p.ownerId).length,
    [projects, phaseView],
  );

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="flex items-center gap-3.5 px-5 py-4 border-b border-border"
        style={{ background: 'rgba(34,50,110,0.05)' }}
      >
        <div
          className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--color-navy)', color: '#fff' }}
        >
          <Gauge size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow color="var(--color-navy)">Resource Management</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">
            Team Bandwidth
            <span className="ml-2.5 text-sm font-medium text-fg-2">{rows.length} {rows.length === 1 ? 'engineer' : 'engineers'}</span>
          </h2>
          <div className="text-[13px] text-fg-2 mt-0.5">
            Active projects per engineer on the {phaseView.toLowerCase()} side.
          </div>
        </div>
        <div className="flex items-center gap-1 p-0.5 bg-white border border-border rounded-md">
          {(['Pre-Sales', 'Post-Sales'] as const).map((p) => {
            const active = phaseView === p;
            return (
              <button
                key={p}
                onClick={() => setPhaseView(p)}
                className={[
                  'px-2.5 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap',
                  active ? 'bg-navy text-white' : 'text-fg-2 hover:text-navy',
                ].join(' ')}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-fg-2">
          No active {phaseView.toLowerCase()} projects with an owner assigned yet.
          {unassignedCount > 0 && (
            <div className="mt-1.5 text-[12px] text-fg-3">
              {unassignedCount} {unassignedCount === 1 ? 'project is' : 'projects are'} active but unassigned.
            </div>
          )}
        </div>
      ) : (
        <div>
          {rows.map((row, i) => (
            <div
              key={row.userId}
              className={`flex items-center gap-3 px-5 py-3 ${i === 0 ? '' : 'border-t border-border'}`}
            >
              <div className="w-8 h-8 rounded-full bg-navy/[0.08] text-navy flex items-center justify-center flex-shrink-0">
                <UserCircle size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-fg truncate">{row.name}</div>
                <div className="h-[6px] mt-1.5 rounded-full overflow-hidden bg-black/[0.05]">
                  <div
                    className="h-full transition-[width]"
                    style={{
                      width: `${maxCount ? Math.round((row.count / maxCount) * 100) : 0}%`,
                      background: phaseView === 'Pre-Sales' ? '#0072CE' : '#F68D2E',
                    }}
                  />
                </div>
              </div>
              <div className="text-right whitespace-nowrap pl-2">
                <div className="text-base font-bold text-fg font-mono leading-none">{row.count}</div>
                <div className="text-[10px] text-fg-2 uppercase tracking-[0.08em] mt-1">active</div>
              </div>
            </div>
          ))}
          {unassignedCount > 0 && (
            <div className="px-5 py-3 border-t border-border bg-surface/40 text-[12px] text-fg-2 flex items-center justify-between">
              <span>
                <strong className="text-navy">{unassignedCount}</strong>{' '}
                active {phaseView.toLowerCase()} project{unassignedCount === 1 ? '' : 's'} unassigned
              </span>
              <span className="text-fg-3">surface in Triage above</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface BandwidthRow {
  userId: string;
  name: string;
  count: number;
}

function activeForPhase(projects: Project[], phase: ProjectPhase): Project[] {
  const activeSet = phase === 'Pre-Sales' ? PRE_SALES_ACTIVE : POST_SALES_ACTIVE;
  return projects.filter((p) => p.phase === phase && activeSet.has(p.status));
}

function bandwidthRows(
  projects: Project[],
  phase: ProjectPhase,
  profilesById: Map<string, ProfileSummary>,
): BandwidthRow[] {
  const counts = new Map<string, number>();
  for (const p of activeForPhase(projects, phase)) {
    if (!p.ownerId) continue;
    counts.set(p.ownerId, (counts.get(p.ownerId) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([userId, count]) => ({
      userId,
      count,
      name: profilesById.get(userId)?.fullName ?? userId,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ──────────────────────────────────────────────────────────────────────────
// Cards lifted from the old ManagerDashboard page
// ──────────────────────────────────────────────────────────────────────────

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

function CutsheetReviewCard({ pendingCount }: { pendingCount: number }) {
  const hasPending = pendingCount > 0;
  return (
    <Link
      to="/cutsheet-review"
      className="bg-white border border-border rounded-xl shadow-sm overflow-hidden hover:border-navy/40 transition-colors block"
    >
      <div
        className="flex items-center gap-3.5 px-5 py-4"
        style={{ background: hasPending ? 'rgba(246,141,46,0.08)' : 'rgba(15,23,42,0.03)' }}
      >
        <div
          className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: hasPending ? 'var(--color-orange)' : '#475569', color: '#fff' }}
        >
          <FolderCheck size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow color={hasPending ? 'var(--color-orange)' : '#475569'}>Cutsheet Review</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">
            {hasPending ? 'Cutsheets awaiting approval' : 'Cutsheet queue is clear'}
            {hasPending && <span className="ml-2.5 text-sm font-medium text-fg-2">{pendingCount}</span>}
          </h2>
          <div className="text-[13px] text-fg-2 mt-0.5">
            {hasPending
              ? 'Review pending cutsheet uploads from engineers and promote approved files to the repository.'
              : 'No pending cutsheet uploads. New submissions from engineers will surface here.'}
          </div>
        </div>
        <ChevronRight size={18} className="text-fg-2 flex-shrink-0" />
      </div>
    </Link>
  );
}

// 60s poll matches what the old sidebar used. Best-effort: errors are
// swallowed so the badge silently misses an update rather than disrupting
// the dashboard.
function usePendingCutsheetCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { count: c, error } = await supabase
          .from('cutsheet_staging')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');
        if (cancelled) return;
        if (!error) setCount(c ?? 0);
      } catch { /* swallow */ }
    };
    tick();
    const interval = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  return count;
}

function daysFromToday(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}
