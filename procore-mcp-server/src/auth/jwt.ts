/**
 * Signs and verifies the short-lived access tokens THIS server issues to Claude
 * (Layer 1). Stateless HS256 JWTs — verification needs no store lookup, so they
 * survive restarts. `sub` is our user id (= Procore user id).
 */
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const key = new TextEncoder().encode(config.sessionSecret);

export type AccessClaims = {
  userId: string;
  clientId: string;
  scope?: string;
  resource?: string;
  exp?: number;
};

export async function signAccessJwt(p: {
  userId: string;
  clientId: string;
  resource?: string;
}): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = config.accessTokenTtlSeconds;
  const token = await new SignJWT({
    client_id: p.clientId,
    scope: 'procore',
    ...(p.resource ? { resource: p.resource } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(p.userId)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(key);
  return { token, expiresIn };
}

export async function verifyAccessJwt(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key);
  return {
    userId: String(payload.sub),
    clientId: String(payload.client_id ?? ''),
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    resource: typeof payload.resource === 'string' ? payload.resource : undefined,
    exp: payload.exp,
  };
}
