import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, resetSupabaseClient } from '../lib/supabase';
import instrataLogo from '../assets/instrata-logo-white.png';

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Clear stale tokens and destroy/recreate the Supabase client.
    // This guarantees a fresh client with no corrupted internal state
    // from Navigator Lock timeouts on page refresh.
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('sb-')) localStorage.removeItem(key);
    });
    resetSupabaseClient();

    const fresh = (await import('../lib/supabase')).supabase;
    const { error: authError } = await fresh.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (authError) {
      setError(authError.message);
    } else {
      navigate('/');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <img
            src={instrataLogo}
            alt="Instrata"
            className="mx-auto h-10 w-auto object-contain"
          />
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.15em] text-orange">
            Project Tools
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-8 shadow-lg">
          <h1 className="mb-6 text-center text-xl font-semibold text-text-primary">
            Sign In
          </h1>

          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-text-secondary">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-text-secondary">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder="Enter your password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-orange py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-dark disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-text-secondary">
            Don&apos;t have an account?{' '}
            <Link to="/register" className="font-medium text-navy hover:text-navy-light">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
