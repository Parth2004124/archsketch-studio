import { mat4Identity, mat4Mul, mat4TransformPoint, mat4TransformDir, norm3 } from './math.js';
import { hexToRgbNorm } from './materials.js';

function triggerDownload(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export function exportProjectJSON(doc) {
  const safeName = doc.projectName.replace(/[^a-z0-9_-]+/gi, '_');
  triggerDownload(`${safeName}.archsketch.json`, doc.serialize(), 'application/json');
}

export function exportPNG(renderer, doc) {
  renderer.render();
  const safeName = doc.projectName.replace(/[^a-z0-9_-]+/gi, '_');
  renderer.glCanvas.toBlob((blob) => {
    if (blob) triggerDownload(`${safeName}_render.png`, blob, 'image/png');
  }, 'image/png');
}

export function exportOBJ(doc) {
  let obj = `# ArchSketch Studio Export - ${doc.projectName}\n`;
  let vOffset = 1;
  let vnOffset = 1;

  const visit = (ctxId, worldMat, prefix = '') => {
    const ctx = doc.contexts.get(ctxId);
    if (!ctx) return;
    if (ctx.faces.size > 0) {
      obj += `g ${prefix || 'model'}\n`;
      for (const face of ctx.faces.values()) {
        if (!doc.isLayerVisible(face.layerId)) continue;
        const tri = doc.triangulateFace(ctx, face);
        if (!tri || !tri.indices.length) continue;
        const wn = norm3(mat4TransformDir(worldMat, tri.normal));
        obj += `usemtl ${face.materialId}\n`;
        const baseV = vOffset;
        for (const p of tri.pts3D) {
          const wp = mat4TransformPoint(worldMat, p);
          // Convert Z-up to standard Y-up OBJ if desired, or preserve architectural Z-up:
          obj += `v ${wp.x.toFixed(5)} ${wp.z.toFixed(5)} ${(-wp.y).toFixed(5)}\n`;
          vOffset++;
        }
        obj += `vn ${wn.x.toFixed(5)} ${wn.z.toFixed(5)} ${(-wn.y).toFixed(5)}\n`;
        const nIdx = vnOffset++;
        for (let i = 0; i < tri.indices.length; i += 3) {
          const a = baseV + tri.indices[i];
          const b = baseV + tri.indices[i + 1];
          const c = baseV + tri.indices[i + 2];
          obj += `f ${a}//${nIdx} ${b}//${nIdx} ${c}//${nIdx}\n`;
        }
      }
    }
    for (const grp of ctx.groups.values()) {
      if (grp.hidden || !doc.isLayerVisible(grp.layerId)) continue;
      visit(grp.contextId, mat4Mul(worldMat, new Float32Array(grp.matrix)), grp.name.replace(/\s+/g, '_'));
    }
  };

  visit(doc.rootContextId, mat4Identity());
  const safeName = doc.projectName.replace(/[^a-z0-9_-]+/gi, '_');
  triggerDownload(`${safeName}.obj`, obj, 'text/plain');
}

export function exportGLTF(doc) {
  // Collect all triangles per material
  const positions = [];
  const normals = [];
  const matBuckets = new Map();

  const visit = (ctxId, worldMat) => {
    const ctx = doc.contexts.get(ctxId);
    if (!ctx) return;
    for (const face of ctx.faces.values()) {
      if (!doc.isLayerVisible(face.layerId)) continue;
      const tri = doc.triangulateFace(ctx, face);
      if (!tri || !tri.indices.length) continue;
      const wn = norm3(mat4TransformDir(worldMat, tri.normal));
      if (!matBuckets.has(face.materialId)) matBuckets.set(face.materialId, []);
      const bucket = matBuckets.get(face.materialId);
      for (let i = 0; i < tri.indices.length; i++) {
        const p = mat4TransformPoint(worldMat, tri.pts3D[tri.indices[i]]);
        // glTF uses Y-up right-handed: (x, z, -y)
        bucket.push({
          pos: [p.x, p.z, -p.y],
          norm: [wn.x, wn.z, -wn.y],
        });
      }
    }
    for (const grp of ctx.groups.values()) {
      if (grp.hidden || !doc.isLayerVisible(grp.layerId)) continue;
      visit(grp.contextId, mat4Mul(worldMat, new Float32Array(grp.matrix)));
    }
  };
  visit(doc.rootContextId, mat4Identity());

  const materials = [];
  const primitives = [];
  const accessors = [];
  const bufferViews = [];
  let totalVerts = 0;

  for (const bucket of matBuckets.values()) totalVerts += bucket.length;
  if (totalVerts === 0) return;

  const byteLen = totalVerts * 24; // 12 pos + 12 norm
  const bin = new ArrayBuffer(byteLen);
  const f32 = new Float32Array(bin);

  let offsetFloats = 0;
  let matIdx = 0;
  for (const [matId, bucket] of matBuckets.entries()) {
    const mat = doc.materials.get(matId) || doc.materials.get('plaster');
    const rgb = hexToRgbNorm(mat.color);
    materials.push({
      name: mat.name,
      pbrMetallicRoughness: {
        baseColorFactor: [rgb[0], rgb[1], rgb[2], mat.opacity ?? 1.0],
        metallicFactor: mat.texType === 'metal' || mat.texType === 'seam' ? 0.6 : 0.05,
        roughnessFactor: mat.roughness ?? 0.8,
      },
      alphaMode: (mat.opacity ?? 1.0) < 0.99 ? 'BLEND' : 'OPAQUE',
      doubleSided: true,
    });

    const minP = [Infinity, Infinity, Infinity];
    const maxP = [-Infinity, -Infinity, -Infinity];
    const startByte = offsetFloats * 4;
    for (const v of bucket) {
      for (let k = 0; k < 3; k++) {
        minP[k] = Math.min(minP[k], v.pos[k]);
        maxP[k] = Math.max(maxP[k], v.pos[k]);
      }
      f32[offsetFloats++] = v.pos[0]; f32[offsetFloats++] = v.pos[1]; f32[offsetFloats++] = v.pos[2];
      f32[offsetFloats++] = v.norm[0]; f32[offsetFloats++] = v.norm[1]; f32[offsetFloats++] = v.norm[2];
    }

    const viewIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: startByte, byteLength: bucket.length * 24, byteStride: 24, target: 34962 });
    const posAcc = accessors.length;
    accessors.push({ bufferView: viewIdx, byteOffset: 0, componentType: 5126, count: bucket.length, type: 'VEC3', min: minP, max: maxP });
    const normAcc = accessors.length;
    accessors.push({ bufferView: viewIdx, byteOffset: 12, componentType: 5126, count: bucket.length, type: 'VEC3' });

    primitives.push({ attributes: { POSITION: posAcc, NORMAL: normAcc }, material: matIdx });
    matIdx++;
  }

  // Encode binary as base64
  const bytes = new Uint8Array(bin);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);

  const gltf = {
    asset: { version: '2.0', generator: 'ArchSketch Studio' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: doc.projectName }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: byteLen }],
  };

  const safeName = doc.projectName.replace(/[^a-z0-9_-]+/gi, '_');
  triggerDownload(`${safeName}.gltf`, JSON.stringify(gltf, null, 2), 'model/gltf+json');
}

// Export 2D Orthographic Architectural Plan SVG (top-down XY projection)
export function exportSVGPlan(doc) {
  const m = doc.computeSceneMetrics();
  const pad = 2.0;
  const minX = m.min.x - pad;
  const minY = m.min.y - pad;
  const w = Math.max(10, m.max.x - m.min.x + pad * 2);
  const h = Math.max(10, m.max.y - m.min.y + pad * 2);

  let linesSvg = '';
  const visit = (ctxId, worldMat) => {
    const ctx = doc.contexts.get(ctxId);
    if (!ctx) return;
    for (const e of ctx.edges.values()) {
      if (!doc.isLayerVisible(e.layerId) || e.soft || e.hidden) continue;
      const a = mat4TransformPoint(worldMat, ctx.vertices.get(e.v1));
      const b = mat4TransformPoint(worldMat, ctx.vertices.get(e.v2));
      // Invert Y for SVG screen coordinates
      linesSvg += `<line x1="${a.x.toFixed(3)}" y1="${(-a.y).toFixed(3)}" x2="${b.x.toFixed(3)}" y2="${(-b.y).toFixed(3)}" stroke="#1e293b" stroke-width="0.04" stroke-linecap="round"/>\n`;
    }
    for (const grp of ctx.groups.values()) {
      if (grp.hidden || !doc.isLayerVisible(grp.layerId)) continue;
      visit(grp.contextId, mat4Mul(worldMat, new Float32Array(grp.matrix)));
    }
  };
  visit(doc.rootContextId, mat4Identity());

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(2)} ${(-m.max.y - pad).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="1200" height="${Math.round(1200 * (h / w))}">
  <rect x="${minX.toFixed(2)}" y="${(-m.max.y - pad).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#ffffff"/>
  ${linesSvg}
</svg>`;

  const safeName = doc.projectName.replace(/[^a-z0-9_-]+/gi, '_');
  triggerDownload(`${safeName}_plan.svg`, svg, 'image/svg+xml');
}
