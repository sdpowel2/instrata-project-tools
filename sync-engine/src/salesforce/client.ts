/**
 * Salesforce REST client, authenticated with the OAuth 2.0 Client Credentials
 * flow against the External Client App (runs as the integration user, spec §9).
 *
 * patchLineItem is a WRITE and must only be called through the writeGate.
 */
import { LINE_ITEM_MARGIN_FIELD, assertSfId, lineItemQuery, mapOpportunity, opportunityQuery } from './soql.ts';
import type { SfOpportunity } from '../reconcile/types.ts';

export interface SfLineItemState {
  Id: string;
  OpportunityId: string;
  UnitPrice: number | null;
  Quantity: number | null;
  Sold_in_Margin__c: number | null;
}

export interface SalesforceClient {
  query<T = any>(soql: string): Promise<T[]>;
  queryAll<T = any>(soql: string): Promise<T[]>;
  /** Opportunities by id (any count; batched). Ids that don't come back are deleted / invisible. */
  getOpportunities(ids: string[]): Promise<Map<string, SfOpportunity>>;
  getLineItem(id: string): Promise<SfLineItemState | null>;
  picklistValues(object: string, field: string): Promise<string[]>;
  // Write — writeGate only
  patchLineItem(id: string, values: { UnitPrice?: number; [LINE_ITEM_MARGIN_FIELD]?: number }): Promise<void>;
}

interface Token {
  accessToken: string;
  instanceUrl: string;
}

export function createSalesforceClient(opts: {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}): SalesforceClient {
  const doFetch = opts.fetchImpl ?? fetch;
  let token: Token | null = null;

  async function authenticate(): Promise<Token> {
    const res = await doFetch(`${opts.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: opts.clientId, client_secret: opts.clientSecret }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`Salesforce auth failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
    }
    token = { accessToken: json.access_token, instanceUrl: json.instance_url };
    return token;
  }

  /** One request, re-authenticating once on 401 (expired / revoked session). */
  async function request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = token ?? (await authenticate());
      const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${t.instanceUrl}${pathOrUrl}`;
      const res = await doFetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      return res;
    }
    throw new Error('unreachable');
  }

  async function failText(res: Response): Promise<string> {
    const body = await res.text().catch(() => '');
    return `Salesforce ${res.status}: ${body.slice(0, 800)}`;
  }

  async function runQuery<T>(endpoint: 'query' | 'queryAll', soql: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `/services/data/v${opts.apiVersion}/${endpoint}?q=${encodeURIComponent(soql)}`;
    while (next) {
      const res = await request(next);
      if (!res.ok) throw new Error(await failText(res));
      const json: any = await res.json();
      out.push(...(json.records ?? []));
      next = json.done ? null : json.nextRecordsUrl;
    }
    return out;
  }

  return {
    query: (soql) => runQuery('query', soql),
    queryAll: (soql) => runQuery('queryAll', soql),

    async getOpportunities(ids) {
      const unique = [...new Set(ids)];
      const out = new Map<string, SfOpportunity>();
      for (let i = 0; i < unique.length; i += 100) {
        const records = await runQuery<any>('query', opportunityQuery(unique.slice(i, i + 100)));
        for (const r of records) {
          // A parent with >200 children paginates the subquery — not realistic for
          // AV-filtered lines, but never silently truncate.
          if (r.OpportunityLineItems && r.OpportunityLineItems.done === false) {
            throw new Error(`Opportunity ${r.Id}: line-item subquery paginated; refusing a partial read`);
          }
          out.set(r.Id, mapOpportunity(r));
        }
      }
      return out;
    },

    async getLineItem(id) {
      const rows = await runQuery<any>('query', lineItemQuery(id));
      const r = rows[0];
      return r
        ? { Id: r.Id, OpportunityId: r.OpportunityId, UnitPrice: r.UnitPrice ?? null, Quantity: r.Quantity ?? null, Sold_in_Margin__c: r[LINE_ITEM_MARGIN_FIELD] ?? null }
        : null;
    },

    async picklistValues(object, field) {
      const res = await request(`/services/data/v${opts.apiVersion}/sobjects/${encodeURIComponent(object)}/describe`);
      if (!res.ok) throw new Error(await failText(res));
      const json: any = await res.json();
      const f = (json.fields ?? []).find((x: any) => x.name === field);
      return (f?.picklistValues ?? []).filter((p: any) => p.active).map((p: any) => String(p.value));
    },

    async patchLineItem(id, values) {
      const res = await request(`/services/data/v${opts.apiVersion}/sobjects/OpportunityLineItem/${assertSfId(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      if (res.status !== 204 && !res.ok) throw new Error(await failText(res));
    },
  };
}
