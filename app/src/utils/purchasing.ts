// Pure helpers for the Purchasing module — no React/store coupling so they
// can be unit-tested and reused from the list page summary.
import type {
  Submittal, SubmittalItem, PurchasingItem, PurchasingDisplayStatus,
  PurchasingManufacturerDefault, PurchasingFreight,
} from '../types';

/** Resolve the display status for one submittal item inside one purchasing
 *  module. Logic precedence:
 *    1. Linked submittal in Draft        → 'draft' (read-only)
 *    2. Item approval !== 'approved'     → 'pending_approval' (read-only)
 *    3. Persisted purchase_status        → maps to ordered / received
 *    4. Item approval reverted AFTER ordering → 'reverted_after_order' (warn) */
export function computePurchasingDisplayStatus(args: {
  submittal: Submittal | undefined;
  submittalItem: SubmittalItem | undefined;
  purchasingItem: PurchasingItem | undefined;
}): PurchasingDisplayStatus {
  const { submittal, submittalItem, purchasingItem } = args;
  const purchaseStatus = purchasingItem?.purchaseStatus ?? 'not_ordered';

  // 4 — reverted approval after an order was placed wins over draft / pending,
  // because it represents a real risk that needs the warning banner.
  const ordered = purchaseStatus === 'ordered' || purchaseStatus === 'received';
  if (ordered && submittalItem && submittalItem.approvalState !== 'approved') {
    return 'reverted_after_order';
  }

  // 1 — package draft locks everything down regardless of item state.
  if (submittal?.status === 'Draft') return 'draft';

  // 2 — package is Submitted/R&R and item not yet individually approved.
  if (submittalItem && (submittalItem.approvalState ?? 'pending') !== 'approved') {
    return 'pending_approval';
  }

  // 3 — approved & in flight.
  if (purchaseStatus === 'received') return 'received';
  if (purchaseStatus === 'ordered')  return 'ordered';
  return 'approved_to_order';
}

/** True when the purchaser fields (price, ship-to, need-by, status advance)
 *  should be editable. False for draft / pending approval rows. */
export function isPurchasingRowEditable(s: PurchasingDisplayStatus): boolean {
  return s !== 'draft' && s !== 'pending_approval';
}

/** Effective ship-to + need-by for a row — per-item overrides take precedence
 *  over the manufacturer default. Used by the detail view to render the
 *  inherited value greyed-out. */
export function effectiveShipTo(item: PurchasingItem | undefined, mfrDefault: PurchasingManufacturerDefault | undefined): { warehouseId?: string; customAddress?: string } {
  if (item?.shipToWarehouseId || item?.shipToCustomAddress) {
    return { warehouseId: item.shipToWarehouseId, customAddress: item.shipToCustomAddress };
  }
  if (mfrDefault?.shipToWarehouseId || mfrDefault?.shipToCustomAddress) {
    return { warehouseId: mfrDefault.shipToWarehouseId, customAddress: mfrDefault.shipToCustomAddress };
  }
  return {};
}

export function effectiveNeedBy(item: PurchasingItem | undefined, mfrDefault: PurchasingManufacturerDefault | undefined): string | undefined {
  if (item?.needByDate) return item.needByDate;
  return mfrDefault?.needByDate;
}

/** List-page summary card: count items by display state for the module. */
export interface PurchaseSummary {
  totalItems: number;
  notOrdered: number;     // approved + not yet ordered
  ordered: number;
  received: number;
  pendingApproval: number;
  draft: number;
  warningCount: number;   // reverted_after_order rows
}

export function computePurchaseSummary(
  moduleId: string,
  linkedSubmittals: Submittal[],
  allPurchasingItems: PurchasingItem[],
): PurchaseSummary {
  const itemsForModule = allPurchasingItems.filter((p) => p.purchasingModuleId === moduleId);
  const itemById = new Map(itemsForModule.map((p) => [p.submittalItemId, p]));

  const counts: PurchaseSummary = {
    totalItems: 0, notOrdered: 0, ordered: 0, received: 0,
    pendingApproval: 0, draft: 0, warningCount: 0,
  };

  for (const sub of linkedSubmittals) {
    for (const si of sub.items) {
      counts.totalItems++;
      const status = computePurchasingDisplayStatus({
        submittal: sub,
        submittalItem: si,
        purchasingItem: itemById.get(si.id),
      });
      switch (status) {
        case 'approved_to_order':    counts.notOrdered++; break;
        case 'ordered':              counts.ordered++; break;
        case 'received':             counts.received++; break;
        case 'pending_approval':     counts.pendingApproval++; break;
        case 'draft':                counts.draft++; break;
        case 'reverted_after_order': counts.warningCount++; break;
      }
    }
  }
  return counts;
}

/** Build the list of warning entries shown at the top of the detail page.
 *  Each warning describes one item that's been ordered through this module
 *  but whose submittal-side approval is no longer 'approved'. */
export interface PurchasingWarning {
  submittalItemId: string;
  manufacturer: string;
  model: string;
  qty: number;
  approvalState: string;
  purchaseStatus: string;
  poNumber?: string;
}

export function computePurchasingWarnings(
  moduleId: string,
  linkedSubmittals: Submittal[],
  allPurchasingItems: PurchasingItem[],
): PurchasingWarning[] {
  const warnings: PurchasingWarning[] = [];
  const itemsForModule = allPurchasingItems.filter((p) => p.purchasingModuleId === moduleId);
  const itemById = new Map(itemsForModule.map((p) => [p.submittalItemId, p]));

  for (const sub of linkedSubmittals) {
    for (const si of sub.items) {
      const pi = itemById.get(si.id);
      if (!pi) continue;
      const ordered = pi.purchaseStatus === 'ordered' || pi.purchaseStatus === 'received';
      if (ordered && (si.approvalState ?? 'pending') !== 'approved') {
        warnings.push({
          submittalItemId: si.id,
          manufacturer: si.manufacturer,
          model: si.model,
          qty: si.qty,
          approvalState: si.approvalState ?? 'pending',
          purchaseStatus: pi.purchaseStatus,
          poNumber: pi.poNumber,
        });
      }
    }
  }
  return warnings;
}

/** Group a list of submittal items by manufacturer for display. Items keep
 *  their original submittal reference so per-row writes still target the
 *  correct row. */
export interface ManufacturerGroup {
  manufacturer: string;
  rows: { submittal: Submittal; submittalItem: SubmittalItem }[];
}

export function groupBySubmittalItemsByManufacturer(linkedSubmittals: Submittal[]): ManufacturerGroup[] {
  const map = new Map<string, ManufacturerGroup>();
  for (const sub of linkedSubmittals) {
    for (const si of sub.items) {
      const mfr = (si.manufacturer || '—').trim();
      const group = map.get(mfr) ?? { manufacturer: mfr, rows: [] };
      group.rows.push({ submittal: sub, submittalItem: si });
      if (!map.has(mfr)) map.set(mfr, group);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.manufacturer.localeCompare(b.manufacturer));
}

/** Find the freight row for (module, manufacturer) — undefined if the
 *  purchaser hasn't entered freight data yet. */
export function findFreight(
  freightRows: PurchasingFreight[],
  moduleId: string,
  manufacturer: string,
): PurchasingFreight | undefined {
  return freightRows.find((f) => f.purchasingModuleId === moduleId && f.manufacturer === manufacturer);
}
