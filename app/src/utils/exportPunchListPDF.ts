import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { Project, PunchItem, ProjectBoMItem } from '../types';
import instrataLogoUrl from '../assets/instrata-logo-color.png';
import { fileGeneratedPdf } from '../lib/projectFiles';

// Brand colors (mirrors exportSubmittalPDF.ts)
const NAVY = rgb(0.133, 0.196, 0.431); // #22326E
const ORANGE = rgb(0.965, 0.553, 0.180); // #F68D2E
const WHITE = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY = rgb(0.5, 0.5, 0.55);
const BLACK = rgb(0.1, 0.1, 0.1);
const RED = rgb(0.725, 0.110, 0.110); // #B91C1C — matches StatusBadge "Critical"

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

/** Draw a hollow square checkbox at (x, y). Returns the box's right edge. */
function drawCheckbox(page: PDFPage, x: number, y: number, size = 11): number {
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    borderColor: DARK_GRAY,
    borderWidth: 1,
  });
  return x + size;
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
      // If the single word itself overflows, hard-truncate it.
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

export async function exportPunchListPDF(
  project: Project,
  punchItems: PunchItem[],
  bomItems: ProjectBoMItem[],
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

  // Resolve product references → display strings.
  const productLookup = new Map(bomItems.map((b) => [b.id, `${b.manufacturer} ${b.model}`.trim()]));

  // Group items by location. "Unassigned" goes last so the field walker hits
  // physical rooms first.
  const grouped = new Map<string, PunchItem[]>();
  for (const item of punchItems) {
    const key = item.location?.trim() || 'Unassigned';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }
  const locations = Array.from(grouped.keys()).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

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

  // Project name — wrap if too wide. Max line width is tighter than the doc
  // margin so the cover hero has visible breathing room on both sides.
  const HERO_MAX_W = CONTENT_W - 80;
  // Step font size down once if a single very long word still overflows at 22pt.
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
  // Anchor everything below to the bottom of the wrapped name block.
  const nameBlockBottom = nameTopY - (projectNameLines.length - 1) * nameLineHeight;

  // Document title
  const titleText = 'Punch List';
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

  // Subtitle: counts
  const openCount = punchItems.filter((p) => p.status !== 'Complete' && p.status !== 'N/A').length;
  const subtitle = `${openCount} open · ${punchItems.length} total`;
  const subtitleW = fontItalic.widthOfTextAtSize(subtitle, 11);
  const subtitleY = titleY - 25;
  coverPage.drawText(subtitle, {
    x: (PAGE_W - subtitleW) / 2,
    y: subtitleY,
    size: 11,
    font: fontItalic,
    color: MID_GRAY,
  });

  // Details block — same fields whether the project name wrapped or not, but
  // pushed down so it never collides with a multi-line name.
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
    // Truncate the value if it would push the centered line wider than the
    // page can hold. Same hero-padding as the project name above.
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
  const footerText = 'Instrata Project Tools — Punch List';
  const ftW = fontItalic.widthOfTextAtSize(footerText, 8);
  coverPage.drawText(footerText, { x: (PAGE_W - ftW) / 2, y: 16, size: 8, font: fontItalic, color: MID_GRAY });

  // ===================== PUNCH LIST PAGES =====================
  // Column geometry — checkbox + #, then description, priority, assigned to.
  // Description is the only wrappable column; everything else is single-line.
  const COL = {
    checkX: MARGIN + 6,        // checkbox left edge
    numX: MARGIN + 28,         // item number
    descX: MARGIN + 60,
    descW: 240,
    priorityX: MARGIN + 304,
    assignedX: MARGIN + 370,
    assignedW: 90,
    statusX: MARGIN + 466,
  };

  let page = pdfDoc.addPage(PageSizes.Letter);
  currentPageNum++;
  let y = PAGE_H - MARGIN;

  // Page header band
  page.drawRectangle({ x: 0, y: y - 4, width: PAGE_W, height: 40, color: NAVY });
  page.drawText('Punch List', { x: MARGIN, y: y + 6, size: 18, font: fontBold, color: WHITE });
  // Project number on the right side of the header band
  const headerRight = `${project.number}`;
  page.drawText(headerRight, {
    x: PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(headerRight, 10),
    y: y + 8,
    size: 10,
    font: fontRegular,
    color: WHITE,
  });
  y -= 60;

  // Empty state — friendly cover-only PDF if nothing to print.
  if (punchItems.length === 0) {
    page.drawText('No punch items.', { x: MARGIN, y, size: 12, font: fontItalic, color: MID_GRAY });
    addFooter(page, fontRegular, currentPageNum, 'Punch List');
  }

  let itemNumber = 0;
  for (const location of locations) {
    const items = grouped.get(location)!;

    // Need ~70pt for location header + table header + 1 row before paginating.
    if (y < MARGIN + 80) {
      addFooter(page, fontRegular, currentPageNum, 'Punch List');
      page = pdfDoc.addPage(PageSizes.Letter);
      currentPageNum++;
      y = PAGE_H - MARGIN;
    }

    // Location header with orange accent bar
    page.drawRectangle({ x: MARGIN, y: y - 2, width: 4, height: 16, color: ORANGE });
    page.drawText(sanitize(location), { x: MARGIN + 12, y, size: 12, font: fontBold, color: NAVY });
    const countText = `${items.length} item${items.length === 1 ? '' : 's'}`;
    page.drawText(countText, {
      x: PAGE_W - MARGIN - fontItalic.widthOfTextAtSize(countText, 9),
      y: y + 1,
      size: 9,
      font: fontItalic,
      color: MID_GRAY,
    });
    y -= 24;

    // Column header band
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: NAVY });
    page.drawText('Done', { x: COL.checkX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('#', { x: COL.numX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Description', { x: COL.descX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Priority', { x: COL.priorityX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Assigned To', { x: COL.assignedX, y, size: 8, font: fontBold, color: WHITE });
    page.drawText('Status', { x: COL.statusX, y, size: 8, font: fontBold, color: WHITE });
    y -= 18;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      itemNumber++;

      // Build wrapped description (includes product ref on a second line if present)
      const descLines = wrapText(item.description, fontRegular, 9, COL.descW - 6);
      const productName = item.productRef ? productLookup.get(item.productRef) : undefined;
      if (productName) descLines.push(`Product: ${productName}`);
      const rowH = Math.max(20, descLines.length * 12 + 8);

      // Paginate if this row won't fit
      if (y - rowH < MARGIN + 30) {
        addFooter(page, fontRegular, currentPageNum, 'Punch List');
        page = pdfDoc.addPage(PageSizes.Letter);
        currentPageNum++;
        y = PAGE_H - MARGIN;

        // Repeat the location header on the new page so context isn't lost
        page.drawRectangle({ x: MARGIN, y: y - 2, width: 4, height: 16, color: ORANGE });
        page.drawText(`${sanitize(location)} (continued)`, { x: MARGIN + 12, y, size: 12, font: fontBold, color: NAVY });
        y -= 24;

        page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: NAVY });
        page.drawText('Done', { x: COL.checkX, y, size: 8, font: fontBold, color: WHITE });
        page.drawText('#', { x: COL.numX, y, size: 8, font: fontBold, color: WHITE });
        page.drawText('Description', { x: COL.descX, y, size: 8, font: fontBold, color: WHITE });
        page.drawText('Priority', { x: COL.priorityX, y, size: 8, font: fontBold, color: WHITE });
        page.drawText('Assigned To', { x: COL.assignedX, y, size: 8, font: fontBold, color: WHITE });
        page.drawText('Status', { x: COL.statusX, y, size: 8, font: fontBold, color: WHITE });
        y -= 18;
      }

      // Zebra background
      const rowBg = i % 2 === 1 ? LIGHT_GRAY : undefined;
      if (rowBg) {
        page.drawRectangle({ x: MARGIN, y: y - rowH + 14, width: CONTENT_W, height: rowH, color: rowBg });
      }

      // Top of row content area (text baseline)
      const topY = y;

      // Checkbox — pre-checked if Complete
      const isComplete = item.status === 'Complete';
      drawCheckbox(page, COL.checkX, topY - 1, 11);
      if (isComplete) {
        // Draw a bold checkmark inside the box
        page.drawText('X', {
          x: COL.checkX + 2,
          y: topY,
          size: 10,
          font: fontBold,
          color: NAVY,
        });
      }

      // Item number
      page.drawText(String(itemNumber), {
        x: COL.numX,
        y: topY,
        size: 9,
        font: fontBold,
        color: NAVY,
      });

      // Description (wrapped)
      for (let li = 0; li < descLines.length; li++) {
        const isProductLine = productName && li === descLines.length - 1;
        page.drawText(descLines[li], {
          x: COL.descX,
          y: topY - li * 12,
          size: 9,
          font: isProductLine ? fontItalic : fontRegular,
          color: isProductLine ? MID_GRAY : BLACK,
        });
      }

      // Priority — red text for Critical
      const priorityColor = item.priority === 'Critical' ? RED : DARK_GRAY;
      const priorityFont = item.priority === 'Critical' ? fontBold : fontRegular;
      page.drawText(item.priority, {
        x: COL.priorityX,
        y: topY,
        size: 9,
        font: priorityFont,
        color: priorityColor,
      });

      // Assigned To
      const cleanAssigned = sanitize(item.assignedTo) || '—';
      let assigned = cleanAssigned;
      while (fontRegular.widthOfTextAtSize(assigned, 9) > COL.assignedW - 4 && assigned.length > 0) {
        assigned = assigned.slice(0, -1);
      }
      if (assigned !== cleanAssigned) assigned = assigned.slice(0, -1) + '…';
      page.drawText(assigned, {
        x: COL.assignedX,
        y: topY,
        size: 9,
        font: fontRegular,
        color: DARK_GRAY,
      });

      // Status
      page.drawText(item.status, {
        x: COL.statusX,
        y: topY,
        size: 9,
        font: fontRegular,
        color: isComplete ? rgb(0.082, 0.502, 0.239) /* #15803D */ : DARK_GRAY,
      });

      y -= rowH;
    }

    // Spacing between location groups
    y -= 14;
  }

  // Footer on the last page
  addFooter(page, fontRegular, currentPageNum, 'Punch List');

  // ===================== SAVE & DOWNLOAD =====================
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number} - Punch List.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  // Fire-and-forget: file a copy into the project's SharePoint folder.
  void fileGeneratedPdf(
    project.id, 'closeout', 'punch_list',
    `${project.number} - Punch List.pdf`, pdfBytes,
  );
}
