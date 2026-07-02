'use strict';

/* ===========================================================================
   Atelier feature module — chat controls   (app/chatcontrols.js)

   A shared per-composer control strip. Part B ships the MODEL PICKER half of
   mount(): a ▾ dropdown injected into any composer (the main chat card and
   each agent card) that switches which Claude model that chat runs on.

     labels -> values:  "Claude Opus 4.8" -> opus
                        "Sonnet"           -> sonnet
                        "Haiku"            -> haiku

   scope 'main'    -> POST /config/model            (the existing global route)
   scope 'session' -> POST /sessions/{sessionId}/model  (per-card override)

   On change: POST the new model; on {"ok":true} keep it + toast; on junk /
   backend-down revert the dropdown to its prior value + toast (matches the
   spec's "dropdown reverts to the prior value" error handling). The initial
   value comes from GET /config (main) or GET /sessions/{id} (session; a null
   override falls back to the global /config value).

   Part C extends this same mount() with a govern target-cursor button.

   Boundaries (per the module contract)
   ------------------------------------
   • Loads AFTER sessions.js; guards window.Atelier so a 404 stays harmless.
   • Touches ONLY window.Atelier (+ optional window.atelier.token) and its own
     injected <style>; never index.html's shell or styles.css.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect "[chatcontrols] ready".
   2. The main chat composer shows a model dropdown; it reflects GET /config's
      model (sonnet by default). Pick "Haiku" — toast "Model set to Haiku";
      GET /config now reports haiku (the long-lived chat client was reset).
   3. Spawn an agent card (💬 dock). Its composer shows its own dropdown,
      defaulting to the global model. Pick "Claude Opus 4.8" — toast, and
      GET /sessions/{id} reports model "opus" independent of the global.
   4. Send a turn from that card — it runs on opus (backend build_options
      resolves session.model first); the main chat + other cards are unaffected.
   5. Stop the backend, change a dropdown — toast "Could not change the model —
      reverted." and the dropdown snaps back to its prior value.
   6. Spawn a second session chat — each composer shows both the model ▾ and
      the ◎ govern button; the main chat composer shows the ▾ but no ◎.
   7. Click ◎ on Chat A — the button turns accent-filled, every agent card
      outlines dashed (A itself solid), cursor turns crosshair. Click Chat B —
      an A -> B arrow is drawn and an "Agent 2" chip appears in A's chip strip.
      Re-click B (or the chip's ✕) — the arrow and chip disappear.
   8. Arm A, then click ◎ on Chat C — A's button de-activates (only one chat
      arms at a time). Arm C, then click a B already governed by A — B's chip
      moves from A's strip to C's and the arrow re-anchors C -> B.
   9. Press Esc while armed — govern mode exits and every highlight clears.
      Close an armed chat's card via its × — no dangling atl-governing body
      class remains.
   10. Rename app/govern.js (simulating a 404) and reload — the ◎ button still
       mounts and clicks no-op silently (guarded govAPI()); no console errors.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.ui) {
    console.warn('[chatcontrols] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const MODELS = [
    { label: 'Claude Opus 4.8', value: 'opus' },
    { label: 'Sonnet', value: 'sonnet' },
    { label: 'Haiku', value: 'haiku' },
  ];

  // Same fetch idiom as sessions.js: never throw on HTTP status, only on
  // network; carry the shared-secret header when main.js minted one.
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  (function injectStyles() {
    if (document.getElementById('atl-chatcontrols-styles')) return;
    const css = `
      .atl-chatcontrols { display: flex; align-items: center; gap: 6px; }
      .atl-model-picker { font: inherit; font-size: 12px; color: var(--ink);
        background: #faf7f1; border: 1px solid var(--border); border-radius: 8px;
        padding: 3px 6px; cursor: pointer; outline: none; }
      .atl-model-picker:focus { border-color: var(--accent); }
    `;
    const style = document.createElement('style');
    style.id = 'atl-chatcontrols-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  function labelFor(value) {
    const m = MODELS.find((x) => x.value === value);
    return m ? m.label : value;
  }

  function endpointFor(ctx) {
    return ctx.scope === 'session'
      ? '/sessions/' + ctx.sessionId + '/model'
      : '/config/model';
  }

  function applyKnown(sel, model) {
    if (model && MODELS.some((x) => x.value === model)) { sel.value = model; }
  }

  function buildModelPicker(ctx) {
    const sel = document.createElement('select');
    sel.className = 'atl-model-picker';
    sel.title = 'Model for this chat';
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    let current = sel.value; // first option until the backend answers

    // initial value: session override else the global /config model
    (async () => {
      try {
        if (ctx.scope === 'session') {
          const r = await apiJson('/sessions/' + ctx.sessionId, { method: 'GET' });
          const override = r && r.data && r.data.model;
          if (override) { applyKnown(sel, override); current = sel.value; return; }
        }
        const g = await apiJson('/config', { method: 'GET' });
        if (g && g.data && g.data.model) { applyKnown(sel, g.data.model); current = sel.value; }
      } catch { /* backend down — keep the default option shown */ }
    })();

    sel.addEventListener('change', async () => {
      const next = sel.value;
      let r = null;
      try {
        r = await apiJson(endpointFor(ctx), {
          method: 'POST',
          body: JSON.stringify({ model: next }),
        });
      } catch { r = null; }
      if (r && r.ok && r.data && r.data.ok) {
        current = next;
        A.ui.toast('Model set to ' + labelFor(next));
      } else {
        sel.value = current; // revert to the prior value (spec error handling)
        A.ui.toast('Could not change the model — reverted.');
      }
    });
    return sel;
  }

  // ── govern select-mode (Part C) ─────────────────────────────────────────────
  // Self-contained: the button/chip/highlight chrome + the click gesture live
  // here; the govern link's backend + arrow lifecycle lives in app/govern.js
  // (window.Atelier.govern), reached lazily so a 404 on that file stays
  // harmless (the button just no-ops with a guarded call).
  function injectGovernStyles() {
    if (document.getElementById('atl-govern-styles')) return;
    const style = document.createElement('style');
    style.id = 'atl-govern-styles';
    style.textContent = `
      .atl-govern-btn { width: 32px; height: 32px; flex: 0 0 32px; border: none;
        border-radius: 9px; background: transparent; color: var(--ink-dim);
        cursor: pointer; font-size: 15px; line-height: 1; }
      .atl-govern-btn:hover { background: var(--border-soft); color: var(--ink); }
      .atl-govern-btn.active { background: var(--accent); color: #fff; }
      .atl-govern-chips { display: flex; flex-wrap: wrap; gap: 6px;
        padding: 4px 14px 0; }
      .atl-govern-chips:empty { display: none; }
      .atl-govern-chip { display: inline-flex; align-items: center; gap: 5px;
        font-size: 11px; padding: 2px 8px; border-radius: 999px;
        background: #f0e9dd; color: var(--ink); border: 1px solid var(--border-soft); }
      .atl-govern-chip-x { cursor: pointer; color: var(--ink-dim); font-weight: 700; }
      .atl-govern-chip-x:hover { color: var(--accent); }
      /* while a chat is armed, candidate agent cards highlight (source solid) */
      body.atl-governing .atl-agent-card { outline: 2px dashed var(--accent);
        outline-offset: 3px; cursor: crosshair; }
      body.atl-governing .atl-agent-card.atl-govern-source {
        outline-style: solid; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  // controlsBar is Part B's `.atl-chatcontrols` bar (the govern button joins
  // the model picker there); composerEl is the actual `.atl-agent-composer`
  // row (the chip strip sits just above THAT, not above the small bar).
  function mountGovern(controlsBar, composerEl, ctx) {
    injectGovernStyles();
    const cardEl = ctx.cardEl;
    // stamp the session id so govern.js resolves this card element -> id
    if (cardEl && ctx.sessionId) cardEl.dataset.atlSession = String(ctx.sessionId);

    // target-cursor toggle button (sits in the composer row, next to model ▾)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'atl-govern-btn';
    btn.textContent = '◎';
    btn.title = 'Govern mode — click agent cards to delegate to them';
    controlsBar.appendChild(btn);

    // chip strip: one chip per governed child, ✕ to ungovern. Sits just ABOVE
    // the composer row so it never fights the send button's flex line.
    const chips = document.createElement('div');
    chips.className = 'atl-govern-chips';
    if (composerEl.parentNode) composerEl.parentNode.insertBefore(chips, composerEl);

    let active = false;
    function govAPI() { return window.Atelier && window.Atelier.govern; }

    function renderChips() {
      const g = govAPI();
      chips.textContent = '';
      if (!g) return;
      g.childrenOf(cardEl).forEach((childEl) => {
        const chip = document.createElement('span');
        chip.className = 'atl-govern-chip';
        const label = document.createElement('span');
        const t = childEl.querySelector('.card-title');
        label.textContent = (t && t.textContent.trim()) || 'agent';
        const x = document.createElement('span');
        x.className = 'atl-govern-chip-x';
        x.textContent = '×';
        x.title = 'Stop governing';
        x.addEventListener('click', () => { g.unlink(cardEl, childEl); });
        chip.append(label, x);
        chips.appendChild(chip);
      });
    }

    // capture-phase mousedown: catch a click on ANOTHER agent card BEFORE
    // core's drag/bringToFront sees it, and toggle govern for that child.
    function onPick(e) {
      if (!active) return;
      const target = e.target.closest ? e.target.closest('.atl-agent-card') : null;
      if (!target || target === cardEl) return;
      if (!target.dataset.atlSession) return; // unstamped -> not a govern target
      e.preventDefault();
      e.stopPropagation();
      const g = govAPI();
      if (!g) return;
      const governed = g.childrenOf(cardEl).indexOf(target) !== -1;
      if (governed) g.unlink(cardEl, target);      // sync: chips repaint below
      else g.govern(cardEl, target);               // async: repaints on govern:changed
    }

    function enter() {
      if (active) return;
      active = true;
      btn.classList.add('active');
      document.body.classList.add('atl-governing');
      if (cardEl) cardEl.classList.add('atl-govern-source');
      document.addEventListener('mousedown', onPick, true);
      A.bus.emit('govern:mode', { on: true, cardEl }); // only one chat arms at a time
    }
    function exit() {
      if (!active) return;
      active = false;
      btn.classList.remove('active');
      document.body.classList.remove('atl-governing');
      if (cardEl) cardEl.classList.remove('atl-govern-source');
      document.removeEventListener('mousedown', onPick, true);
    }
    btn.addEventListener('click', () => { active ? exit() : enter(); });

    // Esc leaves govern mode; another chat arming exits this one; govern-link
    // changes for THIS chat repaint its chips; the card closing tears it down.
    const offEsc = A.bus.on('shortcut:escape', exit);
    const offMode = A.bus.on('govern:mode', (d) => { if (d && d.on && d.cardEl !== cardEl) exit(); });
    const offGov = A.bus.on('govern:changed', (d) => { if (d && d.parentEl === cardEl) renderChips(); });
    const offRem = A.bus.on('card:removed', (d) => {
      if (!d || d.el !== cardEl) return;
      exit();
      offEsc(); offMode(); offGov(); offRem();
    });

    renderChips();
  }

  function mount(composerEl, ctx) {
    if (!composerEl || composerEl.querySelector('.atl-chatcontrols')) return;
    ctx = ctx || { scope: 'main' };
    const bar = document.createElement('div');
    bar.className = 'atl-chatcontrols';
    bar.appendChild(buildModelPicker(ctx));
    // Part C appends the govern target-cursor button to this same bar.
    composerEl.appendChild(bar);
    // Part C: session chats also get the govern target-cursor + chip strip.
    if (ctx.scope === 'session') mountGovern(bar, composerEl, ctx);
  }

  A.chatcontrols = { mount };

  // ── self-check ────────────────────────────────────────────────────────────
  (function selfCheck() {
    const api = window.Atelier.chatcontrols;
    const ok = api && typeof api.mount === 'function';
    console.assert(ok, '[chatcontrols] API surface incomplete:', api);
    // mount must no-op (not throw) on a null composer — used by callers whose
    // composer/session may not exist yet.
    let threw = false;
    try { api.mount(null, { scope: 'main' }); } catch { threw = true; }
    console.assert(!threw, '[chatcontrols] mount(null) must no-op, not throw');
    if (ok && !threw) console.log('[chatcontrols] ready');
  })();
})();
