/**
 * OAuth discovery documents (spec §5.2, §5.3).
 *
 * Built by hand rather than with the SDK's createOAuthMetadata(): that helper
 * hard-codes root-level endpoint paths, can't emit
 * `client_id_metadata_document_supported`, and serves the protected-resource
 * document only at the path-suffixed URL. We need /oauth/* endpoints and the
 * PRM at the root as well.
 *
 * ISSUER has no trailing slash and must be byte-identical wherever it appears
 * (issuer, authorization_servers) — clients compare these strings.
 */
import express, { type Router } from 'express';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { SCOPES } from './scopes.js';

export const ISSUER = config.publicBaseUrl.origin;
export const MCP_RESOURCE_URL = `${ISSUER}/mcp`;
export const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource`;

export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  consent: '/oauth/consent',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
} as const;

export function authorizationServerMetadata(): OAuthMetadata {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${ISSUER}${OAUTH_PATHS.token}`,
    registration_endpoint: `${ISSUER}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${ISSUER}${OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(): OAuthProtectedResourceMetadata {
  return {
    resource: MCP_RESOURCE_URL,
    authorization_servers: [ISSUER],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Instrata Project Tools',
  };
}

/** Mount at the app root. Serves the PRM at both the root and the /mcp-suffixed path. */
export function metadataRouter(): Router {
  const router = express.Router();
  const prm = protectedResourceMetadata();
  // More specific path first: express `use` is prefix-matched.
  router.use('/.well-known/oauth-protected-resource/mcp', metadataHandler(prm));
  router.use('/.well-known/oauth-protected-resource', metadataHandler(prm));
  router.use('/.well-known/oauth-authorization-server', metadataHandler(authorizationServerMetadata()));
  return router;
}
