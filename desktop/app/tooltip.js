'use strict';

/* ===========================================================================
   Atelier feature module — tooltip   (app/tooltip.js)

   Toolbar icon buttons (dock, zoombar, topbar, the "+ widget" affordance)
   rely on the native browser `title` tooltip, which is slow (OS-dependent
   hover delay) and unstyled. This module replaces it with an immediate,
   styled tooltip driven entirely by event delegation, so it works on both
   the static buttons in index.html and any card/button spawned later.

   How it works
   ------------
   • ONE listener per event type on `document` (`mouseover`, `mouseout`,
     `focusin`, `focusout`, `click`, `keydown`) plus one on `window`
     (`scroll`, capture phase, since scroll doesn't bubble) — no per-button
     wiring, so dynamically-spawned cards/buttons are covered for free.
   • A hovered/focused element counts as a tooltip target only when BOTH:
       1. it sits inside `.dock`, `.zoombar`, `.topbar`, or IS `.wgt-add-btn`
          (that button is appended straight to <body> by widgets.js, not
          nested in a toolbar container), AND
       2. it (or the nearest ancestor within that scope) carries a
          `data-tip`/`title` label.
   • De-native-tooltip trick: the FIRST time an element is matched, its
     `title` value is moved into `data-tip` and `title` is removed — this
     happens synchronously on mouseover/focusin, before the delay timer, so
     the OS-level slow tooltip never gets a chance to appear. All label
     reads thereafter prefer `data-tip`, falling back to `title` (element
     never re-stashed) or `aria-label`.
   • Show is delayed ~300ms from first hover (cleared/restarted if the
     target changes before it fires). Hide is immediate: mouseout past the
     target's bounds, focusout, any click, any scroll, or Escape.
   • Position: one shared tooltip <div>, created lazily and reused, appended
     to <body>, `position: fixed` so no scroll-offset math is needed. Sits
     ABOVE the target for dock/zoombar buttons (bottom bars — flip below if
     that would go off the top edge) and BELOW for topbar buttons and
     `.wgt-add-btn` (top-of-screen elements — flip above if that would go
     off the bottom edge). Horizontally centered on the target, then
     clamped into the viewport with an 4px margin.

   API (published as window.Atelier.tooltip, when core is present)
   ------------------------------------------------------------------
     hide() -> force-hide the tooltip and cancel any pending show. Exposed
               so other modules (a palette, a modal) can dismiss a stray
               tooltip before stealing focus, without needing to know this
               module's internals.

   Boundaries (per the module contract)
   ------------------------------------
   • DOM-only: works with zero dependency on window.Atelier. If core.js
     hasn't loaded (or 404s) this module still runs — it only reaches for
     `window.Atelier` to publish the optional `hide()` convenience above.
   • No changes to styles.css — the module injects its own <style> tag once,
     lazily, the same pattern app/analytics.js and app/widgets.js use for
     their own scoped CSS.
   • Never touches the `title`/`data-tip` semantics of elements outside the
     four scopes above — a titled element elsewhere on the page (a card
     button, say) is left alone; its native tooltip behavior is unchanged.

   ponytail: no config, no animation library, no IntersectionObserver — a
   single delegated listener set, a lazily-created div, and getBoundingClientRect
   math is the whole implementation.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/. Console: expect "[tooltip] ready".
   2. Hover a bottom dock button (e.g. Browser 🌐) and hold still — after
      about 300ms a small dark pill reading "Browser" fades in ABOVE the
      button. Move the mouse away — it disappears immediately. No slow
      native browser tooltip ever appears (inspect the button afterward:
      its `title` attribute is gone, replaced by `data-tip`).
   3. Same for a zoombar icon (Fit / Auto-arrange / Minimap) — pill above.
   4. Hover a topbar icon (Toggle sidebar / Back / Forward) — pill appears
      BELOW the button instead.
   5. Hover the "+ widget" button (top-right, fixed) — pill appears below it.
   6. Hover a dock button, then before 300ms elapses move to a different
      dock button — only the second button's label ever appears (no flash
      of the first, no double timer).
   7. Hover a dock button until the pill shows, then click it (or press
      Escape, or scroll the canvas) — the pill vanishes instantly.
   8. Tab-focus a topbar icon button with the keyboard — the same pill
      appears below it after the delay; Tab away (or blur) hides it.
   9. Hover a button, drag the window narrower/near a screen edge so the
      pill would overflow — it stays clamped inside the viewport (and
      flips to the opposite side if it would run off the top/bottom edge).
   10. Hover something OUTSIDE the four scopes (a card's × button, the
       search input) — no custom pill ever appears; native browser
       behavior (or none) is unchanged there.
   ========================================================================== */

(function () {
  const A = window.Atelier; // optional — this module works without core.js

  const SHOW_DELAY_MS = 300;
  const GAP_PX = 8;
  const EDGE_PX = 4;

  let tipEl = null;       // lazily created, reused
  let showTimer = null;   // pending setTimeout id, or null
  let activeTarget = null; // element currently tracked (hovered or focused)

  // ── styling: injected once, lazily — never touches styles.css ─────────────
  function injectCss() {
    if (document.getElementById('atl-tooltip-css')) return;
    const s = document.createElement('style');
    s.id = 'atl-tooltip-css';
    s.textContent = [
      '.atl-tt {',
      '  position: fixed; z-index: 10020; pointer-events: none;',
      '  max-width: 220px; padding: 5px 10px; border-radius: 999px;',
      '  font: 500 11.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;',
      '  color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '  background: color-mix(in srgb, var(--ink, #26201a) 92%, transparent);',
      '  box-shadow: 0 6px 18px rgba(20, 15, 10, 0.28), 0 0 0 1px rgba(255,255,255,0.06) inset;',
      '  opacity: 0; transform: translateY(2px);',
      '  transition: opacity 110ms ease, transform 110ms ease;',
      '  display: none;',
      '}',
      '.atl-tt.atl-tt--visible { opacity: 1; transform: translateY(0); }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function ensureTip() {
    if (tipEl) return tipEl;
    injectCss();
    tipEl = document.createElement('div');
    tipEl.className = 'atl-tt';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    return tipEl;
  }

  // ── matching: is this hover/focus target one we tooltip? ──────────────────
  // Moves title -> data-tip on first match (kills the native slow tooltip).
  function stash(el) {
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      if (t && !el.hasAttribute('data-tip')) el.setAttribute('data-tip', t);
      el.removeAttribute('title');
    }
  }

  function labelOf(el) {
    return el.getAttribute('data-tip') || el.getAttribute('title') ||
      el.getAttribute('aria-label') || '';
  }

  function tooltipTarget(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const scope = el.closest('.dock, .zoombar, .topbar, .wgt-add-btn');
    if (!scope) return null;
    const labeled = el.closest('[data-tip], [title]');
    if (!labeled || !scope.contains(labeled)) return null;
    stash(labeled);
    if (!labelOf(labeled)) return null;
    return labeled;
  }

  // ── positioning ─────────────────────────────────────────────────────────
  function preferredSide(target) {
    if (target.closest('.topbar')) return 'below';
    if (target.classList.contains('wgt-add-btn')) return 'below';
    return 'above';
  }

  function positionTip(tip, target) {
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let side = preferredSide(target);
    let top;
    if (side === 'below') {
      top = r.bottom + GAP_PX;
      if (top + th > vh - EDGE_PX) { side = 'above'; top = r.top - th - GAP_PX; }
    } else {
      top = r.top - th - GAP_PX;
      if (top < EDGE_PX) { side = 'below'; top = r.bottom + GAP_PX; }
    }
    top = Math.max(EDGE_PX, Math.min(top, vh - th - EDGE_PX));

    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(EDGE_PX, Math.min(left, vw - tw - EDGE_PX));

    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  // ── show / hide ─────────────────────────────────────────────────────────
  function show(target) {
    const label = labelOf(target);
    if (!label) return;
    const tip = ensureTip();
    tip.textContent = label;
    tip.classList.remove('atl-tt--visible');
    tip.style.display = 'block';
    positionTip(tip, target);
    // next frame so the opacity/transform transition actually runs
    requestAnimationFrame(() => {
      if (activeTarget === target) tip.classList.add('atl-tt--visible');
    });
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    activeTarget = null;
    if (tipEl) {
      tipEl.classList.remove('atl-tt--visible');
      tipEl.style.display = 'none';
    }
  }

  function scheduleShow(target) {
    if (showTimer) clearTimeout(showTimer);
    activeTarget = target;
    showTimer = setTimeout(() => {
      showTimer = null;
      show(target);
    }, SHOW_DELAY_MS);
  }

  // ── event delegation ────────────────────────────────────────────────────
  document.addEventListener('mouseover', (e) => {
    const target = tooltipTarget(e.target);
    if (!target || target === activeTarget) return;
    scheduleShow(target);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeTarget) return;
    const related = e.relatedTarget;
    if (related && activeTarget.contains(related)) return; // still inside target
    hide();
  });

  document.addEventListener('focusin', (e) => {
    const target = tooltipTarget(e.target);
    if (!target || target === activeTarget) return;
    scheduleShow(target);
  });

  document.addEventListener('focusout', (e) => {
    if (activeTarget && activeTarget.contains(e.target)) hide();
  });

  document.addEventListener('click', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);

  // ── optional publish (core.js may not be loaded at all) ────────────────
  if (A) A.tooltip = { hide };

  // ── self-check ─────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = typeof show === 'function' &&
      typeof hide === 'function' &&
      typeof scheduleShow === 'function' &&
      typeof tooltipTarget === 'function' &&
      tipEl === null; // lazy: nothing created until the first real hover/focus
    console.assert(ok, '[tooltip] internal API incomplete or eagerly created');
    if (ok) console.log('[tooltip] ready');
  })();
})();
