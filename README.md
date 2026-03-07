# RoomPlanz (Offline, SVG, mm-precise)

RoomPlanz is a standalone static, browser-based application for designing precise 2D room layouts with millimetre-accurate measurements. It runs fully offline after initial load, uses no backends, and renders with SVG for deterministic geometry.

Open `index.html` directly in your browser (Chrome, Edge, Firefox latest). No build step needed.

## Features

- mm-precise integer model. Origin at top-left. Object centre-based transforms.
- SVG rendering with crisp borders and handles.
- Zoom (10%–500%) around cursor and panning; view transform only.
- Create rectangles, squares, circles. Selection, drag, resize, rotate, duplicate, delete.
- Real-time clamping to keep objects fully inside room boundaries (including rotated AABB).
- Optional grid overlay (100/250/500/1000 mm) and snapping to grid intersections.
- Properties panel for name, type, dimensions, position, rotation, fill/border, thickness, label toggle.
- Properties panel for name, type, dimensions, position, rotation, fill/border, thickness, label toggle, and label text size (px).
- JSON export/import with schema validation (exact reconstruction).
- JPEG export of current visible canvas at configurable width; optional grid and labels.
- Accessible: keyboard navigable controls for forms; visible focus; pointer and touch interactions supported in canvas.

## How to use

1. Define Room
   - Enter width and height in millimetres (min 500, max 50,000). Canvas resizes immediately. Objects are clamped to remain inside.

2. Create Objects
   - Click Rectangle, Square, or Circle. Newly created objects appear at the room centre.

3. Select & Manipulate
   - Click to select. Drag to move. Use the square handles to resize (edges/corners) or the circular handle to rotate.
   - Use the rotate buttons (↺/↻) above the selected object to rotate left/right by 90°.
   - Rotation input accepts −360 to +360; internally normalized to 0–359.
   - Toggle snapping for 90° rotations and position-to-grid.

4. Zoom & Pan
   - Scroll to zoom around cursor. Drag the background or hold Space and drag to pan. Zoom does not affect stored values.

5. Properties & Styling
   - Edit name, shape type, dimensions, X/Y centre, rotation (deg), fill colour, border colour, border thickness (mm), label visibility, and label text size (px).

6. Export/Import JSON
   - Export JSON to save your layout. Import JSON to restore it. The app validates the schema and measurements.

7. Export JPEG
   - Choose pixel width. Export a JPEG of the current visible canvas, optionally including grid and labels.

## Schema

```
{
  "schemaVersion": "1.0.0",
  "room": { "widthMm": 8000, "heightMm": 6000 },
  "objects": [
    {
      "id": 1,
      "type": "rect|square|circle",
      "name": "...",
      "xMm": 4000, "yMm": 3000,
      "widthMm": 1600, "heightMm": 1000,   // for rect
      "sizeMm": 1000,                        // for square
      "radiusMm": 500,                       // for circle
      "rotationDeg": 0,
      "style": { "fill": "#7ec8e3", "borderColor": "#144663", "borderMm": 10, "showLabel": true }
    }
  ]
}
```

All measurements are integer millimetres. Rotations are stored as integer degrees normalized to 0–359. The `style.labelPx` (integer) controls on-screen label font size in pixels.

## Notes

- This app is designed for rooms up to 50,000 mm per side and aims for sub-16ms interaction updates where feasible. SVG rendering is used for deterministic geometry and precision.
- No network calls, no external APIs, no storage dependency. Runs offline.

## Browser Support

Latest stable Chrome, Edge, Firefox. Open via `file://` is supported.
