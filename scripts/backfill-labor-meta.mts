// One-time backfill: compute LaborMeta from the saved priced (flavor-A)
// payloads and emit UPDATE statements for the live projects rows. DTools now
// publishes these projects zero-priced, so the rates only exist in fixtures.
//
//   node scripts/backfill-labor-meta.mts > %TEMP%\backfill.sql

import { readFileSync } from 'node:fs';
import { buildBomFromDtools } from '../supabase/functions/dtools-project-lookup/transform.ts';

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

const targets = [
  { projectId: '93b35bee-80ae-4aad-96af-a7c01c5e3250', fixture: 'Reference/AkChinOutputDTools.json' },
  { projectId: 'd067fc5e-ee50-4293-8026-af8ce606be5c', fixture: 'Reference/MaricopaDunlapID.json' },
];

for (const t of targets) {
  const result = buildBomFromDtools(loadJson(t.fixture));
  if (result.payloadFlavor !== 'priced' || !result.laborMeta) {
    console.error(`-- SKIP ${t.fixture}: not a priced payload`);
    continue;
  }
  const json = JSON.stringify(result.laborMeta).replace(/'/g, "''");
  console.log(`update public.projects set dtools_labor_meta = '${json}'::jsonb where id = '${t.projectId}';`);
}
