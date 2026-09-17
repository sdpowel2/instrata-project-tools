# Implementation plan: OAuth 2.1 for the Project Tools MCP server

**Spec:** `Product Spec/project-tools-mcp-auth-spec.md`
**Written:** 2026-09-17, from a read of the repo at `dev` == `origin/main` (`277c03d`, after fast-forwarding a stale local `dev`)
**Scope:** `mcp-server/` (Fly app `instrata-project-tools-mcp`), Supabase migrations, the Settings page in `app/`, docs.

---

## 0. What the repo actually looks like (resolves spec §12)

| Spec question | Answer from the repo |
|---|---|
| Framework / language | Node 22 + TypeScript, Express 5, `@modelcontextprotocol/sdk` **1.29.0** (npm latest is 1.30.0), `jose`, `zod`, `@supabase/supabase-js`. |
| Same process as the web app? | **No.** The SPA is a static Vite build served by nginx (root `Dockerfile`, Fly app `instrata-project-tools`). The MCP server is a separate Express process (`mcp-server/`, Fly app `instrata-project-tools-mcp`). No shared cookies, no shared session store. Login is Supabase Auth email + password (`app/src/pages/Login.tsx`). |
| Permanent URL? | Today: `https://instrata-project-tools-mcp.fly.dev/mcp`, hard-coded as the default in `SettingsPage.tsx` and PROJECT_DOCS. No custom domain anywhere in the repo. **Decision needed before the production deploy** (see §9). |
| Does the old token power anything besides MCP? | **No.** `mcp_tokens` / `create_mcp_token` / `resolve_mcp_token` are referenced only by `mcp-server/src/auth.ts`, `app/src/pages/SettingsPage.tsx` (Connect Claude card), and the two migrations. Safe to remove entirely. |
| DB shape | Supabase Postgres via PostgREST. The server holds **no service-role key** by design (PROJECT_DOCS §7); it mints short-lived HS256 JWTs with the legacy secret and talks to PostgREST as a role. §6 below keeps that principle. |

What `main` has that the spec references (all confirmed present):

1. **Placeholder auth has three entry points**, all in `index.ts` and all to be removed: `Authorization: Bearer` header, `?key=` query param (`53088d9`), and the `POST /mcp/:key` path segment (`277c03d`, added specifically so claude.ai would never start OAuth discovery). `handleMcp()` is the shared handler; `GET`/`DELETE` on both `/mcp` and `/mcp/:key` return 405.
2. **Write tools exist** in `mcp-server/src/submittalTools.ts` (`63bf787`, spec `Product Spec/cutsheet-submittal-mcp-writes-spec.md`): `create_submittal`, `update_submittal`, `populate_submittal_from_bom`, `attach_cutsheet`, `detach_cutsheet`, plus the read tool `search_cutsheet_repository`. `tools.ts` gained `get_me` and now takes `userId` (`registerTools(server, supa, userId)`); `registerSubmittalTools` has the same signature. Shared helpers live in `toolHelpers.ts`. Nothing in these files reads the token; they only use the per-user Supabase client and `userId`, so they are untouched by this work apart from scope tagging (§5).
3. **CI deploys the MCP server on push to `main`** via `.github/workflows/deploy-mcp.yml` (path-filtered to `mcp-server/**`, uses the `FLY_API_TOKEN_MCP` secret). Merging to `main` is therefore the production deploy; new Fly secrets must be set **before** the merge (§10 step 8).
4. `express.json` limit is 8 MB (base64 PDFs for `attach_cutsheet`). Keep it.

One thing the spec does not mention that stays true after this work: **the legacy HS256 dependency is unchanged.** Per-user data access still works by minting a Supabase-format JWT for the resolved `user_id` (`mintUserJwt`). OAuth replaces how the caller is identified, not how the server queries Supabase as that caller. Keep the README warning.

---

## 1. Approach

**Use the SDK's built-in authorization-server framework; hand-roll only the gaps.** The installed SDK already ships (under `server/auth/`):

- `OAuthServerProvider` + `OAuthRegisteredClientsStore` interfaces (`provider.ts`, `clients.ts`).
- `authorizationHandler` (PKCE S256 required, `redirect_uri` exact-match with RFC 8252 loopback port relaxation, error redirects), `tokenHandler` (form-urlencoded parsing, PKCE verification via `pkce-challenge`, `authorization_code` + `refresh_token` grants, RFC 6749 error codes), `clientRegistrationHandler` (DCR, public clients get no secret), `revocationHandler`, `metadataHandler`.
- `requireBearerAuth` middleware: 401 + `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="..."` on missing/invalid/expired tokens, 403 `insufficient_scope`, and it sets `req.auth`, which `StreamableHTTPServerTransport` forwards to tool handlers as `extra.authInfo`.
- Per-IP rate limiting on every OAuth handler (`express-rate-limit`, configurable).

Compose the handlers ourselves instead of using the one-shot `mcpAuthRouter`, because that router hard-codes `/authorize`, `/token`, `/register`, `/revoke` at the root, serves the PRM only at `/.well-known/oauth-protected-resource/mcp`, and cannot emit `client_id_metadata_document_supported`. Composing gives the spec's `/oauth/*` paths, the root-level PRM, and full control over the metadata document while keeping all the validation logic.

**What we write ourselves:**

| Piece | Why the SDK doesn't cover it |
|---|---|
| Supabase-backed provider + client store | SDK is storage-agnostic. |
| Login + consent page and its POST handler | `provider.authorize()` is handed the Express `res` and must render whatever UI we want. |
| CIMD (`client_id` is an `https://` URL) | Server-side CIMD isn't in 1.29/1.30; implement inside `getClient()`. |
| Redirect-URI allowlist for DCR | SDK's register handler accepts any URIs; enforce in `registerClient()`. |
| Admin pre-registered client | Env-var backed entry in the client store. |
| `client_secret_basic` shim | SDK's `authenticateClient` reads `client_id`/`client_secret` from the body only. |
| Scope-gated tool registration | Tool-level, not middleware-level. |
| Cleanup job, "Connected apps" UI, migrations, docs | App-specific. |

Bump the SDK to 1.30.0 in the same change (check `server/auth/*` types are unchanged; they were stable between 1.29 and 1.30).

---

## 2. Identity during `/oauth/authorize` (the separate-app problem)

The SPA and the MCP server are different origins, so "if no session, show the existing login" cannot mean redirecting to the SPA's cookie session; there is none the MCP server can read.

**Chosen design: a single self-contained login + consent page served by the MCP server.**

1. `GET /oauth/authorize?...` → SDK validates `client_id`, `redirect_uri`, PKCE, then calls `provider.authorize(client, params, res)`.
2. `authorize()` renders one HTML page: Instrata branding, the client name (`client_name` from DCR/CIMD/admin record), the redirect hostname (with a loopback warning when the host is `localhost`/`127.0.0.1`), the requested scopes in plain language, an email + password form, and **Allow** / **Deny** buttons. All authorization params ride along as hidden fields.
3. `POST /oauth/consent` (our route, not the SDK's):
   - Re-validate everything exactly as the GET did: `getClient`, `redirectUriMatches` (exported by the SDK), `code_challenge` present, `code_challenge_method=S256`, scopes ⊆ supported.
   - **Deny** → `302 redirect_uri?error=access_denied&state=...`.
   - **Allow** → call Supabase Auth's password grant server-side (`createClient(url, anonKey).auth.signInWithPassword({ email, password })`, no session persistence). On failure, re-render the page with an error. On success take `data.user.id` as `user_id`, insert the auth code, `302 redirect_uri?code=...&state=...`.
4. No cookies, no server-side interaction state. Every submit re-authenticates, so there is no session to CSRF. This is acceptable because a user connects once per client and refresh tokens carry them for 30 days.

Why this over redirecting to the SPA: it needs zero SPA changes for the auth step, keeps the whole OAuth flow on one origin (spec §4), and reuses Supabase Auth as the identity source with no new IdP. The SPA-redirect variant (SPA posts the user's Supabase access token back to the MCP server, which verifies it) is the upgrade path if SSO/MFA ever lands; note it in the README but don't build it now.

Guardrails for the credential form: rate-limit `POST /oauth/consent` at 10/min/IP (on top of Supabase Auth's own limits), never log the body, `Cache-Control: no-store`, `autocomplete="current-password"`, and a `Referrer-Policy: no-referrer` header on the page so `state` never leaks via referrer.

---

## 3. Endpoints and routing (`mcp-server/src/index.ts`)

All paths mounted at the app root; `PUBLIC_BASE_URL` (new env, e.g. `https://instrata-project-tools-mcp.fly.dev`) is the issuer and the base for every URL below.

| Route | Handler |
|---|---|
| `GET /.well-known/oauth-authorization-server` | `metadataHandler(asMetadata)` — built from `createOAuthMetadata({ issuerUrl, baseUrl: <issuer>/oauth/, scopesSupported })`, then spread with: `token_endpoint_auth_methods_supported: ['none','client_secret_post','client_secret_basic']`, `client_id_metadata_document_supported: true`, `revocation_endpoint_auth_methods_supported: ['none','client_secret_post']`. Result matches spec §5.3 exactly. |
| `GET /.well-known/oauth-protected-resource` **and** `.../oauth-protected-resource/mcp` | Same PRM doc: `resource: <issuer>/mcp`, `authorization_servers: [<issuer>]`, `scopes_supported`, `bearer_methods_supported: ['header']`. |
| `GET|POST /oauth/authorize` | `authorizationHandler({ provider, rateLimit: { windowMs: 60_000, max: 30 } })` |
| `POST /oauth/consent` | Ours (§2). |
| `POST /oauth/token` | Basic-auth shim → `tokenHandler({ provider, rateLimit: { windowMs: 60_000, max: 30 } })`. The shim is a tiny middleware: if `Authorization: Basic` is present, decode and copy into `req.body.client_id` / `client_secret` after `express.urlencoded` has run. |
| `POST /oauth/register` | `clientRegistrationHandler({ clientsStore, clientSecretExpirySeconds: 0, rateLimit: { windowMs: 60_000, max: 30 } })` |
| `POST /oauth/revoke` | `revocationHandler({ provider })` (always 200). |
| `POST /mcp` | `requireBearerAuth({ verifier: provider, resourceMetadataUrl: <issuer>/.well-known/oauth-protected-resource })` → existing per-token rate limiter (keyed on the token hash, as today) → existing `handleMcp()` body (stateless `McpServer` + `StreamableHTTPServerTransport`), with `userId` read from `req.auth.extra.userId` instead of `resolveToken()`, and `req.auth.scopes` passed into tool registration (§5). |
| `GET /mcp`, `DELETE /mcp` | Same bearer middleware first (so an unauthenticated probe gets 401, not 405), then the existing 405. |
| ~~`POST /mcp/:key`~~, ~~`?key=`~~ | **Delete** `queryKey()`, the `/mcp/:key` POST/GET/DELETE routes, and the `bearer(req) ?? ...` fallbacks. After removal, `/mcp/instrata_mcp_...` falls through to Express's default 404 (acceptance test D1). |
| `GET /`, `GET /healthz` | Unchanged. |

Keep the global `express.json({ limit: '8mb' })`. It only parses JSON bodies, so it does not interfere with the form-urlencoded token endpoint. A JSON body posted to `/oauth/token` is parsed by it and then accepted by the SDK's zod schema, which satisfies acceptance test D4 ("still works, never 415").

Do **not** add any redirecting routes (no trailing-slash handlers, no `www`). Fly's `force_https` only 301s plain-`http` requests, which no client in the spec sends; leave it on.

---

## 4. Provider and client store (`mcp-server/src/oauth/`)

New directory:

```
src/oauth/
  provider.ts    OAuthServerProvider implementation (authorize, code exchange, refresh, verify, revoke)
  clients.ts     OAuthRegisteredClientsStore: DCR records, CIMD fetch+cache, admin env client, redirect allowlist
  store.ts       All Supabase reads/writes for oauth_* tables (via the mcp_service client, §6)
  consent.ts     HTML for the login+consent page + the POST /oauth/consent handler
  metadata.ts    AS metadata + PRM documents and their routes
  tokens.ts      randomToken() (32 bytes, base64url), sha256Hex(), TTL constants
  scopes.ts      SCOPES = ['mcp:read','mcp:write','offline_access'], plain-language labels, tool→scope map
```

**`clients.ts`**

- `REDIRECT_ALLOWLIST`: `https://claude.ai/api/mcp/auth_callback` (exact), `http://localhost/callback` and `http://127.0.0.1/callback` (any port; compare scheme + hostname + path). One helper `isAllowedRedirect(uri)` used by DCR, CIMD, and the admin client.
- `getClient(clientId)`:
  1. If `clientId === OAUTH_ADMIN_CLIENT_ID` → return the admin client built from env (`client_id`, optional `client_secret`, `redirect_uris: [claude.ai callback]`, `token_endpoint_auth_method: secret ? 'client_secret_post' : 'none'`). The SDK compares secrets in plaintext, so the secret lives only in a Fly secret, never in the DB.
  2. If `clientId` starts with `https://` → CIMD: reject non-https, fragments, loopback/private hosts (SSRF guard); check an in-memory cache (1 h TTL); otherwise `fetch` with a 5 s timeout, 64 KB cap, `Accept: application/json`; parse with the SDK's `OAuthClientMetadataSchema`; require the document's `client_id` to equal the URL; require every `redirect_uris` entry to pass `isAllowedRedirect`; upsert into `oauth_clients` with `source='cimd'`; cache and return.
  3. Else → `oauth_clients` lookup by `client_id`.
- `registerClient(info)`: require every `redirect_uris` entry to pass `isAllowedRedirect` (else throw `InvalidClientMetadataError` → 400), require `token_endpoint_auth_method` in `{none, client_secret_post}`, force `grant_types ⊆ {authorization_code, refresh_token}`, insert with `source='dcr'`, return the stored record.

**`provider.ts`**

- `authorize(client, params, res)`: render the consent page (§2). Nothing is persisted at this step.
- `challengeForAuthorizationCode(client, code)`: look up by `sha256(code)`; must be unused, unexpired, and belong to `client.client_id`; return `code_challenge`. Otherwise throw `InvalidGrantError`.
- `exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource)`: PKCE is already verified by the SDK. Atomically burn the code (RPC `oauth_consume_auth_code`, §6), check `redirect_uri` equality when supplied and `resource` equality when supplied, then issue an access token (1 h) and, if `offline_access` was granted, a refresh token (30 d) in a new `family_id`. Return `{ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token, scope }`.
- `exchangeRefreshToken(client, refreshToken, scopes, resource)`: RPC `oauth_rotate_refresh_token` (§6) does, in one transaction: find by hash; if `revoked_at`/`replaced_by` is set → revoke the whole family and throw `InvalidGrantError` (reuse detection); else mark it replaced, insert the new refresh token (new hash, same family, sliding 30 d expiry) and the new access token. Requested `scopes` must be ⊆ the original grant, else `InvalidScopeError`.
- `verifyAccessToken(token)`: lookup by hash; unknown/revoked → `InvalidTokenError`; return `{ token, clientId, scopes, expiresAt, resource, extra: { userId } }`. The SDK middleware handles the expiry check and the 401. Bump `last_used_at` fire-and-forget.
- `revokeToken(client, { token, token_type_hint })`: set `revoked_at` on whichever table matches the hash (try refresh first, then access; revoking a refresh token also revokes its family's live access tokens). Silently no-op on unknown tokens.

**Token format:** opaque, `crypto.randomBytes(32)` base64url, prefixed for log-grepping (`pt_at_`, `pt_rt_`, `pt_ac_`). Only SHA-256 hex hashes are stored. Never log the plaintext; the existing `keyFor()` in `rateLimit.ts` already hashes before keying.

---

## 5. Scope enforcement at tool dispatch (`tools.ts`)

- `scopes.ts` exports `TOOL_SCOPES: Record<string, 'mcp:read' | 'mcp:write'>`:
  - `mcp:read`: everything in `tools.ts` (`get_me`, `list_projects`, `get_project`, `get_project_bom`, `list_rfis`, `list_submittals`, `list_purchasing`, `list_milestones`, `search_catalog`, `search_vendor_contacts`, `list_project_files`, `get_project_file`) plus `search_cutsheet_repository` from `submittalTools.ts`.
  - `mcp:write`: `create_submittal`, `update_submittal`, `populate_submittal_from_bom`, `attach_cutsheet`, `detach_cutsheet`.
- Add a `grantedScopes: string[]` parameter to both `registerTools(server, supa, userId, grantedScopes)` and `registerSubmittalTools(server, supa, userId, grantedScopes)`. Each `server.registerTool(...)` call goes through a small `registerScoped(server, name, scopes, def, handler)` helper in `toolHelpers.ts` that skips registration when `TOOL_SCOPES[name]` is not granted and otherwise wraps the handler with a re-check of `extra.authInfo.scopes` (belt-and-suspenders). Tool bodies do not change.
- Because the server is built per request, `tools/list` naturally reflects the token's scopes, and a write tool called without `mcp:write` gets the SDK's standard JSON-RPC "tool not found" error, never a 401.
- Deviation from spec §9, **confirmed in the smoke test**: a write tool called without `mcp:write` returns HTTP 200 with an `isError` tool result whose text is `MCP error -32602: Tool <name> disabled`, not a top-level JSON-RPC error with `-32003`. Same intent (rejected at the JSON-RPC layer, never an HTTP 401), and it is the shape Claude surfaces to the user most cleanly. Noted in the README.
- A token with neither `mcp:read` nor `mcp:write` is rejected at `verifyAccessToken` with `InsufficientScopeError` → 403.
- `TOOL_SCOPES` is checked at startup against the registered tool names so a new tool without a scope entry fails fast rather than silently disappearing from `tools/list`.

---

## 6. Data model and database access (Supabase)

### 6.1 Tables (`supabase/migrations/add_oauth_server.sql`)

```sql
create table public.oauth_clients (
  client_id                  text primary key,
  client_name                text,
  redirect_uris              text[] not null,
  token_endpoint_auth_method text not null default 'none',
  grant_types                text[] not null default '{authorization_code,refresh_token}',
  scope                      text,
  source                     text not null check (source in ('dcr','cimd')),
  metadata                   jsonb not null default '{}',   -- full registered doc, echoed back
  created_at                 timestamptz not null default now()
);

create table public.oauth_auth_codes (
  code_hash      text primary key,
  client_id      text not null,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  scope          text not null,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create table public.oauth_refresh_tokens (
  token_hash   text primary key,
  client_id    text not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  scope        text not null,
  resource     text,
  family_id    uuid not null,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  replaced_by  text,
  created_at   timestamptz not null default now()
);

create table public.oauth_access_tokens (
  token_hash   text primary key,
  client_id    text not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  scope        text not null,
  resource     text,
  family_id    uuid,                          -- null for tokens issued without offline_access
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
-- indexes: (user_id) on tokens tables, (family_id) on both token tables, (expires_at) everywhere for cleanup
```

Deviation from spec §6: no `client_secret_hash` column. DCR/CIMD clients are public; the only secret-bearing client is the admin one, and its secret is a Fly secret (§4). Admin clients are not rows.

### 6.2 Who is allowed to touch these tables

Problem: the server has no service-role key, and the existing pattern (SECURITY DEFINER RPC granted to `authenticated`, called with a minted `authenticated` JWT) would let **any signed-in app user** call token-issuing RPCs for any `user_id`. Not acceptable for an authorization server.

**Solution: a dedicated PostgREST role for this server.**

```sql
create role mcp_service nologin;
grant mcp_service to authenticator;              -- PostgREST can SET ROLE to it
grant usage on schema public to mcp_service;
grant select, insert, update, delete on public.oauth_clients, public.oauth_auth_codes,
      public.oauth_refresh_tokens, public.oauth_access_tokens to mcp_service;
grant select (id) on public.profiles to mcp_service;   -- FK checks only
```

- `auth.ts`: `mintServiceJwt()` now signs `{ role: 'mcp_service', sub: <nil uuid> }` with the legacy secret. Only holders of `SUPABASE_JWT_SECRET` (this server) can obtain that role. `supabase.ts` gets a `serviceClient()` that attaches it.
- RLS **enabled** on all four tables. Policies: `for all to mcp_service using (true) with check (true)`; for `oauth_access_tokens` and `oauth_refresh_tokens` also `for select to authenticated using (user_id = auth.uid())` and `for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())` so the SPA's Connected-apps card can list and revoke the caller's own grants. No `anon` access anywhere.
- Atomic operations as SQL functions, **SECURITY INVOKER**, `revoke execute ... from public; grant execute ... to mcp_service;`:
  - `oauth_consume_auth_code(p_code_hash text) returns oauth_auth_codes` — `update ... set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning *`. Zero rows → caller throws `invalid_grant`.
  - `oauth_rotate_refresh_token(p_old_hash, p_new_refresh_hash, p_new_access_hash, p_access_expires, p_refresh_expires)` — the rotation + reuse-detection transaction described in §4. Returns the grant (`user_id`, `client_id`, `scope`, `resource`) or raises.
  - `oauth_revoke_family(p_family_id uuid)` — helper used by both of the above and by revoke.
- Verify in the preview deploy that PostgREST honours the `mcp_service` role claim (it does when the role is granted to `authenticator`; this is the one infra assumption to confirm early). Fallback if it somehow does not: SECURITY DEFINER RPCs that `raise` unless `current_setting('request.jwt.claims')::jsonb->>'role' = 'mcp_service'`.

### 6.3 Cleanup (spec §5.4)

Prefer `pg_cron` (Supabase extension) scheduled nightly:

```sql
delete from oauth_auth_codes     where expires_at < now() - interval '1 day';
delete from oauth_access_tokens  where expires_at < now() - interval '7 days';
delete from oauth_refresh_tokens where (expires_at < now() or revoked_at is not null) and created_at < now() - interval '30 days';
delete from oauth_clients c where source = 'dcr' and created_at < now() - interval '7 days'
  and not exists (select 1 from oauth_refresh_tokens where client_id = c.client_id)
  and not exists (select 1 from oauth_access_tokens  where client_id = c.client_id);
```

**Resolved 2026-09-17:** `pg_cron` was available but not enabled; it was enabled in the dashboard and `cron.schedule('oauth-cleanup-nightly', '15 3 * * *', 'select public.oauth_cleanup();')` now shows one active row in `cron.job`. Cleanup lives entirely in Postgres; the server has no cleanup timer.

### 6.4 Removal migration (`supabase/migrations/drop_mcp_tokens.sql`), run **after** production cutover

```sql
drop function if exists public.resolve_mcp_token(text);
drop function if exists public.create_mcp_token(text);
drop table    if exists public.mcp_tokens;
```

Add both new migrations to `supabase/migrations/supabase/check_migrations.sql` (untracked today; commit it as part of this work).

---

## 7. App changes (`app/src/pages/SettingsPage.tsx`)

Replace the "Connect Claude" card (lines ~717–900 and the heading near line 1041) with a **"Connected apps"** card:

- Lists the user's live grants: `select client_id, scope, created_at, last_used_at, expires_at from oauth_refresh_tokens where revoked_at is null and replaced_by is null`, joined client-side with `oauth_clients.client_name` (or the admin client name when `client_id` matches). One row per family.
- **Disconnect** per row: `update oauth_refresh_tokens set revoked_at = now() where family_id = ...` and the same on `oauth_access_tokens`. **Disconnect all** does it for every row.
- Keeps the read-only "MCP server URL" field with copy button (the URL is what an admin or a Claude Code user pastes), and replaces the paste-a-header instructions with: "Add this URL as a custom connector, click Connect, sign in with your Project Tools email and password."
- Remove the `create_mcp_token` RPC call, the `mcp_tokens` reads, and the `McpToken` type. Keep `VITE_MCP_SERVER_URL`.

No routing or auth-context changes in the SPA.

---

## 8. Config, secrets, Fly

`mcp-server/src/config.ts` and `.env.example`:

| Variable | Required | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | yes | Issuer + base for every OAuth URL and the PRM `resource`. Must be `https://` with no path. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | yes | Unchanged. |
| `OAUTH_ADMIN_CLIENT_ID` | no | Pre-registered client id for the claude.ai Advanced-settings fallback (spec §5.9). |
| `OAUTH_ADMIN_CLIENT_SECRET` | no | Its secret. If unset the admin client is public. |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` / `AUTH_CODE_TTL_SECONDS` | no | Defaults 3600 / 2592000 / 600. |
| `JWT_TTL_SECONDS`, `RATE_LIMIT_PER_MIN`, `PORT` | no | Unchanged. |

`fly.toml`: already `min_machines_running = 1` and `force_https = true`; keep both. Update the header comment (no longer "read-only", mention the OAuth secrets). Consider `memory = "512mb"` only if the consent-page render plus SDK auth handlers push the 256 MB machine; measure in preview first.

`fly secrets set PUBLIC_BASE_URL=... OAUTH_ADMIN_CLIENT_ID=... OAUTH_ADMIN_CLIENT_SECRET=...` on the MCP app. Nothing new on the SPA app.

Set `trust proxy` on Express so `express-rate-limit` keys on the real client IP behind Fly's proxy (`app.set('trust proxy', 1)`).

---

## 9. Decisions to lock before deploying to production

1. **Canonical URL.** `https://instrata-project-tools-mcp.fly.dev/mcp` (zero work) vs. a custom Instrata hostname (needs a Fly cert + DNS, and the `resource`/issuer bake it in). Changing later forces the admin to re-add the connector and every user to reconnect. Default to the fly.dev URL unless a domain is ready this week.
2. **Admin client.** Generate `OAUTH_ADMIN_CLIENT_ID` (`instrata-claude-enterprise`) and a 32-byte secret up front so test C4 can run in the same pass.
3. **Consent-page copy** for scopes: "Read your Project Tools projects, BoMs, RFIs, submittals, purchasing, schedule, catalog, directory, and files" for `mcp:read`; "Create and update records on your behalf" for `mcp:write`; "Stay connected without signing in again" for `offline_access`.

---

## 10. Work breakdown (ordered)

**Step 1 — Database (additive, safe to run before any code ships)**
- Write and run `add_oauth_server.sql` (tables, indexes, `mcp_service` role, grants, RLS, the three RPCs, optional `pg_cron` job).
- Update `check_migrations.sql`.

**Step 2 — Server: OAuth core**
- `npm i @modelcontextprotocol/sdk@1.30.0`; confirm `server/auth/*` types compile.
- Add `src/oauth/{tokens,scopes,store,clients,provider,metadata,consent}.ts` per §4.
- `auth.ts`: delete `resolveToken`; change `mintServiceJwt` to role `mcp_service`; keep `mintUserJwt`.
- `supabase.ts`: add `serviceClient()`.
- `config.ts`: new vars from §8, validate `PUBLIC_BASE_URL`.

**Step 3 — Server: routing**
- `index.ts` per §3: metadata routes, OAuth handlers with rate limits, Basic-auth shim, `requireBearerAuth` on `/mcp` (all methods), `userId` from `req.auth.extra.userId`, `trust proxy`. Delete `queryKey()`, the `/mcp/:key` routes, and the header comment's "personal access token" wording.
- `tools.ts` + `submittalTools.ts` + `toolHelpers.ts`: scope-gated registration per §5. No tool logic changes.

**Step 4 — Tests (new; `mcp-server` has none today)**
- Add `vitest` (or `node:test`) with unit tests for: redirect allowlist (exact, loopback any-port, evil host), CIMD document validation (bad `client_id`, non-allowlisted redirect, non-https), code burn (second use → `invalid_grant`), PKCE mismatch, refresh rotation and family revocation on reuse, scope subset on refresh, tool registration by scope. Mock `store.ts`.
- Add `scripts/oauth-roundtrip.mts`: performs spec test B end-to-end against a base URL (DCR → prints authorize URL → waits for the pasted `code` → token → `initialize` + `tools/list` → refresh → replay old refresh and code, asserting `invalid_grant`).

**Step 5 — Preview deploy**
- `fly apps create instrata-project-tools-mcp-preview`; set secrets with `PUBLIC_BASE_URL=https://instrata-project-tools-mcp-preview.fly.dev`; `fly deploy -c mcp-server/fly.toml -a instrata-project-tools-mcp-preview`.
- Run acceptance tests A, B, D (curl + the roundtrip script). Confirm no `3xx`, confirm `mcp_service` role works through PostgREST, confirm cold-start-free token latency < 500 ms.
- MCP Inspector and Claude Code (`claude mcp add --transport http project-tools <preview>/mcp`) against preview = tests C1, C2 early.

**Step 6 — App** — *done 2026-09-17*
- Connect Claude card replaced with Connected apps (§7) in `app/src/pages/SettingsPage.tsx`: groups the user's `oauth_refresh_tokens` by family, shows client name / read-only vs read & write / connected date / last used, Disconnect per row and Disconnect all via the `oauth_disconnect` RPC, URL copy field, and connect instructions for claude.ai and Claude Code. `tsc` and `vite build` clean; ESLint unchanged (same six pre-existing findings). Still to verify once a real client is connected: Disconnect kills a live Claude Code session on its next call (401 → Claude re-auths).

**Step 7 — Docs** — *done 2026-09-17* (README rewritten; PROJECT_DOCS §7 secrets, §8 rewritten, §9 deploy note + two known-limitation entries, §10 changelog; `drop_mcp_tokens.sql` written and wired into `check_migrations.sql`)
- `mcp-server/README.md`: replace the "Connecting a client" section (it currently documents the `?key=` and `/mcp/<token>` forms) and the "How access works" diagram with the OAuth flow (endpoints, CIMD, admin client, consent page, scope map with the read/write split, the `-32602` note, the SPA-redirect upgrade path, the still-present legacy-key warning). Keep the Tools tables; add a scope column.
- `PROJECT_DOCS.md` §8 (retitle: no longer "read-only" in the auth sense), §7 secrets table, §9 known limitations (remove "resolve_mcp_token" items, add "consent page handles passwords on the MCP origin"), §10 changelog entry.
- Delete `add_mcp_tokens.sql` / `revoke_resolve_mcp_token_anon.sql` from the migrations list in docs once `drop_mcp_tokens.sql` has run (keep the files in git history).

**Step 8 — Production cutover (single)**
- **Before merging:** `fly secrets set PUBLIC_BASE_URL=... OAUTH_ADMIN_CLIENT_ID=... OAUTH_ADMIN_CLIENT_SECRET=... -a instrata-project-tools-mcp` and confirm `add_oauth_server.sql` has been run against production. Both must be in place because the merge itself deploys.
- Merge to `main`. CI deploys the SPA (`deploy.yml`) and, because `mcp-server/**` changed, the MCP server (`deploy-mcp.yml`). Old bearer / `?key=` / path tokens stop working immediately; that is the intended hard cutover.
- Run tests A, D against production, then C1, C2.
- Run `drop_mcp_tokens.sql`.
- Hand the admin: canonical URL, and the admin `client_id`/secret for the Advanced-settings fallback. Admin removes the broken connector, re-adds with URL only, scopes it to the user. Run C3, then C4 with the pre-registered client. Confirm the full tool list appears in a fresh chat.
- Delete the preview Fly app.

---

## 11. Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| PostgREST rejects the custom `mcp_service` role claim | **Confirmed working 2026-09-17** against production Supabase after running `add_oauth_server.sql`: `mcp-server/scripts/verify-mcp-service-role.mts` gets 200 as `mcp_service` on tables and RPCs, 403 as `authenticated`, 401 as `anon`. Fallback in §6.2 no longer needed. |
| claude.ai DCR misbehaves for enterprise connectors | Admin pre-registered client (§4, §9.2) tested as C4. |
| CIMD fetch hangs the authorize request past Claude's 10 s | 5 s fetch timeout, 1 h cache, SSRF guard; failure → `invalid_client` 400 rather than a hang. Claude Code also works via plain DCR if CIMD is unavailable. |
| Password form on a `fly.dev` origin looks like phishing to users | Instrata branding, explicit "Project Tools" copy, shows the client name and redirect host. Custom domain (§9.1) removes the concern entirely. |
| Refresh-token reuse after a client crash mid-rotation | Family revocation forces one clean re-consent, which is the spec's stated behaviour. |
| Legacy HS256 secret rotation | Unchanged risk, still documented; OAuth does not make it worse or better. |
| Write tools regress under OAuth | Their bodies are untouched; only registration is wrapped. Acceptance test B4 asserts the five write tools appear in `tools/list` for a token with `mcp:write`, and a unit test asserts they are absent for `mcp:read` alone. |
| `deploy-mcp.yml` deploys before secrets/migration are ready | Step 8 orders secrets and the additive migration before the merge; the server fails fast at boot if `PUBLIC_BASE_URL` is missing (`config.ts` `required()`), so a mis-ordered deploy is loud, not silent. |
