/**
 * Opaque token generation + hashing. Tokens are 32 random bytes, base64url,
 * with a short prefix so they're recognisable in (masked) logs. Only the
 * SHA-256 hex hash is ever stored or looked up.
 */
import { createHash, randomBytes } from 'node:crypto';

export type TokenKind = 'pt_at' | 'pt_rt' | 'pt_ac'; // access, refresh, auth code

export function randomToken(kind: TokenKind): string {
  return `${kind}_${randomBytes(32).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** For log lines: never print a whole token. */
export function maskToken(value: string): string {
  return value.length <= 12 ? '***' : `${value.slice(0, 8)}…${value.slice(-4)}`;
}
