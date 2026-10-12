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

const FIELD_META: Record<SfFieldKey, { label: string; map?: keyof Omit<PlannerMaps, 'stageAction'>; table?: string }> = {
  'presales.due_date': { label: 'Due Date' },
  'presales.quote_number': { label: 'Quote Number' },
  'presales.win_pct': { label: 'Win %', map: 'winPct', table: 'map_win_pct' },
  'presales.business_unit': { label: 'Business Unit', map: 'businessUnit', table: 'map_business_unit' },
  'presales.sales_person': { label: 'Sales Rep', map: 'salesRep', table: 'map_sales_rep' },
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

/** SF value → monday value. null = unmappable. */
function toMondayValue(ctx: Ctx, key: SfFieldKey, sfValue: string): MondayValue | null {
  const meta = FIELD_META[key];
  if (key === 'presales.due_date') return { type: 'datetime', iso: sfValue };
  if (!meta.map) return { type: 'text', text: sfValue };
  const id = ctx.maps[meta.map][sfValue];
  return id === undefined || id === null ? null : { type: 'dropdown', labelIds: [id] };
}

// ── Field sync (§4.4) ───────────────────────────────────────────────────────
/** Mutates `baseline` and `writes`. Returns true when Win % reached 100% (→ Won). */
function syncFields(ctx: Ctx, baseline: Baseline, writes: ColumnWrite[], itemRef: string): boolean {
  const sf = extractSfFields(ctx.opp);
  let wonTriggered = false;

  for (const key of SF_FIELD_KEYS) {
    const cur = sf[key];
    const has = Object.prototype.hasOwnProperty.call(baseline, key);
    const last = has ? baseline[key] : undefined;
    const unmappedKey = failureKey('unmapped_value', ctx.opp.Id, key);

    if (has && cur === last) {
      closeTask(ctx, unmappedKey);
      continue;
    }

    // Blank never clears a populated monday value. Record it once, then move the
    // baseline so the same blank isn't re-logged on every reconcile.
    if (cur === null) {
      if (has) ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last, newValue: null, applied: false }));
      baseline[key] = null;
      delete baseline[missKey(key)];
      closeTask(ctx, unmappedKey);
      continue;
    }

    // 100% isn't a label — it's the status action Won (§3.2, §4.6).
    if (key === 'presales.win_pct' && cur === '100%') {
      if (last !== '100%') {
        wonTriggered = true;
        ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last ?? null, newValue: cur, details: { applied_as: 'status_won' } }));
      }
      baseline[key] = cur;
      delete baseline[missKey(key)];
      closeTask(ctx, unmappedKey);
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
      // Leave the field (and its baseline) untouched so it's retried; only raise
      // the failure when this particular value hasn't already been reported.
      if (baseline[missKey(key)] !== cur) {
        const meta = FIELD_META[key];
        openFailure(
          ctx, 'unmapped_value', ctx.opp.Id, key,
          `Unmapped ${meta.label}: ${cur}`,
          `Salesforce ${meta.label} "${cur}" on "${ctx.opp.Name}" has no monday label. Add it to ${meta.table} in Sync Admin → Mappings.`,
          { mondayItemId: itemRef === CREATED_ITEM ? undefined : itemRef, mappingTable: meta.table },
        );
        baseline[missKey(key)] = cur;
      }
      continue;
    }

    writes.push({ semanticKey: key, value });
    ctx.events.push(sfEvent(ctx, { eventType: 'field_changed', field: key, oldValue: last ?? null, newValue: cur, details: { monday_item_id: itemRef } }));
    baseline[key] = cur;
    delete baseline[missKey(key)];
    closeTask(ctx, unmappedKey);
  }

  return wonTriggered;
}

// ── Stage actions (§4.6) ────────────────────────────────────────────────────
interface ItemEffects {
  writes: ColumnWrite[];
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

function applyWon(ctx: Ctx, item: MondayItemSnapshot, fx: ItemEffects): void {
  // Won-triggered tasks fire only when the ENGINE moves the status. If a human
  // already set Won, the monday status webhook raised them (and re-raising here
  // would reopen tasks Hope already closed).
  if (setStatus(ctx, item, fx, 'won') !== 'written') return;
  const ref = { board_key: 'presales', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id };
  ctx.tasks.push(
    { op: 'open', taskType: 'won_handoff', dedupeKey: `won_handoff:${item.id}`, title: `Won – handoff: ${ctx.opp.Name}`, details: 'Pre-sales → post-sales handoff package.', sourceRef: ref },
    { op: 'open', taskType: 'open_job', dedupeKey: `open_job:${item.id}`, title: `Won – open job: ${ctx.opp.Name}`, details: 'Open the job; closes when the post-sales item has a Project Number.', sourceRef: ref },
  );
}

function applyStageAction(ctx: Ctx, row: StageActionRow, item: MondayItemSnapshot, fx: ItemEffects): void {
  const ref = { board_key: 'presales', monday_item_id: item.id, sf_opportunity_id: ctx.opp.Id };
  switch (row.action) {
    case 'none':
      return;

    case 'set_status':
      if (row.params.label_key) setStatus(ctx, item, fx, row.params.label_key);
      return;

    case 'stage_check_delivered':
      if (item.groupId !== ctx.config.groups['presales.follow_up']) {
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
function syncStage(ctx: Ctx, baseline: Baseline, item: MondayItemSnapshot, fx: ItemEffects, wonFromWinPct: boolean): void {
  const cur = ctx.opp.StageName;
  const has = Object.prototype.hasOwnProperty.call(baseline, STAGE_KEY);
  const row = ctx.maps.stageAction[cur];
  let ranWon = false;

  if (!has || baseline[STAGE_KEY] !== cur) {
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
  const eligibleStage = config.creationStages.includes(opp.StageName);
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
  if (avLines.length === 0 || !eligibleStage) return plan;
  if (avLines.length > 1) {
    openMulti(avLines.length);
    return plan;
  }
  closeTask(ctx, multiKey);
  plan.create = planCreate(ctx, avLines[0].Id);
  return plan;
}

function planCreate(ctx: Ctx, lineItemId: string): CreatePlan {
  const baseline: Baseline = {};
  const columnWrites: ColumnWrite[] = [];

  ctx.events.push(engineEvent(CREATED_ITEM, { eventType: 'created', details: { sf_opportunity_id: ctx.opp.Id, sf_line_item_id: lineItemId, name: ctx.opp.Name } }));

  const wonFromWinPct = syncFields(ctx, baseline, columnWrites, CREATED_ITEM);

  if (writability(ctx.config, 'presales.sf_id') === 'ok') {
    columnWrites.push({ semanticKey: 'presales.sf_id', value: { type: 'text', text: lineItemId } });
  } else {
    openConfigMissing(ctx, 'presales.sf_id', CREATED_ITEM);
  }

  // A brand-new item: in New Requests, default status, no price, no engineer.
  const fresh: MondayItemSnapshot = {
    id: CREATED_ITEM,
    state: 'active',
    groupId: ctx.config.groups['presales.new_requests'] ?? null,
    statusLabelId: null,
    quotedPrice: null,
    engineerUserIds: [],
  };
  const fx: ItemEffects = { writes: [] };
  syncStage(ctx, baseline, fresh, fx, wonFromWinPct);

  return { sfLineItemId: lineItemId, itemName: ctx.opp.Name, groupKey: 'new_requests', columnWrites, stageWrites: fx.writes, baseline };
}

function planLink(ctx: Ctx, link: ReconcileInput['links'][number], item: MondayItemSnapshot | undefined, linePresent: boolean): ItemPlan | null {
  if (link.linkState === 'conflict') return null; // waits for a human

  const baseline: Baseline = { ...link.baseline };
  const done = (fx: ItemEffects, extra: Partial<ItemPlan> = {}): ItemPlan => ({
    mondayItemId: link.mondayItemId,
    columnWrites: fx.writes,
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
  const wonFromWinPct = syncFields(ctx, baseline, fx.writes, item.id);
  syncStage(ctx, baseline, item, fx, wonFromWinPct);

  // Cutover step 3: linked items parked in Pre-Engineering go to New Requests the
  // first time they reach a creation-set stage — the one group move the sync makes.
  let moveToGroupKey: string | undefined;
  const preEng = ctx.config.groups['presales.pre_engineering'];
  if (!fx.archive && preEng && item.groupId === preEng && ctx.config.creationStages.includes(ctx.opp.StageName)) {
    moveToGroupKey = 'new_requests';
    ctx.events.push(engineEvent(item.id, { eventType: 'group_moved', oldValue: 'pre_engineering', newValue: 'new_requests', details: { sf_stage: ctx.opp.StageName } }));
  }

  return done(fx, moveToGroupKey ? { moveToGroupKey } : {});
}

// ── Helpers for the executor and tests ──────────────────────────────────────
/** True when the plan would change anything outside our own task bookkeeping. */
export function planHasEffects(plan: ReconcilePlan): boolean {
  if (plan.create) return true;
  if (plan.events.length > 0) return true;
  if (plan.tasks.some((t) => t.op === 'open')) return true;
  return plan.items.some(
    (i) => i.columnWrites.length > 0 || i.moveToGroupKey || i.postUpdate || i.archive || i.newLinkState,
  );
}
