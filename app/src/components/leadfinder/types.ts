// Lead Finder: shapes of the lf_* tables and the lf_results() rows, plus the
// labels the old standalone app used (leadfinder/web/queries.py).

export type Lane = 'direct_av' | 'likely_av_scope' | 'none';
export type ReviewStatus = 'new' | 'watch' | 'pursue' | 'pass' | 'already_known';
export type OppStatus = 'open' | 'closed' | 'cancelled' | 'awarded' | 'unknown';

export const LANES: Lane[] = ['direct_av', 'likely_av_scope', 'none'];
export const LANE_LABEL: Record<Lane, string> = {
  direct_av: 'Direct AV',
  likely_av_scope: 'Likely AV scope',
  none: 'None',
};
// Lane colors (map pins use the same values).
export const LANE_COLOR: Record<Lane, string> = {
  direct_av: '#15803D',
  likely_av_scope: '#E07A1A',
  none: '#8B8BA6',
};
export const REVIEWS: ReviewStatus[] = ['new', 'watch', 'pursue', 'pass', 'already_known'];
export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  new: 'New',
  watch: 'Watch',
  pursue: 'Pursue',
  pass: 'Pass',
  already_known: 'Already known',
};
export const STATUSES: OppStatus[] = ['open', 'closed', 'cancelled', 'awarded', 'unknown'];

// BuildingConnected Bid Board states (lf_opportunity.source_status).
export const BB_LABEL: Record<string, string> = {
  UNDECIDED: 'Undecided',
  WILL_SUBMIT: 'Accepted',
  SUBMITTED: 'Submitted',
  DECLINED: 'Declined',
  ARCHIVED: 'Archived',
  WON: 'Won',
  LOST: 'Lost',
  CANCELED: 'Cancelled',
  OTHER: 'Closed (other)',
};
export const BB_FILTERS: [string, string][] = [
  ['', 'Any'],
  ['active', 'Undecided or accepted'],
  ['UNDECIDED', 'Undecided only'],
  ['WILL_SUBMIT', 'Accepted only'],
  ['SUBMITTED', 'Submitted'],
  ['DECLINED', 'Declined'],
];

export const SOURCE_LABEL: Record<string, string> = {
  sam_gov: 'SAM.gov',
  buildingconnected: 'Bid Board',
  bonfire: 'Bonfire',
  email_alerts: 'Email alert',
};

/** Filters sent to lf_results(). Mirrors queries.Filters. */
export interface LeadFilters {
  office_id: string;
  office_mode: 'in_range' | 'nearest';
  in_range_only: boolean;
  lanes: Lane[];
  min_score: number;
  status: OppStatus | 'all';
  due_after: string | null; // YYYY-MM-DD
  changed: '' | 'new' | 'updated' | 'new_or_updated';
  review: '' | ReviewStatus;
  source: string;
  bb_status: string;
  location_unknown: boolean;
}

export interface LeadRow {
  id: string;
  group_key: string;
  source_id: string;
  source_record_id: string;
  title: string;
  url: string | null;
  solicitation_number: string | null;
  agency_name: string | null;
  sub_agency: string | null;
  notice_type: string;
  loc_city: string | null;
  loc_state: string | null;
  loc_zip: string | null;
  location_basis: string;
  geocode_method: string;
  lat: number | null;
  lon: number | null;
  posted_at: string | null;
  response_due_at: string | null;
  first_seen_at: string;
  status: OppStatus;
  source_status: string | null;
  lane: Lane;
  score: number;
  review: ReviewStatus;
  notices: number;
  trades: string[];
  gcs: number;
  est_value: number | null;
  nearest_office: string | null;
  nearest_distance: number | null;
  badge: 'New' | 'Updated' | null;
  approximate: boolean;
}

export interface LeadResults {
  last_run: { started_at: string; finished_at: string | null } | null;
  rows: LeadRow[];
}

export interface Office {
  id: string;
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lon: number | null;
  geocode_method: 'census_address' | 'zip_centroid' | 'manual' | null;
  geocode_match: string | null;
  radius_miles: number;
  active: boolean;
}

export interface Source {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  daily_call_budget: number | null;
  last_success_at: string | null;
}

export type JobKind =
  | 'run' | 'sam_docs' | 'ingest_upload' | 'rescan' | 'triage' | 'triage_resume'
  | 'office_save' | 'office_active' | 'rescore' | 'bc_disconnect';

export interface Job {
  id: string;
  kind: JobKind;
  opportunity_id: string | null;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  progress: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SourceRunRow {
  run_id: string;
  source_id: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  records_fetched: number;
  records_new: number;
  records_updated: number;
  api_calls_used: number;
  resume_cursor: Record<string, unknown> | null;
  error: string | null;
}

export interface RunRow {
  id: string;
  trigger: 'manual' | 'scheduled' | 'cli';
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  window_from: string | null;
  window_to: string | null;
  started_at: string;
  finished_at: string | null;
  lf_source_run: SourceRunRow[];
}

export interface LeadDocsSummary {
  folder?: string;
  count?: number;
  total_bytes?: number;
  sam_links?: number;
  sam_ok?: number;
  sam_errors?: [string, string][];
  unpack_errors?: [string, string][];
  zips?: string[];
}

export interface DocumentRow {
  id: string;
  path: string;
  size: number;
  is_zip: boolean;
  unpacked: boolean;
}

export interface TriageRun {
  id: string;
  status: 'uploading' | 'running' | 'done' | 'failed';
  rating: string | null;
  tier: string | null;
  estimate: string | null;
  bid_due: string | null;
  rfi_due: string | null;
  summary: string | null;
  error: string | null;
  files: number | null;
  cost_usd: number | null;
  session_id: string | null;
  report_md: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkerStatus {
  heartbeat_at: string;
  public_url: string;
  sam_key: boolean;
  aps_configured: boolean;
  aps_callback: string;
  /** False on a worker without persistent disk: bid documents and triage are off. */
  documents_enabled?: boolean;
  triage_configured: boolean;
  triage_budget_usd: number;
  auth_configured: boolean;
  disk: { free_bytes: number; total_bytes: number } | null;
  scorer_version: string | null;
  schedule_hour_et: number;
}

export interface BcStatus {
  connected_as: string;
  connected_at: string;
  refreshed_at: string;
  scope: string;
  bid_board_access: boolean | null;
  note: string;
}
