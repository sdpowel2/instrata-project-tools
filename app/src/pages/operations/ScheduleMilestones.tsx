// Schedule & Milestones — Operations tool. Currently unwired and not
// referenced from App.tsx routes; kept here so the page-level styling is
// available to copy from when this tool is built out for real.
import { Calendar, Check } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';

interface Milestone {
  id: string;
  label: string;
  owner: string;
  date: string;
  status: 'Complete' | 'In Progress' | 'Not Started';
}

export function ScheduleMilestonesPage() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  if (!project) return null;

  // Empty state until milestone data exists in the store.
  const milestones: Milestone[] = [];
  const completeIdx = milestones.reduce((acc, m, i) => (m.status === 'Complete' ? i : acc), -1);
  const total = milestones.length;
  const pct = total ? Math.round(((completeIdx + 1) / total) * 100) : 0;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />
      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Schedule & Milestones" toolIcon={Calendar} />
      </div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-navy m-0">Schedule &amp; Milestones</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">Project dates that drive purchasing and field deployment.</p>
        </div>
      </div>

      {milestones.length === 0 ? (
        <EmptyToolState
          icon={Calendar}
          title="No milestones yet"
          body="Add milestones to anchor purchasing and field deployment dates."
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="bg-white border border-border rounded-xl px-5.5 py-4.5 shadow-sm" style={{ paddingLeft: 22, paddingRight: 22 }}>
            <div className="flex items-center justify-between mb-2.5">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-2">Project Schedule</div>
                <div className="text-sm text-fg mt-1">
                  <strong style={{ color: '#15803D' }}>{completeIdx + 1}</strong> of {total} milestones complete
                </div>
              </div>
              <div className="text-2xl font-bold text-navy font-mono">{pct}%</div>
            </div>
            <div className="h-2 bg-gray-100 rounded overflow-hidden">
              <div
                className="h-full transition-[width]"
                style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #15803D 0%, #22C55E 100%)' }}
              />
            </div>
          </div>

          <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="px-5.5 py-3.5 border-b border-border text-[13px] font-semibold text-navy" style={{ paddingLeft: 22, paddingRight: 22 }}>
              Milestones
            </div>
            <div className="px-5.5 pt-2 pb-5.5" style={{ paddingLeft: 22, paddingRight: 22, paddingBottom: 22 }}>
              {milestones.map((m, i) => {
                const isLast = i === milestones.length - 1;
                const c = m.status === 'Complete' ? '#15803D' : m.status === 'In Progress' ? '#E07A1A' : '#9CA3AF';
                return (
                  <div key={m.id} className="flex gap-4.5 relative">
                    <div className="w-[18px] relative flex-shrink-0">
                      {!isLast && (
                        <div
                          className="absolute w-0.5"
                          style={{ top: 22, bottom: -4, left: 8, background: m.status === 'Complete' ? '#15803D' : '#E5E7EB' }}
                        />
                      )}
                      <div
                        className="absolute flex items-center justify-center"
                        style={{
                          top: 14,
                          left: 1,
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          background: m.status === 'Complete' ? c : '#fff',
                          border: `2px solid ${c}`,
                        }}
                      >
                        {m.status === 'Complete' && <Check size={9} className="text-white" strokeWidth={3} />}
                      </div>
                    </div>
                    <div
                      className="flex-1 py-3 flex items-center gap-3.5"
                      style={{ borderBottom: isLast ? 'none' : '1px solid var(--color-border)' }}
                    >
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-fg">{m.label}</div>
                        <div className="text-xs text-fg-2 mt-0.5">{m.owner}</div>
                      </div>
                      <div className="font-mono text-[13px] text-fg-2 w-[120px] text-right">{m.date}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyToolState({ icon: Icon, title, body }: { icon: typeof Calendar; title: string; body: string }) {
  return (
    <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm">
      <div className="text-border mb-3.5 flex justify-center">
        <Icon size={44} />
      </div>
      <div className="text-base font-semibold text-navy">{title}</div>
      <div className="text-[13px] text-fg-2 mt-1.5 max-w-[420px] mx-auto">{body}</div>
    </div>
  );
}
