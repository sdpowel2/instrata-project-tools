// Project Wiki — the per-project knowledge base. Project-level context, the
// room index (one line per room / subsystem — the index guarantee), open
// items, full-text search, and drill-down into a room. Engineers edit here
// directly; agents write the same tables over MCP (wikiTools.ts).
// Spec: Product Spec/project-tools-wiki-spec.md.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { NotebookPen, Plus, Search, Download, Loader2, Pencil, Check, X, ChevronRight, Eye, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { ProjectHeader } from '../components/ProjectHeader';
import { PhaseRibbon } from '../components/PhaseRibbon';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { WikiRoomDetail } from '../components/wiki/WikiRoomDetail';
import { RoomStatusChip, WikiStatusChip, SeverityChip, QuestionStatusChip, OriginTag, Field, MarkdownText } from '../components/wiki/wikiUi';
import {
  WIKI_STATUSES, ROOM_STATUSES, ENTRY_KINDS, QUESTION_SEVERITIES, labelFor, isBlocking, splitSnippet, fmtDate,
  fetchWiki, upsertWiki, fetchRoomIndex, createRoom, fetchProjectQuestions, searchWiki, buildWikiMarkdown, downloadMarkdown,
  type ProjectWiki as WikiRecord, type WikiRoomIndexRow, type WikiQuestion, type WikiSearchHit, type WikiStatus, type RoomStatus, type EntryKind, type RoomInput,
} from '../lib/projectWiki';

export function ProjectWiki() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const myProjectIds = useStore((s) => s.myProjectIds);
  const allBoM = useStore((s) => s.projectBoM);
  const bomItems = useMemo(() => allBoM.filter((b) => b.projectId === projectId), [allBoM, projectId]);
  const { isAdmin, user } = useAuth();
  const canEdit = isAdmin || (!!projectId && myProjectIds.has(projectId));

  const [wiki, setWiki] = useState<WikiRecord | null>(null);
  const [index, setIndex] = useState<WikiRoomIndexRow[]>([]);
  const [questions, setQuestions] = useState<WikiQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'blocking' | RoomStatus>('all');
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [exporting, setExporting] = useState(false);

  const selectedRoomId = params.get('room');
  const selectRoom = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('room', id); else next.delete('room');
    setParams(next, { replace: false });
  };

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [w, idx, qs] = await Promise.all([fetchWiki(projectId), fetchRoomIndex(projectId), fetchProjectQuestions(projectId)]);
      setWiki(w); setIndex(idx); setQuestions(qs); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return index;
    if (statusFilter === 'blocking') return index.filter(isBlocking);
    return index.filter((r) => r.status === statusFilter);
  }, [index, statusFilter]);

  const openItems = useMemo(() => questions.filter((q) => q.status === 'open' || q.status === 'answered'), [questions]);
  const blockingRooms = index.filter(isBlocking).length;

  const handleExport = async () => {
    if (!project || !projectId) return;
    setExporting(true);
    try {
      const md = await buildWikiMarkdown(project, projectId);
      downloadMarkdown(`Wiki-${project.number || projectId}.md`, md);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  if (!project || !projectId) return null;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />
      <div className="mt-5">
        <PhaseRibbon phase={project.phase} toolLabel="Project Wiki" toolIcon={NotebookPen} />
      </div>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h2 className="text-[22px] font-bold text-navy m-0">Project Wiki</h2>
          <p className="text-[13px] text-fg-2 mt-1 m-0">
            One record per room or subsystem, decisions with their rationale, and the questions log. Searchable here and by Claude over MCP.
          </p>
        </div>
        <div className="flex gap-3 flex-shrink-0">
          <button onClick={handleExport} disabled={exporting || index.length === 0} className="btn-secondary text-sm disabled:opacity-50" title="Download a markdown snapshot (wiki.md shape)">
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export markdown
          </button>
          {canEdit && (
            <button onClick={() => setShowNewRoom(true)} className="btn-orange text-sm"><Plus size={16} /> Add room</button>
          )}
        </div>
      </div>

      {!canEdit && (
        <div className="mb-5 flex items-center gap-2 text-[13px] text-fg-2 bg-white border border-border rounded-lg px-4 py-2.5">
          <Eye size={14} className="text-fg-3" />
          View only — you're not on this project's team. Use <strong>Team → Add me</strong> to write notes.
        </div>
      )}

      {error && <div className="mb-5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</div>}

      {selectedRoomId ? (
        <WikiRoomDetail
          key={selectedRoomId}
          roomId={selectedRoomId}
          canEdit={canEdit}
          userId={user?.id ?? null}
          bomItems={bomItems}
          onBack={() => selectRoom(null)}
          onChanged={() => void reload()}
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-5 mb-5">
            <div className="col-span-2">
              <ContextCard
                wiki={wiki}
                canEdit={canEdit}
                onSave={async (patch) => { await upsertWiki(projectId, patch); await reload(); }}
              />
            </div>
            <div className="space-y-5">
              <OpenItemsCard items={openItems} blockingRooms={blockingRooms} onOpenRoom={(id) => selectRoom(id)} />
              <SearchCard projectId={projectId} onOpenRoom={(id) => selectRoom(id)} />
            </div>
          </div>

          {/* Room index */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              {([
                { key: 'all', label: `All · ${index.length}` },
                { key: 'blocking', label: `Blocking · ${blockingRooms}` },
                ...ROOM_STATUSES.map((s) => ({ key: s.key, label: `${s.label} · ${index.filter((r) => r.status === s.key).length}` })),
              ] as { key: typeof statusFilter; label: string }[]).map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${statusFilter === f.key ? 'bg-navy text-white' : 'bg-white text-text-secondary border border-border hover:bg-surface'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="bg-white border border-border rounded-xl shadow-sm p-10 flex items-center justify-center gap-2 text-sm text-fg-2">
              <Loader2 size={16} className="animate-spin" /> Loading wiki…
            </div>
          ) : index.length === 0 ? (
            <div className="bg-white border border-border rounded-xl shadow-sm">
              <EmptyState
                icon={<NotebookPen size={48} />}
                title="No rooms in this wiki yet"
                description="Add a room or subsystem to start the index. Every room gets a one-line headline and a status, so nothing is ever silently unmentioned."
                action={canEdit ? <button onClick={() => setShowNewRoom(true)} className="btn-primary"><Plus size={16} /> Add first room</button> : undefined}
              />
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-navy text-white text-left">
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider w-16">#</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Room / subsystem</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider w-32">Status</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Headline</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-right w-24">Decisions</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-right w-24">Open Qs</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-right w-20">Hours</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((r, i) => (
                    <tr
                      key={r.id}
                      onClick={() => selectRoom(r.id)}
                      className={`cursor-pointer hover:bg-surface/50 transition-colors ${i % 2 === 1 ? 'bg-surface/30' : ''} ${isBlocking(r) ? 'border-l-4 border-l-red-500' : ''}`}
                    >
                      <td className="px-4 py-3 text-sm font-mono font-medium text-navy">{r.roomNumber ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-fg font-medium">{r.roomName}</div>
                        <div className="text-[11px] text-fg-3 flex items-center gap-1.5 flex-wrap">
                          {r.entryKind !== 'room' && <span className="uppercase font-semibold tracking-wider">{labelFor(ENTRY_KINDS, r.entryKind)}</span>}
                          {r.floor && <span>{r.floor}</span>}
                          {r.roomType && <span>· {r.roomType}</span>}
                          {r.typicalOfCount && <span>· typical of {r.typicalOfCount}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3"><RoomStatusChip status={r.status} /></td>
                      <td className="px-4 py-3 text-sm text-fg">
                        <div className="flex items-center gap-2">
                          <span className="flex-1">{r.headline}</span>
                          {r.origin !== 'human' && <OriginTag origin={r.origin} />}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-fg-2 font-mono">{r.decisionCount || '—'}</td>
                      <td className={`px-4 py-3 text-sm text-right font-mono ${r.openQuestionCount ? 'text-red-700 font-semibold' : 'text-fg-2'}`}>{r.openQuestionCount || '—'}</td>
                      <td className="px-4 py-3 text-sm text-right text-fg-2 font-mono">{r.laborHours ? r.laborHours.toFixed(1) : '—'}</td>
                      <td className="pr-3 text-fg-3"><ChevronRight size={14} /></td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-fg-3">No rooms match this filter.</td></tr>
                  )}
                </tbody>
              </table>
              <div className="px-5 py-3 bg-surface/50 border-t border-border text-sm text-text-secondary">
                {index.length} room{index.length === 1 ? '' : 's'} · {blockingRooms} blocking · {index.reduce((s, r) => s + r.decisionCount, 0)} decisions · {index.reduce((s, r) => s + r.laborHours, 0).toFixed(1)} h estimated
              </div>
            </div>
          )}
        </>
      )}

      <NewRoomModal
        open={showNewRoom}
        nextSortOrder={(index.reduce((m, r) => Math.max(m, r.sortOrder), 0) || 0) + 10}
        onClose={() => setShowNewRoom(false)}
        onCreate={async (input) => {
          const room = await createRoom(projectId, input);
          setShowNewRoom(false);
          await reload();
          selectRoom(room.id);
        }}
      />
    </div>
  );
}

// ── Project-level context ─────────────────────────────────────────────────────
function ContextCard({ wiki, canEdit, onSave }: { wiki: WikiRecord | null; canEdit: boolean; onSave: (p: { summary?: string | null; scopeSummary?: string | null; designBasis?: string | null; status?: WikiStatus }) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ summary: '', scopeSummary: '', designBasis: '', status: 'draft' as WikiStatus });
  // Seed the draft when edit mode opens; display mode reads props directly.
  const startEditing = () => {
    setF({ summary: wiki?.summary ?? '', scopeSummary: wiki?.scopeSummary ?? '', designBasis: wiki?.designBasis ?? '', status: wiki?.status ?? 'draft' });
    setEditing(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ summary: f.summary.trim() || null, scopeSummary: f.scopeSummary.trim() || null, designBasis: f.designBasis.trim() || null, status: f.status });
      setEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm h-full">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-navy m-0">Project context</h2>
          <WikiStatusChip status={wiki?.status ?? 'draft'} />
          {wiki?.pipelineRunAt && (
            <span className="text-xs text-fg-3 inline-flex items-center gap-1" title="Populated by a pipeline run"><Sparkles size={12} /> Pipeline run {fmtDate(wiki.pipelineRunAt)}</span>
          )}
        </div>
        {canEdit && !editing && <button onClick={startEditing} className="btn-secondary text-xs py-1.5 px-3"><Pencil size={12} /> Edit</button>}
      </div>
      {editing ? (
        <form onSubmit={submit} className="p-5 space-y-4">
          <Field label="Wiki status" hint='"Awaiting review" is the explicit human-gate marker'>
            <select className="input w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as WikiStatus })}>
              {WIKI_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Summary" hint="Project-level orientation. Markdown.">
            <textarea className="input font-mono text-[13px]" rows={6} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
          </Field>
          <Field label="Scope summary" hint="What the AV scope covers, in prose">
            <textarea className="input font-mono text-[13px]" rows={4} value={f.scopeSummary} onChange={(e) => setF({ ...f, scopeSummary: e.target.value })} />
          </Field>
          <Field label="Design basis" hint="Which consultant documents the design derives from, with revision / date">
            <textarea className="input font-mono text-[13px]" rows={3} value={f.designBasis} onChange={(e) => setF({ ...f, designBasis: e.target.value })} />
          </Field>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm">{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save</button>
          </div>
        </form>
      ) : (
        <div className="p-5 space-y-5">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-fg-3 font-semibold mb-1.5">Summary</div>
            <MarkdownText text={wiki?.summary} />
          </div>
          <div className="grid grid-cols-2 gap-5">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-3 font-semibold mb-1.5">Scope</div>
              <MarkdownText text={wiki?.scopeSummary} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-3 font-semibold mb-1.5">Design basis</div>
              <MarkdownText text={wiki?.designBasis} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Open items (§5.3) ─────────────────────────────────────────────────────────
function OpenItemsCard({ items, blockingRooms, onOpenRoom }: { items: WikiQuestion[]; blockingRooms: number; onOpenRoom: (id: string) => void }) {
  const groups = QUESTION_SEVERITIES.map((s) => ({ ...s, items: items.filter((q) => q.severity === s.key) }));
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <h2 className="text-base font-semibold text-navy m-0">Needs your input</h2>
        <span className={`text-xs font-semibold ${items.length ? 'text-red-700' : 'text-fg-3'}`}>{items.length} open · {blockingRooms} room{blockingRooms === 1 ? '' : 's'} blocking</span>
      </div>
      {items.length === 0 ? (
        <div className="p-5 text-sm text-fg-3 italic">Nothing waiting on a human.</div>
      ) : (
        <div className="divide-y divide-border-soft max-h-80 overflow-y-auto">
          {groups.filter((g) => g.items.length).map((g) => (
            <div key={g.key} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-2"><SeverityChip severity={g.key} /><span className="text-[11px] text-fg-3">{g.hint}</span></div>
              <ul className="m-0 p-0 list-none space-y-2">
                {g.items.map((q) => (
                  <li key={q.id}>
                    <button
                      onClick={() => q.roomId && onOpenRoom(q.roomId)}
                      disabled={!q.roomId}
                      className="text-left w-full group disabled:cursor-default"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-fg-3">
                        <span className="font-semibold text-fg-2">{q.roomLabel ?? 'Project-level'}</span>
                        <QuestionStatusChip status={q.status} />
                      </div>
                      <div className="text-sm text-fg group-hover:text-navy leading-snug">{q.question}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Search (§6 search_project_wiki) ──────────────────────────────────────────
function SearchCard({ projectId, onOpenRoom }: { projectId: string; onOpenRoom: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<WikiSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) { setHits(null); return; }
    setBusy(true); setErr(null);
    try { setHits(await searchWiki(projectId, q)); } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-base font-semibold text-navy m-0">Search this wiki</h2>
        <div className="text-xs text-fg-3 mt-0.5">Same full-text index Claude uses over MCP. Try "why 4 receivers" or a room number.</div>
      </div>
      <form onSubmit={run} className="p-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search headlines, notes, rationale, questions…" className="input pl-9 pr-9 py-2 text-sm" />
          {busy && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-fg-3" />}
        </div>
      </form>
      {err && <div className="px-4 pb-4 text-xs text-red-600">{err}</div>}
      {hits && (
        <div className="border-t border-border-soft divide-y divide-border-soft max-h-80 overflow-y-auto">
          {hits.length === 0 && <div className="p-4 text-sm text-fg-3 italic">No matches.</div>}
          {hits.map((h) => (
            <button
              key={`${h.kind}-${h.id}`}
              onClick={() => h.roomId && onOpenRoom(h.roomId)}
              disabled={!h.roomId}
              className="block w-full text-left px-4 py-3 hover:bg-surface/60 disabled:cursor-default"
            >
              <div className="flex items-center gap-2 text-[11px] text-fg-3">
                <span className="uppercase font-bold tracking-wider text-orange">{h.kind}</span>
                {h.roomLabel && <span className="font-semibold text-fg-2">{h.roomLabel}</span>}
              </div>
              <div className="text-sm font-medium text-fg leading-snug">{h.title}</div>
              <div className="text-xs text-fg-2 mt-0.5 leading-snug">
                {splitSnippet(h.snippet).map((p, i) => p.hit ? <mark key={i} className="bg-yellow-100 text-fg rounded px-0.5">{p.text}</mark> : <span key={i}>{p.text}</span>)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── New room modal ────────────────────────────────────────────────────────────
const BLANK_ROOM = { roomNumber: '', roomName: '', floor: '', dtoolsLocation: '', entryKind: 'room' as EntryKind, roomType: '', headline: '', detail: '' };

function NewRoomModal({ open, nextSortOrder, onClose, onCreate }: { open: boolean; nextSortOrder: number; onClose: () => void; onCreate: (input: RoomInput) => Promise<void> }) {
  const [f, setF] = useState(BLANK_ROOM);
  const [saving, setSaving] = useState(false);
  // Reset the form whenever the modal closes so the next open starts clean.
  const close = () => { setF(BLANK_ROOM); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.roomName.trim() || !f.headline.trim()) return;
    setSaving(true);
    try {
      await onCreate({
        roomNumber: f.roomNumber.trim() || null,
        roomName: f.roomName.trim(),
        floor: f.floor.trim() || null,
        dtoolsLocation: f.dtoolsLocation.trim() || null,
        entryKind: f.entryKind,
        roomType: f.roomType.trim() || null,
        headline: f.headline.trim(),
        detail: f.detail.trim() || null,
        sortOrder: nextSortOrder,
        status: 'authored',
      });
      setF(BLANK_ROOM);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Add room or subsystem" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Room number" hint="Blank for head-ends, zones, etc."><input className="input" value={f.roomNumber} onChange={(e) => setF({ ...f, roomNumber: e.target.value })} placeholder="311" /></Field>
          <Field label="Room / subsystem name" required className="col-span-2"><input className="input" value={f.roomName} onChange={(e) => setF({ ...f, roomName: e.target.value })} placeholder="Md Conference 2" required autoFocus /></Field>
          <Field label="Entry kind">
            <select className="input" value={f.entryKind} onChange={(e) => setF({ ...f, entryKind: e.target.value as EntryKind })}>
              {ENTRY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Floor"><input className="input" value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })} placeholder="2nd Floor" /></Field>
          <Field label="Room type" hint="Free text; groups typicals"><input className="input" value={f.roomType} onChange={(e) => setF({ ...f, roomType: e.target.value })} placeholder="Small Conference" /></Field>
        </div>
        <Field label="D-Tools location" hint="Full location string. Agents reconcile re-runs on this, so match D-Tools exactly if you know it.">
          <input className="input" value={f.dtoolsLocation} onChange={(e) => setF({ ...f, dtoolsLocation: e.target.value })} placeholder="2nd Floor: 311 - Md Conference 2" />
        </Field>
        <Field label="Headline" hint="One line — the room's entry in the index. Keep it short." required>
          <input className="input" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} placeholder='Dual 75" displays, Rally Bar, ceiling mic — per consultant' required />
        </Field>
        <Field label="Design notes" hint="Optional. Markdown. You can add decisions, questions, labor and links after creating.">
          <textarea className="input font-mono text-[13px]" rows={5} value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button type="button" onClick={close} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={16} />} Create room</button>
        </div>
      </form>
    </Modal>
  );
}
