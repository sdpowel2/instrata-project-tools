import { useState, useCallback, useRef } from 'react';
import { Upload, FileSpreadsheet, ChevronRight, ChevronLeft, AlertCircle, Check, X as XIcon } from 'lucide-react';
import { Modal } from './Modal';
import type { ItemCategory } from '../types';

import type { SubmittalItemLocation } from '../types';

const SUBMITTAL_FIELDS = [
  { key: 'manufacturer', label: 'Manufacturer', required: true },
  { key: 'model', label: 'Model Number', required: true },
  { key: 'qty', label: 'Quantity', required: true },
  { key: 'description', label: 'Description', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'location', label: 'Room / Location', required: false },
  { key: 'notes', label: 'Notes', required: false },
] as const;

type FieldKey = '' | 'manufacturer' | 'model' | 'description' | 'category' | 'qty' | 'location' | 'notes';

export interface ImportedItem {
  manufacturer: string;
  model: string;
  description: string;
  category: ItemCategory;
  qty: number;
  notes: string;
  locations: SubmittalItemLocation[];
  cutSheetFile?: File;
  cutSheetName?: string;
}

interface CSVImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (items: ImportedItem[]) => void;
}

type Step = 'upload' | 'map' | 'review';

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.length > 0 || lines.length > 0) lines.push(current);
      current = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) lines.push(current);

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine).filter((r) => r.some((c) => c.length > 0));
  return { headers, rows };
}

function guessMapping(headers: string[]): Record<FieldKey, number> {
  const result: Record<FieldKey, number> = {
    '': -1, manufacturer: -1, model: -1, description: -1, category: -1, qty: -1, location: -1, notes: -1,
  };
  const used = new Set<number>();
  const matchers: [FieldKey, (s: string) => boolean][] = [
    ['manufacturer', (s) => s.includes('manufacturer') || s.includes('mfr') || s === 'make' || s === 'brand'],
    ['model', (s) => s.includes('model') || s.includes('part number') || s.includes('part #') || s.includes('part#') || s.includes('sku')],
    ['description', (s) => s.includes('desc')],
    ['category', (s) => s.includes('categ') || s === 'type'],
    ['qty', (s) => s.includes('qty') || s.includes('quantity') || s.includes('count') || s === 'amount'],
    ['location', (s) => s.includes('room') || s.includes('location') || s.includes('area') || s.includes('space')],
    ['notes', (s) => s.includes('note') || s.includes('comment') || s.includes('remark')],
  ];
  for (const [field, matcher] of matchers) {
    const idx = headers.findIndex((h, i) => !used.has(i) && matcher(h.toLowerCase().trim()));
    if (idx !== -1) {
      result[field] = idx;
      used.add(idx);
    }
  }
  return result;
}

const CATEGORY_MAP: Record<string, ItemCategory> = {
  display: 'Display', monitor: 'Display', screen: 'Display', tv: 'Display', projector: 'Display',
  audio: 'Audio', speaker: 'Audio', microphone: 'Audio', amp: 'Audio', amplifier: 'Audio', dsp: 'Audio',
  control: 'Control', processor: 'Control', touch: 'Control', panel: 'Control',
  networking: 'Networking', network: 'Networking', switch: 'Networking',
  cabling: 'Cabling', cable: 'Cabling', wire: 'Cabling', connector: 'Cabling',
};

function inferCategory(value: string): ItemCategory {
  const lower = value.toLowerCase();
  for (const [keyword, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword)) return cat;
  }
  return 'Other';
}

export function CSVImportModal({ open, onClose, onImport }: CSVImportModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  // Maps field key → CSV column index (or -1 for unmapped)
  const [fieldToCol, setFieldToCol] = useState<Record<FieldKey, number>>({
    '': -1, manufacturer: -1, model: -1, description: -1, category: -1, qty: -1, location: -1, notes: -1,
  });
  const [consolidated, setConsolidated] = useState<ImportedItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload');
    setHeaders([]);
    setRows([]);
    setFieldToCol({ '': -1, manufacturer: -1, model: -1, description: -1, category: -1, qty: -1, location: -1, notes: -1 });
    setConsolidated([]);
    setErrors([]);
    setDragOver(false);
    setFileName('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setErrors(['Please upload a .csv file.']);
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows: r } = parseCSV(text);
      if (h.length === 0) {
        setErrors(['Could not parse CSV. File may be empty.']);
        return;
      }
      setHeaders(h);
      setRows(r);
      setFieldToCol(guessMapping(h));
      setErrors([]);
      setStep('map');
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFieldMapChange = (field: FieldKey, colIdx: number) => {
    setFieldToCol((prev) => {
      const next = { ...prev };
      // If another field already uses this column, unmap it
      if (colIdx !== -1) {
        for (const key of Object.keys(next) as FieldKey[]) {
          if (key && key !== field && next[key] === colIdx) {
            next[key] = -1;
          }
        }
      }
      next[field] = colIdx;
      return next;
    });
  };

  const validateMapping = (): boolean => {
    const errs: string[] = [];
    if (fieldToCol.manufacturer === -1) errs.push('Manufacturer column is required.');
    if (fieldToCol.model === -1) errs.push('Model Number column is required.');
    if (fieldToCol.qty === -1) errs.push('Quantity column is required.');
    setErrors(errs);
    return errs.length === 0;
  };

  const processImport = () => {
    if (!validateMapping()) return;

    const mfIdx = fieldToCol.manufacturer;
    const mdIdx = fieldToCol.model;
    const dsIdx = fieldToCol.description;
    const ctIdx = fieldToCol.category;
    const qyIdx = fieldToCol.qty;
    const lcIdx = fieldToCol.location;
    const ntIdx = fieldToCol.notes;

    // Consolidate by manufacturer+model, tracking locations
    const map = new Map<string, ImportedItem>();
    for (const row of rows) {
      const manufacturer = (row[mfIdx] || '').trim();
      const model = (row[mdIdx] || '').trim();
      const qty = Math.max(1, parseInt(row[qyIdx] || '1', 10) || 1);
      const location = lcIdx !== -1 ? (row[lcIdx] || '').trim() : '';
      if (!manufacturer || !model) continue; // skip rows missing required fields
      const key = `${manufacturer.toLowerCase()}|||${model.toLowerCase()}`;
      const existing = map.get(key);
      if (existing) {
        existing.qty += qty;
        // Track location
        if (location) {
          const existingLoc = existing.locations.find((l) => l.room === location);
          if (existingLoc) {
            existingLoc.qty += qty;
          } else {
            existing.locations.push({ room: location, qty });
          }
        }
        // Append notes if different
        if (ntIdx !== -1 && row[ntIdx] && !existing.notes.includes(row[ntIdx])) {
          existing.notes = existing.notes ? `${existing.notes}; ${row[ntIdx]}` : row[ntIdx];
        }
      } else {
        map.set(key, {
          manufacturer,
          model,
          description: dsIdx !== -1 ? (row[dsIdx] || '').trim() : '',
          category: ctIdx !== -1 ? inferCategory(row[ctIdx] || '') : 'Other',
          qty,
          locations: location ? [{ room: location, qty }] : [],
          notes: ntIdx !== -1 ? (row[ntIdx] || '').trim() : '',
        });
      }
    }

    setConsolidated(Array.from(map.values()));
    setStep('review');
    setErrors([]);
  };

  const handleCutSheetUpload = (idx: number, file: File) => {
    setConsolidated((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], cutSheetFile: file, cutSheetName: file.name };
      return next;
    });
  };

  const removeCutSheet = (idx: number) => {
    setConsolidated((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], cutSheetFile: undefined, cutSheetName: undefined };
      return next;
    });
  };

  const handleCategoryChange = (idx: number, category: ItemCategory) => {
    setConsolidated((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], category };
      return next;
    });
  };

  const handleFinalImport = () => {
    onImport(consolidated);
    handleClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title={
      step === 'upload' ? 'Import CSV' : step === 'map' ? 'Map Columns' : 'Review & Import'
    } wide>
      <div className="min-h-[300px]">
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs font-medium">
          {(['upload', 'map', 'review'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={12} className="text-text-secondary/40" />}
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-colors ${
                step === s ? 'bg-navy text-white' :
                (['upload', 'map', 'review'].indexOf(step) > i) ? 'bg-green-100 text-green-700' : 'bg-surface text-text-secondary'
              }`}>
                {(['upload', 'map', 'review'].indexOf(step) > i) ? <Check size={12} /> : <span className="w-3 text-center">{i + 1}</span>}
                <span className="capitalize">{s === 'map' ? 'Map Columns' : s}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Errors */}
        {errors.length > 0 && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
            <div className="text-sm text-red-700">
              {errors.map((err, i) => <div key={i}>{err}</div>)}
            </div>
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
              dragOver ? 'border-orange bg-orange/5' : 'border-border hover:border-navy/40 hover:bg-surface/50'
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <Upload size={40} className={`mx-auto mb-3 ${dragOver ? 'text-orange' : 'text-text-secondary/40'}`} />
            <p className="text-sm font-medium text-text-primary mb-1">
              {dragOver ? 'Drop your CSV here' : 'Drag & drop a CSV file here'}
            </p>
            <p className="text-xs text-text-secondary">or click to browse</p>
          </div>
        )}

        {/* Step 2: Column Mapping */}
        {step === 'map' && (
          <div>
            <div className="flex items-center gap-2 mb-4 p-3 bg-surface rounded-lg">
              <FileSpreadsheet size={16} className="text-navy" />
              <span className="text-sm font-medium text-text-primary">{fileName}</span>
              <span className="text-xs text-text-secondary">{rows.length} rows found</span>
            </div>

            <p className="text-sm text-text-secondary mb-4">
              For each submittal field, select the matching CSV column. <span className="font-medium text-text-primary">Manufacturer</span>, <span className="font-medium text-text-primary">Model Number</span>, and <span className="font-medium text-text-primary">Quantity</span> are required.
            </p>

            <div className="space-y-3 mb-4">
              {SUBMITTAL_FIELDS.map((field) => {
                const colIdx = fieldToCol[field.key as FieldKey];
                const isMapped = colIdx !== -1;
                return (
                  <div key={field.key} className={`p-3 rounded-lg border ${isMapped ? 'border-green-300 bg-green-50/30' : field.required ? 'border-orange/40 bg-orange/5' : 'border-border bg-surface/50'}`}>
                    <div className="flex items-center justify-between gap-4 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-navy">{field.label}</span>
                        {field.required && <span className="text-[10px] font-bold text-orange uppercase tracking-wide">Required</span>}
                      </div>
                      {isMapped && <Check size={14} className="text-green-600 shrink-0" />}
                    </div>
                    {isMapped && (
                      <div className="text-xs text-text-secondary mb-2 truncate">
                        Preview: {rows.slice(0, 3).map((r) => r[colIdx] || '—').join(' · ')}
                      </div>
                    )}
                    <select
                      value={colIdx}
                      onChange={(e) => handleFieldMapChange(field.key as FieldKey, parseInt(e.target.value))}
                      className="input text-sm py-1.5 w-full"
                    >
                      <option value={-1}>— Select a CSV column —</option>
                      {headers.map((header, idx) => (
                        <option key={idx} value={idx}>{header}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between pt-4 border-t border-border">
              <button onClick={() => { setStep('upload'); setErrors([]); }} className="btn-secondary text-sm">
                <ChevronLeft size={14} /> Back
              </button>
              <button onClick={processImport} className="btn-primary text-sm">
                Continue <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Review & Import */}
        {step === 'review' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-text-secondary">
                <span className="font-medium text-text-primary">{consolidated.length}</span> unique products consolidated from <span className="font-medium text-text-primary">{rows.length}</span> CSV rows.
                Total quantity: <span className="font-medium text-text-primary">{consolidated.reduce((a, b) => a + b.qty, 0)}</span>
              </p>
            </div>

            <div className="border border-border rounded-lg overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-navy text-white text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Model</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center">Qty</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Category</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Cutsheet</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {consolidated.map((item, idx) => (
                    <tr key={idx} className={idx % 2 === 1 ? 'bg-surface/30' : ''}>
                      <td className="px-3 py-2 font-medium text-text-primary">{item.manufacturer}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{item.model}</td>
                      <td className="px-3 py-2 text-center font-semibold text-navy">{item.qty}</td>
                      <td className="px-3 py-2">
                        <select
                          value={item.category}
                          onChange={(e) => handleCategoryChange(idx, e.target.value as ItemCategory)}
                          className="text-xs border border-border rounded px-1.5 py-0.5 bg-white"
                        >
                          {['Display', 'Audio', 'Control', 'Networking', 'Cabling', 'Other'].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {item.cutSheetName ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[140px]">
                              <Check size={10} />
                              <span className="truncate">{item.cutSheetName}</span>
                            </span>
                            <button
                              onClick={() => removeCutSheet(idx)}
                              className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"
                            >
                              <XIcon size={12} />
                            </button>
                          </div>
                        ) : (
                          <label className="text-xs text-navy hover:text-orange cursor-pointer font-medium transition-colors">
                            + Upload PDF
                            <input
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleCutSheetUpload(idx, file);
                              }}
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
              <button onClick={() => { setStep('map'); setErrors([]); }} className="btn-secondary text-sm">
                <ChevronLeft size={14} /> Back
              </button>
              <button onClick={handleFinalImport} className="btn-primary text-sm">
                <Upload size={14} /> Import {consolidated.length} Items
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
