// Fictional sample briefing used until the worklist tables exist. Names,
// projects and links are made up; nothing here comes from real mail or chat.

import type { Briefing } from './types';

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
      id: 'w1', kind: 'respond', source: 'email',
      title: 'Confirm display mounting heights before the GC orders backing',
      from: 'Dana Ortiz (GC PM)', due: '2026-11-05', dueBasis: 'stated', urgency: 1,
      urgencyReason: 'GC is blocked; framing inspection Friday',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w2', kind: 'decide', source: 'monday',
      title: 'Bid / no-bid: Harbor View Community Center AV',
      from: 'Triage board', due: '2026-11-09', dueBasis: 'stated', urgency: 1,
      urgencyReason: 'Bid due in 2 business days',
      link: '#', carriedDays: 1, status: 'open',
    },
    {
      id: 'w3', kind: 'respond', source: 'teams',
      title: 'Does the change order go on the job cost, or do you need the GM form?',
      from: 'Sam Patel', due: null, dueBasis: 'none', urgency: 2,
      urgencyReason: 'Teammate blocked on your answer',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w4', kind: 'do', source: 'monday',
      title: 'Cutsheet submittals – Westlake Library renovation',
      from: 'Post-Sales board', due: '2026-11-06', dueBasis: 'stated', urgency: 2,
      urgencyReason: 'Due tomorrow',
      link: '#', carriedDays: 2, status: 'open',
    },
    {
      id: 'w5', kind: 'do', source: 'email',
      title: 'You promised Casey the updated sync-engine mapping',
      from: 'you promised Casey', due: '2026-11-06', dueBasis: 'inferred', urgency: 2,
      urgencyReason: 'Said "by end of week" in chat',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w6', kind: 'respond', source: 'email',
      title: 'Pick dates for the manufacturer visit (Nov 17–19?)',
      from: 'Riley Chen', due: '2026-11-10', dueBasis: 'inferred', urgency: 3,
      urgencyReason: 'Needs an answer this week to book travel',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w7', kind: 'do', source: 'monday',
      title: 'Rebid – City 911 Center (revised scope)',
      from: 'Pre-Sales board', due: '2026-11-13', dueBasis: 'stated', urgency: 3,
      urgencyReason: 'Due in 8 days',
      link: '#', carriedDays: 0, status: 'open',
    },
    {
      id: 'w8', kind: 'do', source: 'manual',
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
    { id: 'r1', source: 'email', text: 'Riverside Medical moved substantial completion up two weeks – install crew schedule will tighten.', link: '#' },
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
