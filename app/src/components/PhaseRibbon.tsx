// Phase ribbon — sits below ProjectHeader on every tool page to remind the
// user which phase the current tool belongs to.
import { type LucideIcon } from 'lucide-react';
import type { ProjectPhase } from '../types';

// UI-only section type. Operations technically lives under Post-Sales but
// surfaces as a parallel section in the sidebar / overview / ribbon so the
// schedule / purchasing / inventory tools have their own visual identity.
export type ProjectSection = ProjectPhase | 'Operations';

interface Props {
  phase: ProjectSection;
  toolLabel: string;
  toolIcon: LucideIcon;
}

const SECTION_ACCENT: Record<ProjectSection, { fg: string; bg: string }> = {
  'Pre-Sales':  { fg: '#0072CE', bg: 'rgba(0,114,206,0.08)' },
  'Post-Sales': { fg: '#E07A1A', bg: 'rgba(246,141,46,0.08)' },
  'Operations': { fg: '#22C55E', bg: 'rgba(34,197,94,0.08)' },
};

export function PhaseRibbon({ phase, toolLabel, toolIcon: Icon }: Props) {
  const { fg, bg } = SECTION_ACCENT[phase];
  const others = (Object.keys(SECTION_ACCENT) as ProjectSection[]).filter((k) => k !== phase);

  return (
    <div
      className="flex items-stretch rounded-[10px] overflow-hidden mb-6"
      style={{ background: bg, border: `1px solid ${fg}33` }}
    >
      <div className="w-1" style={{ background: fg }} />
      <div className="flex-1 px-4 py-3 flex items-center gap-3.5">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center text-white flex-shrink-0"
          style={{ background: fg }}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <div
              className="text-[10px] font-bold tracking-[0.15em] uppercase"
              style={{ color: fg }}
            >
              {phase} Tool
            </div>
            <span className="text-[10px] text-fg-2">·</span>
            <div className="text-[10px] font-semibold text-fg-2 tracking-[0.1em] uppercase">
              {toolLabel}
            </div>
          </div>
          <div className="text-[13px] text-fg-2 mt-0.5">
            You're working in the <strong style={{ color: fg }}>{phase}</strong> section.
            Other sections remain accessible in the sidebar.
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-fg-2 flex-shrink-0">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: fg }} />
            {phase}
          </span>
          {others.map((o) => (
            <span key={o} className="inline-flex items-center gap-1.5">
              <span className="opacity-40">/</span>
              <span className="inline-flex items-center gap-1 opacity-60">
                <span className="w-2 h-2 rounded-full" style={{ background: SECTION_ACCENT[o].fg }} />
                {o}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
