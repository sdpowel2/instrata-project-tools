import { useState, useMemo } from 'react';
import { X, Check, Trash2, Save } from 'lucide-react';
import type { CellMapping } from '../types';
import { getAvailableTags } from '../utils/bidLevelingEngine';

interface CellMapperModalProps {
  open: boolean;
  onClose: () => void;
  sheetNames: string[];
  sheetData: Map<string, string[][]>;
  locations: string[];
  mappings: CellMapping[];
  onMappingsChange: (mappings: CellMapping[]) => void;
  onSaveTemplate: (name: string, gcName: string) => void;
}

export function CellMapperModal({
  open,
  onClose,
  sheetNames,
  sheetData,
  locations,
  mappings,
  onMappingsChange,
  onSaveTemplate,
}: CellMapperModalProps) {
  const [activeSheet, setActiveSheet] = useState(sheetNames[0] ?? '');
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [saveMode, setSaveMode] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [gcName, setGcName] = useState('');

  const availableTags = useMemo(() => getAvailableTags(locations), [locations]);

  const currentSheetData = sheetData.get(activeSheet) ?? [];

  // Convert row/col index to Excel cell address (e.g., A1, B2, AA3)
  function cellAddress(row: number, col: number): string {
    let addr = '';
    let c = col;
    while (c >= 0) {
      addr = String.fromCharCode(65 + (c % 26)) + addr;
      c = Math.floor(c / 26) - 1;
    }
    return `${addr}${row + 1}`;
  }

  function getMappingForCell(sheet: string, cell: string): CellMapping | undefined {
    return mappings.find(m => m.sheet === sheet && m.cell === cell);
  }

  function assignTag(tag: string) {
    if (!selectedCell) return;
    const existing = mappings.filter(m => !(m.sheet === activeSheet && m.cell === selectedCell));
    onMappingsChange([...existing, { sheet: activeSheet, cell: selectedCell, tag }]);
    setSelectedCell(null);
    setTagFilter('');
  }

  function removeMapping(sheet: string, cell: string) {
    onMappingsChange(mappings.filter(m => !(m.sheet === sheet && m.cell === cell)));
  }

  function handleSaveTemplate() {
    if (!templateName.trim()) return;
    onSaveTemplate(templateName.trim(), gcName.trim());
    setSaveMode(false);
    setTemplateName('');
    setGcName('');
  }

  const filteredTags = tagFilter
    ? availableTags.filter(t => t.label.toLowerCase().includes(tagFilter.toLowerCase()))
    : availableTags;

  // Group tags by location for display
  const tagGroups = useMemo(() => {
    const groups = new Map<string, typeof availableTags>();
    for (const tag of filteredTags) {
      const arr = groups.get(tag.group) ?? [];
      arr.push(tag);
      groups.set(tag.group, arr);
    }
    return groups;
  }, [filteredTags]);

  if (!open) return null;

  // Limit grid rendering to avoid performance issues with large sheets
  const maxRows = Math.min(currentSheetData.length, 100);
  const maxCols = currentSheetData.length > 0
    ? Math.min(Math.max(...currentSheetData.slice(0, maxRows).map(r => r.length)), 30)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[3vh] px-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-7xl max-h-[94vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-navy">Cell Mapper</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSaveMode(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-navy border border-border rounded-lg hover:bg-surface transition-colors"
            >
              <Save size={14} />
              Save as Template
            </button>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface text-text-secondary">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left panel: Sheet preview */}
          <div className="flex-1 flex flex-col overflow-hidden border-r border-border">
            {/* Sheet tabs */}
            <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-border bg-surface shrink-0">
              {sheetNames.map((name) => (
                <button
                  key={name}
                  onClick={() => { setActiveSheet(name); setSelectedCell(null); }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${
                    activeSheet === name
                      ? 'bg-white text-navy border border-b-0 border-border'
                      : 'text-text-secondary hover:text-navy hover:bg-white/50'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-auto p-2">
              {currentSheetData.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
                  Empty sheet
                </div>
              ) : (
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="sticky top-0 left-0 z-20 bg-gray-100 border border-border px-1 py-0.5 text-center text-text-secondary font-mono w-10" />
                      {Array.from({ length: maxCols }, (_, c) => (
                        <th key={c} className="sticky top-0 z-10 bg-gray-100 border border-border px-2 py-0.5 text-center text-text-secondary font-mono min-w-[80px]">
                          {cellAddress(0, c).replace(/\d+$/, '')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {currentSheetData.slice(0, maxRows).map((row, r) => (
                      <tr key={r}>
                        <td className="sticky left-0 z-10 bg-gray-100 border border-border px-1 py-0.5 text-center text-text-secondary font-mono">
                          {r + 1}
                        </td>
                        {Array.from({ length: maxCols }, (_, c) => {
                          const addr = cellAddress(r, c);
                          const mapping = getMappingForCell(activeSheet, addr);
                          const isSelected = selectedCell === addr;
                          const value = row[c] ?? '';
                          return (
                            <td
                              key={c}
                              onClick={() => setSelectedCell(isSelected ? null : addr)}
                              className={`border border-border px-2 py-0.5 cursor-pointer truncate max-w-[160px] transition-colors ${
                                mapping
                                  ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-300'
                                  : isSelected
                                    ? 'bg-orange/10 border-orange ring-1 ring-orange'
                                    : 'hover:bg-surface'
                              }`}
                              title={mapping ? `Tag: ${mapping.tag}` : String(value)}
                            >
                              {mapping ? (
                                <span className="text-blue-700 font-medium text-[10px]">{mapping.tag}</span>
                              ) : (
                                String(value)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {currentSheetData.length > maxRows && (
                <p className="text-xs text-text-secondary mt-2 px-2">
                  Showing first {maxRows} of {currentSheetData.length} rows.
                </p>
              )}
            </div>
          </div>

          {/* Right panel: Tag selector / Mappings summary */}
          <div className="w-80 flex flex-col overflow-hidden bg-surface/50">
            {selectedCell ? (
              /* Tag assignment panel */
              <div className="flex flex-col flex-1 overflow-hidden">
                <div className="px-4 pt-4 pb-2 shrink-0">
                  <h3 className="text-sm font-semibold text-navy">
                    Assign Tag to <span className="font-mono text-orange">{activeSheet}!{selectedCell}</span>
                  </h3>
                  <input
                    type="text"
                    placeholder="Filter tags..."
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    className="input mt-2 text-sm"
                  />
                </div>
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  {Array.from(tagGroups.entries()).map(([group, tags]) => (
                    <div key={group} className="mb-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-text-secondary mb-1">{group}</div>
                      {tags.map((tag) => {
                        const alreadyUsed = mappings.some(m => m.tag === tag.value);
                        return (
                          <button
                            key={tag.value}
                            onClick={() => assignTag(tag.value)}
                            disabled={alreadyUsed}
                            className={`w-full text-left px-2 py-1.5 text-xs rounded-md mb-0.5 transition-colors ${
                              alreadyUsed
                                ? 'text-text-secondary/50 bg-transparent cursor-not-allowed line-through'
                                : 'text-navy hover:bg-blue-50'
                            }`}
                          >
                            {tag.label}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Mappings summary panel */
              <div className="flex flex-col flex-1 overflow-hidden">
                <div className="px-4 pt-4 pb-2 shrink-0">
                  <h3 className="text-sm font-semibold text-navy">
                    Current Mappings ({mappings.length})
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    Click a cell in the grid to assign a tag.
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  {mappings.length === 0 ? (
                    <p className="text-xs text-text-secondary mt-4 text-center">No mappings yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {mappings.map((m, i) => (
                        <div key={i} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-border">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-navy">{m.sheet}!{m.cell}</div>
                            <div className="text-[10px] text-text-secondary truncate">{m.tag}</div>
                          </div>
                          <button
                            onClick={() => removeMapping(m.sheet, m.cell)}
                            className="p-1 text-red-400 hover:text-red-600 shrink-0"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-surface/50 shrink-0">
          <div className="text-xs text-text-secondary">
            {mappings.length} cell{mappings.length !== 1 ? 's' : ''} mapped
          </div>
          <button
            onClick={onClose}
            className="btn-primary text-sm px-4 py-2 flex items-center gap-1.5"
          >
            <Check size={14} />
            Done
          </button>
        </div>
      </div>

      {/* Save Template Modal (overlay on top) */}
      {saveMode && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/30" onClick={() => setSaveMode(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-navy mb-4">Save Mapping Template</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-navy mb-1">Template Name *</label>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g., Holder Construction — AV Summary v2"
                  className="input text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy mb-1">GC / Consultant Name</label>
                <input
                  type="text"
                  value={gcName}
                  onChange={(e) => setGcName(e.target.value)}
                  placeholder="e.g., Holder Construction"
                  className="input text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setSaveMode(false)} className="btn-secondary text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={!templateName.trim()}
                className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
              >
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
