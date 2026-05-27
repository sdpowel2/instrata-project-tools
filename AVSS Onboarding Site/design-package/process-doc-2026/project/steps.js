// AVSS Process — step content
// Edit videoUrl on each step to plug in the real screenshare tutorial when ready.
// Owner buckets drive badge colors: 'sales' | 'avss' | 'ops' | 'purchasing'
//
// PRE-SALES uses a Phase → Milestone → Deliverable model. Phase 1 (universal
// triage) applies to every project; after triage, the project falls into one
// of five mutually-exclusive branches (Design, Design-Build, Bid, Public Bid,
// Budget). All pre-sales copy here is placeholder — managers fill in real
// content via the in-app editor (avss-step-overrides in Process Doc.html).
// POST-SALES is a single linear sequence grouped into stages; unchanged.

const _OWNER_NAMES = { sales: 'Sales Rep', avss: 'Shared Services', ops: 'Operations' };
function _preStep(id, branch, phase, phaseLabel, kind, num, title, ownerKey) {
  return {
    id, section: 'pre',
    branch, phase, phaseLabel, kind, num, title,
    owner: _OWNER_NAMES[ownerKey], ownerKey,
    actionItem: 'TBD',
    summary: 'TBD',
    videoUrl: '',
    details: [],
    notes: [],
  };
}

window.AVSS_STEPS = [
  // ============ PRE-SALES — Phase 1 (universal triage) ============
  _preStep(100, 'triage', 1, 'Intake & Qualification', 'milestone',   'M1', 'Lead Received and Logged',      'sales'),
  _preStep(101, 'triage', 1, 'Intake & Qualification', 'milestone',   'M2', 'Triage',                         'avss'),
  _preStep(102, 'triage', 1, 'Intake & Qualification', 'deliverable', 'D1', 'Bid/No-Bid Gate',                'avss'),
  _preStep(103, 'triage', 1, 'Intake & Qualification', 'deliverable', 'D2', 'Pre-Sales Engineer Assigned',    'avss'),
  _preStep(104, 'triage', 1, 'Intake & Qualification', 'deliverable', 'D3', 'Project Type Defined',           'avss'),
  _preStep(105, 'triage', 1, 'Intake & Qualification', 'milestone',   'M3', 'Project Overview',               'avss'),
  _preStep(106, 'triage', 1, 'Intake & Qualification', 'deliverable', 'D4', 'Project Overview Created',       'avss'),

  // ============ PRE-SALES — Branch: Design (labor-only design package) ============
  _preStep(110, 'design', 2, 'Discovery',                'milestone',   'M2.1', 'Discovery Call',                          'sales'),
  _preStep(111, 'design', 2, 'Discovery',                'milestone',   'M2.2', 'Scope Draft Assembled',                   'avss'),
  _preStep(112, 'design', 2, 'Discovery',                'deliverable', 'D1',   'Scope Draft',                             'avss'),

  _preStep(113, 'design', 3, 'Pricing & Proposal',       'milestone',   'M3.1', 'Proposal Document Assembled',             'avss'),
  _preStep(114, 'design', 3, 'Pricing & Proposal',       'milestone',   'M3.2', 'Engineering Review — Internal AVSS',      'avss'),
  _preStep(115, 'design', 3, 'Pricing & Proposal',       'deliverable', 'D2',   'Final Proposal',                          'avss'),

  _preStep(116, 'design', 4, 'Submission & Negotiation', 'milestone',   'M4.1', 'Delivered to Client',                     'sales'),
  _preStep(117, 'design', 4, 'Submission & Negotiation', 'milestone',   'M4.2', 'Client Scope Review',                     'sales'),
  _preStep(118, 'design', 4, 'Submission & Negotiation', 'milestone',   'M4.3', 'Revisions',                               'avss'),
  _preStep(119, 'design', 4, 'Submission & Negotiation', 'milestone',   'M4.4', 'Proposal Accepted — Confirmed to Win',    'sales'),

  _preStep(120, 'design', 5, 'Award & Handoff',          'milestone',   'M5.1', 'Contract/PO Received',                    'sales'),
  _preStep(121, 'design', 5, 'Award & Handoff',          'milestone',   'M5.2', 'Transition to Design-Build or Bid Flow',  'sales'),

  // ============ PRE-SALES — Branch: Design-Build (design + install) ============
  _preStep(130, 'design-build', 2, 'Discovery',                'milestone',   'M2.1', 'Intro Call with Sales AM',                    'sales'),
  _preStep(131, 'design-build', 2, 'Discovery',                'milestone',   'M2.2', 'Discovery Call with Client',                  'sales'),
  _preStep(132, 'design-build', 2, 'Discovery',                'milestone',   'M2.3', 'Site Walk Conducted',                         'avss'),
  _preStep(133, 'design-build', 2, 'Discovery',                'milestone',   'M2.4', 'Scope Draft Assembled',                       'avss'),
  _preStep(134, 'design-build', 2, 'Discovery',                'deliverable', 'D1',   'Scope Draft',                                 'avss'),

  _preStep(135, 'design-build', 3, 'Design & Engineering',     'milestone',   'M3.1', 'Functional Sketch',                           'avss'),
  _preStep(136, 'design-build', 3, 'Design & Engineering',     'deliverable', 'D2',   'Functional Sketch',                           'avss'),
  _preStep(137, 'design-build', 3, 'Design & Engineering',     'milestone',   'M3.2', 'BoM Developed — in DTools',                   'avss'),

  _preStep(138, 'design-build', 4, 'Pricing & Proposal',       'milestone',   'M4.1', 'Cost Roll-Up Complete',                       'avss'),
  _preStep(139, 'design-build', 4, 'Pricing & Proposal',       'milestone',   'M4.2', 'Margin / Pricing Strategy Applied',           'sales'),
  _preStep(140, 'design-build', 4, 'Pricing & Proposal',       'milestone',   'M4.3', 'Proposal Document Assembled',                 'avss'),
  _preStep(141, 'design-build', 4, 'Pricing & Proposal',       'milestone',   'M4.4', 'Internal Proposal Review',                    'avss'),
  _preStep(142, 'design-build', 4, 'Pricing & Proposal',       'deliverable', 'D3',   'Final Proposal',                              'avss'),

  _preStep(143, 'design-build', 5, 'Submission & Negotiation', 'milestone',   'M5.1', 'Proposal Delivered to Client',                'sales'),
  _preStep(144, 'design-build', 5, 'Submission & Negotiation', 'milestone',   'M5.2', 'Client Scope Review',                         'sales'),
  _preStep(145, 'design-build', 5, 'Submission & Negotiation', 'milestone',   'M5.3', 'Revisions — Scope/Price/VE',                  'avss'),
  _preStep(146, 'design-build', 5, 'Submission & Negotiation', 'deliverable', 'D4',   'Revised Proposal',                            'avss'),
  _preStep(147, 'design-build', 5, 'Submission & Negotiation', 'milestone',   'M5.4', 'Final Proposal Accepted — Confirmed to Win',  'sales'),

  _preStep(148, 'design-build', 6, 'Award & Handoff',          'milestone',   'M6.1', 'Contract/PO Received',                        'sales'),
  _preStep(149, 'design-build', 6, 'Award & Handoff',          'milestone',   'M6.2', 'Contract Review / Red-Lines',                 'sales'),
  _preStep(150, 'design-build', 6, 'Award & Handoff',          'milestone',   'M6.3', 'Contract Countersigned',                      'sales'),
  _preStep(151, 'design-build', 6, 'Award & Handoff',          'milestone',   'M6.4', 'Pre-Sales to Post-Sales Handoff',             'avss'),
  _preStep(152, 'design-build', 6, 'Award & Handoff',          'deliverable', 'D5',   'Post-Sales Handoff Package',                  'avss'),

  // ============ PRE-SALES — Branch: Bid (private-sector competitive) ============
  _preStep(160, 'bid', 2, 'Discovery & RFI',           'milestone',   'M2.1', 'Intro Call with Sales AM',                'sales'),
  _preStep(161, 'bid', 2, 'Discovery & RFI',           'milestone',   'M2.2', 'Document Discovery',                      'avss'),
  _preStep(162, 'bid', 2, 'Discovery & RFI',           'milestone',   'M2.3', 'Takeoffs',                                'avss'),
  _preStep(163, 'bid', 2, 'Discovery & RFI',           'deliverable', 'D1',   'Takeoff Document',                        'avss'),
  _preStep(164, 'bid', 2, 'Discovery & RFI',           'milestone',   'M2.4', 'RFIs Created',                            'avss'),
  _preStep(165, 'bid', 2, 'Discovery & RFI',           'deliverable', 'D2',   'Submitted RFIs',                          'avss'),
  _preStep(166, 'bid', 2, 'Discovery & RFI',           'milestone',   'M2.5', 'Scope Draft Assembled',                   'avss'),
  _preStep(167, 'bid', 2, 'Discovery & RFI',           'deliverable', 'D3',   'Scope Draft',                             'avss'),

  _preStep(168, 'bid', 3, 'Design & Engineering',      'milestone',   'M3.1', 'Review/Markup Consultant One-Lines',      'avss'),
  _preStep(169, 'bid', 3, 'Design & Engineering',      'deliverable', 'D4',   'One-Line Markup as Functional Sketch',    'avss'),
  _preStep(170, 'bid', 3, 'Design & Engineering',      'milestone',   'M3.2', 'Design Notes',                            'avss'),
  _preStep(171, 'bid', 3, 'Design & Engineering',      'deliverable', 'D5',   'Design Notes',                            'avss'),
  _preStep(172, 'bid', 3, 'Design & Engineering',      'milestone',   'M3.3', 'Initial BoM Developed — Pre-RFI Answers', 'avss'),

  _preStep(173, 'bid', 4, 'Pricing & Proposal',        'milestone',   'M4.1', 'Cost Roll-Up Complete',                   'avss'),
  _preStep(174, 'bid', 4, 'Pricing & Proposal',        'milestone',   'M4.2', 'Final BoM Captured — Incl. RFI Answers',  'avss'),
  _preStep(175, 'bid', 4, 'Pricing & Proposal',        'milestone',   'M4.3', 'Margin / Pricing Strategy Applied',       'sales'),
  _preStep(176, 'bid', 4, 'Pricing & Proposal',        'milestone',   'M4.4', 'Proposal Document Assembled',             'avss'),
  _preStep(177, 'bid', 4, 'Pricing & Proposal',        'milestone',   'M4.5', 'Internal Proposal Review',                'avss'),
  _preStep(178, 'bid', 4, 'Pricing & Proposal',        'deliverable', 'D6',   'Final Proposal',                          'avss'),

  _preStep(179, 'bid', 5, 'Submission & Negotiation',  'milestone',   'M5.1', 'Proposal Delivered to Client',            'sales'),
  _preStep(180, 'bid', 5, 'Submission & Negotiation',  'milestone',   'M5.2', 'Follow-Up',                               'sales'),
  _preStep(181, 'bid', 5, 'Submission & Negotiation',  'milestone',   'M5.3', 'Revisions — Re-Bid/Clarifications/Scope', 'avss'),
  _preStep(182, 'bid', 5, 'Submission & Negotiation',  'deliverable', 'D7',   'Revised Proposal',                        'avss'),
  _preStep(183, 'bid', 5, 'Submission & Negotiation',  'milestone',   'M5.4', 'Award',                                   'sales'),

  _preStep(184, 'bid', 6, 'Award & Handoff',           'milestone',   'M6.1', 'Contract/PO Received',                    'sales'),
  _preStep(185, 'bid', 6, 'Award & Handoff',           'milestone',   'M6.2', 'Contract Review / Red-Lines',             'sales'),
  _preStep(186, 'bid', 6, 'Award & Handoff',           'milestone',   'M6.3', 'Contract Countersigned',                  'sales'),
  _preStep(187, 'bid', 6, 'Award & Handoff',           'milestone',   'M6.4', 'Pre-Sales to Post-Sales Handoff',         'avss'),
  _preStep(188, 'bid', 6, 'Award & Handoff',           'deliverable', 'D8',   'Post-Sales Handoff Package',              'avss'),

  // ============ PRE-SALES — Branch: Public Bid (public agency, lowest-cost) ============
  // Structurally identical to Bid; only rollover entry point differs (Budget only).
  _preStep(200, 'public-bid', 2, 'Discovery & RFI',           'milestone',   'M2.1', 'Intro Call with Sales AM',                'sales'),
  _preStep(201, 'public-bid', 2, 'Discovery & RFI',           'milestone',   'M2.2', 'Document Discovery',                      'avss'),
  _preStep(202, 'public-bid', 2, 'Discovery & RFI',           'milestone',   'M2.3', 'Takeoffs',                                'avss'),
  _preStep(203, 'public-bid', 2, 'Discovery & RFI',           'deliverable', 'D1',   'Takeoff Document',                        'avss'),
  _preStep(204, 'public-bid', 2, 'Discovery & RFI',           'milestone',   'M2.4', 'RFIs Created',                            'avss'),
  _preStep(205, 'public-bid', 2, 'Discovery & RFI',           'deliverable', 'D2',   'Submitted RFIs',                          'avss'),
  _preStep(206, 'public-bid', 2, 'Discovery & RFI',           'milestone',   'M2.5', 'Scope Draft Assembled',                   'avss'),
  _preStep(207, 'public-bid', 2, 'Discovery & RFI',           'deliverable', 'D3',   'Scope Draft',                             'avss'),

  _preStep(208, 'public-bid', 3, 'Design & Engineering',      'milestone',   'M3.1', 'Review/Markup Consultant One-Lines',      'avss'),
  _preStep(209, 'public-bid', 3, 'Design & Engineering',      'deliverable', 'D4',   'One-Line Markup as Functional Sketch',    'avss'),
  _preStep(210, 'public-bid', 3, 'Design & Engineering',      'milestone',   'M3.2', 'Design Notes',                            'avss'),
  _preStep(211, 'public-bid', 3, 'Design & Engineering',      'deliverable', 'D5',   'Design Notes',                            'avss'),
  _preStep(212, 'public-bid', 3, 'Design & Engineering',      'milestone',   'M3.3', 'Initial BoM Developed — Pre-RFI Answers', 'avss'),

  _preStep(213, 'public-bid', 4, 'Pricing & Proposal',        'milestone',   'M4.1', 'Cost Roll-Up Complete',                   'avss'),
  _preStep(214, 'public-bid', 4, 'Pricing & Proposal',        'milestone',   'M4.2', 'Final BoM Captured — Incl. RFI Answers',  'avss'),
  _preStep(215, 'public-bid', 4, 'Pricing & Proposal',        'milestone',   'M4.3', 'Margin / Pricing Strategy Applied',       'sales'),
  _preStep(216, 'public-bid', 4, 'Pricing & Proposal',        'milestone',   'M4.4', 'Proposal Document Assembled',             'avss'),
  _preStep(217, 'public-bid', 4, 'Pricing & Proposal',        'milestone',   'M4.5', 'Internal Proposal Review',                'avss'),
  _preStep(218, 'public-bid', 4, 'Pricing & Proposal',        'deliverable', 'D6',   'Final Proposal',                          'avss'),

  _preStep(219, 'public-bid', 5, 'Submission & Negotiation',  'milestone',   'M5.1', 'Proposal Delivered to Client',            'sales'),
  _preStep(220, 'public-bid', 5, 'Submission & Negotiation',  'milestone',   'M5.2', 'Follow-Up',                               'sales'),
  _preStep(221, 'public-bid', 5, 'Submission & Negotiation',  'milestone',   'M5.3', 'Revisions — Re-Bid/Clarifications/Scope', 'avss'),
  _preStep(222, 'public-bid', 5, 'Submission & Negotiation',  'deliverable', 'D7',   'Revised Proposal',                        'avss'),
  _preStep(223, 'public-bid', 5, 'Submission & Negotiation',  'milestone',   'M5.4', 'Award',                                   'sales'),

  _preStep(224, 'public-bid', 6, 'Award & Handoff',           'milestone',   'M6.1', 'Contract/PO Received',                    'sales'),
  _preStep(225, 'public-bid', 6, 'Award & Handoff',           'milestone',   'M6.2', 'Contract Review / Red-Lines',             'sales'),
  _preStep(226, 'public-bid', 6, 'Award & Handoff',           'milestone',   'M6.3', 'Contract Countersigned',                  'sales'),
  _preStep(227, 'public-bid', 6, 'Award & Handoff',           'milestone',   'M6.4', 'Pre-Sales to Post-Sales Handoff',         'avss'),
  _preStep(228, 'public-bid', 6, 'Award & Handoff',           'deliverable', 'D8',   'Post-Sales Handoff Package',              'avss'),

  // ============ PRE-SALES — Branch: Budget (placeholder pricing) ============
  _preStep(240, 'budget', 2, 'Discovery',                'milestone',   'M2.1', 'Intro Call with Sales AM',                       'sales'),
  _preStep(241, 'budget', 2, 'Discovery',                'milestone',   'M2.2', 'Discovery Call with Client — Optional',          'sales'),
  _preStep(242, 'budget', 2, 'Discovery',                'milestone',   'M2.3', 'Brief Scope Draft Assembled — Room Types',       'avss'),
  _preStep(243, 'budget', 2, 'Discovery',                'deliverable', 'D1',   'Scope Draft',                                    'avss'),

  _preStep(244, 'budget', 3, 'Pricing & Proposal',       'milestone',   'M3.1', 'Cost Roll-Up Complete',                          'avss'),
  _preStep(245, 'budget', 3, 'Pricing & Proposal',       'milestone',   'M3.2', 'Proposal Document Assembled',                    'avss'),
  _preStep(246, 'budget', 3, 'Pricing & Proposal',       'milestone',   'M3.3', 'Internal Proposal Review',                       'avss'),
  _preStep(247, 'budget', 3, 'Pricing & Proposal',       'deliverable', 'D2',   'Final Proposal',                                 'avss'),

  _preStep(248, 'budget', 4, 'Submission & Transition',  'milestone',   'M4.1', 'Proposal Submitted to Client',                   'sales'),
  _preStep(249, 'budget', 4, 'Submission & Transition',  'milestone',   'M4.2', 'Client Scope Review',                            'sales'),
  _preStep(250, 'budget', 4, 'Submission & Transition',  'milestone',   'M4.3', 'Transition to Bid / Public Bid / Design-Build',  'sales'),

  // ============ POST-SALES ============
  // Single linear branch ('main') with 6 phases. Milestones use M<phase>.<n>
  // numbering; deliverables use D<n> sequential across the branch.

  // ---------- Phase 1: Project Setup ----------
  {
    id: 12, section: 'post', branch: 'main', phase: 1, phaseLabel: 'Project Setup', kind: 'milestone', num: 'M1.1',
    title: 'Open Job',
    owner: 'Operations', ownerKey: 'ops',
    actionItem: 'Open a job at the local business unit. Communicate job number to AVSS.',
    videoUrl: '',
    summary: 'Once a project has been awarded, our team begins the post-sales cycle by working with the individual business unit to get a job opened or created for the project.',
    details: [
      { body: 'Our team can collaborate with each business unit to get all pertinent job information over for opening the project on the post-sales side: labor cost, labor price, equipment cost, equipment price, job gross margin, taxes. The salesperson/estimator should mark the job as won in the Smartsheet bid log.' }
    ],
    notes: ['We have a detailed open job report we can print in DTools which has all pertinent job information. Sent on request and modifiable to add additional information. Our goal is to streamline the job opening process to make it as easy as possible on all teams.']
  },
  {
    id: 13, section: 'post', branch: 'main', phase: 1, phaseLabel: 'Project Setup', kind: 'milestone', num: 'M1.2',
    title: 'Identify Project Team',
    owner: 'AV Ops / Field Ops / AVSS', ownerKey: 'ops',
    actionItem: 'Create an MS Teams group for the project including all project team members.',
    videoUrl: '',
    summary: 'Once a job has been opened, the AV Ops Manager, Field Ops Director and Shared Services team will assign a project team.',
    details: [
      { label: 'Project team includes', body: 'Purchasing agent, AV field engineer, AV project manager, field project manager, pre-sales engineer, post-sales engineer, programmer (if needed — based on programming or DSP needs), managed services team (if needed — based on Premiere Protect), and salesperson/estimator.' },
      { label: 'Teams chat', body: 'The AV Ops Manager creates a project-specific Teams chat with all project team members included. Project information goes here to facilitate better communication throughout the lifecycle. Questions can also go via email but should be posted in Teams so everyone has visibility.' }
    ],
    notes: ['Each person assigned to the project plays a specific role — not everyone will be able to answer every question.']
  },
  {
    id: 14, section: 'post', branch: 'main', phase: 1, phaseLabel: 'Project Setup', kind: 'milestone', num: 'M1.3',
    title: 'Project Intro / Kickoff Meeting',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Schedule and host AV Kickoff meeting.',
    videoUrl: '',
    summary: 'A 30-minute Teams meeting with the entire project team. The pre-sales engineer gives a short project overview to bring everyone up to speed on what the project will consist of and any other pertinent information.',
    details: [
      { body: 'The AV project manager is responsible for coordinating and scheduling this meeting. Should be scheduled as a Microsoft Teams call so anyone working remote can join. No further steps are taken on the post-sales side until this meeting has happened — it is the first step in bringing everyone up to speed on the operations side.' }
    ],
    notes: ['The pre-sales engineer should come prepared to discuss this project at a high level: end client details, basic functionality overview, any timelines they’re privy to.']
  },
  {
    id: 15, section: 'post', branch: 'main', phase: 1, phaseLabel: 'Project Setup', kind: 'milestone', num: 'M1.4',
    title: 'Build Project Parameters',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Gather project information.',
    videoUrl: '',
    summary: 'First iteration of information gathering by the operations team. The goal is to gain insight into the customer’s timeline expectations and see how that matches our stated number of install hours and programming hours.',
    details: [
      { label: 'Important information to gather', body: 'End client’s current construction schedule. TCO date (or date all construction is completed and site is clean and ready for AV install). Information about other trades to coordinate with (furniture vendor, electrician, etc). Dates that all deliverables would be needed (specifically equipment elevations for displays, product submittals, install drawing sets).' },
      { label: 'Timeline gap example', body: 'Will our quoted timeline meet the customer’s expectations or is there a gap? E.g. if the customer has a 3-week AV install timeline budgeted but we have 5 weeks of time on the project.' }
    ],
    notes: ['Any documents uncovered during this process should be shared with the AV team in the Teams group chat or files related to the team for this project.']
  },
  {
    id: 16, section: 'post', branch: 'main', phase: 1, phaseLabel: 'Project Setup', kind: 'milestone', num: 'M1.5',
    title: 'Client Kickoff Meeting',
    owner: 'AV PM / Field PM', ownerKey: 'ops',
    actionItem: 'Schedule and host meeting with client to relay project timeline expectations.',
    videoUrl: '',
    summary: 'The AV Project Manager and the Field Project Manager get together with the client to introduce themselves as the project leads and discuss any expectations regarding timelines from the previous step.',
    details: [
      { body: 'The most important aspect is making sure the client understands the timeline we will be working on. If scheduling changes need to occur to accommodate us, those should begin to be discussed here rather than later in the project, where they’d show up as a surprise.' },
      { body: 'If our schedule is not going to be sufficient for the end client, we should be discussing the idea of a change order — whether overtime or more technicians being allocated to the project.' }
    ],
    notes: ['Takeaway notes from this meeting should go into the Teams chat for this AV project so the whole team can see what was discussed and work on any action items (like a change order for updated labor).']
  },

  // ---------- Phase 2: Engineering & Procurement ----------
  {
    id: 17, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'milestone', num: 'M2.1',
    title: 'BoM Scrub',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'Review BoM to make sure all items are accounted for.',
    videoUrl: '',
    summary: 'The bill of materials included as part of the scope is reviewed by the engineering and AV operations group for completeness.',
    details: [
      { body: 'Short and simple engineering review. All miscellaneous cables, connectors, and hardware WILL NOT be included in this initial review — these will be completed and turned in as part of the AV drawing package. The list comprises short interconnect cables, specialty adapters, and any equipment missed as part of the original AV design. The goal on the engineering side is to capture everything except short interconnect cables as part of the original BoM.' }
    ],
    notes: ['If this is a design/build project and no product submittals are required, once this step is complete the BoM can be sent to purchasing for order. If this is a bid or product submittals are required by the GC, move to the next step.', 'Some projects may have a phased purchasing plan depending on schedule and product availability. The purchasing agent will work directly with operations to define how to purchase the BoM in a timely and efficient manner.']
  },
  {
    id: 35, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'deliverable', num: 'D1',
    title: 'Scrubbed BoM',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'TBD',
    videoUrl: '',
    summary: 'TBD',
    details: [],
    notes: []
  },
  {
    id: 18, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'milestone', num: 'M2.2',
    title: 'Product Submittals',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'Create a full set of project submittals combined to a PDF with a table of contents noting pages of each device in the BoM.',
    videoUrl: '',
    summary: 'If product submittals are required (usually for a bid scenario or if the GC is requesting them) the shared services team creates a product submittals doc within DTools.',
    details: [
      { body: 'The DTools submittals document lists all products per room with links to individual cut sheets, data sheets, and install manuals (where applicable). We also submit a combined set of all PDF documents in that set as a separate document for printing and delivering to the end client.' },
      { body: 'If a specific format is required for submittal documentation, please let shared services know up front so we can plan to get the submittals into the proposed format.' },
      { label: 'Returned: Revise and Resubmit', body: 'Problems with our submittals, usually stated as comments. Send to the post-sales engineer ASAP so we can revise and return the submittals with the stated changes.' },
      { label: 'Returned: Approved as Noted', body: 'Comments made (usually pertaining to product color or other options). We don’t need to resubmit as long as we can abide by the comments. Communicate with the whole team so we can make any small changes to the BoM before ordering.' },
      { label: 'Returned: Approved', body: 'Submittals approved without notes. The bill of material can be released for order. Purchasing and operations will determine the best course of action based on schedule and materials availability.' }
    ],
    notes: []
  },
  {
    id: 36, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'deliverable', num: 'D2',
    title: 'Cutsheet Submittal Document',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'TBD',
    videoUrl: '',
    summary: 'TBD',
    details: [],
    notes: []
  },
  {
    id: 19, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'milestone', num: 'M2.3',
    title: 'Order Materials',
    owner: 'Purchasing', ownerKey: 'ops',
    actionItem: 'Order known equipment.',
    videoUrl: '',
    summary: 'Once submittals are approved (or once the BoM is scrubbed if no submittals are required) a materials list should be sent to the local purchasing team by the project manager for ordering.',
    details: [
      { body: 'The purchasing agent will order all materials associated with the project (except miscellaneous equipment, which is sent shortly after finishing the drawing sets). They enter all tracking/lead time information into a purchasing module visible to everyone on the project. The purchasing module lives in the MS Teams chat for the project as well as the project folder.' },
      { label: 'Long lead times', body: 'If lead times are an issue, let the end client know ASAP and ask if they want to consider alternative solutions or just wait. If they want an updated quote for a similar product, loop the pre-sales engineer back in for a new change order. If they prefer to wait, ensure all dates are updating accordingly and any schedule changes are relayed to the customer.' }
    ],
    notes: ['It is hard to give realistic lead times until an order is placed to the manufacturer. If the end client asks before we receive the lead times, a general rule of thumb is that we can convey real lead times once we have them, but 6–8 weeks is pretty standard on most non-custom items.']
  },
  {
    id: 20, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'milestone', num: 'M2.4',
    title: 'Drawing Submittals',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'Create all construction drawing submittals.',
    videoUrl: '',
    summary: 'Immediately following the project kickoff meeting, the post-sales engineer begins system drawings.',
    details: [
      { label: 'Drawings include but are not limited to', body: 'Floor Plan · Reflected Ceiling Plan · Equipment Elevations · Line Diagrams · Rack Elevations · Detail Drawings.' },
      { body: 'Floor plans, equipment elevations, and line diagrams are included in every package. Reflected ceiling plans, rack elevations, and detail drawings are provided if needed (e.g. no RCPs if no items are being installed in the ceiling).' },
      { label: 'Pre-terminated cables list', body: 'As part of our standard line diagram package, we include a detailed list of pre-terminated cables and adapters which completes our entire BoM. Once the project manager receives the system drawings, they should send the list of miscellaneous cables and adapters to purchasing to complete all orders.' }
    ],
    notes: ['All drawing submittals are produced to look and feel exactly the same (numbering scheme, format, cable labels). Templates are pre-defined by shared services. If special accommodations are needed (e.g. cables labeled a very specific way), please let the post-sales engineer know ASAP.', 'All system drawings are done in CAD format and printed to PDF.']
  },
  {
    id: 37, section: 'post', branch: 'main', phase: 2, phaseLabel: 'Engineering & Procurement', kind: 'deliverable', num: 'D3',
    title: 'Shop Drawings',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'TBD',
    videoUrl: '',
    summary: 'TBD',
    details: [],
    notes: []
  },

  // ---------- Phase 3: Project Management ----------
  {
    id: 21, section: 'post', branch: 'main', phase: 3, phaseLabel: 'Project Management', kind: 'milestone', num: 'M3.1',
    title: 'Determine Project Dates',
    owner: 'AV PM / Field PM', ownerKey: 'ops',
    actionItem: 'Communicate accurate install dates and durations with project team.',
    videoUrl: '',
    summary: 'While drawing submittals are being processed by shared services, the project managers should be putting together an SSP for the project which details specific install dates and a basic plan for accomplishing the overall scope: order of rooms, scheduled timeline, allocation of technician resources.',
    details: [
      { body: 'Internal scheduling details should be posted to the Teams chat for that job so all parties are made aware of any dates. As dates change, put all new dates in the chat so the shared services team can prioritize jobs accordingly.' }
    ],
    notes: ['Any install dates should be relayed directly to the client and get full approval. This step should be effectively mitigated if we have already relayed our install timeline to the customer in the above steps.']
  },
  {
    id: 22, section: 'post', branch: 'main', phase: 3, phaseLabel: 'Project Management', kind: 'milestone', num: 'M3.2',
    title: 'Manage Inventory',
    owner: 'AV PM / Field PM', ownerKey: 'ops',
    actionItem: 'As product arrives, stage it in the warehouse by room and log all serial numbers and MAC addresses.',
    videoUrl: '',
    summary: 'As equipment arrives at the warehouse, the project managers check in all equipment and place it in its dedicated space for the job.',
    details: [
      { body: 'It is the responsibility of the project managers to ensure all equipment is delivered and staged appropriately. Keep track of location of all equipment.' },
      { body: 'A spreadsheet should be updated with all products that have been delivered along with serial numbers and MAC addresses. This spreadsheet lives on the Teams thread for the associated job.' }
    ],
    notes: ['Preferably equipment is staged by room. We usually put a sticker on each piece of equipment with the room it goes in so we can easily palletize by room when we’re ready to deliver to the site.']
  },
  {
    id: 23, section: 'post', branch: 'main', phase: 3, phaseLabel: 'Project Management', kind: 'milestone', num: 'M3.3',
    title: 'Revision / Change Order',
    owner: 'AV PM / Field PM', ownerKey: 'ops',
    actionItem: 'Relay any change order requests to the AVSS team for processing.',
    videoUrl: '',
    summary: 'Throughout the lifecycle of a project, change orders may be warranted. The project manager should involve the pre-sales engineer to re-engage the project and put together any necessary change orders for review. The salesperson reviews, just like normal pre-sales, then forwards to the customer for approval. Once approved, change orders go back into the BoM scrub process.',
    details: [
      { label: 'Internal Change Orders', body: 'Zero-dollar change orders (direct flip of parts to something around the same cost) or change orders for parts we forgot. Should not go to the customer.' },
      { label: 'External Change Orders', body: 'Needed if the design functionality changes in any way and requires additional labor or equipment.' }
    ],
    notes: ['Anytime a project is marked as approved in DTools (when a project is won), any additional parts or labor adds will be presented as a change order. These can be marked as either internal (doesn’t affect the price to the customer) or external (does affect the price).']
  },

  // ---------- Phase 4: Pre-Install ----------
  {
    id: 24, section: 'post', branch: 'main', phase: 4, phaseLabel: 'Pre-Install', kind: 'milestone', num: 'M4.1',
    title: 'Pre-Install Handoff Meeting',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Schedule and host the project handoff meeting with all project team members.',
    videoUrl: '',
    summary: 'Once all deliverables are complete — in theory about 2 weeks before the system is deployed — the AV project manager schedules a 1-hour remote call with the entire project team to discuss the project in detail.',
    details: [
      { body: 'The purpose is to go through all project details. We review all submittal drawings and discuss anything that could come up during install, helping everyone become more familiar with the project.' },
      { label: 'Post-sales engineer', body: 'Comes prepared to walk through the drawings they’ve created and explain the logic behind the line diagrams as well as any complexities of the project.' },
      { label: 'AV Field Engineer', body: 'Comes having already reviewed the drawing set with any questions prepared to clear up confusion about the systems.' },
      { label: 'Project Managers', body: 'Come prepared to discuss the full deployment schedule.' }
    ],
    notes: ['This meeting is required before any install, bench, or programming work can begin on the project.']
  },
  {
    id: 25, section: 'post', branch: 'main', phase: 4, phaseLabel: 'Pre-Install', kind: 'milestone', num: 'M4.2',
    title: 'Client Scope Review',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Schedule a client scope review meeting with the client, AV PM, and pre-sales engineer.',
    videoUrl: '',
    summary: 'The purpose of this meeting is to verify the full AV scope with the client so that everyone is in agreement on what they will be getting once the install is finished.',
    details: [
      { body: 'This meeting can happen remote or in-person.' },
      { label: 'Documents to bring', body: 'Scope of work, final proposal, AV drawings.' },
      { body: 'The goal is to get verbal confirmation of all our room scopes prior to any install work beginning, including bench work and programming.' }
    ],
    notes: []
  },
  {
    id: 26, section: 'post', branch: 'main', phase: 4, phaseLabel: 'Pre-Install', kind: 'milestone', num: 'M4.3',
    title: 'Programming',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'All preliminary programming for the project.',
    videoUrl: '',
    summary: 'Programming is required on any project with complex DSP configuration or a customized control system (touch panels, button panels, etc). Note: programming is not automatically required on one-touch join systems if they don’t have additional room controls or a DSP that needs to be configured.',
    details: [
      { body: 'Initial programming should always happen offsite and preferably before we mobilize to start the install.' },
      { body: 'Any touch panel layouts that need customer approval should be mocked up in software and provided to the post-sales engineer to review and send to the customer for sign-off before we mobilize to finish the programming.' },
      { body: 'Any testing prior to install should happen at the office on the AV bench or anywhere offsite that is sufficient.' },
      { body: 'Once the initial offsite programming is performed and the install has taken place, the programmer mobilizes to the site for final testing/commissioning/tuning of the programming and audio systems.' }
    ],
    notes: ['It is imperative that ALL AV install work is completed before the programmer mobilizes to the jobsite. If programming work needs to be phased out for a larger project, work directly with the programmer to schedule the dates of each room so they can prioritize rooms that will be completed first.']
  },
  {
    id: 27, section: 'post', branch: 'main', phase: 4, phaseLabel: 'Pre-Install', kind: 'milestone', num: 'M4.4',
    title: 'Bench Work / Staging',
    owner: 'AV Field Engineer', ownerKey: 'ops',
    actionItem: 'Field Engineer to stage equipment and do firmware updates and configuration of equipment.',
    videoUrl: '',
    summary: 'Most projects have some bench work time billed as part of the proposal. Bench work is performed on the AV bench by the AV Field Engineers. Bench work is billed per room or room type in the proposal.',
    details: [
      { label: 'Firmware Updates', body: 'Any firmware updates on devices that need them should be applied prior to installing in the field.' },
      { label: 'IP Addressing', body: 'All IP addresses should be preloaded into devices that need them, unless the client has specified DHCP. Use the AV Networking worksheet template for identifying proper IP schema with a client.' },
      { label: 'Equipment Documentation', body: 'All equipment documentation should be captured in a spreadsheet before the project mobilizes for onsite install: serial numbers, MAC addresses, IP addresses, room the equipment will be installed in, etc.' }
    ],
    notes: []
  },

  // ---------- Phase 5: Install & Commission ----------
  {
    id: 28, section: 'post', branch: 'main', phase: 5, phaseLabel: 'Install & Commission', kind: 'milestone', num: 'M5.1',
    title: 'Schedule Install',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Schedule technicians for onsite install.',
    videoUrl: '',
    summary: 'During the programming/bench work process, the project managers should be mapping our original install timeline into official dates. These dates should be communicated with shared services as soon as they are known. Any changes due to customer or internal delays should be communicated immediately so shared services can prioritize resources accordingly.',
    details: [
      { body: 'An SSP should be developed and presented showing the exact dates each room (or each part of each room) will be installed so everyone involved knows which rooms to prioritize first.' }
    ],
    notes: ['For some projects, this is as simple as scheduling a date or two to mobilize to install a few rooms. For others, it could be a very long detailed SSP for managing a larger project. All relevant information should be communicated via Teams to the entire project team.']
  },
  {
    id: 29, section: 'post', branch: 'main', phase: 5, phaseLabel: 'Install & Commission', kind: 'milestone', num: 'M5.2',
    title: 'Onsite Install',
    owner: 'AV Field Engineer', ownerKey: 'ops',
    actionItem: 'Perform onsite install.',
    videoUrl: '',
    summary: 'Following all programming/bench work completion, the AV Field Engineer, lead techs, and install techs mobilize to do the initial install of the project onsite.',
    details: [
      { body: 'The week leading up to the install, the project managers should be onsite regularly to ensure site conditions are ready for us to install and that all other trades are wrapping up so that all electrical, cable, and pathways are in place and ready for us.' },
      { body: 'The project managers should also be regularly in contact with the furniture teams to ensure all furniture will be installed and ready for us to mount any equipment needed before we mobilize. This has been one of the biggest challenges to date with adding additional unwarranted hours to projects.' }
    ],
    notes: ['During the install process, the project managers send out weekly snapshot updates to the customer and blind-copy the entire project team so everyone involved can see the progress of the install weekly.']
  },
  {
    id: 30, section: 'post', branch: 'main', phase: 5, phaseLabel: 'Install & Commission', kind: 'milestone', num: 'M5.3',
    title: 'Commissioning',
    owner: 'AV Field Engineer', ownerKey: 'ops',
    actionItem: 'Commission all AV systems. Create a punchlist as you go.',
    videoUrl: '',
    summary: 'Once the original install is done, the programmer and AV Field Engineer re-mobilize to commission all systems. This includes final debugging/testing of programming work, dialing in the DSP and tuning the audio in the room, and testing all room functionality.',
    details: [
      { label: 'Programmer’s Work', body: 'Debug any programming in the room, test and verify all of their code is working with the control system, and do a final tuning of the DSP in the room (if there is one).' },
      { label: 'AV Field Engineer’s Work', body: 'Onsite at the same time as the programmer. Tests overall functionality of the system: video routing, audio routing (mics and speakers), start up/shut down of all systems, conferencing capabilities, room schedulers, and any additional functionality per the scope of work.' },
      { label: 'Documentation', body: 'As each room is commissioned, a detailed document should be written up and commented regularly noting any additional items that need to be added or fixed, plus final notes showing all systems are functional once that is the case.' }
    ],
    notes: []
  },
  {
    id: 31, section: 'post', branch: 'main', phase: 5, phaseLabel: 'Install & Commission', kind: 'milestone', num: 'M5.4',
    title: 'Testing Checklist',
    owner: 'AV Field Engineer', ownerKey: 'ops',
    actionItem: 'Finish all punch-list items.',
    videoUrl: '',
    summary: 'Once initial commissioning is complete, the technician team should mobilize to complete any leftover items commented as needing work on the commissioning documentation. This work should be prioritized as high so we can move into the closeout process with the customer.',
    details: [
      { label: 'Internal Checklist', body: 'Sometimes a client won’t be heavily involved in commissioning. In this case, our team uses our internal checklist as the measure of what work is left to be done. The checklist can be found in the project files for every job.' },
      { label: 'External Checklist', body: 'Sometimes the GC/end client requires a site walk through all spaces so a punch list can be put together for work left to be completed. Take the notes the GC or end client has handed over regarding remaining work and upload it to the Teams channel for the whole project team to see.' },
      { label: 'Project Managers', body: 'Take any checklist of work left and assign an owner to each task as well as a date by which that task will be completed. Communicate all dates to the project team and the end client.' }
    ],
    notes: []
  },

  // ---------- Phase 6: Closeout ----------
  {
    id: 32, section: 'post', branch: 'main', phase: 6, phaseLabel: 'Closeout', kind: 'milestone', num: 'M6.1',
    title: 'Training',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'Train the customer on all AV systems.',
    videoUrl: '',
    summary: 'Once final commissioning is complete and all parts of the system are functional per the scope of work, the AV Project Manager and the AV Field Engineer perform training for the end client. Training hours are billed on a project-wide basis (one labor line item on the quote) and can range from 2 hours (small project) to 24+ hours (very large projects).',
    details: [
      { body: 'Training is meant to be for necessary personnel only — we don’t intend to train an entire company including regular users of the system. The target audience is someone who can relay this training to the company at large (an IT manager or whoever will manage the AV system).' },
      { label: 'One per room type', body: 'Training should only be performed for each room type. If there are 5 huddle rooms that are identical, only one huddle room should need to have a training.' },
      { label: 'Stick to the functional scope', body: 'Avoid getting into questions about MS Teams and general organizational needs (e.g. what is the best method of scheduling a meeting in Outlook). If asked, defer the user to their IT team for best practices on the program at hand.' }
    ],
    notes: ['It is fine to provide insight around Zoom/Teams/Google Meet or whatever else the customer is asking about, as long as we preface it with the idea that most of these things can be done in multiple ways and we can’t be responsible for instructing their employees to do things differently than the IT managers would prefer.']
  },
  {
    id: 33, section: 'post', branch: 'main', phase: 6, phaseLabel: 'Closeout', kind: 'milestone', num: 'M6.2',
    title: 'Closeout / Sign Off',
    owner: 'AV PM / Field PM', ownerKey: 'ops',
    actionItem: 'Develop as-builts and send off all close-out documents (owners manuals, warranties, drawings). Get formal sign-off on all systems. Close out job for final billing.',
    videoUrl: '',
    summary: 'Once final commissioning and training have taken place, a site walk should be conducted again with the end user to verify all system functionality and sign off on each individual room.',
    details: [
      { body: 'The sign off of the room indicates that all functionality is working per the scope of work and no additional work needs to be done. This process indicates the start of our 90-day workmanship warranty as well as a takeover by our service department for any additional work that needs to be done once we are signed off.' },
      { body: 'If we receive a call shortly after sign off saying a particular system isn’t working, the service team should mobilize to determine if this is a workmanship issue or a service issue (client broke something or did something they shouldn’t have done).' }
    ],
    notes: []
  },
  {
    id: 34, section: 'post', branch: 'main', phase: 6, phaseLabel: 'Closeout', kind: 'milestone', num: 'M6.3',
    title: 'Managed Services Transfer',
    owner: 'AV PM / Managed Services', ownerKey: 'ops',
    actionItem: 'Introduce client contact to our service team and explain how to create a service ticket.',
    videoUrl: '',
    summary: 'Once a project has been closed out, the customer is introduced to our service department as their primary point of contact moving forward. Any additional calls regarding the project should be routed directly to the service department, not to the project manager.',
    details: [
      { body: 'Once a project is officially closed and the service department has been introduced, the Teams channel for this project can be officially closed.' },
      { body: 'All service calls after this point will be documented and tracked in our service ticketing system.' },
      { body: 'The service department can leverage the project team at any time if additional information or questions need to be asked.' },
      { body: 'If a project warrants an entirely new quote for service work or to build additional needed functionality into an existing system, the project should be entered as a new lead and re-start from the beginning of the pre-sales process.' }
    ],
    notes: ['Currently the standard for AV service is either T&M without a service contract or service contracts through Premiere Protect. When a managed services transfer happens, we should be informing the customer how to make a service request. Service requests will be triaged by the Managed Services Manager for AVSS, then we will work with local business unit teams for service.']
  },

  // ============ PURCHASING ============
  // Single linear branch ('main') with 5 phases. Mirrors the post-sales
  // structure. 'purchasing' ownerKey renders purple; 'avss' = navy; 'ops' = blue.

  // ---------- Phase 1: Setup & Intake ----------
  {
    id: 300, section: 'purchasing', branch: 'main', phase: 1, phaseLabel: 'Setup & Intake', kind: 'milestone', num: 'M1.1',
    title: 'Purchasing Agent Assignment',
    owner: 'Operations', ownerKey: 'ops',
    actionItem: 'Determine and assign the Purchasing Agent for this project based on the Instrata business unit.',
    videoUrl: '',
    summary: 'The appropriate Purchasing Agent is determined per project based on the Instrata business unit. Instrata SE Purchasing supports the SE and MidAtlantic regions; Instrata NE Purchasing supports the NE and SW regions.',
    details: [
      { label: 'Regional assignment', body: 'Instrata SE Purchasing supports: Instrata SE, Instrata MA. Instrata NE Purchasing supports: Instrata NE, Instrata SW.' }
    ],
    notes: []
  },
  {
    id: 301, section: 'purchasing', branch: 'main', phase: 1, phaseLabel: 'Setup & Intake', kind: 'milestone', num: 'M1.2',
    title: 'Post-Sales Kickoff Meeting',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Purchasing Agent attends the post-sales kickoff meeting. Required for projects over $50K.',
    videoUrl: '',
    summary: 'For projects over $50K, the Purchasing Agent attends the post-sales kickoff meeting alongside the AV Post-Sales Engineer and AV Project Manager. The goal is to receive the Preliminary BoM and align on project scope and schedule early.',
    details: [
      { label: 'Attendees', body: 'AV Post-Sales Engineer, AV Project Manager, Purchasing Agent.' }
    ],
    notes: ['Attendance is required for projects over $50K. For smaller projects, coordinate directly with the AV PM via Teams.']
  },
  {
    id: 302, section: 'purchasing', branch: 'main', phase: 1, phaseLabel: 'Setup & Intake', kind: 'deliverable', num: 'D1',
    title: 'Preliminary BoM',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'Generate and deliver the Preliminary BoM from the pre-sales DTools project to the Purchasing Agent at or immediately following kickoff.',
    videoUrl: '',
    summary: 'The Preliminary BoM is produced at project kickoff from the pre-sales design. It represents the best-known equipment list at the time of award and allows Purchasing to begin pricing, vendor outreach, and lead time assessment before shop drawings are finalized.',
    details: [
      { body: 'This BoM is generated from DTools using the standard BoM template grouped by vendor. It is not final — miscellaneous materials, specialty cabling, and items identified during drawing production will be added in the Final Scrubbed BoM (D2). However, it contains sufficient detail for Purchasing to begin vendor quotes and lead time checks.' }
    ],
    notes: ['Use the standard BoM template format so Purchasing can begin their process without reformatting.']
  },

  // ---------- Phase 2: Early Procurement Prep ----------
  {
    id: 303, section: 'purchasing', branch: 'main', phase: 2, phaseLabel: 'Early Procurement Prep', kind: 'milestone', num: 'M2.1',
    title: 'Purchasing Initial BOM Review',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Perform a detailed review of the Preliminary BoM, comparing against the pre-sales budget, and flag any discrepancies to the AV PM and Post-Sales Engineer.',
    videoUrl: '',
    summary: 'Purchasing performs a detailed review of the Preliminary BoM to identify discrepancies between the pre-sales budget estimate and the actual post-sales equipment list. Issues are communicated back to the AV PM and Post-Sales Engineer for resolution.',
    details: [
      { label: 'Review checklist', body: 'Compare pre-sales budget vs. post-sales BoM. Identify and flag: vendor discrepancies, incorrect part numbers or descriptions, cost variances. Identify miscellaneous materials, specialty cabling requirements, and rack/cabinet build locations (if offsite). Identify items to be shipped separately for staging.' }
    ],
    notes: ['All identified issues should be documented and communicated via the project Teams chat so the whole team has visibility.']
  },
  {
    id: 304, section: 'purchasing', branch: 'main', phase: 2, phaseLabel: 'Early Procurement Prep', kind: 'milestone', num: 'M2.2',
    title: 'Vendor Pricing & Lead Time Assessment',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Send RFPs to AV distribution vendors and obtain a minimum of 2–3 competitive quotes per major category. Evaluate pricing, terms, freight, and local warehousing options.',
    videoUrl: '',
    summary: 'Purchasing consolidates the Preliminary BoM across all rooms, groups by vendor and part number, and conducts the formal vendor pricing process. A minimum of 2–3 quotes are obtained per major category to ensure competitive pricing.',
    details: [
      { label: 'BoM consolidation', body: 'Group all items by vendor and part number, summing total quantities across all rooms. This creates a single consolidated RFP document.' },
      { label: 'Vendor evaluation criteria', body: 'Pricing, payment terms, freight cost and timeline, local warehousing availability.' }
    ],
    notes: []
  },
  {
    id: 305, section: 'purchasing', branch: 'main', phase: 2, phaseLabel: 'Early Procurement Prep', kind: 'milestone', num: 'M2.3',
    title: 'Project Schedule & Material Phasing',
    owner: 'AV Project Manager', ownerKey: 'ops',
    actionItem: 'AV PM provides Purchasing with a phased required-by schedule covering long lead items, rack build materials, balance of materials, displays, and receive-from dates.',
    videoUrl: '',
    summary: 'The AV Project Manager works with Purchasing to define the material phasing schedule. This allows Purchasing to prioritize orders and release materials in alignment with the installation timeline rather than ordering everything at once.',
    details: [
      { label: 'Phasing categories', body: 'Long lead items, rack build materials (for offsite staging), balance of materials (excluding displays), displays, receive-from schedule.' }
    ],
    notes: []
  },

  // ---------- Phase 3: Design Validation & BoM Scrub ----------
  {
    id: 306, section: 'purchasing', branch: 'main', phase: 3, phaseLabel: 'Design Validation & BoM Scrub', kind: 'milestone', num: 'M3.1',
    title: 'Shop Drawing Coordination & BoM Validation',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'AVSS team produces shop drawings and simultaneously validates and updates the BoM to capture all miscellaneous materials, specialty cabling, and patch cord assemblies.',
    videoUrl: '',
    summary: 'As the post-sales engineering team produces shop drawings, they simultaneously validate the BoM against the finalized design. This process surfaces all miscellaneous materials — short interconnect cables, specialty adapters, rack accessories, and any equipment missed in the original design.',
    details: [
      { body: 'Lengths for patch cords and cable assemblies should be finalized during this process. Rack and cabinet build requirements should be confirmed. The goal is to capture everything needed for a complete installation before the Final Scrubbed BoM (D2) is issued.' }
    ],
    notes: ['If drawings take longer than expected and Purchasing needs to proceed, coordinate with the AV PM on which items can be released as a partial order (see M3.2).']
  },
  {
    id: 307, section: 'purchasing', branch: 'main', phase: 3, phaseLabel: 'Design Validation & BoM Scrub', kind: 'milestone', num: 'M3.2',
    title: 'Partial Order Release',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'If schedule demands it, coordinate with the AV PM to identify and release a partial order of approved long-lead or critical-path items before the Final BoM is complete.',
    videoUrl: '',
    summary: 'On projects with aggressive schedules, Purchasing may release a partial order before the Final BoM is finalized. This is a controlled release of items that are fully approved and confirmed — typically long-lead or critical-path equipment with no expected changes.',
    details: [],
    notes: ['This step is optional. Only proceed with partial orders when explicitly authorized by the AV PM and when the items in question are highly unlikely to change.']
  },
  {
    id: 308, section: 'purchasing', branch: 'main', phase: 3, phaseLabel: 'Design Validation & BoM Scrub', kind: 'deliverable', num: 'D2',
    title: 'Final Scrubbed BoM',
    owner: 'Shared Services', ownerKey: 'avss',
    actionItem: 'Issue the Final Scrubbed BoM to Purchasing, incorporating all items identified during shop drawing production. This document supersedes the Preliminary BoM.',
    videoUrl: '',
    summary: 'The Final Scrubbed BoM is the complete, validated equipment and materials list, updated after shop drawings are finished. It includes all miscellaneous materials, cabling, patch cords, and any items added or changed since the Preliminary BoM. This is the authoritative BoM for all remaining purchasing activity.',
    details: [
      { body: 'The final BoM should follow the standard template format grouped by vendor. Any items already released in a partial order (M3.2) should be noted clearly so Purchasing can track what has already been ordered.' }
    ],
    notes: []
  },

  // ---------- Phase 4: Order Placement ----------
  {
    id: 309, section: 'purchasing', branch: 'main', phase: 4, phaseLabel: 'Order Placement', kind: 'milestone', num: 'M4.1',
    title: 'Purchasing Worksheets for ERP Entry',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Prepare structured purchasing worksheets from the Final BoM for ERP order entry.',
    videoUrl: '',
    summary: 'Purchasing prepares structured worksheets from the Final BoM that contain all information needed for ERP entry, including vendor details, part numbers, quantities, pricing, and contact information.',
    details: [
      { label: 'Required fields', body: 'Vendor, part number, description, total quantity, unit cost, vendor contact info, availability/lead time.' }
    ],
    notes: []
  },
  {
    id: 310, section: 'purchasing', branch: 'main', phase: 4, phaseLabel: 'Order Placement', kind: 'milestone', num: 'M4.2',
    title: 'Order Entry',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Send purchasing spreadsheet to Instrata MidAtlantic for ERP order entry. Coordinate cross-region items with Instrata SE as needed.',
    videoUrl: '',
    summary: 'Purchasing sends the structured spreadsheet to Instrata MidAtlantic for ERP order entry. For items that cannot be procured directly through MidAtlantic, those items are transferred to Instrata SE Purchasing for procurement.',
    details: [
      { label: 'MidAtlantic ERP entry', body: 'Purchasing sends the spreadsheet to the Instrata MidAtlantic Purchasing Agent, who enters the orders into the local ERP system.' },
      { label: 'Cross-region coordination (Instrata NE)', body: 'Instrata NE Purchasing first determines which items cannot be procured directly. Those items are transferred to Instrata SE Purchasing. SE provides pricing and lead times back to NE and stores all POs in the Shared Project Folder for 3-way match.' }
    ],
    notes: []
  },
  {
    id: 311, section: 'purchasing', branch: 'main', phase: 4, phaseLabel: 'Order Placement', kind: 'milestone', num: 'M4.3',
    title: 'Non-Direct Purchases',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Instrata SE places POs for any items that cannot be purchased through MidAtlantic. Ship to the designated Instrata MidAtlantic location.',
    videoUrl: '',
    summary: 'For items not purchasable via MidAtlantic — specialty items, direct vendor relationships, or regional availability constraints — Instrata SE places the POs directly and ships to the designated MidAtlantic location.',
    details: [],
    notes: []
  },
  {
    id: 312, section: 'purchasing', branch: 'main', phase: 4, phaseLabel: 'Order Placement', kind: 'deliverable', num: 'D3',
    title: 'Purchase Orders',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Store all Purchase Orders in the Shared Services Project Folder for 3-way match processing.',
    videoUrl: '',
    summary: 'All purchase orders are documented and filed in the Shared Services Project Folder to support 3-way match (PO, receipt, invoice) for accounting and reconciliation.',
    details: [],
    notes: []
  },

  // ---------- Phase 5: Order Management ----------
  {
    id: 313, section: 'purchasing', branch: 'main', phase: 5, phaseLabel: 'Order Management', kind: 'milestone', num: 'M5.1',
    title: 'PO Tracking',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Maintain a PO tracking spreadsheet in the Shared Services Project Folder, tracking all open POs by vendor.',
    videoUrl: '',
    summary: 'Purchasing maintains an active tracking spreadsheet in the Shared Services Project Folder with the status of all purchase orders organized by vendor. This is the live dashboard for order status visibility across the project team.',
    details: [],
    notes: []
  },
  {
    id: 314, section: 'purchasing', branch: 'main', phase: 5, phaseLabel: 'Order Management', kind: 'milestone', num: 'M5.2',
    title: 'Documentation Management',
    owner: 'Purchasing Agent', ownerKey: 'purchasing',
    actionItem: 'Store all vendor quotes and purchase orders in the Shared Services Project Folder.',
    videoUrl: '',
    summary: 'All vendor quotes obtained during the pricing process and all issued purchase orders are stored in the Shared Services Project Folder for project documentation and future reference.',
    details: [],
    notes: []
  }
];
