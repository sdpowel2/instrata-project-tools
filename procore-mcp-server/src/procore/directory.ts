/**
 * Per-user companies + projects directory (spec §5.3). Team members belong to
 * multiple GC company accounts, so we never hardcode a company id: we enumerate
 * the user's companies, list projects across all of them, and build a
 * project_id → company_id map. Project-scoped tools resolve the required
 * Procore-Company-Id header (and project_name/company_name for orientation)
 * through here without an extra round trip.
 *
 * Cached per instance with a short TTL. The client is per-user, so this cache is
 * per-user too.
 */
import type { ProcoreClient } from './client.js';
import { paginate } from './paginator.js';
import { ForbiddenError } from '../errors.js';
import type { Company, ProjectRef, RawCompany, RawProject } from './types.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_PROJECTS_PER_COMPANY = 1000;

type CompaniesSnapshot = { at: number; companies: Company[] };
type ProjectsSnapshot = {
  at: number;
  projects: ProjectRef[];
  projectCompany: Map<number, number>;
  skippedCompanies: string[];
};

function normalizeProject(raw: RawProject, company: Company): ProjectRef {
  return {
    project_id: raw.id,
    company_id: company.company_id,
    company_name: company.name,
    name: raw.display_name || raw.name,
    project_number: raw.project_number,
    stage: raw.stage_name ?? raw.phase,
    active: raw.active,
    address: raw.address,
    city: raw.city,
    state: raw.state_code,
  };
}

export class CompanyDirectory {
  private companiesSnapshot: CompaniesSnapshot | null = null;
  private projectsSnapshot: ProjectsSnapshot | null = null;

  constructor(private readonly client: ProcoreClient) {}

  /** Companies the user belongs to. Only hits /rest/v1.0/companies — never projects. */
  async companies(): Promise<Company[]> {
    if (this.companiesSnapshot && Date.now() - this.companiesSnapshot.at < TTL_MS) {
      return this.companiesSnapshot.companies;
    }
    const rawCompanies = await this.client.get<RawCompany[]>('/rest/v1.0/companies');
    const companies: Company[] = rawCompanies
      .filter((c) => c.is_active !== false)
      .map((c) => ({ company_id: c.id, name: c.name }));
    this.companiesSnapshot = { at: Date.now(), companies };
    return companies;
  }

  async projects(): Promise<ProjectRef[]> {
    return (await this.loadProjects()).projects;
  }

  /** Company names whose project listing 403'd and were skipped (for diagnostics). */
  async skippedCompanies(): Promise<string[]> {
    return (await this.loadProjects()).skippedCompanies;
  }

  /** The owning company id for a project, or undefined if not visible to the user. */
  async companyIdForProject(projectId: number): Promise<number | undefined> {
    return (await this.loadProjects()).projectCompany.get(projectId);
  }

  /** Full ref (name + company) for a project, or undefined. */
  async projectRef(projectId: number): Promise<ProjectRef | undefined> {
    return (await this.loadProjects()).projects.find((p) => p.project_id === projectId);
  }

  private async loadProjects(): Promise<ProjectsSnapshot> {
    if (this.projectsSnapshot && Date.now() - this.projectsSnapshot.at < TTL_MS) {
      return this.projectsSnapshot;
    }

    const companies = await this.companies();
    const projects: ProjectRef[] = [];
    const projectCompany = new Map<number, number>();
    const skippedCompanies: string[] = [];

    for (const company of companies) {
      let items: RawProject[];
      try {
        ({ items } = await paginate<RawProject>(
          this.client,
          '/rest/v1.0/projects',
          { companyId: company.company_id, query: { company_id: company.company_id } },
          MAX_PROJECTS_PER_COMPANY,
        ));
      } catch (err) {
        // A company the user can't list projects for shouldn't sink the others.
        if (err instanceof ForbiddenError) {
          const reason = (err as Error).message;
          skippedCompanies.push(`${company.name} — ${reason}`);
          console.warn(`[directory] skipped projects for company ${company.company_id} (${company.name}): ${reason}`);
          continue;
        }
        throw err;
      }
      for (const raw of items) {
        projects.push(normalizeProject(raw, company));
        projectCompany.set(raw.id, company.company_id);
      }
    }

    this.projectsSnapshot = { at: Date.now(), projects, projectCompany, skippedCompanies };
    return this.projectsSnapshot;
  }
}
