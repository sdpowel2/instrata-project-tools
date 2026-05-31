import { useCallback, useEffect, useState } from 'react';
import { Bug, ChevronDown, ChevronUp, ExternalLink, Loader2 } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { Eyebrow } from './ui';

type BugStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix' | 'duplicate';

interface BugReport {
  id: string;
  reporter_id: string | null;
  title: string;
  body: string;
  image_url: string | null;
  page_url: string;
  status: BugStatus;
  resolution_note: string | null;
  created_at: string;
  reporter: { full_name: string | null; email: string | null } | null;
}

const STATUS_META: Record<BugStatus, { label: string; bg: string; fg: string }> = {
  open:        { label: 'Open',        bg: '#FEF3C7', fg: '#A16207' },
  in_progress: { label: 'In Progress', bg: '#DBEAFE', fg: '#1D4ED8' },
  resolved:    { label: 'Resolved',    bg: '#DCFCE7', fg: '#16A34A' },
  wont_fix:    { label: "Won't Fix",   bg: '#F3F4F6', fg: '#6B7280' },
  duplicate:   { label: 'Duplicate',   bg: '#EDE9FE', fg: '#7C3AED' },
};

const CLOSED_STATUSES = new Set<BugStatus>(['resolved', 'wont_fix', 'duplicate']);

export function BugReportsCard() {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured()) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('bug_reports')
      .select('*, reporter:profiles(full_name, email)')
      .order('created_at', { ascending: false });
    if (!error && data) setReports(data as BugReport[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCount   = reports.filter((r) => !CLOSED_STATUSES.has(r.status)).length;
  const closedCount = reports.filter((r) =>  CLOSED_STATUSES.has(r.status)).length;
  const visible     = showClosed ? reports : reports.filter((r) => !CLOSED_STATUSES.has(r.status));

  const accent   = '#DC2626';
  const accentBg = 'rgba(220,38,38,0.07)';

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-border" style={{ background: accentBg }}>
        <div
          className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: accent, color: '#fff' }}
        >
          <Bug size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow color={accent}>Bug Reports</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">
            Reported Issues
            <span className="ml-2.5 text-sm font-medium text-fg-2">{openCount} open</span>
          </h2>
          <div className="text-[13px] text-fg-2 mt-0.5">
            Bug reports submitted by team members. Click a row to triage and update status.
          </div>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-fg-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading reports…
        </div>
      ) : reports.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-fg-2">
          No bug reports yet. Submissions from team members will appear here.
        </div>
      ) : (
        <>
          {visible.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-fg-2">
              All caught up — no open issues.
            </div>
          ) : (
            <div>
              {visible.map((report, i) => (
                <BugReportRow
                  key={report.id}
                  report={report}
                  first={i === 0}
                  expanded={expandedId === report.id}
                  onToggle={() => setExpandedId(expandedId === report.id ? null : report.id)}
                  onSaved={(updated) => {
                    setReports((prev) => prev.map((r) => r.id === updated.id ? updated : r));
                    setExpandedId(null);
                  }}
                />
              ))}
            </div>
          )}

          {closedCount > 0 && (
            <button
              onClick={() => setShowClosed((v) => !v)}
              className="w-full text-center text-xs text-fg-2 hover:text-navy py-3 border-t border-border transition-colors"
            >
              {showClosed
                ? `Hide ${closedCount} closed issue${closedCount === 1 ? '' : 's'}`
                : `Show ${closedCount} closed issue${closedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── Individual Row ───────────────────────────────────────────────────────────

interface RowProps {
  report: BugReport;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (updated: BugReport) => void;
}

function BugReportRow({ report, first, expanded, onToggle, onSaved }: RowProps) {
  const [status, setStatus] = useState<BugStatus>(report.status);
  const [note, setNote]     = useState(report.resolution_note ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reporterName = report.reporter?.full_name || report.reporter?.email || 'Unknown';

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);

    const { error } = await supabase
      .from('bug_reports')
      .update({
        status,
        resolution_note: note.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', report.id);

    if (error) {
      setSaveError(error.message);
      setSaving(false);
      return;
    }

    // Notify the reporter on meaningful closure, respecting their preferences.
    // A missing preference row means opted-in (default enabled).
    if (report.reporter_id && (status === 'resolved' || status === 'wont_fix')) {
      const { data: pref } = await supabase
        .from('notification_preferences')
        .select('enabled')
        .eq('user_id', report.reporter_id)
        .eq('type', 'bug_status_changed')
        .maybeSingle();

      const shouldNotify = pref === null ? true : pref.enabled;

      if (shouldNotify) {
        const title =
          status === 'resolved'
            ? `Your bug report was resolved: "${report.title}"`
            : `Update on your bug report: "${report.title}"`;

        await supabase.from('notifications').insert({
          user_id:    report.reporter_id,
          type:       'bug_status_changed',
          title,
          message:    note.trim() || null,
          related_id: report.id,
        });
      }
    }

    onSaved({ ...report, status, resolution_note: note.trim() || null });
    setSaving(false);
  };

  return (
    <div className={first ? '' : 'border-t border-border'}>
      {/* Summary row — click to expand */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-surface/50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-fg truncate">{report.title}</div>
          <div className="text-[11px] text-fg-2 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{reporterName}</span>
            <span>·</span>
            <span>{new Date(report.created_at).toLocaleDateString()}</span>
            {report.page_url && (
              <>
                <span>·</span>
                <span className="font-mono truncate max-w-[200px]">{report.page_url}</span>
              </>
            )}
          </div>
        </div>
        <span
          className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0"
          style={{ background: STATUS_META[report.status].bg, color: STATUS_META[report.status].fg }}
        >
          {STATUS_META[report.status].label}
        </span>
        {expanded
          ? <ChevronUp  size={14} className="text-fg-2 flex-shrink-0" />
          : <ChevronDown size={14} className="text-fg-2 flex-shrink-0" />
        }
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-5 pb-5 bg-surface/30 border-t border-border/60">
          {/* Description */}
          <div className="pt-4 pb-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-2 mb-1.5">
              Description
            </div>
            <p className="text-sm text-fg whitespace-pre-wrap leading-relaxed">{report.body}</p>
          </div>

          {/* Screenshot */}
          {report.image_url && (
            <div className="pb-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-2 mb-1.5">
                Screenshot
              </div>
              <a
                href={report.image_url}
                target="_blank"
                rel="noreferrer"
                className="inline-block group relative"
              >
                <img
                  src={report.image_url}
                  alt="Bug screenshot"
                  className="max-h-52 rounded-lg border border-border object-contain"
                />
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 group-hover:bg-black/15 transition-colors">
                  <ExternalLink size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                </div>
              </a>
            </div>
          )}

          {/* Triage controls */}
          <div className="pt-3 border-t border-border/60 space-y-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-2 block mb-1.5">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as BugStatus)}
                className="text-sm border border-border rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-navy/20"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="resolved">Resolved</option>
                <option value="wont_fix">Won't Fix</option>
                <option value="duplicate">Duplicate</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-2 block mb-1.5">
                Resolution Note{' '}
                <span className="font-normal normal-case tracking-normal text-fg-3 text-[11px]">
                  {status === 'resolved' || status === 'wont_fix'
                    ? '— will be sent to reporter when notifications are enabled'
                    : '(optional)'}
                </span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="input text-sm w-full"
                placeholder={
                  status === 'resolved' ? 'Describe what was fixed…' :
                  status === 'wont_fix' ? "Explain why this won't be addressed…" :
                  'Internal notes…'
                }
              />
            </div>

            {saveError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                {saveError}
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary text-sm disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 size={13} className="animate-spin" />}
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
