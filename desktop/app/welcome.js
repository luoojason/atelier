'use strict';

/* ===========================================================================
   Atelier feature module — Welcome-back digest   (app/welcome.js)

   A warm "here's what happened while you were away" recap. When you open the
   app (or come back to a window you left sitting) and meaningful things have
   happened since you last looked, a single friendly panel opens once and lists
   them in plain language:

     • Runs that finished        (GET /runs, status === "ok")
     • Anything that needs you    (runs that errored + items waiting to approve)
     • Videos that rendered       (new .mp4/.mov/.webm in the workspace, playable)
     • Other files that were made (a generic count so nothing is a surprise)
     • What's still working now    (running sessions — "picking up where it left off")

   It is a moment, not a HUD: it shows once, is fully dismissible, and marks
   everything as seen so it never nags. You can re-summon it any time from the
   ⌘K palette ("What happened while I was away") or window.AtelierWelcome.open().

   Why a floating panel (not an overlay)
   -------------------------------------
   Like render.js, this mounts through core's A.ui.openPanel (draggable card,
   working ×, click-off backdrop, Escape closes it) so there is no hand-rolled
   backdrop or focus trap to keep correct.

   Why raw localStorage for "last seen" (not A.store)
   --------------------------------------------------
   "Last time I looked" is a per-user, board-independent fact. A.store keys are
   board-scoped unless whitelisted in boards.js GLOBAL_KEYS, so — exactly like
   approvals.js keeps its remembered decisions out of A.store — the last-seen
   stamp is read/written straight to window.localStorage under a stable key.

   Data sources (all already live; no new backend needed)
   ------------------------------------------------------
     • GET /runs?limit=N        → finished + errored runs (record.ts, status, error)
     • GET /workspace/files     → rendered outputs (mtime in epoch seconds)
     • GET /sessions            → count of sessions still running
     • window.AtelierApprovals  → pendingCount() + open() for the review lane

   Timestamps: run-record ts is naive LOCAL ISO (new Date(ts) parses as local),
   workspace mtime is epoch seconds (×1000); both compare cleanly to a
   Date.now()-based last-seen. GET routes are open (the token middleware gates
   only mutating methods) but the X-Atelier-Token header is sent harmlessly
   like every sibling.

   Contract: builds only against window.Atelier (+ fetch and the optional
   window.atelier token bridge). Injects its own CSS. XSS rule: every dynamic
   string (run names, error text, file paths) enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui || typeof A.ui.openPanel !== 'function') {
    console.warn('[welcome] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const LAST_SEEN_KEY = 'atelier.welcome.last-seen';   // raw localStorage, epoch ms
  const RUNS_LIMIT = 50;                                // recent runs to scan
  const MAX_LIST = 4;                                   // names shown before "+N more"
  const REVISIT_MS = 5 * 60 * 1000;                     // re-open after this hidden span
  const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;

  // ── tiny DOM helper (same idiom as the sibling modules) ─────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function baseName(path) {
    const p = String(path || '');
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  }

  // ── last-seen stamp (raw localStorage; board-independent) ───────────────────
  function getLastSeen() {
    try {
      const raw = window.localStorage.getItem(LAST_SEEN_KEY);
      if (raw == null) return null;                     // first-ever run
      const n = Number(raw);
      return isFinite(n) ? n : null;
    } catch { return null; }
  }
  function setLastSeen(ms) {
    try { window.localStorage.setItem(LAST_SEEN_KEY, String(Math.round(ms))); }
    catch { /* private mode — just won't persist */ }
  }

  // ── guarded backend helper (token header; never throws) ─────────────────────
  async function api(path, opts) {
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
      let data = null;
      try { data = await res.json(); } catch { /* empty / non-JSON */ }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  // ── friendly time phrasing ──────────────────────────────────────────────────
  function fmtAway(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return 'a moment';
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour' : ' hours');
    const d = Math.round(h / 24);
    return d + (d === 1 ? ' day' : ' days');
  }

  // ── gather what happened since `since` (epoch ms) ───────────────────────────
  async function gather(since) {
    const [runsR, filesR, sessR] = await Promise.all([
      api('/runs?limit=' + RUNS_LIMIT),
      api('/workspace/files'),
      api('/sessions'),
    ]);

    const digest = {
      finished: [],   // run names that finished ok
      errored: [],    // { name, error } for runs that failed
      videos: [],     // { path, name } for new video files
      otherFiles: 0,  // count of other new files
      running: 0,     // sessions running right now
      waiting: 0,     // items in the approvals lane
    };

    const runs = runsR && runsR.data && Array.isArray(runsR.data.runs) ? runsR.data.runs : [];
    for (const r of runs) {
      if (!r || !r.ts) continue;
      const t = new Date(r.ts).getTime();
      if (!isFinite(t) || t <= since) continue;
      if (r.status === 'ok') {
        if (r.name) digest.finished.push(String(r.name));
      } else {
        digest.errored.push({ name: String(r.name || 'a run'), error: r.error ? String(r.error) : '' });
      }
    }

    const files = filesR && filesR.data && Array.isArray(filesR.data.files) ? filesR.data.files : [];
    for (const f of files) {
      if (!f || !f.path) continue;
      const t = (Number(f.mtime) || 0) * 1000;
      if (t <= since) continue;
      if (VIDEO_RE.test(f.path)) digest.videos.push({ path: String(f.path), name: baseName(f.path) });
      else digest.otherFiles += 1;
    }

    const sessions = sessR && sessR.data && Array.isArray(sessR.data.sessions) ? sessR.data.sessions : [];
    // Count top-level running sessions only, so sub-agents don't double-count.
    digest.running = sessions.filter((s) => s && s.status === 'running' && s.parent_id == null).length;

    const appr = window.AtelierApprovals;
    if (appr && typeof appr.pendingCount === 'function') {
      try { digest.waiting = Number(appr.pendingCount()) || 0; } catch { digest.waiting = 0; }
    }

    digest.hasNews = !!(digest.finished.length || digest.errored.length ||
      digest.videos.length || digest.otherFiles || digest.waiting);
    return digest;
  }

  // ── injected CSS (design tokens from styles.css) ────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-welcome-styles')) return;
    const css = `
      .atl-welcome { width: 420px; max-width: 82vw; display: flex; flex-direction: column;
        gap: 16px; color: var(--ink); }
      .atl-welcome-sub { font-size: 12.5px; color: var(--ink-mid); line-height: 1.5; margin-top: -6px; }

      .atl-welcome-list { display: flex; flex-direction: column; gap: 11px; }

      .atl-welcome-item { display: flex; gap: 11px; align-items: flex-start; }
      .atl-welcome-glyph { flex: 0 0 26px; width: 26px; height: 26px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center; font-size: 14px;
        background: var(--accent-soft); color: var(--accent); margin-top: 1px; }
      .atl-welcome-item.attn .atl-welcome-glyph { background: #f6e7cf; color: #b07615; }
      .atl-welcome-item.calm .atl-welcome-glyph { background: var(--active); color: var(--ink-mid); }
      .atl-welcome-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .atl-welcome-head { font-size: 13.5px; font-weight: 700; color: var(--ink); line-height: 1.35; }
      .atl-welcome-detail { font-size: 12px; color: var(--ink-mid); line-height: 1.45;
        word-break: break-word; }
      .atl-welcome-detail .nm { color: var(--ink); font-weight: 600; }

      .atl-welcome-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
      .atl-welcome-chip { border: 1px solid var(--border); background: var(--panel);
        color: var(--ink); border-radius: 999px; padding: 4px 11px; font: inherit;
        font-size: 11.5px; font-weight: 600; cursor: pointer; max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-welcome-chip:hover { border-color: var(--accent); color: var(--accent); }
      .atl-welcome-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      .atl-welcome-empty { display: flex; flex-direction: column; gap: 6px; align-items: center;
        text-align: center; padding: 14px 4px 6px; }
      .atl-welcome-empty .big { font-size: 26px; line-height: 1; }
      .atl-welcome-empty .msg { font-size: 13.5px; font-weight: 700; color: var(--ink); }
      .atl-welcome-empty .sub { font-size: 12px; color: var(--ink-mid); line-height: 1.5; }

      .atl-welcome-actions { display: flex; gap: 10px; justify-content: flex-end;
        align-items: center; flex-wrap: wrap; }
      .atl-welcome-btn { border: none; border-radius: 10px; background: var(--accent); color: #fff;
        padding: 9px 16px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      .atl-welcome-btn:hover { background: var(--accent-2); }
      .atl-welcome-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); font-weight: 600; }
      .atl-welcome-btn.ghost:hover { border-color: var(--accent); color: var(--ink); background: transparent; }
      .atl-welcome-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    `;
    const style = el('style');
    style.id = 'atl-welcome-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── panel state ─────────────────────────────────────────────────────────────
  let panelRef = null;    // { el, body, close } from openPanel

  function panelAlive() {
    return !!(panelRef && panelRef.el && panelRef.el.isConnected);
  }

  // Build one digest line (glyph + heading + optional detail nodes).
  function item(glyph, tone, head, detailNodes) {
    const row = el('div', 'atl-welcome-item' + (tone ? ' ' + tone : ''));
    const g = el('div', 'atl-welcome-glyph', glyph);
    g.setAttribute('aria-hidden', 'true');
    const body = el('div', 'atl-welcome-body');
    body.appendChild(el('div', 'atl-welcome-head', head));
    (detailNodes || []).forEach((n) => n && body.appendChild(n));
    row.append(g, body);
    return row;
  }

  // A comma list of names, capped, as a single detail node (textContent-only).
  function namesDetail(names) {
    const shown = names.slice(0, MAX_LIST);
    const extra = names.length - shown.length;
    const d = el('div', 'atl-welcome-detail');
    shown.forEach((nm, i) => {
      if (i) d.appendChild(document.createTextNode(', '));
      d.appendChild(el('span', 'nm', nm));
    });
    if (extra > 0) d.appendChild(document.createTextNode(' and ' + extra + ' more'));
    return d;
  }

  function buildBody(digest, awayMs) {
    const wrap = el('div', 'atl-welcome');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'What happened while you were away');

    if (!digest.hasNews) {
      const empty = el('div', 'atl-welcome-empty');
      empty.setAttribute('role', 'status');
      const big = el('div', 'big', '☀');
      big.setAttribute('aria-hidden', 'true');
      empty.append(big, el('div', 'msg', 'You are all caught up.'));
      empty.appendChild(el('div', 'sub', digest.running
        ? (digest.running === 1 ? 'One agent is working right now.' : digest.running + ' agents are working right now.')
        : 'Nothing new since you last looked in.'));
      wrap.appendChild(empty);
      const actions = el('div', 'atl-welcome-actions');
      const ok = el('button', 'atl-welcome-btn', 'Got it');
      ok.type = 'button';
      ok.addEventListener('click', close);
      actions.appendChild(ok);
      wrap.appendChild(actions);
      return wrap;
    }

    wrap.appendChild(el('div', 'atl-welcome-sub',
      'You were away about ' + fmtAway(awayMs) + '. Here is what happened.'));

    const list = el('div', 'atl-welcome-list');

    // Runs that finished.
    if (digest.finished.length) {
      const n = digest.finished.length;
      list.appendChild(item('✓', null,
        n === 1 ? '1 run finished' : n + ' runs finished',
        [namesDetail(digest.finished)]));
    }

    // Runs that errored — needs attention.
    if (digest.errored.length) {
      const n = digest.errored.length;
      const details = [];
      digest.errored.slice(0, MAX_LIST).forEach((e) => {
        const d = el('div', 'atl-welcome-detail');
        d.appendChild(el('span', 'nm', e.name));
        if (e.error) d.appendChild(document.createTextNode(' — ' + e.error));
        details.push(d);
      });
      const extra = digest.errored.length - Math.min(MAX_LIST, digest.errored.length);
      if (extra > 0) details.push(el('div', 'atl-welcome-detail', 'and ' + extra + ' more'));
      list.appendChild(item('!', 'attn',
        n === 1 ? '1 run needs attention' : n + ' runs need attention', details));
    }

    // Waiting for approval.
    if (digest.waiting) {
      const n = digest.waiting;
      const chips = el('div', 'atl-welcome-chips');
      const review = el('button', 'atl-welcome-chip', 'Open the review lane');
      review.type = 'button';
      review.addEventListener('click', () => {
        const appr = window.AtelierApprovals;
        if (appr && typeof appr.open === 'function') appr.open();
      });
      chips.appendChild(review);
      list.appendChild(item('◷', 'attn',
        n === 1 ? '1 thing is waiting for you to approve' : n + ' things are waiting for you to approve',
        [chips]));
    }

    // Videos rendered — each playable.
    if (digest.videos.length) {
      const n = digest.videos.length;
      const chips = el('div', 'atl-welcome-chips');
      digest.videos.slice(0, 6).forEach((v) => {
        const b = el('button', 'atl-welcome-chip', v.name || 'video');
        b.type = 'button';
        b.title = v.name || v.path;
        b.addEventListener('click', () => openFile(v.path));
        chips.appendChild(b);
      });
      list.appendChild(item('▶', null,
        n === 1 ? '1 video rendered' : n + ' videos rendered',
        [el('div', 'atl-welcome-detail', 'Click to play it in your browser.'), chips]));
    }

    // Other files written.
    if (digest.otherFiles) {
      const n = digest.otherFiles;
      list.appendChild(item('◫', 'calm',
        n === 1 ? '1 other file was written' : n + ' other files were written', []));
    }

    wrap.appendChild(list);

    // Footer: what's still running + dismiss.
    const actions = el('div', 'atl-welcome-actions');
    if (digest.running) {
      const still = el('div', 'atl-welcome-detail');
      still.style.flex = '1';
      still.textContent = digest.running === 1
        ? 'One agent is still working — picking up where it left off.'
        : digest.running + ' agents are still working — picking up where they left off.';
      actions.appendChild(still);
    }
    const done = el('button', 'atl-welcome-btn', 'Got it');
    done.type = 'button';
    done.addEventListener('click', close);
    actions.appendChild(done);
    wrap.appendChild(actions);

    return wrap;
  }

  // Open a workspace file (video) in a new tab via the raw endpoint.
  function openFile(path) {
    const url = BASE + '/workspace/raw?path=' + encodeURIComponent(path);
    try { window.open(url, '_blank'); } catch { /* popup blocked — ignore */ }
  }

  function ensurePanel(node) {
    if (panelAlive()) {
      panelRef.body.textContent = '';
      panelRef.body.appendChild(node);
      return;
    }
    panelRef = A.ui.openPanel('While you were away', node, { backdrop: true });
  }

  // ── open / close ────────────────────────────────────────────────────────────
  // open(force): force=true always shows (empty → "all caught up"); force=false
  // (the auto path) only opens when there is news. Either way, opening marks
  // everything up to now as seen so it does not re-fire.
  async function open(force) {
    const since = getLastSeen();
    // First-ever run: seed the stamp and show nothing (avoid a giant first dump).
    if (since == null) {
      setLastSeen(Date.now());
      if (!force) return;
    }
    const base = since == null ? Date.now() : since;
    const digest = await gather(base);
    if (!digest.hasNews && !force) return;          // nothing new, auto path — stay quiet
    const node = buildBody(digest, Date.now() - base);
    ensurePanel(node);
    setLastSeen(Date.now());                         // mark this recap as seen
  }

  function close() {
    if (panelRef && typeof panelRef.close === 'function') { try { panelRef.close(); } catch {} }
    panelRef = null;
  }

  // ── triggers ────────────────────────────────────────────────────────────────
  // Primary: the module running IS the app-open signal (fresh page load).
  function mount() { open(false); }

  // Secondary: user left a window sitting and came back after a while.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (document.visibilityState === 'visible' && hiddenAt && !panelAlive()) {
      if (Date.now() - hiddenAt >= REVISIT_MS) open(false);
    }
    hiddenAt = 0;
  });

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'welcome.open', label: 'What happened while I was away', icon: '☀', section: 'Studio',
      keywords: 'welcome back digest recap away summary handoff caught up news',
      run() { open(true); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);   // covers palette.js loading later

  // Build after core is ready (a deferred script may load either side of it).
  A.bus.on('core:ready', () => setTimeout(mount, 0));
  setTimeout(mount, 0);

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierWelcome = {
    open: () => open(true),
    close,
    isOpen: () => panelAlive(),
  };

  (function selfCheck() {
    const registered = !!(window.AtelierWelcome && typeof window.AtelierWelcome.open === 'function');
    const builders = typeof gather === 'function' && typeof buildBody === 'function';
    console.assert(registered, '[welcome] module did not register window.AtelierWelcome');
    console.assert(builders, '[welcome] digest builders missing');
    if (registered && builders) {
      console.log('[welcome] self-check passed — welcome-back digest ready (palette + AtelierWelcome.open, ' +
        'scans /runs + /workspace/files + /sessions + approvals).');
    }
  })();
})();
