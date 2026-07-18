/**
 * Shared paginator for Procore's page/per_page endpoints. Fetches pages until it
 * has `limit` items or a short page, and reports has_more using the `Total`
 * response header when present (falling back to a page-fullness heuristic).
 */
import type { ProcoreClient, RequestOpts } from './client.js';

const MAX_PER_PAGE = 100;

export async function paginate<T>(
  client: ProcoreClient,
  path: string,
  opts: RequestOpts,
  limit: number,
): Promise<{ items: T[]; hasMore: boolean }> {
  const perPage = Math.min(Math.max(limit, 1), MAX_PER_PAGE);
  const collected: T[] = [];
  let total: number | undefined;
  let page = 1;

  for (;;) {
    const { res, body } = await client.getRaw<T[]>(path, {
      ...opts,
      query: { ...(opts.query ?? {}), page, per_page: perPage },
    });
    const batch = Array.isArray(body) ? body : [];
    collected.push(...batch);

    const totalHeader = res.headers.get('total');
    if (totalHeader !== null && !Number.isNaN(Number(totalHeader))) total = Number(totalHeader);

    if (batch.length < perPage || collected.length >= limit) break;
    page++;
  }

  const items = collected.slice(0, limit);
  const hasMore = total !== undefined ? total > items.length : collected.length > items.length;
  return { items, hasMore };
}
