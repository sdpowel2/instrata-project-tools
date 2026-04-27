import type { Project } from '../types';

/** Small status dot showing whether a project is linked to a DTools project.
 *  Green = linked (BoM is synced or syncable). Red = not linked yet. */
export function DToolsSyncDot({ project, size = 8 }: { project: Pick<Project, 'dtoolsProjectId'>; size?: number }) {
  const linked = !!project.dtoolsProjectId;
  return (
    <span
      className="inline-block rounded-full flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: linked ? '#15803D' : '#DC2626',
        boxShadow: `0 0 0 2px ${linked ? 'rgba(21,128,61,0.15)' : 'rgba(220,38,38,0.15)'}`,
      }}
      title={linked ? 'Linked to DTools' : 'Not linked to DTools'}
      aria-label={linked ? 'Linked to DTools' : 'Not linked to DTools'}
    />
  );
}
