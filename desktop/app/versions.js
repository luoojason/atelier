'use strict';

/* ===========================================================================
   Atelier feature module — versions card   (app/versions.js)

   A browse/preview/restore card over the backend's output version history
   (shared_tools/versions_store.py: every overwrite of a vault note captures
   the superseded content). Registers the 'versions' app type via
   Atelier.registerApp.

   Backend contract (lite_server.py, fixed shapes, never 500):
     GET  /versions?limit=N          -> {"notes":[{path,display,versions,latest_ts}]}
     GET  /versions/list?path=<abs>  -> {"path","versions":[{id,ts,source,label,size}]}
     GET  /versions/content?path=&id=-> {"content": <str|null>}
     POST /versions/restore {path,id}-> {"ok": bool}   (token-gated)

   Three stacked states inside one card (w 420 h 380, warm-cream idiom):
     1. Note list      — GET /versions?limit=50; row = display path + version
                         count + latest ts; click -> state 2. Refresh button.
     2. Version list   — GET /versions/list for one note; row = ts + source +
                         label + size; back button; click -> state 3.
     3. Preview        — GET /versions/content into a readonly <pre> (11px
                         mono, scrollable, textContent) + a 'Restore this
                         version' button -> POST /versions/restore with the
                         X-Atelier-Token header -> toast ok/fail -> back to
                         state 2 refreshed (a restore adds a pre_restore
                         version, so the list is stale by design).

   No polling: every fetch is on demand (spawn, click, Refresh, post-restore).
   Backend unreachable -> a quiet inline note; Refresh retries the same view.
   XSS rule: every server-derived string (paths, ids, labels, note content)
   only ever enters the DOM via textContent.

   Stale-response guard: navigation bumps a sequence counter and every async
   render re-checks it, so a slow response for a view the user already left
   (or a closed card) never lands in the DOM.

   Reachability: NO dock button — the card spawns from the ⌘K palette
   ("Add app: Versions") or Atelier.spawnApp('versions'). Verified the same
   way runlog did: palette.js's buildCommands() runs at open() time and
   iterates A.apps, so registerApp alone puts this module in the palette.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Loads after core.js (orchestrator owns the index.html script tag).

   ponytail: versions cards are not persisted (a board switch removes them via
   removeAllCards -> card:removed, same as runlog cards). The 50-note list cap
   mirrors the server clamp and is a constant, not a setting. Diffing two
   versions and restore-with-confirm are the upgrades.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 .venv-ext/bin/python lite_server.py) and
      `npm start` in desktop/ — or open index.html in a plain browser.
   2. ⌘K → type "versions" → "Add app: Versions" → a warm-cream card spawns
      and GET /versions?limit=50 fires once (Network tab; no polling after).
   3. Fresh install (no captures yet) → the empty state reads 'No note
      versions yet — versions are captured when Atelier overwrites a vault
      note.' Overwrite a vault note twice (e.g. two VaultWrite calls to the
      same path), click Refresh → the note appears with its version count and
      latest timestamp.
   4. Click the note row → the version list renders (ts + source + label +
      size), newest first; the header shows the note's display path and a ←
      back button that returns to the note list.
   5. Click a version row → the preview renders the captured content in a
      readonly monospace <pre>; content with <script> or HTML renders as
      literal text (textContent).
   6. Click 'Restore this version' → POST /versions/restore (with
      X-Atelier-Token under Electron) → toast 'Version restored…' → the card
      returns to the version list, which now includes a new pre_restore entry
      at the top. The vault file on disk holds the restored content.
   7. Restore failure (stop the backend, or a tampered id) → toast 'Restore
      failed…', card stays on the preview, nothing is lost.
   8. Stop the backend, click Refresh → a quiet 'Backend unreachable' note in
      the card, no crash, no console spam. Restart + Refresh → the view loads.
   9. Close the card (×) or switch boards mid-fetch → no errors (stale
      responses are dropped). Console shows "[versions] self-check passed".
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[versions] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const CARD_W = 420;
  const CARD_H = 380;
  const NOTE_LIMIT = 50;

  // ── injected styles (list + preview inside the standard warm-cream card) ──
  (function injectStyles() {
    if (document.getElementById('atl-versions-styles')) return;
    const css = `
      .atl-ver-body { padding: 0; display: flex; flex-direction: column; }
      .atl-ver-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-dim); }
      .atl-ver-crumb { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: var(--ink-mid); }
      .atl-ver-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-ver-btn:hover { border-color: var(--accent); }
      .atl-ver-btn:disabled { opacity: 0.5; cursor: default; }
      .atl-ver-note { font-size: 11px; color: var(--ink-dim);
        padding: 3px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-ver-note:empty { display: none; }
      .atl-ver-list { flex: 1; overflow: auto; }
      .atl-ver-row { display: flex; align-items: baseline; gap: 8px;
        padding: 7px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 12px; color: var(--ink-mid); cursor: pointer; }
      .atl-ver-row:hover { background: #f6f1e7; }
      .atl-ver-row-main { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .atl-ver-row-meta { flex: 0 0 auto; font-size: 11px;
        color: var(--ink-dim); white-space: nowrap; }
      .atl-ver-empty { padding: 16px 14px; font-size: 12px;
        color: var(--ink-dim); line-height: 1.5; }
      .atl-ver-preview { flex: 1; display: flex; flex-direction: column;
        min-height: 0; }
      .atl-ver-restore-bar { padding: 6px 10px;
        border-bottom: 1px solid var(--border-soft); }
      .atl-ver-pre-wrap { flex: 1; overflow: auto; background: #fbf8f2;
        padding: 10px 12px; }
      .atl-ver-pre-wrap pre { margin: 0;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--ink); white-space: pre-wrap; word-break: break-word; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-versions-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend helper: fetch JSON, never throw on HTTP errors (only network) ─
  // Mutating routes require the shared-secret header when the backend was
  // launched by main.js (window.atelier.token via preload); in a plain
  // browser the bridge is absent and a hand-run backend has no token to
  // enforce. Same idiom as sessions.js/views.js.
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const init = Object.assign({ headers }, opts || {});
    const res = await fetch(BASE + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  function fmtSize(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  function fmtTs(ts) {
    // server sends local ISO seconds ("2026-07-02T10:33:12"); a space reads
    // better in a narrow row — pure string swap, no Date parsing to go wrong.
    return String(ts || '').replace('T', ' ');
  }

  // ── one versions card ──────────────────────────────────────────────────────
  function createVersionsCard(worldPos) {
    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = document.createElement('section');
    card.className = 'card app-card atl-ver-card';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = 'Versions';
    const closeX = document.createElement('span');
    closeX.className = 'card-x';
    closeX.textContent = '×';
    bar.append(dot, title, closeX);

    const body = document.createElement('div');
    body.className = 'app-body atl-ver-body';
    const head = document.createElement('div');
    head.className = 'atl-ver-head';
    const backBtn = document.createElement('button');
    backBtn.className = 'atl-ver-btn';
    backBtn.textContent = '← Back';
    backBtn.hidden = true; // note list is the root state
    const crumb = document.createElement('span');
    crumb.className = 'atl-ver-crumb';
    crumb.textContent = 'All notes';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'atl-ver-btn';
    refreshBtn.textContent = 'Refresh';
    head.append(backBtn, crumb, refreshBtn);
    const note = document.createElement('div');
    note.className = 'atl-ver-note';
    const content = document.createElement('div');
    content.className = 'atl-ver-list';
    body.append(head, note, content);
    card.append(bar, body);

    // state
    let closed = false;
    let seq = 0; // bumped per navigation; stale fetch results are dropped
    // current view descriptor — enough to re-run it (Refresh) or go back:
    // {view:'notes'} | {view:'list', path, display}
    // | {view:'preview', path, display, id, ts}
    let cur = { view: 'notes' };

    function setNote(text) { note.textContent = text || ''; }

    function clearContent() {
      content.textContent = '';
      content.scrollTop = 0;
    }

    function emptyRow(text) {
      const div = document.createElement('div');
      div.className = 'atl-ver-empty';
      div.textContent = text;
      return div;
    }

    function row(mainText, metaText, onClick) {
      const r = document.createElement('div');
      r.className = 'atl-ver-row';
      const main = document.createElement('span');
      main.className = 'atl-ver-row-main';
      main.textContent = mainText; // server strings: textContent only
      main.title = mainText;
      const meta = document.createElement('span');
      meta.className = 'atl-ver-row-meta';
      meta.textContent = metaText;
      r.append(main, meta);
      r.addEventListener('click', onClick);
      return r;
    }

    // ── state 1: note list ───────────────────────────────────────────────────
    async function showNotes() {
      cur = { view: 'notes' };
      const my = ++seq;
      backBtn.hidden = true;
      crumb.textContent = 'All notes';
      crumb.title = '';
      setNote('');
      clearContent();
      let notes = null;
      try {
        const { ok, data } = await apiJson('/versions?limit=' + NOTE_LIMIT);
        if (ok && data && Array.isArray(data.notes)) notes = data.notes;
      } catch { /* backend unreachable — handled below */ }
      if (closed || my !== seq) return; // user navigated away / card closed
      if (notes === null) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      if (notes.length === 0) {
        content.appendChild(emptyRow('No note versions yet — versions are '
          + 'captured when Atelier overwrites a vault note.'));
        return;
      }
      for (const n of notes) {
        const display = String(n.display || n.path || '');
        const path = String(n.path || '');
        const count = Number(n.versions) || 0;
        const meta = count + (count === 1 ? ' version · ' : ' versions · ')
          + fmtTs(n.latest_ts);
        content.appendChild(row(display, meta, () => showList(path, display)));
      }
    }

    // ── state 2: version list for one note ──────────────────────────────────
    async function showList(path, display) {
      cur = { view: 'list', path, display };
      const my = ++seq;
      backBtn.hidden = false;
      crumb.textContent = display;
      crumb.title = path;
      setNote('');
      clearContent();
      let versions = null;
      try {
        const { ok, data } = await apiJson('/versions/list?path=' + encodeURIComponent(path));
        if (ok && data && Array.isArray(data.versions)) versions = data.versions;
      } catch { /* backend unreachable — handled below */ }
      if (closed || my !== seq) return;
      if (versions === null) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      if (versions.length === 0) {
        content.appendChild(emptyRow('No versions recorded for this note.'));
        return;
      }
      for (const v of versions) {
        const id = String(v.id || '');
        const ts = String(v.ts || '');
        const label = String(v.label || '');
        const main = fmtTs(ts) + ' · ' + String(v.source || '')
          + (label ? ' · ' + label : '');
        content.appendChild(row(main, fmtSize(v.size), () =>
          showPreview(path, display, id, ts)));
      }
    }

    // ── state 3: preview + restore ───────────────────────────────────────────
    async function showPreview(path, display, id, ts) {
      cur = { view: 'preview', path, display, id, ts };
      const my = ++seq;
      backBtn.hidden = false;
      crumb.textContent = display + ' @ ' + fmtTs(ts);
      crumb.title = path;
      setNote('');
      clearContent();
      let contentStr = null;
      try {
        const { ok, data } = await apiJson('/versions/content?path='
          + encodeURIComponent(path) + '&id=' + encodeURIComponent(id));
        if (ok && data && typeof data.content === 'string') contentStr = data.content;
        else if (ok && data) contentStr = false; // reached backend, null content
      } catch { /* backend unreachable — handled below */ }
      if (closed || my !== seq) return;
      if (contentStr === null) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      if (contentStr === false) {
        setNote('Version content unavailable (missing or corrupt blob).');
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'atl-ver-preview';
      const restoreBar = document.createElement('div');
      restoreBar.className = 'atl-ver-restore-bar';
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'atl-ver-btn';
      restoreBtn.textContent = 'Restore this version';
      restoreBar.appendChild(restoreBtn);
      const preWrap = document.createElement('div');
      preWrap.className = 'atl-ver-pre-wrap';
      const pre = document.createElement('pre');
      pre.textContent = contentStr; // XSS rule: note content only lands here
      preWrap.appendChild(pre);
      wrap.append(restoreBar, preWrap);
      content.appendChild(wrap);

      restoreBtn.addEventListener('click', async () => {
        const mine = seq; // nav guard: the user may navigate mid-POST
        restoreBtn.disabled = true; // one restore at a time
        let ok = false;
        try {
          const res = await apiJson('/versions/restore', {
            method: 'POST',
            body: JSON.stringify({ path, id }),
          });
          ok = !!(res.ok && res.data && res.data.ok);
        } catch { /* backend unreachable — ok stays false */ }
        if (closed) return;
        if (ok) {
          if (A.ui && A.ui.toast) {
            A.ui.toast('Version restored — the previous content was captured as pre_restore.');
          }
          // same my/seq discipline as the view renders: if the user
          // navigated while the POST was in flight, keep their view (the
          // toast already reported the outcome) instead of yanking the card
          // back to this note's version list.
          if (mine !== seq) return;
          // back to the version list, refreshed: the restore just added a
          // pre_restore entry, so the old list is stale by design.
          showList(path, display);
        } else {
          if (A.ui && A.ui.toast) A.ui.toast('Restore failed — the note was not changed.');
          restoreBtn.disabled = false; // stay on the preview, allow retry
        }
      });
    }

    // ── navigation wiring ────────────────────────────────────────────────────
    backBtn.addEventListener('click', () => {
      if (cur.view === 'preview') showList(cur.path, cur.display);
      else showNotes();
    });
    refreshBtn.addEventListener('click', () => {
      if (cur.view === 'list') showList(cur.path, cur.display);
      else if (cur.view === 'preview') showPreview(cur.path, cur.display, cur.id, cur.ts);
      else showNotes();
    });

    // place the card (spawnApp passes a world pos; fall back to canvas center)
    let pos = worldPos;
    if (!pos) {
      const canvasEl = document.getElementById('canvas');
      const rct = canvasEl.getBoundingClientRect();
      pos = A.canvas.screenToWorld(rct.left + rct.width / 2, rct.top + rct.height / 2);
      pos = { x: pos.x - CARD_W / 2, y: pos.y - CARD_H / 2 };
    }
    const handle = A.canvas.addCard(card, { x: pos.x, y: pos.y, w: CARD_W, h: CARD_H });

    // card closed (×, Delete key, board switch's removeAllCards) → drop any
    // in-flight render (no timers here: the card never polls)
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      off();
    });

    showNotes(); // first fetch now; everything after is click-driven
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('versions', {
    label: 'Versions',
    icon: '⧉',
    create(worldPos) { return createVersionsCard(worldPos); },
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('versions');
    console.assert(registered, '[versions] versions app type not registered');
    const styles = !!document.getElementById('atl-versions-styles');
    console.assert(styles, '[versions] styles not injected');
    if (registered && styles) {
      console.log('[versions] self-check passed — versions app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
