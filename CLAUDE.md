# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- `app.js` — the entire frontend (~1900 lines), organized in `// ---- section`
  banner comments: state, geometry, history, rendering, connectors,
  transformation, pointer, text UI, keyboard, UI, theme, icon font TTF,
  SVG icon library, drawing persistence, gallery modal, eraser.io share
  links, image import, import/export JSON, PNG export, session autosave,
  init. Find a feature by grepping for its banner.
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
  Eraser's public icon set. The svgicon tool stamps them as image elements
  with the SVG embedded as a data URL; browsing them needs the server.

## Architecture (app.js)

1. **Scene as data.** The whole drawing is `elements`, a flat array of plain
   JSON objects (`{id, type, x, y, …}`). Undo/redo, save, export, and
   autosave all operate on this array; undo is `JSON.stringify(elements)`
   snapshots. Any state change should call the history/repaint helpers
   rather than mutating silently — every repaint also schedules the
   localStorage session autosave.

2. **Camera transform.** Elements store world coordinates;
   `camera = {x, y, zoom}` plus `screenToWorld`/`worldToScreen` convert to
   and from mouse pixels.

3. **Immediate-mode rendering.** `render()` clears and redraws everything on
   every change. No dirty-tracking or scene graph.

4. **Interaction state machine.** One `drag` object describes the pointer
   interaction in progress (`pan`, `move`, `resize`, `marquee`, `create`,
   `pen`, `endpoint`, …). `pointerdown` decides which, `pointermove`
   executes, `pointerup` finalizes. New interactions should be new `drag`
   kinds, not parallel event handlers.

5. **Pluggable persistence.** A saved drawing is one JSON document
   (`{version, name, savedAt, thumbnail, elements, iconFont}`). Two backends
   implement the same `list/load/save/remove` interface: `serverStore`
   (fetch → server.js → files) and `localStore` (localStorage). Changes to
   the save flow must work through both.

6. **Connectors** are arrows bound to element borders (they re-anchor when
   shapes move) — see the connectors section in app.js and
   `guides/draw-curves.md` for the intended behavior.

7. **Icon fonts**: user picks a `.ttf`/`.otf`; `ttf.js` enumerates its
   codepoints, the `FontFace` API registers it, and placed icons are
   text-like elements. On save the raw font bytes are base64-embedded in the
   drawing JSON so files stay self-contained.

## Project skills

- `/verify` — build/launch/drive the app headlessly to check changes.
- `/export-eraser-doc` — convert an Eraser document into this app's native
  JSON scene format in `drawings/` (needs the eraser MCP server connected).
