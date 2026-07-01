'use strict';

/* ===========================================================================
   Atelier feature module — boards   (app/boards.js)

   Multiple named dashboards ("boards"). The ACTIVE board's state lives in the
   ordinary live 'atelier:*' localStorage keys that every feature module
   already reads/writes; INACTIVE boards exist only as snapshots. Switching
   boards = snapshot the live board-scoped keys, swap in the target's
   snapshot, reload — every module's own boot-restore then re-renders the new
   board for free.

   Data (raw localStorage keys):
     'atelier:boards'            -> [{id, name, createdAt, updatedAt,
                                      previewUpdatedAt}]  (index, no thumbs)
     'atelier:board.<id>.thumb'  -> JPEG data URL (own key; index stays cheap)
     'atelier:board.<id>.state'  -> {rawKey: rawValue} snapshot of the
                                    board-scoped live keys (inactive boards)
     'atelier:lastBoardId'       -> active board id

   Board-scoped = every 'atelier:' key EXCEPT the boards keys above and the
   GLOBAL customization keys (theme/accent/grid — see GLOBAL_KEYS). The
   viewport (inside 'atelier:atelier.layout') stays board-scoped.

   Built ONLY against window.Atelier + the window.atelier preload bridge
   (capturePage). Injects its own CSS. Does NOT edit index.html, core.js,
   styles.css, or any sibling module.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser — thumbnails
      are skipped there, everything else works).
   2. The sidebar "Dashboards" group shows one row, "Main studio", marked
      active (first run adopts your current canvas as that board).
   3. Add a widget or note, drag it somewhere memorable, release the mouse and
      wait ~2s — in Electron the row's thumbnail updates to a real screenshot.
   4. Click "+" in the Dashboards header -> "Board 2" is created and the app
      reloads onto an empty canvas (only the built-in metrics/chat cards).
   5. Click the "Main studio" row -> reload -> your widget/note is back
      exactly where you left it. In DevTools, localStorage now holds
      'atelier:board.<id>.state' for whichever board is NOT active.
   6. Click "⌄" in the Dashboards header -> the "All boards" panel opens:
      cover thumbnails, names, updated dates, a search box that filters by
      name, and Open / Rename / Duplicate / Delete on each card.
   7. Rename Board 2 to "Scratch" (also: double-click the ACTIVE sidebar row
      to rename it). Duplicate it -> "Scratch (copy)" appears with the same
      thumb. Delete "Scratch" -> confirm() -> row disappears; deleting the
      active board lands you on the first remaining board.
   8. ⌘K -> type "board" -> "New board", "All boards" and one
      "Switch board: <name>" per board are in the palette.
   9. Console shows "[boards] ready — …" and no console.assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.store || !A.bus || !A.ui || !A.canvas) {
    console.warn('[boards] Atelier core not available — skipping.');
    return;
  }

  // ── keys ───────────────────────────────────────────────────────────────────
  const INDEX_KEY = 'atelier:boards';
  const LAST_KEY = 'atelier:lastBoardId';
  const BOARD_PREFIX = 'atelier:board.';
  // GLOBAL customization keys (enumerated from the sibling modules):
  //   customization.js -> Atelier.store 'atelier.theme'   (theme + accent + grid)
  //   palette.js       -> Atelier.store 'palette:theme'   (theme)
  //   palette.js       -> Atelier.store 'palette:nogrid'  (grid toggle)
  // The store prefixes each with 'atelier:'. customization.js's other key,
  // 'atelier:atelier.layout' (viewport + built-in card geometry), stays
  // BOARD-SCOPED on purpose — each board keeps its own pan/zoom.
  const GLOBAL_KEYS = [
    'atelier:atelier.theme',
    'atelier:palette:theme',
    'atelier:palette:nogrid',
  ];

  const stateKey = (id) => BOARD_PREFIX + id + '.state';
  const thumbKey = (id) => BOARD_PREFIX + id + '.thumb';

  function isBoardScoped(rawKey) {
    return typeof rawKey === 'string' &&
      rawKey.indexOf('atelier:') === 0 &&
      rawKey !== INDEX_KEY &&
      rawKey !== LAST_KEY &&
      rawKey.indexOf(BOARD_PREFIX) !== 0 &&
      GLOBAL_KEYS.indexOf(rawKey) === -1;
  }

  // ── index helpers ──────────────────────────────────────────────────────────
  function randHex() {
    try {
      const a = new Uint8Array(8);
      crypto.getRandomValues(a);
      return Array.from(a, (b) => ('0' + b.toString(16)).slice(-2)).join('');
    } catch {
      return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
    }
  }

  function readIndex() {
    try {
      const arr = JSON.parse(localStorage.getItem(INDEX_KEY) || 'null');
      if (!Array.isArray(arr)) return [];
      return arr.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string');
    } catch { return []; }
  }

  function writeIndex(idx, opts) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); }
    catch (err) { console.warn('[boards] writeIndex failed', err); }
    if (!opts || !opts.silent) A.bus.emit('boards:changed', { boards: readIndex() });
  }

  function activeId() { return localStorage.getItem(LAST_KEY); }
  function active() {
    const id = activeId();
    return readIndex().find((b) => b.id === id) || null;
  }

  function newEntry(name) {
    const now = Date.now();
    return { id: randHex(), name, createdAt: now, updatedAt: now, previewUpdatedAt: 0 };
  }

  // ── boot / migration ───────────────────────────────────────────────────────
  // First run adopts the current live keys as "Main studio": index + lastBoardId
  // only — no snapshot, no clearing. The active board's state IS the live keys.
  (function boot() {
    let idx = readIndex();
    if (!idx.length) {
      idx = [newEntry('Main studio')];
      writeIndex(idx, { silent: true });
      try { localStorage.setItem(LAST_KEY, idx[0].id); } catch {}
    }
    if (!idx.some((b) => b.id === activeId())) {
      try { localStorage.setItem(LAST_KEY, idx[0].id); } catch {}
    }
  })();

  // ── snapshot machinery ─────────────────────────────────────────────────────
  function collectLiveScoped() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isBoardScoped(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function snapshotLive(boardId) {
    // Returns false when the snapshot write failed (quota) — callers must NOT
    // wipe the live keys in that case or the board's state is lost for good.
    try { localStorage.setItem(stateKey(boardId), JSON.stringify(collectLiveScoped())); }
    catch (err) { console.warn('[boards] snapshot failed', err); return false; }
    const idx = readIndex();
    const b = idx.find((x) => x.id === boardId);
    if (b) { b.updatedAt = Date.now(); writeIndex(idx, { silent: true }); }
    return true;
  }

  function removeLiveScoped() {
    Object.keys(collectLiveScoped()).forEach((k) => localStorage.removeItem(k));
  }

  function restoreSnapshot(boardId) {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(stateKey(boardId)) || 'null'); }
    catch { snap = null; }
    if (!snap || typeof snap !== 'object') return;   // missing snapshot = fresh empty board
    Object.keys(snap).forEach((k) => {
      if (isBoardScoped(k) && typeof snap[k] === 'string') {
        try { localStorage.setItem(k, snap[k]); } catch {}
      }
    });
    // The live keys are now this board's state; drop the consumed snapshot so
    // only INACTIVE boards ever carry one (it is rewritten on switch-away).
    try { localStorage.removeItem(stateKey(boardId)); } catch {}
  }

  // ── thumbnails ─────────────────────────────────────────────────────────────
  // Signature of what's on the canvas; capture only when it changed (or on
  // switch-away, which captures unconditionally).
  let lastSig = null;

  function currentSig() {
    return Array.from(document.querySelectorAll('#content > .card'))
      .map((el) => (el.dataset.cardId || '') + ':' +
        (parseFloat(el.style.left) || 0) + ',' + (parseFloat(el.style.top) || 0))
      .sort().join('|');
  }

  async function captureThumb() {
    if (!(window.atelier && typeof window.atelier.capturePage === 'function')) return null; // plain-browser testing
    const canvasEl = document.getElementById('canvas');
    if (!canvasEl) return null;
    const r = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let dataUrl = null;
    try {
      dataUrl = await window.atelier.capturePage({
        x: Math.round(r.left * dpr),
        y: Math.round(r.top * dpr),
        width: Math.round(r.width * dpr),
        height: Math.round(r.height * dpr),
      });
    } catch { dataUrl = null; }
    lastSig = currentSig();
    if (!dataUrl) return null;                       // capturePage returns null on any failure
    const id = activeId();
    if (!id) return null;
    try { localStorage.setItem(thumbKey(id), dataUrl); }
    catch (err) { console.warn('[boards] thumb store failed', err); return null; }
    const idx = readIndex();
    const b = idx.find((x) => x.id === id);
    if (b) { b.previewUpdatedAt = Date.now(); writeIndex(idx); }
    return dataUrl;
  }

  let thumbTimer = null;
  function scheduleThumb() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      if (currentSig() !== lastSig) captureThumb();
    }, 1800);
  }
  A.bus.on('card:added', scheduleThumb);
  A.bus.on('card:removed', scheduleThumb);
  window.addEventListener('mouseup', scheduleThumb);

  // ── board operations ───────────────────────────────────────────────────────
  async function switchTo(id) {
    if (id === activeId()) return;
    if (!readIndex().some((b) => b.id === id)) return;
    // Flush the sibling modules' debounced saves BEFORE snapshotting, or a
    // drag/edit inside the debounce window is missing from the snapshot (and a
    // timer firing after removeLiveScoped would leak it into the next board).
    // apps.js / widgets.js / customization.js listen and persist+disarm.
    try { A.bus.emit('boards:will-switch', { to: id }); } catch {}
    try { await captureThumb(); } catch {}
    if (!snapshotLive(activeId())) {
      A.ui.toast('Board switch failed — storage is full');
      return;
    }
    removeLiveScoped();
    restoreSnapshot(id);
    try { localStorage.setItem(LAST_KEY, id); } catch {}
    // ponytail: reload-based switch — every module's boot-restore does the
    // re-render for free; in-place switching is the upgrade path.
    location.reload();
  }

  async function create(name) {
    const idx = readIndex();
    const nm = (name != null && String(name).trim()) || ('Board ' + (idx.length + 1));
    const entry = newEntry(nm);
    idx.push(entry);
    writeIndex(idx);
    await switchTo(entry.id);                        // new board has no snapshot = fresh empty canvas
    return entry.id;
  }

  function rename(id, name) {
    const nm = name == null ? '' : String(name).trim();
    if (!nm) return;
    const idx = readIndex();
    const b = idx.find((x) => x.id === id);
    if (!b || b.name === nm) return;
    b.name = nm;
    b.updatedAt = Date.now();
    writeIndex(idx);
  }

  function promptRename(id) {
    const b = readIndex().find((x) => x.id === id);
    if (!b) return;
    const nm = window.prompt('Rename board', b.name); // ponytail: window.prompt v1 — inline input is the upgrade path
    if (nm == null) return;
    rename(id, nm);
  }

  async function duplicate(id) {
    const src = readIndex().find((x) => x.id === id);
    if (!src) return null;
    const nid = randHex();
    try {
      if (id === activeId()) {
        try { await captureThumb(); } catch {}       // freshen the thumb we're about to copy
        localStorage.setItem(stateKey(nid), JSON.stringify(collectLiveScoped()));
      } else {
        const raw = localStorage.getItem(stateKey(id));
        if (raw != null) localStorage.setItem(stateKey(nid), raw);
      }
      const thumb = localStorage.getItem(thumbKey(id));
      if (thumb != null) localStorage.setItem(thumbKey(nid), thumb);
    } catch (err) { console.warn('[boards] duplicate copy failed', err); }
    const idx = readIndex();                         // re-read: captureThumb may have bumped the index
    const now = Date.now();
    idx.push({
      id: nid, name: src.name + ' (copy)',
      createdAt: now, updatedAt: now,
      previewUpdatedAt: src.previewUpdatedAt || 0,
    });
    writeIndex(idx);
    return nid;
  }

  function remove(id) {
    const idx = readIndex();
    const b = idx.find((x) => x.id === id);
    if (!b) return;
    if (!window.confirm('Delete board "' + b.name + '"? This cannot be undone.')) return;
    const wasActive = id === activeId();
    const rest = idx.filter((x) => x.id !== id);
    localStorage.removeItem(stateKey(id));
    localStorage.removeItem(thumbKey(id));
    if (!wasActive) { writeIndex(rest); return; }
    // Deleting the active board: its live keys go too, then land somewhere.
    removeLiveScoped();
    if (rest.length) {
      writeIndex(rest, { silent: true });
      restoreSnapshot(rest[0].id);
      try { localStorage.setItem(LAST_KEY, rest[0].id); } catch {}
    } else {
      const nb = newEntry('Main studio');
      writeIndex([nb], { silent: true });
      try { localStorage.setItem(LAST_KEY, nb.id); } catch {}
    }
    location.reload();
  }

  // ── injected CSS (warm palette via the shared :root vars) ──────────────────
  (function injectStyles() {
    if (document.getElementById('atelier-boards-styles')) return;
    const css = `
      .sb-head .sb-actions span { cursor: pointer; }
      .sb-head .sb-actions span:hover { color: var(--accent); }
      .bd-rows { display: flex; flex-direction: column; gap: 2px; }
      .sb-item.bd-row { display: flex; align-items: center; gap: 9px; }
      .bd-thumb { width: 64px; height: 44px; flex: 0 0 64px; object-fit: cover;
        object-position: top left; border-radius: 6px; border: 1px solid var(--border);
        background: var(--accent-soft); display: block; }
      div.bd-thumb { background: linear-gradient(135deg, var(--accent-soft), var(--canvas)); }
      .bd-row .bd-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; }

      .bd-all { display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 100%; }
      .bd-search { border: 1px solid var(--border); border-radius: 9px; padding: 8px 11px;
        font: inherit; font-size: 13.5px; color: var(--ink); background: #faf7f1; outline: none; }
      .bd-search:focus { border-color: var(--accent); }
      .bd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
        gap: 12px; }
      .bd-card { border: 1px solid var(--border); border-radius: 12px; background: var(--panel);
        overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-sm); }
      .bd-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
      .bd-cover { width: 100%; height: 160px; object-fit: cover; object-position: top left;
        display: block; background: var(--accent-soft); border: none;
        border-bottom: 1px solid var(--border-soft); }
      div.bd-cover { background: linear-gradient(135deg, var(--accent-soft), var(--canvas)); }
      .bd-meta { padding: 9px 11px 4px; }
      .bd-card-name { font-size: 13px; font-weight: 600; color: var(--ink);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bd-card-date { font-size: 11px; color: var(--ink-dim); margin-top: 2px; }
      .bd-card-actions { display: flex; gap: 6px; padding: 8px 10px 10px; flex-wrap: wrap; }
      .bd-btn { border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 8px; padding: 4px 9px; font: inherit; font-size: 11.5px; font-weight: 600;
        cursor: pointer; }
      .bd-btn:hover { background: var(--active); color: var(--ink); }
      .bd-btn-danger:hover { background: var(--accent-soft); color: var(--accent);
        border-color: var(--accent); }
      .bd-empty { color: var(--ink-dim); font-size: 12.5px; padding: 8px 2px; }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-boards-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── sidebar UI (takes over the existing "Dashboards" .sb-group) ────────────
  // XSS rule: board names (and anything else user/endpoint-provided) go into
  // the DOM via textContent only.
  function buildThumb(boardId, cls) {
    const url = localStorage.getItem(thumbKey(boardId));
    if (url && /^data:image\//.test(url)) {
      const img = document.createElement('img');
      img.className = cls;
      img.alt = '';
      img.src = url;
      return img;
    }
    const ph = document.createElement('div');       // neutral placeholder block
    ph.className = cls;
    return ph;
  }

  let rowsHost = null;

  function renderSidebar() {
    if (!rowsHost) return;
    rowsHost.innerHTML = '';
    const act = activeId();
    readIndex().forEach((b) => {
      const row = document.createElement('div');
      row.className = 'sb-item bd-row' + (b.id === act ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'bd-name';
      name.textContent = b.name;
      row.append(buildThumb(b.id, 'bd-thumb'), name);
      row.title = b.name;
      row.addEventListener('click', () => switchTo(b.id));
      // switchTo no-ops on the active row, so dblclick-rename is reachable there
      row.addEventListener('dblclick', () => { if (b.id === activeId()) promptRename(b.id); });
      rowsHost.appendChild(row);
    });
  }

  (function wireSidebar() {
    const groups = Array.from(document.querySelectorAll('.sidebar .sb-group'));
    const group = groups.find((g) => {
      const t = g.querySelector('.sb-title');
      return t && /dashboards/i.test(t.textContent || '');
    }) || groups[0];
    if (!group) { console.warn('[boards] sidebar Dashboards group not found.'); return; }
    group.querySelectorAll(':scope > .sb-item').forEach((el) => el.remove()); // static "Main studio" row
    rowsHost = document.createElement('div');
    rowsHost.className = 'bd-rows';
    group.appendChild(rowsHost);
    const actions = group.querySelectorAll('.sb-head .sb-actions span');
    if (actions[0]) { actions[0].title = 'New board'; actions[0].addEventListener('click', () => create()); }
    if (actions[1]) { actions[1].title = 'All boards'; actions[1].addEventListener('click', openAllBoards); }
    renderSidebar();
  })();

  // ── "All boards" panel ─────────────────────────────────────────────────────
  let allPanel = null;
  let allPanelRender = null;

  function fmtDate(ts) {
    return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '';
  }

  function openAllBoards() {
    const wrap = document.createElement('div');
    wrap.className = 'bd-all';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'bd-search';
    search.placeholder = 'Search boards…';
    const grid = document.createElement('div');
    grid.className = 'bd-grid';
    wrap.append(search, grid);

    function actionBtn(label, danger, fn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-btn' + (danger ? ' bd-btn-danger' : '');
      btn.textContent = label;
      btn.addEventListener('click', fn);
      return btn;
    }

    function renderGrid() {
      grid.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const act = activeId();
      const items = readIndex().filter((b) => !q || b.name.toLowerCase().includes(q));
      if (!items.length) {
        const e = document.createElement('div');
        e.className = 'bd-empty';
        e.textContent = 'No boards match.';
        grid.appendChild(e);
        return;
      }
      items.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'bd-card' + (b.id === act ? ' active' : '');
        const meta = document.createElement('div');
        meta.className = 'bd-meta';
        const nm = document.createElement('div');
        nm.className = 'bd-card-name';
        nm.textContent = b.name;
        nm.title = b.name;
        const dt = document.createElement('div');
        dt.className = 'bd-card-date';
        dt.textContent = 'Updated ' + (fmtDate(b.updatedAt) || '—');
        meta.append(nm, dt);
        const actions = document.createElement('div');
        actions.className = 'bd-card-actions';
        actions.append(
          actionBtn('Open', false, () => switchTo(b.id)),
          actionBtn('Rename', false, () => promptRename(b.id)),
          actionBtn('Duplicate', false, () => duplicate(b.id)),
          actionBtn('Delete', true, () => remove(b.id))
        );
        card.append(buildThumb(b.id, 'bd-cover'), meta, actions);
        grid.appendChild(card);
      });
    }

    search.addEventListener('input', renderGrid);
    renderGrid();
    if (allPanel && document.body.contains(allPanel.el)) { try { allPanel.close(); } catch {} }
    allPanel = A.ui.openPanel('All boards', wrap);
    allPanelRender = renderGrid;
  }

  // ── palette commands (palette.js listens on the bus for 'palette:add') ─────
  function registerPaletteCommands() {
    A.bus.emit('palette:add', {
      id: 'boards.new', label: 'New board', icon: '▦', section: 'Boards',
      keywords: 'board dashboard create new studio',
      run() { create(); },
    });
    A.bus.emit('palette:add', {
      id: 'boards.all', label: 'All boards', icon: '▦', section: 'Boards',
      keywords: 'board dashboard list manage all',
      run() { openAllBoards(); },
    });
    readIndex().forEach((b) => {
      A.bus.emit('palette:add', {
        id: 'boards.switch.' + b.id,
        label: 'Switch board: ' + b.name,
        icon: '▦', section: 'Boards',
        keywords: 'board switch open ' + b.name,
        // ponytail: the palette has no remove API — a deleted board leaves a
        // stale entry until reload, so run() re-checks the index.
        run() {
          if (!readIndex().some((x) => x.id === b.id)) { A.ui.toast('Board no longer exists'); return; }
          switchTo(b.id);
        },
      });
    });
  }
  registerPaletteCommands();
  A.bus.on('palette:ready', registerPaletteCommands); // covers palette.js loading after this module

  // ── keep every surface in sync ─────────────────────────────────────────────
  A.bus.on('boards:changed', () => {
    renderSidebar();
    registerPaletteCommands();                       // palette dedupes by id
    if (allPanel && document.body.contains(allPanel.el) && allPanelRender) allPanelRender();
  });

  // ── public API ─────────────────────────────────────────────────────────────
  window.Atelier.boards = {
    list: readIndex,
    active,
    create,
    rename,
    duplicate,
    remove,
    switch: switchTo,
    captureThumb,
  };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const problems = [];
    const idx = readIndex();
    if (!idx.length) problems.push('empty index');
    if (!idx.some((b) => b.id === activeId())) problems.push('dangling lastBoardId');
    ['list', 'active', 'create', 'rename', 'duplicate', 'remove', 'switch', 'captureThumb']
      .forEach((k) => { if (typeof window.Atelier.boards[k] !== 'function') problems.push('boards.' + k); });
    if (!rowsHost) problems.push('sidebar not wired');
    console.assert(problems.length === 0, '[boards] self-check FAILED:', problems);
    if (!problems.length) {
      const a = active();
      console.log('[boards] ready — ' + idx.length + ' board(s), active "' + (a ? a.name : '?') + '".');
    }
  })();
})();
