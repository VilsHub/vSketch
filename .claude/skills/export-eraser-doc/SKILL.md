---
name: export-eraser-doc
description: Convert an Eraser document's diagrams into drawing-app's (Sketchpad's) native JSON scene format and save it into drawing-app/drawings/. Requires the eraser MCP server to be connected (signed in via /mcp) first. Invoke as /export-eraser-doc <name of Eraser doc>.
argument-hint: <name of Eraser doc>
---

Convert the Eraser document named `$ARGUMENTS` into a Sketchpad drawing document
saved at `drawing-app/drawings/<kebab-cased-name>.json`, made of native editable
shapes (not a bitmap).

## 1. Precondition: Eraser MCP signed in

Load the needed eraser tool schemas via ToolSearch
(`select:mcp__eraser__get_me,mcp__eraser__search,mcp__eraser__list_files,mcp__eraser__get_file,mcp__eraser__list_diagrams,mcp__eraser__get_diagram`),
then call `get_me`. If the tools are missing or the call fails with an auth
error, STOP and tell the user to connect first by running `/mcp` and
authenticating with eraser. Do not attempt any workaround.

## 2. Resolve the document

- Search by name: `search` with `kind: "file"` and the doc name (submit 2–3
  query variants). If that returns nothing, fall back to `list_files` sorted by
  `-updatedAt` and match the title case-insensitively / fuzzily.
- Exactly one match → proceed. Multiple plausible matches → ask the user which
  one. Zero → list the available file titles and stop.

## 3. Fetch the diagrams

- `get_file` for the outline and diagram list; `get_diagram` for each diagram's
  DSL code (pass `includeFreeformDefinition: true` when `diagramType` is
  `freeform-diagram` to get elements/connections/positions).
- If the file reports **zero diagrams**, stop and explain: content drawn
  directly on the Eraser canvas is not exposed through the API (known
  limitation — selectable in-app does not mean it is a diagram object). Offer
  to rebuild it as a proper Eraser diagram first.
- If the file has several diagrams, convert all of them into one scene spaced
  apart horizontally, unless the user named a specific one.

## 4. Convert to a Sketchpad scene

Write a generator script in the scratchpad directory that requires the scene
builder shipped with this skill:

```js
const { createScene } = require('/home/starlvil/Projects/drawing-app/.claude/skills/export-eraser-doc/scripts/sketchpad-scene.js');
const s = createScene();
// s.group(x,y,w,h,title,{stroke})            container with corner title
// s.box(x,y,w,h,label,{stroke,fill,fontSize}) node rect + centered label ('\n' ok)
// s.shape(type,x,y,w,h,label,{...})           same, for ellipse/diamond/triangle/
//                                             pentagon/hexagon/star
// s.diamond(x,y,w,h,label,{...})              decision-node shorthand
// s.edge(x1,y1,x2,y2,label,{stroke,lx,ly})    arrow + optional label
// s.rect / s.text                             raw elements
// stroked helpers also take {lineStyle:'dashed'|'dotted', dashGap:<px>}
const problems = s.validate();
if (problems.length) throw new Error(problems.join('; '));
console.log('elements:', s.save('<doc name>', '<output path>'));
```

The builder emits the exact element schema `drawing-app/app.js` renders — do
not hand-write element objects, and do not modify the builder to add element
types the app lacks. If `drawing-app/app.js` has changed its schema (check when
something looks off), update `scripts/sketchpad-scene.js` to match first.

Conversion rules — Eraser DSL → scene:

- Parse nodes `Name [icon: ..., label: "..."]`, nested `{ }` groups, and
  connections `A > B: label` (`<` reverses direction, `<>` means draw one arrow
  each way, slightly offset).
- **Layout is yours to plan** — Eraser auto-layouts, so the DSL has no
  coordinates. Lay out in flow direction (the `direction` statement, default
  left-to-right), with groups as containers sized to enclose their children
  plus padding, and 40–60px gaps between sibling nodes. Typical node box:
  w 130–340 depending on label length (~0.52 × fontSize per char), h 40–72.
- Draw order matters (painter's algorithm): groups first, then edges, then node
  boxes (`fill: '#ffffff'` or a pale tint so they cover arrow ends), labels come
  with their helpers.
- Color-code edges by meaning when the source distinguishes flows (data vs
  auth vs notifications, etc.); keep node stroke colors loosely evoking the
  service (AWS orange `#f97316`, Postgres sky `#0ea5e9`, Kafka purple
  `#9333ea`, and neutral ink `#1f2937` elsewhere).
- Dashed/dotted Eraser connections keep their style: pass
  `lineStyle: 'dashed'` (or `'dotted'`) on the edge, tuning `dashGap` if the
  default (8) looks off.

## 5. Save, validate, report

- Output path: `drawing-app/drawings/<kebab-cased doc name>.json` (`mkdir -p`
  the folder). If the file already exists, ask before overwriting.
- Run the generator; `validate()` must return no problems.
- Report: output path, element count, and how to open it — `node server.js` in
  `drawing-app/` then the **Drawings** gallery at http://localhost:8123, or the
  **Open** button without the server. Mention that the gallery thumbnail stays
  blank until the user re-saves once in-app (Ctrl+S), and any fidelity caveats
  (auto-planned layout worth a visual once-over).
