import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { Project, ManualBookmark } from '../types';
import letterheadUrl from '../assets/letterhead.pdf?url';

const NAVY      = rgb(0.133, 0.196, 0.431);
const ORANGE    = rgb(0.965, 0.553, 0.180);
const WHITE     = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY  = rgb(0.5, 0.5, 0.55);

const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];
const MARGIN  = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch: ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Builds the product manuals PDF section (cover + optional TOC + embedded manual PDF).
 * Can be called standalone (exportManualsPDF) or used by exportCloseoutPDF.
 *
 * @param pdfDoc      - existing PDFDocument to append into (pass null for standalone)
 * @param project     - project info for cover page
 * @param manualBytes - raw bytes of the stapled product manual PDF
 * @param bookmarks   - bookmarks extracted from the manual PDF
 * @returns           - { startPage, pageCount } of the section
 */
export async function appendManualSection(
  pdfDoc: PDFDocument,
  fontRegular: Awaited<ReturnType<typeof pdfDoc.embedFont>>,
  fontBold: Awaited<ReturnType<typeof pdfDoc.embedFont>>,
  fontItalic: Awaited<ReturnType<typeof pdfDoc.embedFont>>,
  project: Project,
  manualBytes: Uint8Array,
  bookmarks: ManualBookmark[],
  startingPageNum: number,
): Promise<number> {
  let currentPageNum = startingPageNum;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // ── Cover page (letterhead background) ──
  const letterheadBytes = await fetchBytes(letterheadUrl);
  const letterheadDoc   = await PDFDocument.load(letterheadBytes);
  const [letterheadPage] = await pdfDoc.copyPages(letterheadDoc, [0]);
  pdfDoc.addPage(letterheadPage);
  currentPageNum++;
  const coverPage = pdfDoc.getPage(pdfDoc.getPageCount() - 1);

  const CONTENT_TOP    = PAGE_H - 215;
  const CONTENT_BOTTOM = 75;

  let y = CONTENT_TOP;

  // Section label top-right
  const sectionLabel = 'PRODUCT MANUALS';
  coverPage.drawText(sectionLabel, {
    x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(sectionLabel, 8),
    y: y + 10, size: 8, font: fontBold, color: MID_GRAY,
  });

  // Project name
  coverPage.drawText(project.name, { x: MARGIN, y, size: 15, font: fontBold, color: NAVY });
  y -= 20;

  // Navy rule
  coverPage.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: NAVY });
  y -= 16;

  // Subtitle
  coverPage.drawText('Product Manuals', { x: MARGIN, y, size: 13, font: fontRegular, color: DARK_GRAY });
  y -= 14;
  coverPage.drawText(`Project No. ${project.number}  ·  ${today}`, {
    x: MARGIN, y, size: 9, font: fontRegular, color: MID_GRAY,
  });
  y -= 28;

  // Orange rule
  coverPage.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.5, color: ORANGE });
  y -= 20;

  // ── TOC from bookmarks ──
  if (bookmarks.length > 0) {
    coverPage.drawText('CONTENTS', { x: MARGIN, y, size: 8, font: fontBold, color: MID_GRAY });
    y -= 16;

    // Offset page numbers by 1 (cover page is page 1 of this section)
    const pageOffset = currentPageNum; // pages before the manual content

    for (const bm of bookmarks) {
      if (y < CONTENT_BOTTOM + 14) break; // don't overflow into letterhead footer

      const indent = bm.depth * 14;
      const isTop  = bm.depth === 0;
      const font   = isTop ? fontBold : fontRegular;
      const size   = isTop ? 10 : 9;
      const color  = isTop ? NAVY : DARK_GRAY;

      // Truncate title if too wide
      const maxTitleW = CONTENT_W - indent - 50;
      let title = bm.title;
      while (font.widthOfTextAtSize(title, size) > maxTitleW && title.length > 1) {
        title = title.slice(0, -1);
      }
      if (title !== bm.title) title = title.slice(0, -1) + '\u2026';

      coverPage.drawText(title, { x: MARGIN + indent, y, size, font, color });

      // Dot leader + page number
      if (bm.page > 0) {
        const pageLabel = String(bm.page + pageOffset);
        const pageX = PAGE_W - MARGIN - fontRegular.widthOfTextAtSize(pageLabel, size);
        coverPage.drawText(pageLabel, { x: pageX, y, size, font: fontRegular, color: MID_GRAY });

        const titleEnd = MARGIN + indent + font.widthOfTextAtSize(title, size) + 6;
        let dotX = titleEnd;
        while (dotX < pageX - 6) {
          coverPage.drawText('.', { x: dotX, y, size: 7, font: fontRegular, color: LIGHT_GRAY });
          dotX += 4.5;
        }
      }

      y -= isTop ? 16 : 13;
    }
  } else {
    coverPage.drawText('No bookmarks detected in this PDF.', {
      x: MARGIN, y, size: 9, font: fontItalic, color: MID_GRAY,
    });
  }

  // ── Embed the full manual PDF ──
  const manualDoc = await PDFDocument.load(manualBytes);
  const manualPages = await pdfDoc.copyPages(manualDoc, manualDoc.getPageIndices());
  for (const mp of manualPages) {
    pdfDoc.addPage(mp);
    currentPageNum++;
  }

  return currentPageNum;
}

/**
 * Standalone export: cover page + TOC + full manual PDF.
 */
export async function exportManualsPDF(
  project: Project,
  manualBytes: Uint8Array,
  bookmarks: ManualBookmark[],
): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  await appendManualSection(pdfDoc, fontRegular, fontBold, fontItalic, project, manualBytes, bookmarks, 0);

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${project.number} - Product Manuals.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
