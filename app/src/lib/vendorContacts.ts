// Pure helpers for the Vendor Contacts directory, ported from the original
// standalone Vendor Contacts.html. No DOM dependencies except parseSignature,
// which uses a throwaway element to strip HTML from pasted email signatures
// (always runs client-side).

export type CompanyType = 'manufacturer' | 'distributor' | 'rep' | 'other';

export interface VendorContact {
  id: string;
  company: string;
  companyType: CompanyType | null;
  repFor: string;            // comma-separated brands (reps / distributors)
  name: string;
  title: string;
  email: string;
  phone: string;
  website: string;
  role: string;              // "what they do for us"
  notes: string;
  technical: boolean;
  active: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Editable subset used by the add/edit form. */
export type VendorContactDraft = Omit<
  VendorContact,
  'id' | 'createdBy' | 'createdAt' | 'updatedAt'
>;

export function emptyDraft(): VendorContactDraft {
  return {
    company: '', companyType: 'manufacturer', repFor: '', name: '', title: '',
    email: '', phone: '', website: '', role: '', notes: '',
    technical: false, active: true,
  };
}

/* ---- Supabase row <-> contact mapping ---- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToContact(r: any): VendorContact {
  return {
    id: r.id,
    company: r.company ?? '',
    companyType: (r.company_type as CompanyType | null) ?? null,
    repFor: r.rep_for ?? '',
    name: r.name ?? '',
    title: r.title ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    website: r.website ?? '',
    role: r.role ?? '',
    notes: r.notes ?? '',
    technical: !!r.technical,
    active: r.active !== false,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

/** Maps a draft to a snake_case row for insert/update. */
export function draftToRow(d: VendorContactDraft) {
  return {
    company: d.company.trim(),
    company_type: d.companyType,
    rep_for: d.repFor.trim(),
    name: d.name.trim(),
    title: d.title.trim(),
    email: d.email.trim(),
    phone: normalizePhone(d.phone),
    website: cleanDomain(d.website) || domainFromEmail(d.email),
    role: d.role.trim(),
    notes: d.notes.trim(),
    technical: d.technical,
    active: d.active,
  };
}

/* ---- Domain / phone / logo utilities ---- */

export function cleanDomain(d: string): string {
  if (!d) return '';
  return d
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function domainFromEmail(email: string): string {
  if (!email) return '';
  const m = email.match(/@([\w-]+(?:\.[\w-]+)+)/);
  return m ? m[1].toLowerCase() : '';
}

export function normalizePhone(raw: string): string {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return String(raw).trim();
}

export function logoUrl(domain: string): string {
  const d = cleanDomain(domain);
  return d ? `https://logo.clearbit.com/${d}` : '';
}

export function fallbackLogoUrl(domain: string): string {
  const d = cleanDomain(domain);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : '';
}

export function initialsFor(company: string): string {
  if (!company) return '?';
  const words = company.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ---- Type labels ---- */

export const TYPE_LABELS: Record<CompanyType, string> = {
  manufacturer: 'Manufacturer',
  distributor: 'Distributor',
  rep: "Manufacturer's Rep",
  other: 'Other',
};

export function typeLabel(t: CompanyType | null): string {
  return t ? TYPE_LABELS[t] ?? '' : '';
}

/* ---- Search / sort / group ---- */

export function matchesSearch(c: VendorContact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    c.company, c.name, c.title, c.email, c.phone,
    c.role, c.notes, c.website, c.repFor, typeLabel(c.companyType),
  ].some((v) => (v || '').toLowerCase().includes(q));
}

export function sortContacts(list: VendorContact[]): VendorContact[] {
  return [...list].sort((a, b) => {
    const ca = (a.company || '').toLowerCase();
    const cb = (b.company || '').toLowerCase();
    if (ca !== cb) return ca.localeCompare(cb);
    // Empty names sort last
    if (!a.name && b.name) return 1;
    if (a.name && !b.name) return -1;
    return (a.name || '').localeCompare(b.name || '');
  });
}

export interface CompanyGroup {
  company: string;
  /** Domain used for the company logo (first member with a website). */
  domain: string;
  contacts: VendorContact[];
}

/** Groups a pre-sorted contact list by company, preserving company order. */
export function groupByCompany(sorted: VendorContact[]): CompanyGroup[] {
  const groups: CompanyGroup[] = [];
  const index = new Map<string, CompanyGroup>();
  for (const c of sorted) {
    const key = (c.company || '').toLowerCase();
    let g = index.get(key);
    if (!g) {
      g = { company: c.company, domain: '', contacts: [] };
      index.set(key, g);
      groups.push(g);
    }
    if (!g.domain && c.website) g.domain = c.website;
    g.contacts.push(c);
  }
  return groups;
}

/* ---- Signature parsing ---- */

export interface ParsedSignature {
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  website: string;
}

export function parseSignature(text: string): ParsedSignature | null {
  if (!text) return null;
  let t = text;
  if (/<[a-z][\s\S]*>/i.test(t) && typeof document !== 'undefined') {
    const div = document.createElement('div');
    div.innerHTML = t;
    t = div.innerText || div.textContent || '';
  }
  t = t.replace(/\u00a0/g, ' ').replace(/[\t\r]+/g, ' ');

  const junkLineRe = new RegExp(
    [
      '^(sent from|get outlook for|download outlook)',
      '^(on .* wrote:|from:|to:|cc:|bcc:|subject:|date:|sent:|reply-to:)',
      '^>',
      '(confidential|disclaimer|privileged|intended (only|recipient)|unsubscribe|do not reply)',
      '^(linkedin|twitter|facebook|instagram|youtube)([:.]| profile|$)',
      '(\\.com/in/|linkedin\\.com|twitter\\.com|facebook\\.com)',
      '^(book a (meeting|call)|schedule|calendly)',
      '(register now|learn more|click here|view (online|in browser))',
    ].join('|'),
    'i',
  );

  const rawLines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lines = rawLines.filter((l) => !junkLineRe.test(l));

  let workingLines = lines;
  if (lines.length === 1 && /\s\|\s/.test(lines[0])) {
    workingLines = lines[0].split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  }

  const emailMatch = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const email = emailMatch ? emailMatch[0].replace(/^mailto:/i, '') : '';

  const phoneRe = /(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/g;
  const phones: { raw: string; score: number; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = phoneRe.exec(t)) !== null) {
    const idx = m.index;
    const ctxBefore = t.slice(Math.max(0, idx - 30), idx).toLowerCase();
    const ctxAfter = t.slice(idx + m[0].length, idx + m[0].length + 20).toLowerCase();
    const ctx = ctxBefore + ' ' + ctxAfter;
    let score: number;
    if (/(mobile|cell|direct|m:|c:|d:)/.test(ctx)) score = 3;
    else if (/(office|tel|phone|o:|p:|t:)/.test(ctx)) score = 2;
    else if (/(fax|f:)/.test(ctx)) score = -2;
    else score = 1;
    phones.push({ raw: m[0], score, idx });
  }
  phones.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const phone = phones.length ? normalizePhone(phones[0].raw) : '';

  const decorationRe = /^(?:phone|tel|telephone|mobile|cell|direct|office|fax|email|e-mail|web|website|address|www|http)[: -]/i;
  const isContactLine = (l: string): boolean => {
    if (decorationRe.test(l)) return true;
    if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(l) && l.length < 60) return true;
    phoneRe.lastIndex = 0;
    if (phoneRe.test(l) && l.replace(phoneRe, '').replace(/[\s:|.-]/g, '').length < 6) return true;
    if (/^(www\.|https?:)/i.test(l)) return true;
    if (l.length > 0 && /^[\s\-_=*•·|]+$/.test(l)) return true;
    return false;
  };
  phoneRe.lastIndex = 0;

  const stripNameDecor = (s: string): string =>
    s
      .replace(/\s*\((?:he|she|they)[/ ](?:him|her|them)\)/i, '')
      .replace(/[,|]\s*(CTS(?:-[DI])?|MBA|PMP|PE|RCDD|CCNA|CCNP|MCSE|AVIXA)\s*$/i, '')
      .trim();

  const candidateLines = workingLines.filter((l) => !isContactLine(l) && l.length < 120);

  function looksLikeName(l: string): boolean {
    const stripped = stripNameDecor(l);
    const words = stripped.split(/\s+/);
    if (words.length < 2 || words.length > 5) return false;
    const capped = words.filter((w) => /^[A-Z][a-zA-Z'’\-.]+/.test(w)).length;
    return (
      capped >= Math.min(2, words.length) &&
      !/@|www\.|http|inc\.?|llc|corp/i.test(stripped) &&
      !/\d/.test(stripped)
    );
  }
  const corpRe = /\b(inc|llc|ltd|corp|corporation|company|co\.|technologies|technology|electronics|systems|solutions|av|audio|video|group|holdings|industries|partners|labs|media|networks?)\b/i;

  const domain = domainFromEmail(email);
  const domainStem = domain ? domain.split('.')[0].toLowerCase() : '';

  let name = '';
  let title = '';
  let company = '';

  const nameIdx = candidateLines.findIndex(looksLikeName);
  if (nameIdx >= 0) {
    name = stripNameDecor(candidateLines[nameIdx]);
    for (let i = nameIdx + 1; i < candidateLines.length; i++) {
      if (corpRe.test(candidateLines[i])) continue;
      title = candidateLines[i];
      break;
    }
    if (domainStem) {
      for (let i = 0; i < candidateLines.length; i++) {
        if (i === nameIdx) continue;
        if (candidateLines[i].toLowerCase().replace(/[^a-z0-9]/g, '').includes(domainStem)) {
          company = candidateLines[i];
          break;
        }
      }
    }
    if (!company) {
      for (let i = candidateLines.length - 1; i >= 0; i--) {
        if (corpRe.test(candidateLines[i])) {
          company = candidateLines[i];
          break;
        }
      }
    }
    if (!company) {
      const leftovers = candidateLines.filter((_, i) => i !== nameIdx && candidateLines[i] !== title);
      if (leftovers.length) company = leftovers[leftovers.length - 1];
    }
  } else if (candidateLines.length) {
    name = stripNameDecor(candidateLines[0]);
    if (candidateLines[1]) title = candidateLines[1];
    if (candidateLines[2]) company = candidateLines[2];
  }

  if (!company && domain) {
    const stem = domain.split('.')[0];
    company = stem.charAt(0).toUpperCase() + stem.slice(1);
  }

  const clean = (s: string): string =>
    s ? s.replace(/[|•·]+\s*$/, '').replace(/^[|•·-]+\s*/, '').trim() : '';

  return {
    name: clean(name),
    title: clean(title),
    company: clean(company),
    email: email.trim(),
    phone,
    website: domain,
  };
}
