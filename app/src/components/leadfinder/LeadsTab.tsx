// Leads: the filtered, grouped list of candidate bids (lf_results), as a table
// or a map, with inline review and a CSV export that matches the screen.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Search, Download, SlidersHorizontal, Table2, Map as MapIcon, ExternalLink, RotateCcw, Radar } from 'lucide-react';
import { EmptyState } from '../EmptyState';
import type { LeadFilters, LeadRow, Office, ReviewStatus, Source } from './types';
import { BB_FILTERS, BB_LABEL, LANES, LANE_LABEL, REVIEWS, REVIEW_LABEL, SOURCE_LABEL, STATUSES } from './types';
import { daysUntil, defaultFilters, downloadText, fmtDate, fmtDateTime, fmtMoney, location, toCsv, todayEt } from './format';
import { Banner, Chip, LanePill, ReviewSelect, Spinner, Th } from './ui';
import { LeadsMap } from './LeadsMap';
import { setReview, useLeadResults } from '../../hooks/useLeadFinder';

const PAGE = 250;
const FILTER_KEY = 'leadfinder.filters.v1';

function loadFilters(): LeadFilters {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    if (raw) return { ...defaultFilters(), ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return defaultFilters();
}

export function LeadsTab({ offices, sources, onOpen, refreshKey = 0 }: {
  refreshKey?: number;
  offices: Office[];
  sources: Source[];
  onOpen: (id: string) => void;
}) {
  const [filters, setFiltersState] = useState<LeadFilters>(loadFilters);
  const [view, setView] = useState<'table' | 'map'>('table');
  const [search, setSearch] = useState('');
  const [more, setMore] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const { data, loading, error, setData, reload } = useLeadResults(filters);
  // A review saved in the drawer: refresh in place (keeps paging and scroll).
  useEffect(() => { if (refreshKey) void reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilters = (patch: Partial<LeadFilters>) => {
    setFiltersState((f) => {
      const next = { ...f, ...patch };
      try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setShown(PAGE);
  };
  const reset = () => {
    try { sessionStorage.removeItem(FILTER_KEY); } catch { /* ignore */ }
    setFiltersState(defaultFilters());
    setSearch('');
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.title, r.agency_name, r.solicitation_number, r.loc_city, r.loc_state, r.nearest_office, ...r.trades]
        .some((v) => v && v.toLowerCase().includes(q)));
  }, [data, search]);

  const stats = useMemo(() => {
    const valued = rows.filter((r) => r.est_value);
    return {
      total: rows.length,
      direct: rows.filter((r) => r.lane === 'direct_av').length,
      pursue: rows.filter((r) => r.review === 'pursue').length,
      fresh: rows.filter((r) => r.badge === 'New').length,
      dueWeek: rows.filter((r) => { const d = daysUntil(r.response_due_at); return d != null && d >= 0 && d <= 7; }).length,
      value: valued.reduce((s, r) => s + (r.est_value ?? 0), 0),
      valued: valued.length,
    };
  }, [rows]);

  const changeReview = async (row: LeadRow, status: ReviewStatus) => {
    const prev = row.review;
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...r, review: status } : r)) });
    try {
      await setReview(row.id, status);
    } catch (e) {
      setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...r, review: prev } : r)) });
      setSaveErr((e as Error).message);
    }
  };

  const exportCsv = () => downloadText(`AV-Lead-Finder_Leads_${todayEt()}.csv`, toCsv(rows));

  const activeOffices = offices.filter((o) => o.active);
  const nonDefault = JSON.stringify({ ...filters, due_after: null }) !== JSON.stringify({ ...defaultFilters(), due_after: null })
    || filters.due_after !== defaultFilters().due_after || !!search;

  return (
    <div>
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <Tile label="Leads" value={stats.total} onClick={() => setFilters({ review: '' })} />
        <Tile label="Direct AV" value={stats.direct} accent="#15803D" />
        <Tile label="Pursue" value={stats.pursue} accent="#E07A1A" onClick={() => setFilters({ review: filters.review === 'pursue' ? '' : 'pursue' })} active={filters.review === 'pursue'} />
        <Tile label="New since last run" value={stats.fresh} accent="#0072CE" onClick={() => setFilters({ changed: filters.changed === 'new' ? '' : 'new' })} active={filters.changed === 'new'} />
        <Tile label="Est. value" value={stats.valued ? fmtMoney(stats.value) : '—'} hint={stats.valued ? `${stats.valued} with a value` : undefined} />
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-border rounded-xl shadow-sm px-4 py-3 mb-4">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              className="input" style={{ paddingLeft: '2.25rem', paddingTop: '0.5rem', paddingBottom: '0.5rem' }}
              placeholder="Search title, agency, trade, city…" value={search} onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="input" style={{ width: 'auto', paddingTop: '0.5rem', paddingBottom: '0.5rem' }}
            value={filters.office_id} onChange={(e) => setFilters({ office_id: e.target.value })} aria-label="Office">
            <option value="">All offices</option>
            {activeOffices.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.radius_miles} mi)</option>)}
          </select>
          <div className="flex items-center gap-1" role="group" aria-label="Lanes">
            {LANES.map((l) => {
              const on = filters.lanes.includes(l);
              return (
                <button key={l} type="button"
                  onClick={() => setFilters({ lanes: on ? filters.lanes.filter((x) => x !== l) : [...filters.lanes, l] })}
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${on ? 'bg-navy text-white border-navy' : 'bg-white text-fg-2 border-border hover:border-navy hover:text-navy'}`}>
                  {LANE_LABEL[l]}
                </button>
              );
            })}
          </div>
          <select className="input" style={{ width: 'auto', paddingTop: '0.5rem', paddingBottom: '0.5rem' }}
            value={filters.review} onChange={(e) => setFilters({ review: e.target.value as LeadFilters['review'] })} aria-label="Review">
            <option value="">Any review</option>
            {REVIEWS.map((r) => <option key={r} value={r}>{REVIEW_LABEL[r]}</option>)}
          </select>
          <select className="input" style={{ width: 'auto', paddingTop: '0.5rem', paddingBottom: '0.5rem' }}
            value={filters.source} onChange={(e) => setFilters({ source: e.target.value })} aria-label="Source">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{SOURCE_LABEL[s.id] ?? s.name}</option>)}
          </select>
          <button type="button" onClick={() => setMore((m) => !m)}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg ${more ? 'bg-navy/[0.08] text-navy' : 'text-fg-2 hover:text-navy'}`}>
            <SlidersHorizontal size={13} /> More filters
          </button>
          {nonDefault && (
            <button type="button" onClick={reset} className="inline-flex items-center gap-1 text-xs font-semibold text-navy bg-navy/[0.06] hover:bg-navy/10 px-2.5 py-1.5 rounded-md">
              <RotateCcw size={12} /> Reset
            </button>
          )}
        </div>

        {more && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 mt-3 pt-3 border-t border-border-soft">
            <Field label="Office match">
              <select className="input" value={filters.office_mode} onChange={(e) => setFilters({ office_mode: e.target.value as LeadFilters['office_mode'] })}>
                <option value="in_range">In range of office</option>
                <option value="nearest">Office is nearest</option>
              </select>
            </Field>
            <Field label="Status">
              <select className="input" value={filters.status} onChange={(e) => setFilters({ status: e.target.value as LeadFilters['status'] })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                <option value="all">All</option>
              </select>
            </Field>
            <Field label="Due after">
              <input type="date" className="input" value={filters.due_after ?? ''} onChange={(e) => setFilters({ due_after: e.target.value || null })} />
            </Field>
            <Field label="Min score">
              <input type="number" min={0} max={100} className="input" value={filters.min_score}
                onChange={(e) => setFilters({ min_score: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Since last run">
              <select className="input" value={filters.changed} onChange={(e) => setFilters({ changed: e.target.value as LeadFilters['changed'] })}>
                <option value="">Any</option>
                <option value="new">New</option>
                <option value="updated">Updated</option>
                <option value="new_or_updated">New or updated</option>
              </select>
            </Field>
            <Field label="Bid Board state">
              <select className="input" value={filters.bb_status} onChange={(e) => setFilters({ bb_status: e.target.value })}>
                {BB_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-fg-2 self-end pb-2.5 cursor-pointer">
              <input type="checkbox" checked={filters.in_range_only} onChange={(e) => setFilters({ in_range_only: e.target.checked })} className="accent-navy" />
              In range only
            </label>
            <label className="flex items-center gap-2 text-[13px] text-fg-2 self-end pb-2.5 cursor-pointer">
              <input type="checkbox" checked={filters.location_unknown} onChange={(e) => setFilters({ location_unknown: e.target.checked })} className="accent-navy" />
              Include location unknown
            </label>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="inline-flex bg-white border border-border rounded-lg p-0.5">
          {([['table', Table2, 'Table'], ['map', MapIcon, 'Map']] as const).map(([v, Icon, label]) => (
            <button key={v} onClick={() => setView(v)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md ${view === v ? 'bg-navy text-white' : 'text-fg-2 hover:text-navy'}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <span className="text-[13px] text-fg-2">
          <strong className="text-navy">{rows.length.toLocaleString()}</strong> lead{rows.length === 1 ? '' : 's'}
          {data?.last_run && <> · New/Updated relative to the run of {fmtDateTime(data.last_run.started_at)}</>}
        </span>
        {loading && <Spinner size={14} className="text-orange" />}
        <span className="flex-1" />
        <button className="btn-secondary" style={{ padding: '0.45rem 0.9rem', fontSize: 13 }} onClick={exportCsv} disabled={!rows.length}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      {error && <div className="mb-3"><Banner tone="error">{error}</Banner></div>}
      {saveErr && <div className="mb-3"><Banner tone="error" onClose={() => setSaveErr(null)}>Review not saved: {saveErr}</Banner></div>}

      {view === 'map' ? (
        <>
          <LeadsMap rows={rows} offices={offices} selectedOfficeId={filters.office_id} onOpen={onOpen} />
          <p className="text-xs text-fg-3 mt-2">
            Pins by lane: <span style={{ color: '#15803D' }}>●</span> Direct AV <span style={{ color: '#E07A1A' }}>●</span> Likely AV scope <span style={{ color: '#8B8BA6' }}>●</span> None.
            Circles show each office's radius. {rows.filter((r) => r.lat == null).length} unlocated lead(s) aren't on the map.
          </p>
        </>
      ) : (
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-x-auto">
          {!loading && rows.length === 0 ? (
            <EmptyState
              icon={<Radar size={40} />}
              title="No leads match these filters"
              description={'Try more lanes, turn off "In range only", or run a fetch on the Run tab.'}
            />
          ) : (
            <table className="w-full min-w-[1180px]">
              <thead className="bg-navy text-white text-left text-[11px]">
                <tr>
                  <Th>Lane</Th>
                  <Th className="text-right">Score</Th>
                  <Th>Lead</Th>
                  <Th>Location</Th>
                  <Th>Nearest office</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Est. value</Th>
                  <Th>Source</Th>
                  <Th>Review</Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r, i) => (
                  <LeadTableRow key={r.id} r={r} zebra={i % 2 === 1} onOpen={onOpen} onReview={changeReview} />
                ))}
              </tbody>
            </table>
          )}
          {rows.length > shown && (
            <div className="px-5 py-3 border-t border-border-soft text-center">
              <button className="text-[13px] font-semibold text-navy hover:text-orange-dark" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown} remaining
              </button>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-fg-3 mt-4 max-w-4xl leading-relaxed">
        A lot of federal AV buying moves through GSA schedules and BPAs and never appears on SAM.gov.
        ZIP-centroid, city-centroid and agency-address locations are marked approximate; a county agency's bid can be 30+ miles from its office.
      </p>
    </div>
  );
}

function LeadTableRow({ r, zebra, onOpen, onReview }: {
  r: LeadRow; zebra: boolean; onOpen: (id: string) => void; onReview: (r: LeadRow, s: ReviewStatus) => void;
}) {
  const days = daysUntil(r.response_due_at);
  const dueTone = days == null ? 'text-fg-2' : days < 0 ? 'text-fg-3' : days <= 3 ? 'text-status-danger-fg font-semibold' : days <= 7 ? 'text-status-warn-fg font-semibold' : 'text-fg-2';
  return (
    <tr onClick={() => onOpen(r.id)}
      className={`cursor-pointer transition-colors border-t border-border-soft align-top ${zebra ? 'bg-surface/30 hover:bg-surface/60' : 'hover:bg-surface/60'}`}>
      <td className="px-4 py-3 whitespace-nowrap"><LanePill lane={r.lane} /></td>
      <td className="px-4 py-3 text-right font-mono text-[13px] text-navy font-semibold">{r.score}</td>
      <td className="px-4 py-3 max-w-[420px]">
        <div className="flex items-start gap-2">
          <span className="text-sm font-semibold text-fg leading-snug">{r.title}</span>
          {r.badge && <Chip tone={r.badge === 'New' ? 'info' : 'warn'}>{r.badge}</Chip>}
          {r.url && (
            <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
              className="text-fg-3 hover:text-navy mt-0.5 flex-shrink-0" title="Open listing">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
        <div className="text-[12px] text-fg-2 mt-0.5">
          {r.agency_name || '—'}
          {r.notices > 1 && (
            <span className="ml-1.5">
              <Chip>{r.source_id === 'buildingconnected' ? `${r.notices} invites${r.gcs > 1 ? ` · ${r.gcs} GCs` : ''}` : `${r.notices} notices`}</Chip>
            </span>
          )}
        </div>
        {r.trades.length > 0 && <div className="text-[11px] text-fg-3 mt-0.5">Trade{r.trades.length > 1 ? 's' : ''}: {r.trades.join(', ')}</div>}
        {r.solicitation_number && <div className="text-[11px] text-fg-3 font-mono mt-0.5">{r.solicitation_number}</div>}
      </td>
      <td className="px-4 py-3 text-[13px] text-fg-2 whitespace-nowrap">
        {location(r)}
        {(r.approximate || r.lat == null) && (
          <div className="text-[11px] text-status-warn-fg">{r.lat == null ? 'location unknown' : 'approximate'}</div>
        )}
      </td>
      <td className="px-4 py-3 text-[13px] text-fg-2 whitespace-nowrap">
        {r.nearest_office ?? '—'}
        {r.nearest_distance != null && <div className="text-[11px] text-fg-3">{r.nearest_distance.toFixed(1)} mi</div>}
      </td>
      <td className={`px-4 py-3 text-[13px] whitespace-nowrap ${dueTone}`}>
        {fmtDate(r.response_due_at)}
        {days != null && days >= 0 && <div className="text-[11px] font-normal text-fg-3">{days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}</div>}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[13px] text-fg-2 whitespace-nowrap">{r.est_value ? fmtMoney(r.est_value) : '—'}</td>
      <td className="px-4 py-3 text-[12px] text-fg-2 whitespace-nowrap">
        {SOURCE_LABEL[r.source_id] ?? r.source_id}
        {r.source_status && <div className="mt-0.5"><Chip>{BB_LABEL[r.source_status] ?? r.source_status}</Chip></div>}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <ReviewSelect compact value={r.review} onChange={(s) => onReview(r, s)} />
      </td>
    </tr>
  );
}

function Tile({ label, value, accent, hint, onClick, active }: {
  label: string; value: number | string; accent?: string; hint?: string; onClick?: () => void; active?: boolean;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className={`text-left bg-white border rounded-xl px-4 py-3 shadow-sm ${active ? 'border-navy ring-2 ring-navy/10' : 'border-border'} ${onClick ? 'hover:border-navy transition-colors cursor-pointer' : ''}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-0.5" style={{ color: accent ?? 'var(--color-navy)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="text-[11px] text-fg-3">{hint}</div>}
    </Tag>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3 mb-1">{label}</span>
      {children}
    </label>
  );
}
