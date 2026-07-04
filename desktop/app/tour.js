'use strict';

/* ===========================================================================
   Atelier feature module — onboarding tour   (app/tour.js)

   A spotlight tour over the REAL UI (no screenshots, no fake mocks). One
   fixed full-viewport overlay (z-index 9500 — above floating panels at 9000,
   below toasts at 9999) uses the box-shadow cutout technique: a transparent
   highlight box is positioned over the current anchor element and carries an
   enormous rgba(30,24,16,0.55) outer shadow, dimming everything except the
   anchor. A popover sits beside the highlight with the step title, body,
   an "i / n" counter, and Back / Next / Skip buttons. Escape = skip.

   LOOK-ONLY TOUR: the overlay layer spans the viewport with pointer-events
   enabled, so clicks anywhere outside the popover are absorbed and the
   anchored UI underneath is NOT interactive while the tour runs. Only the
   popover's buttons respond. The keyboard is covered too: while active,
   Escape skips and every other key is swallowed (capture phase) except a
   plain Enter/Space aimed at a popover button, so shortcuts like ⌘K
   (palette, z-index 10000) or Delete (card removal) cannot drive the UI
   mid-tour — even while a popover button holds focus. start() also closes
   any open view overlay (Settings/Analytics) so the anchors are visible.

   Steps anchor to live selectors; any step whose selector matches nothing at
   start (or vanished by the time it shows) is skipped gracefully, so the
   tour works no matter which optional modules loaded. The final step has no
   anchor: a centered popover over a uniform dim.

   Auto-start once: if the RAW localStorage key 'atelier-tour-done' is absent
   the tour starts 1500ms after core is ready. Finish or skip writes '1' to
   that key. The key is RAW localStorage on purpose — NOT Atelier.store and
   NOT the 'atelier:' prefix — so board snapshots (which sweep 'atelier:*'
   keys) never carry the flag between boards or reset it on board switches.

   Publishes window.Atelier.tour = { start(), active() } (views.js's Settings
   "Restart tour" row calls start()). The highlight/popover positions are
   recomputed on window resize while active. Teardown removes the single
   overlay element plus both window listeners — nothing leaks.

   Contract: builds ONLY against window.Atelier (bus) + the DOM. Injects its
   own CSS. Loads after core.js (the orchestrator owns the index.html tag).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. localStorage.removeItem('atelier-tour-done'); reload. ~1.5s after boot
      the overlay appears: the canvas is spotlit, everything else dimmed, a
      popover shows "1 / 10" (fewer if optional modules are absent) with
      Next / Skip (no Back on step 1).
   2. Click Next through the steps — dock, ⌘K search, Dashboards group, the
      "+ widget" button, zoombar, Chat dock button, Analytics group, the
      Settings footer row; the cutout glides between anchors and the popover
      stays inside the viewport. Back walks the same path in reverse.
   3. While the tour is up, click a dock button or the canvas — nothing
      happens (look-only). Click Skip (or press Escape) — the overlay is
      gone, document.querySelector('.atl-tour') === null, and
      localStorage.getItem('atelier-tour-done') === '1'. Reload: no auto
      tour.
   4. Last step: a centered "That is the studio — build something." popover;
      the Next button reads Finish and ends the tour (flag written).
   5. Settings → Appearance → "Restart tour" (views.js row) — the tour runs
      again from step 1 even though the done-flag is set.
   6. Resize the window mid-tour — the cutout and popover track the anchor.
   7. Console shows "[tour] self-check passed" and no assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus) {
    console.warn('[tour] window.Atelier not found — tour disabled. Load order: core.js first.');
    return;
  }

  const DONE_KEY = 'atelier-tour-done'; // RAW localStorage — see header comment
  const Z_TOUR = 9500;                  // panels 9000 < tour 9500 < toasts 9999
  const PAD = 6;                        // cutout breathing room around the anchor
  const GAP = 14;                       // popover distance from the cutout
  const EDGE = 12;                      // popover viewport margin

  // ── steps ──────────────────────────────────────────────────────────────────
  // sel: anchor selector (null = final centered popover). Steps whose selector
  // matches nothing are dropped at start() — the counter renumbers over the
  // survivors. ':not(.vw-nav)' keeps step 4 off the views-owned Analytics
  // group, which is also a .sb-group and gets its own step below.
  const STEPS = [
    { sel: '#canvas', title: 'Canvas', body: 'Your studio canvas — pan, zoom, arrange cards' },
    { sel: '.dock', title: 'Dock', body: 'Open a chat, browser, notes, or a helper' },
    { sel: '.topbar .search', title: 'Search', body: '⌘K — search apps, cards, boards' },
    { sel: '.sidebar .sb-group:not(.vw-nav)', title: 'Boards', body: 'Boards — separate studios, switched in place' },
    { sel: '.wgt-add-btn', title: 'Widgets', body: 'Live widgets — metrics, charts, and (soon) living dials' },
    { sel: '.zoombar', title: 'Zoombar', body: 'Fit ⤢, tidy ✦, minimap ▣' },
    { sel: '[title="Chat"]', title: 'Agents', body: 'Chat: each press opens a new chat, and a chat can create helpers that appear beside it' },
    { sel: '.vw-nav', title: 'Analytics', body: 'Your token usage and cost over time' },
    { sel: '.sb-foot .sb-row', title: 'Settings', body: 'Choose subscription or API key, pick an AI, and sign in' },
    { sel: null, title: 'Ready', body: 'That is the studio — build something.' },
  ];

  // ── styles (module-own; never styles.css) ─────────────────────────────────
  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .atl-tour { position: fixed; inset: 0; z-index: ${Z_TOUR}; overflow: hidden; }
      .atl-tour.atl-tour-nohl { background: rgba(30, 24, 16, 0.55); }
      .atl-tour-hl { position: absolute; border-radius: 10px;
        box-shadow: 0 0 0 200vmax rgba(30, 24, 16, 0.55);
        transition: left .25s ease, top .25s ease, width .25s ease, height .25s ease; }
      .atl-tour-pop { position: absolute; width: 300px; background: var(--panel, #fffdf9);
        color: var(--ink, #3c3022); border: 1px solid var(--border, #e6ddcd);
        border-radius: 12px; box-shadow: var(--shadow, 0 12px 32px rgba(60, 48, 34, 0.18));
        padding: 14px 16px 12px; font-size: 13px; }
      .atl-tour-pop h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; }
      .atl-tour-pop p { margin: 0 0 12px; line-height: 1.45; }
      .atl-tour-foot { display: flex; align-items: center; gap: 8px; }
      .atl-tour-count { font-size: 11px; opacity: 0.6; margin-right: auto; }
      .atl-tour-pop button { font: inherit; font-size: 12px; cursor: pointer;
        border-radius: 8px; padding: 5px 12px; border: 1px solid var(--border, #e6ddcd);
        background: transparent; color: inherit; }
      .atl-tour-pop button:hover { background: var(--accent-soft, rgba(192, 92, 55, 0.12)); }
      .atl-tour-pop button.atl-tour-next { background: var(--accent, #c05c37);
        border-color: var(--accent, #c05c37); color: #fff; }
      .atl-tour-pop button.atl-tour-next:hover { opacity: 0.9; }
      .atl-tour-pop button:disabled { opacity: 0.4; cursor: default; }
      .atl-tour-pop button:disabled:hover { background: transparent; }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-tour-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── tour state ─────────────────────────────────────────────────────────────
  let layer = null;   // the single overlay element (null when inactive)
  let steps = [];     // live steps for this run (missing anchors filtered out)
  let idx = 0;
  let refs = null;    // { hl, pop, title, body, count, back, next }

  function markDone() {
    // try/catch: localStorage can throw (disabled storage, quota) — the tour
    // must still close; the only cost is auto-starting again next boot.
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* non-fatal */ }
  }
  function isDone() {
    try { return localStorage.getItem(DONE_KEY) != null; } catch { return false; }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      // Capture-phase listener so this runs before core.js's window Escape
      // handler (selection clear / panel close); preventDefault also makes
      // core's `e.defaultPrevented` guard bail if anything still bubbles.
      e.preventDefault();
      e.stopPropagation();
      end(true); // Escape = skip -> mark done
      return;
    }
    // Keys aimed at the popover itself (Enter/Space on a focused button)
    // stay live; EVERYTHING else is swallowed while the tour runs. Look-only
    // must cover the keyboard too: the ⌘K palette is a fixed overlay at
    // z-index 10000 (above this layer's 9500) and core.js wires Delete to
    // card removal — either would drive the "not interactive" UI mid-tour.
    // The passthrough is plain activation keys ONLY: a click leaves focus on
    // the popover button, so an unqualified target check would let ⌘K reach
    // the palette's window listener, and Tab could walk focus out to the
    // topbar search input, which opens the palette on focus.
    if (refs && refs.pop && refs.pop.contains(e.target)
        && !e.metaKey && !e.ctrlKey && !e.altKey
        && (e.key === 'Enter' || e.key === ' ')) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onResize() {
    if (layer) showStep(idx);
  }

  function teardown() {
    if (!layer) return;
    layer.remove(); // single overlay element — everything lives inside it
    layer = null;
    refs = null;
    steps = [];
    idx = 0;
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onResize);
  }
  function end(done) {
    if (done) markDone();
    teardown();
  }

  // ── layout ─────────────────────────────────────────────────────────────────
  function placePopover(anchorRect) {
    const pop = refs.pop;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const clampX = (x) => Math.min(Math.max(x, EDGE), Math.max(EDGE, vw - pw - EDGE));
    const clampY = (y) => Math.min(Math.max(y, EDGE), Math.max(EDGE, vh - ph - EDGE));
    let left, top;
    if (!anchorRect) {                                    // final step: centered
      left = (vw - pw) / 2; top = (vh - ph) / 2;
    } else if (anchorRect.bottom + GAP + ph <= vh - EDGE) { // below
      left = clampX(anchorRect.left); top = anchorRect.bottom + GAP;
    } else if (anchorRect.top - GAP - ph >= EDGE) {         // above
      left = clampX(anchorRect.left); top = anchorRect.top - GAP - ph;
    } else if (anchorRect.right + GAP + pw <= vw - EDGE) {  // right
      left = anchorRect.right + GAP; top = clampY(anchorRect.top);
    } else if (anchorRect.left - GAP - pw >= EDGE) {        // left
      left = anchorRect.left - GAP - pw; top = clampY(anchorRect.top);
    } else {                                                // huge anchor: center
      left = (vw - pw) / 2; top = (vh - ph) / 2;
    }
    pop.style.left = clampX(left) + 'px';
    pop.style.top = clampY(top) + 'px';
  }

  function showStep(i) {
    if (!layer) return;
    // Anchors can vanish mid-tour (a module tore its UI down) — skip forward,
    // and finish if nothing showable remains.
    while (i < steps.length && steps[i].sel && !document.querySelector(steps[i].sel)) i++;
    if (i >= steps.length) { end(true); return; }
    idx = i;
    const step = steps[i];
    const { hl, pop, title, body, count, back, next } = refs;

    title.textContent = step.title;
    body.textContent = step.body;
    count.textContent = (i + 1) + ' / ' + steps.length;
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Finish' : 'Next';

    let rect = null;
    if (step.sel) {
      const el = document.querySelector(step.sel);
      const r = el.getBoundingClientRect();
      rect = {
        left: r.left - PAD, top: r.top - PAD,
        right: r.right + PAD, bottom: r.bottom + PAD,
        width: r.width + PAD * 2, height: r.height + PAD * 2,
      };
      hl.style.display = '';
      hl.style.left = rect.left + 'px';
      hl.style.top = rect.top + 'px';
      hl.style.width = rect.width + 'px';
      hl.style.height = rect.height + 'px';
      layer.classList.remove('atl-tour-nohl');
    } else {
      // no anchor: hide the cutout box; the layer itself carries the dim
      hl.style.display = 'none';
      layer.classList.add('atl-tour-nohl');
    }
    placePopover(rect);
  }

  // ── build + public API ─────────────────────────────────────────────────────
  function buildOverlay() {
    ensureStyles();
    layer = document.createElement('div');
    layer.className = 'atl-tour';

    const hl = document.createElement('div');
    hl.className = 'atl-tour-hl';

    const pop = document.createElement('div');
    pop.className = 'atl-tour-pop';
    const title = document.createElement('h3');
    const body = document.createElement('p');
    const foot = document.createElement('div');
    foot.className = 'atl-tour-foot';
    const count = document.createElement('span');
    count.className = 'atl-tour-count';
    const back = document.createElement('button');
    back.textContent = 'Back';
    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    const next = document.createElement('button');
    next.className = 'atl-tour-next';
    next.textContent = 'Next';
    foot.append(count, back, skip, next);
    pop.append(title, body, foot);
    layer.append(hl, pop);

    back.addEventListener('click', () => { if (idx > 0) showStepBack(idx - 1); });
    skip.addEventListener('click', () => end(true));
    next.addEventListener('click', () => {
      if (idx >= steps.length - 1) end(true);
      else showStep(idx + 1);
    });

    refs = { hl, pop, title, body, count, back, next };
    document.body.appendChild(layer);
  }

  // Back must skip vanished anchors in REVERSE (showStep only scans forward).
  function showStepBack(i) {
    while (i > 0 && steps[i].sel && !document.querySelector(steps[i].sel)) i--;
    if (steps[i].sel && !document.querySelector(steps[i].sel)) return; // nothing behind
    showStep(i);
  }

  function start() {
    if (layer) teardown(); // restart cleanly (does NOT write the done flag)
    // An open Settings/Analytics view overlay would sit dimmed over the very
    // anchors the tour spotlights — close it first. Guarded: views.js is
    // optional and its close() is a no-op when nothing is open. The views.js
    // "Restart tour" row closes before calling start() already; this covers
    // auto-start (user opened Settings within the 1500ms arm window) and any
    // future caller.
    if (A.views && typeof A.views.close === 'function') {
      try { A.views.close(); } catch { /* non-fatal */ }
    }
    // Filter to steps whose anchor exists right now; the final null-anchor
    // step always survives, so the tour can never be empty.
    steps = STEPS.filter((s) => !s.sel || document.querySelector(s.sel));
    buildOverlay();
    window.addEventListener('keydown', onKeydown, true); // capture: before core.js
    window.addEventListener('resize', onResize);
    showStep(0);
  }
  function active() { return layer != null; }

  A.tour = { start, active };

  // ── auto-start once ────────────────────────────────────────────────────────
  let armed = false;
  function armAutostart() {
    if (armed) return;
    armed = true;
    if (isDone()) return;
    setTimeout(() => { if (!isDone() && !active()) start(); }, 1500);
  }
  // core.js emits 'core:ready' synchronously at the end of its IIFE — before
  // this deferred module even loads — so the bus event alone would never fire
  // for us. window.Atelier existing IS the proof core:ready already happened;
  // arm now, and keep the bus subscription for any future re-emit.
  A.bus.on('core:ready', armAutostart);
  armAutostart();

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const problems = [];
    if (typeof A.tour.start !== 'function') problems.push('tour.start');
    if (typeof A.tour.active !== 'function') problems.push('tour.active');
    if (A.tour.active() !== false) {
      // active() is false at load (auto-start is 1500ms out) — anything else
      // means the overlay leaked from a previous build of this module.
      problems.push('tour.active() not false at load');
    }
    if (STEPS[STEPS.length - 1].sel !== null) problems.push('final step must be anchorless');
    console.assert(problems.length === 0, '[tour] self-check FAILED:', problems);
    if (!problems.length) {
      console.log('[tour] self-check passed — Atelier.tour published,',
        STEPS.length, 'steps declared, auto-start', isDone() ? 'skipped (done flag set)' : 'armed');
    }
  })();
})();
