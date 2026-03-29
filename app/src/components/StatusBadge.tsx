const colorMap: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-600',
  Submitted: 'bg-blue-100 text-blue-700',
  Open: 'bg-blue-100 text-blue-700',
  Approved: 'bg-green-100 text-green-700',
  Complete: 'bg-green-100 text-green-700',
  Closed: 'bg-green-100 text-green-700',
  'Revise & Resubmit': 'bg-yellow-100 text-yellow-700',
  Answered: 'bg-navy/10 text-navy',
  Void: 'bg-gray-50 text-gray-400',
  Overdue: 'bg-red-100 text-red-700',
  Critical: 'bg-red-100 text-red-700',
  'In Progress': 'bg-orange/10 text-orange-dark',
  'N/A': 'bg-gray-100 text-gray-500',
  Active: 'bg-green-100 text-green-700',
  'Pending Closeout': 'bg-yellow-100 text-yellow-700',
  Standard: 'bg-gray-100 text-gray-600',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = colorMap[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
}
