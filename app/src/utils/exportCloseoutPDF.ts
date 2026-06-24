import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { Project, ProjectBoMItem, CloseoutPackage } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';
import { isUrl, fetchFileBytes } from '../lib/storage';
import { extractBookmarks } from './extractBookmarks';
import { appendManualSection } from './exportManualsPDF';

// Brand colors
const NAVY = rgb(0.133, 0.196, 0.431);
const ORANGE = rgb(0.965, 0.553, 0.180);
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
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function addFooter(page: PDFPage, font: PDFFont, pageNum: number, label?: string) {
  const y = 30;
  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: PAGE_W - MARGIN, y: y + 12 },
    thickness: 0.5,
    color: LIGHT_GRAY,
  });
  const pageText = `Page ${pageNum}`;
  page.drawText(pageText, {
    x: PAGE_W - MARGIN - font.widthOfTextAtSize(pageText, 8),
    y,
    size: 8,
    font,
    color: MID_GRAY,
  });
  if (label) {
    page.drawText(label, { x: MARGIN, y, size: 8, font, color: MID_GRAY });
  }
}

function truncateText(text: string, font: PDFFont, size: number, maxW: number): string {
  const original = sanitize(text);
  let t = original;
  while (font.widthOfTextAtSize(t, size) > maxW && t.length > 0) {
    t = t.slice(0, -1);
  }
  if (t !== original && t.length > 0) t = t.slice(0, -1) + '\u2026';
  return t;
}

/** Word-wrap text to a max width. Long single words get hard-truncated with
 *  an ellipsis so they never overflow. */
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
        while (truncated.length > 0 && font.widthOfTextAtSize(truncated + '\u2026', size) > maxWidth) {
          truncated = truncated.slice(0, -1);
        }
        current = truncated + '\u2026';
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

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
    if (text !== original && text.length > 0) text = text.slice(0, -1) + '\u2026';
    page.drawText(text, { x: col.x, y, size, font, color });
  }
}

function drawCheckbox(page: PDFPage, x: number, y: number, size: number = 12) {
  page.drawRectangle({
    x,
    y: y - 2,
    width: size,
    height: size,
    borderColor: DARK_GRAY,
    borderWidth: 1,
    color: WHITE,
  });
}

function drawSectionHeaderPage(
  pdfDoc: PDFDocument,
  title: string,
  fontBold: PDFFont,
  fontRegular: PDFFont,
  pageNum: number,
): { page: PDFPage; nextPageNum: number } {
  const page = pdfDoc.addPage(PageSizes.Letter);
  const num = pageNum + 1;

  // Full-width navy header bar
  page.drawRectangle({ x: 0, y: PAGE_H - MARGIN - 4, width: PAGE_W, height: 40, color: NAVY });
  page.drawText(title, {
    x: MARGIN,
    y: PAGE_H - MARGIN + 6,
    size: 18,
    font: fontBold,
    color: WHITE,
  });

  addFooter(page, fontRegular, num, title);

  return { page, nextPageNum: num };
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

export async function exportCloseoutPDF(
  project: Project,
  closeout: CloseoutPackage,
  bomItems: ProjectBoMItem[],
  preparedBy: string,
  submittedTo: string,
): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Load logo
  let logoImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | undefined;
  try {
    const logoBytes = await fetchImageBytes(instrataLogoUrl);
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch {
    // Logo optional
  }

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let currentPageNum = 0;

  // Track section start pages for TOC
  let warrantiesStartPage = 0;
  let punchStartPage = 0;
  let signOffStartPage = 0;
  let asBuiltStartPage = 0;
  let manualsStartPage = 0;

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

  // Project name — wrap with breathing room (matches the other PDFs).
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

  const titleText = 'Closeout Package';
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

  const detailsY = titleY - 100;
  const detailLines = [
    { label: 'Prepared By:', value: sanitize(preparedBy) },
    { label: 'Submitted To:', value: sanitize(submittedTo) },
    { label: 'Date:', value: today },
    { label: 'Project No.:', value: sanitize(project.number) },
  ];

  for (let i = 0; i < detailLines.length; i++) {
    const d = detailLines[i];
    const y = detailsY - i * 24;
    const labelW = fontBold.widthOfTextAtSize(d.label, 11);
    // Truncate the value if it would push the centered line wider than the
    // hero zone (matches the other PDFs).
    const cleanValue = d.value || '\u2014';
    let value = cleanValue;
    while (
      labelW + 8 + fontRegular.widthOfTextAtSize(value, 11) > HERO_MAX_W &&
      value.length > 1
    ) {
      value = value.slice(0, -1);
    }
    if (value !== cleanValue && value.length > 0) value = value.slice(0, -1) + '\u2026';
    const totalW = labelW + 8 + fontRegular.widthOfTextAtSize(value, 11);
    const startX = (PAGE_W - totalW) / 2;
    coverPage.drawText(d.label, { x: startX, y, size: 11, font: fontBold, color: NAVY });
    coverPage.drawText(value, { x: startX + labelW + 8, y, size: 11, font: fontRegular, color: DARK_GRAY });
  }

  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });

  const footerCoverText = 'Instrata Project Tools \u2014 Closeout Package';
  const ftW = fontItalic.widthOfTextAtSize(footerCoverText, 8);
  coverPage.drawText(footerCoverText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== TABLE OF CONTENTS (placeholder — fill page numbers later) =====================
  const tocPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let tocY = PAGE_H - MARGIN;

  tocPage.drawRectangle({ x: 0, y: tocY - 4, width: PAGE_W, height: 40, color: NAVY });
  tocPage.drawText('Table of Contents', { x: MARGIN, y: tocY + 6, size: 18, font: fontBold, color: WHITE });
  tocY -= 60;

  const tocEntries = [
    { label: 'Warranties', key: 'warranties' },
    { label: 'Punch List', key: 'punch' },
    { label: 'Test & Sign-Off', key: 'signoff' },
    { label: 'As-Built Drawings', key: 'asbuilt' },
    ...(closeout.productManualUrl ? [{ label: 'Product Manuals', key: 'manuals' }] : []),
  ];

  const tocEntryPositions: { key: string; y: number }[] = [];

  for (const entry of tocEntries) {
    tocPage.drawText(entry.label, { x: MARGIN, y: tocY, size: 11, font: fontBold, color: NAVY });

    // Draw dot leader
    const textW = fontBold.widthOfTextAtSize(entry.label, 11);
    const dotsStart = MARGIN + textW + 8;
    const dotsEnd = PAGE_W - MARGIN - 30;
    if (dotsEnd > dotsStart) {
      let dotX = dotsStart;
      while (dotX < dotsEnd) {
        tocPage.drawText('.', { x: dotX, y: tocY, size: 8, font: fontRegular, color: MID_GRAY });
        dotX += 5;
      }
    }

    tocEntryPositions.push({ key: entry.key, y: tocY });
    tocY -= 28;
  }

  addFooter(tocPage, fontRegular, currentPageNum, 'Table of Contents');

  // ===================== WARRANTIES SECTION =====================
  {
    const { page: hdrPage, nextPageNum } = drawSectionHeaderPage(pdfDoc, 'Warranties', fontBold, fontRegular, currentPageNum);
    currentPageNum = nextPageNum;
    warrantiesStartPage = currentPageNum;

    let page = hdrPage;
    let y = PAGE_H - MARGIN - 60; // below header bar

    const warranties = closeout.warranties;

    if (warranties.length === 0) {
      page.drawText('No warranties recorded.', { x: MARGIN, y, size: 11, font: fontItalic, color: MID_GRAY });
    } else {
      // Table header
      const wCols = [
        { label: 'Manufacturer', x: MARGIN, w: 80 },
        { label: 'Model', x: MARGIN + 80, w: 85 },
        { label: 'Vendor', x: MARGIN + 165, w: 70 },
        { label: 'Start', x: MARGIN + 235, w: 60 },
        { label: 'Dur.', x: MARGIN + 295, w: 35 },
        { label: 'Expiry', x: MARGIN + 330, w: 65 },
        { label: 'Contact', x: MARGIN + 395, w: 109 },
      ];

      page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: NAVY });
      for (const col of wCols) {
        page.drawText(col.label, { x: col.x + 4, y, size: 8, font: fontBold, color: WHITE });
      }
      y -= 20;

      for (let i = 0; i < warranties.length; i++) {
        if (y < MARGIN + 50) {
          addFooter(page, fontRegular, currentPageNum, 'Warranties');
          page = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          y = PAGE_H - MARGIN;
        }

        const w = warranties[i];
        const startDate = formatWarrantyDate(w.startDate);
        const dur = w.durationMonths ? `${w.durationMonths}mo` : '\u2014';
        let expiry = '\u2014';
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
          { text: w.manufacturer || '\u2014', x: wCols[0].x + 4, w: wCols[0].w },
          { text: w.model || '\u2014', x: wCols[1].x + 4, w: wCols[1].w },
          { text: w.vendor || '\u2014', x: wCols[2].x + 4, w: wCols[2].w },
          { text: startDate, x: wCols[3].x + 4, w: wCols[3].w },
          { text: dur, x: wCols[4].x + 4, w: wCols[4].w },
          { text: expiry, x: wCols[5].x + 4, w: wCols[5].w },
          { text: contact || '\u2014', x: wCols[6].x + 4, w: wCols[6].w },
        ], fontRegular, 8, BLACK, bg);
        y -= 18;
      }

      addFooter(page, fontRegular, currentPageNum, 'Warranties');
    }
  }

  // ===================== PUNCH LIST SECTION =====================
  // Mirrors the standalone Punch List PDF: items grouped by location with an
  // orange-accent header per group, a navy column band (Done / # / Description
  // / Priority / Assigned To / Status), and a checkbox per row.
  {
    const { page: hdrPage, nextPageNum } = drawSectionHeaderPage(pdfDoc, 'Punch List', fontBold, fontRegular, currentPageNum);
    currentPageNum = nextPageNum;
    punchStartPage = currentPageNum;

    let page = hdrPage;
    let y = PAGE_H - MARGIN - 60;

    const punchItems = closeout.punchItems;

    if (punchItems.length === 0) {
      page.drawText('No punch items recorded.', { x: MARGIN, y, size: 11, font: fontItalic, color: MID_GRAY });
    } else {
      // Group by location. Items without a location land under "Unassigned"
      // so nothing is silently dropped — caught a bug where punch items with
      // empty location strings disappeared from the closeout PDF.
      const grouped = new Map<string, typeof punchItems>();
      for (const item of punchItems) {
        const key = (item.location && item.location.trim()) || 'Unassigned';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(item);
      }
      const locations = Array.from(grouped.keys()).sort((a, b) => {
        if (a === 'Unassigned') return 1;
        if (b === 'Unassigned') return -1;
        return a.localeCompare(b);
      });

      // Column geometry — must fit inside CONTENT_W (504pt). Same layout as
      // the standalone Punch List PDF.
      const COL = {
        checkX: MARGIN + 6,
        checkSize: 11,
        numX: MARGIN + 28,
        descX: MARGIN + 60,
        descW: 240,
        priorityX: MARGIN + 304,
        assignedX: MARGIN + 370,
        assignedW: 90,
        statusX: MARGIN + 466,
      };
      const RED = rgb(0.725, 0.110, 0.110);

      function drawColumnHeader(p: PDFPage, atY: number) {
        p.drawRectangle({ x: MARGIN, y: atY - 4, width: CONTENT_W, height: 18, color: NAVY });
        p.drawText('Done', { x: COL.checkX, y: atY, size: 8, font: fontBold, color: WHITE });
        p.drawText('#', { x: COL.numX, y: atY, size: 8, font: fontBold, color: WHITE });
        p.drawText('Description', { x: COL.descX, y: atY, size: 8, font: fontBold, color: WHITE });
        p.drawText('Priority', { x: COL.priorityX, y: atY, size: 8, font: fontBold, color: WHITE });
        p.drawText('Assigned To', { x: COL.assignedX, y: atY, size: 8, font: fontBold, color: WHITE });
        p.drawText('Status', { x: COL.statusX, y: atY, size: 8, font: fontBold, color: WHITE });
      }

      function drawLocationHeader(p: PDFPage, atY: number, location: string, count: number, suffix?: string) {
        p.drawRectangle({ x: MARGIN, y: atY - 2, width: 4, height: 16, color: ORANGE });
        const label = suffix ? `${sanitize(location)} ${suffix}` : sanitize(location);
        p.drawText(label, { x: MARGIN + 12, y: atY, size: 12, font: fontBold, color: NAVY });
        const countText = `${count} item${count === 1 ? '' : 's'}`;
        p.drawText(countText, {
          x: PAGE_W - MARGIN - fontItalic.widthOfTextAtSize(countText, 9),
          y: atY + 1,
          size: 9,
          font: fontItalic,
          color: MID_GRAY,
        });
      }

      let itemNumber = 0;
      for (const location of locations) {
        const items = grouped.get(location)!;

        // Need ~80pt to fit a location header + column band + 1 row before
        // paginating; otherwise start fresh on a new page.
        if (y < MARGIN + 80) {
          addFooter(page, fontRegular, currentPageNum, 'Punch List');
          page = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          y = PAGE_H - MARGIN;
        }

        drawLocationHeader(page, y, location, items.length);
        y -= 24;
        drawColumnHeader(page, y);
        y -= 18;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          itemNumber++;

          const descLines = wrapText(item.description, fontRegular, 9, COL.descW - 6);
          const rowH = Math.max(20, descLines.length * 12 + 8);

          if (y - rowH < MARGIN + 30) {
            addFooter(page, fontRegular, currentPageNum, 'Punch List');
            page = pdfDoc.addPage(PageSizes.Letter);
            currentPageNum++;
            y = PAGE_H - MARGIN;
            drawLocationHeader(page, y, location, items.length, '(continued)');
            y -= 24;
            drawColumnHeader(page, y);
            y -= 18;
          }

          const rowBg = i % 2 === 1 ? LIGHT_GRAY : undefined;
          if (rowBg) {
            page.drawRectangle({ x: MARGIN, y: y - rowH + 14, width: CONTENT_W, height: rowH, color: rowBg });
          }

          const topY = y;
          const isComplete = item.status === 'Complete';

          // Checkbox (pre-checked if Complete)
          page.drawRectangle({
            x: COL.checkX, y: topY - 1, width: COL.checkSize, height: COL.checkSize,
            borderColor: DARK_GRAY, borderWidth: 1,
          });
          if (isComplete) {
            page.drawText('X', { x: COL.checkX + 2, y: topY, size: 10, font: fontBold, color: NAVY });
          }

          page.drawText(String(itemNumber), {
            x: COL.numX, y: topY, size: 9, font: fontBold, color: NAVY,
          });

          for (let li = 0; li < descLines.length; li++) {
            page.drawText(descLines[li], {
              x: COL.descX,
              y: topY - li * 12,
              size: 9,
              font: fontRegular,
              color: BLACK,
            });
          }

          const priorityColor = item.priority === 'Critical' ? RED : DARK_GRAY;
          const priorityFont = item.priority === 'Critical' ? fontBold : fontRegular;
          page.drawText(sanitize(item.priority), {
            x: COL.priorityX, y: topY, size: 9, font: priorityFont, color: priorityColor,
          });

          const cleanAssigned = sanitize(item.assignedTo) || '\u2014';
          let assigned = cleanAssigned;
          while (fontRegular.widthOfTextAtSize(assigned, 9) > COL.assignedW - 4 && assigned.length > 0) {
            assigned = assigned.slice(0, -1);
          }
          if (assigned !== cleanAssigned) assigned = assigned.slice(0, -1) + '\u2026';
          page.drawText(assigned, {
            x: COL.assignedX, y: topY, size: 9, font: fontRegular, color: DARK_GRAY,
          });

          page.drawText(sanitize(item.status), {
            x: COL.statusX,
            y: topY,
            size: 9,
            font: fontRegular,
            color: isComplete ? rgb(0.082, 0.502, 0.239) : DARK_GRAY,
          });

          y -= rowH;
        }

        // Spacing between location groups
        y -= 14;
      }

      addFooter(page, fontRegular, currentPageNum, 'Punch List');
    }
  }

  // ===================== TEST & SIGN-OFF SECTION =====================
  {
    const { nextPageNum } = drawSectionHeaderPage(pdfDoc, 'Test & Sign-Off', fontBold, fontRegular, currentPageNum);
    currentPageNum = nextPageNum;
    signOffStartPage = currentPageNum;

    // Group BoM items by room
    const roomMap = new Map<string, { manufacturer: string; model: string; description: string; qty: number }[]>();
    for (const item of bomItems) {
      if (item.locations && item.locations.length > 0) {
        for (const loc of item.locations) {
          const room = loc.room || 'Unassigned';
          if (!roomMap.has(room)) roomMap.set(room, []);
          roomMap.get(room)!.push({
            manufacturer: item.manufacturer,
            model: item.model,
            description: item.description,
            qty: loc.qty,
          });
        }
      }
    }
    const unassigned = bomItems.filter((i) => !i.locations || i.locations.length === 0);
    if (unassigned.length > 0) {
      if (!roomMap.has('Unassigned')) roomMap.set('Unassigned', []);
      for (const i of unassigned) {
        roomMap.get('Unassigned')!.push({
          manufacturer: i.manufacturer, model: i.model, description: i.description, qty: i.qty,
        });
      }
    }

    const rooms = Array.from(roomMap.keys()).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    });

    const signOffSheets = closeout.signOffSheets || [];

    const COL_CHECK_X = MARGIN;
    const COL_CHECK_W = 30;
    const COL_MFR_X = MARGIN + COL_CHECK_W;
    const COL_MFR_W = 110;
    const COL_MODEL_X = COL_MFR_X + COL_MFR_W;
    const COL_MODEL_W = 120;
    const COL_DESC_X = COL_MODEL_X + COL_MODEL_W;
    const COL_DESC_W = 175;
    const COL_QTY_X = COL_DESC_X + COL_DESC_W;
    const ROW_H = 22;
    const BODY_SIZE = 11;
    const HEADER_SIZE = 9;
    const FOOTER_ZONE = 60;

    for (const room of rooms) {
      const items = roomMap.get(room)!;
      const sheet = signOffSheets.find((s) => s.zone === room);
      const customItems = sheet?.customItems ?? [];

      let page = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      let y = PAGE_H - MARGIN;

      // Room header bar
      page.drawRectangle({ x: MARGIN, y: y - 6, width: CONTENT_W, height: 30, color: NAVY });
      page.drawText(sanitize(room), { x: MARGIN + 10, y, size: 14, font: fontBold, color: WHITE });
      y -= 44;

      // Table header
      page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 20, color: NAVY });
      page.drawText('OK', { x: COL_CHECK_X + 6, y, size: HEADER_SIZE, font: fontBold, color: WHITE });
      page.drawText('Manufacturer', { x: COL_MFR_X + 4, y, size: HEADER_SIZE, font: fontBold, color: WHITE });
      page.drawText('Model', { x: COL_MODEL_X + 4, y, size: HEADER_SIZE, font: fontBold, color: WHITE });
      page.drawText('Description', { x: COL_DESC_X + 4, y, size: HEADER_SIZE, font: fontBold, color: WHITE });
      page.drawText('Qty', { x: COL_QTY_X + 4, y, size: HEADER_SIZE, font: fontBold, color: WHITE });
      y -= ROW_H;

      for (let i = 0; i < items.length; i++) {
        if (y < MARGIN + FOOTER_ZONE + 120) {
          addFooter(page, fontRegular, currentPageNum, 'Test & Sign-Off');
          page = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          y = PAGE_H - MARGIN;
        }

        const item = items[i];
        const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
        if (bg) {
          page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: ROW_H, color: bg });
        }

        drawCheckbox(page, COL_CHECK_X + 8, y);
        page.drawText(truncateText(item.manufacturer, fontRegular, BODY_SIZE, COL_MFR_W - 8), {
          x: COL_MFR_X + 4, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
        });
        page.drawText(truncateText(item.model, fontRegular, BODY_SIZE, COL_MODEL_W - 8), {
          x: COL_MODEL_X + 4, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
        });
        page.drawText(truncateText(item.description, fontRegular, BODY_SIZE, COL_DESC_W - 8), {
          x: COL_DESC_X + 4, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
        });
        page.drawText(String(item.qty), {
          x: COL_QTY_X + 4, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
        });
        y -= ROW_H;
      }

      // Custom sign-off items
      if (customItems.length > 0) {
        y -= 10;
        if (y < MARGIN + FOOTER_ZONE + 120) {
          addFooter(page, fontRegular, currentPageNum, 'Test & Sign-Off');
          page = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          y = PAGE_H - MARGIN;
        }

        page.drawText('Additional Items', { x: MARGIN, y, size: 12, font: fontBold, color: NAVY });
        y -= 20;

        for (const ci of customItems) {
          if (y < MARGIN + FOOTER_ZONE + 80) {
            addFooter(page, fontRegular, currentPageNum, 'Test & Sign-Off');
            page = pdfDoc.addPage(PageSizes.Letter);
            currentPageNum++;
            y = PAGE_H - MARGIN;
          }

          drawCheckbox(page, MARGIN + 8, y);
          page.drawText(truncateText(ci.text, fontRegular, BODY_SIZE, CONTENT_W - 40), {
            x: MARGIN + 28, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
          });
          y -= ROW_H;
        }
      }

      // Client sign-off area
      y -= 20;
      if (y < MARGIN + FOOTER_ZONE + 80) {
        addFooter(page, fontRegular, currentPageNum, 'Test & Sign-Off');
        page = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        y = PAGE_H - MARGIN;
      }

      page.drawLine({
        start: { x: MARGIN, y: y + 10 },
        end: { x: PAGE_W - MARGIN, y: y + 10 },
        thickness: 0.5,
        color: MID_GRAY,
      });

      const signoffLines = [
        'Client Representative: ___________________________',
        'Date: ___________________________',
        'Signature: ___________________________',
      ];

      for (const line of signoffLines) {
        y -= 22;
        page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: fontRegular, color: DARK_GRAY });
      }

      addFooter(page, fontRegular, currentPageNum, 'Test & Sign-Off');
    }
  }

  // ===================== AS-BUILT DRAWINGS SECTION =====================
  {
    const { nextPageNum } = drawSectionHeaderPage(pdfDoc, 'As-Built Drawings', fontBold, fontRegular, currentPageNum);
    currentPageNum = nextPageNum;
    asBuiltStartPage = currentPageNum;

    const drawings = closeout.asBuiltDrawings || [];

    if (drawings.length === 0) {
      // The section header page already exists; add a note on it
      const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
      lastPage.drawText('No as-built drawings uploaded.', {
        x: MARGIN,
        y: PAGE_H - MARGIN - 60,
        size: 11,
        font: fontItalic,
        color: MID_GRAY,
      });
    } else {
      for (const drawing of drawings) {
        try {
          // Support both URL (Supabase Storage) and base64 (legacy/demo)
          let drawingBytes: Uint8Array;
          if (isUrl(drawing.fileData)) {
            drawingBytes = await fetchFileBytes(drawing.fileData);
          } else {
            drawingBytes = Uint8Array.from(atob(drawing.fileData), (c) => c.charCodeAt(0));
          }
          const drawingPdf = await PDFDocument.load(drawingBytes);
          const pages = await pdfDoc.copyPages(drawingPdf, drawingPdf.getPageIndices());

          for (const page of pages) {
            pdfDoc.addPage(page);
            currentPageNum++;
          }
        } catch {
          // If drawing can't be loaded, add a placeholder page
          const placeholderPage = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          placeholderPage.drawText(sanitize(`As-Built Drawing: ${drawing.title}`), {
            x: MARGIN,
            y: PAGE_H / 2,
            size: 14,
            font: fontBold,
            color: NAVY,
          });
          placeholderPage.drawText('PDF could not be embedded.', {
            x: MARGIN,
            y: PAGE_H / 2 - 24,
            size: 11,
            font: fontItalic,
            color: MID_GRAY,
          });
          addFooter(placeholderPage, fontRegular, currentPageNum, 'As-Built Drawings');
        }
      }
    }
  }

  // ===================== PRODUCT MANUALS SECTION =====================
  if (closeout.productManualUrl) {
    try {
      const manualBytes = await fetchFileBytes(closeout.productManualUrl);
      const bookmarks   = await extractBookmarks(manualBytes);
      manualsStartPage  = currentPageNum + 1;
      currentPageNum    = await appendManualSection(
        pdfDoc, fontRegular, fontBold, fontItalic,
        project, manualBytes, bookmarks, currentPageNum,
      );
    } catch (err) {
      console.warn('[Closeout PDF] Could not embed product manuals:', err);
      const ph = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      manualsStartPage = currentPageNum;
      ph.drawText('Product Manuals — file could not be embedded.', {
        x: MARGIN, y: PAGE_H / 2, size: 11, font: fontItalic, color: MID_GRAY,
      });
    }
  }

  // ===================== FILL IN TOC PAGE NUMBERS + LINKS =====================
  const allPages = pdfDoc.getPages();

  for (const { key, y } of tocEntryPositions) {
    let pageNum = 0;
    if (key === 'warranties') pageNum = warrantiesStartPage;
    else if (key === 'punch') pageNum = punchStartPage;
    else if (key === 'signoff') pageNum = signOffStartPage;
    else if (key === 'asbuilt') pageNum = asBuiltStartPage;
    else if (key === 'manuals') pageNum = manualsStartPage;

    if (pageNum > 0) {
      const pageText = String(pageNum);
      const textX = PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(pageText, 10);
      tocPage.drawText(pageText, { x: textX, y, size: 10, font: fontRegular, color: NAVY });

      // Add clickable link annotation
      const targetPageIdx = pageNum - 1;
      if (targetPageIdx >= 0 && targetPageIdx < allPages.length) {
        const targetPage = allPages[targetPageIdx];
        const linkX = MARGIN;
        const linkW = PAGE_W - MARGIN * 2;
        const linkH = 16;
        tocPage.node.addAnnot(
          pdfDoc.context.register(
            pdfDoc.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [linkX, y - 4, linkX + linkW, y + linkH],
              Border: [0, 0, 0],
              Dest: [targetPage.ref, 'XYZ', null, null, null],
            }),
          ),
        );
      }
    }
  }

  // ===================== SAVE & DOWNLOAD =====================
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - Closeout Package.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
