'use strict';

/* ===========================================================================
   Atelier feature module — mini-app card   (app/miniapp.js)

   The agent scaffolds a small self-contained HTML app on demand; this card
   collects the description, POSTs it to the backend, and renders the result
   in a sandboxed iframe. Registers the 'miniapp' app type via
   Atelier.registerApp — no dock button; the card spawns from the ⌘K palette
   ("Add app: Mini-app") or Atelier.spawnApp('miniapp').

   Backend contract (lite_server.py, never 500):
     POST /miniapp {"description": str}   (X-Atelier-Token when bridged)
       -> {"html": "<!doctype html>…"} on success, else {"error": "<why>"}

   Card states
   -----------
   prompt — textarea ("Describe a small app…") + Build; errors land in an
            inline note via textContent, never innerHTML.
   busy   — spinner while the backend runs the generator (fresh SDK client
            per request; this can take a minute).
   app    — header row (the description, Rebuild, Source) over the sandboxed
            iframe; Source swaps in a readonly <pre> of the raw HTML
            (textContent). The iframe stays mounted while the source shows,
            so the running app's state survives the toggle.

   SECURITY INVARIANT — the iframe sandbox
   ---------------------------------------
   The iframe is created with sandbox="allow-scripts" EXACTLY. NEVER add
   allow-same-origin: combined with allow-scripts, a srcdoc document becomes
   same-origin with this app — its scripts could read localStorage (every
   board snapshot and store key) and walk window.parent to the preload
   bridge, i.e. window.atelier.token. allow-scripts alone keeps the srcdoc
   in a unique opaque origin: no storage, no cookies, no parent access.

   Accepted risk (by design): a unique-origin srcdoc CAN still fetch
   http://127.0.0.1:8765 read-only GETs — the backend CORS-allows the null
   Origin on purpose (plain-browser testing depends on it). Mutating routes
   stay token-gated and the token is unreachable from inside the sandbox,
   so the blast radius is "read what the dashboard already shows".

   Persistence (board-scoped, the widgets.js idiom)
   ------------------------------------------------
   Store key 'atelier.miniapps' via A.store (boards.js swaps the underlying
   localStorage keys per board): records {id, x, y, w, h, description, html,
   oversize} — html is capped at 200_000 chars: a larger app still RENDERS
   normally but persists as prompt-only (html null, oversize true); on
   reload that card opens in the prompt state, prefilled, with a note saying
   why. Restore runs at load AND on 'boards:switched', idempotent (records
   whose id is already live are skipped, so a stray double event cannot
   duplicate cards). Cleanup on 'card:removed' (module-level handler keyed
   on dataset, like widgets.js). Every persist() call site is synchronous
   (spawn, build success, drag mouseup, cards:rearranged, card:removed,
   will-switch flush) — no debounce timer exists in this module; the
   'boards:will-switch' handler only captures the volatile textarea draft
   into its record and flushes, so a switch (or a reason:'export' snapshot)
   never loses a half-typed description.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own
   CSS. Loads after core.js (the orchestrator owns the index.html tag).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up (PORT=8765 .venv-ext/bin/python lite_server.py), `npm start`
      in desktop/ — or open index.html in a plain browser.
   2. ⌘K → "mini" → "Add app: Mini-app" → a 460×420 card spawns showing the
      textarea + Build.
   3. Type "a pomodoro timer", click Build → spinner ("Building your app…"),
      then a working pomodoro renders inside the card. Network tab shows one
      POST /miniapp carrying X-Atelier-Token (under Electron).
   4. Inspect the iframe element → sandbox="allow-scripts" and nothing else.
   5. Click Source → the raw HTML shows in a dark readonly pane; the button
      reads App; click again → the running app returns with its state intact
      (the iframe was hidden, not rebuilt).
   6. Click Rebuild → the prompt returns prefilled with "a pomodoro timer".
      Build again → a fresh app replaces the old one.
   7. Reload (Cmd-R) → the card returns at its spot and size with the app
      rendered — persistence verified. Boards: switch away → the card leaves
      in place; switch back → it returns.
   8. Stop the backend, Build → inline note "Backend unreachable…"; the card
      stays usable. A too-short description → inline note, no request.
   9. Console shows "[miniapp] self-check passed" and no assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store) {
    console.warn('[miniapp] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.miniapps';
  const CARD_W = 460;
  const CARD_H = 420;
  const PERSIST_HTML_MAX = 200000; // larger apps render but persist prompt-only
  const DESC_MIN = 3;    // mirror the server's pydantic bounds so bad input
  const DESC_MAX = 2000; // fails fast with a friendly note, not a 422

  // ── tiny DOM helper (widgets.js idiom) ─────────────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── injected styles (warm palette via the :root vars from styles.css) ──────
  (function injectStyles() {
    if (document.getElementById('atl-miniapp-styles')) return;
    const css = `
      .atl-miniapp-body { padding: 0; display: flex; flex-direction: column; }

      /* prompt state */
      .atl-miniapp-prompt { flex: 1; min-height: 0; display: flex;
        flex-direction: column; gap: 10px; padding: 12px; }
      .atl-miniapp-prompt textarea { flex: 1; min-height: 0; resize: none;
        border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1;
        outline: none; }
      .atl-miniapp-prompt textarea:focus { border-color: var(--accent); }
      .atl-miniapp-note { font-size: 12px; color: var(--accent); }
      .atl-miniapp-note:empty { display: none; }
      .atl-miniapp-actions { display: flex; justify-content: flex-end; }
      .atl-miniapp-build { border: none; border-radius: 9px;
        background: var(--accent); color: #fff; padding: 8px 16px;
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-miniapp-build:hover { background: var(--accent-2); }
      .atl-miniapp-build:disabled { opacity: 0.5; cursor: default; }

      /* busy state */
      .atl-miniapp-busy { flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px;
        color: var(--ink-dim); font-size: 12.5px; padding: 12px;
        text-align: center; }
      .atl-miniapp-spin { width: 22px; height: 22px; border-radius: 50%;
        border: 3px solid var(--border); border-top-color: var(--accent);
        animation: atl-miniapp-spin 0.8s linear infinite; }
      @keyframes atl-miniapp-spin { to { transform: rotate(360deg); } }

      /* app state */
      .atl-miniapp-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-miniapp-desc { flex: 1; min-width: 0; font-size: 11.5px;
        color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .atl-miniapp-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-miniapp-btn:hover { border-color: var(--accent); }
      .atl-miniapp-view { flex: 1; min-height: 0; display: flex;
        flex-direction: column; }
      .atl-miniapp-view iframe { flex: 1; min-height: 0; width: 100%;
        border: none; display: block; background: #fff; }
      .atl-miniapp-src { flex: 1; min-height: 0; overflow: auto; margin: 0;
        padding: 10px 12px; background: #2b2320; color: #f3ead8;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap; word-break: break-word; }
    `;
    const style = el('style');
    style.id = 'atl-miniapp-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend helper: JSON POST, never throw on HTTP errors (only network) ──
  // Mutating routes require the shared-secret header when the backend was
  // launched by main.js (window.atelier.token via preload); in a plain
  // browser the bridge is absent and a hand-run backend enforces no token.
  async function apiPost(path, bodyObj) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + path, {
      method: 'POST', headers, body: JSON.stringify(bodyObj),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // ── live instance registry + board-scoped persistence ─────────────────────
  // id -> { id, handle, bodyEl, description, html, promptTa }
  const instances = new Map();
  let restoring = false;
  let dragId = null; // set on mousedown inside a miniapp card, persisted on mouseup

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const rect = inst.handle.getRect();
      const fits = typeof inst.html === 'string' && inst.html.length <= PERSIST_HTML_MAX;
      arr.push({
        id: inst.id,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        description: inst.description || '',
        // Oversize apps persist prompt-only: html null + oversize true, so the
        // restore path can prefill the prompt and say why the app is gone.
        // When html is null the flag CANNOT be derived (a restored oversize
        // card holds html null); carry the instance's flag through instead,
        // or the first persist after a restore would erase the note.
        html: fits ? inst.html : null,
        oversize: inst.html ? !fits : !!inst.oversize,
      });
    });
    A.store.set(STORE_KEY, arr);
  }

  // ── card states ────────────────────────────────────────────────────────────
  function showPrompt(inst, prefill, noteText) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';
    const wrap = el('div', 'atl-miniapp-prompt');
    const ta = document.createElement('textarea');
    ta.placeholder = 'Describe a small app — e.g. a pomodoro timer, a tip splitter…';
    ta.maxLength = DESC_MAX;
    ta.value = prefill || '';
    const note = el('div', 'atl-miniapp-note', noteText || '');
    const actions = el('div', 'atl-miniapp-actions');
    const buildBtn = el('button', 'atl-miniapp-build', 'Build');
    buildBtn.type = 'button';
    actions.appendChild(buildBtn);
    wrap.append(ta, note, actions);
    body.appendChild(wrap);
    inst.promptTa = ta; // the will-switch flush reads the live draft from here

    buildBtn.addEventListener('click', () => {
      const desc = ta.value.trim();
      if (desc.length < DESC_MIN) {
        note.textContent = 'Describe the app in a few more words.';
        return;
      }
      build(inst, desc);
    });
  }

  function showBusy(inst) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';
    const wrap = el('div', 'atl-miniapp-busy');
    wrap.append(
      el('div', 'atl-miniapp-spin'),
      el('div', null, 'Building your app — this can take a minute…')
    );
    body.appendChild(wrap);
  }

  function showApp(inst) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';

    const head = el('div', 'atl-miniapp-head');
    const desc = el('span', 'atl-miniapp-desc', inst.description || '');
    desc.title = inst.description || ''; // CSS truncates; hover shows it all
    const rebuildBtn = el('button', 'atl-miniapp-btn', 'Rebuild');
    rebuildBtn.type = 'button';
    rebuildBtn.title = 'Describe and build again';
    const srcBtn = el('button', 'atl-miniapp-btn', 'Source');
    srcBtn.type = 'button';
    srcBtn.title = 'Toggle the generated HTML';
    head.append(desc, rebuildBtn, srcBtn);

    const view = el('div', 'atl-miniapp-view');
    const frame = document.createElement('iframe');
    // SECURITY INVARIANT: sandbox="allow-scripts" EXACTLY — NEVER add
    // allow-same-origin. With both, the srcdoc becomes same-origin with this
    // app and its scripts could read localStorage and reach the preload
    // bridge (window.atelier.token) via window.parent. Scripts-only keeps it
    // in a unique opaque origin: no storage, no token, no parent access.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = inst.html;
    // Accepted risk: from that unique origin the app's scripts CAN still
    // fetch http://127.0.0.1:8765 read-only GETs (the backend CORS-allows
    // the null Origin by design); mutating routes stay token-gated and the
    // token is unreachable from the sandbox.
    const pre = el('pre', 'atl-miniapp-src');
    pre.textContent = inst.html; // server-generated string: textContent only
    pre.style.display = 'none';
    view.append(frame, pre);
    body.append(head, view);

    let showingSrc = false;
    srcBtn.addEventListener('click', () => {
      showingSrc = !showingSrc;
      // hide, don't rebuild: the iframe keeps running, so app state survives
      frame.style.display = showingSrc ? 'none' : '';
      pre.style.display = showingSrc ? '' : 'none';
      srcBtn.textContent = showingSrc ? 'App' : 'Source';
    });
    rebuildBtn.addEventListener('click', () => {
      // back to the prompt, prefilled; the last html stays on the instance
      // until a new build succeeds, so nothing is lost by peeking here
      showPrompt(inst, inst.description || '', '');
    });
  }

  // ── build: POST /miniapp, then render | error-note | unreachable-note ─────
  function build(inst, desc) {
    inst.description = desc; // capture now: a mid-build persist keeps the text
    showBusy(inst);
    apiPost('/miniapp', { description: desc })
      .then((r) => {
        // Identity check, not id membership: a board switch away-and-back
        // mid-build restores a NEW instance under the SAME persisted id, so
        // instances.has(inst.id) would pass while this closure's inst is the
        // dead object (detached bodyEl, never persisted).
        if (instances.get(inst.id) !== inst) return; // card closed or replaced mid-build
        if (r.ok && r.data && typeof r.data.html === 'string' && r.data.html) {
          inst.html = r.data.html;
          showApp(inst);
          persist();
          return;
        }
        const msg = (r.data && r.data.error)
          ? String(r.data.error)
          : 'The build failed (HTTP ' + r.status + ').';
        showPrompt(inst, desc, msg);
      })
      .catch(() => {
        if (instances.get(inst.id) !== inst) return; // same identity rule as above
        showPrompt(inst, desc, 'Backend unreachable — is the Atelier server running?');
      });
  }

  // ── spawn one mini-app card ────────────────────────────────────────────────
  function spawnMiniapp(opts = {}) {
    const id = opts.id
      || ('m-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id); // idempotence backstop

    const card = el('section', 'card app-card atl-miniapp-card');
    card.dataset.miniappInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(
      el('span', 'card-dot'),
      el('span', 'card-title', 'Mini-app'),
      el('span', 'card-x', '×')
    );
    const body = el('div', 'app-body atl-miniapp-body');
    card.append(bar, body);

    let rect = opts.rect;
    if (!rect) {
      let pos = opts.worldPos;
      if (!pos) {
        const c = A.canvas.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
        pos = { x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 };
      }
      rect = { x: pos.x, y: pos.y, w: CARD_W, h: CARD_H };
    }
    const handle = A.canvas.addCard(card, rect);

    const inst = {
      id,
      handle,
      bodyEl: body,
      description: typeof opts.description === 'string' ? opts.description : '',
      html: typeof opts.html === 'string' && opts.html ? opts.html : null,
      oversize: !!opts.oversize, // survives persists while html is null
      promptTa: null,
    };
    instances.set(id, inst);

    // mark this instance dirty on any pointer interaction (drag or resize)
    card.addEventListener('mousedown', () => { dragId = id; }, true);

    if (inst.html) {
      showApp(inst);
    } else {
      showPrompt(inst, inst.description, opts.oversize
        ? 'This app was too large to save — press Build to regenerate it.'
        : '');
    }

    if (!restoring) persist();
    return inst;
  }

  // persist rects once a drag/resize gesture ends (widgets.js idiom)
  window.addEventListener('mouseup', () => {
    if (dragId && instances.has(dragId)) persist();
    dragId = null;
  });

  // core's tidy() (zoombar) moves cards without a drag gesture — flush then too
  A.bus.on('cards:rearranged', () => persist());

  // core wires .card-x / Delete key / removeAllCards -> card:removed
  A.bus.on('card:removed', (d) => {
    const node = d && d.el;
    const rid = node && node.dataset && node.dataset.miniappInstance;
    if (!rid || !instances.has(rid)) return;
    instances.delete(rid);
    persist();
  });

  // ── restore persisted cards (load + in-place board switch) ─────────────────
  // Idempotent: a record whose id is already live is skipped, so a stray
  // double 'boards:switched' cannot duplicate cards. On a board switch,
  // core's removeAllCards already fired 'card:removed' per card (clearing
  // the map via the handler above) and boards.js swapped in the TARGET
  // board's store keys before emitting — this re-mounts against clean slate.
  function restoreFromStore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    restoring = true;
    try {
      saved.forEach((rec) => {
        if (!rec || !rec.id) return;
        if (instances.has(rec.id)) return; // already live
        spawnMiniapp({
          id: String(rec.id),
          rect: {
            x: Number(rec.x) || 0,
            y: Number(rec.y) || 0,
            w: Number(rec.w) || CARD_W,
            h: Number(rec.h) || CARD_H,
          },
          description: typeof rec.description === 'string' ? rec.description : '',
          html: typeof rec.html === 'string' && rec.html ? rec.html : null,
          oversize: !!rec.oversize,
        });
      });
    } finally {
      restoring = false;
    }
  }
  restoreFromStore();

  // ── in-place board switch ──────────────────────────────────────────────────
  // No debounce timer exists in this module, so there is no pending write to
  // flush — but the prompt textarea is volatile DOM state: capture any live
  // draft into its record and persist synchronously so a switch (or a
  // reason:'export' snapshot, which also lands here on purpose — exports
  // want the freshest store, and persisting is non-destructive) never loses
  // a half-typed description.
  A.bus.on('boards:will-switch', () => {
    let dirty = false;
    instances.forEach((inst) => {
      if (!inst.promptTa || !inst.promptTa.isConnected) return;
      const draft = inst.promptTa.value.trim();
      if (draft && draft !== inst.description) {
        inst.description = draft;
        dirty = true;
      }
    });
    if (dirty) persist();
  });

  // Re-mount from the restored store. Teardown of the outgoing board's cards
  // already happened per card via 'card:removed'; the sweep below is a safety
  // net for any instance whose card left the DOM without that event. It must
  // NOT persist(): the store now holds the TARGET board's records — writing
  // the (normally empty) map here would erase them.
  A.bus.on('boards:switched', () => {
    instances.forEach((inst, id) => {
      if (inst.handle && inst.handle.el && inst.handle.el.isConnected) return;
      instances.delete(id);
    });
    restoreFromStore();
  });

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('miniapp', {
    label: 'Mini-app',
    icon: '⚒',
    create(worldPos) {
      const inst = spawnMiniapp(worldPos ? { worldPos } : {});
      // spawnApp sees dataset.cardId and won't re-add the card
      return inst ? inst.handle.el : null;
    },
  });

  // ── scriptable hook for headless testing / the self-check ─────────────────
  window.AtelierMiniapps = {
    spawn: spawnMiniapp,
    restoreFromStore,
    instances,
    STORE_KEY,
  };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('miniapp');
    console.assert(registered, '[miniapp] miniapp app type not registered');
    const styles = !!document.getElementById('atl-miniapp-styles');
    console.assert(styles, '[miniapp] styles not injected');
    if (registered && styles) {
      console.log('[miniapp] self-check passed — miniapp app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
