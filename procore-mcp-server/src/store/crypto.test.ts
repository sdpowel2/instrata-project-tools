import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadKey, seal, open } from './crypto.js';

const KEY_B64 = randomBytes(32).toString('base64');

test('loadKey accepts 32-byte base64 and hex keys', () => {
  assert.equal(loadKey(KEY_B64).length, 32);
  assert.equal(loadKey(randomBytes(32).toString('hex')).length, 32);
});

test('loadKey rejects wrong-length keys', () => {
  assert.throws(() => loadKey(randomBytes(16).toString('base64')), /32 bytes/);
});

test('seal → open round-trips arbitrary strings', () => {
  const key = loadKey(KEY_B64);
  for (const plaintext of ['', 'hello', JSON.stringify({ accessToken: 'a', refreshToken: 'b' }), '🔐 unicode ✓']) {
    assert.equal(open(key, seal(key, plaintext)), plaintext);
  }
});

test('each seal uses a fresh IV (ciphertexts differ)', () => {
  const key = loadKey(KEY_B64);
  assert.notEqual(seal(key, 'same'), seal(key, 'same'));
});

test('tampering with ciphertext fails authentication', () => {
  const key = loadKey(KEY_B64);
  const sealed = seal(key, 'secret');
  const buf = Buffer.from(sealed, 'base64');
  buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
  assert.throws(() => open(key, buf.toString('base64')));
});

test('a different key cannot open the blob', () => {
  const sealed = seal(loadKey(KEY_B64), 'secret');
  assert.throws(() => open(loadKey(randomBytes(32).toString('base64')), sealed));
});
