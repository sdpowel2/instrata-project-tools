import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useStore } from '../store';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { DToolsImportPicker, type DToolsListedProject } from '../components/DToolsImportPicker';
import type { ProjectStatus, ProjectBusinessUnit, ProjectPhase } from '../types';

export function ProjectNew() {
  const navigate = useNavigate();
  const addProject = useStore((s) => s.addProject);
  const fetchAllData = useStore((s) => s.fetchAllData);
  const [form, setForm] = useState({
    name: '',
    number: '',
    client: '',
    address: '',
    businessUnit: '' as ProjectBusinessUnit | '',
    status: 'Not Started' as ProjectStatus,
    phase: 'Pre-Sales' as ProjectPhase,
    value: '',
    dtoolsBomStatus: '' as const,
  });
  const [showDToolsPicker, setShowDToolsPicker] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = addProject(form);
    navigate(`/projects/${id}`);
  };

  const handlePickedFromDTools = async (p: DToolsListedProject) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error: fnError } = await supabase.functions.invoke<{ projectId: string; alreadyExisted?: boolean }>(
      'dtools-import-project',
      { body: { dtoolsProjectId: p.dtoolsId, createdBy: user?.id ?? null } },
    );
    if (fnError) throw fnError;
    if (!data?.projectId) throw new Error('Import response missing projectId');
    setShowDToolsPicker(false);
    // Re-pull the store so the freshly-inserted project is in memory before
    // the overview tries to render. Cheap relative to the round trip the
    // import already did.
    await fetchAllData();
    navigate(`/projects/${data.projectId}`);
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-start justify-between mb-6 gap-4">
        <h1 className="text-2xl font-bold text-navy">New Project</h1>
        {isSupabaseConfigured() && (
          <button
            type="button"
            onClick={() => setShowDToolsPicker(true)}
            className="btn-orange whitespace-nowrap"
          >
            <Download size={16} /> Import from DTools
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-border shadow-sm p-6 space-y-5">
        <Field label="Project Name" required>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="input" placeholder="e.g. One Vanderbilt - Level 60 AV Buildout" />
        </Field>
        <Field label="Project Number" required>
          <input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} required className="input" placeholder="e.g. INS-2026-005" />
        </Field>
        <Field label="Client" required>
          <input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} required className="input" placeholder="Client name" />
        </Field>
        <Field label="Business Unit" required>
          <select value={form.businessUnit} onChange={(e) => setForm({ ...form, businessUnit: e.target.value as ProjectBusinessUnit })} required className="input">
            <option value="" disabled>Select a business unit</option>
            <option value="Instrata SE">Instrata SE</option>
            <option value="Instrata SW">Instrata SW</option>
            <option value="Instrata NE">Instrata NE</option>
            <option value="Instrata MA">Instrata MA</option>
          </select>
        </Field>
        <Field label="Address">
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="input" placeholder="Project address" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Phase" required>
            <select value={form.phase} onChange={(e) => setForm({ ...form, phase: e.target.value as ProjectPhase })} className="input">
              <option value="Pre-Sales">Pre-Sales</option>
              <option value="Post-Sales">Post-Sales</option>
            </select>
          </Field>
          <Field label="Contracted Value">
            <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="input" placeholder="e.g. $482K" />
          </Field>
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button type="button" onClick={() => navigate('/projects')} className="btn-secondary">Cancel</button>
          <button type="submit" className="btn-primary">Create Project</button>
        </div>
      </form>

      <DToolsImportPicker
        open={showDToolsPicker}
        onClose={() => setShowDToolsPicker(false)}
        onSelect={handlePickedFromDTools}
      />
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-text-primary">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
