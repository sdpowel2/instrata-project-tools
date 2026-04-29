// Purchasing — Operations tool. Currently unwired and not referenced from
// App.tsx routes; kept for borrowing styling when this tool ships.
import { Truck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';

export function PurchasingPage() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  if (!project) return null;

  // Empty until purchase orders exist in the store.
  const counts = { Received: 0, 'In Transit': 0, Ordered: 0, Backordered: 0 };
  const total = 0;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />
      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Purchasing" toolIcon={Truck} />
      </div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-navy m-0">Purchasing</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">Purchase orders against the BOM, tracked through receipt.</p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-4 gap-3">
          <KpiCard label="Total committed" value={`$${total.toLocaleString()}`} mono accent="var(--color-navy)" />
          <KpiCard label="Received" value={counts.Received} accent="#15803D" />
          <KpiCard label="In transit" value={counts['In Transit']} accent="#E07A1A" />
          <KpiCard label="Backordered" value={counts.Backordered} accent="#B91C1C" />
        </div>
        <EmptyToolState
          title="No purchase orders yet"
          body="POs are generated against the project BOM once the equipment list is finalized."
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
        <Truck size={44} />
      </div>
      <div className="text-base font-semibold text-navy">{title}</div>
      <div className="text-[13px] text-fg-2 mt-1.5 max-w-[420px] mx-auto">{body}</div>
    </div>
  );
}
