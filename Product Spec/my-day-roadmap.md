# My Day / Work Engine roadmap: phases 2 and 3

**Status:** phase 2 in progress (2.1 first) · **Owner:** Seth · **Updated:** 2026-11-13
**Builds on:** phase 1, live since 2026-11-05 (`supabase/migrations/add_worklist.sql`, `mcp-server/src/worklistTools.ts`, `app/src/hooks/useWorklist.ts`, `.claude/skills/morning-worklist/SKILL.md`)
**Phase 3 source:** `Product Spec/work-engine-phase-3-spec.md` (Seth's spec). Section "Phase 3" below lists the changes this roadmap makes to it.

## The shape of it

- **Phase 1 (done):** the morning skill triages mail, Teams, calendar and monday into a short list on My Day.
- **Phase 2: trust and context.** See everything the run reviewed, fix misses in one click, and teach the triage with rules instead of prompt edits. Then link tasks to projects, capture notes into a second brain, make it searchable, and move the run to a nightly cloud schedule.
- **Phase 3: workers.** Claude does the first pass on tasks (reply drafts, IPT change plans, D-Tools reports) and stages each result for approval. Nothing is sent, merged or shared without a click.

**One roadmap, separate branches.** Each numbered milestone gets its own short branch (`my-day/<name>`), merged through `dev` → `main` when its "done when" passes, like phase 1. Phase 3 stays a separate phase because its workers depend on two-week gates and IT sign-off, but its groundwork (2.1–2.3) is built here, first.

## Decisions (and why)

| Decision | Why |
|---|---|
| **Triage tuning comes first in phase 2.** | The list is only useful if Seth trusts it isn't missing things. A visible "reviewed" log with one-click fixes is how that trust gets earned, and every phase 3 gate (work-type accuracy, regression replay) needs the same data. |
| **Hard rules run in code, lessons in the prompt.** | A rule like "always surface anything from this client's domain" must be applied the same way every time. The skill is a model, so the matching happens in an MCP tool (2.2) before Claude classifies anything. Fuzzy guidance ("a GC schedule change sent as FYI should surface") goes into the prompt as a lesson with its example. |
| **No Claude API call in the app yet.** | The tuning modal pre-fills rules from the item and previews them with a plain SQL match, which needs no model. Answering questions from the second brain works through Claude Code / claude.ai with MCP tools on the enterprise seat. An in-app API call (Claude-proposed rules, the "Ask" box) stays optional (2.9). |
| **Summaries, not bodies, everywhere.** | The reviewed log stores sender, subject or chat name, a one-line reason and a link back, not the spec's 200-character snippet. Phase 1's rule stands: the original is one click away, and the database never holds message text. |
| **The second brain lives in Supabase.** | Search, MCP read/write tools and per-user privacy all come for free, the same way the project wiki works. Obsidian stays possible through a one-way export (2.6.4). (Correction to the Nov 5 plan: the app *can* write to the projects SharePoint drive through `sharepoint-project-files`; that's the right home for generated reports in phase 3, but not for the brain.) |
| **Workers never hold send permissions.** | Phase 3 workers write drafts into Project Tools only. Approving from the dashboard creates or sends the Outlook message under Seth's own login. Untrusted email text and the power to act on it never sit in the same job. |
| **Linked tasks go to a per-project activity log, not the curated project wiki.** | The project wiki is organized around rooms, decisions and questions; task churn would clutter it. |
| **Same safety rules as phase 1.** | Owner-only RLS (`user_id = auth.uid()`), admin-only MCP tools, and the skill never writes to monday, mail or Teams. The MCP server keeps acting as the signed-in user; no service-role key. |

## Phase 2 build order

| # | Milestone | Size | Depends on |
|---|---|---|---|
| 2.1 | Reviewed log + "Surface this" | M | nothing |
| 2.2 | Tuning rules: hard rules, lessons, modal with preview, rules page | M–L | 2.1 |
| 2.3 | Work-type tagging (phase 3 groundwork; tag only, no workers) | S | 2.1 |
| 2.4 | Connect project + project activity log | S–M | nothing |
| 2.5 | Log / Hide on read-me lines + quick notes | S | 2.2 (Hide opens the modal) |
| 2.6 | Second brain pages, nightly filing, vault import/export | M–L | 2.5 |
| 2.7 | Search on My Day + `search_brain` MCP tool | S–M | 2.6 |
| 2.8 | Nightly cloud schedule + regression replay | M | 2.1–2.3, IT/Lee sign-off |
| 2.9 | Optional: in-app Claude API (Ask box, Claude-proposed rules) | M | 2.7, API key decision |

**Infrastructure note (2026-11-13):** the hosted Supabase project is over its free-tier usage while IT stands up a self-hosted Supabase and a Docker host for the Fly apps. These milestones add very little load (see "Usage footprint" at the end). Code and migrations can be written now; apply migrations once it's clear which limit is exceeded, or after the move.

---

## 2.1 Reviewed log + "Surface this"

The run header ("mail 77 · Teams 112 · monday 7") becomes a button. It opens everything the run looked at, grouped by where it landed and why, with a **Surface this** button on anything that didn't make the list.

### 2.1.1 Database (`add_worklist_reviewed.sql`)

```sql
create table if not exists public.worklist_reviewed (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  briefing_id   uuid not null references public.worklist_briefings(id) on delete cascade,
  source        text not null check (source in ('email', 'teams', 'monday')),
  source_key    text not null,             -- same rules as worklist_items.source_key
  title         text not null,             -- subject, chat name, or monday item name
  from_label    text,
  link          text,
  outcome       text not null check (outcome in ('respond', 'do', 'decide', 'read_me', 'set_aside', 'dropped', 'carried')),
  reason        text not null,             -- one line from the model
  reason_group  text not null,             -- short label to group by, e.g. "CC only, no ask"
  item_id       uuid references public.worklist_items(id) on delete set null,
  surfaced_at   timestamptz,               -- set when Seth surfaces it by hand
  created_at    timestamptz not null default now(),
  unique (briefing_id, source_key)
);
```

- One row per **conversation**, not per message: an email thread, a Teams chat's asks in the window, a monday item. That keeps a run around 150–250 rows.
- A same-day re-run replaces that briefing's rows (delete + insert in one transaction), except rows Seth already surfaced.
- **Retention:** rows older than 30 days are deleted at the start of each save. Surfaced rows are kept: they're the regression set (2.8).
- `save_reviewed(p_date date, p_rows jsonb)` RPC (SECURITY INVOKER, max 400 rows).
- `surface_reviewed(p_id uuid, p_kind text, p_urgency smallint)` RPC: creates or reopens the worklist item with the same `source_key` (kind and urgency from Seth's pick, reason "Surfaced by you from the reviewed list"), links it back, and sets `surfaced_at`. A trigger logs a `surfaced` row in `worklist_feedback` with the snapshot, so the skill sees every miss.

### 2.1.2 MCP and skill

- `save_briefing` accepts an optional `reviewed` array and saves it right after the briefing.
- `get_worklist_state` returns `recently_surfaced`: what Seth pulled out of the reviewed list in the last 30 days, with the run's original reason. The skill treats each one as a hard lesson: "you put this in *Set aside: vendor marketing*; Seth surfaced it as a Respond."
- **Skill (Step 9):** build one `reviewed` row for every conversation it looked at, including the ones it dropped by category (notifications, newsletters, social). `reason_group` uses a small fixed vocabulary first (the Set aside categories plus "CC only, no ask", "already answered", "not addressed to Seth", "monday: not due"), so grouping is stable from run to run.

### 2.1.3 Page

- The run-health line becomes a button that opens a **Reviewed** panel (a right-hand drawer).
- Tabs or filter chips by outcome: *On the list · Read me · Set aside · Dropped*, each with a count. Within each, rows are grouped by `reason_group`, with a search box over title and sender.
- Each row: source icon, title, from, the one-line reason, link out. Rows not on the list get **Surface this** → choose Respond / Do / Decide and an urgency → the task appears in the worklist right away.
- The drawer loads its rows only when opened, so the normal page load stays small.

### 2.1.4 Done when

- After a run, every conversation the briefing mentions (tasks, read-me lines, set-aside lines) is in the drawer, and its "On the list" count matches the tasks the run created or carried. (The header's mail/Teams numbers count messages; the drawer counts conversations, so those two differ.)
- Surfacing a dropped email creates a task immediately and survives the next run.
- The next run's `get_worklist_state` includes the surfaced item, and the skill's output reflects it (checked by hand over a few days).

## 2.2 Tuning rules

From the phase 3 spec's "Triage tuning", adjusted to work without an in-app model call.

### 2.2.1 Database

```sql
create table if not exists public.triage_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('hard', 'lesson')),
  match          jsonb,                    -- hard rules: {sender, domain, subject_terms[], teams_chat, monday_board}
  effect         text not null check (effect in ('min_read_me', 'min_task', 'suppress')),
  example_id     uuid references public.worklist_reviewed(id) on delete set null,
  note           text,                     -- Seth's words
  active         boolean not null default true,
  created_from   text not null check (created_from in ('surface_more', 'surface_less', 'manual')),
  hits_30d       integer not null default 0,
  created_at     timestamptz not null default now()
);
```

Plus `rule_ids uuid[]` on `worklist_reviewed`, so every row shows which rules fired on it.

### 2.2.2 How rules run

- **Hard rules:** a new MCP tool, `match_triage_rules(candidates[])`, takes the run's candidate conversations (source, sender, domain, subject, chat, board) and returns, per candidate, the rules that match and the resulting floor or ceiling. The skill must apply them: `min_task` can't land below a task, `min_read_me` can't land below Read me, `suppress` goes to Set aside. Matching is plain code, so it's the same every run.
- **Lessons:** `get_worklist_state` returns active lessons with their example rows; the skill reads them as examples before classifying.

### 2.2.3 The modal

1. **Surface more of this** (on any reviewed row not on the list) or **Surface less of this** (on a task, a read-me line, or a Dismiss).
2. The form is pre-filled from the item: sender, domain, a couple of subject words, the chat or board. Seth trims it and adds an optional note.
3. **Hard rule or lesson?** Hard if the match fields describe it; lesson if it's a judgment call ("schedule changes from GCs, even FYI").
4. **Preview** (hard rules only): the match runs as a SQL query against today's reviewed rows. "This would also surface 9 other items", with the list, before saving.
5. Save, edit or cancel. It applies from the next run.

Claude proposing the rule itself (spec step 3) needs a model call from the app. Deferred to 2.9; until then the nightly run can suggest rules in its chat summary.

### 2.2.4 Rules page

A settings view under My Day: every rule with kind, match, effect, note, 30-day hit count, and toggles to edit, disable or delete.

### 2.2.5 Done when

- A hard rule on a sender changes where that sender's mail lands on the very next run, every time.
- The preview's count matches what the next run actually does with today's items.
- Weekly consolidation (merge duplicates, retire rules that never fire, promote stable lessons into the skill) is proposed in the Monday briefing and applied only after Seth approves.

## 2.3 Work-type tagging (phase 3 groundwork)

- Add `work_type` (`reply`, `dtools_report`, `ipt_change`, `none`) and `work_confidence` (0–1) to `worklist_items`.
- The skill tags every task it creates. Nothing acts on the tag yet.
- My Day shows the tag as a small, editable chip. A correction is logged as feedback, which builds the hand-checked sample for phase 3's 90% gate.

## 2.4 Connect project

### 2.4.1 Database (new migration `add_worklist_projects.sql`)

```sql
alter table public.worklist_items
  add column if not exists project_id           uuid references public.projects(id) on delete set null,
  add column if not exists suggested_project_id uuid references public.projects(id) on delete set null;

create table if not exists public.project_activity (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  item_id      uuid references public.worklist_items(id) on delete set null,
  kind         text not null check (kind in ('linked', 'done', 'reopened', 'note')),
  title        text not null check (char_length(title) <= 300),
  detail       text check (char_length(detail) <= 2000),
  occurred_at  timestamptz not null default now()
);
create index if not exists idx_project_activity_project on public.project_activity (project_id, occurred_at desc);
```

- **Trigger on `worklist_items`** (SECURITY DEFINER, like `worklist_log_feedback`): write `linked` when `project_id` goes from null to a value, `done` when a linked item's status becomes done, and `reopened` when it goes back to open. Title = the item title. The trigger is the only writer, so the log can't drift from the list.
- **RLS:** owner-only to start (see open decision 1). Users get select; inserts come only from the trigger.
- Add `project_id` and `suggested_project_id` to `save_briefing()`'s item upsert. The skill may set `suggested_project_id` only, **never** `project_id`. Linking is the user's call.

### 2.4.2 Page

- **Link button on each row** (icon next to snooze/dismiss) opens a "Connect project" modal. The modal searches the projects already in the Zustand store (`useStore().projects`) by name, number, client, and `project_code`, with no extra query.
- **Linked rows** show a small project chip (code + short name) that links to `/projects/:id`, with an unlink "x".
- **Suggested link:** when `suggested_project_id` is set and `project_id` isn't, the row shows "Link to INST-2026-0123 · Paterson 911?" with one-click confirm or dismiss. Confirm sets `project_id`; dismiss clears the suggestion.
- **`useWorklist`:** add `linkProject(id, projectId | null)` and `confirmSuggestion(id)`. Both are optimistic, like the existing writes.
- **Project page (follow-on, small):** a "Seth's activity" panel on `ProjectOverview` listing `project_activity` for that project.

### 2.4.3 Skill and MCP

- `get_worklist_state` returns `project_id` and `suggested_project_id` on open items.
- **Suggestion rules in the skill** (new Step 7b), confident matches only:
  - monday items: match `monday:<itemId>` against `projects.monday_presales_item_id` / `monday_postsales_item_id` (both `bigint`, unique). This is exact, so always suggest it. Programming-board and Triage items have no column on `projects`, so they get no suggestion.
  - email/Teams: suggest only when the subject or summary contains a project's `project_code` or its exact number. No fuzzy name matching yet.
  - It needs one read tool: `find_projects(codes[], numbers[], monday_item_ids[])`, which returns `id, project_code, number, name`. The existing `list_projects` search could do it one query at a time; a batch lookup keeps the run small.
- Once you've linked a few dozen by hand, revisit fuzzy matching. Your manual links are the test set.

### 2.4.4 Done when

- Linking a task shows the chip, writes a `linked` activity row, and survives a re-run of the skill.
- Marking a linked task done writes a `done` row; undo writes `reopened`.
- A monday task whose item id matches a project shows a suggestion after the next skill run.
- The skill can't set `project_id` (covered by an RPC test in the smoke script).

## 2.5 Log / Hide on read-me lines

### 2.5.1 Database (migration `add_brain.sql`, part 1)

```sql
create table if not exists public.brain_raw (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  captured_at    timestamptz not null default now(),
  source         text not null check (source in ('readme', 'note', 'task', 'claude')),
  text           text not null check (btrim(text) <> '' and char_length(text) <= 4000),
  link           text check (char_length(link) <= 2000),
  briefing_date  date,              -- for source = 'readme'
  readme_id      text,              -- the read-me line's id within that briefing
  status         text not null default 'new' check (status in ('new', 'filed', 'discarded')),
  filed_at       timestamptz,
  page_id        uuid               -- FK added in 2.6
);

create table if not exists public.worklist_readme_state (
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  briefing_date  date not null,
  readme_id      text not null,
  state          text not null check (state in ('logged', 'hidden')),
  readme_text    text,              -- snapshot, for calibration
  readme_source  text,
  at             timestamptz not null default now(),
  primary key (user_id, briefing_date, readme_id)
);
```

- Both tables are owner-only, with RLS and grants like the worklist tables.
- Read-me ids are only unique within a briefing; that's why the key includes `briefing_date`. The skill already writes `r1`, `r2`, and so on.

### 2.5.2 Page

- **Read-me lines:** each line in `ReadMeCard` gets two quiet buttons on hover: **Log** (bookmark icon) and **Hide** (eye-off icon).
  - Log inserts into `brain_raw` (source `readme`, text, link, briefing date, read-me id) and upserts `worklist_readme_state` = `logged`. The line stays, with a small "logged" tick.
  - Hide upserts `hidden`. The line collapses into a "1 hidden · undo" footer.
- **Quick note:** an input at the top of the side column ("Jot something for your second brain…") inserts a `brain_raw` row with source `note`. The capture habit doesn't need a read-me line to start from.
- `useWorklist` loads `worklist_readme_state` for the briefing date and exposes `logReadMe`, `hideReadMe`, `undoReadMe`, and `addNote`.

### 2.5.3 Skill

- `get_worklist_state` also returns read-me states for the last 14 days.
- Hide is a "surface less of this" entry point: it opens the 2.2 tuning modal pre-filled from the line. Logged lines are the opposite signal (more of that, please) and reach the skill as calibration.

### 2.5.4 Done when

- Log and Hide survive reload, and undo works.
- Logged lines appear in `brain_raw` with status `new`.
- A hidden pattern changes what the next run puts in the Read me (check by hand over a few days).

## 2.6 The second brain organizes itself

### 2.6.1 Database (migration `add_brain.sql`, part 2)

```sql
create table if not exists public.brain_pages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  title       text not null check (btrim(title) <> '' and char_length(title) <= 200),
  kind        text not null default 'topic' check (kind in ('topic', 'person', 'project', 'company', 'index', 'note')),
  summary     text check (char_length(summary) <= 1000),   -- 1-3 sentences, kept current
  body        text not null default '',                     -- markdown; [[slug]] links between pages
  tags        text[] not null default '{}',
  project_id  uuid references public.projects(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search_tsv  tsvector generated always as (
                setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(summary, '') || ' ' || array_to_string(tags, ' ')), 'B') ||
                setweight(to_tsvector('english', coalesce(body, '')), 'C')
              ) stored,
  unique (user_id, slug)
);
create index if not exists idx_brain_pages_search on public.brain_pages using gin (search_tsv);

create table if not exists public.brain_page_versions (   -- undo for every write
  id          bigserial primary key,
  page_id     uuid not null references public.brain_pages(id) on delete cascade,
  user_id     uuid not null,
  body        text not null,
  summary     text,
  written_by  text not null check (written_by in ('user', 'claude')),
  written_at  timestamptz not null default now()
);

alter table public.brain_raw
  add constraint brain_raw_page_fk foreign key (page_id) references public.brain_pages(id) on delete set null;
```

- A BEFORE UPDATE trigger on `brain_pages` copies the old body and summary into `brain_page_versions`. Every edit Claude makes can be rolled back.
- `file_brain_raw(p_page jsonb, p_raw_ids uuid[])` RPC (SECURITY INVOKER) upserts a page by slug and marks those raw rows `filed` with `page_id`, in one transaction.

### 2.6.2 MCP tools (`mcp-server/src/brainTools.ts`, admin-only, added to `TOOL_SCOPES`)

| Tool | Scope | Does |
|---|---|---|
| `get_brain_inbox` | read | `brain_raw` rows with status `new`, oldest first (limit 50) |
| `search_brain` | read | calls the `search_brain()` RPC (2.7.1); returns slug, title, summary, snippet, rank |
| `get_brain_page` | read | one page by slug, including body and its `[[links]]` |
| `file_brain_raw` | write | the RPC above: create or append to a page, mark raw rows filed |
| `discard_brain_raw` | write | mark raw rows `discarded` with a reason (duplicates, noise) |

### 2.6.3 Skill: new Step 10, "File the inbox"

Runs after `save_briefing`, capped at **20 raw notes and 10 page writes per run**. Leftovers wait for tomorrow.

1. `get_brain_inbox`. For each note, `search_brain` for the right home page.
2. Good match → append under a dated heading (`### 2026-11-05`) with the source link, and refresh that page's `summary` if the note changes the picture.
3. No match → create a page (pick `kind`, a short slug, and `[[links]]` to related pages). A note about a project gets `kind: project` and `project_id` when the project is clear.
4. **Index pages:** keep one `index` page per kind (`people`, `projects`, `topics`) listing pages with their one-line summaries. These indexes are what keep search and Claude's answers good as the brain grows.
5. **Rules:** never delete page content; edit only by appending or rewriting the summary. Never copy a message body; the raw note is already a summary. Duplicates go through `discard_brain_raw` with a reason.
6. The chat summary gets one line: "Filed N notes into M pages (new: …)".

### 2.6.4 Obsidian bridge

- **Import (one time):** `scripts/import-vault.mts <vault path>` reads every `.md` file. Notes in the vault's raw folder become `brain_raw` rows; organized notes become `brain_pages` (slug from the filename, frontmatter tags → `tags`, `[[wikilinks]]` kept as is). It runs as Seth through a minted user JWT, like the smoke scripts, and prints a dry-run summary before writing.
- **Export (any time):** `scripts/export-brain.mts <folder>` writes each page as `<slug>.md` with YAML frontmatter (title, kind, tags, updated). It's one-way, so point Obsidian at the export folder and treat it as read-only. Two-way sync is explicitly out of scope; it's where these setups usually break.

### 2.6.5 Done when

- Logged notes are filed by the next morning run, with an undo-able version row for every page edit.
- The vault import's dry run matches the vault's file count; after import, `search_brain` finds pages by title and by body text.
- Exported files open in Obsidian with working links.

## 2.7 Search

### 2.7.1 `search_brain(p_query text, p_limit int default 20)` RPC

- SECURITY INVOKER (RLS applies). `websearch_to_tsquery('english', p_query)` over `search_tsv`, ranked by `ts_rank_cd`, with `ts_headline` snippets from the body.
- Also returns matching `brain_raw` notes that aren't filed yet, so a note logged this morning is findable today.
- Same shape as `search_project_wiki()`; reuse its approach.

### 2.7.2 Page

- **"Search my notes"** box at the top of My Day's side column. Results show title, kind, and a highlighted snippet.
- Clicking a result opens a drawer with the page rendered as markdown. The app doesn't have a markdown renderer yet: add `react-markdown` + `remark-gfm`, rendering `[[slug]]` as in-drawer links.
- A "Browse" link opens the index pages. A full `/brain` page can wait until the drawer feels cramped.

### 2.7.3 Asking Claude

Nothing to build beyond the `search_brain` and `get_brain_page` tools. In Claude Code or claude.ai, "what did we decide about the HGTC quote?" searches, reads pages, and answers with links. This is the no-API "Ask" and should cover most needs.

### 2.7.4 Done when

- Search returns relevant pages in under a second for a few-word query, including today's unfiled notes.
- Claude answers a question from the brain with page links, through the connector.

## 2.8 Nightly cloud schedule + regression replay

- **Cloud routine:** the morning skill runs on a schedule (target 5:00am Eastern) as a scheduled cloud routine. It needs: the skill without the local markdown file (retire it once the page is trusted), the M365, monday and Project Tools connectors available in the cloud, and **IT/Lee sign-off** on company M365, Teams and monday data running through scheduled cloud jobs. Raise the sign-off now; it's the slowest dependency for phase 3 too.
- **Regression replay:** every surfaced row (2.1) and every rule-correction example (2.2) is a test case: "this conversation should land in this bucket." Hard rules are checked in code against the saved rows on every rules change. Lessons need the model, so `/morning-worklist replay` re-classifies the test set on demand and lists any item that flips. Run it after any skill or rule change.
- **Run report** in the briefing (from the phase 3 spec): reviewed, surfaced, rules fired, and any failures at the top.

## 2.9 (optional) In-app Claude API: "Ask" box on the page

Build only if 2.7.3 isn't enough day to day.

- **Supabase Edge Function `ask-brain`:** checks the caller's JWT (admin only), runs `search_brain` for the top 8 pages, sends them plus the question to the Claude API, and returns the answer with cited slugs.
- **Needs:** an Anthropic API key stored as a Supabase secret, per-use billing (this is the cost phase 1 avoided), a per-user rate limit, and a token cap per question.
- **Later, only if keyword search misses too often:** add `pgvector` embeddings per page for meaning-based search. That needs an embedding API, another cost decision. Tidy index pages (2.6.3, step 4) push this need out a long way.

---

## Phase 3: workers (changes to the spec)

The spec in `work-engine-phase-3-spec.md` stands: stage-don't-ship, triage → dispatch → workers → one approval queue, the five-rule worker contract, the autonomy ladder and the build-order gates. These are the changes now that phase 1 and 2's actual design is known:

1. **Groundwork moves into phase 2.** The spec's milestone 1 (work-type tagging, the reviewed log, rules, the modal, the regression set) is 2.1–2.3 and 2.8 here.
2. **Names.** The spec's `tasks` table is `worklist_items`. Its `source_ref` is mostly `source` + `source_key` + `link`; add `source_ref jsonb` only for what workers need beyond that (thread id, message id). `triage_items` / `triage_runs` are `worklist_reviewed` / `worklist_briefings`.
3. **Email drafts: the worker writes text, the dashboard makes the draft.** The M365 connector can send but can't create drafts, and the app's own Outlook sign-in (`ms-graph-auth`) only has `Mail.Read`. So:
   - The email drafter stores the draft text, recipients and the thread reference in its `work_items` row. It holds no mail-write permission at all.
   - **Approve** and **Open in Outlook** run in the browser under Seth's login: they create the reply draft (or send it) through Microsoft Graph. That needs `ms-graph-auth` extended from `Mail.Read` to `Mail.ReadWrite` + `Mail.Send` (delegated). Check with IT whether Seth can consent to that himself.
   - This is stricter than the spec's "create and update drafts" permission for the worker, and it removes the spec's open question about Teams: Teams drafts are text in the work item either way.
4. **D-Tools reporter can start before the MCP.** Project Tools already calls the D-Tools Subscribe API (`supabase/functions/dtools-list-projects`, `dtools-project-lookup`, key in `DTOOLS_API_KEY`) and already writes into each project's SharePoint folder (`sharepoint-project-files`, indexed in `project_files`). A BoM-report worker can use those plus the existing dtools-bom skill. Answer to the spec's open question: reports go in the project's SharePoint folder, indexed in `project_files`, which the IPT project page and MCP already browse.
5. **No service role for workers.** Workers act as Seth through the MCP server, as phase 1 does; RLS and database functions enforce the rules. "Only Seth can set `decision`" becomes a column grant plus a trigger, and the kill switch is a settings row the claim function checks.
6. **IPT code planner** runs as a cloud Claude Code session on an `auto/*` branch, exactly as specced. It can never apply migrations to the production Supabase; it writes migration files only.
7. **Infrastructure.** Once the self-hosted Supabase is up, workers and the nightly routine point at it. See "Usage footprint" below for what moves.

## Open decisions

1. **(2.4) Who sees project activity?** Owner-only to start, or everyone who can see the project? Recommendation: owner-only now.
2. **(2.6) Where is the current second-brain vault, and how is it laid out?** Needed for the import script.
3. **(2.6) Auto-file or confirm?** Recommendation: auto-file, with version rows for undo.
4. **(2.8) IT/Lee sign-off** on scheduled cloud jobs reading company M365, Teams and monday. Ask now.
5. **(Phase 3) Delegated Graph consent** for `Mail.ReadWrite` + `Mail.Send` on the app's own Outlook sign-in.
6. **(2.9) API key or not?** Decide after a couple of weeks of 2.7.

## Usage footprint (for the Supabase move)

| Milestone | Rows | Size | Reads per page load |
|---|---|---|---|
| Phase 1 (live) | ~10–20 items/day, 1 briefing/day | well under 1 MB/month | ~20–50 KB |
| 2.1 reviewed log | ~150–250 rows/run, 30-day retention | ~2–4 MB at steady state | 0 until the drawer opens (~50–100 KB) |
| 2.2 rules | dozens of rows | negligible | small |
| 2.4–2.7 projects, brain, search | a few notes/day; pages grow slowly | a few MB/year | small; search is server-side |

Realtime: one channel per open My Day tab. None of this is what put the project over its free-tier limit. For comparison, the app's `DataLoader` fetches whole tables (`select=*` on BoM items, submittal items and more) on every sign-in, which is likely the larger bandwidth cost.

**Moving to self-hosted:** the worklist tables travel with a normal `pg_dump`. The MCP server mints its own Supabase JWTs with the project's HS256 secret, so it needs the new instance's `JWT_SECRET`, URL and anon key; Realtime must be enabled on the new instance for My Day's live refresh.

## Next steps

1. **2.1** on branch `my-day/reviewed-log`: migration, MCP, skill, Reviewed drawer. Apply the migration once the Supabase usage situation is clear.
2. **2.2** right after, on its own branch.
3. Raise open decision 4 (IT/Lee sign-off) now, in parallel.
