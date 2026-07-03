/**
 * Minimal TTF/OTF reader for two tables:
 *
 *  - `cmap` maps Unicode codepoints -> glyph ids, which tells us "which
 *    characters does this icon font actually contain". We only read cmap
 *    subtable formats 4 (BMP, the common case) and 12 (full Unicode range,
 *    used by fonts with codepoints above U+FFFF).
 *  - `post` (version 2.0) carries a human-readable name per glyph id
 *    ("magnifying-glass", "arrow-right", …), which powers searching icons
 *    by name. Fonts with post v3.0 ship no names — search falls back to
 *    hex codepoints for those.
 *
 * Rendering the glyphs themselves is left to the browser: the font is
 * registered with the FontFace API and drawn with canvas fillText().
 */
'use strict';

// Locate a top-level table in the font directory.
// offset 0: sfntVersion (0x00010000 for TTF, 'OTTO' for CFF-based OTF)
// offset 4: numTables, then 16-byte table records starting at offset 12
function findFontTable(dv, wanted) {
  const numTables = dv.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      dv.getUint8(rec), dv.getUint8(rec + 1),
      dv.getUint8(rec + 2), dv.getUint8(rec + 3)
    );
    if (tag === wanted) return { offset: dv.getUint32(rec + 8), length: dv.getUint32(rec + 12) };
  }
  return null;
}

// Returns { codepoints: number[], names: Map<codepoint, string> }.
function parseIconFont(buffer, maxCodepoints = 2000) {
  const dv = new DataView(buffer);

  const cmap = findFontTable(dv, 'cmap');
  if (!cmap) throw new Error('font has no cmap table');
  const cmapOffset = cmap.offset;

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
  const pairs = format === 4
    ? readFormat4(dv, best, maxCodepoints)
    : readFormat12(dv, best, maxCodepoints);

  // Drop control chars / space and duplicates; sort for a stable icon grid.
  const glyphNames = parsePostNames(dv);
  const codepoints = [];
  const names = new Map();
  const seen = new Set();
  for (const [c, glyph] of pairs) {
    if (c <= 0x20 || seen.has(c)) continue;
    seen.add(c);
    codepoints.push(c);
    const name = glyphNames.get(glyph);
    if (name) names.set(c, name);
  }
  codepoints.sort((a, b) => a - b);
  return { codepoints, names };
}

// `post` v2.0 = 32-byte header, numGlyphs, glyphNameIndex[numGlyphs], then
// Pascal strings. Indexes < 258 refer to the standard Macintosh glyph list
// (Latin names like 'ampersand' — useless for icon search, so skipped);
// >= 258 index the custom strings where icon fonts keep their real names.
function parsePostNames(dv) {
  const names = new Map(); // glyph id -> name
  const post = findFontTable(dv, 'post');
  if (!post || dv.getUint32(post.offset) !== 0x00020000) return names;

  const numGlyphs = dv.getUint16(post.offset + 32);
  const idxBase = post.offset + 34;
  const tableEnd = post.offset + post.length;

  const custom = [];
  for (let p = idxBase + numGlyphs * 2; p < tableEnd;) {
    const len = dv.getUint8(p++);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(p + i));
    p += len;
    custom.push(s);
  }

  for (let g = 0; g < numGlyphs; g++) {
    const idx = dv.getUint16(idxBase + g * 2);
    if (idx >= 258 && custom[idx - 258]) names.set(g, custom[idx - 258]);
  }
  return names;
}

// Both cmap readers return [codepoint, glyphId] pairs.

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
      if (glyph !== 0) out.push([c, glyph]);
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
    const startGlyph = dv.getUint32(rec + 8);
    for (let c = start; c <= end && out.length < max; c++) {
      out.push([c, startGlyph + (c - start)]);
    }
  }
  return out;
}
