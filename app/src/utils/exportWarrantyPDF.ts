import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { Project, Warranty } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';

// Brand colors (mirrors exportPunchListPDF.ts / exportCloseoutPDF.ts)
const NAVY = rgb(0.133, 0.196, 0.431); // #22326E
const ORANGE = rgb(0.965, 0.553, 0.180); // #F68D2E
const WHITE = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY = rgb(0.5, 0.5, 0.55);
const BLACK = rgb(0.1, 0.1, 0.1);

const PAGE_W = PageSizes.Letter[0]; // 612
const PAGE_H = PageSizes.Letter[1]; // 792
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

function addFooter(page: PDFPage, font: PDFFont, pageNum: number, sectionLabel?: string) {
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
  if (sectionLabel) {
    page.drawText(sectionLabel, { x: MARGIN, y, size: 8, font, color: MID_GRAY });
  }
}

/** Wrap text to a max width, returning lines that fit. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = sanitize(text);
  if (!clean) return [''];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let truncated = word;
        while (truncated.length > 0 && font.widthOfTextAtSize(truncated + '…', size) > maxWidth) {
          truncated = truncated.slice(0, -1);
        }
        current = truncated + '…';
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** Draw one table row, truncating each cell to its column width. Mirrors the
 *  warranty table in exportCloseoutPDF.ts so the standalone doc matches. */
function drawTableRow(
  page: PDFPage,
  y: number,
  cols: { text: string; x: number; w: number }[],
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
  bg?: ReturnType<typeof rgb>,
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

/** Parse a date value as a *local* date. A bare `YYYY-MM-DD` is split by hand
 *  so it doesn't shift a day in timezones behind UTC (`new Date('2026-02-26')`
 *  is UTC midnight, which renders as the 25th in US zones). Returns null if
 *  unparseable. */
function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a warranty date as "Feb 25, 2036". Falls back to the raw string if
 *  it can't be parsed, and to an em-dash when empty. */
function formatWarrantyDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseLocalDate(value);
  return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : value;
}

/**
 * Standalone Warranties PDF — branded cover (matches the punch-list / sign-off
 * exports) followed by the same warranty table used in the full Closeout
 * Package export, so the section can be printed on its own.
 */
export async function exportWarrantyPDF(
  project: Project,
  warranties: Warranty[],
): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let logoImage;
  try {
    const logoBytes = await fetchImageBytes(instrataLogoUrl);
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch {
    // Logo optional
  }

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

  // Project name — wrap with breathing room; step down a size if a single
  // long word still overflows at 22pt (matches the other PDFs).
  const HERO_MAX_W = CONTENT_W - 80;
  let projectNameSize = 22;
  let projectNameLines = wrapText(project.name, fontBold, projectNameSize, HERO_MAX_W);
  if (projectNameLines.some((l) => fontBold.widthOfTextAtSize(l, projectNameSize) > HERO_MAX_W)) {
    projectNameSize = 18;
    projectNameLines = wrapText(project.name, fontBold, projectNameSize, HERO_MAX_W);
  }
  const nameLineHeight = projectNameSize + 6;
  const nameTopY = PAGE_H - 300;
  for (let i = 0; i < projectNameLines.length; i++) {
    const line = projectNameLines[i];
    const w = fontBold.widthOfTextAtSize(line, projectNameSize);
    coverPage.drawText(line, {
      x: (PAGE_W - w) / 2,
      y: nameTopY - i * nameLineHeight,
      size: projectNameSize,
      font: fontBold,
      color: NAVY,
    });
  }
  const nameBlockBottom = nameTopY - (projectNameLines.length - 1) * nameLineHeight;

  // Document title
  const titleText = 'Warranties';
  const titleSize = 16;
  const titleW = fontRegular.widthOfTextAtSize(titleText, titleSize);
  const titleY = nameBlockBottom - 30;
  coverPage.drawText(titleText, {
    x: (PAGE_W - titleW) / 2,
    y: titleY,
    size: titleSize,
    font: fontRegular,
    color: DARK_GRAY,
  });

  // Subtitle: count
  const subtitle = `${warranties.length} warrant${warranties.length === 1 ? 'y' : 'ies'}`;
  const subtitleW = fontItalic.widthOfTextAtSize(subtitle, 11);
  const subtitleY = titleY - 25;
  coverPage.drawText(subtitle, {
    x: (PAGE_W - subtitleW) / 2,
    y: subtitleY,
    size: 11,
    font: fontItalic,
    color: MID_GRAY,
  });

  // Details block
  const detailLines = [
    { label: 'Project No.:', value: project.number },
    { label: 'Client:', value: project.client },
    { label: 'Date:', value: today },
  ];
  const detailsY = subtitleY - 75;
  for (let i = 0; i < detailLines.length; i++) {
    const d = detailLines[i];
    const y = detailsY - i * 24;
    const labelW = fontBold.widthOfTextAtSize(d.label, 11);
    const cleanValue = sanitize(d.value) || '—';
    let value = cleanValue;
    while (
      labelW + 8 + fontRegular.widthOfTextAtSize(value, 11) > HERO_MAX_W &&
      value.length > 1
    ) {
      value = value.slice(0, -1);
    }
    if (value !== cleanValue && value.length > 0) value = value.slice(0, -1) + '…';
    const totalW = labelW + 8 + fontRegular.widthOfTextAtSize(value, 11);
    const startX = (PAGE_W - totalW) / 2;
    coverPage.drawText(d.label, { x: startX, y, size: 11, font: fontBold, color: NAVY });
    coverPage.drawText(value, { x: startX + labelW + 8, y, size: 11, font: fontRegular, color: DARK_GRAY });
  }

  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });
  const footerText = 'Instrata Project Tools — Warranties';
  const ftW = fontItalic.widthOfTextAtSize(footerText, 8);
  coverPage.drawText(footerText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== WARRANTIES PAGE(S) =====================
  // Same table layout as the Warranties section of the Closeout Package PDF.
  let page = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let y = PAGE_H - MARGIN;

  // Page header band
  page.drawRectangle({ x: 0, y: y - 4, width: PAGE_W, height: 40, color: NAVY });
  page.drawText('Warranties', { x: MARGIN, y: y + 6, size: 18, font: fontBold, color: WHITE });
  const headerRight = `${project.number}`;
  page.drawText(headerRight, {
    x: PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(headerRight, 10),
    y: y + 8,
    size: 10,
    font: fontRegular,
    color: WHITE,
  });
  y -= 60;

  const wCols = [
    { label: 'Manufacturer', x: MARGIN, w: 80 },
    { label: 'Model', x: MARGIN + 80, w: 85 },
    { label: 'Vendor', x: MARGIN + 165, w: 70 },
    { label: 'Start', x: MARGIN + 235, w: 60 },
    { label: 'Dur.', x: MARGIN + 295, w: 35 },
    { label: 'Expiry', x: MARGIN + 330, w: 65 },
    { label: 'Contact', x: MARGIN + 395, w: 109 },
  ];

  function drawColumnHeader(p: PDFPage, atY: number) {
    p.drawRectangle({ x: MARGIN, y: atY - 4, width: CONTENT_W, height: 18, color: NAVY });
    for (const col of wCols) {
      p.drawText(col.label, { x: col.x + 4, y: atY, size: 8, font: fontBold, color: WHITE });
    }
  }

  if (warranties.length === 0) {
    page.drawText('No warranties recorded.', { x: MARGIN, y, size: 11, font: fontItalic, color: MID_GRAY });
    addFooter(page, fontRegular, currentPageNum, 'Warranties');
  } else {
    drawColumnHeader(page, y);
    y -= 20;

    for (let i = 0; i < warranties.length; i++) {
      if (y < MARGIN + 50) {
        addFooter(page, fontRegular, currentPageNum, 'Warranties');
        page = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        y = PAGE_H - MARGIN;
        drawColumnHeader(page, y);
        y -= 20;
      }

      const w = warranties[i];
      const startDate = formatWarrantyDate(w.startDate);
      const dur = w.durationMonths ? `${w.durationMonths}mo` : '—';
      let expiry = '—';
      if (w.startDate && w.durationMonths) {
        const d = parseLocalDate(w.startDate);
        if (d) {
          d.setMonth(d.getMonth() + w.durationMonths);
          expiry = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }
      }
      const contact = [w.contactName, w.contactEmail, w.contactPhone].filter(Boolean).join(', ');

      const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
      drawTableRow(page, y, [
        { text: w.manufacturer || '—', x: wCols[0].x + 4, w: wCols[0].w },
        { text: w.model || '—', x: wCols[1].x + 4, w: wCols[1].w },
        { text: w.vendor || '—', x: wCols[2].x + 4, w: wCols[2].w },
        { text: startDate, x: wCols[3].x + 4, w: wCols[3].w },
        { text: dur, x: wCols[4].x + 4, w: wCols[4].w },
        { text: expiry, x: wCols[5].x + 4, w: wCols[5].w },
        { text: contact || '—', x: wCols[6].x + 4, w: wCols[6].w },
      ], fontRegular, 8, BLACK, bg);
      y -= 18;
    }

    addFooter(page, fontRegular, currentPageNum, 'Warranties');
  }

  // ===================== SAVE & DOWNLOAD =====================
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - Warranties.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
