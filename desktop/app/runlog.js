'use strict';

/* ===========================================================================
   Atelier feature module — run-log card   (app/runlog.js)

   A read-only terminal-styled card that tails the desktop backend's log file
   (main.js pipes the backend's stdio to ~/.atelier/logs/backend.log). Registers
   the 'runlog' app type via Atelier.registerApp.

   Backend contract (lite_server.py, fixed shape, never 500):
     GET /logs/backend?tail=N -> {"lines":[<str>...], "path":"<abs>", "size":<int>}
     (tail clamped 1..1000 server-side; missing file -> lines [] + size 0)

   Poll: GET /logs/backend?tail=300 every 2s while the card exists, via a
   CHAINED setTimeout (the next tick is armed only after the previous fetch
   settles, so a slow backend can never stack requests). A small header row in
   the body shows the log path plus a pause/resume button that stops/restarts
   the poll. Backend unreachable -> a quiet inline note; polling continues.

   Render choice: ONE <pre> rebuilt per poll (textContent = lines.join('\n')).
   A single text-node swap is cheaper than creating/GCing 300 <div>s every 2s,
   and no per-line styling is needed; a string compare skips the swap (and any
   layout work) entirely when the tail has not changed. XSS rule: server
   strings (lines, path) only ever enter the DOM via textContent.

   Auto-scroll: to the bottom after a rebuild ONLY when the user was already
   at (or within 8px of) the bottom beforehand — a user who scrolled up to
   read stays exactly where they are.

   Reachability: NO dock button (the dock is full) — the card spawns from the
   ⌘K palette ("Add app: Run log") or Atelier.spawnApp('runlog'). Verified:
   palette.js's buildCommands() runs at open() time and iterates A.apps, so
   registerApp alone puts this module in the palette; no palette change needed.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Loads after core.js (orchestrator owns the index.html script tag).

   ponytail: run-log cards are not persisted (a board switch removes them via
   removeAllCards -> card:removed, which stops the poll; same as agent cards).
   The 300-line tail and 2s cadence are constants, not settings. Board-scoped
   persistence and a follow/find toolbar are the upgrades.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 .venv-ext/bin/python lite_server.py) and
      `npm start` in desktop/ — or open index.html in a plain browser.
   2. ⌘K → type "run log" → "Add app: Run log" → a dark terminal card spawns;
      within 2s the tail of ~/.atelier/logs/backend.log renders (monospace
      cream-on-dark), scrolled to the bottom; the header row shows the path.
      Network tab: GET /logs/backend?tail=300 every ~2s.
   3. Append a line (echo hello >> ~/.atelier/logs/backend.log) → it appears
      within 2s and the view stays pinned to the bottom.
   4. Scroll up, append another line → the view does NOT jump; scroll back to
      the bottom, append again → pinned-to-bottom behavior resumes.
   5. Click Pause → polling stops (Network tab quiet), button reads Resume.
      Click Resume → an immediate fetch, then the 2s cadence.
   6. Stop the backend → a quiet "Backend unreachable" note appears in the
      card; polling continues. Restart the backend → the note clears and
      lines render again, no interaction needed.
   7. Missing log file (ATELIER_BACKEND_LOG=/nope on the backend) → the card
      shows the resolved path and an empty terminal — no error, no crash.
   8. Close the card (×) → polling stops (Network tab). Switching boards
      removes the card the same way.
   9. Console shows "[runlog] self-check passed" and no assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[runlog] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 2000;
  const TAIL = 300;
  const CARD_W = 520;
  const CARD_H = 340;
  const BOTTOM_SLACK = 8; // px: "at the bottom" tolerance for auto-scroll

  // ── injected styles (terminal body inside the standard warm-cream card) ───
  (function injectStyles() {
    if (document.getElementById('atl-runlog-styles')) return;
    const css = `
      .atl-runlog-body { padding: 0; display: flex; flex-direction: column; }
      .atl-runlog-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-dim); }
      .atl-runlog-path { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; direction: rtl; text-align: left;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .atl-runlog-pause { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-runlog-pause:hover { border-color: var(--accent); }
      .atl-runlog-note { font-size: 11px; color: var(--ink-dim);
        padding: 3px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-runlog-note:empty { display: none; }
      .atl-runlog-term { flex: 1; overflow: auto; background: #2b2320;
        padding: 10px 12px; }
      .atl-runlog-term pre { margin: 0;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #f3ead8; white-space: pre-wrap; word-break: break-word; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-runlog-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── one run-log card ───────────────────────────────────────────────────────
  function createRunlogCard(worldPos) {
    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = document.createElement('section');
    card.className = 'card app-card atl-runlog-card';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = 'Run log';
    const closeX = document.createElement('span');
    closeX.className = 'card-x';
    closeX.textContent = '×';
    bar.append(dot, title, closeX);

    const body = document.createElement('div');
    body.className = 'app-body atl-runlog-body';
    const head = document.createElement('div');
    head.className = 'atl-runlog-head';
    const pathEl = document.createElement('span');
    pathEl.className = 'atl-runlog-path';
    pathEl.textContent = '…'; // real path lands with the first poll
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'atl-runlog-pause';
    pauseBtn.textContent = 'Pause';
    pauseBtn.title = 'Pause polling';
    head.append(pathEl, pauseBtn);
    const note = document.createElement('div');
    note.className = 'atl-runlog-note';
    const term = document.createElement('div');
    term.className = 'atl-runlog-term';
    const pre = document.createElement('pre');
    term.appendChild(pre);
    body.append(head, note, term);
    card.append(bar, body);

    // state
    let closed = false;
    let paused = false;
    let pollTimer = null;
    let lastText = null; // last rendered tail; string compare skips no-op swaps

    function setNote(text) { note.textContent = text || ''; }

    function render(data) {
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const text = lines.join('\n');
      pathEl.textContent = String(data.path || '');
      pathEl.title = String(data.path || '');
      if (text === lastText) return; // unchanged tail: skip the swap entirely
      // auto-scroll only when the user was ALREADY at the bottom
      const atBottom =
        term.scrollTop + term.clientHeight >= term.scrollHeight - BOTTOM_SLACK;
      pre.textContent = text; // XSS rule: server text only ever lands here
      lastText = text;
      if (atBottom) term.scrollTop = term.scrollHeight;
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS);
    }

    async function poll() {
      if (closed || paused) return;
      try {
        const headers = {};
        if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
        const res = await fetch(BASE + '/logs/backend?tail=' + TAIL, { headers });
        const data = await res.json();
        if (res.ok && data) {
          setNote('');
          render(data);
        } // non-OK (shouldn't happen: never-500 route) — quiet, poll again
      } catch {
        // backend unreachable/mid-restart — say so quietly, keep polling
        setNote('Backend unreachable — retrying…');
      }
      if (!closed && !paused) schedulePoll(); // chained: fetches never stack
    }

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.title = paused ? 'Resume polling' : 'Pause polling';
      if (paused) {
        clearTimeout(pollTimer);
        setNote('Paused.');
      } else {
        setNote('');
        poll(); // immediate refresh, then the 2s cadence
      }
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

    // card closed (×, Delete key, board switch's removeAllCards) → stop polling
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      clearTimeout(pollTimer);
      off();
    });

    poll(); // first fetch now; subsequent ones every 2s
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('runlog', {
    label: 'Run log',
    icon: '≣',
    create(worldPos) { return createRunlogCard(worldPos); },
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('runlog');
    console.assert(registered, '[runlog] runlog app type not registered');
    const styles = !!document.getElementById('atl-runlog-styles');
    console.assert(styles, '[runlog] styles not injected');
    if (registered && styles) {
      console.log('[runlog] self-check passed — runlog app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
