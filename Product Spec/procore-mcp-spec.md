# Procore Updates MCP Server — Development Spec

**Version:** 1.0 (v1 scope)
**Owner:** Instrata AV
**Target implementation:** TypeScript / Node.js, MCP TypeScript SDK
**Deployment:** Shared remote server for the whole team
**Access model:** Read-only

---

## 1. Problem statement

Instrata engineers are added as subcontractor users to general contractors' (GCs') Procore accounts across many active projects. Staying current means manually logging into multiple Procore accounts and scanning RFIs, submittals, daily logs, change events, and document folders for anything that affects AV scope.

This MCP server gives Claude read access to Procore on behalf of each authenticated team member, so a user can ask e.g. *"give me updates on the LEGO project"* and Claude can locate the project, pull recent activity, read relevant documents, and summarize what matters for AV.

The **AV-relevance filtering is NOT the server's job** — it belongs to Claude via a companion skill (Section 10). The server's job is clean, token-efficient, read-only access to Procore data.

## 2. Goals and non-goals

**Goals (v1):**
- Remote MCP server usable by the whole team as a Claude custom connector (claude.ai, Claude Desktop, Claude mobile)
- Per-user Procore authentication: each team member's access mirrors exactly their own Procore permissions across all GC accounts they belong to
- Read-only tools covering: companies, projects, RFIs, submittals, daily logs, change events, documents/files, and document text extraction
- Sensible defaults that make "what's new since I last checked" a one-tool-call question

**Non-goals (v1):**
- No write operations of any kind (no creating/responding to RFIs, no uploads, no status changes)
- No webhooks, polling, scheduled digests, or notifications (v2 candidate)
- No drawings/markups rendering, no photo analysis
- No caching layer beyond short-lived in-memory response caching (optional)

## 3. Primary user stories

1. *"Give me updates on the LEGO project"* → Claude calls `find_project("LEGO")`, then `get_project_activity` for the last 14 days, then drills into specific RFIs/submittals/documents as needed, and summarizes AV-relevant items.
2. *"Any new drawings or specs uploaded to LEGO this week?"* → `list_recent_documents` with a 7-day window.
3. *"What's the status of our submittals on the Raleigh hospital job?"* → `find_project` + `list_submittals` filtered to items where the user's company is the responsible contractor (best-effort filter; see 6.6).
4. *"Read RFI 214 on LEGO and tell me if it affects our ceiling speaker layout"* → `get_rfi` returns full question/answer text.

## 4. Architecture

```
Claude (claude.ai / Desktop / mobile)
        │  MCP over Streamable HTTP (HTTPS)
        ▼
Procore MCP Server (Node/TS, single service)
  ├─ MCP transport layer (Streamable HTTP, MCP spec 2025-06-18+)
  ├─ OAuth 2.1 authorization server (Claude ↔ server auth)
  ├─ Procore OAuth client (server ↔ Procore, per-user tokens)
  ├─ Tool handlers (read-only)
  ├─ Document text extraction (PDF/DOCX → text)
  └─ Encrypted token store (per user)
        │  HTTPS REST
        ▼
Procore API (api.procore.com)
```

- Single Node.js service, containerized (Docker), deployed behind HTTPS on team infrastructure.
- **Transport:** Streamable HTTP (single endpoint, e.g. `POST/GET/HEAD /mcp`). Do not build on SSE — it is deprecated for new servers. Support `HEAD` on the MCP endpoint for protocol discovery and implement explicit session management per the current MCP spec.
- Use the official `@modelcontextprotocol/sdk` TypeScript package (server + Streamable HTTP transport + OAuth middleware). Express or Fastify for the HTTP layer.

## 5. Authentication (two layers)

### 5.1 Layer 1 — Claude ↔ MCP server (OAuth 2.1)

The server protects its MCP endpoint with OAuth 2.1 + PKCE per the MCP authorization spec:

- Host **Protected Resource Metadata** (`/.well-known/oauth-protected-resource`) so Claude can discover the authorization server.
- Support **Dynamic Client Registration (DCR)** — Claude registers itself as a client. This is the path of least friction for custom connectors; no client ID/secret needs to be distributed to team members.
- Issue short-lived access tokens (JWT recommended) and refresh tokens. On token-endpoint failures for deleted DCR clients, return HTTP 401 `invalid_client` so Claude re-registers.
- The identity established here is the **team member's identity on our server**. Simplest v1 approach: the server's own authorization flow immediately chains into the Procore OAuth flow (5.2), so "logging in to the connector" IS "logging in to Procore," and the server's user record is keyed by the Procore user (`/rest/v1.0/me`). This avoids running a separate identity system.

### 5.2 Layer 2 — MCP server ↔ Procore (per-user Authorization Code grant)

- Create ONE app in the Procore Developer Portal (developers.procore.com) with **Authorization Code** grant type. Redirect URI points at the server (e.g. `https://<host>/procore/callback`).
- During connector authorization, redirect the user to Procore's login/consent. On callback, exchange the code for access + refresh tokens.
- **Token storage:** per-user, encrypted at rest (e.g. AES-256-GCM with a key from env/secret manager). Never log tokens. Auto-refresh on expiry; on refresh failure, surface a clear tool error instructing the user to reconnect the connector.
- Every Procore API call made by a tool uses the **calling user's** token. There is no service account and no shared token. This guarantees each user sees only what their GC-granted permissions allow — the security model is Procore's, not ours.

### 5.3 Multi-company handling (critical)

Team members belong to multiple GC company accounts. Do **not** hardcode a company ID:

- Enumerate companies via `GET /rest/v1.0/companies` per user.
- Most project-scoped endpoints require the `Procore-Company-Id` request header (Multiple Procore Zones). Every tool handler must set it based on the project's owning company.
- Maintain a per-user, in-memory (or short-TTL) map of `project → company_id` built from the projects listing, so tools that take only a `project_id` can resolve the header without an extra round trip.

## 6. Tools (all read-only)

General conventions:

- All list tools accept `since` (ISO date, default **14 days ago**) and `limit` (default 25, max 100), and return `has_more` + pagination cursor/page info.
- Responses are compact JSON: include IDs, titles, statuses, dates, people (name + company), and short text; omit Procore's verbose metadata. Token efficiency matters — Claude may fan out across 5–6 tools per request.
- Every response includes `project_name` and `company_name` for orientation.
- Timestamps in ISO 8601 with timezone.

### 6.1 `list_companies`
No params. Returns the companies the user belongs to: `[{ company_id, name }]`.

### 6.2 `list_projects`
Params: `company_id?` (optional filter), `query?` (name substring), `active_only` (default true).
Returns `[{ project_id, company_id, name, project_number, stage, address, city, state }]`.

### 6.3 `find_project`
Params: `query` (required). Fuzzy/substring match across ALL companies' projects (case-insensitive; match name, project number, and display name). Returns ranked matches. This is the entry point for "the LEGO project" — a nickname must resolve even if the formal name is "LEGO Group – Building C Fit-Out." If multiple strong matches exist, return them all so Claude can ask the user.

### 6.4 `get_project_activity`
Params: `project_id`, `since?`.
Convenience aggregator: one call returning a digest of counts + headline items across RFIs, submittals, change events, daily logs, and recently modified documents in the window. Each item: `{ type, id, title, status, updated_at, one_line_summary }`. Internally fans out to the endpoints below in parallel (`Promise.allSettled`; a 403 on one tool — e.g. user lacks daily-log access — must not fail the digest; include `"access": "forbidden"` for that section instead). This is the workhorse for "give me updates."

### 6.5 `list_rfis` / `get_rfi`
- `list_rfis(project_id, since?, status?)` → `[{ rfi_id, number, subject, status, due_date, ball_in_court, created_at, updated_at }]`
- `get_rfi(project_id, rfi_id)` → full question body, all answers, assignees, linked drawings/spec sections, attachments metadata `[{ file_id, filename, size }]`.

### 6.6 `list_submittals` / `get_submittal`
- `list_submittals(project_id, since?, status?, spec_section?)` → number, title, revision, spec section, status, ball-in-court, responsible contractor, due dates.
- `get_submittal(project_id, submittal_id)` → full detail incl. workflow/approvers and attachments metadata.
- Note: filtering "our" submittals by responsible contractor is best-effort — expose `responsible_contractor` in results and let Claude filter, rather than guessing the user's vendor record server-side.

### 6.7 `list_daily_logs`
Params: `project_id`, `start_date?`, `end_date?` (default last 7 days).
Return the notes/work log entries most useful for status awareness: manpower summaries, work performed notes, delays, deliveries. Procore's daily log is many sub-resources — v1 pulls: **notes logs, manpower logs, delay logs, work logs**. Concatenate per-day into `{ date, entries: [{ type, company, text }] }`.

### 6.8 `list_change_events`
Params: `project_id`, `since?`, `status?`.
Returns `[{ change_event_id, number, title, status, scope, origin, created_at, updated_at }]` plus a `get_change_event` detail tool with description and line-item summaries (cost figures only if the user's permissions return them; pass through whatever the API gives).

### 6.9 `list_recent_documents`
Params: `project_id`, `since?`, `folder_path?` (substring filter, e.g. "Specifications").
Walks the project Documents tool for files created/updated in the window. Returns `[{ file_id, filename, folder_path, size_bytes, updated_at, updated_by }]`. Cap traversal (e.g. 2,000 files) and note truncation in the response.

### 6.10 `read_document`
Params: `project_id`, `file_id`, `max_chars?` (default 40,000), `page_range?`.
Because this is a shared remote server, "download to the user's machine" is not possible — the server extracts text and returns it inline:
- Download the file server-side to a temp location (delete after processing; nothing persisted).
- PDF → text via `pdf-parse` or `pdfjs-dist`; DOCX via `mammoth`; plain text passthrough. Return `{ filename, extracted: true|false, truncated: bool, text }`.
- If extraction yields near-empty text (scanned drawing), return `extracted: false` with a note ("likely a scanned/vector drawing; text extraction unavailable") — do NOT attempt OCR in v1.
- Enforce a hard file-size ceiling (default 50 MB) and return a clear error above it.

### 6.11 `whoami`
No params. Returns the authenticated Procore user (`name, email, procore_user_id`) and company count — useful for connection debugging.

## 7. Procore API implementation notes

- **Base URL:** `https://api.procore.com` (production), `https://sandbox.procore.com` (development sandbox). Make it an env var.
- **Required header:** `Procore-Company-Id` on company-scoped endpoints (see 5.3).
- **Rate limiting:** Procore enforces per-token hourly limits (historically 3,600 req/hr). Implement: (a) honor 429 with `Retry-After`/rate headers, exponential backoff with jitter, max 3 retries; (b) a small client-side concurrency cap (e.g. 5 concurrent requests per user) so `get_project_activity`'s fan-out can't spike.
- **Pagination:** Procore uses `page`/`per_page` with `Total`/`Per-Page` response headers on most v1.0 endpoints. Wrap in a shared paginator.
- **Error mapping:** 401 → attempt token refresh once, then error "Procore session expired — reconnect the connector"; 403 → "You don't have access to <tool> on this project" (never retry); 404 → "Not found — verify project/ID"; 5xx → one retry then surface.
- **API versions:** prefer v1.0 endpoints; some tools (submittals, change events) have v1.1 variants with better payloads — dev should check current Procore REST docs per resource and prefer the newest stable version.

## 8. Security requirements

- HTTPS only; HSTS. MCP endpoint rejects unauthenticated requests with 401 + `WWW-Authenticate` pointing at resource metadata (required for Claude's OAuth discovery).
- Per-user token isolation: a bug class to explicitly test — no request may ever be served with another user's Procore token. Key every token lookup by the authenticated MCP session's user ID.
- Encrypt Procore tokens at rest; secrets via environment/secret manager, never in the repo.
- Logging: request metadata only (user ID, tool name, project ID, duration, status). Never log tokens, document contents, or full API payloads.
- Temp files from `read_document` deleted in a `finally` block; temp dir on tmpfs if available.
- Dependency hygiene: lockfile committed, `npm audit` in CI.

## 9. Deployment & operations

- **Container:** single Dockerfile, Node 20+ LTS, multi-stage build.
- **Config (env vars):** `PORT`, `BASE_URL`, `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_BASE_URL`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, `LOG_LEVEL`.
- **Persistence:** token store needs durable storage — SQLite on a mounted volume is sufficient for a team-sized deployment (use `better-sqlite3`); design the storage interface so Postgres can be swapped in later.
- **Health:** `GET /healthz` (no auth) returning build version.
- **Team rollout:** an org owner adds the server URL under Organization settings → Connectors as a custom connector; each member clicks Connect and completes the Procore login. Document this in the README.

## 10. Companion Claude skill (separate deliverable, small)

Ship alongside the server a Claude skill (`procore-updates`) so "give me updates on <project>" behaves consistently:

- Trigger phrases: "updates on <project>", "what's new on <project>", "anything AV-related on <project>".
- Procedure: `find_project` → confirm if ambiguous → `get_project_activity` (default 14 days or since user's stated last check) → drill into promising items (`get_rfi`, `read_document`, etc.) → summarize grouped by: **Action needed by us / Affects AV scope / FYI**.
- AV-relevance heuristics to include in the skill text: Division 27/28 spec sections, keywords (audiovisual, AV, low voltage, displays, projector, speaker, DSP, videoconference, structured cabling, conduit/backing/blocking for AV, ceiling grid changes, millwork at display walls, power/data at display locations, network/VLAN), plus any RFI/submittal where Instrata is ball-in-court.
- The skill, not the server, owns this logic — keeps the server generic.

## 11. Acceptance criteria

1. Org owner can add the server as a custom connector; two different team members can connect and `whoami` returns each person's own Procore identity.
2. A user belonging to 3+ GC companies sees projects from all of them via `list_projects`, with correct `Procore-Company-Id` handling on subsequent calls.
3. `find_project("LEGO")` resolves a project whose formal name merely contains "LEGO", across companies.
4. `get_project_activity` on a busy sandbox project returns a digest in < 10 s, and degrades gracefully (partial results) when the user lacks access to one tool.
5. `read_document` returns usable text from a 100-page PDF spec and correctly reports a scanned drawing as non-extractable.
6. Revoking a user's Procore access to a project results in clean 403 tool errors for that project only; other users are unaffected.
7. No write endpoint is reachable: the server contains no POST/PUT/PATCH/DELETE calls to Procore except the OAuth token exchange.
8. Restarting the container does not force users to re-authenticate (tokens survive via the volume).

## 12. Testing plan

- Unit tests: paginator, rate-limit/backoff, token refresh, company-ID resolution, text extraction (fixture PDFs incl. a scanned page).
- Integration tests against the **Procore development sandbox** (developer portal provides one; note sandbox data resets periodically — tests should create-nothing and assert on structure, not specific records).
- Manual E2E: connect from claude.ai as two users, run user stories in Section 3.
- Use MCP Inspector during development to exercise the OAuth flow and tools before touching Claude.

## 13. v2 candidates (out of scope, listed for architectural awareness)

- Scheduled digest ("every Monday, summarize all my projects") — would need a job runner + a delivery channel.
- Write actions behind confirmation (respond to RFIs, update submittal status).
- OCR for scanned drawings; drawing-revision diffing.
- Meetings/minutes and punch list tools.
- Correspondence tool coverage (GC-dependent availability).

## 14. Reference links for the developer

- MCP spec + TypeScript SDK: https://modelcontextprotocol.io and https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic guidance on building remote servers for custom connectors: https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers
- Custom connector setup (end-user steps): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Procore Developer Portal + REST API reference: https://developers.procore.com
