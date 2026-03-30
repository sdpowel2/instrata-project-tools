export type ProjectStatus = 'Active' | 'Pending Closeout' | 'Closed';

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
  category: string;
  lastUpdated?: string;
  createdAt: string;
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

export interface Project {
  id: string;
  name: string;
  number: string;
  client: string;
  address: string;
  businessUnit: ProjectBusinessUnit | '';
  status: ProjectStatus;
  mondayItemId?: number;
  createdAt: string;
  updatedAt: string;
}

// ===================== PROJECT-LEVEL BILL OF MATERIALS =====================

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
  productManualUrl?: string;
  productManualName?: string;
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
