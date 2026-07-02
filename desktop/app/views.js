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
      cards for Model provider (segmented "Claude Max subscription" /
      "Anthropic API key" control + API key save/validate/remove — controls
      disabled and "unavailable" shown if the backend is down), Backend
      configuration (Model segmented picker + Max turns / Scheduler /
      Jobs file / Auth mode from GET /config — rows "unavailable" and the
      picker disabled if the backend is down),
      Appearance (theme/accent/grid from customization), Connection (live
      backend status "online — on subscription" / "online — on API key"
      tracking the effective provider — stop lite_server and within ~4s it
      flips to "offline"), Security (token presence text only, NEVER the
      value). Header has ↻ (re-fetches /config) and ×.
   9. Model provider card: with no key saved, clicking "Anthropic API key"
      surfaces the backend's 400 error text inline ("no API key saved").
      Paste a key and Save → the input clears and a "Saved key: …last4"
      line appears with a Remove button (the full key is never rendered).
      Validate → "✓ key accepted" or "✗ <detail>" inline. Remove → the hint
      line disappears and the provider flips back to subscription. Every
      button disables while its request is in flight, and stays disabled
      even if the header ↻ lands a /config response mid-flight.
   10. Backend configuration card: the Model row is a sonnet / opus / haiku
      segmented control with the resolved model highlighted. Clicking the
      active segment is a no-op (no request). Clicking another segment
      disables the trio while POST /config/model is in flight, then the
      highlight moves once /config reflects it (existing agent sessions
      rebuild lazily; the next chat turn uses the new model). A 400 from an
      out-of-allowlist POST or any failure surfaces inline under the row;
      stop lite_server and click → "backend unreachable". With env
      CLAUDE_CLI_MODEL set outside the trio (and no saved setting), a
      fourth, DISABLED segment labeled with that value renders as the
      active one; picking sonnet/opus/haiku persists a setting that beats
      the env and the fourth segment disappears on the next /config load.
      Like the provider card, a header ↻ /config response landing mid-POST
      must not re-enable the segments.
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
      /* Model provider card — interactive rows (settings view, dual auth) */
      .vw-kv.vw-ctl { align-items: center; }
      .vw-seg { display: inline-flex; border: 1px solid var(--border);
        border-radius: 9px; overflow: hidden; }
      .vw-seg button { border: none; background: var(--panel); color: var(--ink-mid);
        font: inherit; font-size: 12.5px; padding: 6px 12px; cursor: pointer; }
      .vw-seg button + button { border-left: 1px solid var(--border); }
      .vw-seg button.active { background: var(--active); color: var(--ink); font-weight: 600; }
      .vw-seg button:disabled { opacity: .5; cursor: default; }
      .vw-key-ctl { display: flex; align-items: center; gap: 8px; flex: 1;
        justify-content: flex-end; min-width: 0; }
      .vw-key-input { flex: 1; min-width: 0; max-width: 260px; border: 1px solid var(--border);
        border-radius: 8px; padding: 6px 9px; font: inherit; font-size: 12.5px;
        background: var(--panel); color: var(--ink); }
      .vw-key-input:disabled { opacity: .5; }
      .vw-btn { border: 1px solid var(--border); background: var(--panel);
        color: var(--ink-mid); border-radius: 8px; padding: 6px 10px; cursor: pointer;
        font: inherit; font-size: 12.5px; }
      .vw-btn:hover:not(:disabled) { background: var(--active); color: var(--ink); }
      .vw-btn:disabled { opacity: .5; cursor: default; }
      .vw-note { font-size: 12.5px; color: var(--ink-mid); padding: 6px 0 2px; }
      .vw-note.ok { color: var(--ok); }
      .vw-note.err { color: var(--accent); }
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
   and the live backend status off the bus, and drives the dual-auth provider
   routes (POST /config/provider, POST/DELETE /config/api-key, validate) plus
   the model picker (POST /config/model) — all token-gated. Registered from
   its own IIFE so it exercises exactly the surface analytics.js will.
   =========================================================================== */
(function () {
  const A = window.Atelier;
  if (!A || !A.views || !A.bus || !A.store || !A.backend) {
    console.warn('[views] settings view: Atelier.views not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const CONFIG_URL = BASE + '/config';
  let refreshHook = null;    // set by the live mount; onRefresh calls through it

  // Fetch JSON against the backend; resolves {ok, status, data}, throws only
  // on network failure. Mutating routes need the shared-secret header when
  // main.js minted one (window.atelier.token via preload) — sessions.js idiom.
  async function api(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

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

    // ── Model provider card (dual auth) ────────────────────────────────────
    // Interactive, so built bespoke — card() above only does static rows.
    // provider / api_key_present / api_key_hint arrive on the same GET
    // /config the read-only card uses; loadConfig below feeds both. The key
    // VALUE never enters the DOM — only the server's …last4 hint.
    function btn(label, cls) {
      const b = document.createElement('button');
      b.type = 'button';
      if (cls) b.className = cls;
      b.textContent = label;
      return b;
    }
    function noteLine() {
      const n = document.createElement('div');
      n.className = 'vw-note';
      n.style.display = 'none';
      return n;
    }
    function setNote(el, text, kind) {       // kind: 'ok' | 'err' | undefined
      el.textContent = text || '';
      el.className = 'vw-note' + (kind ? ' ' + kind : '');
      el.style.display = text ? '' : 'none';
    }

    const provCard = document.createElement('div');
    provCard.className = 'vw-card';
    const provTitle = document.createElement('div');
    provTitle.className = 'vw-card-title';
    provTitle.textContent = 'Model provider';

    const provRow = document.createElement('div');
    provRow.className = 'vw-kv vw-ctl';
    const provLabel = document.createElement('span');
    provLabel.className = 'k';
    provLabel.textContent = 'Provider';
    const seg = document.createElement('div');
    seg.className = 'vw-seg';
    const segSub = btn('Claude Max subscription');
    const segApi = btn('Anthropic API key');
    seg.append(segSub, segApi);
    provRow.append(provLabel, seg);
    const provNote = noteLine();

    const keyRow = document.createElement('div');
    keyRow.className = 'vw-kv vw-ctl';
    const keyLabel = document.createElement('span');
    keyLabel.className = 'k';
    keyLabel.textContent = 'API key';
    const keyCtl = document.createElement('span');
    keyCtl.className = 'vw-key-ctl';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.className = 'vw-key-input';
    keyInput.placeholder = 'sk-ant-…';
    keyInput.autocomplete = 'off';
    const saveBtn = btn('Save', 'vw-btn');
    const validateBtn = btn('Validate', 'vw-btn');
    keyCtl.append(keyInput, saveBtn, validateBtn);
    keyRow.append(keyLabel, keyCtl);

    const hintRow = document.createElement('div');
    hintRow.className = 'vw-kv vw-ctl';
    hintRow.style.display = 'none';          // shown only while a key is stored
    const hintText = document.createElement('span');
    hintText.className = 'k';
    const removeBtn = btn('Remove', 'vw-btn');
    hintRow.append(hintText, removeBtn);
    const keyNote = noteLine();

    provCard.append(provTitle, provRow, provNote, keyRow, hintRow, keyNote);

    const provControls = [segSub, segApi, keyInput, saveBtn, validateBtn, removeBtn];
    function setProvEnabled(on) {
      provControls.forEach((el) => { el.disabled = !on; });
    }
    setProvEnabled(false);                   // until the first /config lands

    let provReachable = false;               // last GET /config outcome
    let provBusy = false;                    // a provider POST/DELETE in flight
    function applyProviderCfg(cfg) {
      provReachable = true;
      const p = cfg.provider === 'api' ? 'api' : 'subscription';
      segSub.classList.toggle('active', p === 'subscription');
      segApi.classList.toggle('active', p === 'api');
      setProvider(p);                        // Connection card status text
      const present = !!cfg.api_key_present;
      hintText.textContent = present ? 'Saved key: ' + String(cfg.api_key_hint || '') : '';
      hintRow.style.display = present ? '' : 'none';
      // clear only the degrade text — action errors stay visible until acted on
      if (provNote.textContent === 'unavailable') setNote(provNote, '');
      // the header ↻ can land a /config response while a provider request is
      // in flight — re-enabling under it would allow a concurrent second POST
      if (!provBusy) setProvEnabled(true);
    }
    function degradeProviderCard() {
      provReachable = false;
      setProvEnabled(false);
      segSub.classList.remove('active');
      segApi.classList.remove('active');
      hintRow.style.display = 'none';
      setNote(provNote, 'unavailable');
      setNote(keyNote, '');
    }

    // One in-flight provider request at a time: the whole cluster disables,
    // then re-enables from the last-known reachability when it settles (a
    // loadConfig kicked off inside re-affirms right after). provBusy keeps
    // applyProviderCfg from re-enabling mid-flight (see above).
    async function provAction(fn) {
      provBusy = true;
      setProvEnabled(false);
      try { await fn(); }
      finally {
        provBusy = false;
        if (!disposed) setProvEnabled(provReachable);
      }
    }

    function pickProvider(p) {
      // skip the no-op click: re-POSTing the active provider would only cost
      // the server a pointless chat-client reset
      if ((p === 'api' ? segApi : segSub).classList.contains('active')) return;
      provAction(async () => {
        setNote(provNote, '');
        try {
          const r = await api('/config/provider', {
            method: 'POST', body: JSON.stringify({ provider: p }),
          });
          if (disposed) return;
          if (r.ok) loadConfig();            // reflect the effective provider
          else setNote(provNote, (r.data && r.data.error) ||
            ('provider switch failed (HTTP ' + r.status + ')'), 'err');
        } catch {
          if (!disposed) setNote(provNote, 'backend unreachable', 'err');
        }
      });
    }
    segSub.addEventListener('click', () => pickProvider('subscription'));
    segApi.addEventListener('click', () => pickProvider('api'));

    saveBtn.addEventListener('click', () => provAction(async () => {
      setNote(keyNote, '');
      const v = keyInput.value.trim();
      if (!v) { setNote(keyNote, 'enter a key first', 'err'); return; }
      try {
        const r = await api('/config/api-key', {
          method: 'POST', body: JSON.stringify({ api_key: v }),
        });
        if (disposed) return;
        if (r.ok) {
          keyInput.value = '';
          setNote(keyNote, 'key saved', 'ok');
          loadConfig();                      // refresh the Saved key hint row
        } else {
          setNote(keyNote, (r.data && r.data.error) ||
            ('save failed (HTTP ' + r.status + ')'), 'err');
        }
      } catch {
        if (!disposed) setNote(keyNote, 'backend unreachable', 'err');
      }
    }));

    removeBtn.addEventListener('click', () => provAction(async () => {
      setNote(keyNote, '');
      try {
        const r = await api('/config/api-key', { method: 'DELETE' });
        if (disposed) return;
        if (r.ok) { setNote(keyNote, 'key removed', 'ok'); loadConfig(); }
        else setNote(keyNote, (r.data && r.data.error) ||
          ('remove failed (HTTP ' + r.status + ')'), 'err');
      } catch {
        if (!disposed) setNote(keyNote, 'backend unreachable', 'err');
      }
    }));

    validateBtn.addEventListener('click', () => provAction(async () => {
      setNote(keyNote, 'validating…');
      const v = keyInput.value.trim();
      try {
        // empty JSON body means "validate the stored key" server-side
        const r = await api('/config/api-key/validate', {
          method: 'POST', body: JSON.stringify(v ? { api_key: v } : {}),
        });
        if (disposed) return;
        const d = r.data || {};
        if (d.valid === true) setNote(keyNote, '✓ key accepted', 'ok');
        else setNote(keyNote, '✗ ' + String(d.detail || 'validation failed'), 'err');
      } catch {
        if (!disposed) setNote(keyNote, 'backend unreachable', 'err');
      }
    }));

    // ── Model picker (Backend configuration card) ──────────────────────────
    // r15: the read-only Model row becomes a segmented control, mirroring
    // the provider-segment idiom above exactly (same .vw-seg styles, same
    // in-flight discipline). POST /config/model persists settings["model"],
    // which beats env CLAUDE_CLI_MODEL; the server resets the chat client so
    // the next chat turn uses it (existing agent sessions rebuild lazily).
    // A resolved model outside the trio (custom env) renders as a fourth,
    // DISABLED segment labeled with that value — display only, never a POST.
    const MODELS = ['sonnet', 'opus', 'haiku'];
    const backendCard = card('Backend configuration', [
      ['Max turns', 'max_turns', 'loading…'],
      ['Scheduler', 'scheduler', 'loading…'],
      ['Jobs file', 'jobs_file', 'loading…'],
      ['Auth mode', 'auth_mode', 'loading…'],
    ]);
    const modelRow = document.createElement('div');
    modelRow.className = 'vw-kv vw-ctl';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'k';
    modelLabel.textContent = 'Model';
    const modelSeg = document.createElement('div');
    modelSeg.className = 'vw-seg';
    const modelBtns = {};                    // 'sonnet'|'opus'|'haiku' -> button
    MODELS.forEach((m) => {
      const b = btn(m);
      modelBtns[m] = b;
      modelSeg.appendChild(b);
    });
    const modelCustom = btn('');             // fourth segment: custom env value
    modelCustom.disabled = true;             // display only — stays disabled
    modelCustom.style.display = 'none';
    modelSeg.appendChild(modelCustom);
    modelRow.append(modelLabel, modelSeg);
    const modelNote = noteLine();
    const firstKv = backendCard.querySelector('.vw-kv');
    backendCard.insertBefore(modelRow, firstKv);
    backendCard.insertBefore(modelNote, firstKv);

    function setModelEnabled(on) {           // modelCustom is never re-enabled
      MODELS.forEach((m) => { modelBtns[m].disabled = !on; });
    }
    setModelEnabled(false);                  // until the first /config lands

    let modelReachable = false;              // last GET /config outcome
    let modelBusy = false;                   // a model POST in flight
    function applyModelCfg(cfg) {
      modelReachable = true;
      const m = typeof cfg.model === 'string' ? cfg.model : '';
      MODELS.forEach((k) => modelBtns[k].classList.toggle('active', k === m));
      if (m && MODELS.indexOf(m) === -1) {   // custom env model
        modelCustom.textContent = m;         // server string: textContent only
        modelCustom.classList.add('active');
        modelCustom.style.display = '';
      } else {
        modelCustom.classList.remove('active');
        modelCustom.style.display = 'none';
      }
      // clear only the degrade text — action errors stay visible until acted on
      if (modelNote.textContent === 'unavailable') setNote(modelNote, '');
      // the header ↻ can land a /config response while a model POST is in
      // flight — re-enabling under it would allow a concurrent second POST
      if (!modelBusy) setModelEnabled(true);
    }
    function degradeModelCtl() {
      modelReachable = false;
      setModelEnabled(false);
      MODELS.forEach((k) => modelBtns[k].classList.remove('active'));
      modelCustom.classList.remove('active');
      modelCustom.style.display = 'none';
      setNote(modelNote, 'unavailable');
    }

    // One in-flight model request at a time — same discipline as provAction:
    // the trio disables, then re-enables from the last-known reachability
    // when it settles (the loadConfig kicked off inside re-affirms after).
    async function modelAction(fn) {
      modelBusy = true;
      setModelEnabled(false);
      try { await fn(); }
      finally {
        modelBusy = false;
        if (!disposed) setModelEnabled(modelReachable);
      }
    }

    function pickModel(m) {
      // skip the no-op click: re-POSTing the active model would only cost
      // the server a pointless chat-client reset
      if (modelBtns[m].classList.contains('active')) return;
      modelAction(async () => {
        setNote(modelNote, '');
        try {
          const r = await api('/config/model', {
            method: 'POST', body: JSON.stringify({ model: m }),
          });
          if (disposed) return;
          if (r.ok) loadConfig();            // reflect the resolved model
          else setNote(modelNote, (r.data && r.data.error) ||
            ('model switch failed (HTTP ' + r.status + ')'), 'err');
        } catch {
          if (!disposed) setNote(modelNote, 'backend unreachable', 'err');
        }
      });
    }
    MODELS.forEach((m) => {
      modelBtns[m].addEventListener('click', () => pickModel(m));
    });

    wrap.append(
      provCard,
      backendCard,
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
    // The "on …" suffix tracks the EFFECTIVE provider (/health and /config
    // both carry it); the bus event only says {ok}, so the last-seen provider
    // fills in and applyProviderCfg re-renders on a switch.
    let statusProvider = 'subscription';
    let statusOk = null;
    function setStatus(ok) {
      statusOk = ok;
      val.status.textContent =
        ok === true
          ? 'online — on ' + (statusProvider === 'api' ? 'API key' : 'subscription')
          : ok === false ? 'offline'
            : 'connecting…';
    }
    function setProvider(p) {
      if (p !== 'api' && p !== 'subscription') return;
      statusProvider = p;
      setStatus(statusOk);
    }
    const unsub = A.bus.on('backend:status', (d) => {
      if (!disposed) setStatus(d ? d.ok : null);
    });
    A.backend.health()
      .then((h) => {
        if (disposed) return;
        if (h) setProvider(h.provider);
        setStatus(!!(h && (h.ok === true || h.status === 'ok')));
      })
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
          applyProviderCfg(cfg);
          applyModelCfg(cfg);
        })
        .catch(() => {
          if (disposed) return;
          ['max_turns', 'scheduler', 'jobs_file', 'auth_mode', 'token']
            .forEach((k) => { val[k].textContent = 'unavailable'; });
          degradeProviderCard();
          degradeModelCtl();
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
