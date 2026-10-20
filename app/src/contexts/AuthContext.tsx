import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'member';
  /** Hope's flag (profiles.is_ops_coordinator): sees and works the sync queue + mappings. Not a role. */
  isOpsCoordinator: boolean;
}

interface AuthContextValue {
  user: UserProfile | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
  /** Admins + ops coordinators: Hope's Queue and Sync Admin. */
  isSyncViewer: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const DEMO_USER: UserProfile = {
  id: 'demo-user',
  email: 'admin@instrata.com',
  fullName: 'Demo Admin',
  role: 'admin',
  isOpsCoordinator: false,
};

/**
 * Fetch the profile row for a user. Returns null on any failure — the caller
 * decides what to do with that (preserve existing state vs. force re-login).
 *
 * IMPORTANT: never silently downgrade to 'member'. A transient query failure
 * (token mid-refresh, schema cache reload, network blip) was previously
 * causing existing admins to flip to 'member' without any DB change, then
 * stick that way until the next sign-in. The fallback path was the bug.
 */
async function fetchProfile(userId: string, email: string): Promise<UserProfile | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, is_ops_coordinator')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[Auth] Profile fetch error (preserving existing state):', error.message);
      return null;
    }
    if (!data) {
      console.warn('[Auth] No profile row found for', email);
      return null;
    }

    console.log('[Auth] Profile loaded:', data.email, 'role:', data.role);
    return {
      id: data.id,
      email: data.email ?? email,
      fullName: data.full_name ?? email,
      role: data.role === 'admin' ? 'admin' : 'member',
      isOpsCoordinator: data.is_ops_coordinator === true,
    };
  } catch (err) {
    console.warn('[Auth] Profile fetch exception (preserving existing state):', err);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const configured = isSupabaseConfigured();

  useEffect(() => {
    // If Supabase isn't configured, go into demo mode immediately
    if (!configured) {
      setUser(DEMO_USER);
      setSession(null);
      setLoading(false);
      return;
    }

    let isMounted = true;

    // Try to restore the session with a timeout so it can't hang forever.
    async function initSession() {
      try {
        const result = await Promise.race([
          supabase.auth.getSession(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 4000),
          ),
        ]);

        if (!isMounted) return;
        const currentSession = result.data.session;
        setSession(currentSession);
        if (currentSession?.user) {
          const profile = await fetchProfile(
            currentSession.user.id,
            currentSession.user.email ?? '',
          );
          // Only set user if fetch succeeded — null means "transient failure,
          // preserve whatever's already there". On initial load there's no
          // prior state, so null leaves user null and the app shows the
          // loading state until the next refresh.
          if (isMounted && profile) setUser(profile);
        }
      } catch {
        if (!isMounted) return;
        console.warn('[Auth] Session restore failed or timed out');
        setSession(null);
        setUser(null);
      }
      if (isMounted) setLoading(false);
    }

    initSession();

    // Listen for auth changes (login, logout, token refresh).
    // SIGNED_OUT is the only event that should clear user state. Token
    // refresh and other state changes preserve the existing profile so a
    // background re-fetch failure can't downgrade an admin's role.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!isMounted) return;
      setSession(newSession);

      if (event === 'SIGNED_OUT' || !newSession?.user) {
        setUser(null);
        setLoading(false);
        return;
      }

      // Only refetch on actual sign-in events. TOKEN_REFRESHED and
      // USER_UPDATED keep firing throughout a session and previously caused
      // role downgrades when the profile fetch raced with anything else.
      // The role rarely changes in-session; if it does, sign out and back in.
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        const profile = await fetchProfile(
          newSession.user.id,
          newSession.user.email ?? '',
        );
        if (isMounted && profile) setUser(profile);
      }

      setLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [configured]);

  const signOut = async () => {
    if (configured) {
      // signOut() can hang indefinitely on a flaky session — race it against
      // a 3s timeout so a stuck network call doesn't trap the user signed in.
      try {
        await Promise.race([
          supabase.auth.signOut(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('signOut timeout')), 3000),
          ),
        ]);
      } catch (err) {
        console.warn('[Auth] signOut API failed or timed out, clearing local session:', err);
      }
      // Always clear Supabase's localStorage keys, even if the API call failed
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('sb-')) localStorage.removeItem(key);
      });
    }
    setSession(null);
    setUser(null);
    // Force redirect to login
    window.location.href = '/login';
  };

  const isAdmin = user?.role === 'admin';
  const isSyncViewer = isAdmin || user?.isOpsCoordinator === true;

  return (
    <AuthContext.Provider value={{ user, session, loading, isAdmin, isSyncViewer, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
