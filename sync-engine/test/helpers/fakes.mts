/** In-memory monday + Salesforce that record every call. */
import type { MondayClient, MondayItemRaw, MondayWebhook } from '../../src/monday/client.ts';
import type { SalesforceClient, SfLineItemState } from '../../src/salesforce/client.ts';
import type { SfOpportunity } from '../../src/reconcile/types.ts';

export function fakeMonday() {
  const items = new Map<string, MondayItemRaw>();
  const writes: { op: string; args: unknown[] }[] = [];
  const webhooks: (MondayWebhook & { url: string })[] = [];
  let nextId = 5000;
  let failNextChange = false;

  function setCol(it: MondayItemRaw, id: string, value: string) {
    const c = it.column_values.find((x) => x.id === id);
    if (c) c.value = value;
    else it.column_values.push({ id, value, text: null });
  }

  const client: MondayClient = {
    query: async () => { throw new Error('not used'); },
    getItems: async (ids) => ids.map((id) => items.get(id)).filter((x): x is MondayItemRaw => !!x),
    pageBoardItems: async () => {},
    getColumnLabels: async () => [],
    listWebhooks: async (boardId) => webhooks.filter((w) => w.board_id === boardId),
    async changeColumnValues(boardId, itemId, values) {
      if (failNextChange) { failNextChange = false; throw new Error('monday 500'); }
      writes.push({ op: 'change', args: [boardId, itemId, values] });
      const it = items.get(itemId);
      const v = values as Record<string, any>;
      if (it && v.status9) setCol(it, 'status9', JSON.stringify(v.status9));
    },
    async createItem(boardId, groupId, name, values) {
      const id = String(nextId++);
      writes.push({ op: 'create', args: [boardId, groupId, name, values] });
      items.set(id, { id, name, state: 'active', group: { id: groupId ?? '' }, column_values: [] });
      return id;
    },
    async moveItemToGroup(itemId, groupId) { writes.push({ op: 'move', args: [itemId, groupId] }); },
    async archiveItem(itemId) {
      writes.push({ op: 'archive', args: [itemId] });
      const it = items.get(itemId);
      if (it) it.state = 'archived';
    },
    async createUpdate(itemId, body, mentions) { writes.push({ op: 'update', args: [itemId, body, mentions] }); },
    async createNotification(userId, itemId, text) { writes.push({ op: 'notify', args: [userId, itemId, text] }); },
    async createWebhook(boardId, url, event) {
      const id = `wh${webhooks.length + 1}`;
      webhooks.push({ id, board_id: boardId, event, config: null, url });
      return id;
    },
  };

  /** A pre-sales item with the given column values. */
  function addItem(id: string, columns: Record<string, string | null> = {}, groupId = 'new_group12986') {
    items.set(id, { id, name: `Item ${id}`, state: 'active', group: { id: groupId }, column_values: Object.entries(columns).map(([cid, value]) => ({ id: cid, value, text: null })) });
  }

  return { client, items, writes, webhooks, addItem, setCol, failOnce: () => { failNextChange = true; } };
}

export function fakeSalesforce(init: { opps?: SfOpportunity[]; lineItems?: SfLineItemState[] } = {}) {
  const opps = new Map((init.opps ?? []).map((o) => [o.Id, o]));
  const lineItems = new Map((init.lineItems ?? []).map((l) => [l.Id, l]));
  const patches: { id: string; values: Record<string, number> }[] = [];
  const queries: string[] = [];
  let queryResults: Record<string, any[]> = {};
  let failGetOpportunities: Error | null = null;

  const client: SalesforceClient = {
    async query(soql) {
      queries.push(soql);
      const hit = Object.entries(queryResults).find(([needle]) => soql.includes(needle));
      return hit ? hit[1] : [];
    },
    async queryAll(soql) {
      queries.push(`ALL:${soql}`);
      const hit = Object.entries(queryResults).find(([needle]) => soql.includes(needle) && needle.includes('IsDeleted'));
      return hit ? hit[1] : [];
    },
    async getOpportunities(ids) {
      if (failGetOpportunities) throw failGetOpportunities;
      return new Map(ids.filter((id) => opps.has(id)).map((id) => [id, opps.get(id)!]));
    },
    getLineItem: async (id) => lineItems.get(id) ?? null,
    picklistValues: async () => [],
    async patchLineItem(id, values) {
      patches.push({ id, values: values as Record<string, number> });
      const li = lineItems.get(id);
      if (li) Object.assign(li, values);
    },
  };

  return {
    client, opps, lineItems, patches, queries,
    setQueryResults: (r: Record<string, any[]>) => { queryResults = r; },
    failOpportunities: (e: Error | null) => { failGetOpportunities = e; },
  };
}
