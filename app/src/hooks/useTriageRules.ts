// Tuning rules for the morning run (My Day 2.2). Read and written straight to
// triage_rules as the signed-in user (owner-only RLS); hit counts come from the
// triage_rules_with_hits view, the preview from the preview_triage_rule() RPC.
// Loaded only when the rules drawer or the rule form opens.
//
// Sample mode keeps the sample rules in local state and previews against the
// sample reviewed log with the twin matcher in components/worklist/rules.ts.

import { useCallback, useState } from 'react';
import { supabase } from '../lib/supabase';
import { SAMPLE_RULES } from '../components/worklist/sampleData';
import { effectChanges, fromDbMatch, ruleMatches, toDbMatch, type DbMatch } from '../components/worklist/rules';
import type { ReviewedRow, RuleEffect, RuleKind, RuleMatch, RuleOrigin, RulePreview, TriageRule } from '../components/worklist/types';
import type { WorklistMode } from './useWorklist';

const RULE_COLS = 'id, kind, match, effect, note, active, created_from, example_id, created_at, hits_30d, last_hit_at';

interface RuleRow {
  id: string;
  kind: RuleKind;
  match: DbMatch | null;
  effect: RuleEffect;
  note: string | null;
  active: boolean;
  created_from: RuleOrigin;
  example_id: string | null;
  created_at: string;
  hits_30d: number;
  last_hit_at: string | null;
}

function toRule(r: RuleRow): TriageRule {
  return {
    id: r.id,
    kind: r.kind,
    match: fromDbMatch(r.match),
    effect: r.effect,
    note: r.note ?? undefined,
    active: r.active,
    createdFrom: r.created_from,
    exampleId: r.example_id ?? undefined,
    createdAt: r.created_at,
    hits30d: r.hits_30d,
    lastHitAt: r.last_hit_at ?? undefined,
  };
}

/** What the rule form saves. */
export interface RuleDraft {
  kind: RuleKind;
  match: RuleMatch | null;
  effect: RuleEffect;
  note: string;
  createdFrom: RuleOrigin;
  exampleId?: string;
}

interface PreviewRpc {
  briefing_date: string | null;
  matched: number;
  would_change: number;
  matched_30d: number;
  rows: { id: string; source: ReviewedRow['source']; title: string; from_label: string | null; outcome: ReviewedRow['outcome']; reason_group: string; changes: boolean }[];
}

function notMigrated(code?: string): boolean {
  return code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205';
}

export interface TriageRules {
  rules: TriageRule[] | null;
  loading: boolean;
  error: string | null;
  load: () => void;
  /** Insert (no id) or update. Resolves to an error message, or null when saved. */
  save: (draft: RuleDraft, id?: string) => Promise<string | null>;
  setActive: (id: string, active: boolean) => void;
  remove: (id: string) => void;
  /** What a draft hard rule would catch in the latest run. */
  preview: (match: RuleMatch, effect: RuleEffect) => Promise<RulePreview | string>;
}

export function useTriageRules(mode: WorklistMode, userId: string | undefined, sampleRows: ReviewedRow[] | null): TriageRules {
  const [rules, setRules] = useState<TriageRule[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (mode === 'sample') {
      setRules((prev) => prev ?? SAMPLE_RULES);
      return;
    }
    if (!userId) return;
    setLoading(true);
    setError(null);
    void supabase
      .from('triage_rules_with_hits')
      .select(RULE_COLS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data, error: e }) => {
        if (e) {
          setError(notMigrated(e.code) ? "Tuning rules aren't set up yet." : `Couldn't load your rules: ${e.message}`);
          setRules([]);
        } else {
          setRules(((data ?? []) as unknown as RuleRow[]).map(toRule));
        }
        setLoading(false);
      });
  }, [mode, userId]);

  const save = useCallback(
    async (draft: RuleDraft, id?: string): Promise<string | null> => {
      const note = draft.note.trim();
      if (mode === 'sample') {
        const now = new Date().toISOString();
        setRules((prev) => {
          const list = prev ?? SAMPLE_RULES;
          if (id) return list.map((r) => (r.id === id ? { ...r, ...draft, note: note || undefined } : r));
          return [{ id: `rule-${Date.now()}`, ...draft, note: note || undefined, active: true, createdAt: now, hits30d: 0 }, ...list];
        });
        return null;
      }
      const row = {
        kind: draft.kind,
        match: draft.match ? toDbMatch(draft.match) : null,
        effect: draft.effect,
        note: note || null,
        ...(id ? {} : { created_from: draft.createdFrom, example_id: draft.exampleId ?? null }),
      };
      const { error: e } = id
        ? await supabase.from('triage_rules').update(row).eq('id', id)
        : await supabase.from('triage_rules').insert(row);
      if (e) return notMigrated(e.code) ? "Tuning rules aren't set up yet." : e.message;
      load();
      return null;
    },
    [mode, load],
  );

  const setActive = useCallback(
    (id: string, active: boolean) => {
      setRules((prev) => prev?.map((r) => (r.id === id ? { ...r, active } : r)) ?? null);
      if (mode === 'sample') return;
      void supabase.from('triage_rules').update({ active }).eq('id', id).then(({ error: e }) => {
        if (e) {
          setError(`That change didn't save: ${e.message}`);
          load();
        }
      });
    },
    [mode, load],
  );

  const remove = useCallback(
    (id: string) => {
      setRules((prev) => prev?.filter((r) => r.id !== id) ?? null);
      if (mode === 'sample') return;
      void supabase.from('triage_rules').delete().eq('id', id).then(({ error: e }) => {
        if (e) {
          setError(`The rule wasn't deleted: ${e.message}`);
          load();
        }
      });
    },
    [mode, load],
  );

  const preview = useCallback(
    async (match: RuleMatch, effect: RuleEffect): Promise<RulePreview | string> => {
      if (mode === 'sample') {
        const hits = (sampleRows ?? []).filter((r) => ruleMatches(match, r));
        const rows = hits
          .map((r) => ({
            id: r.id, source: r.source, title: r.title, from: r.from, outcome: r.outcome,
            reasonGroup: r.reasonGroup, changes: effectChanges(effect, r.outcome),
          }))
          .sort((a, b) => Number(b.changes) - Number(a.changes) || a.title.localeCompare(b.title));
        return {
          briefingDate: 'sample', matched: rows.length, wouldChange: rows.filter((r) => r.changes).length,
          matched30d: rows.length, rows,
        };
      }
      const { data, error: e } = await supabase.rpc('preview_triage_rule', { p_match: toDbMatch(match), p_effect: effect });
      if (e) return notMigrated(e.code) ? "Tuning rules aren't set up yet." : e.message;
      const d = data as PreviewRpc;
      return {
        briefingDate: d.briefing_date,
        matched: d.matched,
        wouldChange: d.would_change,
        matched30d: d.matched_30d,
        rows: d.rows.map((r) => ({
          id: r.id, source: r.source, title: r.title, from: r.from_label ?? '', outcome: r.outcome,
          reasonGroup: r.reason_group, changes: r.changes,
        })),
      };
    },
    [mode, sampleRows],
  );

  return { rules, loading, error, load, save, setActive, remove, preview };
}
