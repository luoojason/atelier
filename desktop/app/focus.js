'use strict';

/* ===========================================================================
   Atelier feature module — Focus / Calm mode   (app/focus.js)

   A single toggle that quiets the interface for focused, low-stress work. When
   Calm mode is on it dims or hides the non-essential chrome, softens the canvas,
   and reduces motion — leaving the chat card and the cards you are actually
   working in exactly where they were. It also carries a gentle wellbeing
   off-ramp: after a long unbroken stretch it offers, once, "you've been at this
   a while — take a break?" (dismissible, snoozable, never naggy).

   How it quiets the UI WITHOUT touching any other file
   ----------------------------------------------------
   Every piece of fixed chrome already carries a stable class from
   index.html + styles.css:

     • .topbar         top bar (.tb-left icon buttons, .tb-center .search,
                       .tb-right .brand-mark / .brand-name / dial / pills)
     • .sidebar        the 248px left rail
     • .dock           bottom-centre floating dock (.dock-btn children)
     • .minimap        bottom-right overview map
     • .zoombar        bottom-right zoom controls
     • .statusbar      bottom-left backend status line
     • .card-badge     the little "Claude Max" style chips in card bars
     • .widget-card    the living widgets (ring / ticker / pipeline / orbs /
                       burn / heartbeat) — the busiest, most animated surfaces
     • .canvas         the dotted grid (a CSS background on .canvas)
     • .spark          the animated sparkline on the metrics card

   So this module needs no DOM surgery on those elements. It follows the exact
   pattern core.js already uses for `body.sidebar-collapsed .sidebar` and
   palette.js uses for `body.atelier-nogrid`: it injects ONE <style> block that
   targets those existing selectors, scoped under a single `body.calm` class it
   owns. Toggling Calm mode is then just `document.body.classList.toggle('calm')`.
   A module can absolutely inject a stylesheet that restyles selectors it does
   not own — the cascade does not care who wrote the rule.

   What is dimmed vs hidden (deliberate)
   -------------------------------------
     • Hidden      .minimap, .card-badge, .spark — pure decoration / overview.
     • Receded     .dock, .zoombar — dropped to low opacity but RESTORED on
                   hover/focus-within, so they stay one glance away and fully
                   usable; they just stop competing for attention.
     • Softened    .statusbar, the .tb-left icon buttons, the .brand-mark, and
                   the dotted grid on .canvas (lighter dots).
     • Quieted     .widget-card faded back and their motion paused.
   The chat card, its composer, and every content card stay at full strength —
   Calm mode removes noise, not the work.

   Reduced motion
   --------------
   The codebase does not use prefers-reduced-motion anywhere today, so this
   module both honors the OS setting for its OWN affordance (the toggle's
   entrance transition is dropped under `@media (prefers-reduced-motion:
   reduce)`) AND, while Calm mode is on, pauses running animations and shortens
   transitions across the app so nothing pulses or slides. That makes Calm mode
   a manual "reduce motion right now" even for users who have not set the OS
   flag.

   Persistence
   -----------
   The on/off state is persisted through Atelier.store (the sanctioned
   preference API) under 'atelier.calm'; the store prefixes it to
   'atelier:atelier.calm'. NOTE: store keys are board-scoped unless listed in
   boards.js GLOBAL_KEYS — and "quiet the whole app" is a set-once, follow-me-
   everywhere preference, so the host should add 'atelier:atelier.calm' to
   GLOBAL_KEYS (a one-line edit, exactly alongside the existing autonomy /
   slashcommands / premium global keys). See backendNeeded in the handoff. Until
   that line is added the toggle still works perfectly; the state is simply
   remembered per board rather than globally. The break-nudge "last shown" stamp
   is a per-user, board-independent fact, so — like welcome.js's last-seen and
   approvals.js's decisions — it is written straight to raw localStorage.

   Contract: builds only against window.Atelier (A.store, A.bus, A.ui). Injects
   its own CSS. Every dynamic string enters the DOM via textContent. Mounts a
   compact toggle in the topbar (.tb-right, beside the brand — where the autonomy
   dial and approvals pill live) and a ⌘K palette command; never edits
   index.html, core.js, styles.css, or any backend file. Reuses the styles.css
   design tokens. Keyboard + screen-reader accessible; respects
   prefers-reduced-motion. Ends with a selfCheck() console log like the siblings.
   Zero token / rate-limit cost — no network calls at all.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store) {
    console.warn('[focus] Atelier core not available — skipping.');
    return;
  }

  // Preference key persisted through A.store (auto-prefixed to
  // 'atelier:atelier.calm'). See header re: GLOBAL_KEYS for app-wide scope.
  const CALM_KEY = 'atelier.calm';
  // The break-nudge "last shown" stamp is board-independent → raw localStorage.
  const BREAK_STAMP_KEY = 'atelier.focus.last-break-nudge';

  // Wellbeing off-ramp tuning (all local; no network, no cost).
  const WORK_BEFORE_BREAK_MS = 50 * 60 * 1000;   // continuous focused work before the first offer
  const IDLE_RESET_MS        = 5 * 60 * 1000;    // this much quiet resets the "since" clock
  const SNOOZE_MS            = 20 * 60 * 1000;    // "Not now" pushes the next offer out this far
  const BREAK_TICK_MS        = 30 * 1000;         // how often the off-ramp checks (cheap)

  // ── tiny DOM helper (same idiom as the sibling modules) ─────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── stored on/off preference (Atelier.store — see header re: GLOBAL_KEYS) ────
  function loadCalm() {
    try { return A.store.get(CALM_KEY, false) === true; }
    catch { return false; }
  }
  function saveCalm(on) {
    try { A.store.set(CALM_KEY, !!on); }
    catch { /* private mode — the state just won't persist */ }
  }

  let calm = loadCalm();

  // ── injected CSS: the calm skin + this module's own affordance/panel ────────
  // Everything visual lives under `body.calm`, so flipping that one class turns
  // the whole skin on and off. Reuses the styles.css design tokens throughout.
  (function injectStyles() {
    if (document.getElementById('atl-focus-style')) return;
    const css = `
      /* ── the toggle chip in the topbar (mirrors the autonomy dial) ── */
      .atl-focus { display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 999px; padding: 4px 10px; margin-right: 8px; font: inherit;
        font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
        line-height: 1; transition: color .15s ease, border-color .15s ease, background .15s ease; }
      .atl-focus:hover { color: var(--ink); border-color: var(--ink-dim); }
      .atl-focus:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-focus-ic { font-size: 13px; line-height: 1; color: var(--ink-mid); }
      .atl-focus[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent);
        color: var(--accent); }
      .atl-focus[aria-pressed="true"] .atl-focus-ic { color: var(--accent); }

      .atl-focus-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

      /* ── the break off-ramp body (mounted inside core's openPanel card) ── */
      .atl-focus-break { width: 340px; max-width: 80vw; display: flex; flex-direction: column;
        gap: 12px; color: var(--ink); }
      .atl-focus-break-lead { display: flex; gap: 12px; align-items: flex-start; }
      .atl-focus-break-glyph { flex: 0 0 30px; width: 30px; height: 30px; border-radius: 9px;
        display: flex; align-items: center; justify-content: center; font-size: 16px;
        background: var(--accent-soft); color: var(--accent); }
      .atl-focus-break-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .atl-focus-break-head { font-size: 14px; font-weight: 700; color: var(--ink); line-height: 1.35; }
      .atl-focus-break-sub { font-size: 12.5px; color: var(--ink-mid); line-height: 1.5; }
      .atl-focus-break-actions { display: flex; gap: 10px; justify-content: flex-end;
        align-items: center; flex-wrap: wrap; }
      .atl-focus-btn { border: none; border-radius: 10px; background: var(--accent); color: #fff;
        padding: 9px 16px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      .atl-focus-btn:hover { background: var(--accent-2); }
      .atl-focus-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); font-weight: 600; }
      .atl-focus-btn.ghost:hover { border-color: var(--accent); color: var(--ink); background: transparent; }
      .atl-focus-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      /* ═══════════ CALM SKIN — targets existing chrome, scoped to body.calm ══════════ */

      /* Hidden — pure decoration / overview. */
      body.calm .minimap,
      body.calm .card-badge,
      body.calm .spark { display: none !important; }

      /* Receded but still reachable — fade back, restore fully on hover/focus. */
      body.calm .dock,
      body.calm .zoombar {
        opacity: 0.22; transition: opacity .25s ease;
      }
      body.calm .dock:hover, body.calm .dock:focus-within,
      body.calm .zoombar:hover, body.calm .zoombar:focus-within { opacity: 1; }

      /* Softened — present but quiet. */
      body.calm .statusbar { opacity: 0.4; }
      body.calm .tb-left .icon-btn { opacity: 0.5; }
      body.calm .brand-mark { opacity: 0.55; box-shadow: none; }
      body.calm .search { box-shadow: none; }

      /* Softer canvas: lighter dotted grid so the field recedes. */
      body.calm .canvas {
        background-image: radial-gradient(color-mix(in srgb, var(--dot) 45%, transparent) 1.4px, transparent 1.4px);
      }

      /* Living widgets fade back and stop moving; hover restores them. */
      body.calm .widget-card { opacity: 0.5; transition: opacity .25s ease; }
      body.calm .widget-card:hover, body.calm .widget-card:focus-within { opacity: 1; }

      /* Reduce motion while calm: pause running animations, shorten transitions.
         A blanket rule is intentional — Calm mode is a manual "reduce motion
         now". The toggle chip and break panel keep their own short easings via
         the explicit transitions declared above (shorter than this cap). */
      body.calm *, body.calm *::before, body.calm *::after {
        animation-play-state: paused !important;
        transition-duration: .12s !important;
      }

      /* Honor the OS reduced-motion setting for THIS module's own affordance. */
      @media (prefers-reduced-motion: reduce) {
        .atl-focus, body.calm .dock, body.calm .zoombar, body.calm .widget-card {
          transition: none !important;
        }
      }
    `;
    const style = el('style');
    style.id = 'atl-focus-style';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── screen-reader live region ───────────────────────────────────────────────
  let liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = el('div', 'atl-focus-sr');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 30);
  }

  // ── apply / set calm state (class + persist + repaint + publish) ────────────
  function applyCalm() {
    document.body.classList.toggle('calm', calm);
    if (chipEl) {
      chipEl.setAttribute('aria-pressed', calm ? 'true' : 'false');
      chipEl.title = calm ? 'Calm mode is on — click to show everything' : 'Calm mode — quiet the interface';
      chipEl.setAttribute('aria-label', calm ? 'Calm mode on' : 'Calm mode off');
    }
  }
  function setCalm(on, opts) {
    const next = !!on;
    const changed = next !== calm;
    calm = next;
    saveCalm(calm);
    if (api) api.calm = calm;
    applyCalm();
    if (changed) {
      A.bus.emit('focus:changed', { calm });
      announce(calm ? 'Calm mode on. The interface is quieted.' : 'Calm mode off. The full interface is back.');
      if (!(opts && opts.silent) && A.ui && typeof A.ui.toast === 'function') {
        A.ui.toast(calm ? 'Calm mode on' : 'Calm mode off');
      }
    }
    return calm;
  }
  function toggle() { return setCalm(!calm); }

  // ── the topbar toggle chip (compact — the topbar is only ~920px) ────────────
  let chipEl = null;
  function buildChip() {
    const host = document.querySelector('.tb-right');
    if (!host || chipEl) return;
    chipEl = el('button', 'atl-focus');
    chipEl.type = 'button';
    chipEl.setAttribute('aria-pressed', 'false');
    const ic = el('span', 'atl-focus-ic', '☾');   // crescent — a text glyph, not an emoji
    ic.setAttribute('aria-hidden', 'true');
    chipEl.appendChild(ic);
    chipEl.addEventListener('click', () => toggle());
    // Sit just left of the brand name, right of any autonomy dial / approvals pill.
    const brand = host.querySelector('.brand-name');
    if (brand) host.insertBefore(chipEl, brand);
    else host.insertBefore(chipEl, host.firstChild);
    applyCalm();   // reflect restored state on the fresh chip
  }

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'focus.toggle', label: 'Calm mode (quiet the interface)', icon: '☾', section: 'Studio',
      keywords: 'calm focus quiet zen minimal distraction free hide dock minimap dim reduce motion break wellbeing',
      run() { const on = toggle(); if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(on ? 'Calm mode on' : 'Calm mode off'); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);   // covers palette.js loading later

  // ── lifecycle wiring ────────────────────────────────────────────────────────
  A.bus.on('core:ready', () => buildChip());
  // Rebuild the chip if the topbar was re-rendered under us (mirrors autonomy).
  A.bus.on('boards:switched', () => { if (!document.querySelector('.atl-focus')) { chipEl = null; buildChip(); } });
  // core:ready may already have fired before this deferred script ran.
  buildChip();
  applyCalm();   // restore the persisted skin immediately on boot

  // ── wellbeing off-ramp ──────────────────────────────────────────────────────
  // Track a continuous stretch of focused work. Real activity (typing, sending,
  // spawning cards, pointer/keyboard) keeps the clock running; a quiet gap of
  // IDLE_RESET_MS resets "since" so a break offer only follows genuine grind.
  let sinceMs = Date.now();
  let lastActivityMs = Date.now();
  let breakPanel = null;   // { close } from openPanel while an offer is open

  function markActivity() {
    const now = Date.now();
    if (now - lastActivityMs >= IDLE_RESET_MS) sinceMs = now;   // came back from a real break
    lastActivityMs = now;
  }
  ['pointerdown', 'keydown', 'wheel'].forEach((evt) =>
    document.addEventListener(evt, markActivity, { passive: true, capture: true }));
  A.bus.on('chat:sent', markActivity);
  A.bus.on('card:added', markActivity);

  function getBreakStamp() {
    try { const n = Number(window.localStorage.getItem(BREAK_STAMP_KEY)); return isFinite(n) ? n : 0; }
    catch { return 0; }
  }
  function setBreakStamp(ms) {
    try { window.localStorage.setItem(BREAK_STAMP_KEY, String(Math.round(ms))); }
    catch { /* private mode — just won't persist */ }
  }

  function offerBreak() {
    if (breakPanel || !A.ui || typeof A.ui.openPanel !== 'function') return;
    const wrap = el('div', 'atl-focus-break');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Take a break?');

    const lead = el('div', 'atl-focus-break-lead');
    const glyph = el('div', 'atl-focus-break-glyph', '☕');
    glyph.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'atl-focus-break-copy');
    copy.appendChild(el('div', 'atl-focus-break-head', "You've been at this a while."));
    copy.appendChild(el('div', 'atl-focus-break-sub',
      'A short pause — stand up, look away, breathe — keeps the work sharp. Your studio will be right here.'));
    lead.append(glyph, copy);
    wrap.appendChild(lead);

    const actions = el('div', 'atl-focus-break-actions');
    const later = el('button', 'atl-focus-btn ghost', 'Not now');
    later.type = 'button';
    later.addEventListener('click', () => { setBreakStamp(Date.now() - (WORK_BEFORE_BREAK_MS - SNOOZE_MS)); closeBreak(); });
    const ok = el('button', 'atl-focus-btn', 'Take a break');
    ok.type = 'button';
    ok.addEventListener('click', () => { sinceMs = Date.now(); setBreakStamp(Date.now()); closeBreak(); });
    actions.append(later, ok);
    wrap.appendChild(actions);

    breakPanel = A.ui.openPanel('Time for a breather?', wrap, { backdrop: true });
    setBreakStamp(Date.now());   // stamp on show so it never re-fires immediately
    A.bus.emit('focus:break-offered', {});
  }
  function closeBreak() {
    if (breakPanel && typeof breakPanel.close === 'function') { try { breakPanel.close(); } catch {} }
    breakPanel = null;
  }

  function breakTick() {
    try {
      const now = Date.now();
      const worked = now - sinceMs;
      const sinceLastOffer = now - getBreakStamp();
      const idle = now - lastActivityMs;
      // Offer only after a real unbroken stretch, while the user is present
      // (not mid-idle), and not within the snooze window of the last offer.
      if (!breakPanel && worked >= WORK_BEFORE_BREAK_MS && idle < IDLE_RESET_MS &&
          sinceLastOffer >= SNOOZE_MS) {
        offerBreak();
      }
    } catch { /* keep the loop alive */ }
    setTimeout(breakTick, BREAK_TICK_MS);
  }
  setTimeout(breakTick, BREAK_TICK_MS);

  // ── public surface + self-check ─────────────────────────────────────────────
  const api = {
    calm,                                   // plain mirror of state; kept in sync by setCalm
    is: () => calm,
    isOn: () => calm,
    on: () => setCalm(true),
    off: () => setCalm(false),
    set: (v) => setCalm(v),
    toggle,
    // Subscribe to state changes; returns an unsubscribe fn.
    onChange: (cb) => A.bus.on('focus:changed', cb),
    // Surface the off-ramp on demand (a palette command / test hook).
    offerBreak,
    el: () => chipEl,
  };
  window.AtelierFocus = api;

  (function selfCheck() {
    const registered = !!(window.AtelierFocus && typeof window.AtelierFocus.toggle === 'function');
    const styled = !!document.getElementById('atl-focus-style');
    const chipOk = !!document.querySelector('.atl-focus') || !document.querySelector('.tb-right');
    console.assert(registered, '[focus] module did not register window.AtelierFocus');
    console.assert(styled, '[focus] calm stylesheet was not injected');
    if (registered && styled) {
      console.log('[focus] self-check passed — calm mode ready (state "' + (calm ? 'on' : 'off') +
        '", chip ' + (chipOk ? 'mounted' : 'pending topbar') + ', palette + AtelierFocus.toggle, ' +
        'break off-ramp after ' + Math.round(WORK_BEFORE_BREAK_MS / 60000) + 'm).');
    }
  })();
})();
