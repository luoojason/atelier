'use strict';

/* Atelier feature module — runs ticker widget (round 17, Builder D)
   =============================================================================
   Registers EXACTLY ONE widget type, 'runsticker', via Atelier.registerWidget.
   widgets.js owns all spawn / persist / config-form / re-mount machinery
   (including the round-14 boards:switched restore); this module only supplies
   the def and rides that machinery. The double-click canvas picker and the
   "+ widget" button list registry entries automatically (widgets.js openPicker
   iterates A.widgets), so 'runsticker' shows up in both with its ⇶ icon the
   moment this file loads — verified against openPicker's A.widgets.forEach.

   What it shows
   -------------
   A live ticker of the newest scheduler runs from GET /runs (the JSONL ledger
   run_store.py writes; record fields per RECORD_FIELDS: name, ts, status,
   status_code, tokens, cost, latency_ms, attempts, error, response_excerpt).
   The server returns records OLDEST first (read_records keeps the most recent
   `limit`, in file order), so rows are reversed for newest-first display.
   Each row: a status dot (ok green #3fa66a, anything else red #b04a3a, per the
   round-17 palette) + the job name + a relative time ("3m ago"). Polls every
   10s (contract cadence); a line NOT present in the previous poll slides in
   with a one-shot flash-pulse CSS animation tinted in its status color (CSS
   animation, not rAF, per the contract preference — nothing here tracks
   continuous time). The first poll after mount seeds silently (no flash storm
   on spawn/restore). Empty ledger -> 'No runs yet.'

   Config fields (gear form, built by widgets.js from `fields`)
   ------------------------------------------------------------
   • title — card title.
   • limit — how many rows (text, default '8', clamped 3..20 at use time).

   Boundaries (per the module contract)
   ------------------------------------
   • Touches ONLY window.Atelier + standard DOM. Does NOT edit index.html,
     core.js, styles.css, widgets.js, or any sibling module.
   • All CSS is injected from the <style> this module creates (warm palette
     via the :root vars styles.css already defines).
   • Every server-derived string lands in the DOM via textContent — never
     innerHTML.
   • mount() creates exactly one interval; its returned cleanup clears it
     (plus a stopped flag so an in-flight fetch cannot write after teardown).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ with the backend running. Double-click empty
      canvas → the picker lists "Runs ticker" (⇶). Add it.
   2. Rows appear newest-first: colored dot, job name, "3m ago" style time.
   3. Wait for a scheduler fire (or append a line to ~/.openswarm/runs.jsonl):
      within 10s the new row slides in at the top with a green (ok) or red
      (error) flash-pulse, once — it does not re-flash on later polls.
   4. Gear → limit 3 → Save: the list truncates to 3 rows (and a fresh mount
      seeds silently — no flash).
   5. EMPTY STATE — point SWARM_RUNS_JSONL at a missing file (fresh machine)
      and reload: the widget shows 'No runs yet.' and zero console errors.
      Kill the backend: rows keep their last values (times freeze at the last
      successful poll; next success catches them up).
   6. Close the card / switch boards: interval stops (Network tab goes quiet).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   console.assert at the bottom verifies the type registered. Pure helpers are
   exposed on window.AtelierRunsTicker for headless verification:
     AtelierRunsTicker.relTime('2026-07-01T21:08:00')  // "3m ago"
     AtelierRunsTicker.clampLimit('8')                 // 8 (3..20)
     AtelierRunsTicker.rowKey(record)                  // dedupe identity
     AtelierRunsTicker.buildRows(container, runs, seen) // -> Set of keys shown
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function') {
    console.warn('[widget-ticker] Atelier core not available — skipping.');
    return;
  }

  // ── tiny DOM helper (same idiom as widgets.js) ─────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── injected CSS (own <style>; round-17 palette) ───────────────────────────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-ticker-styles')) return;
    const css = `
      .rtk { flex: 1; min-height: 0; display: flex; flex-direction: column;
        gap: 3px; overflow-y: auto; overflow-x: hidden; }
      .rtk-row { display: flex; align-items: center; gap: 8px; flex: none;
        padding: 3px 6px; border-radius: 7px; font-size: 12.5px;
        color: var(--ink); }
      .rtk-dot { width: 8px; height: 8px; border-radius: 50%; flex: none;
        background: var(--ink-dim); }
      .rtk-dot.rtk-ok  { background: #3fa66a; }
      .rtk-dot.rtk-bad { background: #b04a3a; }
      .rtk-name { flex: 1; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .rtk-time { flex: none; font-size: 11px; color: var(--ink-dim);
        font-variant-numeric: tabular-nums; }
      .rtk-empty { color: var(--ink-dim); font-size: 12.5px; padding: 4px 6px; }

      /* one-shot slide-in + flash-pulse for lines new since the previous poll;
         the class is only ever set on a freshly created row and next poll's
         rebuild creates the row WITHOUT it, so the animation cannot replay */
      .rtk-new-ok  { animation: rtk-in-ok  1.1s ease-out 1; }
      .rtk-new-bad { animation: rtk-in-bad 1.1s ease-out 1; }
      @keyframes rtk-in-ok {
        0%   { transform: translateY(-7px); opacity: 0;
               background: rgba(63, 166, 106, 0.30); }
        30%  { transform: translateY(0);    opacity: 1;
               background: rgba(63, 166, 106, 0.24); }
        100% { background: rgba(63, 166, 106, 0); }
      }
      @keyframes rtk-in-bad {
        0%   { transform: translateY(-7px); opacity: 0;
               background: rgba(176, 74, 58, 0.30); }
        30%  { transform: translateY(0);    opacity: 1;
               background: rgba(176, 74, 58, 0.26); }
        100% { background: rgba(176, 74, 58, 0); }
      }
    `;
    const style = el('style');
    style.id = 'atelier-widget-ticker-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend access (widgets.js contract idiom: preload bridge in the app,
  //    plain fetch in a browser tab for manual testing) ───────────────────────
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  // ── pure helpers (exposed below for headless verification) ────────────────
  // limit: text field -> integer clamped 3..20; anything unparsable -> 8.
  function clampLimit(raw) {
    const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (isNaN(n)) return 8;
    return Math.max(3, Math.min(20, n));
  }

  // "3m ago" style relative time from the ledger's local-ISO-seconds ts
  // (run_store writes datetime.now().isoformat(timespec='seconds'); a bare
  // date-time without offset parses as LOCAL time per the ES spec, matching).
  // Unparsable -> '' so a malformed record degrades to a blank time, never
  // throws. Small negative deltas (clock skew) clamp to 'just now'.
  function relTime(iso, nowMs) {
    const t = Date.parse(String(iso == null ? '' : iso));
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.floor(((nowMs == null ? Date.now() : nowMs) - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // Identity of one ledger line for the "new since previous poll" diff. The
  // ledger is append-only, so name+ts (+latency_ms as a same-second
  // tiebreaker) identifies a line; keys only ever LEAVE the window, so the
  // previous-poll Set stays bounded by the limit — no cumulative growth.
  function rowKey(r) {
    return String(r && r.name) + '|' + String(r && r.ts) + '|' + String(r && r.latency_ms);
  }

  // Rebuild the row list in place (textContent-only). `runs` is the server
  // array (oldest first); `seen` is the previous poll's key Set, or null to
  // seed silently (first poll after mount — no flash storm on spawn/restore).
  // Returns the Set of keys now displayed, which becomes the next `seen`.
  function buildRows(container, runs, seen) {
    const rows = (Array.isArray(runs) ? runs : [])
      .filter((r) => r && typeof r === 'object')
      .slice()
      .reverse(); // server order is oldest-first — display newest first
    // Wiping the container clamps scrollTop to 0; remember the user's place
    // so the 10s rebuild cannot yank a scrolled list back to the top (the
    // browser re-clamps below if the list shrank).
    const prevScroll = container.scrollTop;
    container.textContent = '';
    const keys = new Set();
    if (!rows.length) {
      container.appendChild(el('div', 'rtk-empty', 'No runs yet.'));
      return keys;
    }
    const now = Date.now();
    rows.forEach((r) => {
      const key = rowKey(r);
      keys.add(key);
      const ok = r.status === 'ok';
      const isNew = seen !== null && seen !== undefined && !seen.has(key);
      const row = el('div', 'rtk-row' + (isNew ? (ok ? ' rtk-new-ok' : ' rtk-new-bad') : ''));
      row.append(
        el('span', 'rtk-dot ' + (ok ? 'rtk-ok' : 'rtk-bad')),
        el('span', 'rtk-name', String(r.name == null ? '?' : r.name)),
        el('span', 'rtk-time', relTime(r.ts, now))
      );
      container.appendChild(row);
    });
    container.scrollTop = prevScroll;
    return keys;
  }

  // ── the widget def (shape per widgets.js: label/icon/size/defaultConfig/
  //    fields/render/mount; field objects use `name`, matching buildForm) ─────
  const DEF = {
    label: 'Runs ticker',
    icon: '⇶',
    size: { w: 300, h: 190 },
    defaultConfig: { title: 'Runs ticker', limit: '8' },
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'limit', label: 'Rows (3–20)', type: 'text' },
    ],
    render() {
      // Static shell; the poll fills it. The placeholder doubles as the
      // fresh-machine empty state, so a dead backend still shows something.
      const w = el('div', 'rtk');
      w.appendChild(el('div', 'rtk-empty', 'No runs yet.'));
      return w;
    },
    mount(root, cfg) {
      const limit = clampLimit(cfg && cfg.limit);
      let seen = null;   // null = first poll seeds silently
      let stopped = false;
      const tick = () => {
        api('/runs?limit=' + limit)
          .then((data) => {
            if (stopped || !data || !Array.isArray(data.runs)) return;
            seen = buildRows(root, data.runs, seen);
          })
          .catch(() => { /* backend down: keep last rows, retry next tick */ });
      };
      tick();
      const iv = setInterval(tick, 10000); // contract cadence: 10s
      return () => { stopped = true; clearInterval(iv); };
    },
  };

  A.registerWidget('runsticker', DEF);

  // ── scriptable hook for headless verification ─────────────────────────────
  window.AtelierRunsTicker = { clampLimit, relTime, rowKey, buildRows, DEF };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = A.widgets && typeof A.widgets.has === 'function' && A.widgets.has('runsticker');
    console.assert(ok, '[widget-ticker] runsticker failed to register');
    if (ok) {
      console.log('[widget-ticker] ready — runsticker registered; it appears in the canvas picker automatically.');
    }
  })();
})();
