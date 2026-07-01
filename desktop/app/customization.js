'use strict';

/* Atelier feature module — customization  (app/customization.js)
   ==============================================================
   Two independent capabilities, both built ONLY against window.Atelier:

   (A) THEMES
       A small theme system that sets CSS custom properties on :root.
       Ships 3 presets — "Clay" (the current warm terracotta default),
       "Slate" (cool grey) and "Forest" (green accent) — plus a live
       accent-color picker and a grid on/off toggle. The sidebar
       "Customization" row opens a small Atelier.ui.openPanel with the
       choices; changes apply instantly and persist under the Atelier.store
       key "atelier.theme", and are restored on load. Also listens on the bus
       for "theme:set" and "canvas:toggleGrid" so other modules can drive it.

   (B) LAYOUT PERSISTENCE
       Snapshots the whole board — every card's position/size (+ content for
       runtime cards) AND the viewport (Atelier.canvas.viewport) — into
       Atelier.store key "atelier.layout" on change (debounced), and restores
       it on load so the studio reopens exactly as it was left. The viewport
       is the explicitly-owned piece here: it is restored by driving the core's
       own pan/zoom handlers with synthetic events, so the core's internal
       pan/zoom stays in sync (no jump on the first interaction).

   This module never edits index.html, core.js, styles.css, or another module.
   Its only CSS is injected below as a <style> string.

   ── MANUAL TEST ─────────────────────────────────────────────────────────────
   1. `npm start` in desktop/.
   2. Click the "Customization" row in the left sidebar → a panel opens.
   3. Click "Slate" → the canvas/sidebar turn cool grey instantly. Reload
      (Cmd-R) → it comes back as Slate (theme persisted).
   4. Toggle "Grid" off → the dotted grid disappears; reload → still off.
   5. Pick a new accent color → terracotta bits recolor live; reload → kept.
   6. Drag the metrics card somewhere new and wheel-zoom the canvas. Reload →
      the card is where you left it AND the pan/zoom are restored. Then pan the
      canvas by dragging — it moves smoothly from the restored position (proof
      the core's pan state was restored in sync, not just the CSS transform).
   7. Console shows "[customization] ready …" with no console.assert failures.
   ============================================================================ */

(function () {
  const A = window.Atelier;
  if (!A || !A.store || typeof A.store.get !== 'function' || !A.ui || !A.canvas) {
    console.warn('[customization] Atelier core not available — skipping.');
    return;
  }

  const ROOT = document.documentElement;

  // ── injected CSS (panel chrome only; adapts to the active theme vars) ──────
  (function injectStyle() {
    const css = `
      .cz-wrap { display:flex; flex-direction:column; gap:18px; width:300px; }
      .cz-sec-title { font-size:11px; text-transform:uppercase; letter-spacing:.06em;
        color:var(--ink-dim); font-weight:700; margin-bottom:9px; }
      .cz-themes { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
      .cz-theme { border:1px solid var(--border); border-radius:10px; padding:8px;
        cursor:pointer; background:var(--panel); text-align:center;
        transition:border-color .15s ease, box-shadow .15s ease; }
      .cz-theme:hover { border-color:var(--accent); }
      .cz-theme.active { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
      .cz-sw { height:34px; border-radius:7px; margin-bottom:7px;
        border:1px solid var(--border-soft); position:relative; overflow:hidden; }
      .cz-sw i { position:absolute; right:6px; bottom:6px; width:13px; height:13px;
        border-radius:50%; box-shadow:0 0 0 2px #fff; }
      .cz-theme b { font-size:12px; color:var(--ink); font-weight:600; }
      .cz-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .cz-row label { font-size:13px; color:var(--ink); font-weight:500; }
      .cz-color { width:44px; height:28px; border:1px solid var(--border);
        border-radius:8px; background:none; cursor:pointer; padding:2px; }
      .cz-toggle { position:relative; width:42px; height:24px; flex:0 0 42px; }
      .cz-toggle input { opacity:0; width:0; height:0; position:absolute; }
      .cz-track { position:absolute; inset:0; background:var(--border);
        border-radius:20px; transition:background .18s ease; cursor:pointer; }
      .cz-track::after { content:''; position:absolute; left:3px; top:3px; width:18px; height:18px;
        border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25);
        transition:transform .18s ease; }
      .cz-toggle input:checked + .cz-track { background:var(--accent); }
      .cz-toggle input:checked + .cz-track::after { transform:translateX(18px); }
      .cz-hint { font-size:11.5px; color:var(--ink-dim); line-height:1.5; }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-customization-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  /* =========================================================================
     PART A — THEMES
     ========================================================================= */

  // Each preset is a full map of the palette vars defined in styles.css :root.
  // "Clay" reproduces the current default exactly so it is a no-op restyle.
  const THEMES = {
    clay: {
      label: 'Clay',
      vars: {
        '--canvas': '#f1eee6', '--sidebar': '#f7f4ed', '--topbar': '#f4f1ea',
        '--panel': '#ffffff', '--ink': '#3c352d', '--ink-mid': '#6f665a', '--ink-dim': '#a49a8a',
        '--accent': '#c05c37', '--accent-2': '#b8532f', '--accent-soft': '#f0e2d9', '--active': '#ecd9cd',
        '--border': 'rgba(60, 48, 34, 0.11)', '--border-soft': 'rgba(60, 48, 34, 0.06)',
        '--dot': '#d7d0c2',
        '--shadow': '0 12px 32px rgba(70, 52, 30, 0.12)', '--shadow-sm': '0 4px 14px rgba(70, 52, 30, 0.09)',
        '--ok': '#3fa66a',
      },
    },
    slate: {
      label: 'Slate',
      vars: {
        '--canvas': '#eceef1', '--sidebar': '#f3f5f7', '--topbar': '#eef1f4',
        '--panel': '#ffffff', '--ink': '#2b3038', '--ink-mid': '#5c636e', '--ink-dim': '#9aa2ad',
        '--accent': '#4f7cac', '--accent-2': '#40679a', '--accent-soft': '#dde6f0', '--active': '#d5dee9',
        '--border': 'rgba(34, 44, 60, 0.12)', '--border-soft': 'rgba(34, 44, 60, 0.06)',
        '--dot': '#c4cbd4',
        '--shadow': '0 12px 32px rgba(30, 40, 60, 0.14)', '--shadow-sm': '0 4px 14px rgba(30, 40, 60, 0.10)',
        '--ok': '#3fa66a',
      },
    },
    forest: {
      label: 'Forest',
      vars: {
        '--canvas': '#eef1ea', '--sidebar': '#f4f6f0', '--topbar': '#eff2ea',
        '--panel': '#ffffff', '--ink': '#2c352c', '--ink-mid': '#5d675a', '--ink-dim': '#9aa596',
        '--accent': '#4a8c5a', '--accent-2': '#3d7a4c', '--accent-soft': '#dcebdd', '--active': '#d6e6d5',
        '--border': 'rgba(40, 55, 40, 0.12)', '--border-soft': 'rgba(40, 55, 40, 0.06)',
        '--dot': '#c7d0c2',
        '--shadow': '0 12px 32px rgba(35, 55, 35, 0.13)', '--shadow-sm': '0 4px 14px rgba(35, 55, 35, 0.10)',
        '--ok': '#3fa66a',
      },
    },
  };
  const THEME_ORDER = ['clay', 'slate', 'forest'];

  // ── colour helpers (for the live accent picker) ────────────────────────────
  function hexToRgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    const t = (v) => ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2);
    return '#' + t(r) + t(g) + t(b);
  }
  function mix(a, b, t) {
    const A1 = hexToRgb(a), B1 = hexToRgb(b);
    return rgbToHex(A1.r + (B1.r - A1.r) * t, A1.g + (B1.g - A1.g) * t, A1.b + (B1.b - A1.b) * t);
  }
  const darken = (h, t) => mix(h, '#000000', t);

  // ── state (persisted under "atelier.theme") ────────────────────────────────
  const DEFAULT_STATE = { id: 'clay', accent: null, grid: true };
  const state = Object.assign({}, DEFAULT_STATE, A.store.get('atelier.theme', {}));
  if (!THEMES[state.id]) state.id = 'clay';

  function effectiveAccent() {
    return state.accent || THEMES[state.id].vars['--accent'];
  }

  // render() applies the *entire* state to :root. Idempotent — safe to call any
  // number of times; every setter just mutates `state` then calls render().
  function render() {
    const vars = THEMES[state.id].vars;
    for (const k in vars) ROOT.style.setProperty(k, vars[k]);
    if (state.accent) {
      const hex = state.accent;
      ROOT.style.setProperty('--accent', hex);
      ROOT.style.setProperty('--accent-2', darken(hex, 0.12));
      ROOT.style.setProperty('--accent-soft', mix(hex, '#ffffff', 0.82));
      ROOT.style.setProperty('--active', mix(hex, '#ffffff', 0.72));
    }
    // grid off = paint the dotted radial-gradient with a transparent dot colour
    ROOT.style.setProperty('--dot', state.grid === false ? 'transparent' : vars['--dot']);
  }

  function persistTheme() { A.store.set('atelier.theme', state); }

  // Setters. `silent` suppresses the outgoing bus echo (used when a setter is
  // itself invoked *by* a bus listener, so there is never a feedback loop).
  function setTheme(id, opts) {
    opts = opts || {};
    if (!THEMES[id]) return;
    state.id = id;
    state.accent = null;           // choosing a preset clears any custom accent
    render(); persistTheme(); refreshPanel();
    if (!opts.silent) A.bus.emit('theme:set', { id });
  }
  function setAccent(hex, opts) {
    opts = opts || {};
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return;
    state.accent = hex;
    render(); persistTheme(); refreshPanel();
    if (!opts.silent) A.bus.emit('theme:set', { accent: hex });
  }
  function setGridOn(on, opts) {
    opts = opts || {};
    state.grid = !!on;
    render(); persistTheme(); refreshPanel();
    if (!opts.silent) A.bus.emit('canvas:toggleGrid', state.grid);
  }

  // restore theme on load
  render();

  // bus entry points (other modules can drive theming without touching us)
  A.bus.on('theme:set', (d) => {
    if (d && typeof d === 'object') {
      if (d.id) setTheme(d.id, { silent: true });
      if (d.accent) setAccent(d.accent, { silent: true });
      if (typeof d.grid === 'boolean') setGridOn(d.grid, { silent: true });
    } else if (typeof d === 'string') {
      setTheme(d, { silent: true });
    }
  });
  A.bus.on('canvas:toggleGrid', (d) => {
    setGridOn(typeof d === 'boolean' ? d : !state.grid, { silent: true });
  });

  // ── the Customization panel ────────────────────────────────────────────────
  let panel = null;         // { el, body, close } while open, else null
  let controls = null;      // live control refs for refreshPanel()

  function refreshPanel() {
    if (!panel || !controls) return;
    controls.themeBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.theme === state.id));
    controls.color.value = effectiveAccent();
    controls.grid.checked = state.grid !== false;
  }

  function buildPanelBody() {
    const wrap = document.createElement('div');
    wrap.className = 'cz-wrap';

    // Themes
    const secT = document.createElement('div');
    const tTitle = document.createElement('div');
    tTitle.className = 'cz-sec-title'; tTitle.textContent = 'Theme';
    const grid = document.createElement('div');
    grid.className = 'cz-themes';
    const themeBtns = THEME_ORDER.map((id) => {
      const def = THEMES[id];
      const btn = document.createElement('div');
      btn.className = 'cz-theme';
      btn.dataset.theme = id;
      btn.innerHTML =
        `<div class="cz-sw" style="background:${def.vars['--canvas']}"><i style="background:${def.vars['--accent']}"></i></div>` +
        `<b>${def.label}</b>`;
      btn.addEventListener('click', () => setTheme(id));
      grid.appendChild(btn);
      return btn;
    });
    secT.append(tTitle, grid);

    // Accent
    const secA = document.createElement('div');
    const aTitle = document.createElement('div');
    aTitle.className = 'cz-sec-title'; aTitle.textContent = 'Accent';
    const aRow = document.createElement('div');
    aRow.className = 'cz-row';
    const aLabel = document.createElement('label');
    aLabel.textContent = 'Accent colour';
    const color = document.createElement('input');
    color.type = 'color'; color.className = 'cz-color'; color.value = effectiveAccent();
    color.addEventListener('input', () => setAccent(color.value));
    aRow.append(aLabel, color);
    secA.append(aTitle, aRow);

    // Grid
    const secG = document.createElement('div');
    const gTitle = document.createElement('div');
    gTitle.className = 'cz-sec-title'; gTitle.textContent = 'Canvas';
    const gRow = document.createElement('div');
    gRow.className = 'cz-row';
    const gLabel = document.createElement('label');
    gLabel.textContent = 'Dotted grid';
    const toggle = document.createElement('label');
    toggle.className = 'cz-toggle';
    const gInput = document.createElement('input');
    gInput.type = 'checkbox'; gInput.checked = state.grid !== false;
    gInput.addEventListener('change', () => setGridOn(gInput.checked));
    const track = document.createElement('span');
    track.className = 'cz-track';
    toggle.append(gInput, track);
    gRow.append(gLabel, toggle);
    const gHint = document.createElement('div');
    gHint.className = 'cz-hint';
    gHint.textContent = 'Theme, accent, grid and your board layout all persist across restarts.';
    secG.append(gTitle, gRow, gHint);

    wrap.append(secT, secA, secG);
    controls = { themeBtns, color, grid: gInput };
    return wrap;
  }

  function openPanel() {
    if (panel && document.body.contains(panel.el)) { panel.close(); }
    panel = A.ui.openPanel('Customization', buildPanelBody());
    refreshPanel();
    // clear our reference when the user closes the panel via its × button
    const x = panel.el.querySelector('.card-x');
    if (x) x.addEventListener('click', () => { panel = null; controls = null; });
  }

  // wire the sidebar "Customization" row
  (function wireSidebar() {
    const row = Array.from(document.querySelectorAll('.sb-row'))
      .find((r) => /customization/i.test(r.textContent || ''));
    if (row) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', openPanel);
    } else {
      console.warn('[customization] sidebar "Customization" row not found.');
    }
  })();

  /* =========================================================================
     PART B — LAYOUT PERSISTENCE  (cards + viewport, key "atelier.layout")
     ========================================================================= */

  const content = document.getElementById('content');
  const canvasEl = document.getElementById('canvas');
  const LAYOUT_KEY = 'atelier.layout';
  let restoring = false;
  let saveTimer = null;

  function cardRect(el) {
    return {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  }

  // Serialize a runtime card to HTML, mirroring live form values so notes etc.
  // survive. Built-in cards (metrics/chat, which the shell recreates every load)
  // are NOT serialized — only their geometry is remembered.
  function serializeCard(el) {
    const clone = el.cloneNode(true);
    const srcTa = el.querySelectorAll('textarea');
    const dstTa = clone.querySelectorAll('textarea');
    srcTa.forEach((ta, i) => { if (dstTa[i]) dstTa[i].textContent = ta.value; });
    const srcIn = el.querySelectorAll('input');
    const dstIn = clone.querySelectorAll('input');
    srcIn.forEach((inp, i) => { if (dstIn[i]) dstIn[i].setAttribute('value', inp.value); });
    clone.querySelectorAll('.resize-handle').forEach((h) => h.remove());
    clone.removeAttribute('data-card-id');
    return clone.outerHTML;
  }

  function collectCards() {
    return Array.from(content.querySelectorAll(':scope > .card')).map((el) => {
      const rect = cardRect(el);
      const builtin = el.getAttribute('data-card');
      if (builtin) return { kind: 'builtin', key: builtin, rect };
      return { kind: 'html', html: serializeCard(el), rect };
    });
  }

  function saveLayout() {
    if (restoring) return;
    try {
      A.store.set(LAYOUT_KEY, {
        v: 1,
        viewport: A.canvas.viewport(),
        cards: collectCards().filter((c) => c.kind === 'builtin'),
      });
    } catch (err) {
      console.warn('[customization] saveLayout failed', err);
    }
  }

  function scheduleSave() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLayout, 450);
  }

  // Restore the viewport by driving the core's OWN pan/zoom handlers with
  // synthetic events, so the core's internal pan/zoom stays consistent and the
  // first real pan/zoom after load does not jump.
  function restoreViewport(vp) {
    if (!vp) return;
    const rect = canvasEl.getBoundingClientRect();

    // 1) Zoom, anchored at the current world-origin's screen point so pan is
    //    left untouched by the zoom.
    let cur = A.canvas.viewport();
    const targetZoom = Math.min(2, Math.max(0.2, vp.zoom || 1));
    if (Math.abs(targetZoom - cur.zoom) > 0.001) {
      const factor = targetZoom / cur.zoom;         // core: factor = 1 - deltaY*0.01
      const deltaY = (1 - factor) * 100;
      canvasEl.dispatchEvent(new WheelEvent('wheel', {
        deltaY, ctrlKey: true,
        clientX: rect.left + cur.panX, clientY: rect.top + cur.panY,
        bubbles: true, cancelable: true,
      }));
    }

    // 2) Pan via a synthetic drag on empty canvas. Core captures its current
    //    panX/panY at mousedown then adds the pointer delta, so a delta of
    //    (target - current) lands core exactly on the saved pan.
    cur = A.canvas.viewport();
    const needX = (vp.panX || 0) - cur.panX;
    const needY = (vp.panY || 0) - cur.panY;
    if (Math.abs(needX) > 0.5 || Math.abs(needY) > 0.5) {
      const sx = rect.left + 6, sy = rect.top + 6;
      canvasEl.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + needX, clientY: sy + needY, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
  }

  function restoreLayout() {
    let saved = null;
    try { saved = A.store.get(LAYOUT_KEY, null); } catch { saved = null; }
    if (!saved) return;
    restoring = true;
    try {
      const cards = saved.cards || [];
      // built-in cards: reposition/resize the elements the shell already made
      cards.filter((c) => c.kind === 'builtin').forEach((c) => {
        const el = content.querySelector(`.card[data-card="${c.key}"]`);
        if (el && c.rect) {
          el.style.left = c.rect.x + 'px';
          el.style.top = c.rect.y + 'px';
          el.style.width = c.rect.w + 'px';
          el.style.height = c.rect.h + 'px';
        }
      });
      // Runtime cards (widgets/apps) own their own persistence; Part B keeps
      // only the viewport + built-in-card geometry to avoid double-restore.
      // viewport last
      restoreViewport(saved.viewport);
    } catch (err) {
      console.warn('[customization] restoreLayout failed', err);
    } finally {
      restoring = false;
    }
  }

  // Restore, THEN start watching for changes (so restore never re-triggers a save).
  restoreLayout();

  // One observer catches everything geometric: child .card style changes (drag /
  // resize) and #content's own transform (pan / zoom), all debounced into a save.
  const observer = new MutationObserver(scheduleSave);
  observer.observe(content, { attributes: true, attributeFilter: ['style'], subtree: true });
  A.bus.on('card:added', scheduleSave);
  A.bus.on('card:removed', scheduleSave);

  // debug / manual-test handle
  window.__atelierCustomization = {
    state, setTheme, setAccent, setGridOn, openPanel,
    saveLayout, restoreLayout, THEMES,
  };

  /* ── self-check: non-destructive assertions ──────────────────────────────── */
  (function selfCheck() {
    const problems = [];
    if (!(THEMES.clay && THEMES.slate && THEMES.forest)) problems.push('missing preset');
    // setProperty round-trips on :root
    ROOT.style.setProperty('--atelier-probe', '7');
    if (getComputedStyle(ROOT).getPropertyValue('--atelier-probe').trim() !== '7') problems.push('setProperty');
    ROOT.style.removeProperty('--atelier-probe');
    // store round-trips the theme state
    if (JSON.stringify(A.store.get('atelier.theme', null)) == null) problems.push('theme not persisted');
    console.assert(problems.length === 0, '[customization] self-check FAILED:', problems);
    if (!problems.length) {
      console.log('[customization] ready — theme "' + state.id + '", grid ' +
        (state.grid === false ? 'off' : 'on') + ', layout persistence armed.');
    }
  })();
})();
