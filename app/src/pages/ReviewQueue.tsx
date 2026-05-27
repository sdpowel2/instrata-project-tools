import { useNavigate } from 'react-router-dom';
import { Clock, AlertCircle, CheckCircle2, RefreshCw, ArrowRight, Inbox } from 'lucide-react';
import { useStore } from '../store';
import type { ReviewRun, ReviewRunStatus } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RUN_STATUS_LABEL: Record<ReviewRunStatus, string> = {
  pending_review:       'Pre-Review',
  submitted_for_review: 'Submitted for Review',
  in_review:            'In Review',
  changes_requested:    'Changes Requested',
  quick_fix:            'Quick Fix',
  approved:             'Approved',
};

const RUN_STATUS_STYLE: Record<ReviewRunStatus, string> = {
  pending_review:       'bg-slate-100 text-slate-700',
  submitted_for_review: 'bg-amber-100 text-amber-800',
  in_review:            'bg-blue-100 text-blue-800',
  changes_requested:    'bg-red-100 text-red-800',
  quick_fix:            'bg-purple-100 text-purple-800',
  approved:             'bg-green-100 text-green-800',
};

// pending_review is the engineer's private pre-review and never appears in
// the manager queue. The queue starts with submitted_for_review.
const ACTIVE_STATUSES: ReviewRunStatus[] = ['submitted_for_review', 'in_review', 'changes_requested'];

// ─── Run Card ─────────────────────────────────────────────────────────────────

function RunCard({ run, projectName, projectNumber, onClick }: {
  run: ReviewRun;
  projectName: string;
  projectNumber: string;
  onClick: () => void;
}) {
  const isSubmitted = run.status === 'submitted_for_review';
  const isChanges   = run.status === 'changes_requested';

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border border-border rounded-xl p-4 hover:shadow-md hover:border-navy/20 transition-all group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${RUN_STATUS_STYLE[run.status]}`}>
              {RUN_STATUS_LABEL[run.status]}
            </span>
            {run.runNumber > 1 && (
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                Resubmission #{run.runNumber}
              </span>
            )}
          </div>
          <div className="font-semibold text-text-primary truncate">{projectName}</div>
          <div className="text-xs text-text-secondary mt-0.5 font-mono">{projectNumber}</div>
        </div>
        <ArrowRight
          size={16}
          className="text-text-secondary group-hover:text-navy transition-colors flex-shrink-0 mt-1"
        />
      </div>

      <div className="flex items-center gap-1.5 mt-3 text-xs text-text-secondary">
        {isSubmitted ? (
          <><Clock size={12} /> Waiting for manager review</>
        ) : isChanges ? (
          <><RefreshCw size={12} /> Awaiting engineer resubmission</>
        ) : (
          <><Clock size={12} /> In review</>
        )}
        <span className="ml-auto">
          {new Date(run.triggeredAt).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
          })}
        </span>
      </div>
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ReviewQueuePage() {
  const navigate  = useNavigate();
  const projects  = useStore(s => s.projects);
  const reviewRuns = useStore(s => s.reviewRuns);

  // Build a lookup: projectId → most recent run
  const latestRunByProject = new Map<string, ReviewRun>();
  for (const run of [...reviewRuns].sort((a, b) => b.runNumber - a.runNumber)) {
    if (!latestRunByProject.has(run.projectId)) {
      latestRunByProject.set(run.projectId, run);
    }
  }

  // Filter to only active statuses
  const activeRuns = [...latestRunByProject.values()].filter(r =>
    ACTIVE_STATUSES.includes(r.status),
  ).sort((a, b) => {
    // submitted_for_review first (oldest waiting), then in_review, then changes_requested
    const order = {
      pending_review: 99,
      submitted_for_review: 0,
      in_review: 1,
      changes_requested: 2,
      quick_fix: 3,
      approved: 4,
    } satisfies Record<ReviewRunStatus, number>;
    const diff = order[a.status] - order[b.status];
    if (diff !== 0) return diff;
    return new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime();
  });

  // Recently approved (last 5)
  const recentlyApproved = [...latestRunByProject.values()]
    .filter(r => r.status === 'approved')
    .sort((a, b) => new Date(b.reviewedAt ?? b.createdAt).getTime() - new Date(a.reviewedAt ?? a.createdAt).getTime())
    .slice(0, 5);

  const getProject = (projectId: string) => projects.find(p => p.id === projectId);

  const submittedCount   = activeRuns.filter(r => r.status === 'submitted_for_review').length;
  const inReviewCount    = activeRuns.filter(r => r.status === 'in_review').length;
  const changesCount     = activeRuns.filter(r => r.status === 'changes_requested').length;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Review Queue</h1>
        <p className="text-sm text-text-secondary mt-1">
          Proposals awaiting review before they advance to submittal or field handoff.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard icon={Clock} label="Submitted for Review" count={submittedCount} color="text-amber-600" bg="bg-amber-50 border-amber-200" />
        <StatCard icon={AlertCircle} label="In Review" count={inReviewCount} color="text-blue-600" bg="bg-blue-50 border-blue-200" />
        <StatCard icon={RefreshCw} label="Changes Requested" count={changesCount} color="text-red-600" bg="bg-red-50 border-red-200" />
      </div>

      {/* Active queue */}
      {activeRuns.length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center">
          <Inbox size={36} className="mx-auto mb-4 text-text-secondary" />
          <p className="font-medium text-text-primary">Queue is clear</p>
          <p className="text-sm text-text-secondary mt-1">
            No proposals are awaiting manager review. New reviews appear here when an engineer hits <strong>Send to Manager</strong> on a pre-review run.
          </p>
        </div>
      ) : (
        <div className="space-y-3 mb-10">
          {activeRuns.map(run => {
            const project = getProject(run.projectId);
            if (!project) return null;
            return (
              <RunCard
                key={run.id}
                run={run}
                projectName={project.name}
                projectNumber={project.number}
                onClick={() => navigate(`/projects/${run.projectId}/review`)}
              />
            );
          })}
        </div>
      )}

      {/* Recently approved */}
      {recentlyApproved.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-2">
            <CheckCircle2 size={14} className="text-green-600" /> Recently Approved
          </h2>
          <div className="space-y-1">
            {recentlyApproved.map(run => {
              const project = getProject(run.projectId);
              if (!project) return null;
              return (
                <button
                  key={run.id}
                  onClick={() => navigate(`/projects/${run.projectId}/review`)}
                  className="w-full text-left flex items-center justify-between px-4 py-2.5 bg-white border border-border rounded-lg hover:bg-surface text-sm transition-colors group"
                >
                  <span className="font-medium text-text-primary">{project.name}</span>
                  <div className="flex items-center gap-3 text-xs text-text-secondary">
                    <span>{project.number}</span>
                    <span>{run.reviewedAt ? new Date(run.reviewedAt).toLocaleDateString() : '—'}</span>
                    <ArrowRight size={13} className="group-hover:text-navy transition-colors" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, count, color, bg }: {
  icon: React.ElementType; label: string; count: number; color: string; bg: string;
}) {
  return (
    <div className={`border rounded-xl p-4 ${bg}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={color} />
        <span className="text-xs font-medium text-text-secondary">{label}</span>
      </div>
      <div className={`text-3xl font-bold ${color}`}>{count}</div>
    </div>
  );
}
