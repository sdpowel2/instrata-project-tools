/**
 * InstrataOAuthProvider — the OAuth 2.1 authorization server Claude talks to
 * (Layer 1), bridged into Procore's OAuth (Layer 2).
 *
 * Flow:
 *   1. Claude → /authorize  → authorize(): stash the pending request (incl. PKCE
 *      challenge) and redirect the user to Procore's consent screen.
 *   2. Procore → /procore/callback → handleProcoreCallback(): exchange the Procore
 *      code, read /me, persist encrypted Procore tokens keyed by the Procore user
 *      id, then redirect back to Claude with OUR authorization code.
 *   3. Claude → /token → exchangeAuthorizationCode(): SDK validates PKCE against
 *      the stored challenge; we mint our own access + refresh tokens bound to the
 *      resolved user id.
 *   4. Claude → /mcp with our access token → verifyAccessToken().
 *
 * Pending requests and one-time auth codes are short-lived and kept in memory
 * (losing them on restart only costs an in-flight login a retry). DCR clients and
 * refresh tokens are persisted in Postgres so established connections survive.
 */
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { TokenStore } from '../store/tokenStore.js';
import type { ProcoreOAuth } from './procoreOAuth.js';
import type { PgRefreshTokenStore } from './refreshStore.js';
import { signAccessJwt, verifyAccessJwt } from './jwt.js';

const PENDING_TTL_MS = 10 * 60 * 1000; // user logging into Procore
const GRANT_TTL_MS = 60 * 1000; // Claude exchanges the code immediately

type Pending = {
  clientId: string;
  claudeRedirectUri: string;
  claudeState?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
};

type Grant = {
  userId: string;
  clientId: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
};

const randomToken = () => randomBytes(32).toString('base64url');

export type ProviderDeps = {
  clients: OAuthRegisteredClientsStore;
  refreshTokens: PgRefreshTokenStore;
  procoreTokens: TokenStore;
  procore: ProcoreOAuth;
};

export class InstrataOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly deps: ProviderDeps) {
    // Evict expired pending/grant entries periodically (unref so it never holds the process open).
    setInterval(() => this.sweep(), 60_000).unref();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.deps.clients;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const linkId = randomToken();
    this.pending.set(linkId, {
      clientId: client.client_id,
      claudeRedirectUri: params.redirectUri,
      claudeState: params.state,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    res.redirect(this.deps.procore.buildAuthorizeUrl(linkId));
  }

  /** Express handler for GET /procore/callback (registered in index.ts). */
  async handleProcoreCallback(req: Request, res: Response): Promise<void> {
    const linkId = String(req.query.state ?? '');
    const p = this.pending.get(linkId);
    this.pending.delete(linkId);
    if (!p || p.expiresAt < Date.now()) {
      res.status(400).send('This authorization link has expired. Restart the connection from Claude.');
      return;
    }

    if (req.query.error) {
      this.redirectBackWithError(res, p, String(req.query.error));
      return;
    }

    try {
      const code = String(req.query.code ?? '');
      const tok = await this.deps.procore.exchangeCode(code);
      const me = await this.deps.procore.fetchMe(tok.accessToken);
      const userId = String(me.id);

      await this.deps.procoreTokens.put({
        userId,
        accessToken: tok.accessToken,
        refreshToken: tok.refreshToken,
        expiresAt: tok.expiresAt,
        procoreUserId: me.id,
        email: me.email,
        name: me.name,
      });

      const authCode = randomToken();
      this.grants.set(authCode, {
        userId,
        clientId: p.clientId,
        codeChallenge: p.codeChallenge,
        resource: p.resource,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });

      const back = new URL(p.claudeRedirectUri);
      back.searchParams.set('code', authCode);
      if (p.claudeState) back.searchParams.set('state', p.claudeState);
      res.redirect(back.href);
    } catch (err) {
      console.error('[auth] procore callback failed:', err);
      this.redirectBackWithError(res, p, 'server_error');
    }
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const g = this.grants.get(authorizationCode);
    if (!g) throw new InvalidGrantError('Unknown or expired authorization code.');
    return g.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const g = this.grants.get(authorizationCode);
    if (!g || g.expiresAt < Date.now()) {
      this.grants.delete(authorizationCode);
      throw new InvalidGrantError('Authorization code is invalid or expired.');
    }
    if (g.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client.');
    }
    this.grants.delete(authorizationCode);
    return this.issueTokens(g.userId, client.client_id, g.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = await this.deps.refreshTokens.lookup(refreshToken);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token.');
    }
    // Rotate: invalidate the used refresh token and issue a fresh pair.
    await this.deps.refreshTokens.delete(refreshToken);
    return this.issueTokens(rec.userId, client.client_id, resource?.href);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Must throw InvalidTokenError (not a raw jose error) so requireBearerAuth
    // returns 401 + WWW-Authenticate and the client refreshes/re-authorizes —
    // otherwise an expired token would surface as an unrecoverable 500.
    let claims: Awaited<ReturnType<typeof verifyAccessJwt>>;
    try {
      claims = await verifyAccessJwt(token);
    } catch {
      throw new InvalidTokenError('Access token is invalid or expired.');
    }
    let resource: URL | undefined;
    try {
      resource = claims.resource ? new URL(claims.resource) : undefined;
    } catch {
      resource = undefined;
    }
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scope ? claims.scope.split(' ') : [],
      expiresAt: claims.exp,
      resource,
      extra: { userId: claims.userId },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // We only track refresh tokens server-side; access tokens are stateless JWTs
    // that expire on their own. Deleting an unknown token is a no-op.
    await this.deps.refreshTokens.delete(request.token).catch(() => undefined);
  }

  private async issueTokens(userId: string, clientId: string, resource?: string): Promise<OAuthTokens> {
    const { token: access_token, expiresIn } = await signAccessJwt({ userId, clientId, resource });
    const refresh_token = randomToken();
    await this.deps.refreshTokens.save(refresh_token, userId, clientId);
    return { access_token, token_type: 'Bearer', expires_in: expiresIn, refresh_token, scope: 'procore' };
  }

  private redirectBackWithError(res: Response, p: Pending, error: string): void {
    try {
      const back = new URL(p.claudeRedirectUri);
      back.searchParams.set('error', error);
      if (p.claudeState) back.searchParams.set('state', p.claudeState);
      res.redirect(back.href);
    } catch {
      res.status(400).send(`Authorization failed: ${error}`);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.grants) if (v.expiresAt < now) this.grants.delete(k);
  }
}
