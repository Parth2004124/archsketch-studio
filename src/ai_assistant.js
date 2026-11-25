import {
  v3,
  add3,
  sub3,
  scale3,
  mat4Translation,
  mat4RotationAxis,
  mat4Mul,
  formatArea,
  formatLength,
} from './math.js';
import { nextId } from './kernel.js';
import {
  addBox,
  createComponentGroup,
  buildWallChain,
  buildStaircaseGroup,
  buildRoofGroup,
  buildDoorComponent,
  buildWindowComponent,
  buildColumnComponent,
  buildScalePersonGroup,
  buildTreeGroup,
  buildFurnitureGroup,
  loadTemplate,
} from './arch_tools.js';

export const AI_QUICK_PROMPTS = [
  'Add a 6x4m room with gable roof',
  'Add a pergola',
  'Floor plan cut at 1.4m',
  'Switch to clay mode',
  'Set sun to 17:30',
  'Walk inside',
];

const MATERIAL_KEYWORDS = [
  { keys: ['brick', 'masonry'], id: 'brick', label: 'Running Bond Brick' },
  { keys: ['concrete', 'cement'], id: 'concrete', label: 'Board Concrete' },
  { keys: ['plaster', 'stucco', 'white', 'drywall'], id: 'plaster', label: 'Architectural Plaster' },
  { keys: ['limestone', 'stone', 'travertine'], id: 'limestone', label: 'Honed Limestone' },
  { keys: ['oak', 'hardwood', 'wood', 'timber'], id: 'oak', label: 'Warm White Oak' },
  { keys: ['cedar', 'siding', 'cladding'], id: 'cedar', label: 'Cedar Vertical Siding' },
  { keys: ['solar glass', 'tinted glass', 'dark glass'], id: 'glass_dark', label: 'Solar Tinted Glass' },
  { keys: ['glass', 'glazing', 'transparent'], id: 'glass', label: 'Architectural Glazing' },
  { keys: ['zinc', 'metal roof', 'standing seam'], id: 'zinc', label: 'Standing Seam Zinc' },
  { keys: ['terracotta', 'clay tile', 'spanish tile'], id: 'terracotta', label: 'Terracotta Roof Tile' },
  { keys: ['steel', 'black metal', 'iron'], id: 'steel', label: 'Blackened Steel' },
  { keys: ['aluminum', 'aluminium', 'silver metal'], id: 'aluminum', label: 'Anodized Aluminum' },
  { keys: ['slate', 'basalt', 'dark stone'], id: 'slate', label: 'Dark Basalt Paver' },
  { keys: ['grass', 'lawn', 'turf'], id: 'grass', label: 'Lawn & Landscape' },
  { keys: ['water', 'pool'], id: 'water', label: 'Reflecting Pool' },
  { keys: ['asphalt', 'road', 'pavement'], id: 'asphalt', label: 'Urban Asphalt' },
  { keys: ['sage', 'green counter'], id: 'kitchen_sage', label: 'Sage Kitchen Counter' },
  { keys: ['walnut', 'dark wood'], id: 'walnut', label: 'Dark Walnut Timber' },
];

function detectMaterial(text, fallback = null) {
  const lower = text.toLowerCase();
  for (const m of MATERIAL_KEYWORDS) {
    if (m.keys.some((k) => lower.includes(k))) return m;
  }
  return fallback;
}

function detectDirectionOffset(text, metrics, width = 4, depth = 4) {
  const lower = text.toLowerCase();
  const cx = (metrics.min.x + metrics.max.x) * 0.5;
  const cy = (metrics.min.y + metrics.max.y) * 0.5;
  const pad = 1.5;

  if (/\b(east|right)\b/.test(lower)) return v3(metrics.max.x + width * 0.5 + pad, cy, 0);
  if (/\b(west|left)\b/.test(lower)) return v3(metrics.min.x - width * 0.5 - pad, cy, 0);
  if (/\b(north|back|top)\b/.test(lower)) return v3(cx, metrics.max.y + depth * 0.5 + pad, 0);
  if (/\b(south|front|bottom)\b/.test(lower)) return v3(cx, metrics.min.y - depth * 0.5 - pad, 0);

  // Explicit coordinates: "at 5, 3" or "at (5, 3, 0)"
  const atMatch = lower.match(/\bat\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)?/);
  if (atMatch) {
    return v3(parseFloat(atMatch[1]), parseFloat(atMatch[2]), atMatch[3] ? parseFloat(atMatch[3]) : 0);
  }
  return null;
}

function findSmartOpenSpot(doc, w = 4, d = 4) {
  const ctx = doc.activeContext;
  if (ctx.faces.size === 0 && ctx.groups.size === 0) return v3(0, 0, 0);
  const m = doc.computeSceneMetrics();
  // Place cleanly beside the east side of current footprint
  return v3(m.max.x + w * 0.5 + 1.5, (m.min.y + m.max.y) * 0.5, 0);
}

function parseDimensions2D(text, defW = 5, defD = 4) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:m|meters?)?\s*(?:x|by|\*)\s*(\d+(?:\.\d+)?)\s*(?:m|meters?)?/i);
  if (m) return { w: parseFloat(m[1]), d: parseFloat(m[2]) };
  return { w: defW, d: defD };
}

function parseHeight(text, defH = 3.0) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:m|meters?)?\s*(?:high|tall|height)\b/i)
    || text.match(/(?:height|tall|high|to|by)\s*(\d+(?:\.\d+)?)\s*(?:m|meters?)?\b/i);
  return m ? parseFloat(m[1]) : defH;
}

function parseCount(text, defN = 1) {
  const m = text.match(/\b(\d+)\s+(?:[a-z-]+\s+)?(?:trees?|columns?|pillars?|windows?|doors?|people|persons?|figures?|chairs?|sofas?)\b/i);
  if (m) return Math.min(20, Math.max(1, parseInt(m[1], 10)));
  return defN;
}

function parseSingleNumber(text) {
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*(?:m|meters?|°|deg|degrees?)?/);
  return m ? parseFloat(m[1]) : null;
}

export class InbuiltAIAssistant {
  constructor(doc, renderer, tools) {
    this.doc = doc;
    this.renderer = renderer;
    this.tools = tools;
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      const raw = localStorage.getItem('archsketch_ai_config');
      if (raw) return JSON.parse(raw);
    } catch {}
    return { provider: 'builtin', apiKey: '', model: '' };
  }

  saveConfig(cfg) {
    this.config = { ...this.config, ...cfg };
    try {
      localStorage.setItem('archsketch_ai_config', JSON.stringify(this.config));
    } catch {}
  }

  async runPrompt(promptText) {
    const clean = promptText.trim();
    if (!clean) return { reply: 'Please enter an architectural instruction.', undoable: false };

    // Optional external LLM mode if user configured a BYOK key
    if (this.config.provider !== 'builtin' && this.config.apiKey) {
      try {
        return await this.runWithBYOKLLM(clean);
      } catch (err) {
        // Gracefully fall back to built-in engine if key/CORS/network fails
        const localRes = this.runBuiltIn(clean);
        return {
          ...localRes,
          reply: `(Cloud LLM fallback: ${err.message})\n${localRes.reply}`,
        };
      }
    }

    return this.runBuiltIn(clean);
  }

  // ---- BUILT-IN DETERMINISTIC ARCHITECTURAL NLP ENGINE ----
  runBuiltIn(rawText) {
    // Split multi-step commands on " and then " / " then " / ";"
    const clauses = rawText
      .split(/\s*(?:;|\band then\b|\bthen\b)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);

    const replies = [];
    let anyUndoable = false;

    for (const clause of clauses) {
      const res = this.executeSingleClause(clause);
      if (res.reply) replies.push(res.reply);
      if (res.undoable) anyUndoable = true;
    }

    return {
      reply: replies.join('\n'),
      undoable: anyUndoable,
    };
  }

  executeSingleClause(text) {
    const lower = text.toLowerCase().trim();
    const doc = this.doc;
    const renderer = this.renderer;
    const tools = this.tools;
    const ctx = doc.activeContext;
    const metrics = doc.computeSceneMetrics();

    // 1. Undo / Redo / Delete / Group / Explode
    if (/^(undo|revert)\b/.test(lower)) {
      const ok = doc.undo();
      return { reply: ok ? 'Undid last action.' : 'Nothing to undo.', undoable: false };
    }
    if (/^redo\b/.test(lower)) {
      const ok = doc.redo();
      return { reply: ok ? 'Redid action.' : 'Nothing to redo.', undoable: false };
    }
    if (/^(delete|remove)\s+(selected|selection|it|this)\b/.test(lower)) {
      const ok = doc.deleteSelection();
      return { reply: ok ? 'Deleted selected elements.' : 'Nothing is currently selected.', undoable: ok };
    }
    if (/^group\b/.test(lower)) {
      const g = doc.groupSelection('AI Group');
      return { reply: g ? 'Grouped selection into an architectural group.' : 'Select geometry first to group.', undoable: !!g };
    }
    if (/^explode\b/.test(lower)) {
      const ok = doc.explodeSelectedGroups();
      return { reply: ok ? 'Exploded selected group(s).' : 'Select a group first to explode.', undoable: ok };
    }

    // 2. Templates / Reset / Clear
    if (/\b(clear|blank|empty|reset|start fresh|new site)\b/.test(lower)) {
      loadTemplate(doc, 'blank');
      renderer.zoomExtents();
      return { reply: 'Cleared workspace to a blank architectural site with a 1.75 m scale figure.', undoable: false };
    }
    if (/\b(apartment|2 bed|two bed|floor plan)\b/.test(lower) && /\b(load|open|switch|show|build|create)\b/.test(lower)) {
      loadTemplate(doc, 'apartment_plan');
      renderer.zoomExtents();
      return { reply: 'Loaded the **2-Bedroom Apartment 3D** model.', undoable: false };
    }
    if (/\b(pavilion|courtyard villa)\b/.test(lower) && /\b(load|open|switch|show|build|create)\b/.test(lower)) {
      loadTemplate(doc, 'pavilion');
      renderer.zoomExtents();
      return { reply: 'Loaded the **Courtyard Pavilion Residence** template.', undoable: false };
    }
    if (/\b(urban|solar study|tower|massing)\b/.test(lower) && /\b(load|open|switch|show|build|create)\b/.test(lower)) {
      loadTemplate(doc, 'urban_solar');
      renderer.zoomExtents();
      return { reply: 'Loaded the **Urban Massing & Solar Study** template.', undoable: false };
    }

    // 3. Inspection / Area / Quantity Takeoff
    if (/\b(area|volume|metric|metrics|how big|quantity|quantities|takeoff|summary|count)\b/.test(lower)) {
      return {
        reply: `**Model Summary** — Floor: ${formatArea(metrics.floorArea, doc.unit)}, Walls: ${formatArea(metrics.wallArea, doc.unit)}, Roof: ${formatArea(metrics.roofArea, doc.unit)}, Total Surface: ${formatArea(metrics.totalFaceArea, doc.unit)} (${metrics.faceCount} faces, ${metrics.groupCount} groups).`,
        undoable: false,
      };
    }

    // 4. Camera Views & Walk Mode
    if (/\b(walk|walkthrough|walk through|walk inside|eye level|first person)\b/.test(lower)) {
      const btn = document.getElementById('btn-walk');
      if (/\b(exit|stop|off|leave)\b/.test(lower)) {
        if (renderer.camera.walkMode && btn) btn.click();
        return { reply: 'Exited Walk Mode.', undoable: false };
      }
      if (!renderer.camera.walkMode && btn) btn.click();
      return { reply: 'Entered **Walk Mode** (`1.75 m` eye level). Use `WASD` or Arrow Keys to walk and drag to look around.', undoable: false };
    }
    if (/\b(top view|plan view|bird.?s eye)\b/.test(lower)) {
      renderer.setStandardView('top');
      renderer.zoomExtents();
      return { reply: 'Switched to **Top Orthographic Plan** view.', undoable: false };
    }
    if (/\b(front view|front elevation)\b/.test(lower)) {
      renderer.setStandardView('front');
      renderer.zoomExtents();
      return { reply: 'Switched to **Front Elevation**.', undoable: false };
    }
    if (/\b(right view|right elevation|east elevation)\b/.test(lower)) {
      renderer.setStandardView('right');
      renderer.zoomExtents();
      return { reply: 'Switched to **Right Elevation**.', undoable: false };
    }
    if (/\b(left view|left elevation|west elevation)\b/.test(lower)) {
      renderer.setStandardView('left');
      renderer.zoomExtents();
      return { reply: 'Switched to **Left Elevation**.', undoable: false };
    }
    if (/\b(iso|isometric|3d view|perspective)\b/.test(lower)) {
      renderer.setStandardView('iso');
      renderer.zoomExtents();
      return { reply: 'Switched to **3D Isometric** view.', undoable: false };
    }
    if (/\b(zoom fit|zoom extents|fit view|center view|reset camera)\b/.test(lower)) {
      renderer.zoomExtents();
      return { reply: 'Fitted model to viewport.', undoable: false };
    }

    // 5. Visual Styles
    if (/\b(clay|maquette|white model)\b/.test(lower)) {
      document.querySelector('[data-style-mode="1"]')?.click();
      return { reply: 'Switched style to **Clay Maquette**.', undoable: false };
    }
    if (/\b(hidden line|blueprint|wireframe|linework)\b/.test(lower)) {
      document.querySelector('[data-style-mode="2"]')?.click();
      return { reply: 'Switched style to **Hidden Line**.', undoable: false };
    }
    if (/\b(x-?ray|transparent|see through)\b/.test(lower)) {
      document.querySelector('[data-style-mode="3"]')?.click();
      return { reply: 'Switched style to **X-Ray**.', undoable: false };
    }
    if (/\b(monochrome)\b/.test(lower)) {
      document.querySelector('[data-style-mode="4"]')?.click();
      return { reply: 'Switched style to **Monochrome**.', undoable: false };
    }
    if (/\b(shaded|textured|normal style|realistic)\b/.test(lower)) {
      document.querySelector('[data-style-mode="0"]')?.click();
      return { reply: 'Switched style to **Shaded + Textures**.', undoable: false };
    }

    // 6. Sun & Shadow Study
    if (/\b(animate|play)\s*(solar|sun|day|shadows?)\b/.test(lower)) {
      renderer.sun.animating = true;
      return { reply: 'Started **Solar Day Animation**.', undoable: false };
    }
    if (/\b(stop|pause)\s*(solar|sun|day|shadows?)\b/.test(lower)) {
      renderer.sun.animating = false;
      return { reply: 'Paused Solar Day animation.', undoable: false };
    }
    if (/\b(sun|time|noon|morning|evening|sunset|sunrise|afternoon)\b/.test(lower)) {
      let hr = null;
      const hm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
      if (hm) {
        hr = parseInt(hm[1], 10) + (hm[2] ? parseInt(hm[2], 10) / 60 : 0);
        if (hm[3] === 'pm' && hr < 12) hr += 12;
        if (hm[3] === 'am' && hr === 12) hr = 0;
      } else if (lower.includes('sunrise') || lower.includes('morning')) hr = 7.5;
      else if (lower.includes('noon') || lower.includes('midday')) hr = 12.0;
      else if (lower.includes('afternoon')) hr = 15.5;
      else if (lower.includes('sunset') || lower.includes('evening') || lower.includes('golden')) hr = 18.2;

      if (hr !== null) {
        renderer.sun.hour = Math.max(5.5, Math.min(20.5, hr));
        renderer.showShadows = true;
        const sh = document.getElementById('sun-hour');
        const sl = document.getElementById('sun-hour-lbl');
        if (sh) sh.value = renderer.sun.hour;
        if (sl) {
          const hh = Math.floor(renderer.sun.hour);
          const mm = Math.round((renderer.sun.hour - hh) * 60);
          sl.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        }
        return { reply: `Updated sun time to **${sl?.textContent || renderer.sun.hour.toFixed(1)}** with shadows enabled.`, undoable: false };
      }
    }

    // 7. Layer Visibility (Roof / Ceiling / Furniture / Annotations)
    if (/\b(hide|off|remove)\s+(roof|ceiling)\b/.test(lower) || /\b(show|on)\s+(roof|ceiling)\b/.test(lower) || /\btoggle\s+(roof|ceiling)\b/.test(lower)) {
      const roofL = doc.layers.find((l) => l.id === 'layer_roof');
      if (roofL) {
        roofL.visible = /\bshow|on\b/.test(lower) ? true : /\bhide|off|remove\b/.test(lower) ? false : !roofL.visible;
        doc.notify('layer');
        return { reply: `${roofL.visible ? 'Shown' : 'Hidden'} **Roof & Parapets** layer.`, undoable: false };
      }
    }

    // 8. Section Cuts
    if (/\b(clear|remove|delete|disable)\s+(all\s+)?sections?\b/.test(lower)) {
      doc.sectionPlanes = [];
      doc.notify('section');
      if (tools.ui.onSectionsChange) tools.ui.onSectionsChange();
      return { reply: 'Removed all active section planes.', undoable: false };
    }
    if (/\b(section|plan cut|slice|cut)\b/.test(lower)) {
      const axis = /\bx\s*section\b/.test(lower) ? 'x' : /\by\s*section\b/.test(lower) ? 'y' : 'z';
      const val = parseSingleNumber(lower);
      const offset = val !== null ? val : (axis === 'z' ? 1.4 : 0.0);
      doc.sectionPlanes.push({
        id: nextId('sec'),
        name: `${axis.toUpperCase()} Cut (${offset.toFixed(2)}m)`,
        axis,
        offset,
        flipped: false,
        active: true,
        showFill: true,
      });
      doc.notify('section');
      if (tools.ui.onSectionsChange) tools.ui.onSectionsChange();
      return { reply: `Added **${axis.toUpperCase()} Section Cut** at \`${offset.toFixed(2)} m\`.`, undoable: false };
    }

    // 9. Paint / Material Assignment
    if (/\b(paint|material|color|change|make)\b/.test(lower) && detectMaterial(lower) && !/\b(room|house|wall|roof|box|slab|table|column|pergola)\b/.test(lower)) {
      const mat = detectMaterial(lower);
      if (doc.selected.faces.size > 0) {
        doc.pushUndo(`Paint ${mat.label}`);
        for (const fid of doc.selected.faces) {
          const f = ctx.faces.get(fid);
          if (f) f.materialId = mat.id;
        }
        doc.notify('paint');
        return { reply: `Painted ${doc.selected.faces.size} selected face(s) with **${mat.label}**.`, undoable: true };
      }
      doc.activeMaterialId = mat.id;
      tools.setTool('paint');
      return { reply: `Selected **${mat.label}** and activated Paint Bucket (\`B\`). Click any face to apply.`, undoable: false };
    }

    // 10. Push/Pull or Extrude Selected Face
    if (/\b(push|pull|extrude|raise|lift)\b/.test(lower)) {
      const dist = parseSingleNumber(lower) ?? 3.0;
      let targetFaceId = doc.selected.faces.size > 0 ? Array.from(doc.selected.faces)[0] : null;
      if (!targetFaceId && ctx.faces.size > 0) {
        // Pick last horizontal face
        for (const f of Array.from(ctx.faces.values()).reverse()) {
          if (Math.abs(f.normal.z) > 0.8) { targetFaceId = f.id; break; }
        }
      }
      if (targetFaceId) {
        doc.pushUndo('AI Push/Pull');
        const cap = doc.pushPullFace(ctx, targetFaceId, dist);
        if (cap) {
          doc.clearSelection();
          doc.selected.faces.add(cap.id);
          doc.notify('pushpull');
          return { reply: `Extruded face by **${formatLength(dist, doc.unit)}**.`, undoable: true };
        }
      }
      return { reply: 'Select a face first so I know which surface to Push/Pull.', undoable: false };
    }

    // 11. Build Pergola / Canopy
    if (/\b(pergola|trellis|canopy|gazebo|shade structure)\b/.test(lower)) {
      const { w, d } = parseDimensions2D(lower, 4.4, 3.2);
      const h = parseHeight(lower, 2.8);
      const spot = detectDirectionOffset(lower, metrics, w, d) || v3((metrics.min.x + metrics.max.x) * 0.5, metrics.max.y + d * 0.5 + 0.5, 0.2);
      doc.pushUndo('Build Pergola');
      const roofLayer = doc.layers.find((l) => l.id === 'layer_roof');
      if (roofLayer) roofLayer.visible = true;
      const grp = createComponentGroup(doc, 'AI Cedar Pergola', 'layer_roof', (c) => {
        const hx = w * 0.5 - 0.12, hy = d * 0.5 - 0.12;
        for (const px of [-hx, hx]) for (const py of [-hy, hy]) {
          addBox(c, doc, px, py, 0, 0.16, 0.16, h, 'steel', 'layer_roof');
        }
        addBox(c, doc, 0, -hy, h - 0.15, w + 0.2, 0.14, 0.18, 'steel', 'layer_roof');
        addBox(c, doc, 0, hy, h - 0.15, w + 0.2, 0.14, 0.18, 'steel', 'layer_roof');
        const slats = Math.max(4, Math.round(w / 0.55));
        for (let i = 0; i < slats; i++) {
          const rx = -w * 0.5 + 0.2 + (i / Math.max(1, slats - 1)) * (w - 0.4);
          addBox(c, doc, rx, 0, h + 0.03, 0.07, d + 0.35, 0.14, 'cedar', 'layer_roof');
        }
      }, mat4Translation(spot.x, spot.y, spot.z));
      doc.clearSelection();
      doc.selected.groups.add(grp.id);
      doc.notify('component');
      return { reply: `Built a **${w}m × ${d}m Cedar & Steel Pergola** (${h}m high).`, undoable: true };
    }

    // 12. Build Room / House / Building / Extension / Garage / Pavilion
    if (/\b(room|house|building|villa|studio|pavilion|extension|garage|shed|cabin|office|box|mass|block|floor)\b/.test(lower)) {
      const { w, d } = parseDimensions2D(lower, 6, 4.5);
      const stories = /\b(2|two)[\s-]*(story|storey|stories|floor)\b/.test(lower) ? 2
        : /\b(3|three)[\s-]*(story|storey|stories|floor)\b/.test(lower) ? 3 : 1;
      const storyH = parseHeight(lower, 3.0);
      const totalH = storyH * stories;
      const wallMat = (detectMaterial(lower) || { id: 'plaster', label: 'Architectural Plaster' });
      const spot = detectDirectionOffset(lower, metrics, w, d) || findSmartOpenSpot(doc, w, d);
      const hasGable = /\bgable\b/.test(lower);
      const hasHip = /\bhip\b/.test(lower);
      const hasShed = /\bshed\b/.test(lower);
      const hasFlatRoof = /\b(flat roof|parapet|roof)\b/.test(lower);

      doc.pushUndo('Build Architectural Structure');
      const grp = createComponentGroup(doc, `AI Structure (${w}x${d}m)`, 'layer_walls_1', (c) => {
        // Floor slab
        addBox(c, doc, 0, 0, 0, w + 0.2, d + 0.2, 0.20, 'limestone', 'layer_foundation');
        // Hollow perimeter walls
        const wt = 0.22;
        addBox(c, doc, 0, -d * 0.5 + wt * 0.5, 0.20, w, wt, totalH, wallMat.id, 'layer_walls_1');
        addBox(c, doc, 0, d * 0.5 - wt * 0.5, 0.20, w, wt, totalH, wallMat.id, 'layer_walls_1');
        addBox(c, doc, -w * 0.5 + wt * 0.5, 0, 0.20, wt, d - wt * 2, totalH, wallMat.id, 'layer_walls_1');
        addBox(c, doc, w * 0.5 - wt * 0.5, 0, 0.20, wt, d - wt * 2, totalH, wallMat.id, 'layer_walls_1');
        // Interior floor plates for multi-story
        for (let s = 1; s < stories; s++) {
          addBox(c, doc, 0, 0, 0.20 + s * storyH - 0.15, w - wt * 2, d - wt * 2, 0.18, 'oak', 'layer_foundation');
        }
        // Front glazing door/window accent
        addBox(c, doc, 0, -d * 0.5 - 0.01, 0.20, Math.min(2.2, w * 0.4), 0.04, 2.2, 'glass', 'layer_openings');
      }, mat4Translation(spot.x, spot.y, spot.z));

      if (hasGable || hasHip || hasShed || hasFlatRoof) {
        const roofLayer = doc.layers.find((l) => l.id === 'layer_roof');
        if (roofLayer) roofLayer.visible = true;
        const rType = hasGable ? 'gable' : hasHip ? 'hip' : hasShed ? 'shed' : 'flat_parapet';
        buildRoofGroup(doc, v3(spot.x, spot.y, spot.z + 0.20 + totalH), {
          type: rType,
          width: w,
          depth: d,
          pitchDeg: 26,
          overhang: 0.45,
          roofMaterial: lower.includes('terracotta') ? 'terracotta' : 'zinc',
        });
      }

      doc.clearSelection();
      doc.selected.groups.add(grp.id);
      doc.notify('component');
      renderer.zoomExtents();
      return {
        reply: `Built a **${w}m × ${d}m** ${stories > 1 ? `${stories}-story ` : ''}structure (${wallMat.label})${hasGable || hasHip || hasShed || hasFlatRoof ? ' with roof' : ''}.`,
        undoable: true,
      };
    }

    // 13. Build Staircase
    if (/\b(stair|stairs|staircase|steps)\b/.test(lower)) {
      const type = /\bl[\s-]?shape\b/.test(lower) ? 'l_shape' : /\bu[\s-]?shape\b/.test(lower) ? 'u_shape' : 'straight';
      const rise = parseHeight(lower, 3.0);
      const spot = detectDirectionOffset(lower, metrics, 2, 3) || findSmartOpenSpot(doc, 2.5, 2.5);
      doc.pushUndo('Build Staircase');
      const grp = buildStaircaseGroup(doc, spot, {
        type,
        totalRise: rise,
        width: 1.2,
        stepMaterial: (detectMaterial(lower) || { id: 'oak' }).id,
      });
      doc.clearSelection();
      doc.selected.groups.add(grp.id);
      doc.notify('component');
      return { reply: `Built a **${type.replace('_', '-')} staircase** (${rise} m rise) with glass guardrails.`, undoable: true };
    }

    // 14. Build Roof
    if (/\b(roof|canopy)\b/.test(lower)) {
      const type = /\bhip\b/.test(lower) ? 'hip' : /\bshed\b/.test(lower) ? 'shed' : /\bflat|parapet\b/.test(lower) ? 'flat_parapet' : 'gable';
      const { w, d } = parseDimensions2D(lower, 8, 6);
      const pitchMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:°|deg|degree)/);
      const pitchDeg = pitchMatch ? parseFloat(pitchMatch[1]) : 26;
      const mat = detectMaterial(lower, { id: 'zinc', label: 'Standing Seam Zinc' });
      const spot = detectDirectionOffset(lower, metrics, w, d) || v3((metrics.min.x + metrics.max.x) * 0.5, (metrics.min.y + metrics.max.y) * 0.5, 3.0);
      doc.pushUndo('Build Roof');
      const roofLayer = doc.layers.find((l) => l.id === 'layer_roof');
      if (roofLayer) roofLayer.visible = true;
      const grp = buildRoofGroup(doc, spot, { type, width: w, depth: d, pitchDeg, roofMaterial: mat.id });
      doc.clearSelection();
      doc.selected.groups.add(grp.id);
      doc.notify('component');
      return { reply: `Generated a **${w}m × ${d}m ${type} roof** (${pitchDeg}° pitch, ${mat.label}).`, undoable: true };
    }

    // 15. Parametric Wall
    if (/\bwall\b/.test(lower)) {
      const len = parseSingleNumber(lower) ?? 4.0;
      const h = parseHeight(lower, 2.8);
      const mat = detectMaterial(lower, { id: 'plaster', label: 'Architectural Plaster' });
      const spot = detectDirectionOffset(lower, metrics, len, 0.5) || findSmartOpenSpot(doc, len, 0.5);
      const vertical = /\b(north|south|vertical)\b/.test(lower);
      const p1 = v3(spot.x - (vertical ? 0 : len * 0.5), spot.y - (vertical ? len * 0.5 : 0), spot.z);
      const p2 = v3(spot.x + (vertical ? 0 : len * 0.5), spot.y + (vertical ? len * 0.5 : 0), spot.z);
      doc.pushUndo('Build Wall');
      buildWallChain(doc, [p1, p2], { thickness: 0.22, height: h, materialId: mat.id, layerId: 'layer_walls_1' });
      return { reply: `Built a **${len}m × ${h}m** ${mat.label} wall.`, undoable: true };
    }

    // 16. Components (Doors, Windows, Columns, Trees, Furniture, Scale People)
    const count = parseCount(lower, 1);
    const baseSpot = detectDirectionOffset(lower, metrics, 2, 2) || v3((metrics.min.x + metrics.max.x) * 0.5, metrics.min.y - 1.5, 0.2);

    if (/\b(door|patio slider|french door)\b/.test(lower)) {
      const variant = /\bdouble|french\b/.test(lower) ? 'double' : /\bsliding|slider|patio\b/.test(lower) ? 'sliding' : 'single';
      doc.pushUndo('Add Door');
      for (let i = 0; i < count; i++) buildDoorComponent(doc, add3(baseSpot, v3(i * 2.2, 0, 0)), 0, variant);
      doc.notify('component');
      return { reply: `Placed ${count} **${variant} door(s)**.`, undoable: true };
    }
    if (/\b(window|curtain wall|glazing)\b/.test(lower)) {
      const variant = /\bcurtain\b/.test(lower) ? 'curtain' : /\bcasement\b/.test(lower) ? 'casement' : 'picture';
      doc.pushUndo('Add Window');
      for (let i = 0; i < count; i++) buildWindowComponent(doc, add3(baseSpot, v3(i * 2.6, 0, 0)), 0, variant);
      doc.notify('component');
      return { reply: `Placed ${count} **${variant} window(s)**.`, undoable: true };
    }
    if (/\b(column|pillar|post|ibeam|i-beam)\b/.test(lower)) {
      const variant = /\bi-?beam|steel\b/.test(lower) ? 'ibeam' : /\bsquare\b/.test(lower) ? 'square' : 'round';
      doc.pushUndo('Add Column(s)');
      for (let i = 0; i < count; i++) buildColumnComponent(doc, add3(baseSpot, v3(i * 3.0, 0, 0)), variant);
      doc.notify('component');
      return { reply: `Placed ${count} **${variant} column(s)** (3.0 m spacing).`, undoable: true };
    }
    if (/\b(tree|trees|cypress|plant|landscape)\b/.test(lower)) {
      const variant = /\bcypress\b/.test(lower) ? 'cypress' : 'canopy';
      const spot = detectDirectionOffset(lower, metrics, 2, 2) || v3(metrics.min.x - 1.8, (metrics.min.y + metrics.max.y) * 0.5, 0);
      doc.pushUndo('Plant Trees');
      for (let i = 0; i < count; i++) buildTreeGroup(doc, add3(spot, v3(0, (i - (count - 1) * 0.5) * 3.5, 0)), variant);
      doc.notify('component');
      return { reply: `Planted ${count} **${variant} tree(s)**.`, undoable: true };
    }
    if (/\b(sofa|couch|dining|table|bed|car|vehicle)\b/.test(lower)) {
      const variant = /\bdining|table\b/.test(lower) ? 'dining' : /\bbed\b/.test(lower) ? 'bed' : /\bcar|vehicle\b/.test(lower) ? 'car' : 'sofa';
      doc.pushUndo(`Add ${variant}`);
      buildFurnitureGroup(doc, baseSpot, 0, variant);
      doc.notify('component');
      return { reply: `Added **${variant}** to the scene.`, undoable: true };
    }
    if (/\b(person|people|human|figure|scale figure)\b/.test(lower)) {
      doc.pushUndo('Add Scale Figure');
      for (let i = 0; i < count; i++) buildScalePersonGroup(doc, add3(baseSpot, v3(i * 1.1, 0, 0)), 0.4);
      doc.notify('component');
      return { reply: `Placed ${count} **1.75 m scale figure(s)**.`, undoable: true };
    }

    // 17. Swimming Pool
    if (/\b(pool|swimming pool|reflecting pool)\b/.test(lower)) {
      const { w, d } = parseDimensions2D(lower, 5.0, 3.0);
      const spot = detectDirectionOffset(lower, metrics, w, d) || findSmartOpenSpot(doc, w, d);
      doc.pushUndo('Add Pool');
      createComponentGroup(doc, 'Swimming Pool', 'layer_site', (c) => {
        addBox(c, doc, 0, 0, 0, w + 0.6, d + 0.6, 0.14, 'limestone', 'layer_site');
        addBox(c, doc, 0, 0, 0.03, w, d, 0.13, 'water', 'layer_site');
      }, mat4Translation(spot.x, spot.y, spot.z));
      doc.notify('component');
      return { reply: `Built a **${w}m × ${d}m** limestone-coped reflecting pool.`, undoable: true };
    }

    // Fallback help message
    return {
      reply: `I didn't recognize that exact command yet. Try phrases like:\n• *"Add a 6x4m brick room with gable roof"*\n• *"Add a pergola"*, *"Add an L-shaped staircase"*, *"Plant 3 cypress trees"*\n• *"Cut a floor plan section at 1.4m"*, *"Switch to clay mode"*, *"Set sun to 17:30"*, or *"Walk inside"*\n(Or click the **⚙** icon above to connect your own Gemini/OpenAI key for open-ended AI generation.)`,
      undoable: false,
    };
  }

  // ---- OPTIONAL BYOK CLOUD LLM (GEMINI / OPENAI) ----
  async runWithBYOKLLM(userPrompt) {
    const metrics = this.doc.computeSceneMetrics();
    const sysPrompt = `You are the inbuilt AI Architect inside ArchSketch Studio (3D WebGL CAD, Z-up meters).
Current scene bounds: min=(${metrics.min.x.toFixed(1)}, ${metrics.min.y.toFixed(1)}, ${metrics.min.z.toFixed(1)}), max=(${metrics.max.x.toFixed(1)}, ${metrics.max.y.toFixed(1)}, ${metrics.max.z.toFixed(1)}).
Floor area: ${metrics.floorArea.toFixed(1)} m², Wall area: ${metrics.wallArea.toFixed(1)} m², Faces: ${metrics.faceCount}, Groups: ${metrics.groupCount}.
Return ONLY valid JSON: {"summary":"short confirmation","js":"executable JS body using doc, renderer, tools, arch, math"}.
Available helpers:
- arch.addBox(ctx, doc, cx, cy, cz, sx, sy, sz, matId, layerId, rotZ)
- arch.createComponentGroup(doc, name, layerId, (ctx)=>{...}, math.mat4Translation(x,y,z))
- arch.buildWallChain(doc, [math.v3(x,y,z),...], {thickness, height, materialId, closed})
- arch.buildStaircaseGroup(doc, origin, {type:'straight'|'l_shape'|'u_shape', totalRise, width})
- arch.buildRoofGroup(doc, origin, {type:'gable'|'hip'|'shed'|'flat_parapet', width, depth, pitchDeg, roofMaterial})
- arch.buildDoorComponent / buildWindowComponent / buildColumnComponent / buildTreeGroup / buildFurnitureGroup / buildScalePersonGroup
Materials: plaster, concrete, brick, limestone, oak, cedar, glass, glass_dark, zinc, terracotta, steel, aluminum, slate, grass, water, foliage, walnut, sofa_taupe, kitchen_sage, fridge_rose.`;

    let text = '';
    if (this.config.provider === 'gemini') {
      const model = this.config.model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${sysPrompt}\n\nUser request: ${userPrompt}` }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const model = this.config.model || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data = await res.json();
      text = data?.choices?.[0]?.message?.content || '';
    }

    const parsed = JSON.parse(text);
    if (!parsed.js) throw new Error('Model returned no executable geometry code.');

    const archApi = {
      addBox,
      createComponentGroup,
      buildWallChain,
      buildStaircaseGroup,
      buildRoofGroup,
      buildDoorComponent,
      buildWindowComponent,
      buildColumnComponent,
      buildScalePersonGroup,
      buildTreeGroup,
      buildFurnitureGroup,
      loadTemplate,
    };
    const mathApi = { v3, add3, sub3, scale3, mat4Translation, mat4RotationAxis, mat4Mul };

    this.doc.pushUndo(`AI: ${userPrompt.slice(0, 32)}`);
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFn('doc', 'renderer', 'tools', 'arch', 'math', parsed.js);
    await fn(this.doc, this.renderer, this.tools, archApi, mathApi);
    this.doc.notify('ai-build');
    return { reply: parsed.summary || 'Built your request in the 3D scene.', undoable: true };
  }
}
