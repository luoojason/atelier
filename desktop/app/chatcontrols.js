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

  function mount(composerEl, ctx) {
    if (!composerEl || composerEl.querySelector('.atl-chatcontrols')) return;
    ctx = ctx || { scope: 'main' };
    const bar = document.createElement('div');
    bar.className = 'atl-chatcontrols';
    bar.appendChild(buildModelPicker(ctx));
    // Part C appends the govern target-cursor button to this same bar.
    composerEl.appendChild(bar);
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
