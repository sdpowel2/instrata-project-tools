// Offices: the Instrata offices leads are measured from. Saving geocodes the
// address on the worker (Census geocoder, ZIP-centroid fallback) and
// recomputes distances; a radius change applies to Leads immediately.

import { useState, type ChangeEvent } from 'react';
import { Plus, MapPin, Power } from 'lucide-react';
import { Card } from '../ui';
import type { Office } from './types';
import { Banner, Chip, Spinner } from './ui';
import { queueJob, waitForJob } from '../../hooks/useLeadFinder';

type Form = {
  name: string; street: string; city: string; state: string; zip: string;
  radius_miles: string; manual_lat: string; manual_lon: string;
};

const blank = (radius: number): Form => ({
  name: '', street: '', city: '', state: '', zip: '', radius_miles: String(radius), manual_lat: '', manual_lon: '',
});
const fromOffice = (o: Office): Form => ({
  name: o.name, street: o.street, city: o.city, state: o.state, zip: o.zip,
  radius_miles: String(o.radius_miles), manual_lat: '', manual_lon: '',
});

export function OfficesTab({ offices, defaultRadius, onChanged }: {
  offices: Office[]; defaultRadius: number; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async (params: Record<string, unknown>, kind: 'office_save' | 'office_active' = 'office_save') => {
    setMsg(null);
    try {
      const job = await queueJob(kind, { params });
      const done = await waitForJob(job.id, 120_000);
      if (done.status === 'failed') { setMsg({ tone: 'error', text: done.error || 'Not saved.' }); return false; }
      setMsg({ tone: 'ok', text: (done.result?.message as string) || 'Saved.' });
      onChanged();
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      return false;
    }
  };

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="text-[13px] text-fg-2 m-0 max-w-2xl">
          The address is geocoded on save; check the matched address. If the geocoder misses or is off, enter a manual
          latitude/longitude. Changing a radius updates Leads immediately, no re-run needed.
        </p>
        {!adding && <button className="btn-orange flex-shrink-0" onClick={() => setAdding(true)}><Plus size={15} /> Add office</button>}
      </div>
      {msg && <div className="mb-4"><Banner tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Banner></div>}

      {adding && (
        <Card title="Add office" className="mb-4">
          <OfficeForm initial={blank(defaultRadius)} submitLabel="Add office"
            onCancel={() => setAdding(false)}
            onSubmit={async (f) => { if (await submit({ ...f })) setAdding(false); }} />
        </Card>
      )}

      <div className="space-y-3">
        {offices.map((o) => (
          <OfficeCard key={o.id} office={o}
            onSave={(f) => submit({ ...f, office_id: o.id })}
            onToggle={() => submit({ office_id: o.id, active: !o.active }, 'office_active')} />
        ))}
      </div>
    </div>
  );
}

function GeocodeChip({ o }: { o: Office }) {
  if (o.geocode_method === 'census_address') return <Chip tone="success">Census match</Chip>;
  if (o.geocode_method === 'manual') return <Chip tone="info">Manual</Chip>;
  if (o.geocode_method === 'zip_centroid') return <Chip tone="warn">ZIP centroid · approximate</Chip>;
  return <Chip tone="danger">Not located</Chip>;
}

function OfficeCard({ office: o, onSave, onToggle }: {
  office: Office; onSave: (f: Form) => Promise<boolean>; onToggle: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  return (
    <div className={`bg-white border border-border rounded-xl shadow-sm ${o.active ? '' : 'opacity-70'}`}>
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="w-9 h-9 rounded-lg bg-navy/[0.06] text-navy flex items-center justify-center flex-shrink-0"><MapPin size={17} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-navy">{o.name}</span>
            <GeocodeChip o={o} />
            {!o.active && <Chip>Inactive</Chip>}
            <span className="text-[13px] text-fg-2">· {o.radius_miles} mi radius</span>
          </div>
          <div className="text-[13px] text-fg-2 mt-0.5">{o.street}, {o.city}, {o.state} {o.zip}</div>
          <div className="text-xs text-fg-3 mt-0.5">
            Matched: {o.geocode_match || '—'}
            {o.lat != null && o.lon != null && <span className="font-mono"> ({o.lat.toFixed(5)}, {o.lon.toFixed(5)})</span>}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {!editing && <button className="btn-secondary" style={{ padding: '0.4rem 0.9rem', fontSize: 13 }} onClick={() => setEditing(true)}>Edit</button>}
          <button
            className="btn-secondary" style={{ padding: '0.4rem 0.9rem', fontSize: 13 }} disabled={toggling}
            onClick={async () => {
              if (o.active && !confirm(`Deactivate ${o.name}? Its leads drop out of "in range" and distances are recomputed.`)) return;
              setToggling(true); await onToggle(); setToggling(false);
            }}>
            {toggling ? <Spinner size={13} /> : <Power size={13} />} {o.active ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>
      </div>
      {editing && (
        <div className="px-5 pb-5 pt-1 border-t border-border-soft">
          <OfficeForm initial={fromOffice(o)} submitLabel="Save" latHint={o.lat} lonHint={o.lon}
            onCancel={() => setEditing(false)}
            onSubmit={async (f) => { if (await onSave(f)) setEditing(false); }} />
        </div>
      )}
    </div>
  );
}

function OfficeForm({ initial, submitLabel, onSubmit, onCancel, latHint, lonHint }: {
  initial: Form; submitLabel: string; onSubmit: (f: Form) => Promise<void>; onCancel: () => void;
  latHint?: number | null; lonHint?: number | null;
}) {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const field = (k: keyof Form, label: string, extra: Record<string, unknown> = {}) => (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3 mb-1">{label}</span>
      <input className="input" value={f[k]} onChange={set(k)} {...extra} />
    </label>
  );
  return (
    <form
      className="mt-3"
      onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSubmit(f); setBusy(false); }}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {field('name', 'Name', { required: true })}
        <div className="md:col-span-2">{field('street', 'Street', { required: true })}</div>
        {field('city', 'City', { required: true })}
        {field('state', 'State', { required: true, maxLength: 20 })}
        {field('zip', 'ZIP', { required: true, maxLength: 10 })}
        {field('radius_miles', 'Radius (mi)', { type: 'number', min: 5, max: 500, required: true })}
        <div />
        {field('manual_lat', 'Manual lat', { placeholder: latHint != null ? latHint.toFixed(5) : 'optional' })}
        {field('manual_lon', 'Manual lon', { placeholder: lonHint != null ? lonHint.toFixed(5) : 'optional' })}
      </div>
      <div className="flex gap-2.5 mt-4">
        <button type="submit" className="btn-primary" style={{ padding: '0.5rem 1rem' }} disabled={busy}>
          {busy && <Spinner size={14} />} {busy ? 'Geocoding…' : submitLabel}
        </button>
        <button type="button" className="btn-secondary" style={{ padding: '0.5rem 1rem' }} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
