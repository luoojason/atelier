'use strict';

/* ===========================================================================
   Atelier feature module — views   (app/views.js)

   Full-area "views": overlays that cover the canvas INSIDE #canvas (the
   topbar/sidebar/statusbar stay), with a sidebar navigation section. This is
   the surface analytics.js registers its dashboards into; the Settings view
   at the bottom of this file is the first consumer.

   API (CONTRACT 1 — analytics.js codes against exactly this):
     window.Atelier.views = {
       register(id, { label, icon, section 'analytics'(default)|'foot',
                      parent, order, mount(container)->cleanupFn,
                      render(container) fire-and-forget alt,
                      onRefresh }) -> unregister(),
       select(id), close(), current() -> id|null, list() -> def[],
     }

   Behavior:
   - section 'analytics' rows live in a views-OWNED .sb-group.vw-nav inserted
     before .sb-foot (below Apps, above the footer), created LAZILY on the
     first 'analytics' registration so an empty section never shows. Defs with
     `parent` render indented (.vw-sub) under their parent row; `order` sorts.
   - section 'foot' REUSES the existing .sb-foot > .sb-row "Settings" row
     (click bound; no new row is created).
   - select(id) opens a .view-overlay (absolute, inset 0, z-index 50) inside
     #canvas, adds 'canvas--view' to #canvas (hides dock/zoombar/minimap via
     injected CSS), and persists Atelier.store 'view.current'.
   - Overlay header: icon + label, an optional ↻ Refresh button (only when the
     def has onRefresh), and × close. mount() receives the BODY container and
     may return a cleanup fn — close() always runs it.
   - Return-to-canvas: header ×, bus 'shortcut:escape', a click on the boards
     "Dashboards" .sb-group, and bus 'boards:will-switch' (which also nulls
     'view.current' BEFORE boards.js snapshots the live keys).
   - Cmd-R restore: the persisted 'view.current' is re-opened when its def
     registers (pendingRestore check inside register(), so late-loading
     modules like analytics.js restore fine).

   This module touches ONLY its own .vw-nav group and the footer Settings row.
   It never edits boards' Dashboards group, core.js, styles.css, index.html,
   or any sibling module. All CSS it needs is injected below.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser). Console shows
      "[views] ready — API surface verified." and
      "[views] settings view registered." with no console.assert failures.
   2. No "Analytics" sidebar section exists yet (nothing registered into it).
      In DevTools run:
        u = Atelier.views.register('demo', { label: 'Demo', icon: '◔',
          mount(c) { c.textContent = 'demo body';
            return () => console.log('demo cleanup'); } });
      → an "Analytics" group appears between Apps and the footer with a
      "Demo" row. boards' Dashboards group is untouched.
   3. Click "Demo" → a full-area overlay covers the canvas (dock, zoombar and
      minimap hidden; topbar/sidebar/statusbar still visible), header shows
      ◔ Demo and ×, NO ↻ (no onRefresh), body says "demo body", and the Demo
      row is highlighted. Atelier.views.current() === 'demo';
      localStorage 'atelier:view.current' is "demo".
   4. Close it four ways, each logging "demo cleanup" exactly once and
      clearing 'view.current': (a) header ×, (b) Escape, (c) click the
      Dashboards group header, (d) reopen then switch boards (view closes
      before the reload snapshot; the new board loads with no view).
   5. Register a child + order:
        Atelier.views.register('demo.sub', { label: 'Sub', parent: 'demo',
          order: 2, render(c) { c.textContent = 'sub'; } });
      → an indented "Sub" row under Demo. Clicking it swaps the overlay
      in-place (Demo's cleanup logs first — mount-cleanup discipline).
   6. Open Demo, press Cmd-R → after reload Demo re-opens by itself
      (pendingRestore fires when the console re-register runs… for the
      built-in test just open Settings instead and Cmd-R: Settings reopens).
   7. u() (the returned unregister) → the Demo row disappears; with 'demo.sub'
      also unregistered the whole Analytics group vanishes (never empty).
   8. Click the footer "Settings" row → the Settings view opens: warm-cream
      cards for Backend configuration (Model / Max turns / Scheduler /
      Jobs file / Auth mode from GET /config — all "unavailable" if the
      backend is down), Appearance (theme/accent/grid from customization),
      Connection (live backend status — stop lite_server and within ~4s it
      flips to "offline"), Security (token presence text only, NEVER the
      value). Header has ↻ (re-fetches /config) and ×.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  const canvas = document.getElementById('canvas');
  const sidebar = document.querySelector('.sidebar');
  if (!A || !A.bus || !A.store || !A.ui || !canvas || !sidebar) {
    console.warn('[views] Atelier core / shell not available — skipping.');
    return;
  }

  const STORE_KEY = 'view.current';

  // ── injected CSS ───────────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atelier-views-styles')) return;
    const css = `
      .view-overlay { position: absolute; inset: 0; z-index: 50; display: flex;
        flex-direction: column; background: var(--canvas); }
      .canvas--view .dock, .canvas--view .zoombar, .canvas--view .minimap { display: none; }
      /* widgets.js's "+ widget" button is fixed at z-index 8000 (above the
         overlay) and would sit exactly on the header's ↻/× — hide canvas
         chrome while a view is open, same intent as the dock/zoombar rule. */
      body:has(.canvas--view) .wgt-add-btn { display: none; }
      .vw-row.active { background: var(--active); color: var(--ink); font-weight: 600; }
      .vw-nav .vw-row { display: flex; align-items: center; gap: 9px; }
      .vw-sub { margin-left: 44px; }
      .view-head { display: flex; align-items: center; gap: 10px; padding: 12px 20px;
        border-bottom: 1px solid var(--border-soft); flex: 0 0 auto; }
      .view-head .vh-ic { width: 22px; text-align: center; color: var(--ink-mid); font-size: 15px; }
      .view-head .vh-title { font-size: 15px; font-weight: 700; color: var(--ink); }
      .view-head .vh-spacer { flex: 1; }
      .vh-btn { border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 15px;
        line-height: 1; padding: 0; }
      .vh-btn:hover { background: var(--active); color: var(--ink); }
      .view-body { flex: 1; overflow: auto; padding: 20px 24px; }
      .vw-error { color: var(--ink-dim); font-size: 13px; padding: 12px 2px; }
      .vw-set { width: 100%; max-width: 720px; margin: 0 auto; display: flex;
        flex-direction: column; gap: 16px; }
      .vw-card { background: var(--panel); border: 1px solid var(--border);
        border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 16px 18px; }
      .vw-card-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; margin-bottom: 8px; }
      .vw-kv { display: flex; align-items: baseline; justify-content: space-between;
        gap: 16px; padding: 7px 0; border-bottom: 1px solid var(--border-soft);
        font-size: 13.5px; }
      .vw-kv:last-child { border-bottom: none; }
      .vw-kv .k { color: var(--ink-mid); flex: 0 0 auto; }
      .vw-kv .v { color: var(--ink); font-weight: 600; text-align: right;
        overflow-wrap: anywhere; min-width: 0; }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-views-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── registry state ─────────────────────────────────────────────────────────
  const defs = new Map();     // id -> normalized def
  let seq = 0;                // registration order tiebreaker for sorting
  let currentId = null;
  let overlay = null;         // { root, body } while a view is open
  let activeCleanup = null;   // the open mount's returned cleanup fn
  let navHost = null;         // .sb-group.vw-nav (lazy; removed when emptied)
  let footId = null;          // the view the footer Settings row opens
  let footBound = false;

  // Cmd-R restore: re-open the persisted view when its def registers.
  let pendingRestore = null;
  (function initRestore() {
    const saved = A.store.get(STORE_KEY, null);
    if (typeof saved === 'string' && saved) pendingRestore = saved;
  })();

  // ── sidebar nav (.vw-nav — views-OWNED; never boards' Dashboards group) ────
  function makeRow(d, sub) {
    const row = document.createElement('div');
    row.className = 'sb-item vw-row' + (sub ? ' vw-sub' : '') +
      (d.id === currentId ? ' active' : '');
    row.dataset.viewId = d.id;
    const ic = document.createElement('span');
    ic.className = 'sb-ic';
    ic.textContent = d.icon || '◫';
    const label = document.createElement('span');
    label.className = 'vw-label';
    label.textContent = d.label;             // XSS rule: textContent only
    row.append(ic, label);
    row.title = d.label;
    row.addEventListener('click', () => select(d.id));
    return row;
  }

  function renderNav() {
    const items = Array.from(defs.values()).filter((d) => d.section === 'analytics');
    if (!items.length) {                     // empty section never shows
      if (navHost) { navHost.remove(); navHost = null; }
      return;
    }
    if (!navHost) {
      navHost = document.createElement('div');
      navHost.className = 'sb-group vw-nav'; // head says "Analytics" — can never
      const head = document.createElement('div'); // match boards' /dashboards/i
      head.className = 'sb-head';
      const ic = document.createElement('span');
      ic.className = 'sb-ic';
      ic.textContent = '◔';
      const title = document.createElement('span');
      title.className = 'sb-title';
      title.textContent = 'Analytics';
      head.append(ic, title);
      navHost.appendChild(head);
      const foot = sidebar.querySelector('.sb-foot');
      if (foot) sidebar.insertBefore(navHost, foot);
      else sidebar.appendChild(navHost);
    }
    // rows are DIRECT children of the .sb-group (contract shape); keep the head
    navHost.querySelectorAll(':scope > .vw-row').forEach((r) => r.remove());
    const ids = new Set(items.map((d) => d.id));
    const byOrder = (a, b) => (a.order - b.order) || (a.seq - b.seq);
    // top-level = no parent, or a parent that isn't a registered analytics def
    const tops = items
      .filter((d) => !(d.parent && d.parent !== d.id && ids.has(d.parent)))
      .sort(byOrder);
    tops.forEach((d) => {
      navHost.appendChild(makeRow(d, false));
      items.filter((c) => c !== d && c.parent === d.id).sort(byOrder)
        .forEach((c) => navHost.appendChild(makeRow(c, true)));
    });
  }

  function refreshActive() {
    if (!navHost) return;
    navHost.querySelectorAll('.vw-row').forEach((r) => {
      r.classList.toggle('active', r.dataset.viewId === currentId);
    });
  }

  // ── footer Settings row (REUSED — never a new row) ─────────────────────────
  function bindFoot() {
    if (footBound) return;
    const rows = Array.from(document.querySelectorAll('.sidebar .sb-foot .sb-row'));
    const row = rows.find((r) => /settings/i.test(r.textContent || '')) || rows[0];
    if (!row) { console.warn('[views] footer Settings row not found.'); return; }
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      if (footId && defs.has(footId)) select(footId);
    });
    footBound = true;
  }

  // ── overlay ────────────────────────────────────────────────────────────────
  function headerButton(glyph, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vh-btn';
    b.title = title;
    b.textContent = glyph;
    return b;
  }

  function buildOverlay(d) {
    const root = document.createElement('div');
    root.className = 'view-overlay';
    // The overlay lives INSIDE #canvas, so events bubble into core.js's canvas
    // handlers, which would act on the HIDDEN board: wheel zooms the canvas
    // (and preventDefault kills native scrolling of .view-body), mousedown
    // pans / shift-drags the marquee OVER the view, dblclick opens the
    // "+ widget" picker. views.js may only touch its own DOM (contract), so
    // stop propagation at the overlay root instead of editing core.js.
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('dblclick', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'view-head';
    const ic = document.createElement('span');
    ic.className = 'vh-ic';
    ic.textContent = d.icon || '◫';
    const title = document.createElement('span');
    title.className = 'vh-title';
    title.textContent = d.label;
    const spacer = document.createElement('span');
    spacer.className = 'vh-spacer';
    head.append(ic, title, spacer);
    if (typeof d.onRefresh === 'function') {   // Refresh slot only when provided
      const rb = headerButton('↻', 'Refresh');
      rb.addEventListener('click', () => {
        try { d.onRefresh(); }
        catch (err) { console.error('[views] onRefresh failed for', d.id, err); }
      });
      head.appendChild(rb);
    }
    const xb = headerButton('×', 'Close');
    xb.addEventListener('click', close);
    head.appendChild(xb);
    const body = document.createElement('div');
    body.className = 'view-body';
    root.append(head, body);
    return { root, body };
  }

  // Tears the open view down (cleanup + DOM) WITHOUT touching the store —
  // select() re-persists right after; close() clears the key itself.
  function teardown() {
    if (activeCleanup) {
      try { activeCleanup(); }
      catch (err) { console.error('[views] mount cleanup failed for', currentId, err); }
      activeCleanup = null;
    }
    if (overlay) { overlay.root.remove(); overlay = null; }
    canvas.classList.remove('canvas--view');
    currentId = null;
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function select(id) {
    const d = defs.get(id);
    if (!d) { console.warn('[views] select: unknown view "' + id + '"'); return; }
    if (currentId === id) return;
    pendingRestore = null;                   // a manual pick beats a stale restore
    teardown();
    currentId = id;
    overlay = buildOverlay(d);
    canvas.appendChild(overlay.root);
    canvas.classList.add('canvas--view');
    try {
      if (d.mount) {
        const c = d.mount(overlay.body);
        activeCleanup = typeof c === 'function' ? c : null;
      } else if (d.render) {
        d.render(overlay.body);              // fire-and-forget alternative
      }
    } catch (err) {
      console.error('[views] mount failed for', id, err);
      const msg = document.createElement('div');
      msg.className = 'vw-error';
      msg.textContent = 'This view failed to load — see the console.';
      overlay.body.appendChild(msg);
    }
    A.store.set(STORE_KEY, id);
    refreshActive();
  }

  function close() {
    if (!currentId) return;
    teardown();
    A.store.set(STORE_KEY, null);
    refreshActive();
  }

  function current() { return currentId; }

  function list() {
    return Array.from(defs.values()).map((d) => ({
      id: d.id, label: d.label, icon: d.icon, section: d.section,
      parent: d.parent, order: d.order,
    }));
  }

  function register(id, spec) {
    if (typeof id !== 'string' || !id) {
      console.warn('[views] register: bad id', id);
      return function () {};
    }
    spec = spec || {};
    const d = {
      id,
      label: spec.label != null ? String(spec.label) : id,
      icon: spec.icon != null ? String(spec.icon) : '',
      section: spec.section === 'foot' ? 'foot' : 'analytics',
      parent: typeof spec.parent === 'string' && spec.parent ? spec.parent : null,
      order: Number.isFinite(spec.order) ? spec.order : 0,
      mount: typeof spec.mount === 'function' ? spec.mount : null,
      render: typeof spec.render === 'function' ? spec.render : null,
      onRefresh: typeof spec.onRefresh === 'function' ? spec.onRefresh : null,
      seq: ++seq,
    };
    if (defs.has(id)) console.warn('[views] register: replacing existing view "' + id + '"');
    defs.set(id, d);
    if (d.section === 'analytics') renderNav();
    else { footId = id; bindFoot(); }
    if (pendingRestore === id) {             // late-registration Cmd-R restore
      pendingRestore = null;
      select(id);
    }
    return function unregister() {
      if (defs.get(id) !== d) return;        // already replaced — not ours to drop
      defs.delete(id);
      if (currentId === id) close();
      if (footId === id) footId = null;
      renderNav();
    };
  }

  A.views = { register, select, close, current, list };

  // ── return-to-canvas hooks ─────────────────────────────────────────────────
  A.bus.on('shortcut:escape', () => { if (currentId) close(); });
  // close() runs synchronously inside boards' emit — BEFORE snapshotLive —
  // so the board switch also nulls the persisted 'view.current'.
  // reason:'export' is boards' debounce-flush signal (boardExportEntry), not
  // a real switch — exporting while a view is open must not close it.
  A.bus.on('boards:will-switch', (d) => {
    if (currentId && !(d && d.reason === 'export')) close();
  });
  (function bindDashboards() {
    const groups = Array.from(document.querySelectorAll('.sidebar .sb-group'));
    const dash = groups.find((g) => {
      const t = g.querySelector('.sb-title');
      return t && /dashboards/i.test(t.textContent || '');
    });
    if (dash) dash.addEventListener('click', () => { if (currentId) close(); });
  })();

  // ── self-check: assert the documented API surface exists ──────────────────
  (function selfCheck() {
    const problems = [];
    ['register', 'select', 'close', 'current', 'list'].forEach((k) => {
      if (typeof A.views[k] !== 'function') problems.push('views.' + k);
    });
    if (navHost) problems.push('vw-nav rendered with zero registrations');
    if (currentId !== null) problems.push('view open before any registration');
    console.assert(problems.length === 0, '[views] self-check FAILED:', problems);
    if (!problems.length) console.log('[views] ready — API surface verified.');
  })();
})();

/* ===========================================================================
   Settings view — the first consumer of Atelier.views (section 'foot').
   Reads GET /config (never the token value), the customization theme state,
   and the live backend status off the bus. Registered from its own IIFE so
   it exercises exactly the surface analytics.js will.
   =========================================================================== */
(function () {
  const A = window.Atelier;
  if (!A || !A.views || !A.bus || !A.store || !A.backend) {
    console.warn('[views] settings view: Atelier.views not available — skipping.');
    return;
  }

  const CONFIG_URL = 'http://127.0.0.1:8765/config';
  let refreshHook = null;    // set by the live mount; onRefresh calls through it

  function mountSettings(container) {
    let disposed = false;
    const wrap = document.createElement('div');
    wrap.className = 'vw-set';
    const val = {};          // key -> value <span> (all writes via textContent)

    function card(title, rows) {
      const c = document.createElement('div');
      c.className = 'vw-card';
      const t = document.createElement('div');
      t.className = 'vw-card-title';
      t.textContent = title;
      c.appendChild(t);
      rows.forEach(([label, key, initial]) => {
        const r = document.createElement('div');
        r.className = 'vw-kv';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = initial;
        r.append(k, v);
        val[key] = v;
        c.appendChild(r);
      });
      return c;
    }

    wrap.append(
      card('Backend configuration', [
        ['Model', 'model', 'loading…'],
        ['Max turns', 'max_turns', 'loading…'],
        ['Scheduler', 'scheduler', 'loading…'],
        ['Jobs file', 'jobs_file', 'loading…'],
        ['Auth mode', 'auth_mode', 'loading…'],
      ]),
      card('Appearance', [
        ['Theme', 'theme', '—'],
        ['Accent', 'accent', '—'],
        ['Dotted grid', 'grid', '—'],
      ]),
      card('Connection', [
        ['Backend status', 'status', 'connecting…'],
      ]),
      card('Security', [
        ['Token', 'token', '—'],
      ])
    );
    container.appendChild(wrap);

    // Theme — customization.js persists {id, accent, grid} under 'atelier.theme'
    // and exposes its preset table on window.__atelierCustomization.THEMES.
    const theme = Object.assign(
      { id: 'clay', accent: null, grid: true },
      A.store.get('atelier.theme', {}) || {}
    );
    const cz = window.__atelierCustomization;
    const preset = cz && cz.THEMES && cz.THEMES[theme.id];
    val.theme.textContent = (preset && preset.label) ||
      (String(theme.id).charAt(0).toUpperCase() + String(theme.id).slice(1));
    val.accent.textContent = theme.accent ? String(theme.accent) + ' (custom)' : 'theme default';
    val.grid.textContent = theme.grid === false ? 'off' : 'on';

    // Token — presence text ONLY; the value itself is never rendered.
    // /config's token_present is authoritative (loadConfig overwrites this):
    // the server, not the renderer bridge, decides whether mutating routes
    // are enforced. The preload token is only the pre-fetch hint.
    val.token.textContent = (window.atelier && window.atelier.token)
      ? 'minted — mutating routes protected'
      : 'checking…';

    // Backend status — live off the bus (core polls /health every 4s), seeded
    // with one direct health() call so the row is right before the next poll.
    function setStatus(ok) {
      val.status.textContent =
        ok === true ? 'online — on subscription'
          : ok === false ? 'offline'
            : 'connecting…';
    }
    const unsub = A.bus.on('backend:status', (d) => {
      if (!disposed) setStatus(d ? d.ok : null);
    });
    A.backend.health()
      .then((h) => { if (!disposed) setStatus(!!(h && (h.ok === true || h.status === 'ok'))); })
      .catch(() => { if (!disposed) setStatus(false); });

    // /config — read-only GET; every failure path degrades to 'unavailable'.
    function fmt(v) {
      return (v === null || v === undefined || v === '') ? 'unavailable' : String(v);
    }
    function loadConfig() {
      fetch(CONFIG_URL)
        .then((r) => { if (!r.ok) throw new Error('config HTTP ' + r.status); return r.json(); })
        .then((cfg) => {
          if (disposed || !cfg || typeof cfg !== 'object') return;
          val.model.textContent = fmt(cfg.model);
          val.max_turns.textContent = fmt(cfg.max_turns);
          const sch = cfg.scheduler;
          val.scheduler.textContent =
            (sch && typeof sch.running === 'boolean')
              ? (sch.running ? 'running' : 'stopped')
              : 'unknown';                   // running:null = server can't honestly know
          val.jobs_file.textContent = fmt(cfg.jobs_file);
          val.auth_mode.textContent = fmt(cfg.auth_mode);
          val.token.textContent = cfg.token_present
            ? 'minted — mutating routes protected'
            : 'not enforced (dev)';
        })
        .catch(() => {
          if (disposed) return;
          ['model', 'max_turns', 'scheduler', 'jobs_file', 'auth_mode', 'token']
            .forEach((k) => { val[k].textContent = 'unavailable'; });
        });
    }
    loadConfig();
    refreshHook = loadConfig;

    return function cleanup() {
      disposed = true;
      if (refreshHook === loadConfig) refreshHook = null;
      try { unsub(); } catch { /* bus unsubscribe is best-effort */ }
    };
  }

  A.views.register('settings', {
    label: 'Settings',
    icon: '⚙',
    section: 'foot',
    mount: mountSettings,
    onRefresh() { if (refreshHook) refreshHook(); },
  });

  console.assert(
    A.views.list().some((v) => v.id === 'settings' && v.section === 'foot'),
    '[views] settings view failed to register'
  );
  console.log('[views] settings view registered.');
})();
