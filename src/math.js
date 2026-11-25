// Architectural 3D CAD Math & Computational Geometry Kernel
// Coordinate Convention (SketchUp-aligned):
// X = East/West (Red), Y = North/South (Green), Z = Elevation/Up (Blue)

export const EPS = 1e-5;
export const WELD_EPS = 1e-4;

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function add3(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub3(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function len3(a) {
  return Math.hypot(a.x, a.y, a.z);
}

export function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function norm3(a) {
  const l = len3(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function lerp3(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function eq3(a, b, eps = WELD_EPS) {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.z - b.z) <= eps
  );
}

// Column-major 4x4 matrix (WebGL convention)
export function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

export function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function mat4Translation(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

export function mat4Scale(sx, sy, sz) {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}

export function mat4RotationAxis(axis, angleRad) {
  const u = norm3(axis);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  const { x, y, z } = u;
  return new Float32Array([
    t * x * x + c,     t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c,     t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,     0,
    0, 0, 0, 1,
  ]);
}

export function mat4TransformPoint(m, p) {
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15] || 1;
  return {
    x: (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w,
    y: (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w,
    z: (m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]) / w,
  };
}

export function mat4TransformDir(m, p) {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z,
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z,
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z,
  };
}

export function mat4Invert(m) {
  const out = new Float32Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-14) return mat4Identity();
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function mat4LookAt(eye, target, up) {
  const z = norm3(sub3(eye, target));
  let x = cross3(up, z);
  if (len3(x) < 1e-6) {
    x = cross3({ x: 0, y: 1, z: 0 }, z);
    if (len3(x) < 1e-6) x = { x: 1, y: 0, z: 0 };
  }
  x = norm3(x);
  const y = cross3(z, x);
  return new Float32Array([
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

export function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function mat4Ortho(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return new Float32Array([
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1,
  ]);
}

// Orthonormal basis from a plane normal
export function basisFromNormal(normal) {
  const n = norm3(normal);
  const ref = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  // Prefer aligning u with X when Z-up
  let u;
  if (Math.abs(n.z) > 0.999) {
    u = { x: 1, y: 0, z: 0 };
  } else {
    u = norm3(cross3(ref, n));
  }
  const v = norm3(cross3(n, u));
  return { u, v, n };
}

export function projectToPlane2D(pts, origin, u, v) {
  return pts.map((p) => {
    const d = sub3(p, origin);
    return { x: dot3(d, u), y: dot3(d, v) };
  });
}

export function polyArea2D(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a * 0.5;
}

export function pointInPoly2D(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Newell's method for 3D polygon normal
export function computeNewellNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    nx += (c.y - n.y) * (c.z + n.z);
    ny += (c.z - n.z) * (c.x + n.x);
    nz += (c.x - n.x) * (c.y + n.y);
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-10) return { x: 0, y: 0, z: 1 };
  return { x: nx / l, y: ny / l, z: nz / l };
}

// 2D Ear-Clipping Triangulation with Holes
// outer: [{x,y}], holes: [[{x,y}], ...]
// Returns { points2D: [{x,y}], indices: [i0, i1, i2, ...] } referring to concatenated vertices
export function triangulatePolygon2D(outer, holes = []) {
  if (outer.length < 3) return { vertices: [], indices: [] };

  // Clone and ensure outer is CCW, holes are CW
  const outerCCW = polyArea2D(outer) < 0 ? [...outer].reverse() : [...outer];
  const holesCW = holes
    .filter((h) => h.length >= 3)
    .map((h) => (polyArea2D(h) > 0 ? [...h].reverse() : [...h]));

  // Build flat vertex list + linked index ring
  const allPts = [];
  const pushRing = (ring) => {
    const startIdx = allPts.length;
    for (const p of ring) allPts.push({ x: p.x, y: p.y });
    return { startIdx, len: ring.length };
  };

  const outerMeta = pushRing(outerCCW);
  const holeMetas = holesCW.map((h) => pushRing(h));

  // Start with outer ring index array
  let poly = [];
  for (let i = 0; i < outerMeta.len; i++) poly.push(outerMeta.startIdx + i);

  // Bridge each hole into outer poly (rightmost vertex first)
  if (holeMetas.length > 0) {
    const holeOrder = holeMetas
      .map((meta, idx) => {
        let maxX = -Infinity;
        let maxV = meta.startIdx;
        for (let i = 0; i < meta.len; i++) {
          const vi = meta.startIdx + i;
          if (allPts[vi].x > maxX) {
            maxX = allPts[vi].x;
            maxV = vi;
          }
        }
        return { meta, maxV, maxX };
      })
      .sort((a, b) => b.maxX - a.maxX);

    for (const h of holeOrder) {
      const m = allPts[h.maxV];
      // Find closest visible edge intersection to the right (+x)
      let bestDist = Infinity;
      let bestP = null;
      let bestEdgeIdx = -1;
      for (let i = 0; i < poly.length; i++) {
        const aIdx = poly[i];
        const bIdx = poly[(i + 1) % poly.length];
        const a = allPts[aIdx];
        const b = allPts[bIdx];
        if ((a.y <= m.y && b.y >= m.y) || (b.y <= m.y && a.y >= m.y)) {
          if (Math.abs(a.y - b.y) < 1e-10) continue;
          const t = (m.y - a.y) / (b.y - a.y);
          const ix = a.x + t * (b.x - a.x);
          if (ix >= m.x - 1e-9 && ix - m.x < bestDist) {
            bestDist = ix - m.x;
            bestP = { x: ix, y: m.y };
            bestEdgeIdx = i;
          }
        }
      }
      if (bestEdgeIdx === -1) continue;
      const aIdx = poly[bestEdgeIdx];
      const bIdx = poly[(bestEdgeIdx + 1) % poly.length];
      let visibleIdx = allPts[aIdx].x >= allPts[bIdx].x ? aIdx : bIdx;

      // Check if any reflex vertex inside triangle (m, bestP, visible)
      const pVis = allPts[visibleIdx];
      let bestAngle = Infinity;
      let candidateIdx = visibleIdx;
      for (let i = 0; i < poly.length; i++) {
        const vi = poly[i];
        if (vi === visibleIdx) continue;
        const p = allPts[vi];
        if (p.x >= m.x - 1e-9 && pointInTri2D(p, m, bestP, pVis)) {
          const ang = Math.atan2(Math.abs(p.y - m.y), p.x - m.x + 1e-12);
          if (ang < bestAngle) {
            bestAngle = ang;
            candidateIdx = vi;
          }
        }
      }

      // Splice hole at candidateIdx
      const candPos = poly.indexOf(candidateIdx);
      const holeRing = [];
      const hStart = h.maxV - h.meta.startIdx;
      for (let i = 0; i < h.meta.len; i++) {
        holeRing.push(h.meta.startIdx + ((hStart + i) % h.meta.len));
      }
      // Duplicate bridge vertices
      const spliced = [
        ...poly.slice(0, candPos + 1),
        ...holeRing,
        holeRing[0],
        candidateIdx,
        ...poly.slice(candPos + 1),
      ];
      poly = spliced;
    }
  }

  // Ear clipping on merged simple polygon
  const indices = earClip(allPts, poly);
  return { vertices: allPts, indices };
}

function sign2D(p1, p2, p3) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

function pointInTri2D(pt, v1, v2, v3) {
  const d1 = sign2D(pt, v1, v2);
  const d2 = sign2D(pt, v2, v3);
  const d3 = sign2D(pt, v3, v1);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}

function earClip(pts, poly) {
  const res = [];
  const ring = [...poly];
  let guard = 0;
  const maxIter = ring.length * ring.length + 20;

  while (ring.length > 3 && guard++ < maxIter) {
    let clipped = false;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const iPrev = ring[(i - 1 + n) % n];
      const iCurr = ring[i];
      const iNext = ring[(i + 1) % n];
      const a = pts[iPrev];
      const b = pts[iCurr];
      const c = pts[iNext];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 1e-10) continue; // reflex or collinear

      let hasInside = false;
      for (let j = 0; j < n; j++) {
        const idx = ring[j];
        if (idx === iPrev || idx === iCurr || idx === iNext) continue;
        // Skip duplicate bridge vertices at exact same coordinates
        const p = pts[idx];
        if (
          (Math.abs(p.x - a.x) < 1e-9 && Math.abs(p.y - a.y) < 1e-9) ||
          (Math.abs(p.x - b.x) < 1e-9 && Math.abs(p.y - b.y) < 1e-9) ||
          (Math.abs(p.x - c.x) < 1e-9 && Math.abs(p.y - c.y) < 1e-9)
        ) {
          continue;
        }
        if (pointInTri2D(p, a, b, c)) {
          hasInside = true;
          break;
        }
      }
      if (!hasInside) {
        res.push(iPrev, iCurr, iNext);
        ring.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      // Fallback: relax collinear check slightly
      break;
    }
  }
  if (ring.length === 3) {
    res.push(ring[0], ring[1], ring[2]);
  }
  return res;
}

// 2D Mitered Polygon Offset (positive = outward for CCW, negative = inward)
export function offsetPolygon2D(pts2D, dist) {
  const n = pts2D.length;
  if (n < 3) return [];
  const area = polyArea2D(pts2D);
  const ccw = area >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts2D[(i - 1 + n) % n];
    const curr = pts2D[i];
    const next = pts2D[(i + 1) % n];

    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const n1x = (e1y / l1) * ccw, n1y = (-e1x / l1) * ccw;

    const e2x = next.x - curr.x, e2y = next.y - curr.y;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n2x = (e2y / l2) * ccw, n2y = (-e2x / l2) * ccw;

    // Bisector
    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      out.push({ x: curr.x + n1x * dist, y: curr.y + n1y * dist });
    } else {
      bx /= bl;
      by /= bl;
      const cosHalf = Math.max(0.25, bx * n1x + by * n1y);
      const miterLen = dist / cosHalf;
      out.push({ x: curr.x + bx * miterLen, y: curr.y + by * miterLen });
    }
  }
  return out;
}

// Ray-Triangle Intersection (Moller-Trumbore)
export function rayTriangle(ro, rd, a, b, c, doubleSided = true) {
  const e1 = sub3(b, a);
  const e2 = sub3(c, a);
  const h = cross3(rd, e2);
  const det = dot3(e1, h);
  if (doubleSided ? Math.abs(det) < 1e-9 : det < 1e-9) return null;
  const f = 1.0 / det;
  const s = sub3(ro, a);
  const u = f * dot3(s, h);
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const q = cross3(s, e1);
  const v = f * dot3(rd, q);
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = f * dot3(e2, q);
  if (t > 1e-5) {
    return { t, point: add3(ro, scale3(rd, t)) };
  }
  return null;
}

export function rayPlane(ro, rd, planeOrigin, planeNormal) {
  const denom = dot3(rd, planeNormal);
  if (Math.abs(denom) < 1e-7) return null;
  const t = dot3(sub3(planeOrigin, ro), planeNormal) / denom;
  if (t < 1e-4) return null;
  return { t, point: add3(ro, scale3(rd, t)) };
}

// Closest point on ray to segment (for 3D edge snapping)
export function raySegmentClosest(ro, rd, p1, p2) {
  const u = rd;
  const v = sub3(p2, p1);
  const w = sub3(ro, p1);
  const a = dot3(u, u);
  const b = dot3(u, v);
  const c = dot3(v, v);
  const d = dot3(u, w);
  const e = dot3(v, w);
  const D = a * c - b * b;
  let sc, tc;
  if (D < 1e-8) {
    sc = 0.0;
    tc = b > c ? d / b : e / (c || 1);
  } else {
    sc = (b * e - c * d) / D;
    tc = (a * e - b * d) / D;
  }
  tc = clamp(tc, 0, 1);
  sc = Math.max(0, (b * tc - d) / (a || 1));
  const pRay = add3(ro, scale3(u, sc));
  const pSeg = add3(p1, scale3(v, tc));
  return { rayT: sc, segT: tc, pointOnSeg: pSeg, dist: dist3(pRay, pSeg) };
}

// Closest point on ray to another ray/line (for axis inference)
export function rayLineClosest(ro, rd, lineOrigin, lineDir) {
  const u = rd;
  const v = lineDir;
  const w = sub3(ro, lineOrigin);
  const a = dot3(u, u);
  const b = dot3(u, v);
  const c = dot3(v, v);
  const d = dot3(u, w);
  const e = dot3(v, w);
  const D = a * c - b * b;
  if (D < 1e-8) return null;
  const sc = (b * e - c * d) / D;
  const tc = (a * e - b * d) / D;
  if (sc < 0) return null;
  return {
    rayT: sc,
    lineT: tc,
    pointOnLine: add3(lineOrigin, scale3(v, tc)),
    dist: dist3(add3(ro, scale3(u, sc)), add3(lineOrigin, scale3(v, tc))),
  };
}

// 2D segment intersection for coplanar edge splitting
export function segIntersect2D(a1, a2, b1, b2, eps = 1e-6) {
  const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
  const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
  const u = ((b1.x - a1.x) * dy1 - (b1.y - a1.y) * dx1) / denom;
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    return {
      t: clamp(t, 0, 1),
      u: clamp(u, 0, 1),
      x: a1.x + clamp(t, 0, 1) * dx1,
      y: a1.y + clamp(t, 0, 1) * dy1,
    };
  }
  return null;
}

// Unit formatting and VCB parsing
export function formatLength(meters, unit = 'm') {
  if (unit === 'cm') return `${(meters * 100).toFixed(1)} cm`;
  if (unit === 'mm') return `${Math.round(meters * 1000)} mm`;
  if (unit === 'ft') {
    const totalIn = meters / 0.0254;
    const sign = totalIn < 0 ? '-' : '';
    const absIn = Math.abs(totalIn);
    const feet = Math.floor(absIn / 12);
    const inches = absIn - feet * 12;
    return `${sign}${feet}' ${inches.toFixed(1)}"`;
  }
  return `${meters.toFixed(2)} m`;
}

export function formatArea(sqMeters, unit = 'm') {
  if (unit === 'ft') return `${(sqMeters * 10.76391).toFixed(2)} sq ft`;
  if (unit === 'cm') return `${(sqMeters * 10000).toFixed(0)} cm²`;
  if (unit === 'mm') return `${(sqMeters * 1e6).toFixed(0)} mm²`;
  return `${sqMeters.toFixed(2)} m²`;
}

export function formatVolume(cubicMeters, unit = 'm') {
  if (unit === 'ft') return `${(cubicMeters * 35.3147).toFixed(2)} cu ft`;
  return `${cubicMeters.toFixed(2)} m³`;
}

export function parseLengthInput(str, defaultUnit = 'm') {
  const s = String(str).trim().toLowerCase();
  if (!s) return null;
  // Feet & inches like 10'6" or 10' 6.5" or 12'
  const ftIn = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (ftIn) {
    const ft = parseFloat(ftIn[1]);
    const inch = ftIn[2] ? parseFloat(ftIn[2]) : 0;
    const sign = ft < 0 ? -1 : 1;
    return sign * (Math.abs(ft) * 0.3048 + inch * 0.0254);
  }
  const inOnly = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in)$/);
  if (inOnly) return parseFloat(inOnly[1]) * 0.0254;

  const numUnit = s.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|ft)?$/);
  if (!numUnit) return null;
  const val = parseFloat(numUnit[1]);
  const u = numUnit[2] || defaultUnit;
  if (u === 'mm') return val / 1000;
  if (u === 'cm') return val / 100;
  if (u === 'ft') return val * 0.3048;
  return val;
}
