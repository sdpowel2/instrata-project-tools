import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { useStore } from '../store';
import type { Project, ProjectStatus, ProjectBusinessUnit, ProjectPhase } from '../types';

const PRE_SALES_BOARD_ID = 3477536693;
const POST_SALES_BOARD_ID = 3523133226;

const STATUS_OPTIONS: ProjectStatus[] = [
  'Not Started', 'In Progress', 'On Hold', 'Review', 'Follow Up',
  'Won', 'Lost', 'Declined to Bid', 'Rebid',
  'Install', 'Close Out', 'Completed',
];

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
    status: 'Not Started' as ProjectStatus,
    phase: 'Pre-Sales' as ProjectPhase,
    value: '',
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
        phase: project.phase,
        value: project.value,
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
      phase: form.phase,
      value: form.value,
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

        <div className="grid grid-cols-2 gap-4">
          <Field label="Phase">
            <select
              value={form.phase}
              onChange={(e) => setForm({ ...form, phase: e.target.value as ProjectPhase })}
              className="input"
            >
              <option value="Pre-Sales">Pre-Sales</option>
              <option value="Post-Sales">Post-Sales</option>
            </select>
          </Field>
          <Field label="Contracted Value">
            <input
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              className="input"
              placeholder="e.g. $482K"
            />
          </Field>
        </div>

        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as ProjectStatus })}
            className="input"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <p className="text-[11px] text-fg-2 mt-1">
            Status is normally synced from Monday.com — change here only to override.
          </p>
        </Field>

        <MondayLinkPanel project={project} />

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

function MondayLinkPanel({ project }: { project: Project }) {
  const presalesUrl = project.mondayPresalesItemId
    ? `https://instrata.monday.com/boards/${PRE_SALES_BOARD_ID}/pulses/${project.mondayPresalesItemId}`
    : null;
  const postsalesUrl = project.mondayPostsalesItemId
    ? `https://instrata.monday.com/boards/${POST_SALES_BOARD_ID}/pulses/${project.mondayPostsalesItemId}`
    : null;

  return (
    <div className="rounded-lg border border-border bg-surface/40 px-4 py-3">
      <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-fg-2 mb-2">
        Monday.com Link
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[13px]">
        <dt className="text-fg-2">Project ID</dt>
        <dd className="font-mono text-fg">
          {project.projectCode ?? <span className="text-fg-2 italic">Not yet assigned</span>}
        </dd>
        <dt className="text-fg-2">Pre-Sales item</dt>
        <dd>
          {presalesUrl
            ? <a href={presalesUrl} target="_blank" rel="noreferrer" className="text-orange hover:underline">{project.mondayPresalesItemId}</a>
            : <span className="text-fg-2 italic">Not linked</span>}
        </dd>
        <dt className="text-fg-2">Post-Sales item</dt>
        <dd>
          {postsalesUrl
            ? <a href={postsalesUrl} target="_blank" rel="noreferrer" className="text-orange hover:underline">{project.mondayPostsalesItemId}</a>
            : <span className="text-fg-2 italic">Not linked</span>}
        </dd>
      </dl>
    </div>
  );
}
