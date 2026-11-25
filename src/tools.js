import {
  clamp,
  v3,
  add3,
  sub3,
  scale3,
  dot3,
  cross3,
  len3,
  dist3,
  norm3,
  mat4Identity,
  mat4Translation,
  mat4Scale,
  mat4RotationAxis,
  mat4Mul,
  mat4TransformPoint,
  mat4Invert,
  rayPlane,
  rayLineClosest,
  raySegmentClosest,
  basisFromNormal,
  projectToPlane2D,
  offsetPolygon2D,
  formatLength,
  parseLengthInput,
} from './math.js';
import { nextId } from './kernel.js';
import {
  buildWallChain,
  buildStaircaseGroup,
  buildRoofGroup,
  buildDoorComponent,
  buildWindowComponent,
  buildColumnComponent,
  buildScalePersonGroup,
  buildTreeGroup,
  buildFurnitureGroup,
} from './arch_tools.js';

export const TOOL_HINTS = {
  select: 'Select: Click face/edge/group (Shift=multi, Double-click=connected/enter group, Drag=box select).',
  line: 'Line (L): Click start & end points. Arrow keys lock X/Y/Z axis. Type length + Enter.',
  rect: 'Rectangle (R): Click opposite corners. Type "W, L" (e.g. 6, 4) + Enter for exact dimensions.',
  circle: 'Circle (C): Click center, then radius. Type radius or "24s" + Enter for segments.',
  polygon: 'Polygon (G): Click center, then radius. Type radius or "6s" + Enter for sides.',
  arc: '2-Point Arc (A): Click start, click end, then drag bulge height.',
  freehand: 'Freehand: Click and drag to sketch continuous architectural contours.',
  pushpull: 'Push/Pull (P): Drag any face to extrude or punch openings. Double-click to repeat. Type distance + Enter.',
  offset: 'Offset (F): Drag face perimeter inward/outward (e.g. 0.25m for walls). Type distance + Enter.',
  move: 'Move (M): Click origin & destination. Press Alt (or Copy button) to duplicate; type "x5" or "/5" for arrays.',
  rotate: 'Rotate (Q): Click pivot, reference arm, and angle. Press Alt to copy; type angle or "x6" for radial array.',
  scale: 'Scale (S): Click anchor and drag to scale selection, or type scale factor + Enter.',
  followme: 'Follow Me: Click a profile face, then click path points (double-click to sweep).',
  wall: 'Parametric Wall (W): Click points for continuous mitered walls. Type length + Enter; Right-click/Esc to finish.',
  tape: 'Tape Measure (T): Click two points to measure & place a dashed construction guide.',
  dimension: 'Dimension (D): Click two points, then drag offset to place architectural dimension callout.',
  text: 'Text Callout: Click anchor point on model, then place leader text label.',
  paint: 'Paint Bucket (B): Click face or group to apply active material.',
  eraser: 'Eraser (E): Click or drag over edges, guides, dimensions, or groups to erase.',
  section: 'Section Plane: Click a face or ground to place an active section cut.',
  place_component: 'Component Placer: Click anywhere in scene to place selected architectural component.',
  orbit: 'Orbit (O): Drag to orbit 3D view. (Tip: Middle-mouse drag always orbits!)',
  pan: 'Pan (H): Drag to pan camera. (Tip: Shift + Middle-mouse always pans!)',
  zoom: 'Zoom (Z): Drag up/down to zoom.',
};

export class ToolManager {
  constructor(doc, renderer, uiCallbacks = {}) {
    this.doc = doc;
    this.renderer = renderer;
    this.ui = uiCallbacks;

    this.activeTool = 'select';
    this.state = 'idle'; // 'idle' | 'active' | 'dragging'
    this.axisLock = null; // null | 'x' | 'y' | 'z'

    // Snap & tool options
    this.gridSnap = false;
    this.gridStep = 0.25;
    this.angleSnap = true;
    this.copyMode = false;

    this.wallOpts = { thickness: 0.22, height: 3.0, alignment: 'center' };
    this.circleSides = 24;
    this.polygonSides = 6;
    this.placeConfig = { kind: 'door', variant: 'single' };

    this.lastPushPullDist = 3.0;
    this.lastOffsetDist = -0.25;
    this.lastAction = null; // for post-commit VCB refinement (like SketchUp!)

    // Active drag/draw state
    this.pts = [];
    this.workPlane = { origin: v3(0, 0, 0), normal: v3(0, 0, 1) };
    this.activeFaceId = null;
    this.activeFaceCenter = null;
    this.activeFaceNormal = null;
    this.startScreen = null;
    this.lastScreen = null;
    this.currentSnap = null;
    this.navButton = null; // 'orbit' | 'pan'
    this.walkKeys = new Set();

    this.bindEvents();
  }

  setTool(toolName) {
    this.cancelCurrent();
    this.activeTool = toolName;
    this.renderer.glCanvas.style.cursor =
      toolName === 'orbit' ? 'grab' :
      toolName === 'pan' ? 'move' :
      toolName === 'zoom' ? 'ns-resize' :
      toolName === 'select' ? 'default' : 'crosshair';
    if (this.ui.onToolChange) this.ui.onToolChange(toolName);
    if (this.ui.onStatus) this.ui.onStatus(TOOL_HINTS[toolName] || '');
  }

  cancelCurrent() {
    this.state = 'idle';
    this.pts = [];
    this.axisLock = null;
    this.activeFaceId = null;
    this.renderer.overlayState.axisLock = null;
    this.renderer.overlayState.previewLines = [];
    this.renderer.overlayState.previewPolys = [];
    this.renderer.overlayState.marquee = null;
    this.renderer.overlayState.cursorLabel = null;
    this.renderer.overlayState.inferenceLine = null;
  }

  // ---- Inference & Snapping Engine ----
  computeSnap(sx, sy, anchorPoint = null) {
    const { ro, rd } = this.renderer.screenToRay(sx, sy);
    const activeCtx = this.doc.activeContext;
    const worldMat = this.doc.getActiveWorldMatrix();

    let bestPt = null;
    let bestType = null;
    let bestScreenDist = 14; // pixel threshold for vertex/edge snaps

    const rect = this.renderer.glCanvas.getBoundingClientRect();
    const lx = sx - rect.left;
    const ly = sy - rect.top;

    // 1. Snap to Vertices (Endpoint) & Edge Midpoints in active context + group vertices
    const checkVertsAndEdges = (ctxId, mat) => {
      const ctx = this.doc.contexts.get(ctxId);
      if (!ctx) return;
      for (const v of ctx.vertices.values()) {
        const wp = mat4TransformPoint(mat, v);
        const sp = this.renderer.worldToScreen(wp);
        if (!sp) continue;
        const d = Math.hypot(lx - sp.x, ly - sp.y);
        if (d < bestScreenDist) {
          bestScreenDist = d;
          bestPt = wp;
          bestType = 'endpoint';
        }
      }
      for (const e of ctx.edges.values()) {
        if (!this.doc.isLayerVisible(e.layerId) || e.hidden) continue;
        const a = mat4TransformPoint(mat, ctx.vertices.get(e.v1));
        const b = mat4TransformPoint(mat, ctx.vertices.get(e.v2));
        const mid = scale3(add3(a, b), 0.5);
        const sm = this.renderer.worldToScreen(mid);
        if (sm) {
          const dm = Math.hypot(lx - sm.x, ly - sm.y);
          if (dm < bestScreenDist) {
            bestScreenDist = dm;
            bestPt = mid;
            bestType = 'midpoint';
          }
        }
      }
      for (const g of ctx.groups.values()) {
        if (g.hidden || !this.doc.isLayerVisible(g.layerId)) continue;
        checkVertsAndEdges(g.contextId, mat4Mul(mat, new Float32Array(g.matrix)));
      }
    };
    checkVertsAndEdges(this.doc.rootContextId, mat4Identity());

    // 2. If no vertex/midpoint hit, check scene faces/edges
    let hitNormal = v3(0, 0, 1);
    if (!bestPt) {
      const pick = this.renderer.pickScene(sx, sy);
      if (pick) {
        bestPt = pick.point;
        bestType = pick.type === 'edge' ? 'edge' : 'face';
        hitNormal = pick.normal || v3(0, 0, 1);
      }
    }

    // 3. Fallback: intersect active workplane or ground plane Z = 0
    if (!bestPt) {
      const wpHit = rayPlane(ro, rd, this.workPlane.origin, this.workPlane.normal);
      const groundHit = rayPlane(ro, rd, v3(0, 0, 0), v3(0, 0, 1));
      const hit = wpHit || groundHit;
      if (hit) {
        bestPt = hit.point;
        bestType = 'ground';
      } else {
        bestPt = add3(ro, scale3(rd, 15));
        bestType = 'free';
      }
    }

    // 4. Axis Lock or Auto-Axis Inference from anchorPoint!
    let infLine = null;
    if (anchorPoint) {
      const axes = [
        { key: 'x', dir: v3(1, 0, 0), color: '#dc2626', type: 'axis_x' },
        { key: 'y', dir: v3(0, 1, 0), color: '#16a34a', type: 'axis_y' },
        { key: 'z', dir: v3(0, 0, 1), color: '#2563eb', type: 'axis_z' },
      ];

      let chosenAxis = this.axisLock ? axes.find((a) => a.key === this.axisLock) : null;

      if (!chosenAxis && bestType !== 'endpoint' && bestType !== 'midpoint') {
        // Auto-infer axis if cursor ray or point aligns closely with X, Y, or Z from anchorPoint
        let bestAxisDist = Infinity;
        for (const ax of axes) {
          const cl = rayLineClosest(ro, rd, anchorPoint, ax.dir);
          if (!cl) continue;
          const spAnchor = this.renderer.worldToScreen(anchorPoint);
          const spLine = this.renderer.worldToScreen(cl.pointOnLine);
          if (spAnchor && spLine) {
            const p1 = this.renderer.worldToScreen(add3(ro, scale3(rd, cl.rayT)));
            const pxDist = p1 ? Math.hypot(p1.x - spLine.x, p1.y - spLine.y) : 999;
            if (pxDist < 12 && pxDist < bestAxisDist) {
              bestAxisDist = pxDist;
              chosenAxis = ax;
            }
          }
        }
      }

      if (chosenAxis) {
        const cl = rayLineClosest(ro, rd, anchorPoint, chosenAxis.dir);
        if (cl) {
          let snappedT = cl.lineT;
          if (this.gridSnap) {
            snappedT = Math.round(snappedT / this.gridStep) * this.gridStep;
          }
          bestPt = add3(anchorPoint, scale3(chosenAxis.dir, snappedT));
          bestType = chosenAxis.type;
          infLine = { p1: anchorPoint, p2: bestPt, color: chosenAxis.color };
        }
      }
    }

    // 5. Optional Grid Snap
    if (this.gridSnap && bestType !== 'endpoint' && bestType !== 'midpoint' && !this.axisLock) {
      bestPt = {
        x: Math.round(bestPt.x / this.gridStep) * this.gridStep,
        y: Math.round(bestPt.y / this.gridStep) * this.gridStep,
        z: Math.round(bestPt.z / this.gridStep) * this.gridStep,
      };
      bestType = 'grid';
    }

    // Convert world snap point into active context local space when needed
    const invWorld = mat4Invert(worldMat);
    const localPt = mat4TransformPoint(invWorld, bestPt);

    return {
      worldPt: bestPt,
      localPt,
      type: bestType,
      normal: hitNormal,
      inferenceLine: infLine,
    };
  }

  // ---- VCB (Measurements Box) Direct Numeric Execution ----
  applyVCB(rawStr) {
    const str = rawStr.trim();
    if (!str) return false;
    const unit = this.doc.unit;
    const ctx = this.doc.activeContext;

    // Segments syntax e.g. "24s" or "8s"
    const segMatch = str.match(/^(\d+)\s*s$/i);
    if (segMatch) {
      const n = clamp(parseInt(segMatch[1], 10), 3, 64);
      if (this.activeTool === 'circle') this.circleSides = n;
      else if (this.activeTool === 'polygon') this.polygonSides = n;
      if (this.ui.onToolOptionsChange) this.ui.onToolOptionsChange();
      return true;
    }

    // Array multiplier/divider e.g. "x5" or "*5" or "/5" right after move/rotate copy!
    const arrMatch = str.match(/^([x*\/])\s*(\d+)$/i);
    if (arrMatch && this.lastAction && (this.lastAction.type === 'move' || this.lastAction.type === 'rotate')) {
      const op = arrMatch[1].toLowerCase();
      const count = clamp(parseInt(arrMatch[2], 10), 2, 40);
      this.doc.pushUndo('Array');
      if (this.lastAction.type === 'move') {
        const totalDelta = this.lastAction.delta;
        const step = op === '/' ? scale3(totalDelta, 1 / count) : totalDelta;
        const copies = op === '/' ? count - 1 : count - 1;
        // Restore selection to base items and clone copies
        for (let i = 1; i <= copies; i++) {
          const d = scale3(step, i);
          if (op === '/' && i === copies) continue; // endpoint already placed
          this.doc.transformSelection(mat4Translation(d.x, d.y, d.z), true);
        }
      } else if (this.lastAction.type === 'rotate') {
        const { pivot, axis, angle } = this.lastAction;
        const stepAng = op === '/' ? angle / count : angle;
        const copies = count - 1;
        for (let i = 1; i <= copies; i++) {
          if (op === '/' && i === copies) continue;
          const a = stepAng * i;
          const m = mat4Mul(
            mat4Translation(pivot.x, pivot.y, pivot.z),
            mat4Mul(mat4RotationAxis(axis, a), mat4Translation(-pivot.x, -pivot.y, -pivot.z))
          );
          this.doc.transformSelection(m, true);
        }
      }
      return true;
    }

    // 2D Dimensions: "W, L" for Rectangle
    if (str.includes(',')) {
      const parts = str.split(',').map((p) => parseLengthInput(p, unit));
      if (parts.length >= 2 && parts[0] !== null && parts[1] !== null) {
        if (this.activeTool === 'rect' && this.state === 'active' && this.pts.length >= 1) {
          const p0 = this.pts[0];
          const { u, v, n } = basisFromNormal(this.workPlane.normal);
          const p1 = add3(p0, scale3(u, parts[0]));
          const p2 = add3(p1, scale3(v, parts[1]));
          const p3 = add3(p0, scale3(v, parts[1]));
          this.doc.pushUndo('Rectangle');
          this.doc.addPolygonFace(ctx, [p0, p1, p2, p3], { preferredNormal: n });
          this.doc.notify('draw');
          this.cancelCurrent();
          return true;
        }
      }
    }

    // Single numeric value
    const val = parseLengthInput(str, unit);
    const numOnly = parseFloat(str);

    if (val !== null) {
      if ((this.activeTool === 'line' || this.activeTool === 'wall') && this.state === 'active' && this.pts.length >= 1) {
        const p0 = this.pts[this.pts.length - 1];
        const dirVec = this.currentSnap ? sub3(this.currentSnap.localPt, p0) : v3(1, 0, 0);
        const dir = len3(dirVec) > 1e-5 ? norm3(dirVec) : v3(1, 0, 0);
        const p1 = add3(p0, scale3(dir, val));
        if (this.activeTool === 'line') {
          this.doc.pushUndo('Line');
          this.doc.addLine(ctx, p0, p1);
          this.doc.notify('draw');
          this.pts.push(p1);
        } else {
          this.pts.push(p1);
        }
        return true;
      }

      if ((this.activeTool === 'circle' || this.activeTool === 'polygon') && this.state === 'active' && this.pts.length >= 1) {
        const center = this.pts[0];
        const sides = this.activeTool === 'circle' ? this.circleSides : this.polygonSides;
        const { u, v, n } = basisFromNormal(this.workPlane.normal);
        const poly = [];
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          poly.push(add3(center, add3(scale3(u, Math.cos(a) * val), scale3(v, Math.sin(a) * val))));
        }
        this.doc.pushUndo(this.activeTool);
        this.doc.addPolygonFace(ctx, poly, { preferredNormal: n });
        this.doc.notify('draw');
        this.cancelCurrent();
        return true;
      }

      if (this.activeTool === 'pushpull' && this.activeFaceId) {
        // Undo preview or push directly if not yet pushed
        this.doc.pushUndo('Push/Pull');
        const res = this.doc.pushPullFace(ctx, this.activeFaceId, val);
        this.lastPushPullDist = val;
        this.cancelCurrent();
        return !!res;
      }

      if (this.activeTool === 'offset' && this.activeFaceId) {
        this.doc.pushUndo('Offset');
        const res = this.doc.offsetFace(ctx, this.activeFaceId, -Math.abs(val));
        this.lastOffsetDist = -Math.abs(val);
        this.cancelCurrent();
        return !!res;
      }

      if (this.activeTool === 'move' && this.state === 'active' && this.pts.length >= 1) {
        const dirVec = this.currentSnap ? sub3(this.currentSnap.localPt, this.pts[0]) : v3(1, 0, 0);
        const dir = len3(dirVec) > 1e-5 ? norm3(dirVec) : v3(1, 0, 0);
        const delta = scale3(dir, val);
        this.doc.pushUndo('Move');
        this.doc.transformSelection(mat4Translation(delta.x, delta.y, delta.z), this.copyMode);
        this.lastAction = { type: 'move', delta };
        this.cancelCurrent();
        return true;
      }
    }

    if (!isNaN(numOnly)) {
      if (this.activeTool === 'rotate' && this.state === 'active' && this.pts.length >= 2) {
        const rad = (numOnly * Math.PI) / 180;
        const pivot = this.pts[0];
        const axis = this.workPlane.normal || v3(0, 0, 1);
        const m = mat4Mul(
          mat4Translation(pivot.x, pivot.y, pivot.z),
          mat4Mul(mat4RotationAxis(axis, rad), mat4Translation(-pivot.x, -pivot.y, -pivot.z))
        );
        this.doc.pushUndo('Rotate');
        this.doc.transformSelection(m, this.copyMode);
        this.lastAction = { type: 'rotate', pivot, axis, angle: rad };
        this.cancelCurrent();
        return true;
      }
      if (this.activeTool === 'scale' && this.state === 'active' && this.pts.length >= 1) {
        const pivot = this.pts[0];
        const s = clamp(numOnly, 0.01, 100);
        const m = mat4Mul(
          mat4Translation(pivot.x, pivot.y, pivot.z),
          mat4Mul(mat4Scale(s, s, s), mat4Translation(-pivot.x, -pivot.y, -pivot.z))
        );
        this.doc.pushUndo('Scale');
        this.doc.transformSelection(m, false);
        this.cancelCurrent();
        return true;
      }
    }

    return false;
  }

  // ---- Pointer Events ----
  bindEvents() {
    const canvas = this.renderer.hudCanvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      const sx = e.clientX, sy = e.clientY;
      this.startScreen = { x: sx, y: sy };
      this.lastScreen = { x: sx, y: sy };

      // Middle mouse button ALWAYS orbits / Shift+Middle ALWAYS pans!
      if (e.button === 1 || (e.button === 0 && (this.activeTool === 'orbit' || this.activeTool === 'pan' || this.activeTool === 'zoom'))) {
        if (e.button === 1 && e.shiftKey) this.navButton = 'pan';
        else if (this.activeTool === 'pan') this.navButton = 'pan';
        else if (this.activeTool === 'zoom') this.navButton = 'zoom';
        else this.navButton = 'orbit';
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (e.button === 2) {
        // Right click finishes wall/line/followme chain or cancels tool
        if (this.activeTool === 'wall' && this.state === 'active' && this.pts.length >= 2) {
          this.commitWallChain(false);
        } else {
          this.cancelCurrent();
        }
        return;
      }

      if (e.button !== 0) return;
      if (this.renderer.camera.walkMode) {
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      this.handlePrimaryDown(e);
    });

    canvas.addEventListener('pointermove', (e) => {
      const sx = e.clientX, sy = e.clientY;
      if (this.navButton) {
        const dx = sx - this.lastScreen.x;
        const dy = sy - this.lastScreen.y;
        this.lastScreen = { x: sx, y: sy };
        this.handleCameraDrag(dx, dy);
        return;
      }

      if (this.renderer.camera.walkMode && e.buttons === 1) {
        const dx = sx - this.lastScreen.x;
        const dy = sy - this.lastScreen.y;
        this.lastScreen = { x: sx, y: sy };
        this.renderer.camera.yaw -= dx * 0.004;
        this.renderer.camera.pitch = clamp(this.renderer.camera.pitch - dy * 0.004, -1.4, 1.4);
        return;
      }

      this.handlePointerMove(e);
      this.lastScreen = { x: sx, y: sy };
    });

    canvas.addEventListener('pointerup', (e) => {
      if (this.navButton) {
        this.navButton = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        return;
      }
      if (this.renderer.camera.walkMode) {
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        return;
      }
      if (e.button === 0) {
        this.handlePrimaryUp(e);
      }
    });

    canvas.addEventListener('dblclick', (e) => {
      this.handleDoubleClick(e);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0012);
      if (this.renderer.camera.walkMode) {
        const forward = {
          x: Math.cos(this.renderer.camera.yaw),
          y: Math.sin(this.renderer.camera.yaw),
          z: 0,
        };
        this.renderer.camera.eyePos = add3(this.renderer.camera.eyePos, scale3(forward, -e.deltaY * 0.01));
      } else {
        this.renderer.camera.distance = clamp(this.renderer.camera.distance * factor, 1.2, 220);
        this.renderer.camera.orthoSize = clamp(this.renderer.camera.orthoSize * factor, 1.2, 220);
      }
    }, { passive: false });
  }

  handleCameraDrag(dx, dy) {
    const cam = this.renderer.camera;
    if (this.navButton === 'orbit') {
      cam.azimuth -= dx * 0.007;
      cam.elevation = clamp(cam.elevation + dy * 0.007, -1.52, 1.52);
    } else if (this.navButton === 'pan') {
      const { eye, target } = this.renderer.getCameraMatrices();
      const forward = norm3(sub3(target, eye));
      const right = norm3(cross3(forward, { x: 0, y: 0, z: 1 }));
      const up = norm3(cross3(right, forward));
      const panScale = (cam.ortho ? cam.orthoSize : cam.distance) * 0.0014;
      cam.target = add3(cam.target, add3(scale3(right, -dx * panScale), scale3(up, dy * panScale)));
    } else if (this.navButton === 'zoom') {
      const factor = Math.exp(dy * 0.006);
      cam.distance = clamp(cam.distance * factor, 1.2, 220);
      cam.orthoSize = clamp(cam.orthoSize * factor, 1.2, 220);
    }
  }

  handlePrimaryDown(e) {
    const sx = e.clientX, sy = e.clientY;
    const anchor = this.pts.length ? this.pts[this.pts.length - 1] : null;
    const snap = this.computeSnap(sx, sy, anchor);
    this.currentSnap = snap;
    const ctx = this.doc.activeContext;

    if (this.activeTool === 'select') {
      this.state = 'dragging';
      const rect = this.renderer.glCanvas.getBoundingClientRect();
      this.marqueeStart = { x: sx - rect.left, y: sy - rect.top };
      return;
    }

    if (this.activeTool === 'paint') {
      const pick = this.renderer.pickScene(sx, sy);
      if (pick) {
        this.doc.pushUndo('Paint Material');
        if (pick.type === 'group') {
          const grp = ctx.groups.get(pick.id);
          if (grp) {
            const subCtx = this.doc.contexts.get(grp.contextId);
            if (subCtx) for (const f of subCtx.faces.values()) f.materialId = this.doc.activeMaterialId;
          }
        } else if (pick.type === 'face') {
          const f = ctx.faces.get(pick.id);
          if (f) {
            if (e.shiftKey) {
              // Paint all faces with same material
              const oldMat = f.materialId;
              for (const oface of ctx.faces.values()) {
                if (oface.materialId === oldMat) oface.materialId = this.doc.activeMaterialId;
              }
            } else {
              f.materialId = this.doc.activeMaterialId;
            }
          }
        }
        this.doc.notify('paint');
      }
      return;
    }

    if (this.activeTool === 'eraser') {
      this.state = 'dragging';
      this.eraseAt(sx, sy);
      return;
    }

    if (this.activeTool === 'section') {
      const pick = this.renderer.pickScene(sx, sy);
      this.doc.pushUndo('Add Section Plane');
      let axis = 'z';
      let offset = 1.2;
      if (pick && pick.normal) {
        if (Math.abs(pick.normal.x) > 0.7) { axis = 'x'; offset = pick.point.x; }
        else if (Math.abs(pick.normal.y) > 0.7) { axis = 'y'; offset = pick.point.y; }
        else { axis = 'z'; offset = pick.point.z > 0.2 ? pick.point.z : 1.2; }
      }
      this.doc.sectionPlanes.push({
        id: nextId('sec'),
        name: `Section ${axis.toUpperCase()} (${offset.toFixed(2)}m)`,
        axis,
        offset,
        flipped: false,
        active: true,
        showFill: true,
      });
      this.doc.notify('section');
      if (this.ui.onSectionsChange) this.ui.onSectionsChange();
      this.setTool('select');
      return;
    }

    if (this.activeTool === 'place_component') {
      this.doc.pushUndo('Place Component');
      const pt = snap.worldPt;
      const { kind, variant } = this.placeConfig;
      let grp = null;
      if (kind === 'door') grp = buildDoorComponent(this.doc, pt, 0, variant);
      else if (kind === 'window') grp = buildWindowComponent(this.doc, pt, 0, variant);
      else if (kind === 'column') grp = buildColumnComponent(this.doc, pt, variant);
      else if (kind === 'person') grp = buildScalePersonGroup(this.doc, pt, 0);
      else if (kind === 'tree') grp = buildTreeGroup(this.doc, pt, variant);
      else if (kind === 'furniture') grp = buildFurnitureGroup(this.doc, pt, 0, variant);
      else if (kind === 'stair') grp = buildStaircaseGroup(this.doc, pt, { type: variant });
      else if (kind === 'roof') grp = buildRoofGroup(this.doc, pt, { type: variant });

      if (grp) {
        this.doc.clearSelection();
        this.doc.selected.groups.add(grp.id);
        this.doc.notify('component');
      }
      return;
    }

    if (this.activeTool === 'freehand') {
      this.state = 'active';
      this.pts = [snap.localPt];
      return;
    }

    if (this.activeTool === 'line') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.localPt];
      } else {
        const p0 = this.pts[this.pts.length - 1];
        const p1 = snap.localPt;
        if (dist3(p0, p1) > 1e-4) {
          this.doc.pushUndo('Line');
          this.doc.addLine(ctx, p0, p1);
          this.doc.notify('draw');
          // If closed back onto first point, finish chain
          if (this.pts.length >= 2 && dist3(p1, this.pts[0]) < 0.02) {
            this.cancelCurrent();
          } else {
            this.pts.push(p1);
          }
        }
      }
      return;
    }

    if (this.activeTool === 'wall') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.localPt];
      } else {
        const p0 = this.pts[this.pts.length - 1];
        const p1 = { ...snap.localPt, z: this.pts[0].z };
        if (dist3(p0, p1) > 0.05) {
          if (this.pts.length >= 3 && dist3(p1, this.pts[0]) < 0.25) {
            this.commitWallChain(true);
          } else {
            this.pts.push(p1);
          }
        }
      }
      return;
    }

    if (this.activeTool === 'rect' || this.activeTool === 'circle' || this.activeTool === 'polygon') {
      if (this.state === 'idle') {
        this.state = 'active';
        const pick = this.renderer.pickScene(sx, sy);
        this.workPlane = pick && pick.type === 'face'
          ? { origin: snap.localPt, normal: pick.normal }
          : { origin: snap.localPt, normal: v3(0, 0, 1) };
        this.pts = [snap.localPt];
      } else {
        const p0 = this.pts[0];
        const p1 = snap.localPt;
        if (dist3(p0, p1) > 0.01) {
          this.commitShapeTool(p0, p1);
        }
      }
      return;
    }

    if (this.activeTool === 'arc') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.localPt];
      } else if (this.pts.length === 1) {
        this.pts.push(snap.localPt);
      } else if (this.pts.length === 2) {
        // Commit 2-point arc with bulge
        const a = this.pts[0], b = this.pts[1], bulgePt = snap.localPt;
        const mid = scale3(add3(a, b), 0.5);
        const chord = sub3(b, a);
        const chordLen = len3(chord);
        if (chordLen > 0.01) {
          const arcPts = this.computeArcPoints(a, b, bulgePt, 16);
          this.doc.pushUndo('Arc');
          for (let i = 0; i < arcPts.length - 1; i++) {
            this.doc.addLine(ctx, arcPts[i], arcPts[i + 1]);
          }
          this.doc.notify('draw');
        }
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'pushpull') {
      if (this.state === 'idle') {
        const pick = this.renderer.pickScene(sx, sy);
        if (pick && pick.type === 'face') {
          this.state = 'active';
          this.activeFaceId = pick.id;
          const face = ctx.faces.get(pick.id);
          if (face) {
            this.activeFaceCenter = this.doc.getFaceCenter(ctx, face);
            this.activeFaceNormal = { ...face.normal };
            this.pts = [pick.point];
          }
        }
      } else {
        // Commit Push/Pull
        const dist = this.computePushPullDist(sx, sy);
        if (Math.abs(dist) > 1e-4) {
          this.doc.pushUndo('Push/Pull');
          this.doc.pushPullFace(ctx, this.activeFaceId, dist);
          this.lastPushPullDist = dist;
        }
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'offset') {
      if (this.state === 'idle') {
        const pick = this.renderer.pickScene(sx, sy);
        if (pick && pick.type === 'face') {
          this.state = 'active';
          this.activeFaceId = pick.id;
          const face = ctx.faces.get(pick.id);
          if (face) {
            this.activeFaceCenter = this.doc.getFaceCenter(ctx, face);
            this.activeFaceNormal = { ...face.normal };
            this.pts = [pick.point];
          }
        }
      } else {
        const dist = this.computeOffsetDist(snap.localPt);
        if (Math.abs(dist) > 1e-3) {
          this.doc.pushUndo('Offset');
          this.doc.offsetFace(ctx, this.activeFaceId, dist);
          this.lastOffsetDist = dist;
        }
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'move' || this.activeTool === 'scale') {
      if (this.state === 'idle') {
        // Auto-select hovered entity if selection empty
        if (this.doc.selected.faces.size === 0 && this.doc.selected.edges.size === 0 && this.doc.selected.groups.size === 0) {
          const pick = this.renderer.pickScene(sx, sy);
          if (pick) {
            if (pick.type === 'face') this.doc.selected.faces.add(pick.id);
            else if (pick.type === 'edge') this.doc.selected.edges.add(pick.id);
            else if (pick.type === 'group') this.doc.selected.groups.add(pick.id);
            this.doc.notify('select');
          }
        }
        if (this.doc.selected.faces.size + this.doc.selected.edges.size + this.doc.selected.groups.size > 0) {
          this.state = 'active';
          this.pts = [snap.localPt];
        }
      } else {
        const p0 = this.pts[0];
        const p1 = snap.localPt;
        if (this.activeTool === 'move') {
          const delta = sub3(p1, p0);
          if (len3(delta) > 1e-4) {
            this.doc.pushUndo(this.copyMode ? 'Copy' : 'Move');
            this.doc.transformSelection(mat4Translation(delta.x, delta.y, delta.z), this.copyMode);
            this.lastAction = { type: 'move', delta };
          }
        } else {
          const d0 = dist3(p0, v3(0, 0, 0)) || 1;
          const s = clamp(dist3(p1, p0) * 0.5 + 0.5, 0.1, 20);
          const m = mat4Mul(
            mat4Translation(p0.x, p0.y, p0.z),
            mat4Mul(mat4Scale(s, s, s), mat4Translation(-p0.x, -p0.y, -p0.z))
          );
          this.doc.pushUndo('Scale');
          this.doc.transformSelection(m, false);
        }
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'rotate') {
      if (this.state === 'idle') {
        if (this.doc.selected.faces.size + this.doc.selected.edges.size + this.doc.selected.groups.size === 0) {
          const pick = this.renderer.pickScene(sx, sy);
          if (pick) {
            if (pick.type === 'face') this.doc.selected.faces.add(pick.id);
            else if (pick.type === 'group') this.doc.selected.groups.add(pick.id);
            this.doc.notify('select');
          }
        }
        if (this.doc.selected.faces.size + this.doc.selected.edges.size + this.doc.selected.groups.size > 0) {
          const pick = this.renderer.pickScene(sx, sy);
          this.workPlane = pick && pick.type === 'face'
            ? { origin: snap.localPt, normal: pick.normal }
            : { origin: snap.localPt, normal: v3(0, 0, 1) };
          this.state = 'active';
          this.pts = [snap.localPt];
        }
      } else if (this.pts.length === 1) {
        if (dist3(this.pts[0], snap.localPt) > 0.02) {
          this.pts.push(snap.localPt);
        }
      } else if (this.pts.length === 2) {
        const angle = this.computeRotateAngle(this.pts[0], this.pts[1], snap.localPt);
        const pivot = this.pts[0];
        const axis = this.workPlane.normal;
        const m = mat4Mul(
          mat4Translation(pivot.x, pivot.y, pivot.z),
          mat4Mul(mat4RotationAxis(axis, angle), mat4Translation(-pivot.x, -pivot.y, -pivot.z))
        );
        this.doc.pushUndo(this.copyMode ? 'Rotate Copy' : 'Rotate');
        this.doc.transformSelection(m, this.copyMode);
        this.lastAction = { type: 'rotate', pivot, axis, angle };
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'followme') {
      if (this.state === 'idle') {
        const pick = this.renderer.pickScene(sx, sy);
        if (pick && pick.type === 'face') {
          this.state = 'active';
          this.activeFaceId = pick.id;
          this.pts = [this.doc.getFaceCenter(ctx, ctx.faces.get(pick.id))];
        }
      } else {
        this.pts.push(snap.localPt);
      }
      return;
    }

    if (this.activeTool === 'tape') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.worldPt];
      } else {
        const p0 = this.pts[0];
        const p1 = snap.worldPt;
        if (dist3(p0, p1) > 0.01) {
          this.doc.pushUndo('Guide Line');
          this.doc.guides.push({ id: nextId('gd'), p1, p2: p1, layerId: 'layer_annotations' });
          this.doc.notify('guide');
          if (this.ui.onVCBValue) this.ui.onVCBValue(formatLength(dist3(p0, p1), this.doc.unit));
        }
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'dimension') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.worldPt];
      } else if (this.pts.length === 1) {
        if (dist3(this.pts[0], snap.worldPt) > 0.01) this.pts.push(snap.worldPt);
      } else if (this.pts.length === 2) {
        const mid = scale3(add3(this.pts[0], this.pts[1]), 0.5);
        const offsetVec = sub3(snap.worldPt, mid);
        this.doc.pushUndo('Dimension');
        this.doc.dimensions.push({
          id: nextId('dim'),
          p1: this.pts[0],
          p2: this.pts[1],
          offsetVec,
          layerId: 'layer_annotations',
        });
        this.doc.notify('dim');
        this.cancelCurrent();
      }
      return;
    }

    if (this.activeTool === 'text') {
      if (this.state === 'idle') {
        this.state = 'active';
        this.pts = [snap.worldPt];
      } else {
        const anchor = this.pts[0];
        const pos = snap.worldPt;
        const txt = window.prompt('Enter architectural callout text:', 'Space / Detail Callout');
        if (txt && txt.trim()) {
          this.doc.pushUndo('Text Callout');
          this.doc.labels.push({
            id: nextId('lbl'),
            anchor,
            p: pos,
            text: txt.trim(),
            layerId: 'layer_annotations',
          });
          this.doc.notify('label');
        }
        this.cancelCurrent();
      }
      return;
    }
  }

  handlePointerMove(e) {
    const sx = e.clientX, sy = e.clientY;
    const rect = this.renderer.glCanvas.getBoundingClientRect();
    const lx = sx - rect.left;
    const ly = sy - rect.top;

    // Update hover highlight in idle mode
    if (this.state === 'idle') {
      const pick = this.renderer.pickScene(sx, sy);
      const prevHov = this.renderer.hovered;
      const changed = (pick?.id !== prevHov?.id) || (pick?.type !== prevHov?.type);
      this.renderer.hovered = pick ? { type: pick.type, id: pick.id, point: pick.point } : null;
      if (changed) this.doc.dirty = true;
    }

    const anchor = this.pts.length ? this.pts[this.pts.length - 1] : null;
    const snap = this.computeSnap(sx, sy, anchor);
    this.currentSnap = snap;

    this.renderer.overlayState.inferencePoint = snap.worldPt;
    this.renderer.overlayState.inferenceType = snap.type;
    this.renderer.overlayState.inferenceLine = snap.inferenceLine;
    this.renderer.overlayState.previewLines = [];
    this.renderer.overlayState.previewPolys = [];
    this.renderer.overlayState.cursorLabel = null;

    if (this.ui.onCoords) {
      this.ui.onCoords(snap.worldPt);
    }

    if (this.activeTool === 'eraser' && this.state === 'dragging') {
      this.eraseAt(sx, sy);
      return;
    }

    if (this.activeTool === 'select' && this.state === 'dragging' && this.marqueeStart) {
      const dx = lx - this.marqueeStart.x;
      this.renderer.overlayState.marquee = {
        x1: this.marqueeStart.x,
        y1: this.marqueeStart.y,
        x2: lx,
        y2: ly,
        crossing: dx < 0,
      };
      return;
    }

    if (this.activeTool === 'freehand' && this.state === 'active') {
      const prev = this.pts[this.pts.length - 1];
      if (dist3(prev, snap.localPt) > 0.12) {
        this.pts.push(snap.localPt);
      }
      for (let i = 0; i < this.pts.length - 1; i++) {
        this.renderer.overlayState.previewLines.push({ p1: this.pts[i], p2: this.pts[i + 1], color: '#0f172a', width: 2 });
      }
      return;
    }

    if (this.activeTool === 'line' && this.state === 'active' && this.pts.length >= 1) {
      const p0 = this.pts[this.pts.length - 1];
      const p1 = snap.localPt;
      const col = snap.inferenceLine ? snap.inferenceLine.color : '#0f172a';
      this.renderer.overlayState.previewLines.push({ p1, p0, color: col, width: 2 });
      const d = dist3(p0, p1);
      const txt = formatLength(d, this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: txt };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'wall' && this.state === 'active' && this.pts.length >= 1) {
      const p0 = this.pts[this.pts.length - 1];
      const p1 = { ...snap.localPt, z: this.pts[0].z };
      const previewChain = [...this.pts, p1];
      for (let i = 0; i < previewChain.length - 1; i++) {
        const a = previewChain[i], b = previewChain[i + 1];
        const dir = norm3(sub3(b, a));
        const perp = { x: -dir.y, y: dir.x, z: 0 };
        const ht = this.wallOpts.thickness * 0.5;
        this.renderer.overlayState.previewPolys.push({
          pts: [
            add3(a, scale3(perp, ht)),
            add3(b, scale3(perp, ht)),
            add3(b, scale3(perp, -ht)),
            add3(a, scale3(perp, -ht)),
          ],
          color: 'rgba(234, 88, 12, 0.30)',
        });
        this.renderer.overlayState.previewLines.push({ p1: a, p2: b, color: '#ea580c', width: 2 });
      }
      const txt = formatLength(dist3(p0, p1), this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: `Wall ${txt}` };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'rect' && this.state === 'active' && this.pts.length === 1) {
      const corners = this.computeRectCorners(this.pts[0], snap.localPt);
      this.renderer.overlayState.previewPolys.push({ pts: corners.pts, color: 'rgba(37, 99, 235, 0.22)' });
      for (let i = 0; i < 4; i++) {
        this.renderer.overlayState.previewLines.push({ p1: corners.pts[i], p2: corners.pts[(i + 1) % 4], color: '#1d4ed8', width: 2 });
      }
      const txt = `${formatLength(corners.w, this.doc.unit)}, ${formatLength(corners.h, this.doc.unit)}`;
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: txt };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if ((this.activeTool === 'circle' || this.activeTool === 'polygon') && this.state === 'active' && this.pts.length === 1) {
      const r = dist3(this.pts[0], snap.localPt);
      const sides = this.activeTool === 'circle' ? this.circleSides : this.polygonSides;
      const { u, v } = basisFromNormal(this.workPlane.normal);
      const poly = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        poly.push(add3(this.pts[0], add3(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
      }
      this.renderer.overlayState.previewPolys.push({ pts: poly, color: 'rgba(37, 99, 235, 0.22)' });
      for (let i = 0; i < poly.length; i++) {
        this.renderer.overlayState.previewLines.push({ p1: poly[i], p2: poly[(i + 1) % poly.length], color: '#1d4ed8', width: 2 });
      }
      const txt = `R ${formatLength(r, this.doc.unit)}`;
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: txt };
      if (this.ui.onVCBValue) this.ui.onVCBValue(formatLength(r, this.doc.unit));
      return;
    }

    if (this.activeTool === 'arc' && this.state === 'active') {
      if (this.pts.length === 1) {
        this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.localPt, color: '#1d4ed8', width: 2, dashed: true });
        const txt = formatLength(dist3(this.pts[0], snap.localPt), this.doc.unit);
        this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: txt };
      } else if (this.pts.length === 2) {
        const arcPts = this.computeArcPoints(this.pts[0], this.pts[1], snap.localPt, 16);
        for (let i = 0; i < arcPts.length - 1; i++) {
          this.renderer.overlayState.previewLines.push({ p1: arcPts[i], p2: arcPts[i + 1], color: '#1d4ed8', width: 2 });
        }
      }
      return;
    }

    if (this.activeTool === 'pushpull' && this.state === 'active' && this.activeFaceId) {
      const dist = this.computePushPullDist(sx, sy);
      const face = this.doc.activeContext.faces.get(this.activeFaceId);
      if (face) {
        const delta = scale3(face.normal, dist);
        const pts = face.loops[0].map((id) => this.doc.activeContext.vertices.get(id));
        const capPts = pts.map((p) => add3(p, delta));
        this.renderer.overlayState.previewPolys.push({ pts: capPts, color: 'rgba(37, 99, 235, 0.28)' });
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          this.renderer.overlayState.previewLines.push({ p1: pts[i], p2: capPts[i], color: '#2563eb', width: 1.5, dashed: true });
          this.renderer.overlayState.previewLines.push({ p1: capPts[i], p2: capPts[j], color: '#1d4ed8', width: 2 });
        }
      }
      const txt = formatLength(dist, this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: `Push/Pull ${txt}` };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'offset' && this.state === 'active' && this.activeFaceId) {
      const dist = this.computeOffsetDist(snap.localPt);
      const face = this.doc.activeContext.faces.get(this.activeFaceId);
      if (face) {
        const outerPts = face.loops[0].map((id) => this.doc.activeContext.vertices.get(id));
        const { u, v } = basisFromNormal(face.normal);
        const origin = outerPts[0];
        const o2d = projectToPlane2D(outerPts, origin, u, v);
        const n2d = offsetPolygon2D(o2d, dist);
        const n3d = n2d.map((p2) => add3(origin, add3(scale3(u, p2.x), scale3(v, p2.y))));
        for (let i = 0; i < n3d.length; i++) {
          this.renderer.overlayState.previewLines.push({ p1: n3d[i], p2: n3d[(i + 1) % n3d.length], color: '#2563eb', width: 2 });
        }
      }
      const txt = formatLength(Math.abs(dist), this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: `Offset ${txt}` };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'move' && this.state === 'active' && this.pts.length === 1) {
      this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.localPt, color: '#2563eb', width: 2, dashed: true });
      const txt = formatLength(dist3(this.pts[0], snap.localPt), this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: `${this.copyMode ? 'Copy' : 'Move'} ${txt}` };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'rotate' && this.state === 'active') {
      if (this.pts.length === 1) {
        this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.localPt, color: '#0284c7', width: 2, dashed: true });
      } else if (this.pts.length === 2) {
        const ang = this.computeRotateAngle(this.pts[0], this.pts[1], snap.localPt);
        const deg = ((ang * 180) / Math.PI).toFixed(1);
        this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: this.pts[1], color: '#94a3b8', width: 1.5, dashed: true });
        this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.localPt, color: '#0284c7', width: 2 });
        this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: `${deg}°` };
        if (this.ui.onVCBValue) this.ui.onVCBValue(`${deg}°`);
      }
      return;
    }

    if (this.activeTool === 'followme' && this.state === 'active') {
      const chain = [...this.pts, snap.localPt];
      for (let i = 0; i < chain.length - 1; i++) {
        this.renderer.overlayState.previewLines.push({ p1: chain[i], p2: chain[i + 1], color: '#8b5cf6', width: 2 });
      }
      return;
    }

    if (this.activeTool === 'tape' && this.state === 'active') {
      this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.worldPt, color: '#0f172a', width: 1.5, dashed: true });
      const txt = formatLength(dist3(this.pts[0], snap.worldPt), this.doc.unit);
      this.renderer.overlayState.cursorLabel = { x: lx, y: ly, text: txt };
      if (this.ui.onVCBValue) this.ui.onVCBValue(txt);
      return;
    }

    if (this.activeTool === 'dimension' && this.state === 'active') {
      if (this.pts.length === 1) {
        this.renderer.overlayState.previewLines.push({ p1: this.pts[0], p2: snap.worldPt, color: '#1e293b', width: 1.5, dashed: true });
      } else if (this.pts.length === 2) {
        const mid = scale3(add3(this.pts[0], this.pts[1]), 0.5);
        const off = sub3(snap.worldPt, mid);
        this.renderer.overlayState.previewLines.push({ p1: add3(this.pts[0], off), p2: add3(this.pts[1], off), color: '#2563eb', width: 1.5 });
      }
    }
  }

  handlePrimaryUp(e) {
    const sx = e.clientX, sy = e.clientY;
    if (this.activeTool === 'eraser') {
      this.state = 'idle';
      return;
    }

    if (this.activeTool === 'freehand' && this.state === 'active') {
      if (this.pts.length >= 2) {
        this.doc.pushUndo('Freehand');
        const ctx = this.doc.activeContext;
        for (let i = 0; i < this.pts.length - 1; i++) {
          this.doc.addLine(ctx, this.pts[i], this.pts[i + 1]);
        }
        this.doc.notify('draw');
      }
      this.cancelCurrent();
      return;
    }

    if (this.activeTool === 'select' && this.state === 'dragging') {
      this.state = 'idle';
      const m = this.renderer.overlayState.marquee;
      this.renderer.overlayState.marquee = null;

      const movedDist = Math.hypot(sx - this.startScreen.x, sy - this.startScreen.y);
      if (movedDist < 5) {
        // Single Click Select
        const pick = this.renderer.pickScene(sx, sy);
        if (!e.shiftKey) this.doc.clearSelection();
        if (pick) {
          const set =
            pick.type === 'face' ? this.doc.selected.faces :
            pick.type === 'edge' ? this.doc.selected.edges :
            this.doc.selected.groups;
          if (e.shiftKey && set.has(pick.id)) set.delete(pick.id);
          else set.add(pick.id);
        } else if (!e.shiftKey && this.doc.contextStack.length > 1) {
          // Clicking empty space outside group exits group
          this.doc.popContext();
        }
        this.doc.notify('select');
      } else if (m) {
        // Marquee Box Selection
        this.performMarqueeSelect(m, e.shiftKey);
      }
      return;
    }

    // Support drag-and-release for PushPull, Offset, Move, Rect, Circle if user dragged > 12px!
    const dragDist = this.startScreen ? Math.hypot(sx - this.startScreen.x, sy - this.startScreen.y) : 0;
    if (dragDist > 14 && this.state === 'active') {
      const ctx = this.doc.activeContext;
      const snap = this.computeSnap(sx, sy, this.pts[0]);
      if (this.activeTool === 'pushpull' && this.activeFaceId) {
        const dist = this.computePushPullDist(sx, sy);
        if (Math.abs(dist) > 1e-4) {
          this.doc.pushUndo('Push/Pull');
          this.doc.pushPullFace(ctx, this.activeFaceId, dist);
          this.lastPushPullDist = dist;
        }
        this.cancelCurrent();
      } else if (this.activeTool === 'offset' && this.activeFaceId) {
        const dist = this.computeOffsetDist(snap.localPt);
        if (Math.abs(dist) > 1e-3) {
          this.doc.pushUndo('Offset');
          this.doc.offsetFace(ctx, this.activeFaceId, dist);
          this.lastOffsetDist = dist;
        }
        this.cancelCurrent();
      } else if ((this.activeTool === 'rect' || this.activeTool === 'circle' || this.activeTool === 'polygon') && this.pts.length === 1) {
        if (dist3(this.pts[0], snap.localPt) > 0.02) {
          this.commitShapeTool(this.pts[0], snap.localPt);
        }
      }
    }
  }

  handleDoubleClick(e) {
    const sx = e.clientX, sy = e.clientY;
    const ctx = this.doc.activeContext;
    if (this.activeTool === 'select') {
      const pick = this.renderer.pickScene(sx, sy);
      if (!pick) return;
      if (pick.type === 'group') {
        this.doc.pushContext(pick.id);
      } else if (pick.type === 'face') {
        this.doc.selectConnectedFromFace(ctx, pick.id);
        this.doc.notify('select');
      }
    } else if (this.activeTool === 'pushpull') {
      const pick = this.renderer.pickScene(sx, sy);
      if (pick && pick.type === 'face' && Math.abs(this.lastPushPullDist) > 1e-4) {
        this.cancelCurrent();
        this.doc.pushUndo('Push/Pull Repeat');
        this.doc.pushPullFace(ctx, pick.id, this.lastPushPullDist);
      }
    } else if (this.activeTool === 'offset') {
      const pick = this.renderer.pickScene(sx, sy);
      if (pick && pick.type === 'face' && Math.abs(this.lastOffsetDist) > 1e-4) {
        this.cancelCurrent();
        this.doc.pushUndo('Offset Repeat');
        this.doc.offsetFace(ctx, pick.id, this.lastOffsetDist);
      }
    } else if (this.activeTool === 'wall' && this.state === 'active' && this.pts.length >= 2) {
      this.commitWallChain(false);
    } else if (this.activeTool === 'followme' && this.state === 'active' && this.activeFaceId && this.pts.length >= 2) {
      this.doc.pushUndo('Follow Me');
      this.doc.followMe(ctx, this.activeFaceId, this.pts, false);
      this.cancelCurrent();
    }
  }

  // ---- Tool Geometry Helpers ----
  computeRectCorners(p0, p1) {
    const { u, v, n } = basisFromNormal(this.workPlane.normal);
    const d = sub3(p1, p0);
    const du = dot3(d, u);
    const dv = dot3(d, v);
    const c1 = add3(p0, scale3(u, du));
    const c2 = add3(c1, scale3(v, dv));
    const c3 = add3(p0, scale3(v, dv));
    return {
      pts: [p0, c1, c2, c3],
      w: Math.abs(du),
      h: Math.abs(dv),
      n,
    };
  }

  commitShapeTool(p0, p1) {
    const ctx = this.doc.activeContext;
    if (this.activeTool === 'rect') {
      const { pts, n } = this.computeRectCorners(p0, p1);
      this.doc.pushUndo('Rectangle');
      this.doc.addPolygonFace(ctx, pts, { preferredNormal: n });
      this.doc.notify('draw');
    } else {
      const r = dist3(p0, p1);
      const sides = this.activeTool === 'circle' ? this.circleSides : this.polygonSides;
      const { u, v, n } = basisFromNormal(this.workPlane.normal);
      const poly = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        poly.push(add3(p0, add3(scale3(u, Math.cos(a) * r), scale3(v, Math.sin(a) * r))));
      }
      this.doc.pushUndo(this.activeTool === 'circle' ? 'Circle' : 'Polygon');
      this.doc.addPolygonFace(ctx, poly, { preferredNormal: n });
      this.doc.notify('draw');
    }
    this.cancelCurrent();
  }

  commitWallChain(closed) {
    if (this.pts.length >= 2) {
      this.doc.pushUndo('Parametric Wall');
      buildWallChain(this.doc, this.pts, {
        ...this.wallOpts,
        materialId: this.doc.activeMaterialId,
        layerId: this.doc.activeLayerId === 'layer_default' ? 'layer_walls_1' : this.doc.activeLayerId,
        closed,
      });
    }
    this.cancelCurrent();
  }

  computeArcPoints(a, b, bulgePt, segs = 16) {
    const mid = scale3(add3(a, b), 0.5);
    const chord = sub3(b, a);
    const cLen = len3(chord);
    const bVec = sub3(bulgePt, mid);
    const dir = norm3(chord);
    const perpRaw = sub3(bVec, scale3(dir, dot3(bVec, dir)));
    const bulge = len3(perpRaw);
    if (bulge < 1e-4) return [a, b];
    const perp = norm3(perpRaw);
    const halfC = cLen * 0.5;
    const radius = (halfC * halfC + bulge * bulge) / (2 * bulge);
    const center = add3(mid, scale3(perp, bulge - radius));
    const u = norm3(sub3(a, center));
    const v = perp;
    const startAng = Math.atan2(dot3(sub3(a, center), v), dot3(sub3(a, center), u));
    let endAng = Math.atan2(dot3(sub3(b, center), v), dot3(sub3(b, center), u));
    // Ensure arc sweeps through bulgePt
    const midAng = Math.atan2(dot3(sub3(bulgePt, center), v), dot3(sub3(bulgePt, center), u));
    let span = endAng - startAng;
    if (span <= 0) span += Math.PI * 2;
    let midRel = midAng - startAng;
    if (midRel <= 0) midRel += Math.PI * 2;
    if (midRel > span) span -= Math.PI * 2;

    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const ang = startAng + (i / segs) * span;
      pts.push(add3(center, add3(scale3(u, Math.cos(ang) * radius), scale3(v, Math.sin(ang) * radius))));
    }
    return pts;
  }

  computePushPullDist(sx, sy) {
    if (!this.activeFaceCenter || !this.activeFaceNormal) return 0;
    const { ro, rd } = this.renderer.screenToRay(sx, sy);
    const cl = rayLineClosest(ro, rd, this.activeFaceCenter, this.activeFaceNormal);
    if (!cl) return 0;
    let d = cl.lineT;
    if (this.gridSnap) d = Math.round(d / this.gridStep) * this.gridStep;
    return d;
  }

  computeOffsetDist(localPt) {
    if (!this.activeFaceCenter) return 0;
    const face = this.doc.activeContext.faces.get(this.activeFaceId);
    if (!face) return 0;
    const v0 = this.doc.activeContext.vertices.get(face.loops[0][0]);
    const rOrig = dist3(this.activeFaceCenter, v0);
    const rCur = dist3(this.activeFaceCenter, localPt);
    return rCur - rOrig;
  }

  computeRotateAngle(pivot, armPt, curPt) {
    const { u, v } = basisFromNormal(this.workPlane.normal);
    const d1 = sub3(armPt, pivot);
    const d2 = sub3(curPt, pivot);
    const a1 = Math.atan2(dot3(d1, v), dot3(d1, u));
    const a2 = Math.atan2(dot3(d2, v), dot3(d2, u));
    let ang = a2 - a1;
    if (this.angleSnap) {
      const step = (15 * Math.PI) / 180;
      ang = Math.round(ang / step) * step;
    }
    return ang;
  }

  eraseAt(sx, sy) {
    const pick = this.renderer.pickScene(sx, sy, true);
    if (!pick) return;
    const ctx = this.doc.activeContext;
    if (pick.type === 'edge') {
      this.doc.pushUndo('Erase Edge');
      const e = ctx.edges.get(pick.id);
      if (e) {
        for (const f of this.doc.getFacesForEdge(ctx, e.v1, e.v2)) ctx.faces.delete(f.id);
        ctx.edges.delete(e.id);
        this.doc.pruneOrphanVertices(ctx);
        this.doc.notify('erase');
      }
    } else if (pick.type === 'group') {
      this.doc.pushUndo('Erase Group');
      ctx.groups.delete(pick.id);
      this.doc.notify('erase');
    }
  }

  performMarqueeSelect(m, additive) {
    if (!additive) this.doc.clearSelection();
    const minX = Math.min(m.x1, m.x2), maxX = Math.max(m.x1, m.x2);
    const minY = Math.min(m.y1, m.y2), maxY = Math.max(m.y1, m.y2);
    const inBox = (sp) => sp && sp.x >= minX && sp.x <= maxX && sp.y >= minY && sp.y <= maxY;
    const ctx = this.doc.activeContext;

    for (const f of ctx.faces.values()) {
      if (!this.doc.isLayerVisible(f.layerId)) continue;
      const pts = f.loops[0].map((id) => this.renderer.worldToScreen(ctx.vertices.get(id)));
      const hit = m.crossing ? pts.some(inBox) : pts.every(inBox);
      if (hit) this.doc.selected.faces.add(f.id);
    }
    for (const e of ctx.edges.values()) {
      if (!this.doc.isLayerVisible(e.layerId)) continue;
      const s1 = this.renderer.worldToScreen(ctx.vertices.get(e.v1));
      const s2 = this.renderer.worldToScreen(ctx.vertices.get(e.v2));
      const hit = m.crossing ? (inBox(s1) || inBox(s2)) : (inBox(s1) && inBox(s2));
      if (hit) this.doc.selected.edges.add(e.id);
    }
    for (const g of ctx.groups.values()) {
      if (g.hidden || !this.doc.isLayerVisible(g.layerId)) continue;
      const sub = this.doc.contexts.get(g.contextId);
      const gm = new Float32Array(g.matrix);
      const pts = Array.from(sub.vertices.values()).map((v) => this.renderer.worldToScreen(mat4TransformPoint(gm, v)));
      if (pts.length && (m.crossing ? pts.some(inBox) : pts.every(inBox))) {
        this.doc.selected.groups.add(g.id);
      }
    }
    this.doc.notify('select');
  }
}
