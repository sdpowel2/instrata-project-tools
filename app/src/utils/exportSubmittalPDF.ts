import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { Submittal, SubmittalItem, Project } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';
import { fetchCutsheetBytes, hasCutsheet } from './cutsheetSource';

// Brand colors
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

/** Strip control chars that pdf-lib's Helvetica (WinAnsi) can't encode. */
function sanitize(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
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
    // Truncate text that's too wide
    while (font.widthOfTextAtSize(text, size) > col.w - 4 && text.length > 0) {
      text = text.slice(0, -1);
    }
    if (text !== original && text.length > 0) text = text.slice(0, -1) + '…';
    page.drawText(text, { x: col.x, y, size, font, color });
  }
}

export async function exportSubmittalPDF(
  submittal: Submittal,
  project: Project,
): Promise<void> {
  console.log('[PDF Export] Starting export for:', submittal.title);
  const pdfDoc = await PDFDocument.create();
  console.log('[PDF Export] PDFDocument created');
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Load logo
  let logoImage;
  try {
    const logoBytes = await fetchImageBytes(instrataLogoUrl);
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch {
    // Logo optional
  }

  const sortedItems = [...submittal.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Track page numbers for cutsheets (will be filled after all pages created)
  let currentPageNum = 0;
  const cutsheetPageMap: { item: SubmittalItem; startPage: number }[] = [];

  // ===================== COVER PAGE =====================
  const coverPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;

  // Orange accent bar at top
  coverPage.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: ORANGE });

  // Large centered logo
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

  // Thin orange divider below logo
  coverPage.drawRectangle({ x: MARGIN + 80, y: PAGE_H - 240, width: CONTENT_W - 160, height: 2, color: ORANGE });

  // Project name
  const projectName = sanitize(project.name);
  const projectNameSize = 22;
  const projectNameW = fontBold.widthOfTextAtSize(projectName, projectNameSize);
  coverPage.drawText(projectName, {
    x: (PAGE_W - projectNameW) / 2,
    y: PAGE_H - 300,
    size: projectNameSize,
    font: fontBold,
    color: NAVY,
  });

  // Submittal title
  const submittalTitle = sanitize(submittal.title);
  const titleSize = 16;
  const titleW = fontRegular.widthOfTextAtSize(submittalTitle, titleSize);
  coverPage.drawText(submittalTitle, {
    x: (PAGE_W - titleW) / 2,
    y: PAGE_H - 330,
    size: titleSize,
    font: fontRegular,
    color: DARK_GRAY,
  });

  // Revision
  const revText = sanitize(submittal.revision);
  const revW = fontItalic.widthOfTextAtSize(revText, 11);
  coverPage.drawText(revText, {
    x: (PAGE_W - revW) / 2,
    y: PAGE_H - 355,
    size: 11,
    font: fontItalic,
    color: MID_GRAY,
  });

  // Details section
  const detailsY = PAGE_H - 430;
  const detailLines = [
    { label: 'Prepared By:', value: sanitize(submittal.preparedBy) },
    { label: 'Submitted To:', value: sanitize(submittal.submittedTo) },
    { label: 'Date:', value: today },
    { label: 'Project No.:', value: sanitize(project.number) },
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

  // Orange accent bar at bottom
  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });

  // Footer text above bottom bar
  const footerText = 'Instrata Project Tools — Submittal Package';
  const ftW = fontItalic.widthOfTextAtSize(footerText, 8);
  coverPage.drawText(footerText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== TABLE OF CONTENTS =====================
  const tocPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let tocY = PAGE_H - MARGIN;

  // TOC header
  tocPage.drawRectangle({ x: 0, y: tocY - 4, width: PAGE_W, height: 40, color: NAVY });
  tocPage.drawText('Table of Contents', { x: MARGIN, y: tocY + 6, size: 18, font: fontBold, color: WHITE });
  tocY -= 60;

  // Section entries - we'll fill page numbers in a placeholder approach
  // For now, list sections and items
  const tocEntries: { label: string; indent: number; pageRef: string }[] = [];
  tocEntries.push({ label: 'Bill of Materials by Room', indent: 0, pageRef: 'bom' });

  // Each item with a cutsheet — checks all three possible sources
  // (repository, staging, legacy storage). Previously only checked
  // cutSheetData, so SharePoint-attached items silently produced PDFs
  // with missing cutsheet pages.
  const itemsWithCutsheets = sortedItems.filter(hasCutsheet);
  if (itemsWithCutsheets.length > 0) {
    tocEntries.push({ label: 'Product Cutsheets', indent: 0, pageRef: 'cutsheets_header' });
    for (const item of itemsWithCutsheets) {
      tocEntries.push({
        label: `${item.manufacturer} ${item.model}`,
        indent: 1,
        pageRef: `cutsheet_${item.id}`,
      });
    }
  }

  // We'll draw TOC entries and come back to fill page numbers
  // For now, store positions
  const tocEntryPositions: { entry: typeof tocEntries[0]; y: number }[] = [];

  for (const entry of tocEntries) {
    const x = MARGIN + entry.indent * 20;
    const isHeader = entry.indent === 0;
    const font = isHeader ? fontBold : fontRegular;
    const size = isHeader ? 11 : 10;
    const color = isHeader ? NAVY : DARK_GRAY;

    if (isHeader && tocEntries.indexOf(entry) > 0) tocY -= 8;

    const tocLabel = sanitize(entry.label);
    tocPage.drawText(tocLabel, { x, y: tocY, size, font, color });
    tocEntryPositions.push({ entry, y: tocY });

    // Draw dot leader
    const textW = font.widthOfTextAtSize(tocLabel, size);
    const dotsStart = x + textW + 8;
    const dotsEnd = PAGE_W - MARGIN - 30;
    if (dotsEnd > dotsStart) {
      let dotX = dotsStart;
      while (dotX < dotsEnd) {
        tocPage.drawText('.', { x: dotX, y: tocY, size: 8, font: fontRegular, color: MID_GRAY });
        dotX += 5;
      }
    }

    tocY -= 20;
  }

  addFooter(tocPage, fontRegular, currentPageNum, 'Table of Contents');

  // ===================== BILL OF MATERIALS BY ROOM =====================
  const bomStartPage = currentPageNum + 1;

  // Gather all rooms from items
  const roomMap = new Map<string, { manufacturer: string; model: string; description: string; qty: number }[]>();
  for (const item of sortedItems) {
    if (item.locations && item.locations.length > 0) {
      for (const loc of item.locations) {
        if (!roomMap.has(loc.room)) roomMap.set(loc.room, []);
        roomMap.get(loc.room)!.push({
          manufacturer: item.manufacturer,
          model: item.model,
          description: item.description,
          qty: loc.qty,
        });
      }
    }
  }

  // Also add items without locations under "Unassigned"
  const unassignedItems = sortedItems.filter((i) => !i.locations || i.locations.length === 0);
  if (unassignedItems.length > 0) {
    roomMap.set('Unassigned', unassignedItems.map((i) => ({
      manufacturer: i.manufacturer,
      model: i.model,
      description: i.description,
      qty: i.qty,
    })));
  }

  let bomPage = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let bomY = PAGE_H - MARGIN;

  // BOM header
  bomPage.drawRectangle({ x: 0, y: bomY - 4, width: PAGE_W, height: 40, color: NAVY });
  bomPage.drawText('Bill of Materials by Room', { x: MARGIN, y: bomY + 6, size: 18, font: fontBold, color: WHITE });
  bomY -= 60;

  // Column definitions for BOM table
  const bomCols = [
    { label: 'Manufacturer', x: MARGIN, w: 130 },
    { label: 'Model', x: MARGIN + 130, w: 140 },
    { label: 'Description', x: MARGIN + 270, w: 175 },
    { label: 'Qty', x: MARGIN + 445, w: 40 },
  ];

  const rooms = Array.from(roomMap.keys()).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  for (const room of rooms) {
    const items = roomMap.get(room)!;

    // Check if we need a new page (need at least room header + table header + 1 row)
    if (bomY < MARGIN + 100) {
      addFooter(bomPage, fontRegular, currentPageNum, 'Bill of Materials by Room');
      bomPage = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      bomY = PAGE_H - MARGIN;
    }

    // Room header with orange accent
    bomPage.drawRectangle({ x: MARGIN, y: bomY - 2, width: 4, height: 16, color: ORANGE });
    bomPage.drawText(sanitize(room), { x: MARGIN + 12, y: bomY, size: 12, font: fontBold, color: NAVY });
    bomY -= 24;

    // Table header
    bomPage.drawRectangle({ x: MARGIN, y: bomY - 4, width: CONTENT_W, height: 18, color: NAVY });
    for (const col of bomCols) {
      bomPage.drawText(col.label, { x: col.x + 4, y: bomY, size: 8, font: fontBold, color: WHITE });
    }
    bomY -= 20;

    // Table rows
    for (let i = 0; i < items.length; i++) {
      if (bomY < MARGIN + 40) {
        addFooter(bomPage, fontRegular, currentPageNum, 'Bill of Materials by Room');
        bomPage = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        bomY = PAGE_H - MARGIN;
      }

      const item = items[i];
      const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
      drawTableRow(bomPage, bomY, [
        { text: item.manufacturer, x: bomCols[0].x + 4, w: bomCols[0].w },
        { text: item.model, x: bomCols[1].x + 4, w: bomCols[1].w },
        { text: item.description, x: bomCols[2].x + 4, w: bomCols[2].w },
        { text: String(item.qty), x: bomCols[3].x + 4, w: bomCols[3].w },
      ], fontRegular, 9, BLACK, bg);
      bomY -= 18;
    }

    // Room subtotal
    const roomTotal = items.reduce((a, b) => a + b.qty, 0);
    bomPage.drawLine({
      start: { x: MARGIN, y: bomY + 2 },
      end: { x: PAGE_W - MARGIN, y: bomY + 2 },
      thickness: 0.5,
      color: MID_GRAY,
    });
    const subtotalText = `${items.length} items · ${roomTotal} total qty`;
    bomPage.drawText(subtotalText, {
      x: PAGE_W - MARGIN - fontItalic.widthOfTextAtSize(subtotalText, 8),
      y: bomY - 8,
      size: 8,
      font: fontItalic,
      color: MID_GRAY,
    });
    bomY -= 30;
  }

  addFooter(bomPage, fontRegular, currentPageNum, 'Bill of Materials by Room');

  // ===================== CUTSHEETS =====================
  for (const item of sortedItems) {
    if (!hasCutsheet(item)) continue;

    try {
      // fetchCutsheetBytes resolves the right source (repository → SharePoint
      // download URL, staging → SharePoint, legacy → Supabase storage or
      // base64) and records usage analytics for repository-sourced cutsheets.
      const cutsheetBytes = await fetchCutsheetBytes(item, project.id, 'submittal');
      const cutsheetPdf = await PDFDocument.load(cutsheetBytes);
      const pages = await pdfDoc.copyPages(cutsheetPdf, cutsheetPdf.getPageIndices());

      const startPageNum = currentPageNum + 1;
      cutsheetPageMap.push({ item, startPage: startPageNum });

      for (const page of pages) {
        pdfDoc.addPage(page);
        currentPageNum++;
      }
    } catch (err) {
      console.warn('[PDF Export] cutsheet embed failed for', item.manufacturer, item.model, err);
      // If cutsheet can't be loaded, add a placeholder page so the user can
      // see exactly which item failed instead of getting a silent gap.
      const placeholderPage = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      cutsheetPageMap.push({ item, startPage: currentPageNum });
      placeholderPage.drawText(sanitize(`Cutsheet: ${item.manufacturer} ${item.model}`), {
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
    }
  }

  // ===================== FILL IN TOC PAGE NUMBERS + LINKS =====================
  // Now go back and write page numbers on the TOC and add clickable links
  const allPages = pdfDoc.getPages();
  for (const { entry, y } of tocEntryPositions) {
    let pageNum = 0;
    if (entry.pageRef === 'bom') {
      pageNum = bomStartPage;
    } else if (entry.pageRef.startsWith('cutsheet_')) {
      const itemId = entry.pageRef.replace('cutsheet_', '');
      const match = cutsheetPageMap.find((c) => c.item.id === itemId);
      if (match) pageNum = match.startPage;
    } else if (entry.pageRef === 'cutsheets_header') {
      if (cutsheetPageMap.length > 0) pageNum = cutsheetPageMap[0].startPage;
    }

    if (pageNum > 0) {
      const pageText = String(pageNum);
      const textX = PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(pageText, 10);
      tocPage.drawText(pageText, { x: textX, y, size: 10, font: fontRegular, color: NAVY });

      // Add a clickable link annotation spanning the full TOC row
      const targetPageIdx = pageNum - 1; // 0-based page index
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
            })
          )
        );
      }
    }
  }

  // ===================== SAVE & DOWNLOAD =====================
  console.log('[PDF Export] Saving PDF...');
  const pdfBytes = await pdfDoc.save();
  console.log('[PDF Export] PDF saved, size:', pdfBytes.length, 'bytes');
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  // Download the PDF directly (avoids popup blocker issues)
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - ${submittal.title}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Clean up after a delay to allow the download to start
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  console.log('[PDF Export] Done!');
}
