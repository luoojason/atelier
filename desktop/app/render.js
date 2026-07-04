'use strict';

/* ===========================================================================
   Atelier feature module — Make the video  (app/render.js)

   A one-action "make me a video" flow that runs a workspace video pipeline
   INSIDE the app and plays the finished MP4 without leaving the canvas. Pick
   what to make (a Top-5 ranking countdown, or a Reddit story), fill one blank,
   and a plain-English progress line narrates the render ("Recording the
   voiceover…", "Stitching it together…") while it polls the backend. When it's
   done a player pops up with the video, a Download button, and — if the
   approvals lane is loaded — a one-click "Send to approvals" so the clip lands
   in the review queue. If the pipeline fails, the raw tail is shown plainly so
   the problem is legible instead of a spinner that never stops.

   Why a floating panel and not an overlay
   ---------------------------------------
   This is a single action, not a front door. It mounts through core's
   A.ui.openPanel (draggable card, working ×, click-off backdrop, Escape closes
   the topmost panel) so there is no hand-rolled backdrop or focus trap to keep
   correct. The panel's body is swapped between four states: setup, progress,
   player, error.

   Backend (already implemented, no wiring needed):
     POST /render {kind:"ranking"|"reddit", topic, text, voice?}
        -> {id, status:"running"}  OR  a 200 body with {error:"…"} on a
           validation/start failure (so check data.error before res.ok).
        Mutating -> carries X-Atelier-Token when the server sets ATELIER_TOKEN.
     GET  /render/{id} -> {id, status:"running"|"done"|"error", rel, tail}
     GET  /workspace/raw?path=<rel> -> streams video/mp4 (bare <video src>, ok)

   Contract: builds only against window.Atelier (+ fetch and the optional
   window.atelier token bridge). Injects its own CSS. XSS rule: every dynamic
   string enters the DOM via textContent only.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui || typeof A.ui.openPanel !== 'function') {
    console.warn('[render] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 1500;            // render-status poll cadence
  const PHRASE_MS = 3600;          // how often the plain-English line advances
  const TAIL_CHARS = 2000;         // cap on error tail put in the DOM

  const KINDS = {
    ranking: {
      label: 'Top-5 ranking',
      blurb: 'A countdown video ranking the best of anything.',
      field: 'topic',
      inputKind: 'text',
      fieldLabel: 'What should the countdown be about?',
      placeholder: 'best budget wireless earbuds',
    },
    reddit: {
      label: 'Reddit story',
      blurb: 'A captioned vertical video that narrates a story.',
      field: 'text',
      inputKind: 'textarea',
      fieldLabel: 'Paste the story to narrate',
      placeholder: 'Paste the cleaned-up story text here…',
    },
  };

  // The friendly render narration. The backend does not expose granular
  // progress, so these advance on a gentle timer while the job is running —
  // enough to feel alive without pretending to know the exact stage.
  const PHRASES = [
    'Warming up the studio…',
    'Writing the script…',
    'Recording the voiceover…',
    'Laying out the visuals…',
    'Stitching it into a video…',
    'Almost there — finishing the render…',
  ];

  // ── tiny helpers ────────────────────────────────────────────────────────────
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
  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── backend helper (guarded token header; never throws) ─────────────────────
  // Mirrors cost.js: returns { ok, status, data } for both GET and POST.
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
  async function postJSON(path, body) {
    return api(path, {
      method: 'POST',
      headers: window.atelier && window.atelier.token
        ? { 'X-Atelier-Token': window.atelier.token, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  // ── injected CSS (design tokens from styles.css) ────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-render-styles')) return;
    const css = `
      .atl-render { width: 460px; max-width: 82vw; display: flex; flex-direction: column;
        gap: 16px; color: var(--ink); }

      .atl-render-intro { font-size: 13px; color: var(--ink-mid); line-height: 1.5; }

      .atl-render-kinds { display: flex; gap: 10px; }
      .atl-render-kind { flex: 1; text-align: left; background: var(--panel);
        border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 13px;
        cursor: pointer; display: flex; flex-direction: column; gap: 4px; font: inherit;
        transition: border-color .14s ease, background-color .14s ease, box-shadow .14s ease; }
      .atl-render-kind:hover { border-color: var(--accent); }
      .atl-render-kind[aria-pressed="true"] { border-color: var(--accent);
        background: var(--accent-soft); box-shadow: var(--shadow-sm); }
      .atl-render-kind:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-render-kind .k { font-size: 13.5px; font-weight: 700; color: var(--ink); }
      .atl-render-kind .b { font-size: 12px; color: var(--ink-mid); line-height: 1.4; }

      .atl-render-field { display: flex; flex-direction: column; gap: 6px; }
      .atl-render-field label { font-size: 12.5px; font-weight: 600; color: var(--ink-mid); }
      .atl-render-field input, .atl-render-field textarea { border: 1px solid var(--border);
        border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px; color: var(--ink);
        background: #faf7f1; outline: none; width: 100%; box-sizing: border-box; }
      .atl-render-field textarea { min-height: 120px; resize: vertical; line-height: 1.5; }
      .atl-render-field input:focus, .atl-render-field textarea:focus { border-color: var(--accent); }

      .atl-render-actions { display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
      .atl-render-btn { border: none; border-radius: 10px; background: var(--accent); color: #fff;
        padding: 10px 18px; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
      .atl-render-btn:hover { background: var(--accent-2); }
      .atl-render-btn:disabled { opacity: .5; cursor: default; }
      .atl-render-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); font-weight: 600; }
      .atl-render-btn.ghost:hover { border-color: var(--accent); color: var(--ink); background: transparent; }
      .atl-render-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      /* progress state */
      .atl-render-progress { display: flex; align-items: center; gap: 13px; padding: 8px 2px; }
      .atl-render-spin { width: 20px; height: 20px; flex: 0 0 20px; border-radius: 50%;
        border: 2.5px solid var(--accent-soft); border-top-color: var(--accent);
        animation: atl-render-spin .8s linear infinite; }
      @keyframes atl-render-spin { to { transform: rotate(360deg); } }
      .atl-render-progress .txt { font-size: 13.5px; font-weight: 600; color: var(--ink); }
      .atl-render-hint { font-size: 12px; color: var(--ink-dim); line-height: 1.5; }

      /* player state */
      .atl-render-video { width: 100%; border-radius: var(--radius); background: #000;
        display: block; max-height: 60vh; box-shadow: var(--shadow-sm); }
      .atl-render-done-h { font-size: 14px; font-weight: 700; color: var(--ink); }

      /* error state */
      .atl-render-err-h { font-size: 14px; font-weight: 700; color: var(--accent); }
      .atl-render-tail { margin: 0; padding: 11px 12px; background: #faf7f1;
        border: 1px solid var(--border-soft); border-radius: 10px; font-size: 11.5px;
        color: var(--ink-mid); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
        max-height: 200px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      @media (prefers-reduced-motion: reduce) {
        .atl-render-spin { animation: none; }
        .atl-render-kind { transition: none; }
      }
    `;
    const style = el('style');
    style.id = 'atl-render-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── panel + run state ───────────────────────────────────────────────────────
  let panelRef = null;     // { el, body, close } from openPanel
  let rootEl = null;       // the swappable container inside the panel body
  let runToken = 0;        // bumps on every start/close so stale polls/timers stop
  let phraseTimer = null;

  function clearPhraseTimer() {
    if (phraseTimer) { clearTimeout(phraseTimer); phraseTimer = null; }
  }

  // The panel can be torn down by four paths — our close(), core's ×, its
  // click-off backdrop, and Escape (which calls p.remove() directly, bypassing
  // any listener). So "is the panel still alive?" is decided by the DOM, not a
  // flag: guards check isConnected, and ensurePanel rebuilds a stale ref.
  function panelAlive() {
    return !!(panelRef && panelRef.el && panelRef.el.isConnected);
  }

  function ensurePanel() {
    if (panelAlive()) return;
    panelRef = null;
    rootEl = el('div', 'atl-render');
    rootEl.setAttribute('role', 'group');
    rootEl.setAttribute('aria-label', 'Make a video');
    panelRef = A.ui.openPanel('Make a video', rootEl, { backdrop: true });
  }

  function swap(node) {
    if (!rootEl) return;
    rootEl.textContent = '';
    rootEl.appendChild(node);
  }

  // ── setup state ─────────────────────────────────────────────────────────────
  function renderSetup(prefill) {
    prefill = prefill || {};
    let kind = KINDS[prefill.kind] ? prefill.kind : 'ranking';

    const wrap = el('div', 'atl-render');
    wrap.appendChild(el('div', 'atl-render-intro',
      'Pick what to make and fill one blank. It renders here and plays in-app when it is ready.'));

    // kind chooser (segmented, keyboard + SR friendly)
    const kinds = el('div', 'atl-render-kinds');
    kinds.setAttribute('role', 'group');
    kinds.setAttribute('aria-label', 'What kind of video');
    const btns = {};
    Object.keys(KINDS).forEach((k) => {
      const def = KINDS[k];
      const b = el('button', 'atl-render-kind');
      b.type = 'button';
      b.setAttribute('aria-pressed', k === kind ? 'true' : 'false');
      b.appendChild(el('span', 'k', def.label));
      b.appendChild(el('span', 'b', def.blurb));
      b.addEventListener('click', () => selectKind(k));
      btns[k] = b;
      kinds.appendChild(b);
    });
    wrap.appendChild(kinds);

    // the single blank (rebuilt when the kind changes)
    const fieldHost = el('div');
    wrap.appendChild(fieldHost);

    // actions
    const actions = el('div', 'atl-render-actions');
    const makeBtn = el('button', 'atl-render-btn', 'Make the video');
    makeBtn.type = 'button';
    actions.appendChild(makeBtn);
    wrap.appendChild(actions);

    let input = null;
    function buildField() {
      const def = KINDS[kind];
      fieldHost.textContent = '';
      const field = el('div', 'atl-render-field');
      const id = 'atl-render-in-' + kind;
      const lab = el('label', null, def.fieldLabel);
      lab.setAttribute('for', id);
      input = document.createElement(def.inputKind === 'textarea' ? 'textarea' : 'input');
      if (def.inputKind !== 'textarea') input.type = 'text';
      input.id = id;
      input.placeholder = def.placeholder;
      input.setAttribute('aria-label', def.fieldLabel);
      const seed = prefill[def.field];
      if (seed) input.value = String(seed);
      if (def.inputKind !== 'textarea') {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
      field.append(lab, input);
      fieldHost.appendChild(field);
      setTimeout(() => { try { input.focus(); } catch {} }, 30);
    }
    function selectKind(k) {
      if (!KINDS[k]) return;
      kind = k;
      Object.keys(btns).forEach((kk) => btns[kk].setAttribute('aria-pressed', kk === k ? 'true' : 'false'));
      buildField();
    }
    function submit() {
      const value = input ? input.value.trim() : '';
      const def = KINDS[kind];
      if (!value) { if (input) input.focus(); return; }
      const body = { kind, voice: prefill.voice || '' };
      body[def.field] = value;
      startRender(body);
    }
    makeBtn.addEventListener('click', submit);

    buildField();
    swap(wrap);
  }

  // ── progress state ──────────────────────────────────────────────────────────
  function renderProgress(token) {
    const wrap = el('div', 'atl-render');
    const row = el('div', 'atl-render-progress');
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');
    row.appendChild(el('div', 'atl-render-spin'));
    const txt = el('div', 'txt', PHRASES[0]);
    row.appendChild(txt);
    wrap.appendChild(row);
    wrap.appendChild(el('div', 'atl-render-hint',
      'This can take a minute or two. You can keep working — leave this open and it will play here when it is done.'));
    swap(wrap);

    // advance the plain-English line on a gentle timer (stops at the last one)
    let i = 0;
    clearPhraseTimer();
    const advance = () => {
      if (token !== runToken || !panelAlive()) return;
      if (i < PHRASES.length - 1) {
        i += 1;
        txt.textContent = PHRASES[i];
        phraseTimer = setTimeout(advance, PHRASE_MS);
      }
    };
    if (!prefersReducedMotion()) phraseTimer = setTimeout(advance, PHRASE_MS);
  }

  // ── player state ────────────────────────────────────────────────────────────
  function renderDone(rel, kind) {
    clearPhraseTimer();
    const wrap = el('div', 'atl-render');
    wrap.appendChild(el('div', 'atl-render-done-h', 'Your video is ready.'));

    const src = BASE + '/workspace/raw?path=' + encodeURIComponent(rel);
    const video = document.createElement('video');
    video.className = 'atl-render-video';
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-label', 'Rendered video');
    // Autoplay may be blocked (the user's click happened before the render
    // finished); controls are present regardless, so swallow a rejected play.
    video.addEventListener('canplay', () => { const p = video.play(); if (p && p.catch) p.catch(() => {}); }, { once: true });
    wrap.appendChild(video);

    const actions = el('div', 'atl-render-actions');

    // Download — a real anchor so it works with keyboard + right-click too.
    const dl = document.createElement('a');
    dl.className = 'atl-render-btn ghost';
    dl.textContent = 'Download';
    dl.href = src;
    dl.download = baseName(rel) || 'video.mp4';
    dl.setAttribute('role', 'button');
    actions.appendChild(dl);

    // Send to approvals — only when the lane is loaded.
    const appr = window.AtelierApprovals;
    if (appr && typeof appr.enqueue === 'function') {
      const send = el('button', 'atl-render-btn ghost', 'Send to approvals');
      send.type = 'button';
      send.addEventListener('click', () => {
        const added = appr.enqueue({
          key: 'render:' + rel,
          kind: 'file',
          path: rel,
          title: 'Rendered video (' + (baseName(rel) || rel) + ')',
          preview: 'A finished video is ready in your workspace. Play it above to review.',
          previewLoaded: true,
        });
        send.disabled = true;
        send.textContent = added ? 'Sent to approvals' : 'Already in approvals';
        if (A.ui && typeof A.ui.toast === 'function') {
          A.ui.toast(added ? 'Sent to the approvals lane.' : 'Already waiting in approvals.');
        }
      });
      actions.appendChild(send);
    }

    const again = el('button', 'atl-render-btn', 'Make another');
    again.type = 'button';
    again.addEventListener('click', () => renderSetup({ kind }));
    actions.appendChild(again);

    wrap.appendChild(actions);
    swap(wrap);
  }

  // ── error state ─────────────────────────────────────────────────────────────
  function renderError(message, tail, retryPrefill) {
    clearPhraseTimer();
    const wrap = el('div', 'atl-render');
    wrap.appendChild(el('div', 'atl-render-err-h', 'That render did not finish.'));
    wrap.appendChild(el('div', 'atl-render-intro', message || 'The video pipeline stopped before producing a file.'));
    if (tail && String(tail).trim()) {
      const pre = el('pre', 'atl-render-tail', String(tail).slice(-TAIL_CHARS));
      pre.setAttribute('aria-label', 'Pipeline output');
      wrap.appendChild(pre);
    }
    const actions = el('div', 'atl-render-actions');
    const back = el('button', 'atl-render-btn', 'Try again');
    back.type = 'button';
    back.addEventListener('click', () => renderSetup(retryPrefill || {}));
    actions.appendChild(back);
    wrap.appendChild(actions);
    swap(wrap);
  }

  // ── the run: POST /render, then poll GET /render/{id} ───────────────────────
  async function startRender(body) {
    ensurePanel();
    const token = ++runToken;
    renderProgress(token);

    const res = await postJSON('/render', body);
    if (token !== runToken || !panelAlive()) return; // panel closed / superseded

    // The backend reports validation/start failures as HTTP 200 with {error}.
    if (res.data && res.data.error) {
      renderError(res.data.error, '', body);
      return;
    }
    if (!res.ok || !res.data || !res.data.id) {
      renderError(
        res.status === 0
          ? 'Could not reach the render service. Is the app backend running?'
          : 'The render could not be started.',
        '', body);
      return;
    }
    pollRender(res.data.id, token, body);
  }

  function pollRender(id, token, prefill) {
    const tick = async () => {
      if (token !== runToken || !panelAlive()) return;    // superseded or closed
      const res = await api('/render/' + encodeURIComponent(id));
      if (token !== runToken || !panelAlive()) return;
      const d = res.data;
      if (res.status === 404) { renderError('The render job was lost before it finished.', '', prefill); return; }
      if (!d) { setTimeout(tick, POLL_MS); return; } // transient blip — keep polling
      if (d.status === 'running') { setTimeout(tick, POLL_MS); return; }
      if (d.status === 'done' && d.rel) { renderDone(d.rel, prefill && prefill.kind); return; }
      // status === 'error' (or done without a file) — show the tail plainly.
      renderError('The video pipeline reported an error. The output is below.', d.tail, prefill);
    };
    tick();
  }

  // ── public API ──────────────────────────────────────────────────────────────
  // open(opts?) — opts: { kind:'ranking'|'reddit', topic, text, voice }.
  // If a required blank is already supplied, render starts immediately;
  // otherwise the setup form opens (prompting for the missing blank).
  function open(opts) {
    opts = opts || {};
    ensurePanel();
    const def = KINDS[opts.kind];
    if (def) {
      const val = opts[def.field];
      if (val && String(val).trim()) {
        const body = { kind: opts.kind, voice: opts.voice || '' };
        body[def.field] = String(val).trim();
        startRender(body);
        return;
      }
    }
    renderSetup(opts);
  }

  function close() {
    runToken++;               // supersede any in-flight poll / phrase timer
    clearPhraseTimer();
    if (panelRef && typeof panelRef.close === 'function') { try { panelRef.close(); } catch {} }
    panelRef = null;
    rootEl = null;
  }

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'render.open', label: 'Make a video', icon: '▶', section: 'Create',
      keywords: 'render video mp4 make ranking reddit countdown play movie clip',
      run() { open(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);   // covers palette.js loading later

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierRender = { open, close, isOpen: () => !!panelRef };

  (function selfCheck() {
    const registered = !!(window.AtelierRender && typeof window.AtelierRender.open === 'function');
    const builders = typeof renderSetup === 'function' && typeof startRender === 'function';
    console.assert(registered, '[render] module did not register window.AtelierRender');
    console.assert(builders, '[render] state builders missing');
    if (registered && builders) {
      console.log('[render] self-check passed — "Make a video" ready (' +
        Object.keys(KINDS).length + ' kinds, palette + AtelierRender.open).');
    }
  })();
})();
