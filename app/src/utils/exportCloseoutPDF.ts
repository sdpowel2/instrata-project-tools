import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
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
  let t = text;
  while (font.widthOfTextAtSize(t, size) > maxW && t.length > 0) {
    t = t.slice(0, -1);
  }
  if (t !== text && t.length > 0) t = t.slice(0, -1) + '\u2026';
  return t;
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
    let text = col.text;
    while (font.widthOfTextAtSize(text, size) > col.w - 4 && text.length > 0) {
      text = text.slice(0, -1);
    }
    if (text !== col.text && text.length > 0) text = text.slice(0, -1) + '\u2026';
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

  const projectNameSize = 22;
  const projectNameW = fontBold.widthOfTextAtSize(project.name, projectNameSize);
  coverPage.drawText(project.name, {
    x: (PAGE_W - projectNameW) / 2,
    y: PAGE_H - 300,
    size: projectNameSize,
    font: fontBold,
    color: NAVY,
  });

  const titleText = 'Closeout Package';
  const titleSize = 16;
  const titleW = fontRegular.widthOfTextAtSize(titleText, titleSize);
  coverPage.drawText(titleText, {
    x: (PAGE_W - titleW) / 2,
    y: PAGE_H - 330,
    size: titleSize,
    font: fontRegular,
    color: DARK_GRAY,
  });

  const detailsY = PAGE_H - 430;
  const detailLines = [
    { label: 'Prepared By:', value: preparedBy },
    { label: 'Submitted To:', value: submittedTo },
    { label: 'Date:', value: today },
    { label: 'Project No.:', value: project.number },
  ];

  for (let i = 0; i < detailLines.length; i++) {
    const d = detailLines[i];
    const y = detailsY - i * 24;
    const labelW = fontBold.widthOfTextAtSize(d.label, 11);
    const totalW = labelW + 8 + fontRegular.widthOfTextAtSize(d.value, 11);
    const startX = (PAGE_W - totalW) / 2;
    coverPage.drawText(d.label, { x: startX, y, size: 11, font: fontBold, color: NAVY });
    coverPage.drawText(d.value, { x: startX + labelW + 8, y, size: 11, font: fontRegular, color: DARK_GRAY });
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
        { label: 'System', x: MARGIN, w: 70 },
        { label: 'Mfr / Model', x: MARGIN + 70, w: 95 },
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
        const startDate = w.startDate || '\u2014';
        const dur = w.durationMonths ? `${w.durationMonths}mo` : '\u2014';
        let expiry = '\u2014';
        if (w.startDate && w.durationMonths) {
          const d = new Date(w.startDate);
          d.setMonth(d.getMonth() + w.durationMonths);
          expiry = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }
        const contact = [w.contactName, w.contactEmail, w.contactPhone].filter(Boolean).join(', ');

        const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
        drawTableRow(page, y, [
          { text: w.system || '\u2014', x: wCols[0].x + 4, w: wCols[0].w },
          { text: `${w.manufacturer} ${w.model}`, x: wCols[1].x + 4, w: wCols[1].w },
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
      const pCols = [
        { label: 'Description', x: MARGIN, w: 180 },
        { label: 'Location', x: MARGIN + 180, w: 100 },
        { label: 'Status', x: MARGIN + 280, w: 70 },
        { label: 'Priority', x: MARGIN + 350, w: 65 },
        { label: 'Assigned To', x: MARGIN + 415, w: 89 },
      ];

      page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: NAVY });
      for (const col of pCols) {
        page.drawText(col.label, { x: col.x + 4, y, size: 8, font: fontBold, color: WHITE });
      }
      y -= 20;

      for (let i = 0; i < punchItems.length; i++) {
        if (y < MARGIN + 50) {
          addFooter(page, fontRegular, currentPageNum, 'Punch List');
          page = pdfDoc.addPage(PageSizes.Letter);
          currentPageNum++;
          y = PAGE_H - MARGIN;
        }

        const p = punchItems[i];
        const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
        drawTableRow(page, y, [
          { text: p.description, x: pCols[0].x + 4, w: pCols[0].w },
          { text: p.location, x: pCols[1].x + 4, w: pCols[1].w },
          { text: p.status, x: pCols[2].x + 4, w: pCols[2].w },
          { text: p.priority, x: pCols[3].x + 4, w: pCols[3].w },
          { text: p.assignedTo, x: pCols[4].x + 4, w: pCols[4].w },
        ], fontRegular, 9, BLACK, bg);
        y -= 18;
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
      page.drawText(room, { x: MARGIN + 10, y, size: 14, font: fontBold, color: WHITE });
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
          placeholderPage.drawText(`As-Built Drawing: ${drawing.title}`, {
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
