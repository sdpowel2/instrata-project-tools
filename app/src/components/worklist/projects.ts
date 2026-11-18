// Project lookup helpers for Connect project (My Day 2.4).

import type { Project } from '../../types';

/** INST-2026-0123, else the project number. */
export function projectCode(p: Pick<Project, 'projectCode' | 'number'>): string {
  return p.projectCode || p.number || 'Project';
}

export function shortName(name: string, max = 30): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

/** All words must appear in the name, number, client or code. Exact code/number hits first. */
export function searchProjects(projects: Project[], query: string, limit = 8): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits = projects.filter((p) => {
    const hay = `${p.name} ${p.number} ${p.client} ${p.projectCode ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const exact = (p: Project) => (p.projectCode?.toLowerCase() === q || p.number.toLowerCase() === q ? 0 : 1);
  return hits
    .sort((a, b) => exact(a) - exact(b) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
