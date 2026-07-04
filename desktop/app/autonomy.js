'use strict';

/* ===========================================================================
   Atelier feature module — Autonomy dial   (app/autonomy.js)

   One control for a walk-away user to set ONCE: how much the agents may do on
   their own before stopping to ask. Three positions:

     • Ask first  — nothing is auto-approved; every deliverable waits in the
                    approvals lane for a human. (The existing behavior.)
     • Balanced   — the lowest-risk deliverables (agent notes) clear on their
                    own; files, documents, and anything that leaves the machine
                    still wait for you.
     • Autopilot  — low- and medium-risk workspace deliverables (notes,
                    documents, rendered files) clear on their own; publishing
                    to the outside world STILL waits for you. Autonomy is never
                    a licence to post without a human.

   How it pairs with the approvals lane (app/approvals.js)
   -------------------------------------------------------
   INVESTIGATION RESULT — approvals.js exposes NO auto-approve / resolve /
   decide method, and emits NO "enqueue" bus event. Its window.AtelierApprovals
   surface is: open, close, toggle, isOpen, pendingCount, enqueue, gate(promise
   form), and the live `items` array. decide() (the thing that actually clears a
   pending item) is private. So there is no first-class hook to call.

   Two real seams do exist, and this module uses both — WITHOUT editing
   approvals.js:

     1. The decision store. approvals.js remembers every human decision in raw
        localStorage under 'atelier.approvals.decided' as
        { <itemKey>: { status:'approved'|'dismissed', ts } }, and BOTH its
        enqueue() and gate() short-circuit against it (an item whose key is
        already 'approved' is never held again, and gate() resolves true
        immediately). Writing an 'approved' record there is therefore a durable,
        supported way to mark something approved that every part of approvals
        already honors.

     2. The live `items` array is exposed by reference. Splicing an item out of
        it reflects the auto-approval in the lane immediately.

   So at Balanced / Autopilot this module runs a light sweep: for each pending
   item whose risk tier the current level permits, it records an 'approved'
   decision (seam 1), fires the item's own onApprove/resolve callback if it
   carries one (so a gated publish promise still settles correctly), splices it
   out of the exposed `items` (seam 2), and best-effort reconciles the number on
   approvals' topbar pill. This is deliberately best-effort: approvals owns that
   pill and its drawer rows, and will authoritatively repaint them on its next
   internal update — the sweep just keeps the visible count honest in between.

   The durable contract (works even if approvals is absent)
   --------------------------------------------------------
   Regardless of the lane, the chosen level is persisted and published as
   window.AtelierAutonomy.level (plus a richer policy API and an
   'autonomy:changed' bus event). Any module — including a future one-line hook
   inside approvals.gate() — can read window.AtelierAutonomy.shouldAutoApprove()
   to decide whether to hold. That is the clean long-term integration; the sweep
   above is what makes the dial DO something today without touching approvals.js.

   Persistence
   -----------
   The level is persisted through Atelier.store (the sanctioned preference API)
   under the key 'atelier.autonomy.level'. The store prefixes it to
   'atelier:atelier.autonomy.level'. NOTE: store keys are board-scoped unless
   listed in boards.js GLOBAL_KEYS — and this is a "set once, follow me
   everywhere" preference, so the host should add 'atelier:atelier.autonomy.level'
   to GLOBAL_KEYS (a one-line edit, alongside the existing slashcommands / premium
   global keys). See backendNeeded in the handoff. Until that line is added the
   dial still works perfectly; the chosen level is simply remembered per board
   rather than globally. (The separate approvals decision store this module writes
   to — seam 1 above — MUST stay raw localStorage under 'atelier.approvals.decided'
   because that is approvals.js's own key; it is intentionally not an A.store key.)

   Contract: builds only against window.Atelier (Atelier.store for the remembered
   level, raw localStorage for the shared approvals decision store). Injects its own
   CSS. Every dynamic string enters the DOM via textContent. Mounts a compact
   segmented dial in the topbar (.tb-right, exactly where the approvals pill
   lives) and a ⌘K palette command; never edits index.html, core.js, styles.css,
   approvals.js, or any backend file. Reuses the styles.css design tokens.
   Keyboard + screen-reader accessible; respects prefers-reduced-motion. Ends
   with a selfCheck() console log like the siblings. Zero token / rate-limit cost
   (no network calls at all).
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store) {
    console.warn('[autonomy] Atelier core not available — skipping.');
    return;
  }

  // Preference key persisted through A.store (auto-prefixed to
  // 'atelier:atelier.autonomy.level'). See header re: GLOBAL_KEYS for global scope.
  const LEVEL_KEY = 'atelier.autonomy.level';
  // The shared approvals decision store is raw localStorage — approvals.js's own
  // key (UNDO_KEYS), NOT an A.store key, so it must be read/written directly.
  const APPROVALS_DECIDED_KEY = 'atelier.approvals.decided';

  const SWEEP_MS = 1500;        // auto-approve sweep cadence (token-free; DOM + localStorage only)

  // ── the three positions ─────────────────────────────────────────────────────
  const LEVELS = [
    { id: 'ask',      label: 'Ask first', short: 'Ask',
      hint: 'Nothing is auto-approved. Every deliverable waits for you.' },
    { id: 'balanced', label: 'Balanced',  short: 'Balanced',
      hint: 'Agent notes clear on their own. Files, documents, and publishing still wait for you.' },
    { id: 'auto',     label: 'Autopilot', short: 'Auto',
      hint: 'Notes, documents, and files clear on their own. Publishing to the outside world still waits for you.' },
  ];
  const LEVEL_IDS = LEVELS.map((l) => l.id);
  const DEFAULT_LEVEL = 'ask'; // safe default: preserves the existing approvals contract until opted in

  // ── risk tiers per deliverable kind, and which tiers each level auto-clears ──
  // Kinds come from approvals.js: 'note' | 'document' | 'file' | 'publish'.
  const RISK = { note: 'low', document: 'medium', file: 'medium', publish: 'high' };
  const DEFAULT_RISK = 'medium';                       // unknown kinds are treated as medium
  const ALLOW = {                                      // level id -> set of auto-clearable risk tiers
    ask:      new Set(),
    balanced: new Set(['low']),
    auto:     new Set(['low', 'medium']),              // 'high' (publish) is never auto-cleared
  };

  function riskOf(item) {
    const k = item && item.kind;
    return Object.prototype.hasOwnProperty.call(RISK, k) ? RISK[k] : DEFAULT_RISK;
  }

  // ── tiny DOM helper (same idiom as the sibling modules) ────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function normLevel(id) {
    return LEVEL_IDS.indexOf(id) === -1 ? DEFAULT_LEVEL : id;
  }
  function levelDef(id) {
    return LEVELS[Math.max(0, LEVEL_IDS.indexOf(normLevel(id)))];
  }

  // ── stored preference (Atelier.store — see header re: GLOBAL_KEYS) ──────────
  function loadLevel() {
    try {
      const raw = A.store.get(LEVEL_KEY, DEFAULT_LEVEL);
      return normLevel(raw == null ? DEFAULT_LEVEL : raw);
    } catch { return DEFAULT_LEVEL; }
  }
  function saveLevel(id) {
    try { A.store.set(LEVEL_KEY, id); }
    catch { /* private mode — the level just won't persist */ }
  }

  let level = loadLevel();

  // ── policy: does the current level clear this item on its own? ──────────────
  function shouldAutoApprove(item) {
    if (!item) return false;
    return ALLOW[level] ? ALLOW[level].has(riskOf(item)) : false;
  }
  function shouldHold(item) { return !shouldAutoApprove(item); }

  // ── the shared approvals decision store (seam 1) ────────────────────────────
  // Read-modify-write so we never clobber a human's manual approve/dismiss.
  function recordDecision(key, status) {
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(APPROVALS_DECIDED_KEY);
      const map = raw ? (JSON.parse(raw) || {}) : {};
      map[key] = { status, ts: Date.now() };
      window.localStorage.setItem(APPROVALS_DECIDED_KEY, JSON.stringify(map));
    } catch { /* private mode — approvals will just re-ask on this key */ }
  }

  // ── auto-approve sweep over the approvals lane (best-effort; no lane edits) ──
  const handled = new Set();   // keys this module has already auto-approved (dedupe)

  function approveItem(appr, item) {
    handled.add(item.key);
    recordDecision(item.key, 'approved');                    // durable: approvals honors this everywhere
    // Honor the item's own callbacks so a gated promise (approvals.gate) settles.
    try { if (typeof item.onApprove === 'function') item.onApprove(); } catch { /* caller's concern */ }
    try { if (typeof item.resolve === 'function') item.resolve(true); } catch { /* caller's concern */ }
    // Reflect it in the live lane array (exposed by reference).
    try {
      const i = appr.items.findIndex((x) => x && x.key === item.key);
      if (i !== -1) appr.items.splice(i, 1);
    } catch { /* array shape changed under us — the decision record still holds */ }
    A.bus.emit('autonomy:auto-approved', { key: item.key, kind: item.kind });
  }

  // Keep approvals' own topbar pill count honest between its internal repaints.
  // We only read pendingCount() and touch the pill's number/So this is a visual
  // reconcile, not a state edit — approvals authoritatively repaints on its next
  // update. (Its open drawer rows are its own; a walk-away user rarely has it
  // open, so those are left for approvals to clear.)
  function syncApprovalsPill(appr) {
    try {
      const n = typeof appr.pendingCount === 'function'
        ? appr.pendingCount()
        : (Array.isArray(appr.items) ? appr.items.length : 0);
      const pill = document.querySelector('.atl-appr-pill');
      if (!pill) return;
      const num = pill.querySelector('.n');
      if (num) num.textContent = String(n);
      pill.classList.toggle('has', n > 0);
    } catch { /* pill absent or restyled — nothing to reconcile */ }
  }

  function sweep() {
    if (level === 'ask') return;                    // hold everything — nothing to do
    const appr = window.AtelierApprovals;
    if (!appr || !Array.isArray(appr.items)) return; // lane not loaded — degrade to a pure preference
    let acted = 0;
    // Snapshot the keys first; approveItem mutates appr.items as we go.
    appr.items.slice().forEach((item) => {
      if (!item || !item.key) return;
      if (handled.has(item.key)) return;
      if (!shouldAutoApprove(item)) return;
      approveItem(appr, item);
      acted++;
    });
    if (acted) syncApprovalsPill(appr);
  }

  // ── injected CSS (reuses styles.css design tokens) ─────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-auto-style')) return;
    const css = `
      .atl-auto { display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 999px; padding: 4px 9px; margin-right: 8px; font: inherit;
        font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; line-height: 1; }
      .atl-auto:hover { color: var(--ink); border-color: var(--ink-dim); }
      .atl-auto:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-auto-ic { font-size: 13px; line-height: 1; color: var(--ink-mid); }
      .atl-auto[data-level="balanced"] .atl-auto-ic { color: var(--ink); }
      .atl-auto[data-level="auto"] .atl-auto-ic { color: var(--accent); }
      .atl-auto-car { font-size: 9px; color: var(--ink-dim); }
      .atl-auto-menu { position: fixed; z-index: 9500; min-width: 232px; display: none;
        flex-direction: column; gap: 2px; padding: 6px; background: var(--panel);
        border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
      .atl-auto-menu.open { display: flex; }
      .atl-auto-opt { display: flex; flex-direction: column; gap: 2px; text-align: left;
        border: none; background: transparent; border-radius: 8px; padding: 8px 10px;
        cursor: pointer; font: inherit; }
      .atl-auto-opt:hover { background: var(--active); }
      .atl-auto-opt.on { background: var(--accent-soft, var(--active)); }
      .atl-auto-opt-t { font-size: 13px; font-weight: 600; color: var(--ink); }
      .atl-auto-opt.on .atl-auto-opt-t { color: var(--accent); }
      .atl-auto-opt-h { font-size: 11.5px; color: var(--ink-mid); font-weight: 500; }
      .atl-auto-opt:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

      .atl-auto-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    `;
    const style = el('style');
    style.id = 'atl-auto-style';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── screen-reader live region ───────────────────────────────────────────────
  let liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = el('div', 'atl-auto-sr');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 30);
  }

  // ── the topbar chip + dropdown (compact — the topbar is only ~920px) ─────────
  let dialEl = null, chipLabel = null, menuEl = null;
  const segEls = new Map();   // level id -> option button (in the dropdown)

  function buildDial() {
    const host = document.querySelector('.tb-right');
    if (!host || dialEl) return;

    dialEl = el('button', 'atl-auto');
    dialEl.type = 'button';
    dialEl.setAttribute('aria-haspopup', 'true');
    dialEl.setAttribute('aria-expanded', 'false');
    // Icon-only chip — the topbar is only ~920px, so the level lives in the
    // tooltip + the dropdown, and the glyph colour signals it at a glance.
    const ic = el('span', 'atl-auto-ic', '◐');
    ic.setAttribute('aria-hidden', 'true');
    const car = el('span', 'atl-auto-car', '▾');
    car.setAttribute('aria-hidden', 'true');
    dialEl.appendChild(ic);
    dialEl.appendChild(car);
    dialEl.addEventListener('click', toggleMenu);

    // Sit just left of the brand name, right of the approvals pill if present.
    const brand = host.querySelector('.brand-name');
    if (brand) host.insertBefore(dialEl, brand);
    else host.insertBefore(dialEl, host.firstChild);
    paintDial();
  }

  function buildMenu() {
    menuEl = el('div', 'atl-auto-menu');
    menuEl.setAttribute('role', 'radiogroup');
    menuEl.setAttribute('aria-label', 'Autonomy — how much agents may do before asking');
    segEls.clear();
    LEVELS.forEach((lv) => {
      const b = el('button', 'atl-auto-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.level = lv.id;
      b.appendChild(el('span', 'atl-auto-opt-t', lv.label));
      b.appendChild(el('span', 'atl-auto-opt-h', lv.hint));
      b.addEventListener('click', () => { setLevel(lv.id); closeMenu(); if (dialEl) dialEl.focus(); });
      menuEl.appendChild(b);
      segEls.set(lv.id, b);
    });
    document.body.appendChild(menuEl);
  }

  function toggleMenu() {
    if (menuEl && menuEl.classList.contains('open')) closeMenu(); else openMenu();
  }
  function openMenu() {
    if (!menuEl) buildMenu();
    const r = dialEl.getBoundingClientRect();
    menuEl.style.top = (r.bottom + 6) + 'px';
    menuEl.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    menuEl.classList.add('open');
    dialEl.setAttribute('aria-expanded', 'true');
    paintDial();
    setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onMenuKey);
  }
  function closeMenu() {
    if (menuEl) menuEl.classList.remove('open');
    if (dialEl) dialEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onMenuKey);
  }
  function onDocClick(e) {
    if (menuEl && !menuEl.contains(e.target) && dialEl && !dialEl.contains(e.target)) closeMenu();
  }
  function onMenuKey(e) {
    if (e.key === 'Escape') { closeMenu(); if (dialEl) dialEl.focus(); }
  }

  function paintDial() {
    if (dialEl) {
      dialEl.dataset.level = level;   // CSS tints the glyph by level
      dialEl.title = 'Autonomy: ' + levelDef(level).label + ' — ' + levelDef(level).hint;
      dialEl.setAttribute('aria-label', 'Autonomy: ' + levelDef(level).label);
    }
    segEls.forEach((b, id) => {
      const on = id === level;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  // ── set the level (persist + publish + repaint + sweep) ─────────────────────
  function setLevel(id, opts) {
    const next = normLevel(id);
    const changed = next !== level;
    level = next;
    saveLevel(level);
    if (api) api.level = level; // keep the plain public property in sync
    paintDial();
    if (changed) {
      A.bus.emit('autonomy:changed', { level });
      const def = levelDef(level);
      announce('Autonomy set to ' + def.label + '. ' + def.hint);
      if (!(opts && opts.silent) && A.ui && typeof A.ui.toast === 'function') {
        A.ui.toast('Autonomy: ' + def.label);
      }
    }
    // A more permissive level can clear items already waiting — sweep now.
    sweep();
    return level;
  }
  function cycle() {
    return setLevel(LEVEL_IDS[(LEVEL_IDS.indexOf(level) + 1) % LEVEL_IDS.length]);
  }

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'autonomy.cycle', label: 'Autonomy level', icon: '◐', section: 'Studio',
      keywords: 'autonomy autopilot ask balanced auto approval hold hands off walk away trust gate',
      run() { const l = cycle(); if (A.ui && typeof A.ui.toast === 'function') A.ui.toast('Autonomy: ' + levelDef(l).label); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);

  // ── lifecycle wiring ────────────────────────────────────────────────────────
  A.bus.on('core:ready', () => buildDial());
  // Rebuild the dial if the topbar was re-rendered under us (mirrors approvals).
  A.bus.on('boards:switched', () => { if (!document.querySelector('.atl-auto')) { dialEl = null; buildDial(); } });
  // core:ready may already have fired before this deferred script ran.
  buildDial();

  // ── sweep loop (self-rescheduling; DOM + localStorage only, no network) ─────
  let sweepTimer = null;
  function tick() {
    try { sweep(); } catch { /* keep the loop alive */ }
    sweepTimer = setTimeout(tick, SWEEP_MS);
  }
  tick();

  // ── public surface + self-check ─────────────────────────────────────────────
  const api = {
    // The stored preference other modules read (the durable, lane-independent
    // contract). Kept in sync by setLevel().
    level,
    LEVELS: LEVELS.slice(),
    get: () => level,
    set: setLevel,
    setLevel,
    cycle,
    is: (id) => level === normLevel(id),
    levelIndex: () => LEVEL_IDS.indexOf(level),
    // Policy oracle — a future approvals.gate() hook (or any module) calls this
    // to decide whether to hold. Give it a { kind } descriptor.
    shouldAutoApprove,
    shouldHold,
    riskOf: (item) => riskOf(item),
    // Subscribe to level changes; returns an unsubscribe fn.
    onChange: (cb) => A.bus.on('autonomy:changed', cb),
    // Run an auto-approve sweep now (also runs on its own timer + on set).
    sweep,
    el: () => dialEl,
  };
  window.AtelierAutonomy = api;

  (function selfCheck() {
    const registered = !!(window.AtelierAutonomy && typeof window.AtelierAutonomy.set === 'function');
    const levelOk = LEVEL_IDS.indexOf(level) !== -1;
    const dialOk = !!document.querySelector('.atl-auto') || !document.querySelector('.tb-right');
    console.assert(registered, '[autonomy] module did not register window.AtelierAutonomy');
    console.assert(levelOk, '[autonomy] stored level out of range');
    if (registered && levelOk) {
      console.log('[autonomy] self-check passed — autonomy dial ready (level "' + level +
        '", dial ' + (dialOk ? 'mounted' : 'pending topbar') + ', sweep ' + SWEEP_MS + 'ms).');
    }
  })();
})();
