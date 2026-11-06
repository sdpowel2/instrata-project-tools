// Run: start a fetch (all enabled sources, or a chosen set and date window)
// and watch it live. The worker also runs every morning on its own schedule.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, CalendarClock } from 'lucide-react';
import { Card } from '../ui';
import type { Job, Source, WorkerStatus } from './types';
import { SOURCE_LABEL } from './types';
import { fmtDateTime, relTime, todayEt } from './format';
import { Banner, Chip, Spinner, Th } from './ui';
import { queueJob, useJobs, workerOnline } from '../../hooks/useLeadFinder';

const STATUS_TONE = { succeeded: 'success', partial: 'warn', failed: 'danger', running: 'info', pending: 'neutral' } as const;

export function RunTab({ sources, worker, onFinished, onSeeNew }: {
  sources: Source[];
  worker: WorkerStatus | null;
  onFinished: () => void;
  onSeeNew: () => void;
}) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { jobs } = useJobs(['run'], 10);
  const latest = jobs[0];
  const live = latest && (latest.status === 'queued' || latest.status === 'running') ? latest : undefined;

  const selected = useMemo(() => picked ?? sources.filter((s) => s.enabled).map((s) => s.id), [picked, sources]);
  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  // Refresh the rest of the page when a run finishes.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (live) { watched.current = live.id; return; }
    if (watched.current && latest?.id === watched.current) { watched.current = null; onFinished(); }
  }, [live, latest, onFinished]);

  const start = async () => {
    setErr(null);
    try {
      await queueJob('run', { params: { sources: selected, since: since || null, until: until || null, trigger: 'manual' } });
    } catch (e) { setErr((e as Error).message); }
  };

  const online = workerOnline(worker);
  const hour = worker?.schedule_hour_et ?? 6;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
      <div className="space-y-6 min-w-0">
        <Card title="Start a run">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-navy mb-2">Sources</div>
              <div className="space-y-2.5">
                {sources.map((s) => (
                  <label key={s.id} className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" className="mt-1 accent-navy" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                    <span className="text-[13px]">
                      <span className="font-semibold text-fg">{SOURCE_LABEL[s.id] ?? s.name}</span>
                      {!s.enabled && <span className="ml-1.5"><Chip>off in Settings</Chip></span>}
                      {s.id === 'sam_gov' && worker && !worker.sam_key && <span className="ml-1.5"><Chip tone="danger">SAM_API_KEY missing</Chip></span>}
                      {s.daily_call_budget != null && <span className="text-fg-3"> · {s.daily_call_budget} calls/day</span>}
                      <div className="text-xs text-fg-3">Last success: {s.last_success_at ? fmtDateTime(s.last_success_at) : 'never'}</div>
                      {s.id === 'bonfire' && <div className="text-xs text-status-warn-fg">robots.txt disallows Bonfire; agencies will be logged as errors.</div>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-navy mb-2">Posted-date window</div>
              <p className="text-xs text-fg-3 mt-0 mb-3">Leave blank for the default: since each source's last successful run (the first run backfills).</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className="block text-xs text-fg-2 mb-1">From</span>
                  <input type="date" className="input" max={todayEt()} value={since} onChange={(e) => setSince(e.target.value)} /></label>
                <label className="block"><span className="block text-xs text-fg-2 mb-1">To</span>
                  <input type="date" className="input" max={todayEt()} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
              </div>
            </div>
          </div>
          {err && <div className="mt-4"><Banner tone="error" onClose={() => setErr(null)}>{err}</Banner></div>}
          <div className="flex items-center gap-3 mt-5 pt-4 border-t border-border-soft">
            <button className="btn-orange" disabled={!!live || !selected.length} onClick={() => void start()}>
              {live ? <Spinner size={14} /> : <Play size={14} />} {live ? 'Running…' : 'Run now'}
            </button>
            <span className="text-xs text-fg-3">One run at a time. It keeps going if you leave this page.</span>
          </div>
        </Card>

        {latest && <RunStatus job={latest} onSeeNew={onSeeNew} />}
      </div>

      <div className="space-y-4">
        <Card>
          <div className="flex items-start gap-3">
            <CalendarClock size={18} className="text-orange mt-0.5" />
            <div className="text-[13px] text-fg-2">
              <div className="font-semibold text-navy mb-0.5">Daily run</div>
              {hour >= 0 ? <>The worker runs every enabled source each morning at {hour}:00 Eastern.</> : 'The scheduled run is off.'}
              <div className="mt-2">
                Worker: {online
                  ? <Chip tone="success">online</Chip>
                  : <Chip tone="danger">{worker ? `last seen ${relTime(worker.heartbeat_at)}` : 'never seen'}</Chip>}
              </div>
            </div>
          </div>
        </Card>
        {jobs.length > 1 && (
          <Card title="Recent runs" flush>
            <div className="divide-y divide-border-soft">
              {jobs.slice(0, 8).map((j) => (
                <div key={j.id} className="px-5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Chip tone={j.status === 'done' ? 'success' : j.status === 'failed' ? 'danger' : 'info'}>{j.status}</Chip>
                  <span className="text-fg-2">{(j.params as { trigger?: string }).trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</span>
                  <span className="ml-auto text-xs text-fg-3">{fmtDateTime(j.created_at)}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function RunStatus({ job, onSeeNew }: { job: Job; onSeeNew: () => void }) {
  const running = job.status === 'queued' || job.status === 'running';
  const sources = (running ? job.progress?.sources : job.result?.sources ?? job.progress?.sources) as
    Record<string, { status: string; fetched?: number; new?: number; updated?: number; calls?: number; budget?: number; error?: string }> | undefined;
  return (
    <Card
      title={running ? (job.status === 'queued' ? 'Waiting for the worker…' : 'Running…') : 'Last run'}
      action={!running && <span className="text-xs text-fg-3">{fmtDateTime(job.created_at)}</span>}
      flush
    >
      {job.status === 'failed' && <div className="px-5 pt-4"><Banner tone="error">{job.error}</Banner></div>}
      {sources && Object.keys(sources).length > 0 ? (
        <table className="w-full text-[13px]">
          <thead className="bg-surface text-fg-3 text-left text-[11px]">
            <tr><Th>Source</Th><Th>Status</Th><Th className="text-right">Fetched</Th><Th className="text-right">New</Th><Th className="text-right">Updated</Th><Th className="text-right">API calls</Th><Th>Note</Th></tr>
          </thead>
          <tbody>
            {Object.entries(sources).map(([sid, p]) => (
              <tr key={sid} className="border-t border-border-soft">
                <td className="px-4 py-2.5 font-semibold text-fg">{SOURCE_LABEL[sid] ?? sid}</td>
                <td className="px-4 py-2.5"><Chip tone={STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{p.status}</Chip></td>
                <td className="px-4 py-2.5 text-right font-mono">{p.fetched ?? 0}</td>
                <td className="px-4 py-2.5 text-right font-mono">{p.new ?? 0}</td>
                <td className="px-4 py-2.5 text-right font-mono">{p.updated ?? 0}</td>
                <td className="px-4 py-2.5 text-right font-mono">{p.calls ?? 0}{p.budget ? ` / ${p.budget}` : ''}</td>
                <td className="px-4 py-2.5 text-xs text-fg-3 max-w-[260px]">{p.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : running ? (
        <div className="px-5 py-6 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14} /> Starting…</div>
      ) : null}
      {!running && job.status === 'done' && (
        <div className="px-5 py-3 border-t border-border-soft">
          <button className="text-[13px] font-semibold text-navy hover:text-orange-dark" onClick={onSeeNew}>See new and updated leads →</button>
          {job.result?.documents?.downloaded ? <span className="text-xs text-fg-3 ml-3">{job.result.documents.downloaded} new attachment(s) for Pursue leads</span> : null}
        </div>
      )}
    </Card>
  );
}
