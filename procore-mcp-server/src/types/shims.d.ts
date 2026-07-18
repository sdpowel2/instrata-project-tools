// Minimal type shims for libraries that don't ship their own declarations.

declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  function pdfParse(data: Buffer | Uint8Array, options?: { max?: number }): Promise<PdfParseResult>;
  export default pdfParse;
}

declare module 'mammoth' {
  interface ExtractResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<ExtractResult>;
  const _default: { extractRawText: typeof extractRawText };
  export default _default;
}
