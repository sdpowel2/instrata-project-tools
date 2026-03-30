import { PDFDocument, PDFDict, PDFName, PDFArray, PDFString, PDFHexString, PDFRef } from 'pdf-lib';
import type { ManualBookmark } from '../types';

/**
 * Extracts PDF outline (bookmarks) from a PDF file.
 * Bluebeam automatically creates bookmarks named after each stapled file,
 * so this gives us a ready-made table of contents.
 */
export async function extractBookmarks(pdfBytes: Uint8Array): Promise<ManualBookmark[]> {
  const bookmarks: ManualBookmark[] = [];

  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const pageRefs = pages.map((p) => p.ref);

    const catalog = pdfDoc.catalog;
    const outlines = catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    if (!outlines) return bookmarks;

    function getTitle(node: PDFDict): string {
      const titleObj = node.lookup(PDFName.of('Title'));
      if (titleObj instanceof PDFString) return titleObj.decodeText();
      if (titleObj instanceof PDFHexString) return titleObj.decodeText();
      return '';
    }

    function getPageNum(node: PDFDict): number {
      // Try /Dest array directly
      const dest = node.lookup(PDFName.of('Dest'));
      if (dest instanceof PDFArray && dest.size() > 0) {
        const ref = dest.lookup(0);
        if (ref instanceof PDFRef) {
          const idx = pageRefs.findIndex((r) => r.objectNumber === ref.objectNumber);
          if (idx >= 0) return idx + 1;
        }
      }
      // Try /A (GoTo action) with /D destination
      const action = node.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action) {
        const d = action.lookup(PDFName.of('D'));
        if (d instanceof PDFArray && d.size() > 0) {
          const ref = d.lookup(0);
          if (ref instanceof PDFRef) {
            const idx = pageRefs.findIndex((r) => r.objectNumber === ref.objectNumber);
            if (idx >= 0) return idx + 1;
          }
        }
      }
      return 0;
    }

    function traverse(node: PDFDict, depth: number) {
      let current = node.lookupMaybe(PDFName.of('First'), PDFDict);
      while (current) {
        const title = getTitle(current);
        const page  = getPageNum(current);
        if (title) bookmarks.push({ title, page, depth });

        // Recurse into children (limit depth to avoid pathological PDFs)
        if (depth < 4) traverse(current, depth + 1);

        current = current.lookupMaybe(PDFName.of('Next'), PDFDict);
      }
    }

    traverse(outlines, 0);
  } catch (err) {
    console.warn('[extractBookmarks] Failed to parse outline:', err);
  }

  return bookmarks;
}
