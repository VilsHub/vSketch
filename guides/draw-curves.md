# Drawing Connectors & Curves

Connectors are arrows drawn from one element's border to another's. They
snap to borders, stay attached when shapes move, and can be bent into
curves while drawing. Everything below happens in the **select tool** (V) —
no separate connector tool needed.

## Starting a connection

1. Hover the mouse near the **border** of any shape (rectangle, ellipse,
   diamond, triangle, pentagon, hexagon, star, image, text, or icon).
2. A violet **source point** appears on the border under your cursor and
   the cursor becomes a crosshair.
3. Press the mouse button down on it — a connector arrow starts drawing
   from that exact spot.

The connector uses your current style settings: stroke color, stroke
width, and line style (solid / dashed / dotted with its dash spacing), so
you can draw dashed connectors by picking the dashed line style first.

## Ending a connection

There are three ways to finish:

- **On another element** — move toward any other shape's border. A green
  **acceptor point** snaps onto the border nearest your cursor. Release
  the mouse on it and the connector commits, landing exactly on the
  border.
- **Sticky mode** — release the mouse over empty space and the connector
  isn't finished yet: the line keeps following your cursor with no button
  held. From there, *click* a green acceptor point to attach to a shape,
  or…
- **Double-click** — while in sticky mode, double-click anywhere to end
  the connector at that point in mid-air (no attachment).

Press **Escape** at any moment to cancel the connector entirely.

## Joints & curves (Ctrl)

Connector segments are **always straight** — curves appear only at the
joints where two segments meet:

- While drawing, press **Ctrl** to pin a joint at the current mouse
  position. The segment behind the joint freezes straight, and a new
  straight segment continues from the joint to your cursor.
- The joint itself renders as a **rounded curve joining the two straight
  segments** (the corner radius adapts to the segment lengths, up to
  24 px).
- Press Ctrl again anywhere to add more joints — a connector can have as
  many as you like, e.g. to route around other shapes.

The arrowhead always aligns with the final straight segment. Keyboard
shortcuts are suspended while drawing a connector, so pressing Ctrl for
joints never triggers Ctrl+Z or other bindings — only Escape (cancel) is
live.

## Attachment: connectors follow shapes

A connector endpoint that lands on a shape's border is **bound** to that
shape at that spot:

- **Move the shape** → the connector follows.
- **Resize the shape** → the endpoint slides proportionally along the
  border (an anchor at the middle of an edge stays at the middle).
- **Jointed connectors** carry their joints along with their endpoints.
- **Delete the shape** → the connector survives in place, just detached.

Attachments are saved with the drawing and survive reload, undo/redo, and
export/import.

## Editing a connector afterwards

Select the connector and drag one of its round **endpoint handles**:

- Drop the endpoint on any shape's border (the green acceptor point shows
  where) to **attach or re-attach** it there.
- Drop it in empty space to **detach** — the endpoint then stays put when
  the old target moves.

Note that a connector bound at *both* ends can't be dragged as a whole —
its endpoints snap back to their anchors. Move the connected shapes
instead, or detach an end first.

**Duplicating** (Ctrl+D) keeps attachments within the duplicated set:
copy two shapes plus their connector and the copies are wired to each
other, not back to the originals.

## Quick reference

| Action                          | How                                      |
| ------------------------------- | ---------------------------------------- |
| Show source point               | Hover a shape's border (select tool)     |
| Start connector                 | Mouse down on the source point           |
| Attach to a shape               | Release (or click) on the acceptor point |
| Keep drawing after release      | Release over empty space (sticky mode)   |
| End in mid-air                  | Double-click while drawing               |
| Pin a joint (rounded corner)    | Press Ctrl while drawing                 |
| Add more joints                 | Press Ctrl again at each turn            |
| Cancel                          | Escape                                   |
| Re-attach / detach later        | Drag an endpoint handle                  |
