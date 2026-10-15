/**
 * The ONLY path to outbound writes (spec §1, dry-run mode).
 *
 * In dry_run every call is recorded in the journal and nothing is sent; the
 * executor turns the journal into `dry_run_write` events. In live the call goes
 * through (and is still journaled, for logging).
 *
 * Webhook registration is infrastructure, not a sync write, and deliberately
 * bypasses the gate — dry run needs to receive monday events too.
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
