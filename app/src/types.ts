// Union of every status value that can appear on either Monday board, kept in
// sync with Monday so we never reject an inbound webhook value. Pre-sales and
// post-sales boards share some statuses (Not Started, In Progress, Won) and
// each carries its own pipeline-specific values on top.
export type ProjectStatus =
  // Pre-sales pipeline
  | 'Not Started'
  | 'In Progress'
  | 'On Hold'
  | 'Review'
  | 'Follow Up'
  | 'Won'
  | 'Lost'
  | 'Declined to Bid'
  | 'Rebid'
  // Post-sales pipeline (Won shared from above)
  | 'Install'
  | 'Close Out'
  | 'Completed';

// Display order for the pre-sales pipeline bar.
export const PRE_SALES_STATUSES: ProjectStatus[] = [
  'Not Started', 'In Progress', 'Review', 'Follow Up', 'Won', 'Lost',
];

// Display order for the post-sales pipeline bar. "Won" is the duplicated
// landing state from pre-sales — kept first so it reads as "just arrived."
export const POST_SALES_STATUSES: ProjectStatus[] = [
  'Won', 'Not Started', 'In Progress', 'Install', 'Close Out', 'Completed',
];

export type ProjectPhase = 'Pre-Sales' | 'Post-Sales';

// ===================== AUTO REVIEWER =====================

export type ReviewRunStatus =
  | 'pending_review'        // engineer's private pre-review — not in manager queue
  | 'submitted_for_review'  // engineer escalated to manager — enters manager queue
  | 'in_review'             // manager actively reviewing
  | 'changes_requested'     // sent back to engineer for fixes
  | 'quick_fix'             // manager applied small fix themselves
  | 'approved';
export type ReviewFlagStatus = 'open' | 'resolved' | 'waived' | 'commented';
export type ReviewFlagSeverity = 'high' | 'moderate' | 'low';
export type ReviewFlagCategory = 'margin' | 'pricing' | 'labor' | 'data' | 'catalog' | 'project';
export type ReviewDiffStatus = 'new' | 'recurring' | 'resolved';

export interface ReviewRun {
  id: string;
  projectId: string;
  runNumber: number;
  triggeredAt: string;
  status: ReviewRunStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  flagCounts?: { high: number; moderate: number; low: number; open: number };
}

export interface ReviewFlag {
  id: string;
  reviewRunId: string;
  ruleId: string;
  severity: ReviewFlagSeverity;
  category: ReviewFlagCategory;
  flagName: string;
  description: string;
  lineItemRef?: string;
  status: ReviewFlagStatus;
  managerComment?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  diffStatus?: ReviewDiffStatus;
  createdAt: string;
}

export interface ReviewConfigEntry {
  key: string;
  value: string;
  label: string;
  dataType: 'number' | 'percent' | 'days' | 'text' | 'list';
}

export interface LaborRate {
  id: string;
  laborType: string;
  ratePerHour: number;
  costPerHour: number;
  pricePerHour: number;
  hoursCeiling?: number;
  isActive: boolean;
  updatedAt: string;
}

export interface ProductCatalogItem {
  id: string;
  manufacturer: string;
  modelNumber: string;
  description: string;
  listPrice?: number;
  cost?: number;
  unitOfMeasure: string;
  category: string;
  priceDate?: string;
  lastUpdated?: string;
  createdAt: string;

  // D-Tools extended fields
  subcategory?: string;
  phase?: string;
  partNumber?: string;
  systemName?: string;
  productUrl?: string;
  shortDescription?: string;
  longDescription?: string;
  tags?: string;
  accountingItemName?: string;
  laborTypes?: string;
  unitLaborHours?: number;
  unitPrice?: number;
  margin?: number;
  markup?: number;
  mapPrice?: number;
  purchaseCost?: number;
  partnerSetCost?: boolean;
  uomForPartnerCost?: string;
  preferredVendor?: string;
  alternateVendors?: string;
  pricedFrom?: string;
  partnerUpdatedOn?: string;
  heightInches?: number;
  widthInches?: number;
  depthInches?: number;
  weightLbs?: number;
  rackMounted?: boolean;
  rackUnits?: number;
  amps?: number;
  volts?: number;
  watts?: number;
  btu?: number;
  poe?: boolean;
  poeClass?: string;
  orderUom?: string;
  doNotOrder?: boolean;
  bulkItem?: boolean;
  includeInSubmittal?: boolean;
  includeInServicePlan?: boolean;
  ownerFurnished?: boolean;
  taxable?: boolean;
  discontinued?: boolean;
  approved?: boolean;
  taaCompliant?: boolean;
  bulkWire?: boolean;
  hasThumbnail?: boolean;
  hasFiles?: boolean;
  dtoolsCreatedOn?: string;
  dtoolsCreatedBy?: string;
  dtoolsUpdatedOn?: string;
  dtoolsUpdatedBy?: string;
  lastSyncedAt?: string;
}
export type ProjectBusinessUnit = 'Instrata SE' | 'Instrata SW' | 'Instrata NE' | 'Instrata MA';
export type SubmittalStatus = 'Draft' | 'Submitted' | 'Approved' | 'Revise & Resubmit';
export type RFIStatus = 'Open' | 'Answered' | 'Closed' | 'Void';
export type PunchStatus = 'Open' | 'In Progress' | 'Complete' | 'N/A';
export type PunchPriority = 'Critical' | 'Standard';
export type CloseoutStatus = 'Draft' | 'In Progress' | 'Complete';
export type ItemCategory = 'Display' | 'Audio' | 'Control' | 'Networking' | 'Cabling' | 'Other';
export type ManualSectionType = 'System Overview' | 'System Section' | 'Device Registry' | 'Support Contacts' | 'Emergency Procedures';
export type SignOffStatus = 'Pending' | 'Passed' | 'Failed' | 'N/A';

export type DToolsBomStatus = '' | 'found' | 'not_found' | 'error' | 'loading';

// ===================== CHANGE ORDERS =====================

/** DTools change-order status. Pending values are tracked but excluded from
 *  the contract total; Approved values modify it; Rejected values are kept
 *  for the audit trail. */
export type ChangeOrderStatus = 'Pending' | 'Approved' | 'Rejected';

/** DTools categorizes COs as either Internal (e.g. estimating cleanup,
 *  scope clarifications absorbed by Instrata) or External (client-facing,
 *  contract-modifying). Both kinds adjust the bottom line — the flag is
 *  surfaced so PMs can see at a glance which side of the deal owns it. */
export type ChangeOrderCategory = 'Internal' | 'External';

/** A read-only change order pulled from DTools alongside the BoM. We never
 *  edit these locally — the next sync overwrites them. */
export interface ProjectChangeOrder {
  id: string;
  projectId: string;
  /** DTools-issued CO number, e.g. "COR-001". */
  number: string;
  title: string;
  description: string;
  /** Signed dollar delta to the contract. Positive for adds, negative for
   *  credits. Pending values are still recorded — they just don't roll into
   *  the current contract total until Approved. */
  amount: number;
  status: ChangeOrderStatus;
  category: ChangeOrderCategory;
  /** ISO date (YYYY-MM-DD). */
  requestedAt: string;
  /** ISO date the CO was Approved or Rejected; null while Pending. */
  resolvedAt?: string;
  /** DTools internal id for cross-referencing. Display-only. */
  dToolsId: string;
  /** CO net cost delta from the published CO payload (signed). */
  cost?: number;
  /** Tax portion of `amount`. Line items are pre-tax: Σ lines + tax = amount. */
  tax?: number;
  /** Net signed raw labor hours in the CO. */
  laborHours?: number;
  /** True when our priced lines reconcile with the CO's own root totals. */
  dtoolsVerified?: boolean;
  /** Signed line-item deltas — present once the CO payload has been
   *  published to the API integration and synced. */
  items?: ChangeOrderItem[];
}

/** One signed delta line inside a published DTools change order. Removed
 *  lines carry DTools' own NEGATED unit prices/hours with positive qty. */
export interface ChangeOrderItem {
  id: string;
  changeType: 'Added' | 'Removed' | 'Adjusted' | 'Other';
  manufacturer: string;
  model: string;
  description: string;
  qty: number;
  unitCost: number;
  unitPrice: number;
  /** 'Labor' for located labor items and phase residuals — their dollars
   *  display in the Labor column even when carried in unitPrice. */
  itemType: 'Product' | 'Labor';
  /** Room name from the CO payload's own location map; '' when the row has
   *  no location (residual labor lines). */
  location: string;
  laborHours: number;
  laborCost: number;
  laborPrice: number;
}

export interface Project {
  id: string;
  name: string;
  number: string;
  client: string;
  address: string;
  businessUnit: ProjectBusinessUnit | '';
  status: ProjectStatus;
  phase: ProjectPhase;
  /** Contracted / quoted value, e.g. "$482K" or "$1.2M". String to allow human formatting. */
  value: string;
  /** Auth user id of the engineer this project is assigned to. On a
   *  pre-sales row that's the pre-sales engineer; on a post-sales row it's
   *  the post-sales engineer. */
  ownerId?: string;
  /** On post-sales rows: the original pre-sales engineer carried forward.
   *  Always null on pre-sales rows. Populated by the monday post-sales
   *  pre-sales-engineer person column once that sync lands. */
  legacyEngineerId?: string;
  /** Persistent ID written to both Monday boards' Project ID column. Format: INST-YYYY-NNNN. */
  projectCode?: string;
  /** Monday item id on the AV Pre-Sales Summary board (3477536693). */
  mondayPresalesItemId?: number;
  /** Monday item id on the post-sales board (3523133226). */
  mondayPostsalesItemId?: number;
  /** @deprecated single-board pointer — replaced by project_code + presales/postsales ids. Removed once cutover is complete. */
  mondayItemId?: number;
  dtoolsProjectId?: string;
  dtoolsBomStatus: DToolsBomStatus;
  /** Authoritative DTools root totals, captured at sync time. These are what
   *  the customer sees on the DTools quote; the BoM table sums its own lines
   *  (cents may differ — see dtoolsSyncDelta). */
  dtoolsCost?: number;
  dtoolsPriceWithoutTax?: number;
  dtoolsTax?: number;
  dtoolsPrice?: number;
  dtoolsHours?: number;
  dtoolsSyncedAt?: string;
  dtoolsSyncDelta?: DToolsSyncDelta;
  createdAt: string;
  updatedAt: string;
}

/** Reconciliation snapshot stored by the DTools sync: our derived
 *  equipment/labor split plus the deltas against DTools' root fields.
 *  verified=true means everything reconciled within $1 (expected drift is
 *  per-line rounding cents). */
export interface DToolsSyncDelta {
  equipmentCost: number;
  equipmentPrice: number;
  laborCost: number;
  laborPrice: number;
  costDelta: number;
  priceDelta: number;
  rowCostDelta: number;
  rowPriceDelta: number;
  /** Companion labor lines DTools rolled into a phase rollup (e.g. Airfare
   *  converted to Travel hours). Their dollars live in their own row here. */
  echoModels: string[];
  verified: boolean;
  /** ISO timestamp of the parent project's last publish to the API. COs
   *  approved after this moment are NOT in the synced totals yet — the
   *  Contract Value summary flags them and prompts an SI republish. */
  publishedOn?: string;
}

// ===================== PROJECT LINE ITEMS =====================

export type BomItemType = 'Product' | 'Labor';

export interface SubmittalItemLocation {
  room: string;
  qty: number;
}

export interface ProjectBoMItem {
  id: string;
  projectId: string;
  manufacturer: string;
  model: string;
  description: string;
  category: ItemCategory;
  qty: number;
  notes: string;
  locations: SubmittalItemLocation[];
  cutSheetData?: string;
  cutSheetName?: string;
  sortOrder: number;
  itemType: BomItemType;
  unitCost: number;
  unitPrice: number;
  laborHours: number;
  laborUnitCost: number;
  laborUnitPrice: number;
  fixedLaborCost: number;
  fixedLaborPrice: number;
  marginPct: number;
  ownerFurnished: boolean;
  optional: boolean;
  /** DTools "Priced From" custom field — vendor + last priced date,
   *  formatted "VENDOR MM/DD/YY". Surfaces in the Purchasing module only. */
  pricedFrom?: string;
  /** For Labor rows: the DTools labor type (Install, Cabling, Travel, …).
   *  Empty for products. */
  laborType: string;
  /** For products: per-labor-type attribution from DTools ItemLaborTypes.
   *  hours are LINE-total raw hours (pricing basis); totalHours are DTools'
   *  display hours (may include a per-type hour adjustment, e.g. ×1.03). */
  laborBreakdown: LaborBreakdownEntry[];
  /** Labor line whose dollars DTools also folded into a phase rollup as
   *  converted hours. Informational — our phase residual rows already have
   *  the converted hours removed, so this row's dollars count normally. */
  includedInPhase: boolean;
}

export interface LaborBreakdownEntry {
  type: string;
  hours: number;
  totalHours: number;
  costRate: number;
  priceRate: number;
}

// ===================== SUBMITTALS =====================

export interface Submittal {
  id: string;
  projectId: string;
  title: string;
  revision: string;
  preparedBy: string;
  submittedTo: string;
  status: SubmittalStatus;
  notes: string;
  createdAt: string;
  items: SubmittalItem[];
}

export type SubmittalItemApprovalState = 'pending' | 'approved' | 'revise';

export interface SubmittalItem {
  id: string;
  submittalId: string;
  manufacturer: string;
  model: string;
  description: string;
  category: ItemCategory;
  qty: number;
  cutSheetPath?: string;
  cutSheetData?: string;
  cutSheetName?: string;
  /** Link to cutsheet_repository.id when the cutsheet was auto-attached from
   *  the SharePoint repository. Mutually exclusive in practice with
   *  cutSheetData (which represents an explicit user upload). */
  cutsheetRepositoryId?: string;
  /** Link to cutsheet_staging.id when the user uploaded a cutsheet that
   *  isn't in the repository yet — the file lives in SharePoint /Staging/
   *  awaiting admin approval. Becomes cutsheetRepositoryId once approved. */
  cutsheetStagingId?: string;
  locations: SubmittalItemLocation[];
  notes: string;
  sortOrder: number;
  /** Per-item approval. Defaults to 'pending' if absent. Editable when the
   *  package is Submitted or Revise & Resubmit. When the package is forced
   *  to Approved every item flips to 'approved'. Optional so existing
   *  callers (CSV import, BoM populate) don't need to pass it explicitly —
   *  the row mapper and store actions normalize undefined → 'pending'. */
  approvalState?: SubmittalItemApprovalState;
  approvalChangedAt?: string;
}

// ===================== RFIs =====================

export interface RFI {
  id: string;
  projectId: string;
  number: string;
  subject: string;
  specSection: string;
  description: string;
  status: RFIStatus;
  responseDue: string;
  answeredAt?: string;
  answeredBy?: string;
  responseSummary?: string;
  createdAt: string;
  attachments: RFIAttachment[];
  locationRef?: string;
  productRef?: string;
}

export interface RFIAttachment {
  id: string;
  rfiId: string;
  filePath: string;
  fileName: string;
}

// ===================== CLOSEOUT =====================

export interface CloseoutPackage {
  id: string;
  projectId: string;
  status: CloseoutStatus;
  createdAt: string;
  warranties: Warranty[];
  punchItems: PunchItem[];
  signOffSheets: SignOffSheet[];
  asBuiltDrawings: AsBuiltDrawing[];
  quickStartRooms: QuickStartRoom[];
  productManualUrl?: string;
  productManualName?: string;
}

export interface QuickStartRoom {
  id: string;
  closeoutId: string;
  name: string;
  sortOrder: number;
  steps: QuickStartStep[];
}

export interface QuickStartStep {
  id: string;
  roomId: string;
  text: string;
  note: string;
  sortOrder: number;
}

export interface ManualBookmark {
  title: string;
  page: number;
  depth: number;
}

export interface Warranty {
  id: string;
  closeoutId: string;
  bomItemId?: string;
  system: string;
  manufacturer: string;
  model: string;
  vendor: string;
  startDate: string;
  durationMonths: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  coverageNotes: string;
}

export interface PunchItem {
  id: string;
  closeoutId: string;
  description: string;
  location: string;
  assignedTo: string;
  status: PunchStatus;
  priority: PunchPriority;
  resolvedAt?: string;
  productRef?: string;
}

export interface SignOffSheet {
  id: string;
  closeoutId: string;
  zone: string;
  system: string;
  testedBy: string;
  testedDate: string;
  witnessedBy: string;
  status: SignOffStatus;
  notes: string;
  customItems: SignOffCustomItem[];
}

export interface SignOffCustomItem {
  id: string;
  signOffSheetId: string;
  text: string;
  sortOrder: number;
}

export interface AsBuiltDrawing {
  id: string;
  closeoutId: string;
  title: string;
  fileName: string;
  fileData: string;
  revision: string;
  uploadedAt: string;
}

// ===================== OWNER MANUAL =====================

export interface OwnerManual {
  id: string;
  projectId: string;
  title: string;
  revision: string;
  overviewText: string;
  createdAt: string;
  sections: ManualSection[];
}

export interface ManualSection {
  id: string;
  manualId: string;
  title: string;
  type: ManualSectionType;
  sortOrder: number;
  devices: ManualDevice[];
}

export interface ManualDevice {
  id: string;
  sectionId: string;
  manufacturer: string;
  model: string;
  serialNumber?: string;
  location: string;
  purpose: string;
  operationNotes: string;
  ipAddress?: string;
  controlId?: string;
  sortOrder: number;
}

// ===================== BID LEVELING =====================

export type BidLevelingStatus = 'draft' | 'mapped' | 'generated';

export interface CellMapping {
  sheet: string;
  cell: string;
  tag: string;
}

export interface BidLevelingMappingTemplate {
  id: string;
  name: string;
  gcConsultantName?: string;
  cellMappings: CellMapping[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationReportEntry {
  cell: string;
  sheet: string;
  tag: string;
  value: number | string;
  status: 'written' | 'skipped' | 'formula_overwritten';
  note?: string;
}

export interface BidLevelingSession {
  id: string;
  projectId: string;
  bomCsvUrl?: string;
  templateXlsxUrl?: string;
  mappingTemplateId?: string;
  cellMappingsSnapshot?: CellMapping[];
  generatedXlsxUrl?: string;
  generationReport?: GenerationReportEntry[];
  status: BidLevelingStatus;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ===================== PROJECT MILESTONES =====================

export type MilestoneTier = 'project' | 'phase';
export type MilestoneStatus = 'upcoming' | 'at_risk' | 'complete' | 'overdue';

export type MilestoneType =
  // Contractual / project-tier
  | 'submittal_due'
  | 'submittal_approval_expected'
  | 'material_order_deadline'
  | 'substantial_completion'
  | 'final_completion'
  | 'closeout_package_due'
  | 'training_scheduled'
  | 'ahj_inspection'
  | 'custom'
  // Operational / phase-tier
  | 'rough_in_complete'
  | 'bench_staging_complete'
  | 'pull_terminate_complete'
  | 'rack_install_complete'
  | 'programming_complete'
  | 'commissioning_complete'
  | 'punchlist_issued'
  | 'punchlist_closed';

export interface MilestoneTypeDef {
  value: MilestoneType;
  label: string;
  tier: MilestoneTier;
}

export const MILESTONE_TYPES: MilestoneTypeDef[] = [
  { value: 'submittal_due',                label: 'Submittal package due',           tier: 'project' },
  { value: 'submittal_approval_expected',  label: 'Submittal approval expected',     tier: 'project' },
  { value: 'material_order_deadline',      label: 'Material order deadline',         tier: 'project' },
  { value: 'substantial_completion',       label: 'Substantial completion',          tier: 'project' },
  { value: 'final_completion',             label: 'Final completion',                tier: 'project' },
  { value: 'closeout_package_due',         label: 'Closeout package due',            tier: 'project' },
  { value: 'training_scheduled',           label: 'Client training scheduled',       tier: 'project' },
  { value: 'ahj_inspection',               label: 'AHJ inspection',                  tier: 'project' },
  { value: 'custom',                       label: 'Custom milestone',                tier: 'project' },
  { value: 'rough_in_complete',            label: 'Rough-in complete',               tier: 'phase'   },
  { value: 'bench_staging_complete',       label: 'Bench staging complete',          tier: 'phase'   },
  { value: 'pull_terminate_complete',      label: 'Pull & terminate complete',       tier: 'phase'   },
  { value: 'rack_install_complete',        label: 'Rack install complete',           tier: 'phase'   },
  { value: 'programming_complete',         label: 'Programming complete',            tier: 'phase'   },
  { value: 'commissioning_complete',       label: 'Commissioning complete',          tier: 'phase'   },
  { value: 'punchlist_issued',             label: 'Punch list issued',               tier: 'phase'   },
  { value: 'punchlist_closed',             label: 'Punch list closed',               tier: 'phase'   },
];

export interface ProjectMilestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  milestoneType: MilestoneType;
  tier: MilestoneTier;
  /** Optional phase label (e.g. "Floor 2", "Wing A", "all"). Free-form so it can
   *  match how the GC has broken out the scope. */
  phase?: string;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
  /** ISO date (YYYY-MM-DD), set when the milestone is marked complete. */
  completedDate?: string;
  ownerId?: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** Days inside the at-risk window. Spec calls this configurable at the system
 *  level later — kept here for now. */
export const MILESTONE_AT_RISK_DAYS = 7;

/** Compute the visual status of a milestone from its due / completed dates.
 *  Pure function — same input always returns the same output. */
export function computeMilestoneStatus(
  m: { dueDate: string; completedDate?: string },
  today: Date = new Date(),
): MilestoneStatus {
  if (m.completedDate) return 'complete';
  if (!m.dueDate) return 'upcoming';
  const due = new Date(m.dueDate + 'T00:00:00');
  const t   = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((due.getTime() - t.getTime()) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= MILESTONE_AT_RISK_DAYS) return 'at_risk';
  return 'upcoming';
}

// ===================== PERSONAL OPS =====================

export type EmailFlagStatus = 'active' | 'flagged' | 'deferred' | 'dismissed';
export type SessionType = 'morning' | 'midday' | 'eod';

export interface GraphEmail {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  bodyPreview: string;
  importance: 'low' | 'normal' | 'high';
  isRead: boolean;
  hasAttachments: boolean;
  conversationId?: string;
}

export interface ScoredEmail extends GraphEmail {
  urgencyScore: number;
  urgencyReason: string;
  draftReply: string | null;
  flagStatus: EmailFlagStatus;
  deferredTo?: SessionType;
  firstSeenAt?: string;
}

export interface EmailFlag {
  id: string;
  userId: string;
  messageId: string;
  status: EmailFlagStatus;
  urgencyScore: number | null;
  urgencyReason: string | null;
  sessionType: SessionType | null;
  deferredTo: SessionType | null;
  firstSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

// ===================== WAREHOUSES =====================

export interface Warehouse {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function formatWarehouseAddress(w: Warehouse): string {
  const parts = [w.addressLine1, w.addressLine2, [w.city, w.state, w.postalCode].filter(Boolean).join(' ')]
    .filter((p) => p && p.trim().length > 0);
  return parts.join(', ');
}

// ===================== PURCHASING =====================

export type PurchaseStatus = 'not_ordered' | 'ordered' | 'received';

/** A purchasing module is the work surface for converting one or more
 *  approved submittals into POs. Items live-link from the submittal so
 *  changes flow through; purchaser-entered fields persist independently. */
export interface PurchasingModule {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  /** Linked submittal ids — mirrored locally for fast lookups. */
  submittalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PurchasingItem {
  id: string;
  purchasingModuleId: string;
  submittalItemId: string;
  purchaseUnitPrice?: number;
  shipToWarehouseId?: string;
  shipToCustomAddress?: string;
  needByDate?: string;
  purchaseStatus: PurchaseStatus;
  orderedDate?: string;
  receivedDate?: string;
  poNumber?: string;
  notes: string;
}

export interface PurchasingFreight {
  id: string;
  purchasingModuleId: string;
  manufacturer: string;
  purchaseUnitPrice?: number;
  shipToWarehouseId?: string;
  shipToCustomAddress?: string;
  needByDate?: string;
  purchaseStatus: PurchaseStatus;
  orderedDate?: string;
  receivedDate?: string;
  poNumber?: string;
  notes: string;
}

export interface PurchasingManufacturerDefault {
  id: string;
  purchasingModuleId: string;
  manufacturer: string;
  shipToWarehouseId?: string;
  shipToCustomAddress?: string;
  needByDate?: string;
}

/** Visual state of a purchasing row, derived from the underlying
 *  submittal item's approval + the persisted purchase status. Computed at
 *  render time — never persisted. */
export type PurchasingDisplayStatus =
  | 'draft'              // Linked submittal is in Draft — fields read-only
  | 'pending_approval'   // Submittal is Submitted/R&R, item not yet approved
  | 'approved_to_order'  // Approved, not yet ordered (= persisted 'not_ordered')
  | 'ordered'
  | 'received'
  | 'reverted_after_order'; // Was approved + ordered, then approval pulled back

// ===================== PROJECT COMMENTS =====================

/** A single emoji reaction on a comment. `userIds` is the set of users who
 *  added that emoji — toggling a reaction adds/removes the current user from
 *  this list. The count surfaced in the UI is `userIds.length`. */
export interface CommentReaction {
  emoji: string;
  userIds: string[];
}

/** A comment on the project overview page. Top-level comments have
 *  `parentId == null`; replies point at the top-level comment. Nested
 *  replies (reply-to-reply) are not supported in v1 — the composer is
 *  hidden from existing replies. */
export interface ProjectComment {
  id: string;
  projectId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;   // denormalized from profiles at fetch time
  authorEmail: string;  // denormalized; falls back to "Unknown" if profile gone
  body: string;
  reactions: CommentReaction[];
  edited: boolean;
  createdAt: string;    // ISO timestamp from Postgres
  updatedAt: string;
}

