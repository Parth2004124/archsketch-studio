import * as kernel from './kernel.js';
import * as arch from './arch_tools.js';
import * as math from './math.js';
import { CADRenderer } from './renderer.js';
import { ToolManager } from './tools.js';
import { initStudioUI } from './ui.js';

const { CADDocument } = kernel;
const { loadTemplate } = arch;
const { add3, scale3 } = math;

function initLiveAgentBridge(doc, renderer, tools) {
  const pill = document.getElementById('agent-link-pill');
  const pillText = pill?.querySelector('.agent-text');
  const statusHint = document.getElementById('status-hint');

  const setConnected = (connected, label) => {
    if (!pill) return;
    pill.classList.toggle('connected', connected);
    if (pillText) pillText.textContent = label;
  };

  const isLocalBridge = location.protocol.startsWith('http') && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (!isLocalBridge) {
    setConnected(false, 'Browser Only');
    return;
  }

  let syncTimer = null;
  const pushState = async () => {
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: doc.projectName,
          metrics: doc.computeSceneMetrics(),
          camera: renderer.camera,
          state: doc.serialize(),
        }),
      });
    } catch {}
  };

  doc.onChange(() => {
    try { localStorage.setItem('archsketch_autosave_ts', String(Date.now())); } catch {}
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushState, 350);
  });

  // Connect SSE Event Stream
  let es = null;
  const connectSSE = () => {
    try {
      es = new EventSource('/api/events');
      es.addEventListener('connected', () => {
        setConnected(true, 'Live Sync');
        pushState();
      });

      es.addEventListener('load_state', (ev) => {
        const data = JSON.parse(ev.data);
        if (data?.state) {
          doc.pushUndo('AI Loaded Project');
          doc.deserialize(data.state, true);
          renderer.zoomExtents();
          try {
            localStorage.setItem('archsketch_autosave_v1', data.state);
            localStorage.setItem('archsketch_autosave_ts', String(Date.now()));
          } catch {}
          if (statusHint) statusHint.textContent = `AI Loaded: ${doc.projectName}`;
        }
      });

      es.addEventListener('exec', async (ev) => {
        const { reqId, code, description } = JSON.parse(ev.data);
        try {
          doc.pushUndo(description || 'AI Build');
          const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFn('doc', 'renderer', 'tools', 'arch', 'math', 'kernel', code);
          const result = await fn(doc, renderer, tools, arch, math, kernel);
          doc.notify('agent-build');
          await pushState();
          if (statusHint) statusHint.textContent = `AI Built: ${description}`;
          await fetch('/api/exec-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reqId,
              ok: true,
              result: result === undefined ? null : result,
              metrics: doc.computeSceneMetrics(),
            }),
          });
        } catch (err) {
          await fetch('/api/exec-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reqId,
              ok: false,
              error: err?.message || String(err),
            }),
          });
        }
      });

      es.onerror = () => {
        setConnected(false, 'Reconnecting…');
      };
    } catch {
      setConnected(false, 'Offline');
    }
  };

  connectSSE();
}

async function boot() {
  const glCanvas = document.getElementById('gl-canvas');
  const hudCanvas = document.getElementById('hud-canvas');

  const doc = new CADDocument();

  // Check server state first if newer than localStorage autosave
  let restored = false;
  let localTs = 0;
  try { localTs = parseInt(localStorage.getItem('archsketch_autosave_ts') || '0', 10) || 0; } catch {}

  const isLocalBridge = location.protocol.startsWith('http') && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (isLocalBridge) {
    try {
      const resp = await fetch('/api/state');
      if (resp.ok) {
        const data = await resp.json();
        const srvTs = data?.updatedAt ? Date.parse(data.updatedAt) : 0;
        if (data?.state && (srvTs > localTs || !localStorage.getItem('archsketch_autosave_v1'))) {
          doc.deserialize(data.state, false);
          restored = true;
        }
      }
    } catch {}
  }

  if (!restored) {
    try {
      const saved = localStorage.getItem('archsketch_autosave_v1');
      if (saved) {
        doc.deserialize(saved, false);
        restored = true;
      }
    } catch {}
  }

  if (!restored) {
    loadTemplate(doc, 'apartment_plan');
  }

  const renderer = new CADRenderer(glCanvas, hudCanvas, doc);
  renderer.zoomExtents();

  const tools = new ToolManager(doc, renderer);
  initStudioUI(doc, renderer, tools);
  initLiveAgentBridge(doc, renderer, tools);

  let lastTime = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (renderer.sun.animating) {
      renderer.sun.hour += dt * 1.4;
      if (renderer.sun.hour > 20.5) renderer.sun.hour = 6.0;
      const sh = document.getElementById('sun-hour');
      const sl = document.getElementById('sun-hour-lbl');
      if (sh && sl) {
        sh.value = renderer.sun.hour.toFixed(1);
        const h = Math.floor(renderer.sun.hour);
        const m = Math.round((renderer.sun.hour - h) * 60);
        sl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }

    if (renderer.camera.walkMode && tools.walkKeys.size > 0) {
      const speed = 5.5 * dt;
      const fwd = { x: Math.cos(renderer.camera.yaw), y: Math.sin(renderer.camera.yaw), z: 0 };
      const right = { x: Math.sin(renderer.camera.yaw), y: -Math.cos(renderer.camera.yaw), z: 0 };
      if (tools.walkKeys.has('w') || tools.walkKeys.has('arrowup')) renderer.camera.eyePos = add3(renderer.camera.eyePos, scale3(fwd, speed));
      if (tools.walkKeys.has('s') || tools.walkKeys.has('arrowdown')) renderer.camera.eyePos = add3(renderer.camera.eyePos, scale3(fwd, -speed));
      if (tools.walkKeys.has('d') || tools.walkKeys.has('arrowright')) renderer.camera.eyePos = add3(renderer.camera.eyePos, scale3(right, speed));
      if (tools.walkKeys.has('a') || tools.walkKeys.has('arrowleft')) renderer.camera.eyePos = add3(renderer.camera.eyePos, scale3(right, -speed));
    }

    renderer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__ARCHSKETCH__ = { doc, renderer, tools, arch, math, kernel, loadTemplate };
}

window.addEventListener('DOMContentLoaded', boot);
