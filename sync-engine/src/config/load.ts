/**
 * Config layer (spec §2): reads config_* and map_* into the shapes the planner
 * and executor use. Business logic only ever sees semantic keys; this is the one
 * place they're resolved to monday ids.
 */
import type { Queryable } from '../db/pool.ts';
import type { ColumnDef, PlannerConfig, PlannerMaps, StageActionRow } from '../reconcile/types.ts';

export interface LabelRef {
  /** Where the id came from — config_labels or a map_* table. */
  source: 'config_labels' | 'map_business_unit' | 'map_win_pct' | 'map_sales_rep';
  semanticKey: string; // the monday column it lives on
  key: string; // label_key (config_labels) or sf_value (maps)
  labelId: number;
}

export interface RuntimeConfig {
  planner: PlannerConfig;
  maps: PlannerMaps;
  /** board_key → monday board id (null = not configured). */
  boards: Record<string, string | null>;
  settings: Record<string, unknown>;
  /** Every configured label id, for the drift check. */
  labelRefs: LabelRef[];
  /** map_estimator: monday user id → Salesforce user name (null = not mapped yet) or ignored. */
  estimators: Record<string, EstimatorMapRow>;
}

export interface EstimatorMapRow {
  mondayName: string;
  sfUserName: string | null;
  ignore: boolean;
  /** Label id in the Triage board's Pre-Sales Engineer dropdown (engineers aren't Triage members). */
  triageLabelId: number | null;
}

const MAP_TABLES = [
  { table: 'map_business_unit', mapKey: 'businessUnit', semanticKey: 'presales.business_unit' },
  { table: 'map_win_pct', mapKey: 'winPct', semanticKey: 'presales.win_pct' },
  { table: 'map_sales_rep', mapKey: 'salesRep', semanticKey: 'presales.sales_person' },
] as const;

/**
 * @param drift  Output of the last drift check: columns to block, and map rows
 *               whose label vanished (treated as unmapped so they raise failure
 *               tasks instead of writing a dead id).
 */
export async function loadRuntimeConfig(
  q: Queryable,
  drift: { blockedColumns: string[]; deadMapRows: { table: string; sfValue: string }[] } = { blockedColumns: [], deadMapRows: [] },
): Promise<RuntimeConfig> {
  const [boards, fields, groups, labels, settings, stages] = await Promise.all([
    q.query<{ board_key: string; monday_board_id: string | null }>('select board_key, monday_board_id::text from config_boards'),
    q.query<{ semantic_key: string; board_key: string; monday_column_id: string | null; column_type: ColumnDef['type']; owner: ColumnDef['owner'] }>(
      'select semantic_key, board_key, monday_column_id, column_type, owner from config_field_registry'),
    q.query<{ board_key: string; group_key: string; monday_group_id: string | null }>('select board_key, group_key, monday_group_id from config_groups'),
    q.query<{ semantic_key: string; label_key: string; monday_label_id: number | null }>('select semantic_key, label_key, monday_label_id from config_labels'),
    q.query<{ key: string; value: unknown }>('select key, value from config_settings'),
    q.query<{ stage: string; action: StageActionRow['action']; params: StageActionRow['params'] }>(
      'select stage, action, params from map_stage_action where active'),
  ]);

  const labelRefs: LabelRef[] = [];
  const planner: PlannerConfig = {
    columns: Object.fromEntries(fields.rows.map((f) => [f.semantic_key, { columnId: f.monday_column_id, type: f.column_type, owner: f.owner, boardKey: f.board_key }])),
    groups: Object.fromEntries(groups.rows.map((g) => [`${g.board_key}.${g.group_key}`, g.monday_group_id])),
    labels: Object.fromEntries(labels.rows.map((l) => {
      if (l.monday_label_id !== null) labelRefs.push({ source: 'config_labels', semanticKey: l.semantic_key, key: l.label_key, labelId: l.monday_label_id });
      return [`${l.semantic_key}.${l.label_key}`, l.monday_label_id];
    })),
    creationStages: [],
    prequalStages: [],
    createItems: true,
    intake: false,
    confirmedWinPcts: [],
    blockedColumns: drift.blockedColumns,
  };

  const settingsMap = Object.fromEntries(settings.rows.map((s) => [s.key, s.value]));
  const cs = settingsMap.creation_stages;
  planner.creationStages = Array.isArray(cs) ? cs.map(String) : [];
  const ps = settingsMap.prequal_stages;
  planner.prequalStages = Array.isArray(ps) ? ps.map(String) : [];
  planner.createItems = settingsMap.create_items !== false;
  // Intake mode needs both boards configured (sandbox and production each have their own).
  const boardIds = Object.fromEntries(boards.rows.map((b) => [b.board_key, b.monday_board_id]));
  planner.intake = !!boardIds.prequal && !!boardIds.triage;
  const cw = settingsMap.confirmed_win_pcts;
  planner.confirmedWinPcts = Array.isArray(cw) && cw.length > 0 ? cw.map(String) : ['100%'];

  const dead = new Set(drift.deadMapRows.map((d) => `${d.table}|${d.sfValue}`));
  const maps: PlannerMaps = { businessUnit: {}, winPct: {}, salesRep: {}, stageAction: {} };
  for (const m of MAP_TABLES) {
    const { rows } = await q.query<{ sf_value: string; monday_label_id: number | null }>(
      `select sf_value, monday_label_id from ${m.table} where active`);
    for (const r of rows) {
      const isDead = dead.has(`${m.table}|${r.sf_value}`);
      maps[m.mapKey][r.sf_value] = isDead ? null : r.monday_label_id;
      if (r.monday_label_id !== null) labelRefs.push({ source: m.table, semanticKey: m.semanticKey, key: r.sf_value, labelId: r.monday_label_id });
    }
  }
  for (const s of stages.rows) maps.stageAction[s.stage] = { action: s.action, params: s.params ?? {} };

  // map_estimator arrives with sync_triage_and_estimator.sql; tolerate a schema without it.
  const estimators: Record<string, EstimatorMapRow> = {};
  const { rows: hasEstimators } = await q.query<{ t: string | null }>(`select to_regclass('map_estimator')::text as t`);
  if (hasEstimators[0]?.t) {
    // triage_label_id arrives with sync_triage_engineer_pick.sql; to_jsonb tolerates its absence.
    const { rows } = await q.query<{ monday_user_id: string; monday_name: string; sf_user_name: string | null; ignore: boolean; triage_label_id: string | null }>(
      `select monday_user_id::text, monday_name, sf_user_name, ignore, to_jsonb(m)->>'triage_label_id' as triage_label_id
         from map_estimator m where active`);
    for (const r of rows) {
      estimators[r.monday_user_id] = {
        mondayName: r.monday_name, sfUserName: r.sf_user_name, ignore: r.ignore,
        triageLabelId: r.triage_label_id === null ? null : Number(r.triage_label_id),
      };
    }
  }

  return {
    estimators,
    planner,
    maps,
    boards: Object.fromEntries(boards.rows.map((b) => [b.board_key, b.monday_board_id])),
    settings: settingsMap,
    labelRefs,
  };
}
