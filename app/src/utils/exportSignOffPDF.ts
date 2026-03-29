import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { Project, ProjectBoMItem, SignOffSheet } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';

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

function addFooter(page: PDFPage, font: PDFFont, pageNum: number) {
  const y = 30;
  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: PAGE_W - MARGIN, y: y + 12 },
    thickness: 0.5,
    color: LIGHT_GRAY,
  });
  const label = 'System Testing & Sign-Off';
  page.drawText(label, { x: MARGIN, y, size: 8, font, color: MID_GRAY });
  const pageText = `Page ${pageNum}`;
  page.drawText(pageText, {
    x: PAGE_W - MARGIN - font.widthOfTextAtSize(pageText, 8),
    y,
    size: 8,
    font,
    color: MID_GRAY,
  });
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

function truncateText(text: string, font: PDFFont, size: number, maxW: number): string {
  let t = text;
  while (font.widthOfTextAtSize(t, size) > maxW && t.length > 0) {
    t = t.slice(0, -1);
  }
  if (t !== text && t.length > 0) t = t.slice(0, -1) + '\u2026';
  return t;
}

export async function exportSignOffPDF(
  project: Project,
  bomItems: ProjectBoMItem[],
  signOffSheets: SignOffSheet[],
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
  const projectNameSize = 22;
  const projectNameW = fontBold.widthOfTextAtSize(project.name, projectNameSize);
  coverPage.drawText(project.name, {
    x: (PAGE_W - projectNameW) / 2,
    y: PAGE_H - 300,
    size: projectNameSize,
    font: fontBold,
    color: NAVY,
  });

  // Subtitle
  const subtitle = 'System Testing & Sign-Off';
  const subtitleSize = 16;
  const subtitleW = fontRegular.widthOfTextAtSize(subtitle, subtitleSize);
  coverPage.drawText(subtitle, {
    x: (PAGE_W - subtitleW) / 2,
    y: PAGE_H - 330,
    size: subtitleSize,
    font: fontRegular,
    color: DARK_GRAY,
  });

  // Details section
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

  // Orange accent bar at bottom
  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });

  // Footer text above bottom bar
  const footerText = 'Instrata Project Tools \u2014 System Testing & Sign-Off';
  const ftW = fontItalic.widthOfTextAtSize(footerText, 8);
  coverPage.drawText(footerText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== ROOM-BY-ROOM SIGN-OFF PAGES =====================

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

  // Also add items without locations under "Unassigned"
  const unassignedItems = bomItems.filter((i) => !i.locations || i.locations.length === 0);
  if (unassignedItems.length > 0) {
    if (!roomMap.has('Unassigned')) roomMap.set('Unassigned', []);
    for (const i of unassignedItems) {
      roomMap.get('Unassigned')!.push({
        manufacturer: i.manufacturer,
        model: i.model,
        description: i.description,
        qty: i.qty,
      });
    }
  }

  const rooms = Array.from(roomMap.keys()).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  // Column definitions for the sign-off table (with checkbox column)
  const COL_CHECK_X = MARGIN;
  const COL_CHECK_W = 30;
  const COL_MFR_X = MARGIN + COL_CHECK_W;
  const COL_MFR_W = 110;
  const COL_MODEL_X = COL_MFR_X + COL_MFR_W;
  const COL_MODEL_W = 120;
  const COL_DESC_X = COL_MODEL_X + COL_MODEL_W;
  const COL_DESC_W = 175;
  const COL_QTY_X = COL_DESC_X + COL_DESC_W;
  const COL_QTY_W = 45;

  const ROW_H = 22;
  const BODY_SIZE = 11;
  const HEADER_SIZE = 9;
  const FOOTER_ZONE = 60; // reserve space for footer

  for (const room of rooms) {
    const items = roomMap.get(room)!;
    const sheet = signOffSheets.find((s) => s.zone === room);
    const customItems = sheet?.customItems ?? [];

    // Start a new page for each room
    let page = pdfDoc.addPage(PageSizes.Letter);
    currentPageNum++;
    let y = PAGE_H - MARGIN;

    // Room header bar
    page.drawRectangle({ x: MARGIN, y: y - 6, width: CONTENT_W, height: 30, color: NAVY });
    page.drawText(room, { x: MARGIN + 10, y: y, size: 14, font: fontBold, color: WHITE });
    y -= 44;

    // Table header row
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 20, color: NAVY });
    page.drawText('\u2713', { x: COL_CHECK_X + 10, y: y, size: HEADER_SIZE, font: fontBold, color: WHITE });
    page.drawText('Manufacturer', { x: COL_MFR_X + 4, y: y, size: HEADER_SIZE, font: fontBold, color: WHITE });
    page.drawText('Model', { x: COL_MODEL_X + 4, y: y, size: HEADER_SIZE, font: fontBold, color: WHITE });
    page.drawText('Description', { x: COL_DESC_X + 4, y: y, size: HEADER_SIZE, font: fontBold, color: WHITE });
    page.drawText('Qty', { x: COL_QTY_X + 4, y: y, size: HEADER_SIZE, font: fontBold, color: WHITE });
    y -= ROW_H;

    // Table rows
    for (let i = 0; i < items.length; i++) {
      if (y < MARGIN + FOOTER_ZONE + 120) {
        // Need space for sign-off area; if we can't fit, add a new page
        addFooter(page, fontRegular, currentPageNum);
        page = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        y = PAGE_H - MARGIN;
      }

      const item = items[i];
      const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
      if (bg) {
        page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: ROW_H, color: bg });
      }

      // Checkbox
      drawCheckbox(page, COL_CHECK_X + 8, y);

      // Data columns
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
        addFooter(page, fontRegular, currentPageNum);
        page = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        y = PAGE_H - MARGIN;
      }

      page.drawText('Additional Items', { x: MARGIN, y, size: 12, font: fontBold, color: NAVY });
      y -= 20;

      for (const ci of customItems) {
        if (y < MARGIN + FOOTER_ZONE + 80) {
          addFooter(page, fontRegular, currentPageNum);
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
      addFooter(page, fontRegular, currentPageNum);
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

    addFooter(page, fontRegular, currentPageNum);
  }

  // ===================== SAVE & DOWNLOAD =====================
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - System Testing & Sign-Off.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
