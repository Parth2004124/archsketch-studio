import {
  v3,
  add3,
  scale3,
  mat4Identity,
  formatLength,
  formatArea,
  formatVolume,
} from './math.js';
import {
  buildStaircaseGroup,
  buildRoofGroup,
  loadTemplate,
} from './arch_tools.js';
import {
  exportProjectJSON,
  exportOBJ,
  exportGLTF,
  exportSVGPlan,
  exportPNG,
} from './exporters.js';
import { nextId } from './kernel.js';
import { TOOL_HINTS } from './tools.js';
import { InbuiltAIAssistant, AI_QUICK_PROMPTS } from './ai_assistant.js';

export function initStudioUI(doc, renderer, tools) {
  const vcbInput = document.getElementById('vcb-input');
  const statusHint = document.getElementById('status-hint');
  const statusCoords = document.getElementById('status-coords');
  const axisBadge = document.getElementById('axis-lock-badge');
  const breadcrumbEl = document.getElementById('context-breadcrumb');

  // ---- Wire Tool Callbacks ----
  tools.ui.onToolChange = (name) => {
    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });
    renderToolOptionsStrip();
  };
  tools.ui.onStatus = (msg) => {
    statusHint.textContent = msg;
  };
  tools.ui.onVCBValue = (val) => {
    if (document.activeElement !== vcbInput) vcbInput.value = val;
  };
  tools.ui.onCoords = (p) => {
    statusCoords.textContent = `X: ${formatLength(p.x, doc.unit)}   Y: ${formatLength(p.y, doc.unit)}   Z: ${formatLength(p.z, doc.unit)}`;
  };
  tools.ui.onToolOptionsChange = () => renderToolOptionsStrip();
  tools.ui.onSectionsChange = () => renderSectionsPanel();

  // ---- Toolbar Tool Buttons ----
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tools.setTool(btn.dataset.tool);
    });
  });

  // ---- Top Menu & View Presets ----
  document.getElementById('btn-undo').addEventListener('click', () => doc.undo());
  document.getElementById('btn-redo').addEventListener('click', () => doc.redo());
  document.getElementById('btn-group').addEventListener('click', () => doc.groupSelection('Architectural Group'));
  document.getElementById('btn-explode').addEventListener('click', () => doc.explodeSelectedGroups());
  document.getElementById('btn-flip').addEventListener('click', () => doc.flipSelectedFaces());
  document.getElementById('btn-delete').addEventListener('click', () => doc.deleteSelection());

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      renderer.setStandardView(btn.dataset.view);
      document.getElementById('btn-ortho').classList.toggle('active', renderer.camera.ortho);
      document.getElementById('btn-walk').classList.remove('active');
    });
  });

  document.getElementById('btn-ortho').addEventListener('click', (e) => {
    renderer.camera.ortho = !renderer.camera.ortho;
    e.currentTarget.classList.toggle('active', renderer.camera.ortho);
  });

  document.getElementById('btn-zoom-extents').addEventListener('click', () => renderer.zoomExtents());

  document.getElementById('btn-walk').addEventListener('click', (e) => {
    renderer.camera.walkMode = !renderer.camera.walkMode;
    if (renderer.camera.walkMode) {
      renderer.camera.ortho = false;
      document.getElementById('btn-ortho').classList.remove('active');
      const eye = renderer.getEyePosition();
      const t = renderer.camera.target;
      const dx = t.x - eye.x;
      const dy = t.y - eye.y;
      const dist2D = Math.hypot(dx, dy) || 1;
      const startDist = Math.min(dist2D, 4.5);
      renderer.camera.eyePos = {
        x: t.x - (dx / dist2D) * startDist,
        y: t.y - (dy / dist2D) * startDist,
        z: 1.75,
      };
      renderer.camera.yaw = Math.atan2(dy, dx);
      renderer.camera.pitch = -0.05;
      statusHint.textContent = 'Walk Mode (1.75m Eye Level): Use WASD or Arrow Keys to walk, Drag to look around, Scroll to step, Esc or Walk to exit.';
    } else {
      statusHint.textContent = TOOL_HINTS[tools.activeTool];
    }
    e.currentTarget.classList.toggle('active', renderer.camera.walkMode);
  });

  // Template Loader
  const templateSelect = document.getElementById('template-select');
  templateSelect.addEventListener('change', (e) => {
    if (!e.target.value) return;
    loadTemplate(doc, e.target.value);
    renderer.zoomExtents();
    e.target.value = '';
  });

  // Project Name & Save/Export
  const projNameInput = document.getElementById('project-name-input');
  projNameInput.addEventListener('change', (e) => {
    doc.projectName = e.target.value || 'Architectural Model';
  });

  document.getElementById('btn-export-json').addEventListener('click', () => exportProjectJSON(doc));
  document.getElementById('btn-export-obj').addEventListener('click', () => exportOBJ(doc));
  document.getElementById('btn-export-gltf').addEventListener('click', () => exportGLTF(doc));
  document.getElementById('btn-export-svg').addEventListener('click', () => exportSVGPlan(doc));
  document.getElementById('btn-export-png').addEventListener('click', () => exportPNG(renderer, doc));

  const fileImport = document.getElementById('file-import-json');
  document.getElementById('btn-import-json').addEventListener('click', () => fileImport.click());
  fileImport.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        doc.deserialize(reader.result, false);
        renderer.zoomExtents();
      } catch (err) {
        alert('Could not load .archsketch.json file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---- Modals (Staircase Generator, Roof Generator, Shortcuts, Schedule) ----
  const openModal = (id) => document.getElementById(id).classList.add('open');
  const closeModal = (id) => document.getElementById(id).classList.remove('open');

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });

  document.getElementById('btn-open-stair-modal').addEventListener('click', () => openModal('modal-stair'));
  document.getElementById('btn-open-roof-modal').addEventListener('click', () => openModal('modal-roof'));
  document.getElementById('btn-open-help').addEventListener('click', () => openModal('modal-help'));

  document.getElementById('btn-build-stair').addEventListener('click', () => {
    doc.pushUndo('Build Staircase');
    const grp = buildStaircaseGroup(doc, v3(0, 0, 0), {
      type: document.getElementById('stair-type').value,
      totalRise: parseFloat(document.getElementById('stair-rise').value) || 3.0,
      width: parseFloat(document.getElementById('stair-width').value) || 1.2,
      treadDepth: parseFloat(document.getElementById('stair-tread').value) || 0.28,
      includeRailings: document.getElementById('stair-rail').checked,
      stepMaterial: document.getElementById('stair-mat').value,
    });
    doc.clearSelection();
    doc.selected.groups.add(grp.id);
    doc.notify('component');
    closeModal('modal-stair');
    tools.setTool('move');
  });

  document.getElementById('btn-build-roof').addEventListener('click', () => {
    doc.pushUndo('Build Roof');
    const grp = buildRoofGroup(doc, v3(0, 0, 3.0), {
      type: document.getElementById('roof-type').value,
      width: parseFloat(document.getElementById('roof-width').value) || 8.0,
      depth: parseFloat(document.getElementById('roof-depth').value) || 6.0,
      pitchDeg: parseFloat(document.getElementById('roof-pitch').value) || 28,
      overhang: parseFloat(document.getElementById('roof-overhang').value) || 0.5,
      roofMaterial: document.getElementById('roof-mat').value,
    });
    doc.clearSelection();
    doc.selected.groups.add(grp.id);
    doc.notify('component');
    closeModal('modal-roof');
    tools.setTool('move');
  });

  // ---- VCB Direct Capture & Enter Submission ----
  vcbInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const ok = tools.applyVCB(vcbInput.value);
      vcbInput.blur();
      if (ok) {
        vcbInput.classList.add('vcb-flash');
        setTimeout(() => vcbInput.classList.remove('vcb-flash'), 250);
      }
    } else if (e.key === 'Escape') {
      vcbInput.blur();
      tools.cancelCurrent();
    }
  });

  // ---- Contextual Tool Options Strip ----
  function renderToolOptionsStrip() {
    const strip = document.getElementById('tool-options-strip');
    let html = `
      <div class="opt-group">
        <label class="opt-check"><input type="checkbox" id="opt-grid-snap" ${tools.gridSnap ? 'checked' : ''}/> Grid Snap</label>
        <select id="opt-grid-step" class="opt-select" title="Snap Interval">
          <option value="0.1" ${tools.gridStep === 0.1 ? 'selected' : ''}>0.10m</option>
          <option value="0.25" ${tools.gridStep === 0.25 ? 'selected' : ''}>0.25m</option>
          <option value="0.5" ${tools.gridStep === 0.5 ? 'selected' : ''}>0.50m</option>
          <option value="1" ${tools.gridStep === 1 ? 'selected' : ''}>1.00m</option>
        </select>
        <select id="opt-unit" class="opt-select" title="Display Units">
          <option value="m" ${doc.unit === 'm' ? 'selected' : ''}>Meters (m)</option>
          <option value="cm" ${doc.unit === 'cm' ? 'selected' : ''}>Centimeters (cm)</option>
          <option value="mm" ${doc.unit === 'mm' ? 'selected' : ''}>Millimeters (mm)</option>
          <option value="ft" ${doc.unit === 'ft' ? 'selected' : ''}>Feet & Inches (ft/in)</option>
        </select>
      </div>
    `;

    if (tools.activeTool === 'wall') {
      html += `
        <div class="opt-sep"></div>
        <div class="opt-group">
          <span class="opt-label">Wall Thick</span>
          <input id="opt-wall-t" type="number" step="0.02" min="0.05" max="1.5" value="${tools.wallOpts.thickness}" class="opt-num"/>
          <span class="opt-label">Height</span>
          <input id="opt-wall-h" type="number" step="0.1" min="0.3" max="20" value="${tools.wallOpts.height}" class="opt-num"/>
          <span class="opt-label">Align</span>
          <select id="opt-wall-align" class="opt-select">
            <option value="center" ${tools.wallOpts.alignment === 'center' ? 'selected' : ''}>Center</option>
            <option value="left" ${tools.wallOpts.alignment === 'left' ? 'selected' : ''}>Left</option>
            <option value="right" ${tools.wallOpts.alignment === 'right' ? 'selected' : ''}>Right</option>
          </select>
        </div>`;
    } else if (tools.activeTool === 'circle' || tools.activeTool === 'polygon') {
      const sides = tools.activeTool === 'circle' ? tools.circleSides : tools.polygonSides;
      html += `
        <div class="opt-sep"></div>
        <div class="opt-group">
          <span class="opt-label">Sides</span>
          <input id="opt-sides" type="number" min="3" max="64" value="${sides}" class="opt-num"/>
        </div>`;
    } else if (tools.activeTool === 'move' || tools.activeTool === 'rotate') {
      html += `
        <div class="opt-sep"></div>
        <div class="opt-group">
          <label class="opt-check"><input type="checkbox" id="opt-copy" ${tools.copyMode ? 'checked' : ''}/> Copy Mode (Alt)</label>
          <label class="opt-check"><input type="checkbox" id="opt-ang-snap" ${tools.angleSnap ? 'checked' : ''}/> 15° Snap</label>
        </div>`;
    } else if (tools.activeTool === 'place_component') {
      html += `
        <div class="opt-sep"></div>
        <div class="opt-group">
          <span class="opt-label">Placing: <strong>${tools.placeConfig.kind} (${tools.placeConfig.variant})</strong> — Click in scene to place</span>
        </div>`;
    }

    strip.innerHTML = html;

    document.getElementById('opt-grid-snap').addEventListener('change', (e) => { tools.gridSnap = e.target.checked; });
    document.getElementById('opt-grid-step').addEventListener('change', (e) => { tools.gridStep = parseFloat(e.target.value); });
    document.getElementById('opt-unit').addEventListener('change', (e) => {
      doc.unit = e.target.value;
      doc.notify('unit');
    });

    const wt = document.getElementById('opt-wall-t');
    if (wt) wt.addEventListener('change', (e) => { tools.wallOpts.thickness = parseFloat(e.target.value) || 0.22; });
    const wh = document.getElementById('opt-wall-h');
    if (wh) wh.addEventListener('change', (e) => { tools.wallOpts.height = parseFloat(e.target.value) || 3.0; });
    const wa = document.getElementById('opt-wall-align');
    if (wa) wa.addEventListener('change', (e) => { tools.wallOpts.alignment = e.target.value; });

    const os = document.getElementById('opt-sides');
    if (os) os.addEventListener('change', (e) => {
      const n = Math.max(3, Math.min(64, parseInt(e.target.value, 10) || 12));
      if (tools.activeTool === 'circle') tools.circleSides = n;
      else tools.polygonSides = n;
    });

    const oc = document.getElementById('opt-copy');
    if (oc) oc.addEventListener('change', (e) => { tools.copyMode = e.target.checked; });
    const oas = document.getElementById('opt-ang-snap');
    if (oas) oas.addEventListener('change', (e) => { tools.angleSnap = e.target.checked; });
  }

  // ---- Right Inspector Accordions ----
  document.querySelectorAll('.tray-header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      hdr.parentElement.classList.toggle('collapsed');
    });
  });

  // 1. Entity Info & Quantity Takeoff
  function renderEntityPanel() {
    const el = document.getElementById('panel-entity-body');
    const ctx = doc.activeContext;
    const metrics = doc.computeSceneMetrics();
    const fCount = doc.selected.faces.size;
    const eCount = doc.selected.edges.size;
    const gCount = doc.selected.groups.size;

    let selHtml = '';
    if (fCount === 1 && eCount === 0 && gCount === 0) {
      const fid = Array.from(doc.selected.faces)[0];
      const f = ctx.faces.get(fid);
      if (f) {
        const mat = doc.materials.get(f.materialId);
        selHtml = `
          <div class="info-kv"><span>Selection</span><strong>Single Face</strong></div>
          <div class="info-kv"><span>Area</span><strong>${formatArea(f.area, doc.unit)}</strong></div>
          <div class="info-kv"><span>Normal</span><strong>(${f.normal.x.toFixed(2)}, ${f.normal.y.toFixed(2)}, ${f.normal.z.toFixed(2)})</strong></div>
          <div class="info-kv"><span>Material</span><strong>${mat ? mat.name : f.materialId}</strong></div>
          <div class="info-kv"><span>Tag / Layer</span>
            <select id="sel-assign-layer" class="tray-select">
              ${doc.layers.map((l) => `<option value="${l.id}" ${l.id === f.layerId ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </div>
        `;
      }
    } else if (gCount === 1 && fCount === 0 && eCount === 0) {
      const gid = Array.from(doc.selected.groups)[0];
      const g = ctx.groups.get(gid);
      if (g) {
        selHtml = `
          <div class="info-kv"><span>Selection</span><strong>Group</strong></div>
          <div class="info-kv"><span>Name</span><input id="sel-grp-name" class="tray-input" value="${g.name}"/></div>
          <div class="info-kv"><span>Tag / Layer</span>
            <select id="sel-assign-layer" class="tray-select">
              ${doc.layers.map((l) => `<option value="${l.id}" ${l.id === g.layerId ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </div>
          <div class="tray-btn-row">
            <button id="sel-enter-grp" class="mini-btn">Edit Group</button>
            <button id="sel-lock-grp" class="mini-btn">${g.locked ? 'Unlock' : 'Lock'}</button>
          </div>
        `;
      }
    } else if (fCount + eCount + gCount > 0) {
      let sumArea = 0;
      for (const fid of doc.selected.faces) {
        const f = ctx.faces.get(fid);
        if (f) sumArea += f.area || 0;
      }
      selHtml = `
        <div class="info-kv"><span>Selected</span><strong>${fCount} Faces, ${eCount} Edges, ${gCount} Groups</strong></div>
        ${sumArea > 0 ? `<div class="info-kv"><span>Selected Area</span><strong>${formatArea(sumArea, doc.unit)}</strong></div>` : ''}
      `;
    } else {
      selHtml = `<div class="muted-note">Nothing selected. Click a face, edge, or group to inspect.</div>`;
    }

    el.innerHTML = `
      ${selHtml}
      <div class="tray-divider"></div>
      <div class="section-sub">Model Quantity Takeoff</div>
      <div class="info-kv"><span>Floor / Horizontal</span><strong>${formatArea(metrics.floorArea, doc.unit)}</strong></div>
      <div class="info-kv"><span>Wall / Vertical</span><strong>${formatArea(metrics.wallArea, doc.unit)}</strong></div>
      <div class="info-kv"><span>Roof Area</span><strong>${formatArea(metrics.roofArea, doc.unit)}</strong></div>
      <div class="info-kv"><span>Total Surface</span><strong>${formatArea(metrics.totalFaceArea, doc.unit)}</strong></div>
      <div class="info-kv"><span>Entities</span><strong>${metrics.faceCount}F · ${metrics.edgeCount}E · ${metrics.groupCount}G</strong></div>
    `;

    const assignL = document.getElementById('sel-assign-layer');
    if (assignL) {
      assignL.addEventListener('change', (ev) => {
        doc.pushUndo('Change Layer');
        for (const fid of doc.selected.faces) {
          const f = ctx.faces.get(fid);
          if (f) f.layerId = ev.target.value;
        }
        for (const gid of doc.selected.groups) {
          const g = ctx.groups.get(gid);
          if (g) g.layerId = ev.target.value;
        }
        doc.notify('layer');
      });
    }
    const gName = document.getElementById('sel-grp-name');
    if (gName) {
      gName.addEventListener('change', (ev) => {
        const gid = Array.from(doc.selected.groups)[0];
        const g = ctx.groups.get(gid);
        if (g) { g.name = ev.target.value; doc.notify('outliner'); }
      });
    }
    const enterBtn = document.getElementById('sel-enter-grp');
    if (enterBtn) {
      enterBtn.addEventListener('click', () => {
        const gid = Array.from(doc.selected.groups)[0];
        doc.pushContext(gid);
      });
    }
    const lockBtn = document.getElementById('sel-lock-grp');
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        const gid = Array.from(doc.selected.groups)[0];
        const g = ctx.groups.get(gid);
        if (g) { g.locked = !g.locked; doc.notify('lock'); }
      });
    }
  }

  // 2. Materials Palette
  function renderMaterialsPanel() {
    const el = document.getElementById('panel-materials-body');
    let swatches = '';
    for (const mat of doc.materials.values()) {
      const active = doc.activeMaterialId === mat.id ? 'active' : '';
      swatches += `
        <button class="mat-swatch ${active}" data-mat="${mat.id}" title="${mat.name} (${mat.category})">
          <span class="mat-chip" style="background:${mat.color}; opacity:${mat.opacity}"></span>
          <span class="mat-name">${mat.name}</span>
        </button>
      `;
    }
    el.innerHTML = `
      <div class="mat-grid">${swatches}</div>
      <div class="tray-divider"></div>
      <div class="info-kv">
        <span>Custom Color</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="color" id="custom-mat-color" value="#64748b"/>
          <button id="btn-add-custom-mat" class="mini-btn">Create</button>
        </div>
      </div>
    `;
    el.querySelectorAll('[data-mat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        doc.activeMaterialId = btn.dataset.mat;
        // Also paint currently selected faces if any!
        if (doc.selected.faces.size > 0) {
          doc.pushUndo('Apply Material');
          for (const fid of doc.selected.faces) {
            const f = doc.activeContext.faces.get(fid);
            if (f) f.materialId = doc.activeMaterialId;
          }
          doc.notify('paint');
        } else {
          tools.setTool('paint');
        }
        renderMaterialsPanel();
      });
    });
    document.getElementById('btn-add-custom-mat').addEventListener('click', () => {
      const hex = document.getElementById('custom-mat-color').value;
      const id = nextId('mat');
      doc.materials.set(id, { id, name: `Custom ${hex}`, category: 'Custom', color: hex, opacity: 1.0, roughness: 0.75, texType: 'plaster', scale: 2.0 });
      doc.activeMaterialId = id;
      renderer.ensureMaterialTextures();
      renderMaterialsPanel();
    });
  }

  // 3. Styles & Sun Heliodon
  function initStylesAndSun() {
    document.querySelectorAll('[data-style-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        renderer.styleMode = parseInt(btn.dataset.styleMode, 10);
        document.querySelectorAll('[data-style-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    document.getElementById('chk-shadows').addEventListener('change', (e) => { renderer.showShadows = e.target.checked; });
    document.getElementById('chk-profiles').addEventListener('change', (e) => { renderer.showProfiles = e.target.checked; doc.dirty = true; });
    document.getElementById('chk-grid').addEventListener('change', (e) => { renderer.showGrid = e.target.checked; });
    document.getElementById('chk-axes').addEventListener('change', (e) => { renderer.showAxes = e.target.checked; });
    document.getElementById('chk-fog').addEventListener('change', (e) => { renderer.showFog = e.target.checked; });
    document.getElementById('chk-hidden-geo').addEventListener('change', (e) => { renderer.showHiddenGeo = e.target.checked; doc.dirty = true; });
    document.getElementById('sel-sky-theme').addEventListener('change', (e) => { renderer.skyTheme = e.target.value; });

    const sunHour = document.getElementById('sun-hour');
    const sunMonth = document.getElementById('sun-month');
    const sunLat = document.getElementById('sun-lat');
    const sunHourLbl = document.getElementById('sun-hour-lbl');
    const sunMonthLbl = document.getElementById('sun-month-lbl');
    const sunLatLbl = document.getElementById('sun-lat-lbl');
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const updateSunUI = () => {
      const h = Math.floor(renderer.sun.hour);
      const m = Math.round((renderer.sun.hour - h) * 60);
      sunHourLbl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      sunMonthLbl.textContent = MONTHS[renderer.sun.month - 1] || 'Jun';
      sunLatLbl.textContent = `${renderer.sun.latitude}°`;
    };
    updateSunUI();

    sunHour.addEventListener('input', (e) => { renderer.sun.hour = parseFloat(e.target.value); updateSunUI(); });
    sunMonth.addEventListener('input', (e) => { renderer.sun.month = parseInt(e.target.value, 10); updateSunUI(); });
    sunLat.addEventListener('input', (e) => { renderer.sun.latitude = parseInt(e.target.value, 10); updateSunUI(); });

    const animBtn = document.getElementById('btn-sun-animate');
    animBtn.addEventListener('click', () => {
      renderer.sun.animating = !renderer.sun.animating;
      animBtn.textContent = renderer.sun.animating ? 'Pause Solar Day' : 'Animate Solar Day';
      animBtn.classList.toggle('active', renderer.sun.animating);
    });
  }

  // 4. Component Library
  function initComponentLibrary() {
    document.querySelectorAll('[data-place-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tools.placeConfig = { kind: btn.dataset.placeKind, variant: btn.dataset.placeVar };
        tools.setTool('place_component');
      });
    });
  }

  // 5. Section Planes
  function renderSectionsPanel() {
    const el = document.getElementById('panel-sections-body');
    let html = `
      <div class="tray-btn-row">
        <button id="btn-add-plan-cut" class="mini-btn">+ Floor Plan Cut</button>
        <button id="btn-add-x-cut" class="mini-btn">+ X Section</button>
        <button id="btn-add-y-cut" class="mini-btn">+ Y Section</button>
      </div>
    `;
    if (doc.sectionPlanes.length === 0) {
      html += `<div class="muted-note" style="margin-top:8px;">No active section planes. Add a Floor Plan or Cross Section cut above.</div>`;
    } else {
      html += doc.sectionPlanes.map((sp, idx) => `
        <div class="sec-item">
          <div class="sec-row">
            <label><input type="checkbox" data-sec-toggle="${idx}" ${sp.active ? 'checked' : ''}/> <strong>${sp.axis.toUpperCase()} Cut</strong></label>
            <div>
              <button class="mini-btn" data-sec-flip="${idx}" title="Flip Direction">Flip</button>
              <button class="mini-btn danger" data-sec-del="${idx}" title="Remove">×</button>
            </div>
          </div>
          <div class="sec-row">
            <input type="range" min="-15" max="25" step="0.1" value="${sp.offset}" data-sec-slider="${idx}" style="flex:1;"/>
            <span class="mono-val">${sp.offset.toFixed(1)}m</span>
          </div>
        </div>
      `).join('');
    }
    el.innerHTML = html;

    document.getElementById('btn-add-plan-cut').addEventListener('click', () => {
      doc.sectionPlanes.push({ id: nextId('sec'), name: 'Plan Cut', axis: 'z', offset: 1.4, flipped: false, active: true, showFill: true });
      renderSectionsPanel();
    });
    document.getElementById('btn-add-x-cut').addEventListener('click', () => {
      doc.sectionPlanes.push({ id: nextId('sec'), name: 'X Section', axis: 'x', offset: 0.0, flipped: false, active: true, showFill: true });
      renderSectionsPanel();
    });
    document.getElementById('btn-add-y-cut').addEventListener('click', () => {
      doc.sectionPlanes.push({ id: nextId('sec'), name: 'Y Section', axis: 'y', offset: 0.0, flipped: false, active: true, showFill: true });
      renderSectionsPanel();
    });

    el.querySelectorAll('[data-sec-toggle]').forEach((inp) => {
      inp.addEventListener('change', () => { doc.sectionPlanes[inp.dataset.secToggle].active = inp.checked; });
    });
    el.querySelectorAll('[data-sec-flip]').forEach((btn) => {
      btn.addEventListener('click', () => { doc.sectionPlanes[btn.dataset.secFlip].flipped = !doc.sectionPlanes[btn.dataset.secFlip].flipped; });
    });
    el.querySelectorAll('[data-sec-del]').forEach((btn) => {
      btn.addEventListener('click', () => { doc.sectionPlanes.splice(btn.dataset.secDel, 1); renderSectionsPanel(); });
    });
    el.querySelectorAll('[data-sec-slider]').forEach((sl) => {
      sl.addEventListener('input', () => {
        const sp = doc.sectionPlanes[sl.dataset.secSlider];
        sp.offset = parseFloat(sl.value);
        sl.nextElementSibling.textContent = `${sp.offset.toFixed(1)}m`;
      });
    });
  }

  // 6. Tags / Layers & Outliner
  function renderLayersAndOutliner() {
    const el = document.getElementById('panel-layers-body');
    const layersHtml = doc.layers.map((l) => `
      <div class="layer-row ${doc.activeLayerId === l.id ? 'active' : ''}">
        <input type="checkbox" data-layer-vis="${l.id}" ${l.visible ? 'checked' : ''} title="Toggle Visibility"/>
        <span class="layer-dot" style="background:${l.color}"></span>
        <button class="layer-name-btn" data-layer-act="${l.id}">${l.name}</button>
      </div>
    `).join('');

    const ctx = doc.activeContext;
    const groupsHtml = Array.from(ctx.groups.values()).map((g) => `
      <div class="outliner-row ${doc.selected.groups.has(g.id) ? 'selected' : ''}">
        <button class="outliner-btn" data-out-sel="${g.id}" data-out-enter="${g.id}">${g.hidden ? '🚫 ' : '📦 '}${g.name}</button>
        <button class="mini-btn" data-out-hide="${g.id}" title="Hide/Show">${g.hidden ? 'Show' : 'Hide'}</button>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="section-sub">Architectural Tags (Layers)</div>
      <div class="layers-list">${layersHtml}</div>
      <div class="tray-divider"></div>
      <div class="section-sub">Outliner (Active Context Groups)</div>
      <div class="outliner-list">${groupsHtml || '<div class="muted-note">No groups in active context</div>'}</div>
    `;

    el.querySelectorAll('[data-layer-vis]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const l = doc.layers.find((x) => x.id === chk.dataset.layerVis);
        if (l) { l.visible = chk.checked; doc.notify('layer'); }
      });
    });
    el.querySelectorAll('[data-layer-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        doc.activeLayerId = btn.dataset.layerAct;
        renderLayersAndOutliner();
      });
    });
    el.querySelectorAll('[data-out-sel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        doc.clearSelection();
        doc.selected.groups.add(btn.dataset.outSel);
        doc.notify('select');
      });
      btn.addEventListener('dblclick', () => doc.pushContext(btn.dataset.outEnter));
    });
    el.querySelectorAll('[data-out-hide]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = ctx.groups.get(btn.dataset.outHide);
        if (g) { g.hidden = !g.hidden; doc.notify('hide'); }
      });
    });
  }

  function renderBreadcrumbs() {
    if (doc.contextStack.length <= 1) {
      breadcrumbEl.innerHTML = `<span class="crumb active">Model Root</span>`;
      return;
    }
    let html = `<button class="crumb" data-pop-to="1">Model Root</button>`;
    for (let i = 1; i < doc.contextStack.length; i++) {
      const parent = doc.contexts.get(doc.contextStack[i - 1]);
      let grpName = 'Group';
      for (const g of parent.groups.values()) {
        if (g.contextId === doc.contextStack[i]) { grpName = g.name; break; }
      }
      html += ` <span class="crumb-sep">›</span> <button class="crumb ${i === doc.contextStack.length - 1 ? 'active' : ''}" data-pop-to="${i + 1}">${grpName}</button>`;
    }
    breadcrumbEl.innerHTML = html;
    breadcrumbEl.querySelectorAll('[data-pop-to]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetLen = parseInt(btn.dataset.popTo, 10);
        while (doc.contextStack.length > targetLen) doc.popContext();
      });
    });
  }

  // ---- Global Keyboard Shortcuts (Classic SketchUp Keybindings!) ----
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const isInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    // Walk mode WASD + Arrow keys + Esc to exit
    if (renderer.camera.walkMode && !isInput) {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
        tools.walkKeys.add(k);
        return;
      }
      if (e.key === 'Escape') {
        renderer.camera.walkMode = false;
        document.getElementById('btn-walk').classList.remove('active');
        statusHint.textContent = TOOL_HINTS[tools.activeTool];
        return;
      }
    }

    // Direct VCB typing! If user types a digit/minus while NOT focused in a panel input, send directly to VCB!
    if (!isInput && !e.ctrlKey && !e.metaKey && /^[0-9.\-']$/.test(e.key)) {
      vcbInput.focus();
      vcbInput.value = e.key;
      e.preventDefault();
      return;
    }

    if (isInput) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doc.redo(); else doc.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doc.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      doc.groupSelection('Architectural Group');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const ctx = doc.activeContext;
      for (const f of ctx.faces.values()) doc.selected.faces.add(f.id);
      for (const ed of ctx.edges.values()) doc.selected.edges.add(ed.id);
      for (const g of ctx.groups.values()) doc.selected.groups.add(g.id);
      doc.notify('select');
      return;
    }

    if (e.key === 'Alt') {
      tools.copyMode = true;
      renderToolOptionsStrip();
      return;
    }

    // Arrow key Axis Locking (Red X, Green Y, Blue Z)
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      tools.axisLock = tools.axisLock === 'x' ? null : 'x';
      axisBadge.textContent = tools.axisLock ? 'Lock: X (Red)' : 'Axis: Free';
      axisBadge.className = tools.axisLock ? 'axis-badge x' : 'axis-badge';
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      tools.axisLock = tools.axisLock === 'y' ? null : 'y';
      axisBadge.textContent = tools.axisLock ? 'Lock: Y (Green)' : 'Axis: Free';
      axisBadge.className = tools.axisLock ? 'axis-badge y' : 'axis-badge';
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      tools.axisLock = tools.axisLock === 'z' ? null : 'z';
      axisBadge.textContent = tools.axisLock ? 'Lock: Z (Blue)' : 'Axis: Free';
      axisBadge.className = tools.axisLock ? 'axis-badge z' : 'axis-badge';
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tools.axisLock = null;
      axisBadge.textContent = 'Axis: Free';
      axisBadge.className = 'axis-badge';
      return;
    }

    if (e.key === 'Escape') {
      if (tools.state !== 'idle') tools.cancelCurrent();
      else if (doc.contextStack.length > 1) doc.popContext();
      else { doc.clearSelection(); doc.notify('select'); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      doc.deleteSelection();
      return;
    }

    const k = e.key.toLowerCase();
    const map = {
      ' ': 'select',
      l: 'line',
      r: 'rect',
      c: 'circle',
      g: 'polygon',
      a: 'arc',
      p: 'pushpull',
      u: 'pushpull',
      f: 'offset',
      m: 'move',
      q: 'rotate',
      s: 'scale',
      w: 'wall',
      t: 'tape',
      d: 'dimension',
      b: 'paint',
      e: 'eraser',
      o: 'orbit',
      h: 'pan',
      z: e.shiftKey ? null : 'zoom',
    };
    if (e.shiftKey && k === 'z') {
      renderer.zoomExtents();
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      const aiPanel = document.getElementById('ai-assistant-panel');
      aiPanel.classList.remove('hidden', 'minimized');
      document.getElementById('btn-toggle-ai').classList.add('active');
      document.getElementById('ai-input').focus();
      return;
    }

    if (map[k]) {
      e.preventDefault();
      tools.setTool(map[k]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      tools.copyMode = false;
      renderToolOptionsStrip();
    }
    tools.walkKeys.delete(e.key.toLowerCase());
  });

  // ---- Inbuilt AI Architect Drawer ----
  function initAIAssistant() {
    const ai = new InbuiltAIAssistant(doc, renderer, tools);
    const panel = document.getElementById('ai-assistant-panel');
    const toggleBtn = document.getElementById('btn-toggle-ai');
    const collapseBtn = document.getElementById('btn-ai-collapse');
    const settingsBtn = document.getElementById('btn-ai-settings');
    const settingsDrawer = document.getElementById('ai-settings-drawer');
    const providerSel = document.getElementById('ai-provider');
    const apiKeyInp = document.getElementById('ai-api-key');
    const saveCfgBtn = document.getElementById('btn-ai-save-cfg');
    const modeLabel = document.getElementById('ai-mode-label');
    const msgList = document.getElementById('ai-messages');
    const chipsEl = document.getElementById('ai-chips');
    const form = document.getElementById('ai-form');
    const input = document.getElementById('ai-input');

    const syncModeBadge = () => {
      providerSel.value = ai.config.provider || 'builtin';
      apiKeyInp.value = ai.config.apiKey || '';
      const isBYOK = ai.config.provider !== 'builtin' && ai.config.apiKey;
      modeLabel.textContent = isBYOK ? `${ai.config.provider.toUpperCase()} BYOK` : 'Built-in';
    };
    syncModeBadge();

    const addBubble = (role, text, undoable = false) => {
      const div = document.createElement('div');
      div.className = `ai-msg ${role}`;
      // Simple bold markdown support (**text**)
      const safe = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      div.innerHTML = safe;
      if (role === 'bot' && undoable) {
        const act = document.createElement('div');
        act.className = 'ai-msg-actions';
        const uBtn = document.createElement('button');
        uBtn.className = 'mini-btn';
        uBtn.textContent = 'Undo Action';
        uBtn.addEventListener('click', () => {
          doc.undo();
          uBtn.disabled = true;
          uBtn.textContent = 'Undone';
        });
        act.appendChild(uBtn);
        div.appendChild(act);
      }
      msgList.appendChild(div);
      msgList.scrollTop = msgList.scrollHeight;
    };

    addBubble(
      'bot',
      'Hi! Tell me what to build or change in plain English — e.g. **"Add a 6x4m brick room with gable roof"**, **"Add a pergola"**, **"Floor plan cut at 1.4m"**, or **"Walk inside"**.'
    );

    AI_QUICK_PROMPTS.forEach((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-chip';
      chip.textContent = p;
      chip.addEventListener('click', () => submitPrompt(p));
      chipsEl.appendChild(chip);
    });

    async function submitPrompt(prompt) {
      const clean = prompt.trim();
      if (!clean) return;
      addBubble('user', clean);
      input.value = '';
      const sendBtn = document.getElementById('ai-send-btn');
      sendBtn.disabled = true;
      sendBtn.textContent = '…';
      try {
        const res = await ai.runPrompt(clean);
        addBubble('bot', res.reply, res.undoable);
      } catch (err) {
        addBubble('bot', `Error: ${err.message}`);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Build';
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitPrompt(input.value);
    });

    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      toggleBtn.classList.toggle('active', !panel.classList.contains('hidden'));
    });

    collapseBtn.addEventListener('click', () => {
      panel.classList.toggle('minimized');
      collapseBtn.textContent = panel.classList.contains('minimized') ? '+' : '_';
    });

    settingsBtn.addEventListener('click', () => {
      settingsDrawer.style.display = settingsDrawer.style.display === 'none' ? 'flex' : 'none';
    });

    saveCfgBtn.addEventListener('click', () => {
      ai.saveConfig({
        provider: providerSel.value,
        apiKey: apiKeyInp.value.trim(),
      });
      syncModeBadge();
      settingsDrawer.style.display = 'none';
      addBubble('bot', `AI engine set to **${modeLabel.textContent}**.`);
    });
  }

  // Subscribe to document updates
  doc.onChange(() => {
    projNameInput.value = doc.projectName;
    renderEntityPanel();
    renderLayersAndOutliner();
    renderBreadcrumbs();
    renderSectionsPanel();
    // Auto-save snapshot to localStorage
    try {
      localStorage.setItem('archsketch_autosave_v1', doc.serialize());
    } catch {}
  });

  // Initial render
  initStylesAndSun();
  initComponentLibrary();
  initAIAssistant();
  renderMaterialsPanel();
  renderToolOptionsStrip();
  renderEntityPanel();
  renderLayersAndOutliner();
  renderSectionsPanel();
  renderBreadcrumbs();
  tools.setTool('select');
}
