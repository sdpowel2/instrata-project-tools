// The project wiki's Notes section (My Day 2.6): a running, dated log of things
// worth knowing about the job. Lines logged in My Day under this project arrive
// overnight; anyone signed in can add one by hand. Notes only ever add to the
// wiki: they never rewrite the summary, rooms or decisions.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ExternalLink, Loader2, Pencil, Trash2, Check, X, Sun } from 'lucide-react';
import {
  fetchProjectNotes, addProjectNote, updateProjectNote, deleteProjectNote, noteMonth, noteDay, type ProjectNote,
} from '../../lib/projectNotes';
import { isSupabaseConfigured } from '../../lib/supabase';

const FIRST = 8;

export function ProjectNotesCard({ projectId, userId, isAdmin }: { projectId: string; userId: string | null; isAdmin: boolean }) {
  const [notes, setNotes] = useState<ProjectNote[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const live = isSupabaseConfigured();

  const load = useCallback(() => {
    fetchProjectNotes(projectId)
      .then((n) => { setNotes(n); setErr(null); })
      .catch((e: unknown) => { setNotes([]); setErr(e instanceof Error ? e.message : String(e)); });
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (all ? notes ?? [] : (notes ?? []).slice(0, FIRST)), [notes, all]);
  const months = useMemo(() => {
    const out: { month: string; notes: ProjectNote[] }[] = [];
    for (const n of shown) {
      const m = noteMonth(n.notedAt);
      if (out.length && out[out.length - 1].month === m) out[out.length - 1].notes.push(n);
      else out.push({ month: m, notes: [n] });
    }
    return out;
  }, [shown]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !live) return;
    setBusy(true);
    try {
      const n = await addProjectNote(projectId, draft);
      setNotes((cur) => [n, ...(cur ?? [])]);
      setDraft('');
      setErr(null);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    const { id, text } = editing;
    try {
      await updateProjectNote(id, text);
      setNotes((cur) => (cur ?? []).map((n) => (n.id === id ? { ...n, text: text.trim() } : n)));
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (n: ProjectNote) => {
    if (!window.confirm('Delete this note? It comes off the project wiki for everyone.')) return;
    try {
      await deleteProjectNote(n.id);
      setNotes((cur) => (cur ?? []).filter((x) => x.id !== n.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-navy m-0">Notes</h3>
          <p className="text-[11px] text-fg-3 m-0 mt-0.5">Dated things worth knowing about this job. Lines logged in My Day land here overnight.</p>
        </div>
        {notes && notes.length > 0 && <span className="text-xs text-fg-3 flex-shrink-0">{notes.length}</span>}
      </div>

      {live && (
        <form onSubmit={add} className="flex items-center gap-2 px-5 py-2.5 border-b border-border-soft">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            placeholder="Add a note for everyone on this project…"
            aria-label="Add a project note"
            className="flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-fg-3"
          />
          <button type="submit" disabled={!draft.trim() || busy} className="text-xs font-medium px-2.5 py-1 rounded-lg bg-navy text-white disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : 'Add'}
          </button>
        </form>
      )}

      {err && <div className="px-5 py-2 text-xs text-red-700">{err}</div>}

      {notes === null ? (
        <div className="px-5 py-4 text-sm text-fg-2 inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : notes.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-3 italic m-0">No notes yet.</p>
      ) : (
        <div className="px-5 py-2">
          {months.map((g) => (
            <div key={g.month} className="py-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-3 mb-1">{g.month}</div>
              <ul className="m-0 p-0 list-none">
                {g.notes.map((n) => {
                  const mine = !!userId && n.notedBy === userId;
                  const isEditing = editing?.id === n.id;
                  return (
                    <li key={n.id} className="group flex gap-3 py-1.5">
                      <span className="w-12 flex-shrink-0 text-xs font-mono text-fg-2 pt-px">{noteDay(n.notedAt)}</span>
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="flex items-start gap-1.5">
                            <textarea
                              value={editing.text}
                              onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                              maxLength={2000}
                              rows={2}
                              className="flex-1 text-sm border border-border rounded-md px-2 py-1 outline-none focus:border-navy"
                              aria-label="Edit note"
                            />
                            <button type="button" onClick={() => void saveEdit()} className="p-1 text-navy hover:bg-surface rounded" aria-label="Save"><Check size={14} /></button>
                            <button type="button" onClick={() => setEditing(null)} className="p-1 text-fg-3 hover:bg-surface rounded" aria-label="Cancel"><X size={14} /></button>
                          </div>
                        ) : (
                          <div className="text-sm text-fg leading-snug">
                            {n.text}
                            {n.link && /^https?:\/\//i.test(n.link) && (
                              <a href={n.link} target="_blank" rel="noreferrer" className="ml-1 inline-flex align-middle text-fg-3 hover:text-navy" aria-label="Open source">
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                        )}
                        <div className="text-[11px] text-fg-3 mt-0.5 flex items-center gap-1.5">
                          <span>{n.notedByName}</span>
                          {n.source === 'my_day' && (
                            <span className="inline-flex items-center gap-0.5" title="Logged in My Day and filed overnight">
                              · <Sun size={10} /> My Day
                            </span>
                          )}
                          {(mine || isAdmin) && !isEditing && live && (
                            <span className="ml-1 inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button type="button" onClick={() => setEditing({ id: n.id, text: n.text })} className="hover:text-navy" aria-label="Edit note"><Pencil size={11} /></button>
                              <button type="button" onClick={() => void remove(n)} className="hover:text-status-danger-fg" aria-label="Delete note"><Trash2 size={11} /></button>
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {notes.length > FIRST && (
            <button type="button" onClick={() => setAll((a) => !a)} className="text-xs font-medium text-navy hover:underline py-1.5">
              {all ? 'Show fewer' : `Show all ${notes.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
