import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'member';
}

interface AuthContextValue {
  user: UserProfile | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const DEMO_USER: UserProfile = {
  id: 'demo-user',
  email: 'admin@instrata.com',
  fullName: 'Demo Admin',
  role: 'admin',
};

async function fetchProfile(userId: string, email: string): Promise<UserProfile> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[Auth] Profile fetch error:', error.message);
    }

    if (data) {
      console.log('[Auth] Profile loaded:', data.email, 'role:', data.role);
      return {
        id: data.id,
        email: data.email ?? email,
        fullName: data.full_name ?? email,
        role: data.role === 'admin' ? 'admin' : 'member',
      };
    }
  } catch (err) {
    console.warn('[Auth] Profile fetch exception:', err);
  }

  // Fallback if profile query fails
  console.warn('[Auth] Using fallback member profile for', email);
  return { id: userId, email, fullName: email, role: 'member' };
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

    // Check for an existing session
    supabase.auth.getSession().then(async ({ data: { session: currentSession } }) => {
      setSession(currentSession);
      if (currentSession?.user) {
        const profile = await fetchProfile(
          currentSession.user.id,
          currentSession.user.email ?? '',
        );
        setUser(profile);
      }
      setLoading(false);
    });

    // Listen for auth changes (login, logout, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) {
        const profile = await fetchProfile(
          newSession.user.id,
          newSession.user.email ?? '',
        );
        setUser(profile);
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [configured]);

  const signOut = async () => {
    if (configured) {
      await supabase.auth.signOut();
    }
    setSession(null);
    setUser(null);
    // Force redirect to login
    window.location.href = '/login';
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, session, loading, isAdmin, signOut }}>
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
