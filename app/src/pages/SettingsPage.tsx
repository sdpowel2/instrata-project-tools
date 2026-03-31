import { useState, useEffect, useCallback } from 'react';
import { Users, Shield, ShieldCheck, Loader2, Plus, Trash2, SlidersHorizontal, Briefcase, Upload, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { CatalogImportModal } from '../components/CatalogImportModal';
import { CatalogViewerModal } from '../components/CatalogViewerModal';
import type { LaborRate, ReviewConfigEntry } from '../types';

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

// ─── Review Config Section ────────────────────────────────────────────────────

function ReviewConfigSection() {
  const [config, setConfig] = useState<ReviewConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    supabase.from('review_config').select('*').then(({ data }) => {
      if (data) {
        setConfig(data.map((r: any) => ({
          key: r.key, value: r.value, label: r.label, dataType: r.data_type,
        })));
      }
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    for (const entry of config) {
      await supabase.from('review_config').update({ value: entry.value }).eq('key', entry.key);
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return <div className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin text-text-secondary" /></div>;

  return (
    <div>
      <div className="space-y-4">
        {config.map((entry) => (
          <label key={entry.key} className="block">
            <span className="text-sm font-medium text-text-primary">{entry.label}</span>
            <input
              type={entry.dataType === 'list' || entry.dataType === 'text' ? 'text' : 'number'}
              value={entry.value}
              onChange={e => setConfig(prev => prev.map(c => c.key === entry.key ? { ...c, value: e.target.value } : c))}
              className="input mt-1.5"
              placeholder={entry.dataType === 'list' ? 'comma-separated values' : ''}
            />
            <span className="text-xs text-text-secondary mt-0.5 block">
              {entry.dataType === 'percent' && 'Percentage (0–100)'}
              {entry.dataType === 'days' && 'Number of days'}
              {entry.dataType === 'list' && 'Comma-separated. Leave blank to disable this rule.'}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
        {saved && <span className="text-sm text-green-600">Saved</span>}
        <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? <><Loader2 size={14} className="animate-spin inline mr-1" />Saving…</> : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ─── Labor Rates Section ──────────────────────────────────────────────────────

// Standard D-Tools labor types — used for quick-seed
const DTOOLS_LABOR_TYPES = [
  'Engineering', 'Mobilization', 'Training', 'Install',
  'Commissioning', 'Programming', 'Cabling', 'Premiere Protect',
];

function LaborRatesSection() {
  const [rates, setRates]         = useState<LaborRate[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newType, setNewType]       = useState('');
  const [newCost, setNewCost]       = useState('');
  const [newPrice, setNewPrice]     = useState('');
  const [newCeiling, setNewCeiling] = useState('');
  const [adding, setAdding]       = useState(false);
  const [addError, setAddError]   = useState<string | null>(null);
  const [seeding, setSeeding]     = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const { data, error } = await supabase.from('labor_rates').select('*').order('labor_type');
    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    setRates((data ?? []).map((r: any) => ({
      id: r.id, laborType: r.labor_type, ratePerHour: r.rate_per_hour,
      costPerHour: r.cost_per_hour ?? 0, pricePerHour: r.price_per_hour ?? 0,
      hoursCeiling: r.hours_ceiling ?? undefined, isActive: r.is_active, updatedAt: r.updated_at,
    })));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newType.trim()) return;
    setAdding(true);
    setAddError(null);
    const { error } = await supabase.from('labor_rates').insert({
      labor_type:     newType.trim(),
      rate_per_hour:  newCost ? parseFloat(newCost) : 0,
      cost_per_hour:  newCost ? parseFloat(newCost) : 0,
      price_per_hour: newPrice ? parseFloat(newPrice) : 0,
      hours_ceiling:  newCeiling ? parseFloat(newCeiling) : null,
      is_active:      true,
    });
    if (error) {
      setAddError(error.message);
    } else {
      setNewType(''); setNewCost(''); setNewPrice(''); setNewCeiling('');
      await load();
    }
    setAdding(false);
  };

  // Quick-seed all standard D-Tools labor types at $0/hr — rates can be updated after
  const handleSeed = async () => {
    setSeeding(true);
    setAddError(null);
    const existing = new Set(rates.map(r => r.laborType.toLowerCase()));
    const toInsert = DTOOLS_LABOR_TYPES
      .filter(t => !existing.has(t.toLowerCase()))
      .map(t => ({ labor_type: t, rate_per_hour: 0, is_active: true }));
    if (toInsert.length > 0) {
      const { error } = await supabase.from('labor_rates').insert(toInsert);
      if (error) setAddError(error.message);
      else await load();
    }
    setSeeding(false);
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    await supabase.from('labor_rates').update({ is_active: isActive }).eq('id', id);
    setRates(prev => prev.map(r => r.id === id ? { ...r, isActive } : r));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this labor type?')) return;
    await supabase.from('labor_rates').delete().eq('id', id);
    setRates(prev => prev.filter(r => r.id !== id));
  };

  const handleUpdateCeiling = async (id: string, ceiling: string) => {
    const val = ceiling ? parseFloat(ceiling) : null;
    await supabase.from('labor_rates').update({ hours_ceiling: val }).eq('id', id);
    setRates(prev => prev.map(r => r.id === id ? { ...r, hoursCeiling: val ?? undefined } : r));
  };

  const handleUpdateRate = async (id: string, rate: string) => {
    const val = rate ? parseFloat(rate) : 0;
    await supabase.from('labor_rates').update({ rate_per_hour: val }).eq('id', id);
    setRates(prev => prev.map(r => r.id === id ? { ...r, ratePerHour: val } : r));
  };

  const handleUpdateCostRate = async (id: string, val: string) => {
    const n = val ? parseFloat(val) : 0;
    await supabase.from('labor_rates').update({ cost_per_hour: n }).eq('id', id);
    setRates(prev => prev.map(r => r.id === id ? { ...r, costPerHour: n } : r));
  };

  const handleUpdatePriceRate = async (id: string, val: string) => {
    const n = val ? parseFloat(val) : 0;
    await supabase.from('labor_rates').update({ price_per_hour: n }).eq('id', id);
    setRates(prev => prev.map(r => r.id === id ? { ...r, pricePerHour: n } : r));
  };

  if (loading) return <div className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin text-text-secondary" /></div>;

  if (loadError) return (
    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
      <span>Failed to load labor rates: {loadError}</span>
      <button onClick={load} className="underline hover:no-underline ml-auto">Retry</button>
    </div>
  );

  return (
    <div className="space-y-3">

      {/* Quick-seed banner */}
      {rates.length === 0 && (
        <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">No labor types yet. Seed the standard D-Tools types to get started.</p>
          <button
            onClick={handleSeed}
            disabled={seeding}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors ml-3 shrink-0"
          >
            {seeding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Seed D-Tools Types
          </button>
        </div>
      )}
      {rates.length > 0 && DTOOLS_LABOR_TYPES.some(t => !rates.find(r => r.laborType.toLowerCase() === t.toLowerCase())) && (
        <button
          onClick={handleSeed}
          disabled={seeding}
          className="text-xs text-navy hover:underline disabled:opacity-50"
        >
          {seeding ? 'Adding...' : '+ Add missing D-Tools types'}
        </button>
      )}

      {rates.map(rate => {
        const marginPct = rate.pricePerHour > 0
          ? Math.round((rate.pricePerHour - rate.costPerHour) / rate.pricePerHour * 100)
          : null;
        const marginColor = marginPct === null
          ? 'text-text-secondary bg-surface'
          : marginPct >= 30 ? 'text-green-700 bg-green-50'
          : marginPct >= 20 ? 'text-amber-700 bg-amber-50'
          : 'text-red-700 bg-red-50';

        return (
          <div key={rate.id} className={`p-3 rounded-lg border ${rate.isActive ? 'border-border bg-surface/30' : 'border-border/40 bg-gray-50 opacity-60'}`}>
            {/* Row 1: name + margin badge + actions */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-text-primary flex-1 min-w-0 truncate">{rate.laborType}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${marginColor}`}>
                {marginPct !== null ? `${marginPct}% margin` : 'No rates set'}
              </span>
              <button
                onClick={() => handleToggle(rate.id, !rate.isActive)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${rate.isActive ? 'border-gray-300 text-gray-500 hover:bg-gray-100' : 'border-navy/30 text-navy hover:bg-navy/5'}`}
              >
                {rate.isActive ? 'Disable' : 'Enable'}
              </button>
              <button onClick={() => handleDelete(rate.id)} className="text-red-400 hover:text-red-600 transition-colors">
                <Trash2 size={14} />
              </button>
            </div>
            {/* Row 2: cost/hr, price/hr, hrs max */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                <span className="text-xs text-text-secondary w-14 shrink-0">Cost/hr</span>
                <span className="text-xs text-text-secondary">$</span>
                <input
                  type="number"
                  defaultValue={rate.costPerHour || ''}
                  placeholder="0.00"
                  onBlur={e => handleUpdateCostRate(rate.id, e.target.value)}
                  className="w-20 text-xs border border-border rounded px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-navy/20"
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-text-secondary w-14 shrink-0">Price/hr</span>
                <span className="text-xs text-text-secondary">$</span>
                <input
                  type="number"
                  defaultValue={rate.pricePerHour || ''}
                  placeholder="0.00"
                  onBlur={e => handleUpdatePriceRate(rate.id, e.target.value)}
                  className="w-20 text-xs border border-border rounded px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-navy/20"
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-text-secondary w-14 shrink-0">Hrs max</span>
                <input
                  type="number"
                  defaultValue={rate.hoursCeiling ?? ''}
                  placeholder="—"
                  onBlur={e => handleUpdateCeiling(rate.id, e.target.value)}
                  className="w-20 text-xs border border-border rounded px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-navy/20"
                />
              </div>
            </div>
          </div>
        );
      })}

      {/* Add error */}
      {addError && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{addError}</div>
      )}

      {/* Add new */}
      <div className="pt-2 border-t border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={newType}
            onChange={e => setNewType(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="Labor type name"
            className="input flex-1 min-w-[140px] text-sm"
          />
          <input
            type="number"
            value={newCost}
            onChange={e => setNewCost(e.target.value)}
            placeholder="Cost/hr $"
            className="input w-28 text-sm"
          />
          <input
            type="number"
            value={newPrice}
            onChange={e => setNewPrice(e.target.value)}
            placeholder="Price/hr $"
            className="input w-28 text-sm"
          />
          <input
            type="number"
            value={newCeiling}
            onChange={e => setNewCeiling(e.target.value)}
            placeholder="Max hrs"
            className="input w-24 text-sm"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newType.trim()}
            className="btn-primary flex items-center gap-1 disabled:opacity-50 shrink-0"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Product Catalog Import Section ──────────────────────────────────────────

function ProductCatalogSection() {
  const [modalOpen, setModalOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);

  const refreshCount = () => {
    supabase.from('product_catalog').select('id', { count: 'exact', head: true }).then(({ count }) => {
      setCatalogCount(count ?? 0);
    });
  };

  useEffect(() => { refreshCount(); }, []);

  const handleComplete = (count: number) => {
    setResult(count);
    refreshCount();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary">Current catalog size:</span>
        <span className="font-semibold text-text-primary">
          {catalogCount === null ? '—' : `${catalogCount.toLocaleString()} items`}
        </span>
      </div>

      <div>
        <p className="text-xs text-text-secondary mb-3">
          Import products from a CSV or Excel file. You'll map columns to the right fields before importing.
          Existing items (matched by manufacturer + model) are updated automatically.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setResult(null); setModalOpen(true); }}
            className="btn-primary flex items-center gap-2"
          >
            <Upload size={14} /> Import from CSV
          </button>
          {catalogCount !== null && catalogCount > 0 && (
            <button
              onClick={() => setViewerOpen(true)}
              className="btn-secondary flex items-center gap-2"
            >
              <Search size={14} /> Open Catalog
            </button>
          )}
        </div>
      </div>

      {result !== null && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          Import complete — {result.toLocaleString()} items processed.
        </div>
      )}

      <CatalogImportModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onComplete={handleComplete}
      />
      <CatalogViewerModal
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />
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

      {/* Auto Review — Admin only */}
      {isAdmin && configured && (
        <>
          <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <SlidersHorizontal size={18} className="text-navy" />
              <h2 className="text-base font-semibold text-navy">Auto Review — Rule Thresholds</h2>
            </div>
            <ReviewConfigSection />
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Briefcase size={18} className="text-navy" />
              <h2 className="text-base font-semibold text-navy">Labor Rates</h2>
            </div>
            <p className="text-sm text-text-secondary mb-4">
              Labor types must match exactly what engineers enter in the D-Tools Labor Type column. Any unmatched type generates a High flag.
            </p>
            <LaborRatesSection />
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck size={18} className="text-navy" />
              <h2 className="text-base font-semibold text-navy">Product Catalog</h2>
            </div>
            <ProductCatalogSection />
          </div>
        </>
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
