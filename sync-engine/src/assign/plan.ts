/**
 * monday-side rules that run when a Pre-Sales Engineer or a Bid Decision changes
 * (Seth 2026-10-15). Pure — tested by test/assign.test.mts.
 *
 * Triage board (Hope's moves; R4 is Hope dragging Triage → Bid/No-Bid, R6 Bid →
 * New Assignment is a native monday automation):
 *   R5  Bid Decision = No-Bid → Pre-Sales Summary / Declined to Bid, status Declined
 *       to Bid. Never writes Salesforce (decision 12).
 *   R7  Bid Decision = Bid AND an engineer picked (whichever comes second) →
 *       Pre-Sales Summary / New Requests, and the engine assigns that engineer in
 *       the Pre-Sales Engineer people column there. Engineers aren't members of
 *       Triage (so they can't grab work before it's triaged); Hope picks from a
 *       single-select dropdown whose labels map to monday accounts through
 *       map_estimator.triage_label_id (Seth 2026-10-19).
 *
 * Estimator writeback: the first mappable person in the Pre-Sales Engineer column
 * becomes the AV line's OpportunityLineItem.Estimator__c (one user per line).
 *   - Salesforce follows monday while the deal is open: a change overwrites.
 *     Items in Won / Lost / Declined to Bid, No-Bid items and closed
 *     opportunities are left alone.
 *   - If Salesforce's Estimator is already one of the engineers on the item, it
 *     stays (adding a helper never flips it; Seth 2026-10-16).
 *   - Only someone REMOVING the engineer in monday clears Salesforce. A column
 *     that is merely empty (first pass, a Bid Decision change, the retry) means
 *     nobody filled it in, so Salesforce is left alone (Seth 2026-10-16).
 *   - Ignored people (map_estimator.ignore) are skipped; the next person counts.
 *   - A person with no mapping (or no active Salesforce user by that name) stops
 *     the pick — they may be the lead — and raises one grouped task for Hope.
 *   - The first pass (existing values) writes the same way but emails no reps.
 */
import type { EstimatorMapRow } from '../config/load.ts';
import type { SfEstimatorContext, SfUser } from '../salesforce/client.ts';
import type { ColumnWrite, PlannerConfig, TaskIntent } from '../reconcile/types.ts';

export type BidDecision = 'bid' | 'no_bid' | null;

/** What the runner knows about the monday item. */
export interface AssignItem {
  id: string;
  name: string;
  boardKey: string | null; // 'presales' | 'prequal' | 'triage'
  groupId: string | null;
  statusLabelId: number | null;
  /**
   * monday user ids, in column order (= order people were added). On Triage they
   * come from the dropdown pick; a label with no mapping appears as
   * '${TRIAGE_LABEL_PREFIX}<label id>' (see engineerNames).
   */
  engineerUserIds: string[];
  /** Display names for unmapped Triage dropdown labels, by pseudo id. */
  engineerNames?: Record<string, string>;
  bidLabelId: number | null; // triage.bid_decision (Triage board only)
}

export const TRIAGE_LABEL_PREFIX = 'triage-label:';
const isUnmappedLabel = (id: string) => id.startsWith(TRIAGE_LABEL_PREFIX);

export function bidDecisionOf(cfg: PlannerConfig, labelId: number | null): BidDecision {
  if (labelId === null) return null;
  if (cfg.labels['triage.bid_decision.no_bid'] === labelId) return 'no_bid';
  if (cfg.labels['triage.bid_decision.bid'] === labelId) return 'bid';
  return null;
}

// ── Triage moves ─────────────────────────────────────────────────────────────
export interface TriageMove {
  rule: 'R5' | 'R7';
  /** Written on Triage before the move. */
  columnWrites: ColumnWrite[];
  moveTo: { boardKey: 'presales'; groupKey: 'declined_to_bid' | 'new_requests' };
  /** Written on the Pre-Sales Summary after the move (R7: the engineer). */
  afterMoveWrites: ColumnWrite[];
}

export function planTriage(cfg: PlannerConfig, item: AssignItem): TriageMove | null {
  if (item.boardKey !== 'triage') return null;
  const decision = bidDecisionOf(cfg, item.bidLabelId);
  if (decision === 'no_bid') {
    const declined = cfg.labels['presales.status.declined_to_bid'];
    const writes: ColumnWrite[] = declined !== undefined && declined !== null && item.statusLabelId !== declined
      ? [{ semanticKey: 'presales.status', value: { type: 'status', labelId: declined } }]
      : [];
    return { rule: 'R5', columnWrites: writes, moveTo: { boardKey: 'presales', groupKey: 'declined_to_bid' }, afterMoveWrites: [] };
  }
  // An unmapped dropdown pick holds the item on Triage (the runner raises the
  // "map this engineer" task): moving it would land it on Pre-Sales unassigned.
  if (decision === 'bid' && item.engineerUserIds.length > 0 && !item.engineerUserIds.some(isUnmappedLabel)) {
    return {
      rule: 'R7', columnWrites: [], moveTo: { boardKey: 'presales', groupKey: 'new_requests' },
      afterMoveWrites: [{ semanticKey: 'presales.presales_engineer', value: { type: 'people', userIds: item.engineerUserIds } }],
    };
  }
  return null;
}

// ── Estimator ────────────────────────────────────────────────────────────────
export const unmappedEngineerKey = (mondayUserId: string) => `sync_failure:unmapped_engineer:${mondayUserId}:estimator`;
export const UNMAPPED_ENGINEER_PREFIX = 'sync_failure:unmapped_engineer:';

export type EstimatorPick =
  | { kind: 'user'; user: SfUser; mondayUserId: string }
  | { kind: 'clear' } // nobody assigned
  | { kind: 'none' } // only ignored people → leave Salesforce alone
  | { kind: 'blocked'; mondayUserId: string; mondayName: string; why: 'no_mapping' | 'no_sf_user' };

/** `users`: active Salesforce users by exact name (from map_estimator's sf_user_name). */
export function pickEstimator(engineerUserIds: string[], map: Record<string, EstimatorMapRow>, users: Map<string, SfUser[]>): EstimatorPick {
  if (engineerUserIds.length === 0) return { kind: 'clear' };
  for (const id of engineerUserIds) {
    const row = map[id];
    if (row?.ignore) continue;
    if (!row || !row.sfUserName) return { kind: 'blocked', mondayUserId: id, mondayName: row?.mondayName ?? '', why: 'no_mapping' };
    const matches = users.get(row.sfUserName) ?? [];
    if (matches.length !== 1) return { kind: 'blocked', mondayUserId: id, mondayName: row.mondayName, why: 'no_sf_user' };
    return { kind: 'user', user: matches[0], mondayUserId: id };
  }
  return { kind: 'none' };
}

/** Salesforce names to resolve for these engineers (every mapped, non-ignored one). */
export function namesToResolve(engineerUserIds: string[], map: Record<string, EstimatorMapRow>): string[] {
  return engineerUserIds.map((id) => map[id]).filter((r) => r && !r.ignore && r.sfUserName).map((r) => r!.sfUserName!);
}

/** Salesforce user ids of every engineer on the item that resolves to exactly one user. */
export function assignedSfIds(engineerUserIds: string[], map: Record<string, EstimatorMapRow>, users: Map<string, SfUser[]>): string[] {
  return namesToResolve(engineerUserIds, map)
    .map((name) => users.get(name) ?? [])
    .filter((m) => m.length === 1)
    .map((m) => m[0].Id);
}

export interface EstimatorInput {
  item: AssignItem;
  /** Is the item in the Pre-Sales Summary's Won / Lost / Declined to Bid? */
  closedGroup: boolean;
  /** Bid Decision = No-Bid on Triage (the item is leaving for Declined to Bid). */
  noBid: boolean;
  link: { sfLineItemId: string; sfOpportunityId: string; linkState: 'active' | 'archived' | 'conflict' } | null;
  ctx: SfEstimatorContext | null; // null = line item gone / invisible
  pick: EstimatorPick;
  /** Salesforce ids of every engineer on the item (see assignedSfIds). */
  assignedSfIds: string[];
  /** True only when the trigger was someone changing the engineer column itself. */
  allowClear: boolean;
  firstPass: boolean;
  repEmail: boolean; // config: estimator_rep_email
  /** Shown in the task; e.g. "Acme HQ (monday item 123)". */
  itemLabel: string;
  /** Salesforce Lightning base for links in the rep email, e.g. https://instrata.lightning.force.com */
  sfBaseUrl: string;
}

export type EstimatorDecision =
  | {
      kind: 'patch';
      lineItemId: string;
      estimatorId: string | null;
      estimatorName: string | null;
      old: { id: string | null; name: string | null };
      repEmail: { to: string; subject: string; body: string; relatedRecordId: string } | null;
    }
  | { kind: 'task'; task: Extract<TaskIntent, { op: 'open' }> }
  | { kind: 'none'; reason: string };

/** The grouped "map this engineer" task (one per person, items as members). */
export function unmappedEngineerTask(
  item: AssignItem, itemLabel: string, mondayUserId: string, mondayName: string, why: 'no_mapping' | 'no_sf_user',
): Extract<TaskIntent, { op: 'open' }> {
  const who = mondayName || item.engineerNames?.[mondayUserId] || `monday user ${mondayUserId}`;
  const detail = isUnmappedLabel(mondayUserId)
    ? `"${who}" was picked in the Triage board's Pre-Sales Engineer dropdown, but that label isn't linked to a monday account and Salesforce user, so the item stays on Triage.`
    : why === 'no_mapping'
      ? `"${who}" is a Pre-Sales Engineer in monday but has no Salesforce user mapped, so the sync can't set them as Estimator.`
      : `"${who}" is mapped to a Salesforce user name that doesn't match exactly one active Salesforce user.`;
  return {
    op: 'open', taskType: 'sync_failure', dedupeKey: unmappedEngineerKey(mondayUserId),
    title: `Map Pre-Sales Engineer: ${who}`,
    details: `${detail} Map them in Sync Admin → Mappings → Estimators (or mark them "ignore" if they are never an estimator of record). ` +
      'The items below are picked up again within the hour after that.',
    sourceRef: { board_key: item.boardKey ?? 'presales', mapping_table: 'map_estimator' },
    member: { id: item.id, label: itemLabel },
  };
}

export function planEstimator(i: EstimatorInput): EstimatorDecision {
  const { item } = i;
  if (!i.link) return { kind: 'none', reason: 'not linked to Salesforce' };
  if (i.link.linkState !== 'active') return { kind: 'none', reason: `link is ${i.link.linkState}` };
  if (i.closedGroup) return { kind: 'none', reason: 'deal closed in monday (Won / Lost / Declined to Bid)' };
  if (i.noBid) return { kind: 'none', reason: 'No-Bid on Triage' };
  if (!i.ctx) return { kind: 'none', reason: 'AV line item not found in Salesforce' };
  if (i.ctx.opportunityClosed) return { kind: 'none', reason: 'opportunity is closed in Salesforce' };

  if (i.ctx.estimatorId && i.assignedSfIds.includes(i.ctx.estimatorId)) {
    return { kind: 'none', reason: 'Salesforce already has an engineer on the item' };
  }
  const p = i.pick;
  if (p.kind === 'none') return { kind: 'none', reason: 'only ignored people assigned' };
  if (p.kind === 'clear' && !i.allowClear) return { kind: 'none', reason: 'no engineer in monday' };
  if (p.kind === 'blocked') {
    return { kind: 'task', task: unmappedEngineerTask(item, i.itemLabel, p.mondayUserId, p.mondayName, p.why) };
  }

  const want = p.kind === 'user' ? p.user : null;
  if ((want?.Id ?? null) === i.ctx.estimatorId) return { kind: 'none', reason: 'Salesforce already matches' };

  let repEmail: (EstimatorDecision & { kind: 'patch' })['repEmail'] = null;
  const rep = i.ctx.rep;
  if (want && !i.firstPass && i.repEmail && rep?.email && rep.id !== want.Id) {
    const link = `${i.sfBaseUrl.replace(/\/$/, '')}/lightning/r/Opportunity/${i.ctx.opportunityId}/view`;
    repEmail = {
      to: rep.email,
      subject: `Estimator assigned: ${i.ctx.opportunityName}`,
      body: `${want.Name} is estimating ${i.ctx.opportunityName}.\n\nOpportunity: ${link}\n\n` +
        'This message was sent automatically when the Pre-Sales Engineer was assigned in monday.',
      relatedRecordId: i.ctx.opportunityId,
    };
  }
  return {
    kind: 'patch', lineItemId: i.ctx.lineItemId, estimatorId: want?.Id ?? null, estimatorName: want?.Name ?? null,
    old: { id: i.ctx.estimatorId, name: i.ctx.estimatorName }, repEmail,
  };
}
