import {
  EPS,
  WELD_EPS,
  v3,
  add3,
  sub3,
  scale3,
  dot3,
  cross3,
  len3,
  dist3,
  norm3,
  eq3,
  mat4Identity,
  mat4Mul,
  mat4TransformPoint,
  mat4TransformDir,
  mat4Invert,
  basisFromNormal,
  projectToPlane2D,
  polyArea2D,
  pointInPoly2D,
  computeNewellNormal,
  triangulatePolygon2D,
  offsetPolygon2D,
  segIntersect2D,
} from './math.js';
import { DEFAULT_MATERIALS } from './materials.js';

let globalIdCounter = 1;
export function nextId(prefix = 'id') {
  return `${prefix}_${globalIdCounter++}`;
}

export const DEFAULT_LAYERS = [
  { id: 'layer_default',     name: 'Untagged (Layer 0)',   visible: true, color: '#94a3b8' },
  { id: 'layer_site',        name: 'Site & Landscape',     visible: true, color: '#65a30d' },
  { id: 'layer_foundation',  name: 'Foundation & Slabs',   visible: true, color: '#78716c' },
  { id: 'layer_walls_1',     name: 'Walls - Level 1',      visible: true, color: '#ea580c' },
  { id: 'layer_walls_2',     name: 'Walls - Level 2',      visible: true, color: '#f59e0b' },
  { id: 'layer_roof',        name: 'Roof & Parapets',      visible: true, color: '#dc2626' },
  { id: 'layer_openings',    name: 'Doors & Windows',      visible: true, color: '#0284c7' },
  { id: 'layer_stairs',      name: 'Stairs & Structure',   visible: true, color: '#0d9488' },
  { id: 'layer_entourage',   name: 'Furniture & Entourage',visible: true, color: '#8b5cf6' },
  { id: 'layer_annotations', name: 'Dimensions & Guides',  visible: true, color: '#ec4899' },
];

export function createEmptyContext(id = nextId('ctx')) {
  return {
    id,
    vertices: new Map(), // id -> { id, x, y, z }
    edges: new Map(),    // id -> { id, v1, v2, soft, hidden, layerId }
    faces: new Map(),    // id -> { id, loops: [[vId...],...], normal, materialId, backMaterialId, layerId, area }
    groups: new Map(),   // id -> { id, name, contextId, matrix: Array(16), layerId, locked, hidden }
  };
}

export class CADDocument {
  constructor() {
    this.projectName = 'Untitled Architectural Model';
    this.unit = 'm'; // 'm' | 'cm' | 'mm' | 'ft'
    this.contexts = new Map();
    const root = createEmptyContext('ctx_root');
    this.contexts.set(root.id, root);
    this.rootContextId = root.id;
    this.contextStack = [root.id]; // editing breadcrumb

    this.layers = DEFAULT_LAYERS.map((l) => ({ ...l }));
    this.activeLayerId = 'layer_default';

    this.materials = new Map();
    for (const m of DEFAULT_MATERIALS) {
      this.materials.set(m.id, { ...m });
    }
    this.activeMaterialId = 'plaster';

    this.guides = [];     // { id, p1, p2, layerId }
    this.dimensions = []; // { id, p1, p2, offsetVec, layerId }
    this.labels = [];     // { id, p, anchor, text, layerId }
    this.sectionPlanes = []; // { id, name, axis, offset, flipped, active, showFill }

    this.selected = {
      faces: new Set(),
      edges: new Set(),
      groups: new Set(),
      dims: new Set(),
      guides: new Set(),
      labels: new Set(),
    };

    this.undoStack = [];
    this.redoStack = [];
    this.dirty = true;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(reason = 'model') {
    this.dirty = true;
    for (const fn of this.listeners) fn(reason);
  }

  get activeContextId() {
    return this.contextStack[this.contextStack.length - 1];
  }

  get activeContext() {
    return this.contexts.get(this.activeContextId);
  }

  get rootContext() {
    return this.contexts.get(this.rootContextId);
  }

  // Transform from active context local space to world space
  getActiveWorldMatrix() {
    let m = mat4Identity();
    for (let i = 0; i < this.contextStack.length - 1; i++) {
      const parentCtx = this.contexts.get(this.contextStack[i]);
      const childCtxId = this.contextStack[i + 1];
      for (const g of parentCtx.groups.values()) {
        if (g.contextId === childCtxId) {
          m = mat4Mul(m, new Float32Array(g.matrix));
          break;
        }
      }
    }
    return m;
  }

  pushContext(groupId) {
    const ctx = this.activeContext;
    const g = ctx.groups.get(groupId);
    if (!g || g.locked) return false;
    this.clearSelection();
    this.contextStack.push(g.contextId);
    this.notify('context');
    return true;
  }

  popContext() {
    if (this.contextStack.length <= 1) return false;
    this.clearSelection();
    this.contextStack.pop();
    this.notify('context');
    return true;
  }

  clearSelection() {
    this.selected.faces.clear();
    this.selected.edges.clear();
    this.selected.groups.clear();
    this.selected.dims.clear();
    this.selected.guides.clear();
    this.selected.labels.clear();
  }

  isLayerVisible(layerId) {
    const l = this.layers.find((x) => x.id === layerId);
    return l ? l.visible : true;
  }

  // Serialization for Undo/Redo & Save/Load
  serialize() {
    const contextsArr = [];
    for (const [cid, ctx] of this.contexts.entries()) {
      contextsArr.push({
        id: cid,
        vertices: Array.from(ctx.vertices.values()),
        edges: Array.from(ctx.edges.values()),
        faces: Array.from(ctx.faces.values()),
        groups: Array.from(ctx.groups.values()),
      });
    }
    return JSON.stringify({
      version: 1,
      projectName: this.projectName,
      unit: this.unit,
      rootContextId: this.rootContextId,
      contextStack: [...this.contextStack],
      activeLayerId: this.activeLayerId,
      activeMaterialId: this.activeMaterialId,
      layers: this.layers,
      materials: Array.from(this.materials.values()),
      contexts: contextsArr,
      guides: this.guides,
      dimensions: this.dimensions,
      labels: this.labels,
      sectionPlanes: this.sectionPlanes,
      globalIdCounter,
    });
  }

  deserialize(jsonStr, preserveHistory = true) {
    const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    this.projectName = data.projectName || 'Architectural Model';
    this.unit = data.unit || 'm';
    this.rootContextId = data.rootContextId || 'ctx_root';
    this.contextStack = data.contextStack && data.contextStack.length ? [...data.contextStack] : [this.rootContextId];
    this.activeLayerId = data.activeLayerId || 'layer_default';
    this.activeMaterialId = data.activeMaterialId || 'plaster';
    this.layers = data.layers || DEFAULT_LAYERS.map((l) => ({ ...l }));

    this.materials = new Map();
    for (const m of (data.materials || DEFAULT_MATERIALS)) {
      this.materials.set(m.id, { ...m });
    }

    this.contexts = new Map();
    for (const c of data.contexts) {
      const ctx = createEmptyContext(c.id);
      for (const v of c.vertices) ctx.vertices.set(v.id, { ...v });
      for (const e of c.edges) ctx.edges.set(e.id, { ...e });
      for (const f of c.faces) ctx.faces.set(f.id, { ...f, loops: f.loops.map((lp) => [...lp]) });
      for (const g of c.groups) ctx.groups.set(g.id, { ...g, matrix: [...g.matrix] });
      this.contexts.set(ctx.id, ctx);
    }

    this.guides = data.guides || [];
    this.dimensions = data.dimensions || [];
    this.labels = data.labels || [];
    this.sectionPlanes = data.sectionPlanes || [];
    this.clearSelection();
    if (data.globalIdCounter && data.globalIdCounter > globalIdCounter) {
      globalIdCounter = data.globalIdCounter;
    }
    if (!preserveHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.notify('load');
  }

  pushUndo(label = 'Edit') {
    const snap = this.serialize();
    this.undoStack.push({ label, snap });
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    const current = this.serialize();
    const prev = this.undoStack.pop();
    this.redoStack.push({ label: prev.label, snap: current });
    this.deserialize(prev.snap, true);
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    const current = this.serialize();
    const next = this.redoStack.pop();
    this.undoStack.push({ label: next.label, snap: current });
    this.deserialize(next.snap, true);
    return true;
  }

  // ---- Vertex / Edge / Face B-Rep Operations ----

  findOrCreateVertex(ctx, p, eps = WELD_EPS) {
    for (const v of ctx.vertices.values()) {
      if (
        Math.abs(v.x - p.x) <= eps &&
        Math.abs(v.y - p.y) <= eps &&
        Math.abs(v.z - p.z) <= eps
      ) {
        return v.id;
      }
    }
    const id = nextId('v');
    ctx.vertices.set(id, { id, x: p.x, y: p.y, z: p.z });
    return id;
  }

  findEdge(ctx, v1, v2) {
    for (const e of ctx.edges.values()) {
      if ((e.v1 === v1 && e.v2 === v2) || (e.v1 === v2 && e.v2 === v1)) {
        return e;
      }
    }
    return null;
  }

  ensureEdge(ctx, v1, v2, options = {}) {
    if (v1 === v2) return null;
    const existing = this.findEdge(ctx, v1, v2);
    if (existing) return existing;
    const e = {
      id: nextId('e'),
      v1,
      v2,
      soft: !!options.soft,
      hidden: !!options.hidden,
      layerId: options.layerId || this.activeLayerId,
    };
    ctx.edges.set(e.id, e);
    return e;
  }

  getEdgesForVertex(ctx, vId) {
    const out = [];
    for (const e of ctx.edges.values()) {
      if (e.v1 === vId || e.v2 === vId) out.push(e);
    }
    return out;
  }

  getFacesForEdge(ctx, v1, v2) {
    const out = [];
    for (const f of ctx.faces.values()) {
      let found = false;
      for (const lp of f.loops) {
        const n = lp.length;
        for (let i = 0; i < n; i++) {
          const a = lp[i];
          const b = lp[(i + 1) % n];
          if ((a === v1 && b === v2) || (a === v2 && b === v1)) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) out.push(f);
    }
    return out;
  }

  recomputeFaceProps(ctx, face) {
    if (!face.loops.length || face.loops[0].length < 3) {
      face.area = 0;
      return;
    }
    const outerPts = face.loops[0].map((id) => ctx.vertices.get(id)).filter(Boolean);
    if (outerPts.length < 3) {
      face.area = 0;
      return;
    }
    face.normal = computeNewellNormal(outerPts);
    const { u, v } = basisFromNormal(face.normal);
    const outer2D = projectToPlane2D(outerPts, outerPts[0], u, v);
    let area = Math.abs(polyArea2D(outer2D));
    for (let i = 1; i < face.loops.length; i++) {
      const hPts = face.loops[i].map((id) => ctx.vertices.get(id)).filter(Boolean);
      if (hPts.length >= 3) {
        const h2D = projectToPlane2D(hPts, outerPts[0], u, v);
        area -= Math.abs(polyArea2D(h2D));
      }
    }
    face.area = Math.max(0, area);
  }

  // Insert vertex vSplit into edge e if it lies strictly on it, updating all incident faces
  splitEdgeAtVertex(ctx, edge, vSplitId) {
    if (edge.v1 === vSplitId || edge.v2 === vSplitId) return [edge];
    const oldV1 = edge.v1;
    const oldV2 = edge.v2;

    // Update faces containing (oldV1, oldV2)
    for (const face of ctx.faces.values()) {
      for (let li = 0; li < face.loops.length; li++) {
        const lp = face.loops[li];
        const newLp = [];
        for (let i = 0; i < lp.length; i++) {
          const a = lp[i];
          const b = lp[(i + 1) % lp.length];
          newLp.push(a);
          if ((a === oldV1 && b === oldV2) || (a === oldV2 && b === oldV1)) {
            if (!lp.includes(vSplitId)) {
              newLp.push(vSplitId);
            }
          }
        }
        face.loops[li] = newLp;
      }
    }

    ctx.edges.delete(edge.id);
    const e1 = this.ensureEdge(ctx, oldV1, vSplitId, edge);
    const e2 = this.ensureEdge(ctx, vSplitId, oldV2, edge);
    return [e1, e2].filter(Boolean);
  }

  // Split any existing edges that pass through point p
  insertPointAndSplitEdges(ctx, p) {
    const vId = this.findOrCreateVertex(ctx, p);
    const vp = ctx.vertices.get(vId);
    const edgesCopy = Array.from(ctx.edges.values());
    for (const e of edgesCopy) {
      if (e.v1 === vId || e.v2 === vId) continue;
      const a = ctx.vertices.get(e.v1);
      const b = ctx.vertices.get(e.v2);
      if (!a || !b) continue;
      const ab = sub3(b, a);
      const lenSq = dot3(ab, ab);
      if (lenSq < 1e-10) continue;
      const t = dot3(sub3(vp, a), ab) / lenSq;
      if (t > 1e-4 && t < 1 - 1e-4) {
        const proj = add3(a, scale3(ab, t));
        if (dist3(vp, proj) < WELD_EPS * 2) {
          this.splitEdgeAtVertex(ctx, e, vId);
        }
      }
    }
    return vId;
  }

  // Add a line segment with full intersection splitting, face splitting, and auto-face closing
  addLine(ctx, p1, p2, options = {}) {
    if (dist3(p1, p2) < WELD_EPS) return [];
    const vStart = this.insertPointAndSplitEdges(ctx, p1);
    const vEnd = this.insertPointAndSplitEdges(ctx, p2);
    if (vStart === vEnd) return [];

    // Find all existing vertices lying along segment (p1, p2)
    const A = ctx.vertices.get(vStart);
    const B = ctx.vertices.get(vEnd);
    const AB = sub3(B, A);
    const abLenSq = dot3(AB, AB);
    const splits = [{ t: 0, vId: vStart }, { t: 1, vId: vEnd }];

    for (const v of ctx.vertices.values()) {
      if (v.id === vStart || v.id === vEnd) continue;
      const t = dot3(sub3(v, A), AB) / abLenSq;
      if (t > 1e-4 && t < 1 - 1e-4) {
        const proj = add3(A, scale3(AB, t));
        if (dist3(v, proj) < WELD_EPS * 2) {
          splits.push({ t, vId: v.id });
        }
      }
    }

    // Also intersect with coplanar edges!
    const edgesSnapshot = Array.from(ctx.edges.values());
    for (const e of edgesSnapshot) {
      const c = ctx.vertices.get(e.v1);
      const d = ctx.vertices.get(e.v2);
      if (!c || !d) continue;
      const n = cross3(AB, sub3(d, c));
      if (len3(n) < 1e-8) continue; // parallel
      const nUnit = norm3(n);
      // Coplanar check
      if (Math.abs(dot3(sub3(c, A), nUnit)) > WELD_EPS * 3) continue;
      const { u, v } = basisFromNormal(nUnit);
      const a2 = projectToPlane2D([A, B, c, d], A, u, v);
      const hit = segIntersect2D(a2[0], a2[1], a2[2], a2[3], 1e-5);
      if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4 && hit.u > 1e-4 && hit.u < 1 - 1e-4) {
        const ip = add3(A, scale3(AB, hit.t));
        const iv = this.findOrCreateVertex(ctx, ip);
        this.splitEdgeAtVertex(ctx, e, iv);
        splits.push({ t: hit.t, vId: iv });
      }
    }

    splits.sort((a, b) => a.t - b.t);
    const uniqueSplits = [];
    for (const s of splits) {
      if (!uniqueSplits.length || uniqueSplits[uniqueSplits.length - 1].vId !== s.vId) {
        uniqueSplits.push(s);
      }
    }

    const addedEdges = [];
    for (let i = 0; i < uniqueSplits.length - 1; i++) {
      const va = uniqueSplits[i].vId;
      const vb = uniqueSplits[i + 1].vId;
      const e = this.ensureEdge(ctx, va, vb, options);
      if (e) {
        addedEdges.push(e);
        this.trySplitOrCloseFaceWithEdge(ctx, e, options);
      }
    }
    return addedEdges;
  }

  // When an edge connects two vertices of an existing face, split the face;
  // otherwise find a minimal coplanar closed cycle containing this edge to auto-create a face!
  trySplitOrCloseFaceWithEdge(ctx, edge, options = {}) {
    const va = edge.v1;
    const vb = edge.v2;

    // 1. Check if va and vb both lie on the outer loop of an existing face (chord split!)
    const facesSnap = Array.from(ctx.faces.values());
    for (const f of facesSnap) {
      const outer = f.loops[0];
      const ia = outer.indexOf(va);
      const ib = outer.indexOf(vb);
      if (ia !== -1 && ib !== -1) {
        const n = outer.length;
        const adjacent = (ia + 1) % n === ib || (ib + 1) % n === ia;
        if (!adjacent) {
          // Verify midpoint of (va, vb) lies inside face f!
          const pa = ctx.vertices.get(va);
          const pb = ctx.vertices.get(vb);
          const mid = scale3(add3(pa, pb), 0.5);
          const { u, v } = basisFromNormal(f.normal);
          const outerPts = outer.map((id) => ctx.vertices.get(id));
          const outer2D = projectToPlane2D(outerPts, outerPts[0], u, v);
          const mid2D = projectToPlane2D([mid], outerPts[0], u, v)[0];
          if (pointInPoly2D(mid2D, outer2D)) {
            // Split outer loop into two loops!
            const i1 = Math.min(ia, ib);
            const i2 = Math.max(ia, ib);
            const loopA = outer.slice(i1, i2 + 1);
            const loopB = [...outer.slice(i2), ...outer.slice(0, i1 + 1)];

            // Reassign holes to whichever loop contains them
            const holesA = [];
            const holesB = [];
            for (let hi = 1; hi < f.loops.length; hi++) {
              const h = f.loops[hi];
              const hp = ctx.vertices.get(h[0]);
              const hp2 = projectToPlane2D([hp], outerPts[0], u, v)[0];
              const loopA2D = projectToPlane2D(loopA.map((id) => ctx.vertices.get(id)), outerPts[0], u, v);
              if (pointInPoly2D(hp2, loopA2D)) holesA.push(h);
              else holesB.push(h);
            }

            f.loops = [loopA, ...holesA];
            this.recomputeFaceProps(ctx, f);

            const f2 = {
              id: nextId('f'),
              loops: [loopB, ...holesB],
              normal: { ...f.normal },
              materialId: f.materialId,
              backMaterialId: f.backMaterialId,
              layerId: f.layerId,
              area: 0,
            };
            // Ensure consistent winding for f2
            this.alignFaceWinding(ctx, f2, f.normal);
            this.recomputeFaceProps(ctx, f2);
            ctx.faces.set(f2.id, f2);
            return;
          }
        }
      }
    }

    // 2. Auto-face closing: look for shortest coplanar cycle containing edge (va -> ... -> vb)
    const pa = ctx.vertices.get(va);
    const pb = ctx.vertices.get(vb);
    const edgeDir = norm3(sub3(pb, pa));
    const incA = this.getEdgesForVertex(ctx, va).filter((e) => e.id !== edge.id);
    if (incA.length === 0) return;

    // Candidate plane normals from adjacent edges at va
    const testedNormals = [];
    for (const adj of incA) {
      const otherId = adj.v1 === va ? adj.v2 : adj.v1;
      const pc = ctx.vertices.get(otherId);
      const c = cross3(edgeDir, norm3(sub3(pc, pa)));
      if (len3(c) < 1e-4) continue;
      const planeNormal = norm3(c);
      if (testedNormals.some((tn) => Math.abs(dot3(tn, planeNormal)) > 0.999)) continue;
      testedNormals.push(planeNormal);

      // BFS from vb to va using only edges coplanar with (pa, planeNormal), avoiding edge itself
      const planeD = dot3(planeNormal, pa);
      const coplanarNeighbors = (vid) => {
        const res = [];
        for (const e of this.getEdgesForVertex(ctx, vid)) {
          if (e.id === edge.id) continue;
          const nid = e.v1 === vid ? e.v2 : e.v1;
          const np = ctx.vertices.get(nid);
          if (Math.abs(dot3(planeNormal, np) - planeD) < WELD_EPS * 4) {
            res.push(nid);
          }
        }
        return res;
      };

      const queue = [[vb]];
      const visited = new Set([vb]);
      let foundCycle = null;
      while (queue.length > 0) {
        const path = queue.shift();
        if (path.length > 24) break;
        const curr = path[path.length - 1];
        for (const nxt of coplanarNeighbors(curr)) {
          if (nxt === va && path.length >= 2) {
            foundCycle = [...path, va];
            break;
          }
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push([...path, nxt]);
          }
        }
        if (foundCycle) break;
      }

      if (foundCycle && foundCycle.length >= 3) {
        const pts = foundCycle.map((id) => ctx.vertices.get(id));
        const n = computeNewellNormal(pts);
        // Check if an identical face already exists
        const exists = Array.from(ctx.faces.values()).some((f) => {
          const lp = f.loops[0];
          if (lp.length !== foundCycle.length) return false;
          return foundCycle.every((vid) => lp.includes(vid));
        });
        if (!exists) {
          this.createFaceFromLoopIds(ctx, foundCycle, {
            materialId: options.materialId || this.activeMaterialId,
            layerId: options.layerId || this.activeLayerId,
            preferredNormal: Math.abs(n.z) > 0.9 ? { x: 0, y: 0, z: 1 } : n,
          });
        }
      }
    }
  }

  alignFaceWinding(ctx, face, desiredNormal) {
    const pts = face.loops[0].map((id) => ctx.vertices.get(id));
    const n = computeNewellNormal(pts);
    if (dot3(n, desiredNormal) < 0) {
      face.loops[0].reverse();
    }
  }

  createFaceFromLoopIds(ctx, loopIds, options = {}) {
    if (loopIds.length < 3) return null;
    // Register edges
    for (let i = 0; i < loopIds.length; i++) {
      this.ensureEdge(ctx, loopIds[i], loopIds[(i + 1) % loopIds.length], options);
    }
    const pts = loopIds.map((id) => ctx.vertices.get(id));
    let n = computeNewellNormal(pts);
    const orderedIds = [...loopIds];
    if (options.preferredNormal && dot3(n, options.preferredNormal) < 0) {
      orderedIds.reverse();
      n = scale3(n, -1);
    }

    const face = {
      id: nextId('f'),
      loops: [orderedIds],
      normal: n,
      materialId: options.materialId || this.activeMaterialId,
      backMaterialId: options.backMaterialId || 'concrete',
      layerId: options.layerId || this.activeLayerId,
      area: 0,
    };
    this.recomputeFaceProps(ctx, face);
    if (face.area < 1e-7) return null;

    // Check if this new face sits STRICTLY INSIDE an existing coplanar face!
    // If so, punch a hole in that outer face so the new face can be independently Push/Pulled!
    const { u, v } = basisFromNormal(face.normal);
    const newPts = orderedIds.map((id) => ctx.vertices.get(id));
    const newCenter = scale3(newPts.reduce((a, b) => add3(a, b), v3()), 1 / newPts.length);
    const planeD = dot3(face.normal, newPts[0]);

    for (const existing of ctx.faces.values()) {
      if (Math.abs(Math.abs(dot3(existing.normal, face.normal)) - 1) > 1e-3) continue;
      const exOrigin = ctx.vertices.get(existing.loops[0][0]);
      if (!exOrigin) continue;
      if (Math.abs(dot3(face.normal, exOrigin) - planeD) > WELD_EPS * 5) continue;

      const exOuterPts = existing.loops[0].map((id) => ctx.vertices.get(id));
      const ex2D = projectToPlane2D(exOuterPts, exOrigin, u, v);
      const new2D = projectToPlane2D(newPts, exOrigin, u, v);
      const c2D = projectToPlane2D([newCenter], exOrigin, u, v)[0];

      if (pointInPoly2D(c2D, ex2D)) {
        // Check if every vertex of new face is inside or on boundary of existing face, and smaller area
        if (face.area < existing.area - 1e-5 && new2D.every((p) => pointInPoly2D(p, ex2D) || ex2D.some((ep) => Math.hypot(ep.x - p.x, ep.y - p.y) < 1e-3))) {
          // Make sure winding matches existing face normal for consistency
          if (dot3(face.normal, existing.normal) < 0) {
            face.loops[0].reverse();
            this.recomputeFaceProps(ctx, face);
          }
          // Add reversed loop as hole in existing face
          const holeIds = [...face.loops[0]].reverse();
          existing.loops.push(holeIds);
          this.recomputeFaceProps(ctx, existing);
          break;
        }
      }
    }

    ctx.faces.set(face.id, face);
    return face;
  }

  // High-level: Add polygon from 3D points
  addPolygonFace(ctx, points, options = {}) {
    if (points.length < 3) return null;
    const ids = [];
    for (const p of points) {
      const id = this.insertPointAndSplitEdges(ctx, p);
      if (!ids.length || ids[ids.length - 1] !== id) {
        ids.push(id);
      }
    }
    if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length < 3) return null;
    return this.createFaceFromLoopIds(ctx, ids, options);
  }

  // ---- PUSH / PULL (Signature SketchUp Operation!) ----
  pushPullFace(ctx, faceId, distance) {
    const face = ctx.faces.get(faceId);
    if (!face || Math.abs(distance) < 1e-5) return null;

    const normal = { ...face.normal };
    const delta = scale3(normal, distance);

    // Collect all vertices in this face's loops
    const faceVertSet = new Set();
    for (const lp of face.loops) {
      for (const vid of lp) faceVertSet.add(vid);
    }

    // Check if ALL adjacent faces sharing edges with `face` are perpendicular (~90 deg)
    // AND none of `face`'s vertices are shared by any coplanar neighbor face.
    // If true -> pure prism cap translation (like pulling the roof of an existing box taller)!
    let canStretchDirectly = true;
    const adjacentSideFaces = new Set();
    for (const lp of face.loops) {
      for (let i = 0; i < lp.length; i++) {
        const a = lp[i];
        const b = lp[(i + 1) % lp.length];
        const adj = this.getFacesForEdge(ctx, a, b).filter((f) => f.id !== face.id);
        if (adj.length === 0) {
          canStretchDirectly = false;
          break;
        }
        for (const af of adj) {
          if (Math.abs(dot3(af.normal, normal)) > 0.05) {
            canStretchDirectly = false;
            break;
          }
          adjacentSideFaces.add(af);
        }
        if (!canStretchDirectly) break;
      }
      if (!canStretchDirectly) break;
    }

    // Also verify no other face outside adjacentSideFaces shares any vertex with `face`
    if (canStretchDirectly) {
      for (const other of ctx.faces.values()) {
        if (other.id === face.id || adjacentSideFaces.has(other)) continue;
        for (const lp of other.loops) {
          for (const vid of lp) {
            if (faceVertSet.has(vid)) {
              canStretchDirectly = false;
              break;
            }
          }
          if (!canStretchDirectly) break;
        }
        if (!canStretchDirectly) break;
      }
    }

    if (canStretchDirectly) {
      for (const vid of faceVertSet) {
        const v = ctx.vertices.get(vid);
        v.x += delta.x;
        v.y += delta.y;
        v.z += delta.z;
      }
      this.recomputeFaceProps(ctx, face);
      for (const af of adjacentSideFaces) {
        this.recomputeFaceProps(ctx, af);
      }
      this.notify('pushpull');
      return face;
    }

    // Otherwise: Extrude new walls + cap!
    // Check if this face is embedded as a hole in another coplanar face (e.g. window on wall!)
    let hostOuterFace = null;
    let hostHoleIdx = -1;
    for (const f of ctx.faces.values()) {
      if (f.id === face.id) continue;
      for (let hi = 1; hi < f.loops.length; hi++) {
        const h = f.loops[hi];
        if (h.length === face.loops[0].length && h.every((vid) => face.loops[0].includes(vid))) {
          hostOuterFace = f;
          hostHoleIdx = hi;
          break;
        }
      }
      if (hostOuterFace) break;
    }

    // Check for Through-Cut Punching (e.g. pushing a window inward to the opposite wall face)
    if (hostOuterFace && distance < 0) {
      const capCenter = this.getFaceCenter(ctx, face);
      const targetCenter = add3(capCenter, delta);
      const oppositeFace = this.findOppositeCoplanarFaceAtPoint(ctx, targetCenter, normal, face.id);
      if (oppositeFace) {
        // Punch through both faces!
        const newHoleLoop = [];
        for (const vid of face.loops[0]) {
          const p = ctx.vertices.get(vid);
          const tp = add3(p, delta);
          newHoleLoop.push(this.insertPointAndSplitEdges(ctx, tp));
        }
        // Create tunnel reveal faces connecting front hole to back hole
        const origLoop = face.loops[0];
        const n = origLoop.length;
        for (let i = 0; i < n; i++) {
          const a = origLoop[i];
          const b = origLoop[(i + 1) % n];
          const a2 = newHoleLoop[i];
          const b2 = newHoleLoop[(i + 1) % n];
          const quad = [b, a, a2, b2];
          this.createRawFace(ctx, quad, face.materialId, face.layerId);
        }
        // Add hole to opposite face and delete the pushed face!
        const { u, v } = basisFromNormal(oppositeFace.normal);
        const oppOrigin = ctx.vertices.get(oppositeFace.loops[0][0]);
        const newHolePts = newHoleLoop.map((id) => ctx.vertices.get(id));
        const opp2D = projectToPlane2D(newHolePts, oppOrigin, u, v);
        // Hole winding should be opposite to outer loop
        const outerArea = polyArea2D(projectToPlane2D(oppositeFace.loops[0].map((id) => ctx.vertices.get(id)), oppOrigin, u, v));
        const holeArea = polyArea2D(opp2D);
        const finalHole = (outerArea * holeArea > 0) ? [...newHoleLoop].reverse() : newHoleLoop;
        oppositeFace.loops.push(finalHole);
        this.recomputeFaceProps(ctx, oppositeFace);
        ctx.faces.delete(face.id);
        this.notify('pushpull');
        return oppositeFace;
      }
    }

    // Standard Extrusion: Duplicate cap vertices shifted by `delta`, build side quads
    const capMap = new Map();
    const newLoops = face.loops.map((lp) =>
      lp.map((vid) => {
        if (capMap.has(vid)) return capMap.get(vid);
        const p = ctx.vertices.get(vid);
        const np = add3(p, delta);
        const nvid = this.findOrCreateVertex(ctx, np);
        capMap.set(vid, nvid);
        return nvid;
      })
    );

    const sign = distance >= 0 ? 1 : -1;

    // Build side faces for every loop (outer + holes)
    for (let li = 0; li < face.loops.length; li++) {
      const baseLp = face.loops[li];
      const capLp = newLoops[li];
      const len = baseLp.length;
      for (let i = 0; i < len; i++) {
        const a = baseLp[i];
        const b = baseLp[(i + 1) % len];
        const a2 = capLp[i];
        const b2 = capLp[(i + 1) % len];
        const quad = sign > 0 ? [a, b, b2, a2] : [b, a, a2, b2];
        this.createRawFace(ctx, quad, face.materialId, face.layerId);
      }
    }

    // Create cap face
    const capFace = {
      id: nextId('f'),
      loops: newLoops.map((lp) => [...lp]),
      normal: { ...normal },
      materialId: face.materialId,
      backMaterialId: face.backMaterialId,
      layerId: face.layerId,
      area: face.area,
    };
    for (const lp of capFace.loops) {
      for (let i = 0; i < lp.length; i++) {
        this.ensureEdge(ctx, lp[i], lp[(i + 1) % lp.length], { layerId: face.layerId });
      }
    }
    this.recomputeFaceProps(ctx, capFace);
    ctx.faces.set(capFace.id, capFace);

    // Handle original base face:
    // If embedded in a host face and pushed inward (recessed niche) -> delete original face!
    // If standalone flat face -> flip base face normal outward (down) so it forms a watertight solid!
    if (hostOuterFace) {
      ctx.faces.delete(face.id);
    } else {
      // Flip base face if extruded along +normal so solid has outward normals
      if (sign > 0) {
        face.loops.forEach((lp) => lp.reverse());
        this.recomputeFaceProps(ctx, face);
      }
    }

    this.notify('pushpull');
    return capFace;
  }

  createRawFace(ctx, loopIds, materialId, layerId) {
    for (let i = 0; i < loopIds.length; i++) {
      this.ensureEdge(ctx, loopIds[i], loopIds[(i + 1) % loopIds.length], { layerId });
    }
    const f = {
      id: nextId('f'),
      loops: [[...loopIds]],
      normal: { x: 0, y: 0, z: 1 },
      materialId: materialId || this.activeMaterialId,
      backMaterialId: 'concrete',
      layerId: layerId || this.activeLayerId,
      area: 0,
    };
    this.recomputeFaceProps(ctx, f);
    if (f.area > 1e-7) {
      ctx.faces.set(f.id, f);
      return f;
    }
    return null;
  }

  findOppositeCoplanarFaceAtPoint(ctx, pt, refNormal, excludeId) {
    for (const f of ctx.faces.values()) {
      if (f.id === excludeId) continue;
      if (Math.abs(dot3(f.normal, refNormal)) < 0.99) continue;
      const origin = ctx.vertices.get(f.loops[0][0]);
      if (!origin) continue;
      const planeDist = Math.abs(dot3(sub3(pt, origin), f.normal));
      if (planeDist > 0.02) continue;
      const { u, v } = basisFromNormal(f.normal);
      const outer2D = projectToPlane2D(f.loops[0].map((id) => ctx.vertices.get(id)), origin, u, v);
      const pt2D = projectToPlane2D([pt], origin, u, v)[0];
      if (pointInPoly2D(pt2D, outer2D)) return f;
    }
    return null;
  }

  // ---- OFFSET TOOL ----
  offsetFace(ctx, faceId, offsetDist) {
    const face = ctx.faces.get(faceId);
    if (!face || Math.abs(offsetDist) < 1e-4) return null;
    const outerPts = face.loops[0].map((id) => ctx.vertices.get(id));
    const { u, v } = basisFromNormal(face.normal);
    const origin = outerPts[0];
    const outer2D = projectToPlane2D(outerPts, origin, u, v);
    const new2D = offsetPolygon2D(outer2D, offsetDist);
    if (new2D.length < 3 || Math.abs(polyArea2D(new2D)) < 1e-5) return null;

    const newPts3D = new2D.map((p2) =>
      add3(origin, add3(scale3(u, p2.x), scale3(v, p2.y)))
    );
    const newFace = this.addPolygonFace(ctx, newPts3D, {
      materialId: face.materialId,
      layerId: face.layerId,
      preferredNormal: face.normal,
    });
    this.notify('offset');
    return newFace;
  }

  // ---- FOLLOW ME (Sweep a face profile along a path of 3D points) ----
  followMe(ctx, faceId, pathPoints, closed = false) {
    const face = ctx.faces.get(faceId);
    if (!face || pathPoints.length < 2) return [];
    const { u: fu, v: fv, n: fn } = basisFromNormal(face.normal);
    const fOrigin = this.getFaceCenter(ctx, face);
    const profile2D = projectToPlane2D(face.loops[0].map((id) => ctx.vertices.get(id)), fOrigin, fu, fv);

    const rings = [];
    for (let i = 0; i < pathPoints.length; i++) {
      const curr = pathPoints[i];
      let tangent;
      if (i === 0) {
        tangent = closed
          ? norm3(add3(norm3(sub3(pathPoints[1], curr)), norm3(sub3(curr, pathPoints[pathPoints.length - 1]))))
          : norm3(sub3(pathPoints[1], curr));
      } else if (i === pathPoints.length - 1) {
        tangent = closed
          ? norm3(add3(norm3(sub3(pathPoints[0], curr)), norm3(sub3(curr, pathPoints[i - 1]))))
          : norm3(sub3(curr, pathPoints[i - 1]));
      } else {
        const t1 = norm3(sub3(curr, pathPoints[i - 1]));
        const t2 = norm3(sub3(pathPoints[i + 1], curr));
        tangent = norm3(add3(t1, t2));
      }
      const up = Math.abs(tangent.z) < 0.95 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const right = norm3(cross3(tangent, up));
      const realUp = norm3(cross3(right, tangent));
      const ringIds = profile2D.map((p2) => {
        const wp = add3(curr, add3(scale3(right, p2.x), scale3(realUp, p2.y)));
        return this.findOrCreateVertex(ctx, wp);
      });
      rings.push(ringIds);
    }

    const created = [];
    const segCount = closed ? rings.length : rings.length - 1;
    for (let i = 0; i < segCount; i++) {
      const rA = rings[i];
      const rB = rings[(i + 1) % rings.length];
      for (let j = 0; j < rA.length; j++) {
        const jn = (j + 1) % rA.length;
        const f = this.createRawFace(ctx, [rA[j], rA[jn], rB[jn], rB[j]], face.materialId, face.layerId);
        if (f) created.push(f);
      }
    }
    if (!closed && rings.length >= 2) {
      this.createRawFace(ctx, [...rings[0]].reverse(), face.materialId, face.layerId);
      this.createRawFace(ctx, [...rings[rings.length - 1]], face.materialId, face.layerId);
    }
    this.notify('followme');
    return created;
  }

  getFaceCenter(ctx, face) {
    const lp = face.loops[0];
    let c = v3();
    for (const vid of lp) c = add3(c, ctx.vertices.get(vid));
    return scale3(c, 1 / (lp.length || 1));
  }

  // ---- Selection & Entity Queries ----
  deleteSelection() {
    const ctx = this.activeContext;
    if (
      this.selected.faces.size === 0 &&
      this.selected.edges.size === 0 &&
      this.selected.groups.size === 0 &&
      this.selected.dims.size === 0 &&
      this.selected.guides.size === 0 &&
      this.selected.labels.size === 0
    ) {
      return false;
    }
    this.pushUndo('Delete');
    for (const fid of this.selected.faces) ctx.faces.delete(fid);
    for (const eid of this.selected.edges) {
      const e = ctx.edges.get(eid);
      if (e) {
        // Delete any faces using this edge
        const faces = this.getFacesForEdge(ctx, e.v1, e.v2);
        for (const f of faces) ctx.faces.delete(f.id);
        ctx.edges.delete(eid);
      }
    }
    for (const gid of this.selected.groups) ctx.groups.delete(gid);
    this.dimensions = this.dimensions.filter((d) => !this.selected.dims.has(d.id));
    this.guides = this.guides.filter((g) => !this.selected.guides.has(g.id));
    this.labels = this.labels.filter((l) => !this.selected.labels.has(l.id));
    this.pruneOrphanVertices(ctx);
    this.clearSelection();
    this.notify('delete');
    return true;
  }

  pruneOrphanVertices(ctx) {
    const used = new Set();
    for (const e of ctx.edges.values()) {
      used.add(e.v1);
      used.add(e.v2);
    }
    for (const f of ctx.faces.values()) {
      for (const lp of f.loops) for (const vid of lp) used.add(vid);
    }
    for (const vid of Array.from(ctx.vertices.keys())) {
      if (!used.has(vid)) ctx.vertices.delete(vid);
    }
  }

  flipSelectedFaces() {
    const ctx = this.activeContext;
    if (this.selected.faces.size === 0) return false;
    this.pushUndo('Flip Faces');
    for (const fid of this.selected.faces) {
      const f = ctx.faces.get(fid);
      if (f) {
        f.loops.forEach((lp) => lp.reverse());
        this.recomputeFaceProps(ctx, f);
      }
    }
    this.notify('flip');
    return true;
  }

  // Group currently selected faces & edges into a new Group
  groupSelection(name = 'Group') {
    const ctx = this.activeContext;
    if (this.selected.faces.size === 0 && this.selected.edges.size === 0 && this.selected.groups.size === 0) {
      return null;
    }
    this.pushUndo('Group');
    const newCtx = createEmptyContext();
    this.contexts.set(newCtx.id, newCtx);

    const movedVerts = new Map();
    const copyVert = (vid) => {
      if (movedVerts.has(vid)) return movedVerts.get(vid);
      const v = ctx.vertices.get(vid);
      const nid = nextId('v');
      newCtx.vertices.set(nid, { ...v, id: nid });
      movedVerts.set(vid, nid);
      return nid;
    };

    const facesToMove = new Set(this.selected.faces);
    const edgesToMove = new Set(this.selected.edges);

    for (const fid of facesToMove) {
      const f = ctx.faces.get(fid);
      if (!f) continue;
      const newLoops = f.loops.map((lp) => lp.map(copyVert));
      for (const lp of newLoops) {
        for (let i = 0; i < lp.length; i++) {
          this.ensureEdge(newCtx, lp[i], lp[(i + 1) % lp.length], { layerId: f.layerId });
        }
      }
      const nf = {
        ...f,
        id: nextId('f'),
        loops: newLoops,
      };
      newCtx.faces.set(nf.id, nf);
      ctx.faces.delete(fid);
    }

    for (const eid of edgesToMove) {
      const e = ctx.edges.get(eid);
      if (!e) continue;
      // Only delete from parent if no remaining face uses it
      const remFaces = this.getFacesForEdge(ctx, e.v1, e.v2);
      const nv1 = copyVert(e.v1);
      const nv2 = copyVert(e.v2);
      this.ensureEdge(newCtx, nv1, nv2, e);
      if (remFaces.length === 0) ctx.edges.delete(eid);
    }

    for (const gid of this.selected.groups) {
      const g = ctx.groups.get(gid);
      if (g) {
        newCtx.groups.set(g.id, g);
        ctx.groups.delete(gid);
      }
    }

    // Also delete edges from parent that belonged exclusively to moved faces
    for (const e of Array.from(ctx.edges.values())) {
      if (movedVerts.has(e.v1) && movedVerts.has(e.v2)) {
        if (this.getFacesForEdge(ctx, e.v1, e.v2).length === 0 && !edgesToMove.has(e.id)) {
          ctx.edges.delete(e.id);
        }
      }
    }
    this.pruneOrphanVertices(ctx);

    const groupObj = {
      id: nextId('grp'),
      name,
      contextId: newCtx.id,
      matrix: Array.from(mat4Identity()),
      layerId: this.activeLayerId,
      locked: false,
      hidden: false,
    };
    ctx.groups.set(groupObj.id, groupObj);
    this.clearSelection();
    this.selected.groups.add(groupObj.id);
    this.notify('group');
    return groupObj;
  }

  explodeSelectedGroups() {
    const ctx = this.activeContext;
    if (this.selected.groups.size === 0) return false;
    this.pushUndo('Explode Group');
    const newFaces = [];
    for (const gid of Array.from(this.selected.groups)) {
      const g = ctx.groups.get(gid);
      if (!g || g.locked) continue;
      const subCtx = this.contexts.get(g.contextId);
      if (!subCtx) continue;
      const mat = new Float32Array(g.matrix);

      const vMap = new Map();
      for (const v of subCtx.vertices.values()) {
        const tp = mat4TransformPoint(mat, v);
        vMap.set(v.id, this.findOrCreateVertex(ctx, tp));
      }
      for (const e of subCtx.edges.values()) {
        this.ensureEdge(ctx, vMap.get(e.v1), vMap.get(e.v2), e);
      }
      for (const f of subCtx.faces.values()) {
        const nf = {
          ...f,
          id: nextId('f'),
          loops: f.loops.map((lp) => lp.map((vid) => vMap.get(vid))),
        };
        this.recomputeFaceProps(ctx, nf);
        ctx.faces.set(nf.id, nf);
        newFaces.push(nf.id);
      }
      for (const sg of subCtx.groups.values()) {
        const nsg = {
          ...sg,
          id: nextId('grp'),
          matrix: Array.from(mat4Mul(mat, new Float32Array(sg.matrix))),
        };
        ctx.groups.set(nsg.id, nsg);
      }
      ctx.groups.delete(gid);
    }
    this.clearSelection();
    newFaces.forEach((id) => this.selected.faces.add(id));
    this.notify('explode');
    return true;
  }

  // Select all connected faces/edges (SketchUp triple-click!)
  selectConnectedFromFace(ctx, startFaceId) {
    const queue = [startFaceId];
    const visitedFaces = new Set([startFaceId]);
    const visitedEdges = new Set();
    while (queue.length > 0) {
      const fid = queue.shift();
      const f = ctx.faces.get(fid);
      if (!f) continue;
      for (const lp of f.loops) {
        for (let i = 0; i < lp.length; i++) {
          const a = lp[i];
          const b = lp[(i + 1) % lp.length];
          const edge = this.findEdge(ctx, a, b);
          if (edge) visitedEdges.add(edge.id);
          for (const adj of this.getFacesForEdge(ctx, a, b)) {
            if (!visitedFaces.has(adj.id)) {
              visitedFaces.add(adj.id);
              queue.push(adj.id);
            }
          }
        }
      }
    }
    visitedFaces.forEach((id) => this.selected.faces.add(id));
    visitedEdges.forEach((id) => this.selected.edges.add(id));
  }

  // Transform selected vertices / groups by 4x4 matrix (or clone if copy = true!)
  transformSelection(matrix, copy = false) {
    const ctx = this.activeContext;
    if (!copy) {
      // Collect unique vertices from selected faces & edges
      const vIds = new Set();
      for (const fid of this.selected.faces) {
        const f = ctx.faces.get(fid);
        if (f) f.loops.forEach((lp) => lp.forEach((id) => vIds.add(id)));
      }
      for (const eid of this.selected.edges) {
        const e = ctx.edges.get(eid);
        if (e) { vIds.add(e.v1); vIds.add(e.v2); }
      }
      for (const vid of vIds) {
        const v = ctx.vertices.get(vid);
        const tp = mat4TransformPoint(matrix, v);
        v.x = tp.x; v.y = tp.y; v.z = tp.z;
      }
      for (const f of ctx.faces.values()) {
        this.recomputeFaceProps(ctx, f);
      }
      for (const gid of this.selected.groups) {
        const g = ctx.groups.get(gid);
        if (g && !g.locked) {
          g.matrix = Array.from(mat4Mul(matrix, new Float32Array(g.matrix)));
        }
      }
    } else {
      const newFaces = new Set();
      const newEdges = new Set();
      const newGroups = new Set();
      const vCloneMap = new Map();
      const cloneVert = (vid) => {
        if (vCloneMap.has(vid)) return vCloneMap.get(vid);
        const v = ctx.vertices.get(vid);
        const tp = mat4TransformPoint(matrix, v);
        const nid = this.findOrCreateVertex(ctx, tp);
        vCloneMap.set(vid, nid);
        return nid;
      };
      for (const fid of this.selected.faces) {
        const f = ctx.faces.get(fid);
        if (!f) continue;
        const loops = f.loops.map((lp) => lp.map(cloneVert));
        for (const lp of loops) {
          for (let i = 0; i < lp.length; i++) {
            const ne = this.ensureEdge(ctx, lp[i], lp[(i + 1) % lp.length], { layerId: f.layerId });
            if (ne) newEdges.add(ne.id);
          }
        }
        const nf = { ...f, id: nextId('f'), loops };
        this.recomputeFaceProps(ctx, nf);
        ctx.faces.set(nf.id, nf);
        newFaces.add(nf.id);
      }
      for (const eid of this.selected.edges) {
        const e = ctx.edges.get(eid);
        if (!e) continue;
        const ne = this.ensureEdge(ctx, cloneVert(e.v1), cloneVert(e.v2), e);
        if (ne) newEdges.add(ne.id);
      }
      for (const gid of this.selected.groups) {
        const g = ctx.groups.get(gid);
        if (!g) continue;
        // Deep-clone subcontext so copies are independent groups
        const clonedSubCtxId = this.cloneContext(g.contextId);
        const ng = {
          ...g,
          id: nextId('grp'),
          contextId: clonedSubCtxId,
          matrix: Array.from(mat4Mul(matrix, new Float32Array(g.matrix))),
        };
        ctx.groups.set(ng.id, ng);
        newGroups.add(ng.id);
      }
      this.clearSelection();
      newFaces.forEach((id) => this.selected.faces.add(id));
      newEdges.forEach((id) => this.selected.edges.add(id));
      newGroups.forEach((id) => this.selected.groups.add(id));
    }
    this.notify('transform');
  }

  cloneContext(srcCtxId) {
    const src = this.contexts.get(srcCtxId);
    const dst = createEmptyContext();
    this.contexts.set(dst.id, dst);
    for (const [k, v] of src.vertices) dst.vertices.set(k, { ...v });
    for (const [k, e] of src.edges) dst.edges.set(k, { ...e });
    for (const [k, f] of src.faces) dst.faces.set(k, { ...f, loops: f.loops.map((lp) => [...lp]) });
    for (const [k, g] of src.groups) {
      const subId = this.cloneContext(g.contextId);
      dst.groups.set(k, { ...g, contextId: subId, matrix: [...g.matrix] });
    }
    return dst.id;
  }

  // Triangulate a face into world/context triangles
  triangulateFace(ctx, face) {
    if (!face.loops.length || face.loops[0].length < 3) return [];
    const outerPts = face.loops[0].map((id) => ctx.vertices.get(id)).filter(Boolean);
    if (outerPts.length < 3) return [];
    const origin = outerPts[0];
    const { u, v, n } = basisFromNormal(face.normal);
    const outer2D = projectToPlane2D(outerPts, origin, u, v);
    const holes2D = [];
    for (let i = 1; i < face.loops.length; i++) {
      const hp = face.loops[i].map((id) => ctx.vertices.get(id)).filter(Boolean);
      if (hp.length >= 3) holes2D.push(projectToPlane2D(hp, origin, u, v));
    }
    const { vertices, indices } = triangulatePolygon2D(outer2D, holes2D);
    const pts3D = vertices.map((p2) => add3(origin, add3(scale3(u, p2.x), scale3(v, p2.y))));
    return { pts3D, uvs: vertices, indices, normal: n };
  }

  // Compute bounding box and architectural quantities across the entire document
  computeSceneMetrics() {
    let min = v3(Infinity, Infinity, Infinity);
    let max = v3(-Infinity, -Infinity, -Infinity);
    let totalFaceArea = 0;
    let floorArea = 0;
    let wallArea = 0;
    let roofArea = 0;
    let totalEdgeLength = 0;
    let faceCount = 0;
    let edgeCount = 0;
    let groupCount = 0;

    const visitCtx = (ctxId, mat) => {
      const ctx = this.contexts.get(ctxId);
      if (!ctx) return;
      for (const v of ctx.vertices.values()) {
        const wp = mat4TransformPoint(mat, v);
        min.x = Math.min(min.x, wp.x); min.y = Math.min(min.y, wp.y); min.z = Math.min(min.z, wp.z);
        max.x = Math.max(max.x, wp.x); max.y = Math.max(max.y, wp.y); max.z = Math.max(max.z, wp.z);
      }
      for (const e of ctx.edges.values()) {
        if (!this.isLayerVisible(e.layerId)) continue;
        const a = mat4TransformPoint(mat, ctx.vertices.get(e.v1));
        const b = mat4TransformPoint(mat, ctx.vertices.get(e.v2));
        totalEdgeLength += dist3(a, b);
        edgeCount++;
      }
      for (const f of ctx.faces.values()) {
        if (!this.isLayerVisible(f.layerId)) continue;
        faceCount++;
        const wn = norm3(mat4TransformDir(mat, f.normal));
        // Scale factor approx
        const sx = len3(mat4TransformDir(mat, { x: 1, y: 0, z: 0 }));
        const area = (f.area || 0) * sx * sx;
        totalFaceArea += area;
        if (wn.z > 0.85) {
          if (f.layerId === 'layer_roof' || f.materialId === 'zinc' || f.materialId === 'terracotta') {
            roofArea += area;
          } else if (f.layerId !== 'layer_site') {
            floorArea += area;
          }
        } else if (Math.abs(wn.z) < 0.25) {
          wallArea += area;
        }
      }
      for (const g of ctx.groups.values()) {
        if (g.hidden || !this.isLayerVisible(g.layerId)) continue;
        groupCount++;
        visitCtx(g.contextId, mat4Mul(mat, new Float32Array(g.matrix)));
      }
    };

    visitCtx(this.rootContextId, mat4Identity());
    if (!isFinite(min.x)) {
      min = v3(-5, -5, 0);
      max = v3(5, 5, 3);
    }
    return {
      min, max,
      totalFaceArea, floorArea, wallArea, roofArea,
      totalEdgeLength, faceCount, edgeCount, groupCount,
    };
  }
}
