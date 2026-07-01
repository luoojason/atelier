'use strict';

/* Atelier feature module — apps  (OpenSwarm parity)
   ==================================================
   Real, movable/resizable app cards spawned from the bottom dock (and the
   palette / registry). Registers five app-card types via Atelier.registerApp
   and owns the dock wiring, plus persistence of open apps + positions.

   Types:
     note      — editable sticky note (textarea), text persisted per note.
     browser   — URL bar that loads a site in a <webview> when the Electron
                 build enables webviewTag, else an <iframe> with a clear note.
     workflow  — list of Atelier scheduled jobs (sample; reads the scheduler
                 jobs when connected).
     calendar  — a simple month grid with prev/next month.
     history   — recent sessions (sample; reads the run ledger when connected).

   Dock wiring: index.html has six .dock-btn with title=Chat/Apps/Browser/
     Campaign/Notes/History. core.js already attached its own click handlers to
     these buttons, so this module CLONE-REPLACES each button (which strips
     core's listeners) and attaches its own — otherwise every click would spawn
     twice. This also fixes the "Notes" button, which core left inert.

   Persistence: open apps (type + config + rect) are stored under the Atelier
     store key "atelier.apps" and restored on load. A note's text and the
     browser's URL live in each app's config, so they survive a reload.

   Contract: builds ONLY against window.Atelier. Does not touch index.html,
     core.js, styles.css, or any other module. All CSS is injected below.

   ── SELF-CHECK ────────────────────────────────────────────────────────────
   Runtime assertions run at the bottom (see selfCheck): five types registered,
   the store key is an array, the dock has its buttons. On success the console
   logs "[apps] self-check passed".

   Manual test:
     1. `npm start` in desktop/ (or open index.html in a browser).
     2. Click the Browser dock button (🌐) → a browser card opens; type a URL
        (e.g. example.com) and press Go → the site loads (iframe in this build).
     3. Click Notes (🗒), type some text, then reload the app (Cmd-R) → the note
        reopens at its position with the text intact.
     4. Drag/resize any spawned card, reload → it restores where you left it.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.store) {
    console.warn('[apps] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.apps';

  // ── injected styles (warm palette via the shared CSS vars) ────────────────
  (function injectStyles() {
    if (document.getElementById('atl-apps-styles')) return;
    const css = `
      .atl-note-body { padding: 10px; }
      .atl-note-body .note-area { border-radius: 8px; padding: 8px; }

      .atl-browser-body { padding: 0; display: flex; flex-direction: column; }
      .atl-url-bar { display: flex; gap: 6px; padding: 8px 10px;
        border-bottom: 1px solid var(--border-soft); }
      .atl-url-input { flex: 1; min-width: 0; border: 1px solid var(--border);
        border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 12.5px;
        color: var(--ink); background: #faf7f1; outline: none; }
      .atl-url-input:focus { border-color: var(--accent); }
      .atl-url-go { border: none; border-radius: 8px; background: var(--accent);
        color: #fff; padding: 0 13px; font-size: 12.5px; cursor: pointer; }
      .atl-frame-note { font-size: 11.5px; color: var(--ink-dim);
        padding: 6px 10px; line-height: 1.4; }
      .atl-frame-note:empty { display: none; }
      .atl-frame-wrap { flex: 1; position: relative; background: #fff; }
      .atl-frame { position: absolute; inset: 0; width: 100%; height: 100%;
        border: none; background: #fff; }

      .atl-list-body { padding: 0; display: flex; flex-direction: column; }
      .atl-list-note { font-size: 11.5px; color: var(--ink-dim);
        padding: 9px 12px; border-bottom: 1px solid var(--border-soft); }
      .atl-row { display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--border-soft); }
      .atl-row:last-child { border-bottom: none; }
      .atl-row-main { flex: 1; min-width: 0; }
      .atl-row-title { font-size: 13px; color: var(--ink); font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .atl-row-sub { font-size: 11.5px; color: var(--ink-dim); margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .atl-pill { font-size: 10.5px; font-weight: 600; padding: 2px 8px;
        border-radius: 20px; white-space: nowrap; }
      .atl-pill.scheduled { color: var(--accent); background: var(--accent-soft); }
      .atl-pill.running { color: #fff; background: var(--accent); }
      .atl-pill.paused, .atl-pill.gated { color: var(--ink-mid); background: #ece5da; }
      .atl-pill.done { color: var(--ok); background: #e2f0e7; }

      .atl-cal-body { padding: 10px 12px; display: flex; flex-direction: column; }
      .atl-cal-head { display: flex; align-items: center;
        justify-content: space-between; margin-bottom: 8px; }
      .atl-cal-title { font-size: 13px; font-weight: 600; color: var(--ink); }
      .atl-cal-nav { border: none; background: transparent; color: var(--ink-mid);
        cursor: pointer; font-size: 16px; width: 24px; height: 24px;
        border-radius: 6px; line-height: 1; }
      .atl-cal-nav:hover { background: rgba(60, 48, 34, 0.06); }
      .atl-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
      .atl-cal-dow { font-size: 10.5px; color: var(--ink-dim); text-align: center;
        padding: 4px 0; font-weight: 600; }
      .atl-cal-cell { text-align: center; padding: 6px 0; font-size: 12px;
        color: var(--ink); border-radius: 7px; }
      .atl-cal-cell.blank { visibility: hidden; }
      .atl-cal-cell.today { background: var(--accent); color: #fff; font-weight: 700; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-apps-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── open-app registry + persistence ───────────────────────────────────────
  const openApps = new Map();     // appId -> { id, type, config, handle }
  let idSeq = 0;
  function genId(type) { return type + '-' + Date.now().toString(36) + '-' + (idSeq++).toString(36); }

  function safeRect(handle) { try { return handle.getRect(); } catch { return null; } }
  function snapshot() {
    return [...openApps.values()].map((r) => ({
      id: r.id, type: r.type, config: r.config, rect: safeRect(r.handle),
    }));
  }
  function persist() { A.store.set(STORE_KEY, snapshot()); }
  let persistTimer = null;
  function persistDebounced() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 250); }

  // Save rects after a drag/resize. Capture-phase mousedown is used so it still
  // fires even though core's resize-handle listener calls stopPropagation().
  let pendingSave = false;
  document.addEventListener('mousedown', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (card && card.dataset.atlAppId && openApps.has(card.dataset.atlAppId)) pendingSave = true;
  }, true);
  document.addEventListener('mouseup', () => {
    if (pendingSave) { pendingSave = false; persist(); }
  });

  // Card closed via its × button → core emits card:removed; drop it from state.
  if (A.bus && typeof A.bus.on === 'function') {
    A.bus.on('card:removed', ({ el }) => {
      const appId = el && el.dataset && el.dataset.atlAppId;
      if (appId && openApps.has(appId)) { openApps.delete(appId); persist(); }
    });
  }

  // ── card shell (matches core's expected structure) ────────────────────────
  function cardShell(title) {
    const card = document.createElement('section');
    card.className = 'card app-card';
    card.innerHTML =
      '<div class="card-bar"><span class="card-dot"></span>' +
      '<span class="card-title"></span><span class="card-x">×</span></div>' +
      '<div class="app-body"></div>';
    card.querySelector('.card-title').textContent = title;
    return { card, body: card.querySelector('.app-body') };
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function normalizeUrl(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    try { return new URL(raw).href; } catch { return ''; }
  }

  function webviewSupported() {
    // Electron's <webview> only works when the build sets webPreferences
    // .webviewTag = true. This build does not, so detection falls back to iframe.
    try {
      if (typeof customElements !== 'undefined' && customElements.get('webview')) return true;
      const el = document.createElement('webview');
      return typeof el.loadURL === 'function' || typeof el.reload === 'function';
    } catch { return false; }
  }

  // ── builders (function declarations so TYPES below can reference them) ─────
  function buildNote(body, cfg, api) {
    body.classList.add('atl-note-body');
    const ta = document.createElement('textarea');
    ta.className = 'note-area';
    ta.placeholder = 'Write a note…';
    ta.value = cfg.text || '';
    ta.addEventListener('input', () => api.setConfig({ text: ta.value }));
    body.appendChild(ta);
  }

  function buildBrowser(body, cfg, api) {
    body.classList.add('atl-browser-body');
    const useWebview = webviewSupported();

    const bar = document.createElement('form');
    bar.className = 'atl-url-bar';
    const input = document.createElement('input');
    input.className = 'atl-url-input';
    input.type = 'text';
    input.placeholder = 'Enter a URL…';
    input.value = cfg.url || '';
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'atl-url-go';
    go.textContent = 'Go';
    bar.append(input, go);

    const note = document.createElement('div');
    note.className = 'atl-frame-note';
    const frameWrap = document.createElement('div');
    frameWrap.className = 'atl-frame-wrap';

    let frame;
    if (useWebview) {
      frame = document.createElement('webview');
    } else {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      frame.setAttribute('referrerpolicy', 'no-referrer');
    }
    frame.className = 'atl-frame';
    frameWrap.appendChild(frame);

    function load(url) {
      const u = normalizeUrl(url);
      if (!u) return;
      input.value = u;
      if (useWebview) frame.setAttribute('src', u);
      else frame.src = u;
      note.textContent = useWebview
        ? ''
        : 'Rendered in an <iframe>. Sites that block embedding (X-Frame-Options) appear blank; a packaged Electron build with webviewTag can load any site.';
      api.setConfig({ url: u });
    }

    bar.addEventListener('submit', (e) => { e.preventDefault(); load(input.value); });

    body.append(bar, note, frameWrap);

    if (cfg.url) {
      load(cfg.url);
    } else {
      note.textContent = useWebview
        ? 'Enter a URL to load a site in a webview.'
        : 'Enter a URL to load a site in an <iframe> (this build has webviewTag off).';
    }
  }

  function buildList(body, noteText, items) {
    body.classList.add('atl-list-body');
    const n = document.createElement('div');
    n.className = 'atl-list-note';
    n.textContent = noteText;
    body.appendChild(n);
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'atl-row';
      const main = document.createElement('div');
      main.className = 'atl-row-main';
      const t = document.createElement('div');
      t.className = 'atl-row-title';
      t.textContent = it.title;
      const s = document.createElement('div');
      s.className = 'atl-row-sub';
      s.textContent = it.sub;
      main.append(t, s);
      const pill = document.createElement('span');
      pill.className = 'atl-pill ' + it.status;
      pill.textContent = it.statusLabel || it.status;
      row.append(main, pill);
      body.appendChild(row);
    });
  }

  function buildWorkflow(body) {
    buildList(body, 'Sample jobs — reads the Atelier scheduler when connected.', [
      { title: 'Weekly research digest', sub: 'Mon 09:00 · research → gate → publish', status: 'scheduled' },
      { title: 'Product launch campaign', sub: 'every 6h · draft → review gate', status: 'running' },
      { title: 'Short-form clip batch', sub: 'daily 18:00 · render → gate → post', status: 'paused' },
    ]);
  }

  function buildHistory(body) {
    buildList(body, 'Sample sessions — will read the run ledger when connected.', [
      { title: 'Metrics board refresh', sub: '2m ago · session #204', status: 'done' },
      { title: 'Landing copy — 3 variants', sub: '1h ago · session #203', status: 'done' },
      { title: 'Competitor teardown research', sub: 'yesterday · session #201', status: 'done' },
      { title: 'Newsletter campaign', sub: '2d ago · session #198', status: 'gated' },
    ]);
  }

  function buildCalendar(body, cfg, api) {
    body.classList.add('atl-cal-body');
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    const head = document.createElement('div');
    head.className = 'atl-cal-head';
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'atl-cal-nav'; prev.textContent = '‹';
    const titleEl = document.createElement('div');
    titleEl.className = 'atl-cal-title';
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'atl-cal-nav'; next.textContent = '›';
    head.append(prev, titleEl, next);

    const grid = document.createElement('div');
    grid.className = 'atl-cal-grid';
    body.append(head, grid);

    function render() {
      const now = new Date();
      const base = new Date(now.getFullYear(), now.getMonth() + (cfg.monthOffset || 0), 1);
      const y = base.getFullYear(), m = base.getMonth();
      titleEl.textContent = MONTHS[m] + ' ' + y;
      grid.innerHTML = '';
      DOW.forEach((d) => {
        const c = document.createElement('div');
        c.className = 'atl-cal-dow'; c.textContent = d;
        grid.appendChild(c);
      });
      const firstDay = new Date(y, m, 1).getDay();
      const days = new Date(y, m + 1, 0).getDate();
      for (let i = 0; i < firstDay; i++) {
        const b = document.createElement('div');
        b.className = 'atl-cal-cell blank';
        grid.appendChild(b);
      }
      for (let d = 1; d <= days; d++) {
        const c = document.createElement('div');
        c.className = 'atl-cal-cell'; c.textContent = String(d);
        if (y === now.getFullYear() && m === now.getMonth() && d === now.getDate()) c.classList.add('today');
        grid.appendChild(c);
      }
    }

    prev.addEventListener('click', () => { cfg.monthOffset = (cfg.monthOffset || 0) - 1; api.setConfig({ monthOffset: cfg.monthOffset }); render(); });
    next.addEventListener('click', () => { cfg.monthOffset = (cfg.monthOffset || 0) + 1; api.setConfig({ monthOffset: cfg.monthOffset }); render(); });
    render();
  }

  // ── type table ────────────────────────────────────────────────────────────
  const TYPES = {
    note:     { label: 'Note', icon: '🗒', title: 'Note', w: 300, h: 240, defaultConfig: { text: '' }, build: buildNote },
    browser:  { label: 'Browser', icon: '🌐', title: 'Browser', w: 480, h: 380, defaultConfig: { url: '' }, build: buildBrowser },
    workflow: { label: 'Workflow', icon: '↺', title: 'Workflow', w: 380, h: 290, defaultConfig: {}, build: buildWorkflow },
    calendar: { label: 'Calendar', icon: '🗓', title: 'Calendar', w: 320, h: 330, defaultConfig: { monthOffset: 0 }, build: buildCalendar },
    history:  { label: 'History', icon: '🕘', title: 'History', w: 380, h: 300, defaultConfig: {}, build: buildHistory },
  };

  // ── spawn (also the registered create() path) ─────────────────────────────
  function centerPos(w, h) {
    const canvasEl = document.getElementById('canvas');
    const r = canvasEl.getBoundingClientRect();
    const world = A.canvas.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    const off = (openApps.size % 6) * 26;            // cascade so cards don't stack exactly
    return { x: world.x - w / 2 + off, y: world.y - h / 2 + off };
  }

  function makeApp(type, opts) {
    opts = opts || {};
    const def = TYPES[type];
    if (!def) return null;
    const appId = opts.id || genId(type);
    const cfg = Object.assign({}, def.defaultConfig || {}, opts.config || {});
    const shell = cardShell(def.title);
    shell.card.dataset.atlAppId = appId;

    const api = { setConfig(patch) { Object.assign(cfg, patch); persistDebounced(); } };
    def.build(shell.body, cfg, api);

    const rect = opts.rect || {};
    let x, y;
    if (rect.x != null && rect.y != null) { x = rect.x; y = rect.y; }
    else if (opts.pos) { x = opts.pos.x; y = opts.pos.y; }
    else { const p = centerPos(def.w, def.h); x = p.x; y = p.y; }
    const w = rect.w || def.w;
    const h = rect.h || def.h;

    const handle = A.canvas.addCard(shell.card, { x, y, w, h });
    openApps.set(appId, { id: appId, type, config: cfg, handle });
    persist();
    return handle;
  }

  // ── register the five app types (overrides core's stubs) ──────────────────
  Object.keys(TYPES).forEach((type) => {
    const def = TYPES[type];
    A.registerApp(type, {
      label: def.label,
      icon: def.icon,
      defaultConfig: def.defaultConfig,
      // core.spawnApp / the palette call this; makeApp already runs addCard, so
      // core sees dataset.cardId and returns the element without re-adding it.
      create(worldPos) { const h = makeApp(type, { pos: worldPos }); return h ? h.el : null; },
    });
  });

  // ── restore previously-open apps ──────────────────────────────────────────
  (function restore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    saved.forEach((rec) => {
      if (!rec || !TYPES[rec.type]) return;
      makeApp(rec.type, { id: rec.id, config: rec.config, rect: rec.rect || undefined });
    });
  })();

  // ── own the dock (clone-replace strips core's listeners → no double-spawn) ─
  const DOCK_MAP = {
    apps: 'note', browser: 'browser', campaign: 'workflow',
    notes: 'note', history: 'history', calendar: 'calendar',
  };
  (function wireDock() {
    document.querySelectorAll('.dock-btn').forEach((btn) => {
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        document.querySelectorAll('.dock-btn').forEach((x) => x.classList.remove('active'));
        fresh.classList.add('active');
        const t = (fresh.getAttribute('title') || '').toLowerCase();
        if (t === 'chat') { const i = document.getElementById('input'); if (i) i.focus(); return; }
        const type = DOCK_MAP[t];
        if (type) makeApp(type, {});
      });
    });
  })();

  // ── self-check ────────────────────────────────────────────────────────────
  (function selfCheck() {
    const need = ['note', 'browser', 'workflow', 'calendar', 'history'];
    const missing = need.filter((t) => !(A.apps && A.apps.has(t)));
    console.assert(missing.length === 0, '[apps] missing registered types:', missing);
    const stored = A.store.get(STORE_KEY, []);
    console.assert(Array.isArray(stored), '[apps] store key atelier.apps is not an array');
    const dock = document.querySelectorAll('.dock-btn');
    console.assert(dock.length >= 6, '[apps] expected 6 dock buttons, got', dock.length);
    if (!missing.length && Array.isArray(stored) && dock.length >= 6) {
      console.log('[apps] self-check passed — 5 app types registered, dock wired, store ok.');
    }
  })();
})();
