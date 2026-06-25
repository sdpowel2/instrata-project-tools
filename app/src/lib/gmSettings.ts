// Gross Margin Form settings — the exact DTools Model strings used to pull the
// special fixed-cost labor lines out of the labor section. Stored org-wide in
// review_config (text keys) so accounting can adjust them without a code change
// if a quote ever uses a naming variant. Seeded lazily from DEFAULT_SPECIAL_MODELS.
import { supabase, isSupabaseConfigured } from './supabase';
import { DEFAULT_SPECIAL_MODELS, type SpecialModels } from '../utils/grossMargin';

const KEYS: Record<keyof SpecialModels, { key: string; label: string }> = {
  subcontractor:   { key: 'gm_model_subcontractor',    label: 'GM Form — Subcontractor line model' },
  equipmentRental: { key: 'gm_model_equipment_rental', label: 'GM Form — Equipment Rental line model' },
  permits:         { key: 'gm_model_permits',          label: 'GM Form — Permits line model' },
  premiereProtect: { key: 'gm_model_premiere_protect', label: 'GM Form — Premiere Protect line model' },
};

let cache: SpecialModels | null = null;

export async function loadSpecialModels(): Promise<SpecialModels> {
  if (cache) return cache;
  if (!isSupabaseConfigured()) return DEFAULT_SPECIAL_MODELS;
  const { data } = await supabase
    .from('review_config')
    .select('key, value')
    .in('key', Object.values(KEYS).map((k) => k.key));
  const byKey = new Map((data ?? []).map((r: { key: string; value: string | null }) => [r.key, String(r.value ?? '').trim()]));
  const result = { ...DEFAULT_SPECIAL_MODELS };
  for (const field of Object.keys(KEYS) as (keyof SpecialModels)[]) {
    const v = byKey.get(KEYS[field].key);
    if (v) result[field] = v;
  }
  cache = result;
  return result;
}

export async function saveSpecialModels(models: SpecialModels): Promise<void> {
  cache = { ...models };
  if (!isSupabaseConfigured()) return;
  const { data: { user } } = await supabase.auth.getUser();
  const rows = (Object.keys(KEYS) as (keyof SpecialModels)[]).map((field) => ({
    key: KEYS[field].key,
    value: models[field],
    label: KEYS[field].label,
    data_type: 'text',
    updated_by: user?.id ?? null,
    updated_at: new Date().toISOString(),
  }));
  await supabase.from('review_config').upsert(rows, { onConflict: 'key' });
}

/** Drop the in-memory cache (after a settings save by another surface). */
export function clearSpecialModelsCache() { cache = null; }
