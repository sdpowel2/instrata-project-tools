import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from './text.js';

test('plain text passes through when under the limit', async () => {
  const buf = Buffer.from('hello world\nsecond line');
  const r = await extractText(buf, 'note.txt', 'text/plain', 1_000_000);
  assert.equal(r.extracted, true);
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hello world\nsecond line');
});

test('text is truncated to max_chars', async () => {
  const buf = Buffer.from('x'.repeat(500));
  const r = await extractText(buf, 'note.txt', 'text/plain', 100);
  assert.equal(r.extracted, true);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 100);
});

test('unsupported type reports extracted:false with a note', async () => {
  const r = await extractText(Buffer.from('binary'), 'image.png', 'image/png', 1000);
  assert.equal(r.extracted, false);
  assert.ok(r.note && r.note.length > 0);
});

test('type is detected from extension when mime is absent', async () => {
  const r = await extractText(Buffer.from('a,b,c'), 'data.csv', undefined, 1000);
  assert.equal(r.extracted, true);
  assert.equal(r.text, 'a,b,c');
});
