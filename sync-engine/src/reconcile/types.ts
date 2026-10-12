/**
 * Types for the Salesforce → monday reconciler (spec §4).
 *
 * The planner (plan.ts) is pure: Salesforce state + link rows + monday item
 * snapshots + config in, a ReconcilePlan out. No I/O, no clock. The executor
 * performs the plan through the writeGate (dry run / live) and persists the
 * baseline + events in one transaction.
 */

// ── Salesforce input (the spec §4.2 query, subquery flattened by the client) ────
export interface SfLineItem {
  Id: string; // 00k…
  isAVProduct__c: boolean | null;
  Technology__c: string | null;
  UnitPrice: number | null;
  Quantity: number | null;
  Sold_in_Margin__c: number | null; // lowercase "i" — the LINE ITEM field
  CreatedDate: string;
}

export interface SfOpportunity {
  Id: string; // 006…
  Name: string;
  StageName: string;
  Estimate_Due_Date_Time__c: string | null;
  Estimate_Number__c: string | null; // the quote number (Quote_Number__c is always null)
  Win_Likelihood__c: string | number | null;
  Business_Unit__c: string | null;
  Sales_Rep__c: string | null; // source of truth for the rep — NOT OwnerId
  Sales_Rep__r: { Name: string | null } | null;
  Lost_Reason__c: string | null;
  Other_lost_reason__c: string | null;
  Lost_To__c: string | null;
  SystemModstamp: string;
  LastModifiedById?: string | null; // optional: event actor for rework analysis
  lineItems: SfLineItem[]; // AV-filtered by the query, re-checked by the planner
}

// ── monday input ────────────────────────────────────────────────────────────
/** Only the monday-side facts the stage actions need. */
export interface MondayItemSnapshot {
  id: string;
  state: 'active' | 'archived' | 'deleted';
  groupId: string | null;
  statusLabelId: number | null; // presales.status
  quotedPrice: number | null; // presales.quoted_price
  engineerUserIds: string[]; // presales.presales_engineer
}

// ── Link rows ───────────────────────────────────────────────────────────────
/**
 * Baseline values are the normalized SALESFORCE value last written, keyed by
 * semantic key, plus:
 *   'sf.stage'      last StageName processed
 *   'miss:<key>'    the SF value that last failed to map (suppresses repeat
 *                   failure events/tasks until the value or the mapping changes)
 * A missing key means "never synced".
 */
export type Baseline = Record<string, string | null>;

export interface LinkRow {
  mondayItemId: string;
  sfOpportunityId: string;
  sfLineItemId: string;
  linkState: 'active' | 'archived' | 'conflict';
  baseline: Baseline;
}

// ── Config (resolved from config_* + map_* tables by the config layer) ──────
export type ColumnType =
  | 'date' | 'datetime' | 'text' | 'long_text' | 'numbers' | 'status' | 'dropdown' | 'people' | 'link' | 'button';

export interface ColumnDef {
  columnId: string | null; // null = not configured yet
  type: ColumnType;
  boardKey?: string; // config_boards key the column lives on
  owner: 'salesforce' | 'monday' | 'shared' | 'engine';
}

export type StageActionKind =
  | 'none' | 'set_status' | 'stage_check_delivered' | 'stage_check_contract' | 'won' | 'lost' | 'declined' | 'canceled';

export interface StageActionRow {
  action: StageActionKind;
  params: { label_key?: string };
}

export interface PlannerConfig {
  /** semantic key → column. */
  columns: Record<string, ColumnDef>;
  /** '<board_key>.<group_key>' → monday group id (null = not configured). */
  groups: Record<string, string | null>;
  /** '<semantic_key>.<label_key>' → monday label id (null = not configured). */
  labels: Record<string, number | null>;
  creationStages: string[];
  /** Semantic keys write-blocked by the config-drift check (spec §2.2). */
  blockedColumns: string[];
}

/** Active mapping rows only. A null label id = known value, not mapped yet. */
export interface PlannerMaps {
  businessUnit: Record<string, number | null>;
  winPct: Record<string, number | null>;
  salesRep: Record<string, number | null>;
  stageAction: Record<string, StageActionRow>;
}

export interface ReconcileInput {
  /** null = the opportunity no longer exists / isn't visible to the integration user. */
  opportunity: SfOpportunity | null;
  opportunityId: string;
  /** Every sf_link row for this opportunity. */
  links: LinkRow[];
  /** monday snapshots for the linked items, keyed by item id. */
  items: Record<string, MondayItemSnapshot>;
  config: PlannerConfig;
  maps: PlannerMaps;
}

// ── Output ──────────────────────────────────────────────────────────────────
export type MondayValue =
  | { type: 'status'; labelId: number }
  | { type: 'dropdown'; labelIds: number[] }
  | { type: 'datetime'; iso: string } // UTC instant, passed through (spec §4.4)
  | { type: 'text'; text: string }
  | { type: 'long_text'; text: string };

export interface ColumnWrite {
  semanticKey: string;
  value: MondayValue;
}

/** Placeholder for the item a CreatePlan makes; the executor substitutes the real id. */
export const CREATED_ITEM = '$created';

export type TaskType =
  | 'sync_failure' | 'writeback_no_link' | 'writeback_quantity'
  | 'stage_check_delivered' | 'stage_check_contract' | 'won_handoff' | 'open_job';

export type TaskIntent =
  | {
      op: 'open';
      taskType: TaskType;
      dedupeKey: string; // may contain CREATED_ITEM
      title: string;
      details: string;
      sourceRef: { board_key?: string; monday_item_id?: string; sf_opportunity_id?: string; mapping_table?: string };
    }
  | { op: 'close'; dedupeKey: string };

export interface EventIntent {
  source: 'salesforce' | 'engine';
  entityType: 'opportunity' | 'line_item' | 'monday_item';
  entityId: string; // may be CREATED_ITEM
  eventType:
    | 'created' | 'field_changed' | 'status_changed' | 'stage_changed' | 'sync_failure' | 'archived' | 'notified' | 'group_moved';
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  applied?: boolean; // default true
  actor?: string;
  details?: Record<string, unknown>;
}

export interface CreatePlan {
  sfLineItemId: string;
  itemName: string; // written once, never updated
  groupKey: 'new_requests';
  /** Field values sent with create_item. */
  columnWrites: ColumnWrite[];
  /**
   * Stage-action writes (status / notes), sent as a SECOND mutation after the
   * item exists so monday's "status changes to…" automations fire.
   */
  stageWrites: ColumnWrite[];
  baseline: Baseline;
}

export interface ItemPlan {
  mondayItemId: string;
  /** All column writes for this item — sent as ONE change_multiple_column_values. */
  columnWrites: ColumnWrite[];
  moveToGroupKey?: string;
  postUpdate?: { mentionUserIds: string[]; body: string };
  archive?: boolean;
  newLinkState?: 'archived';
  /** The complete new baseline (unchanged keys included). */
  baseline: Baseline;
}

export interface ReconcilePlan {
  opportunityId: string;
  create: CreatePlan | null;
  items: ItemPlan[];
  tasks: TaskIntent[];
  events: EventIntent[];
}
