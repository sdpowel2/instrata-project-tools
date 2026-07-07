# Instrata Project Tools — MCP server (read-only)

A small HTTP service that lets staff connect a Claude client (Desktop, Code, or
claude.ai) to their Project Tools data and ask questions in natural language. It
exposes **read-only** tools backed by the same Supabase tables the web app uses.

## How access works (and why it's secure)

```
Claude client ──(MCP / Streamable HTTP, Authorization: Bearer <token>)──▶ this server
                                                                            │ 1. resolve_mcp_token(token) → user_id
                                                                            │ 2. mint ~5-min JWT { sub: user_id, role: authenticated }
                                                                            │ 3. query PostgREST AS that user
                                                                            ▼
                                                                     Supabase ── RLS (auth.uid()) ──▶ only that user's data
```

- Each staff member generates a **personal token** in the app under
  **Settings → Connect Claude**. Only its SHA-256 hash is stored (see
  `supabase/migrations/add_mcp_tokens.sql`).
- The server queries Supabase **as the connecting user**, so the project's
  existing Row Level Security is the single source of truth. A user sees exactly
  what they'd see in the app — no more. Project-scoped data (BoM, RFIs,
  submittals, purchasing, milestones) only returns for projects they belong to.
- **No service-role key.** The server holds the anon key (public) and the JWT
  secret (to mint user tokens). It is read-only — there is no write path.

## ⚠️ Auth & the legacy key

The server signs its short-lived user JWTs with the project's **legacy HS256 JWT
secret** (`SUPABASE_JWT_SECRET`). This project has already enabled asymmetric
(ES256) signing keys; the HS256 secret is the dashboard **"Previous Key"** —
still *trusted for verification*, and the same key the app's anon key depends on.

So this works today and is stable as long as the legacy key remains. **When you
eventually rotate Supabase keys / revoke the legacy HS256 secret (a deliberate
migration you'll also do for the app's anon key), this minting approach will stop
working and must be upgraded** — to relaying Supabase-issued tokens (refresh-token
exchange) or full OAuth 2.1. Treat that rotation and this server's auth as a
single coordinated change.

## Local development

```bash
cd mcp-server
cp .env.example .env        # fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET
npm install
npm run dev                 # starts on :8080
```

Test with the MCP Inspector, using a token generated from the app's Settings page:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP   URL: http://localhost:8080/mcp
# Header:    Authorization: Bearer instrata_mcp_xxxxxxxx...
```

## Deploy (Fly.io)

Separate Fly app, alongside the SPA:

```bash
cd mcp-server
fly launch --no-deploy          # first time only; keeps app name from fly.toml
fly secrets set \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon key> \
  SUPABASE_JWT_SECRET=<legacy HS256 secret>
fly deploy
```

The public URL (e.g. `https://instrata-project-tools-mcp.fly.dev/mcp`) is what
staff paste into their Claude client.

## Tools

All read-only. Discovery starts with `list_projects` (returns project ids), then
the project-scoped tools take a `project_id`:

| Tool | Returns |
|------|---------|
| `list_projects` | Projects (search by name/number/client/code, filter by status) |
| `get_project` | Full record for one project id |
| `get_project_bom` | Equipment / labor line items |
| `list_rfis` | RFIs (optionally Open only) |
| `list_submittals` | Submittal packages (optionally with line items) |
| `list_purchasing` | Purchasing modules + items (status, PO #, dates) |
| `list_milestones` | Schedule milestones |
| `search_catalog` | Full-text product catalog search |
| `search_vendor_contacts` | Vendor / distributor / rep directory |
| `list_project_files` | Project document repository index (SharePoint-backed; filter by category / search) |
| `get_project_file` | Fresh ~1h download URL for one file (minted by the sharepoint-project-files edge function with the caller's JWT) |
