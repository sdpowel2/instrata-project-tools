# Project Tools — Project Wiki Data Spec

Data model and MCP surface for the project wiki/notes feature in Project Tools. Serves two
consumers:

1. **The AVSS Bid Pipeline skill**, writing design validation output via MCP.
2. **Engineers authoring by hand** on design-build projects with no pipeline run.

Both are first-class. Nothing in the model may assume a pipeline produced the content.

**Companion files:** `labor-estimating-rules.md`, `review-checklist.md`.

---

## 1. Design principles

**The index guarantee is structural, not editorial.** The bid pipeline brief requires a
guaranteed one-line entry per room regardless of outcome, so that silence is never ambiguous
between "checked and fine" and "never covered." In a filesystem wiki that's a discipline the
agent must remember. Here the index is a **query over room records**, so an unindexed room
cannot exist. `status` is `NOT NULL` — that single constraint enforces the guarantee.

**Decisions are records, not prose.** The target retrieval case is "why are there 3
transmitters and 4 receivers in room 311?" answered without re-reading the room. That works
when the rationale is an addressable row, not a sentence buried in a markdown blob.

**Depth is proportional.** A clean room has a headline and no decisions. A messy room has many.
The model must not require filler to be well-formed — every long-form field is nullable.

**Human-authored is not a degraded mode.** `origin` distinguishes provenance; it does not
gate validity. A hand-written room with no labor rows and no decisions is a complete,
valid record.

---

## 2. Stack assumptions

Written against the conventions visible in the existing Project Tools API: UUID primary keys,
`project_id` foreign keys, snake_case, soft ordering via `sort_order`, timestamps on
everything. Adjust naming to match house style — the shape matters more than the labels.

Long-form text fields are **markdown**. The existing D-Tools location string is carried as a
plain field rather than a foreign key, since locations are strings in D-Tools exports.

---

## 3. Entities

### 3.1 `project_wiki`

One row per project. Holds the narrative context that doesn't belong on the `projects` record.
Separate table so a wiki can be created without touching project data.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | unique; one wiki per project |
| `summary` | text, null | Project-level orientation. Markdown |
| `scope_summary` | text, null | What the AV scope covers, in prose |
| `design_basis` | text, null | Which consultant documents the design derives from, and their revision/date |
| `status` | enum `wiki_status` | see §4.1 |
| `pipeline_run_at` | timestamptz, null | Null on hand-authored wikis |
| `created_by` | uuid FK → users | |
| `created_at` / `updated_at` | timestamptz | |

### 3.2 `project_room`

One row per room or subsystem. **The unit of the index guarantee.**

"Subsystem" matters — not every entry is a physical room. A head-end rack, a paging zone, or a
building-wide distribution system each gets a row.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | |
| `room_number` | text, null | e.g. `311`. Null for non-room subsystems |
| `room_name` | text | e.g. `Md Conference 2` |
| `floor` | text, null | e.g. `2nd Floor` |
| `dtools_location` | text, null | Full D-Tools location string, e.g. `2nd Floor: 236 - Md Conference 2` |
| `sort_order` | integer | Print/display order; mirrors D-Tools location ordering |
| `entry_kind` | enum `entry_kind` | see §4.2 |
| `room_type` | text, null | e.g. `Small Conference`. Free text; groups typicals |
| `area_sqft` | numeric, null | |
| `size_class` | enum `size_class`, null | see §4.3. Null where undetermined |
| `size_basis` | enum `size_basis`, null | Which signal classified it — see §4.4 |
| `has_conferencing` | boolean, null | Drives commissioning tier |
| `typical_of_count` | integer, null | `5` for "Typical of 5" |
| `typical_of_rooms` | text[], null | Explicit roster of covered room numbers |
| `status` | enum `room_status` **NOT NULL** | see §4.5 — enforces the index guarantee |
| `headline` | text **NOT NULL** | The one-line index entry. Keep short |
| `detail` | text, null | Long-form design notes. Markdown |
| `validation_notes` | text, null | The math: counts, coverage, headroom, power |
| `origin` | enum `origin` | see §4.6 |
| `created_by` | uuid FK → users | |
| `created_at` / `updated_at` | timestamptz | |

**`typical_of_rooms` is the fix for the ambiguity gap.** A "Typical of 5" location is one
record, but the roster names all five physical rooms, so no room is silently unmentioned.

**Constraints**

- `status` and `headline` are `NOT NULL` — a room cannot exist un-indexed or unlabelled
- unique on `(project_id, dtools_location)` where `dtools_location` is not null
- `typical_of_count` and `array_length(typical_of_rooms)` should agree; warn rather than reject

### 3.3 `room_decision`

The queryable rationale layer. `room_id` nullable so project-level decisions are expressible.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | denormalized for project-wide queries |
| `room_id` | uuid FK → project_room, null | Null = project-level decision |
| `kind` | enum `decision_kind` | see §4.7 |
| `title` | text | The decision, one line. e.g. `3 transmitters, 4 receivers` |
| `rationale` | text | Why. Markdown. **This is the field the retrieval case reads** |
| `source_ref` | text, null | Consultant doc, sheet number, spec section |
| `assumption_confirmed` | boolean, null | Only meaningful when `kind = 'assumption'` |
| `origin` | enum `origin` | |
| `created_by` | uuid FK → users | |
| `created_at` / `updated_at` | timestamptz | |

Append-mostly. Edits are legitimate but the table is not a place to overwrite history —
supersede with a new row and note it in `rationale` where the distinction matters.

### 3.4 `room_question`

The `_questions-log.md` equivalent. Carries the two-tier escalation split.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | |
| `room_id` | uuid FK → project_room, null | Null = project-level |
| `severity` | enum `question_severity` | see §4.8 — drives interrupt vs batch |
| `question` | text | |
| `context` | text, null | What the agent saw that prompted it |
| `status` | enum `question_status` | see §4.9 |
| `answer` | text, null | The human's answer, verbatim |
| `resolution` | text, null | The resulting decision |
| `resulting_decision_id` | uuid FK → room_decision, null | Links answer → logged decision |
| `raised_by` | uuid FK → users | |
| `answered_by` | uuid FK → users, null | |
| `raised_at` | timestamptz | |
| `answered_at` | timestamptz, null | |

**`severity` is load-bearing.** `functional_conflict` interrupts the run, one question at a
time. `estimating_escalation` batches into a single "needs your input" list. Conflating them
recreates the question-volume problem the pipeline exists to avoid.

### 3.5 `room_labor`

Calculated labor by bucket. Optional per room — hand-authored rooms may have none.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `room_id` | uuid FK → project_room | |
| `labor_type` | enum `labor_type` | see §4.10 |
| `hours` | numeric **NOT NULL** | `0.00` is meaningful and must be stored, not omitted |
| `basis` | text, null | The inputs that produced it, e.g. `2 displays + 12 speakers + 1 rack` |
| `origin` | enum `origin` | |
| `created_at` / `updated_at` | timestamptz | |

**Zero rows are real rows.** The CSV spec requires all four per-room labor rows even at
`0.00`, on the same anti-ambiguity logic as the index guarantee. Do not treat absence and zero
as equivalent anywhere in this model.

Unique on `(room_id, labor_type)`.

### 3.6 Link tables

| Table | Purpose |
|---|---|
| `room_bom_line` | `room_id` ↔ existing BoM line item id. Ties the wiki to the estimate |
| `room_file` | `room_id` ↔ existing project file id. Drawings, sketches, RCPs per room |

Both carry `created_at` and a nullable `note`.

---

## 4. Enums

### 4.1 `wiki_status`
`draft` · `in_progress` · `awaiting_review` · `reviewed` · `final`

`awaiting_review` is the explicit human-gate marker the brief asked for — a status a
non-technical user can see without knowing to check back in.

### 4.2 `entry_kind`
`room` · `subsystem` · `head_end` · `zone` · `project_wide`

### 4.3 `size_class`
`small_medium` · `large_xl` · `oversize`

`oversize` means past 1,500 sq ft — always escalates.

### 4.4 `size_basis`
`sqft` · `seat_count` · `display_count` · `stated` · `undetermined`

Records which signal classified the room, per the labor rules fallback.

### 4.5 `room_status`
| Value | Meaning |
|---|---|
| `pending` | Record exists, not yet evaluated |
| `clean` | Validated, no issues |
| `noted` | Non-functional deviation accepted; proceeded on consultant's number |
| `escalated` | Question raised, unresolved. **Blocking** |
| `resolved` | Question raised and answered; decision logged |
| `authored` | Human-written, no pipeline validation performed |

### 4.6 `origin`
`agent` · `human` · `agent_human_edited`

Provenance only. Never gates validity or read access.

### 4.7 `decision_kind`
`validated` · `deviation_accepted` · `assumption` · `rationale` · `escalation_outcome`

`assumption` is the one the review stage cares about most — a recorded assumption should read
as an assumption, not a finding. UI page count is the standard case.

### 4.8 `question_severity`
`functional_conflict` · `estimating_escalation`

### 4.9 `question_status`
`open` · `answered` · `resolved` · `withdrawn`

### 4.10 `labor_type`
`install` · `cabling` · `bench` · `commissioning` · `programming` · `engineering` ·
`mobilization` · `training`

Exactly the D-Tools vocabulary. Travel is deliberately absent — it is human-quoted in D-Tools.

---

## 5. Derived views

### 5.1 Room index

Replaces the hand-maintained one-line-per-room list. Ordered by `sort_order`.

```
sort_order | room_number | room_name | status | headline | decision_count | open_questions
```

Because it's a query, a room with no index entry is impossible. Rooms at `escalated` and
questions at `open` should surface distinctly — those are the blocking set.

### 5.2 Project wiki render

`project_wiki` context, then the room index, then per-room detail on drill-down. This is also
the markdown export shape (§7).

### 5.3 Open items

All `room_question` rows at `open` or `answered`-but-unresolved, across the project, grouped by
`severity`. This is the "needs your input" batch.

---

## 6. MCP tool surface

New tool group, sibling to the D-Tools group. **Read**

| Tool | Returns |
|---|---|
| `get_project_wiki` | `project_wiki` + room index |
| `list_project_rooms` | Index rows; filter by `status`, `room_type` |
| `get_project_room` | Full room + decisions + questions + labor + links |
| `list_room_decisions` | Decisions; filter by `kind`, scope to room or project |
| `list_project_questions` | Questions; filter by `severity`, `status` |
| `search_project_wiki` | Full-text across `headline`, `detail`, `rationale`, `validation_notes`. **The retrieval case runs through here** |

**Write**

| Tool | Behavior |
|---|---|
| `upsert_project_wiki` | Create or update project-level context |
| `upsert_project_room` | Create or update by `(project_id, dtools_location)` or `id`. Idempotent — safe for pipeline re-runs |
| `set_room_status` | Status transition, with optional headline update |
| `append_room_decision` | Add a decision. Append-only by design |
| `set_room_labor` | Replace the labor set for one room. Must accept `0.00` |
| `raise_room_question` | Create at `open` |
| `answer_room_question` | Record answer, optionally create the resulting decision and link it |
| `link_room_bom_lines` / `link_room_files` | Populate link tables |

**Idempotency matters more than it looks.** Re-runs and partial updates are an unresolved
pipeline question; `upsert_project_room` keyed on the D-Tools location means a re-run reconciles
rather than duplicating. Build it idempotent now even before that question is settled.

---

## 7. Markdown export mapping

Project Tools is the source of truth; the markdown wiki becomes a **generated snapshot**, not a
parallel record. Mapping to the brief's folder structure:

| Output path | Source |
|---|---|
| `wiki.md` | `project_wiki` + room index view |
| `01-Design/room-<number>.md` | One `project_room` + its decisions, labor, links |
| `_questions-log.md` | `room_question`, chronological, with answers and resolutions |
| `02-Estimating/equipment-labor-breakdown.md` | `room_labor` across rooms, with `basis` |

Export is one-way. If the folder must stand alone for someone without Project Tools access,
regenerate rather than edit in place.

---

## 8. Open items

- **Round-trip.** Spec assumes one-way export. If engineers will edit markdown and expect it
  back, that's an import path and a merge policy — materially more work. Confirm before build.
- **Re-run reconciliation.** `upsert_project_room` keyed on location handles the mechanics, but
  the policy is unsettled: when a revised drawing lands, does a `clean` room reset to `pending`,
  or hold status until re-validated? Affects whether re-runs discard human answers.
- **Pipeline state.** If `room_status` plus `wiki_status` prove sufficient to determine stage
  position, no separate `_pipeline-state` file is needed. Likely true; confirm during testing.
- **Review isolation.** `get_project_room` is review's input contract. Whether it should expose
  `validation_notes` (the design stage's reasoning) or only decisions and rationale is the
  open question — exposing the full trail invites rubber-stamping.
- **Permissions.** Whether wiki content follows existing project-level permissions or needs its
  own scoping, particularly for `awaiting_review` visibility.
