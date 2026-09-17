# Spec: Replace Project Tools MCP placeholder auth with OAuth 2.1

**Status:** Ready for implementation
**Target repo:** Instrata Project Tools (Fly.io app `instrata-project-tools-mcp`)
**Audience:** Code session implementing this end to end

---

## 1. Context

The Project Tools MCP server currently authenticates with a placeholder scheme: a per-user token generated inside Project Tools, passed either in the URL path (`/mcp/instrata_mcp_<token>`) or as a static `Authorization: Bearer` header. This was always a stand-in.

It no longer works with claude.ai custom connectors:

- claude.ai custom connectors support OAuth (DCR, CIMD, or admin-entered client ID/secret) or no auth. Static request headers exist only as an org-admin-entered, org-wide credential in a rollout-by-request beta. Neither fits a per-user token.
- Credentials in the URL are explicitly discouraged by Anthropic and prohibited by the MCP authorization spec.
- The current server returns `401` without OAuth discovery metadata, so when the connector is added, Claude starts OAuth discovery, finds nothing, and the connect fails.

The server also now includes **write tools** (cutsheet submittal generation), which makes per-user identity and audit non-negotiable.

## 2. Goal

Make Project Tools its **own OAuth 2.1 authorization server** for the MCP endpoint, so that:

1. An Instrata admin can add the connector in claude.ai Enterprise with no special beta or manual credential entry.
2. Each user clicks Connect, signs in with their existing Project Tools account, consents, and gets tokens tied to their identity.
3. Every MCP tool call executes as that user — same permissions and audit trail as today's per-user token.
4. The same server works unchanged from Claude Code, Claude Desktop, Cowork, and MCP Inspector.

Project Tools already has per-user identity, so no third-party IdP is required. Do not introduce Auth0/Clerk/etc. unless the codebase already has one wired in (see Open Questions).

## 3. Non-goals

- Enterprise Managed Auth / SSO identity assertions (later, if ever).
- Directory listing / Anthropic review submission. This is a private custom connector.
- Changing any tool schemas or tool behavior. Auth only.
- Multi-tenant per-customer URLs. One universal URL.

## 4. Target architecture

```
claude.ai / Claude Code
        │
        │ 1. POST /mcp (no token)        → 401 + WWW-Authenticate: Bearer resource_metadata=...
        │ 2. GET /.well-known/oauth-protected-resource      → PRM doc (points at AS = same origin)
        │ 3. GET /.well-known/oauth-authorization-server    → AS metadata
        │ 4. POST /oauth/register (DCR)                      → client_id   (skipped if admin supplied client_id)
        │ 5. Browser → GET /oauth/authorize?...&code_challenge=... → Project Tools login + consent screen
        │ 6. 302 → https://claude.ai/api/mcp/auth_callback?code=...&state=...
        │ 7. POST /oauth/token (form-urlencoded, code + code_verifier) → access_token, refresh_token
        │ 8. POST /mcp  Authorization: Bearer <access_token>  → tools/list, tools/call as that user
        ▼
Project Tools (Fly.io) — MCP endpoint + OAuth AS + existing user store
```

Everything lives on one origin (`https://instrata-project-tools-mcp.fly.dev` or a custom domain — see Open Questions). No redirects anywhere in the flow.

## 5. Requirements

### 5.1 MCP endpoint (`/mcp`)

- Transport: **Streamable HTTP** at exactly `POST /mcp` (and `GET /mcp` for SSE streams if the SDK supports it). No trailing-slash variants that redirect.
- Unauthenticated or invalid-token request → **`401`** with:
  ```
  WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
  ```
  This must be an HTTP 401, not a 200 with a tool error and not a JSON-RPC error. Claude ignores `WWW-Authenticate` on a 200.
- Valid token → resolve token to a Project Tools user, attach that user to the request context, and run tools/list + tools/call with that user's permissions. Every existing "who is the caller" lookup that today reads the placeholder token must read from this context instead.
- Expired token → `401` with `error="invalid_token"` in `WWW-Authenticate`. Claude refreshes reactively on 401.

### 5.2 Protected Resource Metadata (RFC 9728)

Serve at **`GET /.well-known/oauth-protected-resource`** (root-level route; also serve `/.well-known/oauth-protected-resource/mcp` returning the same doc as a fallback):

```json
{
  "resource": "https://<host>/mcp",
  "authorization_servers": ["https://<host>"],
  "scopes_supported": ["mcp:read", "mcp:write", "offline_access"],
  "bearer_methods_supported": ["header"]
}
```

`resource` must match the MCP URL **exactly as entered in Claude**, including path. Lock this down to a single canonical URL.

### 5.3 Authorization Server Metadata (RFC 8414)

Serve at **`GET /.well-known/oauth-authorization-server`**:

```json
{
  "issuer": "https://<host>",
  "authorization_endpoint": "https://<host>/oauth/authorize",
  "token_endpoint": "https://<host>/oauth/token",
  "registration_endpoint": "https://<host>/oauth/register",
  "revocation_endpoint": "https://<host>/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "scopes_supported": ["mcp:read", "mcp:write", "offline_access"],
  "client_id_metadata_document_supported": true
}
```

Notes:
- `code_challenge_methods_supported: ["S256"]` is required. PKCE S256 is mandatory on every authorization request; reject requests without a `code_challenge`.
- `"none"` in `token_endpoint_auth_methods_supported` is required — Claude registers as a **public client** via DCR/CIMD.
- `client_id_metadata_document_supported: true` + `"none"` enables CIMD, which Claude Code uses (`https://claude.ai/oauth/claude-code-client-metadata`). Implement CIMD: if `client_id` is an `https://` URL, fetch it, validate `redirect_uris`, cache it. If that's too much for v1, drop the flag and DCR alone will still work for Claude Code — but CIMD is preferred.
- `offline_access` in `scopes_supported` causes Claude to request it and expect a refresh token.

### 5.4 Dynamic Client Registration (RFC 7591) — `POST /oauth/register`

- Accept `application/json`.
- Store: `client_id` (generate), `client_name`, `redirect_uris`, `grant_types`, `token_endpoint_auth_method`.
- Return `201` with `client_id`, and echo the registered metadata. No `client_secret` for public clients.
- Validate `redirect_uris` against the allowlist in 5.7. Reject anything else.
- Traffic is tiny (one Instrata org), so DCR churn is not a concern. Still, add a nightly job that deletes registered clients with no issued tokens older than 7 days.

### 5.5 Authorization endpoint — `GET /oauth/authorize`

Params: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, optional `resource`.

Behavior:
1. Validate `client_id` exists (DCR record, CIMD document, or admin pre-registered client) and `redirect_uri` is one of its registered URIs (exact match, except loopback — see 5.7).
2. Require `code_challenge` + `code_challenge_method=S256`; else `400 invalid_request`.
3. If no Project Tools session → show the **existing Project Tools login**, then return here.
4. Show a **consent screen**: app name, requested scopes in plain language ("Read your Project Tools projects", "Create cutsheet submittals on your behalf"), the redirect hostname (MCP spec requires displaying it; warn if it's a loopback address), Allow / Deny.
5. On Allow: issue a one-time authorization code (opaque, 10-minute TTL) bound to `client_id`, `redirect_uri`, `code_challenge`, `scope`, and the `user_id`. Redirect to `redirect_uri?code=...&state=...`.
6. On Deny: redirect with `error=access_denied&state=...`.

### 5.6 Token endpoint — `POST /oauth/token`

- **Must accept `Content-Type: application/x-www-form-urlencoded`.** Claude sends this for both code exchange and refresh. Verify the framework's body parser handles it (this is the classic `415` failure).
- `grant_type=authorization_code`: verify code unused/unexpired, `client_id` matches, `redirect_uri` matches, `S256(code_verifier) == code_challenge`. Burn the code. Issue tokens.
- `grant_type=refresh_token`: verify refresh token, **rotate it** (issue a new refresh token and invalidate the old one in the same response), issue a new access token.
- Errors use RFC 6749 codes exactly: `invalid_grant` for bad/expired/reused codes and dead refresh tokens (Claude keys refresh failure handling on this), `invalid_client`, `invalid_request`, `unsupported_grant_type`.
- Response:
  ```json
  { "access_token": "...", "token_type": "Bearer", "expires_in": 3600,
    "refresh_token": "...", "scope": "mcp:read mcp:write offline_access" }
  ```
- Tokens are opaque random strings (≥ 32 bytes, URL-safe), stored hashed (SHA-256). JWTs are acceptable if the codebase already has a signing setup, but opaque is simpler to revoke.
- Access token TTL: 1 hour. Refresh token TTL: 30 days sliding, rotate on use.
- Latency budget: Claude times out discovery/registration/token at **10 s** and refresh at **30 s**. Target < 500 ms. No synchronous downstream calls (D-Tools, etc.) in any OAuth handler.

### 5.7 Redirect URI allowlist

Accept exactly:

- `https://claude.ai/api/mcp/auth_callback` — claude.ai web, Desktop, mobile, Cowork
- `http://localhost/callback` and `http://127.0.0.1/callback` **with any port** — Claude Code (RFC 8252 loopback; compare scheme + host + path, ignore port)
- Anything registered via DCR/CIMD *that also matches one of the above patterns*

Reject all others with `400 invalid_request`.

### 5.8 Revocation (optional but cheap) — `POST /oauth/revoke`

RFC 7009. Accept `token` + optional `token_type_hint`. Always return `200`. Also expose "Disconnect Claude" in the Project Tools user settings UI that revokes all tokens for that user.

### 5.9 Admin pre-registered client (belt and suspenders)

Add a way (env var or admin UI) to pre-register a fixed `client_id` (+ optional `client_secret`) with the claude.ai redirect URI. The Instrata admin can paste these into the connector's Advanced settings, which bypasses DCR entirely and gives a stable per-org client. This is the fallback if DCR misbehaves in the enterprise connector flow.

## 6. Data model

New tables (or equivalent in whatever the app uses):

| Table | Key fields |
|---|---|
| `oauth_clients` | `client_id` PK, `client_secret_hash` nullable, `client_name`, `redirect_uris[]`, `token_endpoint_auth_method`, `source` (`dcr` \| `cimd` \| `admin`), `created_at` |
| `oauth_auth_codes` | `code_hash` PK, `client_id`, `user_id`, `redirect_uri`, `code_challenge`, `scope`, `expires_at`, `used_at` nullable |
| `oauth_access_tokens` | `token_hash` PK, `client_id`, `user_id`, `scope`, `expires_at`, `revoked_at` nullable |
| `oauth_refresh_tokens` | `token_hash` PK, `client_id`, `user_id`, `scope`, `expires_at`, `revoked_at` nullable, `replaced_by` nullable |

`user_id` references the existing Project Tools user. Nothing in the existing user model changes.

## 7. Removing the placeholder auth

- Delete the `/mcp/instrata_mcp_<token>` path route and the static-bearer lookup against the per-user Project Tools token table.
- Keep the UI that *generated* those tokens only if it's used for something other than MCP; otherwise remove it and replace with the "Connected apps / Disconnect Claude" view from 5.8.
- Any code that keys audit records or permissions off the old token must now key off the OAuth token's `user_id`. Grep for every reference to the old token before deleting.
- Do a single hard cutover. There is one user on the connector today; no dual-auth period needed.

## 8. Hosting and network (Fly.io)

- **No redirects** on any endpoint in this spec. Check specifically: `http→https` (Fly handles this at the edge — confirm `force_https` doesn't produce a 301 on the MCP POST), trailing slashes, and `www`/apex. A redirect drops the `Authorization` header on hosted Claude and is the most common "works in Inspector, fails in claude.ai" cause.
- `/.well-known/*` must be served at the origin root by this app, not a platform default.
- Anthropic egress is `160.79.104.0/21`. No WAF/allowlist in front of Fly should block it, including for the `.well-known` and `/oauth/*` paths.
- Machines must not be set to auto-stop such that cold start pushes the token endpoint past 10 s. Set `min_machines_running = 1` or verify cold start is well under budget.
- All OAuth secrets/salts via Fly secrets, not committed config.

## 9. Security requirements

- PKCE S256 required on every authorization request; no plain, no optional.
- Authorization codes: single use, 10-min TTL, bound to client + redirect_uri + code_challenge.
- Refresh tokens rotated on every use; reuse of a rotated token revokes the whole family.
- All tokens and codes stored hashed. Never log token values (mask in request logs).
- `state` is passed through untouched and never inspected.
- Consent screen shows the redirect hostname; extra warning when only loopback URIs are registered.
- Scopes enforced at tool dispatch: `mcp:read` for read tools, `mcp:write` for cutsheet submittal write tools. A token lacking `mcp:write` calling a write tool gets a JSON-RPC error (`-32003` or similar), not a 401.
- Rate-limit `/oauth/token` and `/oauth/register` (e.g. 30 req/min/IP).

## 10. Acceptance tests

Run these against the deployed Fly app before asking the admin to re-add the connector.

**A. Discovery**
```
curl -i -X POST https://<host>/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# expect: HTTP 401, WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
curl -i https://<host>/.well-known/oauth-protected-resource   # 200, resource == https://<host>/mcp
curl -i https://<host>/.well-known/oauth-authorization-server # 200, S256 + "none" present
```
No `3xx` anywhere in the above.

**B. Manual OAuth round trip** (script it or use Postman)
1. DCR → `client_id`
2. Generate `code_verifier`/`code_challenge`, hit `/oauth/authorize` in a browser, log in, Allow, capture `code`
3. `POST /oauth/token` as `x-www-form-urlencoded` → tokens
4. `POST /mcp` with `Authorization: Bearer <access_token>` → `initialize` succeeds, `tools/list` includes the cutsheet write tools
5. `POST /oauth/token` `grant_type=refresh_token` → new pair; old refresh token now returns `invalid_grant`
6. Replay the code from step 2 → `invalid_grant`

**C. Real clients**
- MCP Inspector: full connect + tools/list.
- Claude Code: `claude mcp add --transport http project-tools https://<host>/mcp` → `/mcp` → authenticate via loopback → tools visible.
- claude.ai Enterprise: admin adds custom connector with URL only (no client ID), scoped to the user → user clicks Connect → login/consent → connector shows connected → new chat sees the full tool list including write tools.
- Repeat C3 with the admin-entered pre-registered `client_id` from 5.9.

**D. Negative**
- Old `/mcp/instrata_mcp_<token>` URL → 404.
- Missing `code_challenge` → 400.
- `redirect_uri=https://evil.example/cb` → 400.
- Token endpoint with JSON body → still works or returns a clear 400, never 415.

## 11. Rollout

1. Implement + unit tests behind a branch; deploy to a Fly preview app or the existing app with the old route still live.
2. Run tests A, B, D against preview.
3. Deploy to production, remove old route (single cutover).
4. Run test C1, C2.
5. Hand the admin the canonical MCP URL (and optional pre-registered client ID). Admin removes the broken connector and re-adds it, scoped to the user.
6. Run test C3. Confirm the cutsheet write tools appear in a fresh chat.

## 12. Open questions for the code session to resolve from the repo

- What framework/language is the MCP server? Prefer the official MCP SDK's Streamable HTTP transport for that language plus a small hand-rolled OAuth AS (the surface above is ~6 endpoints) over pulling in a heavyweight OAuth library — unless the app already has one.
- Is the MCP server the same process/app as the Project Tools web app (shared session cookies for the login step), or a separate Fly app? If separate, the authorize endpoint needs a way to authenticate the user — either proxy to the main app's login or share the session store. Same-origin is strongly preferred.
- Is `instrata-project-tools-mcp.fly.dev` the permanent URL, or should this go behind a custom Instrata domain now (changing the URL later means the admin re-adds the connector and everyone reconnects)?
- Does the existing per-user token power anything besides MCP?
- Existing DB: relational or KV? Adjust §6 accordingly.
