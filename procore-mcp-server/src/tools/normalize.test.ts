import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personName, ballInCourt, withinSince, firstStr } from './normalize.js';

test('personName reads name, first/last, login, or string', () => {
  assert.equal(personName('Dev Dev'), 'Dev Dev');
  assert.equal(personName({ name: 'Jane Roe' }), 'Jane Roe');
  assert.equal(personName({ first_name: 'John', last_name: 'Doe' }), 'John Doe');
  assert.equal(personName({ login: 'x@y.com' }), 'x@y.com');
  assert.equal(personName(undefined), undefined);
});

test('ballInCourt handles a single party, an array, and Procore-style names', () => {
  // Real sandbox shape captured from get_rfi.
  assert.equal(ballInCourt({ name: 'API Support (Procore (Test Companies))' }), 'API Support (Procore (Test Companies))');
  assert.equal(ballInCourt([{ name: 'A' }, { name: 'B' }]), 'A, B');
  assert.equal(ballInCourt(null), undefined);
});

test('withinSince keeps items on/after the bound and passes undefined dates', () => {
  const since = '2026-07-21T00:00:00Z';
  assert.equal(withinSince('2026-08-04T19:18:04Z', since), true);
  assert.equal(withinSince('2026-01-01T00:00:00Z', since), false);
  assert.equal(withinSince(undefined, since), true);
});

test('firstStr returns the first non-empty string', () => {
  assert.equal(firstStr(undefined, '', 'hit', 'miss'), 'hit');
  assert.equal(firstStr(undefined, ''), undefined);
});
