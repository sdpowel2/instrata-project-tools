import { supabase, isSupabaseConfigured } from './supabase';

export type StorageBucket = 'cutsheets' | 'as-builts';

/**
 * Upload a file to Supabase Storage.
 * Path convention: {projectId}/{uuid}_{filename}
 * Returns the public URL of the uploaded file.
 */
export async function uploadFile(
  bucket: StorageBucket,
  projectId: string,
  file: File,
): Promise<string> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }

  const uniqueName = `${crypto.randomUUID()}_${file.name}`;
  const path = `${projectId}/${uniqueName}`;

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return getFileUrl(bucket, path);
}

/**
 * Delete a file from Supabase Storage.
 * The path should be the portion after the bucket name (e.g. "projectId/uuid_filename").
 */
export async function deleteFile(
  bucket: StorageBucket,
  path: string,
): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    console.error(`Storage delete failed: ${error.message}`);
  }
}

/**
 * Get the public download URL for a file in Supabase Storage.
 */
export function getFileUrl(bucket: StorageBucket, path: string): string {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Extract the storage path from a full Supabase Storage URL.
 * Used when deleting a file given only the URL stored in the database.
 */
export function extractStoragePath(bucket: StorageBucket, url: string): string | null {
  // Public URLs have the pattern: .../storage/v1/object/public/{bucket}/{path}
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

/**
 * Check if a string looks like a URL (i.e. from Supabase Storage) vs base64.
 */
export function isUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Fetch file bytes from a URL. Useful for PDF exports that need the raw data.
 */
export async function fetchFileBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
