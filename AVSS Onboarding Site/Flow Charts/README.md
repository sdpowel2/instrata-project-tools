# Instrata Pre-Sales Flow — Mermaid Diagrams

This directory contains the pre-sales process flowcharts for Instrata's AV team, broken into one system map and five project-type branches. Each `.mmd` file is a standalone Mermaid diagram intended for markup and review.

## Files

| File | Purpose |
|---|---|
| `00-system-map.mmd` | High-level view of Phase 1 → branch selection → exits & rollover paths |
| `01-branch-design.mmd` | Branch 1: Design (labor-only design package) |
| `02-branch-design-build.mmd` | Branch 2: Design-Build (design + install) |
| `03-branch-bid.mmd` | Branch 3: Bid (private-sector competitive bid) |
| `04-branch-public-bid.mmd` | Branch 4: Public Bid (public agency, lowest-cost) |
| `05-branch-budget.mmd` | Branch 5: Budget (placeholder pricing) |

## Structural model

The hierarchy is: **Phase → Milestone → Deliverable**

- **Phases** are major stages of the pre-sales process. Phase 1 (Intake & Qualification) is universal; subsequent phases vary by project type.
- **Milestones** are the work that happens within a phase.
- **Deliverables** are the tracked artifacts produced (mapped to Monday.com subitems). Deliverables are numbered uniquely across the entire pre-sales lifecycle for a given project (D1, D2, D3...), not reset per phase.

## Branch entry points

| Branch | New lead | Rollover |
|---|---|---|
| Design | Phase 2 | — |
| Design-Build | Phase 2 | Phase 3 (from Design or Budget) |
| Bid | Phase 2 | Phase 3 (from Design or Budget) |
| Public Bid | Phase 2 | Phase 3 (from Budget only) |
| Budget | Phase 2 | — |

Rollovers happen because a Design project's discovery work and a Budget project's scope draft are sufficient to skip Phase 2 on the next branch. The rollover creates a new project record on the target branch; it doesn't continue the same record.

## Color coding (consistent across all diagrams)

| Color | Meaning |
|---|---|
| Dark navy | Phase headers (the structural spine) |
| Light blue | Milestones (the work) |
| Orange | Deliverables (tracked artifacts → Monday.com subitems) |
| Yellow | Rollover/transition entry points (cross-branch connectors) |
| Green | Terminal states (end of flow) |

## Phase 1 (universal, applies to all branches)

Phase 1 is not redrawn in each branch diagram beyond a single header node — its full structure is:

**Phase 1: Intake & Qualification**
- Milestone 1: Lead Received and Logged
- Milestone 2: Triage
  - Deliverable: Bid/No-Bid Gate
  - Deliverable: Pre-Sales Engineer Assigned
  - Deliverable: Project Type Defined (Bid | Public Bid | Budget | Design | Design-Build)
- Milestone 3: Project Overview
  - Deliverable: Project Overview Created

## Branch descriptions

**Design.** Client has asked for a quote that is just for us to help them design a project. Labor-only quote for the design with a list of what we will be providing with that package. If the client decides to bid the project out from there, the price of the design is invoiced as its own project. If they decide to let this roll into a design-build project, we absorb the cost of the design into the design-build contract.

**Design-Build.** Any project that is brought to us with the explicit direction that the client plans to have us design and install the project when we agree on scope and price. Also the continuation path from a Design project that rolls over.

**Bid.** We've been asked to bid a project that is for a client in the private sector and doesn't need to be a public "lowest cost wins" bid. Our job is to fully validate the consultant's design and provide the best possible engineering, not necessarily the lowest cost. Cost will still be adjusted to normal bid margins, but we won't be seeking the bottom number, just competitive in the landscape we're bidding toward.

**Public Bid.** A bid to an agency that is exclusively looking for the lowest-cost bidder. Typically we would only chase this work in a scenario where we have some relationship with the customer or GC and think there is a higher than usual chance of us winning the project.

**Budget.** A client asks for a budgetary proposal as a placeholder or for requesting funding for a project that's happening in the future. Rarely revised — taken at face value. Almost always re-enters as a Bid / Public Bid / Design-Build later.

## How to view / edit

These are Mermaid (`.mmd`) files. They can be opened in:
- VS Code with the "Markdown Preview Mermaid Support" extension
- The Mermaid Live Editor: https://mermaid.live
- Any tool that supports Mermaid syntax (GitHub, GitLab, Notion, Obsidian, etc.)

To mark up: edit the `.mmd` source directly, or paste into mermaid.live to render visually and iterate.
