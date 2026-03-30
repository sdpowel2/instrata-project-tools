import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { RFI, Project } from '../types';
import letterheadUrl from '../assets/letterhead.pdf?url';

const NAVY      = rgb(0.133, 0.196, 0.431);
const ORANGE    = rgb(0.965, 0.553, 0.180);
const WHITE     = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY  = rgb(0.5, 0.5, 0.55);
const BLACK     = rgb(0.1, 0.1, 0.1);
const GREEN     = rgb(0.13, 0.55, 0.13);
const RED       = rgb(0.75, 0.1, 0.1);

const PAGE_W = PageSizes.Letter[0]; // 612
const PAGE_H = PageSizes.Letter[1]; // 792
const MARGIN  = 72; // 1 inch — clear of letterhead logo/shapes
const CONTENT_W = PAGE_W - MARGIN * 2;

// Content starts below the letterhead header graphic (~top 210pt)
const CONTENT_TOP = PAGE_H - 215;
// Content ends above the letterhead footer (~bottom 70pt)
const CONTENT_BOTTOM = 75;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch: ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Draws word-wrapped text, returns the Y position after the last line. */
function drawWrapped(
  page: ReturnType<PDFDocument['addPage']>,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  font: any,
  color: any,
  lineHeight = size + 4,
): number {
  const words = (text || '').split(/\s+/);
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineHeight;
  }
  return y;
}

export async function exportRFIPDF(rfi: RFI, project: Project): Promise<void> {
  // ── Load letterhead as background ──
  const letterheadBytes = await fetchBytes(letterheadUrl);
  const letterheadDoc   = await PDFDocument.load(letterheadBytes);

  // Create output doc and copy the letterhead page into it
  const pdfDoc = await PDFDocument.create();
  const [letterheadPage] = await pdfDoc.copyPages(letterheadDoc, [0]);
  pdfDoc.addPage(letterheadPage);
  const page = pdfDoc.getPage(0);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const isOverdue = rfi.status === 'Open' && !!rfi.responseDue && new Date(rfi.responseDue) < new Date();

  let y = CONTENT_TOP;

  // ── RFI label + number (top-right of content area) ──
  const rfiLabel = 'REQUEST FOR INFORMATION';
  page.drawText(rfiLabel, {
    x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(rfiLabel, 8),
    y: y + 10,
    size: 8, font: fontBold, color: MID_GRAY,
  });
  page.drawText(rfi.number, {
    x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(rfi.number, 20),
    y: y - 10,
    size: 20, font: fontBold, color: ORANGE,
  });

  // ── Subject ──
  page.drawText(rfi.subject, { x: MARGIN, y, size: 15, font: fontBold, color: NAVY });
  y -= 20;

  // ── Navy rule ──
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: NAVY });
  y -= 14;

  // ── Status badge + date ──
  const statusColor = rfi.status === 'Answered' ? GREEN
    : rfi.status === 'Open' ? (isOverdue ? RED : NAVY)
    : MID_GRAY;
  const statusLabel = isOverdue ? 'OVERDUE' : rfi.status.toUpperCase();
  const badgeW = fontBold.widthOfTextAtSize(statusLabel, 8) + 14;
  page.drawRectangle({ x: MARGIN, y: y - 3, width: badgeW, height: 16, color: statusColor });
  page.drawText(statusLabel, { x: MARGIN + 7, y, size: 8, font: fontBold, color: WHITE });

  page.drawText(`Generated: ${today}`, {
    x: PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(`Generated: ${today}`, 8),
    y, size: 8, font: fontRegular, color: MID_GRAY,
  });
  y -= 22;

  // ── Project info band ──
  page.drawRectangle({ x: MARGIN, y: y - 5, width: CONTENT_W, height: 26, color: LIGHT_GRAY });
  page.drawText(`Project: ${project.name}`, { x: MARGIN + 8, y: y + 4, size: 9, font: fontBold, color: NAVY });
  const projNum = `No. ${project.number}`;
  page.drawText(projNum, {
    x: PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(projNum, 9) - 8,
    y: y + 4, size: 9, font: fontRegular, color: DARK_GRAY,
  });
  y -= 34;

  // ── Metadata grid (2 columns) ──
  const col1X = MARGIN;
  const col2X = MARGIN + CONTENT_W / 2 + 8;

  const metaLeft  = [
    ['SPEC SECTION / DRAWING REF', rfi.specSection || '—'],
    ['CREATED',                    rfi.createdAt    || '—'],
  ];
  const metaRight = [
    ['RESPONSE DUE', rfi.responseDue || '—'],
    ['CLIENT',       project.client  || '—'],
  ];

  for (let i = 0; i < metaLeft.length; i++) {
    const [lLabel, lValue] = metaLeft[i];
    const [rLabel, rValue] = metaRight[i];
    page.drawText(lLabel, { x: col1X, y, size: 7, font: fontBold, color: MID_GRAY });
    page.drawText(rLabel, { x: col2X, y, size: 7, font: fontBold, color: MID_GRAY });
    y -= 13;
    const valueColor = (lLabel === 'RESPONSE DUE' || rLabel === 'RESPONSE DUE') && isOverdue ? RED : DARK_GRAY;
    page.drawText(lValue, { x: col1X, y, size: 10, font: fontRegular, color: DARK_GRAY });
    page.drawText(rValue, { x: col2X, y, size: 10, font: fontRegular, color: valueColor });
    y -= 22;
  }

  // ── Orange rule ──
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: ORANGE });
  y -= 16;

  // ── Question / Description ──
  page.drawText('QUESTION / DESCRIPTION', { x: MARGIN, y, size: 7, font: fontBold, color: MID_GRAY });
  y -= 13;
  y = drawWrapped(page, rfi.description || '', MARGIN, y, CONTENT_W, 10, fontRegular, BLACK);
  y -= 14;

  // ── Response (if answered) ──
  if (rfi.status === 'Answered' && rfi.responseSummary) {
    page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: GREEN });
    y -= 16;

    page.drawText('RESPONSE', { x: MARGIN, y, size: 7, font: fontBold, color: rgb(0.13, 0.55, 0.13) });
    y -= 13;
    y = drawWrapped(page, rfi.responseSummary, MARGIN, y, CONTENT_W, 10, fontRegular, BLACK);
    y -= 8;

    const byLine = `Answered by ${rfi.answeredBy || '—'}${rfi.answeredAt ? ` on ${rfi.answeredAt}` : ''}`;
    page.drawText(byLine, { x: MARGIN, y, size: 8, font: fontItalic, color: MID_GRAY });
  }

  // ── Save & download ──
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `RFI-${rfi.number} - ${rfi.subject}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
