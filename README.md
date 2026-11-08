# vSketch

A small eraser.io-style whiteboard built with **vanilla HTML + Canvas 2D + JavaScript** — no dependencies, no build step. Made for learning how drawing apps work.

## Run it

**With the drawings folder (recommended):**

```bash
node server.js
# → http://localhost:8123 — drawings persist as JSON files in ./drawings/
```

**Without a server:** just open `index.html` in a browser (or use
`python3 -m http.server`). Everything works the same, except saved drawings
go to browser `localStorage` instead of the `drawings/` folder — the app
detects at startup whether the server API is present and picks the backend
automatically (the badge in the Drawings dialog shows which one is active).

## Features

- Shapes: rectangle, ellipse, diamond, line, arrow, freehand pen, text
- **Font icons from any `.ttf`/`.otf`**: click *Load icon TTF*, pick an icon font
  (Font Awesome, Material Icons, Bootstrap Icons…), browse its glyphs in the
  sidebar, click one, then click the canvas to place it
- Infinite canvas: scroll to zoom (toward the cursor), pan with the hand tool (H), Space-drag, or middle-drag
- Select, multi-select (shift-click or marquee), move, corner-resize, duplicate
- Undo/redo, PNG export, import/export as a JSON file (the icon font is embedded)
- **Dark / light theme**: toggle with the 🌙/☀️ button; remembered across visits
  and defaults to your system preference. The UI is themed with CSS variables;
  the drawing surface is themed with an invert+hue-rotate filter
  (excalidraw-style), so elements keep their stored colors and PNG export /
  thumbnails always render light
- **Image import**: the *Image* button, pasting from the clipboard, or dropping
  a file onto the canvas — the image becomes a movable/resizable element with
  its pixels embedded as a data URL, so drawings stay self-contained
- **Session autosave**: the live scene, camera, and doc name are mirrored to
  localStorage after every change and restored on the next load, so a browser
  refresh or crash loses nothing (best-effort: skipped if the scene outgrows
  the localStorage quota)
- **Drawings gallery**: save named drawings with thumbnails and reopen them from
  the UI (*Drawings* button or Ctrl+S). Stored in the `drawings/` folder when
  running `server.js`, or in browser localStorage otherwise
- **Eraser.io import**: paste a share link (e.g.
  `https://app.eraser.io/workspace/…?origin=share`) and its diagram lands on
  your canvas as a movable/resizable image. Needs `server.js` (CORS proxy).
  Note: Eraser exposes no public API for the editable scene behind a share
  link — only its rendered preview image — so the import is a bitmap, not
  editable shapes

## Shortcuts

| Key | Action |
|---|---|
| V H R O D L A P T | select / pan / rect / ellipse / diamond / line / arrow / pen / text |
| Ctrl+S | save to the drawings gallery |
| Ctrl+Shift+S | save as — save under a new name |
| Delete | delete selection |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Ctrl+D | duplicate |
| Ctrl+A | select all |
| Double-click | add or edit text |
| Escape | deselect / back to select tool |

## How it works (the learning part)

### Files

- `index.html` — layout: toolbar, sidebar (style + icon grid), canvas, gallery dialog
- `style.css` — UI styling
- `ttf.js` — a minimal binary parser for the font's `cmap` table
- `app.js` — everything else, organized in sections
- `server.js` — optional zero-dependency Node server (Node 18+): serves the
  app, exposes a tiny REST API (`GET/PUT/DELETE /api/drawings/<name>`) that
  reads and writes JSON files in `drawings/`, and proxies Eraser share-link
  imports (`GET /api/eraser?url=…` — extracts the workspace id, fetches the
  page's `og:title` and its `/preview` image from the fixed `app.eraser.io`
  host, and returns them as `{title, dataUrl}`)
- `drawings/` — created on first run of `server.js`; one `.json` file per saved drawing

### Core ideas in `app.js`

1. **Scene as data.** The whole drawing is `elements`, a flat array of plain
   JSON objects (`{id, type, x, y, ...}`). Undo, save, and export all just
   operate on this array. Undo is literally `JSON.stringify(elements)` snapshots.

2. **Camera transform.** Elements store *world* coordinates. The view is
   `camera = {x, y, zoom}`. Two tiny functions, `screenToWorld` /
   `worldToScreen`, convert between mouse pixels and world space. "Zoom toward
   cursor" = change zoom, then shift the camera so the world point under the
   mouse stays put.

3. **Immediate-mode rendering.** `render()` clears the canvas and redraws
   everything on every change. No dirty-tracking, no scene graph — simple and
   fast enough for hundreds of shapes.

4. **Interaction state machine.** One `drag` object describes the interaction
   in progress (`pan`, `move`, `resize`, `marquee`, `create`, `pen`,
   `endpoint`). `pointerdown` decides which, `pointermove` executes it,
   `pointerup` finalizes.

5. **Text editing** overlays a positioned `<textarea>` on top of the canvas
   (canvas can't do text input), scaled to the current zoom, and commits the
   value back into the element on blur.

6. **Pluggable persistence.** A drawing is a single JSON document
   (`{name, savedAt, thumbnail, elements, iconFont}`). Two backends implement
   the same 4-method interface (`list/load/save/remove`): `serverStore`
   (fetch → `server.js` → files in `drawings/`) and `localStore`
   (localStorage). At startup the app probes `GET /api/drawings` and picks
   whichever is available. Thumbnails are just the scene rendered small into
   an offscreen canvas and stored as a JPEG data URL inside the document.

### How TTF icon support works

1. You pick a `.ttf` file; it's read as an `ArrayBuffer`.
2. `ttf.js` parses the font's **`cmap` table** (the codepoint → glyph map,
   subtable formats 4 and 12) with a `DataView` to enumerate which Unicode
   codepoints the font actually contains — icon fonts usually live in the
   Private Use Area (U+E000–U+F8FF).
3. The font is registered with the **`FontFace` API**
   (`document.fonts.add(new FontFace(name, buffer))`) so both CSS (the icon
   grid) and canvas `fillText()` can render it.
4. Placing an icon just creates a text-like element:
   `{type: 'icon', char: String.fromCodePoint(cp), family, size}` drawn with
   `ctx.font = size + 'px ' + family; ctx.fillText(char, x, y)`.
5. On save, the raw font bytes are base64-embedded in the JSON so a saved
   drawing reopens with its icons intact.

### Ideas to extend it

- Rotation (add an `angle` per element, `ctx.rotate` around the center)
- Snapping / alignment guides
- Sticky-note and container shapes with auto-layout text
- Multiplayer via WebSocket + CRDT (this is the fun rabbit hole)
- Hand-drawn "sketchy" rendering (see how roughjs perturbs paths)
