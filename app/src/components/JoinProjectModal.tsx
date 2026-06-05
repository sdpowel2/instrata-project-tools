import { useState } from 'react';
import { UserPlus, Eye, Loader2, Lock } from 'lucide-react';
import { Modal } from './Modal';

interface JoinProjectModalProps {
  open: boolean;
  projectName: string;
  /** Add the current user to the project team, then continue to the tool. */
  onJoin: () => Promise<void> | void;
  /** Continue to the tool in read-only mode without joining. */
  onViewOnly: () => void;
  /** Dismiss without navigating anywhere (e.g. backdrop / X). */
  onClose: () => void;
}

/**
 * Shown when a non-member opens a project tool. Editing project data (BoM,
 * submittals, cutsheets, etc.) is gated to project-team members by RLS — a
 * non-member's writes silently fail. Rather than let that happen, we prompt
 * the user to either join the team (so their edits persist) or continue in
 * an explicit view-only mode to see what teammates have done.
 */
export function JoinProjectModal({ open, projectName, onJoin, onViewOnly, onClose }: JoinProjectModalProps) {
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    setJoining(true);
    try {
      await onJoin();
    } finally {
      setJoining(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Join this project to make changes">
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-navy/[0.06] text-navy flex items-center justify-center flex-shrink-0">
            <Lock size={20} />
          </div>
          <div className="text-sm text-text-secondary leading-relaxed">
            You're not on the team for{' '}
            <strong className="text-navy">{projectName}</strong>. You can keep viewing the project
            to see what the team has done, but <strong>your changes won't save</strong> until you
            join. Add yourself to the team to make changes.
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pt-1">
          <button
            onClick={handleJoin}
            disabled={joining}
            className="btn-primary text-sm justify-center disabled:opacity-60"
          >
            {joining ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
            {joining ? 'Adding you…' : 'Add me to this project'}
          </button>
          <button
            onClick={onViewOnly}
            disabled={joining}
            className="btn-secondary text-sm justify-center disabled:opacity-60"
          >
            <Eye size={15} /> No thanks — view only
          </button>
        </div>
      </div>
    </Modal>
  );
}
