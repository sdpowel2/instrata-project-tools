// Purchasing module — detail page. Manufacturer-grouped list of submittal
// items with inline purchaser fields (purchase price, ship-to, need-by) and
// status advance. Each manufacturer carries a default ship-to + need-by that
// rows inherit unless overridden, and a persistent freight row.
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Truck, ArrowLeft, AlertTriangle, Plus, X,
  Package, Check, MapPin, CalendarDays,
} from 'lucide-react';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';
import { Modal } from '../../components/Modal';
import {
  computePurchasingDisplayStatus, computePurchasingWarnings,
  groupBySubmittalItemsByManufacturer, isPurchasingRowEditable,
  effectiveShipTo, effectiveNeedBy, findFreight,
} from '../../utils/purchasing';
import type {
  Submittal, SubmittalItem, PurchasingItem, PurchasingFreight,
  PurchasingManufacturerDefault, PurchaseStatus, PurchasingDisplayStatus, Warehouse,
} from '../../types';
import { formatWarehouseAddress } from '../../types';

const STATUS_BADGE: Record<PurchasingDisplayStatus, { bg: string; fg: string; label: string }> = {
  draft:                { bg: '#F3F4F6', fg: '#4B5563', label: 'Draft' },
  pending_approval:     { bg: '#FEF3C7', fg: '#A16207', label: 'Pending Approval' },
  approved_to_order:    { bg: '#DBEAFE', fg: '#1D4ED8', label: 'Approved to Order' },
  ordered:              { bg: 'rgba(0,114,206,0.12)', fg: '#0072CE', label: 'Ordered' },
  received:             { bg: '#DCFCE7', fg: '#15803D', label: 'Received' },
  reverted_after_order: { bg: '#FEE2E2', fg: '#B91C1C', label: '⚠ Approval Reverted' },
};

const PURCHASE_STATUS_OPTIONS: { value: PurchaseStatus; label: string }[] = [
  { value: 'not_ordered', label: 'Not Ordered' },
  { value: 'ordered',     label: 'Ordered' },
  { value: 'received',    label: 'Received' },
];

export function PurchasingDetailPage() {
  const { projectId, purchasingId } = useParams();
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const module = useStore((s) => s.purchasingModules.find((m) => m.id === purchasingId));
  const allSubmittals = useStore((s) => s.submittals);
  const purchasingItems = useStore((s) => s.purchasingItems);
  const purchasingFreight = useStore((s) => s.purchasingFreight);
  const mfrDefaults = useStore((s) => s.purchasingMfrDefaults);
  const warehouses = useStore((s) => s.warehouses);
  const projectBoM = useStore((s) => s.projectBoM);

  const upsertItem    = useStore((s) => s.upsertPurchasingItem);
  const upsertFreight = useStore((s) => s.upsertPurchasingFreight);
  const upsertDefault = useStore((s) => s.upsertMfrDefault);
  const linkSubmittal   = useStore((s) => s.linkSubmittalToPurchasingModule);
  const unlinkSubmittal = useStore((s) => s.unlinkSubmittalFromPurchasingModule);

  const linkedSubs = useMemo(
    () => (module?.submittalIds ?? []).map((id) => allSubmittals.find((s) => s.id === id)).filter(Boolean) as Submittal[],
    [module, allSubmittals],
  );

  const groups = useMemo(() => groupBySubmittalItemsByManufacturer(linkedSubs), [linkedSubs]);
  const warnings = useMemo(
    () => purchasingId ? computePurchasingWarnings(purchasingId, linkedSubs, purchasingItems) : [],
    [purchasingId, linkedSubs, purchasingItems],
  );

  // Vendor (priced_from) and sold-in price (unit_cost) live on
  // project_bom_items, not on submittal_items. Build a single lookup keyed
  // by manufacturer|model so both columns can resolve in O(1).
  //
  // The DTools sync can split one part into an owner-furnished ($0) row and
  // an Instrata-supplied row, and populate-from-BoM keeps those as separate
  // submittal items. Key on manufacturer|model|ofe so each submittal item
  // resolves to its own BoM row; the plain manufacturer|model key falls back
  // to the priced (non-OFE) row so older items never pick up the $0 copy.
  const bomLookup = useMemo(() => {
    const m = new Map<string, { pricedFrom?: string; unitCost?: number }>();
    for (const b of projectBoM) {
      if (b.projectId !== projectId) continue;
      const base = `${b.manufacturer.toLowerCase()}|||${b.model.toLowerCase()}`;
      const entry = { pricedFrom: b.pricedFrom, unitCost: b.unitCost };
      m.set(`${base}|||${b.ownerFurnished ? 'ofe' : 'std'}`, entry);
      if (!b.ownerFurnished || !m.has(base)) m.set(base, entry);
    }
    return m;
  }, [projectBoM, projectId]);

  const projectSubmittals = useMemo(
    () => allSubmittals.filter((s) => s.projectId === projectId),
    [allSubmittals, projectId],
  );

  const [showLinkModal, setShowLinkModal] = useState(false);

  if (!project || !module) return null;

  const handleLink = (submittalId: string) => {
    linkSubmittal(module.id, submittalId);
    setShowLinkModal(false);
  };

  const handleUnlink = (submittalId: string, title: string) => {
    if (window.confirm(`Unlink "${title}" from this purchasing module? Items from this submittal will be removed (purchaser data on those rows will be lost).`)) {
      unlinkSubmittal(module.id, submittalId);
    }
  };

  // Submittals that aren't already linked — eligible for the "+ Add" picker.
  const linkableSubmittals = projectSubmittals.filter((s) => !module.submittalIds.includes(s.id));

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1600px]">
      <ProjectHeader project={project} />
      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Purchasing" toolIcon={Truck} />
      </div>

      <button
        onClick={() => navigate(`/projects/${projectId}/purchasing`)}
        className="flex items-center gap-1 text-sm text-fg-2 hover:text-navy mb-4 transition-colors"
      >
        <ArrowLeft size={14} /> Back to Purchasing
      </button>

      <div className="flex items-end justify-between mb-5 gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-navy m-0 truncate">{module.title || 'Untitled Module'}</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">
            {linkedSubs.length === 0
              ? 'No submittals linked. Add at least one to populate items.'
              : `Linked to ${linkedSubs.length} submittal${linkedSubs.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        <button onClick={() => setShowLinkModal(true)} className="btn-secondary text-sm" disabled={linkableSubmittals.length === 0}>
          <Plus size={14} /> Add Submittal
        </button>
      </div>

      {/* Linked submittals chip row */}
      {linkedSubs.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {linkedSubs.map((s) => (
            <div
              key={s.id}
              className="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-full bg-white border border-border text-[12px]"
            >
              <span className="font-semibold text-navy">{s.title}</span>
              <span className="text-fg-2">·</span>
              <span className={`font-medium ${s.status === 'Approved' ? 'text-green-700' : s.status === 'Draft' ? 'text-fg-2' : s.status === 'Revise & Resubmit' ? 'text-amber-700' : 'text-blue-700'}`}>
                {s.status}
              </span>
              <button
                onClick={() => handleUnlink(s.id, s.title)}
                className="p-0.5 rounded text-fg-2 hover:bg-red-50 hover:text-red-600"
                title="Unlink"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Warning banners — surfaces approval reverts on already-ordered items */}
      {warnings.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-red-800">
                {warnings.length} item{warnings.length === 1 ? '' : 's'} ordered but no longer approved on the submittal
              </div>
              <ul className="mt-2 space-y-1 text-xs text-red-800">
                {warnings.map((w) => (
                  <li key={w.submittalItemId}>
                    <strong className="font-mono">{w.manufacturer} {w.model}</strong> — qty {w.qty} ·
                    purchase status: {w.purchaseStatus} · approval reverted to {w.approvalState}
                    {w.poNumber && <> · PO {w.poNumber}</>}
                  </li>
                ))}
              </ul>
              <div className="text-xs text-red-700 mt-2">
                Re-approve on the submittal page or coordinate with the vendor before the order ships.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      {groups.length === 0 ? (
        <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm">
          <div className="text-border mb-3.5 flex justify-center">
            <Package size={44} />
          </div>
          <div className="text-base font-semibold text-navy">No items to purchase yet</div>
          <div className="text-[13px] text-fg-2 mt-1.5 max-w-[460px] mx-auto">
            {linkedSubs.length === 0
              ? 'Add a submittal to bring items into this purchasing module.'
              : 'The linked submittal(s) don\u2019t have any items yet.'}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <ManufacturerSection
              key={g.manufacturer}
              moduleId={module.id}
              manufacturer={g.manufacturer}
              rows={g.rows}
              warehouses={warehouses}
              purchasingItems={purchasingItems}
              freight={findFreight(purchasingFreight, module.id, g.manufacturer)}
              mfrDefault={mfrDefaults.find((d) => d.purchasingModuleId === module.id && d.manufacturer === g.manufacturer)}
              bomLookup={bomLookup}
              upsertItem={upsertItem}
              upsertFreight={upsertFreight}
              upsertDefault={upsertDefault}
            />
          ))}
        </div>
      )}

      {/* Link submittal modal */}
      <Modal open={showLinkModal} onClose={() => setShowLinkModal(false)} title="Link Submittal">
        {linkableSubmittals.length === 0 ? (
          <p className="text-sm text-fg-2">All of this project\u2019s submittals are already linked.</p>
        ) : (
          <div className="space-y-2">
            {linkableSubmittals.map((s) => (
              <button
                key={s.id}
                onClick={() => handleLink(s.id)}
                className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border bg-white hover:bg-surface/50"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-navy truncate">{s.title}</div>
                  <div className="text-xs text-fg-2 mt-0.5">{s.revision} · {s.items.length} items · {s.status}</div>
                </div>
                <Plus size={14} className="text-fg-2" />
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

// =============================================================================
// ManufacturerSection — header + items table + freight row + defaults
// =============================================================================

interface ManufacturerSectionProps {
  moduleId: string;
  manufacturer: string;
  rows: { submittal: Submittal; submittalItem: SubmittalItem }[];
  warehouses: Warehouse[];
  purchasingItems: PurchasingItem[];
  freight: PurchasingFreight | undefined;
  mfrDefault: PurchasingManufacturerDefault | undefined;
  bomLookup: Map<string, { pricedFrom?: string; unitCost?: number }>;
  upsertItem:    (input: { purchasingModuleId: string; submittalItemId: string; updates: Partial<PurchasingItem> }) => void;
  upsertFreight: (input: { purchasingModuleId: string; manufacturer: string; updates: Partial<PurchasingFreight> }) => void;
  upsertDefault: (input: { purchasingModuleId: string; manufacturer: string; updates: Partial<PurchasingManufacturerDefault> }) => void;
}

function ManufacturerSection({
  moduleId, manufacturer, rows, warehouses, purchasingItems, freight, mfrDefault,
  bomLookup, upsertItem, upsertFreight, upsertDefault,
}: ManufacturerSectionProps) {
  const activeWarehouses = warehouses.filter((w) => w.isActive);
  const itemsForModule = purchasingItems.filter((p) => p.purchasingModuleId === moduleId);
  const itemBySubmittalItemId = new Map(itemsForModule.map((p) => [p.submittalItemId, p]));

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-4 flex-wrap"
        style={{ background: '#22C55E08' }}
      >
        <div>
          <div className="text-[10px] font-bold tracking-[0.15em] uppercase text-fg-2">Manufacturer</div>
          <div className="text-base font-semibold text-navy mt-0.5">{manufacturer}</div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <DefaultShipToPicker
            warehouses={activeWarehouses}
            value={{ warehouseId: mfrDefault?.shipToWarehouseId, customAddress: mfrDefault?.shipToCustomAddress }}
            onChange={(v) => upsertDefault({
              purchasingModuleId: moduleId, manufacturer,
              updates: { shipToWarehouseId: v.warehouseId, shipToCustomAddress: v.customAddress },
            })}
          />
          <DateField
            label="Default Need-By"
            value={mfrDefault?.needByDate}
            onChange={(v) => upsertDefault({
              purchasingModuleId: moduleId, manufacturer,
              updates: { needByDate: v },
            })}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full" style={{ minWidth: 1200 }}>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-fg-2 bg-surface/40">
              <th className="px-4 py-2.5 font-semibold w-[150px]">Status</th>
              <th className="px-3 py-2.5 font-semibold">Model</th>
              <th className="px-3 py-2.5 font-semibold">Description</th>
              <th className="px-3 py-2.5 font-semibold w-[60px] text-right">Qty</th>
              <th className="px-3 py-2.5 font-semibold w-[110px] text-right">Sold-In Price</th>
              <th className="px-3 py-2.5 font-semibold w-[160px]">Vendor</th>
              <th className="px-3 py-2.5 font-semibold w-[120px] text-right">Purchase Price</th>
              <th className="px-3 py-2.5 font-semibold w-[200px]">Ship To</th>
              <th className="px-3 py-2.5 font-semibold w-[130px]">Need By</th>
              <th className="px-3 py-2.5 font-semibold w-[130px]">PO #</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ submittal, submittalItem }) => {
              const pi = itemBySubmittalItemId.get(submittalItem.id);
              const status = computePurchasingDisplayStatus({ submittal, submittalItem, purchasingItem: pi });
              const editable = isPurchasingRowEditable(status);
              const bomBaseKey = `${submittalItem.manufacturer.toLowerCase()}|||${submittalItem.model.toLowerCase()}`;
              const bomMatch = bomLookup.get(`${bomBaseKey}|||${submittalItem.ownerFurnished ? 'ofe' : 'std'}`)
                ?? bomLookup.get(bomBaseKey);
              const vendor = bomMatch?.pricedFrom;
              const soldIn = bomMatch?.unitCost;
              const ship = effectiveShipTo(pi, mfrDefault);
              const needBy = effectiveNeedBy(pi, mfrDefault);
              const inheritShip = !pi?.shipToWarehouseId && !pi?.shipToCustomAddress;
              const inheritNeedBy = !pi?.needByDate;

              return (
                <tr key={submittalItem.id} className="hover:bg-surface/40">
                  <td className="px-4 py-2.5">
                    <PurchaseStatusCell
                      status={status}
                      editable={editable}
                      currentPurchaseStatus={pi?.purchaseStatus ?? 'not_ordered'}
                      onAdvance={(next) => upsertItem({
                        purchasingModuleId: moduleId,
                        submittalItemId: submittalItem.id,
                        updates: {
                          purchaseStatus: next,
                          orderedDate: next === 'ordered'  ? today() : pi?.orderedDate,
                          receivedDate: next === 'received' ? today() : pi?.receivedDate,
                        },
                      })}
                    />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[13px] text-fg">{submittalItem.model}</td>
                  <td className="px-3 py-2.5 text-sm text-fg-2 max-w-[300px] truncate" title={submittalItem.description}>
                    {submittalItem.description}
                  </td>
                  <td className="px-3 py-2.5 text-sm text-fg text-right font-medium">{submittalItem.qty}</td>
                  <td className="px-3 py-2.5 text-sm text-fg-2 text-right font-mono">
                    {fmtCurrency(soldIn)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-fg-2 truncate" title={vendor || ''}>
                    {vendor || <span className="text-fg-2/50">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <CurrencyInput
                      value={pi?.purchaseUnitPrice}
                      disabled={!editable}
                      onSave={(v) => upsertItem({
                        purchasingModuleId: moduleId,
                        submittalItemId: submittalItem.id,
                        updates: { purchaseUnitPrice: v },
                      })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <ShipToPicker
                      warehouses={activeWarehouses}
                      value={ship}
                      inherited={inheritShip}
                      disabled={!editable}
                      onChange={(v) => upsertItem({
                        purchasingModuleId: moduleId,
                        submittalItemId: submittalItem.id,
                        updates: { shipToWarehouseId: v.warehouseId, shipToCustomAddress: v.customAddress },
                      })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <DateField
                      value={needBy}
                      inherited={inheritNeedBy}
                      disabled={!editable}
                      onChange={(v) => upsertItem({
                        purchasingModuleId: moduleId,
                        submittalItemId: submittalItem.id,
                        updates: { needByDate: v },
                      })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="text"
                      defaultValue={pi?.poNumber ?? ''}
                      disabled={!editable}
                      onBlur={(e) => {
                        const next = e.currentTarget.value.trim() || undefined;
                        if ((pi?.poNumber ?? undefined) === next) return;
                        upsertItem({
                          purchasingModuleId: moduleId,
                          submittalItemId: submittalItem.id,
                          updates: { poNumber: next },
                        });
                      }}
                      placeholder="—"
                      className="input text-sm py-1 disabled:bg-surface/30 disabled:text-fg-2"
                    />
                  </td>
                </tr>
              );
            })}

            {/* Persistent freight row */}
            <tr className="bg-amber-50/40">
              <td className="px-4 py-2.5">
                <PurchaseStatusCell
                  status={freight?.purchaseStatus === 'received' ? 'received' : freight?.purchaseStatus === 'ordered' ? 'ordered' : 'approved_to_order'}
                  editable={true}
                  currentPurchaseStatus={freight?.purchaseStatus ?? 'not_ordered'}
                  onAdvance={(next) => upsertFreight({
                    purchasingModuleId: moduleId, manufacturer,
                    updates: {
                      purchaseStatus: next,
                      orderedDate: next === 'ordered'  ? today() : freight?.orderedDate,
                      receivedDate: next === 'received' ? today() : freight?.receivedDate,
                    },
                  })}
                />
              </td>
              <td className="px-3 py-2.5 font-mono text-[13px] text-amber-800">FREIGHT</td>
              <td className="px-3 py-2.5 text-sm text-fg-2 italic">Inbound freight charge — entered when the PO is placed</td>
              <td className="px-3 py-2.5 text-sm text-fg-2 text-right">—</td>
              <td className="px-3 py-2.5 text-sm text-fg-2 text-right">—</td>
              <td className="px-3 py-2.5 text-xs text-fg-2">—</td>
              <td className="px-3 py-2.5">
                <CurrencyInput
                  value={freight?.purchaseUnitPrice}
                  onSave={(v) => upsertFreight({
                    purchasingModuleId: moduleId, manufacturer,
                    updates: { purchaseUnitPrice: v },
                  })}
                />
              </td>
              <td className="px-3 py-2.5">
                <ShipToPicker
                  warehouses={activeWarehouses}
                  value={{ warehouseId: freight?.shipToWarehouseId, customAddress: freight?.shipToCustomAddress }}
                  inherited={false}
                  onChange={(v) => upsertFreight({
                    purchasingModuleId: moduleId, manufacturer,
                    updates: { shipToWarehouseId: v.warehouseId, shipToCustomAddress: v.customAddress },
                  })}
                />
              </td>
              <td className="px-3 py-2.5">
                <DateField
                  value={freight?.needByDate}
                  onChange={(v) => upsertFreight({
                    purchasingModuleId: moduleId, manufacturer,
                    updates: { needByDate: v },
                  })}
                />
              </td>
              <td className="px-3 py-2.5">
                <input
                  type="text"
                  defaultValue={freight?.poNumber ?? ''}
                  onBlur={(e) => {
                    const next = e.currentTarget.value.trim() || undefined;
                    if ((freight?.poNumber ?? undefined) === next) return;
                    upsertFreight({
                      purchasingModuleId: moduleId, manufacturer,
                      updates: { poNumber: next },
                    });
                  }}
                  placeholder="—"
                  className="input text-sm py-1"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Inline cell components
// =============================================================================

function PurchaseStatusCell({
  status, editable, currentPurchaseStatus, onAdvance,
}: {
  status: PurchasingDisplayStatus;
  editable: boolean;
  currentPurchaseStatus: PurchaseStatus;
  onAdvance: (next: PurchaseStatus) => void;
}) {
  const s = STATUS_BADGE[status];
  if (!editable) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
        style={{ background: s.bg, color: s.fg }}
      >
        {status === 'received' && <Check size={11} />}
        {s.label}
      </span>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5">
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
        style={{ background: s.bg, color: s.fg }}
      >
        {s.label}
      </span>
      <select
        value={currentPurchaseStatus}
        onChange={(e) => onAdvance(e.target.value as PurchaseStatus)}
        className="text-[11px] px-1 py-0.5 rounded border border-border bg-white text-fg-2 hover:border-navy"
        title="Change purchase status"
      >
        {PURCHASE_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function CurrencyInput({
  value, disabled, onSave,
}: {
  value: number | undefined;
  disabled?: boolean;
  onSave: (next: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      step="0.01"
      min={0}
      defaultValue={value !== undefined ? String(value) : ''}
      disabled={disabled}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        const next = raw === '' ? undefined : Number(raw);
        if (Number.isNaN(next as number)) return;
        if ((value ?? undefined) === next) return;
        onSave(next);
      }}
      placeholder="—"
      className="input text-sm py-1 text-right font-mono disabled:bg-surface/30 disabled:text-fg-2"
    />
  );
}

function DateField({
  label, value, inherited, disabled, onChange,
}: {
  label?: string;
  value?: string;
  inherited?: boolean;
  disabled?: boolean;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <label className="block">
      {label && (
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-2 inline-flex items-center gap-1">
          <CalendarDays size={10} /> {label}
        </span>
      )}
      <input
        type="date"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value || undefined;
          onChange(next);
        }}
        className={`input text-sm py-1 ${label ? 'mt-1' : ''} ${inherited ? 'text-fg-2/70' : ''} disabled:bg-surface/30 disabled:text-fg-2`}
      />
    </label>
  );
}

function ShipToPicker({
  warehouses, value, inherited, disabled, onChange,
}: {
  warehouses: Warehouse[];
  value: { warehouseId?: string; customAddress?: string };
  inherited?: boolean;
  disabled?: boolean;
  onChange: (next: { warehouseId?: string; customAddress?: string }) => void;
}) {
  const isCustom = !!value.customAddress;
  const selected = value.warehouseId ?? (isCustom ? '__custom__' : '');
  return (
    <div className="flex flex-col gap-1">
      <select
        value={selected}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') onChange({ customAddress: value.customAddress ?? '' });
          else if (v === '')      onChange({});
          else                    onChange({ warehouseId: v });
        }}
        className={`input text-sm py-1 ${inherited ? 'text-fg-2/70 italic' : ''} disabled:bg-surface/30 disabled:text-fg-2`}
      >
        <option value="">— None —</option>
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
        <option value="__custom__">Custom address…</option>
      </select>
      {isCustom && !disabled && (
        <input
          type="text"
          defaultValue={value.customAddress ?? ''}
          onBlur={(e) => onChange({ customAddress: e.currentTarget.value })}
          placeholder="Street, City, State ZIP"
          className="input text-xs py-1"
        />
      )}
      {value.warehouseId && warehouses.find((w) => w.id === value.warehouseId) && (
        <div className="text-[10px] text-fg-2 truncate">
          <MapPin size={9} className="inline mr-0.5" />
          {formatWarehouseAddress(warehouses.find((w) => w.id === value.warehouseId)!) || '—'}
        </div>
      )}
    </div>
  );
}

function DefaultShipToPicker({
  warehouses, value, onChange,
}: {
  warehouses: Warehouse[];
  value: { warehouseId?: string; customAddress?: string };
  onChange: (next: { warehouseId?: string; customAddress?: string }) => void;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-2 inline-flex items-center gap-1 mb-1">
        <MapPin size={10} /> Default Ship-To
      </div>
      <ShipToPicker warehouses={warehouses} value={value} onChange={onChange} />
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function fmtCurrency(v: number | undefined): string {
  if (v === undefined || v === null) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
