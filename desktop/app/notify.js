'use strict';

/* ===========================================================================
   Atelier feature module — Walk-away notifications   (app/notify.js)

   Lets a user step away from the studio and get pulled back at the two moments
   that actually need them:

     1) A run FINISHED — a top-level agent session flipped running -> idle.
     2) Something NEEDS APPROVAL — the approvals lane (approvals.js) grew.

   When that happens and the app is in the background, this fires a real
   desktop notification (native macOS banner in the packaged app). Clicking it
   raises the app and takes you to the thing: the finished run's card, or the
   approvals lane.

   Opt-in, quiet by default
   ------------------------
   Desktop banners are intrusive, so this ships OFF. A small "Notify" pill in
   the topbar turns it on; that click is the user gesture we use to politely
   request notification permission. The preference persists in Atelier.store
   under 'notify.enabled'. If permission is blocked at the OS level we say so
   once and leave the toggle off rather than pretending it worked.

   Never spams a watching user
   ---------------------------
   A banner only fires when document.hasFocus() === false — if you are looking
   at the canvas you already see the HUD and the Approvals pill, so no banner.
   The one exception is a single confirmation banner the moment you enable it,
   so you know it works. When a finish and an approval land in the same tick the
   approval wins (it is the more actionable one) and the finish banner is
   suppressed, since they are usually the same run.

   How it detects events (frontend-only, no backend, no new bridge)
   ----------------------------------------------------------------
   There is no central run bus, so this mirrors approvals.js / cost.js: it polls
   GET /sessions on a light, token-free cadence and watches each top-level
   session cross running -> not-running. For approvals it reads the in-memory
   window.AtelierApprovals.pendingCount() each tick and pings when it grows.
   Both are seeded silently on the first pass so existing runs / pending items
   never fire on load. Firing uses the browser-native Notification API, which
   Electron maps to native notifications — no preload bridge, no /health poll,
   no route, no main.js change.

   Boundaries: window.Atelier (bus/store/ui) + the optional window.atelier token
   bridge for reads + the standard Notification API. Every dynamic string enters
   the DOM via textContent. Injects its own CSS, reuses styles.css design tokens,
   keyboard + screen-reader accessible, respects prefers-reduced-motion, and ends
   with a selfCheck() console log like its siblings.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store) {
    console.warn('[notify] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 2000;                 // session/approval poll cadence (token-free)
  const ENABLED_KEY = 'notify.enabled'; // Atelier.store: opt-in flag (default false)

  const supported = typeof window.Notification === 'function';

  // ── tiny DOM helper (same idiom as the sibling modules) ────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── stored preference ───────────────────────────────────────────────────────
  function isEnabled() { return A.store.get(ENABLED_KEY, false) === true; }
  function setEnabledFlag(v) { A.store.set(ENABLED_KEY, !!v); }

  function permission() {
    return supported ? window.Notification.permission : 'denied';
  }

  // ── guarded backend read (prefer the token bridge; never throws) ────────────
  // Same shape as approvals.js apiGet — the window.atelier bridge dodges the
  // page CSP origin allow-list; the fetch path is the fallback.
  async function apiGet(path) {
    try {
      if (window.atelier && typeof window.atelier.get === 'function') {
        return await window.atelier.get(path);
      }
    } catch {
      return null;
    }
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ── screen-reader live region (announces state changes for keyboard users) ──
  let liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = el('div', 'atl-notify-sr');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 30);
  }

  function toast(msg) {
    if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(msg);
  }

  // ── firing a banner ─────────────────────────────────────────────────────────
  // Keep a reference to each open notification so its click handler survives GC
  // and so a newer banner with the same tag visibly replaces the old one.
  const live = new Map();  // tag -> Notification

  function fire(tag, title, body, onClick) {
    if (!supported || permission() !== 'granted') return null;
    let n;
    try {
      n = new window.Notification(title, { body: body, tag: tag });
    } catch {
      return null;  // some environments throw if construction is disallowed
    }
    const prev = live.get(tag);
    if (prev && prev !== n) { try { prev.close(); } catch {} }
    live.set(tag, n);
    n.onclick = () => {
      // Raise the app window (best-effort in the renderer) and route to the thing.
      try { window.focus(); } catch {}
      try { if (typeof onClick === 'function') onClick(); } catch {}
      try { n.close(); } catch {}
      if (live.get(tag) === n) live.delete(tag);
    };
    n.onclose = () => { if (live.get(tag) === n) live.delete(tag); };
    return n;
  }

  // Only fire when the user is elsewhere — a focused user already sees the HUD
  // and the Approvals pill, so a banner would just be noise.
  function awayFromApp() {
    try { return document.hasFocus && document.hasFocus() === false; }
    catch { return true; }
  }

  // ── routing on click ────────────────────────────────────────────────────────
  function revealRun(sessionId, name) {
    const S = window.AtelierSessions;
    if (S && typeof S.reveal === 'function' && sessionId != null) {
      try { S.reveal(sessionId, name); return; } catch {}
    }
    // Fall back to the approvals lane if the card system is unavailable.
    openApprovals();
  }
  function openApprovals() {
    const Ap = window.AtelierApprovals;
    if (Ap && typeof Ap.open === 'function') { try { Ap.open(); } catch {} }
  }

  // ── detector 1: run finished (running -> not-running on a top-level session) ─
  const sessionStatus = new Map();  // id -> last seen status
  const sessionName = new Map();     // id -> name (for the banner + reveal)
  let sessionsSeeded = false;

  async function pollSessions() {
    const d = await apiGet('/sessions');
    const sessions = (d && Array.isArray(d.sessions)) ? d.sessions : [];
    const finished = [];
    sessions.forEach((s) => {
      if (!s || s.id == null) return;
      if (s.name != null) sessionName.set(s.id, s.name);
      const prev = sessionStatus.get(s.id);
      const now = s.status;
      const topLevel = s.parent_id == null;   // don't ping for each child turn
      // Maintain the map whether enabled or not, so turning notifications on
      // never retroactively fires for edges that happened while they were off.
      if (sessionsSeeded && prev === 'running' && now !== 'running' && topLevel) {
        finished.push(s.id);
      }
      sessionStatus.set(s.id, now);
    });
    sessionsSeeded = true;
    return finished;
  }

  // ── detector 2: approvals lane grew ─────────────────────────────────────────
  let lastApprovalCount = null;  // null until first read (seeds silently)

  function pollApprovals() {
    const Ap = window.AtelierApprovals;
    if (!Ap || typeof Ap.pendingCount !== 'function') return 0;
    let n = 0;
    try { n = Ap.pendingCount() | 0; } catch { return 0; }
    if (lastApprovalCount == null) { lastApprovalCount = n; return 0; }  // seed
    const grew = Math.max(0, n - lastApprovalCount);
    lastApprovalCount = n;
    return grew;
  }

  // ── the tick that ties them together ────────────────────────────────────────
  async function tick() {
    let finished = [];
    try { finished = await pollSessions(); } catch { finished = []; }
    let approvalDelta = 0;
    try { approvalDelta = pollApprovals(); } catch { approvalDelta = 0; }

    if (!isEnabled() || !awayFromApp()) return;

    if (approvalDelta > 0) {
      // Approval wins the tick — suppress the finish banner (usually the same run).
      const total = (window.AtelierApprovals && window.AtelierApprovals.pendingCount)
        ? window.AtelierApprovals.pendingCount() : approvalDelta;
      const body = total === 1
        ? 'One item is waiting for your approval.'
        : total + ' items are waiting for your approval.';
      fire('atl-notify-approvals', 'Ready for your review', body, openApprovals);
      return;
    }

    if (finished.length) {
      const id = finished[finished.length - 1];       // most recent finish
      const name = sessionName.get(id) || 'A run';
      const body = finished.length === 1
        ? name + ' has finished.'
        : finished.length + ' runs have finished (' + name + ' and others).';
      fire('atl-notify-run-' + id, 'Run finished', body, () => revealRun(id, name));
    }
  }

  // ── enable / disable ────────────────────────────────────────────────────────
  async function enable() {
    if (!supported) {
      toast('Desktop notifications are not available here.');
      return false;
    }
    let perm = permission();
    if (perm === 'default') {
      try { perm = await window.Notification.requestPermission(); }
      catch { perm = permission(); }
    }
    if (perm !== 'granted') {
      toast('Notifications are blocked — enable them for Atelier in system settings.');
      setEnabledFlag(false);
      updatePill();
      announce('Notifications stayed off — permission was not granted.');
      return false;
    }
    setEnabledFlag(true);
    updatePill();
    announce('Notifications on — you will be pinged when a run finishes or needs approval.');
    // A single confirmation banner (the one time we fire while focused) so the
    // user sees it works.
    fire('atl-notify-hello', 'Notifications on',
      'You can walk away — Atelier will ping you when a run finishes or needs approval.',
      () => {});
    return true;
  }

  function disable() {
    setEnabledFlag(false);
    // Close anything still on screen.
    live.forEach((n) => { try { n.close(); } catch {} });
    live.clear();
    updatePill();
    announce('Notifications off.');
  }

  function toggleEnabled() { if (isEnabled()) disable(); else enable(); }

  // ── injected CSS (reuses styles.css design tokens) ─────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-notify-styles')) return;
    const css = `
      .atl-notify-pill { display: inline-flex; align-items: center; gap: 7px;
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 999px; padding: 5px 12px 5px 10px; font: inherit; font-size: 12.5px;
        font-weight: 600; cursor: pointer; margin-right: 10px; }
      .atl-notify-pill:hover { color: var(--ink); border-color: var(--accent); }
      .atl-notify-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-notify-pill .ic { font-size: 13px; line-height: 1; }
      .atl-notify-pill .st { font-size: 11px; font-weight: 700; color: var(--ink-dim); }
      .atl-notify-pill.on { color: var(--ink); border-color: var(--accent); }
      .atl-notify-pill.on .ic { color: var(--accent); }
      .atl-notify-pill.on .st { color: var(--accent); }
      .atl-notify-pill.unsupported { opacity: .5; cursor: default; }

      .atl-notify-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    `;
    const style = el('style');
    style.id = 'atl-notify-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── topbar pill (persistent affordance) ─────────────────────────────────────
  let pillEl = null;
  let pillStateEl = null;
  function buildPill() {
    const host = document.querySelector('.tb-right');
    if (!host || pillEl) return;
    pillEl = el('button', 'atl-notify-pill');
    pillEl.type = 'button';
    // '◔' — a geometric glyph in the sibling style (approvals '✓', hud '◧'); no emoji.
    pillEl.appendChild(el('span', 'ic', '◔'));
    pillEl.appendChild(el('span', null, 'Notify'));
    pillStateEl = el('span', 'st', '');
    pillEl.appendChild(pillStateEl);
    if (!supported) {
      pillEl.classList.add('unsupported');
      pillEl.title = 'Desktop notifications are not available here';
      pillEl.disabled = true;
    } else {
      pillEl.addEventListener('click', toggleEnabled);
    }
    // Sit to the left of the brand name/mark (same host the Approvals pill uses).
    host.insertBefore(pillEl, host.firstChild);
    updatePill();
  }

  function updatePill() {
    if (!pillEl) return;
    const on = supported && isEnabled() && permission() === 'granted';
    pillEl.classList.toggle('on', on);
    if (pillStateEl) pillStateEl.textContent = supported ? (on ? 'On' : 'Off') : 'n/a';
    pillEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    pillEl.setAttribute('aria-label', !supported
      ? 'Desktop notifications unavailable'
      : on
        ? 'Notify me when something is ready — on. Click to turn off.'
        : 'Notify me when something is ready — off. Click to turn on and get pinged when a run finishes or needs approval.');
    pillEl.title = !supported
      ? 'Notifications unavailable'
      : on ? 'Notifications on — click to turn off' : 'Notify me when something’s ready';
  }

  // ── ⌘K palette command ──────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'notify.toggle', label: 'Notify me when something’s ready', icon: '◔', section: 'Studio',
      keywords: 'notify notification alert banner desktop walk away done finished approval ready ping',
      run() { toggleEnabled(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);

  // ── lifecycle wiring (mirrors cost.js / approvals.js) ───────────────────────
  A.bus.on('core:ready', () => buildPill());
  // Rebuild the pill if the topbar was re-rendered under us (defensive).
  A.bus.on('boards:switched', () => {
    if (!document.querySelector('.atl-notify-pill')) { pillEl = null; buildPill(); }
    else updatePill();
  });
  // core:ready may have already fired before this deferred script ran.
  buildPill();

  // ── polling loop (token-free; keeps state seeded even while disabled) ───────
  let pollTimer = null;
  async function loop() {
    try { await tick(); } catch { /* keep the loop alive */ }
    pollTimer = setTimeout(loop, POLL_MS);
  }
  loop();

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierNotify = {
    isEnabled,
    enable,
    disable,
    toggle: toggleEnabled,
    supported: () => supported,
    permission,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierNotify && typeof window.AtelierNotify.enable === 'function');
    const pillOk = !!document.querySelector('.atl-notify-pill') || !document.querySelector('.tb-right');
    console.assert(registered, '[notify] module did not register window.AtelierNotify');
    if (registered) {
      console.log('[notify] self-check passed — walk-away notifications ready (' +
        (supported ? 'supported, ' + (isEnabled() ? 'on' : 'off') + ', permission ' + permission() : 'unsupported') +
        ', pill ' + (pillOk ? 'mounted' : 'pending topbar') + ').');
    }
  })();
})();
