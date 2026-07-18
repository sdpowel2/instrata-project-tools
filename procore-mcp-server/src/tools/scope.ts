/**
 * Resolves a project_id to its owning company + orientation fields (project_name,
 * company_name) via the per-user directory. Project-scoped tools call this to get
 * the Procore-Company-Id they must send and to stamp every response for context.
 */
import type { AppContext } from '../context.js';
import type { ProjectRef } from '../procore/types.js';
import { NotFoundError } from '../errors.js';

export async function resolveProject(ctx: AppContext, projectId: number): Promise<ProjectRef> {
  const ref = await ctx.directory.projectRef(projectId);
  if (!ref) throw new NotFoundError(`project ${projectId}`);
  return ref;
}

/** Standard orientation fields stamped on every project-scoped response (spec §6). */
export function orientation(ref: ProjectRef): { project_id: number; project_name: string; company_name: string } {
  return { project_id: ref.project_id, project_name: ref.name, company_name: ref.company_name };
}
