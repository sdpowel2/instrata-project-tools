// Fictional sample briefing used until the worklist tables exist. Names,
// projects and links are made up; nothing here comes from real mail or chat.

import type { Briefing, ProjectActivity, ReviewedRow, TriageRule } from './types';

export const SAMPLE_BRIEFING: Briefing = {
  date: '2026-11-05',
  ranAt: '2026-11-05T06:04:00-05:00',
  since: '2026-11-04T17:00:00-05:00',
  missing: [],
  sourceCounts: { mail: 41, teams: 27, monday: 64, manual: 2 },
  schedule: [
    { id: 'e1', start: '08:00', end: '09:00', subject: 'Weekly sub coordination', location: 'Jobsite trailer', canceled: true },
    { id: 'e2', start: '09:30', end: '10:00', subject: 'Pre-sales standup', location: 'Teams' },
    { id: 'e3', start: '11:00', end: '12:00', subject: 'Design review – Riverside Medical lobby', location: 'Conf Rm B', isOrganizer: true },
    { id: 'e4', start: '14:00', end: '14:30', subject: '1:1 with Jordan', location: 'Teams' },
  ],
  openBlocks: ['10:00–11:00', '12:00–14:00', '14:30–17:00'],
  items: [
    {
      id: 'w1', workType: 'reply', claudeWorkType: 'reply', workConfidence: 0.9, workTypeChecked: true, kind: 'respond', source: 'email',
      title: 'Confirm display mounting heights before the GC orders backing',
      from: 'Dana Ortiz (GC PM)', due: '2026-11-05', dueBasis: 'stated', urgency: 1,
      urgencyReason: 'GC is blocked; framing inspection Friday',
      link: '#', carriedDays: 0, status: 'open', projectId: 'p1',
    },
    {
      id: 'w2', workType: 'none', claudeWorkType: 'none', workConfidence: 0.85, kind: 'decide', source: 'monday',
      title: 'Bid / no-bid: Harbor View Community Center AV',
      from: 'Triage board', due: '2026-11-09', dueBasis: 'stated', urgency: 1,
      urgencyReason: 'Bid due in 2 business days',
      link: '#', carriedDays: 1, status: 'open',
    },
    {
      id: 'w3', workType: 'reply', claudeWorkType: 'reply', workConfidence: 0.8, kind: 'respond', source: 'teams',
      title: 'Does the change order go on the job cost, or do you need the GM form?',
      from: 'Sam Patel', due: null, dueBasis: 'none', urgency: 2,
      urgencyReason: 'Teammate blocked on your answer',
      summary: 'Sam asks about the INS-2026-002 lobby change order.',
      link: '#', carriedDays: 0, status: 'open', suggestedProjectId: 'p2',
    },
    {
      id: 'w4', workType: 'dtools_report', claudeWorkType: 'none', workConfidence: 0.55, workTypeChecked: true, kind: 'do', source: 'monday',
      title: 'Cutsheet submittals – Westlake Library renovation',
      from: 'Post-Sales board', due: '2026-11-06', dueBasis: 'stated', urgency: 2,
      urgencyReason: 'Due tomorrow',
      link: '#', carriedDays: 2, status: 'open',
    },
    {
      id: 'w5', workType: 'ipt_change', claudeWorkType: 'ipt_change', workConfidence: 0.75, kind: 'do', source: 'email',
      title: 'You promised Casey the updated sync-engine mapping',
      from: 'you promised Casey', due: '2026-11-06', dueBasis: 'inferred', urgency: 2,
      urgencyReason: 'Said "by end of week" in chat',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w6', workType: 'reply', claudeWorkType: 'reply', workConfidence: 0.95, kind: 'respond', source: 'email',
      title: 'Pick dates for the manufacturer visit (Nov 17–19?)',
      from: 'Riley Chen', due: '2026-11-10', dueBasis: 'inferred', urgency: 3,
      urgencyReason: 'Needs an answer this week to book travel',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w7', workType: 'none', claudeWorkType: 'none', workConfidence: 0.7, kind: 'do', source: 'monday',
      title: 'Rebid – City 911 Center (revised scope)',
      from: 'Pre-Sales board', due: '2026-11-13', dueBasis: 'stated', urgency: 3,
      urgencyReason: 'Due in 8 days',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w8', workType: 'none', claudeWorkType: 'none', workConfidence: 0.8, kind: 'do', source: 'manual',
      title: 'Review SCT visit agenda',
      from: 'manual', due: null, dueBasis: 'none', urgency: 3,
      urgencyReason: 'Marked !high but no date',
      carriedDays: 4, status: 'open',
    },
    {
      id: 'w9', kind: 'do', source: 'manual',
      title: 'Clean up stale Post-Sales items',
      from: 'manual', due: null, dueBasis: 'none', urgency: 4,
      urgencyReason: 'No date, nobody blocked',
      carriedDays: 0, status: 'open',
    },
    {
      id: 'q1', kind: 'question', source: 'claude',
      title: 'The GC asked for a revised quote. Send it now with the current drawings, or wait for the Rev C set due Monday?',
      from: 'Claude', due: '2026-11-06', dueBasis: 'inferred', urgency: 2,
      urgencyReason: 'Draft is ready; waiting on your call',
      carriedDays: 0, status: 'open',
      options: ['Send now', 'Wait for Rev C', 'Let me look first'],
    },
  ],
  readMe: [
    { id: 'r1', source: 'email', text: 'Hudson Yards GC (INS-2026-002) moved substantial completion up two weeks – install crew schedule will tighten.', link: '#', projectId: 'p2' },
    { id: 'r2', source: 'teams', text: 'Programming team finished the Westlake DSP config; handover can be scheduled.', link: '#' },
    { id: 'r3', source: 'email', text: 'New bid invite: county courthouse courtroom AV (due Dec 2). Looks in scope.', link: '#' },
    { id: 'r4', source: 'monday', text: 'Two Pre-Sales items were marked Won overnight by the Salesforce sync.', link: '#' },
  ],
  setAside: {
    categories: [
      { label: 'Automated / notifications', count: 17 },
      { label: 'Newsletters / marketing', count: 14 },
      { label: 'Other-trade GC mail', count: 4 },
      { label: 'Social chats', count: 2 },
      { label: 'Stale monday', count: 11 },
    ],
    items: [
      { id: 's1', title: 'Vendor pricing update – projectors', reason: 'pricing blast, no ask', link: '#' },
      { id: 's2', title: 'RFI 315 – plumbing riser conflict', reason: 'other trade, not AV', link: '#' },
    ],
  },
  closedSinceLast: [
    { id: 'c1', title: 'Reply to Morgan about rack elevations' },
    { id: 'c2', title: 'Approve labor hours on Harbor View estimate' },
  ],
};

/** Fictional reviewed log for the sample briefing (one row per conversation). */
export const SAMPLE_REVIEWED: ReviewedRow[] = [
  { id: 'v1', source: 'email', sourceKey: 'email:display mounting heights|dana@gcexample.com', title: 'Display mounting heights - need before backing order', from: 'Dana Ortiz (GC PM)', link: '#', outcome: 'respond', reason: 'GC blocked on your answer', reasonGroup: 'Direct ask', itemId: 'w1', sender: 'dana@gcexample.com' },
  { id: 'v2', source: 'teams', sourceKey: 'teams:chat-sam:msg-1', title: 'Sam Patel', from: 'Sam Patel', link: '#', outcome: 'respond', reason: 'asks where the change order goes', reasonGroup: 'Direct ask', itemId: 'w3', sender: 'sam.patel@instrata.com', channel: 'Sam Patel' },
  { id: 'v3', source: 'monday', sourceKey: 'monday:1001', title: 'Westlake Library renovation', from: 'Post-Sales board', link: '#', outcome: 'carried', reason: 'cutsheets due tomorrow', reasonGroup: 'Due soon on monday', itemId: 'w4', channel: 'AV Post-Sales Project Summary' },
  { id: 'v4', source: 'email', sourceKey: 'email:manufacturer visit dates|riley@vendor.com', title: 'Manufacturer visit - Nov 17-19?', from: 'Riley Chen', link: '#', outcome: 'respond', reason: 'needs dates to book travel', reasonGroup: 'Waiting on you', itemId: 'w6', sender: 'riley@vendor.com' },
  { id: 'v5', source: 'email', sourceKey: 'email:riverside medical schedule update|pm@gcexample.com', title: 'Riverside Medical - revised completion date', from: 'Riverside GC', link: '#', outcome: 'read_me', reason: 'schedule moved up two weeks', reasonGroup: 'Worth knowing', sender: 'pm@gcexample.com', ruleIds: ['rule-1'] },
  { id: 'v6', source: 'email', sourceKey: 'email:courthouse courtroom av|bids@platform.com', title: 'Bid invite: County Courthouse courtroom AV', from: 'Bid platform', link: '#', outcome: 'read_me', reason: 'looks like AV scope', reasonGroup: 'Worth knowing', sender: 'bids@platform.com' },
  { id: 'v7', source: 'email', sourceKey: 'email:projector pricing update|sales@distributor.com', title: 'Projector pricing update', from: 'Distributor sales', link: '#', outcome: 'set_aside', reason: 'pricing blast, no ask', reasonGroup: 'Newsletters / marketing', sender: 'sales@distributor.com', ruleIds: ['rule-2'] },
  { id: 'v8', source: 'email', sourceKey: 'email:rfi 315 plumbing riser|procore@gcexample.com', title: 'RFI 315 - plumbing riser conflict', from: 'Procore', link: '#', outcome: 'set_aside', reason: 'other trade, not AV', reasonGroup: 'Other trade', sender: 'no-reply@procore.com' },
  { id: 'v9', source: 'email', sourceKey: 'email:lobby displays - quick question|jordan@client.com', title: 'Lobby displays - quick question', from: 'Jordan (client)', link: '#', outcome: 'set_aside', reason: 'you were CC only', reasonGroup: 'CC only, no ask', sender: 'jordan@client.com' },
  { id: 'v10', source: 'email', sourceKey: 'email:weekly av digest|news@trade.com', title: 'Weekly AV industry digest', from: 'Trade newsletter', link: '#', outcome: 'dropped', reason: 'newsletter', reasonGroup: 'Newsletters / marketing', sender: 'news@trade.com' },
  { id: 'v11', source: 'email', sourceKey: 'email:automatic reply: out of office|ooo@vendor.com', title: 'Automatic reply: Out of office', from: 'Vendor rep', link: '#', outcome: 'dropped', reason: 'auto-reply', reasonGroup: 'Automated / notifications', sender: 'ooo@vendor.com' },
  { id: 'v12', source: 'teams', sourceKey: 'teams:chat-friday:msg-9', title: 'Friday lunch?', from: 'Team chat', link: '#', outcome: 'dropped', reason: 'small talk, no ask', reasonGroup: 'Social chats', sender: 'alex@instrata.com', channel: 'AV Team' },
  { id: 'v13', source: 'monday', sourceKey: 'monday:1077', title: 'Heartwood Wealth Advisors (Close Out)', from: 'Post-Sales board', link: '#', outcome: 'set_aside', reason: 'shop drawings date long past', reasonGroup: 'Stale monday', channel: 'AV Post-Sales Project Summary' },
];

/** Sample tuning rules (2.2): one lesson, one hard suppress, one switched off. */
export const SAMPLE_RULES: TriageRule[] = [
  {
    id: 'rule-1', kind: 'lesson', match: { domain: 'gcexample.com' }, effect: 'min_read_me',
    note: "Schedule changes from a GC matter even when they're sent FYI", active: true,
    createdFrom: 'surface_more', exampleId: 'v5', createdAt: '2026-11-02T14:10:00Z', hits30d: 4, lastHitAt: '2026-11-05T11:02:00Z',
  },
  {
    id: 'rule-2', kind: 'hard', match: { source: 'email', domain: 'distributor.com' }, effect: 'suppress',
    note: 'Distributor pricing blasts', active: true,
    createdFrom: 'surface_less', exampleId: 'v7', createdAt: '2026-10-28T13:00:00Z', hits30d: 9, lastHitAt: '2026-11-05T11:02:00Z',
  },
  {
    id: 'rule-3', kind: 'hard', match: { source: 'email', subjectTerms: ['rfi'] }, effect: 'min_task',
    note: 'Every RFI', active: false,
    createdFrom: 'manual', createdAt: '2026-10-20T15:30:00Z', hits30d: 0,
  },
];

/** Sample activity for the project page panel (2.4), keyed by the demo store's project ids. */
export const SAMPLE_PROJECT_ACTIVITY: Record<string, ProjectActivity[]> = {
  p1: [
    { id: 'pa3', itemId: 'w1', kind: 'linked', title: 'Confirm display mounting heights before the GC orders backing', occurredAt: '2026-11-05T07:12:00-05:00' },
    { id: 'pa2', kind: 'done', title: 'Send the revised rack elevation to the GC', occurredAt: '2026-11-03T15:40:00-05:00' },
    { id: 'pa1', kind: 'linked', title: 'Send the revised rack elevation to the GC', occurredAt: '2026-11-02T08:05:00-05:00' },
  ],
};
