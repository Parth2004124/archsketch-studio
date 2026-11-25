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
  mat4Mul,
  mat4Invert,
  mat4LookAt,
  mat4Perspective,
  mat4Ortho,
  mat4TransformPoint,
  mat4TransformDir,
  rayTriangle,
  raySegmentClosest,
  formatLength,
} from './math.js';
import { generateProceduralTextureCanvas, hexToRgbNorm } from './materials.js';

const SHADOW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uLightVP;
uniform vec4 uSectionPlanes[3];
uniform int uSectionCount;
out vec3 vWorldPos;
void main() {
  vWorldPos = aPos;
  gl_Position = uLightVP * vec4(aPos, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
uniform vec4 uSectionPlanes[3];
uniform int uSectionCount;
void main() {
  for (int i = 0; i < 3; i++) {
    if (i < uSectionCount && dot(vWorldPos, uSectionPlanes[i].xyz) - uSectionPlanes[i].w > 0.001) {
      discard;
    }
  }
}`;

const FACE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aColor; // rgb + opacity
layout(location = 4) in float aSelected;
layout(location = 5) in float aHovered;

uniform mat4 uVP;
uniform mat4 uLightVP;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
out float vSelected;
out float vHovered;
out vec4 vLightSpacePos;

void main() {
  vWorldPos = aPos;
  vNormal = aNormal;
  vUv = aUv;
  vColor = aColor;
  vSelected = aSelected;
  vHovered = aHovered;
  vLightSpacePos = uLightVP * vec4(aPos, 1.0);
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FACE_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
in float vSelected;
in float vHovered;
in vec4 vLightSpacePos;

uniform sampler2D uTex;
uniform sampler2D uShadowMap;
uniform int uUseTex;
uniform int uStyleMode; // 0=shaded, 1=clay, 2=hidden, 3=xray, 4=monochrome
uniform int uShadowsEnabled;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCamPos;
uniform vec4 uSectionPlanes[3];
uniform int uSectionCount;
uniform int uSectionFill;
uniform vec3 uFogColor;
uniform float uFogDensity;

out vec4 fragColor;

float calcShadow(vec4 lightPos, vec3 n) {
  if (uShadowsEnabled == 0) return 0.0;
  vec3 proj = lightPos.xyz / lightPos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 0.0;
  float ndotl = max(dot(n, uSunDir), 0.0);
  float bias = max(0.0018 * (1.0 - ndotl), 0.0005);
  float shadow = 0.0;
  vec2 texel = vec2(1.0 / 2048.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      float pcfDepth = texture(uShadowMap, proj.xy + vec2(x, y) * texel).r;
      shadow += (proj.z - bias > pcfDepth) ? 1.0 : 0.0;
    }
  }
  return shadow / 9.0;
}

void main() {
  for (int i = 0; i < 3; i++) {
    if (i < uSectionCount && dot(vWorldPos, uSectionPlanes[i].xyz) - uSectionPlanes[i].w > 0.001) {
      discard;
    }
  }

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;

  // Section cut interior poche shading for backfaces when section active
  if (!gl_FrontFacing && uSectionCount > 0 && uSectionFill == 1) {
    fragColor = vec4(0.18, 0.20, 0.23, 1.0);
    return;
  }

  vec3 baseCol = vColor.rgb;
  float alpha = vColor.a;

  if (uStyleMode == 0) {
    if (uUseTex == 1) {
      vec3 texel = texture(uTex, vUv).rgb;
      baseCol = texel;
    }
  } else if (uStyleMode == 1) {
    // Architectural Clay Maquette
    baseCol = vec3(0.93, 0.92, 0.89);
    alpha = (alpha < 0.9) ? 0.35 : 1.0;
  } else if (uStyleMode == 2) {
    // Hidden Line / Technical Blueprint
    fragColor = vec4(0.985, 0.988, 0.992, 1.0);
    return;
  } else if (uStyleMode == 3) {
    // X-Ray mode
    alpha = min(alpha, 0.36);
  } else if (uStyleMode == 4) {
    // Monochrome orientation check
    baseCol = gl_FrontFacing ? vec3(0.94, 0.92, 0.88) : vec3(0.51, 0.61, 0.72);
    alpha = 1.0;
  }

  // Sun + Sky Hemisphere Lighting
  float hemi = 0.5 + 0.5 * N.z;
  vec3 skyAmb = mix(vec3(0.42, 0.44, 0.48), vec3(0.76, 0.82, 0.90), hemi);
  float diff = max(dot(N, uSunDir), 0.0);
  float shadow = calcShadow(vLightSpacePos, N);

  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 H = normalize(uSunDir + V);
  float spec = (alpha < 0.9) ? pow(max(dot(N, H), 0.0), 64.0) * 0.45 : pow(max(dot(N, H), 0.0), 24.0) * 0.05;

  vec3 lit = baseCol * (skyAmb * 0.60 + uSunColor * diff * (1.0 - shadow * 0.72) * 0.78) + uSunColor * spec * (1.0 - shadow);

  // Subtle selection / hover highlight (SketchUp blue stipple feel)
  if (vSelected > 0.5) {
    lit = mix(lit, vec3(0.18, 0.49, 0.96), 0.36);
  } else if (vHovered > 0.5) {
    lit = mix(lit, vec3(0.22, 0.74, 0.97), 0.20);
  }

  // Subtle distance horizon fog
  if (uFogDensity > 0.0) {
    float dist = length(uCamPos - vWorldPos);
    float fog = clamp(1.0 - exp(-pow(dist * uFogDensity, 2.0)), 0.0, 0.85);
    lit = mix(lit, uFogColor, fog);
  }

  fragColor = vec4(lit, alpha);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
uniform mat4 uVP;
out vec3 vWorldPos;
out vec4 vColor;
void main() {
  vWorldPos = aPos;
  vColor = aColor;
  vec4 clip = uVP * vec4(aPos, 1.0);
  clip.z -= 0.00018 * clip.w; // bias edges slightly toward camera to prevent z-fighting
  gl_Position = clip;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec4 vColor;
uniform vec4 uSectionPlanes[3];
uniform int uSectionCount;
uniform int uIgnoreSection;
out vec4 fragColor;
void main() {
  if (uIgnoreSection == 0) {
    for (int i = 0; i < 3; i++) {
      if (i < uSectionCount && dot(vWorldPos, uSectionPlanes[i].xyz) - uSectionPlanes[i].w > 0.004) {
        discard;
      }
    }
  }
  fragColor = vColor;
}`;

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
  }
  return s;
}

function createProgram(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(p));
  }
  return p;
}

export class CADRenderer {
  constructor(glCanvas, hudCanvas, doc) {
    this.glCanvas = glCanvas;
    this.hudCanvas = hudCanvas;
    this.hud = hudCanvas.getContext('2d');
    this.doc = doc;

    this.gl = glCanvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false });
    if (!this.gl) throw new Error('WebGL2 is required for ArchSketch Studio.');

    // Camera state (Z-up architectural orbit)
    this.camera = {
      target: v3(0, 0, 1.2),
      azimuth: -0.78,    // radians around Z
      elevation: 0.48,   // radians above XY
      distance: 22.0,
      fov: (42 * Math.PI) / 180,
      ortho: false,
      orthoSize: 16.0,
      walkMode: false,
      eyePos: v3(0, -10, 1.65),
      yaw: 0,
      pitch: 0,
    };

    // Visual & Heliodon settings
    this.styleMode = 0; // 0=shaded, 1=clay, 2=hidden, 3=xray, 4=monochrome
    this.showShadows = true;
    this.showGrid = true;
    this.showAxes = true;
    this.showProfiles = true;
    this.showHiddenGeo = false;
    this.showFog = true;
    this.skyTheme = 'daylight'; // 'daylight' | 'studio' | 'blueprint'

    this.sun = {
      hour: 14.2,      // 2:12 PM
      month: 6,        // June
      latitude: 38,    // degrees North
      northAngle: 15,  // degrees
      animating: false,
    };

    this.hovered = null; // { type, id, point, normal }
    this.overlayState = {
      inferencePoint: null,
      inferenceType: null, // 'endpoint' | 'midpoint' | 'edge' | 'face' | 'axis_x' | 'axis_y' | 'axis_z' | 'grid'
      inferenceLine: null, // { p1, p2, color }
      axisLock: null,      // 'x' | 'y' | 'z' | null
      previewLines: [],    // [{ p1, p2, color, dashed }]
      previewPolys: [],    // [{ pts, color }]
      marquee: null,       // { x1, y1, x2, y2, crossing }
      cursorLabel: null,   // { x, y, text }
    };

    this.cachedBatches = null;
    this.pickMeshes = [];
    this.pickEdges = [];
    this.textures = new Map();

    this.initGL();
    this.buildGridAndAxes();
  }

  initGL() {
    const gl = this.gl;
    this.progShadow = createProgram(gl, SHADOW_VS, SHADOW_FS);
    this.progFace = createProgram(gl, FACE_VS, FACE_FS);
    this.progLine = createProgram(gl, LINE_VS, LINE_FS);

    // Shadow FBO (2048x2048 depth texture)
    this.shadowSize = 2048;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.shadowFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // White fallback 1x1 texture
    this.whiteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

    this.gridVAO = gl.createVertexArray();
    this.gridVBO = gl.createBuffer();
    this.axesVAO = gl.createVertexArray();
    this.axesVBO = gl.createBuffer();
    this.edgeVAO = gl.createVertexArray();
    this.edgeVBO = gl.createBuffer();
    this.guideVAO = gl.createVertexArray();
    this.guideVBO = gl.createBuffer();

    this.ensureMaterialTextures();
  }

  ensureMaterialTextures() {
    const gl = this.gl;
    for (const mat of this.doc.materials.values()) {
      if (this.textures.has(mat.id)) continue;
      const canvas = generateProceduralTextureCanvas(mat, 256);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.textures.set(mat.id, tex);
    }
  }

  buildGridAndAxes() {
    const gl = this.gl;
    // Grid lines (-30m to 30m)
    const gData = [];
    const pushLine = (arr, x1, y1, z1, x2, y2, z2, r, g, b, a) => {
      arr.push(x1, y1, z1, r, g, b, a, x2, y2, z2, r, g, b, a);
    };
    for (let i = -30; i <= 30; i++) {
      if (i === 0) continue;
      const major = i % 5 === 0;
      const alpha = major ? 0.24 : 0.11;
      const c = major ? 0.35 : 0.45;
      pushLine(gData, i, -30, -0.003, i, 30, -0.003, c, c, c, alpha);
      pushLine(gData, -30, i, -0.003, 30, i, -0.003, c, c, c, alpha);
    }
    this.gridVertCount = gData.length / 7;
    gl.bindVertexArray(this.gridVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gData), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);

    // Architectural RGB Axes (Positive solid, Negative subtle)
    const aData = [];
    // X = Red
    pushLine(aData, 0, 0, 0.002, 80, 0, 0.002, 0.88, 0.18, 0.18, 0.95);
    pushLine(aData, -80, 0, 0.002, 0, 0, 0.002, 0.88, 0.18, 0.18, 0.30);
    // Y = Green
    pushLine(aData, 0, 0, 0.002, 0, 80, 0.002, 0.16, 0.68, 0.28, 0.95);
    pushLine(aData, 0, -80, 0.002, 0, 0, 0.002, 0.16, 0.68, 0.28, 0.30);
    // Z = Blue
    pushLine(aData, 0, 0, 0, 0, 0, 60, 0.18, 0.44, 0.92, 0.95);
    pushLine(aData, 0, 0, -25, 0, 0, 0, 0.18, 0.44, 0.92, 0.28);

    this.axesVertCount = aData.length / 7;
    gl.bindVertexArray(this.axesVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.axesVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(aData), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
  }

  getEyePosition() {
    if (this.camera.walkMode) return { ...this.camera.eyePos };
    const { target, azimuth, elevation, distance } = this.camera;
    const ce = Math.cos(elevation);
    return {
      x: target.x + distance * ce * Math.cos(azimuth),
      y: target.y + distance * ce * Math.sin(azimuth),
      z: target.z + distance * Math.sin(elevation),
    };
  }

  getCameraMatrices() {
    const w = this.glCanvas.width || 1;
    const h = this.glCanvas.height || 1;
    const aspect = w / h;
    let eye, target, up;
    if (this.camera.walkMode) {
      eye = this.camera.eyePos;
      const cp = Math.cos(this.camera.pitch);
      target = add3(eye, {
        x: cp * Math.cos(this.camera.yaw),
        y: cp * Math.sin(this.camera.yaw),
        z: Math.sin(this.camera.pitch),
      });
      up = { x: 0, y: 0, z: 1 };
    } else {
      eye = this.getEyePosition();
      target = this.camera.target;
      up = Math.abs(Math.sin(this.camera.elevation)) > 0.995
        ? { x: -Math.cos(this.camera.azimuth), y: -Math.sin(this.camera.azimuth), z: 0 }
        : { x: 0, y: 0, z: 1 };
    }
    const view = mat4LookAt(eye, target, up);
    let proj;
    if (this.camera.ortho && !this.camera.walkMode) {
      const halfH = this.camera.orthoSize * 0.5;
      const halfW = halfH * aspect;
      proj = mat4Ortho(-halfW, halfW, -halfH, halfH, -200, 500);
    } else {
      proj = mat4Perspective(this.camera.fov, aspect, 0.08, 600);
    }
    const vp = mat4Mul(proj, view);
    const invVP = mat4Invert(vp);
    return { eye, target, view, proj, vp, invVP, aspect };
  }

  setStandardView(preset) {
    this.camera.walkMode = false;
    if (preset === 'iso') {
      this.camera.azimuth = -0.78;
      this.camera.elevation = 0.48;
      this.camera.ortho = false;
    } else if (preset === 'top') {
      this.camera.azimuth = -Math.PI * 0.5;
      this.camera.elevation = Math.PI * 0.4999;
      this.camera.ortho = true;
    } else if (preset === 'front') {
      this.camera.azimuth = -Math.PI * 0.5;
      this.camera.elevation = 0.001;
      this.camera.ortho = true;
    } else if (preset === 'back') {
      this.camera.azimuth = Math.PI * 0.5;
      this.camera.elevation = 0.001;
      this.camera.ortho = true;
    } else if (preset === 'right') {
      this.camera.azimuth = 0.0;
      this.camera.elevation = 0.001;
      this.camera.ortho = true;
    } else if (preset === 'left') {
      this.camera.azimuth = Math.PI;
      this.camera.elevation = 0.001;
      this.camera.ortho = true;
    }
  }

  zoomExtents() {
    const m = this.doc.computeSceneMetrics();
    const center = scale3(add3(m.min, m.max), 0.5);
    const span = Math.max(4, dist3(m.min, m.max));
    this.camera.target = center;
    this.camera.distance = span * 1.15;
    this.camera.orthoSize = span * 0.95;
  }

  screenToRay(sx, sy) {
    const rect = this.glCanvas.getBoundingClientRect();
    const ndcX = ((sx - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((sy - rect.top) / rect.height) * 2 - 1);
    const { invVP } = this.getCameraMatrices();
    const nearP = mat4TransformPoint(invVP, { x: ndcX, y: ndcY, z: -1 });
    const farP = mat4TransformPoint(invVP, { x: ndcX, y: ndcY, z: 1 });
    return {
      ro: nearP,
      rd: norm3(sub3(farP, nearP)),
    };
  }

  worldToScreen(p) {
    const { vp } = this.getCameraMatrices();
    const w = vp[3] * p.x + vp[7] * p.y + vp[11] * p.z + vp[15];
    if (w <= 0.001) return null;
    const ndcX = (vp[0] * p.x + vp[4] * p.y + vp[8] * p.z + vp[12]) / w;
    const ndcY = (vp[1] * p.x + vp[5] * p.y + vp[9] * p.z + vp[13]) / w;
    const rect = this.glCanvas.getBoundingClientRect();
    return {
      x: (ndcX * 0.5 + 0.5) * rect.width,
      y: (-ndcY * 0.5 + 0.5) * rect.height,
    };
  }

  // Solar Heliodon calculation (simplified astronomical equation)
  getSunVectorAndColor() {
    const { hour, month, latitude, northAngle } = this.sun;
    const decl = 23.44 * Math.sin(((2 * Math.PI) / 12) * (month - 3.2)) * (Math.PI / 180);
    const lat = (latitude * Math.PI) / 180;
    const ha = ((hour - 12) * 15 * Math.PI) / 180;

    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    const alt = Math.max(0.06, Math.asin(clamp(sinAlt, -1, 1)));
    const cosAz = (Math.sin(decl) - Math.sin(lat) * Math.sin(alt)) / (Math.cos(lat) * Math.cos(alt) + 1e-6);
    let az = Math.acos(clamp(cosAz, -1, 1));
    if (ha > 0) az = 2 * Math.PI - az;
    az += (northAngle * Math.PI) / 180;

    // Convert compass azimuth (0 = +Y North) & altitude to XYZ
    const sunDir = norm3({
      x: Math.cos(alt) * Math.sin(az),
      y: Math.cos(alt) * Math.cos(az),
      z: Math.sin(alt),
    });

    // Warm golden-hour color at low altitude, crisp daylight high up
    const low = 1.0 - clamp((alt - 0.06) / 0.45, 0, 1);
    const sunColor = [
      1.0,
      1.0 - low * 0.25,
      0.96 - low * 0.45,
    ];
    return { sunDir, sunColor, altitudeDeg: (alt * 180) / Math.PI };
  }

  // Compile Document B-Rep into GPU vertex buffers + CPU picking cache
  rebuildSceneBuffers() {
    const gl = this.gl;
    this.ensureMaterialTextures();

    // Group triangles by materialId -> opaque & transparent batches
    const matBatches = new Map(); // matId -> array of floats (13 per vertex: pos3, norm3, uv2, col4, sel1, hov1)
    const edgeVerts = []; // 7 floats per vertex: pos3, col4
    this.pickMeshes = [];
    this.pickEdges = [];

    const activeCtxId = this.doc.activeContextId;
    const hov = this.hovered;

    const pushVert = (arr, p, n, uv, col, sel, hovFlag) => {
      arr.push(
        p.x, p.y, p.z,
        n.x, n.y, n.z,
        uv.x, uv.y,
        col[0], col[1], col[2], col[3],
        sel, hovFlag
      );
    };

    const visitContext = (ctxId, worldMat, isActiveCtx, parentGroupId = null, isDimmed = false) => {
      const ctx = this.doc.contexts.get(ctxId);
      if (!ctx) return;

      for (const face of ctx.faces.values()) {
        if (!this.doc.isLayerVisible(face.layerId)) continue;
        const tri = this.doc.triangulateFace(ctx, face);
        if (!tri || !tri.indices || tri.indices.length === 0) continue;

        const mat = this.doc.materials.get(face.materialId) || this.doc.materials.get('plaster');
        const rgb = hexToRgbNorm(mat.color);
        const alpha = mat.opacity ?? 1.0;
        const texScale = mat.scale || 2.0;

        const isSel = isActiveCtx
          ? (this.doc.selected.faces.has(face.id) ? 1.0 : 0.0)
          : (parentGroupId && this.doc.selected.groups.has(parentGroupId) ? 1.0 : 0.0);
        const isHov = hov && (
          (isActiveCtx && hov.type === 'face' && hov.id === face.id) ||
          (parentGroupId && hov.type === 'group' && hov.id === parentGroupId)
        ) ? 1.0 : 0.0;

        const wn = norm3(mat4TransformDir(worldMat, tri.normal));
        const worldPts = tri.pts3D.map((p) => mat4TransformPoint(worldMat, p));

        if (!matBatches.has(mat.id)) {
          matBatches.set(mat.id, { mat, data: [], transparent: alpha < 0.99 });
        }
        const batch = matBatches.get(mat.id);

        const triList = [];
        for (let i = 0; i < tri.indices.length; i += 3) {
          const i0 = tri.indices[i];
          const i1 = tri.indices[i + 1];
          const i2 = tri.indices[i + 2];
          const p0 = worldPts[i0], p1 = worldPts[i1], p2 = worldPts[i2];
          const u0 = { x: tri.uvs[i0].x / texScale, y: tri.uvs[i0].y / texScale };
          const u1 = { x: tri.uvs[i1].x / texScale, y: tri.uvs[i1].y / texScale };
          const u2 = { x: tri.uvs[i2].x / texScale, y: tri.uvs[i2].y / texScale };
          const c = isDimmed ? [rgb[0] * 0.75 + 0.2, rgb[1] * 0.75 + 0.2, rgb[2] * 0.75 + 0.2, alpha] : [rgb[0], rgb[1], rgb[2], alpha];
          pushVert(batch.data, p0, wn, u0, c, isSel, isHov);
          pushVert(batch.data, p1, wn, u1, c, isSel, isHov);
          pushVert(batch.data, p2, wn, u2, c, isSel, isHov);
          triList.push([p0, p1, p2]);
        }

        this.pickMeshes.push({
          type: isActiveCtx ? 'face' : 'group',
          id: isActiveCtx ? face.id : parentGroupId,
          faceId: face.id,
          ctxId,
          normal: wn,
          tris: triList,
        });
      }

      // Edges
      for (const edge of ctx.edges.values()) {
        if (!this.doc.isLayerVisible(edge.layerId)) continue;
        if (edge.hidden && !this.showHiddenGeo) continue;
        if (edge.soft && !this.showHiddenGeo) continue;
        const v1 = ctx.vertices.get(edge.v1);
        const v2 = ctx.vertices.get(edge.v2);
        if (!v1 || !v2) continue;
        const p1 = mat4TransformPoint(worldMat, v1);
        const p2 = mat4TransformPoint(worldMat, v2);

        const isSel = isActiveCtx
          ? this.doc.selected.edges.has(edge.id)
          : (parentGroupId && this.doc.selected.groups.has(parentGroupId));
        const isHov = hov && isActiveCtx && hov.type === 'edge' && hov.id === edge.id;

        const incFaces = this.doc.getFacesForEdge(ctx, edge.v1, edge.v2);
        let isProfile = incFaces.length === 1;
        if (incFaces.length === 2) {
          const d = dot3(incFaces[0].normal, incFaces[1].normal);
          if (d < 0.7) isProfile = true;
        }

        let col;
        if (isSel) col = [0.15, 0.45, 0.96, 1.0];
        else if (isHov) col = [0.20, 0.72, 0.98, 1.0];
        else if (edge.soft) col = [0.45, 0.45, 0.50, 0.4];
        else if (isDimmed) col = [0.45, 0.47, 0.50, 0.55];
        else if (this.showProfiles && isProfile) col = [0.09, 0.10, 0.12, 0.95];
        else col = [0.18, 0.20, 0.24, 0.78];

        edgeVerts.push(p1.x, p1.y, p1.z, col[0], col[1], col[2], col[3]);
        edgeVerts.push(p2.x, p2.y, p2.z, col[0], col[1], col[2], col[3]);

        this.pickEdges.push({
          type: isActiveCtx ? 'edge' : 'group',
          id: isActiveCtx ? edge.id : parentGroupId,
          edgeId: edge.id,
          ctxId,
          p1, p2,
        });
      }

      // Nested Groups
      for (const grp of ctx.groups.values()) {
        if (grp.hidden || !this.doc.isLayerVisible(grp.layerId)) continue;
        const gMat = mat4Mul(worldMat, new Float32Array(grp.matrix));
        const childIsActive = grp.contextId === activeCtxId;
        const topGroupForHit = isActiveCtx ? grp.id : parentGroupId;
        visitContext(
          grp.contextId,
          gMat,
          childIsActive,
          childIsActive ? null : topGroupForHit,
          !childIsActive && activeCtxId !== this.doc.rootContextId && !isActiveCtx
        );
      }
    };

    const rootActive = activeCtxId === this.doc.rootContextId;
    visitContext(this.doc.rootContextId, mat4Identity(), rootActive, null, !rootActive);

    // Dispose old VAOs
    if (this.cachedBatches) {
      for (const b of this.cachedBatches.batches) {
        gl.deleteVertexArray(b.vao);
        gl.deleteBuffer(b.vbo);
      }
    }

    const batches = [];
    const stride = 14 * 4;
    for (const entry of matBatches.values()) {
      if (entry.data.length === 0) continue;
      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(entry.data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 48);
      gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 52);
      batches.push({
        vao,
        vbo,
        count: entry.data.length / 14,
        mat: entry.mat,
        transparent: entry.transparent,
      });
    }

    // Sort opaque first, transparent last
    batches.sort((a, b) => (a.transparent === b.transparent ? 0 : a.transparent ? 1 : -1));

    gl.bindVertexArray(this.edgeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeVerts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    this.cachedBatches = { batches, edgeCount: edgeVerts.length / 7 };
    this.doc.dirty = false;
  }

  pickScene(sx, sy, preferEdges = false) {
    const { ro, rd } = this.screenToRay(sx, sy);
    const activeSectionPlanes = this.getActiveSectionUniforms();

    const isClipped = (pt) => {
      for (const sp of activeSectionPlanes) {
        if (pt.x * sp[0] + pt.y * sp[1] + pt.z * sp[2] - sp[3] > 0.002) return true;
      }
      return false;
    };

    let bestFace = null;
    for (const m of this.pickMeshes) {
      for (const [a, b, c] of m.tris) {
        const hit = rayTriangle(ro, rd, a, b, c, true);
        if (hit && !isClipped(hit.point)) {
          if (!bestFace || hit.t < bestFace.distance) {
            bestFace = {
              type: m.type,
              id: m.id,
              faceId: m.faceId,
              ctxId: m.ctxId,
              point: hit.point,
              normal: m.normal,
              distance: hit.t,
            };
          }
        }
      }
    }

    // Also test edge proximity in screen space
    let bestEdge = null;
    for (const e of this.pickEdges) {
      const s1 = this.worldToScreen(e.p1);
      const s2 = this.worldToScreen(e.p2);
      if (!s1 || !s2) continue;
      const rect = this.glCanvas.getBoundingClientRect();
      const lx = sx - rect.left;
      const ly = sy - rect.top;
      const dx = s2.x - s1.x, dy = s2.y - s1.y;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 1 ? ((lx - s1.x) * dx + (ly - s1.y) * dy) / lenSq : 0;
      t = clamp(t, 0, 1);
      const px = s1.x + t * dx, py = s1.y + t * dy;
      const screenDist = Math.hypot(lx - px, ly - py);
      if (screenDist < 7) {
        const segClose = raySegmentClosest(ro, rd, e.p1, e.p2);
        if (!isClipped(segClose.pointOnSeg)) {
          if (!bestFace || segClose.rayT <= bestFace.distance + 0.05) {
            if (!bestEdge || screenDist < bestEdge.screenDist) {
              bestEdge = {
                type: e.type,
                id: e.id,
                edgeId: e.edgeId,
                ctxId: e.ctxId,
                point: segClose.pointOnSeg,
                normal: v3(0, 0, 1),
                distance: segClose.rayT,
                screenDist,
              };
            }
          }
        }
      }
    }

    if (preferEdges && bestEdge) return bestEdge;
    if (bestEdge && (!bestFace || bestEdge.screenDist < 4.5)) return bestEdge;
    return bestFace;
  }

  getActiveSectionUniforms() {
    const out = [];
    for (const sp of this.doc.sectionPlanes) {
      if (!sp.active) continue;
      const sign = sp.flipped ? -1 : 1;
      const n =
        sp.axis === 'x' ? [sign, 0, 0] :
        sp.axis === 'y' ? [0, sign, 0] :
        [0, 0, sign];
      out.push([n[0], n[1], n[2], sp.offset * sign]);
      if (out.length >= 3) break;
    }
    return out;
  }

  render() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.glCanvas.getBoundingClientRect();
    const pw = Math.max(1, Math.floor(rect.width * dpr));
    const ph = Math.max(1, Math.floor(rect.height * dpr));
    if (this.glCanvas.width !== pw || this.glCanvas.height !== ph) {
      this.glCanvas.width = pw;
      this.glCanvas.height = ph;
      this.hudCanvas.width = pw;
      this.hudCanvas.height = ph;
    }

    if (this.doc.dirty || !this.cachedBatches) {
      this.rebuildSceneBuffers();
    }

    const { eye, vp } = this.getCameraMatrices();
    const { sunDir, sunColor } = this.getSunVectorAndColor();
    const sectionPlanes = this.getActiveSectionUniforms();
    const sectionFlat = new Float32Array(12);
    for (let i = 0; i < sectionPlanes.length; i++) {
      sectionFlat.set(sectionPlanes[i], i * 4);
    }
    const sectionFill = this.doc.sectionPlanes.some((s) => s.active && s.showFill !== false) ? 1 : 0;

    // Fit directional light frustum around scene bounds
    const metrics = this.doc.computeSceneMetrics();
    const sceneCenter = scale3(add3(metrics.min, metrics.max), 0.5);
    const radius = Math.max(18, dist3(metrics.min, metrics.max) * 0.75);
    const lightEye = add3(sceneCenter, scale3(sunDir, radius * 2.2));
    const lightView = mat4LookAt(lightEye, sceneCenter, { x: 0, y: 0, z: 1 });
    const lightProj = mat4Ortho(-radius, radius, -radius, radius, 1, radius * 5);
    const lightVP = mat4Mul(lightProj, lightView);

    // ---- PASS 1: SUN SHADOW MAP ----
    if (this.showShadows && this.styleMode !== 2) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(this.progShadow);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progShadow, 'uLightVP'), false, lightVP);
      gl.uniform4fv(gl.getUniformLocation(this.progShadow, 'uSectionPlanes'), sectionFlat);
      gl.uniform1i(gl.getUniformLocation(this.progShadow, 'uSectionCount'), sectionPlanes.length);

      for (const b of this.cachedBatches.batches) {
        if (b.transparent) continue;
        gl.bindVertexArray(b.vao);
        gl.drawArrays(gl.TRIANGLES, 0, b.count);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ---- PASS 2: MAIN SCENE ----
    gl.viewport(0, 0, pw, ph);
    let bg = [0.91, 0.94, 0.97];
    if (this.styleMode === 2 || this.skyTheme === 'studio') bg = [0.96, 0.965, 0.97];
    else if (this.skyTheme === 'blueprint') bg = [0.09, 0.16, 0.28];
    else if (this.styleMode === 1) bg = [0.93, 0.93, 0.92];
    gl.clearColor(bg[0], bg[1], bg[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Prepare Face Program
    gl.useProgram(this.progFace);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFace, 'uVP'), false, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFace, 'uLightVP'), false, lightVP);
    gl.uniform1i(gl.getUniformLocation(this.progFace, 'uStyleMode'), this.styleMode);
    gl.uniform1i(gl.getUniformLocation(this.progFace, 'uShadowsEnabled'), this.showShadows ? 1 : 0);
    gl.uniform3fv(gl.getUniformLocation(this.progFace, 'uSunDir'), [sunDir.x, sunDir.y, sunDir.z]);
    gl.uniform3fv(gl.getUniformLocation(this.progFace, 'uSunColor'), sunColor);
    gl.uniform3fv(gl.getUniformLocation(this.progFace, 'uCamPos'), [eye.x, eye.y, eye.z]);
    gl.uniform4fv(gl.getUniformLocation(this.progFace, 'uSectionPlanes'), sectionFlat);
    gl.uniform1i(gl.getUniformLocation(this.progFace, 'uSectionCount'), sectionPlanes.length);
    gl.uniform1i(gl.getUniformLocation(this.progFace, 'uSectionFill'), sectionFill);
    gl.uniform3fv(gl.getUniformLocation(this.progFace, 'uFogColor'), bg);
    gl.uniform1f(gl.getUniformLocation(this.progFace, 'uFogDensity'), this.showFog && !this.camera.ortho ? 0.0085 : 0.0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(gl.getUniformLocation(this.progFace, 'uShadowMap'), 1);

    // 1. Opaque Faces first (writes depth)
    gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    for (const b of this.cachedBatches.batches) {
      if (b.transparent || this.styleMode === 3) continue;
      gl.activeTexture(gl.TEXTURE0);
      const tex = this.textures.get(b.mat.id) || this.whiteTex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.progFace, 'uTex'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progFace, 'uUseTex'), this.styleMode === 0 ? 1 : 0);
      gl.bindVertexArray(b.vao);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // 2. Grid & RGB Axes (occluded by opaque geometry)
    gl.depthMask(false);
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uVP'), false, vp);
    gl.uniform4fv(gl.getUniformLocation(this.progLine, 'uSectionPlanes'), sectionFlat);
    gl.uniform1i(gl.getUniformLocation(this.progLine, 'uSectionCount'), sectionPlanes.length);
    gl.uniform1i(gl.getUniformLocation(this.progLine, 'uIgnoreSection'), 1);

    if (this.showGrid) {
      gl.bindVertexArray(this.gridVAO);
      gl.drawArrays(gl.LINES, 0, this.gridVertCount);
    }
    if (this.showAxes) {
      gl.bindVertexArray(this.axesVAO);
      gl.drawArrays(gl.LINES, 0, this.axesVertCount);
    }

    // 3. Transparent / X-Ray Faces
    gl.useProgram(this.progFace);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    for (const b of this.cachedBatches.batches) {
      if (!(b.transparent || this.styleMode === 3)) continue;
      gl.activeTexture(gl.TEXTURE0);
      const tex = this.textures.get(b.mat.id) || this.whiteTex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.progFace, 'uTex'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progFace, 'uUseTex'), this.styleMode === 0 ? 1 : 0);
      gl.bindVertexArray(b.vao);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);

    // 4. Crisp Edges
    if (this.cachedBatches.edgeCount > 0) {
      gl.useProgram(this.progLine);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uVP'), false, vp);
      gl.uniform4fv(gl.getUniformLocation(this.progLine, 'uSectionPlanes'), sectionFlat);
      gl.uniform1i(gl.getUniformLocation(this.progLine, 'uSectionCount'), sectionPlanes.length);
      gl.uniform1i(gl.getUniformLocation(this.progLine, 'uIgnoreSection'), 0);
      gl.bindVertexArray(this.edgeVAO);
      gl.drawArrays(gl.LINES, 0, this.cachedBatches.edgeCount);
    }
    gl.bindVertexArray(null);

    // ---- PASS 3: 2D HUD OVERLAY (Inference, Guides, Dimensions, Labels, Marquee) ----
    this.renderHUD(dpr);
  }

  renderHUD(dpr) {
    const ctx = this.hud;
    const w = this.hudCanvas.width;
    const h = this.hudCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(dpr, dpr);

    // 1. Active Context Bounding Indicator if inside a Group
    if (this.doc.contextStack.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(4, 4, w / dpr - 8, h / dpr - 8);
      ctx.restore();
    }

    // 2. Section Plane Wireframe Gizmos
    for (const sp of this.doc.sectionPlanes) {
      if (!sp.active) continue;
      const S = 11;
      let corners;
      if (sp.axis === 'z') {
        corners = [v3(-S, -S, sp.offset), v3(S, -S, sp.offset), v3(S, S, sp.offset), v3(-S, S, sp.offset)];
      } else if (sp.axis === 'x') {
        corners = [v3(sp.offset, -S, 0), v3(sp.offset, S, 0), v3(sp.offset, S, 8), v3(sp.offset, -S, 8)];
      } else {
        corners = [v3(-S, sp.offset, 0), v3(S, sp.offset, 0), v3(S, sp.offset, 8), v3(-S, sp.offset, 8)];
      }
      const sc = corners.map((c) => this.worldToScreen(c));
      if (sc.every(Boolean)) {
        ctx.save();
        ctx.strokeStyle = 'rgba(234, 88, 12, 0.78)';
        ctx.fillStyle = 'rgba(234, 88, 12, 0.05)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(sc[0].x, sc[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(sc[i].x, sc[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // 3. Construction Guides (Tape Measure dashed lines)
    if (this.doc.isLayerVisible('layer_annotations')) {
      for (const g of this.doc.guides) {
        const s1 = this.worldToScreen(g.p1);
        const s2 = this.worldToScreen(g.p2);
        if (!s1 || !s2) continue;
        ctx.save();
        ctx.strokeStyle = this.doc.selected.guides.has(g.id) ? '#2563eb' : '#475569';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.restore();
      }

      // 4. Persistent 3D Dimensions
      for (const d of this.doc.dimensions) {
        const o1 = add3(d.p1, d.offsetVec);
        const o2 = add3(d.p2, d.offsetVec);
        const sP1 = this.worldToScreen(d.p1);
        const sP2 = this.worldToScreen(d.p2);
        const sO1 = this.worldToScreen(o1);
        const sO2 = this.worldToScreen(o2);
        if (!sP1 || !sP2 || !sO1 || !sO2) continue;
        const isSel = this.doc.selected.dims.has(d.id);
        const col = isSel ? '#2563eb' : '#1e293b';
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.25;
        // Extension lines
        ctx.beginPath();
        ctx.moveTo(sP1.x, sP1.y); ctx.lineTo(sO1.x, sO1.y);
        ctx.moveTo(sP2.x, sP2.y); ctx.lineTo(sO2.x, sO2.y);
        ctx.moveTo(sO1.x, sO1.y); ctx.lineTo(sO2.x, sO2.y);
        ctx.stroke();
        // Architectural slash ticks
        for (const pt of [sO1, sO2]) {
          ctx.beginPath();
          ctx.moveTo(pt.x - 4, pt.y + 4);
          ctx.lineTo(pt.x + 4, pt.y - 4);
          ctx.stroke();
        }
        // Dimension badge
        const mx = (sO1.x + sO2.x) * 0.5;
        const my = (sO1.y + sO2.y) * 0.5;
        const txt = formatLength(dist3(d.p1, d.p2), this.doc.unit);
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.fillRect(mx - tw * 0.5, my - 9, tw, 18);
        ctx.strokeRect(mx - tw * 0.5, my - 9, tw, 18);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, mx, my + 0.5);
        ctx.restore();
      }

      // 5. Text Leader Callouts
      for (const l of this.doc.labels) {
        const sA = this.worldToScreen(l.anchor);
        const sP = this.worldToScreen(l.p);
        if (!sA || !sP) continue;
        const isSel = this.doc.selected.labels.has(l.id);
        ctx.save();
        ctx.strokeStyle = isSel ? '#2563eb' : '#0f172a';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(sA.x, sA.y);
        ctx.lineTo(sP.x, sP.y);
        ctx.lineTo(sP.x + 12, sP.y);
        ctx.stroke();
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(sA.x, sA.y, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(l.text).width + 12;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
        ctx.strokeStyle = isSel ? '#2563eb' : '#cbd5e1';
        ctx.fillRect(sP.x + 12, sP.y - 11, tw, 22);
        ctx.strokeRect(sP.x + 12, sP.y - 11, tw, 22);
        ctx.fillStyle = '#0f172a';
        ctx.textBaseline = 'middle';
        ctx.fillText(l.text, sP.x + 18, sP.y);
        ctx.restore();
      }
    }

    // 6. Preview Polygons & Lines (Active Tool)
    for (const poly of this.overlayState.previewPolys) {
      const sc = poly.pts.map((p) => this.worldToScreen(p)).filter(Boolean);
      if (sc.length < 3) continue;
      ctx.save();
      ctx.fillStyle = poly.color || 'rgba(37, 99, 235, 0.22)';
      ctx.beginPath();
      ctx.moveTo(sc[0].x, sc[0].y);
      for (let i = 1; i < sc.length; i++) ctx.lineTo(sc[i].x, sc[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    for (const ln of this.overlayState.previewLines) {
      const s1 = this.worldToScreen(ln.p1);
      const s2 = this.worldToScreen(ln.p2);
      if (!s1 || !s2) continue;
      ctx.save();
      ctx.strokeStyle = ln.color || '#0f172a';
      ctx.lineWidth = ln.width || 2;
      if (ln.dashed) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
      ctx.restore();
    }

    // 7. Inference Line & Snap Glyph
    if (this.overlayState.inferenceLine) {
      const il = this.overlayState.inferenceLine;
      const s1 = this.worldToScreen(il.p1);
      const s2 = this.worldToScreen(il.p2);
      if (s1 && s2) {
        ctx.save();
        ctx.strokeStyle = il.color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.overlayState.inferencePoint) {
      const sp = this.worldToScreen(this.overlayState.inferencePoint);
      if (sp) {
        const t = this.overlayState.inferenceType;
        ctx.save();
        if (t === 'endpoint') {
          ctx.fillStyle = '#16a34a';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else if (t === 'midpoint') {
          ctx.fillStyle = '#06b6d4';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else if (t === 'edge') {
          ctx.fillStyle = '#dc2626';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.fillRect(sp.x - 4, sp.y - 4, 8, 8);
          ctx.strokeRect(sp.x - 4, sp.y - 4, 8, 8);
        } else if (t === 'face') {
          ctx.fillStyle = '#2563eb';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.translate(sp.x, sp.y);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-4, -4, 8, 8);
          ctx.strokeRect(-4, -4, 8, 8);
        } else {
          ctx.fillStyle = t === 'axis_x' ? '#dc2626' : t === 'axis_y' ? '#16a34a' : t === 'axis_z' ? '#2563eb' : '#475569';
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 3.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }

    // 8. Marquee Selection Box
    if (this.overlayState.marquee) {
      const m = this.overlayState.marquee;
      const x = Math.min(m.x1, m.x2);
      const y = Math.min(m.y1, m.y2);
      const mw = Math.abs(m.x2 - m.x1);
      const mh = Math.abs(m.y2 - m.y1);
      ctx.save();
      ctx.strokeStyle = m.crossing ? '#16a34a' : '#2563eb';
      ctx.fillStyle = m.crossing ? 'rgba(22, 163, 74, 0.12)' : 'rgba(37, 99, 235, 0.12)';
      ctx.lineWidth = 1.5;
      if (m.crossing) ctx.setLineDash([5, 4]);
      ctx.fillRect(x, y, mw, mh);
      ctx.strokeRect(x, y, mw, mh);
      ctx.restore();
    }

    // 9. Live Cursor Badge (VCB Feedback near pointer)
    if (this.overlayState.cursorLabel) {
      const cl = this.overlayState.cursorLabel;
      ctx.save();
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(cl.text).width + 12;
      const bx = cl.x + 14;
      const by = cl.y - 24;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 20, 4);
      ctx.fill();
      ctx.fillStyle = '#f8fafc';
      ctx.textBaseline = 'middle';
      ctx.fillText(cl.text, bx + 6, by + 10);
      ctx.restore();
    }
  }
}
