// Resolves a submittal item's cutsheet bytes regardless of source —
// SharePoint repository, SharePoint staging, or legacy Supabase storage.
//
// PDF export and any other consumer that needs the file bytes should go
// through fetchCutsheetBytes() so the multiple sources stay encapsulated.
// Records usage to cutsheet_project_usage when a repository cutsheet is
// fetched, fire-and-forget — analytics shouldn't block the export.

import { supabase } from '../lib/supabase';
import { isUrl, fetchFileBytes } from '../lib/storage';
import type { SubmittalItem } from '../types';

/** True when the item has any kind of cutsheet attached. Replaces the
 *  previous `!!item.cutSheetData` checks scattered in the codebase. */
export function hasCutsheet(item: Pick<SubmittalItem, 'cutSheetData' | 'cutsheetRepositoryId' | 'cutsheetStagingId'>): boolean {
  return !!(item.cutSheetData || item.cutsheetRepositoryId || item.cutsheetStagingId);
}

async function getSharepointDownloadUrl(sharepointItemId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ downloadUrl: string }>(
    'sharepoint-cutsheet',
    { body: { op: 'getDownloadUrl', sharepointItemId } },
  );
  if (error) throw error;
  if (!data?.downloadUrl) throw new Error('SharePoint download URL missing');
  return data.downloadUrl;
}

/** Insert a cutsheet_project_usage row. Fire-and-forget — failures are
 *  logged and swallowed so analytics writes never break the caller. */
function recordUsage(opts: { cutsheetId: string; projectId: string; usedIn: string }): void {
  void (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('cutsheet_project_usage').insert({
        cutsheet_id: opts.cutsheetId,
        project_id: opts.projectId,
        used_in: opts.usedIn,
        used_by_user_id: user?.id ?? null,
      });
      if (error) console.warn('[cutsheetSource] usage insert failed:', error.message);
    } catch (err) {
      console.warn('[cutsheetSource] usage tracking exception:', err);
    }
  })();
}

/**
 * Fetch the cutsheet bytes for a submittal item from its current source.
 * Order of precedence:
 *   1. cutsheetRepositoryId — approved canonical cutsheet (also records usage)
 *   2. cutsheetStagingId    — pending review, staged in SharePoint
 *   3. cutSheetData         — legacy Supabase storage URL or base64 blob
 *
 * @param projectId Used by the usage analytics insert when the source is repo.
 * @param usedIn   Tag for the usage row, e.g. 'submittal' / 'om_manual'.
 */
export async function fetchCutsheetBytes(
  item: Pick<SubmittalItem, 'cutSheetData' | 'cutsheetRepositoryId' | 'cutsheetStagingId'>,
  projectId: string,
  usedIn = 'submittal',
): Promise<Uint8Array> {
  // 1. Approved repository cutsheet
  if (item.cutsheetRepositoryId) {
    const { data: row, error } = await supabase
      .from('cutsheet_repository')
      .select('sharepoint_item_id')
      .eq('id', item.cutsheetRepositoryId)
      .maybeSingle();
    if (error) throw new Error(`Repository row lookup failed: ${error.message}`);
    if (!row?.sharepoint_item_id) throw new Error('Repository row missing SharePoint item id');

    const url = await getSharepointDownloadUrl(row.sharepoint_item_id);
    const bytes = await fetchFileBytes(url);
    recordUsage({ cutsheetId: item.cutsheetRepositoryId, projectId, usedIn });
    return bytes;
  }

  // 2. Pending staged cutsheet — engineer can still ship the submittal while
  //    admin review is in flight.
  if (item.cutsheetStagingId) {
    const { data: row, error } = await supabase
      .from('cutsheet_staging')
      .select('sharepoint_item_id')
      .eq('id', item.cutsheetStagingId)
      .maybeSingle();
    if (error) throw new Error(`Staging row lookup failed: ${error.message}`);
    if (!row?.sharepoint_item_id) throw new Error('Staging row missing SharePoint item id');

    const url = await getSharepointDownloadUrl(row.sharepoint_item_id);
    return fetchFileBytes(url);
  }

  // 3. Legacy Supabase storage (URL) or in-memory base64 (demo mode)
  if (item.cutSheetData) {
    if (isUrl(item.cutSheetData)) return fetchFileBytes(item.cutSheetData);
    return Uint8Array.from(atob(item.cutSheetData), (c) => c.charCodeAt(0));
  }

  throw new Error('No cutsheet source on item');
}
