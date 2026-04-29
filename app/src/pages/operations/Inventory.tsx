// Inventory — Operations tool. Currently unwired and not referenced from
// App.tsx routes; kept for borrowing styling when this tool ships.
import { Package } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';

export function InventoryPage() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  if (!project) return null;

  // Empty until inventory data exists in the store.
  const counts = { 'On Hand': 0, 'In Transit': 0, Backordered: 0 };
  const totalUnits = 0;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />
      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Inventory" toolIcon={Package} />
      </div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-navy m-0">Inventory</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">Parts at the warehouse, in transit, or staged for the site.</p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-4 gap-3">
          <KpiCard label="Total units" value={totalUnits} mono accent="var(--color-navy)" />
          <KpiCard label="On hand" value={counts['On Hand']} accent="#15803D" />
          <KpiCard label="In transit" value={counts['In Transit']} accent="#E07A1A" />
          <KpiCard label="Backordered" value={counts.Backordered} accent="#B91C1C" />
        </div>
        <EmptyToolState
          title="No inventory tracked"
          body="Inventory rows appear once equipment is received against a purchase order."
        />
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent = 'var(--color-navy)',
  mono = false,
}: {
  label: string;
  value: number | string;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-white border border-border rounded-[10px] px-4 py-3.5 shadow-sm">
      <div className="text-[11px] font-semibold text-fg-2 uppercase tracking-[0.1em]">{label}</div>
      <div
        className="mt-1.5 text-[22px] font-bold"
        style={{ color: accent, fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyToolState({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm">
      <div className="text-border mb-3.5 flex justify-center">
        <Package size={44} />
      </div>
      <div className="text-base font-semibold text-navy">{title}</div>
      <div className="text-[13px] text-fg-2 mt-1.5 max-w-[420px] mx-auto">{body}</div>
    </div>
  );
}
