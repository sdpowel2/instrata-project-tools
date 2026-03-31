import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, MinusCircle, MessageSquare, ChevronDown,
  ChevronUp, Clock, RefreshCw, ThumbsUp, AlertCircle, Info, Loader2,
  Upload, FileSpreadsheet, PlayCircle,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { parseCsv, mapRow } from '../utils/reviewEngine';
import { Modal } from '../components/Modal';
import type { ReviewFlag, ReviewFlagStatus, ReviewRunStatus } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<string, { bg: string; text: string; badge: string; icon: React.ElementType }> = {
  high:     { bg: 'bg-red-50 border-red-200',     text: 'text-red-800',    badge: 'bg-red-100 text-red-700',    icon: AlertCircle },
  moderate: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-800',  badge: 'bg-amber-100 text-amber-700', icon: AlertTriangle },
  low:      { bg: 'bg-blue-50 border-blue-200',   text: 'text-blue-800',   badge: 'bg-blue-100 text-blue-700',  icon: Info },
};

const STATUS_STYLE: Record<string, string> = {
  open:      'bg-gray-100 text-gray-600',
  resolved:  'bg-green-100 text-green-700',
  waived:    'bg-purple-100 text-purple-700',
  commented: 'bg-blue-100 text-blue-700',
};

const RUN_STATUS_LABEL: Record<ReviewRunStatus, string> = {
  pending_review:     'Pending Review',
  in_review:          'In Review',
  changes_requested:  'Changes Requested',
  quick_fix:          'Quick Fix',
  approved:           'Approved',
};

const RUN_STATUS_STYLE: Record<ReviewRunStatus, string> = {
  pending_review:    'bg-amber-100 text-amber-800',
  in_review:         'bg-blue-100 text-blue-800',
  changes_requested: 'bg-red-100 text-red-800',
  quick_fix:         'bg-purple-100 text-purple-800',
  approved:          'bg-green-100 text-green-800',
};

// ─── Flag Card ────────────────────────────────────────────────────────────────

function FlagCard({
  flag,
  onUpdateStatus,
}: {
  flag: ReviewFlag;
  onUpdateStatus: (id: string, status: ReviewFlagStatus, comment?: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(flag.status === 'open');
  const [commentText, setCommentText] = useState(flag.managerComment ?? '');
  const [saving, setSaving] = useState(false);
  const style = SEVERITY_STYLE[flag.severity];
  const SeverityIcon = style.icon;

  const save = async (status: ReviewFlagStatus, comment?: string) => {
    setSaving(true);
    await onUpdateStatus(flag.id, status, (comment ?? commentText) || undefined);
    setSaving(false);
  };

  return (
    <div className={`rounded-lg border ${style.bg} mb-2`}>
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-start gap-3 p-3 text-left"
      >
        <SeverityIcon size={16} className={`mt-0.5 flex-shrink-0 ${style.text}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-semibold uppercase tracking-wide ${style.text}`}>
              {flag.severity}
            </span>
            <span className="text-xs text-text-secondary">{flag.category}</span>
            {flag.diffStatus && (
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                flag.diffStatus === 'new' ? 'bg-orange/20 text-orange' :
                flag.diffStatus === 'recurring' ? 'bg-gray-200 text-gray-600' : ''
              }`}>
                {flag.diffStatus}
              </span>
            )}
            <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[flag.status]}`}>
              {flag.status}
            </span>
          </div>
          <div className="text-sm font-medium text-text-primary mt-0.5">{flag.flagName}</div>
          {flag.lineItemRef && (
            <div className="text-xs text-text-secondary mt-0.5 font-mono">{flag.lineItemRef}</div>
          )}
        </div>
        {expanded ? <ChevronUp size={14} className="text-text-secondary flex-shrink-0 mt-1" /> : <ChevronDown size={14} className="text-text-secondary flex-shrink-0 mt-1" />}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-black/5 pt-3">
          <p className="text-sm text-text-primary">{flag.description}</p>

          {/* Comment box */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Manager note</label>
            <textarea
              rows={2}
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Add a note for the record..."
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy resize-none"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {flag.status !== 'resolved' && (
              <button
                onClick={() => save('resolved')}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                <CheckCircle2 size={12} /> Resolve
              </button>
            )}
            {flag.status !== 'waived' && (
              <button
                onClick={() => save('waived')}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                <MinusCircle size={12} /> Waive
              </button>
            )}
            {commentText && flag.status === 'open' && (
              <button
                onClick={() => save('commented', commentText)}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <MessageSquare size={12} /> Save Note
              </button>
            )}
            {commentText && flag.status !== 'open' && (
              <button
                onClick={() => save(flag.status, commentText)}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-border text-text-primary rounded-lg hover:bg-surface disabled:opacity-50 transition-colors"
              >
                <MessageSquare size={12} /> Update Note
              </button>
            )}
            {flag.status !== 'open' && (
              <button
                onClick={() => save('open')}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-border text-text-secondary rounded-lg hover:bg-surface disabled:opacity-50 transition-colors"
              >
                Reopen
              </button>
            )}
            {saving && <Loader2 size={14} className="animate-spin text-text-secondary" />}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared CSV Drop Zone ─────────────────────────────────────────────────────

function CsvDropZone({
  dragOver, busy, busyLabel, emptyLabel, fileInputRef, onDragOver, onDragLeave, onDrop, onChange,
}: {
  dragOver:     boolean;
  busy:         boolean;
  busyLabel:    string;
  emptyLabel:   string;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onDragOver:   () => void;
  onDragLeave:  () => void;
  onDrop:       (file: File) => void;
  onChange:     (file: File) => void;
}) {
  return (
    <div
      onDragOver={e => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onDrop(f); }}
      onClick={() => !busy && fileInputRef.current?.click()}
      className={`relative border-2 border-dashed rounded-xl px-6 py-5 flex items-center gap-4 cursor-pointer transition-colors ${
        dragOver ? 'border-navy bg-navy/5' : 'border-border hover:border-navy/40 hover:bg-surface/50'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onChange(f); }}
      />
      {busy
        ? <Loader2 size={22} className="text-navy animate-spin flex-shrink-0" />
        : <FileSpreadsheet size={22} className={`flex-shrink-0 ${dragOver ? 'text-navy' : 'text-text-secondary/50'}`} />
      }
      <div>
        <p className="text-sm font-medium text-text-primary">
          {busy ? busyLabel : emptyLabel}
        </p>
        {!busy && <p className="text-xs text-text-secondary mt-0.5">Drag & drop or click to browse · .csv files only</p>}
      </div>
      {!busy && <Upload size={16} className="ml-auto text-text-secondary/40 flex-shrink-0" />}
    </div>
  );
}

// ─── Labor Rates Modal ────────────────────────────────────────────────────────

export interface ModalRate {
  labor_type:     string;
  cost_per_hour:  number;
  price_per_hour: number;
  hours_ceiling:  number | null;
}

function LaborRatesModal({
  open, rates, onClose, onRun, running,
}: {
  open: boolean;
  rates: ModalRate[];
  onClose: () => void;
  onRun: (rates: ModalRate[]) => void;
  running: boolean;
}) {
  const [local, setLocal] = useState<ModalRate[]>([]);

  useEffect(() => { setLocal(rates); }, [rates]);

  const update = (idx: number, field: 'cost_per_hour' | 'price_per_hour', val: string) => {
    const n = val !== '' ? parseFloat(val) : 0;
    setLocal(prev => prev.map((r, i) => i === idx ? { ...r, [field]: isNaN(n) ? 0 : n } : r));
  };

  return (
    <Modal open={open} onClose={onClose} title="Review Labor Rates Before Running" wide>
      <div>
        <p className="text-sm text-text-secondary mb-4">
          Rates are pre-populated from Settings. Adjust cost and price per hour for any
          union requirements or project-specific agreements, then hit <strong>Run Review</strong>.
        </p>

        {local.length === 0 ? (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-3 mb-4">
            No active labor rates found. Add them in <strong>Settings → Labor Rates</strong> first.
            The review will still run, but labor margin rules won't fire.
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-navy text-white text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Labor Type</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right w-32">Cost / hr</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right w-32">Price / hr</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center w-20">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {local.map((rate, idx) => {
                  const margin = rate.price_per_hour > 0
                    ? Math.round((rate.price_per_hour - rate.cost_per_hour) / rate.price_per_hour * 100)
                    : null;
                  const marginColor = margin === null
                    ? 'text-text-secondary'
                    : margin >= 30 ? 'text-green-700'
                    : margin >= 20 ? 'text-amber-600'
                    : 'text-red-600';

                  return (
                    <tr key={rate.labor_type} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
                      <td className="px-3 py-2 font-medium text-text-primary">{rate.labor_type}</td>

                      {/* Cost / hr */}
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-xs text-text-secondary">$</span>
                          <input
                            type="number"
                            defaultValue={rate.cost_per_hour || ''}
                            placeholder="0"
                            onBlur={e => update(idx, 'cost_per_hour', e.target.value)}
                            className="w-20 text-xs border border-border rounded px-2 py-1 text-right focus:outline-none focus:ring-1 focus:ring-navy/20"
                          />
                        </div>
                      </td>

                      {/* Price / hr */}
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-xs text-text-secondary">$</span>
                          <input
                            type="number"
                            defaultValue={rate.price_per_hour || ''}
                            placeholder="0"
                            onBlur={e => update(idx, 'price_per_hour', e.target.value)}
                            className="w-20 text-xs border border-border rounded px-2 py-1 text-right focus:outline-none focus:ring-1 focus:ring-navy/20"
                          />
                        </div>
                      </td>

                      {/* Margin */}
                      <td className={`px-3 py-2 text-center text-xs font-semibold ${marginColor}`}>
                        {margin !== null ? `${margin}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <button onClick={onClose} disabled={running} className="btn-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={() => onRun(local)}
            disabled={running}
            className="btn-primary text-sm flex items-center gap-2 disabled:opacity-60"
          >
            {running
              ? <><Loader2 size={14} className="animate-spin" /> Running review…</>
              : <><PlayCircle size={14} /> Run Review</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AutoReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { session, isAdmin } = useAuth();
  const reviewRuns = useStore(s => s.reviewRuns);
  const updateRunStatus = useStore(s => s.updateRunStatus);
  const updateFlagStatus = useStore(s => s.updateFlagStatus);
  const fetchProjectFlags = useStore(s => s.fetchProjectFlags);
  const createReviewRunFromCsv = useStore(s => s.createReviewRunFromCsv);

  const [flags, setFlags] = useState<ReviewFlag[]>([]);
  const [loadingFlags, setLoadingFlags] = useState(false);
  const [updatingRun, setUpdatingRun] = useState(false);

  // ── CSV Upload state ───────────────────────────────────────────────────────
  const [uploadDragOver, setUploadDragOver]     = useState(false);
  const [uploading, setUploading]               = useState(false);
  const [loadingRates, setLoadingRates]         = useState(false);
  const [uploadResult, setUploadResult]         = useState<{ flagCount: number } | null>(null);
  const [uploadError, setUploadError]           = useState<string | null>(null);
  const fileInputRef                            = useRef<HTMLInputElement>(null);

  // ── Labor Rates Modal state ────────────────────────────────────────────────
  const [pendingCsv, setPendingCsv]             = useState<{ text: string; name: string } | null>(null);
  const [showRatesModal, setShowRatesModal]     = useState(false);
  const [modalRates, setModalRates]             = useState<ModalRate[]>([]);

  // Get all runs for this project, most recent first
  const projectRuns = reviewRuns
    .filter(r => r.projectId === projectId)
    .sort((a, b) => b.runNumber - a.runNumber);

  const latestRun = projectRuns[0];

  const loadFlags = useCallback(async (runId: string) => {
    setLoadingFlags(true);
    const fetched = await fetchProjectFlags(runId);
    setFlags(fetched);
    setLoadingFlags(false);
  }, [fetchProjectFlags]);

  // Mark run as "in_review" when manager first opens it
  useEffect(() => {
    if (!latestRun) return;
    if (latestRun.status === 'pending_review') {
      updateRunStatus(latestRun.id, 'in_review', session?.user?.id);
    }
    loadFlags(latestRun.id);
  }, [latestRun?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFlagUpdate = async (flagId: string, status: ReviewFlagStatus, comment?: string) => {
    await updateFlagStatus(flagId, status, comment);
    setFlags(prev => prev.map(f => f.id === flagId ? {
      ...f, status,
      managerComment: comment !== undefined ? comment : f.managerComment,
    } : f));
  };

  const handleRunStatusChange = async (newStatus: ReviewRunStatus) => {
    if (!latestRun) return;
    setUpdatingRun(true);
    await updateRunStatus(latestRun.id, newStatus, session?.user?.id);
    setUpdatingRun(false);
  };

  // ── Phase 1: validate CSV + fetch rates → open modal ──────────────────────
  const handleCsvFile = useCallback(async (file: File) => {
    if (!projectId) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setUploadError('Please upload a .csv file.');
      return;
    }
    setUploadError(null);
    setUploadResult(null);

    // Quick local validation — make sure it's a D-Tools export with product rows
    const csvText = await file.text();
    const rows    = parseCsv(csvText).map(mapRow);
    if (!rows.some(r => r.itemType.toLowerCase() === 'product')) {
      setUploadError('No product rows found. Make sure this is a D-Tools AV Package Items export.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Fetch active labor rates to pre-populate the modal
    setLoadingRates(true);
    const { data: rateData, error: rateError } = await supabase
      .from('labor_rates')
      .select('labor_type, cost_per_hour, price_per_hour, hours_ceiling')
      .eq('is_active', true)
      .order('labor_type');
    setLoadingRates(false);

    if (rateError) {
      setUploadError(`Could not load labor rates: ${rateError.message}`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Stage the CSV and open the rates modal
    setPendingCsv({ text: csvText, name: file.name });
    setModalRates((rateData ?? []).map(r => ({
      labor_type:    r.labor_type,
      cost_per_hour:  r.cost_per_hour  ?? 0,
      price_per_hour: r.price_per_hour ?? 0,
      hours_ceiling:  r.hours_ceiling  ?? null,
    })));
    setShowRatesModal(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId]);

  // ── Phase 2: run review with (possibly edited) rates ──────────────────────
  const handleRunReview = useCallback(async (rates: ModalRate[]) => {
    if (!projectId || !pendingCsv) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const result = await createReviewRunFromCsv(projectId, pendingCsv.text, rates);
      setShowRatesModal(false);
      setUploadResult({ flagCount: result.flagCount });
      await loadFlags(result.runId);
    } catch (err: any) {
      setShowRatesModal(false);
      setUploadError(err?.message ?? 'Failed to process CSV. Please try again.');
    } finally {
      setUploading(false);
      setPendingCsv(null);
      setModalRates([]);
    }
  }, [projectId, pendingCsv, createReviewRunFromCsv, loadFlags]);

  // ── Counts ────────────────────────────────────────────────────────────────
  const counts = {
    high:     flags.filter(f => f.severity === 'high').length,
    moderate: flags.filter(f => f.severity === 'moderate').length,
    low:      flags.filter(f => f.severity === 'low').length,
    open:     flags.filter(f => f.status === 'open').length,
    resolved: flags.filter(f => f.status === 'resolved').length,
    waived:   flags.filter(f => f.status === 'waived').length,
  };

  const openHighCount = flags.filter(f => f.severity === 'high' && f.status === 'open').length;
  const canApprove    = openHighCount === 0 && counts.open === 0;
  const canApproveWithWarning = openHighCount === 0 && counts.open > 0;

  // ── Diff summary (resubmission) ───────────────────────────────────────────
  const diffNew       = flags.filter(f => f.diffStatus === 'new').length;
  const diffRecurring = flags.filter(f => f.diffStatus === 'recurring').length;
  const diffResolved  = flags.filter(f => f.diffStatus === 'resolved').length;
  const isResubmission = projectRuns.length > 1 && latestRun && (diffNew + diffRecurring + diffResolved) > 0;

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!isSupabaseConfigured()) {
    return (
      <div className="p-8 max-w-2xl">
        <EmptyReviewState message="Auto Review requires Supabase to be configured." />
      </div>
    );
  }

  if (!latestRun) {
    return (
      <div className="p-6 max-w-4xl">
        <LaborRatesModal
          open={showRatesModal}
          rates={modalRates}
          onClose={() => { setShowRatesModal(false); setPendingCsv(null); setModalRates([]); }}
          onRun={handleRunReview}
          running={uploading}
        />

        {/* Still show upload section even when no runs exist yet */}
        {isAdmin && (
          <div className="mb-5">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-2">
              Upload D-Tools Export
            </h2>
            <CsvDropZone
              dragOver={uploadDragOver}
              busy={uploading || loadingRates}
              busyLabel={loadingRates ? 'Loading labor rates…' : 'Processing CSV — running rules engine & rebuilding BoM…'}
              emptyLabel="Upload D-Tools CSV to start the first review run"
              fileInputRef={fileInputRef}
              onDragOver={() => setUploadDragOver(true)}
              onDragLeave={() => setUploadDragOver(false)}
              onDrop={file => { setUploadDragOver(false); handleCsvFile(file); }}
              onChange={handleCsvFile}
            />
            {uploadResult && !uploading && (
              <div className="mt-2 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
                <CheckCircle2 size={15} />
                Review run created — <span className="font-semibold">{uploadResult.flagCount} flag{uploadResult.flagCount !== 1 ? 's' : ''}</span> generated. BoM rebuilt.
              </div>
            )}
            {uploadError && (
              <div className="mt-2 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                <AlertCircle size={15} />
                {uploadError}
              </div>
            )}
          </div>
        )}
        <EmptyReviewState message={
          isAdmin
            ? 'No review runs yet. Upload the D-Tools CSV export above to run the first review and build the project BoM.'
            : 'No review has been run on this project yet. A manager will upload the D-Tools CSV to begin the review process.'
        } />
      </div>
    );
  }

  const grouped = {
    high:     flags.filter(f => f.severity === 'high'),
    moderate: flags.filter(f => f.severity === 'moderate'),
    low:      flags.filter(f => f.severity === 'low'),
  };

  return (
    <div className="p-6 max-w-4xl">

      <LaborRatesModal
        open={showRatesModal}
        rates={modalRates}
        onClose={() => { setShowRatesModal(false); setPendingCsv(null); setModalRates([]); }}
        onRun={handleRunReview}
        running={uploading}
      />

      {/* ── CSV Upload (admin only) ───────────────────────────────────────── */}
      {isAdmin && (
        <div className="mb-5">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-2">
            Upload D-Tools Export
          </h2>
          <CsvDropZone
            dragOver={uploadDragOver}
            busy={uploading || loadingRates}
            busyLabel={loadingRates ? 'Loading labor rates…' : 'Processing CSV — running rules engine & rebuilding BoM…'}
            emptyLabel={uploadDragOver ? 'Drop the CSV here' : 'Upload revised D-Tools CSV to start a new review run'}
            fileInputRef={fileInputRef}
            onDragOver={() => setUploadDragOver(true)}
            onDragLeave={() => setUploadDragOver(false)}
            onDrop={file => { setUploadDragOver(false); handleCsvFile(file); }}
            onChange={handleCsvFile}
          />

          {/* Upload result / error */}
          {uploadResult && !uploading && (
            <div className="mt-2 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
              <CheckCircle2 size={15} />
              Review run created — <span className="font-semibold">{uploadResult.flagCount} flag{uploadResult.flagCount !== 1 ? 's' : ''}</span> generated. BoM rebuilt.
            </div>
          )}
          {uploadError && (
            <div className="mt-2 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
              <AlertCircle size={15} />
              {uploadError}
            </div>
          )}
        </div>
      )}

      {/* Run header */}
      <div className="bg-white rounded-xl border border-border shadow-sm p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${RUN_STATUS_STYLE[latestRun.status]}`}>
                {RUN_STATUS_LABEL[latestRun.status]}
              </span>
              <span className="text-xs text-text-secondary">Run #{latestRun.runNumber}</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-text-secondary">
              <Clock size={13} />
              Triggered {new Date(latestRun.triggeredAt).toLocaleString()}
            </div>
          </div>

          {/* Manager actions */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {(latestRun.status === 'in_review' || latestRun.status === 'pending_review') && (
              <>
                <button
                  onClick={() => handleRunStatusChange('changes_requested')}
                  disabled={updatingRun}
                  className="flex items-center gap-1.5 text-sm px-3 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={14} /> Changes Requested
                </button>
                <button
                  onClick={() => handleRunStatusChange('approved')}
                  disabled={updatingRun || openHighCount > 0}
                  title={openHighCount > 0 ? `${openHighCount} open High flag(s) must be resolved before approving` : ''}
                  className="flex items-center gap-1.5 text-sm px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  <ThumbsUp size={14} />
                  {canApprove ? 'Approve' : canApproveWithWarning ? 'Approve (open flags remain)' : `Approve (${openHighCount} High open)`}
                </button>
              </>
            )}
            {latestRun.status === 'approved' && (
              <div className="flex items-center gap-1.5 text-green-700 text-sm font-medium">
                <CheckCircle2 size={16} /> Approved
              </div>
            )}
            {latestRun.status === 'changes_requested' && (
              <div className="flex items-center gap-1.5 text-red-700 text-sm font-medium">
                <RefreshCw size={14} /> Awaiting resubmission
              </div>
            )}
            {updatingRun && <Loader2 size={16} className="animate-spin text-text-secondary" />}
          </div>
        </div>

        {/* Flag summary badges */}
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
          <StatBadge label="High" count={counts.high} color="text-red-600" />
          <StatBadge label="Moderate" count={counts.moderate} color="text-amber-600" />
          <StatBadge label="Low" count={counts.low} color="text-blue-600" />
          <span className="ml-auto text-xs text-text-secondary">
            {counts.resolved} resolved · {counts.waived} waived · {counts.open} open
          </span>
        </div>
      </div>

      {/* Diff summary (resubmissions only) */}
      {isResubmission && (
        <div className="bg-navy/5 border border-navy/10 rounded-lg px-4 py-3 mb-5 text-sm">
          <span className="font-semibold text-navy mr-2">Resubmission diff:</span>
          {diffResolved > 0 && <span className="text-green-700 mr-3">{diffResolved} resolved</span>}
          {diffRecurring > 0 && <span className="text-gray-600 mr-3">{diffRecurring} recurring</span>}
          {diffNew > 0 && <span className="text-orange mr-3">{diffNew} new</span>}
          <span className="text-text-secondary ml-1">
            · Prior review: Run #{latestRun.runNumber - 1}
          </span>
        </div>
      )}

      {/* Flags */}
      {loadingFlags ? (
        <div className="flex items-center gap-2 text-text-secondary py-8 justify-center">
          <Loader2 size={18} className="animate-spin" /> Loading flags...
        </div>
      ) : flags.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">
          <CheckCircle2 size={32} className="mx-auto mb-3 text-green-500" />
          <p className="font-medium text-text-primary">No flags generated</p>
          <p className="text-sm mt-1">The CSV passed all rules checks.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {(['high', 'moderate', 'low'] as const).map(severity => {
            const group = grouped[severity];
            if (group.length === 0) return null;
            const style = SEVERITY_STYLE[severity];
            return (
              <section key={severity}>
                <h3 className={`text-xs font-bold uppercase tracking-widest mb-2 ${style.text}`}>
                  {severity} — {group.length} flag{group.length !== 1 ? 's' : ''}
                </h3>
                {group.map(flag => (
                  <FlagCard key={flag.id} flag={flag} onUpdateStatus={handleFlagUpdate} />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {/* Prior runs */}
      {projectRuns.length > 1 && (
        <div className="mt-8 pt-6 border-t border-border">
          <h3 className="text-sm font-semibold text-text-secondary mb-3">Review History</h3>
          <div className="space-y-1">
            {projectRuns.slice(1).map(run => (
              <div key={run.id} className="flex items-center justify-between text-sm px-3 py-2 bg-surface rounded-lg">
                <span className="text-text-secondary">Run #{run.runNumber}</span>
                <span className="text-text-secondary text-xs">{new Date(run.triggeredAt).toLocaleDateString()}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RUN_STATUS_STYLE[run.status]}`}>
                  {RUN_STATUS_LABEL[run.status]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-lg font-bold ${color}`}>{count}</span>
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  );
}

function EmptyReviewState({ message }: { message: string }) {
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm p-10 text-center">
      <Clock size={36} className="mx-auto mb-4 text-text-secondary" />
      <h2 className="text-base font-semibold text-text-primary mb-2">No Review Yet</h2>
      <p className="text-sm text-text-secondary max-w-sm mx-auto">{message}</p>
    </div>
  );
}
