/**
 * OAuthServerProvider implementation for the MCP SDK's authorization-server
 * handlers. The SDK does the protocol work (PKCE verification, grant-type
 * dispatch, error formatting); this class does the state work against
 * Supabase and decides what a token means.
 *
 * Token lifecycle (spec §5.6, §9):
 *   - auth code: opaque, 10 min, single use, bound to client + redirect_uri +
 *     PKCE challenge + user + scope (+ resource)
 *   - access token: opaque, 1 h
 *   - refresh token: opaque, 30 d sliding, rotated on every use; replaying a
 *     rotated token revokes the whole family
 *   - everything stored hashed (sha256)
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InsufficientScopeError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { ProjectToolsClientsStore } from './clients.js';
import { renderConsentPage } from './consent.js';
import { MCP_RESOURCE_URL } from './metadata.js';
import { isSubset, parseScopes, resolveRequestedScopes, unsupportedScopes } from './scopes.js';
import {
  consumeAuthCode,
  getAccessToken,
  getRefreshToken,
  insertAccessToken,
  insertRefreshToken,
  peekAuthCode,
  revokeAccessToken,
  revokeFamily,
  rotateRefreshToken,
  touchAccessToken,
  touchClient,
} from './store.js';
import { randomToken, sha256Hex } from './tokens.js';

interface Grant {
  clientId: string;
  userId: string;
  scope: string; // space-separated, already validated
  resource: string | null;
}

/** Two resource indicators are the same if they're the same URL minus fragment. */
function sameResource(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // nothing to compare
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.href === ub.href;
  } catch {
    return a === b;
  }
}

export class ProjectToolsOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ProjectToolsClientsStore();

  // ── Authorization (spec §5.5) ───────────────────────────────────────────────

  /**
   * The SDK has already validated client_id, redirect_uri, response_type and
   * PKCE. We validate scopes, then hand the browser our login + consent page;
   * POST /oauth/consent (consent.ts) finishes the flow.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = resolveRequestedScopes(params.scopes);
    const bad = unsupportedScopes(scopes);
    if (bad.length > 0) {
      throw new InvalidScopeError(`Unsupported scope(s): ${bad.join(' ')}`); // SDK redirects with error=invalid_scope
    }
    if (params.resource && !sameResource(params.resource.href, MCP_RESOURCE_URL)) {
      throw new InvalidTargetError(`This authorization server only issues tokens for ${MCP_RESOURCE_URL}`);
    }
    renderConsentPage(res, { client, params, scopes });
  }

  // ── Authorization-code exchange (spec §5.6) ─────────────────────────────────

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await peekAuthCode(sha256Hex(authorizationCode));
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or already used');
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE already verified by the SDK (skipLocalPkceValidation is false)
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await consumeAuthCode(sha256Hex(authorizationCode));
    if (!row) throw new InvalidGrantError('Authorization code is invalid, expired, or already used');
    if (row.client_id !== client.client_id) throw new InvalidGrantError('Authorization code was issued to a different client');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && !sameResource(resource.href, row.resource ?? MCP_RESOURCE_URL)) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }
    return this.issueTokens({ clientId: row.client_id, userId: row.user_id, scope: row.scope, resource: row.resource });
  }

  // ── Refresh (spec §5.6, rotation + reuse detection) ─────────────────────────

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const oldHash = sha256Hex(refreshToken);

    // Pre-checks that need the original grant. The RPC below is the atomic
    // step; a race here just means one of two callers gets invalid_grant.
    const existing = await getRefreshToken(oldHash);
    if (!existing) throw new InvalidGrantError('Refresh token is invalid or expired');
    if (existing.client_id !== client.client_id) throw new InvalidGrantError('Refresh token was issued to a different client');
    if (resource && !sameResource(resource.href, existing.resource ?? MCP_RESOURCE_URL)) {
      throw new InvalidTargetError('resource does not match the original grant');
    }
    let scope: string | undefined;
    if (scopes && scopes.length > 0) {
      const requested = parseScopes(scopes);
      if (!isSubset(requested, parseScopes(existing.scope))) {
        throw new InvalidScopeError('Requested scope exceeds the original grant');
      }
      scope = requested.join(' ');
    }

    const newAccess = randomToken('pt_at');
    const newRefresh = randomToken('pt_rt');
    const now = Date.now();
    const grant = await rotateRefreshToken({
      oldHash,
      newRefreshHash: sha256Hex(newRefresh),
      newAccessHash: sha256Hex(newAccess),
      accessExpiresAt: new Date(now + config.accessTokenTtlSeconds * 1000),
      refreshExpiresAt: new Date(now + config.refreshTokenTtlSeconds * 1000),
      scope,
    });
    if (!grant) throw new InvalidGrantError('Refresh token is invalid, expired, or has been revoked');

    touchClient(grant.client_id);
    return {
      access_token: newAccess,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: newRefresh,
      scope: grant.scope,
    };
  }

  // ── Bearer verification (spec §5.1) ─────────────────────────────────────────

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = sha256Hex(token);
    const row = await getAccessToken(hash);
    if (!row || row.revoked_at) throw new InvalidTokenError('Access token is invalid or has been revoked');
    // Audience check (RFC 8707): a token minted for some other resource is not
    // valid here even if it's otherwise live.
    if (row.resource && !sameResource(row.resource, MCP_RESOURCE_URL)) {
      throw new InvalidTokenError('Access token was not issued for this resource');
    }
    const scopes = parseScopes(row.scope);
    if (!scopes.includes('mcp:read') && !scopes.includes('mcp:write')) {
      throw new InsufficientScopeError('Token grants no MCP scopes');
    }
    touchAccessToken(hash);
    return {
      token,
      clientId: row.client_id,
      scopes,
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000), // SDK middleware enforces expiry
      resource: new URL(MCP_RESOURCE_URL),
      extra: { userId: row.user_id, familyId: row.family_id },
    };
  }

  // ── Revocation (spec §5.8) ──────────────────────────────────────────────────

  /** RFC 7009: silently succeed on unknown tokens. Revoking a refresh token kills its family. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256Hex(request.token);
    const tryRefreshFirst = request.token_type_hint !== 'access_token';

    const refresh = async (): Promise<boolean> => {
      const row = await getRefreshToken(hash);
      if (!row || row.client_id !== client.client_id) return false;
      await revokeFamily(row.family_id);
      return true;
    };
    const access = async (): Promise<boolean> => {
      const row = await getAccessToken(hash);
      if (!row || row.client_id !== client.client_id) return false;
      await revokeAccessToken(hash, client.client_id);
      return true;
    };

    if (tryRefreshFirst) {
      if (!(await refresh())) await access();
    } else if (!(await access())) {
      await refresh();
    }
  }

  // ── Issuance ────────────────────────────────────────────────────────────────

  private async issueTokens(grant: Grant): Promise<OAuthTokens> {
    const scopes = parseScopes(grant.scope);
    const wantsRefresh = scopes.includes('offline_access');
    const familyId = wantsRefresh ? randomUUID() : null;
    const now = Date.now();

    const accessToken = randomToken('pt_at');
    await insertAccessToken({
      token_hash: sha256Hex(accessToken),
      client_id: grant.clientId,
      user_id: grant.userId,
      scope: grant.scope,
      resource: grant.resource,
      family_id: familyId,
      expires_at: new Date(now + config.accessTokenTtlSeconds * 1000).toISOString(),
    });

    let refreshToken: string | undefined;
    if (wantsRefresh && familyId) {
      refreshToken = randomToken('pt_rt');
      await insertRefreshToken({
        token_hash: sha256Hex(refreshToken),
        client_id: grant.clientId,
        user_id: grant.userId,
        scope: grant.scope,
        resource: grant.resource,
        family_id: familyId,
        expires_at: new Date(now + config.refreshTokenTtlSeconds * 1000).toISOString(),
      });
    }

    touchClient(grant.clientId);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: grant.scope,
    };
  }
}
