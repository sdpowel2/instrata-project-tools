/** Normalized Procore shapes the tools return (compact subsets of the API payloads). */

export type Company = { company_id: number; name: string };

export type ProjectRef = {
  project_id: number;
  company_id: number;
  company_name: string;
  name: string;
  project_number?: string;
  stage?: string;
  active?: boolean;
  address?: string;
  city?: string;
  state?: string;
};

/** Raw Procore company payload (subset). */
export type RawCompany = { id: number; name: string; is_active?: boolean };

/** Raw Procore project payload (subset). */
export type RawProject = {
  id: number;
  name: string;
  display_name?: string;
  project_number?: string;
  active?: boolean;
  stage_name?: string;
  phase?: string;
  address?: string;
  city?: string;
  state_code?: string;
};
