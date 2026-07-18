/**
 * Resolves a fresh Procore access token for a given user, transparently
 * refreshing when the stored one is near expiry. This is the single point every
 * Procore API call goes through, so per-user token isolation is enforced in one
 * place: a token is only ever fetched by the caller's own user id.
 */
import type { Request } from 'express';
import type { TokenStore, ProcoreTokenRecord } from '../store/tokenStore.js';
import type { ProcoreOAuth } from './procoreOAuth.js';
import { NotConnectedError, ReconnectRequiredError } from '../errors.js';

const REFRESH_MARGIN_MS = 30_000;

export class ProcoreSession {
  constructor(
    private readonly tokens: TokenStore,
    private readonly oauth: ProcoreOAuth,
  ) {}

  /** A valid access token for `userId`, refreshing if needed. Throws if unconnected. */
  async accessTokenFor(userId: string): Promise<string> {
    const rec = await this.tokens.get(userId);
    if (!rec) throw new NotConnectedError();
    if (rec.expiresAt > Date.now() + REFRESH_MARGIN_MS) return rec.accessToken;

    try {
      const fresh = await this.oauth.refresh(rec.refreshToken);
      await this.tokens.put({
        ...rec,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
      });
      return fresh.accessToken;
    } catch {
      // Refresh token is dead — clear it so the user gets a clean reconnect prompt.
      await this.tokens.delete(userId);
      throw new ReconnectRequiredError();
    }
  }

  /** Stored identity/metadata for whoami; null if not connected. */
  identity(userId: string): Promise<ProcoreTokenRecord | null> {
    return this.tokens.get(userId);
  }
}

/** Extract the authenticated user id set by requireBearerAuth → verifyAccessToken. */
export function getUserId(req: Request): string {
  const userId = req.auth?.extra?.userId;
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('Authenticated request is missing a user id.');
  }
  return userId;
}
