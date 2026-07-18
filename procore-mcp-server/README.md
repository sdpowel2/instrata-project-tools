# Instrata Procore MCP Server

Read-only, **per-user** remote MCP server that gives Claude access to Procore on
behalf of each authenticated Instrata team member. Every Procore call is made with
the *calling user's own* token, so access mirrors exactly that person's Procore
permissions across all the GC company accounts they belong to. There is **no
service account and no shared token**.

Companion to the AV-relevance skill `procore-updates` (ships alongside this server);
the server stays generic, the skill owns "what matters for AV."

See the full spec: [`../Product Spec/procore-mcp-spec.md`](../Product%20Spec/procore-mcp-spec.md).

> **Status:** in development on branch `feature/procore-mcp`. Built and tested
> against the Procore developer **sandbox**; production deployment is deferred
> until the company Fly/Supabase paid plans are in place (see *Deployment*).

## Architecture

```
Claude (claude.ai / Desktop / mobile)
   │  MCP over Streamable HTTP (HTTPS)
   ▼
Procore MCP Server (Node/TS)
  ├─ OAuth 2.1 AS  (Claude ↔ server: DCR + PKCE)
  ├─ Procore OAuth (server ↔ Procore: per-user Authorization Code)
  ├─ Read-only tools
  ├─ Document text extraction (PDF/DOCX → text)
  └─ Encrypted token store (dedicated Postgres, AES-256-GCM)
   │  HTTPS REST
   ▼
Procore API
```

## Tools (all read-only)

| Tool | Purpose |
|---|---|
| `whoami` | Authenticated Procore user + company count |
| `list_companies` | GC companies the user belongs to |
| `list_projects` | Projects across all companies (filter by company/name/active) |
| `find_project` | Fuzzy "the LEGO project" lookup, ranked matches |
| `get_project_activity` | One-call digest across RFIs/submittals/change events/daily logs/documents |
| `list_rfis` / `get_rfi` | RFIs + full question/answer detail |
| `list_submittals` / `get_submittal` | Submittals + workflow/approvers |
| `list_daily_logs` | Notes/manpower/delay/work logs grouped per day |
| `list_change_events` / `get_change_event` | Change events + line items |
| `list_recent_documents` / `read_document` | Document index + inline text extraction |

Companion skill: [`skill/procore-updates/SKILL.md`](./skill/procore-updates/SKILL.md).

## Local development

```bash
npm install
cp .env.example .env      # fill in Procore app creds, DATABASE_URL, secrets
npm run dev               # tsx watch on http://localhost:8080
```

Prerequisites for a full local run:
- A **Procore Developer app** (developers.procore.com), Authorization Code grant,
  redirect URI `http://localhost:8080/procore/callback`, pointed at the sandbox.
- A **Postgres** database (local or a dev instance) in `DATABASE_URL` — the schema
  is created automatically on boot (`store/db.ts`).
- `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET`: generate each with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Environment

See [`.env.example`](./.env.example). Required: `BASE_URL`, `PROCORE_CLIENT_ID`,
`PROCORE_CLIENT_SECRET`, `PROCORE_BASE_URL`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`,
`SESSION_SECRET`.

## Verification

```bash
npm run typecheck    # tsc --noEmit, must be clean
npm test             # unit tests (crypto, jwt, semaphore, paginator, extraction)
```

End-to-end against the Procore **sandbox** with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP → http://localhost:8080/mcp
# Inspector will drive the OAuth flow: DCR → Procore login → callback.
```

Then exercise `whoami`, `list_companies`, `find_project`, `get_project_activity`,
and `read_document`. Assert on response **structure**, not specific records — the
sandbox resets periodically. Procore endpoint paths/fields marked with `NOTE:` in
the `tools/` and `procore/` sources should be confirmed against the live sandbox
payloads and adjusted if Procore's current REST version differs.

## Deployment

**Deferred to the company paid-plan migration.** The app is stateless (all state
lives in the external dedicated Postgres — no Fly volume), so rollout is:

1. Provision a **dedicated Postgres** for the token store (Fly Postgres or a
   second Supabase project) — separate from the app's Supabase so the Procore
   trust domain stays isolated.
2. Create the production **Procore Developer app** (or add a prod redirect URI):
   `https://<host>/procore/callback`.
3. `fly deploy` using [`fly.toml`](./fly.toml); set all secrets via
   `fly secrets set ...` (see the header of `fly.toml`). Never commit secrets.
4. **Team rollout:** an org owner adds the server URL under Organization settings
   → Connectors as a custom connector; each member clicks Connect and completes
   the Procore login. Verify with `whoami` returning each person's own identity.

## Security model

- **Per-user, no service account** — every Procore call uses the connecting user's
  own token; access mirrors their Procore permissions exactly.
- **Encrypted at rest** — Procore tokens are AES-256-GCM sealed; the key
  (`TOKEN_ENCRYPTION_KEY`) lives only in env, never in the database.
- **Session isolation** — each MCP session is pinned to one user id; a request can
  never be served with another user's token.
- **Read-only** — no POST/PUT/PATCH/DELETE to Procore except the OAuth token
  exchange.
- **Minimal logging** — metadata only; never tokens or document contents.
