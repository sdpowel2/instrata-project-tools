// Data access for the Lead Finder tab. Everything is read straight from the
// lf_* tables (admin-only RLS) and the lf_results() RPC; work the worker does
// (runs, document downloads, uploads, triage, office geocoding) is queued as
// lf_job rows. Realtime on lf_job / lf_lead_docs / lf_triage_run keeps the
// page current while the worker runs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import type {
  BcStatus, DocumentRow, Job, JobKind, LeadDocsSummary, LeadFilters, LeadResults, Office,
  ReviewStatus, RunRow, Source, TriageRun, WorkerStatus,
} from '../components/leadfinder/types';

function errText(e: unknown): string {
  if (!e) return 'Something went wrong.';
  if (typeof e === 'string') return e;
  const m = (e as { message?: string }).message;
  return m || 'Something went wrong.';
}

/** Re-run `fn` when any of these tables change (optionally only rows for one lead). */
function useRealtime(tables: string[], fn: () => void, opportunityId?: string | null) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; }, [fn]);
  const key = tables.join(',');
  useEffect(() => {
    if (opportunityId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => ref.current(), 250); };
    const ch = supabase.channel(`lf-${key}-${opportunityId ?? 'all'}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of key.split(',')) {
      ch.on('postgres_changes', {
        event: '*', schema: 'public', table,
        ...(opportunityId ? { filter: `opportunity_id=eq.${opportunityId}` } : {}),
      }, bump);
    }
    ch.subscribe();
    return () => { clearTimeout(timer); supabase.removeChannel(ch); };
  }, [key, opportunityId]);
}

/**
 * Load data with `fetcher`, again whenever `key` changes, and on reload().
 * State is only set in promise callbacks (the My Day hook's pattern); a
 * response from an older load is dropped.
 */
function useAsync<T>(fetcher: () => Promise<T>, initial: T, key: string) {
  const [data, setData] = useState<T>(initial);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback((k: string) => {
    const n = ++seq.current;
    fetcher().then(
      (d) => { if (n === seq.current) { setData(d); setError(null); setDoneKey(k); } },
      (e) => { if (n === seq.current) { setError(errText(e)); setDoneKey(k); } },
    );
  }, [fetcher]);
  useEffect(() => { run(key); }, [run, key]);
  const reload = useCallback(() => run(key), [run, key]);
  return { data, setData, error, loading: doneKey !== key, reload };
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw error;
  return data as T;
}

// ── Leads ────────────────────────────────────────────────────────────────────

export function useLeadResults(filters: LeadFilters) {
  const body = JSON.stringify(filters);
  const fetcher = useCallback(
    () => rows<LeadResults>(supabase.rpc('lf_results', { p: JSON.parse(body) })),
    [body],
  );
  const r = useAsync<LeadResults | null>(fetcher, null, body);
  return { data: r.data, loading: r.loading, error: r.error, reload: r.reload, setData: r.setData };
}

export async function setReview(opportunityId: string, status: ReviewStatus, notes?: string | null) {
  const row: Record<string, unknown> = {
    opportunity_id: opportunityId, status, reviewed_at: new Date().toISOString(),
  };
  if (notes !== undefined) row.notes = notes?.trim() || null;
  const { error } = await supabase.from('lf_lead_review').upsert(row, { onConflict: 'opportunity_id' });
  if (error) throw new Error(errText(error));
}

// ── One lead (the drawer) ────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LeadDetail {
  opp: any;
  score: any | null;
  review: { status: ReviewStatus; notes: string | null; reviewed_at: string | null } | null;
  distances: { office: Office; distance_miles: number; is_nearest: boolean }[];
  history: any[];
  duplicates: any[];
  raw: { payload: string; fetched_at: string } | null;
  docs: LeadDocsSummary | null;
  documents: DocumentRow[];
  triage: TriageRun[];
  jobs: Job[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchLeadDetail(id: string): Promise<LeadDetail> {
  const opp = await rows<LeadDetail['opp'] | null>(supabase
    .from('lf_opportunity')
    .select('*, lf_opportunity_score(*), lf_lead_review(status, notes, reviewed_at)')
    .eq('id', id)
    .maybeSingle());
  if (!opp) throw new Error('Lead not found.');
  const [dist, hist, dupes, raw, docs, files, tri, jobs] = await Promise.all([
    supabase.from('lf_office_distance').select('distance_miles, is_nearest, lf_office(*)').eq('opportunity_id', id),
    supabase.from('lf_opportunity')
      .select('id, title, url, posted_at, response_due_at, status, source_id, agency_name, source_status, extra')
      .eq('group_key', opp.group_key).order('posted_at', { ascending: false, nullsFirst: false }),
    supabase.from('lf_opportunity').select('id, title, url, source_id').eq('duplicate_of', id),
    supabase.from('lf_raw_record').select('payload, fetched_at')
      .eq('source_id', opp.source_id).eq('source_record_id', opp.source_record_id)
      .order('fetched_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('lf_lead_docs').select('summary').eq('opportunity_id', id).maybeSingle(),
    supabase.from('lf_document').select('id, path, size, is_zip, unpacked').eq('opportunity_id', id).order('path'),
    supabase.from('lf_triage_run').select('*').eq('opportunity_id', id).order('started_at', { ascending: false }),
    supabase.from('lf_job').select('*').eq('opportunity_id', id).order('created_at', { ascending: false }).limit(20),
  ]);
  const firstErr = [dist, hist, dupes, raw, docs, files, tri, jobs].find((r) => r.error)?.error;
  if (firstErr) throw firstErr;
  const score = Array.isArray(opp.lf_opportunity_score) ? opp.lf_opportunity_score[0] : opp.lf_opportunity_score;
  const review = Array.isArray(opp.lf_lead_review) ? opp.lf_lead_review[0] : opp.lf_lead_review;
  return {
    opp,
    score: score ?? null,
    review: review ?? null,
    distances: ((dist.data ?? []) as unknown as { distance_miles: number; is_nearest: boolean; lf_office: Office }[])
      .filter((d) => d.lf_office?.active)
      .map((d) => ({ office: d.lf_office, distance_miles: d.distance_miles, is_nearest: d.is_nearest }))
      .sort((a, b) => a.distance_miles - b.distance_miles),
    history: hist.data ?? [],
    duplicates: dupes.data ?? [],
    raw: raw.data ?? null,
    docs: (docs.data?.summary as LeadDocsSummary) ?? null,
    documents: (files.data ?? []) as DocumentRow[],
    triage: (tri.data ?? []) as TriageRun[],
    jobs: (jobs.data ?? []) as Job[],
  };
}

export function useLeadDetail(id: string | null) {
  const fetcher = useCallback(() => (id ? fetchLeadDetail(id) : Promise.resolve(null)), [id]);
  const r = useAsync<LeadDetail | null>(fetcher, null, id ?? '');
  useRealtime(['lf_job', 'lf_lead_docs', 'lf_triage_run'], r.reload, id);
  // Never show the previous lead while the next one loads.
  const detail = r.data && id && r.data.opp.id === id ? r.data : null;
  return { detail, loading: !!id && r.loading, error: id ? r.error : null, reload: r.reload };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function queueJob(kind: JobKind, opts: { opportunityId?: string; params?: Record<string, unknown> } = {}) {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('lf_job')
    .insert({ kind, opportunity_id: opts.opportunityId ?? null, params: opts.params ?? {}, requested_by: u.user?.id })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('That is already queued or running.');
    throw new Error(errText(error));
  }
  return data as Job;
}

/** Resolve when the worker finishes a job (realtime, with a polling fallback). */
export function waitForJob(id: string, timeoutMs = 10 * 60_000): Promise<Job> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (j: Job | null, err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(limit);
      supabase.removeChannel(ch);
      if (err) reject(err); else resolve(j as Job);
    };
    const check = async () => {
      const { data } = await supabase.from('lf_job').select('*').eq('id', id).maybeSingle();
      if (data && (data.status === 'done' || data.status === 'failed')) finish(data as Job);
    };
    const ch = supabase.channel(`lf-job-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lf_job', filter: `id=eq.${id}` }, (p) => {
        const j = p.new as Job;
        if (j.status === 'done' || j.status === 'failed') finish(j);
      })
      .subscribe();
    const poll = setInterval(check, 3000);
    const limit = setTimeout(() => finish(null, new Error('The worker has not picked this up. Is it running?')), timeoutMs);
    void check();
  });
}

export function useJobs(kinds?: JobKind[], limit = 30) {
  const kindKey = (kinds ?? []).join(',');
  const fetcher = useCallback(() => {
    let q = supabase.from('lf_job').select('*').order('created_at', { ascending: false }).limit(limit);
    if (kindKey) q = q.in('kind', kindKey.split(','));
    return rows<Job[]>(q);
  }, [kindKey, limit]);
  const r = useAsync<Job[]>(fetcher, [], `${kindKey}|${limit}`);
  useRealtime(['lf_job'], r.reload);
  return { jobs: r.data ?? [], reload: r.reload };
}

// ── Documents ────────────────────────────────────────────────────────────────

// Bid documents live on the worker's volume (not Supabase Storage), so uploads and
// downloads go to the worker, authenticated with the signed-in admin's token.

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in again first.');
  return token;
}

function workerBase(workerUrl: string | null | undefined): string {
  if (!workerUrl) throw new Error("The Lead Finder worker hasn't reported its address yet. Is it running?");
  return workerUrl.replace(/\/$/, '');
}

/** Upload files to the worker (with byte progress); it files them, unzipping zips, as a queued job. */
export async function uploadDocuments(
  workerUrl: string | null | undefined, opportunityId: string, files: File[],
  onProgress?: (fraction: number) => void,
): Promise<{ job_id: string }> {
  const url = `${workerBase(workerUrl)}/documents/${encodeURIComponent(opportunityId)}/upload`;
  const token = await accessToken();
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error("Couldn't reach the Lead Finder worker."));
    xhr.onload = () => {
      let body: { job_id?: string; error?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.job_id) resolve({ job_id: body.job_id });
      else reject(new Error(body.error || `The worker answered HTTP ${xhr.status}.`));
    };
    xhr.send(form);
  });
}

/** A 5-minute signed link to one document on the worker. PDFs and images open in the browser. */
export async function documentUrl(workerUrl: string | null | undefined, opportunityId: string, path: string) {
  const inline = /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(path);
  const res = await fetch(`${workerBase(workerUrl)}/documents/${encodeURIComponent(opportunityId)}/link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, inline }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error || `The worker answered HTTP ${res.status}.`);
  return body.url as string;
}

// ── Offices, sources, runs, settings ─────────────────────────────────────────

export function useOffices() {
  const fetcher = useCallback(() => rows<Office[]>(supabase.from('lf_office').select('*').order('name')), []);
  const r = useAsync<Office[]>(fetcher, [], 'offices');
  return { offices: r.data ?? [], loading: r.loading, reload: r.reload };
}

export function useSources() {
  const fetcher = useCallback(() => rows<Source[]>(supabase.from('lf_source').select('*').order('id')), []);
  const r = useAsync<Source[]>(fetcher, [], 'sources');
  return { sources: r.data ?? [], reload: r.reload };
}

export async function updateSource(id: string, patch: Partial<Pick<Source, 'enabled' | 'daily_call_budget'>>) {
  const { error } = await supabase.from('lf_source').update(patch).eq('id', id);
  if (error) throw new Error(errText(error));
}

export function useRuns(limit = 100) {
  const fetcher = useCallback(() => rows<RunRow[]>(supabase.from('lf_run').select('*, lf_source_run(*)')
    .order('started_at', { ascending: false }).limit(limit)), [limit]);
  const r = useAsync<RunRow[]>(fetcher, [], `runs${limit}`);
  useRealtime(['lf_job'], r.reload);
  return { runs: r.data ?? [], loading: r.loading, reload: r.reload };
}

export function useSettings() {
  const fetcher = useCallback(async () => {
    const data = await rows<{ key: string; value: unknown }[]>(supabase.from('lf_setting').select('key, value'));
    return Object.fromEntries(data.map((x) => [x.key, x.value])) as Record<string, unknown>;
  }, []);
  const r = useAsync<Record<string, unknown>>(fetcher, {}, 'settings');
  // The worker heartbeat lands every minute; pick it up without a reload.
  useEffect(() => {
    const t = setInterval(r.reload, 60_000);
    return () => clearInterval(t);
  }, [r.reload]);
  const values = r.data ?? {};
  return {
    loaded: !r.loading,
    reload: r.reload,
    defaultRadius: Number(values.default_radius_miles ?? 100),
    worker: (values.worker_status as WorkerStatus | undefined) ?? null,
    bc: (values.bc_status as BcStatus | undefined) ?? null,
  };
}

export async function saveSetting(key: string, value: unknown) {
  const { error } = await supabase.from('lf_setting').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(errText(error));
}

/** Worker heartbeat is at most ~1 min old when it's up. */
export function workerOnline(w: WorkerStatus | null): boolean {
  return !!w && Date.now() - new Date(w.heartbeat_at).getTime() < 5 * 60_000;
}

export async function startBuildingConnectedConnect(workerUrl: string) {
  const res = await fetch(`${workerBase(workerUrl)}/bc/authorize`, {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error || `The worker answered HTTP ${res.status}.`);
  window.location.href = body.url as string;
}
