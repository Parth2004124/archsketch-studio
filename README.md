# ArchSketch Studio

A zero-dependency, SketchUp-style **3D Architectural CAD Sandbox** built with a custom B-Rep geometry kernel, WebGL2 shadow-mapped renderer, parametric architectural tools, and a live SSE AI-agent bridge.

## Features
- **B-Rep Modeling Kernel (`src/kernel.js`)**: Vertices, edges, faces with holes, automatic coplanar face closing & splitting, **Push/Pull** extrusions and through-cut punching, **Offset**, **Follow Me** profile sweeping, hierarchical **Groups**, **Tags (Layers)**, and 60-step **Undo/Redo**.
- **SketchUp-Style Tools (`src/tools.js`)**: Select (click, double-click connected/enter group, marquee enclosed/crossing), Line (`L`), Rectangle (`R`), Circle (`C`), Polygon (`G`), 2-Point Arc (`A`), Freehand, Push/Pull (`P`), Offset (`F`), Move/Array (`M`), Rotate/Array (`Q`), Scale (`S`), Parametric Wall Chain (`W`), Tape Measure & Guides (`T`), 3D Dimensions (`D`), Text Callouts, Paint Bucket (`B`), Eraser (`E`), Section Planes, Orbit/Pan/Zoom, and Eye-Level Walk Mode (`1.65 m`).
- **VCB Measurements & Inference**: Endpoint/Midpoint/Edge/Face/Grid snapping, arrow-key XYZ axis locking, live numeric dimension entry (`4.5`, `6, 4`, `10'6"`, `24s`), and linear/radial arrays (`x5`, `/5`).
- **Architectural Parametric Generators (`src/arch_tools.js`)**: Parametric Walls, Straight/L/U Staircases with glass guardrails, Gable/Hip/Shed/Parapet Roofs, Doors, Windows, Curtain Walls, Columns, Entourage, plus starter templates including a full **2-Bedroom Apartment 3D** floor plan model.
- **WebGL2 Architectural Renderer (`src/renderer.js`)**: 2048px PCF directional sun shadow maps, Heliodon time/month/latitude solar study, 5 visual styles (*Shaded + Textures*, *Clay Maquette*, *Hidden Line*, *X-Ray*, *Monochrome*), and real-time GLSL section plane clipping with poche fill.
- **Exporters (`src/exporters.js`)**: Save/Load `.archsketch.json`, export 3D `.obj`, `.gltf`, 2D `.svg` plan, and `.png` render snapshots.
- **Live Bridge Server (`server.mjs`)**: Serves the app on port `5173` and provides an SSE `/api/events` + `/api/exec` + `/api/state` bridge for real-time programmatic/AI-assisted modeling.

## Run Locally
Requires **Node.js 18+** (zero `npm install` dependencies required):

```bash
node server.mjs
```

Then open `http://localhost:5173` in your browser.
