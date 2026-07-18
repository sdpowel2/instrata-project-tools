import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './paginator.js';
import type { ProcoreClient } from './client.js';

/** Fake client that serves fixed pages and an optional Total header. */
function fakeClient(pages: number[][], total?: number): ProcoreClient {
  let call = 0;
  return {
    async getRaw<T>() {
      const body = (pages[call] ?? []) as T;
      call++;
      const headers = new Headers();
      if (total !== undefined) headers.set('Total', String(total));
      return { res: new Response(null, { headers }), body };
    },
  } as unknown as ProcoreClient;
}

const nums = (n: number, start = 0) => Array.from({ length: n }, (_, i) => start + i);

test('single short page → all items, hasMore false', async () => {
  const { items, hasMore } = await paginate<number>(fakeClient([nums(5)], 5), '/x', {}, 25);
  assert.deepEqual(items, nums(5));
  assert.equal(hasMore, false);
});

test('full page with a larger Total → hasMore true', async () => {
  const { items, hasMore } = await paginate<number>(fakeClient([nums(25)], 40), '/x', {}, 25);
  assert.equal(items.length, 25);
  assert.equal(hasMore, true);
});

test('walks multiple pages up to limit', async () => {
  // limit 150 → perPage 100; page1 full (100), page2 short (60) → 160 collected, sliced to 150.
  const client = fakeClient([nums(100), nums(60, 100)], 160);
  const { items, hasMore } = await paginate<number>(client, '/x', {}, 150);
  assert.equal(items.length, 150);
  assert.deepEqual(items.slice(0, 3), [0, 1, 2]);
  assert.equal(hasMore, true); // 160 total > 150 returned
});

test('no Total header → falls back to overflow heuristic', async () => {
  const { items, hasMore } = await paginate<number>(fakeClient([nums(10)]), '/x', {}, 10);
  assert.equal(items.length, 10);
  assert.equal(hasMore, false); // short page, nothing beyond
});
