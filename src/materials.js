// Architectural Material Registry & Procedural Texture Generator

export const DEFAULT_MATERIALS = [
  { id: 'plaster',    name: 'Architectural Plaster', category: 'Walls',    color: '#ece9e2', opacity: 1.0, roughness: 0.85, texType: 'plaster',    scale: 2.0 },
  { id: 'concrete',   name: 'Board Concrete',        category: 'Structure',color: '#a8aaa6', opacity: 1.0, roughness: 0.90, texType: 'concrete',   scale: 3.0 },
  { id: 'brick',      name: 'Running Bond Brick',    category: 'Masonry',  color: '#9e5340', opacity: 1.0, roughness: 0.88, texType: 'brick',      scale: 2.2 },
  { id: 'limestone',  name: 'Honed Limestone',       category: 'Stone',    color: '#d8d0c1', opacity: 1.0, roughness: 0.72, texType: 'stone',      scale: 2.5 },
  { id: 'oak',        name: 'Warm White Oak',        category: 'Timber',   color: '#b88b5a', opacity: 1.0, roughness: 0.62, texType: 'wood',       scale: 2.0 },
  { id: 'cedar',      name: 'Cedar Vertical Siding', category: 'Timber',   color: '#8f5e3b', opacity: 1.0, roughness: 0.75, texType: 'siding',     scale: 1.8 },
  { id: 'glass',      name: 'Architectural Glazing', category: 'Glazing',  color: '#7ab8d6', opacity: 0.38,roughness: 0.10, texType: 'glass',      scale: 2.0 },
  { id: 'glass_dark', name: 'Solar Tinted Glass',    category: 'Glazing',  color: '#325263', opacity: 0.55,roughness: 0.12, texType: 'glass',      scale: 2.0 },
  { id: 'zinc',       name: 'Standing Seam Zinc',    category: 'Roofing',  color: '#4e555c', opacity: 1.0, roughness: 0.45, texType: 'seam',       scale: 1.5 },
  { id: 'terracotta', name: 'Terracotta Roof Tile',  category: 'Roofing',  color: '#b35b3b', opacity: 1.0, roughness: 0.78, texType: 'tile',       scale: 1.6 },
  { id: 'steel',      name: 'Blackened Steel',       category: 'Metal',    color: '#2c3036', opacity: 1.0, roughness: 0.35, texType: 'metal',      scale: 2.0 },
  { id: 'aluminum',   name: 'Anodized Aluminum',     category: 'Metal',    color: '#c4c9cf', opacity: 1.0, roughness: 0.32, texType: 'metal',      scale: 2.0 },
  { id: 'slate',      name: 'Dark Basalt Paver',     category: 'Site',     color: '#52565b', opacity: 1.0, roughness: 0.80, texType: 'stone',      scale: 2.0 },
  { id: 'grass',      name: 'Lawn & Landscape',      category: 'Site',     color: '#6b8c4e', opacity: 1.0, roughness: 0.95, texType: 'grass',      scale: 3.0 },
  { id: 'water',      name: 'Reflecting Pool',       category: 'Site',     color: '#4b8da8', opacity: 0.78,roughness: 0.08, texType: 'water',      scale: 3.0 },
  { id: 'asphalt',    name: 'Urban Asphalt',         category: 'Site',     color: '#424448', opacity: 1.0, roughness: 0.92, texType: 'noise',      scale: 2.5 },
  { id: 'foliage',    name: 'Tree Canopy',           category: 'Entourage',color: '#5c8248', opacity: 1.0, roughness: 0.92, texType: 'grass',      scale: 1.5 },
  { id: 'scale_fig',  name: 'Scale Silhouette',      category: 'Entourage',color: '#374151', opacity: 0.88,roughness: 0.70, texType: 'solid',      scale: 1.0 },
  { id: 'kitchen_sage',name:'Sage Kitchen Counter',  category: 'Interior', color: '#b7d49c', opacity: 1.0, roughness: 0.55, texType: 'plaster',    scale: 1.5 },
  { id: 'fridge_rose',name: 'Refrigerator Finish',   category: 'Interior', color: '#cf8290', opacity: 1.0, roughness: 0.30, texType: 'metal',      scale: 1.0 },
  { id: 'sofa_taupe', name: 'Upholstery Taupe',      category: 'Interior', color: '#9c8f86', opacity: 1.0, roughness: 0.88, texType: 'plaster',    scale: 1.0 },
  { id: 'walnut',     name: 'Dark Walnut Timber',    category: 'Timber',   color: '#5c3824', opacity: 1.0, roughness: 0.55, texType: 'wood',       scale: 1.8 },
];

export function hexToRgbNorm(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Deterministic pseudo-random generator for clean procedural textures
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateProceduralTextureCanvas(mat, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(
    mat.id.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 17)
  );

  ctx.fillStyle = mat.color;
  ctx.fillRect(0, 0, size, size);

  const type = mat.texType || 'solid';

  if (type === 'plaster' || type === 'noise') {
    for (let i = 0; i < 3200; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 1 + rng() * 3;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
      ctx.fillRect(x, y, r, r);
    }
  } else if (type === 'concrete') {
    // Board-formed horizontal tie lines + speckle
    const rows = 4;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      const shade = (rng() - 0.5) * 18;
      ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade / 255})` : `rgba(0,0,0,${-shade / 255})`;
      ctx.fillRect(0, r * rh, size, rh);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(0, r * rh, size, 2);
      // Formwork tie holes
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.arc(size * 0.25, r * rh + rh * 0.5, 3, 0, Math.PI * 2);
      ctx.arc(size * 0.75, r * rh + rh * 0.5, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(rng() * size, rng() * size, 2, 2);
    }
  } else if (type === 'brick') {
    const rows = 8;
    const cols = 4;
    const bh = size / rows;
    const bw = size / cols;
    // Mortar background
    ctx.fillStyle = '#c8c2b8';
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * (bw * 0.5);
      for (let c = -1; c <= cols; c++) {
        const x = c * bw + offset;
        const y = r * bh;
        const tint = (rng() - 0.5) * 28;
        ctx.fillStyle = mat.color;
        ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
        if (tint !== 0) {
          ctx.fillStyle = tint > 0 ? `rgba(255,220,180,${tint / 255})` : `rgba(20,10,5,${-tint / 255})`;
          ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
        }
      }
    }
  } else if (type === 'stone') {
    // Ashlar stone blocks
    const rows = 4;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      const cols = 2 + (r % 2);
      const cw = size / cols;
      for (let c = 0; c < cols; c++) {
        const shade = (rng() - 0.5) * 22;
        ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade / 255})` : `rgba(0,0,0,${-shade / 255})`;
        ctx.fillRect(c * cw + 1, r * rh + 1, cw - 2, rh - 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 2;
        ctx.strokeRect(c * cw, r * rh, cw, rh);
      }
    }
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
      ctx.fillRect(rng() * size, rng() * size, 2, 2);
    }
  } else if (type === 'wood') {
    const planks = 6;
    const ph = size / planks;
    for (let p = 0; p < planks; p++) {
      const y = p * ph;
      const shade = (rng() - 0.5) * 24;
      ctx.fillStyle = shade > 0 ? `rgba(255,230,190,${shade / 255})` : `rgba(30,15,0,${-shade / 255})`;
      ctx.fillRect(0, y, size, ph);
      // Wood grain streaks
      for (let g = 0; g < 16; g++) {
        ctx.fillStyle = 'rgba(60,30,10,0.08)';
        ctx.fillRect(0, y + rng() * ph, size, 1 + rng() * 1.5);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, y, size, 1.5);
      const joint = rng() * size;
      ctx.fillRect(joint, y, 1.5, ph);
    }
  } else if (type === 'siding') {
    const slats = 12;
    const sw = size / slats;
    for (let s = 0; s < slats; s++) {
      const x = s * sw;
      const shade = (rng() - 0.5) * 26;
      ctx.fillStyle = shade > 0 ? `rgba(255,230,200,${shade / 255})` : `rgba(0,0,0,${-shade / 255})`;
      ctx.fillRect(x, 0, sw, size);
      ctx.fillStyle = 'rgba(0,0,0,0.26)';
      ctx.fillRect(x, 0, 2, size);
    }
  } else if (type === 'seam') {
    const seams = 6;
    const sw = size / seams;
    for (let s = 0; s < seams; s++) {
      const x = s * sw;
      const grad = ctx.createLinearGradient(x, 0, x + sw, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.35)');
      grad.addColorStop(0.08, 'rgba(255,255,255,0.12)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0.0)');
      grad.addColorStop(0.95, 'rgba(0,0,0,0.2)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, sw, size);
    }
  } else if (type === 'tile') {
    const rows = 6;
    const cols = 6;
    const rh = size / rows;
    const cw = size / cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const grad = ctx.createLinearGradient(c * cw, 0, (c + 1) * cw, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.22)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0.25)');
        ctx.fillStyle = grad;
        ctx.fillRect(c * cw, r * rh, cw, rh);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(c * cw, (r + 1) * rh - 2, cw, 2);
      }
    }
  } else if (type === 'glass') {
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.04)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(0,20,40,0.12)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  } else if (type === 'grass') {
    for (let i = 0; i < 4500; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(180,220,100,0.09)' : 'rgba(20,50,15,0.10)';
      ctx.fillRect(rng() * size, rng() * size, 2, 3);
    }
  } else if (type === 'water') {
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const y = rng() * size;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.33, y + 6, size * 0.66, y - 6, size, y);
      ctx.stroke();
    }
  } else if (type === 'metal') {
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(0, rng() * size, size, 1);
    }
  }

  return canvas;
}
