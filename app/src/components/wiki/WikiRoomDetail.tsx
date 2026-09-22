// Project Wiki — one room / subsystem in full, with in-place editing for
// members: headline + status, the metadata grid, long-form detail and
// validation notes (markdown), decisions, questions, labor buckets, and links
// to BoM lines / project files. Read-only for non-members.
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Pencil, Check, X, Plus, Trash2, Loader2, Link2, FileText, ExternalLink, AlertTriangle, MessageCircleQuestion,
} from 'lucide-react';
import type { ProjectBoMItem } from '../../types';
import { fetchProjectFiles, type ProjectFile } from '../../lib/projectFiles';
import {
  ENTRY_KINDS, SIZE_CLASSES, SIZE_BASES, ROOM_STATUSES, DECISION_KINDS, QUESTION_SEVERITIES, LABOR_TYPES, REQUIRED_LABOR_TYPES,
  labelFor, roomLabel, fmtDate,
  fetchRoomBundle, updateRoom, deleteRoom, addDecision, updateDecision, deleteDecision,
  raiseQuestion, answerQuestion, setQuestionStatus, deleteQuestion, setRoomLabor, linkBomLines, unlinkBomLine, linkFiles, unlinkFile,
  type WikiRoomBundle, type WikiRoom, type RoomInput, type WikiDecision, type WikiQuestion, type DecisionKind, type QuestionSeverity,
  type LaborType, type RoomStatus, type EntryKind, type SizeClass, type SizeBasis,
} from '../../lib/projectWiki';
import {
  RoomStatusChip, OriginTag, DecisionKindChip, SeverityChip, QuestionStatusChip, Field, SectionTitle, MarkdownText,
} from './wikiUi';

interface Props {
  roomId: string;
  canEdit: boolean;
  userId: string | null;
  bomItems: ProjectBoMItem[];
  onBack: () => void;
  /** Called after any write so the index / open-items panels refresh. */
  onChanged: () => void;
}

export function WikiRoomDetail({ roomId, canEdit, userId, bomItems, onBack, onChanged }: Props) {
  const [bundle, setBundle] = useState<WikiRoomBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setBundle(await fetchRoomBundle(roomId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void reload(); }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="bg-white border border-border rounded-xl shadow-sm p-6">
        <button onClick={onBack} className="btn-secondary text-sm mb-4"><ArrowLeft size={14} /> Back to index</button>
        <div className="text-sm text-red-600">{error}</div>
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="bg-white border border-border rounded-xl shadow-sm p-10 flex items-center justify-center gap-2 text-sm text-fg-2">
        <Loader2 size={16} className="animate-spin" /> Loading room…
      </div>
    );
  }

  const { room } = bundle;
  const typicalMismatch = room.typicalOfCount != null && room.typicalOfRooms != null && room.typicalOfRooms.length !== room.typicalOfCount;

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div className="bg-white border border-border rounded-xl shadow-sm">
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <button onClick={onBack} className="btn-secondary text-sm"><ArrowLeft size={14} /> Back to index</button>
          <div className="flex items-center gap-2 text-xs text-fg-3">
            <OriginTag origin={room.origin} />
            <span>Updated {fmtDate(room.updatedAt)}</span>
            {busy && <Loader2 size={14} className="animate-spin text-fg-3" />}
          </div>
        </div>
        <div className="p-5">
          <HeadlineEditor room={room} canEdit={canEdit} onSave={(patch) => run(() => updateRoom(room.id, patch, room.origin))} />
          {typicalMismatch && (
            <div className="mt-3 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>"Typical of {room.typicalOfCount}" but the roster lists {room.typicalOfRooms!.length} room(s). Fix one so every covered room is named.</span>
            </div>
          )}
          <MetaEditor room={room} canEdit={canEdit} onSave={(patch) => run(() => updateRoom(room.id, patch, room.origin))} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-5">
          <LongTextCard
            title="Design notes"
            hint="Long-form notes for this room. Markdown."
            value={room.detail}
            canEdit={canEdit}
            onSave={(v) => run(() => updateRoom(room.id, { detail: v }, room.origin))}
          />
          <LongTextCard
            title="Validation notes"
            hint="The math: counts, coverage, headroom, power."
            value={room.validationNotes}
            canEdit={canEdit}
            onSave={(v) => run(() => updateRoom(room.id, { validationNotes: v }, room.origin))}
          />
          <DecisionsCard
            room={room}
            decisions={bundle.decisions}
            canEdit={canEdit}
            onAdd={(d) => run(() => addDecision(room.projectId, room.id, d))}
            onEdit={(id, patch, origin) => run(() => updateDecision(id, patch, origin))}
            onDelete={(id) => run(() => deleteDecision(id))}
          />
          <QuestionsCard
            room={room}
            questions={bundle.questions}
            canEdit={canEdit}
            onRaise={(q) => run(() => raiseQuestion(room.projectId, room.id, q))}
            onAnswer={(q, a) => run(() => answerQuestion(q, a, userId))}
            onStatus={(id, s) => run(() => setQuestionStatus(id, s))}
            onDelete={(id) => run(() => deleteQuestion(id))}
          />
        </div>
        <div className="space-y-5">
          <LaborCard
            room={room}
            labor={bundle.labor}
            canEdit={canEdit}
            onSave={(rows) => run(() => setRoomLabor(room, rows))}
          />
          <BomLinksCard
            room={room}
            links={bundle.bomLinks}
            bomItems={bomItems}
            canEdit={canEdit}
            onLink={(ids) => run(() => linkBomLines(room, ids))}
            onUnlink={(id) => run(() => unlinkBomLine(id))}
          />
          <FileLinksCard
            room={room}
            links={bundle.fileLinks}
            canEdit={canEdit}
            onLink={(ids) => run(() => linkFiles(room, ids))}
            onUnlink={(id) => run(() => unlinkFile(id))}
          />
          {canEdit && (
            <div className="text-right">
              <button
                onClick={() => {
                  if (confirm(`Delete "${roomLabel(room)}" and all its decisions, questions, labor and links? This cannot be undone.`)) {
                    void (async () => {
                      try { await deleteRoom(room.id); onChanged(); onBack(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
                    })();
                  }
                }}
                className="btn-secondary text-sm text-red-600 hover:border-red-300"
              >
                <Trash2 size={14} /> Delete room
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Headline + status ─────────────────────────────────────────────────────────
function HeadlineEditor({ room, canEdit, onSave }: { room: WikiRoom; canEdit: boolean; onSave: (p: Partial<RoomInput>) => void }) {
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState(room.headline);
  const [status, setStatus] = useState<RoomStatus>(room.status);
  // Drafts are seeded when edit mode opens, so display mode always reflects props.
  const startEditing = () => { setHeadline(room.headline); setStatus(room.status); setEditing(true); };

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-[22px] font-bold text-navy m-0 leading-tight">{roomLabel(room)}</h2>
            <RoomStatusChip status={room.status} />
            <span className="text-xs text-fg-3">{labelFor(ENTRY_KINDS, room.entryKind)}</span>
          </div>
          <p className="text-[15px] text-fg mt-2 m-0">{room.headline}</p>
        </div>
        {canEdit && (
          <button onClick={startEditing} className="btn-secondary text-sm flex-shrink-0"><Pencil size={14} /> Headline / status</button>
        )}
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!headline.trim()) return; onSave({ headline: headline.trim(), status }); setEditing(false); }}
      className="space-y-3"
    >
      <div className="flex items-center gap-2.5">
        <h2 className="text-[22px] font-bold text-navy m-0 leading-tight">{roomLabel(room)}</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as RoomStatus)} className="input w-auto py-1.5 text-sm">
          {ROOM_STATUSES.map((s) => <option key={s.key} value={s.key} title={s.hint}>{s.label}</option>)}
        </select>
      </div>
      <Field label="Headline" hint="One line — this is the room's entry in the index. Keep it short." required>
        <input value={headline} onChange={(e) => setHeadline(e.target.value)} className="input" required autoFocus />
      </Field>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => { setEditing(false); setHeadline(room.headline); setStatus(room.status); }} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
        <button type="submit" className="btn-primary text-sm"><Check size={14} /> Save</button>
      </div>
    </form>
  );
}

// ── Metadata grid ─────────────────────────────────────────────────────────────
function MetaEditor({ room, canEdit, onSave }: { room: WikiRoom; canEdit: boolean; onSave: (p: Partial<RoomInput>) => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => toForm(room));
  const startEditing = () => { setF(toForm(room)); setEditing(true); };

  const items: [string, string][] = [
    ['Floor', room.floor ?? '—'],
    ['D-Tools location', room.dtoolsLocation ?? '—'],
    ['Room type', room.roomType ?? '—'],
    ['Area', room.areaSqft != null ? `${room.areaSqft.toLocaleString()} sq ft` : '—'],
    ['Size class', room.sizeClass ? `${labelFor(SIZE_CLASSES, room.sizeClass)}${room.sizeBasis ? ` · by ${labelFor(SIZE_BASES, room.sizeBasis).toLowerCase()}` : ''}` : '—'],
    ['Conferencing', room.hasConferencing == null ? '—' : room.hasConferencing ? 'Yes' : 'No'],
    ['Typical of', room.typicalOfCount ? `${room.typicalOfCount}${room.typicalOfRooms?.length ? ` — ${room.typicalOfRooms.join(', ')}` : ''}` : '—'],
    ['Sort order', String(room.sortOrder)],
  ];

  if (!editing) {
    return (
      <div className="mt-5 border-t border-border-soft pt-4">
        <SectionTitle action={canEdit && <button onClick={startEditing} className="text-xs text-navy font-medium hover:underline inline-flex items-center gap-1"><Pencil size={12} /> Edit details</button>}>
          Details
        </SectionTitle>
        <dl className="grid grid-cols-4 gap-x-6 gap-y-3 m-0">
          {items.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wider text-fg-3 font-semibold">{k}</dt>
              <dd className="text-sm text-fg m-0 mt-0.5 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave(fromForm(f)); setEditing(false); }}
      className="mt-5 border-t border-border-soft pt-4 space-y-4"
    >
      <SectionTitle>Details</SectionTitle>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Room name" required><input className="input" value={f.roomName} onChange={(e) => set('roomName', e.target.value)} required /></Field>
        <Field label="Room number"><input className="input" value={f.roomNumber} onChange={(e) => set('roomNumber', e.target.value)} placeholder="311" /></Field>
        <Field label="Entry kind">
          <select className="input" value={f.entryKind} onChange={(e) => set('entryKind', e.target.value as EntryKind)}>
            {ENTRY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Floor"><input className="input" value={f.floor} onChange={(e) => set('floor', e.target.value)} placeholder="2nd Floor" /></Field>
        <Field label="D-Tools location" hint="Full string, e.g. 2nd Floor: 236 - Md Conference 2" className="col-span-2">
          <input className="input" value={f.dtoolsLocation} onChange={(e) => set('dtoolsLocation', e.target.value)} />
        </Field>
        <Field label="Room type" hint="Free text; groups typicals"><input className="input" value={f.roomType} onChange={(e) => set('roomType', e.target.value)} placeholder="Small Conference" /></Field>
        <Field label="Area (sq ft)"><input className="input" type="number" min={0} step="any" value={f.areaSqft} onChange={(e) => set('areaSqft', e.target.value)} /></Field>
        <Field label="Sort order"><input className="input" type="number" value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} /></Field>
        <Field label="Size class">
          <select className="input" value={f.sizeClass} onChange={(e) => set('sizeClass', e.target.value as SizeClass | '')}>
            <option value="">— undetermined —</option>
            {SIZE_CLASSES.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Size basis">
          <select className="input" value={f.sizeBasis} onChange={(e) => set('sizeBasis', e.target.value as SizeBasis | '')}>
            <option value="">—</option>
            {SIZE_BASES.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Conferencing">
          <select className="input" value={f.hasConferencing} onChange={(e) => set('hasConferencing', e.target.value as '' | 'yes' | 'no')}>
            <option value="">— unknown —</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        <Field label="Typical of (count)"><input className="input" type="number" min={1} value={f.typicalOfCount} onChange={(e) => set('typicalOfCount', e.target.value)} /></Field>
        <Field label="Typical of (rooms)" hint="Comma-separated room numbers covered by this typical" className="col-span-2">
          <input className="input" value={f.typicalOfRooms} onChange={(e) => set('typicalOfRooms', e.target.value)} placeholder="236, 238, 240" />
        </Field>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => { setEditing(false); setF(toForm(room)); }} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
        <button type="submit" className="btn-primary text-sm"><Check size={14} /> Save details</button>
      </div>
    </form>
  );
}

function toForm(r: WikiRoom) {
  return {
    roomName: r.roomName, roomNumber: r.roomNumber ?? '', entryKind: r.entryKind, floor: r.floor ?? '',
    dtoolsLocation: r.dtoolsLocation ?? '', roomType: r.roomType ?? '', areaSqft: r.areaSqft?.toString() ?? '',
    sortOrder: String(r.sortOrder), sizeClass: (r.sizeClass ?? '') as SizeClass | '', sizeBasis: (r.sizeBasis ?? '') as SizeBasis | '',
    hasConferencing: (r.hasConferencing == null ? '' : r.hasConferencing ? 'yes' : 'no') as '' | 'yes' | 'no',
    typicalOfCount: r.typicalOfCount?.toString() ?? '', typicalOfRooms: r.typicalOfRooms?.join(', ') ?? '',
  };
}

function fromForm(f: ReturnType<typeof toForm>): Partial<RoomInput> {
  const blankNull = (s: string) => (s.trim() ? s.trim() : null);
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
  const roster = f.typicalOfRooms.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    roomName: f.roomName.trim(), roomNumber: blankNull(f.roomNumber), entryKind: f.entryKind, floor: blankNull(f.floor),
    dtoolsLocation: blankNull(f.dtoolsLocation), roomType: blankNull(f.roomType), areaSqft: numOrNull(f.areaSqft),
    sortOrder: Number(f.sortOrder) || 0, sizeClass: f.sizeClass || null, sizeBasis: f.sizeBasis || null,
    hasConferencing: f.hasConferencing === '' ? null : f.hasConferencing === 'yes',
    typicalOfCount: numOrNull(f.typicalOfCount), typicalOfRooms: roster.length ? roster : null,
  };
}

// ── Long-form markdown card ───────────────────────────────────────────────────
function LongTextCard({ title, hint, value, canEdit, onSave }: { title: string; hint: string; value: string | null; canEdit: boolean; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const startEditing = () => { setDraft(value ?? ''); setEditing(true); };
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-navy m-0">{title}</h3>
          <div className="text-xs text-fg-3">{hint}</div>
        </div>
        {canEdit && !editing && <button onClick={startEditing} className="btn-secondary text-xs py-1.5 px-3"><Pencil size={12} /> Edit</button>}
      </div>
      <div className="p-5">
        {editing ? (
          <div className="space-y-3">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className="input font-mono text-[13px]" autoFocus />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setEditing(false); setDraft(value ?? ''); }} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
              <button onClick={() => { onSave(draft.trim() ? draft : null); setEditing(false); }} className="btn-primary text-sm"><Check size={14} /> Save</button>
            </div>
          </div>
        ) : (
          <MarkdownText text={value} />
        )}
      </div>
    </div>
  );
}

// ── Decisions ─────────────────────────────────────────────────────────────────
function DecisionsCard({ room, decisions, canEdit, onAdd, onEdit, onDelete }: {
  room: WikiRoom;
  decisions: WikiDecision[];
  canEdit: boolean;
  onAdd: (d: { kind: DecisionKind; title: string; rationale: string; sourceRef?: string | null; assumptionConfirmed?: boolean | null }) => void;
  onEdit: (id: string, patch: { title?: string; rationale?: string; sourceRef?: string | null; kind?: DecisionKind; assumptionConfirmed?: boolean | null }, origin: WikiDecision['origin']) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-navy m-0">Decisions <span className="text-fg-3 font-normal">· {decisions.length}</span></h3>
          <div className="text-xs text-fg-3">The why. Each decision is one line plus its rationale — this is what gets searched later.</div>
        </div>
        {canEdit && !adding && <button onClick={() => setAdding(true)} className="btn-secondary text-xs py-1.5 px-3"><Plus size={12} /> Add decision</button>}
      </div>
      <div className="divide-y divide-border-soft">
        {adding && (
          <div className="p-5 bg-surface/40">
            <DecisionForm onCancel={() => setAdding(false)} onSubmit={(d) => { onAdd(d); setAdding(false); }} />
          </div>
        )}
        {decisions.length === 0 && !adding && (
          <div className="p-5 text-sm text-fg-3 italic">No decisions recorded for {roomLabel(room)}. A clean room may legitimately have none.</div>
        )}
        {decisions.map((d) => (
          <div key={d.id} className="p-5">
            {editingId === d.id ? (
              <DecisionForm
                initial={d}
                onCancel={() => setEditingId(null)}
                onSubmit={(patch) => { onEdit(d.id, patch, d.origin); setEditingId(null); }}
              />
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <DecisionKindChip kind={d.kind} />
                    {d.kind === 'assumption' && (
                      <span className={`text-[11px] font-semibold ${d.assumptionConfirmed ? 'text-green-700' : 'text-red-700'}`}>
                        {d.assumptionConfirmed ? 'Confirmed' : 'Unconfirmed'}
                      </span>
                    )}
                    <OriginTag origin={d.origin} />
                    <span className="text-xs text-fg-3">{fmtDate(d.createdAt)}</span>
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => setEditingId(d.id)} className="p-1.5 rounded hover:bg-surface text-fg-3" title="Edit"><Pencil size={13} /></button>
                      <button onClick={() => { if (confirm('Delete this decision?')) onDelete(d.id); }} className="p-1.5 rounded hover:bg-red-50 text-fg-3 hover:text-red-600" title="Delete"><Trash2 size={13} /></button>
                    </div>
                  )}
                </div>
                <div className="text-[15px] font-semibold text-fg mt-2">{d.title}</div>
                <MarkdownText text={d.rationale} className="mt-1.5" />
                {d.sourceRef && <div className="text-xs text-fg-2 mt-2">Source: <span className="font-mono">{d.sourceRef}</span></div>}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionForm({ initial, onSubmit, onCancel }: {
  initial?: WikiDecision;
  onSubmit: (d: { kind: DecisionKind; title: string; rationale: string; sourceRef: string | null; assumptionConfirmed: boolean | null }) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<DecisionKind>(initial?.kind ?? 'rationale');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [rationale, setRationale] = useState(initial?.rationale ?? '');
  const [sourceRef, setSourceRef] = useState(initial?.sourceRef ?? '');
  const [confirmed, setConfirmed] = useState<boolean | null>(initial?.assumptionConfirmed ?? null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSubmit({ kind, title: title.trim(), rationale, sourceRef: sourceRef.trim() || null, assumptionConfirmed: kind === 'assumption' ? (confirmed ?? false) : null });
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as DecisionKind)}>
            {DECISION_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Decision (one line)" required className="col-span-2">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="3 transmitters, 4 receivers" required autoFocus />
        </Field>
      </div>
      <Field label="Rationale" hint="Why. This is the field future readers search for.">
        <textarea className="input" rows={4} value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3 items-end">
        <Field label="Source reference" hint="Consultant doc, sheet number, spec section">
          <input className="input" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="AV-201 Rev 3 / 27 41 16 §2.3" />
        </Field>
        {kind === 'assumption' && (
          <label className="flex items-center gap-2 text-sm text-fg pb-2.5">
            <input type="checkbox" checked={!!confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Assumption confirmed by a human
          </label>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
        <button type="submit" className="btn-primary text-sm"><Check size={14} /> {initial ? 'Save' : 'Add decision'}</button>
      </div>
    </form>
  );
}

// ── Questions ─────────────────────────────────────────────────────────────────
function QuestionsCard({ room, questions, canEdit, onRaise, onAnswer, onStatus, onDelete }: {
  room: WikiRoom;
  questions: WikiQuestion[];
  canEdit: boolean;
  onRaise: (q: { severity: QuestionSeverity; question: string; context: string | null }) => void;
  onAnswer: (q: WikiQuestion, a: { answer: string; resolution: string | null; decision?: { kind: DecisionKind; title: string; rationale: string } }) => void;
  onStatus: (id: string, s: 'withdrawn' | 'resolved') => void;
  onDelete: (id: string) => void;
}) {
  const [raising, setRaising] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const open = questions.filter((q) => q.status === 'open').length;
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-navy m-0">
            Questions <span className="text-fg-3 font-normal">· {questions.length}{open ? ` · ${open} open` : ''}</span>
          </h3>
          <div className="text-xs text-fg-3">Raising a question moves the room to Escalated; answering it with a decision resolves it.</div>
        </div>
        {canEdit && !raising && <button onClick={() => setRaising(true)} className="btn-secondary text-xs py-1.5 px-3"><MessageCircleQuestion size={12} /> Raise question</button>}
      </div>
      <div className="divide-y divide-border-soft">
        {raising && (
          <div className="p-5 bg-surface/40">
            <RaiseForm onCancel={() => setRaising(false)} onSubmit={(q) => { onRaise(q); setRaising(false); }} />
          </div>
        )}
        {questions.length === 0 && !raising && (
          <div className="p-5 text-sm text-fg-3 italic">No questions on {roomLabel(room)}.</div>
        )}
        {questions.map((q) => (
          <div key={q.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <SeverityChip severity={q.severity} />
                <QuestionStatusChip status={q.status} />
                <span className="text-xs text-fg-3">Raised {fmtDate(q.raisedAt)}</span>
              </div>
              {canEdit && (
                <div className="flex gap-1 flex-shrink-0">
                  {q.status === 'open' && answeringId !== q.id && (
                    <button onClick={() => setAnsweringId(q.id)} className="btn-primary text-xs py-1 px-2.5">Answer</button>
                  )}
                  {q.status === 'open' && (
                    <button onClick={() => onStatus(q.id, 'withdrawn')} className="btn-secondary text-xs py-1 px-2.5">Withdraw</button>
                  )}
                  {q.status === 'answered' && (
                    <button onClick={() => onStatus(q.id, 'resolved')} className="btn-secondary text-xs py-1 px-2.5">Mark resolved</button>
                  )}
                  <button onClick={() => { if (confirm('Delete this question?')) onDelete(q.id); }} className="p-1.5 rounded hover:bg-red-50 text-fg-3 hover:text-red-600" title="Delete"><Trash2 size={13} /></button>
                </div>
              )}
            </div>
            <div className="text-[15px] font-semibold text-fg mt-2">{q.question}</div>
            {q.context && <div className="text-sm text-fg-2 mt-1"><span className="text-fg-3">Context:</span> {q.context}</div>}
            {q.answer && (
              <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-green-700">Answer{q.answeredAt ? ` · ${fmtDate(q.answeredAt)}` : ''}</div>
                <p className="text-sm text-fg m-0 mt-1 whitespace-pre-wrap">{q.answer}</p>
                {q.resolution && <p className="text-sm text-fg-2 m-0 mt-2"><span className="font-semibold text-fg">Resolution:</span> {q.resolution}</p>}
              </div>
            )}
            {answeringId === q.id && (
              <div className="mt-3">
                <AnswerForm onCancel={() => setAnsweringId(null)} onSubmit={(a) => { onAnswer(q, a); setAnsweringId(null); }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RaiseForm({ onSubmit, onCancel }: { onSubmit: (q: { severity: QuestionSeverity; question: string; context: string | null }) => void; onCancel: () => void }) {
  const [severity, setSeverity] = useState<QuestionSeverity>('estimating_escalation');
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!question.trim()) return; onSubmit({ severity, question: question.trim(), context: context.trim() || null }); }} className="space-y-3">
      <Field label="Severity" hint={QUESTION_SEVERITIES.find((s) => s.key === severity)?.hint}>
        <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as QuestionSeverity)}>
          {QUESTION_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="Question" required>
        <textarea className="input" rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} required autoFocus />
      </Field>
      <Field label="Context" hint="What you saw that prompted it">
        <textarea className="input" rows={2} value={context} onChange={(e) => setContext(e.target.value)} />
      </Field>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
        <button type="submit" className="btn-primary text-sm"><Check size={14} /> Raise</button>
      </div>
    </form>
  );
}

function AnswerForm({ onSubmit, onCancel }: {
  onSubmit: (a: { answer: string; resolution: string | null; decision?: { kind: DecisionKind; title: string; rationale: string } }) => void;
  onCancel: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [resolution, setResolution] = useState('');
  const [logDecision, setLogDecision] = useState(true);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!answer.trim()) return;
        if (logDecision && !title.trim()) return;
        onSubmit({
          answer: answer.trim(),
          resolution: resolution.trim() || null,
          decision: logDecision ? { kind: 'escalation_outcome', title: title.trim(), rationale: rationale.trim() || answer.trim() } : undefined,
        });
      }}
      className="space-y-3 bg-surface/40 border border-border rounded-lg p-4"
    >
      <Field label="Answer" hint="Verbatim — what the human said" required>
        <textarea className="input" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} required autoFocus />
      </Field>
      <Field label="Resolution" hint="The resulting direction, in prose (optional)">
        <input className="input" value={resolution} onChange={(e) => setResolution(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={logDecision} onChange={(e) => setLogDecision(e.target.checked)} />
        Also log the resulting decision (marks the question resolved)
      </label>
      {logDecision && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Decision (one line)" required><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
          <Field label="Rationale" hint="Defaults to the answer if blank"><input className="input" value={rationale} onChange={(e) => setRationale(e.target.value)} /></Field>
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
        <button type="submit" className="btn-primary text-sm"><Check size={14} /> Record answer</button>
      </div>
    </form>
  );
}

// ── Labor ─────────────────────────────────────────────────────────────────────
function LaborCard({ room, labor, canEdit, onSave }: {
  room: WikiRoom;
  labor: WikiRoomBundle['labor'];
  canEdit: boolean;
  onSave: (rows: { laborType: LaborType; hours: number; basis: string | null }[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const initialRows = useMemo(() => {
    const by = new Map(labor.map((l) => [l.laborType, l]));
    return LABOR_TYPES.map((t) => ({
      laborType: t.key,
      enabled: by.has(t.key) || REQUIRED_LABOR_TYPES.includes(t.key),
      hours: by.get(t.key)?.hours.toString() ?? '0',
      basis: by.get(t.key)?.basis ?? '',
    }));
  }, [labor]);
  const [rows, setRows] = useState(initialRows);
  const startEditing = () => { setRows(initialRows); setEditing(true); };
  const total = labor.reduce((s, l) => s + l.hours, 0);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-navy m-0">Labor <span className="text-fg-3 font-normal">· {total.toFixed(2)} h</span></h3>
          <div className="text-xs text-fg-3">Zero is a real value — a bucket at 0.00 means "checked, none", absence means "never estimated".</div>
        </div>
        {canEdit && !editing && <button onClick={startEditing} className="btn-secondary text-xs py-1.5 px-3"><Pencil size={12} /> Edit</button>}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(rows.filter((r) => r.enabled).map((r) => ({ laborType: r.laborType, hours: Math.max(0, Number(r.hours) || 0), basis: r.basis.trim() || null })));
            setEditing(false);
          }}
          className="p-4 space-y-2"
        >
          {rows.map((r, i) => (
            <div key={r.laborType} className="grid grid-cols-[auto_1fr_72px_1.4fr] gap-2 items-center">
              <input type="checkbox" checked={r.enabled} onChange={(e) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))} title="Include this bucket" />
              <span className="text-sm text-fg">{labelFor(LABOR_TYPES, r.laborType)}</span>
              <input type="number" min={0} step="0.25" className="input py-1 px-2 text-sm" value={r.hours} disabled={!r.enabled}
                onChange={(e) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, hours: e.target.value } : x))} />
              <input className="input py-1 px-2 text-xs" placeholder="basis" value={r.basis} disabled={!r.enabled}
                onChange={(e) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, basis: e.target.value } : x))} />
            </div>
          ))}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary text-sm"><X size={14} /> Cancel</button>
            <button type="submit" className="btn-primary text-sm"><Check size={14} /> Save labor</button>
          </div>
        </form>
      ) : labor.length === 0 ? (
        <div className="p-5 text-sm text-fg-3 italic">No labor estimated for {roomLabel(room)}.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border-soft">
            {labor.map((l) => (
              <tr key={l.id}>
                <td className="px-5 py-2 text-fg">{labelFor(LABOR_TYPES, l.laborType)}</td>
                <td className="px-3 py-2 text-right font-mono text-fg">{l.hours.toFixed(2)}</td>
                <td className="px-5 py-2 text-xs text-fg-2">{l.basis ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── BoM links ─────────────────────────────────────────────────────────────────
function BomLinksCard({ room, links, bomItems, canEdit, onLink, onUnlink }: {
  room: WikiRoom;
  links: WikiRoomBundle['bomLinks'];
  bomItems: ProjectBoMItem[];
  canEdit: boolean;
  onLink: (ids: string[]) => void;
  onUnlink: (linkId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const linked = useMemo(() => new Set(links.map((l) => l.bomItemId)), [links]);

  // Suggest lines whose D-Tools locations mention this room first.
  const candidates = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const mentions = (it: ProjectBoMItem) =>
      it.locations?.some((l) => (room.dtoolsLocation && l.room === room.dtoolsLocation) || (room.roomNumber && l.room.includes(room.roomNumber))) ?? false;
    return bomItems
      .filter((it) => !linked.has(it.id))
      .filter((it) => !f || `${it.manufacturer} ${it.model} ${it.description}`.toLowerCase().includes(f))
      .sort((a, b) => Number(mentions(b)) - Number(mentions(a)) || a.sortOrder - b.sortOrder)
      .slice(0, 60)
      .map((it) => ({ it, suggested: mentions(it) }));
  }, [bomItems, filter, linked, room.dtoolsLocation, room.roomNumber]);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-navy m-0 inline-flex items-center gap-1.5"><Link2 size={14} /> BoM lines <span className="text-fg-3 font-normal">· {links.length}</span></h3>
        {canEdit && !picking && <button onClick={() => setPicking(true)} className="btn-secondary text-xs py-1.5 px-3"><Plus size={12} /> Link</button>}
      </div>
      {picking && (
        <div className="p-4 border-b border-border-soft bg-surface/40 space-y-2">
          <input className="input py-1.5 text-sm" placeholder="Filter by manufacturer / model…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          <div className="max-h-56 overflow-y-auto divide-y divide-border-soft border border-border rounded-lg bg-white">
            {candidates.length === 0 && <div className="p-3 text-xs text-fg-3">No matching BoM lines.</div>}
            {candidates.map(({ it, suggested }) => (
              <label key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-surface">
                <input type="checkbox" checked={selected.has(it.id)} onChange={(e) => setSelected((prev) => { const n = new Set(prev); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n; })} />
                <span className="font-mono text-fg">{it.qty}×</span>
                <span className="text-fg font-medium">{it.manufacturer} {it.model}</span>
                <span className="text-fg-3 truncate flex-1">{it.description}</span>
                {suggested && <span className="text-[10px] font-bold text-orange uppercase">in room</span>}
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setPicking(false); setSelected(new Set()); }} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
            <button disabled={selected.size === 0} onClick={() => { onLink([...selected]); setPicking(false); setSelected(new Set()); }} className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50">Link {selected.size || ''}</button>
          </div>
        </div>
      )}
      {links.length === 0 ? (
        <div className="p-5 text-sm text-fg-3 italic">No BoM lines linked.</div>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-border-soft">
          {links.map((l) => (
            <li key={l.id} className="px-5 py-2 flex items-center gap-2 text-sm">
              <span className="font-mono text-fg-2 text-xs">{l.qty}×</span>
              <span className="text-fg font-medium">{l.manufacturer} {l.model}</span>
              <span className="text-fg-3 text-xs truncate flex-1">{l.description}</span>
              {canEdit && <button onClick={() => onUnlink(l.id)} className="p-1 rounded hover:bg-red-50 text-fg-3 hover:text-red-600" title="Unlink"><X size={12} /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── File links ────────────────────────────────────────────────────────────────
function FileLinksCard({ room, links, canEdit, onLink, onUnlink }: {
  room: WikiRoom;
  links: WikiRoomBundle['fileLinks'];
  canEdit: boolean;
  onLink: (ids: string[]) => void;
  onUnlink: (linkId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const linked = new Set(links.map((l) => l.fileId));

  useEffect(() => {
    if (!picking || files) return;
    fetchProjectFiles(room.projectId).then(setFiles).catch(() => setFiles([]));
  }, [picking, files, room.projectId]);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-navy m-0 inline-flex items-center gap-1.5"><FileText size={14} /> Files <span className="text-fg-3 font-normal">· {links.length}</span></h3>
        {canEdit && !picking && <button onClick={() => setPicking(true)} className="btn-secondary text-xs py-1.5 px-3"><Plus size={12} /> Link</button>}
      </div>
      {picking && (
        <div className="p-4 border-b border-border-soft bg-surface/40 space-y-2">
          <div className="max-h-56 overflow-y-auto divide-y divide-border-soft border border-border rounded-lg bg-white">
            {!files && <div className="p-3 text-xs text-fg-3 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Loading project files…</div>}
            {files && files.filter((f) => !linked.has(f.id)).length === 0 && <div className="p-3 text-xs text-fg-3">No unlinked project files. Upload drawings on the Overview → Files tab first.</div>}
            {files?.filter((f) => !linked.has(f.id)).map((f) => (
              <label key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-surface">
                <input type="checkbox" checked={selected.has(f.id)} onChange={(e) => setSelected((prev) => { const n = new Set(prev); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} />
                <span className="text-fg font-medium truncate flex-1">{f.filename}</span>
                <span className="text-fg-3">{f.category}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setPicking(false); setSelected(new Set()); }} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
            <button disabled={selected.size === 0} onClick={() => { onLink([...selected]); setPicking(false); setSelected(new Set()); }} className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50">Link {selected.size || ''}</button>
          </div>
        </div>
      )}
      {links.length === 0 ? (
        <div className="p-5 text-sm text-fg-3 italic">No files linked.</div>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-border-soft">
          {links.map((l) => (
            <li key={l.id} className="px-5 py-2 flex items-center gap-2 text-sm">
              <span className="text-fg font-medium truncate flex-1">{l.filename}</span>
              <span className="text-fg-3 text-xs">{l.category}</span>
              {l.sharepointWebUrl && <a href={l.sharepointWebUrl} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-surface text-fg-3" title="Open in SharePoint"><ExternalLink size={12} /></a>}
              {canEdit && <button onClick={() => onUnlink(l.id)} className="p-1 rounded hover:bg-red-50 text-fg-3 hover:text-red-600" title="Unlink"><X size={12} /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
