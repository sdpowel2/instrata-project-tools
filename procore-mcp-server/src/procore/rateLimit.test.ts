import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from './rateLimit.js';

test('Semaphore never exceeds its max concurrency', async () => {
  const max = 3;
  const sem = new Semaphore(max);
  let active = 0;
  let peak = 0;

  const task = async () => {
    const release = await sem.acquire();
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    release();
  };

  await Promise.all(Array.from({ length: 12 }, task));
  assert.ok(peak <= max, `peak ${peak} exceeded max ${max}`);
  assert.equal(active, 0);
});

test('Semaphore releasing twice is a no-op (no slot leak)', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release(); // double release must not free an extra slot
  let concurrent = 0;
  let peak = 0;
  const task = async () => {
    const r = await sem.acquire();
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((res) => setTimeout(res, 5));
    concurrent--;
    r();
  };
  await Promise.all([task(), task(), task()]);
  assert.equal(peak, 1);
});
