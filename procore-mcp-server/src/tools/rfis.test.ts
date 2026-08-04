import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRfi } from './rfis.js';

// Real payload shape captured from the Procore sandbox (list_rfis).
const SANDBOX_RFI = {
  id: 106458,
  number: 1,
  full_number: '1',
  subject: 'Test RFI',
  status: 'open',
  due_date: '2026-08-07',
  ball_in_court: { name: 'API Support (Procore (Test Companies))' },
  created_at: '2026-08-04T19:18:04Z',
  updated_at: '2026-08-04T19:18:04Z',
};

test('normalizeRfi maps the real sandbox RFI payload', () => {
  const r = normalizeRfi(SANDBOX_RFI);
  assert.equal(r.rfi_id, 106458);
  assert.equal(r.number, '1');
  assert.equal(r.subject, 'Test RFI');
  assert.equal(r.status, 'open');
  assert.equal(r.due_date, '2026-08-07');
  assert.equal(r.ball_in_court, 'API Support (Procore (Test Companies))');
  assert.equal(r.updated_at, '2026-08-04T19:18:04Z');
});

test('normalizeRfi falls back to numeric number when full_number is absent', () => {
  const r = normalizeRfi({ id: 5, number: 42, subject: 'x' });
  assert.equal(r.number, '42');
});
