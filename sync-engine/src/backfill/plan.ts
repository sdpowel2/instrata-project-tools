/**
 * Backfill planner (spec §11 cutover step 2). Pure — tested by test/backfill.test.mts.
 *
 * Links existing pre-sales items to Salesforce by the ID already typed in their
 * "Salesforce ID" column:
 *   00k…  line item id      → link directly (if it exists in Salesforce)
 *   006…  opportunity id    → link to that opportunity's single AV line item
 *   blank                   → left alone (no name matching in v1)
 *   anything else / missing / ambiguous / duplicated → a grouped failure task
 *
 * Each link's baseline is ONLY the opportunity's current stage. Empty field keys
 * mean the first live reconcile writes every non-blank Salesforce value that
 * differs from monday (the "fix stale data" outcome) — except on items in a
 * closed group, and Due Dates on a different day, which it leaves for review
 * (reconcile/plan.ts syncFields, Seth 2026-10-13); the seeded stage stops
 * historical stage actions (archiving old canceled items, @mentions, stage-check
 * tasks for old deals) from replaying.
 */
import type { TaskMember } from '../reconcile/types.ts';

const LINE_ID = /^00k[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;
const OPP_ID = /^006[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;

export interface BackfillItem {
  id: string;
  name: string;
  sfId: string | null; // raw text from the Salesforce ID column
}

export interface SfLineRef {
  id: string;
  opportunityId: string;
  stage: string;
}

export interface BackfillInput {
  items: BackfillItem[];
  /** Line items that exist in Salesforce, by id (both 15- and 18-char keys present). */
  lineItems: Map<string, SfLineRef>;
  /** AV line items per opportunity id, for items that hold an opportunity id. */
  avLinesByOpp: Map<string, SfLineRef[]>;
  /** monday item ids already linked (a re-run never touches them). */
  alreadyLinkedItems: Set<string>;
  /** Line item ids already linked to some item. */
  alreadyLinkedLines: Set<string>;
}

export interface PlannedLink {
  mondayItemId: string;
  sfLineItemId: string;
  sfOpportunityId: string;
  stage: string;
  via: 'line_id' | 'opportunity_id';
}

export type BackfillProblemKind = 'not_found' | 'bad_id' | 'opp_unresolved' | 'duplicate';

export interface BackfillPlan {
  links: PlannedLink[];
  problems: Record<BackfillProblemKind, TaskMember[]>;
  counts: { items: number; blank: number; alreadyLinked: number; linkByLineId: number; linkByOppId: number; problems: number };
}

export const PROBLEM_TEXT: Record<BackfillProblemKind, { title: string; details: string }> = {
  not_found: {
    title: "Backfill: Salesforce ID on the board doesn't exist in Salesforce",
    details: 'These pre-sales items have a Salesforce ID that Salesforce doesn\'t know (deleted record, a typo, or — in the sandbox — a record the partial copy didn\'t include). They were not linked. Fix or clear the ID in monday.',
  },
  bad_id: {
    title: "Backfill: Salesforce ID column isn't a Salesforce ID",
    details: 'These items have something in the Salesforce ID column that isn\'t a line-item (00k…) or opportunity (006…) id. They were not linked. Correct or clear the value in monday.',
  },
  opp_unresolved: {
    title: 'Backfill: opportunity ID with no single AV product',
    details: 'These items hold an opportunity id (006…) instead of a line-item id, and that opportunity has zero or several AV line items, so the sync can\'t tell which one the item mirrors. Put the right AV line-item id (00k…) in the Salesforce ID column.',
  },
  duplicate: {
    title: 'Backfill: same Salesforce ID on more than one item',
    details: 'These items share a Salesforce line item with another item that was linked first. Only one monday item can mirror a line item. Remove the duplicate or fix its ID.',
  },
};

export function backfillTaskKey(kind: BackfillProblemKind): string {
  return `sync_failure:backfill:${kind}`;
}

/** 15- or 18-char id → the 15-char case-sensitive prefix, for matching. */
const key15 = (id: string) => id.slice(0, 15);

export function planBackfill(input: BackfillInput): BackfillPlan {
  const plan: BackfillPlan = {
    links: [],
    problems: { not_found: [], bad_id: [], opp_unresolved: [], duplicate: [] },
    counts: { items: input.items.length, blank: 0, alreadyLinked: 0, linkByLineId: 0, linkByOppId: 0, problems: 0 },
  };
  const claimed = new Set([...input.alreadyLinkedLines].map(key15));
  const lineIndex = new Map([...input.lineItems.values()].map((l) => [key15(l.id), l]));
  const problem = (kind: BackfillProblemKind, item: BackfillItem, sfId: string) => {
    plan.problems[kind].push({ id: item.id, label: `${item.name} (monday item ${item.id}; Salesforce ID "${sfId}")` });
    plan.counts.problems++;
  };

  // Stable order: lowest item id first, so "linked first" is deterministic on re-runs.
  const items = [...input.items].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  for (const item of items) {
    const raw = (item.sfId ?? '').trim();
    if (raw === '') {
      plan.counts.blank++;
      continue;
    }
    if (input.alreadyLinkedItems.has(item.id)) {
      plan.counts.alreadyLinked++;
      continue;
    }

    let line: SfLineRef | undefined;
    let via: PlannedLink['via'];
    if (LINE_ID.test(raw)) {
      line = lineIndex.get(key15(raw));
      via = 'line_id';
      if (!line) {
        problem('not_found', item, raw);
        continue;
      }
    } else if (OPP_ID.test(raw)) {
      via = 'opportunity_id';
      const av = input.avLinesByOpp.get(key15(raw)) ?? [];
      if (av.length !== 1) {
        problem(av.length === 0 && !input.avLinesByOpp.has(key15(raw)) ? 'not_found' : 'opp_unresolved', item, raw);
        continue;
      }
      line = av[0];
    } else {
      problem('bad_id', item, raw);
      continue;
    }

    if (claimed.has(key15(line.id))) {
      problem('duplicate', item, raw);
      continue;
    }
    claimed.add(key15(line.id));
    plan.links.push({ mondayItemId: item.id, sfLineItemId: line.id, sfOpportunityId: line.opportunityId, stage: line.stage, via });
    if (via === 'line_id') plan.counts.linkByLineId++;
    else plan.counts.linkByOppId++;
  }
  return plan;
}

/** Which ids to look up in Salesforce. */
export function idsToFetch(items: BackfillItem[]): { lineIds: string[]; oppIds: string[] } {
  const lineIds = new Set<string>();
  const oppIds = new Set<string>();
  for (const i of items) {
    const raw = (i.sfId ?? '').trim();
    if (LINE_ID.test(raw)) lineIds.add(raw);
    else if (OPP_ID.test(raw)) oppIds.add(raw);
  }
  return { lineIds: [...lineIds], oppIds: [...oppIds] };
}
