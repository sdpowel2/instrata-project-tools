import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { useStore } from '../store';
import type { Project, ProjectStatus, ProjectBusinessUnit } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project;
}

export function ProjectSettingsModal({ open, onClose, project }: Props) {
  const updateProject = useStore((s) => s.updateProject);

  const [form, setForm] = useState({
    name: '',
    number: '',
    client: '',
    address: '',
    businessUnit: '' as ProjectBusinessUnit | '',
    status: 'Active' as ProjectStatus,
    mondayItemId: undefined as number | undefined,
  });

  // Reset form when modal opens or project changes
  useEffect(() => {
    if (open) {
      setForm({
        name: project.name,
        number: project.number,
        client: project.client,
        address: project.address,
        businessUnit: project.businessUnit,
        status: project.status,
        mondayItemId: project.mondayItemId,
      });
    }
  }, [open, project]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateProject(project.id, {
      name: form.name,
      number: form.number,
      client: form.client,
      address: form.address,
      businessUnit: form.businessUnit,
      status: form.status,
      mondayItemId: form.mondayItemId,
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Project Settings">
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Project Name" required>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            className="input"
            placeholder="e.g. One Vanderbilt - Level 60 AV Buildout"
          />
        </Field>

        <Field label="Project Number" required>
          <input
            value={form.number}
            onChange={(e) => setForm({ ...form, number: e.target.value })}
            required
            className="input"
            placeholder="e.g. INS-2026-005"
          />
        </Field>

        <Field label="Client" required>
          <input
            value={form.client}
            onChange={(e) => setForm({ ...form, client: e.target.value })}
            required
            className="input"
            placeholder="Client name"
          />
        </Field>

        <Field label="Business Unit" required>
          <select
            value={form.businessUnit}
            onChange={(e) => setForm({ ...form, businessUnit: e.target.value as ProjectBusinessUnit })}
            required
            className="input"
          >
            <option value="" disabled>Select a business unit</option>
            <option value="Instrata SE">Instrata SE</option>
            <option value="Instrata SW">Instrata SW</option>
            <option value="Instrata NE">Instrata NE</option>
            <option value="Instrata MA">Instrata MA</option>
          </select>
        </Field>

        <Field label="Address">
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="input"
            placeholder="Project address"
          />
        </Field>

        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as ProjectStatus })}
            className="input"
          >
            <option value="Active">Active</option>
            <option value="Pending Closeout">Pending Closeout</option>
            <option value="Closed">Closed</option>
          </select>
        </Field>

        <Field label="Monday.com Item ID">
          <input
            type="number"
            value={form.mondayItemId ?? ''}
            onChange={(e) => setForm({ ...form, mondayItemId: e.target.value ? Number(e.target.value) : undefined })}
            className="input"
            placeholder="Monday.com item ID (optional)"
          />
        </Field>

        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Save Changes
          </button>
        </div>
      </form>
    </Modal>
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
