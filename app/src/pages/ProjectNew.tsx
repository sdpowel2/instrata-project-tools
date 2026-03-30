import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import type { ProjectStatus, ProjectBusinessUnit } from '../types';

export function ProjectNew() {
  const navigate = useNavigate();
  const addProject = useStore((s) => s.addProject);
  const [form, setForm] = useState({ name: '', number: '', client: '', address: '', businessUnit: '' as ProjectBusinessUnit | '', status: 'Active' as ProjectStatus });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = addProject(form);
    navigate(`/projects/${id}`);
  };

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-navy mb-6">New Project</h1>
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
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button type="button" onClick={() => navigate('/projects')} className="btn-secondary">Cancel</button>
          <button type="submit" className="btn-primary">Create Project</button>
        </div>
      </form>
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
