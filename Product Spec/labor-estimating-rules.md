# AVSS Bid Pipeline — Labor & Estimating Rules

Reference file for the AVSS Bid Pipeline Cowork skill. Source of truth for all labor
calculation during the Estimating stage.

**Derived from:** `DTools_AV_Quoting_Process_Guide` (rev. 4/4/25, IG) plus AVSS internal
rules locked during skill definition.

**Scope note:** This file covers labor and materials allowances only. Shipping & Handling
and sales tax are **not** calculated by the pipeline — D-Tools derives both automatically
(S&H as a calculated field, tax by site address). The skill's output is everything up to
the point D-Tools takes over on financials, not a complete priced project.

---

## 1. Product Install Labor

Per-device. **Mounts are a separate labor line at 2 hours each** — they are not bundled into
display or projector hours. (The quoting guide's "8 hours, includes mount" was always 6 + 2;
this table states it explicitly.)

| Device | Hours | Notes |
|---|---|---|
| Display <85" | 6 | Mount quoted separately |
| Display ≥85" | 10 | Mount quoted separately |
| Mount | 2 | Per mount device, any type |
| Projector screen | 12 | |
| Projector | 6 | Mount quoted separately |
| Speaker — ceiling | 1 | |
| Speaker — pendant | 2 | |
| Touch panel | 2 | Controller or scheduler |
| Small box | 1 | Extender, DA, small switch |
| Large box | 2 | Matrix, large processor, large switch |
| Small rack | 4 | <24RU |
| Large rack | 8 | ≥24RU |
| Video conferencing system | 4 | All-in-one: Logitech, Yealink, Poly, Neat |

Install labor is priced to include cabling of the device with **pre-terminated** cables.
Non-field-terminated runs are therefore already covered here and must **not** be counted
again under Cabling.

**Rack size gate: 24RU.** This threshold applies to both install labor and bench time.

---

## 2. Cabling

Calculated per room/location. Additive.

| Element | Hours | Basis |
|---|---|---|
| Display | 1 | Per display |
| Camera | 1 | Per camera, regardless of mounting location |
| Speaker | 1 | Per speaker |
| Microphone | 1 | Per mic — typically home-run to the DSP in the rack |
| Field-terminated cable through a pathway | 2 | Per cable |
| Rack | 2 | Per rack, once |

**Field termination assumption:** a cable running through a pathway (e.g. shielded Cat6
from a table to a display) is assumed field-terminated and takes the 2-hour rate.

**Rack attribution:** rack cabling hours land **once**, at the D-Tools location that
physically owns the rack. A shared rack in an IDF is counted in the IDF location only, not
in each room it serves.

### Worked example
Room with 2 displays, 3 field-terminated pathway cables, 12 speakers, and a rack:

```
2 displays          × 1 =  2
3 field-term cables × 2 =  6
12 speakers         × 1 = 12
1 rack              × 2 =  2
                         ---
                          22 hours
```

---

## 3. Bench Time

Pre-field configuration and firmware. All three components stack.

- **Smart devices:** 1 hour per 2 devices requiring firmware update or configuration before
  field install. Smart = touch panel, matrix switcher, control processor, DSP, and similar
  configurable devices.
- **Racks:** 4 hours per small rack (<24RU), 8 hours per large rack (≥24RU). **Stacks on
  top of** the smart-device count — devices mounted in the rack are still counted
  individually.
- **Displays:** 0.25 hours each, for DOA / shipping damage check.

---

## 4. Commissioning

Keyed to room class and whether conferencing is present.

| Room type | Hours |
|---|---|
| Digital signage location or audio-only zone | 0.5 |
| Small/medium, no conferencing | 1 |
| Small/medium, with conferencing | 2 |
| Large/XL, no conferencing | 4 |
| Large/XL, with conferencing | 8 |

### Room size classification

| Square footage | Class |
|---|---|
| Under 400 sq ft | Small/medium |
| 400 – 1,500 sq ft | Large/XL |
| Over 1,500 sq ft | **Escalate to human** |

**Fallback:** when drawings don't carry dimensions, classify by seat count or display count
instead of escalating. Record which signal was used in the room file.

**Complexity override:** adjust for complexity within these tiers. An auditorium-class space
escalates regardless of calculated square footage.

---

## 5. Programming

### Trigger test
Programming is required **only** when the room contains a custom control system or a DSP.
Run this test once per room; the result also feeds the travel rule (§8).

- **No programming:** all-in-one VC system with its own touch controller (e.g. Logitech +
  Tap). Soundbar with no DSP.
- **Programming required:** third-party control processor or button panel present (e.g.
  Extron). Discrete speakers/microphones routed through a DSP.

A room can trigger one or both. **Control and DSP programming stack.**

### Control system programming

| Component | Hours |
|---|---|
| Custom UI | 4 **per page** |
| Config + debug — simple (≤3 third-party device types under control) | 4 |
| Config + debug — complex (≥4 third-party device types under control) | 8 |

"Device types under control" counts distinct third-party systems, not unit quantities.
Controlling a TV and a DSP is simple. Cameras with tracking recall + DSP + lighting +
shades is complex.

**Page count default:** if the consultant narrative doesn't indicate a multi-page UI, assume
1 page and **record the assumption** in the room file so review sees it as an assumption
rather than a finding.

*Example — 4-page UI on a complex system: (4 × 4) + 8 = 24 hours.*

### DSP programming

| Configuration | Hours |
|---|---|
| Baseline | 4 |
| Complex — AEC for conferencing, complex mic routing | 8 |

---

## 6. Engineering

Tiered on project value.

| Project value | Hours |
|---|---|
| $0 – $100k | 8 |
| $100k – $400k | 20 |
| $400k – $1M | 40 |
| $1M – $2M | 80 |
| $2M – $5M | 100 |
| Over $5M | **Escalate to human** |

**Anti-circularity rule:** compute the tier from the equipment + install-labor subtotal,
*before* project-level adders. The tier stands even if the final project total crosses a
boundary. Do not recompute and oscillate.

*Interim rule — internal team guidance on engineering estimation is being expanded. Revisit.*

---

## 7. Mobilization

Same tier table as Engineering (§6). Billed at a different rate; hours are equivalent.
Covers van loading, trash/box breakdown, and similar.

---

## 8. Training

2, 4, or 8 hours, scaled by **number of room types**, not project dollar value.

- A $2M project with 3 room types may need only 4 hours.
- A $150k project with 7 room types may need a full day (8 hours).

**RFP override:** always check bid documents for a specified training-hours requirement. A
stated figure overrides this rule.

---

## 9. Travel

**Out of scope for the skill.** Travel is quoted by a human in D-Tools after the pipeline
finishes, alongside margin tuning, S&H, and tax. There is no `Travel` labor type in the
D-Tools vocabulary and the line format is non-trivial, so automation is deferred.

The skill's remaining responsibility is to **detect and flag** when travel will be required,
so the human knows to add it. Both triggers are determinable from the design:

1. Job site is **more than 50 miles** from the business unit office, **or**
2. **Programming is involved on a non-Premiere business unit** — a Lead Tech and a Programmer
   travel for final commissioning, regardless of distance. (This reuses the §5 programming
   determination.)

When either fires, note it in the wiki and the estimating breakdown as a required human
follow-up. Do not emit travel rows in the CSV.

### Reference rates — for the human, not the agent

| Item | Rate | Margin | Quantity |
|---|---|---|---|
| Per diem & hotel | GSA rates for job location | 20% | people × days |
| Rental car | $45–65/day | 20% | days |
| Airfare — East Coast | $300 | — | people × flights |
| Airfare — West Coast | $600 | — | people × flights |

GSA per diem reference: https://www.gsa.gov/travel/plan-book/per-diem-rates

*Revisit: candidate for automation once the line format is documented.*

---

## 10. MHCC (Misc. Hardware, Cables, Connectors)

**Always quote at 5% of materials cost, per room/location.** Never a single project-level
bucket.

**The agent does not reduce below 5%.** Refining MHCC downward to sharpen a quote is a
human-only action taken later in D-Tools. The skill's job is to produce the full 5% starting
point.

MHCC is emitted as a **Product** row, not a labor row:

| Field | Value |
|---|---|
| Manufacturer | `Premiere` (or the project's business unit) |
| Model | `Miscellaneous hardware. cables, connectors` |
| Part Number | `MHCC/SIF` |
| Labor Types | `Install` |

### MHCC install labor

The MHCC line carries its own install labor, scaled to the size of the allowance:

| MHCC value | Hours |
|---|---|
| ≤ $500 | 1 |
| $500 – $1,500 | 2 |
| $1,500 – $3,000 | 4 |
| $3,000 – $6,000 | 6 |
| Over $6,000 | 8 |

At a 5% rate, the $6,000 ceiling corresponds to roughly $120k of room materials — which is
already past the per-room escalation trigger in §11, so the table self-terminates.

---

## 11. Escalation Triggers

Distinct from the brief's **functional conflict** rule (design literally cannot work → stop
and ask immediately, one question at a time). These are **estimating escalations** — the
design is sound, but the rules run out of road.

Estimating escalations are predictable and should be **batched** into a single "needs your
input" list rather than interrupting the run one at a time.

| Trigger | Reason |
|---|---|
| Project value over $5M | No engineering/mobilization tier defined |
| Single room over $100k | Commissioning complexity likely exceeds tier table |
| Auditorium-class space | Commissioning tiers don't apply |
| Room over 1,500 sq ft | Outside classification range |

---

## 12. Margin

**Flat 30% margin on everything the skill produces.** Corresponding markup is **0.4286**
(markup = margin ÷ (1 − margin)). Both columns exist in the D-Tools CSV; write both.

The skill does not vary margin by manufacturer, category, or item. Per-line margin tuning is
a human action performed in D-Tools after the skill finishes, alongside S&H and tax.

---

## 13. D-Tools CSV Output Format

24 columns, quoted fields, CRLF line endings. One row per line item.

**This format round-trips.** D-Tools imports a CSV in this exact shape into a blank project.
The Estimating stage's deliverable is therefore a real import file, not a worklist for manual
keying. Column set and ordering must match exactly.

```
Item Type, Manufacturer, Model, Quantity, Location, Part Number, Short Description,
Unit Cost, Unit Price, Margin, Labor Types, Unit Labor Hours, Fixed Labor Cost,
Fixed Labor Price, Labor Unit Cost, Labor Unit Price, Owner Furnished Equipment,
Non-Billable, Use Tax, Optional, CO Number, CO Type, Priced From, Markup
```

**`Component ID` is omitted.** D-Tools generates it internally (written as `'005` to protect
the leading zero) and AVSS does not use it. Do not emit the column.

### Two labor mechanisms

Install labor **rides on the product row** (`Labor Types = Install`, `Unit Labor Hours` per
unit). Everything else is a **standalone `Labor` row**.

| Labor Type | Row placement |
|---|---|
| Install | On the product row |
| Bench, Cabling, Commissioning, Programming | Standalone row, in the room location |
| Engineering, Mobilization, Training | Standalone row, in `Labor and Services` |

These eight are the complete `Labor Types` vocabulary. **Travel has no labor type** — it is
human-quoted in D-Tools after the pipeline finishes (§9).

### Labor rates

| Rate tier | Cost | Price | Applies to |
|---|---|---|---|
| Standard | $60.30 | $145.00 | Engineering, Bench, Commissioning, Programming, Training |
| Reduced | $51.55 | $97.85 | Cabling, Mobilization |

### Placeholder rows are always emitted

Every room gets all four per-room labor rows — Bench, Cabling, Commissioning, Programming —
**even when the calculated value is zero**. A Neat-only room with no programming requirement
still gets a Programming row at `0.00`.

This matches the brief's wiki principle: an absent row is ambiguous between "not needed" and
"never evaluated." A zeroed row is unambiguous.

### Location naming

Format: `<Floor>: <Number> - <Name>` — e.g. `2nd Floor: 236 - Md Conference 2`.

Locations nest under a floor parent. **Retain the `Labor and Services` location**; the
quoting guide explicitly forbids deleting it from the template.

### Owner-furnished equipment

OFE is expressed as a **Manufacturer value**, literally `Owner Furnished [OFE]`, with
`Unit Cost` of 0 and `Owner Furnished Equipment` set True. Model names carry an `[OFE]`
suffix.

**OFE still carries install labor.** Client-furnished gear is installed at zero material cost
but non-zero labor.

### Fields the skill leaves alone

| Field | Handling |
|---|---|
| `Unit Price` | Derived from cost + margin |
| `Fixed Labor Cost` / `Fixed Labor Price` | Always 0 |
| `Use Tax` | D-Tools applies by site address |
| `CO Number` / `CO Type` | Blank on an original quote; change-order fields only |
| `Optional` / `Non-Billable` | False unless specifically flagged |
| S&H | D-Tools calculated field — do not emit a row |

`Short Description` is populated on Product rows and left blank on Labor rows.

---

## 14. Open Items

- **Travel automation.** Currently human-quoted in D-Tools (§9). Revisit once the travel line
  format is documented.
- **Room-level defaults in D-Tools templates.** The default "Room" location in each business
  unit template already contains Bench Time, Cabling, Commissioning, and Programming line
  items. Confirm whether the values above replace those template defaults or supplement them.
- **Business unit is a required pipeline input.** Premiere / Net100 / Kane determines the
  D-Tools template, whether custom fields apply, and whether the programming-travel rule
  fires. Must be captured at pipeline start.
- **"Typical of X" locations.** Naming convention supports one quoted location standing for
  multiple physical rooms (e.g. "Small Conference Room (Typical of 5)"). Proposed handling:
  one wiki entry for the type, plus an explicit roster of covered room numbers — so no
  physical room is silently unmentioned.
