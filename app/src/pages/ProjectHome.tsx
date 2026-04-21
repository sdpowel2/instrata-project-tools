import { useState } from 'react';
import { useParams, Outlet, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { ProjectMembersModal } from '../components/ProjectMembersModal';
import { ProjectSettingsModal } from '../components/ProjectSettingsModal';

/**
 * Outlet context exposed to every project tool page so they can trigger the
 * shared Settings / Team modals from their own action bars.
 */
export interface ProjectOutletContext {
  openSettings: () => void;
  openTeam: () => void;
}

export function ProjectHome() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  if (!project) {
    return (
      <div className="px-8 pt-7 pb-10 max-w-[1400px]">
        <div className="text-fg-2 text-sm">Project not found.</div>
        <button onClick={() => navigate('/projects')} className="btn-secondary mt-4">
          Back to projects
        </button>
      </div>
    );
  }

  const ctx: ProjectOutletContext = {
    openSettings: () => setSettingsModalOpen(true),
    openTeam: () => setTeamModalOpen(true),
  };

  return (
    <>
      <Outlet context={ctx} />

      <ProjectSettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        project={project}
      />

      <ProjectMembersModal
        open={teamModalOpen}
        onClose={() => setTeamModalOpen(false)}
        projectId={project.id}
        projectName={project.name}
      />
    </>
  );
}
