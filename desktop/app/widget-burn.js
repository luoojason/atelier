'use strict';

/* Atelier feature module — Claude Code burn gauge widget ('ccburn')
   =============================================================================
   Registers ONE widget type via Atelier.registerWidget: a semicircle SVG gauge
   comparing TODAY's Claude Code token burn against the average of the 7 prior
   days, fed by GET /cc/aggregate (lite_server -> cc_usage.aggregate_summary).

   Data shape consumed (cc_usage.aggregate_summary, 30-day window):
     { "daily": [ {"date": "YYYY-MM-DD", "tokens": int, "usd": float}, ... ] }
   daily[] is sorted ascending by LOCAL date and omits days with zero events.

   Math
   ----
   • today       = tokens of the entry whose date == the local date, else 0.
   • 7-day avg   = sum(tokens of entries dated within the 7 calendar days
                   immediately before today) / 7. CHOICE (per contract): a day
                   absent from daily[] inside that window genuinely had zero
                   usage (the backend omits zero days), so it counts as 0 and
                   the divisor stays a fixed 7; entries older than the window
                   never enter. A brand-new machine with 2 days of history
                   therefore reads a diluted average — deliberate simplicity.
   • Gauge fill  = (today / avg) clamped [0, 2], mapped over the semicircle so
                   the 12 o'clock midpoint is EXACTLY the 7-day average
                   (ratio 1.0 -> half arc). Needle tracks the same fraction.
   • Caption     = over/under vs average from the UNclamped ratio
                   ('34% above average'); warn color when ratio > 1.25,
                   ok green when ratio <= 1, neutral in between.
   • avg == 0    -> gauge idles: no fill, needle hidden, 'not enough history'.

   Cadence + animation
   -------------------
   Polls /cc/aggregate every 60s (contract cadence) with an immediate first
   tick, via window.atelier.get in the app or a plain fetch('http://
   127.0.0.1:8765'+path) fallback in a bare browser tab (same idiom as
   widgets.js). All motion is CSS: the arc animates via a stroke-dashoffset
   transition, the needle via a CSS transform transition, and a soft glow
   keyframe pulses the arc while burn exceeds 1.25x — no rAF needed (nothing
   here tracks continuous time between polls). A failed poll keeps the last
   rendered values and dims the widget (.ccburn-stale); recovery undims.

   Boundaries (module contract)
   ----------------------------
   • Touches ONLY window.Atelier + standard DOM; owns ONLY this file. CSS is
     injected from this module's own <style> (palette via the :root vars).
   • Every server-derived string lands via textContent — never innerHTML.
   • mount() returns a cleanup that clears its interval (the only timer).
   • PICKER PICKUP (verified): widgets.js openPicker() iterates A.widgets
     live at open time, so 'ccburn' — registered after widgets.js loads —
     appears in the double-click picker and "+ widget" menu automatically.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend on :8765, `npm start` in desktop/. Double-click empty canvas →
      pick "Claude Code burn" → the gauge card appears.
   2. With real transcript history: the arc eases to today's burn vs the
      7-day average within a second (needle mid-arc = exactly average), the
      numeric row reads like 'today 1.2B · avg 890M', and the caption states
      the over/under. Burn past 1.25x → caption turns warn and the arc pulses.
   3. Fresh machine (CLAUDE_PROJECTS_DIR at an empty dir): daily[] is [] →
      dimmed idle gauge, hidden needle, 'not enough history'. Zero console
      errors (empty-state verification: exercised by pointing the api helper
      at a stub resolving {daily: []} and by loading with the backend off —
      the scaffold renders with '—' values and only dims).
   4. Kill the backend → widget dims, last values stay; restart → recovers on
      the next 60s tick. Close the card → interval stops (Network tab quiet).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   On load: console.assert that 'ccburn' registered + pure-math spot checks
   (formatter and stats over a synthetic daily[]). Pure helpers are exposed on
   window.AtelierBurn { compute, fmt } for headless testing.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function' || !A.widgets) {
    console.warn('[widget-burn] Atelier core not available — skipping.');
    return;
  }

  // ── tiny DOM helper (same shape as widgets.js) ─────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  // preload bridge in the app, plain fetch in a browser tab (widgets.js idiom)
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  // ── gauge geometry (viewBox units) ─────────────────────────────────────────
  const CX = 110, CY = 112, R = 88, STROKE = 12;
  const ARC_LEN = Math.PI * R; // semicircle length ≈ 276.46
  const NEEDLE_LEN = 62;

  // ── injected CSS (contract palette: track rgba(192,92,55,.15), fill
  //    var(--accent), ok #3fa66a, warn #b9822a, idle var(--ink-dim)) ──────────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-burn-styles')) return;
    const css = `
      .ccburn { flex: 1; min-height: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 1px; }
      .ccburn-svg { display: block; width: 100%; max-width: 208px; height: auto;
        flex: 0 1 auto; min-height: 0; }
      .ccburn-track { fill: none; stroke: rgba(192,92,55,0.15);
        stroke-width: ${STROKE}px; stroke-linecap: round; }
      .ccburn-fill { fill: none; stroke: var(--accent);
        stroke-width: ${STROKE}px; stroke-linecap: round;
        transition: stroke-dashoffset .9s cubic-bezier(.22, 1, .36, 1); }
      .ccburn-fill.ccburn-hot { animation: ccburn-glow 1.6s ease-in-out infinite; }
      @keyframes ccburn-glow {
        0%, 100% { filter: drop-shadow(0 0 0 rgba(185,130,42,0)); }
        50%      { filter: drop-shadow(0 0 5px rgba(185,130,42,0.55)); }
      }
      .ccburn-tick { stroke: var(--ink-dim); stroke-width: 2px; opacity: 0.7; }
      .ccburn-avg-lab { font-size: 9px; fill: var(--ink-dim);
        text-anchor: middle; letter-spacing: 0.04em; }
      .ccburn-needle { stroke: var(--ink); stroke-width: 3px;
        stroke-linecap: round; transform-origin: ${CX}px ${CY}px;
        transition: transform .9s cubic-bezier(.22, 1, .36, 1),
                    opacity .3s ease; }
      .ccburn-hub { fill: var(--ink); }
      .ccburn-nums { font-size: 12.5px; font-weight: 600; color: var(--ink);
        font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
      .ccburn-cap { font-size: 11.5px; color: var(--ink-dim); margin-top: 1px; }
      .ccburn-cap.ccburn-ok { color: #3fa66a; }
      .ccburn-cap.ccburn-warn { color: #b9822a; font-weight: 600; }
      /* idle: not enough history — no fill, no needle, everything dims */
      .ccburn.ccburn-idle .ccburn-needle { opacity: 0; }
      .ccburn.ccburn-idle .ccburn-nums { color: var(--ink-dim); }
      /* last poll failed — keep values, just dim (widgets.js stale idiom) */
      .ccburn.ccburn-stale { opacity: 0.55; transition: opacity .3s ease; }
    `;
    const style = el('style');
    style.id = 'atelier-widget-burn-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── pure helpers ───────────────────────────────────────────────────────────

  // Compact token formatter: 1234567890 -> '1.2B', 890000000 -> '890M'.
  function fmt(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '—';
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (let i = 0; i < units.length; i++) {
      if (n >= units[i][0]) {
        return (n / units[i][0]).toFixed(1).replace(/\.0$/, '') + units[i][1];
      }
    }
    return String(Math.round(n));
  }

  function localDateStr(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  // daily[] + a reference Date -> { today, avg }. See the header for the
  // fixed-divisor choice on the 7-day window.
  function compute(daily, now) {
    const ref = now || new Date();
    const todayStr = localDateStr(ref);
    const windowSet = new Set();
    for (let i = 1; i <= 7; i++) {
      windowSet.add(localDateStr(
        new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - i)));
    }
    let today = 0, priorSum = 0;
    (Array.isArray(daily) ? daily : []).forEach((d) => {
      if (!d || typeof d !== 'object') return;
      const tokens = Number(d.tokens) || 0;
      if (d.date === todayStr) today += tokens;
      else if (windowSet.has(d.date)) priorSum += tokens;
    });
    return { today: today, avg: priorSum / 7 };
  }

  // ── widget definition ──────────────────────────────────────────────────────

  function buildGauge() {
    const root = el('div', 'ccburn ccburn-idle');

    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 220 132');
    svg.setAttribute('class', 'ccburn-svg');
    svg.setAttribute('aria-hidden', 'true');

    const arcD = 'M ' + (CX - R) + ' ' + CY
      + ' A ' + R + ' ' + R + ' 0 0 1 ' + (CX + R) + ' ' + CY;

    const track = svgEl('path');
    track.setAttribute('d', arcD);
    track.setAttribute('class', 'ccburn-track');

    const fill = svgEl('path');
    fill.setAttribute('d', arcD);
    fill.setAttribute('class', 'ccburn-fill');
    fill.setAttribute('stroke-dasharray', String(ARC_LEN));
    fill.setAttribute('stroke-dashoffset', String(ARC_LEN)); // empty until data

    // 12 o'clock tick: the exactly-average mark
    const tick = svgEl('line');
    tick.setAttribute('x1', String(CX)); tick.setAttribute('y1', String(CY - R - STROKE / 2 - 2));
    tick.setAttribute('x2', String(CX)); tick.setAttribute('y2', String(CY - R - STROKE / 2 - 9));
    tick.setAttribute('class', 'ccburn-tick');
    const avgLab = svgEl('text');
    avgLab.setAttribute('x', String(CX));
    avgLab.setAttribute('y', String(CY - R - STROKE / 2 - 12));
    avgLab.setAttribute('class', 'ccburn-avg-lab');
    avgLab.textContent = 'avg';

    // needle drawn at ratio 0 (pointing left); CSS transform rotates it
    const needle = svgEl('line');
    needle.setAttribute('x1', String(CX)); needle.setAttribute('y1', String(CY));
    needle.setAttribute('x2', String(CX - NEEDLE_LEN)); needle.setAttribute('y2', String(CY));
    needle.setAttribute('class', 'ccburn-needle');
    const hub = svgEl('circle');
    hub.setAttribute('cx', String(CX)); hub.setAttribute('cy', String(CY));
    hub.setAttribute('r', '4.5');
    hub.setAttribute('class', 'ccburn-hub');

    svg.append(track, fill, tick, avgLab, needle, hub);

    const nums = el('div', 'ccburn-nums', 'today — · avg —');
    const cap = el('div', 'ccburn-cap', '');
    root.append(svg, nums, cap);
    return { root: root, fill: fill, needle: needle, nums: nums, cap: cap };
  }

  function applyData(refs, data) {
    const stats = compute(data && data.daily, new Date());
    const today = stats.today, avg = stats.avg;

    if (!(avg > 0)) {
      // Zero average -> idle gauge, per contract.
      refs.root.classList.add('ccburn-idle');
      refs.fill.setAttribute('stroke-dashoffset', String(ARC_LEN));
      refs.fill.classList.remove('ccburn-hot');
      refs.needle.style.transform = 'rotate(0deg)';
      refs.nums.textContent = 'today ' + fmt(today) + ' · avg —';
      refs.cap.textContent = 'not enough history';
      refs.cap.classList.remove('ccburn-ok', 'ccburn-warn');
      return;
    }

    refs.root.classList.remove('ccburn-idle');
    const ratio = today / avg;
    const frac = Math.min(2, Math.max(0, ratio)) / 2; // 12 o'clock = 1.0x
    refs.fill.setAttribute('stroke-dashoffset', String(ARC_LEN * (1 - frac)));
    refs.needle.style.transform = 'rotate(' + (frac * 180) + 'deg)';
    refs.fill.classList.toggle('ccburn-hot', ratio > 1.25);

    refs.nums.textContent = 'today ' + fmt(today) + ' · avg ' + fmt(avg);

    const pct = Math.round(Math.abs(ratio - 1) * 100);
    refs.cap.textContent = pct === 0 ? 'right at average'
      : ratio > 1 ? pct + '% above average'
      : pct + '% below average';
    refs.cap.classList.toggle('ccburn-warn', ratio > 1.25);
    refs.cap.classList.toggle('ccburn-ok', ratio <= 1);
  }

  A.registerWidget('ccburn', {
    label: 'Claude Code burn',
    icon: '⌁',
    size: { w: 300, h: 200 },
    defaultConfig: { title: 'Claude Code burn' },
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
    ],
    render() {
      // Scaffold only; mount()'s immediate first tick fills it. With the
      // backend absent the scaffold stands ('—' values) and only dims.
      return buildGauge().root;
    },
    mount(root, _cfg) {
      const refs = {
        root: root,
        fill: root.querySelector('.ccburn-fill'),
        needle: root.querySelector('.ccburn-needle'),
        nums: root.querySelector('.ccburn-nums'),
        cap: root.querySelector('.ccburn-cap'),
      };
      if (!refs.fill || !refs.needle || !refs.nums || !refs.cap) return null;
      let stopped = false;
      const poll = () => {
        api('/cc/aggregate')
          .then((data) => {
            if (stopped || data == null) return;
            try { applyData(refs, data); }
            catch (e) { console.error('[widget-burn] update', e); }
            root.classList.remove('ccburn-stale');
          })
          .catch(() => { if (!stopped) root.classList.add('ccburn-stale'); });
      };
      poll();
      const iv = setInterval(poll, 60000); // contract cadence: 60s
      return () => { stopped = true; clearInterval(iv); };
    },
  });

  // headless-test hook for the pure math
  window.AtelierBurn = { compute: compute, fmt: fmt };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    console.assert(A.widgets.has('ccburn'),
      '[widget-burn] ccburn failed to register');
    console.assert(fmt(1234567890) === '1.2B' && fmt(890000000) === '890M'
      && fmt(950) === '950' && fmt(12500) === '12.5K',
      '[widget-burn] formatter self-check failed');
    // synthetic daily[]: today 200, prior window 70+70+70 over 7 days -> avg 30
    const now = new Date(2026, 5, 15); // 2026-06-15 local
    const s = compute([
      { date: '2026-06-01', tokens: 999 },  // outside the 7-day window
      { date: '2026-06-09', tokens: 70 },
      { date: '2026-06-11', tokens: 70 },
      { date: '2026-06-14', tokens: 70 },
      { date: '2026-06-15', tokens: 200 },
    ], now);
    console.assert(s.today === 200 && s.avg === 30,
      '[widget-burn] compute self-check failed', s);
    const e = compute([], now);
    console.assert(e.today === 0 && e.avg === 0,
      '[widget-burn] empty daily[] self-check failed', e);
    if (A.widgets.has('ccburn')) {
      console.log('[widget-burn] ready — ccburn registered; the picker lists it automatically.');
    }
  })();
})();
