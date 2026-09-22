# AVSS Bid Pipeline — Review Stage Checklist

Reference file for the AVSS Bid Pipeline Cowork skill. Governs Stage 4 (Review).

**Derived from:** `DTools_AV_Quoting_Process_Guide` (rev. 4/4/25, IG) § 7 "Getting Project
Ready for Review", plus checks implied by the locked labor rules.

**Companion file:** `labor-estimating-rules.md` — all hour and dollar values referenced here
are defined there.

---

## Purpose and posture

Review is a **fresh-context pass** that re-checks the estimate against the original consultant
documents. It exists to catch what the design and estimating stages missed, not to re-derive
their work.

Two failure modes it must avoid:

- **Rubber-stamping** — reading the design stage's reasoning trail and agreeing with it.
- **Re-litigating** — re-raising every non-functional deviation the design stage already
  consciously accepted, which would recreate the question-volume problem the conflict rule
  exists to prevent.

The intended middle: review sees the **decisions and their stated rationale**, not the
reasoning chain that produced them. A well-formed room file is exactly that, which makes the
room file format the review stage's input contract.

---

## A. Consultant document reconciliation

Re-compare the estimate against the original package, not against the design stage's notes.

- [ ] Every room/location in the consultant drawings appears in the estimate
- [ ] Every room in the estimate traces to a consultant document — no invented locations
- [ ] Equipment quantities per room match the consultant BoM, or carry a logged deviation with
      rationale
- [ ] Rooms covered by a "Typical of X" location have an explicit roster of which physical
      rooms they cover (see §C)
- [ ] Any RFP-specified requirement (training hours, warranty terms, spares) is reflected
- [ ] Addenda and revised drawings are reflected, not just the original issue

---

## B. Completeness — product

- [ ] **Every display has a mount product line.** Mount *labor* is a separate 2-hour line;
      the mount *hardware* is a distinct product and is the most common omission
- [ ] Every projector has a mount; every projector has a screen or specified surface
- [ ] Every rack has the accessories it implies — power, shelving, ventilation, hardware
- [ ] Speakers have amplification adequate to the count and impedance specified
- [ ] Every source device has a path to every intended destination
- [ ] Control system present where the narrative requires control
- [ ] MHCC line present in **every** room, at 5% of that room's materials, never a
      project-level bucket
- [ ] Owner-furnished equipment flagged correctly — `Owner Furnished [OFE]` manufacturer,
      zero unit cost, OFE boolean True, **but labor hours still populated**

---

## C. Completeness — labor

- [ ] All four per-room labor rows present in every room: Bench, Cabling, Commissioning,
      Programming — **including rows calculated at 0.00**
- [ ] Project-level rows present in `Labor and Services`: Engineering, Mobilization, Training
- [ ] Install labor attached to product rows, not emitted as standalone labor rows
- [ ] Engineering and Mobilization tiers agree with each other and with the pre-adder subtotal
- [ ] Training hours scaled by room *type* count, and reconciled against any RFP-stated figure
- [ ] MHCC line carries its own install labor, gated to the allowance size
- [ ] Travel requirement **flagged for the human** where either trigger fires: site over 50
      miles from the business unit, or programming on a non-Premiere business unit

---

## D. Labor math spot-checks

Recompute rather than accept. Cheap to verify, and the most likely source of silent error.

- [ ] Cabling totals reconcile to element counts — displays, cameras, speakers, mics,
      field-terminated pathway runs, rack
- [ ] Bench time reconciles — smart-device pairs, **plus** rack adder (these stack), plus
      0.25/display DOA check
- [ ] Commissioning matches the room's size class and conferencing status
- [ ] Programming fires only where a custom control system or DSP is actually present — a
      Neat or Logitech room with no third-party control should be 0.00
- [ ] Programming UI hours = 4 × page count, with a single page assumed **and the assumption
      recorded** where the narrative is silent
- [ ] Control and DSP programming stacked where both apply
- [ ] Rack size classification uses the 24RU gate consistently in both install and bench

---

## E. D-Tools output hygiene

From § 7 of the quoting guide, scoped to what the skill produces.

- [ ] Every product row has an accurate `Short Description` — present, and neither verbose nor
      wrong
- [ ] Every product row has a populated `Priced From` field
- [ ] Margin is a flat 0.30 with markup 0.4286 across all rows
- [ ] Location names follow `<Floor>: <Number> - <Name>`
- [ ] `Labor and Services` location retained
- [ ] `Fixed Labor Cost` / `Fixed Labor Price` zeroed; `CO Number` / `CO Type` blank
- [ ] No `Component ID` column; no S&H rows; no tax values
- [ ] Column set and order match the import spec exactly

**Not in scope:** S&H, sales tax, per-line margin tuning, travel line items, and client-report
item ordering. All are human actions taken in D-Tools after the skill finishes. The skill's
output is explicitly **not** a complete priced project.

---

## F. Documentation consistency

- [ ] Every room/subsystem has its guaranteed one-line wiki entry — clean, noted, or escalated
- [ ] Every wiki entry links to its full room file in `01-Design/`
- [ ] Every non-obvious decision has its rationale logged at the point of decision, not just
      the resulting number
- [ ] Every escalation in `_questions-log.md` has a recorded human answer and a resulting
      decision
- [ ] Scope of work covers every location in the estimate
- [ ] SOW quantities agree with BoM quantities per item
- [ ] Exclusions and assumptions documented, including any assumption the estimating stage
      recorded (UI page count being the common one)
- [ ] Documentation depth is proportional — a clean room gets a short confirmation, not a
      paragraph

---

## G. Escalations raised by review itself

Review may surface issues the earlier stages didn't. Same two-tier handling as the rest of the
pipeline:

**Functional conflict** — the design cannot work as estimated. Stop, ask the human one
question at a time, log question + answer + decision in `_questions-log.md`.

**Estimating escalation** — the design is sound but the rules ran out of road. **Batch these**
into a single "needs your input" list rather than interrupting one at a time. Standing
triggers: project over $5M, single room over $100k, auditorium-class space, room over
1,500 sq ft.

---

## Open items

- **Review context mechanics.** Whether Stage 4 runs as an isolated sub-agent, a fresh
  session, or a same-context pass with a constrained input set. Unresolved — this checklist
  defines *what* review checks, not *how* it is invoked.
- **Room file format.** Named above as review's input contract, but not yet specified.
  Blocking the isolation decision.
- **Known-issue additions.** This list should grow from real misses. Anything a human reviewer
  catches that the pipeline shipped belongs here.
