import { Sparkles } from 'lucide-react';
import type { ProjectPhase, ProjectStatus } from '../types';

export interface PipelineTileSpec {
  key: ProjectStatus;
  color: string;
  bg: string;
}

// Pre-sales bar: the buckets that matter for the sales pipeline. Off-pipeline
// states (On Hold / Declined to Bid / Rebid) deliberately omitted so the bar
// stays scannable — those projects are still visible in the table below.
export const PRE_SALES_TILES: PipelineTileSpec[] = [
  { key: 'Not Started', color: '#9CA3AF', bg: '#F3F4F6' },
  { key: 'In Progress', color: '#E07A1A', bg: 'rgba(246,141,46,0.12)' },
  { key: 'Review',      color: '#1D4ED8', bg: '#DBEAFE' },
  { key: 'Follow Up',   color: '#A16207', bg: '#FEF9C3' },
  { key: 'Won',         color: '#15803D', bg: '#DCFCE7' },
  { key: 'Lost',        color: '#B91C1C', bg: '#FEE2E2' },
];

// Post-sales bar: delivery pipeline. "Won" appears first because it's the
// landing state from Monday's pre-sales → post-sales duplication automation
// (≈ "just arrived, not yet started").
export const POST_SALES_TILES: PipelineTileSpec[] = [
  { key: 'Won',         color: '#15803D', bg: '#DCFCE7' },
  { key: 'Not Started', color: '#9CA3AF', bg: '#F3F4F6' },
  { key: 'In Progress', color: '#E07A1A', bg: 'rgba(246,141,46,0.12)' },
  { key: 'Install',     color: '#0072CE', bg: 'rgba(0,114,206,0.12)' },
  { key: 'Close Out',   color: '#22326E', bg: 'rgba(34,50,110,0.12)' },
  { key: 'Completed',   color: '#15803D', bg: '#DCFCE7' },
];

export function tilesForPhase(phase: ProjectPhase): PipelineTileSpec[] {
  return phase === 'Pre-Sales' ? PRE_SALES_TILES : POST_SALES_TILES;
}

interface PipelineBarProps {
  tiles: PipelineTileSpec[];
  counts: Map<ProjectStatus, number>;
  total: number;
  selected: 'All' | ProjectStatus;
  onSelect: (s: 'All' | ProjectStatus) => void;
  phaseView: ProjectPhase;
  onPhaseChange: (p: ProjectPhase) => void;
  /** Optional eyebrow label override (defaults to "{phase} pipeline"). */
  eyebrow?: string;
  /** Optional footer text override; pass null to hide the footer entirely. */
  footer?: React.ReactNode | null;
}

export function PipelineBar({
  tiles, counts, total, selected, onSelect, phaseView, onPhaseChange, eyebrow, footer,
}: PipelineBarProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm p-1">
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-fg-2">
          {eyebrow ?? `${phaseView} pipeline`}
        </div>
        <div className="flex items-center gap-1 p-0.5 bg-surface/60 rounded-md">
          {(['Pre-Sales', 'Post-Sales'] as const).map((p) => {
            const active = phaseView === p;
            return (
              <button
                key={p}
                onClick={() => onPhaseChange(p)}
                className={[
                  'px-2.5 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap',
                  active ? 'bg-white shadow-sm text-navy' : 'text-fg-2 hover:text-navy',
                ].join(' ')}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `minmax(140px,180px) repeat(${tiles.length}, 1fr)` }}
      >
        <PipelineTile
          active={selected === 'All'}
          onClick={() => onSelect('All')}
          accent="var(--color-navy)"
          accentBg="rgba(34,50,110,0.06)"
          label="All"
          value={total}
          tagline={`${phaseView.toLowerCase()} projects`}
          dotColor="var(--color-navy)"
        />
        {tiles.map((s) => {
          const count = counts.get(s.key) ?? 0;
          const pct = total ? Math.round((count / total) * 100) : 0;
          const active = selected === s.key;
          return (
            <PipelineTile
              key={s.key}
              active={active}
              onClick={() => onSelect(s.key)}
              accent={s.color}
              accentBg={s.bg}
              label={s.key}
              value={count}
              tagline={`${pct}% of pipeline`}
              dotColor={s.color}
              showBar
              barPct={pct}
            />
          );
        })}
      </div>
      {footer !== null && (
        <div className="flex items-center gap-2 px-3.5 pt-2 pb-1.5 mt-1 border-t border-border text-fg-2 text-[11px]">
          <Sparkles size={12} className="text-orange" />
          <span>
            {footer ?? (
              <>
                Live from <strong className="text-fg">Monday.com</strong> · click a status to filter the list below
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

interface PipelineTileProps {
  active: boolean;
  onClick: () => void;
  accent: string;
  accentBg: string;
  label: string;
  value: number;
  tagline: string;
  dotColor: string;
  showBar?: boolean;
  barPct?: number;
}

function PipelineTile({
  active, onClick, accent, accentBg, label, value, tagline, dotColor, showBar, barPct = 0,
}: PipelineTileProps) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-[9px] px-3.5 pt-3.5 pb-3 transition-all"
      style={{
        background: active ? accentBg : 'transparent',
        border: active ? `1px solid ${accent}` : '1px solid transparent',
        boxShadow: active ? `inset 0 -2px 0 ${accent}` : undefined,
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
        <div
          className="text-[11px] font-bold tracking-[0.08em] uppercase whitespace-nowrap"
          style={{ color: accent }}
        >
          {label}
        </div>
      </div>
      <div
        className="text-[26px] font-bold leading-none font-mono"
        style={{ color: active && label !== 'All' ? 'var(--color-fg)' : (label === 'All' ? 'var(--color-navy)' : 'var(--color-fg)') }}
      >
        {value}
      </div>
      {showBar ? (
        <>
          <div className="mt-2.5 h-[3px] rounded-sm overflow-hidden bg-black/[0.06]">
            <div className="h-full transition-[width]" style={{ width: `${barPct}%`, background: accent }} />
          </div>
          <div className="text-[11px] text-fg-2 mt-1.5">{tagline}</div>
        </>
      ) : (
        <div className="text-[11px] text-fg-2 mt-1">{tagline}</div>
      )}
    </button>
  );
}

/**
 * Build a status → count map for a slice of projects under a given phase.
 * Caller decides the slice (all projects, my projects, etc.) — keeping the
 * counter dumb keeps it reusable.
 */
export function buildPipelineCounts(
  projects: Array<{ phase: ProjectPhase; status: ProjectStatus }>,
  phase: ProjectPhase,
  tiles: PipelineTileSpec[],
): { counts: Map<ProjectStatus, number>; total: number } {
  const counts = new Map<ProjectStatus, number>();
  for (const t of tiles) counts.set(t.key, 0);
  let total = 0;
  for (const p of projects) {
    if (p.phase !== phase) continue;
    total += 1;
    if (counts.has(p.status)) {
      counts.set(p.status, counts.get(p.status)! + 1);
    }
  }
  return { counts, total };
}
