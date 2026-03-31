// ─── CSVImportModal ───────────────────────────────────────────────────────────
// Accepts a D-Tools "AV Package Items" CSV export and auto-maps every column.
// No manual column mapping required — headers are matched exactly.
//
// Flow: Upload → Review & Import  (2 steps)

import { useState, useCallback, useRef } from 'react';
import { Upload, FileSpreadsheet, ChevronRight, ChevronLeft, AlertCircle, Check, X as XIcon } from 'lucide-react';
import { Modal } from './Modal';
import { parseCsv, mapRow, inferCategory } from '../utils/reviewEngine';
import type { ItemCategory } from '../utils/reviewEngine';
import type { SubmittalItemLocation } from '../types';

export interface ImportedItem {
  manufacturer: string;
  model:        string;
  description:  string;
  category:     ItemCategory;
  qty:          number;
  notes:        string;
  locations:    SubmittalItemLocation[];
  cutSheetFile?: File;
  cutSheetName?: string;
}

interface CSVImportModalProps {
  open:     boolean;
  onClose:  () => void;
  onImport: (items: ImportedItem[]) => void;
}

type Step = 'upload' | 'review';

// ─── Consolidation ────────────────────────────────────────────────────────────
// Groups Product rows by manufacturer + model, sums qty, tracks locations.
// Skips Labor rows, S&H, and MISC placeholder rows.

function consolidateItems(csvText: string): { items: ImportedItem[]; rowCount: number; skipped: number } {
  const rawRows = parseCsv(csvText);
  const rows    = rawRows.map(mapRow);

  const productRows = rows.filter(r => r.itemType.toLowerCase() === 'product');
  const skipped     = rows.length - productRows.length;

  const map = new Map<string, ImportedItem>();

  for (const r of productRows) {
    if (r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
    if (!r.manufacturer && !r.modelNumber) continue;

    const key      = `${r.manufacturer.toLowerCase()}|||${r.modelNumber.toLowerCase()}`;
    const qty      = r.quantity ?? 1;
    const location = r.location && r.location !== 'Labor and Services' ? r.location : '';
    const existing = map.get(key);

    if (existing) {
      existing.qty += qty;
      if (location) {
        const loc = existing.locations.find(l => l.room === location);
        if (loc) loc.qty += qty;
        else existing.locations.push({ room: location, qty });
      }
    } else {
      map.set(key, {
        manufacturer: r.manufacturer,
        model:        r.modelNumber,
        description:  r.description,
        category:     inferCategory(r.description, r.modelNumber),
        qty,
        notes:        '',
        locations:    location ? [{ room: location, qty }] : [],
      });
    }
  }

  return {
    items:    Array.from(map.values()),
    rowCount: productRows.length,
    skipped,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CSVImportModal({ open, onClose, onImport }: CSVImportModalProps) {
  const [step, setStep]               = useState<Step>('upload');
  const [fileName, setFileName]       = useState('');
  const [rowCount, setRowCount]       = useState(0);
  const [skipped, setSkipped]         = useState(0);
  const [items, setItems]             = useState<ImportedItem[]>([]);
  const [errors, setErrors]           = useState<string[]>([]);
  const [dragOver, setDragOver]       = useState(false);
  const fileRef                       = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload');
    setFileName('');
    setRowCount(0);
    setSkipped(0);
    setItems([]);
    setErrors([]);
    setDragOver(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setErrors(['Please upload a .csv file exported from D-Tools.']);
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      try {
        const { items: consolidated, rowCount: rc, skipped: sk } = consolidateItems(text);
        if (consolidated.length === 0) {
          setErrors(['No product rows found. Make sure this is a D-Tools AV Package Items export.']);
          return;
        }
        setFileName(file.name);
        setRowCount(rc);
        setSkipped(sk);
        setItems(consolidated);
        setErrors([]);
        setStep('review');
      } catch {
        setErrors(['Could not parse the CSV file. Please check the file and try again.']);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleCategoryChange = (idx: number, category: ItemCategory) => {
    setItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], category };
      return next;
    });
  };

  const handleCutSheetUpload = (idx: number, file: File) => {
    setItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], cutSheetFile: file, cutSheetName: file.name };
      return next;
    });
  };

  const removeCutSheet = (idx: number) => {
    setItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], cutSheetFile: undefined, cutSheetName: undefined };
      return next;
    });
  };

  const handleFinalImport = () => { onImport(items); handleClose(); };

  const CATEGORIES: ItemCategory[] = ['Display', 'Audio', 'Control', 'Networking', 'Cabling', 'Other'];

  return (
    <Modal open={open} onClose={handleClose} title={step === 'upload' ? 'Import D-Tools CSV' : 'Review & Import'} wide>
      <div className="min-h-[300px]">

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs font-medium">
          {(['upload', 'review'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={12} className="text-text-secondary/40" />}
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-colors ${
                step === s
                  ? 'bg-navy text-white'
                  : step === 'review' && s === 'upload'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-surface text-text-secondary'
              }`}>
                {step === 'review' && s === 'upload'
                  ? <Check size={12} />
                  : <span className="w-3 text-center">{i + 1}</span>}
                <span className="capitalize">{s === 'upload' ? 'Upload' : 'Review & Import'}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Errors */}
        {errors.length > 0 && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
            <div className="text-sm text-red-700">{errors.map((e, i) => <div key={i}>{e}</div>)}</div>
          </div>
        )}

        {/* ── Step 1: Upload ─────────────────────────────────────────────── */}
        {step === 'upload' && (
          <div>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                dragOver ? 'border-navy bg-navy/5' : 'border-border hover:border-navy/40 hover:bg-surface/50'
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={e => { const file = e.target.files?.[0]; if (file) handleFile(file); }}
              />
              <Upload size={40} className={`mx-auto mb-3 ${dragOver ? 'text-navy' : 'text-text-secondary/40'}`} />
              <p className="text-sm font-medium text-text-primary mb-1">
                {dragOver ? 'Drop your D-Tools CSV here' : 'Drag & drop your D-Tools CSV here'}
              </p>
              <p className="text-xs text-text-secondary">or click to browse · AV Package Items export</p>
            </div>

            <div className="mt-4 p-3 bg-surface rounded-lg text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Expected format:</span> D-Tools &rarr; Reports &rarr; AV Package Items export (.csv).
              Columns are mapped automatically — no manual configuration needed.
            </div>
          </div>
        )}

        {/* ── Step 2: Review & Import ─────────────────────────────────────── */}
        {step === 'review' && (
          <div>
            {/* File summary */}
            <div className="flex items-center gap-3 mb-4 p-3 bg-surface rounded-lg">
              <FileSpreadsheet size={16} className="text-navy shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{fileName}</p>
                <p className="text-xs text-text-secondary">
                  {items.length} unique products from {rowCount} product rows
                  {skipped > 0 && ` · ${skipped} labor rows skipped`}
                  {' · '}total qty: {items.reduce((a, b) => a + b.qty, 0)}
                </p>
              </div>
              <button
                onClick={() => { setStep('upload'); setErrors([]); }}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0"
              >
                Change file
              </button>
            </div>

            {/* Items table */}
            <div className="border border-border rounded-lg overflow-hidden mb-4 max-h-[380px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-navy text-white text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Model</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center w-14">Qty</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Category</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Cutsheet</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((item, idx) => (
                    <tr key={idx} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
                      <td className="px-3 py-2 font-medium text-text-primary">{item.manufacturer}</td>
                      <td className="px-3 py-2">
                        <div className="font-mono text-text-secondary text-xs">{item.model}</div>
                        {item.description && (
                          <div className="text-xs text-text-secondary/70 mt-0.5 max-w-[200px] truncate" title={item.description}>
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center font-semibold text-navy">{item.qty}</td>
                      <td className="px-3 py-2">
                        <select
                          value={item.category}
                          onChange={e => handleCategoryChange(idx, e.target.value as ItemCategory)}
                          className="text-xs border border-border rounded px-1.5 py-0.5 bg-white"
                        >
                          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {item.cutSheetName ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[120px]">
                              <Check size={10} />
                              <span className="truncate">{item.cutSheetName}</span>
                            </span>
                            <button onClick={() => removeCutSheet(idx)} className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500">
                              <XIcon size={12} />
                            </button>
                          </div>
                        ) : (
                          <label className="text-xs text-navy hover:text-orange cursor-pointer font-medium transition-colors">
                            + PDF
                            <input type="file" accept=".pdf" className="hidden"
                              onChange={e => { const file = e.target.files?.[0]; if (file) handleCutSheetUpload(idx, file); }}
                            />
                          </label>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between pt-4 border-t border-border">
              <button onClick={() => { setStep('upload'); setErrors([]); }} className="btn-secondary text-sm">
                <ChevronLeft size={14} /> Back
              </button>
              <button onClick={handleFinalImport} className="btn-primary text-sm">
                <Upload size={14} /> Import {items.length} Items
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
