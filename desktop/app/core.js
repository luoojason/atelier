'use strict';

/* ===========================================================================
   Atelier core — desktop/app/core.js

   Owns the canvas (pan / wheel-zoom), floating cards (drag / resize / raise),
   the dock, the chat card, and the backend status. Builds and exposes
   `window.Atelier`, the single API every feature module builds against.

   Feature modules (app/widgets.js, app/apps.js, app/palette.js,
   app/customization.js) load AFTER this file and must only touch
   `window.Atelier` — never the DOM shell, styles.css, or each other.

   The look and feel (warm cream canvas, dotted grid, terracotta accent) lives
   in index.html + styles.css and is intentionally untouched here — this file
   only moves behavior, it does not restyle.

   ── MANUAL TEST ──────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser).
   2. Open DevTools console — expect: "[Atelier] core ready — API surface
      verified." and NO console.assert failures.
   3. Drag the metrics card and the chat card by their title bars; drag the
      little handle at each card's bottom-right corner to resize. Both must
      move/resize (proving they now route through Atelier.canvas.addCard).
   4. Drag empty canvas to pan; wheel to zoom (zoom % updates bottom-right).
   5. Double-click empty canvas — a toast "world (x, y)" appears (registered
      by the smoke hook below), proving onDoubleClick + screenToWorld.
   6. Click dock buttons (Apps / Browser / Campaign / Notes / History) — an
      app card spawns near center and is itself draggable/resizable.
   7. In the console run:
        Atelier.ui.toast('hi'); Atelier.ui.openPanel('Test', Object.assign(
          document.createElement('div'), { textContent: 'panel body' }));
      A toast and a draggable floating panel appear.
   8. Click the zoombar ⤢ (Fit) button — the view frames every card with a
      ~60px margin (zoom clamped to 20–200%); with zero cards it resets to
      pan (0,0) at 100%. Same via Atelier.canvas.fitToView(). In the console,
      Atelier.canvas.setViewport({panX: 40, panY: 40, zoom: 1.2}) repaints.
   9. Press Cmd/Ctrl+M on empty canvas — a Note card spawns (fallback; a
      module listening on bus 'shortcut:add-app' claims the key instead).
      Press Escape while a floating panel is open — the topmost panel
      closes; with none open, bus 'shortcut:escape' fires. Cmd/Ctrl+M is
      ignored while typing in an input/textarea; Escape always works.
   =========================================================================== */

(function () {
  // ── shell elements ────────────────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  const content = document.getElementById('content');
  const dotEl = document.getElementById('status-dot');
  const statusTextEl = document.getElementById('status-text');
  const zoomLabel = document.getElementById('zoom-level');

  // ── viewport state (pan + zoom) ───────────────────────────────────────────
  let panX = 0, panY = 0, zoom = 1;
  const MIN_Z = 0.2, MAX_Z = 2;

  function applyTransform() {
    content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  }
  function zoomAt(nz, cx, cy) {              // keep screen point (cx,cy) fixed
    nz = Math.min(MAX_Z, Math.max(MIN_Z, nz));
    panX = cx - (cx - panX) * (nz / zoom);
    panY = cy - (cy - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }
  function zoomCenter(nz) {
    const r = canvas.getBoundingClientRect();
    zoomAt(nz, r.width / 2, r.height / 2);
  }

  document.getElementById('zoom-in').onclick = () => zoomCenter(zoom * 1.15);
  document.getElementById('zoom-out').onclick = () => zoomCenter(zoom / 1.15);

  canvas.addEventListener('wheel', (e) => {
    if (e.target.closest('.chat-body') || e.target.closest('textarea')) return; // let cards scroll
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const factor = e.ctrlKey ? (1 - e.deltaY * 0.01) : (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    zoomAt(zoom * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ── pan by dragging empty canvas ──────────────────────────────────────────
  let panning = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
    panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    canvas.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    panX = panning.px + (e.clientX - panning.x);
    panY = panning.py + (e.clientY - panning.y);
    applyTransform();
  });
  window.addEventListener('mouseup', () => { panning = null; canvas.classList.remove('panning'); });

  // world <-> screen ---------------------------------------------------------
  function screenToWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  function viewport() { return { panX, panY, zoom }; }
  function centerWorld(cardW = 340, cardH = 230) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (r.width / 2 - panX) / zoom - cardW / 2,
      y: (r.height / 2 - panY) / zoom - cardH / 2,
    };
  }

  // fit all cards in view with a ~60px margin; no cards -> reset viewport
  function fitToView() {
    const cards = Array.from(content.children).filter((el) => el.classList.contains('card'));
    if (!cards.length) { panX = 0; panY = 0; zoom = 1; applyTransform(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cards.forEach((el) => {
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + el.offsetWidth);
      maxY = Math.max(maxY, y + el.offsetHeight);
    });
    const r = canvas.getBoundingClientRect();
    const bw = maxX - minX, bh = maxY - minY;
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, Math.min(r.width / (bw + 120), r.height / (bh + 120))));
    zoom = nz;
    panX = (r.width - bw * nz) / 2 - minX * nz;  // center the bbox horizontally
    panY = (r.height - bh * nz) / 2 - minY * nz; // ...and vertically
    applyTransform();
  }
  const fitBtn = document.querySelector('.zoombar [title="Fit"]');
  if (fitBtn) fitBtn.addEventListener('click', fitToView);

  // apply an explicit viewport (boards restore theirs through this) + repaint
  function setViewport(v = {}) {
    if (typeof v.panX === 'number' && isFinite(v.panX)) panX = v.panX;
    if (typeof v.panY === 'number' && isFinite(v.panY)) panY = v.panY;
    if (typeof v.zoom === 'number' && isFinite(v.zoom)) zoom = Math.min(MAX_Z, Math.max(MIN_Z, v.zoom));
    applyTransform();
  }

  // ── event bus ─────────────────────────────────────────────────────────────
  const listeners = new Map();
  const bus = {
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name) && listeners.get(name).delete(cb);
    },
    emit(name, data) {
      const set = listeners.get(name);
      if (!set) return;
      set.forEach((cb) => { try { cb(data); } catch (err) { console.error('[Atelier] bus handler for', name, err); } });
    },
  };

  // ── JSON store (localStorage) ─────────────────────────────────────────────
  const STORE_PREFIX = 'atelier:';
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };

  // ── backend (proxies the preload bridge window.atelier) ───────────────────
  const backend = {
    chat(message) {
      return Promise.resolve().then(() => {
        if (!window.atelier || typeof window.atelier.chat !== 'function') {
          throw new Error('Atelier backend bridge unavailable');
        }
        return window.atelier.chat(message);
      });
    },
    health() {
      return Promise.resolve().then(() => {
        if (!window.atelier || typeof window.atelier.health !== 'function') {
          throw new Error('Atelier backend bridge unavailable');
        }
        return window.atelier.health();
      });
    },
  };

  // ── cards: drag (by .card-bar), resize (handle), raise on mousedown ────────
  let zTop = 10;
  let cardSeq = 0;
  function bringToFront(card) { card.style.zIndex = ++zTop; }

  function makeInteractive(card) {
    bringToFront(card);
    card.addEventListener('mousedown', () => bringToFront(card));

    const bar = card.querySelector('.card-bar');
    if (bar) {
      bar.addEventListener('mousedown', (e) => {
        if (e.target.closest('.card-x')) return;
        const start = {
          x: e.clientX, y: e.clientY,
          l: parseFloat(card.style.left) || 0,
          t: parseFloat(card.style.top) || 0,
        };
        const move = (ev) => {
          card.style.left = start.l + (ev.clientX - start.x) / zoom + 'px';
          card.style.top = start.t + (ev.clientY - start.y) / zoom + 'px';
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
      });
    }

    // resize handle
    let handle = card.querySelector('.resize-handle');
    if (!handle) { handle = document.createElement('div'); handle.className = 'resize-handle'; card.appendChild(handle); }
    handle.addEventListener('mousedown', (e) => {
      const start = { x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
      const move = (ev) => {
        card.style.width = Math.max(240, start.w + (ev.clientX - start.x) / zoom) + 'px';
        card.style.height = Math.max(160, start.h + (ev.clientY - start.y) / zoom) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * addCard(el, {x, y, w?, h?, title?}) -> handle
   * Appends `el` into the canvas content at WORLD coords (x,y), sizes it,
   * makes it draggable by its .card-bar, resizable, raises it on mousedown.
   */
  function addCard(el, opts = {}) {
    const { x = 0, y = 0, w, h, title } = opts;
    el.classList.add('card');
    el.style.position = 'absolute';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (w != null) el.style.width = (typeof w === 'number' ? w + 'px' : w);
    if (h != null) el.style.height = (typeof h === 'number' ? h + 'px' : h);
    if (title) {
      const t = el.querySelector('.card-title');
      if (t) t.textContent = title;
    }
    content.appendChild(el);

    const id = 'card-' + (++cardSeq);
    el.dataset.cardId = id;
    makeInteractive(el);

    const handle = {
      el,
      id,
      remove() { el.remove(); bus.emit('card:removed', { id, el }); },
      setRect(rect = {}) {
        if (rect.x != null) el.style.left = rect.x + 'px';
        if (rect.y != null) el.style.top = rect.y + 'px';
        if (rect.w != null) el.style.width = rect.w + 'px';
        if (rect.h != null) el.style.height = rect.h + 'px';
      },
      getRect() {
        return {
          x: parseFloat(el.style.left) || 0,
          y: parseFloat(el.style.top) || 0,
          w: el.offsetWidth,
          h: el.offsetHeight,
        };
      },
    };

    // close button routes through the handle so card:removed fires
    const x0 = el.querySelector('.card-x');
    if (x0) x0.addEventListener('click', () => handle.remove());

    bus.emit('card:added', { id, el });
    return handle;
  }

  // double-click on EMPTY canvas -> world coords
  const dblClickCbs = new Set();
  canvas.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    dblClickCbs.forEach((cb) => { try { cb(x, y, e); } catch (err) { console.error('[Atelier] onDoubleClick handler', err); } });
  });
  function onDoubleClick(cb) { dblClickCbs.add(cb); return () => dblClickCbs.delete(cb); }

  // ── app + widget registries ───────────────────────────────────────────────
  const appRegistry = new Map();
  const widgetRegistry = new Map();

  function registerApp(type, def) {
    appRegistry.set(type, def || {});
    bus.emit('app:registered', { type, def });
  }
  function registerWidget(type, def) {
    widgetRegistry.set(type, def || {});
    bus.emit('widget:registered', { type, def });
  }

  function spawnApp(type, worldPos) {
    const def = appRegistry.get(type);
    if (!def || typeof def.create !== 'function') return null;
    const pos = worldPos || centerWorld();
    const el = def.create(pos);
    if (!el) return null;
    if (el.dataset && el.dataset.cardId) return el; // create() already used addCard
    return addCard(el, { x: pos.x, y: pos.y });
  }

  function spawnWidget(type, config, worldPos) {
    // widgets.js owns config forms, live-data mounts, and persistence — route
    // through it when loaded so every spawn path (palette, scripts) behaves
    // like the picker. The inline path below is only the pre-widgets fallback.
    if (window.AtelierWidgets && typeof window.AtelierWidgets.spawn === 'function') {
      return window.AtelierWidgets.spawn(type, config, worldPos);
    }
    const def = widgetRegistry.get(type);
    if (!def || typeof def.render !== 'function') return null;
    const cfg = Object.assign({}, def.defaultConfig || {}, config || {});
    const inner = def.render(cfg);
    const card = document.createElement('section');
    card.className = 'card widget-card';
    card.innerHTML =
      '<div class="card-bar"><span class="card-dot"></span>' +
      '<span class="card-title"></span><span class="card-x">×</span></div>';
    card.querySelector('.card-title').textContent = cfg.title || def.label || type;
    const body = document.createElement('div');
    body.className = 'app-body';
    if (inner) body.appendChild(inner);
    card.appendChild(body);
    const pos = worldPos || centerWorld(300, 200);
    return addCard(card, { x: pos.x, y: pos.y, w: 300, h: 200 });
  }

  // ── ui: toast + floating panel (styles injected here, not in styles.css) ──
  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .atelier-toasts { position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
        display: flex; flex-direction: column; gap: 8px; z-index: 9999; pointer-events: none; }
      .atelier-toast { background: var(--panel); color: var(--ink);
        border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px;
        box-shadow: var(--shadow); font-size: 13px; max-width: 340px;
        opacity: 0; transform: translateY(-6px); transition: opacity .18s ease, transform .18s ease; }
      .atelier-toast.show { opacity: 1; transform: translateY(0); }
      .atelier-panel { position: fixed; top: 90px; left: 50%; transform: translateX(-50%);
        min-width: 280px; max-width: 520px; background: var(--panel);
        border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow); z-index: 9000; display: flex; flex-direction: column;
        overflow: hidden; }
      .atelier-panel-body { padding: 14px; overflow: auto; max-height: 60vh; color: var(--ink); }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-core-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  let toastHost = null;
  function toast(text) {
    ensureStyles();
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'atelier-toasts';
      document.body.appendChild(toastHost);
    }
    const t = document.createElement('div');
    t.className = 'atelier-toast';
    t.textContent = text;
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, 2600);
    return t;
  }

  function openPanel(title, el) {
    ensureStyles();
    const panel = document.createElement('div');
    panel.className = 'atelier-panel';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    bar.innerHTML = '<span class="card-dot"></span><span class="card-title"></span><span class="card-x">×</span>';
    bar.querySelector('.card-title').textContent = title || 'Panel';
    const body = document.createElement('div');
    body.className = 'atelier-panel-body';
    if (el) body.appendChild(el);
    panel.append(bar, body);
    document.body.appendChild(panel);

    const close = () => panel.remove();
    bar.querySelector('.card-x').addEventListener('click', close);

    // draggable (screen-space; panels float above the canvas, unaffected by zoom)
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.card-x')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      const start = { x: e.clientX, y: e.clientY, l: rect.left, t: rect.top };
      const move = (ev) => {
        panel.style.left = start.l + (ev.clientX - start.x) + 'px';
        panel.style.top = start.t + (ev.clientY - start.y) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });

    return { el: panel, body, close };
  }

  // ── chat card ─────────────────────────────────────────────────────────────
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const messagesEl = document.getElementById('messages');
  let sending = false;

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function clearEmpty() { const e = document.getElementById('empty-state'); if (e) e.remove(); }
  function avatar(role) {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.textContent = role === 'assistant' ? 'A' : 'You';
    return a;
  }
  function addMessage(role, text) {
    clearEmpty();
    const row = document.createElement('div');
    row.className = `row ${role}`;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    row.append(avatar(role), b);
    messagesEl.appendChild(row);
    scrollBottom();
    return b;
  }
  function addThinking() {
    clearEmpty();
    const row = document.createElement('div');
    row.className = 'row assistant';
    const b = document.createElement('div');
    b.className = 'bubble thinking';
    b.textContent = 'Thinking…';
    row.append(avatar('assistant'), b);
    messagesEl.appendChild(row);
    scrollBottom();
    return b;
  }
  function extractReply(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    return d.response ?? d.reply ?? d.message ?? d.text ?? d.output ?? d.content ?? '';
  }
  function extractError(d) {
    if (!d) return 'No response.';
    return d.message ?? d.detail ?? (typeof d.error === 'string' ? d.error : null) ?? 'Something went wrong.';
  }
  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true; sendEl.disabled = true; inputEl.value = ''; grow();
    addMessage('user', text);
    bus.emit('chat:sent', { text });
    const t = addThinking();
    try {
      const data = await backend.chat(text);
      t.classList.remove('thinking');
      t.textContent = (data && data.error) ? extractError(data) : (extractReply(data) || '(empty response)');
      bus.emit('chat:reply', { data });
    } catch {
      t.classList.remove('thinking');
      t.textContent = 'Could not reach the Atelier backend. It may still be starting — try again in a moment.';
    } finally {
      sending = false; sendEl.disabled = false; scrollBottom(); inputEl.focus();
    }
  }
  function grow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }
  inputEl.addEventListener('input', grow);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendEl.addEventListener('click', send);

  // ── backend status polling ────────────────────────────────────────────────
  function setStatus(ok) {
    dotEl.classList.remove('ok', 'bad');
    if (ok === true) { dotEl.classList.add('ok'); statusTextEl.textContent = 'on subscription'; }
    else if (ok === false) { dotEl.classList.add('bad'); statusTextEl.textContent = 'backend offline'; }
    else { statusTextEl.textContent = 'connecting…'; }
    bus.emit('backend:status', { ok });
  }
  async function pollHealth() {
    try {
      const h = await backend.health();
      setStatus(!!(h && (h.ok === true || h.status === 'ok')));
    } catch { setStatus(false); }
  }

  // ── built-in dock app types (preserve existing spawn behavior) ────────────
  function makeAppCard(title, bodyHTML) {
    const card = document.createElement('section');
    card.className = 'card app-card';
    card.innerHTML =
      `<div class="card-bar"><span class="card-dot"></span>` +
      `<span class="card-title">${title}</span><span class="card-x">×</span></div>` +
      `<div class="app-body">${bodyHTML}</div>`;
    return card;
  }
  registerApp('note', { label: 'Note', icon: '🗒', create: () => makeAppCard('Note', `<textarea class="note-area" placeholder="Write a note…"></textarea>`) });
  registerApp('browser', { label: 'Browser', icon: '🌐', create: () => makeAppCard('Browser', `<div class="app-stub">🌐 Browser card — open a site as a card. (Wire to a webview to enable.)</div>`) });
  registerApp('workflow', { label: 'Workflow', icon: '↺', create: () => makeAppCard('Workflow', `<div class="app-stub">↺ Workflow — a scheduled Atelier job (research → gate → publish).</div>`) });
  registerApp('calendar', { label: 'Calendar', icon: '🗓', create: () => makeAppCard('Calendar', `<div class="app-stub">🗓 Calendar — schedule campaigns and posts.</div>`) });
  registerApp('history', { label: 'History', icon: '🕘', create: () => makeAppCard('History', `<div class="app-stub">🕘 Recent sessions and run ledger.</div>`) });

  document.querySelectorAll('.dock-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.dock-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const t = (b.getAttribute('title') || '').toLowerCase();
      if (t === 'chat') { inputEl.focus(); return; }
      if (t === 'apps') { spawnApp('note'); return; }
      if (t === 'campaign') { spawnApp('workflow'); return; }
      if (appRegistry.has(t)) spawnApp(t);
    });
  });

  // ── keyboard shortcuts (Cmd/Ctrl+M add-app, Escape close/escape) ──────────
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return; // palette & friends handle their own keys
    if (e.key === 'Escape') {
      // Escape works even while typing. Close the topmost floating panel if
      // one is open (uniform z-index, so last in DOM order paints on top).
      const panels = document.querySelectorAll('.atelier-panel');
      if (panels.length) panels[panels.length - 1].remove();
      else bus.emit('shortcut:escape');
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      bus.emit('shortcut:add-app', {});
      const subs = listeners.get('shortcut:add-app');
      // ponytail: note-spawn fallback until an app-launcher module registers
      // a 'shortcut:add-app' bus listener and owns the key.
      if (!subs || subs.size === 0) spawnApp('note');
    }
  });

  // ── publish the API ───────────────────────────────────────────────────────
  window.Atelier = {
    canvas: { addCard, onDoubleClick, viewport, screenToWorld, fitToView, setViewport },
    bus,
    store,
    backend,
    ui: { toast, openPanel },
    registerApp,
    registerWidget,
    // helpers feature modules use to spawn what they register:
    spawnApp,
    spawnWidget,
    apps: appRegistry,
    widgets: widgetRegistry,
  };

  // ── boot: register the pre-existing metrics + chat cards through addCard ──
  document.querySelectorAll('#content > .card').forEach((el) => {
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    addCard(el, { x, y }); // width/height stay from CSS; look unchanged
  });

  applyTransform();
  setStatus(null);
  pollHealth();
  setInterval(pollHealth, 4000);
  inputEl.focus();


  // ── self-check: assert the documented API surface exists ──────────────────
  (function selfCheck() {
    const A = window.Atelier;
    const checks = [
      ['canvas.addCard', A.canvas && typeof A.canvas.addCard === 'function'],
      ['canvas.onDoubleClick', typeof A.canvas.onDoubleClick === 'function'],
      ['canvas.viewport', typeof A.canvas.viewport === 'function'],
      ['canvas.screenToWorld', typeof A.canvas.screenToWorld === 'function'],
      ['canvas.fitToView', typeof A.canvas.fitToView === 'function'],
      ['canvas.setViewport', typeof A.canvas.setViewport === 'function'],
      ['bus.on', A.bus && typeof A.bus.on === 'function'],
      ['bus.emit', A.bus && typeof A.bus.emit === 'function'],
      ['store.get', A.store && typeof A.store.get === 'function'],
      ['store.set', A.store && typeof A.store.set === 'function'],
      ['backend.chat', A.backend && typeof A.backend.chat === 'function'],
      ['backend.health', A.backend && typeof A.backend.health === 'function'],
      ['ui.toast', A.ui && typeof A.ui.toast === 'function'],
      ['ui.openPanel', A.ui && typeof A.ui.openPanel === 'function'],
      ['registerApp', typeof A.registerApp === 'function'],
      ['registerWidget', typeof A.registerWidget === 'function'],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([n]) => n);
    console.assert(missing.length === 0, '[Atelier] MISSING API methods:', missing);
    if (!missing.length) console.log('[Atelier] core ready — API surface verified.');
    bus.emit('core:ready', { api: A });
  })();
})();
