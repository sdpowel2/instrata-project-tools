// The tuning-rule form (My Day 2.2): "More like this" / "Less like this" from
// the reviewed drawer or a task, "New rule" and "Edit" from the rules drawer.
// Pre-filled from the example conversation; Seth trims the match, picks what
// should happen, and (for a hard rule) previews it against the latest run
// before saving. Rules apply from the next run.

import { useEffect, useState, type ReactNode } from 'react';
import { X, Eye, ArrowRight, Mail, MessageSquare, LayoutGrid } from 'lucide-react';
import type { ReviewedRow, RuleEffect, RuleKind, RuleMatch, RulePreview, TriageRule } from './types';
import {
  EFFECT_LABEL, OUTCOME_LABEL, EFFECT_SHORT, matchProblem, pickMatch, seedFromRow, seedFromRule, type Direction,
} from './rules';
import type { RuleDraft } from '../../hooks/useTriageRules';

const SOURCE_ICON = { email: Mail, teams: MessageSquare, monday: LayoutGrid } as const;

export type RuleTarget =
  /** direction null = a new rule from the rules drawer, with no example. */
  | { mode: 'create'; direction: Direction | null; example: ReviewedRow | null; fallbackTitle?: string }
  | { mode: 'edit'; rule: TriageRule; example: ReviewedRow | null };

interface Props {
  target: RuleTarget;
  onClose: () => void;
  onSave: (draft: RuleDraft, id?: string) => Promise<string | null>;
  onPreview: (match: RuleMatch, effect: RuleEffect) => Promise<RulePreview | string>;
}

type Flags = Record<keyof RuleMatch, boolean>;

export function RuleModal({ target, onClose, onSave, onPreview }: Props) {
  const editing = target.mode === 'edit' ? target.rule : null;
  const example = target.example;
  const direction: Direction | null = target.mode === 'create' ? target.direction : null;

  const seed = editing ? seedFromRule(editing) : seedFromRow(example);
  const [fields, setFields] = useState<RuleMatch>(seed.offer);
  const [terms, setTerms] = useState((seed.offer.subjectTerms ?? []).join(', '));
  const [on, setOn] = useState<Flags>(seed.on);
  const [effect, setEffect] = useState<RuleEffect>(editing?.effect ?? (direction === 'less' ? 'suppress' : 'min_task'));
  const [kind, setKind] = useState<RuleKind>(editing?.kind ?? 'hard');
  const [note, setNote] = useState(editing?.note ?? '');
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Capture on window so Escape closes only this form, not the drawer under it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const subjectTerms = terms.split(',').map((t) => t.trim()).filter(Boolean);
  const match = pickMatch({ ...fields, subjectTerms }, on);
  const anyChecked = on.sender || on.domain || on.subjectTerms || on.channel;
  const matchError = matchProblem(match);

  // Any edit makes the last preview stale.
  const touch = () => { setPreview(null); setProblem(null); };
  const setField = (k: keyof RuleMatch, v: string) => { setFields((f) => ({ ...f, [k]: v })); touch(); };
  const toggle = (k: keyof RuleMatch) => { setOn((o) => ({ ...o, [k]: !o[k] })); touch(); };

  const runPreview = async () => {
    if (matchError) { setProblem(matchError); return; }
    setPreviewing(true);
    const r = await onPreview(match, effect);
    setPreviewing(false);
    if (typeof r === 'string') setProblem(r);
    else setPreview(r);
  };

  const save = async () => {
    if (kind === 'hard' && matchError) { setProblem(matchError); return; }
    if (kind === 'lesson' && !note.trim()) { setProblem('A lesson needs a note in your words: that is what the run learns from.'); return; }
    if (kind === 'lesson' && anyChecked && matchError) { setProblem(matchError); return; }
    setSaving(true);
    const err = await onSave(
      {
        kind,
        match: kind === 'lesson' && !anyChecked ? null : match,
        effect,
        note,
        createdFrom: direction === 'more' ? 'surface_more' : direction === 'less' ? 'surface_less' : 'manual',
        exampleId: example?.id,
      },
      editing?.id,
    );
    setSaving(false);
    if (err) setProblem(err);
    else onClose();
  };

  const title = editing
    ? 'Edit rule'
    : direction === 'more'
      ? 'Surface more like this'
      : direction === 'less'
        ? 'Surface less like this'
        : 'New rule';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4" role="dialog" aria-modal="true" aria-label={title}>
      <button className="fixed inset-0 bg-navy/30 cursor-default" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-[580px] bg-white rounded-2xl shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 border-b border-border">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-orange">Tune the morning run</div>
            <div className="text-lg font-bold text-navy mt-0.5">{title}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-surface" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* The example */}
          {example ? (
            <ExampleLine row={example} />
          ) : target.mode === 'create' && target.fallbackTitle ? (
            <div className="text-xs text-fg-3 bg-surface rounded-lg px-3 py-2">
              <span className="font-medium text-fg-2">{target.fallbackTitle}</span>. The run didn't record a sender for this one,
              so match on the subject or fill in a sender.
            </div>
          ) : null}

          {/* Match */}
          <fieldset>
            <legend className="text-xs font-semibold text-fg-2 mb-1.5">
              Match conversations where{' '}
              <span className="font-normal text-fg-3">(everything checked must match)</span>
            </legend>
            <div className="space-y-1.5">
              <FieldRow label="Source" checked={on.source} onToggle={() => toggle('source')}>
                <select
                  value={fields.source ?? 'email'}
                  onChange={(e) => setField('source', e.target.value)}
                  disabled={!on.source}
                  aria-label="Source"
                  className="text-sm border border-border rounded-md px-2 py-1 bg-white disabled:opacity-50"
                >
                  <option value="email">Email</option>
                  <option value="teams">Teams</option>
                  <option value="monday">monday</option>
                </select>
              </FieldRow>
              <FieldRow label="Sender is" checked={on.sender} onToggle={() => toggle('sender')}>
                <TextInput value={fields.sender ?? ''} onChange={(v) => setField('sender', v)} disabled={!on.sender} placeholder="name@company.com" label="Sender address" />
              </FieldRow>
              <FieldRow label="Anyone at" checked={on.domain} onToggle={() => toggle('domain')}>
                <TextInput value={fields.domain ?? ''} onChange={(v) => setField('domain', v)} disabled={!on.domain} placeholder="company.com" label="Sender domain" />
              </FieldRow>
              <FieldRow label="Subject has" checked={on.subjectTerms} onToggle={() => toggle('subjectTerms')}>
                <TextInput value={terms} onChange={(v) => { setTerms(v); touch(); }} disabled={!on.subjectTerms} placeholder="words, separated by commas" label="Subject words" />
              </FieldRow>
              <FieldRow label="Chat / board" checked={on.channel} onToggle={() => toggle('channel')}>
                <TextInput value={fields.channel ?? ''} onChange={(v) => setField('channel', v)} disabled={!on.channel} placeholder="part of the chat or board name" label="Chat or board name" />
              </FieldRow>
            </div>
          </fieldset>

          {/* Effect */}
          <fieldset>
            <legend className="text-xs font-semibold text-fg-2 mb-1.5">Then</legend>
            <div className="flex flex-wrap gap-1.5">
              {(['min_task', 'min_read_me', 'max_read_me', 'suppress'] as RuleEffect[]).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => { setEffect(e); touch(); }}
                  aria-pressed={effect === e}
                  className={[
                    'text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors',
                    effect === e ? 'bg-navy text-white border-navy' : 'border-border text-fg-2 hover:bg-surface',
                  ].join(' ')}
                >
                  {EFFECT_LABEL[e]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Kind */}
          <fieldset>
            <legend className="text-xs font-semibold text-fg-2 mb-1.5">Rule type</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <KindOption
                selected={kind === 'hard'}
                onSelect={() => { setKind('hard'); touch(); }}
                title="Hard rule"
                body="Applied in code before Claude decides. Same result every run."
              />
              <KindOption
                selected={kind === 'lesson'}
                onSelect={() => { setKind('lesson'); touch(); }}
                title="Lesson"
                body="A judgment call. Claude reads it, with this example, before it classifies."
              />
            </div>
          </fieldset>

          <label className="block">
            <span className="text-xs font-semibold text-fg-2">
              Note {kind === 'lesson' ? <span className="text-orange">(required)</span> : <span className="font-normal text-fg-3">(optional)</span>}
            </span>
            <textarea
              value={note}
              onChange={(e) => { setNote(e.target.value); setProblem(null); }}
              maxLength={500}
              rows={2}
              placeholder={kind === 'lesson' ? 'In your words, e.g. "Schedule changes from a GC matter even when sent FYI"' : 'Why, so future you remembers'}
              className="mt-1 w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-navy resize-y"
            />
          </label>

          {/* Preview */}
          {kind === 'hard' && (
            <div className="border border-border rounded-xl">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="text-xs text-fg-2">
                  {preview ? (
                    <PreviewSummary preview={preview} effect={effect} />
                  ) : (
                    'See what this rule would catch in the latest run.'
                  )}
                </div>
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={previewing || !anyChecked}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border border-border text-navy hover:bg-surface disabled:opacity-40 flex-shrink-0"
                >
                  <Eye size={13} /> {previewing ? 'Checking…' : preview ? 'Refresh' : 'Preview'}
                </button>
              </div>
              {preview && preview.rows.length > 0 && (
                <ul className="m-0 p-0 list-none border-t border-border-soft max-h-48 overflow-y-auto">
                  {preview.rows.map((r) => {
                    const Icon = SOURCE_ICON[r.source];
                    return (
                      <li key={r.id} className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-border-soft last:border-b-0">
                        <Icon size={12} className="text-fg-3 flex-shrink-0" />
                        <span className="flex-1 min-w-0 truncate text-fg">{r.title}</span>
                        <span className={`flex items-center gap-1 flex-shrink-0 ${r.changes ? 'text-navy font-semibold' : 'text-fg-3'}`}>
                          {OUTCOME_LABEL[r.outcome]}
                          {r.changes && <><ArrowRight size={11} /> {EFFECT_SHORT[effect]}</>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {problem && <div className="text-sm text-status-danger-fg bg-status-danger-bg rounded-lg px-3 py-2">{problem}</div>}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-border bg-surface/50 rounded-b-2xl">
          <span className="text-xs text-fg-3">Applies from the next run.</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm font-medium px-3 py-1.5 rounded-lg text-fg-2 hover:bg-surface">Cancel</button>
            <button
              onClick={save}
              disabled={saving}
              className="text-sm font-medium px-4 py-1.5 rounded-lg bg-navy text-white hover:bg-navy/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Save rule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExampleLine({ row }: { row: ReviewedRow }) {
  const Icon = SOURCE_ICON[row.source];
  return (
    <div className="flex items-start gap-2.5 bg-surface rounded-lg px-3 py-2">
      <Icon size={14} className="text-fg-3 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg leading-snug">{row.title}</div>
        <div className="text-xs text-fg-3 mt-0.5">
          {row.from && <>{row.from} · </>}landed in <span className="font-medium text-fg-2">{OUTCOME_LABEL[row.outcome]}</span> ({row.reasonGroup})
        </div>
      </div>
    </div>
  );
}

function PreviewSummary({ preview, effect }: { preview: RulePreview; effect: RuleEffect }) {
  if (preview.matched === 0) {
    return (
      <span>
        Matches nothing in the latest run
        {preview.matched30d > 0 ? `, but ${preview.matched30d} conversation${preview.matched30d === 1 ? '' : 's'} in the last 30 days.` : ' or the last 30 days.'}
      </span>
    );
  }
  return (
    <span>
      Matches <b className="text-navy">{preview.matched}</b> in the latest run;{' '}
      <b className="text-navy">{preview.wouldChange}</b> would move to “{EFFECT_SHORT[effect]}”.
      {preview.matched30d > preview.matched && <span className="text-fg-3"> {preview.matched30d} in the last 30 days.</span>}
    </span>
  );
}

function FieldRow({ label, checked, onToggle, children }: { label: string; checked: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <label className="flex items-center gap-2 w-[118px] flex-shrink-0 text-sm text-fg-2 cursor-pointer">
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-navy" />
        {label}
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, disabled, placeholder, label }: { value: string; onChange: (v: string) => void; disabled: boolean; placeholder: string; label: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      className="w-full text-sm border border-border rounded-md px-2 py-1 outline-none focus:border-navy disabled:opacity-50 disabled:bg-surface"
    />
  );
}

function KindOption({ selected, onSelect, title, body }: { selected: boolean; onSelect: () => void; title: string; body: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        'text-left rounded-xl border px-3 py-2 transition-colors',
        selected ? 'border-navy bg-navy/5' : 'border-border hover:bg-surface',
      ].join(' ')}
    >
      <div className={`text-sm font-semibold ${selected ? 'text-navy' : 'text-fg'}`}>{title}</div>
      <div className="text-xs text-fg-3 mt-0.5 leading-snug">{body}</div>
    </button>
  );
}
