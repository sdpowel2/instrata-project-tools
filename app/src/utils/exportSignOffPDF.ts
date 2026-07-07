import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { Project, ProjectBoMItem, SignOffSheet } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';
import { fileGeneratedPdf } from '../lib/projectFiles';

// Brand colors (mirrors exportSubmittalPDF.ts and exportPunchListPDF.ts)
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

// Pre-computed sign-off block height so we know when to paginate the
// last room's items. Statement + signature rows + breathing room.
const SIGN_OFF_BLOCK_H = 130;

const SIGN_OFF_STATEMENT =
  'Instrata has completed the full scope of this room, including installing, configuring, programming and testing all components.';

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

function drawCheckbox(page: PDFPage, x: number, y: number, size = 11) {
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    borderColor: DARK_GRAY,
    borderWidth: 1,
  });
}

function truncateText(text: string, font: PDFFont, size: number, maxW: number): string {
  let t = sanitize(text);
  const original = t;
  while (font.widthOfTextAtSize(t, size) > maxW && t.length > 0) {
    t = t.slice(0, -1);
  }
  if (t !== original && t.length > 0) t = t.slice(0, -1) + '\u2026';
  return t;
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

function drawSignOffBlock(
  page: PDFPage,
  startY: number,
  font: PDFFont,
  fontBold: PDFFont,
  fontItalic: PDFFont,
  preparedBy: string,
): number {
  let y = startY;

  // Statement, wrapped within the content width.
  const statementLines = wrapText(SIGN_OFF_STATEMENT, fontItalic, 10, CONTENT_W);
  for (const line of statementLines) {
    page.drawText(line, { x: MARGIN, y, size: 10, font: fontItalic, color: DARK_GRAY });
    y -= 14;
  }
  y -= 18;

  // Two signature blocks, side by side.
  const colW = (CONTENT_W - 30) / 2; // 30pt gutter
  const leftX = MARGIN;
  const rightX = MARGIN + colW + 30;

  // Labels above the lines
  page.drawText('Client Representative', { x: leftX, y, size: 9, font: fontBold, color: NAVY });
  page.drawText('Instrata Representative', { x: rightX, y, size: 9, font: fontBold, color: NAVY });
  if (preparedBy && preparedBy.trim()) {
    const label = `(${preparedBy.trim()})`;
    page.drawText(label, {
      x: rightX + fontBold.widthOfTextAtSize('Instrata Representative', 9) + 6,
      y,
      size: 8,
      font: fontItalic,
      color: MID_GRAY,
    });
  }
  y -= 28;

  // Signature row (lines)
  page.drawLine({ start: { x: leftX, y }, end: { x: leftX + colW, y }, thickness: 0.7, color: DARK_GRAY });
  page.drawLine({ start: { x: rightX, y }, end: { x: rightX + colW, y }, thickness: 0.7, color: DARK_GRAY });
  page.drawText('Signature', { x: leftX, y: y - 10, size: 8, font, color: MID_GRAY });
  page.drawText('Signature', { x: rightX, y: y - 10, size: 8, font, color: MID_GRAY });
  y -= 36;

  // Date / printed-name row
  const halfColW = (colW - 16) / 2;
  page.drawLine({ start: { x: leftX, y }, end: { x: leftX + halfColW, y }, thickness: 0.7, color: DARK_GRAY });
  page.drawText('Printed Name', { x: leftX, y: y - 10, size: 8, font, color: MID_GRAY });
  page.drawLine({
    start: { x: leftX + halfColW + 16, y },
    end: { x: leftX + colW, y },
    thickness: 0.7,
    color: DARK_GRAY,
  });
  page.drawText('Date', { x: leftX + halfColW + 16, y: y - 10, size: 8, font, color: MID_GRAY });

  page.drawLine({ start: { x: rightX, y }, end: { x: rightX + halfColW, y }, thickness: 0.7, color: DARK_GRAY });
  page.drawText('Printed Name', { x: rightX, y: y - 10, size: 8, font, color: MID_GRAY });
  page.drawLine({
    start: { x: rightX + halfColW + 16, y },
    end: { x: rightX + colW, y },
    thickness: 0.7,
    color: DARK_GRAY,
  });
  page.drawText('Date', { x: rightX + halfColW + 16, y: y - 10, size: 8, font, color: MID_GRAY });

  return y - 16;
}

export async function exportSignOffPDF(
  project: Project,
  bomItems: ProjectBoMItem[],
  signOffSheets: SignOffSheet[],
  preparedBy: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _submittedTo: string,
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

  // Project name — wrap with breathing room (matches exportPunchListPDF.ts).
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
  const titleText = 'System Testing & Sign-Off';
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

  // Subtitle: room count
  const totalRooms = (() => {
    const set = new Set<string>();
    for (const item of bomItems) {
      if (item.locations && item.locations.length > 0) {
        for (const loc of item.locations) set.add(loc.room || 'Unassigned');
      } else {
        set.add('Unassigned');
      }
    }
    return set.size;
  })();
  const subtitle = `${totalRooms} room${totalRooms === 1 ? '' : 's'}`;
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
    { label: 'Prepared By:', value: preparedBy || 'Instrata' },
    { label: 'Date:', value: today },
  ];
  const detailsY = subtitleY - 75;
  for (let i = 0; i < detailLines.length; i++) {
    const d = detailLines[i];
    const y = detailsY - i * 24;
    const labelW = fontBold.widthOfTextAtSize(d.label, 11);
    const cleanValue = sanitize(d.value) || '\u2014';
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
  const footerText = 'Instrata Project Tools \u2014 System Testing & Sign-Off';
  const ftW = fontItalic.widthOfTextAtSize(footerText, 8);
  coverPage.drawText(footerText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== ROOM-BY-ROOM SIGN-OFF PAGES =====================

  // Group BoM items by room. Items without a location land under "Unassigned"
  // so nothing is silently dropped from the walk-through.
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
    } else {
      if (!roomMap.has('Unassigned')) roomMap.set('Unassigned', []);
      roomMap.get('Unassigned')!.push({
        manufacturer: item.manufacturer,
        model: item.model,
        description: item.description,
        qty: item.qty,
      });
    }
  }

  const rooms = Array.from(roomMap.keys()).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  // Item table column geometry — checkbox + manufacturer/model/description/qty.
  const COL = {
    checkX: MARGIN + 6,
    checkSize: 11,
    mfrX: MARGIN + 28,
    mfrW: 120,
    modelX: MARGIN + 152,
    modelW: 110,
    descX: MARGIN + 266,
    descW: 200,
    qtyX: MARGIN + 470,
  };

  const ROW_H = 18;
  const BODY_SIZE = 9;

  function drawRoomBand(page: PDFPage, y: number, room: string, suffix?: string) {
    page.drawRectangle({ x: 0, y: y - 4, width: PAGE_W, height: 36, color: NAVY });
    page.drawText(sanitize(room), { x: MARGIN, y: y + 4, size: 16, font: fontBold, color: WHITE });
    if (suffix) {
      page.drawText(suffix, {
        x: PAGE_W - MARGIN - fontItalic.widthOfTextAtSize(suffix, 10),
        y: y + 7,
        size: 10,
        font: fontItalic,
        color: WHITE,
      });
    }
  }

  function drawColumnHeader(page: PDFPage, y: number) {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: NAVY });
    page.drawText('Done', { x: COL.checkX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Manufacturer', { x: COL.mfrX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Model', { x: COL.modelX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Description', { x: COL.descX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Qty', { x: COL.qtyX, y, size: 8, font: fontBold, color: WHITE });
  }

  for (const room of rooms) {
    const items = roomMap.get(room)!;
    const sheet = signOffSheets.find((s) => s.zone === room);
    const customItems = sheet?.customItems ?? [];

    // Each room starts on a new page so the sign-off block stays attached to
    // its room — and so the field walker has a clean printable per-room sheet.
    let page = pdfDoc.addPage(PageSizes.Letter);
    currentPageNum++;
    let y = PAGE_H - MARGIN;

    drawRoomBand(page, y, room, `${items.length} item${items.length === 1 ? '' : 's'}`);
    y -= 56;

    drawColumnHeader(page, y);
    y -= ROW_H;

    // Helper to start a continuation page for the same room.
    const continuePage = () => {
      addFooter(page, fontRegular, currentPageNum, `${room} \u2014 System Testing & Sign-Off`);
      page = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      y = PAGE_H - MARGIN;
      drawRoomBand(page, y, room, '(continued)');
      y -= 56;
      drawColumnHeader(page, y);
      y -= ROW_H;
    };

    // Table rows
    for (let i = 0; i < items.length; i++) {
      // Need at least one row of room items left; if not, paginate.
      if (y < MARGIN + 60) continuePage();

      const item = items[i];
      const bg = i % 2 === 0 ? undefined : LIGHT_GRAY;
      if (bg) {
        page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: ROW_H, color: bg });
      }

      drawCheckbox(page, COL.checkX, y - 1, COL.checkSize);

      page.drawText(truncateText(item.manufacturer, fontRegular, BODY_SIZE, COL.mfrW - 6), {
        x: COL.mfrX, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
      });
      page.drawText(truncateText(item.model, fontRegular, BODY_SIZE, COL.modelW - 6), {
        x: COL.modelX, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
      });
      page.drawText(truncateText(item.description, fontRegular, BODY_SIZE, COL.descW - 6), {
        x: COL.descX, y, size: BODY_SIZE, font: fontRegular, color: BLACK,
      });
      page.drawText(String(item.qty), { x: COL.qtyX, y, size: BODY_SIZE, font: fontRegular, color: BLACK });

      y -= ROW_H;
    }

    // Custom items (free-text checklist additions per room)
    if (customItems.length > 0) {
      y -= 12;
      if (y < MARGIN + 60) continuePage();

      page.drawText('Additional Items', { x: MARGIN, y, size: 11, font: fontBold, color: NAVY });
      y -= 18;

      for (const ci of customItems) {
        if (y < MARGIN + 60) continuePage();
        drawCheckbox(page, COL.checkX, y - 1, COL.checkSize);
        const wrapped = wrapText(ci.text, fontRegular, BODY_SIZE, CONTENT_W - (COL.mfrX - MARGIN) - 4);
        for (let li = 0; li < wrapped.length; li++) {
          page.drawText(wrapped[li], {
            x: COL.mfrX,
            y: y - li * 12,
            size: BODY_SIZE,
            font: fontRegular,
            color: BLACK,
          });
        }
        y -= Math.max(ROW_H, wrapped.length * 12 + 4);
      }
    }

    // Sign-off block. If it doesn't fit on the current page, push to a fresh
    // continuation page so the statement and signatures stay together.
    if (y < MARGIN + SIGN_OFF_BLOCK_H) continuePage();
    y -= 16;

    // Divider above the sign-off block
    page.drawLine({
      start: { x: MARGIN, y: y + 6 },
      end: { x: PAGE_W - MARGIN, y: y + 6 },
      thickness: 0.5,
      color: LIGHT_GRAY,
    });
    y -= 4;

    drawSignOffBlock(page, y, fontRegular, fontBold, fontItalic, preparedBy);

    addFooter(page, fontRegular, currentPageNum, `${room} \u2014 System Testing & Sign-Off`);
  }

  // ===================== SAVE & DOWNLOAD =====================
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - System Testing & Sign-Off.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 5000);

  // Fire-and-forget: file a copy into the project's SharePoint folder.
  void fileGeneratedPdf(
    project.id, 'closeout', 'sign_off',
    `${project.number} - System Testing & Sign-Off.pdf`, pdfBytes,
  );
}
