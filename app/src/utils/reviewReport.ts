import jsPDF from 'jspdf';
import type { ReviewFlag, ReviewRun } from '../types';
import type { CsvRow } from './reviewEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { high: 0, moderate: 1, low: 2 };

function sortFlags(flags: ReviewFlag[]): ReviewFlag[] {
  return [...flags].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
}

function severityLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build a map from model number (lowercase) → list of locations with quantities */
function buildLocationMap(csvRows: CsvRow[]): Map<string, { location: string; qty: number }[]> {
  const map = new Map<string, { location: string; qty: number }[]>();
  for (const r of csvRows) {
    if (r.itemType.toLowerCase() !== 'product') continue;
    if (!r.modelNumber || r.modelNumber === 'S&H' || r.modelNumber === 'MISC') continue;
    const key = r.modelNumber.trim().toLowerCase();
    const loc = r.location || 'Unassigned';
    const qty = r.quantity ?? 0;
    const arr = map.get(key) ?? [];
    arr.push({ location: loc, qty });
    map.set(key, arr);
  }
  // Also handle labor refs (format: "laborType @ location")
  for (const r of csvRows) {
    if (r.itemType.toLowerCase() !== 'labor') continue;
    const types = r.laborTypes?.length ? r.laborTypes : [r.modelNumber || ''];
    const loc = r.location || 'Unassigned';
    for (const lt of types) {
      if (!lt) continue;
      const compoundKey = `${lt.trim()} @ ${loc}`.toLowerCase();
      const arr = map.get(compoundKey) ?? [];
      arr.push({ location: loc, qty: r.quantity ?? 1 });
      map.set(compoundKey, arr);
    }
  }
  return map;
}

// ─── PDF Builder ─────────────────────────────────────────────────────────────

interface ReportOptions {
  projectName: string;
  projectNumber: string;
  run: ReviewRun;
  flags: ReviewFlag[];
  csvRows: CsvRow[];
  action: 'approved' | 'changes_requested';
}

export function generateReviewSummaryPdf(opts: ReportOptions): void {
  const { projectName, projectNumber, run, flags, csvRows, action } = opts;
  const locationMap = buildLocationMap(csvRows);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const checkPageBreak = (needed: number) => {
    if (y + needed > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Header ──────────────────────────────────────────────────────────────

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Review Summary Report', margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  const actionLabel = action === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED';
  doc.text(`${actionLabel}  |  Run #${run.runNumber}  |  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, margin, y);
  y += 6;

  doc.setTextColor(0);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(projectName, margin, y);
  y += 5;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);
  doc.text(projectNumber, margin, y);
  y += 8;

  // Divider
  doc.setDrawColor(200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // ── Summary counts ──────────────────────────────────────────────────────

  const openFlags     = flags.filter(f => f.status === 'open' || f.status === 'commented');
  const resolvedFlags = flags.filter(f => f.status === 'resolved');
  const waivedFlags   = flags.filter(f => f.status === 'waived');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text('Summary', margin, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = [
    `Total flags: ${flags.length}`,
    `Open: ${openFlags.length}    Resolved: ${resolvedFlags.length}    Waived: ${waivedFlags.length}`,
  ];
  for (const line of summaryLines) {
    doc.text(line, margin + 2, y);
    y += 4;
  }
  y += 4;

  // ── Flag sections ───────────────────────────────────────────────────────

  const renderSection = (title: string, sectionFlags: ReviewFlag[], accentColor: [number, number, number]) => {
    if (sectionFlags.length === 0) return;

    checkPageBreak(15);
    // Section header
    doc.setFillColor(...accentColor);
    doc.rect(margin, y - 1, contentWidth, 7, 'F');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255);
    doc.text(`${title} (${sectionFlags.length})`, margin + 3, y + 4);
    y += 10;
    doc.setTextColor(0);

    const sorted = sortFlags(sectionFlags);
    for (const flag of sorted) {
      // Estimate space needed
      const descLines = doc.splitTextToSize(flag.description, contentWidth - 10);
      const commentLines = flag.managerComment ? doc.splitTextToSize(`Note: ${flag.managerComment}`, contentWidth - 10) : [];
      const refKey = flag.lineItemRef?.trim().toLowerCase() ?? '';
      const locCount = (locationMap.get(refKey) ?? []).length;
      const needed = 14 + descLines.length * 3.5 + commentLines.length * 3.5 + locCount * 3;
      checkPageBreak(needed);

      // Severity + flag name
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      const sevColor: Record<string, [number, number, number]> = {
        high: [220, 38, 38], moderate: [217, 119, 6], low: [37, 99, 235],
      };
      doc.setTextColor(...(sevColor[flag.severity] ?? [0, 0, 0]));
      doc.text(`[${severityLabel(flag.severity)}]`, margin + 2, y);
      const sevWidth = doc.getTextWidth(`[${severityLabel(flag.severity)}] `);
      doc.setTextColor(0);
      doc.text(flag.flagName, margin + 2 + sevWidth, y);
      y += 4;

      // Line item ref + occurrence count and locations
      if (flag.lineItemRef) {
        const refKey = flag.lineItemRef.trim().toLowerCase();
        const locations = locationMap.get(refKey) ?? [];
        const totalQty = locations.reduce((s, l) => s + l.qty, 0);

        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(80);
        const refLabel = totalQty > 0
          ? `${flag.lineItemRef}  —  ${locations.length} location${locations.length !== 1 ? 's' : ''}, qty ${totalQty}`
          : flag.lineItemRef;
        doc.text(refLabel, margin + 4, y);
        y += 3.5;

        // Show each location with sub-location breakdown
        if (locations.length > 0) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(110);
          for (const loc of locations) {
            checkPageBreak(4);
            // Parse sub-locations from colon-separated location string
            const segments = loc.location.split(':').map(s => s.trim()).filter(Boolean);
            const locLabel = segments.length > 1
              ? segments.join('  ›  ')
              : loc.location;
            doc.text(`  •  ${locLabel}  (qty ${loc.qty})`, margin + 6, y);
            y += 3;
          }
          y += 1;
        }
      }

      // Description
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(60);
      for (const line of descLines) {
        doc.text(line, margin + 4, y);
        y += 3.5;
      }

      // Manager comment
      if (commentLines.length > 0) {
        doc.setTextColor(30, 80, 160);
        doc.setFont('helvetica', 'italic');
        for (const line of commentLines) {
          doc.text(line, margin + 4, y);
          y += 3.5;
        }
      }

      doc.setTextColor(0);
      y += 2;

      // Light separator
      doc.setDrawColor(230);
      doc.line(margin + 2, y, pageWidth - margin - 2, y);
      y += 3;
    }

    y += 3;
  };

  // Render sections based on action type
  if (action === 'changes_requested') {
    renderSection('Open Items — Action Required', openFlags, [220, 38, 38]);
    renderSection('Resolved Items', resolvedFlags, [22, 163, 74]);
    renderSection('Waived Items', waivedFlags, [147, 51, 234]);
  } else {
    renderSection('Resolved Items', resolvedFlags, [22, 163, 74]);
    renderSection('Waived Items', waivedFlags, [147, 51, 234]);
    if (openFlags.length > 0) {
      renderSection('Remaining Open Items', openFlags, [220, 38, 38]);
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(160);
    doc.text(
      `${projectName} — Review Run #${run.runNumber} — Page ${i} of ${pageCount}`,
      pageWidth / 2, doc.internal.pageSize.getHeight() - 8,
      { align: 'center' },
    );
  }

  // ── Download ────────────────────────────────────────────────────────────

  const safeProject = projectNumber.replace(/[^a-zA-Z0-9-_]/g, '_');
  const dateStr = new Date().toISOString().split('T')[0];
  const suffix = action === 'approved' ? 'Approved' : 'Changes_Requested';
  doc.save(`${safeProject}_Review_Run${run.runNumber}_${suffix}_${dateStr}.pdf`);
}
