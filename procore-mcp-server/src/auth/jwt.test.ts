import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts fails fast on missing env, so provide the minimum before importing.
process.env.BASE_URL ??= 'http://localhost:8080';
process.env.PROCORE_CLIENT_ID ??= 'test-client';
process.env.PROCORE_CLIENT_SECRET ??= 'test-secret';
process.env.PROCORE_BASE_URL ??= 'https://sandbox.procore.com';
process.env.DATABASE_URL ??= 'postgres://localhost/test';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret';

const { signAccessJwt, verifyAccessJwt } = await import('./jwt.js');

test('signAccessJwt → verifyAccessJwt round-trips user + client + scope', async () => {
  const { token, expiresIn } = await signAccessJwt({ userId: '42', clientId: 'client-1' });
  assert.ok(expiresIn > 0);
  const claims = await verifyAccessJwt(token);
  assert.equal(claims.userId, '42');
  assert.equal(claims.clientId, 'client-1');
  assert.equal(claims.scope, 'procore');
});

test('resource claim is carried when provided', async () => {
  const { token } = await signAccessJwt({ userId: '1', clientId: 'c', resource: 'http://localhost:8080/mcp' });
  const claims = await verifyAccessJwt(token);
  assert.equal(claims.resource, 'http://localhost:8080/mcp');
});

test('verifyAccessJwt rejects a tampered token', async () => {
  const { token } = await signAccessJwt({ userId: '42', clientId: 'c' });
  const bad = `${token.slice(0, -2)}${token.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(() => verifyAccessJwt(bad));
});

test('verifyAccessJwt rejects a token signed with a different secret', async () => {
  const { token } = await signAccessJwt({ userId: '42', clientId: 'c' });
  const { SignJWT } = await import('jose');
  const forged = await new SignJWT({ client_id: 'c', scope: 'procore' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('42')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('a-different-secret'));
  assert.notEqual(token, forged);
  await assert.rejects(() => verifyAccessJwt(forged));
});
