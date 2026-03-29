import { useEffect } from 'react';
import { useStore } from '../store';
import { isSupabaseConfigured } from '../lib/supabase';

/**
 * Hook that hydrates the Zustand store from Supabase on mount.
 * Call this once inside the authenticated route wrapper so auth is
 * already resolved before we attempt to read data.
 *
 * In demo mode (Supabase not configured) this is a no-op — the store
 * is already seeded with sample data.
 */
export function useSupabaseSync() {
  const fetchAllData = useStore((s) => s.fetchAllData);
  const isInitialized = useStore((s) => s.isInitialized);
  const isLoading = useStore((s) => s.isLoading);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    if (isInitialized) return; // already fetched

    fetchAllData();
  }, [fetchAllData, isInitialized]);

  return { isLoading, isInitialized };
}
