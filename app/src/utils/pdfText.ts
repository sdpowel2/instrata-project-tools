// Shared text-sanitizer for all pdf-lib PDF exporters.
//
// pdf-lib StandardFonts (Helvetica) use WinAnsi (CP1252) encoding, which
// cannot encode many common typographic Unicode chars — smart quotes, en/em
// dashes, primes, the multiplication sign, ellipsis, and the non-breaking
// hyphen (U+2011) that sneaks in via copy-paste from Word/web. drawText and
// widthOfTextAtSize throw on the first such glyph, aborting the whole export.
// Map the frequent offenders to ASCII look-alikes; the catch-all drops
// anything still unencodable (a dropped glyph beats a crashed export).
//
// This file must stay UTF-8 for the character classes below to match the
// intended code points.
const WINANSI_REPLACEMENTS: [RegExp, string][] = [
  [/[‐-―−]/g, '-'],                       // hyphens, dashes, minus sign
  [/[‘’‚‛′]/g, "'"],            // single quotes, prime (feet)
  [/[“”„‟″]/g, '"'],            // double quotes, double prime (inches)
  [/…/g, '...'],                                    // ellipsis
  [/[•·]/g, '-'],                              // bullet, middle dot
  [/×/g, 'x'],                                      // multiplication sign (dimensions)
  [/[  -   　]/g, ' '],     // non-breaking / thin spaces
  [/[​-‍﻿]/g, ''],                        // zero-width spaces / BOM
];

export function sanitizePdfText(s: string | null | undefined): string {
  if (!s) return '';
  let out = String(s);
  for (const [re, rep] of WINANSI_REPLACEMENTS) out = out.replace(re, rep);
  // C0/C1 control chars -> space, then remove any remaining char outside
  // printable ASCII + the Latin-1 supplement (all of which WinAnsi encodes).
  out = out.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}
