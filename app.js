/**
 * Sketchpad — a small eraser.io-style whiteboard.
 *
 * Architecture:
 *  - `elements` is the scene: a flat array of plain JSON objects, one per
 *    shape. Everything (undo, save, export) works off this array.
 *  - `camera` = {x, y, zoom} defines the view. World coordinates are what
 *    elements store; screen coordinates are canvas pixels. All input is
 *    converted screen -> world immediately.
 *  - Rendering is immediate mode: render() redraws the whole scene on any
 *    change. Simple and plenty fast for hundreds of shapes.
 *  - Interaction is a small state machine held in `drag`.
 *  - Undo/redo stores JSON snapshots of `elements`.
 */
'use strict';

// ---------------------------------------------------------------- state

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');

let elements = [];                 // the scene
let selection = new Set();         // ids of selected elements
let tool = 'select';
let camera = { x: 0, y: 0, zoom: 1 };
const style = { stroke: '#1f2937', fill: 'transparent', strokeWidth: 2, fontSize: 28, lineStyle: 'solid', dashGap: 8 };

let iconFont = null;               // { family, dataB64, codepoints[] }
let currentIcon = null;            // codepoint chosen in the icon grid

let history = [];                  // undo stack of JSON snapshots
let future = [];                   // redo stack
let drag = null;                   // active pointer interaction
let editingEl = null;              // text element being edited in overlay
let spaceDown = false;
let nextId = 1;

const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
const HANDLE_SIZE = 8;             // screen px

// ------------------------------------------------------------ geometry

function screenToWorld(sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}
function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}

function normBox(x, y, w, h) {
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
}

// World-space bounding box of any element.
function getBBox(el) {
  switch (el.type) {
    case 'rect': case 'ellipse': case 'diamond': case 'image':
    case 'triangle': case 'pentagon': case 'hexagon': case 'star':
      return normBox(el.x, el.y, el.w, el.h);
    case 'line': case 'arrow': {
      const xs = [el.x, el.x2], ys = [el.y, el.y2];
      for (const [px, py] of el.pts || []) { xs.push(px); ys.push(py); }
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
    case 'pen': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [px, py] of el.points) {
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'text': {
      ctx.save();
      ctx.font = `${el.fontSize}px sans-serif`;
      const lines = el.text.split('\n');
      const w = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
      ctx.restore();
      return { x: el.x, y: el.y, w, h: lines.length * el.fontSize * 1.25 };
    }
    case 'icon': {
      ctx.save();
      ctx.font = `${el.size}px "${el.family}"`;
      const w = Math.max(el.size * 0.5, ctx.measureText(el.char).width);
      ctx.restore();
      return { x: el.x, y: el.y, w, h: el.size };
    }
  }
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitElement(el, x, y) {
  const pad = Math.max(6 / camera.zoom, el.strokeWidth || 0);
  if (el.type === 'line' || el.type === 'arrow') {
    const pts = [[el.x, el.y], ...(el.pts || []), [el.x2, el.y2]];
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= pad) return true;
    }
    return false;
  }
  if (el.type === 'pen') {
    for (let i = 1; i < el.points.length; i++) {
      const [ax, ay] = el.points[i - 1], [bx, by] = el.points[i];
      if (distToSegment(x, y, ax, ay, bx, by) <= pad) return true;
    }
    return false;
  }
  const b = getBBox(el);
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

// Topmost element under the point, or null.
function hitTest(x, y) {
  for (let i = elements.length - 1; i >= 0; i--) {
    if (hitElement(elements[i], x, y)) return elements[i];
  }
  return null;
}

// ------------------------------------------------------------- history

function pushHistory() {
  history.push(JSON.stringify(elements));
  if (history.length > 100) history.shift();
  future = [];
}
function undo() {
  if (!history.length) return;
  future.push(JSON.stringify(elements));
  elements = JSON.parse(history.pop());
  selection.clear();
  render();
}
function redo() {
  if (!future.length) return;
  history.push(JSON.stringify(elements));
  elements = JSON.parse(future.pop());
  selection.clear();
  render();
}

// ------------------------------------------------------------ rendering

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  render();
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);

  drawGrid();

  // enter world space
  ctx.save();
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  for (const el of elements) {
    if (el.id === (editingEl && editingEl.id)) continue; // hidden while editing
    drawElement(ctx, el);
  }
  ctx.restore();

  drawSelectionUI();
  drawConnectUI();
  if (drag && drag.type === 'marquee') drawMarquee();

  // every state change repaints, so this is the one autosave hook needed
  scheduleAutosave();
}

function drawGrid() {
  // dot grid in world space, thinned out as you zoom away
  let step = 24;
  while (step * camera.zoom < 14) step *= 2;
  while (step * camera.zoom > 60) step /= 2;

  const view = screenToWorld(wrap.clientWidth, wrap.clientHeight);
  ctx.fillStyle = '#d4d4d8';
  const startX = Math.floor(camera.x / step) * step;
  const startY = Math.floor(camera.y / step) * step;
  for (let wx = startX; wx <= view.x; wx += step) {
    for (let wy = startY; wy <= view.y; wy += step) {
      const p = worldToScreen(wx, wy);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
  }
}

// Vertices of a box-bounded polygon shape, normalized to fill its bbox.
function polygonPoints(type, b) {
  let pts;
  if (type === 'triangle') {
    pts = [[0.5, 0], [1, 1], [0, 1]];
  } else {
    const n = type === 'pentagon' ? 5 : type === 'hexagon' ? 6 : 10; // star = 10 alternating
    pts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const r = type === 'star' && i % 2 ? 0.45 : 1;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    pts = pts.map(([px, py]) => [(px - minX) / (maxX - minX), (py - minY) / (maxY - minY)]);
  }
  return pts.map(([px, py]) => [b.x + px * b.w, b.y + py * b.h]);
}

// setLineDash pattern for an element's lineStyle / dashGap.
function dashPattern(el) {
  const w = el.strokeWidth || 2, gap = el.dashGap || 8;
  if (el.lineStyle === 'dashed') return [Math.max(6, w * 3), gap];
  if (el.lineStyle === 'dotted') return [0.1, gap + w];
  return [];
}

function drawElement(c, el) {
  c.strokeStyle = el.stroke || '#1f2937';
  c.fillStyle = el.fill || 'transparent';
  c.lineWidth = el.strokeWidth || 2;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.setLineDash(dashPattern(el));

  const hasFill = el.fill && el.fill !== 'transparent';

  switch (el.type) {
    case 'rect': {
      const b = normBox(el.x, el.y, el.w, el.h);
      const r = Math.min(8, b.w / 2, b.h / 2); // rounded corners, eraser-style
      c.beginPath();
      c.roundRect(b.x, b.y, b.w, b.h, r);
      if (hasFill) c.fill();
      c.stroke();
      break;
    }
    case 'ellipse': {
      const b = normBox(el.x, el.y, el.w, el.h);
      c.beginPath();
      c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (hasFill) c.fill();
      c.stroke();
      break;
    }
    case 'diamond': {
      const b = normBox(el.x, el.y, el.w, el.h);
      c.beginPath();
      c.moveTo(b.x + b.w / 2, b.y);
      c.lineTo(b.x + b.w, b.y + b.h / 2);
      c.lineTo(b.x + b.w / 2, b.y + b.h);
      c.lineTo(b.x, b.y + b.h / 2);
      c.closePath();
      if (hasFill) c.fill();
      c.stroke();
      break;
    }
    case 'triangle': case 'pentagon': case 'hexagon': case 'star': {
      const b = normBox(el.x, el.y, el.w, el.h);
      const pts = polygonPoints(el.type, b);
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      if (hasFill) c.fill();
      c.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      // straight segments through the joints; each joint is rounded with
      // an arc so the curve lives only where two segments meet
      const pts = [[el.x, el.y], ...(el.pts || []), [el.x2, el.y2]];
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const [px, py] = pts[i - 1], [jx, jy] = pts[i], [nx, ny] = pts[i + 1];
        const r = Math.min(24, Math.hypot(jx - px, jy - py) / 2, Math.hypot(nx - jx, ny - jy) / 2);
        c.arcTo(jx, jy, nx, ny, r);
      }
      c.lineTo(el.x2, el.y2);
      c.stroke();
      if (el.type === 'arrow') {
        c.setLineDash([]); // head stays solid whatever the shaft style
        // aim the head along the final straight segment
        const from = pts[pts.length - 2];
        const angle = Math.atan2(el.y2 - from[1], el.x2 - from[0]);
        const len = 8 + (el.strokeWidth || 2) * 2;
        c.beginPath();
        for (const side of [-1, 1]) {
          c.moveTo(el.x2, el.y2);
          c.lineTo(
            el.x2 - len * Math.cos(angle + side * 0.45),
            el.y2 - len * Math.sin(angle + side * 0.45)
          );
        }
        c.stroke();
      }
      break;
    }
    case 'pen': {
      const pts = el.points;
      if (pts.length < 2) break;
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      // midpoint quadratic smoothing
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(last[0], last[1]);
      c.stroke();
      break;
    }
    case 'text': {
      c.font = `${el.fontSize}px sans-serif`;
      c.textBaseline = 'top';
      c.fillStyle = el.stroke || '#1f2937';
      el.text.split('\n').forEach((line, i) => {
        c.fillText(line, el.x, el.y + i * el.fontSize * 1.25);
      });
      break;
    }
    case 'icon': {
      c.font = `${el.size}px "${el.family}"`;
      c.textBaseline = 'top';
      c.fillStyle = el.stroke || '#1f2937';
      c.fillText(el.char, el.x, el.y);
      break;
    }
    case 'image': {
      const b = normBox(el.x, el.y, el.w, el.h);
      const img = getImage(el.dataUrl);
      if (img.complete && img.naturalWidth) {
        if (c === ctx && isDarkTheme()) {
          // pre-invert so the dark-theme CSS inversion on #canvas-wrap
          // cancels out and photos keep their real colors on screen
          c.save();
          c.filter = 'invert(100%) hue-rotate(180deg)';
          c.drawImage(img, b.x, b.y, b.w, b.h);
          c.restore();
        } else {
          c.drawImage(img, b.x, b.y, b.w, b.h);
        }
      } else {
        // still decoding — show a placeholder; onload re-renders
        c.fillStyle = '#f3f4f6';
        c.fillRect(b.x, b.y, b.w, b.h);
        c.strokeRect(b.x, b.y, b.w, b.h);
      }
      break;
    }
  }

  c.setLineDash([]); // don't leak the dash into selection UI / next element
}

// Decoded bitmaps for image elements, keyed by their data URL so
// duplicated elements share one bitmap. Loading is async; the onload
// callback repaints once the pixels are ready.
const imageCache = new Map();
function getImage(dataUrl) {
  let img = imageCache.get(dataUrl);
  if (!img) {
    img = new Image();
    img.onload = () => render();
    img.src = dataUrl;
    imageCache.set(dataUrl, img);
  }
  return img;
}

function selectedElements() {
  return elements.filter(el => selection.has(el.id));
}

function isLinear(el) { return el.type === 'line' || el.type === 'arrow'; }

// Corner resize handles for a single selected element (screen space).
function getHandles(el) {
  if (isLinear(el)) {
    const a = worldToScreen(el.x, el.y);
    const b = worldToScreen(el.x2, el.y2);
    return [
      { name: 'start', x: a.x, y: a.y },
      { name: 'end',   x: b.x, y: b.y },
    ];
  }
  const b = getBBox(el);
  const tl = worldToScreen(b.x, b.y);
  const br = worldToScreen(b.x + b.w, b.y + b.h);
  return [
    { name: 'nw', x: tl.x, y: tl.y },
    { name: 'ne', x: br.x, y: tl.y },
    { name: 'sw', x: tl.x, y: br.y },
    { name: 'se', x: br.x, y: br.y },
  ];
}

function drawSelectionUI() {
  const sel = selectedElements();
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (const el of sel) {
    const b = getBBox(el);
    const tl = worldToScreen(b.x, b.y);
    ctx.strokeRect(tl.x - 4, tl.y - 4, b.w * camera.zoom + 8, b.h * camera.zoom + 8);
  }
  ctx.setLineDash([]);

  if (sel.length === 1) {
    ctx.fillStyle = '#ffffff';
    for (const h of getHandles(sel[0])) {
      ctx.beginPath();
      if (isLinear(sel[0])) {
        ctx.arc(h.x, h.y, HANDLE_SIZE / 2 + 1, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else {
        ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      }
    }
  }
}

function drawMarquee() {
  const a = worldToScreen(drag.start.x, drag.start.y);
  const b = worldToScreen(drag.current.x, drag.current.y);
  ctx.fillStyle = 'rgba(79,70,229,0.08)';
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 1;
  const r = normBox(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

// ------------------------------------------------------------ connectors
//
// Hovering near a shape's border (select tool) reveals a source point;
// dragging from it draws an arrow. Near another shape's border the end
// snaps to an acceptor point — release (or click, in sticky mode) there
// to connect. Releasing over nothing keeps the line following the mouse
// ("sticky") until an acceptor is clicked or a double-click ends it in
// place; Escape cancels. Holding Ctrl bends the connector into a curve
// that follows the mouse trail.

const CONNECT_TYPES = new Set([
  'rect', 'ellipse', 'diamond', 'triangle', 'pentagon', 'hexagon', 'star',
  'image', 'text', 'icon',
]);
const ANCHOR_RADIUS = 8; // screen px within which border points appear

let hoverAnchor = null;  // {el, x, y} — border point under the idle cursor

// Nearest point on a bbox perimeter (works from inside and outside).
function nearestBorderPoint(b, px, py) {
  const cx = Math.min(Math.max(px, b.x), b.x + b.w);
  const cy = Math.min(Math.max(py, b.y), b.y + b.h);
  if (cx !== px || cy !== py) return { x: cx, y: cy }; // outside: clamp = border
  const dl = px - b.x, dr = b.x + b.w - px, dt = py - b.y, db = b.y + b.h - py;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: b.x, y: py };
  if (m === dr) return { x: b.x + b.w, y: py };
  if (m === dt) return { x: px, y: b.y };
  return { x: px, y: b.y + b.h };
}

// Topmost connectable element whose border is near p, or null.
function findAnchor(p, excludeEl) {
  const maxD = ANCHOR_RADIUS / camera.zoom;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el === excludeEl || !CONNECT_TYPES.has(el.type)) continue;
    const q = nearestBorderPoint(getBBox(el), p.x, p.y);
    if (Math.hypot(p.x - q.x, p.y - q.y) <= maxD) return { el, x: q.x, y: q.y };
  }
  return null;
}

// A binding pins a connector endpoint to a spot on another element's
// border, stored as that element's id plus the spot in bbox-normalized
// coordinates — so it survives moves and scales sensibly on resize.
function makeBind(target, x, y) {
  const b = getBBox(target);
  return {
    id: target.id,
    tx: b.w ? (x - b.x) / b.w : 0.5,
    ty: b.h ? (y - b.y) / b.h : 0.5,
  };
}

// Re-route every bound connector endpoint from its target's current bbox.
// Bindings whose target is gone are dropped (the connector stays put).
function syncConnectors() {
  const byId = new Map(elements.map(el => [el.id, el]));
  for (const el of elements) {
    if (el.type !== 'line' && el.type !== 'arrow') continue;
    if (!el.startBind && !el.endBind) continue;
    const before = { x: el.x, y: el.y, x2: el.x2, y2: el.y2 };
    for (const [key, px, py] of [['startBind', 'x', 'y'], ['endBind', 'x2', 'y2']]) {
      const bind = el[key];
      if (!bind) continue;
      const target = byId.get(bind.id);
      if (!target || !CONNECT_TYPES.has(target.type)) { delete el[key]; continue; }
      const b = getBBox(target);
      el[px] = b.x + bind.tx * b.w;
      el[py] = b.y + bind.ty * b.h;
    }
    if (el.pts && el.pts.length) { // carry the joints along with the endpoints
      const dx = ((el.x - before.x) + (el.x2 - before.x2)) / 2;
      const dy = ((el.y - before.y) + (el.y2 - before.y2)) / 2;
      for (const pt of el.pts) { pt[0] += dx; pt[1] += dy; }
    }
  }
}

function finishConnect() {
  if (drag.acceptor) drag.el.endBind = makeBind(drag.acceptor.el, drag.acceptor.x, drag.acceptor.y);
  const el = drag.el;
  if (Math.hypot(el.x2 - el.x, el.y2 - el.y) < 4) {
    elements.pop(); // degenerate click — discard
    history.pop();
  } else {
    selection = new Set([el.id]);
  }
  drag = null;
  render();
}

function cancelConnect() {
  elements.pop();
  history.pop();
  drag = null;
  render();
}

function drawConnectUI() {
  const dot = (wx, wy, fill) => {
    const s = worldToScreen(wx, wy);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  if (!drag && hoverAnchor) dot(hoverAnchor.x, hoverAnchor.y, '#4f46e5');
  if (drag && (drag.type === 'connect' || drag.type === 'endpoint') && drag.acceptor) {
    dot(drag.acceptor.x, drag.acceptor.y, '#16a34a');
  }
}

// -------------------------------------------------------- transformation

function moveElement(el, dx, dy) {
  switch (el.type) {
    case 'line': case 'arrow':
      el.x += dx; el.y += dy; el.x2 += dx; el.y2 += dy;
      if (el.pts) for (const pt of el.pts) { pt[0] += dx; pt[1] += dy; }
      break;
    case 'pen':
      for (const p of el.points) { p[0] += dx; p[1] += dy; } break;
    default:
      el.x += dx; el.y += dy;
  }
}

// Map an element (from its snapshot `snap`) from oldBox into newBox.
function transformElement(el, snap, oldBox, newBox) {
  const sx = oldBox.w ? newBox.w / oldBox.w : 1;
  const sy = oldBox.h ? newBox.h / oldBox.h : 1;
  const mapX = x => newBox.x + (x - oldBox.x) * sx;
  const mapY = y => newBox.y + (y - oldBox.y) * sy;

  switch (el.type) {
    case 'rect': case 'ellipse': case 'diamond': case 'image':
    case 'triangle': case 'pentagon': case 'hexagon': case 'star':
      el.x = mapX(snap.x); el.y = mapY(snap.y);
      el.w = snap.w * sx;  el.h = snap.h * sy;
      break;
    case 'line': case 'arrow':
      el.x = mapX(snap.x);   el.y = mapY(snap.y);
      el.x2 = mapX(snap.x2); el.y2 = mapY(snap.y2);
      if (snap.pts) el.pts = snap.pts.map(([px, py]) => [mapX(px), mapY(py)]);
      break;
    case 'pen':
      el.points = snap.points.map(([px, py]) => [mapX(px), mapY(py)]);
      break;
    case 'text':
      el.x = mapX(snap.x); el.y = mapY(snap.y);
      el.fontSize = Math.max(6, snap.fontSize * sy);
      break;
    case 'icon':
      el.x = mapX(snap.x); el.y = mapY(snap.y);
      el.size = Math.max(6, snap.size * sy);
      break;
  }
}

// -------------------------------------------------------------- pointer

canvas.addEventListener('pointerdown', e => {
  if (editingEl) return; // textarea overlay handles its own commit on blur

  // sticky connector: a click on an acceptor commits, elsewhere keep drawing
  if (drag && drag.type === 'connect') {
    if (drag.acceptor && e.button === 0) finishConnect();
    return;
  }

  canvas.setPointerCapture(e.pointerId);
  const p = screenToWorld(e.offsetX, e.offsetY);

  // pan: middle mouse, space+drag, or the hand tool
  if (e.button === 1 || spaceDown || tool === 'pan') {
    drag = { type: 'pan', startScreen: { x: e.offsetX, y: e.offsetY }, startCam: { ...camera } };
    return;
  }
  if (e.button !== 0) return;

  if (tool === 'select') {
    // resize handle on the single selected element?
    const sel = selectedElements();
    if (sel.length === 1) {
      for (const h of getHandles(sel[0])) {
        if (Math.abs(e.offsetX - h.x) <= HANDLE_SIZE && Math.abs(e.offsetY - h.y) <= HANDLE_SIZE) {
          pushHistory();
          drag = {
            type: isLinear(sel[0]) ? 'endpoint' : 'resize',
            el: sel[0], handle: h.name,
            startBox: getBBox(sel[0]),
            snap: JSON.parse(JSON.stringify(sel[0])),
            moved: false, pushed: true,
          };
          return;
        }
      }
    }

    // border source point under the cursor? start drawing a connector
    if (hoverAnchor) {
      pushHistory();
      const a = hoverAnchor;
      const el = {
        id: nextId++, type: 'arrow', x: a.x, y: a.y, x2: p.x, y2: p.y,
        stroke: style.stroke, strokeWidth: style.strokeWidth,
        lineStyle: style.lineStyle, dashGap: style.dashGap,
        startBind: makeBind(a.el, a.x, a.y),
      };
      elements.push(el);
      selection.clear();
      hoverAnchor = null;
      drag = { type: 'connect', el, sourceEl: a.el, cursor: { x: p.x, y: p.y }, acceptor: null, sticky: false };
      render();
      return;
    }

    const hit = hitTest(p.x, p.y);
    if (hit) {
      if (e.shiftKey) {
        selection.has(hit.id) ? selection.delete(hit.id) : selection.add(hit.id);
      } else if (!selection.has(hit.id)) {
        selection = new Set([hit.id]);
      }
      pushHistory();
      drag = {
        type: 'move', start: p, last: p,
        snaps: new Map(selectedElements().map(el => [el.id, JSON.parse(JSON.stringify(el))])),
        moved: false, pushed: true,
      };
    } else {
      if (!e.shiftKey) selection.clear();
      drag = { type: 'marquee', start: p, current: p };
    }
    render();
    return;
  }

  if (tool === 'pen') {
    pushHistory();
    const el = { id: nextId++, type: 'pen', points: [[p.x, p.y]], stroke: style.stroke, strokeWidth: style.strokeWidth, lineStyle: style.lineStyle, dashGap: style.dashGap };
    elements.push(el);
    drag = { type: 'pen', el };
    return;
  }

  if (tool === 'text') {
    // stop the canvas from grabbing focus on mousedown, which would
    // immediately blur (and thus destroy) the textarea we're about to show
    e.preventDefault();
    createTextAt(p);
    return;
  }

  if (tool === 'icon') {
    if (!iconFont || currentIcon == null) return; // panel hint guides the user
    pushHistory();
    const size = Math.max(24, style.fontSize * 1.4);
    elements.push({
      id: nextId++, type: 'icon',
      x: p.x - size / 2, y: p.y - size / 2,
      size, char: String.fromCodePoint(currentIcon),
      family: iconFont.family, stroke: style.stroke,
    });
    render();
    return;
  }

  // shape tools: rect / ellipse / diamond / triangle / pentagon / hexagon / star / line / arrow
  pushHistory();
  let el;
  if (tool === 'line' || tool === 'arrow') {
    el = { id: nextId++, type: tool, x: p.x, y: p.y, x2: p.x, y2: p.y, stroke: style.stroke, strokeWidth: style.strokeWidth, lineStyle: style.lineStyle, dashGap: style.dashGap };
  } else {
    el = { id: nextId++, type: tool, x: p.x, y: p.y, w: 0, h: 0, stroke: style.stroke, fill: style.fill, strokeWidth: style.strokeWidth, lineStyle: style.lineStyle, dashGap: style.dashGap };
  }
  elements.push(el);
  drag = { type: 'create', el, start: p };
});

canvas.addEventListener('pointermove', e => {
  const p = screenToWorld(e.offsetX, e.offsetY);

  // idle in select mode: surface a connection source point near a border
  if (!drag && tool === 'select' && !editingEl && !spaceDown) {
    const a = findAnchor(p, null);
    const changed = !!a !== !!hoverAnchor ||
      (a && hoverAnchor && (a.x !== hoverAnchor.x || a.y !== hoverAnchor.y));
    hoverAnchor = a;
    if (changed) render();
  }

  updateCursor(e);
  if (!drag) return;

  switch (drag.type) {
    case 'connect': {
      drag.cursor = p; // where Ctrl would pin the next joint
      drag.acceptor = findAnchor(p, drag.sourceEl);
      drag.el.x2 = drag.acceptor ? drag.acceptor.x : p.x;
      drag.el.y2 = drag.acceptor ? drag.acceptor.y : p.y;
      break;
    }
    case 'pan':
      camera.x = drag.startCam.x - (e.offsetX - drag.startScreen.x) / camera.zoom;
      camera.y = drag.startCam.y - (e.offsetY - drag.startScreen.y) / camera.zoom;
      break;

    case 'move': {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
      for (const el of selectedElements()) {
        const snap = drag.snaps.get(el.id);
        // reset to snapshot then offset — avoids drift from repeated deltas
        Object.assign(el, JSON.parse(JSON.stringify(snap)));
        moveElement(el, dx, dy);
      }
      syncConnectors();
      break;
    }

    case 'resize': {
      drag.moved = true;
      const b = drag.startBox;
      // anchor is the corner opposite the dragged handle
      const anchor = {
        nw: { x: b.x + b.w, y: b.y + b.h },
        ne: { x: b.x,       y: b.y + b.h },
        sw: { x: b.x + b.w, y: b.y },
        se: { x: b.x,       y: b.y },
      }[drag.handle];
      const newBox = normBox(anchor.x, anchor.y, p.x - anchor.x, p.y - anchor.y);
      if (newBox.w > 1 && newBox.h > 1) {
        transformElement(drag.el, drag.snap, b, newBox);
        syncConnectors();
      }
      break;
    }

    case 'endpoint': {
      drag.moved = true;
      // endpoints snap to borders and re-bind there; elsewhere they detach
      drag.acceptor = findAnchor(p, null);
      const nx = drag.acceptor ? drag.acceptor.x : p.x;
      const ny = drag.acceptor ? drag.acceptor.y : p.y;
      if (drag.handle === 'start') { drag.el.x = nx; drag.el.y = ny; }
      else { drag.el.x2 = nx; drag.el.y2 = ny; }
      break;
    }

    case 'marquee': {
      drag.current = p;
      const box = normBox(drag.start.x, drag.start.y, p.x - drag.start.x, p.y - drag.start.y);
      selection = new Set(elements.filter(el => boxesIntersect(getBBox(el), box)).map(el => el.id));
      break;
    }

    case 'create': {
      const el = drag.el;
      if (isLinear(el)) { el.x2 = p.x; el.y2 = p.y; }
      else { el.w = p.x - drag.start.x; el.h = p.y - drag.start.y; }
      break;
    }

    case 'pen':
      drag.el.points.push([p.x, p.y]);
      break;
  }
  render();
});

canvas.addEventListener('pointerup', () => {
  if (!drag) return;

  if (drag.type === 'connect') {
    if (drag.acceptor) finishConnect();
    else drag.sticky = true; // keep following the mouse until committed
    return;
  }

  if (drag.type === 'endpoint' && drag.moved) {
    const key = drag.handle === 'start' ? 'startBind' : 'endBind';
    if (drag.acceptor) drag.el[key] = makeBind(drag.acceptor.el, drag.acceptor.x, drag.acceptor.y);
    else delete drag.el[key];
  }

  if (drag.type === 'create') {
    const el = drag.el;
    const b = getBBox(el);
    if (b.w < 3 && b.h < 3) {
      // click without drag — discard the degenerate shape
      elements.pop();
      history.pop();
    } else {
      // store normalized (positive w/h) coordinates
      if (!isLinear(el)) Object.assign(el, b);
      selection = new Set([el.id]);
      setTool('select'); // eraser-style: back to select after drawing a shape
    }
  }

  if (drag.type === 'pen' && drag.el.points.length < 2) {
    elements.pop();
    history.pop();
  }

  // drop the no-op history entry from a plain click on an element
  if (drag.pushed && !drag.moved) history.pop();

  drag = null;
  render();
});

canvas.addEventListener('dblclick', e => {
  e.preventDefault();
  if (drag && drag.type === 'connect') { finishConnect(); return; } // end in place
  const p = screenToWorld(e.offsetX, e.offsetY);
  const hit = hitTest(p.x, p.y);
  if (hit && hit.type === 'text') startEditing(hit);
  else if (!hit) createTextAt(p);
});

// zoom toward the cursor so the point under the mouse stays fixed
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  const before = screenToWorld(e.offsetX, e.offsetY);
  camera.zoom = newZoom;
  const after = screenToWorld(e.offsetX, e.offsetY);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  updateZoomLabel();
  render();
}, { passive: false });

function updateCursor(e) {
  if (spaceDown || tool === 'pan' || (drag && drag.type === 'pan')) { canvas.style.cursor = 'grab'; return; }
  if (drag && drag.type === 'connect') { canvas.style.cursor = 'crosshair'; return; }
  if (tool === 'select') {
    if (hoverAnchor) { canvas.style.cursor = 'crosshair'; return; }
    const sel = selectedElements();
    if (sel.length === 1) {
      for (const h of getHandles(sel[0])) {
        if (Math.abs(e.offsetX - h.x) <= HANDLE_SIZE && Math.abs(e.offsetY - h.y) <= HANDLE_SIZE) {
          canvas.style.cursor = isLinear(sel[0]) ? 'move'
            : (h.name === 'nw' || h.name === 'se') ? 'nwse-resize' : 'nesw-resize';
          return;
        }
      }
    }
    const p = screenToWorld(e.offsetX, e.offsetY);
    canvas.style.cursor = hitTest(p.x, p.y) ? 'move' : 'default';
    return;
  }
  canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
}

// -------------------------------------------------------------- text UI

function createTextAt(p) {
  pushHistory();
  const el = {
    id: nextId++, type: 'text',
    x: p.x, y: p.y - style.fontSize / 2,
    text: '', fontSize: style.fontSize, stroke: style.stroke,
  };
  elements.push(el);
  startEditing(el, true);
}

function startEditing(el, isNew = false) {
  editingEl = el;
  selection.clear();
  render();

  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = el.text;
  const pos = worldToScreen(el.x, el.y);
  const fs = el.fontSize * camera.zoom;
  Object.assign(ta.style, {
    left: pos.x + 'px',
    top: pos.y + 'px',
    fontSize: fs + 'px',
    color: el.stroke,
    minWidth: '30px',
  });
  wrap.appendChild(ta);
  // focus after the current pointer event fully settles — focusing
  // synchronously inside pointerdown gets undone by the browser
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  const fit = () => {
    ta.style.width = 'auto';
    ta.style.height = 'auto';
    ta.style.width = Math.max(30, ta.scrollWidth + 4) + 'px';
    ta.style.height = ta.scrollHeight + 'px';
  };
  fit();
  ta.addEventListener('input', fit);

  const commit = () => {
    const newText = ta.value.trimEnd();
    ta.remove();
    editingEl = null;
    if (isNew) {
      // createTextAt() already pushed history; drop it if nothing was typed
      if (newText) el.text = newText;
      else { elements = elements.filter(x => x.id !== el.id); history.pop(); }
    } else if (newText !== el.text) {
      pushHistory(); // snapshot before mutating the existing element
      if (newText) el.text = newText;
      else elements = elements.filter(x => x.id !== el.id);
    }
    setTool('select');
    render();
  };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) ta.blur();
  });
}

// -------------------------------------------------------------- keyboard

window.addEventListener('keydown', e => {
  if (editingEl || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // while drawing a connector: Ctrl pins a joint (segments stay straight,
  // the curve lives at the joint), Escape cancels, everything else is off
  if (drag && drag.type === 'connect') {
    if (e.key === 'Control' && !e.repeat) {
      (drag.el.pts ||= []).push([drag.cursor.x, drag.cursor.y]);
      render();
    }
    if (e.key !== 'Escape') return;
  }

  if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    quickSave();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (!selection.size) return;
    pushHistory();
    const idMap = new Map(); // original id -> copy id
    const copies = selectedElements().map(el => {
      const copy = JSON.parse(JSON.stringify(el));
      copy.id = nextId++;
      idMap.set(el.id, copy.id);
      moveElement(copy, 16, 16);
      return copy;
    });
    // keep bindings within the duplicated set; drop ones pointing outside,
    // so offset copies don't snap back onto the originals
    for (const copy of copies) {
      for (const key of ['startBind', 'endBind']) {
        if (!copy[key]) continue;
        if (idMap.has(copy[key].id)) copy[key].id = idMap.get(copy[key].id);
        else delete copy[key];
      }
    }
    elements.push(...copies);
    selection = new Set(copies.map(c => c.id));
    render();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selection = new Set(elements.map(el => el.id));
    render();
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selection.size) return;
    pushHistory();
    elements = elements.filter(el => !selection.has(el.id));
    selection.clear();
    syncConnectors(); // drop bindings that pointed at deleted elements
    render();
    return;
  }
  if (e.key === 'Escape') {
    if (drag && drag.type === 'connect') { cancelConnect(); return; }
    if (!gallery.classList.contains('hidden')) { closeGallery(); return; }
    if (!exportDialog.classList.contains('hidden')) { closeExportDialog(); return; }
    selection.clear();
    setTool('select');
    render();
    return;
  }

  const shortcuts = {
    v: 'select', h: 'pan', r: 'rect', o: 'ellipse', d: 'diamond',
    '3': 'triangle', '5': 'pentagon', '6': 'hexagon', s: 'star',
    l: 'line', a: 'arrow', p: 'pen', t: 'text',
  };
  const t = shortcuts[e.key.toLowerCase()];
  if (t && !e.ctrlKey && !e.metaKey) setTool(t);
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = tool === 'pan' ? 'grab' : 'default'; }
});

// ------------------------------------------------------------------- UI

function setTool(t) {
  tool = t;
  document.querySelectorAll('#toolbar .tool').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === t));
  updateIconPanel();
  if (hoverAnchor) { hoverAnchor = null; render(); }
}

// The icon panel lives only with the icon tool: hidden otherwise, and it
// shows a load-a-font hint instead of the grid until a font is loaded.
function updateIconPanel() {
  const panel = document.getElementById('icon-panel');
  panel.classList.toggle('hidden', tool !== 'icon');
  if (tool !== 'icon') return;
  const hasFont = !!iconFont;
  document.getElementById('icon-empty').classList.toggle('hidden', hasFont);
  document.getElementById('icon-search').classList.toggle('hidden', !hasFont);
  document.getElementById('icon-grid').classList.toggle('hidden', !hasFont);
}

document.getElementById('icon-load-link').addEventListener('click', () =>
  document.getElementById('file-ttf').click());

document.querySelectorAll('#toolbar .tool').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// style inputs: update defaults and restyle current selection
function applyStyleToSelection(fn) {
  if (!selection.size) return;
  pushHistory();
  selectedElements().forEach(fn);
  render();
}

document.getElementById('prop-stroke').addEventListener('input', e => {
  style.stroke = e.target.value;
  applyStyleToSelection(el => { el.stroke = style.stroke; });
});
document.getElementById('prop-fill-on').addEventListener('change', e => {
  const colorInput = document.getElementById('prop-fill');
  colorInput.disabled = !e.target.checked;
  style.fill = e.target.checked ? colorInput.value : 'transparent';
  applyStyleToSelection(el => { if ('fill' in el) el.fill = style.fill; });
});
document.getElementById('prop-fill').addEventListener('input', e => {
  style.fill = e.target.value;
  applyStyleToSelection(el => { if ('fill' in el) el.fill = style.fill; });
});
document.querySelectorAll('.line-style').forEach(btn => {
  btn.addEventListener('click', () => {
    style.lineStyle = btn.dataset.style;
    document.querySelectorAll('.line-style').forEach(b => b.classList.toggle('active', b === btn));
    applyStyleToSelection(el => { if ('strokeWidth' in el && el.type !== 'text' && el.type !== 'icon') el.lineStyle = style.lineStyle; });
  });
});
document.getElementById('prop-dashgap').addEventListener('input', e => {
  style.dashGap = +e.target.value;
  applyStyleToSelection(el => { if ('lineStyle' in el) el.dashGap = style.dashGap; });
});
document.getElementById('prop-width').addEventListener('input', e => {
  style.strokeWidth = +e.target.value;
  applyStyleToSelection(el => { if ('strokeWidth' in el) el.strokeWidth = style.strokeWidth; });
});
document.getElementById('prop-fontsize').addEventListener('input', e => {
  style.fontSize = +e.target.value;
  applyStyleToSelection(el => {
    if (el.type === 'text') el.fontSize = style.fontSize;
    if (el.type === 'icon') el.size = style.fontSize * 1.4;
  });
});

// zoom bar
function updateZoomLabel() {
  document.getElementById('zoom-reset').textContent = Math.round(camera.zoom * 100) + '%';
}
function zoomBy(factor) {
  const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2;
  const before = screenToWorld(cx, cy);
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  const after = screenToWorld(cx, cy);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  updateZoomLabel();
  render();
}
document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.2));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
document.getElementById('zoom-reset').addEventListener('click', () => {
  camera = { x: 0, y: 0, zoom: 1 };
  updateZoomLabel();
  render();
});

// ----------------------------------------------------------------- theme
//
// The UI is themed with CSS variables; the drawing surface is themed by a
// CSS invert filter on #canvas-wrap (see style.css), so elements keep their
// stored colors. index.html sets data-theme before first paint; here we
// only toggle it. PNG export and thumbnails always render light.

const THEME_KEY = 'sketchpad:theme';

function isDarkTheme() { return document.documentElement.dataset.theme === 'dark'; }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  render(); // image elements are counter-inverted per theme
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
    setTool('icon');
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
  document.documentElement.style.setProperty('--icon-font', `"${family}"`);
  buildIconGrid();
  render(); // re-render in case existing icons used a previous font
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
      grid.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setTool('icon');
    });
    grid.appendChild(btn);
  }
}

document.getElementById('icon-search').addEventListener('input', e =>
  buildIconGrid(e.target.value.trim()));

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
    elements,
    // embed the icon font so the drawing is self-contained
    iconFont: serializeIconFont(),
  };
}

// Small JPEG preview of the whole scene, used by the gallery list.
function makeThumbnail(maxW = 320, maxH = 200) {
  if (!elements.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const b = getBBox(el);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const margin = 16;
  const w = maxX - minX + margin * 2, h = maxY - minY + margin * 2;
  const scale = Math.min(maxW / w, maxH / h, 1);

  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(w * scale));
  off.height = Math.max(1, Math.round(h * scale));
  const octx = off.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, off.width, off.height);
  octx.scale(scale, scale);
  octx.translate(margin - minX, margin - minY);
  for (const el of elements) drawElement(octx, el);
  return off.toDataURL('image/jpeg', 0.75);
}

// Restore a drawing document into the editor (shared by gallery + import).
async function loadDrawingData(data) {
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
    document.documentElement.style.setProperty('--icon-font', `"${data.iconFont.family}"`);
    buildIconGrid();
  }
  elements = data.elements || [];
  nextId = Math.max(0, ...elements.map(el => el.id)) + 1;
  selection.clear();
  render();
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
  if (!elements.length) { alert('Nothing to save yet'); return false; }
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
        pushHistory();
        await loadDrawingData(data);
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

    const img = await loadImage(data.dataUrl);
    pushHistory();
    // drop it centered in the current view at a sensible world size
    const w = 800;
    const h = w * img.naturalHeight / img.naturalWidth;
    const center = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
    const el = {
      id: nextId++, type: 'image',
      x: center.x - w / 2, y: center.y - h / 2, w, h,
      dataUrl: data.dataUrl,
    };
    elements.push(el);
    selection = new Set([el.id]);
    setTool('select');
    if (!currentName && data.title) {
      currentName = cleanName(data.title) || null;
      updateDocName();
    }
    render();
  } catch (err) {
    alert('Eraser import failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Eraser link';
  }
}
document.getElementById('btn-eraser').addEventListener('click', importFromEraser);

// Resolve once an image element's bitmap is decoded and drawable.
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = getImage(dataUrl);
    if (img.complete && img.naturalWidth) return resolve(img);
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => reject(new Error('could not decode the preview image')), { once: true });
  });
}

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
    const img = await loadImage(dataUrl);
    pushHistory();
    // fit large images into a sensible world size; keep aspect ratio
    const scale = Math.min(1, 640 / img.naturalWidth, 640 / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const center = at || screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
    const el = {
      id: nextId++, type: 'image',
      x: center.x - w / 2, y: center.y - h / 2, w, h,
      dataUrl,
    };
    elements.push(el);
    selection = new Set([el.id]);
    setTool('select');
    render();
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

canvas.addEventListener('dragover', e => e.preventDefault());
canvas.addEventListener('drop', e => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) insertImageFile(file, screenToWorld(e.offsetX, e.offsetY));
});

window.addEventListener('paste', e => {
  if (editingEl || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
    pushHistory();
    await loadDrawingData(data);
    currentName = cleanName(data.name) || null;
    updateDocName();
  } catch (err) {
    alert('Could not open file: ' + err.message);
  }
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!elements.length) return;
  if (!confirm('Delete everything?')) return;
  pushHistory();
  elements = [];
  selection.clear();
  render();
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
  if (!elements.length) { alert('Nothing to export'); return; }
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
  // union of all element bounding boxes, with a margin
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const b = getBBox(el);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const margin = 40, scale = 2;
  const w = (maxX - minX + margin * 2) * scale;
  const h = (maxY - minY + margin * 2) * scale;

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  if (bg !== 'transparent') {
    octx.fillStyle = bg;
    octx.fillRect(0, 0, w, h);
  }
  octx.scale(scale, scale);
  octx.translate(margin - minX, margin - minY);
  for (const el of elements) drawElement(octx, el);

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
    if (!elements.length) { localStorage.removeItem(SESSION_KEY); return; }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      elements, camera, currentName,
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
      if (session.camera) camera = session.camera;
      currentName = session.currentName || null;
      updateDocName();
      updateZoomLabel();
      render();
    }
  } catch { /* corrupt session or font failure — start fresh */ }
  sessionRestored = true;
}

// ----------------------------------------------------------------- init

window.addEventListener('resize', resizeCanvas);
applyTheme(document.documentElement.dataset.theme); // set by index.html pre-paint
resizeCanvas();
updateZoomLabel();
restoreSession();
