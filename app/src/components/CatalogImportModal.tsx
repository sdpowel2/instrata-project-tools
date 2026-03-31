// ─── CatalogImportModal ──────────────────────────────────────────────────────
// 3-step product catalog import: Upload → Map Columns → Preview & Import
// Supports CSV and Excel (.xls/.xlsx) with column-mapping and auto-detection.

import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload, FileSpreadsheet, ChevronRight, ChevronLeft,
  AlertCircle, Check, Loader2, Columns3,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from './Modal';
import { supabase } from '../lib/supabase';

interface CatalogImportModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (count: number) => void;
}

type Step = 'upload' | 'map' | 'preview';

// ─── Target fields & auto-detection aliases ─────────────────────────────────

interface TargetField {
  key: string;
  label: string;
  required: boolean;
  aliases: string[];
}

const TARGET_FIELDS: TargetField[] = [
  {
    key: 'manufacturer',
    label: 'Manufacturer',
    required: true,
    aliases: ['manufacturer', 'mfg', 'brand', 'vendor', 'make'],
  },
  {
    key: 'model_number',
    label: 'Model Number',
    required: true,
    aliases: ['model number', 'model_number', 'model#', 'model', 'part number', 'part_number', 'part#', 'sku', 'part'],
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    aliases: ['description', 'desc', 'short description', 'name', 'item', 'product', 'product name'],
  },
  {
    key: 'cost',
    label: 'Cost',
    required: false,
    aliases: ['cost', 'unit cost', 'unit_cost', 'dealer cost', 'dealer price', 'buy price', 'wholesale'],
  },
  {
    key: 'list_price',
    label: 'MSRP / List Price',
    required: false,
    aliases: ['msrp', 'list price', 'list_price', 'price', 'unit price', 'retail', 'retail price'],
  },
  {
    key: 'unit_of_measure',
    label: 'Unit of Measure',
    required: false,
    aliases: ['unit of measure', 'unit_of_measure', 'uom', 'unit', 'measure', 'um'],
  },
  {
    key: 'category',
    label: 'Category',
    required: false,
    aliases: ['category', 'type', 'group', 'product type'],
  },
];

// ─── CSV parser ──────────────────────────────────────────────────────────────

function parseRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { fields.push(field.trim()); field = ''; }
      else { field += c; }
    }
  }
  fields.push(field.trim());
  return fields;
}

function parseCsvAllRows(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');
  return lines.map(parseRow);
}

// ─── Excel parser ────────────────────────────────────────────────────────────

function parseExcelSheet(wb: XLSX.WorkBook, sheetName: string): string[][] {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found.`);
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (raw.length < 2) throw new Error('Sheet must have a header row and at least one data row.');
  return raw.map(r => r.map(c => String(c ?? '').trim()));
}

// Pick the first row where >50% of cells are non-blank as the likely header row.
// Looks at the first 5 rows max. Falls back to row 0.
function detectHeaderRow(allRows: string[][]): number {
  const maxCheck = Math.min(allRows.length, 5);
  for (let i = 0; i < maxCheck; i++) {
    const row = allRows[i];
    const nonBlank = row.filter(c => c.trim() !== '').length;
    if (nonBlank > row.length * 0.5) return i;
  }
  return 0;
}

const ACCEPTED_EXTENSIONS = ['.csv', '.xls', '.xlsx'];
const ACCEPT_ATTR = '.csv,.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isExcelFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xls') || lower.endsWith('.xlsx');
}

// ─── Auto-detect mapping ─────────────────────────────────────────────────────

function autoDetect(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalized = headers.map(h => h.toLowerCase().trim());

  for (const field of TARGET_FIELDS) {
    for (const alias of field.aliases) {
      const idx = normalized.indexOf(alias);
      if (idx >= 0 && !Object.values(mapping).includes(idx)) {
        mapping[field.key] = idx;
        break;
      }
    }
  }
  return mapping;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CatalogImportModal({ open, onClose, onComplete }: CatalogImportModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [headerRowIdx, setHeaderRowIdx] = useState(0);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [fileName, setFileName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Excel workbook state for sheet switching
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');

  // Default manufacturer for sheets without a manufacturer column
  const [defaultMfg, setDefaultMfg] = useState('');

  // Derived: headers and data rows based on selected header row
  const headers = useMemo(() => allRows[headerRowIdx] ?? [], [allRows, headerRowIdx]);
  const rawRows = useMemo(() => {
    return allRows.slice(headerRowIdx + 1).filter(r => r.some(v => v.trim() !== ''));
  }, [allRows, headerRowIdx]);

  const reset = () => {
    setStep('upload');
    setAllRows([]);
    setHeaderRowIdx(0);
    setMapping({});
    setFileName('');
    setErrors([]);
    setImporting(false);
    setDragOver(false);
    setWorkbook(null);
    setSheetNames([]);
    setActiveSheet('');
    setDefaultMfg('');
  };

  const handleClose = () => { reset(); onClose(); };

  // ── File handling ──────────────────────────────────────────────────────────

  // Apply a sheet from the current workbook
  const applySheet = useCallback((wb: XLSX.WorkBook, sheet: string) => {
    try {
      const rows = parseExcelSheet(wb, sheet);
      if (rows.length < 2) {
        setErrors(['Sheet must have a header row and at least one data row.']);
        return;
      }
      const hIdx = detectHeaderRow(rows);
      setAllRows(rows);
      setHeaderRowIdx(hIdx);
      setActiveSheet(sheet);
      setMapping(autoDetect(rows[hIdx]));
      setErrors([]);
      setStep('map');
    } catch (err: any) {
      setErrors([err.message ?? 'Could not parse this sheet.']);
    }
  }, []);

  const handleSheetChange = (sheet: string) => {
    if (workbook) applySheet(workbook, sheet);
  };

  const handleFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some(e => ext.endsWith(e))) {
      setErrors(['Please upload a .csv, .xls, or .xlsx file.']);
      return;
    }

    if (isExcelFile(file.name)) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target?.result as ArrayBuffer, { type: 'array' });
          const names = wb.SheetNames;
          setWorkbook(wb);
          setSheetNames(names);
          setFileName(file.name);

          // Auto-select the first sheet with enough data (skip cover pages)
          let picked = names[0];
          for (const name of names) {
            const ws = wb.Sheets[name];
            const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            const nonEmptyRows = raw.filter(r => r.some((c: any) => String(c ?? '').trim() !== ''));
            if (nonEmptyRows.length >= 5) { picked = name; break; }
          }
          applySheet(wb, picked);
        } catch (err: any) {
          setErrors([err.message ?? 'Could not parse the spreadsheet.']);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const rows = parseCsvAllRows(e.target?.result as string);
          if (rows.length < 2) {
            setErrors(['File must have a header row and at least one data row.']);
            return;
          }
          const hIdx = detectHeaderRow(rows);
          setAllRows(rows);
          setHeaderRowIdx(hIdx);
          setFileName(file.name);
          setMapping(autoDetect(rows[hIdx]));
          setErrors([]);
          setStep('map');
        } catch (err: any) {
          setErrors([err.message ?? 'Could not parse the CSV file.']);
        }
      };
      reader.readAsText(file);
    }
  }, [applySheet]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── Header row selection ─────────────────────────────────────────────────

  const handleHeaderRowChange = (idx: number) => {
    setHeaderRowIdx(idx);
    setMapping(autoDetect(allRows[idx]));
  };

  // Max rows to offer as header row candidates (first 10)
  const headerRowCandidates = useMemo(() => {
    const max = Math.min(allRows.length, 10);
    return allRows.slice(0, max).map((row, i) => {
      const preview = row.filter(c => c.trim()).slice(0, 4).join(', ');
      return { idx: i, preview: preview || '(empty row)' };
    });
  }, [allRows]);

  // ── Mapping helpers ────────────────────────────────────────────────────────

  const setFieldMapping = (fieldKey: string, headerIdx: number) => {
    setMapping(prev => {
      const next = { ...prev };
      if (headerIdx < 0) {
        delete next[fieldKey];
      } else {
        next[fieldKey] = headerIdx;
      }
      return next;
    });
  };

  const mfgMapped = mapping.manufacturer !== undefined && mapping.manufacturer >= 0;
  const requiredMet = TARGET_FIELDS
    .filter(f => f.required)
    .every(f => {
      if (f.key === 'manufacturer') return mfgMapped || defaultMfg.trim() !== '';
      return mapping[f.key] !== undefined && mapping[f.key] >= 0;
    });

  // Sample values for a header column (first 3 non-empty from raw rows)
  const sampleValues = useCallback((colIdx: number): string[] => {
    if (colIdx < 0) return [];
    const samples: string[] = [];
    for (const row of rawRows) {
      const val = row[colIdx]?.trim();
      if (val && samples.length < 3) samples.push(val);
      if (samples.length >= 3) break;
    }
    return samples;
  }, [rawRows]);

  // ── Preview data ───────────────────────────────────────────────────────────

  const previewRows = useMemo(() => {
    const fallbackMfg = defaultMfg.trim();
    return rawRows.slice(0, 5).map(row => {
      const mapped: Record<string, string> = {};
      for (const field of TARGET_FIELDS) {
        const idx = mapping[field.key];
        if (field.key === 'manufacturer' && !mfgMapped) {
          mapped[field.key] = fallbackMfg;
        } else {
          mapped[field.key] = idx !== undefined && idx >= 0 ? (row[idx] ?? '') : '';
        }
      }
      return mapped;
    });
  }, [rawRows, mapping, mfgMapped, defaultMfg]);

  const totalValid = useMemo(() => {
    const mfgIdx = mapping.manufacturer;
    const modelIdx = mapping.model_number;
    if (modelIdx === undefined) return 0;
    const fallbackMfg = defaultMfg.trim();
    if (!mfgMapped && !fallbackMfg) return 0;
    const seen = new Set<string>();
    for (const row of rawRows) {
      const mfg = mfgMapped ? row[mfgIdx]?.trim() : fallbackMfg;
      const model = row[modelIdx]?.trim();
      if (mfg && model) seen.add(`${mfg.toLowerCase()}|||${model.toLowerCase()}`);
    }
    return seen.size;
  }, [rawRows, mapping, mfgMapped, defaultMfg]);

  // ── Import ─────────────────────────────────────────────────────────────────

  const handleImport = async () => {
    setImporting(true);
    setErrors([]);
    try {
      const mfgIdx = mapping.manufacturer;
      const modelIdx = mapping.model_number;
      const descIdx = mapping.description;
      const costIdx = mapping.cost;
      const priceIdx = mapping.list_price;
      const uomIdx = mapping.unit_of_measure;
      const catIdx = mapping.category;

      const parseNum = (val: string | undefined): number | null => {
        const cleaned = val?.replace(/[$,]/g, '').trim();
        if (!cleaned) return null;
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      };

      const getOpt = (row: string[], idx: number | undefined) =>
        idx !== undefined && idx >= 0 ? (row[idx] ?? '') : '';

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // Deduplicate by manufacturer+model (last row wins) to avoid
      // "ON CONFLICT DO UPDATE cannot affect row a second time" errors
      const fallbackMfg = defaultMfg.trim();
      const deduped = new Map<string, Record<string, any>>();
      for (const raw of rawRows) {
        const mfg = mfgMapped ? raw[mfgIdx]?.trim() : fallbackMfg;
        const model = raw[modelIdx]?.trim();
        if (!mfg || !model) continue;

        const key = `${mfg.toLowerCase()}|||${model.toLowerCase()}`;
        deduped.set(key, {
          manufacturer: mfg,
          model_number: model,
          description: getOpt(raw, descIdx),
          cost: costIdx !== undefined && costIdx >= 0 ? parseNum(raw[costIdx]) : null,
          list_price: priceIdx !== undefined && priceIdx >= 0 ? parseNum(raw[priceIdx]) : null,
          unit_of_measure: getOpt(raw, uomIdx),
          category: getOpt(raw, catIdx),
          price_date: today,
        });
      }
      const rows = Array.from(deduped.values());

      let inserted = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error: err } = await supabase
          .from('product_catalog')
          .upsert(batch, { onConflict: 'manufacturer,model_number', ignoreDuplicates: false });
        if (err) throw new Error(err.message);
        inserted += batch.length;
      }

      onComplete(inserted);
      handleClose();
    } catch (err: any) {
      setErrors([err.message ?? 'Import failed.']);
    }
    setImporting(false);
  };

  // ── Step labels ────────────────────────────────────────────────────────────

  const STEPS: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'map', label: 'Map Columns' },
    { key: 'preview', label: 'Preview & Import' },
  ];

  const stepIdx = STEPS.findIndex(s => s.key === step);

  return (
    <Modal open={open} onClose={handleClose} title="Import Product Catalog" wide>
      <div className="min-h-[320px]">

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs font-medium">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={12} className="text-text-secondary/40" />}
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-colors ${
                step === s.key
                  ? 'bg-navy text-white'
                  : i < stepIdx
                  ? 'bg-green-100 text-green-700'
                  : 'bg-surface text-text-secondary'
              }`}>
                {i < stepIdx
                  ? <Check size={12} />
                  : <span className="w-3 text-center">{i + 1}</span>}
                <span>{s.label}</span>
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

        {/* ── Step 1: Upload ────────────────────────────────────────────── */}
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
                accept={ACCEPT_ATTR}
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <Upload size={40} className={`mx-auto mb-3 ${dragOver ? 'text-navy' : 'text-text-secondary/40'}`} />
              <p className="text-sm font-medium text-text-primary mb-1">
                {dragOver ? 'Drop your file here' : 'Drag & drop your product catalog CSV or Excel file'}
              </p>
              <p className="text-xs text-text-secondary">or click to browse</p>
            </div>

            <div className="mt-4 p-3 bg-surface rounded-lg text-xs text-text-secondary">
              <span className="font-medium text-text-primary">CSV and Excel files supported</span> — you'll map columns
              to the right fields in the next step. Auto-detection will try to match common header names.
            </div>
          </div>
        )}

        {/* ── Step 2: Map Columns ───────────────────────────────────────── */}
        {step === 'map' && (
          <div>
            {/* File info */}
            <div className="flex items-center gap-3 mb-5 p-3 bg-surface rounded-lg">
              <FileSpreadsheet size={16} className="text-navy shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{fileName}</p>
                <p className="text-xs text-text-secondary">
                  {headers.length} columns · {rawRows.length} data rows
                </p>
              </div>
              <button
                onClick={() => { setStep('upload'); setErrors([]); }}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0"
              >
                Change file
              </button>
            </div>

            {/* Sheet selector (Excel only) */}
            {sheetNames.length > 1 && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-text-primary whitespace-nowrap">
                    Sheet:
                  </label>
                  <select
                    value={activeSheet}
                    onChange={e => handleSheetChange(e.target.value)}
                    className="flex-1 text-sm border border-border rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                  >
                    {sheetNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-text-secondary mt-1.5">
                  This workbook has multiple sheets. Select the one containing the product data.
                </p>
              </div>
            )}

            {/* Header row selector */}
            {headerRowCandidates.length > 1 && (
              <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-text-primary whitespace-nowrap">
                    Header row:
                  </label>
                  <select
                    value={headerRowIdx}
                    onChange={e => handleHeaderRowChange(parseInt(e.target.value))}
                    className="flex-1 text-sm border border-border rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                  >
                    {headerRowCandidates.map(c => (
                      <option key={c.idx} value={c.idx}>
                        Row {c.idx + 1}: {c.preview}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-text-secondary mt-1.5">
                  If your file has grouped headers or title rows, select the row that contains the actual column names.
                </p>
              </div>
            )}

            {/* Mapping grid */}
            <div className="space-y-3">
              {TARGET_FIELDS.map(field => {
                const selectedIdx = mapping[field.key];
                const samples = selectedIdx !== undefined && selectedIdx >= 0
                  ? sampleValues(selectedIdx) : [];
                // Columns already used by other fields
                const usedIndices = new Set(
                  Object.entries(mapping)
                    .filter(([k]) => k !== field.key)
                    .map(([, v]) => v)
                );

                return (
                  <div key={field.key} className="grid grid-cols-[160px_1fr] gap-3 items-start">
                    <div className="flex items-center gap-1.5 pt-1.5">
                      <span className="text-sm font-medium text-text-primary">{field.label}</span>
                      {field.required && (
                        <span className="text-[10px] font-semibold text-red-500">*</span>
                      )}
                    </div>
                    <div>
                      <select
                        value={selectedIdx !== undefined ? selectedIdx : -1}
                        onChange={e => setFieldMapping(field.key, parseInt(e.target.value))}
                        className="w-full text-sm border border-border rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                      >
                        <option value={-1}>— Skip (don't import) —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i} disabled={usedIndices.has(i)}>
                            {h || `(Column ${i + 1})`}
                          </option>
                        ))}
                      </select>
                      {samples.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {samples.map((s, i) => (
                            <span key={i} className="text-[11px] bg-surface text-text-secondary px-2 py-0.5 rounded-full max-w-[200px] truncate">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Default manufacturer input when column isn't mapped */}
                      {field.key === 'manufacturer' && !mfgMapped && (
                        <div className="mt-2">
                          <input
                            type="text"
                            value={defaultMfg}
                            onChange={e => setDefaultMfg(e.target.value)}
                            placeholder="Type manufacturer name (e.g. Crestron)"
                            className="w-full text-sm border border-border rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                          />
                          <p className="text-[11px] text-text-secondary mt-1">
                            No manufacturer column? Enter a default value for all rows.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Navigation */}
            <div className="flex justify-between pt-5 mt-5 border-t border-border">
              <button
                onClick={() => { setStep('upload'); setErrors([]); }}
                className="btn-secondary text-sm flex items-center gap-1"
              >
                <ChevronLeft size={14} /> Back
              </button>
              <button
                onClick={() => { setErrors([]); setStep('preview'); }}
                disabled={!requiredMet}
                className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50"
              >
                Preview <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Preview & Import ──────────────────────────────────── */}
        {step === 'preview' && (
          <div>
            {/* Summary */}
            <div className="flex items-center gap-3 mb-4 p-3 bg-surface rounded-lg">
              <Columns3 size={16} className="text-navy shrink-0" />
              <p className="text-sm text-text-primary">
                <span className="font-semibold">{totalValid.toLocaleString()}</span> items will be imported
                {totalValid < rawRows.length && (
                  <span className="text-text-secondary">
                    {' '}({rawRows.length - totalValid} rows skipped — missing manufacturer or model)
                  </span>
                )}
              </p>
            </div>

            {/* Preview table */}
            <div className="border border-border rounded-lg overflow-hidden mb-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-navy text-white text-left">
                      {TARGET_FIELDS.filter(f => (mapping[f.key] !== undefined && mapping[f.key] >= 0) || (f.key === 'manufacturer' && !mfgMapped && defaultMfg.trim())).map(f => (
                        <th key={f.key} className="px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {previewRows.map((row, idx) => {
                      const mfg = row.manufacturer?.trim();
                      const model = row.model_number?.trim();
                      const isSkipped = !mfg || !model;
                      return (
                        <tr key={idx} className={`${idx % 2 === 1 ? 'bg-surface/30' : ''} ${isSkipped ? 'opacity-40' : ''}`}>
                          {TARGET_FIELDS.filter(f => (mapping[f.key] !== undefined && mapping[f.key] >= 0) || (f.key === 'manufacturer' && !mfgMapped && defaultMfg.trim())).map(f => (
                            <td key={f.key} className="px-3 py-2 text-text-primary whitespace-nowrap max-w-[220px] truncate">
                              {(f.key === 'list_price' || f.key === 'cost') && row[f.key]
                                ? (() => {
                                    const n = parseFloat(row[f.key].replace(/[$,]/g, ''));
                                    return isNaN(n) ? row[f.key] : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                                  })()
                                : row[f.key] || '—'}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rawRows.length > 5 && (
                <div className="px-3 py-1.5 bg-surface text-xs text-text-secondary text-center border-t border-border">
                  Showing first 5 of {rawRows.length} rows
                </div>
              )}
            </div>

            {/* Navigation */}
            <div className="flex justify-between pt-4 border-t border-border">
              <button
                onClick={() => setStep('map')}
                className="btn-secondary text-sm flex items-center gap-1"
              >
                <ChevronLeft size={14} /> Back
              </button>
              <button
                onClick={handleImport}
                disabled={importing || totalValid === 0}
                className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50"
              >
                {importing
                  ? <><Loader2 size={14} className="animate-spin" /> Importing…</>
                  : <><Upload size={14} /> Import {totalValid.toLocaleString()} Items</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
