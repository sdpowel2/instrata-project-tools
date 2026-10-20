/**
 * The reconcile planner — every decision in spec §4 (create eligibility, field
 * sync, stage actions, failure tasks) as one pure function.
 *
 *   planReconcile(input) → ReconcilePlan
 *
 * Guarantees (asserted by scripts/verify-sync-reconcile.mts):
 *   - Idempotent: applying a plan and planning again yields no effects.
 *   - The comparison baseline is the last value the SYNC wrote (link.baseline),
 *     never the current monday value, so hand edits in monday aren't fought (§4.5).
 *   - A blank Salesforce value never clears monday (§4.4).
 *   - An unmappable value never writes; it raises one failure task and the field
 *     is retried on every later reconcile until the mapping exists (§1, §4.4).
 *   - Stage actions run only when StageName changes, or on create (§4.6).
 *   - Status + Win/Loss Notes land in one mutation (ItemPlan.columnWrites) (§4.6).
 *
 * The executor owns everything stateful: performing writes through the
 * writeGate, persisting ItemPlan.baseline (to dry_run_synced_values in dry run),
 * resolving CREATED_ITEM, and turning task intents into open/reopen/close.
 *
 * NOTE for the executor: a mapping fix doesn't change the opportunity, so the
 * watermark sweep won't revisit it. When a map_* row changes, re-reconcile the
 * opportunities on open `sync_failure:unmapped_value:*` tasks for that field.
 */
import { wonTaskIntents } from '../queue/won.ts';
import {
  CREATED_ITEM,
  type Baseline,
  type ColumnWrite,
  type CreatePlan,
  type EventIntent,
  type ItemPlan,
  type MondayItemSnapshot,
  type MondayValue,
  type PlannerConfig,
  type PlannerMaps,
  type ReconcileInput,
  type ReconcilePlan,
  type SfOpportunity,
  type StageActionRow,
  type TaskIntent,
} from './types.ts';
import {
  SF_FIELD_KEYS,
  STAGE_KEY,
  buildWinLossNotes,
  extractSfFields,
  isAvLineItem,
  missKey,
  type SfFieldKey,
} from './normalize.ts';
import { etDate, mondayValueMatches, readEtDate } from '../monday/encode.ts';

const FIELD_META: Record<SfFieldKey, { label: string; mondayColumn: string; map?: keyof Omit<PlannerMaps, 'stageAction'>; table?: string }> = {
  'presales.due_date': { label: 'Due Date', mondayColumn: 'Due Date' },
  'presales.quote_number': { label: 'Quote Number', mondayColumn: 'Quote Number' },
  'presales.win_pct': { label: 'Win %', mondayColumn: 'Win Percentage', map: 'winPct', table: 'map_win_pct' },
  'presales.business_unit': { label: 'Business Unit', mondayColumn: 'Business Unit', map: 'businessUnit', table: 'map_business_unit' },
  'presales.sales_person': { label: 'Sales Rep', mondayColumn: 'Sales Person', map: 'salesRep', table: 'map_sales_rep' },
};

/** Stage actions that end the opportunity — a Win % of 100 is ignored while in one. */
const TERMINAL_ACTIONS = new Set(['lost', 'declined', 'canceled']);

const CANCELED_UPDATE_BODY = 'This opportunity was canceled in Salesforce. Please stop work.';

// ── Plan-building context ───────────────────────────────────────────────────
interface Ctx {
  opp: SfOpportunity;
  config: PlannerConfig;
  maps: PlannerMaps;
  tasks: TaskIntent[];
  events: EventIntent[];
}

type Writability = 'ok' | 'blocked' | 'unconfigured';

function writability(config: PlannerConfig, key: string): Writability {
  if (config.blockedColumns.includes(key)) return 'blocked';
  return config.columns[key]?.columnId ? 'ok' : 'unconfigured';
}

// ── Boards (intake mode, Seth + Lee 2026-10-14) ──────────────────────────────
// Pre-Qualification and Triage are duplicates of the Pre-Sales board (same
// column and label ids) but REUSE its group ids with different meanings, so a
// group check must always match the board too.
const boardOf = (item: MondayItemSnapshot): string => item.boardKey ?? 'presales';
const isIntakeBoard = (item: MondayItemSnapshot): boolean => ['prequal', 'triage'].includes(boardOf(item));
const BOARD_TITLE: Record<string, string> = { presales: 'Pre-Sales Summary', prequal: 'Pre-Qualification', triage: 'Triage' };

/** Is the item in group '<board>.<group>'? */
function inGroup(config: PlannerConfig, item: MondayItemSnapshot, key: string): boolean {
  const id = config.groups[key];
  return !!id && boardOf(item) === key.split('.')[0] && item.groupId === id;
}

/** Pre-Qualification has one group per stage: 'Lead' → lead, 'Qualified Opportunity' → qualified_opportunity. */
function prequalGroupKey(stage: string): string {
  return stage.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** Where a new item for an opportunity at this stage is created; null = not at a creation stage. */
export function createTargetFor(config: PlannerConfig, stage: string): { boardKey: string; groupKey: string } | null {
  if (config.intake) {
    if (config.prequalStages.includes(stage)) return { boardKey: 'prequal', groupKey: prequalGroupKey(stage) };
    if (config.creationStages.includes(stage)) return { boardKey: 'triage', groupKey: 'triage' };
    return null;
  }
  return config.creationStages.includes(stage) ? { boardKey: 'presales', groupKey: 'new_requests' } : null;
}

function sfEvent(ctx: Ctx, e: Omit<EventIntent, 'source' | 'entityType' | 'entityId' | 'actor'>): EventIntent {
  return {
    source: 'salesforce',
    entityType: 'opportunity',
    entityId: ctx.opp.Id,
    actor: ctx.opp.LastModifiedById ?? undefined,
    ...e,
  };
}

function engineEvent(itemRef: string, e: Omit<EventIntent, 'source' | 'entityType' | 'entityId' | 'actor'>): EventIntent {
  return { source: 'engine', entityType: 'monday_item', entityId: itemRef, actor: 'engine', ...e };
}

function failureKey(kind: string, entityId: string, field: string): string {
  return `sync_failure:${kind}:${entityId}:${field}`;
}

function openFailure(
  ctx: Ctx,
  kind: string,
  entityId: string,
  field: string,
  title: string,
  details: string,
  extra: { mondayItemId?: string; mappingTable?: string } = {},
): void {
  const dedupeKey = failureKey(kind, entityId, field);
  ctx.tasks.push({
    op: 'open',
    taskType: 'sync_failure',
    dedupeKey,
    title,
    details,
    sourceRef: {
      board_key: 'presales',
      sf_opportunity_id: ctx.opp.Id,
      ...(extra.mondayItemId ? { monday_item_id: extra.mondayItemId } : {}),
      ...(extra.mappingTable ? { mapping_table: extra.mappingTable } : {}),
    },
  });
  ctx.events.push(sfEvent(ctx, { eventType: 'sync_failure', field, applied: false, details: { kind, dedupe_key: dedupeKey, message: details } }));
}

function closeTask(ctx: Ctx, dedupeKey: string): void {
  ctx.tasks.push({ op: 'close', dedupeKey });
}

function openConfigMissing(ctx: Ctx, key: string, itemRef: string): void {
  openFailure(
    ctx, 'config_missing', 'presales', key,
    `Config missing: ${key}`,
    `The sync needs "${key}" but it has no monday id configured. Add it in Sync Admin → Field Registry / Labels.`,
    { mondayItemId: itemRef === CREATED_ITEM ? undefined : itemRef },
  );
}

/** SF value → monday value. null = unmappable. Shared with the diff report. */
export function mapSfValue(maps: PlannerMaps, key: SfFieldKey, sfValue: string): MondayValue | null {
  const meta = FIELD_META[key];
  if (key === 'presales.due_date') return { type: 'datetime', iso: sfValue };
  if (!meta.map) return { type: 'text', text: sfValue };
  const id = maps[meta.map][sfValue];
  return id === undefined || id === null ? null : { type: 'dropdown', labelIds: [id] };
}

function toMondayValue(ctx: Ctx, key: SfFieldKey, sfValue: string): MondayValue | null {
  return mapSfValue(ctx.maps, key, sfValue);
}

/** Human field names (shared with the diff report). */
export function fieldLabel(key: SfFieldKey): string {
  return FIELD_META[key].mondayColumn;
}

// ── Field sync (§4.4) ───────────────────────────────────────────────────────
/** Groups that hold finished deals. The first pass over a linked item there writes nothing. */
const CLOSED_GROUP_KEYS = ['presales.won', 'presales.lost', 'presales.declined_to_bid'];

export function isClosedGroup(config: PlannerConfig, boardKey: string, groupId: string | null): boolean {
  return boardKey === 'presales' && groupId !== null && CLOSED_GROUP_KEYS.some((k) => config.groups[k] === groupId);
}

/**
 * Mutates `baseline` and `writes`. Returns true when Win % became a confirmed-to-win value (→ Won).
 *
 * `firstLink`: a linked item's first reconcile (field keys absent from the
 * baseline — how the backfill seeds links). On that first look (Seth 2026-10-13):
 *   - an item in a closed group (Won / Lost / Declined to Bid) gets no writes;
 *   - a Due Date whose DAY differs from Salesforce keeps monday's date and joins
 *     a grouped review task (monday is often a week later; people move it there).
 * Either way the baseline records the Salesforce value, so later Salesforce
 * changes sync normally.
 */
function syncFields(
  ctx: Ctx,
  baseline: Baseline,
  writes: ColumnWrite[],
  itemRef: string,
  current: Record<string, string | null> | undefined,
  opts: { firstLink: boolean; closedGroup: boolean },
): { wonTriggered: boolean; wonReview: boolean } {
  const sf = extractSfFields(ctx.opp);
  let wonTriggered = false;
  let wonReview = false;
  let wroteDueDate = false;

  for (const key of SF_FIELD_KEYS) {
    const cur = sf[key];
    const has = Object.prototype.hasOwnProperty.call(baseline, key);
    const last = has ? baseline[key] : undefined;
    const prevMiss = baseline[missKey(key)];

    /** This opportunity no longer waits on the value it last failed to map. */
    const resolveMiss = () => {
      if (prevMiss !== undefined && prevMiss !== null) {
        ctx.tasks.push({ op: 'close', dedupeKey: unmappedValueKey(key, prevMiss), memberId: ctx.opp.Id });
      }
      delete baseline[missKey(key)];
    };

    if (has && cur === last) {
      resolveMiss();
      continue;
    }

    // Blank never clears a populated monday value. Record it once, then move the
    // baseline so the same blank isn't re-logged on every reconcile.
    if (cur === null) {
      if (has) ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last, newValue: null, applied: false }));
      baseline[key] = null;
      resolveMiss();
      continue;
    }

    // Confirmed-to-win percentages (99% and 100% at Instrata) aren't labels —
    // they're the status action Won (§3.2, §4.6).
    const confirmed = ctx.config.confirmedWinPcts;
    if (key === 'presales.win_pct' && confirmed.includes(cur)) {
      if (!has && opts.firstLink) {
        // First look at a freshly linked (backfilled) item: Salesforce may have
        // been at 99/100% for months. Don't fire Won (post-sales copy + leadership
        // email) on history — ask a human instead (Seth 2026-10-12).
        wonReview = true;
      } else if (last === undefined || last === null || !confirmed.includes(last)) {
        wonTriggered = true;
        ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last ?? null, newValue: cur, details: { applied_as: 'status_won' } }));
      }
      baseline[key] = cur;
      resolveMiss();
      continue;
    }

    // First look at a finished deal: record Salesforce's value, write nothing.
    if (!has && opts.firstLink && opts.closedGroup) {
      baseline[key] = cur;
      continue;
    }

    const w = writability(ctx.config, key);
    if (w === 'blocked') continue; // config drift: the drift check owns the task; retry later
    if (w === 'unconfigured') {
      openConfigMissing(ctx, key, itemRef);
      continue;
    }

    const value = toMondayValue(ctx, key, cur);
    if (!value) {
      // Leave the field (and its baseline) untouched so it's retried. Join the
      // ONE task for this missing value (grouped across opportunities); leave
      // the task for a value it previously missed on, if that changed.
      if (prevMiss !== cur) {
        if (prevMiss !== undefined && prevMiss !== null) {
          ctx.tasks.push({ op: 'close', dedupeKey: unmappedValueKey(key, prevMiss), memberId: ctx.opp.Id });
        }
        openUnmapped(ctx, key, cur, itemRef);
        baseline[missKey(key)] = cur;
      }
      continue;
    }

    // monday already shows this value (typed by hand, or by the old Zap): record
    // it as synced without a write — no API call, no activity-log noise.
    if (current && Object.prototype.hasOwnProperty.call(current, key) && mondayValueMatches(value, current[key])) {
      baseline[key] = cur;
      resolveMiss();
      continue;
    }

    // First look, Due Date on a different day: keep monday's, ask Hope.
    if (key === 'presales.due_date' && !has && opts.firstLink) {
      const mondayDay = readEtDate(current?.[key]);
      if (mondayDay !== null && mondayDay !== etDate(cur)) {
        openDueDateReview(ctx, itemRef, mondayDay, cur);
        baseline[key] = cur;
        baseline[DUE_REVIEW_MARK] = '1';
        continue;
      }
    }

    writes.push({ semanticKey: key, value });
    ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last ?? null, newValue: cur, details: { monday_item_id: itemRef } }));
    baseline[key] = cur;
    if (key === 'presales.due_date') wroteDueDate = true;
    resolveMiss();
  }

  // The item leaves the Due Date review once the dates agree: Salesforce's
  // date was written, or someone made monday match.
  if (baseline[DUE_REVIEW_MARK]) {
    const sfDue = sf['presales.due_date'];
    const mondayDay = readEtDate(current?.['presales.due_date']);
    if (wroteDueDate || (sfDue !== null && mondayDay !== null && mondayDay === etDate(sfDue))) {
      ctx.tasks.push({ op: 'close', dedupeKey: DUE_REVIEW_KEY, memberId: ctx.opp.Id });
      delete baseline[DUE_REVIEW_MARK];
    }
  }

  return { wonTriggered, wonReview };
}

// ── First-pass Due Date review (Seth 2026-10-13) ────────────────────────────
const DUE_REVIEW_MARK = 'review:due_date';
export const DUE_REVIEW_KEY = 'sync_failure:due_date_differs:presales:presales.due_date';

function openDueDateReview(ctx: Ctx, itemRef: string, mondayDay: string, sfIso: string): void {
  ctx.tasks.push({
    op: 'open',
    taskType: 'sync_failure',
    dedupeKey: DUE_REVIEW_KEY,
    title: 'Due Date differs from Salesforce',
    details:
      'When these items were first linked, monday\'s Due Date was a different day from the Salesforce Estimate Due Date. ' +
      'The sync kept the monday date. Check each one and fix whichever side is wrong; if Salesforce is right, update its date ' +
      'and the sync writes it to monday. An item drops off this list once the two dates agree.',
    sourceRef: { board_key: 'presales' },
    member: { id: ctx.opp.Id, label: `${ctx.opp.Name}: monday ${mondayDay}, Salesforce ${etDate(sfIso)} (Salesforce ${ctx.opp.Id}; monday item ${itemRef})` },
  });
  ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: 'presales.due_date', oldValue: null, newValue: sfIso, applied: false, details: { reason: 'first_link_date_differs', monday_date: mondayDay, monday_item_id: itemRef } }));
}

/** One task per (field, missing value) — not per opportunity (Seth 2026-10-12). */
export function unmappedValueKey(field: string, value: string): string {
  return `sync_failure:unmapped_value:${field}:${value}`;
}

function openUnmapped(ctx: Ctx, key: SfFieldKey, value: string, itemRef: string): void {
  const meta = FIELD_META[key];
  const dedupeKey = unmappedValueKey(key, value);
  const where = `monday item ${itemRef}`; // the executor rewrites a CREATED_ITEM ref
  ctx.tasks.push({
    op: 'open',
    taskType: 'sync_failure',
    dedupeKey,
    title: `Unmapped ${meta.label}: ${value}`,
    details:
      `Salesforce ${meta.label} "${value}" has no matching monday "${meta.mondayColumn}" label, so that field was left unchanged. ` +
      `Add the label in monday if it's missing, then map "${value}" to it in Sync Admin → Mappings (${meta.table}). ` +
      `The affected opportunities re-sync on their own within the hour.`,
    sourceRef: { board_key: 'presales', mapping_table: meta.table },
    member: { id: ctx.opp.Id, label: `${ctx.opp.Name} (Salesforce ${ctx.opp.Id}; ${where})` },
  });
  ctx.events.push(sfEvent(ctx, { eventType: 'sync_failure', field: key, applied: false, details: { kind: 'unmapped_value', dedupe_key: dedupeKey, value } }));
}

// ── Stage actions (§4.6) ────────────────────────────────────────────────────
interface ItemEffects {
  writes: ColumnWrite[];
  moveTo?: { boardKey: string; groupKey: string };
  postUpdate?: { mentionUserIds: string[]; body: string };
  archive?: boolean;
  newLinkState?: 'archived';
}

/** Returns 'written' | 'already' | 'skipped'. */
function setStatus(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects, labelKey: string): 'written' | 'already' | 'skipped' {
  const key = 'presales.status';
  const w = writability(ctx.config, key);
  if (w === 'blocked') return 'skipped';
  const labelId = ctx.config.labels[`${key}.${labelKey}`];
  if (w === 'unconfigured' || labelId === undefined || labelId === null) {
    openConfigMissing(ctx, `${key}.${labelKey}`, item.id);
    return 'skipped';
  }
  if (item.statusLabelId === labelId) return 'already';
  fx.writes = fx.writes.filter((x) => x.semanticKey !== key);
  fx.writes.push({ semanticKey: key, value: { type: 'status', labelId } });
  ctx.events.push(engineEvent(item.id, { eventType: 'status_changed', field: key, oldValue: item.statusLabelId, newValue: labelId, details: { label_key: labelKey, sf_stage: ctx.opp.StageName } }));
  return 'written';
}

function writeNotes(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects, text: string): void {
  if (text === '') return;
  const key = 'presales.win_loss_notes';
  const w = writability(ctx.config, key);
  if (w === 'blocked') return;
  if (w === 'unconfigured') {
    openConfigMissing(ctx, key, item.id);
    return;
  }
  fx.writes.push({ semanticKey: key, value: { type: 'long_text', text } });
}

/** Plan a move (after this pass's column writes). Unconfigured group → config task, no move. */
function moveItem(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects, boardKey: string, groupKey: string): void {
  const key = `${boardKey}.${groupKey}`;
  if (!ctx.config.groups[key]) {
    openConfigMissing(ctx, `group ${key}`, item.id);
    return;
  }
  fx.moveTo = { boardKey, groupKey };
  ctx.events.push(engineEvent(item.id, {
    eventType: 'group_moved', oldValue: boardOf(item), newValue: key,
    details: { from_board: boardOf(item), from_group: item.groupId, to_board: boardKey, to_group: groupKey, sf_stage: ctx.opp.StageName },
  }));
}

/**
 * Stage-driven moves on the intake boards, run when StageName changes:
 *   R3   Pre-Qualification → Triage / Triage when the stage reaches Engineering or later
 *   EC1  Triage → Pre-Qualification when the stage goes back to Lead / Qualified Opportunity
 *        (wherever on Triage the item is)
 *   and Lead ↔ Qualified Opportunity between Pre-Qualification's two groups.
 */
function intakeMove(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects): void {
  const stage = ctx.opp.StageName;
  const board = boardOf(item);
  if (board === 'prequal') {
    if (ctx.config.creationStages.includes(stage)) {
      moveItem(ctx, item, fx, 'triage', 'triage');
    } else if (ctx.config.prequalStages.includes(stage) && !inGroup(ctx.config, item, `prequal.${prequalGroupKey(stage)}`)) {
      moveItem(ctx, item, fx, 'prequal', prequalGroupKey(stage));
    }
  } else if (board === 'triage' && ctx.config.prequalStages.includes(stage)) {
    moveItem(ctx, item, fx, 'prequal', prequalGroupKey(stage));
  }
}

/**
 * Won (Closed Won or Confirmed to Win) while the item is still on Pre-Qualification
 * or Triage. Not decided whether that should skip straight to the Pre-Sales
 * board's Won (which fires the Post-Sales copy + leadership email), so ask Hope.
 */
function wonOnIntake(ctx: Ctx, item: MondayItemSnapshot): void {
  const where = BOARD_TITLE[boardOf(item)];
  ctx.tasks.push({
    op: 'open', taskType: 'sync_failure', dedupeKey: failureKey('won_on_intake', item.id, 'status'),
    title: `Won in Salesforce, still on ${where}: ${ctx.opp.Name}`,
    details:
      `Salesforce says "${ctx.opp.Name}" is won (stage ${ctx.opp.StageName}), but its item is still on the ${where} board. ` +
      'The sync did not move it or set Won. If the deal is won, move the item to the Pre-Sales Summary and set its status to Won there ' +
      '(that triggers the Post-Sales copy and the leadership notification).',
    sourceRef: { board_key: boardOf(item), monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id },
  });
}

/** Salesforce says Won now: a 'won' stage (Closed Won) or a confirmed-to-win Win %. */
function sfSaysWon(ctx: Ctx): boolean {
  if (ctx.maps.stageAction[ctx.opp.StageName]?.action === 'won') return true;
  const pct = extractSfFields(ctx.opp)['presales.win_pct'];
  return pct !== null && ctx.config.confirmedWinPcts.includes(pct);
}

function applyWon(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects): void {
  if (isIntakeBoard(item)) {
    wonOnIntake(ctx, item);
    return;
  }
  // Won-triggered tasks fire only when the ENGINE moves the status. If a human
  // already set Won, the monday status webhook raised them (and re-raising here
  // would reopen tasks Hope already closed).
  if (setStatus(ctx, item, fx, 'won') !== 'written') return;
  ctx.tasks.push(...wonTaskIntents(item.id, ctx.opp.Name, { board_key: 'presales', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id }));
}

/**
 * Stage actions while the item is on Pre-Qualification or Triage. A finished deal
 * moves to the Pre-Sales Summary's Lost / Declined to Bid group with its status and
 * notes (Seth 2026-10-14); the stage checks don't apply on Hope's boards.
 */
function applyIntakeStageAction(ctx: Ctx, row: StageActionRow, item: MondayItemSnapshot, fx: ItemEffects): void {
  switch (row.action) {
    case 'set_status':
      if (row.params.label_key) setStatus(ctx, item, fx, row.params.label_key);
      return;
    case 'won':
      wonOnIntake(ctx, item);
      return;
    case 'lost':
    case 'canceled': {
      const notes = buildWinLossNotes(ctx.opp);
      writeNotes(ctx, item, fx, row.action === 'canceled' ? (notes ? `CANCELED — ${notes}` : 'CANCELED') : notes);
      setStatus(ctx, item, fx, 'lost');
      moveItem(ctx, item, fx, 'presales', 'lost');
      return;
    }
    case 'declined':
      writeNotes(ctx, item, fx, buildWinLossNotes(ctx.opp));
      setStatus(ctx, item, fx, 'declined_to_bid');
      moveItem(ctx, item, fx, 'presales', 'declined_to_bid');
      return;
    default:
      return; // none, stage_check_delivered, stage_check_contract
  }
}

function applyStageAction(ctx: Ctx, row: StageActionRow, item: MondayItemSnapshot, fx: ItemEffects): void {
  if (isIntakeBoard(item)) {
    applyIntakeStageAction(ctx, row, item, fx);
    return;
  }
  const ref = { board_key: 'presales', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id };
  switch (row.action) {
    case 'none':
      return;

    case 'set_status':
      if (row.params.label_key) setStatus(ctx, item, fx, row.params.label_key);
      return;

    case 'stage_check_delivered':
      if (!inGroup(ctx.config, item, 'presales.follow_up')) {
        ctx.tasks.push({
          op: 'open', taskType: 'stage_check_delivered', dedupeKey: `stage_check_delivered:${item.id}`,
          title: `Delivered, not in Follow Up: ${ctx.opp.Name}`,
          details: 'Salesforce says Delivered to Customer, but the pre-sales item is not in the Follow Up group.',
          sourceRef: ref,
        });
      }
      return;

    case 'stage_check_contract':
      if (item.statusLabelId !== ctx.config.labels['presales.status.won']) {
        ctx.tasks.push({
          op: 'open', taskType: 'stage_check_contract', dedupeKey: `stage_check_contract:${item.id}`,
          title: `Contract In House, not Won: ${ctx.opp.Name}`,
          details: 'Salesforce says Contract In House, but the pre-sales status is not Won — possible automation misfire.',
          sourceRef: ref,
        });
      }
      return;

    case 'won':
      applyWon(ctx, item, fx);
      return;

    case 'lost':
      writeNotes(ctx, item, fx, buildWinLossNotes(ctx.opp));
      setStatus(ctx, item, fx, 'lost');
      return;

    case 'declined':
      writeNotes(ctx, item, fx, buildWinLossNotes(ctx.opp));
      setStatus(ctx, item, fx, 'declined_to_bid');
      return;

    case 'canceled': {
      if (item.quotedPrice !== null) {
        const notes = buildWinLossNotes(ctx.opp);
        writeNotes(ctx, item, fx, notes ? `CANCELED — ${notes}` : 'CANCELED');
        setStatus(ctx, item, fx, 'lost');
        return;
      }
      if (item.engineerUserIds.length > 0) {
        fx.postUpdate = { mentionUserIds: item.engineerUserIds, body: CANCELED_UPDATE_BODY };
        ctx.events.push(engineEvent(item.id, { eventType: 'notified', details: { mention_user_ids: item.engineerUserIds, body: CANCELED_UPDATE_BODY } }));
      }
      fx.archive = true;
      fx.newLinkState = 'archived';
      ctx.events.push(engineEvent(item.id, { eventType: 'archived', details: { reason: 'canceled_unpriced', sf_opportunity_id: ctx.opp.Id } }));
      return;
    }
  }
}

/**
 * Stage change (or first sight) + Win-100% → Won. Mutates baseline and fx.
 */
function syncStage(ctx: Ctx, baseline: Baseline, item: MondayItemSnapshot, fx: ItemEffects, wonFromWinPct: boolean): boolean {
  const cur = ctx.opp.StageName;
  const has = Object.prototype.hasOwnProperty.call(baseline, STAGE_KEY);
  const row = ctx.maps.stageAction[cur];
  let ranWon = false;
  const changed = !has || baseline[STAGE_KEY] !== cur;

  if (changed) {
    if (has) ctx.events.push(sfEvent(ctx, { eventType: 'stage_changed', field: 'StageName', oldValue: baseline[STAGE_KEY], newValue: cur }));
    baseline[STAGE_KEY] = cur;
    if (!row) {
      openFailure(
        ctx, 'unmapped_stage', ctx.opp.Id, 'StageName',
        `Unmapped Salesforce stage: ${cur}`,
        `Stage "${cur}" on "${ctx.opp.Name}" has no row in map_stage_action. Add it in Sync Admin → Mappings → Stage Actions.`,
        { mondayItemId: item.id === CREATED_ITEM ? undefined : item.id, mappingTable: 'map_stage_action' },
      );
    } else {
      applyStageAction(ctx, row, item, fx);
      ranWon = row.action === 'won';
    }
  }

  if (wonFromWinPct && !ranWon && !(row && TERMINAL_ACTIONS.has(row.action))) {
    applyWon(ctx, item, fx);
  }
  return changed;
}

// ── Entry point ─────────────────────────────────────────────────────────────
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { opportunityId: input.opportunityId, create: null, items: [], tasks: [], events: [] };
  const { opportunity: opp, config, maps } = input;

  if (!opp) {
    // Deleted, or no longer visible to the integration user. Never touch monday.
    for (const link of input.links.filter((l) => l.linkState === 'active')) {
      plan.tasks.push({
        op: 'open', taskType: 'sync_failure',
        dedupeKey: failureKey('opportunity_missing', input.opportunityId, 'opportunity'),
        title: `Salesforce opportunity not found: ${input.opportunityId}`,
        details: 'The linked opportunity was deleted or is not visible to the integration user. The monday item was left alone.',
        sourceRef: { board_key: 'presales', monday_item_id: link.mondayItemId, sf_opportunity_id: input.opportunityId },
      });
    }
    return plan;
  }

  const ctx: Ctx = { opp, config, maps, tasks: plan.tasks, events: plan.events };
  const avLines = opp.lineItems.filter(isAvLineItem);
  const target = createTargetFor(config, opp.StageName);
  const eligibleStage = target !== null;
  const multiKey = failureKey('multi_av_product', opp.Id, 'line_items');
  const openMulti = (count: number) =>
    openFailure(
      ctx, 'multi_av_product', opp.Id, 'line_items',
      `Multiple AV products: ${opp.Name}`,
      `"${opp.Name}" has ${count} AV line items. The sync only mirrors opportunities with exactly one AV product, so nothing new was created. Fix the products in Salesforce or link the item by hand.`,
    );

  // ── Existing links ──
  if (input.links.length > 0) {
    const linkedIds = new Set(input.links.map((l) => l.sfLineItemId));
    const unlinked = avLines.filter((li) => !linkedIds.has(li.Id));
    if (unlinked.length > 0 && eligibleStage) openMulti(avLines.length);
    else closeTask(ctx, multiKey);

    for (const link of input.links) {
      const itemPlan = planLink(ctx, link, input.items[link.mondayItemId], avLines.some((li) => li.Id === link.sfLineItemId));
      if (itemPlan) plan.items.push(itemPlan);
    }
    return plan;
  }

  // ── No link yet: create? (§4.3) ──
  if (avLines.length === 0 || !target) return plan;
  if (avLines.length > 1) {
    openMulti(avLines.length);
    return plan;
  }
  closeTask(ctx, multiKey);
  if (!config.createItems) return plan; // creation switched off (config_settings.create_items)
  plan.create = planCreate(ctx, avLines[0].Id, target);
  return plan;
}

function planCreate(ctx: Ctx, lineItemId: string, target: { boardKey: string; groupKey: string }): CreatePlan {
  const baseline: Baseline = {};
  const columnWrites: ColumnWrite[] = [];

  ctx.events.push(engineEvent(CREATED_ITEM, { eventType: 'created', details: { sf_opportunity_id: ctx.opp.Id, sf_line_item_id: lineItemId, name: ctx.opp.Name } }));

  // A brand-new item has no history: confirmed-to-win → Won straight away.
  const { wonTriggered: wonFromWinPct } = syncFields(ctx, baseline, columnWrites, CREATED_ITEM, undefined, { firstLink: false, closedGroup: false });

  if (writability(ctx.config, 'presales.sf_id') === 'ok') {
    columnWrites.push({ semanticKey: 'presales.sf_id', value: { type: 'text', text: lineItemId } });
  } else {
    openConfigMissing(ctx, 'presales.sf_id', CREATED_ITEM);
  }

  // A brand-new item: in its creation group, default status, no price, no engineer.
  const fresh: MondayItemSnapshot = {
    id: CREATED_ITEM,
    state: 'active',
    boardKey: target.boardKey,
    groupId: ctx.config.groups[`${target.boardKey}.${target.groupKey}`] ?? null,
    statusLabelId: null,
    quotedPrice: null,
    engineerUserIds: [],
  };
  const fx: ItemEffects = { writes: [] };
  syncStage(ctx, baseline, fresh, fx, wonFromWinPct);
  reviewEstimateDue(ctx, baseline, fresh, target.boardKey);

  return { sfLineItemId: lineItemId, itemName: ctx.opp.Name, boardKey: target.boardKey, groupKey: target.groupKey, columnWrites, stageWrites: fx.writes, baseline };
}

function planLink(ctx: Ctx, link: ReconcileInput['links'][number], item: MondayItemSnapshot | undefined, linePresent: boolean): ItemPlan | null {
  if (link.linkState === 'conflict') return null; // waits for a human

  const baseline: Baseline = { ...link.baseline };
  const done = (fx: ItemEffects, extra: Partial<ItemPlan> = {}): ItemPlan => ({
    mondayItemId: link.mondayItemId,
    boardKey: item ? boardOf(item) : 'presales',
    columnWrites: fx.writes,
    ...(fx.moveTo ? { moveTo: fx.moveTo } : {}),
    ...(fx.postUpdate ? { postUpdate: fx.postUpdate } : {}),
    ...(fx.archive ? { archive: true } : {}),
    ...(fx.newLinkState ? { newLinkState: fx.newLinkState } : {}),
    ...extra,
    baseline,
  });

  // Archived links don't sync. monday has no API to unarchive, so if the deal
  // comes back to life, ask a human to restore the item.
  if (link.linkState === 'archived') {
    const cur = ctx.opp.StageName;
    if (baseline[STAGE_KEY] !== cur) {
      baseline[STAGE_KEY] = cur;
      if (ctx.config.creationStages.includes(cur)) {
        openFailure(
          ctx, 'archived_reactivated', ctx.opp.Id, 'StageName',
          `Archived item reactivated: ${ctx.opp.Name}`,
          `"${ctx.opp.Name}" moved back to ${cur} in Salesforce, but its monday item is archived. Restore the item in monday, then reconcile.`,
          { mondayItemId: link.mondayItemId },
        );
      }
    }
    return done({ writes: [] });
  }

  if (!item || item.state === 'deleted') {
    openFailure(
      ctx, 'monday_item_missing', link.mondayItemId, 'item',
      `monday item missing: ${ctx.opp.Name}`,
      `The pre-sales item ${link.mondayItemId} linked to "${ctx.opp.Name}" no longer exists. Re-link or recreate it.`,
      { mondayItemId: link.mondayItemId },
    );
    return null;
  }

  if (item.state === 'archived') {
    ctx.events.push(engineEvent(item.id, { eventType: 'archived', details: { reason: 'archived_in_monday', sf_opportunity_id: ctx.opp.Id } }));
    return done({ writes: [], newLinkState: 'archived' });
  }

  const lineKey = failureKey('av_line_missing', ctx.opp.Id, link.sfLineItemId);
  if (!linePresent) {
    openFailure(
      ctx, 'av_line_missing', ctx.opp.Id, link.sfLineItemId,
      `AV product removed: ${ctx.opp.Name}`,
      `The AV line item ${link.sfLineItemId} on "${ctx.opp.Name}" was deleted or is no longer AV. Opportunity fields still sync; decide whether the monday item should stay.`,
      { mondayItemId: item.id },
    );
  } else {
    closeTask(ctx, lineKey);
  }

  const fx: ItemEffects = { writes: [] };
  const { wonTriggered: wonFromWinPct, wonReview } = syncFields(ctx, baseline, fx.writes, item.id, item.fieldValues, { firstLink: true, closedGroup: isClosedGroup(ctx.config, boardOf(item), item.groupId) });
  const stageChanged = syncStage(ctx, baseline, item, fx, wonFromWinPct);
  reviewConfirmedWin(ctx, baseline, item, wonReview);

  // Intake boards: R3 / EC1 / Lead ↔ Qualified moves follow a StageName change,
  // never a standing mismatch, so Hope's hand moves aren't fought.
  if (!fx.archive && !fx.moveTo && stageChanged && isIntakeBoard(item)) intakeMove(ctx, item, fx);
  // The won_on_intake task closes once the item leaves the intake boards, or when
  // Salesforce stops saying Won (a rep's early 99% taken back; Seth 2026-10-15).
  if (ctx.config.intake && (!isIntakeBoard(item) || !sfSaysWon(ctx))) closeTask(ctx, failureKey('won_on_intake', item.id, 'status'));

  // Legacy (no intake boards): linked items parked in the Pre-Sales board's
  // Pre-Engineering group go to New Requests on reaching a creation-set stage.
  if (!fx.archive && !fx.moveTo && inGroup(ctx.config, item, 'presales.pre_engineering') && ctx.config.creationStages.includes(ctx.opp.StageName)) {
    fx.moveTo = { boardKey: 'presales', groupKey: 'new_requests' };
    ctx.events.push(engineEvent(item.id, { eventType: 'group_moved', oldValue: 'pre_engineering', newValue: 'new_requests', details: { sf_stage: ctx.opp.StageName } }));
  }

  reviewEstimateDue(ctx, baseline, item, fx.moveTo?.boardKey ?? boardOf(item));
  return done(fx);
}

// ── EC2: estimate due date on a pre-engineering opportunity (Seth 2026-10-14) ──
const ESTIMATE_DUE_MARK = 'review:prequal_due';

/**
 * While an item sits on Pre-Qualification at a pre-engineering stage with an
 * Estimate Due Date/Time, Hope gets a task to check with the salesperson whether
 * it belongs in Engineering. It closes itself when the stage reaches Engineering
 * (the item moves to Triage) or the date is cleared. `boardAfter` = the item's
 * board once this pass's move (if any) is done.
 */
function reviewEstimateDue(ctx: Ctx, baseline: Baseline, item: MondayItemSnapshot, boardAfter: string): void {
  const key = failureKey('prequal_estimate_due', item.id, 'due_date');
  const due = extractSfFields(ctx.opp)['presales.due_date'];
  const applies = boardAfter === 'prequal' && ctx.config.prequalStages.includes(ctx.opp.StageName) && due !== null;
  if (applies && !baseline[ESTIMATE_DUE_MARK]) {
    ctx.tasks.push({
      op: 'open', taskType: 'sync_failure', dedupeKey: key,
      title: `Estimate due date on a pre-engineering opportunity: ${ctx.opp.Name}`,
      details:
        `"${ctx.opp.Name}" is at ${ctx.opp.StageName} in Salesforce but has an Estimate Due Date/Time (${etDate(due!)}). ` +
        'Check with the salesperson whether it should be in Engineering. If yes, move the stage to Engineering (the item moves to Triage); ' +
        'if not, clear the estimate due date. This task closes itself either way.',
      sourceRef: { board_key: 'prequal', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id },
    });
    baseline[ESTIMATE_DUE_MARK] = '1';
  } else if (!applies && baseline[ESTIMATE_DUE_MARK]) {
    closeTask(ctx, key);
    delete baseline[ESTIMATE_DUE_MARK];
  }
}

// ── First-pass review of Confirmed-to-Win items (Seth 2026-10-12) ───────────
const REVIEW_MARK = 'review:won';

function humanStatus(cfg: PlannerConfig, id: number | null): string {
  if (id === null) return 'blank';
  const hit = Object.entries(cfg.labels).find(([k, v]) => k.startsWith('presales.status.') && v === id);
  if (!hit) return `label ${id}`;
  return hit[0].slice('presales.status.'.length).split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Open (on first sight) and later close the "Confirmed to Win in Salesforce,
 * not Won in monday" review task for a linked item. It stays open while both
 * hold; it closes once monday is Won, Salesforce drops below confirmed, or the
 * deal reaches a terminal stage.
 */
function reviewConfirmedWin(ctx: Ctx, baseline: Baseline, item: MondayItemSnapshot, firstSight: boolean): void {
  const key = failureKey('confirmed_win_review', item.id, 'status');
  const wonId = ctx.config.labels['presales.status.won'];
  const row = ctx.maps.stageAction[ctx.opp.StageName];
  const sfWin = extractSfFields(ctx.opp)['presales.win_pct'];
  const applies = sfWin !== null && ctx.config.confirmedWinPcts.includes(sfWin)
    && item.statusLabelId !== wonId && !(row && TERMINAL_ACTIONS.has(row.action));

  if (firstSight && applies) {
    ctx.tasks.push({
      op: 'open',
      taskType: 'sync_failure',
      dedupeKey: key,
      title: `Confirmed to Win in Salesforce, not Won in monday: ${ctx.opp.Name}`,
      details:
        `Salesforce Win % is ${sfWin} (Confirmed to Win), but the pre-sales item's status is ${humanStatus(ctx.config, item.statusLabelId)}. ` +
        'The sync did not change it because this item was only just linked and may already have been handled by hand. ' +
        'If the deal is confirmed, set the status to Won in monday — that triggers the Post-Sales copy and the leadership notification. ' +
        'If not, the Win % in Salesforce needs correcting. This task closes itself once the item is Won.',
      sourceRef: { board_key: 'presales', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id },
    });
    baseline[REVIEW_MARK] = '1';
    return;
  }
  if (baseline[REVIEW_MARK] && !applies) {
    closeTask(ctx, key);
    delete baseline[REVIEW_MARK];
  }
}

// ── Helpers for the executor and tests ──────────────────────────────────────
/** True when the plan would change anything outside our own task bookkeeping. */
export function planHasEffects(plan: ReconcilePlan): boolean {
  if (plan.create) return true;
  if (plan.events.length > 0) return true;
  if (plan.tasks.some((t) => t.op === 'open')) return true;
  return plan.items.some(
    (i) => i.columnWrites.length > 0 || i.moveTo || i.postUpdate || i.archive || i.newLinkState,
  );
}
