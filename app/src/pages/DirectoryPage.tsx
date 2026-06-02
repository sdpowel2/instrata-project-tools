// Directory — shared vendor contacts list. Ported from the standalone
// Vendor Contacts.html into the app. Any signed-in user can add, edit,
// deactivate, or delete contacts; data lives in Supabase (vendor_contacts),
// not localStorage, and there's no admin gate or approval queue. This is the
// seed of a broader "Directory" area (client CRM may follow), hence the
// generic route name.

import { useEffect, useMemo, useState } from 'react';
import {
  Search, Plus, LayoutGrid, List as ListIcon, Eye, EyeOff, Mail, Phone,
  Globe, Pencil, Trash2, Power, Wand2, Loader2, AlertTriangle, Users,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import { Modal } from '../components/Modal';
import { VendorLogo } from '../components/VendorLogo';
import { EmptyState } from '../components/EmptyState';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  type VendorContact, type VendorContactDraft, type CompanyType,
  emptyDraft, rowToContact, draftToRow, parseSignature,
  matchesSearch, sortContacts, groupByCompany, typeLabel,
} from '../lib/vendorContacts';

type ViewMode = 'list' | 'card';
type ModalMode = 'view' | 'add' | 'edit';

export function DirectoryPage() {
  const { user } = useAuth();
  const configured = isSupabaseConfigured();

  const [contacts, setContacts] = useState<VendorContact[]>([]);
  // Only "loading" when there's a backend to load from; demo mode renders empty.
  const [loading, setLoading] = useState(isSupabaseConfigured());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [showInactive, setShowInactive] = useState(false);

  const [modalMode, setModalMode] = useState<ModalMode | null>(null);
  const [selected, setSelected] = useState<VendorContact | null>(null);

  // ---- Load ----
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('vendor_contacts')
        .select('*')
        .order('company', { ascending: true });
      if (cancelled) return;
      if (error) setLoadError(error.message);
      else setContacts((data ?? []).map(rowToContact));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [configured]);

  // ---- Derived ----
  const visible = useMemo(() => {
    const filtered = contacts.filter(
      (c) => (showInactive || c.active) && matchesSearch(c, search),
    );
    return sortContacts(filtered);
  }, [contacts, search, showInactive]);

  const groups = useMemo(() => groupByCompany(visible), [visible]);
  const activeCount = contacts.filter((c) => c.active).length;

  // ---- Mutations ----
  const openAdd = () => { setSelected(null); setModalMode('add'); };
  const openView = (c: VendorContact) => { setSelected(c); setModalMode('view'); };
  const closeModal = () => { setModalMode(null); setSelected(null); };

  async function handleSave(draft: VendorContactDraft, editingId: string | null) {
    const row = draftToRow(draft);
    if (editingId) {
      const { data, error } = await supabase
        .from('vendor_contacts')
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq('id', editingId)
        .select()
        .single();
      if (error) throw error;
      const updated = rowToContact(data);
      setContacts((prev) => prev.map((c) => (c.id === editingId ? updated : c)));
    } else {
      const { data, error } = await supabase
        .from('vendor_contacts')
        .insert({ ...row, created_by: user?.id ?? null })
        .select()
        .single();
      if (error) throw error;
      setContacts((prev) => [...prev, rowToContact(data)]);
    }
    closeModal();
  }

  async function setActive(c: VendorContact, active: boolean) {
    const { data, error } = await supabase
      .from('vendor_contacts')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', c.id)
      .select()
      .single();
    if (error) throw error;
    const updated = rowToContact(data);
    setContacts((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    setSelected(updated);
  }

  async function handleDelete(c: VendorContact) {
    const { error } = await supabase.from('vendor_contacts').delete().eq('id', c.id);
    if (error) throw error;
    setContacts((prev) => prev.filter((x) => x.id !== c.id));
    closeModal();
  }

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="Directory"
        title="Vendor Contacts"
        subtitle="Shared directory of manufacturer, distributor, and rep contacts. Anyone can add or update an entry."
        actions={
          <button className="btn-orange text-sm" onClick={openAdd} disabled={!configured}>
            <Plus size={16} /> Add Contact
          </button>
        }
      />

      {!configured && (
        <div className="flex items-center gap-2.5 p-3 mb-5 rounded-lg bg-status-warn-bg text-status-warn-fg text-sm">
          <AlertTriangle size={16} className="flex-shrink-0" />
          Supabase isn't configured — the directory is read-only in demo mode.
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[260px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, name, email, phone, brand…"
            className="input"
            style={{ paddingLeft: '2.25rem' }}
          />
        </div>

        <div className="inline-flex bg-surface border border-border rounded-lg p-0.5">
          <ToggleBtn active={view === 'list'} onClick={() => setView('list')}>
            <ListIcon size={15} /> List
          </ToggleBtn>
          <ToggleBtn active={view === 'card'} onClick={() => setView('card')}>
            <LayoutGrid size={15} /> Cards
          </ToggleBtn>
        </div>

        <button
          className={`btn-secondary text-sm ${showInactive ? '!border-navy text-navy' : ''}`}
          onClick={() => setShowInactive((v) => !v)}
        >
          {showInactive ? <EyeOff size={15} /> : <Eye size={15} />}
          {showInactive ? 'Hiding inactive' : 'Show inactive'}
        </button>
      </div>

      <div className="text-xs text-fg-2 mb-4">
        {loading ? 'Loading…' : `${visible.length} of ${activeCount} contacts`}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-fg-2">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : loadError ? (
        <div className="p-4 rounded-lg bg-status-danger-bg text-status-danger-fg text-sm">
          Failed to load contacts: {loadError}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Users size={40} />}
          title={search ? 'No matching contacts' : 'No contacts yet'}
          description={
            search
              ? 'Try a different search term.'
              : 'Add the first vendor contact to get started.'
          }
        />
      ) : view === 'list' ? (
        <div className="flex flex-col gap-3.5">
          {groups.map((g) => (
            <div key={g.company} className="bg-white border border-border rounded-xl overflow-hidden shadow-sm">
              <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-gradient-to-r from-navy/[0.04] to-transparent">
                <VendorLogo domain={g.domain} company={g.company} size={32} />
                <h3 className="text-[15px] font-bold text-navy m-0">{g.company}</h3>
                {g.contacts[0]?.companyType && (
                  <span className="text-[11px] text-fg-2">{typeLabel(g.contacts[0].companyType)}</span>
                )}
                <span className="ml-auto text-xs text-fg-2">
                  {g.contacts.length} {g.contacts.length === 1 ? 'contact' : 'contacts'}
                </span>
              </div>
              {g.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} onClick={() => openView(c)} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {visible.map((c) => (
            <ContactCard key={c.id} contact={c} onClick={() => openView(c)} />
          ))}
        </div>
      )}

      {/* Modal */}
      {modalMode === 'view' && selected && (
        <ContactViewModal
          contact={selected}
          configured={configured}
          onClose={closeModal}
          onEdit={() => setModalMode('edit')}
          onToggleActive={() => setActive(selected, !selected.active)}
          onDelete={() => handleDelete(selected)}
        />
      )}
      {(modalMode === 'add' || modalMode === 'edit') && (
        <ContactFormModal
          mode={modalMode}
          contact={modalMode === 'edit' ? selected : null}
          onClose={closeModal}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

/* ---------- Small pieces ---------- */

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
        active ? 'bg-navy text-white' : 'text-fg-2 hover:text-fg',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function TypeBadges({ contact }: { contact: VendorContact }) {
  return (
    <>
      {!contact.active && (
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-status-neutral-bg text-status-neutral-fg">
          Inactive
        </span>
      )}
      <span
        className={[
          'text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full',
          contact.technical ? 'bg-blue/10 text-blue' : 'bg-orange/10 text-orange-dark',
        ].join(' ')}
      >
        {contact.technical ? 'Technical' : 'Sales'}
      </span>
    </>
  );
}

function QuickPills({ contact }: { contact: VendorContact }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className="flex gap-1.5 flex-wrap">
      {contact.email && (
        <a href={`mailto:${contact.email}`} onClick={stop} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface text-[12px] text-fg hover:bg-navy hover:text-white transition-colors">
          <Mail size={12} /> Email
        </a>
      )}
      {contact.phone && (
        <a href={`tel:${contact.phone}`} onClick={stop} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface text-[12px] text-fg hover:bg-navy hover:text-white transition-colors">
          <Phone size={12} /> {contact.phone}
        </a>
      )}
    </div>
  );
}

function ContactRow({ contact, onClick }: { contact: VendorContact; onClick: () => void }) {
  const subtitle = [contact.role, contact.title].filter(Boolean).join(' · ');
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3.5 px-5 py-3 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface transition-colors ${contact.active ? '' : 'opacity-60'}`}
    >
      <div className={`w-[3px] self-stretch rounded ${contact.technical ? 'bg-blue' : 'bg-orange'}`} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-fg flex items-center gap-2">
          {contact.name || <span className="italic font-normal text-fg-3">No contact name</span>}
        </div>
        {subtitle && <div className="text-[12.5px] text-fg-2 truncate">{subtitle}</div>}
      </div>
      <QuickPills contact={contact} />
      <div className="flex gap-1.5 items-center"><TypeBadges contact={contact} /></div>
    </div>
  );
}

function ContactCard({ contact, onClick }: { contact: VendorContact; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`relative bg-white border border-border rounded-xl p-4 cursor-pointer shadow-sm hover:shadow-lg hover:border-navy hover:-translate-y-0.5 transition-all ${contact.active ? '' : 'opacity-60'}`}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${contact.technical ? 'bg-blue' : 'bg-orange'}`} />
      <div className="absolute top-3 right-3 flex gap-1.5"><TypeBadges contact={contact} /></div>
      <div className="flex items-center gap-3 mb-3">
        <VendorLogo domain={contact.website} company={contact.company} size={44} />
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-fg-2 font-semibold truncate">{contact.company}</div>
          <div className="text-base font-semibold text-fg truncate">
            {contact.name || <span className="italic font-normal text-fg-3">No contact name</span>}
          </div>
        </div>
      </div>
      {(contact.role || contact.title) && (
        <div className="text-[12.5px] text-fg-2 mb-3 line-clamp-2">
          {[contact.role, contact.title].filter(Boolean).join(' · ')}
        </div>
      )}
      <QuickPills contact={contact} />
    </div>
  );
}

/* ---------- View modal ---------- */

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="text-[11px] uppercase tracking-wide text-fg-2 font-semibold mb-1">{label}</div>
      <div className="text-sm text-fg">{children}</div>
    </div>
  );
}

function ContactViewModal({
  contact, configured, onClose, onEdit, onToggleActive, onDelete,
}: {
  contact: VendorContact;
  configured: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggleActive: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const brands = contact.repFor.split(',').map((b) => b.trim()).filter(Boolean);

  return (
    <Modal open onClose={onClose} title={contact.company} wide>
      <div className="flex items-start gap-3.5 pb-4 mb-4 border-b border-border">
        <VendorLogo domain={contact.website} company={contact.company} size={56} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-orange-dark font-bold mb-1">
            {typeLabel(contact.companyType) || contact.company}
          </div>
          <h2 className="text-xl font-bold text-navy m-0">
            {contact.name || <span className="italic font-normal text-fg-3 text-base">No contact name</span>}
          </h2>
          {contact.title && <div className="text-[13px] text-fg-2 mt-1">{contact.title}</div>}
        </div>
        <div className="flex flex-col items-end gap-1"><TypeBadges contact={contact} /></div>
      </div>

      <div>
        {contact.email && (
          <InfoRow label="Email">
            <a href={`mailto:${contact.email}`} className="text-navy hover:underline inline-flex items-center gap-1.5">
              <Mail size={14} /> {contact.email}
            </a>
          </InfoRow>
        )}
        {contact.phone && (
          <InfoRow label="Phone">
            <a href={`tel:${contact.phone}`} className="text-navy hover:underline inline-flex items-center gap-1.5">
              <Phone size={14} /> {contact.phone}
            </a>
          </InfoRow>
        )}
        {contact.website && (
          <InfoRow label="Website">
            <a href={`https://${contact.website}`} target="_blank" rel="noreferrer" className="text-navy hover:underline inline-flex items-center gap-1.5">
              <Globe size={14} /> {contact.website}
            </a>
          </InfoRow>
        )}
        {contact.role && <InfoRow label="What they do for us">{contact.role}</InfoRow>}
        {brands.length > 0 && (
          <InfoRow label={`Brands represented (${brands.length})`}>
            <div className="flex flex-wrap gap-1.5">
              {brands.map((b, i) => (
                <span key={i} className="px-2 py-0.5 rounded-full bg-surface text-[12px] text-fg">{b}</span>
              ))}
            </div>
          </InfoRow>
        )}
        {contact.notes && <InfoRow label="Notes"><span className="whitespace-pre-wrap">{contact.notes}</span></InfoRow>}
      </div>

      {err && <div className="mt-3 p-2.5 rounded-lg bg-status-danger-bg text-status-danger-fg text-sm">{err}</div>}

      <div className="flex items-center gap-2 pt-4 mt-4 border-t border-border">
        <button className="btn-secondary text-sm" onClick={onEdit} disabled={!configured || busy}>
          <Pencil size={14} /> Edit
        </button>
        <button className="btn-secondary text-sm" onClick={run(onToggleActive)} disabled={!configured || busy}>
          <Power size={14} /> {contact.active ? 'Deactivate' : 'Reactivate'}
        </button>
        <div className="ml-auto">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-fg-2">Delete permanently?</span>
              <button className="btn-secondary text-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</button>
              <button
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-status-danger-bg text-status-danger-fg hover:bg-red-200 disabled:opacity-50"
                onClick={run(onDelete)}
                disabled={busy}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
              </button>
            </div>
          ) : (
            <button
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-status-danger-fg hover:bg-status-danger-bg disabled:opacity-50"
              onClick={() => setConfirmDelete(true)}
              disabled={!configured || busy}
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Add / Edit form modal ---------- */

const TYPE_OPTIONS: { value: CompanyType; label: string }[] = [
  { value: 'manufacturer', label: 'Manufacturer' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'rep', label: "Mfg's Rep" },
  { value: 'other', label: 'Other' },
];

function ContactFormModal({
  mode, contact, onClose, onSave,
}: {
  mode: 'add' | 'edit';
  contact: VendorContact | null;
  onClose: () => void;
  onSave: (draft: VendorContactDraft, editingId: string | null) => Promise<void>;
}) {
  const [tab, setTab] = useState<'manual' | 'signature'>('manual');
  const [sig, setSig] = useState('');
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<VendorContactDraft>(() =>
    contact
      ? {
          company: contact.company, companyType: contact.companyType ?? 'manufacturer',
          repFor: contact.repFor, name: contact.name, title: contact.title,
          email: contact.email, phone: contact.phone, website: contact.website,
          role: contact.role, notes: contact.notes, technical: contact.technical,
          active: contact.active,
        }
      : emptyDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = <K extends keyof VendorContactDraft>(k: K, v: VendorContactDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const showRepFor = draft.companyType === 'distributor' || draft.companyType === 'rep';

  function runParse() {
    const parsed = parseSignature(sig);
    if (!parsed) { setParseMsg('Could not parse anything from that text.'); return; }
    setDraft((d) => ({
      ...d,
      name: parsed.name || d.name,
      title: parsed.title || d.title,
      company: parsed.company || d.company,
      email: parsed.email || d.email,
      phone: parsed.phone || d.phone,
      website: parsed.website || d.website,
    }));
    const found = [
      parsed.name && `name`, parsed.title && `title`, parsed.company && `company`,
      parsed.email && `email`, parsed.phone && `phone`,
    ].filter(Boolean);
    setParseMsg(found.length ? `Filled: ${found.join(', ')}. Review the details below.` : 'Nothing recognized.');
    setTab('manual');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.company.trim()) { setErr('Company is required.'); return; }
    setSaving(true); setErr(null);
    try {
      await onSave(draft, mode === 'edit' && contact ? contact.id : null);
    } catch (e2) {
      setErr((e2 as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={mode === 'edit' ? 'Edit Contact' : 'Add Contact'} wide>
      {mode === 'add' && (
        <div className="flex gap-1 border-b border-border mb-5 -mt-1">
          <FormTab active={tab === 'manual'} onClick={() => setTab('manual')}>Enter details</FormTab>
          <FormTab active={tab === 'signature'} onClick={() => setTab('signature')}>
            <Wand2 size={14} /> Paste signature
          </FormTab>
        </div>
      )}

      {mode === 'add' && tab === 'signature' ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-2">
            Paste an email signature and we'll pull out the name, title, company, email, and phone.
          </p>
          <textarea
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            rows={8}
            className="input"
            placeholder={'James Atkins\nRegional Director, Commercial - Southeast\nCrestron Electronics\n404.694.0768\njatkins@crestron.com'}
            autoFocus
          />
          {parseMsg && <div className="text-sm text-navy">{parseMsg}</div>}
          <button type="button" className="btn-primary text-sm" onClick={runParse} disabled={!sig.trim()}>
            <Wand2 size={15} /> Parse signature
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Company" required>
            <input className="input" value={draft.company} onChange={(e) => set('company', e.target.value)} placeholder="e.g. Crestron" autoFocus />
          </Field>

          <div>
            <FieldLabel>Company type</FieldLabel>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 bg-surface border border-border rounded-lg p-1">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('companyType', opt.value)}
                  className={[
                    'px-2 py-2 rounded-md text-[12.5px] font-medium transition-colors',
                    draft.companyType === opt.value ? 'bg-navy text-white' : 'text-fg-2 hover:text-fg',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {showRepFor && (
            <Field label="Brands they represent" hint="Comma-separated and searchable.">
              <input className="input" value={draft.repFor} onChange={(e) => set('repFor', e.target.value)} placeholder="e.g. Lightware, Meyer Sound, QSC" />
            </Field>
          )}

          <Field label="Contact name">
            <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. James Atkins" />
          </Field>

          <Field label="Title">
            <input className="input" value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Regional Director" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <input type="email" className="input" value={draft.email} onChange={(e) => set('email', e.target.value)} placeholder="name@company.com" />
            </Field>
            <Field label="Phone" hint="Auto-formatted">
              <input className="input" value={draft.phone} onChange={(e) => set('phone', e.target.value)} placeholder="xxx-xxx-xxxx" />
            </Field>
          </div>

          <Field label="Website / domain (for logo)" hint="Auto-detected from email if left blank.">
            <input className="input" value={draft.website} onChange={(e) => set('website', e.target.value)} placeholder="company.com" />
          </Field>

          <Field label="What they do for us">
            <input className="input" value={draft.role} onChange={(e) => set('role', e.target.value)} placeholder="e.g. Account rep, Pricing inquiries" />
          </Field>

          <Field label="Notes">
            <textarea className="input" rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Any extra context" />
          </Field>

          <label className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border cursor-pointer">
            <div>
              <div className="text-sm font-medium text-fg">{draft.technical ? 'Technical contact' : 'Non-technical contact'}</div>
              <div className="text-xs text-fg-2">{draft.technical ? 'Engineering / support' : 'Sales, account management'}</div>
            </div>
            <input type="checkbox" checked={draft.technical} onChange={(e) => set('technical', e.target.checked)} className="w-4 h-4 accent-navy" />
          </label>

          {err && <div className="p-2.5 rounded-lg bg-status-danger-bg text-status-danger-fg text-sm">{err}</div>}

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button type="button" className="btn-secondary text-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary text-sm disabled:opacity-50" disabled={saving || !draft.company.trim()}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add contact'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function FormTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
        active ? 'border-orange text-navy' : 'border-transparent text-fg-2 hover:text-navy',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wide text-fg-2 font-semibold mb-1.5">{children}</div>;
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <FieldLabel>{label}{required && <span className="text-status-danger-fg"> *</span>}</FieldLabel>
      {children}
      {hint && <div className="text-xs text-fg-2 mt-1">{hint}</div>}
    </label>
  );
}
