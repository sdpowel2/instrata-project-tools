---
name: procore-updates
description: >-
  Summarize what's new and AV-relevant on a construction project in Procore.
  Use when the user asks for "updates on <project>", "what's new on <project>",
  "anything AV-related on <project>", or to review recent RFIs, submittals,
  change events, daily logs, or drawings/specs for a job. Requires the Instrata
  Procore MCP connector to be connected.
---

# Procore updates (AV focus)

You help Instrata AV engineers stay current on general contractors' Procore
projects. Instrata is a low-voltage/AV subcontractor, so the goal is to surface
what actually affects **audiovisual scope** — not to dump every project event.

The Procore MCP server is generic and read-only; **the AV-relevance judgment is
yours**, using the heuristics below.

## Procedure

1. **Resolve the project.** Call `find_project` with the user's nickname (e.g.
   "LEGO"). If there are multiple strong matches, ask the user which one before
   continuing. If none match, say so and offer `list_projects`.
2. **Get the digest.** Call `get_project_activity` for the resolved `project_id`.
   Use the user's stated "since I last checked" date if given; otherwise the
   default 14-day window. Sections marked `access:"forbidden"` mean the user
   lacks that permission on this project — note it briefly, don't treat it as an
   error.
3. **Drill into promising items.** For anything that looks AV-relevant, pull
   detail: `get_rfi`, `get_submittal`, `get_change_event`, or `read_document`
   (for a spec section or drawing). Prefer reading the actual RFI/spec text over
   guessing from the title.
4. **Summarize**, grouped into exactly these three buckets:
   - **🔴 Action needed by us** — anything where Instrata is ball-in-court, an RFI
     awaiting our input, a submittal we must return, or a due date approaching.
   - **🟡 Affects AV scope** — changes that touch our work even if no action is
     due yet (ceiling/grid changes, power/data relocations, display-wall millwork,
     Div 27/28 revisions, RFIs/COs impacting AV locations).
   - **⚪ FYI** — general project movement worth awareness but not AV-critical.
   Lead with the most urgent bucket. Cite RFI/submittal numbers and dates. If a
   bucket is empty, say so in one line rather than omitting it.

## AV-relevance heuristics

Treat an item as AV-relevant if any of these apply:

- **Spec divisions:** Division **27** (Communications) or **28** (Electronic
  Safety & Security), and related low-voltage sections.
- **Keywords** (in titles, RFI/submittal text, spec sections, document names):
  audiovisual, AV, low voltage, displays, monitor, projector, screen, speaker,
  DSP, microphone, videoconference / VTC / Zoom / Teams room, structured cabling,
  network / VLAN / switch, rack, head-end, conduit / backing / blocking for AV,
  ceiling grid or ceiling tile changes, millwork at display walls, power or data
  at display/camera/speaker locations, floor boxes, pathways.
- **Ball-in-court = Instrata** on any RFI, submittal, or change event — always
  Action-needed regardless of subject matter.
- **Documents:** newly uploaded or revised drawings/specs in folders like
  "Specifications", "Drawings", "AV", or Division 27/28 — worth reading if the
  title suggests AV or the trades above.

When unsure whether something is AV-relevant, include it under **Affects AV
scope** with a one-line note on why it might matter, rather than dropping it.

## Notes

- Never attempt write actions — the connector is read-only by design.
- If `whoami` shows the wrong account or nothing is connected, tell the user to
  reconnect the Procore connector.
- Keep summaries scannable: short bullets, numbers and dates, no raw JSON.
