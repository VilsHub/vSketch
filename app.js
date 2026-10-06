/**
 * Sketchpad — a small eraser.io-style whiteboard.
 *
 * Architecture:
 *  - The drawing surface is vUX's SketchPad component (lib/vUX/vUX-sketchPad.js):
 *    the scene, rendering, selection, connectors, text editing, undo/redo,
 *    pan/zoom and the editing shortcuts all live there. This file is the app
 *    around it: toolbar and style panel, icon fonts and the SVG icon library,
 *    saved drawings, imports/exports, theme and session autosave.
 *  - The scene is `pad.elements`, a flat array of plain JSON objects, one per
 *    shape. Saving serializes it; opening hands it back with pad.load().
 *  - Every repaint fires the pad's `change` callback, which is the one
 *    autosave hook needed.
 */

import { SketchPad } from './lib/vUX/vUX-sketchPad.js';

// ---------------------------------------------------------------- state

const wrap = document.getElementById('canvas-wrap');
const pad = new SketchPad(wrap);
window.sketchpad = pad; // handle for the console and headless checks

let iconFont = null;               // { family, dataB64, codepoints[], names, extraNames }
let currentIcon = null;            // codepoint chosen in the icon grid

// The pad listens on the whole document so the editing keys work whatever
// toolbar button last took focus; it ignores keys typed into inputs.
pad.config.keyboardScope = 'document';
pad.config.shortcuts = {
  v: 'select', h: 'pan', r: 'rect', o: 'ellipse', d: 'diamond',
  '3': 'triangle', '5': 'pentagon', '6': 'hexagon', s: 'star',
  l: 'line', a: 'arrow', p: 'pen', t: 'text', i: 'stamp',
};
// Called from initialize() onwards, so the init section runs it last: the
// handlers below read state declared further down the file.
pad.config.callbacks = {
  change: () => scheduleAutosave(),
  toolChange: t => updateToolUI(t),
  zoomChange: () => updateZoomLabel(),
};

// App-level keys. Capture phase, so a key handled here (Escape closing a
// dialog) can be kept from also reaching the pad's own listener.
window.addEventListener('keydown', e => {
  if (pad.editing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    e.shiftKey ? saveAs() : quickSave();
    return;
  }
  if (e.key === 'Escape') {
    if (!gallery.classList.contains('hidden')) { closeGallery(); e.stopPropagation(); return; }
    if (!exportDialog.classList.contains('hidden')) { closeExportDialog(); e.stopPropagation(); }
  }
}, true);

// ------------------------------------------------------------------- UI

function updateToolUI(t) {
  document.querySelectorAll('#toolbar .tool').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === t));
  updateIconPanel();
  updateSvgIconPanel();
}

// The icon panel lives only with the icon tool: hidden otherwise, and it
// shows a load-a-font hint instead of the grid until a font is loaded.
function updateIconPanel() {
  const panel = document.getElementById('icon-panel');
  panel.classList.toggle('hidden', pad.tool !== 'icon');
  if (pad.tool !== 'icon') return;
  const hasFont = !!iconFont;
  document.getElementById('icon-empty').classList.toggle('hidden', hasFont);
  document.getElementById('icon-search').classList.toggle('hidden', !hasFont);
  document.getElementById('icon-grid').classList.toggle('hidden', !hasFont);
}

document.getElementById('icon-load-link').addEventListener('click', () =>
  document.getElementById('file-ttf').click());

document.querySelectorAll('#toolbar .tool').forEach(btn => {
  btn.addEventListener('click', () => { pad.tool = btn.dataset.tool; });
});

// style inputs: each sets the pad's default and restyles the selection
document.getElementById('prop-stroke').addEventListener('input', e => {
  pad.setStyle({ stroke: e.target.value });
});
document.getElementById('prop-fill-on').addEventListener('change', e => {
  const colorInput = document.getElementById('prop-fill');
  colorInput.disabled = !e.target.checked;
  pad.setStyle({ fill: e.target.checked ? colorInput.value : 'transparent' });
});
document.getElementById('prop-fill').addEventListener('input', e => {
  pad.setStyle({ fill: e.target.value });
});
document.querySelectorAll('.line-style').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.line-style').forEach(b => b.classList.toggle('active', b === btn));
    pad.setStyle({ lineStyle: btn.dataset.style });
  });
});
document.getElementById('prop-dashgap').addEventListener('input', e => {
  pad.setStyle({ dashGap: +e.target.value });
});
document.getElementById('prop-width').addEventListener('input', e => {
  pad.setStyle({ strokeWidth: +e.target.value });
});
document.getElementById('prop-fontsize').addEventListener('input', e => {
  pad.setStyle({ fontSize: +e.target.value });
});

// zoom bar
function updateZoomLabel() {
  document.getElementById('zoom-reset').textContent = Math.round(pad.zoom * 100) + '%';
}
document.getElementById('zoom-in').addEventListener('click', () => pad.zoomBy(1.2));
document.getElementById('zoom-out').addEventListener('click', () => pad.zoomBy(1 / 1.2));
document.getElementById('zoom-reset').addEventListener('click', () => pad.resetView());

// ----------------------------------------------------------------- theme
//
// The UI is themed with CSS variables; the drawing surface is themed by a
// CSS invert filter on #canvas-wrap (see style.css), so elements keep their
// stored colors; the pad counter-inverts image elements so photos keep
// theirs. index.html sets data-theme before first paint; here we only toggle
// it. PNG export and thumbnails always render light.

const THEME_KEY = 'sketchpad:theme';

function isDarkTheme() { return document.documentElement.dataset.theme === 'dark'; }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  pad.counterInvertImages = theme === 'dark'; // repaints
}

document.getElementById('btn-theme').addEventListener('click', () => {
  const theme = isDarkTheme() ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
});

// --------------------------------------------------------- icon font TTF

document.getElementById('btn-load-ttf').addEventListener('click', () =>
  document.getElementById('file-ttf').click());

document.getElementById('file-ttf').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const fontFile = files.find(f => /\.(ttf|otf)$/i.test(f.name));
  const jsonFile = files.find(f => /\.json$/i.test(f.name));
  try {
    if (fontFile) await loadIconFont(await fontFile.arrayBuffer());
    if (jsonFile) {
      if (!iconFont) throw new Error('load the icon font (.ttf) first, then its selection.json');
      applySelectionJson(JSON.parse(await jsonFile.text()));
    }
    pad.tool = 'icon';
  } catch (err) {
    alert('Could not load font: ' + err.message);
  }
});

// IcoMoon selection.json: icons[].properties.{name, code} plus search tags.
// Fills the names map for fonts whose post table carries no glyph names.
function applySelectionJson(data) {
  if (!Array.isArray(data.icons)) throw new Error('not an IcoMoon selection.json');
  let applied = 0;
  for (const entry of data.icons) {
    const p = entry.properties || {};
    if (!p.code || !p.name) continue;
    const tags = (entry.icon && entry.icon.tags) || [];
    const name = [...new Set([p.name, ...tags])].join(' ');
    iconFont.names.set(p.code, name);
    iconFont.extraNames.set(p.code, name);
    applied++;
  }
  if (!applied) throw new Error('no icon names found in selection.json');
  buildIconGrid(document.getElementById('icon-search').value.trim());
}

async function loadIconFont(buffer) {
  const { codepoints, names } = parseIconFont(buffer);
  if (!codepoints.length) throw new Error('no glyphs found in cmap');

  // Unique family name per load so the browser never serves a stale font.
  const family = 'IconFont-' + Date.now();
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);

  iconFont = { family, dataB64: bufferToBase64(buffer), codepoints, names, extraNames: new Map() };
  currentIcon = codepoints[0]; // pre-select so the icon tool works immediately
  armIcon();
  document.documentElement.style.setProperty('--icon-font', `"${family}"`);
  buildIconGrid();
  pad.refresh(); // re-render in case existing icons used a previous font
}

function buildIconGrid(filter = '') {
  const grid = document.getElementById('icon-grid');
  updateIconPanel(); // swap the load hint for the grid once a font exists
  grid.innerHTML = '';

  // match glyph names when the font has them (post v2), hex always
  const q = filter.toLowerCase();
  const shown = iconFont.codepoints.filter(cp => {
    if (!q) return true;
    const name = iconFont.names.get(cp);
    return (name && name.toLowerCase().includes(q)) || cp.toString(16).includes(q);
  });
  document.getElementById('icon-count').textContent = `(${shown.length})`;

  for (const cp of shown) {
    const btn = document.createElement('button');
    btn.textContent = String.fromCodePoint(cp);
    const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    const name = iconFont.names.get(cp);
    btn.title = name ? `${name} — ${hex}` : hex;
    if (cp === currentIcon) btn.classList.add('active');
    btn.addEventListener('click', () => {
      currentIcon = cp;
      armIcon();
      grid.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pad.tool = 'icon';
    });
    grid.appendChild(btn);
  }
}

document.getElementById('icon-search').addEventListener('input', e =>
  buildIconGrid(e.target.value.trim()));

// Hand the pad the glyph its icon tool places.
function armIcon() {
  pad.icon = iconFont && currentIcon != null
    ? { family: iconFont.family, char: String.fromCodePoint(currentIcon) }
    : null;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// -------------------------------------------------------- SVG icon library
//
// Stock icons live in ./icons/<category>/<name>.svg; server.js lists them
// via GET /api/icons (the browser can't enumerate a folder itself, so the
// panel needs the local server). Picking one arms the pad's stamp tool;
// each canvas click stamps a plain image element with the SVG embedded as a
// data URL, so saved drawings stay self-contained.

let svgIcons = null;            // { category: [filename, …] } once fetched
let currentSvgIcon = null;      // path of the icon armed for stamping
const svgIconCache = new Map(); // path -> stamp from pad.createStamp()
const SVG_GRID_MAX = 300;       // cap the DOM; search narrows the rest

function svgIconUrl(path) {
  return 'icons/' + path.split('/').map(encodeURIComponent).join('/');
}

// Mono icons (drawn only in black, like most general/tech-logo glyphs) come
// back from pad.createStamp() marked mono, and the pad retints them with the
// Fill color once placed.

async function ensureSvgIcons() {
  if (svgIcons) return;
  const r = await fetch('/api/icons');
  if (!r.ok) throw new Error('server answered ' + r.status);
  const data = await r.json();
  if (!Object.keys(data).length) throw new Error('the icons/ folder is empty');
  svgIcons = data;
  const sel = document.getElementById('svgicon-category');
  sel.innerHTML = '';
  sel.appendChild(new Option('all categories', ''));
  for (const cat of Object.keys(data)) {
    sel.appendChild(new Option(`${cat} (${data[cat].length})`, cat));
  }
}

function buildSvgIconGrid() {
  const grid = document.getElementById('svgicon-grid');
  const cat = document.getElementById('svgicon-category').value;
  const q = document.getElementById('svgicon-search').value.trim().toLowerCase();
  grid.innerHTML = '';

  const matches = [];
  for (const [c, files] of Object.entries(svgIcons)) {
    if (cat && c !== cat) continue;
    for (const f of files) {
      if (!q || f.toLowerCase().includes(q)) matches.push(c + '/' + f);
    }
  }
  document.getElementById('svgicon-count').textContent =
    matches.length > SVG_GRID_MAX ? `(${SVG_GRID_MAX} of ${matches.length})` : `(${matches.length})`;

  for (const path of matches.slice(0, SVG_GRID_MAX)) {
    const btn = document.createElement('button');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = svgIconUrl(path);
    img.alt = '';
    btn.appendChild(img);
    btn.title = path.slice(path.indexOf('/') + 1, -4); // name without category/.svg
    if (currentSvgIcon === path) btn.classList.add('active');
    btn.addEventListener('click', () => pickSvgIcon(path, btn));
    grid.appendChild(btn);
  }
}

async function pickSvgIcon(path, btn) {
  document.querySelectorAll('#svgicon-grid button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  pad.tool = 'stamp';
  try {
    let entry = svgIconCache.get(path);
    if (!entry) {
      const r = await fetch(svgIconUrl(path));
      if (!r.ok) throw new Error('server answered ' + r.status);
      entry = await pad.createStamp(await r.text());
      svgIconCache.set(path, entry);
    }
    pad.stamp = entry;
    currentSvgIcon = path;
  } catch (err) {
    pad.stamp = null;
    currentSvgIcon = null;
    alert('Could not load icon: ' + err.message);
  }
}

// Like the font-icon panel: visible only with its tool, and the category /
// search / grid controls appear only once the library list has loaded.
function updateSvgIconPanel() {
  const panel = document.getElementById('svgicon-panel');
  panel.classList.toggle('hidden', pad.tool !== 'stamp');
  if (pad.tool !== 'stamp') return;
  const setControls = ok => {
    document.getElementById('svgicon-empty').classList.toggle('hidden', ok);
    document.getElementById('svgicon-category').classList.toggle('hidden', !ok);
    document.getElementById('svgicon-search').classList.toggle('hidden', !ok);
    document.getElementById('svgicon-grid').classList.toggle('hidden', !ok);
  };
  if (svgIcons) { setControls(true); return; }
  ensureSvgIcons()
    .then(() => { setControls(true); buildSvgIconGrid(); })
    .catch(err => {
      setControls(false);
      document.getElementById('svgicon-empty').textContent =
        `Icon library unavailable (${err.message}) — it needs the icons/ folder and the local server: run node server.js, then open http://localhost:8123.`;
    });
}

document.getElementById('svgicon-category').addEventListener('change', buildSvgIconGrid);
document.getElementById('svgicon-search').addEventListener('input', buildSvgIconGrid);

// -------------------------------------------------- drawing persistence
//
// A drawing is one JSON document: { version, name, savedAt, thumbnail,
// elements, iconFont }. Two storage backends share the same interface;
// which one is active is decided once at startup:
//   - serverStore: talks to server.js, which writes files into ./drawings/
//   - localStore:  browser localStorage, used when no server is running

let currentName = null; // name of the drawing being edited, if saved

// Embeddable form of the loaded icon font. Names applied from a
// selection.json ride along, since they can't be re-derived from the font.
function serializeIconFont() {
  if (!iconFont) return null;
  const out = { family: iconFont.family, dataB64: iconFont.dataB64 };
  if (iconFont.extraNames.size) out.names = Object.fromEntries(iconFont.extraNames);
  return out;
}

function serializeDrawing(name) {
  return {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    thumbnail: makeThumbnail(),
    elements: pad.elements,
    // embed the icon font so the drawing is self-contained
    iconFont: serializeIconFont(),
  };
}

// Small JPEG preview of the whole scene, used by the gallery list.
function makeThumbnail() {
  const off = pad.exportCanvas({ margin: 16, maxWidth: 320, maxHeight: 200, background: '#ffffff' });
  return off ? off.toDataURL('image/jpeg', 0.75) : null;
}

// Restore a drawing document into the editor (shared by gallery, import and
// session restore). `undoable` lets Ctrl+Z bring the previous scene back.
async function loadDrawingData(data, undoable = false) {
  if (data.iconFont) {
    const buffer = base64ToBuffer(data.iconFont.dataB64);
    // register under the saved family name so icon elements keep working
    const face = new FontFace(data.iconFont.family, buffer);
    await face.load();
    document.fonts.add(face);
    const { codepoints, names } = parseIconFont(buffer);
    // re-apply names that came from a selection.json (not derivable from the font)
    const extraNames = new Map(Object.entries(data.iconFont.names || {}).map(([cp, n]) => [+cp, n]));
    for (const [cp, n] of extraNames) names.set(cp, n);
    iconFont = { family: data.iconFont.family, dataB64: data.iconFont.dataB64, codepoints, names, extraNames };
    if (!codepoints.includes(currentIcon)) currentIcon = codepoints[0];
    armIcon();
    document.documentElement.style.setProperty('--icon-font', `"${data.iconFont.family}"`);
    buildIconGrid();
  }
  pad.load(data.elements || [], { history: undoable });
}

const LS_PREFIX = 'sketchpad:drawing:';

const localStore = {
  label: 'browser storage',
  async list() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(LS_PREFIX)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(key));
        out.push({ name: key.slice(LS_PREFIX.length), savedAt: d.savedAt, thumbnail: d.thumbnail });
      } catch { /* skip corrupt entry */ }
    }
    return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  },
  async load(name) {
    const raw = localStorage.getItem(LS_PREFIX + name);
    if (!raw) throw new Error('drawing not found');
    return JSON.parse(raw);
  },
  async save(name, data) {
    try {
      localStorage.setItem(LS_PREFIX + name, JSON.stringify(data));
    } catch {
      throw new Error('browser storage is full — run server.js or use Export instead');
    }
  },
  async remove(name) { localStorage.removeItem(LS_PREFIX + name); },
};

const serverStore = {
  label: 'drawings/ folder',
  async list() {
    const r = await fetch('/api/drawings');
    if (!r.ok) throw new Error('could not list drawings');
    return r.json();
  },
  async load(name) {
    const r = await fetch('/api/drawings/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('drawing not found');
    return r.json();
  },
  async save(name, data) {
    const r = await fetch('/api/drawings/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error('server rejected the save');
  },
  async remove(name) {
    const r = await fetch('/api/drawings/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) throw new Error('delete failed');
  },
};

let store = localStore;
// Probe for server.js; keep localStorage as the fallback.
(async () => {
  try {
    const r = await fetch('/api/drawings');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) store = serverStore;
  } catch { /* no server — stay on localStorage */ }
})();

function updateDocName() {
  document.getElementById('doc-name').textContent = currentName ? '— ' + currentName : '';
}

// Drawing names double as filenames on the server, so keep them tame.
function cleanName(raw) {
  return (raw || '').trim().replace(/[^\w \-]/g, '').slice(0, 40);
}

async function saveCurrent(name) {
  if (!pad.elements.length) { alert('Nothing to save yet'); return false; }
  name = cleanName(name);
  if (!name) return false;
  try {
    await store.save(name, serializeDrawing(name));
    currentName = name;
    updateDocName();
    return true;
  } catch (err) {
    alert('Save failed: ' + err.message);
    return false;
  }
}

// --------------------------------------------------------- gallery modal

const gallery = document.getElementById('gallery');

async function openGallery() {
  gallery.classList.remove('hidden');
  document.getElementById('store-mode').textContent = store.label;
  document.getElementById('drawing-name').value = currentName || '';
  await refreshGallery();
}
function closeGallery() { gallery.classList.add('hidden'); }

async function refreshGallery() {
  const listEl = document.getElementById('drawing-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  let items;
  try {
    items = await store.list();
  } catch (err) {
    listEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Could not load drawings: ' + err.message;
    listEl.appendChild(p);
    return;
  }

  listEl.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No saved drawings yet — draw something and hit “Save current”.';
    listEl.appendChild(p);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'drawing-item';

    if (item.thumbnail) {
      const img = document.createElement('img');
      img.src = item.thumbnail;
      img.alt = item.name;
      row.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb-placeholder';
      ph.textContent = '∅';
      row.appendChild(ph);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = item.name;
    const dateEl = document.createElement('div');
    dateEl.className = 'date';
    dateEl.textContent = item.savedAt ? new Date(item.savedAt).toLocaleString() : '';
    meta.append(nameEl, dateEl);
    row.appendChild(meta);

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', async () => {
      try {
        const data = await store.load(item.name);
        await loadDrawingData(data, true);
        currentName = item.name;
        updateDocName();
        closeGallery();
      } catch (err) {
        alert('Could not open drawing: ' + err.message);
      }
    });
    row.appendChild(openBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${item.name}"?`)) return;
      try {
        await store.remove(item.name);
        if (currentName === item.name) { currentName = null; updateDocName(); }
        await refreshGallery();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });
    row.appendChild(delBtn);

    listEl.appendChild(row);
  }
}

document.getElementById('btn-drawings').addEventListener('click', openGallery);
document.getElementById('gallery-close').addEventListener('click', closeGallery);
gallery.addEventListener('click', e => { if (e.target === gallery) closeGallery(); });
gallery.addEventListener('keydown', e => { if (e.key === 'Escape') closeGallery(); });

document.getElementById('btn-save-as').addEventListener('click', async () => {
  if (await saveCurrent(document.getElementById('drawing-name').value)) await refreshGallery();
});
document.getElementById('drawing-name').addEventListener('keydown', async e => {
  if (e.key === 'Enter' && await saveCurrent(e.target.value)) await refreshGallery();
});

// top-bar quick save (also Ctrl+S)
async function quickSave() {
  const name = currentName || prompt('Name this drawing:');
  if (name == null) return;
  if (await saveCurrent(name)) {
    const btn = document.getElementById('btn-quicksave');
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save'; }, 1200);
  }
}
document.getElementById('btn-quicksave').addEventListener('click', quickSave);

// top-bar Save As (also Ctrl+Shift+S) — always asks for a name, so an open
// drawing can be saved as a copy without overwriting the original
async function saveAs() {
  const name = prompt('Save drawing as:', currentName || '');
  if (name == null) return;
  await saveCurrent(name);
}
document.getElementById('btn-saveas').addEventListener('click', saveAs);

// top-bar New — blank canvas, detached from any saved drawing
function newDrawing() {
  if (pad.elements.length && !confirm('Start a new blank drawing? The current canvas will be cleared (undoable with Ctrl+Z).')) return;
  pad.clear();
  currentName = null;
  updateDocName();
  pad.resetView();
}
document.getElementById('btn-new').addEventListener('click', newDrawing);

// ------------------------------------------------- eraser.io share links
//
// An Eraser share page publicly exposes only its title and a rendered
// preview image (og:image → /workspace/<id>/preview) — there is no public
// API for the editable scene. So "loading" a share link means placing that
// preview on the canvas as an image element. server.js proxies the fetch
// because eraser.io doesn't send CORS headers.

async function importFromEraser() {
  const link = prompt(
    'Paste an Eraser share link:\n' +
    'e.g. https://app.eraser.io/workspace/oFHwvJh8CUIC4cP4w3gz?origin=share'
  );
  if (!link) return;
  if (store !== serverStore) {
    alert('Importing from Eraser needs the local server as a proxy.\n\nRun:  node server.js\nthen open  http://localhost:8123');
    return;
  }

  const btn = document.getElementById('btn-eraser');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await fetch('/api/eraser?url=' + encodeURIComponent(link.trim()));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'import failed');

    // drop it centered in the current view at a sensible world size
    await pad.insertImage(data.dataUrl, { width: 800 });
    if (!currentName && data.title) {
      currentName = cleanName(data.title) || null;
      updateDocName();
    }
  } catch (err) {
    alert('Eraser import failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Eraser link';
  }
}
document.getElementById('btn-eraser').addEventListener('click', importFromEraser);

// ------------------------------------------------------------ image import
//
// Three ways in — the Image button, pasting from the clipboard, or dropping
// a file onto the canvas. The file becomes an image element with its pixels
// embedded as a data URL, so saved drawings stay self-contained.

async function insertImageFile(file, at) {
  if (!file || !file.type.startsWith('image/')) { alert('Not an image file'); return; }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('could not read the file'));
      reader.readAsDataURL(file);
    });
    // fits large images into 640 world px, keeping the aspect ratio
    await pad.insertImage(dataUrl, { at, maxSize: 640 });
  } catch (err) {
    alert('Could not insert image: ' + err.message);
  }
}

document.getElementById('btn-image').addEventListener('click', () =>
  document.getElementById('file-image').click());

document.getElementById('file-image').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) insertImageFile(file);
});

wrap.addEventListener('dragover', e => e.preventDefault());
wrap.addEventListener('drop', e => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) insertImageFile(file, pad.clientToWorld(e.clientX, e.clientY));
});

window.addEventListener('paste', e => {
  if (pad.editing || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const item = [...(e.clipboardData ? e.clipboardData.items : [])]
    .find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); insertImageFile(item.getAsFile()); }
});

// ---------------------------------------------------- import / export JSON

document.getElementById('btn-save').addEventListener('click', () => {
  const name = currentName || 'drawing';
  const blob = new Blob([JSON.stringify(serializeDrawing(name))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('btn-open').addEventListener('click', () =>
  document.getElementById('file-open').click());

document.getElementById('file-open').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await loadDrawingData(data, true);
    currentName = cleanName(data.name) || null;
    updateDocName();
  } catch (err) {
    alert('Could not open file: ' + err.message);
  }
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!pad.elements.length) return;
  if (!confirm('Delete everything?')) return;
  pad.clear();
});

// ------------------------------------------------------------ PNG export
//
// The PNG button opens a small dialog to pick the background: transparent,
// white, black, or a custom color. The choice is remembered in localStorage.

const EXPORT_BG_KEY = 'sketchpad:exportBg';
const exportDialog = document.getElementById('export-dialog');
const exportSwatches = [...document.querySelectorAll('.bg-swatch')];
const exportCustomInput = document.getElementById('export-bg-custom');

function selectExportBg(swatch) {
  exportSwatches.forEach(s => s.classList.toggle('selected', s === swatch));
}

function selectedExportBg() {
  const swatch = exportSwatches.find(s => s.classList.contains('selected'));
  if (!swatch) return '#ffffff';
  if (swatch.classList.contains('bg-custom')) return exportCustomInput.value;
  return swatch.dataset.bg;
}

// restore the last-used background ('transparent', a preset, or custom color)
{
  const saved = localStorage.getItem(EXPORT_BG_KEY);
  const preset = exportSwatches.find(s => s.dataset.bg === saved);
  if (preset) {
    selectExportBg(preset);
  } else if (saved) {
    exportCustomInput.value = saved;
    selectExportBg(exportSwatches.find(s => s.classList.contains('bg-custom')));
  } else {
    selectExportBg(exportSwatches.find(s => s.dataset.bg === '#ffffff'));
  }
}

exportSwatches.forEach(swatch => {
  swatch.addEventListener('click', () => selectExportBg(swatch));
});
exportCustomInput.addEventListener('input', () =>
  selectExportBg(exportSwatches.find(s => s.classList.contains('bg-custom'))));

function closeExportDialog() { exportDialog.classList.add('hidden'); }

document.getElementById('btn-export').addEventListener('click', () => {
  if (!pad.elements.length) { alert('Nothing to export'); return; }
  exportDialog.classList.remove('hidden');
});

document.getElementById('export-close').addEventListener('click', closeExportDialog);
exportDialog.addEventListener('click', e => { if (e.target === exportDialog) closeExportDialog(); });

document.getElementById('export-confirm').addEventListener('click', () => {
  const bg = selectedExportBg();
  localStorage.setItem(EXPORT_BG_KEY, bg);
  closeExportDialog();
  exportPNG(bg);
});

function exportPNG(bg) {
  // cropped to the drawing with a margin, at 2x for crisp output
  const off = pad.exportCanvas({ scale: 2, margin: 40, background: bg });
  off.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drawing.png';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// -------------------------------------------------------- session autosave
//
// Crash/refresh insurance, separate from the named drawings gallery: the
// live scene (plus camera and doc name) is mirrored into localStorage a
// moment after every change and restored on the next load. Best-effort —
// if the scene outgrows the localStorage quota (huge embedded images), the
// session simply isn't kept and explicit saves still work.

const SESSION_KEY = 'sketchpad:session';
let autosaveTimer = null;
let sessionRestored = false; // don't overwrite the stored session before restore

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveSession, 800);
}

function saveSession() {
  clearTimeout(autosaveTimer);
  if (!sessionRestored) return;
  try {
    const elements = pad.elements;
    if (!elements.length) { localStorage.removeItem(SESSION_KEY); return; }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      elements, camera: pad.camera, currentName,
      iconFont: serializeIconFont(),
    }));
  } catch { /* quota exceeded — skip */ }
}

window.addEventListener('beforeunload', saveSession);

async function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const session = JSON.parse(raw);
      await loadDrawingData(session);
      if (session.camera) pad.camera = session.camera;
      currentName = session.currentName || null;
      updateDocName();
    }
  } catch { /* corrupt session or font failure — start fresh */ }
  sessionRestored = true;
}

// ----------------------------------------------------------------- init

// the pad sizes itself to #canvas-wrap and follows it with a ResizeObserver
applyTheme(document.documentElement.dataset.theme); // set by index.html pre-paint
pad.initialize();
updateZoomLabel();
restoreSession();
