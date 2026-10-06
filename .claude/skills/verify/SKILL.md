---
name: verify
description: How to build, launch, and drive drawing-app (Sketchpad) to verify changes end-to-end in a headless browser.
---

# Verifying drawing-app

No build step — vanilla HTML/JS. Launch:

```bash
cd drawing-app && node server.js &   # serves app + drawings API on http://localhost:8123
```

## Driving the GUI headlessly

No system browser on this machine and no passwordless sudo. Working recipe:

```bash
cd <scratchpad> && npm i playwright && npx playwright install chromium-headless-shell
# chromium fails to launch: libnspr4.so / libnss3 / libasound missing.
# Extract them locally instead of apt-get install:
mkdir libs && cd libs
apt-get download libnspr4 libnss3 libasound2t64
for f in *.deb; do dpkg -x "$f" extracted/; done
# then run node with:
LD_LIBRARY_PATH=$PWD/libs/extracted/usr/lib/x86_64-linux-gnu node <driver>.js
```

## Gotchas when driving app.js

- app.js is an ES module, so its top-level state is not on `window`. It
  exposes the drawing surface as `window.sketchpad` (the vUX SketchPad):
  assert on `sketchpad.elements`, `.selection`, `.tool`, `.camera`, `.zoom`.
- Drawing: keyboard shortcut (`r`, `a`, `t`…) then mouse down/move/up on
  `#canvas-wrap canvas` (the pad creates the canvas; there is no `#canvas`).
- Keys go nowhere while focus is in a sidebar input (the pad ignores keys
  typed into inputs) — click the canvas before pressing Ctrl+D, Delete, etc.
- If `npm i playwright` pulls a newer version than the cached browser, pass
  `executablePath` pointing at the `~/.cache/ms-playwright/chromium_headless_shell-*`
  build that exists.
- Session autosave debounces 800 ms after any `render()`; `beforeunload` flushes
  it — so reloading always persists the live scene. To test startup with a
  planted localStorage value, use `context.addInitScript()`, not `evaluate()`
  before reload (beforeunload would overwrite it).
- Native dialogs (Clear confirm, save prompt, non-image alert) need
  `page.once('dialog', d => d.accept())`.
- Dark theme = `data-theme="dark"` on `<html>` + invert filter on `#canvas-wrap`;
  check `getComputedStyle(...).filter` and take screenshots for both themes.

## Flows worth driving

draw rect → import image (file chooser on `#btn-image`, drop event on canvas) →
toggle theme → zoom/pan → reload (scene, camera, name, theme must survive) →
Clear (session key must be removed) → non-image file (alert, no element added).
