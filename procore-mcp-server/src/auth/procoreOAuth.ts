/**
 * Procore OAuth client (Layer 2). One Procore Developer app, Authorization Code
 * grant. Builds the consent URL, exchanges codes, refreshes tokens, and reads
 * the authenticated user's identity (/rest/v1.0/me).
 */
import { config, procoreRedirectUri } from '../config.js';

export type ProcoreTokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type ProcoreMe = { id: number; email?: string; name?: string };

/** Refresh a little before the real expiry so calls in flight don't 401. */
const EXPIRY_SAFETY_MS = 60_000;

export class ProcoreOAuth {
  /** Consent URL to redirect the user to; `state` correlates the callback. */
  buildAuthorizeUrl(state: string): string {
    const u = new URL(`${config.procoreAuthUrl}/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', config.procoreClientId);
    u.searchParams.set('redirect_uri', procoreRedirectUri);
    u.searchParams.set('state', state);
    return u.href;
  }

  exchangeCode(code: string): Promise<ProcoreTokens> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: procoreRedirectUri,
    });
  }

  refresh(refreshToken: string): Promise<ProcoreTokens> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async tokenRequest(params: Record<string, string>): Promise<ProcoreTokens> {
    const body = new URLSearchParams({
      ...params,
      client_id: config.procoreClientId,
      client_secret: config.procoreClientSecret,
    });
    const r = await fetch(`${config.procoreAuthUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      throw new Error(`Procore token request failed (${r.status}): ${detail}`);
    }
    const j = (await r.json()) as { access_token: string; refresh_token: string; expires_in?: number };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + ((j.expires_in ?? 3600) * 1000 - EXPIRY_SAFETY_MS),
    };
  }

  async fetchMe(accessToken: string): Promise<ProcoreMe> {
    const r = await fetch(`${config.procoreBaseUrl}/rest/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Procore /rest/v1.0/me failed (${r.status})`);
    const j = (await r.json()) as { id: number; login?: string; email_address?: string; name?: string };
    return { id: j.id, email: j.login ?? j.email_address, name: j.name };
  }
}
