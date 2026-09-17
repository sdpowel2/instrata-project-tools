import { useState, useEffect, useCallback } from 'react';
import { Users, Shield, ShieldCheck, Loader2, Plus, Trash2, SlidersHorizontal, Briefcase, Warehouse as WarehouseIcon, Pencil, Bell, Link2, Unplug, Copy, Check, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStore } from '../store';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { Modal } from '../components/Modal';
import type { LaborRate, ReviewConfigEntry, Warehouse } from '../types';
import { loadSpecialModels, saveSpecialModels, clearSpecialModelsCache } from '../lib/gmSettings';
import { DEFAULT_SPECIAL_MODELS, type SpecialModels } from '../utils/grossMargin';

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

// Gross Margin Form — the exact DTools Model strings used to reclassify the
// special fixed-cost labor lines (Subcontractor / Equipment Rental / Permits →
// Equipment; Premiere Protect → carved out). Seeded with the known values;
// editable here so accounting can adjust without a code change.
function GmFormModelsSection() {
  const [models, setModels] = useState<SpecialModels>(DEFAULT_SPECIAL_MODELS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSpecialModels().then((m) => { setModels(m); setLoading(false); });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    clearSpecialModelsCache();
    await saveSpecialModels(models);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fields: { key: keyof SpecialModels; label: string }[] = [
    { key: 'subcontractor', label: 'Subcontractor' },
    { key: 'equipmentRental', label: 'Equipment Rental' },
    { key: 'permits', label: 'Permits' },
    { key: 'premiereProtect', label: 'Premiere Protect' },
  ];

  if (loading) return <div className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin text-text-secondary" /></div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        These match the DTools line-item <strong>Model</strong> exactly. The matched lines are pulled out of
        the labor section on the Gross Margin Form — Subcontractor, Equipment Rental and Permits are reported
        as equipment; Premiere Protect is carved out entirely. Only change these if a quote uses a different name.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-sm font-medium text-text-primary">{f.label}</span>
            <input value={models[f.key]} onChange={(e) => setModels((m) => ({ ...m, [f.key]: e.target.value }))} className="input mt-1.5" />
          </label>
        ))}
      </div>
      <div className="flex justify-end items-center gap-3 pt-4 border-t border-border">
        {saved && <span className="text-sm text-emerald-600 inline-flex items-center gap-1"><Check size={14} /> Saved</span>}
        <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-60">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save Changes
        </button>
      </div>
    </div>
  );
}

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

// =============================================================================
// Warehouses — admin-only org-wide ship-to destinations used by Purchasing.
// =============================================================================

function WarehousesSection() {
  const warehouses = useStore((s) => s.warehouses);
  const addWarehouse = useStore((s) => s.addWarehouse);
  const updateWarehouse = useStore((s) => s.updateWarehouse);
  const deleteWarehouse = useStore((s) => s.deleteWarehouse);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<Warehouse, 'id' | 'createdAt' | 'updatedAt'>>({
    name: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
    notes: '', isActive: true,
  });

  const sorted = [...warehouses].sort((a, b) => a.name.localeCompare(b.name));

  const openNew = () => {
    setEditingId(null);
    setForm({ name: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', notes: '', isActive: true });
    setShowForm(true);
  };

  const openEdit = (w: Warehouse) => {
    setEditingId(w.id);
    setForm({
      name: w.name, addressLine1: w.addressLine1, addressLine2: w.addressLine2,
      city: w.city, state: w.state, postalCode: w.postalCode,
      notes: w.notes, isActive: w.isActive,
    });
    setShowForm(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (editingId) updateWarehouse(editingId, form);
    else           addWarehouse(form);
    setShowForm(false);
  };

  const handleDelete = (w: Warehouse) => {
    if (window.confirm(`Delete warehouse "${w.name}"? Existing purchasing rows that reference it will keep the address text but lose the link.`)) {
      deleteWarehouse(w.id);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={openNew} className="btn-primary text-sm">
          <Plus size={14} /> Add Warehouse
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-text-secondary py-4">No warehouses yet. Add one above so purchasers can pick it as a ship-to destination.</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((w) => (
            <div
              key={w.id}
              className={`flex items-start justify-between p-3 rounded-lg border border-border bg-surface/30 ${w.isActive ? '' : 'opacity-60'}`}
            >
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <WarehouseIcon size={16} className="text-navy" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary flex items-center gap-2">
                    {w.name}
                    {!w.isActive && <span className="text-[10px] font-bold uppercase text-fg-2">Inactive</span>}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    {[w.addressLine1, w.addressLine2, [w.city, w.state, w.postalCode].filter(Boolean).join(' ')]
                      .filter((p) => p && p.trim().length > 0).join(', ') || '— no address —'}
                  </div>
                  {w.notes && <div className="text-xs text-fg-2 italic mt-1">{w.notes}</div>}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => openEdit(w)} title="Edit" className="p-1.5 rounded-md text-fg-2 hover:bg-surface hover:text-navy">
                  <Pencil size={13} />
                </button>
                <button onClick={() => handleDelete(w)} title="Delete" className="p-1.5 rounded-md text-fg-2 hover:bg-red-50 hover:text-red-600">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editingId ? 'Edit Warehouse' : 'Add Warehouse'}>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Name <span className="text-red-500">*</span></span>
            <input
              required value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input mt-1.5"
              placeholder="e.g. Instrata HQ Warehouse"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Address Line 1</span>
            <input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Address Line 2</span>
            <input value={form.addressLine2} onChange={(e) => setForm({ ...form, addressLine2: e.target.value })} className="input mt-1.5" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block col-span-2">
              <span className="text-sm font-medium text-text-primary">City</span>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="input mt-1.5" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">State</span>
              <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="input mt-1.5" maxLength={2} />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Postal Code</span>
            <input value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Notes</span>
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input mt-1.5" placeholder="Receiving hours, dock contact, etc." />
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active (uncheck to hide from ship-to dropdowns)
          </label>
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn-primary text-sm">{editingId ? 'Save Changes' : 'Add Warehouse'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ─── Notifications Section ────────────────────────────────────────────────────

function NotificationsSection() {
  const { user } = useAuth();
  const configured = isSupabaseConfigured();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    if (!user || !configured) { setLoading(false); return; }
    supabase
      .from('notification_preferences')
      .select('enabled')
      .eq('user_id', user.id)
      .eq('type', 'bug_status_changed')
      .maybeSingle()
      .then(({ data }) => {
        if (data !== null) setEnabled(data.enabled);
        setLoading(false);
      });
  }, [user, configured]);

  const handleToggle = async (val: boolean) => {
    if (!user) return;
    setEnabled(val);
    setSaving(true);
    await supabase
      .from('notification_preferences')
      .upsert(
        { user_id: user.id, type: 'bug_status_changed', enabled: val },
        { onConflict: 'user_id,type' },
      );
    setSaving(false);
  };

  if (!configured) {
    return (
      <p className="text-sm text-text-secondary">
        Notification preferences require Supabase to be configured.
      </p>
    );
  }

  if (loading) {
    return <div className="py-4 flex justify-center"><Loader2 size={16} className="animate-spin text-text-secondary" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface/30">
        <div className="pr-4">
          <div className="text-sm font-medium text-text-primary">Bug report status updates</div>
          <div className="text-xs text-text-secondary mt-0.5">
            Get notified when the status of a bug you reported changes or is resolved
          </div>
        </div>
        <button
          onClick={() => handleToggle(!enabled)}
          disabled={saving}
          aria-label={enabled ? 'Disable notification' : 'Enable notification'}
          className={[
            'relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 border-0 outline-none cursor-pointer',
            enabled ? 'bg-navy' : 'bg-gray-200',
          ].join(' ')}
        >
          <span
            className={[
              'absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-200',
              enabled ? 'left-[22px]' : 'left-[2px]',
            ].join(' ')}
          />
        </button>
      </div>
      <p className="text-xs text-text-secondary">
        More notification types will be added as new features roll out.
      </p>
    </div>
  );
}

// ─── Connected apps (MCP / OAuth) Section ────────────────────────────────────
// Shows the Claude connections this user has approved for the Project Tools
// MCP server and lets them disconnect. Connections are OAuth 2.1 grants issued
// by mcp-server's own authorization server (see /mcp-server); one row here =
// one refresh-token family = one "Connect" click. RLS on oauth_refresh_tokens /
// oauth_access_tokens limits reads to the caller's own rows, and
// oauth_disconnect() (SECURITY INVOKER) does the revoking under the same RLS.
// Nothing is minted from this page any more — sign-in + consent happen on the
// MCP server when a client connects.

const MCP_SERVER_URL =
  import.meta.env.VITE_MCP_SERVER_URL || 'https://instrata-project-tools-mcp.fly.dev/mcp';

interface RefreshRow {
  family_id: string;
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
}

interface ConnectedApp {
  familyId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string;   // earliest token in the family
  lastUsedAt: string | null;
  expiresAt: string;     // current refresh token's expiry (sliding)
}

const CLIENT_NAME_FALLBACK = 'Claude';

function ConnectedAppsSection() {
  const configured = isSupabaseConfigured();
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // familyId or 'all'
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    // All of this user's refresh tokens (RLS), then group client-side by family.
    const { data: refreshRows, error } = await supabase
      .from('oauth_refresh_tokens')
      .select('family_id, client_id, scope, created_at, expires_at, revoked_at, replaced_by')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[Settings] Failed to load connected apps:', error);
      setLoading(false);
      return;
    }

    const families = new Map<string, ConnectedApp>();
    for (const r of (refreshRows ?? []) as RefreshRow[]) {
      const live = r.revoked_at === null && r.replaced_by === null;
      const existing = families.get(r.family_id);
      if (!existing) {
        families.set(r.family_id, {
          familyId: r.family_id,
          clientId: r.client_id,
          clientName: CLIENT_NAME_FALLBACK,
          scopes: r.scope.split(' ').filter(Boolean),
          connectedAt: r.created_at,
          lastUsedAt: null,
          expiresAt: live ? r.expires_at : '',
        });
      } else if (live) {
        existing.expiresAt = r.expires_at;
        existing.scopes = r.scope.split(' ').filter(Boolean);
      }
    }
    // A family with no live refresh token is disconnected (or fully expired).
    const liveApps = [...families.values()].filter((a) => a.expiresAt !== '' && new Date(a.expiresAt) > new Date());

    if (liveApps.length > 0) {
      const familyIds = liveApps.map((a) => a.familyId);
      const clientIds = [...new Set(liveApps.map((a) => a.clientId))];
      const [{ data: accessRows }, { data: clientRows }] = await Promise.all([
        supabase
          .from('oauth_access_tokens')
          .select('family_id, last_used_at')
          .in('family_id', familyIds)
          .not('last_used_at', 'is', null),
        supabase.from('oauth_clients').select('client_id, client_name').in('client_id', clientIds),
      ]);
      const lastUsed = new Map<string, string>();
      for (const row of (accessRows ?? []) as { family_id: string; last_used_at: string }[]) {
        const prev = lastUsed.get(row.family_id);
        if (!prev || row.last_used_at > prev) lastUsed.set(row.family_id, row.last_used_at);
      }
      const names = new Map<string, string>();
      for (const c of (clientRows ?? []) as { client_id: string; client_name: string | null }[]) {
        if (c.client_name) names.set(c.client_id, c.client_name);
      }
      for (const a of liveApps) {
        a.lastUsedAt = lastUsed.get(a.familyId) ?? null;
        a.clientName = names.get(a.clientId) ?? CLIENT_NAME_FALLBACK; // admin-registered client has no row
      }
    }

    liveApps.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
    setApps(liveApps);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (configured) load();
    else setLoading(false);
  }, [configured, load]);

  const disconnect = async (familyId: string | null) => {
    const msg = familyId
      ? 'Disconnect this Claude connection? It will lose access immediately and will need to reconnect.'
      : 'Disconnect ALL Claude connections? Every connected client will lose access immediately.';
    if (!window.confirm(msg)) return;
    setBusy(familyId ?? 'all');
    const { error } = await supabase.rpc('oauth_disconnect', { p_family_id: familyId });
    if (error) {
      alert('Failed to disconnect: ' + error.message);
    } else {
      await load();
    }
    setBusy(null);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(MCP_SERVER_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const describeScopes = (scopes: string[]) =>
    scopes.includes('mcp:write') ? 'Read & write' : scopes.includes('mcp:read') ? 'Read-only' : 'No access';

  if (!configured) {
    return (
      <p className="text-sm text-text-secondary">
        Connecting Claude requires Supabase to be configured.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Connect a Claude client (claude.ai, Claude Desktop, or Claude Code) to your project data. When you
        connect, you’ll sign in with your Project Tools email and password and approve what Claude may do.
        Claude then acts as you: it can see exactly what you can see here, and can only change submittals on
        projects you belong to.
      </p>

      <label className="block">
        <span className="text-sm font-medium text-text-primary">MCP server URL</span>
        <div className="flex gap-2 mt-1.5">
          <input readOnly value={MCP_SERVER_URL} className="input flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <button onClick={copyUrl} className="btn-secondary text-sm flex-shrink-0" title="Copy URL">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </label>

      <div className="text-xs text-text-secondary space-y-1">
        <p className="font-medium text-text-primary">How to connect</p>
        <p><span className="font-medium">claude.ai:</span> an Instrata admin adds the URL above as a custom connector once; then open it and click <em>Connect</em>.</p>
        <p><span className="font-medium">Claude Code:</span> run
          <code className="mx-1 px-1 py-0.5 bg-surface rounded">claude mcp add --transport http project-tools {MCP_SERVER_URL}</code>
          then <code className="mx-1 px-1 py-0.5 bg-surface rounded">/mcp</code> to sign in.</p>
      </div>

      <div className="flex items-center justify-between pt-2">
        <span className="text-sm font-medium text-text-primary">Active connections</span>
        {apps.length > 1 && (
          <button onClick={() => disconnect(null)} disabled={busy !== null} className="btn-secondary text-xs disabled:opacity-50">
            {busy === 'all' ? <Loader2 size={12} className="animate-spin inline mr-1" /> : <Unplug size={12} className="inline mr-1" />}
            Disconnect all
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-4 flex justify-center"><Loader2 size={16} className="animate-spin text-text-secondary" /></div>
      ) : apps.length === 0 ? (
        <p className="text-sm text-text-secondary py-2">
          No Claude clients are connected. Connections appear here after you approve one.
        </p>
      ) : (
        <div className="space-y-2">
          {apps.map((a) => (
            <div key={a.familyId} className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface/30">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
                  <Link2 size={16} className="text-navy" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{a.clientName}</div>
                  <div className="text-xs text-text-secondary">
                    {describeScopes(a.scopes)}
                    {' · '}connected {new Date(a.connectedAt).toLocaleDateString()}
                    {' · '}
                    {a.lastUsedAt ? `last used ${new Date(a.lastUsedAt).toLocaleDateString()}` : 'not used yet'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => disconnect(a.familyId)}
                disabled={busy !== null}
                title="Disconnect"
                className="p-1.5 rounded-md text-fg-2 hover:bg-red-50 hover:text-red-600 flex-shrink-0 disabled:opacity-50"
              >
                {busy === a.familyId ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}
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
              <WarehouseIcon size={18} className="text-navy" />
              <h2 className="text-base font-semibold text-navy">Warehouses</h2>
            </div>
            <p className="text-sm text-text-secondary mb-4">
              Org-wide ship-to destinations used by the Purchasing module. Purchasers can pick any active
              warehouse as a default for a manufacturer or override at the line-item level.
            </p>
            <WarehousesSection />
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <FileSpreadsheet size={18} className="text-navy" />
              <h2 className="text-base font-semibold text-navy">Gross Margin Form — Special Lines</h2>
            </div>
            <GmFormModelsSection />
          </div>
        </>
      )}

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={18} className="text-navy" />
          <h2 className="text-base font-semibold text-navy">Notifications</h2>
        </div>
        <NotificationsSection />
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Link2 size={18} className="text-navy" />
          <h2 className="text-base font-semibold text-navy">Connected apps</h2>
        </div>
        <ConnectedAppsSection />
      </div>

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
