/**
 * Minimal TTF/OTF `cmap` reader.
 *
 * A font file is a set of binary tables. The `cmap` table maps Unicode
 * codepoints -> glyph ids, which is exactly what we need to know "which
 * characters does this icon font actually contain". We only read cmap
 * subtable formats 4 (BMP, the common case) and 12 (full Unicode range,
 * used by fonts with codepoints above U+FFFF).
 *
 * Rendering the glyphs themselves is left to the browser: the font is
 * registered with the FontFace API and drawn with canvas fillText().
 */
'use strict';

function parseCmapCodepoints(buffer, maxCodepoints = 2000) {
  const dv = new DataView(buffer);

  // --- font directory: locate the cmap table ---------------------------
  // offset 0: sfntVersion (0x00010000 for TTF, 'OTTO' for CFF-based OTF)
  // offset 4: numTables, then 16-byte table records starting at offset 12
  const numTables = dv.getUint16(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      dv.getUint8(rec), dv.getUint8(rec + 1),
      dv.getUint8(rec + 2), dv.getUint8(rec + 3)
    );
    if (tag === 'cmap') { cmapOffset = dv.getUint32(rec + 8); break; }
  }
  if (cmapOffset < 0) throw new Error('font has no cmap table');

  // --- pick the best encoding subtable ----------------------------------
  // A font may carry several cmap subtables for different platforms.
  // Prefer full-Unicode (3,10) over BMP-only (3,1) over legacy ones.
  const subtableCount = dv.getUint16(cmapOffset + 2);
  let best = -1, bestScore = -1;
  for (let i = 0; i < subtableCount; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const offset = cmapOffset + dv.getUint32(rec + 4);
    const format = dv.getUint16(offset);
    if (format !== 4 && format !== 12) continue;

    let score = 0;
    if (platform === 3 && encoding === 10) score = 4;      // Windows, full Unicode
    else if (platform === 0 && encoding >= 4) score = 3;    // Unicode platform, full range
    else if (platform === 3 && encoding === 1) score = 2;   // Windows, BMP
    else if (platform === 0) score = 1;                     // Unicode platform, BMP
    if (score > bestScore) { bestScore = score; best = offset; }
  }
  if (best < 0) throw new Error('no supported cmap subtable (format 4 or 12)');

  const format = dv.getUint16(best);
  const codepoints = format === 4
    ? readFormat4(dv, best, maxCodepoints)
    : readFormat12(dv, best, maxCodepoints);

  // Drop control chars / space; sort for a stable icon grid.
  return [...new Set(codepoints)].filter(c => c > 0x20).sort((a, b) => a - b);
}

// Format 4: BMP codepoints stored as contiguous segments.
function readFormat4(dv, off, max) {
  const segCount = dv.getUint16(off + 6) / 2;
  const endCodes = off + 14;
  const startCodes = endCodes + segCount * 2 + 2;  // +2 skips reservedPad
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;

  const out = [];
  for (let seg = 0; seg < segCount && out.length < max; seg++) {
    const end = dv.getUint16(endCodes + seg * 2);
    const start = dv.getUint16(startCodes + seg * 2);
    if (start === 0xFFFF) continue; // sentinel segment
    const delta = dv.getInt16(idDeltas + seg * 2);
    const rangeOffset = dv.getUint16(idRangeOffsets + seg * 2);

    for (let c = start; c <= end && out.length < max; c++) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xFFFF;
      } else {
        // rangeOffset is relative to its own position in the file
        const addr = idRangeOffsets + seg * 2 + rangeOffset + (c - start) * 2;
        glyph = dv.getUint16(addr);
        if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
      }
      if (glyph !== 0) out.push(c);
    }
  }
  return out;
}

// Format 12: sequential groups of 32-bit codepoints.
function readFormat12(dv, off, max) {
  const numGroups = dv.getUint32(off + 12);
  const out = [];
  for (let g = 0; g < numGroups && out.length < max; g++) {
    const rec = off + 16 + g * 12;
    const start = dv.getUint32(rec);
    const end = dv.getUint32(rec + 4);
    for (let c = start; c <= end && out.length < max; c++) out.push(c);
  }
  return out;
}
