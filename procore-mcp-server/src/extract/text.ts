/**
 * Server-side document text extraction for read_document (spec §6.10).
 * PDF via pdf-parse, DOCX via mammoth, plain text passthrough. Operates on an
 * in-memory buffer and never writes to disk — nothing is persisted.
 *
 * pdf-parse is imported from its lib entry to avoid the package index's debug
 * behavior (it tries to read a bundled test PDF when imported as a main module).
 */
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export type Extraction = { extracted: boolean; truncated: boolean; text: string; note?: string };

/** Below this many characters, a PDF is almost certainly a scanned/vector drawing. */
const MIN_PDF_TEXT = 20;

export async function extractText(
  buffer: Buffer,
  filename: string,
  mime: string | undefined,
  maxChars: number,
): Promise<Extraction> {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const m = mime ?? '';
  const isPdf = ext === 'pdf' || m.includes('pdf');
  const isDocx = ext === 'docx' || m.includes('officedocument.wordprocessingml');
  const isText = ext === 'txt' || ext === 'csv' || ext === 'md' || m.startsWith('text/');

  let text = '';
  if (isPdf) {
    const parsed = await pdfParse(buffer);
    text = parsed.text ?? '';
    if (text.trim().length < MIN_PDF_TEXT) {
      return {
        extracted: false,
        truncated: false,
        text: '',
        note: 'Likely a scanned or vector drawing; text extraction unavailable (no OCR in v1).',
      };
    }
  } else if (isDocx) {
    text = (await mammoth.extractRawText({ buffer })).value ?? '';
  } else if (isText) {
    text = buffer.toString('utf8');
  } else {
    return {
      extracted: false,
      truncated: false,
      text: '',
      note: `Unsupported file type for extraction: .${ext || 'unknown'}. v1 supports PDF, DOCX, and plain text.`,
    };
  }

  const truncated = text.length > maxChars;
  return { extracted: true, truncated, text: truncated ? text.slice(0, maxChars) : text };
}
