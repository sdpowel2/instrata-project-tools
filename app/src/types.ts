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

export type ReviewRunStatus = 'pending_review' | 'in_review' | 'changes_requested' | 'quick_fix' | 'approved';
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
  /** Auth user id of the engineer this project is assigned to. */
  ownerId?: string;
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
  createdAt: string;
  updatedAt: string;
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
