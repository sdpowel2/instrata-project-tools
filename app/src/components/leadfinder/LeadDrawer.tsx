// Lead detail slide-over: review, bid documents, triage, Bid Board fields, why
// it matched, details, distances, notice history and the raw payload.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  ExternalLink, FileText, FileArchive, Upload, RefreshCw, Download, Sparkles, ShieldAlert, ChevronDown, FolderSync,
} from 'lucide-react';
import { Modal } from '../Modal';
import type { DocumentRow, Job, ReviewStatus, TriageRun, WorkerStatus } from './types';
import { BB_LABEL, LANE_LABEL, SOURCE_LABEL } from './types';
import { fmtBytes, fmtDate, fmtDateTime, fmtMoney, titleCase } from './format';
import { Banner, Chip, JobLine, KV, LanePill, RatingChip, ReviewSelect, SectionTitle, SlideOver, Spinner } from './ui';
import {
  documentUrl, queueJob, setReview, uploadDocuments, useLeadDetail, waitForJob, workerOnline,
} from '../../hooks/useLeadFinder';
import type { LeadDetail } from '../../hooks/useLeadFinder';

export function LeadDrawer({ id, onClose, onChanged, worker }: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
  worker: WorkerStatus | null;
}) {
  const { detail, loading, error, reload } = useLeadDetail(id);
  const opp = detail?.opp;
  return (
    <SlideOver
      open={!!id}
      onClose={onClose}
      title="Lead details"
      header={opp ? (
        <div>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            {detail?.score && <LanePill lane={detail.score.lane} />}
            {detail?.score && <span className="text-[13px] font-semibold text-navy">Score {detail.score.score}</span>}
            <Chip>{SOURCE_LABEL[opp.source_id] ?? opp.source_id}</Chip>
            {opp.source_status && <Chip tone="navy">{BB_LABEL[opp.source_status] ?? opp.source_status}</Chip>}
          </div>
          <h2 className="text-lg font-bold text-navy leading-snug m-0">{opp.title}</h2>
          <div className="text-[13px] text-fg-2 mt-1">
            {opp.agency_name || '—'} · due <span className="font-semibold text-fg">{fmtDateTime(opp.response_due_at)}</span>
          </div>
          <div className="flex gap-3 mt-2 text-[13px]">
            {opp.url && (
              <a href={opp.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-navy hover:text-orange-dark">
                <ExternalLink size={13} /> {opp.source_id === 'buildingconnected' ? 'Open in Bid Board' : 'Open listing'}
              </a>
            )}
            {opp.documents_url && (
              <a href={opp.documents_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-navy hover:text-orange-dark">
                <FileText size={13} /> Source documents
              </a>
            )}
          </div>
        </div>
      ) : <div className="h-14 flex items-center">{loading && <Spinner className="text-orange" />}</div>}
    >
      {error && <div className="mt-4"><Banner tone="error">{error}</Banner></div>}
      {detail && (
        <DrawerBody key={detail.opp.id} detail={detail} reload={reload} onChanged={onChanged} worker={worker} />
      )}
    </SlideOver>
  );
}

function DrawerBody({ detail, reload, onChanged, worker }: {
  detail: LeadDetail; reload: () => void; onChanged: () => void; worker: WorkerStatus | null;
}) {
  const { opp, score } = detail;
  const x = (opp.extra ?? {}) as Record<string, unknown>;
  // The interim worker has no persistent disk, so bid documents and triage are off there.
  const docsOff = worker?.documents_enabled === false;
  return (
    <>
      <ReviewBox detail={detail} documentsOn={!docsOff} onSaved={() => { reload(); onChanged(); }} />
      {docsOff ? (
        <>
          <SectionTitle>Documents &amp; triage</SectionTitle>
          <p className="text-[13px] text-fg-2 m-0">
            Bid documents and triage are switched off for now; they come back when the Lead Finder worker moves to
            the company server. Use {opp.url ? <a href={opp.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-navy hover:text-orange-dark">{opp.source_id === 'buildingconnected' ? 'Open in Bid Board' : 'Open listing'}</a> : 'the source listing'} for the package.
          </p>
        </>
      ) : (
        <>
          {!workerOnline(worker) && (
            <div className="mt-4">
              <Banner tone="warn">The Lead Finder worker hasn't checked in recently, so downloads, uploads and triage will wait until it's back.</Banner>
            </div>
          )}
          <DocumentsSection detail={detail} reload={reload} workerUrl={worker?.public_url ?? null} />
          <TriageSection detail={detail} worker={worker} />
        </>
      )}

      {opp.source_id === 'buildingconnected' && (
        <>
          <SectionTitle>Bid Board</SectionTitle>
          <KV rows={[
            ['Status', BB_LABEL[opp.source_status] ?? opp.source_status ?? '—'],
            ['Trade', (x.trade as string) || '—'],
            ['Invited by', <>{(x.gc as string) || opp.agency_name || '—'}{detail.history.length > 1 && <span className="text-fg-3 text-xs"> (+{detail.history.length - 1} more invite{detail.history.length > 2 ? 's' : ''}, below)</span>}</>],
            ['Est. value', <>{opp.est_value ? fmtMoney(opp.est_value) : '—'}{x.value_basis ? <span className="text-fg-3 text-xs"> ({String(x.value_basis)})</span> : null}</>],
            ['Project size', x.project_sqft ? `${Number(x.project_sqft).toLocaleString()} sq ft` : '—'],
            ['Market sector', titleCase(String(x.market_sector ?? '').replace(/_/g, ' ')) || '—'],
            ['Owner / tenant', `${(x.owner as string) || '—'}${x.tenant ? ` / ${x.tenant}` : ''}`],
            ['Architect', `${(x.architect as string) || '—'}${x.engineer ? ` · engineer: ${x.engineer}` : ''}`],
            ['Job walk', fmtDateTime(x.job_walk_at as string)],
            ['RFIs due', fmtDateTime(x.rfis_due_at as string)],
            ['Expected start', fmtDateTime(x.expected_start_at as string)],
            ...(x.priority || x.win_probability ? [['Priority / win %', `${x.priority || '—'} / ${x.win_probability ? `${x.win_probability}%` : '—'}`] as [string, string]] : []),
            ...(x.nda_required ? [['NDA', 'required'] as [string, string]] : []),
          ]} />
        </>
      )}

      {score && (
        <>
          <SectionTitle>Why it matched</SectionTitle>
          <KV rows={[
            ['Lane', LANE_LABEL[score.lane as keyof typeof LANE_LABEL]],
            ['Codes', (score.matched_codes ?? []).join(', ') || '—'],
            ['Keywords', (score.matched_keywords ?? []).join(', ') || '—'],
            ['Negative hits', (score.negative_hits ?? []).join(', ') || '—'],
            ['Scorer version', <span className="font-mono text-xs">{score.scorer_version}</span>],
          ]} />
        </>
      )}

      <SectionTitle>Details</SectionTitle>
      <KV rows={[
        ['Source', <span className="font-mono text-xs">{opp.source_id} · {opp.source_record_id}</span>],
        ['Solicitation #', opp.solicitation_number || '—'],
        ['Agency', opp.agency_name || '—'],
        ['Sub-agency', opp.sub_agency || '—'],
        ['Notice type', opp.notice_type],
        ['Status', opp.status],
        ['Posted', fmtDateTime(opp.posted_at)],
        ['Response due', fmtDateTime(opp.response_due_at)],
        ['NAICS', (opp.naics_codes ?? []).join(', ') || '—'],
        ['PSC', opp.psc_code || '—'],
        ['Set-aside', opp.set_aside || '—'],
        ['Contact', opp.contact_name || opp.contact_email || opp.contact_phone ? (
          <>
            {opp.contact_name || '—'}
            {opp.contact_email && <div><a className="text-navy hover:text-orange-dark" href={`mailto:${opp.contact_email}`}>{opp.contact_email}</a></div>}
            {opp.contact_phone && <div>{opp.contact_phone}</div>}
          </>
        ) : '—'],
        ['Location', (
          <>
            {[opp.loc_street, opp.loc_city, opp.loc_state, opp.loc_zip].filter(Boolean).join(', ') || '—'}
            <div className="text-[11px] text-fg-3">basis: {String(opp.location_basis).replace(/_/g, ' ')} · geocode: {String(opp.geocode_method).replace(/_/g, ' ')}</div>
          </>
        )],
        ['First seen', fmtDateTime(opp.first_seen_at)],
        ['Last changed', fmtDateTime(opp.last_changed_at)],
        ['Last seen', fmtDateTime(opp.last_seen_at)],
      ]} />

      {opp.description ? (
        <>
          <SectionTitle>Description</SectionTitle>
          <p className="text-[13px] text-fg leading-relaxed whitespace-pre-wrap m-0">{opp.description}</p>
        </>
      ) : opp.source_id === 'sam_gov' ? (
        <p className="text-xs text-fg-3 mt-4">Description not fetched (SAM.gov charges one API call per description; fetched only for in-range AV leads while budget remains).</p>
      ) : null}

      <SectionTitle>Distance to every office</SectionTitle>
      {detail.distances.length ? (
        <MiniTable head={['Office', 'Miles', 'Radius', '']} rows={detail.distances.map((d) => [
          d.office.name,
          <span className="font-mono">{d.distance_miles.toFixed(1)}</span>,
          <span className="font-mono">{d.office.radius_miles}</span>,
          <span className="flex gap-1">{d.distance_miles <= d.office.radius_miles && <Chip tone="success">in range</Chip>}{d.is_nearest && <Chip>nearest</Chip>}</span>,
        ])} />
      ) : <p className="text-[13px] text-fg-3 m-0">No location, so no distances.</p>}

      <SectionTitle>{opp.source_id === 'buildingconnected' ? 'Invites in this group' : 'Notice history'} ({detail.history.length})</SectionTitle>
      <MiniTable head={['Posted', 'Title', 'Due', 'Status']} rows={detail.history.map((h) => [
        fmtDate(h.posted_at),
        <>
          {h.url ? <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-navy hover:text-orange-dark">{h.title}</a> : h.title}
          {h.id === opp.id && <span className="ml-1.5"><Chip>this</Chip></span>}
          {h.source_id === 'buildingconnected' && (
            <div className="text-[11px] text-fg-3">{h.agency_name || '—'} · {h.extra?.trade || 'no trade'} · {BB_LABEL[h.source_status] ?? h.source_status ?? ''}</div>
          )}
        </>,
        fmtDate(h.response_due_at),
        h.status,
      ])} />

      {detail.duplicates.length > 0 && (
        <>
          <SectionTitle>Same bid from other sources</SectionTitle>
          <ul className="m-0 pl-5 text-[13px] space-y-1">
            {detail.duplicates.map((d) => (
              <li key={d.id}>{SOURCE_LABEL[d.source_id] ?? d.source_id}: <a className="text-navy hover:text-orange-dark" href={d.url} target="_blank" rel="noopener noreferrer">{d.title}</a></li>
            ))}
          </ul>
        </>
      )}

      <SectionTitle>Raw payload</SectionTitle>
      {detail.raw ? (
        <details className="group">
          <summary className="text-[13px] text-fg-2 cursor-pointer list-none inline-flex items-center gap-1">
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
            As published by {SOURCE_LABEL[opp.source_id] ?? opp.source_id} (fetched {fmtDateTime(detail.raw.fetched_at)})
          </summary>
          <pre className="mt-2 text-[11px] leading-relaxed font-mono bg-surface border border-border rounded-lg p-3 overflow-auto max-h-[420px]">{prettyJson(detail.raw.payload)}</pre>
        </details>
      ) : <p className="text-[13px] text-fg-3 m-0">None stored.</p>}
    </>
  );
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function MiniTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full text-[13px]">
        <thead className="bg-surface text-fg-3 text-left text-[11px] uppercase tracking-[0.05em]">
          <tr>{head.map((h, i) => <th key={i} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border-soft align-top">
              {r.map((c, j) => <td key={j} className="px-3 py-2 text-fg-2">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────

function ReviewBox({ detail, onSaved, documentsOn }: { detail: LeadDetail; onSaved: () => void; documentsOn: boolean }) {
  const [status, setStatus] = useState<ReviewStatus>(detail.review?.status ?? 'new');
  const [notes, setNotes] = useState(detail.review?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const dirty = status !== (detail.review?.status ?? 'new') || notes !== (detail.review?.notes ?? '');

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await setReview(detail.opp.id, status, notes);
      const pursueSam = documentsOn && status === 'pursue' && detail.review?.status !== 'pursue' && detail.opp.source_id === 'sam_gov';
      setMsg({ tone: 'ok', text: pursueSam ? 'Saved. SAM.gov attachments are being downloaded.' : 'Saved.' });
      onSaved();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 bg-surface/60 border border-border rounded-xl p-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-navy">Review</span>
        <ReviewSelect value={status} onChange={setStatus} />
        {detail.review?.reviewed_at && <span className="text-xs text-fg-3">last saved {fmtDateTime(detail.review.reviewed_at)}</span>}
      </div>
      <textarea className="input mt-3" rows={2} placeholder="Notes" value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex items-center gap-3 mt-3">
        <button className="btn-primary" style={{ padding: '0.5rem 1rem' }} disabled={busy || !dirty} onClick={save}>
          {busy && <Spinner size={14} />} Save review
        </button>
        {msg && <span className={`text-[13px] ${msg.tone === 'ok' ? 'text-status-success-fg' : 'text-status-danger-fg'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────

function liveJob(jobs: Job[], kinds: Job['kind'][]): Job | undefined {
  return jobs.find((j) => kinds.includes(j.kind) && (j.status === 'queued' || j.status === 'running'));
}

function DocumentsSection({ detail, reload, workerUrl }: { detail: LeadDetail; reload: () => void; workerUrl: string | null }) {
  const { opp, docs, documents, jobs } = detail;
  const fileInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<{ pct: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const samJob = liveJob(jobs, ['sam_docs']);
  const fileJob = liveJob(jobs, ['ingest_upload', 'rescan']);

  // Report the outcome of the latest finished document job once.
  const lastDone = jobs.find((j) => ['sam_docs', 'ingest_upload', 'rescan'].includes(j.kind) && (j.status === 'done' || j.status === 'failed'));
  const seen = useRef<string | null>(lastDone?.id ?? null);
  useEffect(() => {
    if (!lastDone || seen.current === lastDone.id) return;
    seen.current = lastDone.id;
    setMsg(lastDone.status === 'failed'
      ? { tone: 'error', text: lastDone.error || 'That didn\'t work.' }
      : { tone: 'ok', text: (lastDone.result?.message as string) || (lastDone.kind === 'sam_docs' ? `Downloaded ${lastDone.result?.downloaded ?? 0} attachment(s).` : 'Done.') });
  }, [lastDone]);

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    setMsg(null);
    setUploading({ pct: 0, total: files.length });
    try {
      await uploadDocuments(workerUrl, opp.id, files, (f) => setUploading({ pct: Math.round(f * 100), total: files.length }));
      reload();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const run = async (kind: 'sam_docs' | 'rescan', params: Record<string, unknown> = {}) => {
    setMsg(null);
    try { await queueJob(kind, { opportunityId: opp.id, params }); reload(); } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
  };

  const open = async (d: DocumentRow) => {
    // Open the tab now (inside the click) so the browser doesn't block it, then point it at the link.
    const w = window.open('about:blank', '_blank');
    try {
      const url = await documentUrl(workerUrl, opp.id, d.path);
      if (w) { w.opener = null; w.location.href = url; } else window.location.href = url;
    } catch (e) {
      w?.close();
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  };

  const visible = documents.filter((d) => !(d.is_zip && d.unpacked));
  const zips = documents.filter((d) => d.is_zip && d.unpacked);
  const samLinks = docs?.sam_links ?? 0;
  const samOk = docs?.sam_ok ?? 0;
  const prog = samJob?.progress as { total?: number; done?: number; failed?: number } | undefined;

  return (
    <>
      <SectionTitle action={docs?.count ? <span className="text-xs text-fg-3">{docs.count} file{docs.count === 1 ? '' : 's'} · {fmtBytes(docs.total_bytes)}</span> : undefined}>
        Documents
      </SectionTitle>
      {msg && <div className="mb-3"><Banner tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Banner></div>}

      {opp.source_id === 'sam_gov' && (
        <div className="text-[13px] text-fg-2 mb-3">
          {samJob ? (
            <JobLine job={samJob} label={`Downloading SAM.gov attachments${prog?.total ? ` (${prog.done ?? 0} of ${prog.total})` : ''}`} />
          ) : samLinks || detail.docs === null ? (
            <div className="flex items-center gap-3 flex-wrap">
              {detail.docs ? <span>SAM.gov attachments: <strong className="text-fg">{samOk} of {samLinks}</strong> downloaded.</span> : <span>SAM.gov attachments haven't been checked yet.</span>}
              {(!detail.docs || samOk < samLinks) ? (
                <button className="btn-secondary" style={{ padding: '0.35rem 0.8rem', fontSize: 12 }} onClick={() => run('sam_docs')}>
                  <Download size={13} /> Download {samOk ? 'the rest' : 'now'}
                </button>
              ) : (
                <button className="btn-secondary" style={{ padding: '0.35rem 0.8rem', fontSize: 12 }}
                  onClick={() => { if (confirm(`Download all ${samLinks} attachments again?`)) void run('sam_docs', { force: true }); }}>
                  <RefreshCw size={13} /> Re-download
                </button>
              )}
            </div>
          ) : <span className="text-fg-3">This notice has no attachments on SAM.gov.</span>}
          {detail.review?.status !== 'pursue' && !samOk && !samJob && (
            <p className="text-xs text-fg-3 mt-1.5 mb-0">Marking this lead Pursue downloads them automatically, and every run after that picks up attachments added by amendments.</p>
          )}
          {(docs?.sam_errors ?? []).map(([, e], i) => <div key={i} className="text-xs text-status-danger-fg mt-1">Attachment {i + 1} failed: {e}</div>)}
        </div>
      )}
      {opp.source_id === 'buildingconnected' && (
        <p className="text-[13px] text-fg-2 mb-3 mt-0">
          BuildingConnected has no API for invite files, so this step is by hand:{' '}
          {opp.url ? <a href={opp.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-navy hover:text-orange-dark">Open in Bid Board</a> : 'open it in Bid Board'}
          {' '}→ <strong>Files</strong> → <strong>Download all</strong>, then drop the zip below. It's unpacked automatically.
        </p>
      )}

      <div
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
        onClick={() => fileInput.current?.click()}
        className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed rounded-xl px-4 py-5 cursor-pointer transition-colors text-center ${drag ? 'border-orange bg-orange/[0.05]' : 'border-border hover:border-navy/40 bg-white'}`}
      >
        <input ref={fileInput} type="file" multiple hidden aria-label="Add bid documents"
          onChange={(e: ChangeEvent<HTMLInputElement>) => e.target.files && void addFiles(e.target.files)} />
        {uploading ? (
          <span className="inline-flex items-center gap-2 text-[13px] text-navy"><Spinner size={14} /> Uploading {uploading.total} file{uploading.total === 1 ? '' : 's'}… {uploading.pct}%</span>
        ) : fileJob ? (
          <JobLine job={fileJob} label={fileJob.kind === 'rescan' ? 'Rescanning' : 'Filing and unpacking the upload'} />
        ) : (
          <>
            <Upload size={18} className="text-fg-3" />
            <span className="text-[13px]"><strong className="text-navy">Drop files or a zip here</strong> <span className="text-fg-3">or click to choose</span></span>
          </>
        )}
      </div>

      {(docs?.unpack_errors ?? []).map(([rel, e]) => <div key={rel} className="text-xs text-status-danger-fg mt-1.5">Couldn't unpack {rel}: {e}</div>)}

      {visible.length > 0 ? (
        <details className="group mt-3" open={visible.length <= 25}>
          <summary className="text-[13px] text-fg-2 cursor-pointer list-none inline-flex items-center gap-1 mb-2">
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
            {visible.length} file{visible.length === 1 ? '' : 's'}
            {zips.length > 0 && ` (from ${zips.length} unpacked zip${zips.length === 1 ? '' : 's'})`}
            <button onClick={(e) => { e.preventDefault(); void run('rescan'); }} className="ml-3 inline-flex items-center gap-1 text-xs font-semibold text-navy hover:text-orange-dark" title="Unpack any zips that weren't unpacked yet">
              <FolderSync size={12} /> Rescan
            </button>
          </summary>
          <div className="border border-border rounded-lg divide-y divide-border-soft max-h-[320px] overflow-y-auto">
            {visible.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]">
                {d.is_zip ? <FileArchive size={14} className="text-fg-3 flex-shrink-0" /> : <FileText size={14} className="text-fg-3 flex-shrink-0" />}
                <button onClick={() => void open(d)} className="text-left text-navy hover:text-orange-dark truncate flex-1" title={d.path}>{d.path}</button>
                <span className="text-xs text-fg-3 font-mono flex-shrink-0">{fmtBytes(d.size)}</span>
              </div>
            ))}
          </div>
        </details>
      ) : !samJob && !fileJob && <p className="text-xs text-fg-3 mt-2 mb-0">No documents yet.</p>}
    </>
  );
}

// ── Triage ───────────────────────────────────────────────────────────────────

function TriageSection({ detail, worker }: { detail: LeadDetail; worker: WorkerStatus | null }) {
  const { opp, docs, triage, jobs } = detail;
  const [nda, setNda] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<TriageRun | null>(null);
  const job = liveJob(jobs, ['triage', 'triage_resume']);
  const needsNda = !!(opp.extra as Record<string, unknown> | null)?.nda_required;
  const budget = worker?.triage_budget_usd ?? 10;
  const count = docs?.count ?? 0;
  const failed = jobs.find((j) => (j.kind === 'triage') && j.status === 'failed');

  const start = async () => {
    setConfirmOpen(false);
    setErr(null);
    try {
      const j = await queueJob('triage', { opportunityId: opp.id, params: { nda_ok: nda } });
      void waitForJob(j.id).then((done) => { if (done.status === 'failed') setErr(done.error); }).catch(() => undefined);
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <SectionTitle>Triage</SectionTitle>
      {err && <div className="mb-3"><Banner tone="error" onClose={() => setErr(null)}>{err}</Banner></div>}
      {job ? (
        <div className="text-[13px] text-fg-2">
          <JobLine job={job} label={`Triage running${job.progress?.stage ? `: ${job.progress.stage}` : ''}`} />
          <div className="text-xs text-fg-3 mt-1">Usually 5–20 minutes. You can close this panel.
            {job.progress?.session_id && <> <a className="text-navy hover:text-orange-dark" href={`https://platform.claude.com/workspaces/default/sessions/${job.progress.session_id}`} target="_blank" rel="noopener noreferrer">Watch in the Claude Console</a></>}
          </div>
        </div>
      ) : worker && !worker.triage_configured ? (
        <p className="text-xs text-fg-3 m-0">Triage isn't set up on the worker (ANTHROPIC_API_KEY and the av-triage skill).</p>
      ) : count ? (
        <div className="flex items-center gap-3 flex-wrap">
          <button className="btn-orange" style={{ padding: '0.5rem 1rem' }} disabled={needsNda && !nda} onClick={() => setConfirmOpen(true)}>
            <Sparkles size={14} /> {triage.length ? 'Run triage again' : 'Run triage'}
          </button>
          <span className="text-xs text-fg-3">Runs the av-triage skill on these {count} files; capped at ${budget.toFixed(0)}.</span>
          {needsNda && (
            <label className="flex items-start gap-2 text-[13px] text-fg-2 w-full cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-navy" checked={nda} onChange={(e) => setNda(e.target.checked)} />
              <span><ShieldAlert size={13} className="inline text-status-warn-fg mr-1" />This invite has an NDA. I've checked it allows sending the documents to Anthropic.</span>
            </label>
          )}
        </div>
      ) : <p className="text-xs text-fg-3 m-0">Add documents to run the triage.</p>}
      {failed && !job && !err && triage[0]?.status !== 'done' && failed.error && (
        <p className="text-xs text-status-danger-fg mt-2 mb-0">Last attempt: {failed.error}</p>
      )}

      {triage.length > 0 && (
        <div className="mt-3 space-y-2">
          {triage.map((r) => (
            <div key={r.id} className="border border-border rounded-lg px-3.5 py-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                {r.status === 'done' ? (
                  <>
                    <RatingChip rating={r.rating} />
                    {r.tier && <Chip tone="navy">{r.tier}</Chip>}
                    {r.estimate && <strong className="text-[13px] text-fg">{r.estimate}</strong>}
                    {r.report_md && <button className="text-[13px] font-semibold text-navy hover:text-orange-dark ml-auto" onClick={() => setReport(r)}>Read report</button>}
                  </>
                ) : r.status === 'running' || r.status === 'uploading' ? (
                  <Chip tone="info">running</Chip>
                ) : (
                  <><Chip tone="danger">failed</Chip><span className="text-[13px] text-fg-2">{r.error}</span></>
                )}
              </div>
              {r.status === 'done' && <div className="text-xs text-fg-3 mt-1">Bid due: {r.bid_due || '—'} · RFIs due: {r.rfi_due || '—'}</div>}
              {r.summary && <div className="text-[13px] text-fg-2 whitespace-pre-wrap mt-1.5">{r.summary}</div>}
              <div className="text-[11px] text-fg-3 mt-1.5">
                {fmtDateTime(r.started_at)} · {r.files ?? '?'} files{r.cost_usd != null && ` · $${Number(r.cost_usd).toFixed(2)}`}
                {r.session_id && <> · <a className="text-navy hover:text-orange-dark" href={`https://platform.claude.com/workspaces/default/sessions/${r.session_id}`} target="_blank" rel="noopener noreferrer">session</a></>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Run triage?">
        <p className="text-sm text-fg-2 mt-0">
          Send {count} file{count === 1 ? '' : 's'} ({fmtBytes(docs?.total_bytes)}) to the Claude API and run the av-triage skill on them.
          The run is capped at ${budget.toFixed(0)} and the uploaded copies are deleted afterwards.
        </p>
        <div className="flex justify-end gap-2.5 mt-5">
          <button className="btn-secondary" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button className="btn-orange" onClick={() => void start()}><Sparkles size={14} /> Run triage</button>
        </div>
      </Modal>

      <Modal open={!!report} onClose={() => setReport(null)} title={`Triage: ${opp.title}`} wide>
        {report && (
          <>
            <p className="text-xs text-fg-3 mt-0">{fmtDateTime(report.started_at)} · {report.files} files{report.cost_usd != null && ` · $${Number(report.cost_usd).toFixed(2)}`}</p>
            <pre className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap bg-surface border border-border rounded-lg p-4 m-0">{report.report_md}</pre>
          </>
        )}
      </Modal>
    </>
  );
}
