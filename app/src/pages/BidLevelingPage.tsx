import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, Download, Plus, Trash2, ChevronRight,
  AlertTriangle, CheckCircle2, ArrowLeft, MapPin, DollarSign, Clock,
  FileText, RefreshCw,
} from 'lucide-react';
import { Scale } from 'lucide-react';
import { useStore } from '../store';
import { CellMapperModal } from '../components/CellMapperModal';
import { ProjectHeader } from '../components/ProjectHeader';
import { PhaseRibbon } from '../components/PhaseRibbon';
import type { CellMapping, BidLevelingSession, GenerationReportEntry } from '../types';
import {
  parseBomCsv, parseTemplate, generateXlsx, resolveTag,
  type ParsedBomResult, type ParsedTemplate,
} from '../utils/bidLevelingEngine';

type WizardStep = 'list' | 'bom' | 'template' | 'mapper' | 'generate';

export function BidLevelingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const allSessions = useStore((s) => s.bidLevelingSessions);
  const templates = useStore((s) => s.bidLevelingTemplates);

  const sessions = useMemo(
    () => allSessions.filter((ss) => ss.projectId === projectId),
    [allSessions, projectId],
  );
  const addSession = useStore((s) => s.addBidLevelingSession);
  const updateSession = useStore((s) => s.updateBidLevelingSession);
  const deleteSession = useStore((s) => s.deleteBidLevelingSession);
  const addTemplate = useStore((s) => s.addBidLevelingTemplate);

  // Wizard state
  const [step, setStep] = useState<WizardStep>('list');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // BoM state
  const [bomResult, setBomResult] = useState<ParsedBomResult | null>(null);

  // Template state
  const [templateBuffer, setTemplateBuffer] = useState<ArrayBuffer | null>(null);
  const [templateFileName, setTemplateFileName] = useState('');
  const [parsedTemplate, setParsedTemplate] = useState<ParsedTemplate | null>(null);

  // Mapper state
  const [mappings, setMappings] = useState<CellMapping[]>([]);
  const [mapperOpen, setMapperOpen] = useState(false);

  // Generation state
  const [generationReport, setGenerationReport] = useState<GenerationReportEntry[] | null>(null);
  const [generatedBlob, setGeneratedBlob] = useState<Blob | null>(null);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  function handleNewSession() {
    if (!projectId) return;
    const id = addSession({ projectId, status: 'draft' });
    setActiveSessionId(id);
    setStep('bom');
    resetWizardState();
  }

  function handleOpenSession(session: BidLevelingSession) {
    setActiveSessionId(session.id);
    resetWizardState();
    // Resume at appropriate step based on status
    if (session.status === 'generated') {
      setGenerationReport(session.generationReport ?? null);
      if (session.cellMappingsSnapshot) setMappings(session.cellMappingsSnapshot);
      setStep('generate');
    } else if (session.status === 'mapped') {
      if (session.cellMappingsSnapshot) setMappings(session.cellMappingsSnapshot);
      setStep('generate');
    } else {
      setStep('bom');
    }
  }

  function handleDeleteSession(id: string) {
    deleteSession(id);
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setStep('list');
    }
  }

  function resetWizardState() {
    setBomResult(null);
    setTemplateBuffer(null);
    setTemplateFileName('');
    setParsedTemplate(null);
    setMappings([]);
    setGenerationReport(null);
    setGeneratedBlob(null);
  }

  function handleBackToList() {
    setStep('list');
    setActiveSessionId(null);
    resetWizardState();
  }

  // ─── BoM Upload ────────────────────────────────────────────────────────────

  function handleBomUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const result = parseBomCsv(text);
      setBomResult(result);
    };
    reader.readAsText(file);
  }

  function handleBomContinue() {
    if (!bomResult) return;
    setStep('template');
  }

  // ─── Template Upload ───────────────────────────────────────────────────────

  function handleTemplateUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setTemplateFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      setTemplateBuffer(buffer);
      const parsed = parseTemplate(buffer);
      setParsedTemplate(parsed);

      // Check if any saved templates match (by name heuristic)
      // User can also manually select one
    };
    reader.readAsArrayBuffer(file);
  }

  function handleTemplateContinue() {
    if (!parsedTemplate) return;
    setStep('mapper');
  }

  // ─── Mapper ────────────────────────────────────────────────────────────────

  function handleApplyTemplate(templateId: string) {
    const tpl = templates.find((t) => t.id === templateId);
    if (tpl) {
      setMappings(tpl.cellMappings);
    }
  }

  function handleSaveTemplate(name: string, gcName: string) {
    addTemplate({
      name,
      gcConsultantName: gcName || undefined,
      cellMappings: mappings,
    });
  }

  function handleMapperContinue() {
    if (mappings.length === 0) return;
    if (activeSessionId) {
      updateSession(activeSessionId, {
        cellMappingsSnapshot: mappings,
        status: 'mapped',
      });
    }
    setStep('generate');
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  function handleGenerate() {
    if (!templateBuffer || !bomResult) return;

    const result = generateXlsx(templateBuffer, mappings, bomResult.aggregations);
    const blob = new Blob([result.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    setGeneratedBlob(blob);
    setGenerationReport(result.report);

    if (activeSessionId) {
      updateSession(activeSessionId, {
        generationReport: result.report,
        status: 'generated',
      });
    }
  }

  function handleDownload() {
    if (!generatedBlob) return;
    const url = URL.createObjectURL(generatedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = templateFileName
      ? templateFileName.replace(/\.xlsx?$/i, '_LEVELED.xlsx')
      : 'bid_leveling_output.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const project = useStore((s) => s.projects.find((p) => p.id === projectId));

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      {project && <ProjectHeader project={project} />}
      <div className="mt-5">
        <PhaseRibbon phase="Pre-Sales" toolLabel="Bid Leveling" toolIcon={Scale} />
      </div>
      {step === 'list' ? (
        <SessionList
          sessions={sessions}
          onNew={handleNewSession}
          onOpen={handleOpenSession}
          onDelete={handleDeleteSession}
        />
      ) : (
        <div>
          {/* Breadcrumb / step indicator */}
          <div className="flex items-center gap-2 mb-6">
            <button onClick={handleBackToList} className="text-sm text-text-secondary hover:text-navy flex items-center gap-1">
              <ArrowLeft size={14} /> Sessions
            </button>
            <ChevronRight size={14} className="text-text-secondary" />
            <StepIndicator current={step} />
          </div>

          {step === 'bom' && (
            <BomUploadStep
              bomResult={bomResult}
              onUpload={handleBomUpload}
              onContinue={handleBomContinue}
            />
          )}

          {step === 'template' && (
            <TemplateUploadStep
              parsedTemplate={parsedTemplate}
              templateFileName={templateFileName}
              onUpload={handleTemplateUpload}
              onContinue={handleTemplateContinue}
            />
          )}

          {step === 'mapper' && (
            <MapperStep
              bomResult={bomResult}
              mappings={mappings}
              templates={templates}
              onOpenMapper={() => setMapperOpen(true)}
              onApplyTemplate={handleApplyTemplate}
              onContinue={handleMapperContinue}
            />
          )}

          {step === 'generate' && (
            <GenerateStep
              mappings={mappings}
              bomResult={bomResult}
              generationReport={generationReport}
              generatedBlob={generatedBlob}
              canGenerate={!!templateBuffer && !!bomResult}
              onGenerate={handleGenerate}
              onDownload={handleDownload}
            />
          )}
        </div>
      )}

      {/* Cell Mapper Modal */}
      {parsedTemplate && bomResult && (
        <CellMapperModal
          open={mapperOpen}
          onClose={() => setMapperOpen(false)}
          sheetNames={parsedTemplate.sheetNames}
          sheetData={parsedTemplate.sheetData}
          locations={bomResult.aggregations.locations}
          mappings={mappings}
          onMappingsChange={setMappings}
          onSaveTemplate={handleSaveTemplate}
        />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SessionList({
  sessions,
  onNew,
  onOpen,
  onDelete,
}: {
  sessions: BidLevelingSession[];
  onNew: () => void;
  onOpen: (s: BidLevelingSession) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-navy">Bid Leveling</h2>
          <p className="text-sm text-text-secondary mt-1">
            Generate submission-ready GC bid leveling sheets from D-Tools BoM exports.
          </p>
        </div>
        <button onClick={onNew} className="btn-primary flex items-center gap-2 text-sm px-4 py-2">
          <Plus size={16} />
          New Session
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16 bg-surface rounded-xl border border-border">
          <FileSpreadsheet size={40} className="mx-auto text-text-secondary/40 mb-3" />
          <h3 className="text-lg font-semibold text-navy mb-1">No sessions yet</h3>
          <p className="text-sm text-text-secondary mb-4">
            Create a new session to start generating bid leveling sheets.
          </p>
          <button onClick={onNew} className="btn-primary text-sm px-4 py-2">
            New Session
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between bg-white rounded-lg border border-border px-5 py-4 hover:border-navy/20 transition-colors cursor-pointer"
              onClick={() => onOpen(s)}
            >
              <div className="flex items-center gap-4">
                <FileSpreadsheet size={20} className="text-navy/40" />
                <div>
                  <div className="text-sm font-medium text-navy">
                    Session — {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    Status: <span className="font-medium capitalize">{s.status}</span>
                    {s.cellMappingsSnapshot && ` · ${s.cellMappingsSnapshot.length} mappings`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={s.status} />
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                  className="p-1.5 text-text-secondary hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    mapped: 'bg-blue-50 text-blue-700',
    generated: 'bg-green-50 text-green-700',
  };
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${colors[status] ?? colors.draft}`}>
      {status}
    </span>
  );
}

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: { key: WizardStep; label: string }[] = [
    { key: 'bom', label: 'BoM CSV' },
    { key: 'template', label: 'Template' },
    { key: 'mapper', label: 'Map Cells' },
    { key: 'generate', label: 'Generate' },
  ];
  const currentIdx = steps.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-1">
      {steps.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1">
          <span className={`text-sm font-medium ${i === currentIdx ? 'text-navy' : i < currentIdx ? 'text-orange' : 'text-text-secondary/50'}`}>
            {s.label}
          </span>
          {i < steps.length - 1 && <ChevronRight size={12} className="text-text-secondary/40" />}
        </span>
      ))}
    </div>
  );
}

// ─── Step 1: BoM CSV Upload ─────────────────────────────────────────────────

function BomUploadStep({
  bomResult,
  onUpload,
  onContinue,
}: {
  bomResult: ParsedBomResult | null;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onContinue: () => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-navy mb-1">Step 1: Upload D-Tools BoM CSV</h3>
      <p className="text-sm text-text-secondary mb-6">
        Upload the D-Tools SI Bill of Materials export. The CSV will be parsed and costs aggregated by location.
      </p>

      {!bomResult ? (
        <label className="flex flex-col items-center justify-center w-full h-48 bg-surface border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-navy/30 transition-colors">
          <Upload size={32} className="text-text-secondary/40 mb-2" />
          <span className="text-sm font-medium text-navy">Click to upload BoM CSV</span>
          <span className="text-xs text-text-secondary mt-1">D-Tools SI export (.csv)</span>
          <input type="file" accept=".csv" onChange={onUpload} className="hidden" />
        </label>
      ) : (
        <div>
          {/* Warnings */}
          {bomResult.warnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2 text-yellow-800 text-sm font-medium mb-2">
                <AlertTriangle size={16} />
                Warnings ({bomResult.warnings.length})
              </div>
              <ul className="text-xs text-yellow-700 space-y-1">
                {bomResult.warnings.slice(0, 10).map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
                {bomResult.warnings.length > 10 && (
                  <li className="text-yellow-600">...and {bomResult.warnings.length - 10} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Summary Cards */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <SummaryCard
              icon={<FileText size={16} />}
              label="BoM Items"
              value={bomResult.rows.length.toString()}
            />
            <SummaryCard
              icon={<MapPin size={16} />}
              label="Locations"
              value={bomResult.aggregations.locations.length.toString()}
            />
            <SummaryCard
              icon={<DollarSign size={16} />}
              label="Equipment Total"
              value={formatCurrency(bomResult.aggregations.all.equipmentTotal)}
            />
            <SummaryCard
              icon={<Clock size={16} />}
              label="Labor Hours"
              value={bomResult.aggregations.all.laborHours.toFixed(1)}
            />
          </div>

          {/* Location breakdown */}
          <h4 className="text-sm font-semibold text-navy mb-3">Cost Breakdown by Location</h4>
          <div className="border border-border rounded-lg overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface text-left">
                  <th className="px-4 py-2.5 font-medium text-text-secondary">Location</th>
                  <th className="px-4 py-2.5 font-medium text-text-secondary text-right">Equipment</th>
                  <th className="px-4 py-2.5 font-medium text-text-secondary text-right">Labor</th>
                  <th className="px-4 py-2.5 font-medium text-text-secondary text-right">Hours</th>
                  <th className="px-4 py-2.5 font-medium text-text-secondary text-right">Grand Total</th>
                </tr>
              </thead>
              <tbody>
                {bomResult.aggregations.locations.map((loc) => {
                  const agg = bomResult.aggregations.byLocation.get(loc)!;
                  return (
                    <tr key={loc} className="border-t border-border">
                      <td className="px-4 py-2.5 font-medium text-navy">{loc}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm">{formatCurrency(agg.equipmentTotal)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm">{formatCurrency(agg.laborTotal)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm">{agg.laborHours.toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold">{formatCurrency(agg.grandTotal)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-navy/20 bg-surface font-semibold">
                  <td className="px-4 py-2.5 text-navy">ALL LOCATIONS</td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(bomResult.aggregations.all.equipmentTotal)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(bomResult.aggregations.all.laborTotal)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{bomResult.aggregations.all.laborHours.toFixed(1)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(bomResult.aggregations.all.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Upload new CSV */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text-secondary hover:text-navy cursor-pointer flex items-center gap-1.5">
              <RefreshCw size={14} />
              Upload different CSV
              <input type="file" accept=".csv" onChange={onUpload} className="hidden" />
            </label>
            <button onClick={onContinue} className="btn-primary text-sm px-5 py-2 flex items-center gap-2">
              Continue
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 2: Template Upload ─────────────────────────────────────────────────

function TemplateUploadStep({
  parsedTemplate,
  templateFileName,
  onUpload,
  onContinue,
}: {
  parsedTemplate: ParsedTemplate | null;
  templateFileName: string;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onContinue: () => void;
}) {
  const [previewSheet, setPreviewSheet] = useState('');

  const activeSheet = previewSheet || (parsedTemplate?.sheetNames[0] ?? '');
  const sheetData = parsedTemplate?.sheetData.get(activeSheet) ?? [];
  const maxRows = Math.min(sheetData.length, 50);
  const maxCols = sheetData.length > 0 ? Math.min(Math.max(...sheetData.slice(0, maxRows).map(r => r.length)), 20) : 0;

  return (
    <div>
      <h3 className="text-lg font-semibold text-navy mb-1">Step 2: Upload GC/Consultant Template</h3>
      <p className="text-sm text-text-secondary mb-6">
        Upload the XLSX file provided by the GC or consultant. All formatting, formulas, and branding will be preserved.
      </p>

      {!parsedTemplate ? (
        <label className="flex flex-col items-center justify-center w-full h-48 bg-surface border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-navy/30 transition-colors">
          <FileSpreadsheet size={32} className="text-text-secondary/40 mb-2" />
          <span className="text-sm font-medium text-navy">Click to upload XLSX template</span>
          <span className="text-xs text-text-secondary mt-1">GC/consultant bid leveling template (.xlsx, .xls)</span>
          <input type="file" accept=".xlsx,.xls" onChange={onUpload} className="hidden" />
        </label>
      ) : (
        <div>
          {/* File info */}
          <div className="bg-surface rounded-lg border border-border px-4 py-3 mb-4 flex items-center gap-3">
            <FileSpreadsheet size={20} className="text-navy" />
            <div>
              <div className="text-sm font-medium text-navy">{templateFileName}</div>
              <div className="text-xs text-text-secondary">{parsedTemplate.sheetNames.length} sheet(s)</div>
            </div>
          </div>

          {/* Sheet tabs */}
          <div className="flex gap-1 mb-3">
            {parsedTemplate.sheetNames.map((name) => (
              <button
                key={name}
                onClick={() => setPreviewSheet(name)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeSheet === name
                    ? 'bg-navy text-white'
                    : 'bg-surface text-text-secondary hover:text-navy'
                }`}
              >
                {name}
              </button>
            ))}
          </div>

          {/* Preview grid */}
          <div className="border border-border rounded-lg overflow-auto max-h-80 mb-6">
            <table className="border-collapse text-xs w-full">
              <tbody>
                {sheetData.slice(0, maxRows).map((row, r) => (
                  <tr key={r} className={r === 0 ? 'bg-surface font-medium' : ''}>
                    {Array.from({ length: maxCols }, (_, c) => (
                      <td key={c} className="border border-border px-2 py-1 truncate max-w-[150px]">
                        {String(row[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm text-text-secondary hover:text-navy cursor-pointer flex items-center gap-1.5">
              <RefreshCw size={14} />
              Upload different template
              <input type="file" accept=".xlsx,.xls" onChange={onUpload} className="hidden" />
            </label>
            <button onClick={onContinue} className="btn-primary text-sm px-5 py-2 flex items-center gap-2">
              Continue
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Mapper ──────────────────────────────────────────────────────────

function MapperStep({
  bomResult,
  mappings,
  templates,
  onOpenMapper,
  onApplyTemplate,
  onContinue,
}: {
  bomResult: ParsedBomResult | null;
  mappings: CellMapping[];
  templates: { id: string; name: string; gcConsultantName?: string; cellMappings: CellMapping[] }[];
  onOpenMapper: () => void;
  onApplyTemplate: (id: string) => void;
  onContinue: () => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-navy mb-1">Step 3: Map Cells</h3>
      <p className="text-sm text-text-secondary mb-6">
        Define which cells in the template correspond to which BoM cost aggregations. Apply a saved template or create a new mapping.
      </p>

      {/* Saved templates */}
      {templates.length > 0 && (
        <div className="mb-6">
          <h4 className="text-sm font-semibold text-navy mb-2">Saved Templates</h4>
          <div className="grid grid-cols-2 gap-2">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => onApplyTemplate(t.id)}
                className="text-left bg-white border border-border rounded-lg px-4 py-3 hover:border-navy/30 transition-colors"
              >
                <div className="text-sm font-medium text-navy">{t.name}</div>
                {t.gcConsultantName && (
                  <div className="text-xs text-text-secondary">{t.gcConsultantName}</div>
                )}
                <div className="text-xs text-text-secondary mt-1">{t.cellMappings.length} mappings</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Open mapper button */}
      <button
        onClick={onOpenMapper}
        className="w-full flex items-center justify-center gap-2 bg-surface border-2 border-dashed border-border rounded-xl py-8 text-sm font-medium text-navy hover:border-navy/30 transition-colors mb-6"
      >
        <FileSpreadsheet size={20} />
        {mappings.length > 0 ? 'Edit Cell Mappings' : 'Open Cell Mapper'}
      </button>

      {/* Current mappings summary */}
      {mappings.length > 0 && (
        <div className="mb-6">
          <h4 className="text-sm font-semibold text-navy mb-3">
            Mapped Cells ({mappings.length})
          </h4>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface text-left">
                  <th className="px-4 py-2 font-medium text-text-secondary">Sheet</th>
                  <th className="px-4 py-2 font-medium text-text-secondary">Cell</th>
                  <th className="px-4 py-2 font-medium text-text-secondary">Tag</th>
                  <th className="px-4 py-2 font-medium text-text-secondary text-right">Resolved Value</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => {
                  const resolved = bomResult
                    ? resolveTag(m.tag, bomResult.aggregations)
                    : null;
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="px-4 py-2 font-mono text-xs">{m.sheet}</td>
                      <td className="px-4 py-2 font-mono text-xs font-medium">{m.cell}</td>
                      <td className="px-4 py-2 text-xs">{m.tag}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">
                        {resolved === null ? (
                          <span className="text-yellow-600">No data</span>
                        ) : typeof resolved === 'number' ? (
                          formatCurrency(resolved)
                        ) : (
                          resolved
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={onContinue}
          disabled={mappings.length === 0}
          className="btn-primary text-sm px-5 py-2 flex items-center gap-2 disabled:opacity-50"
        >
          Continue
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Generate ────────────────────────────────────────────────────────

function GenerateStep({
  mappings,
  bomResult,
  generationReport,
  generatedBlob,
  canGenerate,
  onGenerate,
  onDownload,
}: {
  mappings: CellMapping[];
  bomResult: ParsedBomResult | null;
  generationReport: GenerationReportEntry[] | null;
  generatedBlob: Blob | null;
  canGenerate: boolean;
  onGenerate: () => void;
  onDownload: () => void;
}) {
  const written = generationReport?.filter((r) => r.status === 'written').length ?? 0;
  const skipped = generationReport?.filter((r) => r.status === 'skipped').length ?? 0;
  const formulaOverwritten = generationReport?.filter((r) => r.status === 'formula_overwritten').length ?? 0;

  return (
    <div>
      <h3 className="text-lg font-semibold text-navy mb-1">Step 4: Generate & Download</h3>
      <p className="text-sm text-text-secondary mb-6">
        Generate the bid leveling XLSX with your BoM data written into the template. The output file is submission-ready.
      </p>

      {!generationReport ? (
        <div className="text-center py-12 bg-surface rounded-xl border border-border">
          <FileSpreadsheet size={40} className="mx-auto text-navy/30 mb-3" />
          <p className="text-sm text-text-secondary mb-4">{mappings.length} cells will be written into the template.</p>
          <button
            onClick={onGenerate}
            disabled={!canGenerate}
            className="btn-primary text-sm px-6 py-2.5 disabled:opacity-50"
          >
            Generate XLSX
          </button>
        </div>
      ) : (
        <div>
          {/* Report summary */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-center">
              <CheckCircle2 size={20} className="mx-auto text-green-600 mb-1" />
              <div className="text-2xl font-bold text-green-800">{written}</div>
              <div className="text-xs text-green-700">Cells Written</div>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-center">
              <AlertTriangle size={20} className="mx-auto text-yellow-600 mb-1" />
              <div className="text-2xl font-bold text-yellow-800">{skipped}</div>
              <div className="text-xs text-yellow-700">Skipped (No Data)</div>
            </div>
            <div className="bg-orange/5 border border-orange/20 rounded-lg px-4 py-3 text-center">
              <AlertTriangle size={20} className="mx-auto text-orange mb-1" />
              <div className="text-2xl font-bold text-navy">{formulaOverwritten}</div>
              <div className="text-xs text-text-secondary">Formulas Overwritten</div>
            </div>
          </div>

          {/* Sanity check totals */}
          {bomResult && (
            <div className="bg-surface rounded-lg border border-border px-5 py-4 mb-6">
              <h4 className="text-sm font-semibold text-navy mb-2">Sanity Check — BoM Totals</h4>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-xs text-text-secondary">Equipment Total</div>
                  <div className="font-mono font-semibold text-navy">{formatCurrency(bomResult.aggregations.all.equipmentTotal)}</div>
                </div>
                <div>
                  <div className="text-xs text-text-secondary">Labor Total</div>
                  <div className="font-mono font-semibold text-navy">{formatCurrency(bomResult.aggregations.all.laborTotal)}</div>
                </div>
                <div>
                  <div className="text-xs text-text-secondary">Grand Total</div>
                  <div className="font-mono font-semibold text-navy">{formatCurrency(bomResult.aggregations.all.grandTotal)}</div>
                </div>
              </div>
            </div>
          )}

          {/* Detailed report */}
          <details className="mb-6">
            <summary className="text-sm font-medium text-navy cursor-pointer hover:text-orange">
              Detailed Generation Report ({generationReport.length} entries)
            </summary>
            <div className="mt-2 border border-border rounded-lg overflow-auto max-h-64">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Cell</th>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Tag</th>
                    <th className="px-3 py-2 text-right font-medium text-text-secondary">Value</th>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {generationReport.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono">{r.sheet}!{r.cell}</td>
                      <td className="px-3 py-1.5">{r.tag}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {typeof r.value === 'number' ? formatCurrency(r.value) : r.value}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          r.status === 'written' ? 'bg-green-100 text-green-700' :
                          r.status === 'skipped' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-orange/10 text-orange'
                        }`}>
                          {r.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary max-w-[200px] truncate">{r.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {/* Download button */}
          {generatedBlob && (
            <div className="flex justify-center">
              <button
                onClick={onDownload}
                className="btn-primary text-sm px-8 py-3 flex items-center gap-2"
              >
                <Download size={16} />
                Download Generated XLSX
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Utility Components ──────────────────────────────────────────────────────

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-white border border-border rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 text-text-secondary mb-1">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-lg font-bold text-navy">{value}</div>
    </div>
  );
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);
}
