'use strict';

/* Atelier feature module — customizable widgets
   =============================================================================
   A self-contained WIDGET SYSTEM built only against window.Atelier (core.js).

   What it adds
   ------------
   • Registers 5 built-in widget types (metric, status, chart, list, clock) via
     Atelier.registerWidget — so the palette / customization modules pick them up
     too (they read the Atelier.widgets registry).
   • Double-clicking EMPTY canvas (Atelier.canvas.onDoubleClick) opens a compact
     WIDGET PICKER at the click point. Picking a type places it as a movable +
     resizable card via Atelier.canvas.addCard at that world position.
   • A floating "+ widget" button (injected onto the page) opens the same picker
     and spawns near the viewport center.
   • Every widget card has a ⚙ gear that opens a live config form built from the
     type's `fields`; editing title + settings re-renders the widget in place.
   • Positions, sizes and configs persist via Atelier.store under the key
     "atelier.widgets", restored by an idempotent restoreFromStore() at load
     AND on bus 'boards:switched' (round 14: boards.js switches boards in
     place — canvas.removeAllCards() fires 'card:removed' per widget card,
     which stops timers/pollers + clears the instance map below, then the
     target board's store keys land and 'boards:switched' re-mounts them).
     Nothing to flush on 'boards:will-switch': every persist() call site here
     (spawn, drag mouseup, cards:rearranged, card:removed, config save) writes
     localStorage synchronously — no debounce timer exists in this module.
     Will-switch DOES close any open widget config panel (real switches only;
     reason:'export' is exempt): its Save closure targets a card the switch
     destroys, and saving afterwards would re-mount a live poller on a
     detached body (the old reload wiped panels for free).
   • LIVE DATA BINDINGS — metric / status / chart / list each gain a
     "Data source" select ('' Static, metrics, runs, jobs, notifications,
     health) + a "Field path" dot-path text field. A shared mount polls the
     backend every 15s (immediate first tick) via window.atelier.get, with a
     plain fetch('http://127.0.0.1:8765'+path) fallback for browser testing,
     and updates the already-rendered DOM in place. Server down → last values
     stay (a subtle .wgt-stale dim marks staleness). Every external string
     lands in the DOM via textContent — never innerHTML.

   Boundaries (per the module contract)
   ------------------------------------
   • Touches ONLY window.Atelier + standard DOM. Does NOT edit index.html,
     core.js, styles.css, or any sibling module.
   • All CSS is injected from the <style> this module creates (warm palette via
     the :root CSS vars already defined in styles.css: --panel/--accent/--ink…).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or serve the folder and open index.html).
   2. Double-click an EMPTY part of the canvas → the "Add widget" picker opens
      at the cursor. Click "Metric" → a metric widget card appears there.
   3. Click the card's ⚙ gear → a config panel opens. Change the Title to
      "Revenue", Value to "42", Unit to "k", tick "Accent color" → Save.
      The card's title bar + big number update live.
   4. Drag the card by its title bar and resize it from the bottom-right handle.
   5. Reload the app (Cmd-R). The Revenue/42k widget reappears at the same spot
      and size with the same config → persistence verified.
   6. Click the floating "+ widget" button (top-right) → the picker opens; add a
      "Clock" → it ticks every second. Add "Chart", "Status", "List" to taste.
   7. LIVE DATA — with the backend running, gear a Metric widget → set
      "Data source" = metrics, "Field path" = runs.today → Save. The big
      number becomes the backend's runs-today count within a second and
      refreshes every 15s. Kill the backend → the number stays, the widget
      dims (.wgt-stale); restart → it recovers on the next tick.
   8. Status widget → source = health, Field path blank (defaults to 'ok') →
      green OK pill while up, red Down when the poll flips. Chart → source =
      runs → bars of latency_ms per run (Field path overrides the per-run
      key, e.g. tokens). Checklist → source = jobs → "name — schedule" rows;
      source = notifications → "name: error" rows.
   9. BOARDS — create a second board in the sidebar and switch to it: the
      widgets from steps 2–6 disappear IN PLACE (no reload) and the new board
      is empty. Add a Clock there, switch back → the original widgets return
      at their spots; the clock stays on board 2. Switch with a widget config
      panel open → the panel closes with the switch. No orphan ticking: after
      a switch, `AtelierWidgets.instances.size` matches the visible widget
      cards and removed clocks/pollers stop (watch the Network/console).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   On load, a console.assert verifies all 5 types registered (see bottom). A
   scriptable hook is exposed as window.AtelierWidgets for headless testing:
     AtelierWidgets.spawn('metric', { title:'X', value:'9' })  // returns handle
     AtelierWidgets.instances                                   // Map of live widgets
     AtelierWidgets.restoreFromStore()                          // idempotent re-mount
     localStorage['atelier:atelier.widgets']                    // persisted state
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function' || !A.canvas || !A.store) {
    console.warn('[widgets] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.widgets';

  // ── tiny DOM helper ────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── inject module CSS (warm palette via the existing :root vars) ───────────
  (function injectStyles() {
    if (document.getElementById('atelier-widgets-styles')) return;
    const css = `
      /* widget cards reuse .card / .card-bar; these tune the body + affordances */
      .widget-card .wgt-gear {
        margin-left: auto; border: none; background: transparent; cursor: pointer;
        color: var(--ink-dim); font-size: 14px; line-height: 1; padding: 2px 4px;
        border-radius: 6px;
      }
      .widget-card .wgt-gear:hover { background: rgba(60,48,34,0.08); color: var(--ink-mid); }
      .widget-card .card-x { margin-left: 4px; }
      .wgt-body { display: flex; flex-direction: column; }
      .wgt { flex: 1; min-height: 0; display: flex; flex-direction: column;
        justify-content: center; }

      /* metric */
      .wgt-metric { justify-content: center; }
      .wgt-num { font-size: 34px; font-weight: 700; color: var(--ink);
        letter-spacing: -0.02em; line-height: 1.05; }
      .wgt-num.accent { color: var(--accent); }
      .wgt-lab { font-size: 12px; color: var(--ink-dim); margin-top: 4px; }

      /* status */
      .wgt-status { justify-content: center; }
      .wgt-pill { display: inline-flex; align-items: center; gap: 8px;
        align-self: flex-start; padding: 6px 12px; border-radius: 20px;
        font-size: 13px; font-weight: 600; border: 1px solid var(--border-soft); }
      .wgt-pill-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-dim); }
      .wgt-pill.state-ok  { background: rgba(63,166,106,0.12); color: var(--ok); }
      .wgt-pill.state-ok  .wgt-pill-dot { background: var(--ok); }
      .wgt-pill.state-warn { background: rgba(200,140,40,0.14); color: #b9822a; }
      .wgt-pill.state-warn .wgt-pill-dot { background: #c8922e; }
      .wgt-pill.state-bad { background: var(--accent-soft); color: var(--accent); }
      .wgt-pill.state-bad .wgt-pill-dot { background: var(--accent); }

      /* chart */
      .wgt-chart { justify-content: flex-end; }
      .wgt-bars { display: flex; align-items: flex-end; gap: 4px; height: 100%;
        min-height: 44px; }
      .wgt-bars i { flex: 1; min-width: 4px; background: var(--accent);
        border-radius: 3px 3px 0 0; opacity: 0.85; }

      /* list */
      .wgt-list { justify-content: flex-start; gap: 7px; overflow: auto; }
      .wgt-check { display: flex; align-items: center; gap: 9px; font-size: 13.5px;
        color: var(--ink); cursor: pointer; }
      .wgt-check input { accent-color: var(--accent); width: 15px; height: 15px; }
      .wgt-check input:checked + span { color: var(--ink-dim); text-decoration: line-through; }

      /* clock */
      .wgt-clock { align-items: center; justify-content: center; text-align: center; }
      .wgt-time { font-size: 30px; font-weight: 700; color: var(--ink);
        font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
      .wgt-zone { font-size: 11.5px; color: var(--ink-dim); margin-top: 4px; }

      .wgt-empty { color: var(--ink-dim); font-size: 12.5px; }

      /* live-bound widget whose last poll failed — keep values, just dim */
      .wgt.wgt-stale { opacity: 0.55; transition: opacity .3s ease; }

      /* widget picker */
      .wgt-picker {
        position: fixed; z-index: 9500; min-width: 180px; background: var(--panel);
        border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
        padding: 6px; display: flex; flex-direction: column; gap: 2px;
      }
      .wgt-picker-head { font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; color: var(--ink-dim); padding: 6px 8px 4px; }
      .wgt-picker-item {
        display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
        border: none; background: transparent; cursor: pointer; padding: 8px 10px;
        border-radius: 8px; color: var(--ink); font: inherit; font-size: 13.5px;
      }
      .wgt-picker-item:hover { background: var(--active); }
      .wgt-pick-ic { width: 20px; text-align: center; font-size: 15px; }

      /* "+ widget" button */
      .wgt-add-btn {
        position: fixed; top: 64px; right: 24px; z-index: 8000;
        display: inline-flex; align-items: center; gap: 6px;
        background: var(--accent); color: #fff; border: none; border-radius: 10px;
        padding: 8px 13px; font: inherit; font-size: 13px; font-weight: 600;
        cursor: pointer; box-shadow: var(--shadow-sm);
      }
      .wgt-add-btn:hover { background: var(--accent-2); }

      /* config form (rendered inside Atelier.ui.openPanel) */
      .wgt-form { display: flex; flex-direction: column; gap: 12px; min-width: 260px; }
      .wgt-field { display: flex; flex-direction: column; gap: 5px; }
      .wgt-field-label { font-size: 12px; font-weight: 600; color: var(--ink-mid); }
      .wgt-field-bool { flex-direction: row; align-items: center; gap: 9px; }
      .wgt-field-bool .wgt-field-label { order: 2; }
      .wgt-input {
        border: 1px solid var(--border); border-radius: 9px; padding: 8px 11px;
        font: inherit; font-size: 13.5px; color: var(--ink); background: #faf7f1;
        outline: none;
      }
      .wgt-input:focus { border-color: var(--accent); }
      textarea.wgt-input { resize: vertical; min-height: 64px; }
      input[type="checkbox"].wgt-input { width: 16px; height: 16px; accent-color: var(--accent); }
      .wgt-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      .wgt-btn {
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 9px; padding: 7px 14px; font: inherit; font-size: 13px;
        font-weight: 600; cursor: pointer;
      }
      .wgt-btn:hover { background: rgba(60,48,34,0.05); }
      .wgt-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .wgt-btn-primary:hover { background: var(--accent-2); }
    `;
    const style = el('style');
    style.id = 'atelier-widgets-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── built-in widget type definitions ──────────────────────────────────────
  // Each def: { label, icon, size, defaultConfig, fields, render(cfg)->el, mount? }
  // `mount(renderedEl, cfg) -> cleanupFn?` runs after render (used for the live
  // clock); extra keys (size/mount) are stored verbatim by registerWidget.
  const TITLE_FIELD = { name: 'title', label: 'Title', type: 'text' };

  // ── live data bindings (metric / status / chart / list) ────────────────────
  // Contract fallback helper: preload bridge in the app, plain fetch in a
  // browser tab (for manual testing without Electron).
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  const SOURCE_FIELD = {
    name: 'source', label: 'Data source', type: 'select',
    options: [
      { value: '', label: 'Static' },
      { value: 'metrics', label: 'metrics' },
      { value: 'runs', label: 'runs' },
      { value: 'jobs', label: 'jobs' },
      { value: 'notifications', label: 'notifications' },
      { value: 'health', label: 'health' },
    ],
  };
  const FIELD_FIELD = { name: 'field', label: 'Field path', type: 'text' };

  // dot-path pluck: pluck({runs:{today:3}}, 'runs.today') -> 3; '' -> obj
  function pluck(obj, path) {
    if (!path) return obj;
    return String(path).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
  }

  // Shared bar builder — the ONLY place chart bars are built, so the static
  // render() path and the live poll path cannot drift.
  function buildBars(barsEl, nums) {
    barsEl.textContent = '';
    const max = Math.max.apply(null, nums.concat(1));
    nums.forEach((n) => {
      const b = el('i');
      b.style.height = Math.max(4, (Math.max(0, n) / max) * 100) + '%';
      b.title = String(n);
      barsEl.appendChild(b);
    });
  }

  // Shared list-row builder — same single-source rule as buildBars.
  function buildListRows(container, items, emptyText) {
    container.textContent = '';
    if (!items.length) { container.appendChild(el('div', 'wgt-empty', emptyText)); return; }
    items.forEach((it) => {
      const row = el('label', 'wgt-check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      row.append(cb, el('span', null, it));
      container.appendChild(row);
    });
  }

  // chart: data.runs rows (or a plucked array) -> last values of
  // Number(r[field || 'latency_ms']).
  // ponytail: `field` doubles as pluck-path OR per-row key; nested per-row
  // paths (e.g. 'runs.meta.ms') need a second config field later.
  function chartValues(cfg, data) {
    if (data == null) return null;
    const rows = Array.isArray(data.runs) ? data.runs : pluck(data, cfg.field);
    if (!Array.isArray(rows)) return null;
    const key = cfg.field || 'latency_ms';
    return rows.slice(-20)
      .map((r) => (r && typeof r === 'object') ? Number(r[key]) : Number(r))
      .filter((n) => !isNaN(n));
  }

  // list: jobs -> "name — schedule", notifications -> "name: error",
  // otherwise a plucked array (objects fall back to .name / JSON).
  function listRows(cfg, data) {
    if (data == null) return null;
    if (!cfg.field) {
      if (cfg.source === 'jobs' && Array.isArray(data.jobs)) {
        return data.jobs.map((j) => String(j.name || '?') + ' — ' + String(j.schedule || ''));
      }
      if (cfg.source === 'notifications' && Array.isArray(data.notifications)) {
        return data.notifications.map((n) => String(n.name || '?') + (n.error ? ': ' + String(n.error) : ''));
      }
    }
    const arr = pluck(data, cfg.field);
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => (x && typeof x === 'object')
      ? (x.name != null ? String(x.name) : JSON.stringify(x))
      : String(x));
  }

  // Per-type in-place DOM updaters. Each receives the element render()
  // returned (same root the clock's mount gets). A null/absent value means
  // "keep last values" — the poll never writes error states into the DOM.
  const LIVE_UPDATERS = {
    metric(root, cfg, data) {
      const v = pluck(data, cfg.field);
      if (v == null || typeof v === 'object') return;
      const num = root.querySelector('.wgt-num');
      if (num) num.textContent = String(v) + (cfg.unit ? ' ' + cfg.unit : '');
    },
    status(root, cfg, data) {
      const val = pluck(data, cfg.field || 'ok');
      if (val == null) return;
      const ok = !!val;
      const pill = root.querySelector('.wgt-pill');
      if (!pill) return;
      pill.classList.remove('state-ok', 'state-warn', 'state-bad');
      pill.classList.add(ok ? 'state-ok' : 'state-bad');
      const txt = pill.querySelector('.wgt-pill-txt');
      if (txt) txt.textContent = ok ? 'OK' : 'Down';
    },
    chart(root, cfg, data) {
      const nums = chartValues(cfg, data);
      if (!nums || !nums.length) return;
      let bars = root.querySelector('.wgt-bars');
      if (!bars) { root.textContent = ''; bars = el('div', 'wgt-bars'); root.appendChild(bars); }
      buildBars(bars, nums);
    },
    list(root, cfg, data) {
      const rows = listRows(cfg, data);
      if (!rows) return;
      buildListRows(root, rows, 'No rows yet.');
    },
  };

  // Shared polling mount. Returns null for static widgets (cfg.source empty)
  // so render()'s output stands untouched; otherwise polls every 15s with an
  // immediate first tick and updates in place. Failures keep last values and
  // toggle a subtle .wgt-stale dim. applyConfig re-runs this on every save
  // (same lifecycle as the clock's mount).
  // ponytail: one interval per widget; N widgets on one source = N fetches —
  // a shared deduping poller is the upgrade path.
  function liveMount(type, root, cfg) {
    if (!cfg || !cfg.source) return null;
    const update = LIVE_UPDATERS[type];
    if (!update) return null;
    let stopped = false;
    const tick = () => {
      api('/' + cfg.source)
        .then((data) => {
          if (stopped || data == null) return;
          try { update(root, cfg, data); } catch (e) { console.error('[widgets] live update', e); }
          root.classList.remove('wgt-stale');
        })
        .catch(() => { if (!stopped) root.classList.add('wgt-stale'); });
    };
    tick();
    const iv = setInterval(tick, 15000);
    return () => { stopped = true; clearInterval(iv); };
  }

  const BUILTINS = {
    metric: {
      label: 'Metric', icon: '▧', size: { w: 210, h: 150 },
      defaultConfig: { title: 'Deliverables', value: '10', unit: '', accent: false, source: '', field: '' },
      fields: [
        TITLE_FIELD,
        { name: 'value', label: 'Value', type: 'text' },
        { name: 'unit', label: 'Unit', type: 'text' },
        { name: 'accent', label: 'Accent color', type: 'bool' },
        SOURCE_FIELD,
        FIELD_FIELD,
      ],
      render(c) {
        const w = el('div', 'wgt wgt-metric');
        const num = el('div', 'wgt-num' + (c.accent ? ' accent' : ''));
        num.textContent = String(c.value ?? '') + (c.unit ? ' ' + c.unit : '');
        w.append(num, el('div', 'wgt-lab', c.title || ''));
        return w;
      },
      mount(root, c) { return liveMount('metric', root, c); },
    },

    status: {
      label: 'Status', icon: '◉', size: { w: 220, h: 130 },
      defaultConfig: { title: 'Backend', label: 'Operational', state: 'ok', source: '', field: '' },
      fields: [
        TITLE_FIELD,
        { name: 'label', label: 'Text', type: 'text' },
        {
          name: 'state', label: 'State', type: 'select',
          options: [
            { value: 'ok', label: 'OK' },
            { value: 'warn', label: 'Warning' },
            { value: 'bad', label: 'Critical' },
          ],
        },
        SOURCE_FIELD,
        FIELD_FIELD,
      ],
      render(c) {
        const w = el('div', 'wgt wgt-status');
        const state = ['ok', 'warn', 'bad'].includes(c.state) ? c.state : 'ok';
        const pill = el('span', 'wgt-pill state-' + state);
        pill.append(el('span', 'wgt-pill-dot'), el('span', 'wgt-pill-txt', c.label || ''));
        w.append(pill);
        return w;
      },
      mount(root, c) { return liveMount('status', root, c); },
    },

    chart: {
      label: 'Chart', icon: '▤', size: { w: 260, h: 170 },
      defaultConfig: { title: 'Weekly', values: '4, 9, 6, 12, 7, 14, 10', source: '', field: '' },
      fields: [
        TITLE_FIELD,
        { name: 'values', label: 'Values (comma-separated)', type: 'text' },
        SOURCE_FIELD,
        FIELD_FIELD,
      ],
      render(c) {
        const w = el('div', 'wgt wgt-chart');
        const nums = String(c.values || '')
          .split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
        if (!nums.length) { w.append(el('div', 'wgt-empty', 'No data — add comma-separated numbers.')); return w; }
        const bars = el('div', 'wgt-bars');
        buildBars(bars, nums);
        w.append(bars);
        return w;
      },
      mount(root, c) { return liveMount('chart', root, c); },
    },

    list: {
      label: 'Checklist', icon: '☑', size: { w: 240, h: 210 },
      defaultConfig: { title: 'To do', items: 'Draft brief\nReview copy\nShip it', source: '', field: '' },
      fields: [
        TITLE_FIELD,
        { name: 'items', label: 'Items (one per line)', type: 'textarea' },
        SOURCE_FIELD,
        FIELD_FIELD,
      ],
      render(c) {
        const w = el('div', 'wgt wgt-list');
        const items = String(c.items || '').split('\n').map((s) => s.trim()).filter(Boolean);
        buildListRows(w, items, 'No items — add one per line.');
        return w;
      },
      mount(root, c) { return liveMount('list', root, c); },
    },

    clock: {
      label: 'Clock', icon: '🕐', size: { w: 210, h: 140 },
      defaultConfig: { title: 'Local time', tz: '' },
      fields: [
        TITLE_FIELD,
        { name: 'tz', label: 'Time zone (IANA, blank = local)', type: 'text' },
      ],
      render(c) {
        const w = el('div', 'wgt wgt-clock');
        w.append(el('div', 'wgt-time', '--:--:--'), el('div', 'wgt-zone', c.tz || 'local'));
        return w;
      },
      mount(root, c) {
        const timeEl = root.querySelector('.wgt-time');
        const tick = () => {
          let text;
          try {
            const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
            if (c.tz) opts.timeZone = c.tz;
            text = new Intl.DateTimeFormat([], opts).format(new Date());
          } catch (_) {
            text = new Date().toLocaleTimeString();
          }
          if (timeEl) timeEl.textContent = text;
        };
        tick();
        const iv = setInterval(tick, 1000);
        return () => clearInterval(iv);
      },
    },
  };

  Object.keys(BUILTINS).forEach((type) => A.registerWidget(type, BUILTINS[type]));

  // ── live instance registry ─────────────────────────────────────────────────
  // id -> { id, type, config, handle, bodyEl, cleanup }
  const instances = new Map();
  let restoring = false;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      arr.push({
        instanceId: inst.id,
        type: inst.type,
        config: inst.config,
        rect: inst.handle.getRect(),
      });
    });
    A.store.set(STORE_KEY, arr);
  }

  function renderBody(def, cfg, bodyEl) {
    bodyEl.innerHTML = '';
    let rendered;
    try { rendered = def.render(cfg); } catch (e) { console.error('[widgets] render', e); }
    if (!rendered) rendered = el('div', 'wgt-empty', 'Nothing to show.');
    bodyEl.appendChild(rendered);
    if (typeof def.mount === 'function') {
      try { return def.mount(rendered, cfg) || null; }
      catch (e) { console.error('[widgets] mount', e); }
    }
    return null;
  }

  function centerWorld(w, h) {
    const p = A.canvas.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    return { x: p.x - w / 2, y: p.y - h / 2 };
  }

  let dragId = null; // set on mousedown inside a widget card, persisted on mouseup

  function spawnWidget(type, opts = {}) {
    const def = A.widgets.get(type);
    if (!def || typeof def.render !== 'function') {
      console.warn('[widgets] unknown widget type:', type);
      return null;
    }
    const cfg = Object.assign({}, def.defaultConfig || {}, opts.config || {});
    const size = def.size || { w: 240, h: 160 };

    let x, y, w, h;
    if (opts.rect) { x = opts.rect.x; y = opts.rect.y; w = opts.rect.w; h = opts.rect.h; }
    else if (opts.worldPos) { x = opts.worldPos.x; y = opts.worldPos.y; w = size.w; h = size.h; }
    else { const c = centerWorld(size.w, size.h); x = c.x; y = c.y; w = size.w; h = size.h; }

    const id = opts.instanceId || ('w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));

    const card = el('section', 'card widget-card');
    card.dataset.widgetInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'));
    bar.append(el('span', 'card-title', cfg.title || def.label));
    const gear = el('button', 'wgt-gear', '⚙');
    gear.type = 'button';
    gear.title = 'Configure';
    bar.append(gear);
    bar.append(el('span', 'card-x', '×'));
    const body = el('div', 'app-body wgt-body');
    card.append(bar, body);

    const cleanup = renderBody(def, cfg, body);
    const handle = A.canvas.addCard(card, { x, y, w, h, title: cfg.title || def.label });

    const inst = { id, type, config: cfg, handle, bodyEl: body, cleanup };
    instances.set(id, inst);

    // gear: don't let the click start a card-bar drag; open the config form
    gear.addEventListener('mousedown', (e) => e.stopPropagation());
    gear.addEventListener('click', (e) => { e.stopPropagation(); openConfigForm(id); });

    // mark this instance dirty on any pointer interaction (drag or resize)
    card.addEventListener('mousedown', () => { dragId = id; }, true);

    if (!restoring) persist();
    return handle;
  }

  // persist rect once a drag/resize gesture ends
  window.addEventListener('mouseup', () => {
    if (dragId && instances.has(dragId)) persist();
    dragId = null;
  });

  // core's tidy() (zoombar ✦) moves every card without any drag gesture —
  // flush widget rects when it announces the rearrange.
  A.bus.on('cards:rearranged', () => persist());

  // core wires .card-x → handle.remove() → emits card:removed; clean up here
  A.bus.on('card:removed', (d) => {
    const node = d && d.el;
    const rid = node && node.dataset && node.dataset.widgetInstance;
    if (!rid || !instances.has(rid)) return;
    const inst = instances.get(rid);
    if (inst.cleanup) { try { inst.cleanup(); } catch (_) {} }
    instances.delete(rid);
    persist();
  });

  function applyConfig(inst, newCfg) {
    const def = A.widgets.get(inst.type);
    if (!def) return;
    // The card can be removed while its config panel is open (board switch,
    // Delete key, close ×). Its 'card:removed' already ran cleanup; saving now
    // would re-mount a poller onto the detached body that nothing ever stops.
    if (!instances.has(inst.id)) return;
    if (inst.cleanup) { try { inst.cleanup(); } catch (_) {} inst.cleanup = null; }
    inst.config = newCfg;
    inst.cleanup = renderBody(def, newCfg, inst.bodyEl);
    const t = inst.handle.el.querySelector('.card-title');
    if (t) t.textContent = newCfg.title || def.label;
    persist();
  }

  // ── config form (built from def.fields, shown in a floating panel) ─────────
  function buildForm(def, config, onSave, onCancel) {
    const form = el('form', 'wgt-form');
    const inputs = {};
    (def.fields || []).forEach((f) => {
      const row = el('label', 'wgt-field');
      const label = el('span', 'wgt-field-label', f.label || f.name);
      let input;
      if (f.type === 'bool') {
        row.classList.add('wgt-field-bool');
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!config[f.name];
      } else if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach((o) => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label || o.value;
          if (String(config[f.name]) === String(o.value)) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = config[f.name] == null ? '' : String(config[f.name]);
      } else {
        input = document.createElement('input');
        input.type = f.type === 'number' ? 'number' : 'text';
        input.value = config[f.name] == null ? '' : String(config[f.name]);
      }
      input.className = 'wgt-input';
      inputs[f.name] = { input, type: f.type };
      row.append(label, input);
      form.appendChild(row);
    });

    const actions = el('div', 'wgt-form-actions');
    const cancel = el('button', 'wgt-btn', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'wgt-btn wgt-btn-primary', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      Object.keys(inputs).forEach((k) => {
        const { input, type } = inputs[k];
        if (type === 'bool') out[k] = input.checked;
        else if (type === 'number') out[k] = input.value === '' ? '' : Number(input.value);
        else out[k] = input.value;
      });
      onSave(out);
    });
    cancel.addEventListener('click', onCancel);
    return form;
  }

  // Open config panels, tracked module-level so a board switch can close them
  // (core's panel.close() is panel.remove() — safe to call twice).
  const cfgPanels = new Set();

  function openConfigForm(id) {
    const inst = instances.get(id);
    if (!inst) return;
    const def = A.widgets.get(inst.type);
    if (!def) return;
    let panel;
    const dismiss = () => {
      if (!panel) return;
      try { panel.close(); } catch (_) {}
      cfgPanels.delete(panel);
      panel = null;
    };
    const form = buildForm(
      def, inst.config,
      (values) => {
        applyConfig(inst, Object.assign({}, inst.config, values));
        A.ui.toast('Widget updated');
        dismiss();
      },
      dismiss
    );
    panel = A.ui.openPanel('Configure · ' + (def.label || inst.type), form);
    cfgPanels.add(panel);
  }

  // ── widget picker (compact floating menu) ──────────────────────────────────
  let pickerEl = null;
  function closePicker() {
    if (!pickerEl) return;
    pickerEl.remove();
    pickerEl = null;
    document.removeEventListener('mousedown', onPickerOutside, true);
    document.removeEventListener('keydown', onPickerKey, true);
  }
  function onPickerOutside(e) { if (pickerEl && !pickerEl.contains(e.target)) closePicker(); }
  function onPickerKey(e) {
    if (e.key !== 'Escape') return;
    // Consume the key: core's window keydown bails on e.defaultPrevented, so
    // one Escape closes ONLY the picker, not the topmost panel behind it.
    e.preventDefault();
    e.stopPropagation();
    closePicker();
  }

  function openPicker(clientX, clientY, worldPos) {
    closePicker();
    const menu = el('div', 'wgt-picker');
    menu.append(el('div', 'wgt-picker-head', 'Add widget'));
    A.widgets.forEach((def, type) => {
      const item = el('button', 'wgt-picker-item');
      item.type = 'button';
      item.append(el('span', 'wgt-pick-ic', def.icon || '▧'));
      item.append(el('span', null, def.label || type));
      item.addEventListener('click', () => {
        spawnWidget(type, worldPos ? { worldPos } : {});
        closePicker();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    pickerEl = menu;

    // clamp within the viewport
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 220;
    let x = clientX, y = clientY;
    if (x + mw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mw - 8);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // defer so the opening click/dblclick doesn't immediately close it
    setTimeout(() => {
      document.addEventListener('mousedown', onPickerOutside, true);
      document.addEventListener('keydown', onPickerKey, true);
    }, 0);
  }

  // double-click empty canvas → picker at cursor, spawning at that world point
  A.canvas.onDoubleClick((wx, wy, e) => {
    openPicker(e.clientX, e.clientY, { x: wx, y: wy });
  });

  // floating "+ widget" affordance → picker near the button, spawn at center
  (function addWidgetButton() {
    const btn = el('button', 'wgt-add-btn', '+ widget');
    btn.type = 'button';
    btn.title = 'Add a widget';
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect();
      openPicker(r.left, r.bottom + 6, null);
    });
    document.body.appendChild(btn);
  })();

  // ── restore persisted widgets (load + in-place board switch) ───────────────
  // Idempotent: a record whose instanceId is already live is skipped, so a
  // stray double 'boards:switched' cannot duplicate cards. At load the map is
  // empty and every record spawns; on a board switch, core's removeAllCards
  // already fired 'card:removed' per widget card (clearing the map + stopping
  // timers/pollers via the handler above), and boards.js has swapped in the
  // TARGET board's store keys before emitting — so this re-mounts the target's
  // records against a clean slate.
  function restoreFromStore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    restoring = true;
    try {
      saved.forEach((rec) => {
        if (!rec || !rec.type || !A.widgets.has(rec.type)) return;
        if (rec.instanceId && instances.has(rec.instanceId)) return; // already live
        spawnWidget(rec.type, { config: rec.config, rect: rec.rect, instanceId: rec.instanceId });
      });
    } finally {
      restoring = false;
    }
  }
  restoreFromStore();

  // Externally registered widget types (the Phase B modules) load AFTER this
  // file, so the restore pass above skips their persisted records — and any
  // later persist() rebuilds the store from live instances only, silently
  // erasing the skipped records. core.js emits 'widget:registered' on every
  // registerWidget call; re-running the idempotent restore per registration
  // re-mounts those records no matter which module loads last (previously
  // only widget-heartbeat's trailing rescue call happened to cover this, a
  // single point of failure on the orchestrator's script order).
  A.bus.on('widget:registered', () => restoreFromStore());

  // ── in-place board switch (round 14) ───────────────────────────────────────
  // Nothing to flush here: unlike apps.js / customization.js, every persist()
  // in this module is synchronous (spawn, drag mouseup, cards:rearranged,
  // card:removed, config save) — verified, no debounce timer exists. The only
  // will-switch duty is closing open config panels: each Save closure targets
  // a card removeAllCards is about to destroy (see the applyConfig guard).
  // reason:'export' is boards' debounce-flush signal, not a real switch —
  // exporting must not close panels (same check as views.js). Closing a
  // panel is non-destructive, so it is safe here even when the quota gate
  // later aborts the switch.
  A.bus.on('boards:will-switch', (d) => {
    if (d && d.reason === 'export') return;
    cfgPanels.forEach((p) => { try { p.close(); } catch (_) {} });
    cfgPanels.clear();
  });

  // Re-mount from the restored store. The teardown of the outgoing board's
  // widgets already happened per card via 'card:removed'; the sweep below is
  // a safety net for any instance whose card left the DOM without that event.
  // It must NOT persist(): the store now holds the TARGET board's records —
  // writing the (normally empty) map here would erase them.
  A.bus.on('boards:switched', () => {
    instances.forEach((inst, id) => {
      if (inst.handle && inst.handle.el && inst.handle.el.isConnected) return;
      if (inst.cleanup) { try { inst.cleanup(); } catch (_) {} }
      instances.delete(id);
    });
    restoreFromStore();
  });

  // ── scriptable hook for headless testing / the self-check ──────────────────
  window.AtelierWidgets = {
    spawn: (type, config, worldPos) => spawnWidget(type, worldPos ? { config, worldPos } : { config }),
    openPicker,
    restoreFromStore,
    instances,
    STORE_KEY,
  };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const required = ['metric', 'status', 'chart', 'list', 'clock'];
    const missing = required.filter((t) => !A.widgets.has(t));
    console.assert(missing.length === 0, '[widgets] MISSING widget types:', missing);
    if (!missing.length) {
      console.log('[widgets] ready — 5 widget types registered; double-click the canvas or use "+ widget".');
    }
  })();
})();
