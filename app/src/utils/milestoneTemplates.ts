// Milestone templates — admin-configurable in the spec, hard-coded here for
// Phase 1. Generates a default Commercial AV checkpoint set anchored off a
// project_start_date. All template dates are editable after generation —
// the template is a starting point, not a commitment.
import type { ProjectMilestone, MilestoneType, MilestoneTier } from '../types';

interface TemplateEntry {
  type: MilestoneType;
  title: string;
  tier: MilestoneTier;
  /** Days from project_start_date. */
  offsetDays: number;
  description?: string;
}

export const COMMERCIAL_AV_TEMPLATE: TemplateEntry[] = [
  { type: 'submittal_due',                title: 'Submittal package due',          tier: 'project', offsetDays: 14 },
  { type: 'submittal_approval_expected',  title: 'Submittal approval expected',    tier: 'project', offsetDays: 35 },
  { type: 'material_order_deadline',      title: 'Material order deadline',        tier: 'project', offsetDays: 42, description: 'Adjust based on longest lead time on the BoM.' },
  { type: 'bench_staging_complete',       title: 'Bench staging complete',         tier: 'phase',   offsetDays: 60 },
  { type: 'rough_in_complete',            title: 'Rough-in complete',              tier: 'phase',   offsetDays: 75 },
  { type: 'rack_install_complete',        title: 'Rack install complete',          tier: 'phase',   offsetDays: 90 },
  { type: 'programming_complete',         title: 'Programming complete',           tier: 'phase',   offsetDays: 100 },
  { type: 'commissioning_complete',       title: 'Commissioning complete',         tier: 'phase',   offsetDays: 110 },
  { type: 'punchlist_issued',             title: 'Punch list issued',              tier: 'phase',   offsetDays: 112 },
  { type: 'substantial_completion',       title: 'Substantial completion',         tier: 'project', offsetDays: 120 },
  { type: 'closeout_package_due',         title: 'Closeout package due',           tier: 'project', offsetDays: 135 },
  { type: 'final_completion',             title: 'Final completion',               tier: 'project', offsetDays: 150 },
];

/** Materialize the template into a list of milestones ready for insert.
 *  `startDate` is the anchor (project_start_date); offsets are added to it. */
export function generateFromTemplate(
  projectId: string,
  startDate: string,
  template: TemplateEntry[] = COMMERCIAL_AV_TEMPLATE,
): Omit<ProjectMilestone, 'id' | 'createdAt' | 'updatedAt'>[] {
  const start = new Date(startDate + 'T00:00:00');
  return template.map((t) => {
    const due = new Date(start);
    due.setDate(due.getDate() + t.offsetDays);
    return {
      projectId,
      title: t.title,
      description: t.description ?? '',
      milestoneType: t.type,
      tier: t.tier,
      phase: t.tier === 'phase' ? 'all' : undefined,
      dueDate: due.toISOString().slice(0, 10),
      notes: '',
    };
  });
}
