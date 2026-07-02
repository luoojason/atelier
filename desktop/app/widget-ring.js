'use strict';

/* Atelier feature module — scheduler job timer ring (widget type 'schedring')
   =============================================================================
   A circular countdown per scheduler job: an SVG ring slowly fills toward the
   job's real next fire, pulses when the job actually fires (green ok / red
   fail, read from the runs ledger), then re-arms from the fresh /jobs data.

   How it plugs in
   ---------------
   • Registers exactly ONE widget type ('schedring') via Atelier.registerWidget.
     widgets.js owns all spawn / persist / config-form / board-switch re-mount
     machinery — externally registered types ride it for free.
   • Picker pickup: widgets.js openPicker() iterates the Atelier.widgets
     registry AT OPEN TIME (A.widgets.forEach), so 'schedring' appears in the
     double-click picker and the "+ widget" menu automatically — no wiring
     beyond registerWidget, regardless of load order vs widgets.js.
   • Data: GET /jobs every 30s (contract cadence) → the configured job (cfg.job
     by exact name, blank = first job). Keeps {next_fire, fire_after, name}
     from Builder A's enriched /jobs items (ISO local seconds or null).
   • Fill fraction = 1 - (next_fire - now) / (fire_after - next_fire), clamped
     to [0,1]. The denominator is the real cadence period. ASSUMPTION: regular
     cadence — exact for interval jobs and simple crons; irregular crons (e.g.
     weekday-only 5pm) read approximately because the ELAPSED period is
     inferred from the NEXT gap.
   • Geometry tracks time, so this is the one widget driven by a timer instead
     of a pure CSS animation: a 1s setInterval tick. Why not rAF: at 60fps the
     dashoffset of an hours-scale period moves by sub-pixel noise per frame —
     rAF would burn battery repainting invisible deltas. A 1s tick plus a
     ~1s linear CSS transition on stroke-dashoffset reads as continuous.
   • Fire pulse: GET /runs?limit=10 every 15s (contract cadence). Ledger
     records (scheduler/run_store.py) carry the job name in "name", the ISO
     timestamp in "ts" and "ok"/"error" in "status"; /runs returns them
     OLDEST-FIRST (read_records keeps records[-limit:] in file order), so the
     newest line for this job is the LAST match. The first poll only PRIMES
     the remembered line (history must not pulse); a subsequently NEW line
     triggers a ~1.2s CSS glow (ok green / fail red), then /jobs is re-fetched
     to re-arm the ring from the fresh next_fire.
   • next_fire null (or the job/jobs file missing) → dimmed ring +
     "unscheduled". fire_after null with next_fire present → countdown still
     runs but the fill stays empty (no period to fill against).
   • Every server string lands via textContent. All CSS is injected from this
     module's own <style> (warm palette: track rgba(192,92,55,.15), fill
     var(--accent), ok #3fa66a, bad #b04a3a, idle var(--ink-dim)).

   Boundaries (per the module contract)
   ------------------------------------
   • Touches ONLY window.Atelier + standard DOM. Does NOT edit index.html,
     core.js, styles.css, or any sibling module.
   • mount() returns a cleanup that clears ALL THREE intervals (1s tick, 30s
     jobs poll, 15s runs poll) and the pending pulse-reset timeout.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up, `npm start` in desktop/. Double-click empty canvas → the
      picker lists "Job timer" (◔). Add it: the ring appears, the center shows
      the countdown to the first job's next fire (e.g. "2h 14m") with the job
      name beneath, and the accent arc reflects how far into the period we are.
   2. Gear → set Job to a specific job name → Save: the ring re-arms on that
      job. A name that matches nothing dims to "unscheduled".
   3. Trigger a fire (or wait for one): within 15s the ring glows green (or
      red on a failed run), then re-arms toward the new next_fire.
   4. Stop the backend (fresh machine / empty state): the widget renders the
      dimmed "unscheduled" ring, zero console errors. Same for a jobs file
      with no jobs.
   5. Close the card / switch boards: Network tab shows the /jobs + /runs
      polling stops (cleanup verified).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   console.assert at the bottom verifies the type registered. Headless probe:
     AtelierWidgets.spawn('schedring', { job: '' })
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function') {
    console.warn('[widget-ring] Atelier core not available — skipping.');
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RADIUS = 78;
  const STROKE = 10;
  const VIEW = (RADIUS + STROKE / 2) * 2; // 166 — ring exactly fills the viewBox
  const CENTER = VIEW / 2;
  const CIRC = 2 * Math.PI * RADIUS;

  const JOBS_POLL_MS = 30000; // contract: /jobs every 30s
  const RUNS_POLL_MS = 15000; // contract: /runs every 15s
  const TICK_MS = 1000;       // geometry tick — see header for why not rAF
  const PULSE_MS = 1250;      // matches the 1.2s glow animation + slack

  // ── tiny DOM helper (same idiom as widgets.js) ─────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // Backend access: preload bridge in the app, plain fetch in a browser tab
  // (manual testing without Electron) — the same fallback widgets.js uses.
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  // ── inject module CSS ──────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-ring-styles')) return;
    const css = `
      .wgt-schedring { align-items: center; justify-content: center; }
      .ring-wrap {
        position: relative; width: 100%; height: 100%; min-height: 110px;
        display: flex; align-items: center; justify-content: center;
      }
      .ring-svg { width: 100%; height: 100%; display: block; }
      .ring-track { fill: none; stroke: rgba(192,92,55,0.15); stroke-width: ${STROKE}; }
      .ring-fill {
        fill: none; stroke: var(--accent); stroke-width: ${STROKE};
        stroke-linecap: round;
        /* the 1s tick nudges dashoffset; this linear transition makes the
           between-tick motion read as continuous */
        transition: stroke-dashoffset 0.95s linear;
      }
      .ring-center {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; text-align: center;
        pointer-events: none; padding: 0 14px;
      }
      .ring-count {
        font-size: 23px; font-weight: 700; color: var(--ink);
        font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
        line-height: 1.1;
      }
      .ring-name {
        font-size: 11.5px; color: var(--ink-dim); margin-top: 4px;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* unscheduled: dimmed ring, idle-colored center */
      .ring-dim .ring-fill { opacity: 0.25; }
      .ring-dim .ring-count { color: var(--ink-dim); font-size: 14.5px; font-weight: 600; }
      /* fire pulse: ~1.2s glow on the whole ring, ok green / fail red */
      @keyframes ring-pulse-ok {
        0%   { filter: drop-shadow(0 0 0 rgba(63,166,106,0)); }
        30%  { filter: drop-shadow(0 0 14px rgba(63,166,106,0.9)); }
        100% { filter: drop-shadow(0 0 0 rgba(63,166,106,0)); }
      }
      @keyframes ring-pulse-bad {
        0%   { filter: drop-shadow(0 0 0 rgba(176,74,58,0)); }
        30%  { filter: drop-shadow(0 0 14px rgba(176,74,58,0.9)); }
        100% { filter: drop-shadow(0 0 0 rgba(176,74,58,0)); }
      }
      .ring-pulse-ok  .ring-svg { animation: ring-pulse-ok 1.2s ease-out; }
      .ring-pulse-bad .ring-svg { animation: ring-pulse-bad 1.2s ease-out; }
      .ring-pulse-ok  .ring-fill { stroke: #3fa66a; }
      .ring-pulse-bad .ring-fill { stroke: #b04a3a; }
    `;
    const style = el('style');
    style.id = 'atelier-widget-ring-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // "2h 14m" / "14m 05s" / "42s" / "due" — tabular-nums friendly.
  function fmtRemaining(ms) {
    if (ms <= 0) return 'due';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m > 0) return m + 'm ' + String(sec).padStart(2, '0') + 's';
    return sec + 's';
  }

  // ISO local seconds ("2026-07-02T09:00:00", no zone) → epoch ms, else null.
  function parseTs(s) {
    if (!s || typeof s !== 'string') return null;
    const t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  }

  // ── the widget definition ──────────────────────────────────────────────────
  const DEF = {
    label: 'Job timer',
    icon: '◔',
    size: { w: 230, h: 230 },
    defaultConfig: { job: '', title: '' },
    fields: [
      { name: 'job', label: 'Job name (blank = first job)', type: 'text' },
      { name: 'title', label: 'Title', type: 'text' },
    ],

    render() {
      const w = el('div', 'wgt wgt-schedring');
      const wrap = el('div', 'ring-wrap ring-dim');

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'ring-svg');
      svg.setAttribute('viewBox', '0 0 ' + VIEW + ' ' + VIEW);

      const track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('class', 'ring-track');
      track.setAttribute('cx', CENTER);
      track.setAttribute('cy', CENTER);
      track.setAttribute('r', RADIUS);

      const fill = document.createElementNS(SVG_NS, 'circle');
      fill.setAttribute('class', 'ring-fill');
      fill.setAttribute('cx', CENTER);
      fill.setAttribute('cy', CENTER);
      fill.setAttribute('r', RADIUS);
      // start the arc at 12 o'clock
      fill.setAttribute('transform', 'rotate(-90 ' + CENTER + ' ' + CENTER + ')');
      fill.setAttribute('stroke-dasharray', String(CIRC));
      fill.style.strokeDashoffset = String(CIRC); // empty until data lands

      svg.append(track, fill);

      const center = el('div', 'ring-center');
      center.append(el('div', 'ring-count', 'unscheduled'), el('div', 'ring-name', ''));

      wrap.append(svg, center);
      w.append(wrap);
      return w;
    },

    mount(root, cfg) {
      const wrap = root.querySelector('.ring-wrap');
      const fill = root.querySelector('.ring-fill');
      const countEl = root.querySelector('.ring-count');
      const nameEl = root.querySelector('.ring-name');
      if (!wrap || !fill || !countEl || !nameEl) return null;

      let stopped = false;
      let pulseTimer = null;
      const st = {
        // watch cfg.job immediately so the runs poll can match the ledger
        // even before the first /jobs response resolves the name
        name: String((cfg && cfg.job) || '').trim() || null,
        nextFire: null,  // epoch ms or null
        fireAfter: null, // epoch ms or null
        lastRunTs: null, // ts of the newest seen ledger line for this job
        primed: false,   // first runs poll only records history, never pulses
      };

      function paint() {
        if (st.nextFire == null) {
          wrap.classList.add('ring-dim');
          fill.style.strokeDashoffset = String(CIRC);
          countEl.textContent = 'unscheduled';
          nameEl.textContent = st.name || 'no jobs';
          return;
        }
        wrap.classList.remove('ring-dim');
        const remaining = st.nextFire - Date.now();
        // Fraction of the period elapsed; period = fire_after - next_fire (the
        // real cadence — regular-cadence assumption, see header). No
        // fire_after → no period to fill against: countdown only, arc empty.
        let frac = 0;
        const period = st.fireAfter != null ? st.fireAfter - st.nextFire : 0;
        if (period > 0) frac = 1 - remaining / period;
        frac = Math.max(0, Math.min(1, frac));
        fill.style.strokeDashoffset = String(CIRC * (1 - frac));
        countEl.textContent = fmtRemaining(remaining);
        nameEl.textContent = st.name || '';
      }

      function fetchJobs() {
        api('/jobs')
          .then((data) => {
            if (stopped || !data || !Array.isArray(data.jobs)) return;
            const want = String((cfg && cfg.job) || '').trim();
            const job = want
              ? data.jobs.find((j) => j && j.name === want)
              : data.jobs.find((j) => j && j.name != null); // first real job
            const prevName = st.name;
            if (!job) {
              st.name = want || null;
              st.nextFire = null;
              st.fireAfter = null;
            } else {
              st.name = String(job.name);
              st.nextFire = parseTs(job.next_fire);
              st.fireAfter = parseTs(job.fire_after);
            }
            // watched job changed (blank cfg + jobs file edited): the
            // remembered ledger line belongs to the old job — re-prime so
            // the new job's history does not read as a fresh fire
            if (st.name !== prevName) {
              st.primed = false;
              st.lastRunTs = null;
            }
            paint();
          })
          .catch(() => { /* backend down — keep last state, never throw */ });
      }

      function firePulse(ok) {
        wrap.classList.remove('ring-pulse-ok', 'ring-pulse-bad');
        void wrap.offsetWidth; // restart the one-shot CSS animation
        wrap.classList.add(ok ? 'ring-pulse-ok' : 'ring-pulse-bad');
        if (pulseTimer) clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => {
          wrap.classList.remove('ring-pulse-ok', 'ring-pulse-bad');
          pulseTimer = null;
        }, PULSE_MS);
      }

      function pollRuns() {
        if (!st.name) return; // nothing to match yet
        api('/runs?limit=10')
          .then((data) => {
            if (stopped || !data || !Array.isArray(data.runs)) return;
            // ledger lines are oldest-first (run_store.read_records) — the
            // newest line for this job is the LAST one whose "name" matches
            let newest = null;
            for (let i = data.runs.length - 1; i >= 0; i--) {
              const r = data.runs[i];
              if (r && r.name === st.name) { newest = r; break; }
            }
            if (!st.primed) {
              // First COMPLETED poll: whatever the window holds (even
              // nothing) is history, not a fresh fire. Priming must not wait
              // for a matching line to exist — on an empty ledger the first
              // ever fire would otherwise be swallowed as "history" and only
              // the second fire would pulse.
              st.primed = true;
              st.lastRunTs = newest && newest.ts ? String(newest.ts) : null;
              return;
            }
            if (!newest || !newest.ts) return;
            if (String(newest.ts) === st.lastRunTs) return;
            st.lastRunTs = String(newest.ts);
            firePulse(newest.status === 'ok');
            fetchJobs(); // re-arm from the fresh next_fire
          })
          .catch(() => { /* backend down — keep last state */ });
      }

      paint(); // immediate: dimmed "unscheduled" until real data lands
      fetchJobs();
      pollRuns(); // prime against history right away
      const tickIv = setInterval(paint, TICK_MS);
      const jobsIv = setInterval(fetchJobs, JOBS_POLL_MS);
      const runsIv = setInterval(pollRuns, RUNS_POLL_MS);

      return () => {
        stopped = true;
        clearInterval(tickIv);
        clearInterval(jobsIv);
        clearInterval(runsIv);
        if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
      };
    },
  };

  A.registerWidget('schedring', DEF);

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = A.widgets && typeof A.widgets.has === 'function' && A.widgets.has('schedring');
    console.assert(ok, '[widget-ring] schedring failed to register');
    if (ok) {
      console.log('[widget-ring] ready — schedring registered; the widget picker lists it automatically (widgets.js iterates the registry at open time).');
    }
  })();
})();
