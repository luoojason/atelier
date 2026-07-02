'use strict';

/* ===========================================================================
   Atelier feature module — heartbeat widget   (app/widget-heartbeat.js)

   Registers ONE widget type, 'heartbeat', via Atelier.registerWidget: two
   labeled status dots — Backend and Scheduler — that beat while their
   process is alive.

   Data contract (round 17)
   ------------------------
   • Backend dot — seeded from a SINGLE Atelier.backend.health() call (same
     ok predicate as core's pollHealth: h.ok === true || h.status === 'ok'),
     then driven live off the bus event 'backend:status' that core.js emits
     every 4s from its own poll ({ok: true|false|null}; null is core's boot
     "connecting" state → unknown here). No extra /health polling from this
     module — core already owns that cadence. A bus event that lands before
     the seed resolves wins (the late seed is dropped), so a stale first
     read can never overwrite fresher live data.
   • Scheduler dot — window.atelier.schedulerStatus() (preload IPC, added by
     Builder K in this round) polled every 10s with an immediate first tick,
     but ONLY when the function exists: the bridge is absent in a plain
     browser tab and the method is absent on an older preload, and both
     cases render the hollow 'unknown' state with no interval and no console
     errors. {running:true} → ok, any other object → down, a null resolve →
     unknown (the preload wraps the invoke in .catch(() => null), so a
     main.js without the handler — or any IPC failure — arrives as null,
     never as a rejection).

   Dot states (contract palette)
   -----------------------------
     ok      solid #3fa66a with a CSS double-beat heartbeat animation
             (scale keyframes — lub-dub, then rest; no rAF, nothing here
             tracks time geometrically)
     down    steady #b04a3a, no animation
     unknown hollow — transparent fill, var(--ink-dim) border

   Widget def shape follows widgets.js exactly: { label, icon, size,
   defaultConfig, fields, render(cfg)->el, mount(root, cfg)->cleanup }.
   Form fields use the `name` key (widgets.js's buildForm reads f.name).
   mount returns a cleanup that unsubscribes the bus listener, clears the
   scheduler interval, and flips a `stopped` flag so in-flight promise
   callbacks cannot write into a removed widget.

   Boundaries: touches ONLY window.Atelier + standard DOM + the optional
   window.atelier bridge (guarded). Injects its own CSS. Owns only this
   file; index.html script order is the orchestrator's. After registering it
   calls AtelierWidgets.restoreFromStore() when present (documented
   idempotent) so persisted heartbeat instances re-mount even when this file
   loads after widgets.js's initial restore pass.

   Picker pickup — VERIFIED in widgets.js: openPicker() iterates A.widgets
   at open time, so registration alone lists 'Heartbeat' in the double-click
   picker and the "+ widget" button; no picker change needed.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ with the backend up → double-click the canvas,
      pick "Heartbeat". Backend dot double-beats green within a tick;
      Scheduler dot reflects schedulerStatus() (green beating when the
      scheduler daemon child is running, steady red when not).
   2. Kill the backend → within ~4s (core's poll) the Backend dot goes
      steady red. Restart it → the dot beats green again, no interaction.
   3. Open index.html in a plain browser tab (no Electron bridge): both the
      seed and core's poll fail → Backend shows red (core keeps emitting
      ok:false); Scheduler shows the hollow gray 'unknown' dot. Console: no
      errors (empty state verified this way + via the stub harness below).
   4. Close the widget card → Network/console quiet: the bus unsubscribe and
      the 10s interval are gone (AtelierWidgets.instances shrinks by one).
   5. Gear → set Title → Save: the card re-renders and re-mounts cleanly
      (widgets.js applyConfig runs cleanup first — no doubled listeners).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   console.assert at the bottom verifies A.widgets.has('heartbeat').
   Headless smoke: def = Atelier.widgets.get('heartbeat');
   el = def.render(def.defaultConfig); stop = def.mount(el, def.defaultConfig);
   stop() — must not throw, with or without window.atelier.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function' || !A.bus || !A.backend) {
    console.warn('[widget-heartbeat] Atelier core not available — skipping.');
    return;
  }

  // ── tiny DOM helper (same idiom as widgets.js) ─────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── inject module CSS (warm palette; layout self-contained — no dependence
  //    on widgets.js's .wgt rules, in case load order ever changes) ──────────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-heartbeat-styles')) return;
    const css = `
      .wgt-heartbeat { display: flex; flex-direction: column; height: 100%;
        justify-content: center; gap: 13px; min-height: 0; }
      .hb-row { display: flex; align-items: center; gap: 10px; }
      .hb-dot { width: 12px; height: 12px; border-radius: 50%; flex: none;
        box-sizing: border-box; border: 2px solid transparent; }
      .hb-dot.hb-ok { background: #3fa66a; border-color: #3fa66a;
        box-shadow: 0 0 6px rgba(63, 166, 106, 0.5);
        animation: hb-doublebeat 1.4s ease-in-out infinite; }
      .hb-dot.hb-down { background: #b04a3a; border-color: #b04a3a; }
      .hb-dot.hb-unknown { background: transparent; border-color: var(--ink-dim); }
      .hb-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
      .hb-state { margin-left: auto; font-size: 11.5px; color: var(--ink-dim); }
      /* double-beat: two quick systoles, then rest for the remainder */
      @keyframes hb-doublebeat {
        0%   { transform: scale(1); }
        10%  { transform: scale(1.4); }
        22%  { transform: scale(1); }
        32%  { transform: scale(1.25); }
        45%  { transform: scale(1); }
        100% { transform: scale(1); }
      }
    `;
    const style = el('style');
    style.id = 'atelier-widget-heartbeat-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  const STATES = ['ok', 'down', 'unknown'];

  // Distinct single classes per element so mount() needs only trivial
  // querySelector lookups (root is the element render() returned).
  function buildRow(name, dotClass, stateClass) {
    const row = el('div', 'hb-row');
    const dot = el('span', 'hb-dot hb-unknown ' + dotClass);
    row.append(dot, el('span', 'hb-name', name), el('span', 'hb-state ' + stateClass, 'unknown'));
    return row;
  }

  function setDot(dotEl, stateEl, state) {
    if (!dotEl) return;
    const s = STATES.includes(state) ? state : 'unknown';
    STATES.forEach((x) => dotEl.classList.remove('hb-' + x));
    dotEl.classList.add('hb-' + s);
    if (stateEl) stateEl.textContent = s;
  }

  A.registerWidget('heartbeat', {
    label: 'Heartbeat',
    icon: '❤',
    size: { w: 260, h: 120 },
    defaultConfig: { title: 'Heartbeat' },
    fields: [{ name: 'title', label: 'Title', type: 'text' }],

    render() {
      const w = el('div', 'wgt wgt-heartbeat');
      w.append(
        buildRow('Backend', 'hb-dot-backend', 'hb-state-backend'),
        buildRow('Scheduler', 'hb-dot-sched', 'hb-state-sched')
      );
      return w;
    },

    mount(root) {
      let stopped = false;
      const backendDot = root.querySelector('.hb-dot-backend');
      const backendState = root.querySelector('.hb-state-backend');
      const schedDot = root.querySelector('.hb-dot-sched');
      const schedState = root.querySelector('.hb-state-sched');

      // ── Backend: one seed read, then bus-driven ──────────────────────────
      const applyBackend = (ok) => {
        setDot(backendDot, backendState, ok === true ? 'ok' : ok === false ? 'down' : 'unknown');
      };
      let busSeen = false;
      const unsub = A.bus.on('backend:status', (d) => {
        busSeen = true;
        if (!stopped) applyBackend(d && d.ok);
      });
      A.backend.health()
        .then((h) => {
          if (stopped || busSeen) return; // live data already landed — drop the seed
          applyBackend(!!(h && (h.ok === true || h.status === 'ok')));
        })
        .catch(() => {
          if (!stopped && !busSeen) applyBackend(false);
        });

      // ── Scheduler: 10s poll of the preload IPC, when it exists ──────────
      // Builder K lands schedulerStatus() in preload.js in parallel; a plain
      // browser tab has no window.atelier at all. Both absences keep the
      // hollow 'unknown' dot from render() — no interval, no errors.
      let schedIv = null;
      const bridge = window.atelier;
      if (bridge && typeof bridge.schedulerStatus === 'function') {
        const tick = () => {
          bridge.schedulerStatus()
            .then((s) => {
              // preload's never-reject idiom resolves null on ANY failure
              // (missing main.js handler on an older build, channel-level
              // IPC error) — that state is unknowable, not "down"
              if (!stopped) setDot(schedDot, schedState, s == null ? 'unknown' : (s.running ? 'ok' : 'down'));
            })
            .catch(() => {
              // belt and braces for a bridge that rejects instead
              if (!stopped) setDot(schedDot, schedState, 'unknown');
            });
        };
        tick();
        schedIv = setInterval(tick, 10000);
      }

      return () => {
        stopped = true;
        try { unsub(); } catch (_) {}
        if (schedIv) clearInterval(schedIv);
      };
    },
  });

  // widgets.js's initial restoreFromStore() skips types not yet registered
  // (and later persists would drop their records). Re-running it here is
  // documented idempotent — already-live instanceIds are skipped — so any
  // persisted heartbeat widgets mount even though this file loads after
  // widgets.js. No-op when widgets.js loads after this module (its own
  // restore pass will see the type registered).
  if (window.AtelierWidgets && typeof window.AtelierWidgets.restoreFromStore === 'function') {
    try { window.AtelierWidgets.restoreFromStore(); } catch (e) {
      console.error('[widget-heartbeat] restore pass', e);
    }
  }

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = A.widgets && typeof A.widgets.has === 'function' && A.widgets.has('heartbeat');
    console.assert(ok, '[widget-heartbeat] type "heartbeat" failed to register');
    if (ok) console.log('[widget-heartbeat] ready — Heartbeat listed in the widget picker.');
  })();
})();
