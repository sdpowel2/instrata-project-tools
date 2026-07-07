// Project Files — client wrappers for the sharepoint-project-files edge
// function plus a direct read of the public.project_files index. SharePoint
// holds the bytes; the index powers the Files tab and MCP tools. See
// Product Spec/04-project-files.md.
import { supabase, isSupabaseConfigured } from './supabase';

export interface ProjectFile {
  id: string;
  projectId: string;
  category: ProjectFileCategory;
  filename: string;
  sharepointPath: string;
  sharepointWebUrl: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  source: 'upload' | 'generated' | 'sharepoint_sync';
  docType: string | null;
  uploadedBy: string | null;
  uploaderName: string | null;
  createdAt: string;
}

export type ProjectFileCategory =
  | 'contracts' | 'drawings' | 'submittals' | 'meeting_notes'
  | 'photos' | 'closeout' | 'general';

/** Display order + labels for the standard category folders. */
export const PROJECT_FILE_CATEGORIES: { key: ProjectFileCategory; label: string }[] = [
  { key: 'contracts',     label: 'Contracts' },
  { key: 'drawings',      label: 'Drawings' },
  { key: 'submittals',    label: 'Submittals' },
  { key: 'meeting_notes', label: 'Meeting Notes' },
  { key: 'photos',        label: 'Photos' },
  { key: 'closeout',      label: 'Closeout' },
  { key: 'general',       label: 'General' },
];

const TEMP_BUCKET = 'project-files-temp';

/** Raw project_files row (snake_case), optionally joined with the uploader profile. */
interface ProjectFileRow {
  id: string;
  project_id: string;
  category: ProjectFileCategory;
  filename: string;
  sharepoint_path: string;
  sharepoint_web_url: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  source: 'upload' | 'generated' | 'sharepoint_sync';
  doc_type: string | null;
  uploaded_by: string | null;
  created_at: string;
  profiles?: { email?: string | null; full_name?: string | null } | null;
}

function mapRow(r: ProjectFileRow): ProjectFile {
  return {
    id: r.id,
    projectId: r.project_id,
    category: r.category,
    filename: r.filename,
    sharepointPath: r.sharepoint_path,
    sharepointWebUrl: r.sharepoint_web_url ?? null,
    sizeBytes: r.size_bytes ?? null,
    mimeType: r.mime_type ?? null,
    source: r.source,
    docType: r.doc_type ?? null,
    uploadedBy: r.uploaded_by ?? null,
    uploaderName: r.profiles?.full_name || r.profiles?.email || null,
    createdAt: r.created_at,
  };
}

/** Read the index for one project, newest first within each category. */
export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('project_files')
    .select('*, profiles:uploaded_by(email, full_name)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load files: ${error.message}`);
  return (data ?? []).map(mapRow);
}

export interface SyncResult {
  folderExists: boolean;
  folderWebUrl?: string | null;
  added: number;
  updated: number;
  removed: number;
  total?: number;
}

/**
 * Reconcile the index with SharePoint (picks up files added natively via
 * Explorer/Teams). One Graph folder walk server-side — call on tab open,
 * throttled by the component.
 */
export async function syncProjectFiles(projectId: string): Promise<SyncResult> {
  const { data, error } = await supabase.functions.invoke<SyncResult>('sharepoint-project-files', {
    body: { op: 'sync', projectId },
  });
  if (error) throw new Error(`Sync failed: ${error.message}`);
  return data!;
}

/**
 * Upload a file into the project's SharePoint folder under the given
 * category. Stages through the project-files-temp bucket so large files
 * bypass the edge-function body limit; the function forwards the bytes to
 * SharePoint, deletes the temp object, and writes the index row.
 */
export async function uploadProjectFile(
  projectId: string,
  category: ProjectFileCategory,
  file: File,
  opts?: { source?: 'upload' | 'generated'; docType?: string },
): Promise<ProjectFile> {
  const tempPath = `${crypto.randomUUID()}_${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  const { error: storageErr } = await supabase.storage
    .from(TEMP_BUCKET)
    .upload(tempPath, file, { cacheControl: '300', upsert: false });
  if (storageErr) throw new Error(`Staging upload failed: ${storageErr.message}`);

  const { data, error } = await supabase.functions.invoke<{ file: ProjectFileRow }>('sharepoint-project-files', {
    body: {
      op: 'upload',
      projectId,
      category,
      filename: file.name,
      storagePath: tempPath,
      mimeType: file.type || undefined,
      source: opts?.source ?? 'upload',
      docType: opts?.docType,
    },
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return mapRow(data!.file);
}

/**
 * Auto-file a generated PDF (submittal package, RFI, closeout doc, …) into
 * the project folder. The filed copy gets a timestamp suffix so re-exports
 * version side-by-side instead of colliding. Never throws — export flows
 * must not break because filing failed; returns null on failure.
 */
export async function fileGeneratedPdf(
  projectId: string,
  category: ProjectFileCategory,
  docType: string,
  filename: string,
  bytes: Uint8Array | ArrayBuffer | Blob,
): Promise<ProjectFile | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const stamped = `${filename.replace(/\.pdf$/i, '')} — ${stamp}.pdf`;
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], stamped, { type: 'application/pdf' });
    return await uploadProjectFile(projectId, category, file, { source: 'generated', docType });
  } catch (err) {
    console.warn('[fileGeneratedPdf] auto-file failed (export still succeeded):', err);
    return null;
  }
}

/** Mint a fresh ~1h download URL and hand it to the browser. */
export async function downloadProjectFile(fileId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ downloadUrl: string; filename: string }>(
    'sharepoint-project-files',
    { body: { op: 'getDownloadUrl', fileId } },
  );
  if (error || !data?.downloadUrl) {
    throw new Error(`Download failed: ${error?.message ?? 'no URL returned'}`);
  }
  const a = document.createElement('a');
  a.href = data.downloadUrl;
  a.download = data.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Delete the SharePoint file and its index row. Member/admin only. */
export async function deleteProjectFile(fileId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('sharepoint-project-files', {
    body: { op: 'delete', fileId },
  });
  if (error) throw new Error(`Delete failed: ${error.message}`);
}

export function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
