# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**vSketch** (renamed from sketch-app / "Sketchpad" on 2026-11-08). Repo: `github.com/VilsHub/vSketch`,
checked out at `Apps/vSketch`. The `SketchPad` in the code is the vUX component, not the app's name.

## Running

No dependencies, no build step, no test suite — vanilla HTML + Canvas 2D + JS.

```bash
node server.js   # http://localhost:8123 (Node 18+; PORT env var to override)
```

The server is optional: opening `index.html` directly also works, but saved
drawings then go to localStorage instead of the `drawings/` folder. The app
probes `GET /api/drawings` at startup and picks the backend automatically.

To verify changes end-to-end in a headless browser, use the `verify` skill
(`.claude/skills/verify/SKILL.md`) — it documents the working Playwright
recipe for this machine (system Chromium won't launch; use
`chromium-headless-shell`).

## Files

- `app.js` — the app around the drawing surface (~900 lines, an ES module),
  organized in `// ---- section` banner comments: state, UI, theme, icon
  font TTF, SVG icon library, drawing persistence, gallery modal, eraser.io
  share links, image import, import/export JSON, PNG export, session
  autosave, init. Find a feature by grepping for its banner.
- `lib/vUX` — relative symlink to `../../../Libraries/vUX`. The drawing
  surface itself is vUX's `SketchPad` (`lib/vUX/vUX-sketchPad.js`): scene,
  rendering, selection, connectors, text editing, undo/redo, pan/zoom and the
  editing shortcuts. **Editing it edits the vUX repo**, and My Invitees uses
  the same module; see `Libraries/vUX/doc/sketch-pad.md`. `index.html` boots
  vUX with `data-id="vUX" data-library-root="lib/vUX"` on the app.js tag.
- `server.js` — zero-dependency static-file server + REST API
  (`GET/PUT/DELETE /api/drawings/<name>` → JSON files in `drawings/`) +
  `GET /api/icons` (lists `icons/` for the place-icon panel) +
  `GET /api/eraser?url=…` CORS proxy for eraser.io share-link previews.
  `safeName()` is the path-traversal guard — keep any new file-touching
  endpoint behind it.
- `ttf.js` — minimal binary parser for a font's `cmap` table (formats 4/12),
  used to enumerate glyphs in user-loaded icon fonts.
- `index.html` / `style.css` — layout and theming (CSS variables for UI;
  the canvas is dark-themed via an invert+hue-rotate filter, so elements
  keep their stored light-theme colors and PNG export always renders light).
- `guides/draw-curves.md` — user-facing doc for the connector/curve UX.
- `drawings/` — one `.json` file per saved drawing; created on first server run.
- `icons/` — stock SVG icons, one folder per category (aws, azure, …), from
  Eraser's public icon set. The pad's stamp tool places them as image elements
  with the SVG embedded as a data URL; browsing them needs the server.

## Architecture

1. **The surface is a vUX component.** `const pad = new SketchPad(wrap)` in
   app.js, configured (`keyboardScope: 'document'`, the tool shortcut map,
   callbacks) and started with `pad.initialize()` at the very end of the
   file — its callbacks touch state declared further down. Everything the
   app does to the drawing goes through the pad's API: `pad.tool`,
   `pad.setStyle()`, `pad.load()`, `pad.elements`, `pad.insertImage()`,
   `pad.exportCanvas()`, `pad.icon` / `pad.stamp`, `pad.zoomBy()`. Engine
   behaviour (a new shape, a new drag kind, hit-testing, undo) belongs in
   `vUX-sketchPad.js`, not here.

2. **Scene as data.** The drawing is `pad.elements`, a flat array of plain
   JSON objects (`{id, type, x, y, …}`); the getter returns a deep copy.
   Undo is JSON snapshots inside the pad. Every repaint fires the pad's
   `change` callback, which schedules the localStorage session autosave.

3. **App keys vs pad keys.** The pad handles editing keys and tool
   shortcuts on `window` and ignores keys typed into inputs. app.js adds a
   capture-phase `keydown` for Ctrl+S / Ctrl+Shift+S and for Escape closing
   a dialog — it calls `stopPropagation()` so that Escape doesn't also
   clear the selection.

4. **Dark theme** inverts `#canvas-wrap` with a CSS filter;
   `pad.counterInvertImages = true` pre-inverts image elements so photos
   keep their colors. Exports are never inverted.

5. **Pluggable persistence.** A saved drawing is one JSON document
   (`{version, name, savedAt, thumbnail, elements, iconFont}`). Two backends
   implement the same `list/load/save/remove` interface: `serverStore`
   (fetch → server.js → files) and `localStore` (localStorage). Changes to
   the save flow must work through both.

6. **Connectors** are arrows bound to element borders (they re-anchor when
   shapes move) — implemented in the pad; `guides/draw-curves.md` describes
   the intended behavior.

7. **Icon fonts**: user picks a `.ttf`/`.otf`; `ttf.js` enumerates its
   codepoints, the `FontFace` API registers it, and placed icons are
   text-like elements. On save the raw font bytes are base64-embedded in the
   drawing JSON so files stay self-contained.

## Project skills

- `/verify` — build/launch/drive the app headlessly to check changes.
- `/export-eraser-doc` — convert an Eraser document into this app's native
  JSON scene format in `drawings/` (needs the eraser MCP server connected).
