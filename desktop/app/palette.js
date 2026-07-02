'use strict';

/* ===========================================================================
   Atelier feature module — palette   (app/palette.js)

   A ⌘K / Ctrl+K command palette: a centered overlay with a search input and a
   filtered, keyboard-driven list of commands. Also wires the existing topbar
   `.search` input so focusing / typing there opens the palette.

   Built ONLY against window.Atelier. Injects its own CSS via <style>. Does NOT
   edit index.html, core.js, styles.css, or any other module.

   ── Data-driven ────────────────────────────────────────────────────────────
   Commands are plain objects: { id, label, run(), icon?, section?, keywords? }.
   Other modules extend the palette by emitting on the bus:
       Atelier.bus.emit('palette:add', { id, label, run, icon?, section?, keywords? });
   The built-in commands emit the bus events the rest of the ecosystem listens
   for (widget:pick, app:spawn, canvas:toggleGrid, theme:set, …). See
   PALETTE_DIRECT_ACTIONS below for how built-in fallbacks are wired.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser).
   2. Press ⌘K (macOS) or Ctrl+K — the palette overlay opens, input focused.
   3. Type "note" — the list filters to "Add app: Note"; press Enter — a Note
      card spawns near the canvas center. (Self-check for the spec.)
   4. Press ⌘K again, use ↓/↑ to move the highlight, Enter to run, Esc to close.
   5. Click the topbar search box (top center) — the palette opens too.
   6. Run "Toggle grid" — the dotted grid disappears / reappears. Run
      "Theme: Slate" then "Theme: Cream (default)" — palette + canvas retint and
      restore. DevTools console shows "[palette] ready — self-check passed."
   7. DevTools console: `window.Atelier.palette.open()` — the palette overlay
      opens, input focused. `window.Atelier.palette.close()` — it closes.
   8. `typeof window.Atelier.palette.toggle` is "function".
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || typeof A.bus.on !== 'function' || !A.ui) {
    console.warn('[palette] Atelier core not available — skipping.');
    return;
  }

  // When true, built-in commands perform their concrete action directly (via
  // window.Atelier helpers) in addition to emitting the documented bus event,
  // so the palette is fully functional on its own today. When dedicated
  // apps/widgets/customization/settings modules start LISTENING for these
  // events and performing the action themselves, flip this to false (one line)
  // to make the palette emit-only and avoid double-handling.
  const PALETTE_DIRECT_ACTIONS = true;

  // ── themes (opt-in; default "cream" clears all overrides so the shipped warm
  //    look is preserved unless the user explicitly picks another) ───────────
  const THEMES = [
    { name: 'cream', label: 'Cream (default)', vars: null },
    {
      name: 'slate', label: 'Slate',
      vars: {
        '--canvas': '#e7e9ee', '--sidebar': '#eef0f4', '--topbar': '#e9ebf0',
        '--panel': '#ffffff', '--ink': '#2f3440', '--ink-mid': '#5c6472',
        '--ink-dim': '#9aa2b1', '--active': '#dfe7f2', '--accent-soft': '#e2e9f4',
        '--dot': '#c7ccd6',
      },
    },
    {
      name: 'sage', label: 'Sage',
      vars: {
        '--canvas': '#eaeee6', '--sidebar': '#f0f3ea', '--topbar': '#edf0e7',
        '--panel': '#ffffff', '--ink': '#333a30', '--ink-mid': '#5f6a56',
        '--ink-dim': '#9aa38e', '--active': '#e0ead0', '--accent-soft': '#e6ecdb',
        '--dot': '#cbd2bf',
      },
    },
  ];

  function applyTheme(name) {
    const t = THEMES.find((x) => x.name === name) || THEMES[0];
    const root = document.documentElement;
    // clear any previously applied theme vars, then apply the chosen set
    THEMES.forEach((th) => th.vars && Object.keys(th.vars).forEach((k) => root.style.removeProperty(k)));
    if (t.vars) Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    A.store.set('palette:theme', t.name);
  }

  // restore a previously chosen theme (defaults to cream → no visual change)
  applyTheme(A.store.get('palette:theme', 'cream'));

  // ── grid toggle (self-contained: a <body> class + our own CSS override) ────
  function toggleGrid() {
    const on = document.body.classList.toggle('atelier-nogrid');
    A.store.set('palette:nogrid', on);
    A.ui.toast(on ? 'Grid hidden' : 'Grid shown');
  }
  if (A.store.get('palette:nogrid', false)) document.body.classList.add('atelier-nogrid');

  // ── built-in widget picker (fallback for the widget:pick event) ───────────
  function openWidgetPicker() {
    const list = document.createElement('div');
    list.className = 'pal-picker';
    if (!A.widgets || A.widgets.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'pal-picker-empty';
      empty.textContent = 'No widgets registered yet. Feature modules add them via Atelier.registerWidget.';
      list.appendChild(empty);
    } else {
      A.widgets.forEach((def, type) => {
        const b = document.createElement('button');
        b.className = 'pal-picker-item';
        b.innerHTML = '<span class="pal-ic"></span><span class="pal-lbl"></span>';
        b.querySelector('.pal-ic').textContent = (def && def.icon) || '◲';
        b.querySelector('.pal-lbl').textContent = (def && def.label) || type;
        b.addEventListener('click', () => { A.spawnWidget(type); panel.close(); });
        list.appendChild(b);
      });
    }
    const panel = A.ui.openPanel('Add widget', list);
  }

  // ── the command catalog (rebuilt each open so it reflects the registries and
  //    any palette:add extensions) ───────────────────────────────────────────
  const extra = [];            // commands contributed by other modules
  A.bus.on('palette:add', (cmd) => {
    if (!cmd || typeof cmd.run !== 'function' || !cmd.label) return;
    const id = cmd.id || 'ext.' + cmd.label.toLowerCase().replace(/\s+/g, '-');
    const i = extra.findIndex((c) => c.id === id);
    const entry = {
      id, label: cmd.label, run: cmd.run,
      icon: cmd.icon || '›', section: cmd.section || 'More',
      keywords: cmd.keywords || '',
    };
    if (i >= 0) extra[i] = entry; else extra.push(entry);
  });

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function buildCommands() {
    const cmds = [];

    // Add widget…
    cmds.push({
      id: 'widget.pick', label: 'Add widget…', icon: '◲', section: 'Create',
      keywords: 'widget add insert',
      run() { A.bus.emit('widget:pick'); if (PALETTE_DIRECT_ACTIONS) openWidgetPicker(); },
    });

    // Add app: Note / Browser / Workflow / Calendar / History (+ any others)
    A.apps.forEach((def, type) => {
      const name = (def && def.label) || cap(type);
      cmds.push({
        id: 'app.' + type, label: 'Add app: ' + name, icon: (def && def.icon) || '▦',
        section: 'Create', keywords: 'app spawn ' + type,
        run() { A.bus.emit('app:spawn', { type }); if (PALETTE_DIRECT_ACTIONS) A.spawnApp(type); },
      });
    });

    // New session
    cmds.push({
      id: 'session.new', label: 'New session', icon: '✦', section: 'Session',
      keywords: 'session new start reset chat',
      run() { A.bus.emit('session:new'); if (PALETTE_DIRECT_ACTIONS) A.ui.toast('New session'); },
    });

    // Toggle grid
    cmds.push({
      id: 'canvas.grid', label: 'Toggle grid', icon: '⁚', section: 'Canvas',
      keywords: 'grid dots toggle background',
      run() { A.bus.emit('canvas:toggleGrid'); if (PALETTE_DIRECT_ACTIONS) toggleGrid(); },
    });

    // Reset view (no viewport setter on the public API — emit for core/future
    // to handle; toast as immediate feedback)
    cmds.push({
      id: 'canvas.reset', label: 'Reset view', icon: '⤢', section: 'Canvas',
      keywords: 'reset view zoom pan fit center',
      run() { A.bus.emit('canvas:resetView'); if (PALETTE_DIRECT_ACTIONS) A.ui.toast('Reset view'); },
    });

    // Open Settings
    cmds.push({
      id: 'settings.open', label: 'Open Settings', icon: '⚙', section: 'App',
      keywords: 'settings preferences options config',
      run() { A.bus.emit('settings:open'); if (PALETTE_DIRECT_ACTIONS) A.ui.toast('Settings'); },
    });

    // Switch theme
    THEMES.forEach((t) => cmds.push({
      id: 'theme.' + t.name, label: 'Theme: ' + t.label, icon: '◑', section: 'Theme',
      keywords: 'theme color palette skin ' + t.name,
      run() { A.bus.emit('theme:set', { name: t.name }); if (PALETTE_DIRECT_ACTIONS) applyTheme(t.name); },
    }));

    // extension commands from palette:add
    extra.forEach((c) => cmds.push(c));
    return cmds;
  }

  // ── styles (injected here; never in styles.css) ───────────────────────────
  (function injectStyles() {
    const css = `
      .pal-overlay { position: fixed; inset: 0; z-index: 10000;
        background: rgba(40, 30, 20, 0.24); backdrop-filter: blur(2px);
        display: flex; align-items: flex-start; justify-content: center;
        padding-top: 14vh; opacity: 0; transition: opacity .12s ease; }
      .pal-overlay.show { opacity: 1; }
      .pal { width: 560px; max-width: 92vw; background: var(--panel);
        border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow); overflow: hidden; display: flex;
        flex-direction: column; transform: translateY(-6px);
        transition: transform .12s ease; }
      .pal-overlay.show .pal { transform: translateY(0); }
      .pal-search { display: flex; align-items: center; gap: 10px;
        padding: 13px 16px; border-bottom: 1px solid var(--border-soft); }
      .pal-search .pal-ic { color: var(--ink-dim); font-size: 15px; }
      .pal-search input { flex: 1; border: none; outline: none; background: transparent;
        color: var(--ink); font: inherit; font-size: 15px; }
      .pal-search .pal-esc { font-size: 11px; color: var(--ink-dim);
        border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
      .pal-list { max-height: 46vh; overflow: auto; padding: 6px; }
      .pal-sec { font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
        color: var(--ink-dim); padding: 8px 12px 4px; }
      .pal-item { display: flex; align-items: center; gap: 11px; width: 100%;
        text-align: left; border: none; background: transparent; cursor: pointer;
        color: var(--ink); font: inherit; padding: 9px 12px; border-radius: 9px; }
      .pal-item .pal-ic { width: 20px; text-align: center; color: var(--ink-mid); font-size: 14px; }
      .pal-item .pal-lbl { flex: 1; }
      .pal-item.is-active { background: var(--active); }
      .pal-item.is-active .pal-ic { color: var(--accent); }
      .pal-empty { padding: 22px 16px; text-align: center; color: var(--ink-dim); font-size: 13px; }
      .pal-picker { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
      .pal-picker-item { display: flex; align-items: center; gap: 10px; width: 100%;
        text-align: left; border: 1px solid var(--border); background: var(--panel);
        color: var(--ink); font: inherit; padding: 9px 12px; border-radius: 9px; cursor: pointer; }
      .pal-picker-item:hover { background: var(--active); }
      .pal-picker-empty { color: var(--ink-dim); font-size: 13px; line-height: 1.5; }
      /* self-contained grid toggle (overrides the styles.css dotted grid) */
      body.atelier-nogrid .canvas { background-image: none !important; }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-palette-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── overlay DOM (built once, reused) ──────────────────────────────────────
  let overlay, inputEl, listEl;
  let commands = [];      // full catalog for the current open
  let filtered = [];      // currently visible commands
  let selIndex = 0;
  let isOpen = false;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'pal-overlay';
    const box = document.createElement('div');
    box.className = 'pal';
    box.innerHTML =
      '<div class="pal-search"><span class="pal-ic">⌕</span>' +
      '<input type="text" placeholder="Type a command…" spellcheck="false" autocomplete="off" />' +
      '<span class="pal-esc">esc</span></div>' +
      '<div class="pal-list"></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    inputEl = box.querySelector('input');
    listEl = box.querySelector('.pal-list');

    // click outside the box closes
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    inputEl.addEventListener('input', () => { selIndex = 0; render(); });
    inputEl.addEventListener('keydown', onKeydown);
  }

  function score(cmd, q) {
    if (!q) return true;
    const hay = (cmd.label + ' ' + (cmd.keywords || '') + ' ' + (cmd.section || '')).toLowerCase();
    return hay.includes(q);
  }

  function render() {
    const q = (inputEl.value || '').trim().toLowerCase();
    filtered = commands.filter((c) => score(c, q));
    if (selIndex >= filtered.length) selIndex = Math.max(0, filtered.length - 1);

    listEl.innerHTML = '';
    if (filtered.length === 0) {
      const e = document.createElement('div');
      e.className = 'pal-empty';
      e.textContent = 'No matching commands';
      listEl.appendChild(e);
      return;
    }

    let lastSection = null;
    filtered.forEach((cmd, i) => {
      if (cmd.section && cmd.section !== lastSection) {
        lastSection = cmd.section;
        const s = document.createElement('div');
        s.className = 'pal-sec';
        s.textContent = cmd.section;
        listEl.appendChild(s);
      }
      const b = document.createElement('button');
      b.className = 'pal-item' + (i === selIndex ? ' is-active' : '');
      b.innerHTML = '<span class="pal-ic"></span><span class="pal-lbl"></span>';
      b.querySelector('.pal-ic').textContent = cmd.icon || '›';
      b.querySelector('.pal-lbl').textContent = cmd.label;
      b.addEventListener('mousemove', () => { if (selIndex !== i) { selIndex = i; paintActive(); } });
      b.addEventListener('click', () => runAt(i));
      b._palIndex = i;
      listEl.appendChild(b);
    });
    scrollActiveIntoView();
  }

  function paintActive() {
    listEl.querySelectorAll('.pal-item').forEach((el) => {
      el.classList.toggle('is-active', el._palIndex === selIndex);
    });
    scrollActiveIntoView();
  }
  function scrollActiveIntoView() {
    const el = listEl.querySelector('.pal-item.is-active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!filtered.length) return;
    selIndex = (selIndex + delta + filtered.length) % filtered.length;
    paintActive();
  }

  function runAt(i) {
    const cmd = filtered[i];
    if (!cmd) return;
    close();
    try { cmd.run(); }
    catch (err) { console.error('[palette] command failed:', cmd.id, err); A.ui.toast('Command failed'); }
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(selIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function open(prefill) {
    ensureDom();
    commands = buildCommands();
    selIndex = 0;
    isOpen = true;
    inputEl.value = prefill || '';
    render();
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('show'));
    inputEl.focus();
    // if opened from the topbar search, place caret at the end
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }

  function close() {
    if (!overlay || !isOpen) return;
    isOpen = false;
    overlay.classList.remove('show');
    const done = () => { if (!isOpen) overlay.style.display = 'none'; };
    setTimeout(done, 130);
    // return focus to the canvas area (not the topbar input, to avoid reopening)
    if (document.activeElement === inputEl) inputEl.blur();
  }

  function toggle() { isOpen ? close() : open(); }

  // ── public surface: let other modules (e.g. the ▦ Apps dock button in
  //    apps.js) open the palette without re-implementing the ⌘K wiring.
  //    apps.js loads BEFORE this file, so it reads A.palette lazily at click
  //    time and guards it — a 404 of this module simply leaves ▦ Apps inert.
  A.palette = { open, close, toggle };

  // ── ⌘K / Ctrl+K global shortcut ───────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  });

  // ── wire the existing topbar .search input (open on focus / typing) ───────
  (function wireTopbarSearch() {
    const search = document.querySelector('.search input');
    if (!search) return;
    const openFromSearch = (prefill) => {
      // hand off to the palette; the topbar box is only a launcher
      const val = prefill != null ? prefill : '';
      search.blur();
      open(val);
      if (val) search.value = '';
    };
    search.addEventListener('focus', () => { if (!isOpen) openFromSearch(''); });
    search.addEventListener('input', () => {
      const v = search.value;
      search.value = '';
      openFromSearch(v);
    });
  })();

  // ── self-check (assertions + console summary) ─────────────────────────────
  (function selfCheck() {
    const cmds = buildCommands();
    const hasNote = cmds.some((c) => /note/i.test(c.label) && c.section === 'Create');
    const hasWidget = cmds.some((c) => c.id === 'widget.pick');
    const hasThemeEvt = typeof A.bus.emit === 'function';
    const apiOk = !!A.palette
      && typeof A.palette.open === 'function'
      && typeof A.palette.close === 'function'
      && typeof A.palette.toggle === 'function';
    const ok = hasNote && hasWidget && hasThemeEvt && apiOk && THEMES.length >= 1;
    console.assert(hasNote, '[palette] expected an "Add app: Note" command');
    console.assert(hasWidget, '[palette] expected an "Add widget…" command');
    console.assert(apiOk, '[palette] window.Atelier.palette API incomplete:', A.palette);
    if (ok) console.log('[palette] ready — self-check passed (' + cmds.length + ' commands, ⌘K to open).');
    A.bus.emit('palette:ready', { count: cmds.length });
  })();
})();
