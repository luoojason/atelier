'use strict';

/* ===========================================================================
   Atelier feature module — State-carrying sound cues   (app/sound.js)

   Gives a walk-away user their status by EAR. When you turn it on, Atelier
   plays a short, subtle tone at the three moments that actually matter — so
   you can look away from the canvas and still know what happened:

     1) A run FINISHED       — a top-level session flipped running -> idle.
                               → a soft rising chime (resolved, "done").
     2) Something NEEDS YOU  — the approvals lane (approvals.js) grew.
                               → a gentle two-note ping ("come look").
     3) A run ERRORED        — a top-level session flipped running -> error.
                               → a quiet low falling tone ("something's off").

   No assets, CSP-clean
   --------------------
   Every sound is synthesised live with the Web Audio API (OscillatorNode +
   GainNode) — there are no .mp3/.wav files, no <audio> tags, no network, no
   media-src. That keeps it inside the app's strict CSP with nothing to
   allow-list. Tones are sine/triangle with short exponential envelopes so
   they read as a warm bell, never a harsh beep.

   Opt-in, quiet by default
   ------------------------
   Audio is intrusive, so this ships OFF. A small "Sounds" pill in the topbar
   turns it on; the preference persists in Atelier.store under 'sound.enabled'.
   Because the pill click is a real user gesture, that is exactly where we
   create and resume the AudioContext — Chromium (and therefore the Electron
   renderer) starts every AudioContext "suspended" until a gesture, so the
   context is only ever built/resumed from inside the enable click, and a soft
   confirmation tone the moment you turn it on proves it works.

   How it detects events (frontend-only, no backend, no new bridge)
   ----------------------------------------------------------------
   There is no run bus, so this mirrors notify.js / approvals.js / cost.js: it
   polls GET /sessions on a light, token-free cadence and watches each
   top-level session cross running -> idle (finished) or running -> error. For
   approvals it reads window.AtelierApprovals.pendingCount() each tick and
   chimes when it grows. Both are seeded silently on the first pass, so turning
   sounds on never retroactively fires for edges that already happened. At most
   ONE cue plays per tick (error > approval > finished) so overlapping events
   never turn into a pile-up.

   Boundaries: window.Atelier (bus/store/ui) + the optional window.atelier
   token bridge for reads + the standard Web Audio API. Injects its own CSS,
   reuses styles.css design tokens, keyboard + screen-reader accessible, and
   ends with a selfCheck() console log like its siblings.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store) {
    console.warn('[sound] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 2000;                 // session/approval poll cadence (token-free)
  const ENABLED_KEY = 'sound.enabled';  // Atelier.store: opt-in flag (default false)

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const supported = typeof AudioCtor === 'function';

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

  function toast(msg) {
    if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(msg);
  }

  // ── screen-reader live region (announces state changes for keyboard users) ──
  let liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = el('div', 'atl-sound-sr');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 30);
  }

  // ── guarded backend read (prefer the token bridge; never throws) ────────────
  // Same shape as notify.js / approvals.js apiGet — the window.atelier bridge
  // dodges the page CSP origin allow-list; the plain fetch path is the fallback.
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

  /* ── the audio engine ──────────────────────────────────────────────────────
     A single shared AudioContext, built lazily and only ever resumed from a
     user gesture (the enable click). A master gain keeps the whole thing quiet
     — cues are meant to be noticed, not to make you jump. Each note is one
     oscillator through its own gain, shaped with a fast exponential attack and
     a smooth exponential release so there is no click at the edges. */

  const MASTER_GAIN = 0.9;     // headroom under the destination
  const PEAK = 0.075;          // per-note peak (subtle by design)
  let ctx = null;              // AudioContext (created on first gesture)
  let master = null;           // master GainNode -> destination

  function ensureCtx() {
    if (!supported) return null;
    if (ctx) return ctx;
    try {
      ctx = new AudioCtor();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  // Best-effort resume. Chromium starts every context "suspended"; a gesture
  // clears that. Safe to call repeatedly — a running context ignores it.
  function resumeCtx() {
    if (!ctx) return;
    try { if (ctx.state === 'suspended') ctx.resume(); } catch { /* ignore */ }
  }

  // Schedule one enveloped note. `to` (optional) glides the pitch to a second
  // frequency across the note for the falling error tone.
  function note(freq, tStart, dur, opts) {
    if (!ctx || !master) return;
    opts = opts || {};
    const type = opts.type || 'sine';
    const peak = opts.peak != null ? opts.peak : PEAK;
    let osc, g;
    try {
      osc = ctx.createOscillator();
      g = ctx.createGain();
    } catch { return; }
    osc.type = type;
    osc.frequency.setValueAtTime(freq, tStart);
    if (opts.to != null) {
      try { osc.frequency.exponentialRampToValueAtTime(opts.to, tStart + dur); } catch { /* ignore */ }
    }
    const attack = Math.min(0.02, dur * 0.25);
    g.gain.setValueAtTime(0.0001, tStart);
    g.gain.exponentialRampToValueAtTime(peak, tStart + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, tStart + dur);   // never ramp to exactly 0
    osc.connect(g);
    g.connect(master);
    osc.start(tStart);
    osc.stop(tStart + dur + 0.03);
  }

  // Musical pitches used below (Hz).
  const C5 = 523.25, G5 = 783.99, GS5 = 830.61, A3 = 220.0, E3 = 164.81, A5 = 880.0;

  // FINISHED — a soft rising perfect-fifth chime (C5 -> G5). Resolved, "done".
  function playFinished(gain) {
    if (!ensureCtx()) return;
    resumeCtx();
    const t = ctx.currentTime + 0.01;
    const p = gain != null ? gain : PEAK;
    note(C5, t, 0.16, { type: 'sine', peak: p * 0.85 });
    note(G5, t + 0.12, 0.30, { type: 'sine', peak: p });
  }

  // NEEDS APPROVAL — a gentle two-note ping (equal soft bells). "Come look."
  // A doublet (not a glide) so it never reads as either finished or error.
  function playApproval() {
    if (!ensureCtx()) return;
    resumeCtx();
    const t = ctx.currentTime + 0.01;
    note(GS5, t, 0.15, { type: 'triangle', peak: PEAK * 0.8 });
    note(GS5, t + 0.19, 0.18, { type: 'triangle', peak: PEAK * 0.8 });
  }

  // ERROR — a quiet low falling tone (A3 -> E3). "Something's off." Kept soft
  // and sine so it warns without being harsh.
  function playError() {
    if (!ensureCtx()) return;
    resumeCtx();
    const t = ctx.currentTime + 0.01;
    note(A3, t, 0.45, { type: 'sine', peak: PEAK * 0.9, to: E3 });
  }

  // The one-time confirmation the moment you enable, so you know it works.
  function playHello() {
    if (!ensureCtx()) return;
    resumeCtx();
    const t = ctx.currentTime + 0.01;
    note(A5, t, 0.16, { type: 'sine', peak: PEAK * 0.7 });
  }

  // ── detector 1: top-level session finished / errored ────────────────────────
  const sessionStatus = new Map();  // id -> last seen status
  let sessionsSeeded = false;

  async function pollSessions() {
    const d = await apiGet('/sessions');
    const sessions = (d && Array.isArray(d.sessions)) ? d.sessions : [];
    let finished = 0;
    let errored = 0;
    sessions.forEach((s) => {
      if (!s || s.id == null) return;
      const prev = sessionStatus.get(s.id);
      const now = s.status;                     // "idle" | "running" | "error"
      const topLevel = s.parent_id == null;     // don't chime for each child turn
      // Maintain the map whether enabled or not, so turning sounds on never
      // retroactively fires for edges that happened while they were off.
      if (sessionsSeeded && prev === 'running' && topLevel) {
        if (now === 'error') errored += 1;
        else if (now !== 'running') finished += 1;   // idle (or any settled state)
      }
      sessionStatus.set(s.id, now);
    });
    sessionsSeeded = true;
    return { finished, errored };
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
  // At most one cue per tick, most urgent wins: error > approval > finished.
  async function tick() {
    let sess = { finished: 0, errored: 0 };
    try { sess = await pollSessions(); } catch { sess = { finished: 0, errored: 0 }; }
    let approvalDelta = 0;
    try { approvalDelta = pollApprovals(); } catch { approvalDelta = 0; }

    if (!isEnabled()) return;

    if (sess.errored > 0) { playError(); return; }
    if (approvalDelta > 0) { playApproval(); return; }
    if (sess.finished > 0) { playFinished(); }
  }

  // ── enable / disable ────────────────────────────────────────────────────────
  function enable() {
    if (!supported) {
      toast('Sound cues are not available here.');
      return false;
    }
    ensureCtx();       // build inside this gesture …
    resumeCtx();       // … and clear the "suspended" autoplay state.
    setEnabledFlag(true);
    updatePill();
    announce('Sounds on — you will hear a tone when a run finishes, needs approval, or errors.');
    playHello();       // one confirmation tone so you know it works.
    return true;
  }

  function disable() {
    setEnabledFlag(false);
    updatePill();
    announce('Sounds off.');
  }

  function toggleEnabled() { if (isEnabled()) disable(); else enable(); }

  // ── injected CSS (reuses styles.css design tokens) ─────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-sound-styles')) return;
    const css = `
      .atl-sound-pill { display: inline-flex; align-items: center; gap: 7px;
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 999px; padding: 5px 12px 5px 10px; font: inherit; font-size: 12.5px;
        font-weight: 600; cursor: pointer; margin-right: 10px; }
      .atl-sound-pill:hover { color: var(--ink); border-color: var(--accent); }
      .atl-sound-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-sound-pill .ic { font-size: 13px; line-height: 1; }
      .atl-sound-pill .st { font-size: 11px; font-weight: 700; color: var(--ink-dim); }
      .atl-sound-pill.on { color: var(--ink); border-color: var(--accent); }
      .atl-sound-pill.on .ic { color: var(--accent); }
      .atl-sound-pill.on .st { color: var(--accent); }
      .atl-sound-pill.unsupported { opacity: .5; cursor: default; }

      .atl-sound-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    `;
    const style = el('style');
    style.id = 'atl-sound-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── topbar pill (persistent affordance, sits by the Notify pill) ────────────
  let pillEl = null;
  let pillStateEl = null;
  function buildPill() {
    const host = document.querySelector('.tb-right');
    if (!host || pillEl) return;
    pillEl = el('button', 'atl-sound-pill');
    pillEl.type = 'button';
    // '♪' — a symbol glyph in the sibling style (welcome '☀', notify '◔'); no emoji.
    pillEl.appendChild(el('span', 'ic', '♪'));
    pillEl.appendChild(el('span', null, 'Sounds'));
    pillStateEl = el('span', 'st', '');
    pillEl.appendChild(pillStateEl);
    if (!supported) {
      pillEl.classList.add('unsupported');
      pillEl.title = 'Sound cues are not available here';
      pillEl.disabled = true;
    } else {
      pillEl.addEventListener('click', toggleEnabled);
    }
    // Sit to the left of the brand name/mark (same host the Notify pill uses).
    host.insertBefore(pillEl, host.firstChild);
    updatePill();
  }

  function updatePill() {
    if (!pillEl) return;
    const on = supported && isEnabled();
    pillEl.classList.toggle('on', on);
    if (pillStateEl) pillStateEl.textContent = supported ? (on ? 'On' : 'Off') : 'n/a';
    pillEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    pillEl.setAttribute('aria-label', !supported
      ? 'Sound cues unavailable'
      : on
        ? 'Sound cues — on. Click to turn off.'
        : 'Sound cues — off. Click to turn on and hear a tone when a run finishes, needs approval, or errors.');
    pillEl.title = !supported
      ? 'Sound cues unavailable'
      : on ? 'Sounds on — click to turn off' : 'Play a tone when something needs you';
  }

  // ── ⌘K palette command ──────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'sound.toggle', label: 'Play a sound when something needs me', icon: '♪', section: 'Studio',
      keywords: 'sound sounds audio chime tone beep cue alert notification finished approval error walk away mute',
      run() { toggleEnabled(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);

  // ── lifecycle wiring (mirrors notify.js / cost.js / approvals.js) ───────────
  A.bus.on('core:ready', () => buildPill());
  // Rebuild the pill if the topbar was re-rendered under us (defensive).
  A.bus.on('boards:switched', () => {
    if (!document.querySelector('.atl-sound-pill')) { pillEl = null; buildPill(); }
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
  // A single console-friendly test entry: test() previews the finished chime;
  // test('approval') / test('error') preview the other two cues. It routes
  // through the same gesture-safe path (ensureCtx + resumeCtx) as real cues.
  function test(kind) {
    if (kind === 'error') { playError(); return; }
    if (kind === 'approval') { playApproval(); return; }
    playFinished();
  }

  window.AtelierSound = {
    isEnabled,
    isOn: isEnabled,       // requested alias
    enable,
    disable,
    toggle: toggleEnabled,
    supported: () => supported,
    // Manual triggers (handy for testing the sound design from the console).
    test,
    testFinished: playFinished,
    testApproval: playApproval,
    testError: playError,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierSound && typeof window.AtelierSound.enable === 'function');
    const pillOk = !!document.querySelector('.atl-sound-pill') || !document.querySelector('.tb-right');
    console.assert(registered, '[sound] module did not register window.AtelierSound');
    if (registered) {
      console.log('[sound] self-check passed — state-carrying sound cues ready (' +
        (supported ? 'Web Audio supported, ' + (isEnabled() ? 'on' : 'off') : 'unsupported') +
        ', pill ' + (pillOk ? 'mounted' : 'pending topbar') +
        ', watches /sessions + approvals).');
    }
  })();
})();
