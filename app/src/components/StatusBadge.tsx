// Background + foreground hex pairs so we can render the optional dot in the
// same color as the text. Inline styles avoid Tailwind purging dynamic classes.
const colorMap: Record<string, [string, string]> = {
  // Document statuses
  Draft: ['#F3F4F6', '#4B5563'],
  Submitted: ['#DBEAFE', '#1D4ED8'],
  Open: ['#DBEAFE', '#1D4ED8'],
  Approved: ['#DCFCE7', '#15803D'],
  Complete: ['#DCFCE7', '#15803D'],
  Closed: ['#DCFCE7', '#15803D'],
  'Revise & Resubmit': ['#FEF9C3', '#A16207'],
  Answered: ['rgba(34,50,110,0.1)', '#22326E'],
  Void: ['#F9FAFB', '#9CA3AF'],
  Overdue: ['#FEE2E2', '#B91C1C'],
  Critical: ['#FEE2E2', '#B91C1C'],
  'N/A': ['#F3F4F6', '#6B7280'],
  Standard: ['#F3F4F6', '#4B5563'],

  // Monday.com pipeline statuses
  'Not Started': ['#F3F4F6', '#4B5563'],
  'In Progress': ['rgba(246,141,46,0.1)', '#E07A1A'],
  'In Review': ['#DBEAFE', '#1D4ED8'],
  'Follow Up': ['#FEF9C3', '#A16207'],
  Won: ['#DCFCE7', '#15803D'],

  // Legacy ProjectStatus values (retained while legacy projects exist)
  Active: ['#DCFCE7', '#15803D'],
  'Pending Closeout': ['#FEF9C3', '#A16207'],

  // Phase tags
  'Pre-Sales': ['rgba(0,114,206,0.1)', '#0072CE'],
  'Post-Sales': ['rgba(34,50,110,0.1)', '#22326E'],

  // Auto-Review
  Recommended: ['#DCFCE7', '#15803D'],
  Flagged: ['#FEE2E2', '#B91C1C'],
  'Ready for Review': ['#DBEAFE', '#1D4ED8'],
};

export function StatusBadge({ status, dot }: { status: string; dot?: boolean }) {
  const [bg, fg] = colorMap[status] ?? colorMap.Draft;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: bg, color: fg }}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: fg }} />}
      {status}
    </span>
  );
}
