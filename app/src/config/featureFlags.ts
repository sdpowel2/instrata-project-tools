/** Features gated off for the v1 team rollout. The full-suite branch is the
 *  long-term home of these tools; flip to true (or merge from full-suite)
 *  when a feature is ready to ship. Gates cover routes (App.tsx), sidebar
 *  nav (Layout.tsx), overview tool cards (ProjectOverview.tsx), and
 *  dashboard widgets (Dashboard.tsx, AdminDashboardSection.tsx). */
export const FEATURES = {
  autoReview:  false,
  bidLeveling: false,
  ownerManual: false,
  operations:  false, // schedule & milestones, purchasing, inventory
} as const;
