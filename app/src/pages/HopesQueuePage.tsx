// Hope's Queue — the Project Tools side of the Salesforce ↔ monday sync engine's
// task queue (plan §6.1/§6.2; Seth 2026-10-20). Hope works the queue on the
// "Hope's Queue" monday board; this page adds what monday can't show: KPI tiles,
// the cleanliness item lists, and the Mappings screen she uses to fix "Fix Mapping"
// tasks. Status changes here sync to monday within a minute (and vice versa).
// Visible to admins and ops coordinators (profiles.is_ops_coordinator).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, RefreshCw, Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card, PageHeader } from '../components/ui';
import {
  LABEL_MAPS, QUEUE_GROUPS, TASK_STATUSES,
  cleanlinessTrend, engineInfo, groupFor, listEstimators, listLabelMap, listTasks, mondayItemUrl, salesforceUrl,
  saveEstimator, saveLabelMap, setTaskStatus, taskTypeLabel, unmappedEngineers, unmappedValues,
  type EngineInfo, type EstimatorRow, type LabelMapRow, type LabelMapTable, type QueueTask, type SyncSchema, type TaskStatus,
} from '../lib/syncQueue';

const SCHEMA_KEY = 'hopesQueue.schema';
type Tab = 'queue' | 'cleanliness' | 'mappings';

function readSchemaPref(): SyncSchema {
  try { return localStorage.getItem(SCHEMA_KEY) === 'sync_sandbox' ? 'sync_sandbox' : 'public'; } catch { return 'public'; }
}

const TYPE_TONE: Record<string, string> = {
  'Fix Mapping': 'bg-status-warn-bg text-status-warn-fg',
  'Review': 'bg-status-info-bg text-status-info-fg',
  'Sync Problem': 'bg-status-danger-bg text-status-danger-fg',
  'Won – Handoff': 'bg-status-success-bg text-status-success-fg',
  'Won – Open Job': 'bg-status-success-bg text-status-success-fg',
};

const fmtDue = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'
  : '—';

export function HopesQueuePage() {
  const { isAdmin, isSyncViewer } = useAuth();
  const [schema, setSchema] = useState<SyncSchema>(isAdmin ? readSchemaPref() : 'public');
  const [tab, setTab] = useState<Tab>('queue');
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [trend, setTrend] = useState<{ date: string; total: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, i, tr] = await Promise.all([listTasks(schema), engineInfo(schema), cleanlinessTrend(schema)]);
      setTasks(t);
      setInfo(i);
      setTrend(tr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [schema]);

  useEffect(() => { void load(); }, [load]);
  // The engine works on a one-minute cycle; refresh on the same rhythm.
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!isSyncViewer) return <Navigate to="/" replace />;

  const switchSchema = (s: SyncSchema) => {
    setSchema(s);
    try { localStorage.setItem(SCHEMA_KEY, s); } catch { /* per-browser convenience only */ }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <PageHeader
        eyebrow="Operations"
        title="Hope's Queue"
        subtitle="Sync tasks, data cleanliness, and the mappings behind them. Status changes sync to the monday board within a minute."
        actions={
          <>
            {isAdmin && (
              <div className="flex items-center rounded-lg border border-border bg-white text-[13px] overflow-hidden">
                {(['public', 'sync_sandbox'] as const).map((s) => (
                  <button key={s} onClick={() => switchSchema(s)}
                    className={`px-3 py-2 ${schema === s ? 'bg-navy text-white' : 'text-fg-2 hover:bg-surface'}`}>
                    {s === 'public' ? 'Production' : 'Sandbox data'}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => void load()} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-white text-[13px] text-navy hover:bg-surface">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
            </button>
          </>
        }
      />

      {schema === 'sync_sandbox' && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-status-warn-bg text-status-warn-fg text-[13px]">
          Showing <b>sandbox</b> data from the staging engine (monday sandbox boards, Salesforce partial sandbox).
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-status-danger-bg text-status-danger-fg text-[13px]">
          {error}{schema === 'sync_sandbox' ? ' — is sync_sandbox in Supabase\'s exposed schemas?' : ''}
        </div>
      )}

      <EngineStrip info={info} />
      <Tiles tasks={tasks} trend={trend} />

      <div className="flex gap-1 mb-4 border-b border-border">
        {([['queue', 'Queue'], ['cleanliness', 'Data Cleanliness'], ['mappings', 'Mappings']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-[14px] font-medium border-b-2 -mb-px ${tab === k ? 'border-orange text-navy' : 'border-transparent text-fg-2 hover:text-navy'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'queue' && info && <QueueTab schema={schema} tasks={tasks} info={info} onChanged={load} />}
      {tab === 'cleanliness' && info && <CleanlinessTab info={info} />}
      {tab === 'mappings' && info && <MappingsTab schema={schema} tasks={tasks} info={info} onChanged={load} />}
    </div>
  );
}

// ── Engine status + KPI tiles ────────────────────────────────────────────────
function EngineStrip({ info }: { info: EngineInfo | null }) {
  if (!info) return null;
  const live = info.mode === 'live';
  return (
    <div className="flex items-center gap-3 mb-4 text-[13px] text-fg-2">
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${live ? 'bg-status-success-bg text-status-success-fg' : 'bg-status-warn-bg text-status-warn-fg'}`}>
        {info.mode ? (live ? 'LIVE' : 'DRY RUN') : 'ENGINE NOT RUNNING'}
      </span>
      {info.lastSweepAt && <span>Last Salesforce sweep {new Date(info.lastSweepAt).toLocaleString()}</span>}
    </div>
  );
}

function Tiles({ tasks, trend }: { tasks: QueueTask[]; trend: { date: string; total: number }[] }) {
  const open = tasks.filter((t) => t.status !== 'done');
  const count = (pred: (t: QueueTask) => boolean) => open.filter(pred).length;
  const cleanliness = open.find((t) => t.taskType === 'data_cleanliness')?.countValue ?? null;
  const tiles: { label: string; value: number | string; tone?: string }[] = [
    { label: 'Overdue / today', value: count((t) => groupFor(t) === 'today_overdue'), tone: 'text-status-danger-fg' },
    { label: 'Due this week', value: count((t) => groupFor(t) === 'this_week') },
    { label: 'Fix Mapping', value: count((t) => taskTypeLabel(t) === 'Fix Mapping') },
    { label: 'Sync Problems', value: count((t) => taskTypeLabel(t) === 'Sync Problem') },
    { label: 'Job Opening', value: count((t) => t.taskType === 'open_job') },
    { label: 'Blank fields', value: cleanliness ?? '—' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
      {tiles.map((t) => (
        <div key={t.label} className="bg-white border border-border rounded-xl px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{t.label}</div>
          <div className={`text-[26px] font-bold leading-tight ${t.tone ?? 'text-navy'}`}>{t.value}</div>
          {t.label === 'Blank fields' && trend.length > 1 && <Sparkline points={trend.map((p) => p.total)} />}
        </div>
      ))}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points, 1);
  const min = Math.min(...points);
  const w = 120, h = 24;
  const xy = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - ((v - min) / Math.max(max - min, 1)) * h}`).join(' ');
  return <svg width={w} height={h} className="mt-1"><polyline points={xy} fill="none" stroke="var(--color-orange)" strokeWidth={1.5} /></svg>;
}

// ── Queue ────────────────────────────────────────────────────────────────────
function QueueTab({ schema, tasks, info, onChanged }: { schema: SyncSchema; tasks: QueueTask[]; info: EngineInfo; onChanged: () => Promise<void> }) {
  const byGroup = useMemo(() => {
    const m = new Map<string, QueueTask[]>();
    for (const t of tasks) m.set(groupFor(t), [...(m.get(groupFor(t)) ?? []), t]);
    return m;
  }, [tasks]);
  return (
    <div className="flex flex-col gap-4">
      {QUEUE_GROUPS.map((g) => {
        const list = byGroup.get(g.key) ?? [];
        if (list.length === 0 && g.key === 'background') return null;
        return (
          <Card key={g.key} title={`${g.label} (${list.length})`} flush>
            {list.length === 0
              ? <div className="px-5 py-4 text-[13px] text-fg-3">Nothing here.</div>
              : list.map((t) => <TaskRow key={t.id} schema={schema} task={t} info={info} onChanged={onChanged} />)}
          </Card>
        );
      })}
    </div>
  );
}

function TaskRow({ schema, task, info, onChanged }: { schema: SyncSchema; task: QueueTask; info: EngineInfo; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const type = taskTypeLabel(task);
  const itemUrl = task.sourceRef.monday_item_id ? mondayItemUrl(info, task.sourceRef.board_key, String(task.sourceRef.monday_item_id)) : null;
  const sfUrl = task.sourceRef.sf_opportunity_id ? salesforceUrl(schema, String(task.sourceRef.sf_opportunity_id)) : null;
  const change = async (s: TaskStatus) => {
    setSaving(true);
    try { await setTaskStatus(schema, task.id, s); await onChanged(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  return (
    <div className="border-b border-border-soft last:border-b-0">
      <div className="flex items-center gap-3 px-5 py-2.5">
        <button onClick={() => setOpen(!open)} className="text-fg-3 hover:text-navy">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-fg truncate">{task.title}</div>
        </div>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${TYPE_TONE[type] ?? 'bg-status-neutral-bg text-status-neutral-fg'}`}>{type}</span>
        <span className="text-[12px] text-fg-2 w-[130px] text-right whitespace-nowrap">{task.taskType === 'data_cleanliness' ? `Count ${task.countValue ?? '—'}` : fmtDue(task.dueAt)}</span>
        {task.reopenCount > 0 && <span className="text-[11px] text-fg-3 whitespace-nowrap" title="Times this came back">↻ {task.reopenCount}</span>}
        <div className="flex gap-1.5 w-[44px] justify-end">
          {itemUrl && <a href={itemUrl} target="_blank" rel="noreferrer" title="Open in monday" className="text-fg-3 hover:text-navy"><ExternalLink size={14} /></a>}
          {sfUrl && <a href={sfUrl} target="_blank" rel="noreferrer" title="Open in Salesforce" className="text-blue hover:text-navy"><ExternalLink size={14} /></a>}
        </div>
        <select value={task.status} disabled={saving} onChange={(e) => void change(e.target.value as TaskStatus)}
          className="text-[12px] border border-border rounded-md px-2 py-1 bg-white">
          {TASK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
      {open && <pre className="px-12 pb-3 text-[12.5px] text-fg-2 whitespace-pre-wrap font-sans m-0">{task.details || 'No details.'}</pre>}
    </div>
  );
}

// ── Data cleanliness ─────────────────────────────────────────────────────────
function CleanlinessTab({ info }: { info: EngineInfo }) {
  const c = info.cleanliness;
  if (!c) return <Card><div className="text-[13px] text-fg-3">No count yet — the engine refreshes it hourly.</div></Card>;
  const boards = [['presales', 'Pre-Sales'], ['postsales', 'Post-Sales'], ['programming', 'Programming']] as const;
  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-fg-3">As of {new Date(c.at).toLocaleString()}. Active work only: Pre-Sales Follow Up + this year's Won; Post-Sales In Progress, Install, Close Out; Programming On Radar, Active, Close Out.</div>
      {boards.map(([key, title]) => {
        const fields = Object.entries(c.fields).filter(([, f]) => f.board === key && f.count > 0).sort((a, b) => b[1].count - a[1].count);
        const total = fields.reduce((a, [, f]) => a + f.count, 0);
        return (
          <Card key={key} title={`${title} — ${total} blank`} flush>
            {fields.length === 0
              ? <div className="px-5 py-4 text-[13px] text-fg-3">All clear.</div>
              : fields.map(([k, f]) => <FieldRow key={k} title={f.title} items={f.items} count={f.count} url={(id) => mondayItemUrl(info, key, id)} />)}
          </Card>
        );
      })}
    </div>
  );
}

function FieldRow({ title, items, count, url }: { title: string; items: { id: string; name: string }[]; count: number; url: (id: string) => string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-soft last:border-b-0">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-surface">
        {open ? <ChevronDown size={16} className="text-fg-3" /> : <ChevronRight size={16} className="text-fg-3" />}
        <span className="flex-1 text-[14px] text-fg">{title}</span>
        <span className="text-[14px] font-semibold text-navy">{count}</span>
      </button>
      {open && (
        <ul className="px-12 pb-3 m-0 list-none columns-1 md:columns-2 gap-6">
          {items.map((it) => {
            const href = url(it.id);
            return <li key={it.id} className="text-[13px] py-0.5">{href ? <a href={href} target="_blank" rel="noreferrer" className="text-blue hover:underline">{it.name}</a> : it.name}</li>;
          })}
          {count > items.length && <li className="text-[12px] text-fg-3 py-0.5">…and {count - items.length} more</li>}
        </ul>
      )}
    </div>
  );
}

// ── Mappings ─────────────────────────────────────────────────────────────────
function MappingsTab({ schema, tasks, info, onChanged }: { schema: SyncSchema; tasks: QueueTask[]; info: EngineInfo; onChanged: () => Promise<void> }) {
  const [sub, setSub] = useState<LabelMapTable | 'estimators'>('map_sales_rep');
  return (
    <div>
      <div className="flex gap-2 mb-4">
        {[...LABEL_MAPS.map((m) => [m.table, m.title] as const), ['estimators', 'Estimators'] as const].map(([k, label]) => (
          <button key={k} onClick={() => setSub(k)}
            className={`px-3 py-1.5 rounded-full text-[13px] border ${sub === k ? 'bg-navy text-white border-navy' : 'bg-white text-fg-2 border-border hover:text-navy'}`}>{label}</button>
        ))}
      </div>
      {sub === 'estimators'
        ? <EstimatorMap schema={schema} tasks={tasks} info={info} onChanged={onChanged} />
        : <LabelMap key={sub} schema={schema} table={sub} tasks={tasks} info={info} onChanged={onChanged} />}
    </div>
  );
}

function LabelMap({ schema, table, tasks, info, onChanged }: { schema: SyncSchema; table: LabelMapTable; tasks: QueueTask[]; info: EngineInfo; onChanged: () => Promise<void> }) {
  const meta = LABEL_MAPS.find((m) => m.table === table)!;
  const labels = info.labels[meta.labelsKey] ?? [];
  const [rows, setRows] = useState<LabelMapRow[]>([]);
  const [draft, setDraft] = useState<{ sfValue: string; mondayLabelId: number | null }>({ sfValue: '', mondayLabelId: null });
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setRows(await listLabelMap(schema, table)), [schema, table]);
  useEffect(() => { void reload(); }, [reload]);
  const waiting = unmappedValues(tasks).filter((u) => u.field === meta.sfField);

  const save = async (row: { id?: string; sfValue: string; mondayLabelId: number | null; active: boolean }) => {
    setBusy(true);
    try { await saveLabelMap(schema, table, row); await reload(); await onChanged(); setDraft({ sfValue: '', mondayLabelId: null }); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const labelSelect = (value: number | null, onChange: (v: number | null) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className="text-[13px] border border-border rounded-md px-2 py-1 bg-white min-w-[200px]">
      <option value="">— not mapped —</option>
      {labels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
    </select>
  );

  return (
    <div className="flex flex-col gap-4">
      {waiting.length > 0 && (
        <Card title="Waiting to be mapped" eyebrow="From open Fix Mapping tasks">
          {waiting.map((w) => (
            <div key={w.taskId} className="flex items-center gap-3 py-1.5 text-[13px]">
              <span className="flex-1">Salesforce <b>{w.value}</b>{w.members ? ` — ${w.members} opportunit${w.members === 1 ? 'y' : 'ies'}` : ''}</span>
              <button onClick={() => setDraft({ sfValue: w.value, mondayLabelId: null })} className="text-blue hover:underline">Map it ↓</button>
            </div>
          ))}
          <p className="text-[12px] text-fg-3 mt-2 mb-0">If the monday label doesn't exist yet, add it to the monday column first; the list below picks it up within the hour.</p>
        </Card>
      )}
      <Card title={`${meta.title}: Salesforce value → monday label`} flush>
        <div className="px-5 py-3 flex items-center gap-3 border-b border-border bg-surface">
          <input value={draft.sfValue} onChange={(e) => setDraft({ ...draft, sfValue: e.target.value })} placeholder="Salesforce value (exact)" className="text-[13px] border border-border rounded-md px-2 py-1 flex-1" />
          {labelSelect(draft.mondayLabelId, (v) => setDraft({ ...draft, mondayLabelId: v }))}
          <button disabled={busy || !draft.sfValue.trim()} onClick={() => void save({ ...draft, active: true })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-orange text-white text-[13px] disabled:opacity-50"><Plus size={14} /> Add</button>
        </div>
        {rows.map((r) => <LabelMapRowView key={r.id} row={r} labelSelect={labelSelect} onSave={save} busy={busy} />)}
      </Card>
    </div>
  );
}

function LabelMapRowView({ row, labelSelect, onSave, busy }: {
  row: LabelMapRow; busy: boolean;
  labelSelect: (v: number | null, on: (v: number | null) => void) => React.ReactNode;
  onSave: (r: { id?: string; sfValue: string; mondayLabelId: number | null; active: boolean }) => Promise<void>;
}) {
  const [label, setLabel] = useState(row.mondayLabelId);
  const [active, setActive] = useState(row.active);
  const dirty = label !== row.mondayLabelId || active !== row.active;
  return (
    <div className="flex items-center gap-3 px-5 py-2 border-b border-border-soft last:border-b-0 text-[13px]">
      <span className={`flex-1 ${active ? 'text-fg' : 'text-fg-3 line-through'}`}>{row.sfValue}</span>
      {labelSelect(label, setLabel)}
      <label className="flex items-center gap-1.5 text-fg-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active</label>
      <button disabled={!dirty || busy} onClick={() => void onSave({ id: row.id, sfValue: row.sfValue, mondayLabelId: label, active })}
        className="text-navy disabled:opacity-30" title="Save"><Save size={15} /></button>
    </div>
  );
}

function EstimatorMap({ schema, tasks, info, onChanged }: { schema: SyncSchema; tasks: QueueTask[]; info: EngineInfo; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<EstimatorRow[]>([]);
  const [busy, setBusy] = useState(false);
  const blank = { mondayUserId: '', mondayName: '', sfUserName: '', triageLabelId: null as number | null, ignore: false, active: true };
  const [draft, setDraft] = useState(blank);
  const reload = useCallback(async () => setRows(await listEstimators(schema)), [schema]);
  useEffect(() => { void reload(); }, [reload]);
  const triageLabels = info.labels['triage.engineer_pick'] ?? [];
  const waiting = unmappedEngineers(tasks);

  const save = async (row: Omit<EstimatorRow, 'id' | 'notes'> & { id?: string }) => {
    setBusy(true);
    try { await saveEstimator(schema, row); await reload(); await onChanged(); setDraft(blank); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const triageSelect = (value: number | null, onChange: (v: number | null) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className="text-[13px] border border-border rounded-md px-2 py-1 bg-white w-[170px]">
      <option value="">— none —</option>
      {triageLabels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
    </select>
  );

  return (
    <div className="flex flex-col gap-4">
      {waiting.length > 0 && (
        <Card title="Waiting to be mapped" eyebrow="From open Fix Mapping tasks">
          {waiting.map((w) => (
            <div key={w.taskId} className="flex items-center gap-3 py-1.5 text-[13px]">
              <span className="flex-1">{w.title}</span>
              <button onClick={() => setDraft({ ...blank, mondayUserId: w.mondayUserId ?? '', triageLabelId: w.triageLabelId })} className="text-blue hover:underline">Map it ↓</button>
            </div>
          ))}
        </Card>
      )}
      <Card title="Pre-Sales Engineers: monday person → Salesforce user" flush>
        <div className="px-5 py-2 text-[12px] text-fg-3 border-b border-border">
          Salesforce user name must match the user's full name in Salesforce exactly. <b>Ignore</b> = never an estimator of record (no task, skipped). Triage label = this engineer's name in the Triage board's dropdown.
        </div>
        <div className="px-5 py-3 flex items-center gap-2 border-b border-border bg-surface flex-wrap">
          <input value={draft.mondayUserId} onChange={(e) => setDraft({ ...draft, mondayUserId: e.target.value.replace(/\D/g, '') })} placeholder="monday user id" className="text-[13px] border border-border rounded-md px-2 py-1 w-[130px]" />
          <input value={draft.mondayName} onChange={(e) => setDraft({ ...draft, mondayName: e.target.value })} placeholder="Name in monday" className="text-[13px] border border-border rounded-md px-2 py-1 w-[170px]" />
          <input value={draft.sfUserName} onChange={(e) => setDraft({ ...draft, sfUserName: e.target.value })} placeholder="Salesforce user name" className="text-[13px] border border-border rounded-md px-2 py-1 w-[180px]" />
          {triageSelect(draft.triageLabelId, (v) => setDraft({ ...draft, triageLabelId: v }))}
          <label className="flex items-center gap-1.5 text-[13px] text-fg-2"><input type="checkbox" checked={draft.ignore} onChange={(e) => setDraft({ ...draft, ignore: e.target.checked })} /> ignore</label>
          <button disabled={busy || !draft.mondayUserId || !draft.mondayName.trim()} onClick={() => void save(draft)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-orange text-white text-[13px] disabled:opacity-50"><Plus size={14} /> Add</button>
        </div>
        {rows.map((r) => <EstimatorRowView key={r.id} row={r} triageSelect={triageSelect} onSave={save} busy={busy} />)}
      </Card>
    </div>
  );
}

function EstimatorRowView({ row, triageSelect, onSave, busy }: {
  row: EstimatorRow; busy: boolean;
  triageSelect: (v: number | null, on: (v: number | null) => void) => React.ReactNode;
  onSave: (r: Omit<EstimatorRow, 'id' | 'notes'> & { id?: string }) => Promise<void>;
}) {
  const [sf, setSf] = useState(row.sfUserName ?? '');
  const [label, setLabel] = useState(row.triageLabelId);
  const [ignore, setIgnore] = useState(row.ignore);
  const dirty = sf !== (row.sfUserName ?? '') || label !== row.triageLabelId || ignore !== row.ignore;
  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-border-soft last:border-b-0 text-[13px] flex-wrap">
      <span className={`w-[200px] ${ignore ? 'text-fg-3' : 'text-fg'}`}>{row.mondayName}<span className="text-fg-3 text-[11px] ml-1.5">{row.mondayUserId}</span></span>
      <input value={sf} onChange={(e) => setSf(e.target.value)} placeholder="Salesforce user name" className="text-[13px] border border-border rounded-md px-2 py-1 w-[180px]" />
      {triageSelect(label, setLabel)}
      <label className="flex items-center gap-1.5 text-fg-2"><input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} /> ignore</label>
      <span className="flex-1 text-[12px] text-fg-3 truncate">{row.notes}</span>
      <button disabled={!dirty || busy} onClick={() => void onSave({ ...row, sfUserName: sf, triageLabelId: label, ignore })}
        className="text-navy disabled:opacity-30" title="Save"><Save size={15} /></button>
    </div>
  );
}
