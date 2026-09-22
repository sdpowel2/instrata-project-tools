// Compact Project Wiki summary for the Project Overview: room count, blocking
// set, wiki status, and a jump into the wiki. Cheap head-fetch of the room
// index view; the full wiki loads on its own page.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NotebookPen, ChevronRight, Loader2 } from 'lucide-react';
import { Eyebrow } from '../ui';
import { isSupabaseConfigured } from '../../lib/supabase';
import { fetchWiki, fetchRoomIndex, isBlocking, type ProjectWiki, type WikiRoomIndexRow } from '../../lib/projectWiki';
import { WikiStatusChip } from './wikiUi';

export function WikiSummaryCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [wiki, setWiki] = useState<ProjectWiki | null>(null);
  // null = loading. Demo mode (no Supabase) resolves to an empty index immediately.
  const [rooms, setRooms] = useState<WikiRoomIndexRow[] | null>(() => (isSupabaseConfigured() ? null : []));

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    Promise.all([fetchWiki(projectId), fetchRoomIndex(projectId)])
      .then(([w, r]) => { if (!cancelled) { setWiki(w); setRooms(r); } })
      .catch(() => { if (!cancelled) setRooms([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  const blocking = rooms?.filter(isBlocking).length ?? 0;
  const decisions = rooms?.reduce((s, r) => s + r.decisionCount, 0) ?? 0;
  const escalated = rooms?.filter((r) => r.status === 'escalated').length ?? 0;

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div>
          <Eyebrow>Knowledge base</Eyebrow>
          <h2 className="text-base font-semibold text-navy m-0 mt-0.5">Project Wiki</h2>
        </div>
        {wiki && <WikiStatusChip status={wiki.status} />}
      </div>
      <button
        onClick={() => navigate(`/projects/${projectId}/wiki`)}
        className="w-full text-left px-5 py-4 hover:bg-surface/60 transition-colors flex items-center gap-4"
      >
        <div className="w-10 h-10 rounded-lg bg-navy text-white flex items-center justify-center flex-shrink-0">
          <NotebookPen size={18} />
        </div>
        <div className="flex-1 min-w-0">
          {rooms === null ? (
            <div className="text-sm text-fg-2 inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : rooms.length === 0 ? (
            <>
              <div className="text-sm font-semibold text-fg">No rooms yet</div>
              <div className="text-xs text-fg-2 mt-0.5">Start the room index, or let a pipeline run seed it.</div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-fg">
                {rooms.length} room{rooms.length === 1 ? '' : 's'} · {decisions} decision{decisions === 1 ? '' : 's'}
              </div>
              <div className={`text-xs mt-0.5 ${blocking ? 'text-red-700 font-medium' : 'text-fg-2'}`}>
                {blocking
                  ? `${blocking} blocking${escalated ? ` · ${escalated} escalated` : ''} — needs your input`
                  : 'Nothing blocking'}
              </div>
            </>
          )}
        </div>
        <ChevronRight size={16} className="text-fg-3 flex-shrink-0" />
      </button>
    </div>
  );
}
