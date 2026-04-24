// "My Uploads" — shows the current user's cutsheet upload history with
// status (pending / approved / rejected / duplicate) and any reject reasons
// admin left during review. Closes the loop for engineers who upload
// cutsheets and want to know whether they made it into the catalog.
//
// Relies on RLS — cutsheet_staging.SELECT allows the original uploader to
// see their own rows in addition to admins.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Clock, Check, X as XIcon, Copy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Eyebrow, PageHeader } from '../components/ui';

interface MyUploadRow {
  id: string;
  manufacturer: string | null;
  model_number: string | null;
  original_filename: string | null;
  sharepoint_path: string;
  source_project_id: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'duplicate';
  reviewed_at: string | null;
  review_notes: string | null;
  duplicate_of: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<MyUploadRow['status'], { bg: string; fg: string; label: string; Icon: typeof Clock }> = {
  pending:   { bg: 'rgba(246,141,46,0.12)', fg: '#E07A1A', label: 'Awaiting review', Icon: Clock },
  approved:  { bg: '#DCFCE7',               fg: '#15803D', label: 'Approved',        Icon: Check },
  rejected:  { bg: '#FEE2E2',               fg: '#B91C1C', label: 'Rejected',        Icon: XIcon },
  duplicate: { bg: '#F3F4F6',               fg: '#4B5563', label: 'Duplicate',       Icon: Copy },
};

export function CutsheetMyUploadsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<MyUploadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      // RLS scopes this query to the current user's own rows automatically.
      const { data, error: qErr } = await supabase
        .from('cutsheet_staging')
        .select('id, manufacturer, model_number, original_filename, sharepoint_path, source_project_id, status, reviewed_at, review_notes, duplicate_of, created_at')
        .eq('uploaded_by_user_id', user.id)
        .order('created_at', { ascending: false });
      if (qErr) throw qErr;
      setItems((data ?? []) as MyUploadRow[]);
    } catch (err) {
      console.error('[MyUploads] load failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const rejectedCount = items.filter((i) => i.status === 'rejected').length;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1100px]">
      <PageHeader
        eyebrow="SharePoint · Cutsheet Repository"
        title="My Cutsheet Uploads"
        subtitle={
          <>
            Cutsheets you've uploaded from submittal builds.
            {' '}
            {pendingCount > 0 && <strong className="text-orange-dark">{pendingCount} awaiting review.</strong>}
            {rejectedCount > 0 && (
              <strong className="text-red-700 ml-1">
                {rejectedCount} rejected{rejectedCount === 1 ? '' : ''} — see notes below.
              </strong>
            )}
          </>
        }
        actions={
          <button onClick={refresh} disabled={loading} className="btn-secondary disabled:opacity-60">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong className="font-semibold">Couldn't load uploads:</strong> {error}
        </div>
      )}

      <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-fg-2 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-fg-2">
            <Eyebrow className="mb-2">Nothing here yet</Eyebrow>
            You haven't uploaded any cutsheets to the repository yet. Uploads from the submittal page show up here with their review status.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((row) => {
              const s = STATUS_STYLES[row.status];
              const Icon = s.Icon;
              return (
                <div key={row.id} className="px-5 py-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-fg truncate">
                      {row.manufacturer || <span className="italic text-fg-2">(no manufacturer)</span>}
                      {' '}
                      <span className="font-mono text-fg-2">{row.model_number || '—'}</span>
                    </div>
                    <div className="text-xs text-fg-2 mt-0.5 truncate" title={row.original_filename ?? row.sharepoint_path}>
                      {row.original_filename ?? row.sharepoint_path.split('/').pop()}
                    </div>
                    <div className="text-[11px] text-fg-3 mt-1">
                      Uploaded {new Date(row.created_at).toLocaleString()}
                      {row.reviewed_at && (
                        <>
                          {' · '}
                          Reviewed {new Date(row.reviewed_at).toLocaleString()}
                        </>
                      )}
                    </div>
                    {row.review_notes && (
                      <div
                        className="mt-2 text-[12px] rounded-md px-3 py-2"
                        style={{
                          background: row.status === 'rejected' ? '#FEE2E2' : '#F3F4F6',
                          color: row.status === 'rejected' ? '#B91C1C' : '#4B5563',
                        }}
                      >
                        <strong className="font-semibold">Reviewer note:</strong> {row.review_notes}
                      </div>
                    )}
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0"
                    style={{ background: s.bg, color: s.fg }}
                  >
                    <Icon size={12} />
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
