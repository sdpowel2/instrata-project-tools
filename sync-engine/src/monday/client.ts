/**
 * monday GraphQL client. Read methods are used directly; WRITE methods must only
 * ever be called through the writeGate (src/writeGate.ts) so dry run is
 * enforced in exactly one place.
 *
 * All IDs travel as GraphQL variables, never string-concatenated into queries.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from '../log.ts';
import { parseColumnLabels, type LiveLabel } from './encode.ts';

const MONDAY_API = 'https://api.monday.com/v2';
const MAX_RETRIES = 5;

export interface MondayItemRaw {
  id: string;
  name: string;
  state: 'active' | 'archived' | 'deleted';
  group: { id: string } | null;
  column_values: { id: string; value: string | null; text: string | null }[];
}

export interface MondayWebhook {
  id: string;
  event: string;
  board_id: string;
  config: string | null;
}

export interface MondayClient {
  query<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;

  // Reads
  getItems(itemIds: string[], columnIds: string[]): Promise<MondayItemRaw[]>;
  pageBoardItems(boardId: string, columnIds: string[], onPage: (items: MondayItemRaw[]) => Promise<void> | void): Promise<void>;
  getColumnLabels(boardId: string, columnId: string): Promise<LiveLabel[]>;
  listWebhooks(boardId: string): Promise<MondayWebhook[]>;

  // Writes — writeGate only
  changeColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void>;
  createItem(boardId: string, groupId: string | null, name: string, values: Record<string, unknown>): Promise<string>;
  moveItemToGroup(itemId: string, groupId: string): Promise<void>;
  archiveItem(itemId: string): Promise<void>;
  /** Item update; mentionUserIds become real @mentions (mentions_list). */
  createUpdate(itemId: string, body: string, mentionUserIds?: string[]): Promise<void>;
  createNotification(userId: string, itemId: string, text: string): Promise<void>;
  createWebhook(boardId: string, url: string, event: string, config?: Record<string, unknown>): Promise<string>;
}

export function createMondayClient(opts: { token: string; apiVersion: string; fetchImpl?: typeof fetch }): MondayClient {
  const doFetch = opts.fetchImpl ?? fetch;

  async function query<T>(q: string, variables?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await doFetch(MONDAY_API, {
        method: 'POST',
        headers: { Authorization: opts.token, 'Content-Type': 'application/json', 'API-Version': opts.apiVersion },
        body: JSON.stringify({ query: q, variables }),
      });
      const json: any = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}, non-JSON body` }] }));
      if (!json.errors && !json.error_code) return json.data as T;

      // Per-minute complexity budget: monday says how long to wait. Same policy as monday-backfill.
      const errors: any[] = json.errors ?? [{ message: json.error_message, extensions: { code: json.error_code, status_code: res.status } }];
      const rate = errors.find((e) => e?.extensions?.code === 'COMPLEXITY_BUDGET_EXHAUSTED' || e?.extensions?.status_code === 429 || res.status === 429);
      if (rate && attempt < MAX_RETRIES) {
        const waitMs = (Math.max(1, Number(rate.extensions?.retry_in_seconds) || 30) + Math.random() * 2) * 1000;
        log.warn('monday rate limited; backing off', { waitMs: Math.round(waitMs), attempt: attempt + 1 });
        await sleep(waitMs);
        continue;
      }
      throw new Error(`monday GraphQL: ${JSON.stringify(errors).slice(0, 1000)}`);
    }
    throw new Error('monday GraphQL: retries exhausted');
  }

  const ITEM_FIELDS = `id name state group { id } column_values(ids: $columnIds) { id value text }`;

  return {
    query,

    async getItems(itemIds, columnIds) {
      const out: MondayItemRaw[] = [];
      for (let i = 0; i < itemIds.length; i += 100) {
        const data = await query<{ items: MondayItemRaw[] }>(
          `query ($ids: [ID!], $columnIds: [String!]) { items(ids: $ids, limit: 100) { ${ITEM_FIELDS} } }`,
          { ids: itemIds.slice(i, i + 100), columnIds },
        );
        out.push(...(data.items ?? []));
      }
      return out;
    },

    async pageBoardItems(boardId, columnIds, onPage) {
      const first = await query<{ boards: { items_page: { cursor: string | null; items: MondayItemRaw[] } }[] }>(
        `query ($boardId: [ID!], $columnIds: [String!]) {
           boards(ids: $boardId) { items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } } } }`,
        { boardId: [boardId], columnIds },
      );
      let page = first.boards?.[0]?.items_page;
      while (page) {
        await onPage(page.items ?? []);
        if (!page.cursor) break;
        const next = await query<{ next_items_page: { cursor: string | null; items: MondayItemRaw[] } }>(
          `query ($cursor: String!, $columnIds: [String!]) {
             next_items_page(cursor: $cursor, limit: 500) { cursor items { ${ITEM_FIELDS} } } }`,
          { cursor: page.cursor, columnIds },
        );
        page = next.next_items_page;
      }
    },

    async getColumnLabels(boardId, columnId) {
      // `settings` (JSON) — the older `settings_str` is gone from current API versions.
      const data = await query<{ boards: { columns: { id: string; settings: unknown }[] }[] }>(
        `query ($boardId: [ID!], $columnId: [String!]) { boards(ids: $boardId) { columns(ids: $columnId) { id settings } } }`,
        { boardId: [boardId], columnId: [columnId] },
      );
      const col = data.boards?.[0]?.columns?.[0];
      if (!col) throw new Error(`Column ${columnId} not found on board ${boardId}`);
      return parseColumnLabels(col.settings);
    },

    async listWebhooks(boardId) {
      const data = await query<{ webhooks: MondayWebhook[] }>(
        `query ($boardId: ID!) { webhooks(board_id: $boardId) { id event board_id config } }`,
        { boardId },
      );
      return data.webhooks ?? [];
    },

    async changeColumnValues(boardId, itemId, values) {
      await query(
        `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values, create_labels_if_missing: false) { id } }`,
        { boardId, itemId, values: JSON.stringify(values) },
      );
    },

    async createItem(boardId, groupId, name, values) {
      const data = await query<{ create_item: { id: string } }>(
        `mutation ($boardId: ID!, $groupId: String, $name: String!, $values: JSON) {
           create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $values, create_labels_if_missing: false) { id } }`,
        { boardId, groupId, name, values: JSON.stringify(values) },
      );
      return data.create_item.id;
    },

    async moveItemToGroup(itemId, groupId) {
      await query(`mutation ($itemId: ID!, $groupId: String!) { move_item_to_group(item_id: $itemId, group_id: $groupId) { id } }`, { itemId, groupId });
    },

    async archiveItem(itemId) {
      await query(`mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`, { itemId });
    },

    async createUpdate(itemId, body, mentionUserIds = []) {
      await query(
        `mutation ($itemId: ID!, $body: String!, $mentions: [UpdateMention]) {
           create_update(item_id: $itemId, body: $body, mentions_list: $mentions) { id } }`,
        { itemId, body, mentions: mentionUserIds.map((id) => ({ id, type: 'User' })) },
      );
    },

    async createNotification(userId, itemId, text) {
      await query(
        `mutation ($userId: ID!, $itemId: ID!, $text: String!) {
           create_notification(user_id: $userId, target_id: $itemId, text: $text, target_type: Project) { text } }`,
        { userId, itemId, text },
      );
    },

    async createWebhook(boardId, url, event, config) {
      const data = await query<{ create_webhook: { id: string } }>(
        `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
           create_webhook(board_id: $boardId, url: $url, event: $event, config: $config) { id } }`,
        { boardId, url, event, config: config ? JSON.stringify(config) : null },
      );
      return data.create_webhook.id;
    },
  };
}
