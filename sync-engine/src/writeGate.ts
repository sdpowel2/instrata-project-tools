/**
 * The ONLY path to outbound writes (spec §1, dry-run mode).
 *
 * In dry_run every call is recorded in the journal and nothing is sent; the
 * executor turns the journal into `dry_run_write` events. In live the call goes
 * through (and is still journaled, for logging).
 *
 * Webhook registration is infrastructure, not a sync write, and deliberately
 * bypasses the gate — dry run needs to receive monday events too. The Hope's
 * Queue push gets its own always-live gate (index.ts): that board is the
 * engine's own, switched by the queue_push setting.
 */
import type { SyncMode } from './env.ts';
import type { MondayClient } from './monday/client.ts';
import type { EmailMessage, LineItemPatch, SalesforceClient } from './salesforce/client.ts';

export interface JournalEntry {
  system: 'monday' | 'salesforce';
  op: string;
  target: string; // item / line item id ('$created' for a not-yet-created item)
  payload: Record<string, unknown>;
}

export interface WriteGate {
  readonly mode: SyncMode;
  /** Returns and clears everything recorded since the last drain. */
  drain(): JournalEntry[];
  /**
   * A gate with its own empty journal (same mode, same clients). Every operation
   * — a reconcile pass, a writeback — forks one, so concurrent operations never
   * see each other's journal entries.
   */
  fork(): WriteGate;
  monday: {
    changeColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void>;
    /** Returns the new item id, or null in dry run. */
    createItem(boardId: string, groupId: string | null, name: string, values: Record<string, unknown>): Promise<string | null>;
    moveItemToGroup(itemId: string, groupId: string): Promise<void>;
    moveItemToBoard(itemId: string, fromBoardId: string, toBoardId: string, groupId: string): Promise<void>;
    archiveItem(itemId: string): Promise<void>;
    createUpdate(itemId: string, body: string, mentionUserIds?: string[]): Promise<void>;
    createNotification(userId: string, itemId: string, text: string): Promise<void>;
  };
  salesforce: {
    patchLineItem(id: string, values: LineItemPatch): Promise<void>;
    sendEmail(msg: EmailMessage): Promise<void>;
  };
}

/**
 * A live gate that can do ONE thing: write OpportunityLineItem.Estimator__c. For the
 * Estimator first pass run while the engine is still in dry run (Seth 2026-10-26: the
 * executives wanted the Estimators fixed before go-live). Every other write — monday,
 * price / GM%, emails — throws, so nothing else can leak out of dry run.
 */
export function createEstimatorOnlyGate(monday: MondayClient, salesforce: SalesforceClient): WriteGate {
  const live = createWriteGate('live', monday, salesforce);
  const refuse = (what: string) => async (): Promise<never> => { throw new Error(`estimator-only gate: ${what} is not allowed`); };
  const gate: WriteGate = {
    mode: 'live',
    drain: () => live.drain(),
    fork: () => createEstimatorOnlyGate(monday, salesforce),
    monday: {
      changeColumnValues: refuse('a monday write'),
      createItem: refuse('a monday write'),
      moveItemToGroup: refuse('a monday write'),
      moveItemToBoard: refuse('a monday write'),
      archiveItem: refuse('a monday write'),
      createUpdate: refuse('a monday write'),
      createNotification: refuse('a monday write'),
    },
    salesforce: {
      async patchLineItem(id, values) {
        const keys = Object.keys(values);
        if (keys.length !== 1 || keys[0] !== 'Estimator__c') throw new Error(`estimator-only gate: only Estimator__c may be written, got ${keys.join(', ')}`);
        await live.salesforce.patchLineItem(id, values);
      },
      sendEmail: refuse('an email'),
    },
  };
  return gate;
}

export function createWriteGate(mode: SyncMode, monday: MondayClient, salesforce: SalesforceClient): WriteGate {
  let journal: JournalEntry[] = [];
  const live = mode === 'live';
  const record = (e: JournalEntry) => {
    journal.push(e);
  };

  return {
    mode,
    fork: () => createWriteGate(mode, monday, salesforce),
    drain() {
      const out = journal;
      journal = [];
      return out;
    },
    monday: {
      async changeColumnValues(boardId, itemId, values) {
        record({ system: 'monday', op: 'change_multiple_column_values', target: itemId, payload: { boardId, values } });
        if (live) await monday.changeColumnValues(boardId, itemId, values);
      },
      async createItem(boardId, groupId, name, values) {
        record({ system: 'monday', op: 'create_item', target: '$created', payload: { boardId, groupId, name, values } });
        return live ? monday.createItem(boardId, groupId, name, values) : null;
      },
      async moveItemToGroup(itemId, groupId) {
        record({ system: 'monday', op: 'move_item_to_group', target: itemId, payload: { groupId } });
        if (live) await monday.moveItemToGroup(itemId, groupId);
      },
      async moveItemToBoard(itemId, fromBoardId, toBoardId, groupId) {
        record({ system: 'monday', op: 'move_item_to_board', target: itemId, payload: { fromBoardId, toBoardId, groupId } });
        if (live) await monday.moveItemToBoard(itemId, fromBoardId, toBoardId, groupId);
      },
      async archiveItem(itemId) {
        record({ system: 'monday', op: 'archive_item', target: itemId, payload: {} });
        if (live) await monday.archiveItem(itemId);
      },
      async createUpdate(itemId, body, mentionUserIds = []) {
        record({ system: 'monday', op: 'create_update', target: itemId, payload: { body, mentionUserIds } });
        if (live) await monday.createUpdate(itemId, body, mentionUserIds);
      },
      async createNotification(userId, itemId, text) {
        record({ system: 'monday', op: 'create_notification', target: itemId, payload: { userId, text } });
        if (live) await monday.createNotification(userId, itemId, text);
      },
    },
    salesforce: {
      async patchLineItem(id, values) {
        record({ system: 'salesforce', op: 'patch_line_item', target: id, payload: { values } });
        if (live) await salesforce.patchLineItem(id, values);
      },
      async sendEmail(msg) {
        record({ system: 'salesforce', op: 'send_email', target: msg.relatedRecordId ?? msg.to, payload: { to: msg.to, subject: msg.subject } });
        if (live) await salesforce.sendEmail(msg);
      },
    },
  };
}
