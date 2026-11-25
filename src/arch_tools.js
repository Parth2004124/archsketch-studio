import {
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
  mat4RotationAxis,
  mat4Mul,
  offsetPolygon2D,
} from './math.js';
import { createEmptyContext, nextId } from './kernel.js';

// Helper: add an axis-aligned or oriented box into a context
export function addBox(ctx, doc, cx, cy, cz, sx, sy, sz, materialId, layerId, rotZ = 0) {
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const c = Math.cos(rotZ);
  const s = Math.sin(rotZ);
  const rotPt = (lx, ly, lz) => ({
    x: cx + lx * c - ly * s,
    y: cy + lx * s + ly * c,
    z: cz + lz,
  });

  const b0 = doc.findOrCreateVertex(ctx, rotPt(-hx, -hy, 0));
  const b1 = doc.findOrCreateVertex(ctx, rotPt(hx, -hy, 0));
  const b2 = doc.findOrCreateVertex(ctx, rotPt(hx, hy, 0));
  const b3 = doc.findOrCreateVertex(ctx, rotPt(-hx, hy, 0));

  const t0 = doc.findOrCreateVertex(ctx, rotPt(-hx, -hy, sz));
  const t1 = doc.findOrCreateVertex(ctx, rotPt(hx, -hy, sz));
  const t2 = doc.findOrCreateVertex(ctx, rotPt(hx, hy, sz));
  const t3 = doc.findOrCreateVertex(ctx, rotPt(-hx, hy, sz));

  const faces = [
    [b3, b2, b1, b0], // bottom
    [t0, t1, t2, t3], // top
    [b0, b1, t1, t0], // front
    [b1, b2, t2, t1], // right
    [b2, b3, t3, t2], // back
    [b3, b0, t0, t3], // left
  ];
  for (const quad of faces) {
    doc.createRawFace(ctx, quad, materialId, layerId);
  }
}

export function addPrism(ctx, doc, pts2D, z0, height, materialId, layerId, softSides = false) {
  if (pts2D.length < 3 || Math.abs(height) < 1e-5) return;
  const botIds = pts2D.map((p) => doc.findOrCreateVertex(ctx, { x: p.x, y: p.y, z: z0 }));
  const topIds = pts2D.map((p) => doc.findOrCreateVertex(ctx, { x: p.x, y: p.y, z: z0 + height }));
  const n = pts2D.length;

  // Ensure CCW for top
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts2D[i], b = pts2D[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const ccw = area >= 0;
  const bLoop = ccw ? botIds : [...botIds].reverse();
  const tLoop = ccw ? topIds : [...topIds].reverse();

  doc.createRawFace(ctx, [...bLoop].reverse(), materialId, layerId);
  doc.createRawFace(ctx, [...tLoop], materialId, layerId);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    doc.createRawFace(ctx, [bLoop[i], bLoop[j], tLoop[j], tLoop[i]], materialId, layerId);
    if (softSides) {
      const e = doc.findEdge(ctx, bLoop[i], tLoop[i]);
      if (e) e.soft = true;
    }
  }
}

export function addCylinder(ctx, doc, cx, cy, z0, radius, height, segments = 16, materialId, layerId) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  addPrism(ctx, doc, pts, z0, height, materialId, layerId, true);
}

// Helper to wrap builder into a Group placed at (x, y, z) with rotation rotZ
export function createComponentGroup(doc, name, layerId, buildFn, matrix = null) {
  const targetCtx = doc.activeContext;
  const newCtx = createEmptyContext();
  doc.contexts.set(newCtx.id, newCtx);
  buildFn(newCtx);
  const grp = {
    id: nextId('grp'),
    name,
    contextId: newCtx.id,
    matrix: Array.from(matrix || mat4Identity()),
    layerId: layerId || doc.activeLayerId,
    locked: false,
    hidden: false,
  };
  targetCtx.groups.set(grp.id, grp);
  return grp;
}

// ---- 1. PARAMETRIC ARCHITECTURAL WALL CHAIN ----
export function buildWallChain(doc, points, options = {}) {
  if (points.length < 2) return null;
  const thickness = options.thickness ?? 0.22;
  const height = options.height ?? 3.0;
  const align = options.alignment || 'center'; // 'center' | 'left' | 'right'
  const materialId = options.materialId || 'plaster';
  const layerId = options.layerId || 'layer_walls_1';
  const closed = !!options.closed;

  const baseZ = points[0].z || 0;
  const leftPts = [];
  const rightPts = [];

  const getOffsetOffsets = () => {
    if (align === 'left') return { l: 0, r: -thickness };
    if (align === 'right') return { l: thickness, r: 0 };
    return { l: thickness * 0.5, r: -thickness * 0.5 };
  };
  const { l: offL, r: offR } = getOffsetOffsets();

  const n = points.length;
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    let dirPrev = null;
    let dirNext = null;
    if (i > 0 || closed) {
      const prev = points[(i - 1 + n) % n];
      dirPrev = norm3({ x: curr.x - prev.x, y: curr.y - prev.y, z: 0 });
    }
    if (i < n - 1 || closed) {
      const next = points[(i + 1) % n];
      dirNext = norm3({ x: next.x - curr.x, y: next.y - curr.y, z: 0 });
    }

    let nx, ny, miterScale = 1;
    if (!dirPrev) {
      nx = -dirNext.y; ny = dirNext.x;
    } else if (!dirNext) {
      nx = -dirPrev.y; ny = dirPrev.x;
    } else {
      const n1 = { x: -dirPrev.y, y: dirPrev.x };
      const n2 = { x: -dirNext.y, y: dirNext.x };
      const bx = n1.x + n2.x;
      const by = n1.y + n2.y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-4) {
        nx = n1.x; ny = n1.y;
      } else {
        nx = bx / bl; ny = by / bl;
        const cosH = Math.max(0.35, nx * n1.x + ny * n1.y);
        miterScale = 1 / cosH;
      }
    }
    leftPts.push({ x: curr.x + nx * offL * miterScale, y: curr.y + ny * offL * miterScale });
    rightPts.push({ x: curr.x + nx * offR * miterScale, y: curr.y + ny * offR * miterScale });
  }

  const ctx = doc.activeContext;
  if (closed) {
    // Outer ring + inner hole ring
    const outerLoop = leftPts.map((p) => ({ x: p.x, y: p.y, z: baseZ }));
    const innerLoop = [...rightPts].reverse().map((p) => ({ x: p.x, y: p.y, z: baseZ }));
    // Use prism approach: outer top/bot, inner top/bot, and hollow cap faces
    const botOut = outerLoop.map((p) => doc.findOrCreateVertex(ctx, p));
    const topOut = outerLoop.map((p) => doc.findOrCreateVertex(ctx, { ...p, z: baseZ + height }));
    const botIn = innerLoop.map((p) => doc.findOrCreateVertex(ctx, p));
    const topIn = innerLoop.map((p) => doc.findOrCreateVertex(ctx, { ...p, z: baseZ + height }));

    const fBot = {
      id: nextId('f'),
      loops: [[...botOut].reverse(), [...botIn].reverse()],
      normal: { x: 0, y: 0, z: -1 },
      materialId, backMaterialId: 'concrete', layerId, area: 0,
    };
    const fTop = {
      id: nextId('f'),
      loops: [topOut, topIn],
      normal: { x: 0, y: 0, z: 1 },
      materialId, backMaterialId: 'concrete', layerId, area: 0,
    };
    for (const lp of [...fBot.loops, ...fTop.loops]) {
      for (let i = 0; i < lp.length; i++) doc.ensureEdge(ctx, lp[i], lp[(i + 1) % lp.length], { layerId });
    }
    doc.recomputeFaceProps(ctx, fBot);
    doc.recomputeFaceProps(ctx, fTop);
    ctx.faces.set(fBot.id, fBot);
    ctx.faces.set(fTop.id, fTop);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      doc.createRawFace(ctx, [botOut[i], botOut[j], topOut[j], topOut[i]], materialId, layerId);
      doc.createRawFace(ctx, [botIn[i], botIn[j], topIn[j], topIn[i]], materialId, layerId);
    }
  } else {
    const footprint = [...leftPts, ...[...rightPts].reverse()];
    addPrism(ctx, doc, footprint, baseZ, height, materialId, layerId, false);
  }
  doc.notify('wall');
  return true;
}

// ---- 2. PARAMETRIC STAIRCASE GENERATOR ----
export function buildStaircaseGroup(doc, origin, options = {}) {
  const type = options.type || 'straight'; // 'straight' | 'l_shape' | 'u_shape'
  const totalRise = options.totalRise ?? 3.0;
  const width = options.width ?? 1.2;
  const treadDepth = options.treadDepth ?? 0.28;
  const riserTarget = options.riserHeight ?? 0.175;
  const includeRail = options.includeRailings !== false;
  const stepMat = options.stepMaterial || 'oak';
  const railMat = options.railMaterial || 'steel';
  const glassMat = 'glass';
  const layerId = 'layer_stairs';

  const totalSteps = Math.max(3, Math.round(totalRise / riserTarget));
  const actualRiser = totalRise / totalSteps;

  return createComponentGroup(doc, `Staircase (${type})`, layerId, (ctx) => {
    const buildRun = (startIdx, count, startX, startY, startZ, dirX, dirY) => {
      // dir is unit vector in XY along run direction
      const perpX = -dirY;
      const perpY = dirX;
      for (let i = 0; i < count; i++) {
        const zBot = startZ + i * actualRiser;
        const zTop = zBot + actualRiser;
        const cx = startX + dirX * (i + 0.5) * treadDepth;
        const cy = startY + dirY * (i + 0.5) * treadDepth;
        const rotZ = Math.atan2(dirY, dirX);
        // Solid step tread+riser block
        addBox(ctx, doc, cx, cy, zBot, treadDepth + 0.02, width, actualRiser, stepMat, layerId, rotZ);

        // Railing posts every 3 steps or ends
        if (includeRail && (i === 0 || i === count - 1 || i % 3 === 0)) {
          for (const side of [-1, 1]) {
            const px = cx + perpX * side * (width * 0.5 - 0.04);
            const py = cy + perpY * side * (width * 0.5 - 0.04);
            addBox(ctx, doc, px, py, zTop, 0.04, 0.04, 0.92, railMat, layerId, rotZ);
          }
        }
      }

      // Sloped handrail & glass balustrade along both sides
      if (includeRail && count >= 2) {
        const lenRun = count * treadDepth;
        const runRise = count * actualRiser;
        for (const side of [-1, 1]) {
          const sx0 = startX + perpX * side * (width * 0.5 - 0.04);
          const sy0 = startY + perpY * side * (width * 0.5 - 0.04);
          const sx1 = sx0 + dirX * lenRun;
          const sy1 = sy0 + dirY * lenRun;
          const sz0 = startZ + actualRiser + 0.92;
          const sz1 = startZ + runRise + 0.92;

          // Handrail bar as inclined prism
          const railW = 0.025;
          const pA = { x: sx0 - perpX * railW, y: sy0 - perpY * railW, z: sz0 };
          const pB = { x: sx0 + perpX * railW, y: sy0 + perpY * railW, z: sz0 };
          const pC = { x: sx1 + perpX * railW, y: sy1 + perpY * railW, z: sz1 };
          const pD = { x: sx1 - perpX * railW, y: sy1 - perpY * railW, z: sz1 };
          const hThick = 0.045;
          const vIds = [
            doc.findOrCreateVertex(ctx, pA), doc.findOrCreateVertex(ctx, pB),
            doc.findOrCreateVertex(ctx, pC), doc.findOrCreateVertex(ctx, pD),
            doc.findOrCreateVertex(ctx, { ...pA, z: pA.z + hThick }), doc.findOrCreateVertex(ctx, { ...pB, z: pB.z + hThick }),
            doc.findOrCreateVertex(ctx, { ...pC, z: pC.z + hThick }), doc.findOrCreateVertex(ctx, { ...pD, z: pD.z + hThick }),
          ];
          doc.createRawFace(ctx, [vIds[4], vIds[5], vIds[6], vIds[7]], railMat, layerId);
          doc.createRawFace(ctx, [vIds[3], vIds[2], vIds[1], vIds[0]], railMat, layerId);
          doc.createRawFace(ctx, [vIds[0], vIds[1], vIds[5], vIds[4]], railMat, layerId);
          doc.createRawFace(ctx, [vIds[1], vIds[2], vIds[6], vIds[5]], railMat, layerId);
          doc.createRawFace(ctx, [vIds[2], vIds[3], vIds[7], vIds[6]], railMat, layerId);
          doc.createRawFace(ctx, [vIds[3], vIds[0], vIds[4], vIds[7]], railMat, layerId);

          // Glass infill panel
          const gIds = [
            doc.findOrCreateVertex(ctx, { x: sx0, y: sy0, z: startZ + actualRiser + 0.12 }),
            doc.findOrCreateVertex(ctx, { x: sx1, y: sy1, z: startZ + runRise + 0.12 }),
            doc.findOrCreateVertex(ctx, { x: sx1, y: sy1, z: sz1 - 0.03 }),
            doc.findOrCreateVertex(ctx, { x: sx0, y: sy0, z: sz0 - 0.03 }),
          ];
          doc.createRawFace(ctx, gIds, glassMat, layerId);
        }
      }
    };

    if (type === 'straight') {
      buildRun(0, totalSteps, 0, 0, 0, 1, 0);
    } else if (type === 'l_shape') {
      const half = Math.floor(totalSteps / 2);
      const rem = totalSteps - half;
      buildRun(0, half, 0, 0, 0, 1, 0);
      const lx = half * treadDepth + width * 0.5;
      const lz = half * actualRiser;
      addBox(ctx, doc, lx, 0, lz - actualRiser, width, width, actualRiser, stepMat, layerId, 0);
      buildRun(half, rem, lx, width * 0.5, lz, 0, 1);
    } else {
      // U-shape
      const half = Math.floor(totalSteps / 2);
      const rem = totalSteps - half;
      buildRun(0, half, 0, 0, 0, 1, 0);
      const lx = half * treadDepth + width * 0.5;
      const lz = half * actualRiser;
      const gap = 0.15;
      addBox(ctx, doc, lx, (width + gap) * 0.5, lz - actualRiser, width, width * 2 + gap, actualRiser, stepMat, layerId, 0);
      buildRun(half, rem, half * treadDepth, width + gap, lz, -1, 0);
    }
  }, mat4Translation(origin.x, origin.y, origin.z));
}

// ---- 3. PARAMETRIC ARCHITECTURAL ROOF GENERATOR ----
export function buildRoofGroup(doc, origin, options = {}) {
  const type = options.type || 'gable'; // 'gable' | 'hip' | 'shed' | 'flat_parapet'
  const width = options.width ?? 8.0;    // X dimension
  const depth = options.depth ?? 6.0;    // Y dimension
  const pitchDeg = options.pitchDeg ?? 28;
  const overhang = options.overhang ?? 0.5;
  const fascia = options.fascia ?? 0.22;
  const roofMat = options.roofMaterial || 'zinc';
  const soffitMat = options.soffitMaterial || 'cedar';
  const layerId = 'layer_roof';

  const W = width + overhang * 2;
  const D = depth + overhang * 2;
  const hw = W * 0.5;
  const hd = D * 0.5;
  const tanP = Math.tan((pitchDeg * Math.PI) / 180);

  return createComponentGroup(doc, `Roof (${type})`, layerId, (ctx) => {
    if (type === 'gable') {
      const ridgeH = hd * tanP;
      // Left-to-right ridge along X at y = 0
      const e0 = doc.findOrCreateVertex(ctx, v3(-hw, -hd, 0));
      const e1 = doc.findOrCreateVertex(ctx, v3(hw, -hd, 0));
      const e2 = doc.findOrCreateVertex(ctx, v3(hw, hd, 0));
      const e3 = doc.findOrCreateVertex(ctx, v3(-hw, hd, 0));
      const r0 = doc.findOrCreateVertex(ctx, v3(-hw, 0, ridgeH));
      const r1 = doc.findOrCreateVertex(ctx, v3(hw, 0, ridgeH));

      const t_e0 = doc.findOrCreateVertex(ctx, v3(-hw, -hd, fascia));
      const t_e1 = doc.findOrCreateVertex(ctx, v3(hw, -hd, fascia));
      const t_e2 = doc.findOrCreateVertex(ctx, v3(hw, hd, fascia));
      const t_e3 = doc.findOrCreateVertex(ctx, v3(-hw, hd, fascia));
      const t_r0 = doc.findOrCreateVertex(ctx, v3(-hw, 0, ridgeH + fascia));
      const t_r1 = doc.findOrCreateVertex(ctx, v3(hw, 0, ridgeH + fascia));

      // Top roof slopes
      doc.createRawFace(ctx, [t_e0, t_e1, t_r1, t_r0], roofMat, layerId);
      doc.createRawFace(ctx, [t_r0, t_r1, t_e2, t_e3], roofMat, layerId);
      // Soffit underside
      doc.createRawFace(ctx, [e1, e0, r0, r1], soffitMat, layerId);
      doc.createRawFace(ctx, [r1, r0, e3, e2], soffitMat, layerId);
      // Eave fascias & gable end fascias
      doc.createRawFace(ctx, [e0, e1, t_e1, t_e0], soffitMat, layerId);
      doc.createRawFace(ctx, [e2, e3, t_e3, t_e2], soffitMat, layerId);
      doc.createRawFace(ctx, [e3, r0, t_r0, t_e3], soffitMat, layerId);
      doc.createRawFace(ctx, [r0, e0, t_e0, t_r0], soffitMat, layerId);
      doc.createRawFace(ctx, [e1, r1, t_r1, t_e1], soffitMat, layerId);
      doc.createRawFace(ctx, [r1, e2, t_e2, t_r1], soffitMat, layerId);
      // Gable infill triangles
      const g0 = doc.findOrCreateVertex(ctx, v3(-hw + overhang, -hd + overhang, 0));
      const g1 = doc.findOrCreateVertex(ctx, v3(-hw + overhang, hd - overhang, 0));
      const gr0 = doc.findOrCreateVertex(ctx, v3(-hw + overhang, 0, (hd - overhang) * tanP));
      doc.createRawFace(ctx, [g1, g0, gr0], 'plaster', layerId);
      const g2 = doc.findOrCreateVertex(ctx, v3(hw - overhang, -hd + overhang, 0));
      const g3 = doc.findOrCreateVertex(ctx, v3(hw - overhang, hd - overhang, 0));
      const gr1 = doc.findOrCreateVertex(ctx, v3(hw - overhang, 0, (hd - overhang) * tanP));
      doc.createRawFace(ctx, [g2, g3, gr1], 'plaster', layerId);
    } else if (type === 'hip') {
      const span = Math.min(hw, hd);
      const ridgeH = span * tanP;
      const rx = Math.max(0.05, hw - span);
      const e0 = doc.findOrCreateVertex(ctx, v3(-hw, -hd, 0));
      const e1 = doc.findOrCreateVertex(ctx, v3(hw, -hd, 0));
      const e2 = doc.findOrCreateVertex(ctx, v3(hw, hd, 0));
      const e3 = doc.findOrCreateVertex(ctx, v3(-hw, hd, 0));
      const r0 = doc.findOrCreateVertex(ctx, v3(-rx, 0, ridgeH));
      const r1 = doc.findOrCreateVertex(ctx, v3(rx, 0, ridgeH));

      const t_e0 = doc.findOrCreateVertex(ctx, v3(-hw, -hd, fascia));
      const t_e1 = doc.findOrCreateVertex(ctx, v3(hw, -hd, fascia));
      const t_e2 = doc.findOrCreateVertex(ctx, v3(hw, hd, fascia));
      const t_e3 = doc.findOrCreateVertex(ctx, v3(-hw, hd, fascia));
      const t_r0 = doc.findOrCreateVertex(ctx, v3(-rx, 0, ridgeH + fascia));
      const t_r1 = doc.findOrCreateVertex(ctx, v3(rx, 0, ridgeH + fascia));

      doc.createRawFace(ctx, [t_e0, t_e1, t_r1, t_r0], roofMat, layerId);
      doc.createRawFace(ctx, [t_e1, t_e2, t_r1], roofMat, layerId);
      doc.createRawFace(ctx, [t_e2, t_e3, t_r0, t_r1], roofMat, layerId);
      doc.createRawFace(ctx, [t_e3, t_e0, t_r0], roofMat, layerId);

      doc.createRawFace(ctx, [e1, e0, r0, r1], soffitMat, layerId);
      doc.createRawFace(ctx, [e2, e1, r1], soffitMat, layerId);
      doc.createRawFace(ctx, [e3, e2, r1, r0], soffitMat, layerId);
      doc.createRawFace(ctx, [e0, e3, r0], soffitMat, layerId);

      doc.createRawFace(ctx, [e0, e1, t_e1, t_e0], soffitMat, layerId);
      doc.createRawFace(ctx, [e1, e2, t_e2, t_e1], soffitMat, layerId);
      doc.createRawFace(ctx, [e2, e3, t_e3, t_e2], soffitMat, layerId);
      doc.createRawFace(ctx, [e3, e0, t_e0, t_e3], soffitMat, layerId);
    } else if (type === 'shed') {
      const highZ = D * tanP;
      const b = [
        doc.findOrCreateVertex(ctx, v3(-hw, -hd, 0)),
        doc.findOrCreateVertex(ctx, v3(hw, -hd, 0)),
        doc.findOrCreateVertex(ctx, v3(hw, hd, highZ)),
        doc.findOrCreateVertex(ctx, v3(-hw, hd, highZ)),
      ];
      const t = [
        doc.findOrCreateVertex(ctx, v3(-hw, -hd, fascia)),
        doc.findOrCreateVertex(ctx, v3(hw, -hd, fascia)),
        doc.findOrCreateVertex(ctx, v3(hw, hd, highZ + fascia)),
        doc.findOrCreateVertex(ctx, v3(-hw, hd, highZ + fascia)),
      ];
      doc.createRawFace(ctx, [t[0], t[1], t[2], t[3]], roofMat, layerId);
      doc.createRawFace(ctx, [b[3], b[2], b[1], b[0]], soffitMat, layerId);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        doc.createRawFace(ctx, [b[i], b[j], t[j], t[i]], soffitMat, layerId);
      }
    } else {
      // Flat parapet roof slab + parapet coping
      addBox(ctx, doc, 0, 0, 0, W, D, fascia, roofMat, layerId, 0);
      const pw = 0.22;
      const ph = 0.45;
      addBox(ctx, doc, 0, -hd + pw * 0.5, fascia, W, pw, ph, 'plaster', layerId, 0);
      addBox(ctx, doc, 0, hd - pw * 0.5, fascia, W, pw, ph, 'plaster', layerId, 0);
      addBox(ctx, doc, -hw + pw * 0.5, 0, fascia, pw, D - pw * 2, ph, 'plaster', layerId, 0);
      addBox(ctx, doc, hw - pw * 0.5, 0, fascia, pw, D - pw * 2, ph, 'plaster', layerId, 0);
    }
  }, mat4Translation(origin.x, origin.y, origin.z));
}

// ---- 4. ARCHITECTURAL DOORS, WINDOWS, COLUMNS, & ENTOURAGE ----
export function buildDoorComponent(doc, origin, rotZ = 0, variant = 'single') {
  const layerId = 'layer_openings';
  const w = variant === 'double' ? 1.8 : variant === 'sliding' ? 2.6 : 0.96;
  const h = variant === 'sliding' ? 2.4 : 2.15;
  const frameT = 0.06;
  const depth = 0.16;

  const mat = mat4Mul(mat4Translation(origin.x, origin.y, origin.z), mat4RotationAxis({ x: 0, y: 0, z: 1 }, rotZ));
  return createComponentGroup(doc, `Door (${variant})`, layerId, (ctx) => {
    // Jambs & Header
    addBox(ctx, doc, -w * 0.5 + frameT * 0.5, 0, 0, frameT, depth, h, 'steel', layerId);
    addBox(ctx, doc, w * 0.5 - frameT * 0.5, 0, 0, frameT, depth, h, 'steel', layerId);
    addBox(ctx, doc, 0, 0, h - frameT, w, depth, frameT, 'steel', layerId);

    if (variant === 'single') {
      // Slightly ajar door leaf (30 deg) for visual depth + handle
      const leafW = w - frameT * 2;
      const openAngle = 0.45;
      const cx = -leafW * 0.5 + Math.cos(openAngle) * leafW * 0.5;
      const cy = Math.sin(openAngle) * leafW * 0.5;
      addBox(ctx, doc, cx, cy, 0, leafW, 0.045, h - frameT, 'oak', layerId, openAngle);
      // 90 deg architectural swing arc edge on floor!
      const arcSegs = 12;
      let prev = null;
      const hingeX = -leafW * 0.5;
      for (let i = 0; i <= arcSegs; i++) {
        const a = (i / arcSegs) * Math.PI * 0.5;
        const p = v3(hingeX + Math.cos(a) * leafW, Math.sin(a) * leafW, 0.005);
        if (prev) {
          const e = doc.ensureEdge(ctx, doc.findOrCreateVertex(ctx, prev), doc.findOrCreateVertex(ctx, p), { layerId });
          if (e) e.soft = true;
        }
        prev = p;
      }
    } else if (variant === 'double') {
      const leafW = (w - frameT * 2) * 0.5 - 0.01;
      addBox(ctx, doc, -leafW * 0.5 - 0.005, 0, 0, leafW, 0.045, h - frameT, 'oak', layerId);
      addBox(ctx, doc, leafW * 0.5 + 0.005, 0, 0, leafW, 0.045, h - frameT, 'oak', layerId);
      addBox(ctx, doc, -leafW * 0.5 - 0.005, 0, 0.25, leafW - 0.24, 0.055, h - 0.5, 'glass', layerId);
      addBox(ctx, doc, leafW * 0.5 + 0.005, 0, 0.25, leafW - 0.24, 0.055, h - 0.5, 'glass', layerId);
    } else {
      // Sliding glass patio door
      const pw = (w - frameT * 2) * 0.52;
      addBox(ctx, doc, -w * 0.24, -0.025, 0.02, pw, 0.04, h - frameT - 0.02, 'glass', layerId);
      addBox(ctx, doc, w * 0.24, 0.025, 0.02, pw, 0.04, h - frameT - 0.02, 'glass', layerId);
      addBox(ctx, doc, 0, 0, 0, w, depth, 0.04, 'aluminum', layerId);
    }
  }, mat);
}

export function buildWindowComponent(doc, origin, rotZ = 0, variant = 'picture') {
  const layerId = 'layer_openings';
  const w = variant === 'curtain' ? 4.2 : variant === 'casement' ? 1.6 : 2.2;
  const h = variant === 'curtain' ? 2.8 : 1.4;
  const sillZ = variant === 'curtain' ? 0 : 0.9;
  const frame = 0.05;
  const depth = 0.14;

  const mat = mat4Mul(mat4Translation(origin.x, origin.y, origin.z), mat4RotationAxis({ x: 0, y: 0, z: 1 }, rotZ));
  return createComponentGroup(doc, `Window (${variant})`, layerId, (ctx) => {
    // Sill & Frame
    addBox(ctx, doc, 0, 0, sillZ, w + 0.08, depth + 0.06, 0.05, 'limestone', layerId);
    addBox(ctx, doc, 0, 0, sillZ + h - frame, w, depth, frame, 'steel', layerId);
    addBox(ctx, doc, -w * 0.5 + frame * 0.5, 0, sillZ + 0.05, frame, depth, h - 0.05, 'steel', layerId);
    addBox(ctx, doc, w * 0.5 - frame * 0.5, 0, sillZ + 0.05, frame, depth, h - 0.05, 'steel', layerId);

    if (variant === 'casement') {
      addBox(ctx, doc, 0, 0, sillZ + 0.05, 0.04, depth * 0.8, h - 0.05, 'steel', layerId);
    } else if (variant === 'curtain') {
      for (const mx of [-w * 0.25, 0, w * 0.25]) {
        addBox(ctx, doc, mx, 0, sillZ + 0.05, 0.05, depth * 0.9, h - 0.05, 'steel', layerId);
      }
      addBox(ctx, doc, 0, 0, sillZ + h * 0.68, w, depth * 0.85, 0.05, 'steel', layerId);
    }
    // Glazing pane
    addBox(ctx, doc, 0, 0, sillZ + 0.05, w - frame * 2, 0.02, h - frame - 0.05, 'glass', layerId);
  }, mat);
}

export function buildColumnComponent(doc, origin, variant = 'round') {
  const layerId = 'layer_stairs';
  const h = 3.2;
  return createComponentGroup(doc, `Column (${variant})`, layerId, (ctx) => {
    if (variant === 'round') {
      addCylinder(ctx, doc, 0, 0, 0, 0.18, h, 16, 'concrete', layerId);
    } else if (variant === 'ibeam') {
      // Steel I-Beam
      addBox(ctx, doc, 0, -0.11, 0, 0.22, 0.025, h, 'steel', layerId);
      addBox(ctx, doc, 0, 0.11, 0, 0.22, 0.025, h, 'steel', layerId);
      addBox(ctx, doc, 0, 0, 0, 0.022, 0.20, h, 'steel', layerId);
    } else {
      addBox(ctx, doc, 0, 0, 0, 0.35, 0.35, h, 'concrete', layerId);
    }
  }, mat4Translation(origin.x, origin.y, origin.z));
}

// Architectural Scale Silhouette Figure (1.75m tall!)
export function buildScalePersonGroup(doc, origin, rotZ = 0) {
  const layerId = 'layer_entourage';
  const mat = mat4Mul(mat4Translation(origin.x, origin.y, origin.z), mat4RotationAxis({ x: 0, y: 0, z: 1 }, rotZ));
  return createComponentGroup(doc, 'Scale Figure (1.75m)', layerId, (ctx) => {
    // Legs
    addBox(ctx, doc, -0.09, 0, 0, 0.11, 0.13, 0.86, 'scale_fig', layerId);
    addBox(ctx, doc, 0.09, 0, 0, 0.11, 0.13, 0.86, 'scale_fig', layerId);
    // Torso
    addBox(ctx, doc, 0, 0, 0.86, 0.36, 0.18, 0.62, 'scale_fig', layerId);
    // Arms
    addBox(ctx, doc, -0.23, 0, 0.94, 0.08, 0.11, 0.52, 'scale_fig', layerId);
    addBox(ctx, doc, 0.23, 0, 0.94, 0.08, 0.11, 0.52, 'scale_fig', layerId);
    // Head
    addCylinder(ctx, doc, 0, 0, 1.52, 0.10, 0.22, 10, 'scale_fig', layerId);
  }, mat);
}

export function buildTreeGroup(doc, origin, variant = 'canopy') {
  const layerId = 'layer_site';
  return createComponentGroup(doc, `Tree (${variant})`, layerId, (ctx) => {
    if (variant === 'cypress') {
      addCylinder(ctx, doc, 0, 0, 0, 0.12, 1.4, 8, 'cedar', layerId);
      addCylinder(ctx, doc, 0, 0, 1.2, 0.55, 2.2, 10, 'foliage', layerId);
      addCylinder(ctx, doc, 0, 0, 3.4, 0.38, 1.8, 10, 'foliage', layerId);
      addCylinder(ctx, doc, 0, 0, 5.0, 0.18, 1.2, 8, 'foliage', layerId);
    } else {
      addCylinder(ctx, doc, 0, 0, 0, 0.16, 2.2, 8, 'cedar', layerId);
      addCylinder(ctx, doc, 0, 0, 2.0, 1.45, 1.6, 12, 'foliage', layerId);
      addCylinder(ctx, doc, 0.4, 0.3, 2.8, 1.05, 1.3, 10, 'foliage', layerId);
      addCylinder(ctx, doc, -0.45, -0.2, 2.6, 0.95, 1.2, 10, 'foliage', layerId);
    }
  }, mat4Translation(origin.x, origin.y, origin.z));
}

export function buildFurnitureGroup(doc, origin, rotZ = 0, variant = 'sofa') {
  const layerId = 'layer_entourage';
  const mat = mat4Mul(mat4Translation(origin.x, origin.y, origin.z), mat4RotationAxis({ x: 0, y: 0, z: 1 }, rotZ));
  if (variant === 'sofa') {
    return createComponentGroup(doc, 'Modern L-Sofa', layerId, (ctx) => {
      addBox(ctx, doc, 0, 0, 0.08, 2.4, 0.95, 0.32, 'limestone', layerId);
      addBox(ctx, doc, -0.72, 0.85, 0.08, 0.96, 0.85, 0.32, 'limestone', layerId);
      addBox(ctx, doc, 0, -0.38, 0.40, 2.4, 0.18, 0.36, 'limestone', layerId);
      addBox(ctx, doc, 1.11, 0, 0.40, 0.18, 0.95, 0.24, 'limestone', layerId);
      addBox(ctx, doc, -1.11, 0.40, 0.40, 0.18, 1.75, 0.24, 'limestone', layerId);
    }, mat);
  }
  if (variant === 'dining') {
    return createComponentGroup(doc, 'Dining Table Set', layerId, (ctx) => {
      // Table
      addBox(ctx, doc, 0, 0, 0.71, 2.2, 1.0, 0.05, 'oak', layerId);
      for (const lx of [-0.95, 0.95]) for (const ly of [-0.4, 0.4]) {
        addBox(ctx, doc, lx, ly, 0, 0.06, 0.06, 0.71, 'steel', layerId);
      }
      // 4 Chairs
      for (const cx of [-0.55, 0.55]) {
        addBox(ctx, doc, cx, -0.75, 0.42, 0.46, 0.44, 0.04, 'oak', layerId);
        addBox(ctx, doc, cx, -0.95, 0.46, 0.46, 0.04, 0.38, 'oak', layerId);
        addBox(ctx, doc, cx, 0.75, 0.42, 0.46, 0.44, 0.04, 'oak', layerId);
        addBox(ctx, doc, cx, 0.95, 0.46, 0.46, 0.04, 0.38, 'oak', layerId);
      }
    }, mat);
  }
  if (variant === 'bed') {
    return createComponentGroup(doc, 'Queen Bed', layerId, (ctx) => {
      addBox(ctx, doc, 0, 0, 0.12, 1.7, 2.1, 0.22, 'oak', layerId);
      addBox(ctx, doc, 0, 0.04, 0.34, 1.56, 1.98, 0.24, 'plaster', layerId);
      addBox(ctx, doc, 0, -0.98, 0.12, 1.8, 0.12, 0.95, 'cedar', layerId);
    }, mat);
  }
  // Minimalist Car
  return createComponentGroup(doc, 'Architectural Car', layerId, (ctx) => {
    addBox(ctx, doc, 0, 0, 0.22, 4.4, 1.85, 0.58, 'aluminum', layerId);
    addBox(ctx, doc, -0.2, 0, 0.80, 2.2, 1.60, 0.52, 'glass_dark', layerId);
    for (const wx of [-1.35, 1.35]) for (const wy of [-0.88, 0.88]) {
      addBox(ctx, doc, wx, wy, 0, 0.62, 0.20, 0.62, 'steel', layerId);
    }
  }, mat);
}

// ---- 5. ARCHITECTURAL STARTER TEMPLATES & FLOOR PLAN 3D BUILDER ----
export function buildApartmentFromPlan(doc) {
  doc.projectName = '2-Bedroom Apartment 3D';
  const root = doc.rootContext;
  const S = 3.15 / 323; // Exact scale from 315CM balcony/living span (323 px = 3.15m)
  const CX = 512;
  const CY = 431;
  const pxW = (x) => (x - CX) * S;
  const pyW = (y) => (CY - y) * S;

  const Z0 = 0.20;   // Floor finish elevation
  const WH = 2.80;   // Ceiling height (total wall top = 3.00m)
  const DH = 2.15;   // Door head height
  const SILL = 0.90; // Window sill height
  const WINH = 1.25; // Window glazing height

  const rectBox = (ctx, x1, y1, x2, y2, zBot, h, mat, layer) => {
    const wx1 = pxW(Math.min(x1, x2)), wx2 = pxW(Math.max(x1, x2));
    const wy1 = pyW(Math.max(y1, y2)), wy2 = pyW(Math.min(y1, y2));
    const sx = wx2 - wx1, sy = wy2 - wy1;
    if (sx < 0.005 || sy < 0.005 || h < 0.005) return;
    addBox(ctx, doc, (wx1 + wx2) * 0.5, (wy1 + wy2) * 0.5, zBot, sx, sy, h, mat, layer, 0);
  };

  const wallSeg = (x1, y1, x2, y2, mat = 'plaster', layer = 'layer_walls_1') => {
    rectBox(root, x1, y1, x2, y2, Z0, WH, mat, layer);
  };

  const wallWithWindow = (x1, y1, x2, y2, sillZ = SILL, winH = WINH, mat = 'plaster') => {
    // Lower sill wall
    rectBox(root, x1, y1, x2, y2, Z0, sillZ, mat, 'layer_walls_1');
    // Upper lintel header
    rectBox(root, x1, y1, x2, y2, Z0 + sillZ + winH, WH - (sillZ + winH), mat, 'layer_walls_1');
    // Window frame & glass in center plane
    const isHoriz = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    const xm = (x1 + x2) * 0.5, ym = (y1 + y2) * 0.5;
    if (isHoriz) {
      rectBox(root, x1, ym - 2, x2, ym + 2, Z0 + sillZ, 0.04, 'steel', 'layer_openings');
      rectBox(root, x1, ym - 2, x2, ym + 2, Z0 + sillZ + winH - 0.04, 0.04, 'steel', 'layer_openings');
      rectBox(root, x1, ym - 1, x2, ym + 1, Z0 + sillZ + 0.04, winH - 0.08, 'glass', 'layer_openings');
    } else {
      rectBox(root, xm - 2, y1, xm + 2, y2, Z0 + sillZ, 0.04, 'steel', 'layer_openings');
      rectBox(root, xm - 2, y1, xm + 2, y2, Z0 + sillZ + winH - 0.04, 0.04, 'steel', 'layer_openings');
      rectBox(root, xm - 1, y1, xm + 1, y2, Z0 + sillZ + 0.04, winH - 0.08, 'glass', 'layer_openings');
    }
  };

  const doorOpening = (x1, y1, x2, y2, swingAngle = 0.5, leafMat = 'oak') => {
    // Lintel above door
    rectBox(root, x1, y1, x2, y2, Z0 + DH, WH - DH, 'plaster', 'layer_walls_1');
    // Hinged open door leaf
    const isHoriz = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    const len = isHoriz ? Math.abs(pxW(x2) - pxW(x1)) : Math.abs(pyW(y1) - pyW(y2));
    const hx = isHoriz ? pxW(Math.min(x1, x2)) : pxW((x1 + x2) * 0.5);
    const hy = isHoriz ? pyW((y1 + y2) * 0.5) : pyW(Math.max(y1, y2));
    const baseAng = isHoriz ? 0 : Math.PI * 0.5;
    const ang = baseAng + swingAngle;
    const cx = hx + Math.cos(ang) * len * 0.5;
    const cy = hy + Math.sin(ang) * len * 0.5;
    createComponentGroup(doc, 'Interior Door', 'layer_openings', (c) => {
      addBox(c, doc, cx, cy, Z0, len, 0.045, DH - 0.02, leafMat, 'layer_openings', ang);
    });
  };

  // ---- 1. FLOOR SLABS (Z = 0..0.20m) ----
  // Site ground base
  addBox(root, doc, 0, 0, -0.10, 16, 14, 0.10, 'slate', 'layer_site');
  // Main oak interior floor zones
  rectBox(root, 18, 6, 354, 412, 0, Z0, 'oak', 'layer_foundation');       // NW Master Bedroom
  rectBox(root, 354, 145, 680, 550, 0, Z0, 'oak', 'layer_foundation');    // Kitchen & Central Hall
  rectBox(root, 150, 545, 520, 858, 0, Z0, 'oak', 'layer_foundation');    // SW Bedroom 2
  rectBox(root, 680, 198, 1020, 742, 0, Z0, 'oak', 'layer_foundation');   // East Living Room
  // Limestone wet & outdoor zones
  rectBox(root, 0, 412, 248, 545, 0, Z0, 'limestone', 'layer_foundation'); // West Half Bath
  rectBox(root, 520, 550, 680, 758, 0, Z0, 'limestone', 'layer_foundation'); // South Ensuite Bath
  rectBox(root, 680, 6, 1020, 198, 0, Z0, 'limestone', 'layer_foundation');  // North-East Balcony

  // ---- 2. EXTERIOR & INTERIOR WALLS ----
  // NW Master Bedroom walls
  wallSeg(18, 2, 220, 16);                        // North wall left
  wallWithWindow(220, 4, 336, 14);                // North window
  wallSeg(336, 2, 358, 16);                       // North corner
  wallSeg(18, 16, 32, 290);                       // West wall upper
  wallWithWindow(20, 290, 30, 408);               // West window
  wallSeg(344, 16, 358, 292);                     // East wall (to kitchen)
  doorOpening(344, 292, 358, 392, 0.45, 'oak');   // NW Bedroom Door
  wallSeg(344, 392, 358, 425);                    // Stub

  // West Half Bath & Entry Hall
  wallSeg(0, 402, 162, 416);                      // North half-bath wall
  wallSeg(0, 538, 250, 552);                      // South half-bath wall
  wallSeg(62, 470, 74, 538);                      // Toilet partition
  doorOpening(62, 416, 74, 470, -0.45, 'oak');
  wallSeg(238, 430, 250, 538);                    // East half-bath wall

  // Kitchen North Exterior Wall
  wallSeg(358, 142, 446, 156);
  wallWithWindow(446, 144, 574, 154, 1.15, 1.0);  // Kitchen Window above sink/stove
  wallSeg(574, 142, 676, 156);

  // SW Bedroom 2
  wallSeg(148, 545, 250, 556);                    // Top-left wall
  doorOpening(348, 542, 480, 554, -0.55, 'oak');  // SW Bedroom Door
  wallSeg(148, 556, 162, 645);                    // West wall upper
  wallWithWindow(150, 645, 160, 815);             // West window
  wallSeg(148, 815, 162, 860);                    // West corner
  wallSeg(148, 846, 548, 860);                    // South exterior wall
  wallSeg(514, 558, 526, 846);                    // Ensuite divider wall

  // South Ensuite Bathroom
  wallSeg(526, 750, 568, 762);
  wallWithWindow(568, 752, 636, 760, 1.35, 0.8);  // Ensuite frosted window
  wallSeg(636, 750, 684, 762);
  wallSeg(672, 550, 684, 750);                    // East wall of ensuite

  // Living Room & Balcony Spine Wall (x = 672..686)
  wallSeg(672, 6, 686, 444);                      // Balcony + upper living room wall
  rectBox(root, 672, 444, 686, 546, Z0 + DH, WH - DH, 'plaster', 'layer_walls_1'); // Open Hallway Archway!
  wallSeg(672, 546, 686, 744);                    // Lower living room divider

  // Living Room East Exterior Wall (x = 1009..1023)
  wallSeg(1009, 6, 1023, 270);
  wallWithWindow(1011, 270, 1021, 485);           // East tall window 1
  wallSeg(1009, 485, 1023, 545);
  wallWithWindow(1011, 545, 1021, 695);           // East tall window 2
  wallSeg(1009, 695, 1023, 744);

  // Balcony North Glass Balustrade + French Patio Doors (3.15m span)
  wallSeg(686, 192, 732, 204);
  wallSeg(924, 192, 1009, 204);
  // Lintel & Double French Glass Patio Doors
  rectBox(root, 732, 192, 924, 204, Z0 + DH, WH - DH, 'plaster', 'layer_walls_1');
  createComponentGroup(doc, 'Balcony French Doors', 'layer_openings', (c) => {
    // Door leaves slightly open onto balcony
    addBox(c, doc, pxW(755), pyW(170), Z0, 0.90, 0.04, DH - 0.02, 'glass', 'layer_openings', 0.42);
    addBox(c, doc, pxW(900), pyW(170), Z0, 0.90, 0.04, DH - 0.02, 'glass', 'layer_openings', -0.42);
    addBox(c, doc, pxW(828), pyW(198), Z0, 1.88, 0.08, 0.03, 'aluminum', 'layer_openings', 0);
  });
  // Balcony Glass Railing (North)
  createComponentGroup(doc, 'Balcony Glass Railing', 'layer_openings', (c) => {
    rectBox(c, 686, 6, 1009, 12, Z0, 1.02, 'glass', 'layer_openings');
    rectBox(c, 686, 5, 1009, 13, Z0 + 1.02, 0.05, 'steel', 'layer_openings');
    for (const px of [690, 770, 850, 930, 1005]) {
      rectBox(c, px - 2, 5, px + 2, 13, Z0, 1.05, 'steel', 'layer_openings');
    }
  });

  // Living Room South Wall + Main Entry Door + Exterior Architectural Pier
  wallSeg(686, 732, 902, 744);
  doorOpening(902, 732, 1009, 744, 0.55, 'walnut'); // Main Entry Door
  rectBox(root, 882, 744, 914, 845, 0, Z0 + WH, 'limestone', 'layer_walls_1'); // South Pier

  // ---- 3. INTERIOR FURNITURE, KITCHEN & BATH FIXTURES ----
  // Master Bedroom (NW) Furniture
  createComponentGroup(doc, 'Master Bedroom Furniture', 'layer_entourage', (c) => {
    // Double Bed (East side, pillows at North)
    rectBox(c, 238, 60, 336, 248, Z0, 0.24, 'walnut', 'layer_entourage');
    rectBox(c, 242, 64, 332, 244, Z0 + 0.24, 0.22, 'plaster', 'layer_entourage');
    rectBox(c, 238, 56, 336, 64, Z0, 0.92, 'walnut', 'layer_entourage'); // Headboard
    rectBox(c, 248, 68, 284, 92, Z0 + 0.46, 0.10, 'limestone', 'layer_entourage'); // Pillow L
    rectBox(c, 290, 68, 326, 92, Z0 + 0.46, 0.10, 'limestone', 'layer_entourage'); // Pillow R
    // North & West Desks / Cabinets
    rectBox(c, 36, 18, 212, 62, Z0, 0.75, 'oak', 'layer_entourage');
    rectBox(c, 36, 72, 76, 360, Z0, 0.75, 'oak', 'layer_entourage');
    rectBox(c, 215, 18, 338, 52, Z0, 2.10, 'plaster', 'layer_entourage'); // North closet
  });

  // Kitchen (Central) Sage Counters, Sink, Cooktop & Pink Refrigerator
  createComponentGroup(doc, 'Kitchen Cabinetry & Appliances', 'layer_entourage', (c) => {
    // L-Counter Base (Sage Green)
    rectBox(c, 358, 158, 672, 224, Z0, 0.88, 'kitchen_sage', 'layer_entourage');
    rectBox(c, 358, 224, 418, 365, Z0, 0.88, 'kitchen_sage', 'layer_entourage');
    // Cooktop / Stove unit
    rectBox(c, 472, 165, 550, 218, Z0 + 0.88, 0.04, 'steel', 'layer_entourage');
    // Kitchen Sink on West counter leg
    rectBox(c, 366, 265, 408, 325, Z0 + 0.88, 0.04, 'steel', 'layer_entourage');
    // Island Counter + Base
    rectBox(c, 496, 368, 588, 430, Z0, 0.90, 'slate', 'layer_entourage');
    // Pink/Rose Refrigerator!
    rectBox(c, 590, 368, 662, 428, Z0, 2.02, 'fridge_rose', 'layer_entourage');
  });

  // SW Bedroom 2 Furniture (Bed, Wardrobe, Storage)
  createComponentGroup(doc, 'Bedroom 2 Furniture', 'layer_entourage', (c) => {
    // Double Bed (pillows at South wall)
    rectBox(c, 252, 622, 412, 838, Z0, 0.24, 'oak', 'layer_entourage');
    rectBox(c, 256, 626, 408, 834, Z0 + 0.24, 0.22, 'plaster', 'layer_entourage');
    rectBox(c, 252, 834, 412, 844, Z0, 0.92, 'walnut', 'layer_entourage'); // Headboard
    rectBox(c, 262, 800, 324, 830, Z0 + 0.46, 0.10, 'limestone', 'layer_entourage');
    rectBox(c, 338, 800, 400, 830, Z0 + 0.46, 0.10, 'limestone', 'layer_entourage');
    // Tall Wardrobe on East wall
    rectBox(c, 464, 608, 514, 842, Z0, 2.25, 'oak', 'layer_entourage');
    // West wall cabinetry
    rectBox(c, 164, 560, 212, 842, Z0, 0.78, 'oak', 'layer_entourage');
  });

  // Bathroom Fixtures (Toilets & Vanities)
  createComponentGroup(doc, 'Bathroom Fixtures', 'layer_entourage', (c) => {
    // West half-bath toilet
    rectBox(c, 84, 456, 134, 496, Z0, 0.42, 'plaster', 'layer_entourage');
    rectBox(c, 80, 456, 94, 496, Z0 + 0.42, 0.36, 'plaster', 'layer_entourage');
    // Hallway sink vanity outside SW bedroom
    rectBox(c, 254, 534, 316, 564, Z0, 0.82, 'limestone', 'layer_entourage');
    // Ensuite toilet
    rectBox(c, 578, 692, 616, 742, Z0, 0.42, 'plaster', 'layer_entourage');
    rectBox(c, 578, 728, 616, 746, Z0 + 0.42, 0.36, 'plaster', 'layer_entourage');
  });

  // Living Room Furniture (L-Shaped Taupe Sofa & Dark Walnut Table)
  createComponentGroup(doc, 'Living Room Furniture', 'layer_entourage', (c) => {
    // Dark Walnut Dining / Study Desk
    rectBox(c, 690, 248, 804, 338, Z0, 0.75, 'walnut', 'layer_entourage');
    // L-Shaped Taupe Sofa in SW corner
    rectBox(c, 688, 545, 746, 728, Z0, 0.44, 'sofa_taupe', 'layer_entourage'); // Chaise
    rectBox(c, 746, 668, 898, 728, Z0, 0.44, 'sofa_taupe', 'layer_entourage'); // Main seat
    rectBox(c, 688, 714, 898, 728, Z0 + 0.44, 0.34, 'sofa_taupe', 'layer_entourage'); // Backrest
    rectBox(c, 688, 545, 702, 714, Z0 + 0.44, 0.34, 'sofa_taupe', 'layer_entourage'); // Side arm
    rectBox(c, 892, 668, 904, 728, Z0, 0.62, 'walnut', 'layer_entourage'); // End table accent
  });

  // Scale Figure on Balcony & Living Room
  buildScalePersonGroup(doc, v3(pxW(830), pyW(100), Z0), -1.2);
  buildScalePersonGroup(doc, v3(pxW(860), pyW(460), Z0), 2.4);

  // Optional Roof Slab on Roof Layer (hidden by default so interior rooms read like a 3D dollhouse, toggleable in Layers!)
  const roofLayer = doc.layers.find((l) => l.id === 'layer_roof');
  if (roofLayer) roofLayer.visible = false;
  createComponentGroup(doc, 'Apartment Ceiling Slab', 'layer_roof', (c) => {
    rectBox(c, 18, 6, 358, 412, Z0 + WH, 0.18, 'plaster', 'layer_roof');
    rectBox(c, 358, 142, 686, 550, Z0 + WH, 0.18, 'plaster', 'layer_roof');
    rectBox(c, 148, 545, 686, 860, Z0 + WH, 0.18, 'plaster', 'layer_roof');
    rectBox(c, 686, 192, 1023, 744, Z0 + WH, 0.18, 'plaster', 'layer_roof');
  });

  // Dimension & Room Labels
  doc.dimensions.push({
    id: nextId('dim'),
    p1: v3(pxW(686), pyW(196), Z0 + 0.02),
    p2: v3(pxW(1009), pyW(196), Z0 + 0.02),
    offsetVec: v3(0, 0.45, 0),
    layerId: 'layer_annotations',
  });
  doc.labels.push(
    { id: nextId('lbl'), p: v3(pxW(845), pyW(95), 1.6), anchor: v3(pxW(845), pyW(95), Z0), text: 'Balcony (3.15m)', layerId: 'layer_annotations' },
    { id: nextId('lbl'), p: v3(pxW(845), pyW(430), 2.6), anchor: v3(pxW(845), pyW(430), Z0), text: 'Living Room', layerId: 'layer_annotations' },
    { id: nextId('lbl'), p: v3(pxW(510), pyW(290), 2.6), anchor: v3(pxW(510), pyW(290), Z0), text: 'Kitchen', layerId: 'layer_annotations' },
    { id: nextId('lbl'), p: v3(pxW(185), pyW(190), 2.6), anchor: v3(pxW(185), pyW(190), Z0), text: 'Master Bedroom', layerId: 'layer_annotations' },
    { id: nextId('lbl'), p: v3(pxW(335), pyW(700), 2.6), anchor: v3(pxW(335), pyW(700), Z0), text: 'Bedroom 2', layerId: 'layer_annotations' },
  );

  doc.notify('load');
}

export function loadTemplate(doc, templateName) {
  // Reset document cleanly
  const fresh = new doc.constructor();
  doc.contexts = fresh.contexts;
  doc.rootContextId = fresh.rootContextId;
  doc.contextStack = [doc.rootContextId];
  doc.layers = fresh.layers;
  doc.guides = [];
  doc.dimensions = [];
  doc.labels = [];
  doc.sectionPlanes = [];
  doc.clearSelection();
  doc.undoStack = [];
  doc.redoStack = [];

  const root = doc.rootContext;

  if (templateName === 'apartment_plan') {
    buildApartmentFromPlan(doc);
    return;
  }

  if (templateName === 'blank') {
    doc.projectName = 'Blank Architectural Site';
    buildScalePersonGroup(doc, v3(1.2, 1.0, 0), 0.3);
    doc.notify('load');
    return;
  }

  if (templateName === 'urban_solar') {
    doc.projectName = 'Urban Massing & Solar Study';
    // Site ground slab & plaza
    addBox(root, doc, 0, 0, -0.2, 42, 36, 0.2, 'asphalt', 'layer_site');
    addBox(root, doc, 0, 0, 0, 22, 20, 0.15, 'limestone', 'layer_site');
    addBox(root, doc, -4, 4, 0.15, 6, 4, 0.10, 'water', 'layer_site');

    // Central stepped mixed-use tower (editable raw faces in root so user can Push/Pull immediately!)
    const podium = doc.addPolygonFace(root, [
      v3(-6, -6, 0.15), v3(7, -6, 0.15), v3(7, 5, 0.15), v3(-6, 5, 0.15),
    ], { materialId: 'limestone', layerId: 'layer_walls_1' });
    if (podium) doc.pushPullFace(root, podium.id, 4.2);

    const towerA = doc.addPolygonFace(root, [
      v3(-5, -5, 4.35), v3(5, -5, 4.35), v3(5, 2, 4.35), v3(-5, 2, 4.35),
    ], { materialId: 'glass', layerId: 'layer_walls_2' });
    if (towerA) doc.pushPullFace(root, towerA.id, 14.0);

    const crown = doc.addPolygonFace(root, [
      v3(-4, -4, 18.35), v3(3, -4, 18.35), v3(3, 1, 18.35), v3(-4, 1, 18.35),
    ], { materialId: 'zinc', layerId: 'layer_roof' });
    if (crown) doc.pushPullFace(root, crown.id, 4.5);

    // Context neighbor buildings (grouped)
    createComponentGroup(doc, 'Context Block North', 'layer_site', (c) => {
      addBox(c, doc, -14, 12, 0, 10, 8, 12, 'concrete', 'layer_site');
      addBox(c, doc, 14, 11, 0, 9, 10, 16, 'concrete', 'layer_site');
    });
    createComponentGroup(doc, 'Context Block West', 'layer_site', (c) => {
      addBox(c, doc, -15, -6, 0, 8, 14, 9.5, 'brick', 'layer_site');
      addBox(c, doc, 15, -7, 0, 8, 12, 11.0, 'concrete', 'layer_site');
    });

    buildTreeGroup(doc, v3(-8, -7, 0.15), 'canopy');
    buildTreeGroup(doc, v3(8.5, 6.5, 0.15), 'canopy');
    buildTreeGroup(doc, v3(9, -6.5, 0.15), 'cypress');
    buildScalePersonGroup(doc, v3(1, -8, 0.15), 0.4);
    buildScalePersonGroup(doc, v3(2.1, -7.4, 0.15), -0.6);

    doc.dimensions.push({ id: nextId('dim'), p1: v3(-6, -6, 0.15), p2: v3(7, -6, 0.15), offsetVec: v3(0, -1.6, 0), layerId: 'layer_annotations' });
    doc.labels.push({ id: nextId('lbl'), p: v3(0, -1, 23.0), anchor: v3(0, -1, 22.85), text: 'Tower Crown +22.85m', layerId: 'layer_annotations' });
    doc.notify('load');
    return;
  }

  // DEFAULT: 'pavilion' — Modern Cantilevered Courtyard Pavilion Residence
  doc.projectName = 'Courtyard Pavilion Residence';

  // Site lawn & travertine plinth
  addBox(root, doc, 0, 0, -0.15, 28, 22, 0.15, 'grass', 'layer_site');
  addBox(root, doc, -0.5, -0.5, 0, 16, 12, 0.25, 'limestone', 'layer_foundation');
  // Reflecting pool in courtyard
  addBox(root, doc, 3.8, -2.6, 0.02, 5.2, 3.2, 0.24, 'water', 'layer_site');
  // Cedar outdoor terrace deck
  addBox(root, doc, -3.5, -3.6, 0.25, 6.5, 3.6, 0.10, 'cedar', 'layer_foundation');

  // Main Pavilion Walls (editable directly in root!)
  buildWallChain(doc, [
    v3(-7.0, 4.5, 0.25),
    v3(6.0, 4.5, 0.25),
    v3(6.0, 0.5, 0.25),
  ], { thickness: 0.28, height: 3.3, alignment: 'center', materialId: 'plaster', layerId: 'layer_walls_1' });

  buildWallChain(doc, [
    v3(-7.0, 4.5, 0.25),
    v3(-7.0, -1.2, 0.25),
    v3(-3.2, -1.2, 0.25),
  ], { thickness: 0.28, height: 3.3, alignment: 'center', materialId: 'concrete', layerId: 'layer_walls_1' });

  // Feature fireplace / masonry core mass (editable via Push/Pull!)
  const coreFace = doc.addPolygonFace(root, [
    v3(-1.8, 1.5, 0.25), v3(-0.4, 1.5, 0.25), v3(-0.4, 3.2, 0.25), v3(-1.8, 3.2, 0.25),
  ], { materialId: 'brick', layerId: 'layer_walls_1' });
  if (coreFace) doc.pushPullFace(root, coreFace.id, 4.4);

  // Floating Flat Roof with deep cedar soffit & zinc fascia (grouped so user can toggle Roof layer!)
  createComponentGroup(doc, 'Pavilion Cantilever Roof', 'layer_roof', (c) => {
    addBox(c, doc, -0.5, 1.6, 3.55, 14.8, 7.6, 0.12, 'cedar', 'layer_roof');
    addBox(c, doc, -0.5, 1.6, 3.67, 15.0, 7.8, 0.22, 'zinc', 'layer_roof');
    // Skylight aperture box on roof
    addBox(c, doc, 2.2, 2.2, 3.89, 2.4, 1.8, 0.16, 'glass', 'layer_roof');
  });

  // Curtain wall glazing & structural steel columns
  buildWindowComponent(doc, v3(2.2, 0.5, 0.25), 0, 'curtain');
  buildDoorComponent(doc, v3(-1.8, -1.2, 0.25), 0, 'sliding');
  buildColumnComponent(doc, v3(-6.4, -1.6, 0.25), 'ibeam');
  buildColumnComponent(doc, v3(5.8, -1.6, 0.25), 'ibeam');

  // Exterior garden stairs & interior furniture
  buildStaircaseGroup(doc, v3(6.6, -2.5, 0.25), { type: 'straight', totalRise: 1.4, width: 1.2, treadDepth: 0.30 });
  buildFurnitureGroup(doc, v3(-4.2, 2.0, 0.25), 0, 'sofa');
  buildFurnitureGroup(doc, v3(2.6, 2.4, 0.25), Math.PI * 0.5, 'dining');

  // Landscape trees & human scale figures
  buildTreeGroup(doc, v3(-9.5, -4.5, 0), 'canopy');
  buildTreeGroup(doc, v3(9.2, 3.5, 0), 'cypress');
  buildTreeGroup(doc, v3(10.0, -3.5, 0), 'canopy');
  buildScalePersonGroup(doc, v3(-4.6, -4.2, 0.35), 0.6);
  buildScalePersonGroup(doc, v3(0.5, -2.2, 0.25), -0.3);

  // Architectural Dimension & Callout
  doc.dimensions.push({
    id: nextId('dim'),
    p1: v3(-7.0, -1.2, 0.25),
    p2: v3(6.0, -1.2, 0.25),
    offsetVec: v3(0, -1.3, 0),
    layerId: 'layer_annotations',
  });
  doc.labels.push({
    id: nextId('lbl'),
    p: v3(-0.5, 1.6, 4.6),
    anchor: v3(-0.5, 1.6, 3.9),
    text: 'Cantilevered Roof +3.89m',
    layerId: 'layer_annotations',
  });

  doc.notify('load');
}
