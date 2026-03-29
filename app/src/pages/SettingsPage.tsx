import { useState, useEffect, useCallback } from 'react';
import { Users, Shield, ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
}

function TeamMembersSection() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[Settings] Failed to fetch profiles:', error);
    } else {
      setProfiles(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    setUpdating(userId);
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);
    if (error) {
      console.error('[Settings] Failed to update role:', error);
      alert('Failed to update role. You may not have permission.');
    } else {
      setProfiles((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, role: newRole } : p))
      );
    }
    setUpdating(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-text-secondary">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading team members...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {profiles.length === 0 && (
        <p className="text-sm text-text-secondary">No team members found.</p>
      )}
      {profiles.map((profile) => (
        <div
          key={profile.id}
          className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface/30"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-navy/10 flex items-center justify-center">
              {profile.role === 'admin' ? (
                <ShieldCheck size={16} className="text-navy" />
              ) : (
                <Shield size={16} className="text-text-secondary" />
              )}
            </div>
            <div>
              <div className="text-sm font-medium text-text-primary">
                {profile.full_name || profile.email}
              </div>
              <div className="text-xs text-text-secondary">{profile.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-secondary">
              Joined {new Date(profile.created_at).toLocaleDateString()}
            </span>
            <select
              value={profile.role}
              onChange={(e) => handleRoleChange(profile.id, e.target.value)}
              disabled={updating === profile.id}
              className="text-sm border border-border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy disabled:opacity-50"
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { isAdmin } = useAuth();
  const configured = isSupabaseConfigured();
  const [company, setCompany] = useState({ name: 'Instrata / Premiere Communications', phone: '(212) 555-0100', email: 'support@instrata-av.com', address: 'New York, NY' });

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-navy mb-6">Settings</h1>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-navy mb-4">Company Information</h2>
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Company Name</span>
            <input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} className="input mt-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Phone</span>
              <input value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} className="input mt-1.5" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Email</span>
              <input value={company.email} onChange={(e) => setCompany({ ...company, email: e.target.value })} className="input mt-1.5" />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Address</span>
            <input value={company.address} onChange={(e) => setCompany({ ...company, address: e.target.value })} className="input mt-1.5" />
          </label>
        </div>
        <div className="flex justify-end mt-6 pt-4 border-t border-border">
          <button className="btn-primary">Save Changes</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-navy mb-4">PDF Export Defaults</h2>
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Default Prepared By</span>
            <input defaultValue="" className="input mt-1.5" placeholder="Name shown as preparer on exports" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Company Tagline</span>
            <input defaultValue="Technology Solutions for Modern Spaces" className="input mt-1.5" />
          </label>
        </div>
        <div className="flex justify-end mt-6 pt-4 border-t border-border">
          <button className="btn-primary">Save Changes</button>
        </div>
      </div>

      {/* Team Members — Admin only */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Users size={18} className="text-navy" />
            <h2 className="text-base font-semibold text-navy">Team Members</h2>
          </div>
          {configured ? (
            <TeamMembersSection />
          ) : (
            <p className="text-sm text-text-secondary">
              User management requires Supabase to be configured. Set your environment variables to enable this feature.
            </p>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-border shadow-sm p-6">
        <h2 className="text-base font-semibold text-navy mb-4">About</h2>
        <div className="space-y-2 text-sm text-text-secondary">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-orange rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">I</span>
            </div>
            <div>
              <div className="font-semibold text-text-primary">Instrata Project Tools</div>
              <div>v1.0.0 — March 2026</div>
            </div>
          </div>
          <p className="mt-3">AV project documentation toolset for Instrata field engineers and project managers. Submittal packages, RFI tracking, closeout documentation, and owner manuals.</p>
        </div>
      </div>
    </div>
  );
}
