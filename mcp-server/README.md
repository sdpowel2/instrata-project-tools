# Instrata Project Tools — MCP server

A small HTTP service that lets staff connect a Claude client (claude.ai, Claude
Desktop, Claude Code, or the MCP Inspector) to their Project Tools data and work
with it in natural language. It exposes tools backed by the same Supabase tables
the web app uses — **read tools for everything, plus a scoped set of write tools
covering the cutsheet submittal workflow** (create/populate a submittal package
and attach cutsheets; see `Product Spec/cutsheet-submittal-mcp-writes-spec.md`).

The server is also its **own OAuth 2.1 authorization server**, so clients
connect with a standard OAuth flow and no shared secrets or pasted tokens.
Spec: `Product Spec/project-tools-mcp-auth-spec.md`; design notes:
`Product Spec/project-tools-mcp-auth-implementation-plan.md`.

## How access works (and why it's secure)

```
Claude client
  │ 1. POST /mcp (no token)                  → 401 + WWW-Authenticate: Bearer resource_metadata=…
  │ 2. GET /.well-known/oauth-protected-resource   → points at this same origin as the AS
  │ 3. GET /.well-known/oauth-authorization-server → endpoints, PKCE S256, public clients OK
  │ 4. POST /oauth/register (DCR) or CIMD           → client_id
  │ 5. browser: GET /oauth/authorize → our login + consent page → POST /oauth/consent
  │       user signs in with their Project Tools email/password (Supabase Auth), clicks Allow
  │ 6. 302 back to the client with ?code=…
  │ 7. POST /oauth/token (form-urlencoded, PKCE verifier) → access_token (1 h) + refresh_token (30 d)
  │ 8. POST /mcp  Authorization: Bearer <access_token>
  ▼
this server ── access token → user_id ── mint ~5-min JWT { sub: user_id, role: authenticated }
                                       ── query PostgREST AS that user
                                                 ▼
                                       Supabase ── RLS (auth.uid()) ──▶ only that user's data
```

- **Identity is the user's own Project Tools login.** The consent page verifies
  email + password against Supabase Auth — the same identity store as the app.
  No third-party IdP, no separate password.
- **Every tool call runs as that user.** The server mints a short-lived
  Supabase JWT for the resolved `user_id` and queries PostgREST with it, so the
  project's existing Row Level Security is the single source of truth. Reads
  are org-wide (like the app); writes only succeed on projects the user is a
  **member** of, exactly like the app UI.
- **Scopes decide which tools exist.** `mcp:read` unlocks the read tools,
  `mcp:write` the five submittal write tools, `offline_access` a refresh token.
  A token without `mcp:write` simply doesn't see the write tools in
  `tools/list`; calling one anyway returns an `isError` tool result
  (`MCP error -32602: Tool … disabled`), never an HTTP 401.
- **No service-role key, anywhere.** The server holds the public anon key and
  the JWT secret. OAuth state (clients, codes, tokens — all stored as SHA-256
  hashes) lives in `oauth_*` tables that only a dedicated PostgREST role,
  `mcp_service`, can touch; the server mints that role's JWT itself. See
  `supabase/migrations/add_oauth_server.sql`.
- **Hard-to-get-wrong OAuth.** PKCE S256 is mandatory; authorization codes are
  single-use with a 10-minute TTL and bound to client + redirect URI +
  challenge; refresh tokens rotate on every use and replaying a rotated one
  revokes the whole family; redirect URIs are allowlisted (below); the token
  and registration endpoints are rate-limited per IP.

### Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (stateless). Bearer token required. |
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | RFC 9728 protected-resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `GET /oauth/authorize` | Authorization endpoint → renders the login + consent page |
| `POST /oauth/consent` | Consent form target (ours): verifies credentials, issues the code |
| `POST /oauth/token` | Code exchange + refresh. `application/x-www-form-urlencoded` (JSON tolerated). `client_secret_post`, `client_secret_basic`, or public (`none`). |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration (public clients only) |
| `POST /oauth/revoke` | RFC 7009 revocation (always 200) |
| `GET /healthz` | Fly health check |

Protocol handling (PKCE verification, grant dispatch, RFC 6749 error codes,
DCR parsing, the 401 challenge) comes from `@modelcontextprotocol/sdk`'s
`server/auth` handlers; `src/oauth/` supplies the Supabase-backed provider,
client store, consent page and metadata. There are deliberately **no
redirects** on any of these paths — a redirect drops the `Authorization`
header on hosted Claude.

### Clients

Three ways a client can identify itself; all are checked against the same
redirect-URI allowlist:

- **Dynamic registration** (`POST /oauth/register`) — what claude.ai and the
  MCP Inspector do. Registered clients are always public.
- **Client ID Metadata Document (CIMD)** — `client_id` is an `https://` URL
  serving the client's metadata (Claude Code uses
  `https://claude.ai/oauth/claude-code-client-metadata`). Fetched with a 5 s
  timeout and SSRF guard, validated, cached for an hour. Redirect URIs in the
  document that aren't on the allowlist are dropped rather than failing the
  whole client, since we don't author that document. **Pinned fallback:**
  claude.ai's edge has returned 403 to this fetch from Fly's egress, so when
  the live fetch fails for `https://claude.ai/oauth/mcp-oauth-client-metadata`
  (claude.ai) or `…/claude-code-client-metadata` (Claude Code) the server uses
  a pinned copy of the document (`KNOWN_CIMD_CLIENTS` in `src/oauth/clients.ts`)
  and retries the live one after 5 minutes. Safe because those documents'
  redirect URIs are exactly our allowlist.
- **Admin pre-registered client** — `OAUTH_ADMIN_CLIENT_ID` (+ optional
  `OAUTH_ADMIN_CLIENT_SECRET`) from env. An Instrata admin can paste these into
  the claude.ai connector's Advanced settings to bypass DCR entirely. Not a DB
  row; the secret lives only in a Fly secret.

**Redirect URI allowlist:** exactly `https://claude.ai/api/mcp/auth_callback`,
or `http://localhost:<any port>/callback` / `http://127.0.0.1:<any port>/callback`
(RFC 8252 loopback for Claude Code). Anything else is rejected at registration
and at authorization.

## Connecting a client

The URL to give every client is `https://<host>/mcp` (production:
`https://instrata-project-tools-mcp.fly.dev/mcp`). No headers, no tokens.

- **claude.ai (Enterprise):** an Instrata admin adds a custom connector with
  that URL and nothing else (or, as a fallback, the admin client id/secret in
  Advanced settings), scoped to the right users. Each user opens the connector,
  clicks **Connect**, signs in with their Project Tools email/password on our
  consent page, and approves.
- **Claude Code:** `claude mcp add --transport http project-tools https://<host>/mcp`,
  then `/mcp` → authenticate. A browser opens on the consent page; the redirect
  lands on a loopback port.
- **Claude Desktop / Cowork:** add the URL as a custom connector; same
  browser-based sign-in.
- **MCP Inspector:** Transport *Streamable HTTP*, URL `https://<host>/mcp`,
  click *Open Auth Settings* → *Quick OAuth Flow*.

Users can see and revoke their connections in the app under **Settings →
Connected apps** (one row per approved connection; Disconnect revokes the
token family immediately, so the client's next call gets a 401 and it
re-prompts to connect).

## ⚠️ Auth & the legacy key

Both JWTs this server mints — the per-user `authenticated` token and its own
`mcp_service` token — are signed with the project's **legacy HS256 JWT secret**
(`SUPABASE_JWT_SECRET`). This project has already enabled asymmetric (ES256)
signing keys; the HS256 secret is the dashboard **"Previous Key"** — still
*trusted for verification*, and the same key the app's anon key depends on.

OAuth changed how the *caller* is identified; it did not change how the server
talks to Supabase. So this still works today and is stable as long as the
legacy key remains. **When you rotate Supabase keys / revoke the legacy HS256
secret, this server's Supabase access must be upgraded at the same time** — e.g.
by capturing the Supabase session issued at consent time and relaying its
refresh token, or by giving `mcp_service` a different credential. Treat that
rotation and this server as a single coordinated change.

## Local development

```bash
cd mcp-server
cp .env.example .env        # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, PUBLIC_BASE_URL=http://localhost:8080
npm install
npm run dev                 # starts on :8080 (issuer http://localhost:8080)
```

The server refuses to start if `PUBLIC_BASE_URL` is missing or is not a bare
https origin (http is allowed for localhost only), and if any registered tool
lacks a scope in `src/oauth/scopes.ts`.

Test with the MCP Inspector (`npx @modelcontextprotocol/inspector`, Streamable
HTTP, `http://localhost:8080/mcp`, Quick OAuth Flow) or with the scripts:

```bash
# Does PostgREST honour the mcp_service role? (run once after the migration)
npx tsx --env-file=.env scripts/verify-mcp-service-role.mts

# Full token lifecycle without a browser: plants an auth code as mcp_service,
# then does the real code exchange, initialize, tools/list, refresh rotation,
# replay detection, scope gating, revocation. Cleans up after itself.
SMOKE_USER_ID=<your profile uuid> npx tsx --env-file=.env scripts/oauth-smoke.mts http://localhost:8080
```

(In PowerShell set the variable first: `$env:SMOKE_USER_ID = "<uuid>"`.)

## Deploy (Fly.io)

Separate Fly app, alongside the SPA. **CI deploys it automatically** on any
push to `main` that touches `mcp-server/**` (`.github/workflows/deploy-mcp.yml`,
token `FLY_API_TOKEN_MCP`), so set secrets *before* merging changes that need
them.

```bash
cd mcp-server
fly launch --no-deploy          # first time only; keeps app name from fly.toml
fly secrets set \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon key> \
  SUPABASE_JWT_SECRET=<legacy HS256 secret> \
  PUBLIC_BASE_URL=https://instrata-project-tools-mcp.fly.dev \
  OAUTH_ADMIN_CLIENT_ID=<optional> OAUTH_ADMIN_CLIENT_SECRET=<optional>
fly deploy                      # or just merge to main
```

`PUBLIC_BASE_URL` must match the host clients use **exactly** (it is the OAuth
issuer and the protected resource's identity). Changing it later means every
client has to reconnect. `fly.toml` keeps one machine always warm so the token
endpoint stays well inside Claude's 10 s budget.

**Migrations:** `add_oauth_server.sql` (tables, `mcp_service` role, RPCs,
nightly `pg_cron` cleanup) must be applied before deploying this version;
`drop_mcp_tokens.sql` removes the old personal-token scheme after cutover.

## Tools

Discovery starts with `list_projects` (returns project ids), then the
project-scoped tools take a `project_id`. The scope column is the OAuth scope a
token needs for the tool to appear (`src/oauth/scopes.ts`).

### Read (`mcp:read`)

| Tool | Returns |
|------|---------|
| `get_me` | The calling user's profile (id, full name, email) |
| `list_projects` | Projects (search by name/number/client/code, filter by status) |
| `get_project` | Full record for one project id |
| `get_project_bom` | Equipment / labor line items |
| `list_rfis` | RFIs (optionally Open only) |
| `list_submittals` | Submittal packages; with `include_items`, line items carry `has_cutsheet` / `cutsheet_source` match status |
| `list_purchasing` | Purchasing modules + items (status, PO #, dates) |
| `list_milestones` | Schedule milestones |
| `search_catalog` | Full-text product catalog search |
| `search_vendor_contacts` | Vendor / distributor / rep directory |
| `search_cutsheet_repository` | Approved cutsheet repository search (mfr / model / free text) |
| `list_project_files` | Project document repository index (SharePoint-backed; filter by category / search) |
| `get_project_file` | Fresh ~1h download URL for one file (minted by the sharepoint-project-files edge function with the caller's JWT) |
| `get_project_wiki` | Project wiki context (summary / scope / design basis / status) + the room index (one line per room with status, headline, decision + open-question counts) and blocking counts |
| `list_project_rooms` | Room index rows; filter by `status`, `room_type`, `entry_kind` |
| `get_project_room` | One room in full: fields + decisions + questions + labor + linked BoM lines / files. By `room_id`, or `project_id` + `dtools_location` / `room_number` |
| `list_room_decisions` | Decisions with rationale; scope to a room or project-level, filter by `kind` |
| `list_project_questions` | Questions log; filter by `severity` / `status` (default: open + answered — the "needs your input" set) |
| `search_project_wiki` | Full-text search across headlines, detail, validation notes, decision rationale, questions/answers and project context (`search_project_wiki` RPC; web-search syntax; `<b>` marked snippets) |

### Write (`mcp:write` — project wiki, `src/wikiTools.ts`)

| Tool | Does |
|------|------|
| `upsert_project_wiki` | Create or patch the project-level context; only supplied fields change |
| `upsert_project_room` | Idempotent create-or-update of a room / subsystem, matched by `room_id` else `(project_id, dtools_location)`. `headline` + `room_name` required on create; status defaults `pending` (agent) / `authored` (human). Warns when `typical_of_count` ≠ roster length |
| `set_room_status` | Status transition with optional headline update |
| `append_room_decision` | Append a decision (`kind`, one-line `title`, markdown `rationale`, `source_ref`); room-level or project-level. Append-only by design |
| `set_room_labor` | Replace a room's labor buckets; `0` hours are stored, and the four CSV-required buckets (bench, cabling, commissioning, programming) are filled at 0.00 unless `fill_required_with_zero: false` |
| `raise_room_question` | Log a question at `open` with `severity` (`functional_conflict` / `estimating_escalation`); moves the room to `escalated` unless `escalate_room: false` |
| `answer_room_question` | Record the answer (+ optional resolution), optionally log the resulting decision and link it → `resolved`; an `escalated` room with nothing left open becomes `resolved` |
| `link_room_bom_lines` / `link_room_files` | Populate the room ↔ BoM line / room ↔ project file link tables (duplicates skipped) |

### Write (`mcp:write` — cutsheet submittal workflow, `src/submittalTools.ts`)

| Tool | Does |
|------|------|
| `create_submittal` | New package; `prepared_by` defaults to the caller's name, title to "AV Submittals" |
| `update_submittal` | Edit package fields (title, submitted_to, revision, notes) |
| `populate_submittal_from_bom` | Server-side "Autopopulate from BoM": filter/dedup line items, auto-attach repository cutsheets, return per-item match status. Refuses to overwrite existing items unless `replace: true` |
| `attach_cutsheet` | Attach a cutsheet to a line item from the repository (`repository_id`), a fetched `url`, or `base64_pdf`. New files are deduped against the repository, otherwise staged pending admin approval |
| `detach_cutsheet` | Clear a line item's cutsheet so a different one can be attached |

Notes on writes:
- The final submittal **PDF export stays in the app** (Submittal → Export) — the
  server has no PDF generation.
- New cutsheets uploaded via `attach_cutsheet` land in the **admin staging
  review queue** (`source_context: 'mcp_skill'`); they attach and export
  immediately but should be approved so the repository grows.
- The BoM filter rules (labor + house manufacturers) are a copy of
  `app/src/utils/submittalExclusions.ts` — keep the two in sync.
- Wiki writes need `add_project_wiki.sql` applied. The wiki vocabulary
  (statuses, kinds, labor types) is duplicated in `app/src/lib/projectWiki.ts`
  — keep the two in sync. Spec: `Product Spec/project-tools-wiki-spec.md`.
- Adding a tool? Give it a scope in `src/oauth/scopes.ts` or the server won't boot.
