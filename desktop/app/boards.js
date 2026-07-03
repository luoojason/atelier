'use strict';

/* ===========================================================================
   Atelier feature module — boards   (app/boards.js)

   Multiple named dashboards ("boards"). The ACTIVE board's state lives in the
   ordinary live 'atelier:*' localStorage keys that every feature module
   already reads/writes; INACTIVE boards exist only as snapshots. Switching
   boards is IN-PLACE (no reload): flush ('boards:will-switch') -> thumb +
   snapshot the live board-scoped keys -> canvas.removeAllCards() -> swap in
   the target's snapshot -> 'boards:switched', on which every module
   re-mounts its cards from the restored store.

   KNOWN BEHAVIOR CHANGE (in-place switch): the built-in chat card's
   transcript is page-scoped DOM, not board state, so it now PERSISTS across
   board switches — which matches the single long-lived backend conversation
   better than the old reload-wipe did.

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
   4. Click "+" in the Dashboards header -> "Board 2" is created and the
      canvas swaps IN PLACE (no reload) to an empty board — only the built-in
      metrics/chat cards remain, and the chat transcript survives the switch.
   5. Click the "Main studio" row -> in-place swap again -> your widget/note
      is back exactly where you left it, and the sidebar active highlight has
      moved without a reload. In DevTools, localStorage now holds
      'atelier:board.<id>.state' for whichever board is NOT active.
   6. Click "⌄" in the Dashboards header -> the "All boards" panel opens:
      cover thumbnails, names, updated dates, a search box that filters by
      name, Open / Rename / Duplicate / Export / Delete on each card, and an
      "Export boards" + "Import" footer.
   7. Click Rename on Board 2's card -> the name swaps to an inline <input>
      (value selected). Type "Scratch" + Enter (or click away to blur) ->
      committed; Escape cancels; whitespace-only input is a no-op. Same
      inline input on double-clicking the ACTIVE sidebar row's name.
      Duplicate it -> "Scratch (copy)" appears with the same thumb. Delete
      "Scratch" -> confirm() -> row disappears; deleting the active board
      lands you on the first remaining board.
   8. ⌘K -> type "board" -> "New board", "All boards" and one
      "Switch board: <name>" per board are in the palette.
   9. In the All boards footer click "Export boards" -> atelier-boards.json
      downloads: {format:"atelier-boards", version:1, exportedAt,
      boards:[{id,name,createdAt,updatedAt,state}]} — the ACTIVE board's
      state is captured live (debounced saves flushed first), and NO
      thumbnails are inside. A card's own "Export" button downloads just
      that one board (atelier-board-<slug>.json).
  10. Click "Import" in the footer -> pick that file -> toast
      "Imported N board(s)", new rows appear with FRESH ids (" (imported)"
      suffix only on a name clash) and nothing switches; opening one shows
      the exported canvas. Re-picking the SAME file works (input resets).
      Feeding it a random/malformed .json -> toast only, no uncaught throw.
  11. Console shows "[boards] ready — …" and no console.assert failures.
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
    // slashcommands.js -> Atelier.store 'atelier.slashcommands' (user-defined
    // slash commands). GLOBAL so a custom /command follows the user across
    // every board rather than living on only the board it was created on.
    'atelier:atelier.slashcommands',
    // premium.js -> Atelier.store 'atelier.premium.license' (Workflow AI unlock
    // token). GLOBAL so an unlock is not tied to the board it was entered on.
    'atelier:atelier.premium.license',
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

  // A view can be OPEN while we snapshot outside a real switch (duplicate,
  // export) — a real switch always nulls 'view.current' first (views.js
  // closes on 'boards:will-switch'), so a snapshot that carries an open view
  // would auto-reopen it when the copy is later restored. Normalize to the
  // JSON null the store convention uses.
  function scrubViewKey(snap) {
    if ('atelier:view.current' in snap) snap['atelier:view.current'] = 'null';
    return snap;
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
  // Shared in-place mount — the ONLY path that swaps the live keys. Both real
  // switches (switchTo) and delete-active landings (remove) come through here
  // AFTER their own will-switch / snapshot steps:
  //   canvas.removeAllCards()  -> 'card:removed' fires per non-builtin card,
  //                               so modules drop their per-card state
  //   removeLiveScoped() + restoreSnapshot(id) + LAST_KEY = id
  //   'boards:switched'        -> modules re-mount from the restored store
  //   syncUI()                 -> sidebar highlight / all-boards panel follow
  function mountBoard(id) {
    // The target can be deleted between switchTo's entry check and here: the
    // await captureThumb() suspension leaves the All boards panel interactive,
    // so a Delete can land mid-switch. Mounting a ghost id would strand
    // LAST_KEY outside the index (the old reload path self-healed via boot()'s
    // dangling-lastBoardId migration; in-place has no reload) — mirror boot
    // and land on the first remaining board instead.
    const idx = readIndex();
    if (!idx.length) return;                         // boot + remove() keep >= 1 board
    if (!idx.some((b) => b.id === id)) id = idx[0].id;
    A.canvas.removeAllCards();
    removeLiveScoped();
    restoreSnapshot(id);
    try { localStorage.setItem(LAST_KEY, id); } catch {}
    A.bus.emit('boards:switched', { to: id });
    syncUI();
  }

  async function switchTo(id) {
    if (id === activeId()) return;
    if (!readIndex().some((b) => b.id === id)) return;
    // Flush the sibling modules' debounced saves BEFORE snapshotting, or a
    // drag/edit inside the debounce window is missing from the snapshot (and a
    // timer firing after removeLiveScoped would leak it into the next board).
    // apps.js / widgets.js / customization.js listen and persist+disarm;
    // views.js closes the open view. Nothing DESTRUCTIVE may hang off this
    // event: the quota gate below can still abort with the board unchanged
    // (agent cards, for one, are only closed later by mountBoard's
    // removeAllCards — after the gate).
    try { A.bus.emit('boards:will-switch', { to: id }); } catch {}
    try { await captureThumb(); } catch {}
    if (!snapshotLive(activeId())) {
      A.ui.toast('Board switch failed — storage is full');
      return;                                        // quota-abort: board unchanged
    }
    // ponytail: the in-place switch rebuilds via remove-all + full re-restore
    // — no card diffing; fine at board scale (tens of cards), diff if not.
    mountBoard(id);
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

  // Inline rename: swap a name element's text for an <input> in place.
  // Enter/blur commits (rename() trims + ignores empty/unchanged), Escape
  // cancels. Names re-enter the DOM via textContent / input.value only.
  function startInlineRename(nameEl, id) {
    const b = readIndex().find((x) => x.id === id);
    if (!b || !nameEl || nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bd-rename-input';
    input.value = b.name;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    function finish(commit) {
      if (done) return;                              // blur re-fires when input.remove() runs
      done = true;
      const nm = input.value;
      input.remove();
      nameEl.textContent = b.name;                   // restore; a successful rename re-renders anyway
      if (commit) rename(id, nm);
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                           // keep Escape from closing the panel, ⌘K from opening, etc.
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    // clicks inside the input must not bubble into row switch / re-rename
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  async function duplicate(id) {
    const src = readIndex().find((x) => x.id === id);
    if (!src) return null;
    const nid = randHex();
    try {
      if (id === activeId()) {
        try { await captureThumb(); } catch {}       // freshen the thumb we're about to copy
        localStorage.setItem(stateKey(nid), JSON.stringify(scrubViewKey(collectLiveScoped())));
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
    // Deleting the active board: its live keys go too, then land somewhere
    // (the first remaining board, or a fresh "Main studio").
    let landing;
    if (rest.length) {
      writeIndex(rest, { silent: true });
      landing = rest[0].id;
    } else {
      const nb = newEntry('Main studio');
      writeIndex([nb], { silent: true });
      landing = nb.id;
    }
    // Same flush/close as a real switch (disarm debounce timers, close views)
    // or a late timer could resurrect deleted-board keys into the landing
    // board; agent cards go in mountBoard's removeAllCards. No thumb/snapshot:
    // this board's state is gone on purpose — mountBoard's removeLiveScoped
    // drops the live keys.
    try { A.bus.emit('boards:will-switch', { to: landing }); } catch {}
    mountBoard(landing);
  }

  // ── export / import ────────────────────────────────────────────────────────
  // File shape: {format:"atelier-boards", version:1, exportedAt,
  //   boards:[{id, name, createdAt, updatedAt, state:{rawKey: rawValue}}]}.
  // Thumbnails are NEVER exported — they are bulky derived data that live on
  // their own 'atelier:board.<id>.thumb' keys (outside the state snapshots)
  // and regenerate from live capture after the board is opened.
  function boardExportEntry(b) {
    let state = {};
    if (b.id === activeId()) {
      // The active board's state IS the live keys — flush the siblings'
      // debounced saves first, exactly like switch-away does (they listen on
      // 'boards:will-switch' and persist+disarm; the payload is ignored).
      try { A.bus.emit('boards:will-switch', { to: b.id, reason: 'export' }); } catch {}
      // views.js deliberately ignores reason:'export' (the view stays open),
      // so the live 'view.current' may be set — scrub it like duplicate does.
      state = scrubViewKey(collectLiveScoped());
    } else {
      try {
        const snap = JSON.parse(localStorage.getItem(stateKey(b.id)) || 'null');
        if (snap && typeof snap === 'object' && !Array.isArray(snap)) state = snap;
      } catch { state = {}; }                        // unreadable snapshot exports as empty board
    }
    return { id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, state };
  }

  function downloadJSON(payload, filename) {
    let json = null;
    try { json = JSON.stringify(payload); }
    catch (err) { console.warn('[boards] export serialize failed', err); A.ui.toast('Export failed'); return false; }
    const a = document.createElement('a');
    a.download = filename;
    // ponytail: data-URL download — a Blob/object-URL is the upgrade if boards outgrow it.
    a.href = 'data:application/json,' + encodeURIComponent(json);
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  function exportBoards(list, filename) {
    if (!list.length) { A.ui.toast('Nothing to export'); return; }
    const payload = {
      format: 'atelier-boards',
      version: 1,
      exportedAt: Date.now(),
      boards: list.map(boardExportEntry),
    };
    if (downloadJSON(payload, filename)) {
      A.ui.toast('Exported ' + payload.boards.length + ' board(s)');
    }
  }

  function exportAll() { exportBoards(readIndex(), 'atelier-boards.json'); }

  function exportOne(id) {
    const b = readIndex().find((x) => x.id === id);
    if (!b) return;
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    exportBoards([b], 'atelier-board-' + (slug || 'untitled') + '.json');
  }

  // Never throws on user input: every malformed path lands on a toast.
  function importBoardsText(text) {
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || data.format !== 'atelier-boards' || !Array.isArray(data.boards)) {
      A.ui.toast('Import failed — not an Atelier boards file');
      return;
    }
    const malformed = data.boards.some((b) =>
      !b || typeof b.name !== 'string' || !b.name.trim() ||
      !b.state || typeof b.state !== 'object' || Array.isArray(b.state));
    if (malformed) { A.ui.toast('Import failed — malformed board entries'); return; }
    if (!data.boards.length) { A.ui.toast('No boards in that file'); return; }

    const idx = readIndex();
    const names = new Set(idx.map((x) => x.name));   // also tracks names added this batch
    const added = [];
    let full = false;
    for (const src of data.boards) {
      let name = src.name.trim();
      if (names.has(name)) name += ' (imported)';    // suffix only on an actual clash
      const nid = randHex();                         // FRESH id — imports never collide/overwrite
      // Store as an inactive-board snapshot; keep only keys restoreSnapshot
      // would accept, so hostile files can't smuggle index/global/thumb keys.
      const snap = {};
      Object.keys(src.state).forEach((k) => {
        if (isBoardScoped(k) && typeof src.state[k] === 'string') snap[k] = src.state[k];
      });
      try { localStorage.setItem(stateKey(nid), JSON.stringify(snap)); }
      catch (err) { console.warn('[boards] import snapshot write failed', err); full = true; break; }
      const now = Date.now();
      names.add(name);
      added.push({
        id: nid,
        name,
        createdAt: Number.isFinite(src.createdAt) ? src.createdAt : now,
        updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : now,
        previewUpdatedAt: 0,                         // thumbs aren't exported; captured after first open
      });
    }
    if (added.length) writeIndex(idx.concat(added)); // stays on the current board — no auto-switch
    A.ui.toast(full
      ? 'Imported ' + added.length + ' of ' + data.boards.length + ' board(s) — storage is full'
      : 'Imported ' + added.length + ' board(s)');
  }

  function importBoardsFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => A.ui.toast('Import failed — could not read file');
    reader.onload = () => {
      try { importBoardsText(String(reader.result)); }
      catch (err) {
        console.warn('[boards] import failed', err);
        A.ui.toast('Import failed — malformed boards file');
      }
    };
    reader.readAsText(file);
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
      .bd-foot { display: flex; gap: 6px; justify-content: flex-end;
        border-top: 1px solid var(--border-soft); padding-top: 10px; }
      .bd-rename-input { font: inherit; font-size: inherit; font-weight: inherit;
        color: var(--ink); background: var(--panel); border: 1px solid var(--accent);
        border-radius: 6px; padding: 1px 5px; width: 100%; min-width: 0;
        box-sizing: border-box; outline: none; }
      .bd-kebab-wrap { display: flex; justify-content: flex-end; padding: 8px 10px 10px; }
      .bd-kebab { border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 8px; padding: 1px 11px; font-size: 17px; line-height: 1.15; font-weight: 700;
        letter-spacing: 1px; cursor: pointer; }
      .bd-kebab:hover, .bd-kebab.open { background: var(--active); color: var(--ink);
        border-color: var(--accent); }
      .bd-menu { position: fixed; z-index: 10010; min-width: 158px; background: var(--panel);
        border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
        padding: 5px; display: flex; flex-direction: column; }
      .bd-menu-item { text-align: left; border: none; background: none; color: var(--ink);
        padding: 7px 10px; border-radius: 7px; font: inherit; font-size: 12.5px; cursor: pointer; }
      .bd-menu-item:hover { background: var(--active); }
      .bd-menu-item.danger { color: var(--accent); }
      .bd-menu-item.danger:hover { background: var(--accent-soft); }
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
      row.addEventListener('dblclick', () => { if (b.id === activeId()) startInlineRename(name, b.id); });
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
    if (actions[0]) { actions[0].title = 'New board'; actions[0].addEventListener('click', (e) => { e.stopPropagation(); create(); }); }
    if (actions[1]) { actions[1].title = 'All boards'; actions[1].addEventListener('click', (e) => { e.stopPropagation(); openAllBoards(); }); }
    // Clicking the "Dashboards" header itself (icon/title, not the +/⌄ actions)
    // opens the All boards panel — the same thing the ⌄ down-arrow does.
    const head = group.querySelector('.sb-head');
    if (head) {
      head.style.cursor = 'pointer';
      head.addEventListener('click', (e) => {
        if (e.target.closest('.sb-actions')) return;
        openAllBoards();
      });
    }
    renderSidebar();
  })();

  // A kebab (⋯) button that opens a small dropdown menu of per-board actions,
  // replacing the old row of inline buttons. items = [[label, danger, fn], …].
  // The menu is a fixed-position element (body-appended, positioned by the
  // button's rect) that closes on item-run, click-off, or Escape.
  function buildKebab(items) {
    const wrap = document.createElement('div');
    wrap.className = 'bd-kebab-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bd-kebab';
    btn.textContent = '⋯';
    btn.title = 'Board actions';
    wrap.appendChild(btn);

    let menu = null;
    function closeMenu() {
      if (menu) { menu.remove(); menu = null; }
      btn.classList.remove('open');
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onDocDown(e) {
      if (menu && !menu.contains(e.target) && e.target !== btn) closeMenu();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); }
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();                           // don't bubble to card/panel/head
      if (menu) { closeMenu(); return; }
      menu = document.createElement('div');
      menu.className = 'bd-menu';
      items.forEach(([label, danger, fn]) => {
        const mi = document.createElement('button');
        mi.type = 'button';
        mi.className = 'bd-menu-item' + (danger ? ' danger' : '');
        mi.textContent = label;
        mi.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); fn(); });
        menu.appendChild(mi);
      });
      document.body.appendChild(menu);
      btn.classList.add('open');
      const r = btn.getBoundingClientRect();
      let left = r.right - menu.offsetWidth;
      if (left < 4) left = 4;
      let top = r.bottom + 4;
      if (top + menu.offsetHeight > window.innerHeight - 4) top = r.top - menu.offsetHeight - 4;
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      // defer the outside-close listeners so THIS opening click doesn't close it
      setTimeout(() => {
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    });
    return wrap;
  }

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

    function actionBtn(label, danger, fn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-btn' + (danger ? ' bd-btn-danger' : '');
      btn.textContent = label;
      btn.addEventListener('click', fn);
      return btn;
    }

    // footer: whole-collection export + import (hidden file input)
    const foot = document.createElement('div');
    foot.className = 'bd-foot';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      importBoardsFile(fileInput.files && fileInput.files[0]);
      fileInput.value = '';                          // same file re-selectable next time
    });
    foot.append(
      actionBtn('Export boards', false, exportAll),
      actionBtn('Import', false, () => fileInput.click()),
      fileInput
    );
    wrap.append(search, grid, foot);

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
        const actions = buildKebab([
          ['Open', false, () => switchTo(b.id)],
          ['Rename', false, () => startInlineRename(nm, b.id)],
          ['Duplicate', false, () => duplicate(b.id)],
          ['Export', false, () => exportOne(b.id)],
          ['Delete', true, () => remove(b.id)],
        ]);
        card.append(buildThumb(b.id, 'bd-cover'), meta, actions);
        grid.appendChild(card);
      });
    }

    search.addEventListener('input', renderGrid);
    renderGrid();
    if (allPanel && document.body.contains(allPanel.el)) { try { allPanel.close(); } catch {} }
    // backdrop: click off the panel to dismiss (Escape also closes it — core.js)
    allPanel = A.ui.openPanel('All boards', wrap, { backdrop: true });
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
  // Called on index changes AND after every in-place mount (a plain switch
  // never touches the index, so the active highlight would otherwise stall).
  function syncUI() {
    renderSidebar();
    registerPaletteCommands();                       // palette dedupes by id
    if (allPanel && document.body.contains(allPanel.el) && allPanelRender) allPanelRender();
  }
  A.bus.on('boards:changed', syncUI);

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
