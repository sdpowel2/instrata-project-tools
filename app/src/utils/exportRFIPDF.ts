import { PDFDocument, PDFPage, PDFFont, PDFImage, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { RFI, Project } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';

// Brand colors (match exportSubmittalPDF)
const NAVY = rgb(0.133, 0.196, 0.431); // #22326E
const ORANGE = rgb(0.965, 0.553, 0.180); // #F68D2E
const WHITE = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY = rgb(0.5, 0.5, 0.55);
const BLACK = rgb(0.1, 0.1, 0.1);

const PAGE_W = PageSizes.Letter[0]; // 612
const PAGE_H = PageSizes.Letter[1]; // 792
const MARGIN = 54; // 0.75 inch
const CONTENT_W = PAGE_W - MARGIN * 2;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function addFooter(page: PDFPage, font: PDFFont, pageNum: number, totalLabel?: string) {
  const y = 30;
  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: PAGE_W - MARGIN, y: y + 12 },
    thickness: 0.5,
    color: LIGHT_GRAY,
  });
  page.drawText(`Page ${pageNum}`, {
    x: PAGE_W - MARGIN - font.widthOfTextAtSize(`Page ${pageNum}`, 8),
    y,
    size: 8,
    font,
    color: MID_GRAY,
  });
  if (totalLabel) {
    page.drawText(totalLabel, { x: MARGIN, y, size: 8, font, color: MID_GRAY });
  }
}

/** Word-wrap text into lines that fit maxWidth. */
function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawTableRow(
  page: PDFPage,
  y: number,
  cols: { text: string; x: number; w: number }[],
  font: PDFFont,
  size: number,
  color: typeof BLACK,
  bg?: typeof LIGHT_GRAY
) {
  if (bg) {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: bg });
  }
  for (const col of cols) {
    const original = sanitize(col.text);
    let text = original;
    while (font.widthOfTextAtSize(text, size) > col.w - 4 && text.length > 0) {
      text = text.slice(0, -1);
    }
    if (text !== original && text.length > 0) text = text.slice(0, -1) + '…';
    page.drawText(text, { x: col.x, y, size, font, color });
  }
}

async function loadLogo(pdfDoc: PDFDocument): Promise<PDFImage | undefined> {
  try {
    const logoBytes = await fetchImageBytes(instrataLogoUrl);
    return await pdfDoc.embedPng(logoBytes);
  } catch {
    return undefined; // Logo optional
  }
}

/**
 * Render one RFI starting on a fresh page. Intentionally omits status —
 * these documents are client-facing, so internal workflow state (Open /
 * Answered / Closed / Void) stays out of the export.
 * Returns the page number of the last page drawn.
 */
function renderRFI(
  pdfDoc: PDFDocument,
  rfi: RFI,
  project: Project,
  fonts: Fonts,
  logoImage: PDFImage | undefined,
  startPageNum: number,
): number {
  const { regular, bold, italic } = fonts;
  const rfiNumber = sanitize(rfi.number);
  const footerLabel = `RFI ${rfiNumber} — ${sanitize(project.number)}`;
  const BOTTOM_LIMIT = MARGIN + 20; // keep clear of the footer rule

  let pageNum = startPageNum + 1;
  let page = pdfDoc.addPage(PageSizes.Letter);

  const newPage = (): number => {
    addFooter(page, regular, pageNum, footerLabel);
    page = pdfDoc.addPage(PageSizes.Letter);
    pageNum++;
    const bandY = PAGE_H - MARGIN;
    page.drawRectangle({ x: 0, y: bandY - 4, width: PAGE_W, height: 40, color: NAVY });
    page.drawText(`Request for Information ${rfiNumber} (continued)`, {
      x: MARGIN,
      y: bandY + 6,
      size: 14,
      font: bold,
      color: WHITE,
    });
    return bandY - 40;
  };

  const ensure = (y: number, needed: number): number =>
    y - needed < BOTTOM_LIMIT ? newPage() : y;

  const drawParagraph = (
    text: string,
    y: number,
    size: number,
    font: PDFFont,
    color: typeof BLACK,
    x = MARGIN,
    maxWidth = CONTENT_W,
  ): number => {
    const lineHeight = size + 4;
    for (const line of wrapLines(text, font, size, maxWidth)) {
      y = ensure(y, lineHeight);
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
    }
    return y;
  };

  // ── Header: orange bar, logo, RFI number ──
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: ORANGE });

  if (logoImage) {
    let logoW = 130;
    let logoH = logoImage.height * (logoW / logoImage.width);
    if (logoH > 36) {
      logoH = 36;
      logoW = logoImage.width * (logoH / logoImage.height);
    }
    page.drawImage(logoImage, { x: MARGIN, y: PAGE_H - 30 - logoH, width: logoW, height: logoH });
  }

  const rfiLabel = 'REQUEST FOR INFORMATION';
  page.drawText(rfiLabel, {
    x: PAGE_W - MARGIN - bold.widthOfTextAtSize(rfiLabel, 8),
    y: PAGE_H - 38,
    size: 8,
    font: bold,
    color: MID_GRAY,
  });
  page.drawText(rfiNumber, {
    x: PAGE_W - MARGIN - bold.widthOfTextAtSize(rfiNumber, 20),
    y: PAGE_H - 58,
    size: 20,
    font: bold,
    color: ORANGE,
  });

  // Navy rule under the header
  page.drawRectangle({ x: MARGIN, y: PAGE_H - 78, width: CONTENT_W, height: 1.5, color: NAVY });

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const issued = `Issued: ${today}`;
  page.drawText(issued, {
    x: PAGE_W - MARGIN - regular.widthOfTextAtSize(issued, 8),
    y: PAGE_H - 92,
    size: 8,
    font: regular,
    color: MID_GRAY,
  });

  // Project band top sits at y + 21 — keep that below the issued line above.
  let y = PAGE_H - 124;

  // ── Project info band ──
  page.drawRectangle({ x: MARGIN, y: y - 5, width: CONTENT_W, height: 26, color: LIGHT_GRAY });
  page.drawText(sanitize(`Project: ${project.name}`), { x: MARGIN + 8, y: y + 4, size: 9, font: bold, color: NAVY });
  const projNum = sanitize(`No. ${project.number}`);
  page.drawText(projNum, {
    x: PAGE_W - MARGIN - regular.widthOfTextAtSize(projNum, 9) - 8,
    y: y + 4,
    size: 9,
    font: regular,
    color: DARK_GRAY,
  });
  y -= 36;

  // ── Subject with orange accent ──
  page.drawRectangle({ x: MARGIN, y: y - 2, width: 4, height: 16, color: ORANGE });
  y = drawParagraph(sanitize(rfi.subject), y, 14, bold, NAVY, MARGIN + 12, CONTENT_W - 12);
  y -= 10;

  // ── Metadata grid (2 columns) ──
  const col1X = MARGIN;
  const col2X = MARGIN + CONTENT_W / 2 + 8;
  const metaRows: [string, string, string, string][] = [
    ['SPEC SECTION / DRAWING REF', sanitize(rfi.specSection) || '—', 'RESPONSE DUE', sanitize(rfi.responseDue) || '—'],
    ['CREATED', sanitize(rfi.createdAt) || '—', 'CLIENT', sanitize(project.client) || '—'],
  ];
  for (const [lLabel, lValue, rLabel, rValue] of metaRows) {
    y = ensure(y, 35);
    page.drawText(lLabel, { x: col1X, y, size: 7, font: bold, color: MID_GRAY });
    page.drawText(rLabel, { x: col2X, y, size: 7, font: bold, color: MID_GRAY });
    y -= 13;
    page.drawText(lValue, { x: col1X, y, size: 10, font: regular, color: DARK_GRAY });
    page.drawText(rValue, { x: col2X, y, size: 10, font: regular, color: DARK_GRAY });
    y -= 22;
  }

  // ── Question / Description ──
  y = ensure(y, 40);
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: ORANGE });
  y -= 16;
  page.drawText('QUESTION / DESCRIPTION', { x: MARGIN, y, size: 7, font: bold, color: MID_GRAY });
  y -= 13;
  y = drawParagraph(rfi.description || '', y, 10, regular, BLACK);
  y -= 14;

  // ── Response (if answered) ──
  if (rfi.status === 'Answered' && rfi.responseSummary) {
    y = ensure(y, 40);
    page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: NAVY });
    y -= 16;
    page.drawText('RESPONSE', { x: MARGIN, y, size: 7, font: bold, color: NAVY });
    y -= 13;
    y = drawParagraph(rfi.responseSummary, y, 10, regular, BLACK);
    y -= 8;

    y = ensure(y, 14);
    const byLine = sanitize(`Answered by ${rfi.answeredBy || '—'}${rfi.answeredAt ? ` on ${rfi.answeredAt}` : ''}`);
    page.drawText(byLine, { x: MARGIN, y, size: 8, font: italic, color: MID_GRAY });
  }

  addFooter(page, regular, pageNum, footerLabel);
  return pageNum;
}

function downloadPdf(pdfBytes: Uint8Array, filename: string) {
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Export a single RFI as a client-facing PDF (no internal status shown). */
export async function exportRFIPDF(rfi: RFI, project: Project): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  };
  const logoImage = await loadLogo(pdfDoc);

  renderRFI(pdfDoc, rfi, project, fonts, logoImage, 0);

  const pdfBytes = await pdfDoc.save();
  downloadPdf(pdfBytes, `RFI-${rfi.number} - ${rfi.subject}.pdf`);
}

/**
 * Export all open RFIs on a project as a single client-facing package:
 * cover page + summary table + one detail section per RFI. Closed and
 * Void RFIs are excluded.
 */
export async function exportRFILogPDF(rfis: RFI[], project: Project): Promise<void> {
  const openRFIs = rfis
    .filter((r) => r.status !== 'Closed' && r.status !== 'Void')
    .sort((a, b) => a.number.localeCompare(b.number));
  if (openRFIs.length === 0) return;

  const pdfDoc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  };
  const logoImage = await loadLogo(pdfDoc);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let currentPageNum = 0;

  // ===================== COVER PAGE =====================
  const coverPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;

  coverPage.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: ORANGE });

  if (logoImage) {
    const logoW = 340;
    const logoScale = logoW / logoImage.width;
    const logoH = logoImage.height * logoScale;
    coverPage.drawImage(logoImage, {
      x: (PAGE_W - logoW) / 2,
      y: PAGE_H - 160 - logoH / 2,
      width: logoW,
      height: logoH,
    });
  }

  coverPage.drawRectangle({ x: MARGIN + 80, y: PAGE_H - 240, width: CONTENT_W - 160, height: 2, color: ORANGE });

  const projectName = sanitize(project.name);
  coverPage.drawText(projectName, {
    x: (PAGE_W - fonts.bold.widthOfTextAtSize(projectName, 22)) / 2,
    y: PAGE_H - 300,
    size: 22,
    font: fonts.bold,
    color: NAVY,
  });

  const logTitle = 'Request for Information Log';
  coverPage.drawText(logTitle, {
    x: (PAGE_W - fonts.regular.widthOfTextAtSize(logTitle, 16)) / 2,
    y: PAGE_H - 330,
    size: 16,
    font: fonts.regular,
    color: DARK_GRAY,
  });

  const countText = `${openRFIs.length} Open RFI${openRFIs.length === 1 ? '' : 's'}`;
  coverPage.drawText(countText, {
    x: (PAGE_W - fonts.italic.widthOfTextAtSize(countText, 11)) / 2,
    y: PAGE_H - 355,
    size: 11,
    font: fonts.italic,
    color: MID_GRAY,
  });

  const detailsY = PAGE_H - 430;
  const detailLines = [
    { label: 'Client:', value: sanitize(project.client) },
    { label: 'Date:', value: today },
    { label: 'Project No.:', value: sanitize(project.number) },
  ];
  for (let i = 0; i < detailLines.length; i++) {
    const d = detailLines[i];
    const y = detailsY - i * 24;
    const labelW = fonts.bold.widthOfTextAtSize(d.label, 11);
    const totalW = labelW + 8 + fonts.regular.widthOfTextAtSize(d.value, 11);
    const startX = (PAGE_W - totalW) / 2;
    coverPage.drawText(d.label, { x: startX, y, size: 11, font: fonts.bold, color: NAVY });
    coverPage.drawText(d.value, { x: startX + labelW + 8, y, size: 11, font: fonts.regular, color: DARK_GRAY });
  }

  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });
  const footerText = 'Instrata Project Tools — RFI Log';
  coverPage.drawText(footerText, {
    x: (PAGE_W - fonts.italic.widthOfTextAtSize(footerText, 8)) / 2,
    y: 16,
    size: 8,
    font: fonts.italic,
    color: MID_GRAY,
  });

  // ===================== SUMMARY TABLE =====================
  let summaryPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let sumY = PAGE_H - MARGIN;

  summaryPage.drawRectangle({ x: 0, y: sumY - 4, width: PAGE_W, height: 40, color: NAVY });
  summaryPage.drawText('RFI Summary', { x: MARGIN, y: sumY + 6, size: 18, font: fonts.bold, color: WHITE });
  sumY -= 60;

  const sumCols = [
    { label: 'RFI #', x: MARGIN, w: 64 },
    { label: 'Subject', x: MARGIN + 64, w: 230 },
    { label: 'Spec Section', x: MARGIN + 294, w: 110 },
    { label: 'Response Due', x: MARGIN + 404, w: 100 },
  ];

  const drawSummaryHeader = () => {
    summaryPage.drawRectangle({ x: MARGIN, y: sumY - 4, width: CONTENT_W, height: 18, color: NAVY });
    for (const col of sumCols) {
      summaryPage.drawText(col.label, { x: col.x + 4, y: sumY, size: 8, font: fonts.bold, color: WHITE });
    }
    sumY -= 20;
  };
  drawSummaryHeader();

  for (let i = 0; i < openRFIs.length; i++) {
    if (sumY < MARGIN + 40) {
      addFooter(summaryPage, fonts.regular, currentPageNum, 'RFI Summary');
      summaryPage = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      sumY = PAGE_H - MARGIN;
      drawSummaryHeader();
    }
    const r = openRFIs[i];
    const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
    drawTableRow(summaryPage, sumY, [
      { text: r.number, x: sumCols[0].x + 4, w: sumCols[0].w },
      { text: r.subject, x: sumCols[1].x + 4, w: sumCols[1].w },
      { text: r.specSection || '—', x: sumCols[2].x + 4, w: sumCols[2].w },
      { text: r.responseDue || '—', x: sumCols[3].x + 4, w: sumCols[3].w },
    ], fonts.regular, 9, BLACK, bg);
    sumY -= 18;
  }

  summaryPage.drawLine({
    start: { x: MARGIN, y: sumY + 2 },
    end: { x: PAGE_W - MARGIN, y: sumY + 2 },
    thickness: 0.5,
    color: MID_GRAY,
  });
  const totalText = `${openRFIs.length} open RFI${openRFIs.length === 1 ? '' : 's'}`;
  summaryPage.drawText(totalText, {
    x: PAGE_W - MARGIN - fonts.italic.widthOfTextAtSize(totalText, 8),
    y: sumY - 8,
    size: 8,
    font: fonts.italic,
    color: MID_GRAY,
  });
  addFooter(summaryPage, fonts.regular, currentPageNum, 'RFI Summary');

  // ===================== RFI DETAIL PAGES =====================
  for (const rfi of openRFIs) {
    currentPageNum = renderRFI(pdfDoc, rfi, project, fonts, logoImage, currentPageNum);
  }

  const pdfBytes = await pdfDoc.save();
  downloadPdf(pdfBytes, `${project.number} - RFI Log.pdf`);
}
