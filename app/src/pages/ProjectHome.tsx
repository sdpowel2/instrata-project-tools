import { useEffect, useState } from 'react';
import { useParams, Outlet, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { isSupabaseConfigured } from '../lib/supabase';
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
  // A project's detail tables (BoM, submittal items, closeout, purchasing, …)
  // load the first time it is opened, not at sign-in; its pages wait for them.
  const loaded = useStore((s) => !isSupabaseConfigured() || (!!projectId && s.loadedProjectIds.has(projectId)));
  const ensureProjectLoaded = useStore((s) => s.ensureProjectLoaded);
  const [failed, setFailed] = useState<{ projectId: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  const exists = !!project;
  useEffect(() => {
    if (!projectId || !exists) return;
    let cancelled = false;
    ensureProjectLoaded(projectId).catch((e: unknown) => {
      if (!cancelled) setFailed({ projectId, message: e instanceof Error ? e.message : String(e) });
    });
    return () => { cancelled = true; };
  }, [projectId, exists, ensureProjectLoaded, attempt]);

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

  if (!loaded) {
    const loadError = failed && failed.projectId === projectId ? failed.message : null;
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        {loadError ? (
          <>
            <p className="text-sm text-fg-2">Couldn't load this project ({loadError}).</p>
            <button onClick={() => { setFailed(null); setAttempt((n) => n + 1); }} className="btn-secondary">Try again</button>
          </>
        ) : (
          <>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange" />
            <p className="text-sm text-gray-500">Loading project…</p>
          </>
        )}
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
