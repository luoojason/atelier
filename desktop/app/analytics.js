'use strict';

/* ===========================================================================
   Atelier feature module — analytics   (app/analytics.js)

   The "Claude Code" analytics view: one scrollable warm-cream metrics page
   registered through window.Atelier.views (Contract 1) and fed by the
   lite_server /cc/* read-only endpoints (Contract 2):

     GET /cc/status         -> stat-tile row
     GET /cc/aggregate      -> tokens/cost lines, cache donut, model bars,
                               peak-hours histogram
     GET /cc/heatmap        -> hand-drawn calendar heatmap (viz-seq ramp)
     GET /cc/usage?limit=12 -> recent-sessions leaderboard (lb-bar idiom)

   Charts use the vendored Chart.js (vendor/chart.umd.min.js). If
   window.Chart is absent the view still renders every hand-drawn section
   plus a 'charts unavailable' note — it never crashes. All Chart instances
   are destroyed and all in-flight fetches aborted by the mount cleanup.

   Test seam: when window.__ccFixture is set (an object keyed by endpoint
   path, e.g. {'/cc/status': {...}}), the network layer resolves from it
   instead of fetching — used by the pre-backend smoke test.

   Built ONLY against window.Atelier(.views). Injects its own CSS, including
   the --viz-* warm-cream palette. Does NOT edit index.html, core.js,
   styles.css, or any sibling module. XSS rule: every network-derived string
   (project names, model names, session ids, dates) enters the DOM via
   textContent / createElement only — never innerHTML.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ with lite_server serving the /cc/* routes on
      :8765 (or open index.html via a static server and set
      window.__ccFixture in DevTools before clicking the row).
   2. The sidebar "Analytics" group shows a "Claude Code" row (◍). Click it:
      a full-canvas overlay opens with — stat tiles (cost tile terracotta),
      two soft-area line charts (tokens/day, cost/day), a cache donut with a
      centered "NN% cached / $X saved" stat, two horizontal model bars
      (desc-sorted, $-formatted), a 24-bar peak-hours histogram (top 3 bars
      full terracotta), a bordered calendar heatmap on the --viz-seq ramp,
      and a 12-row session leaderboard with terracotta fill bars.
   3. Hover any chart point/bar/arc -> warm-cream tooltip (white panel, soft
      border). Hover a heatmap cell -> fixed tooltip "YYYY-MM-DD · Nk tokens".
   4. Click the header ↻ -> sections flash shimmer skeletons, then repopulate.
   5. Close (×/Esc/board click) and reopen -> clean re-render: no console
      errors, no duplicate <style>, no orphan tooltip div, charts rebuilt.
   6. Stop lite_server and ↻ -> every section degrades to its own quiet
      "unavailable" note; nothing throws.
   7. Temporarily rename vendor/chart.umd.min.js and reload -> tiles,
      heatmap, and leaderboard still render; chart sections show a subtle
      "Charts unavailable" note.
   =========================================================================== */

(function () {
  const BASE = 'http://127.0.0.1:8765';
  const VIEW_ID = 'analytics';
  const STYLE_ID = 'cca-style';

  /* ── tiny DOM + format helpers ─────────────────────────────────────────── */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function fmtNum(v) {
    const n = num(v);
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtUsd(v) {
    const n = num(v);
    if (n >= 100) return '$' + Math.round(n).toLocaleString();
    if (n >= 1) return '$' + n.toFixed(2);
    if (n > 0) return '$' + n.toFixed(3);
    return '$0';
  }

  function fmtMb(v) {
    const n = num(v);
    if (n >= 1024) return (n / 1024).toFixed(1) + ' GB';
    return Math.round(n) + ' MB';
  }

  function fmtWhen(v) {
    if (v == null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000) : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }

  function dayKey(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ── module CSS (incl. the frozen --viz-* warm-cream palette) ──────────── */

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      ':root{',
      '  --viz-cat-1:#c05c37; --viz-cat-2:#2f7d72; --viz-cat-3:#4d6a9a;',
      '  --viz-cat-4:#6d7a35; --viz-cat-5:#8a4a68; --viz-cat-6:#a6762c;',
      '  --viz-cat-7:#7a5a44; --viz-cat-8:#3f8a5a;',
      '  --viz-seq-1:#f6e7db; --viz-seq-2:#eec4a8; --viz-seq-3:#e0a07a;',
      '  --viz-seq-4:#d17d50; --viz-seq-5:#bd5c30; --viz-seq-6:#96421f;',
      '  --viz-warn:#b9822a;',
      '}',
      '.cca-root{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;}',
      '.cca-inner{max-width:1160px;margin:0 auto;padding:20px 26px 56px;display:flex;flex-direction:column;gap:16px;}',
      '.cca-sec{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:16px 18px;min-width:0;}',
      '.cca-sec-title{margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-mid);}',
      '.cca-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;}',
      '.cca-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}',
      '.cca-tile{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:14px 16px;min-width:0;}',
      '.cca-tile-label{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.cca-tile-value{font-size:24px;font-weight:650;color:var(--ink);line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.cca-tile--accent .cca-tile-value{color:var(--accent);}',
      '.cca-chart{position:relative;height:220px;min-width:0;}',
      '.cca-chart--donut{height:190px;max-width:260px;margin:0 auto;}',
      '.cca-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;gap:2px;}',
      '.cca-donut-pct{font-size:22px;font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums;}',
      '.cca-donut-sub{font-size:10px;color:var(--ink-mid);}',
      '.cca-mini-legend{display:flex;justify-content:center;gap:16px;margin-top:10px;font-size:11px;color:var(--ink-mid);flex-wrap:wrap;}',
      '.cca-mini-legend>span{display:inline-flex;align-items:center;}',
      '.cca-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px;flex-shrink:0;}',
      '.cca-note{padding:24px 10px;text-align:center;font-size:12px;color:var(--ink-dim);}',
      '.cca-skel{border-radius:8px;background:linear-gradient(100deg,rgba(60,48,34,0.05) 40%,rgba(60,48,34,0.10) 50%,rgba(60,48,34,0.05) 60%);background-size:200% 100%;animation:cca-shimmer 1.4s infinite linear;}',
      '@keyframes cca-shimmer{to{background-position:-200% 0;}}',
      '.cca-skel-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}',
      '.cca-hm{display:flex;gap:6px;align-items:flex-start;}',
      '.cca-hm-days{display:flex;flex-direction:column;gap:3px;padding-top:18px;flex-shrink:0;}',
      '.cca-hm-day{height:12px;font-size:9px;line-height:12px;color:var(--ink-dim);width:26px;text-align:right;}',
      '.cca-hm-scroll{overflow-x:auto;flex:1;min-width:0;padding-bottom:4px;}',
      '.cca-hm-grid{display:flex;gap:3px;width:max-content;}',
      '.cca-hm-col{display:flex;flex-direction:column;gap:3px;}',
      '.cca-hm-month{height:15px;font-size:9px;color:var(--ink-dim);white-space:nowrap;overflow:visible;}',
      '.cca-hm-cell{width:12px;height:12px;border-radius:3px;border:1px solid rgba(60,48,34,0.08);background:rgba(60,48,34,0.04);box-sizing:border-box;}',
      '.cca-hm-cell--future{visibility:hidden;}',
      '.cca-hm-legend{display:flex;align-items:center;gap:4px;margin-top:10px;font-size:10px;color:var(--ink-dim);justify-content:flex-end;}',
      '.cca-hm-legend .cca-hm-cell{cursor:default;}',
      '.cca-lb{display:flex;flex-direction:column;gap:9px;}',
      '.cca-lb-row{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.cca-lb-rank{width:18px;text-align:right;font-size:11px;color:var(--ink-dim);flex-shrink:0;font-variant-numeric:tabular-nums;}',
      '.cca-lb-proj{width:170px;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;}',
      '.cca-lb-model{width:120px;font-size:10px;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;}',
      '.cca-lb-bar-wrap{flex:1;height:6px;border-radius:3px;background:var(--border-soft);overflow:hidden;min-width:60px;}',
      '.cca-lb-bar-fill{height:100%;border-radius:3px;background:var(--accent);transition:width .4s ease;}',
      '.cca-lb-tok{width:64px;text-align:right;font-size:11px;color:var(--ink-mid);font-variant-numeric:tabular-nums;flex-shrink:0;}',
      '.cca-lb-usd{width:64px;text-align:right;font-size:11px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;flex-shrink:0;}',
      '@media (max-width:760px){.cca-lb-model{display:none;}.cca-lb-proj{width:120px;}}',
      '.cca-tip{position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-sm);color:var(--ink);font-size:11px;padding:5px 9px;pointer-events:none;white-space:nowrap;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── theme tokens (read once) + Chart.js adapter ───────────────────────── */

  let THEME = null;

  function theme() {
    if (THEME) return THEME;
    injectCss(); // --viz-* must exist before we read them
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
    THEME = {
      ink: v('--ink', '#3c352d'),
      inkMid: v('--ink-mid', '#6f665a'),
      inkDim: v('--ink-dim', '#a49a8a'),
      accent: v('--accent', '#c05c37'),
      panel: v('--panel', '#ffffff'),
      border: v('--border', 'rgba(60,48,34,0.11)'),
      grid: 'rgba(60,48,34,0.06)',
      accentFill: 'rgba(192,92,55,0.10)',
      accentDim: 'rgba(192,92,55,0.45)',
      cat1: v('--viz-cat-1', '#c05c37'),
      cat2: v('--viz-cat-2', '#2f7d72'),
      cat3: v('--viz-cat-3', '#4d6a9a'),
      font: getComputedStyle(document.body).fontFamily,
    };
    return THEME;
  }

  function hasChart() { return typeof window.Chart === 'function'; }

  let chartThemed = false;
  function applyChartTheme(t) {
    if (chartThemed || !hasChart()) return;
    chartThemed = true;
    const d = window.Chart.defaults;
    d.font.size = 10;
    d.font.family = t.font;
    d.color = t.inkMid;
    d.borderColor = t.grid;
  }

  function tooltipOpts(t) {
    return {
      backgroundColor: t.panel,
      titleColor: t.ink,
      bodyColor: t.inkMid,
      borderColor: t.border,
      borderWidth: 1,
      cornerRadius: 8,
      padding: 8,
      displayColors: false,
      titleFont: { size: 11, weight: '600' },
      bodyFont: { size: 11 },
    };
  }

  function makeChart(state, host, config) {
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const chart = new window.Chart(canvas, config);
    state.charts.push(chart);
    return chart;
  }

  function destroyCharts(state) {
    state.charts.forEach((c) => { try { c.destroy(); } catch (e) { /* already gone */ } });
    state.charts = [];
  }

  /* ── data layer (fixture seam + AbortController) ───────────────────────── */

  function ccGet(path, signal) {
    const fx = window.__ccFixture;
    if (fx && typeof fx === 'object') {
      const key = path.split('?')[0];
      const hit = Object.prototype.hasOwnProperty.call(fx, path) ? fx[path]
        : Object.prototype.hasOwnProperty.call(fx, key) ? fx[key] : undefined;
      if (hit !== undefined) return Promise.resolve(hit);
    }
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    return fetch(BASE + path, { signal, headers }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ── shared small renders ──────────────────────────────────────────────── */

  function note(host, msg) {
    host.replaceChildren();
    host.appendChild(el('div', 'cca-note', msg));
  }

  function chartsUnavailable(host) {
    note(host, 'Charts unavailable — vendor Chart.js not loaded.');
  }

  function skel(host, height) {
    host.replaceChildren();
    const b = el('div', 'cca-skel');
    b.style.height = height + 'px';
    host.appendChild(b);
  }

  function skelTiles(host) {
    host.replaceChildren();
    const grid = el('div', 'cca-skel-tiles');
    for (let i = 0; i < 5; i++) {
      const b = el('div', 'cca-skel');
      b.style.height = '72px';
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }

  function chartHost(host, height) {
    host.replaceChildren();
    const wrap = el('div', 'cca-chart');
    if (height) wrap.style.height = height + 'px';
    host.appendChild(wrap);
    return wrap;
  }

  /* ── (a) stat tiles ────────────────────────────────────────────────────── */

  function renderTiles(host, d) {
    if (!d || typeof d !== 'object') {
      note(host, 'No usage data found.');
      return;
    }
    host.replaceChildren();
    const grid = el('div', 'cca-tiles');
    const tile = (label, value, accent) => {
      const c = el('div', 'cca-tile' + (accent ? ' cca-tile--accent' : ''));
      c.appendChild(el('div', 'cca-tile-label', label));
      c.appendChild(el('div', 'cca-tile-value', value));
      grid.appendChild(c);
    };
    tile('Conversations', fmtNum(d.conversations));
    tile('Projects', fmtNum(d.projects));
    tile('Tokens this week', fmtNum(d.this_week_tokens));
    tile('Estimated value this month', fmtUsd(d.this_month_usd), true);
    tile('Storage', fmtMb(d.storage_mb));
    host.appendChild(grid);
  }

  /* ── (b) token / cost over time (two small-multiple lines, one axis each) ─ */

  function renderDaily(state, tokHost, usdHost, daily) {
    const rows = Array.isArray(daily) ? daily.filter((r) => r && r.date) : [];
    if (!rows.length) {
      note(tokHost, 'No usage recorded yet.');
      note(usdHost, 'No usage recorded yet.');
      return;
    }
    if (!hasChart()) { chartsUnavailable(tokHost); chartsUnavailable(usdHost); return; }
    const t = theme();
    const labels = rows.map((r) => String(r.date));
    const line = (host, values, fmt, word) => {
      makeChart(state, chartHost(host), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: values,
            borderColor: t.accent,
            borderWidth: 2,
            backgroundColor: t.accentFill,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: t.accent,
            pointHoverBorderColor: t.panel,
            pointHoverBorderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: Object.assign(tooltipOpts(t), {
              callbacks: { label: (c) => fmt(c.parsed.y) + (word ? ' ' + word : '') },
            }),
          },
          scales: {
            x: {
              ticks: { color: t.inkMid, font: { size: 10 }, maxTicksLimit: 7, maxRotation: 0 },
              grid: { display: false },
              border: { display: false },
            },
            y: {
              beginAtZero: true,
              ticks: { color: t.inkMid, font: { size: 10 }, maxTicksLimit: 5, callback: (v) => fmt(v) },
              grid: { color: t.grid },
              border: { display: false },
            },
          },
        },
      });
    };
    line(tokHost, rows.map((r) => num(r.tokens)), fmtNum, 'tokens');
    line(usdHost, rows.map((r) => num(r.usd)), fmtUsd, '');
  }

  /* ── (c) cache efficiency donut with center stat ───────────────────────── */

  function renderCache(state, host, cache) {
    const read = cache ? num(cache.read) : 0;
    const write = cache ? num(cache.write) : 0;
    if (!read && !write) {
      note(host, 'No cache activity recorded.');
      return;
    }
    host.replaceChildren();
    const t = theme();
    const pct = cache.pct != null ? num(cache.pct) : (read + write ? Math.round((read / (read + write)) * 100) : 0);
    const saved = num(cache.saved_usd);

    if (hasChart()) {
      const wrap = el('div', 'cca-chart cca-chart--donut');
      host.appendChild(wrap);
      const total = read + write;
      makeChart(state, wrap, {
        type: 'doughnut',
        data: {
          labels: ['Cache read', 'Cache write'],
          datasets: [{
            data: [read, write],
            backgroundColor: [t.cat1, t.cat3],
            borderColor: t.panel,
            borderWidth: 2, // 2px surface gap between fills
            hoverOffset: 4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          animation: { duration: 300 },
          plugins: {
            legend: { display: false }, // hand-drawn legend below keeps the center stat centered
            tooltip: Object.assign(tooltipOpts(t), {
              callbacks: {
                label: (c) => c.label + ': ' + fmtNum(c.parsed) + ' tokens' +
                  (total ? ' (' + Math.round((c.parsed / total) * 100) + '%)' : ''),
              },
            }),
          },
        },
      });
      const center = el('div', 'cca-donut-center');
      center.appendChild(el('div', 'cca-donut-pct', pct + '%'));
      center.appendChild(el('div', 'cca-donut-sub', 'cached'));
      center.appendChild(el('div', 'cca-donut-sub', fmtUsd(saved) + ' saved'));
      wrap.appendChild(center);
    } else {
      const center = el('div', 'cca-note');
      center.textContent = pct + '% cached · ' + fmtUsd(saved) + ' saved (charts unavailable)';
      host.appendChild(center);
    }

    const legend = el('div', 'cca-mini-legend');
    [['Cache read ' + fmtNum(read), t.cat1], ['Cache write ' + fmtNum(write), t.cat3]].forEach(([label, color]) => {
      const item = el('span');
      const dot = el('span', 'cca-dot');
      dot.style.background = color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }

  /* ── (d) usage-by-model + cost-by-model horizontal bars ────────────────── */

  function shortModel(m) {
    return String(m == null ? '' : m).replace(/^claude-/, '') || 'unknown';
  }

  function renderModels(state, tokHost, usdHost, byModel) {
    const rows = Array.isArray(byModel) ? byModel.filter((r) => r && (r.model != null)) : [];
    if (!rows.length) {
      note(tokHost, 'No model usage recorded.');
      note(usdHost, 'No model usage recorded.');
      return;
    }
    if (!hasChart()) { chartsUnavailable(tokHost); chartsUnavailable(usdHost); return; }
    const t = theme();
    const hbar = (host, sorted, field, color, fmt, word) => {
      const labels = sorted.map((r) => shortModel(r.model));
      const values = sorted.map((r) => num(r[field]));
      const height = Math.max(140, sorted.length * 28 + 46);
      makeChart(state, chartHost(host, height), {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: color,
            borderRadius: 4,
            borderSkipped: 'start', // rounded data-end, square at the baseline
            maxBarThickness: 14,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          plugins: {
            legend: { display: false },
            tooltip: Object.assign(tooltipOpts(t), {
              callbacks: { label: (c) => fmt(c.parsed.x) + (word ? ' ' + word : '') },
            }),
          },
          scales: {
            x: {
              beginAtZero: true,
              ticks: { color: t.inkMid, font: { size: 10 }, maxTicksLimit: 5, callback: (v) => fmt(v) },
              grid: { color: t.grid },
              border: { display: false },
            },
            y: {
              ticks: { color: t.ink, font: { size: 10 }, autoSkip: false },
              grid: { display: false },
              border: { display: false },
            },
          },
        },
      });
    };
    const topTok = rows.slice().sort((a, b) => num(b.tokens) - num(a.tokens)).slice(0, 8);
    const topUsd = rows.slice().sort((a, b) => num(b.usd) - num(a.usd)).slice(0, 8);
    hbar(tokHost, topTok, 'tokens', t.accent, fmtNum, 'tokens');
    hbar(usdHost, topUsd, 'usd', t.cat2, fmtUsd, '');
  }

  /* ── (e) peak hours histogram (top-3 full accent) ──────────────────────── */

  function renderHours(state, host, hours) {
    const vals = Array.isArray(hours) ? hours.slice(0, 24).map(num) : [];
    while (vals.length < 24) vals.push(0);
    if (!vals.some((v) => v > 0)) {
      note(host, 'No activity recorded yet.');
      return;
    }
    if (!hasChart()) { chartsUnavailable(host); return; }
    const t = theme();
    const top3 = vals.map((v, i) => [v, i])
      .filter((p) => p[0] > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map((p) => p[1]);
    const colors = vals.map((_, i) => (top3.indexOf(i) !== -1 ? t.accent : t.accentDim));
    makeChart(state, chartHost(host), {
      type: 'bar',
      data: {
        labels: vals.map((_, i) => i),
        datasets: [{
          data: vals,
          backgroundColor: colors,
          borderRadius: 3,
          borderSkipped: 'bottom',
          categoryPercentage: 0.9,
          barPercentage: 0.85,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign(tooltipOpts(t), {
            callbacks: {
              title: (items) => (items[0] ? items[0].label + ':00 – ' + items[0].label + ':59' : ''),
              label: (c) => fmtNum(c.parsed.y) + ' tokens',
            },
          }),
        },
        scales: {
          x: {
            ticks: {
              color: t.inkMid,
              font: { size: 10 },
              maxRotation: 0,
              autoSkip: false,
              callback: (v, i) => (i % 6 === 0 ? i + ':00' : ''),
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { color: t.inkMid, font: { size: 10 }, maxTicksLimit: 4, callback: (v) => fmtNum(v) },
            grid: { color: t.grid },
            border: { display: false },
          },
        },
      },
    });
  }

  /* ── (f) calendar heatmap (hand-drawn, --viz-seq ramp, bordered cells) ─── */

  const HM_DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const HM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function seqStep(val, max) {
    if (!val || !max) return 0;
    const t = Math.pow(val / max, 0.45);
    if (t < 0.18) return 1;
    if (t < 0.35) return 2;
    if (t < 0.55) return 3;
    if (t < 0.75) return 4;
    if (t < 0.90) return 5;
    return 6;
  }

  function renderHeatmap(host, tip, data) {
    const days = data && Array.isArray(data.days) ? data.days.filter((r) => r && r.date) : [];
    if (!days.length) {
      note(host, 'No daily usage to map.');
      return;
    }
    host.replaceChildren();

    const byDay = new Map();
    let minTs = Infinity;
    days.forEach((r) => {
      const key = String(r.date).slice(0, 10);
      byDay.set(key, { tokens: num(r.tokens), usd: num(r.usd) });
      const ts = new Date(key + 'T00:00:00').getTime();
      if (Number.isFinite(ts) && ts < minTs) minTs = ts;
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const gridEnd = new Date(today);
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay())); // forward to Saturday (Sun-first columns)

    let weeks = 16;
    if (Number.isFinite(minTs)) {
      const span = Math.ceil((gridEnd.getTime() - minTs) / 864e5) + 1;
      weeks = Math.max(8, Math.min(26, Math.ceil(span / 7)));
    }

    let max = 0;
    byDay.forEach((v) => { if (v.tokens > max) max = v.tokens; });

    const wrap = el('div', 'cca-hm');
    const dayCol = el('div', 'cca-hm-days');
    HM_DAY_LABELS.forEach((d) => dayCol.appendChild(el('div', 'cca-hm-day', d)));
    const scroll = el('div', 'cca-hm-scroll');
    const grid = el('div', 'cca-hm-grid');
    scroll.appendChild(grid);
    wrap.appendChild(dayCol);
    wrap.appendChild(scroll);

    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const col = el('div', 'cca-hm-col');
      const colStart = new Date(gridEnd);
      colStart.setDate(gridEnd.getDate() - ((weeks - 1 - w) * 7 + 6));
      const month = colStart.getMonth();
      const monthLbl = el('div', 'cca-hm-month');
      if (month !== lastMonth) {
        monthLbl.textContent = HM_MONTHS[month];
        lastMonth = month;
      }
      col.appendChild(monthLbl);

      for (let d = 0; d < 7; d++) {
        const date = new Date(colStart);
        date.setDate(colStart.getDate() + d);
        const cell = el('div', 'cca-hm-cell');
        if (date > today) {
          cell.classList.add('cca-hm-cell--future');
        } else {
          const key = dayKey(date);
          const rec = byDay.get(key);
          const step = seqStep(rec ? rec.tokens : 0, max);
          if (step > 0) cell.style.background = 'var(--viz-seq-' + step + ')';
          cell.dataset.tip = key + ' · ' + fmtNum(rec ? rec.tokens : 0) + ' tokens' +
            (rec && rec.usd ? ' · ' + fmtUsd(rec.usd) : '');
        }
        col.appendChild(cell);
      }
      grid.appendChild(col);
    }

    // delegated hover tooltip (fixed-position, textContent only)
    grid.addEventListener('mousemove', (e) => {
      const cell = e.target && e.target.closest ? e.target.closest('.cca-hm-cell') : null;
      const text = cell && cell.dataset ? cell.dataset.tip : null;
      if (text) {
        tip.textContent = text;
        tip.hidden = false;
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 34) + 'px';
      } else {
        tip.hidden = true;
      }
    });
    grid.addEventListener('mouseleave', () => { tip.hidden = true; });

    const legend = el('div', 'cca-hm-legend');
    legend.appendChild(el('span', null, 'Less'));
    for (let i = 0; i <= 6; i++) {
      const c = el('div', 'cca-hm-cell');
      if (i > 0) c.style.background = 'var(--viz-seq-' + i + ')';
      legend.appendChild(c);
    }
    legend.appendChild(el('span', null, 'More'));

    host.appendChild(wrap);
    host.appendChild(legend);
    requestAnimationFrame(() => { scroll.scrollLeft = scroll.scrollWidth; });
  }

  /* ── (g) recent-sessions leaderboard (lb-bar idiom) ────────────────────── */

  function renderLeaderboard(host, rows) {
    const sessions = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    if (!sessions.length) {
      note(host, 'No recent sessions.');
      return;
    }
    host.replaceChildren();
    const list = el('div', 'cca-lb');
    const max = Math.max.apply(null, sessions.map((s) => num(s.total_tokens)).concat([1]));
    sessions.forEach((s, i) => {
      const row = el('div', 'cca-lb-row');
      const project = String(s.project == null ? '' : s.project) || 'unknown project';
      const model = shortModel(s.model);

      row.appendChild(el('span', 'cca-lb-rank', String(i + 1)));

      const proj = el('span', 'cca-lb-proj', project);
      proj.title = project + ' · ' + model +
        (s.session_id != null ? ' · ' + String(s.session_id).slice(0, 8) : '') +
        (fmtWhen(s.started_at) ? ' · ' + fmtWhen(s.started_at) : '') +
        (s.turns != null ? ' · ' + fmtNum(s.turns) + ' turns' : '');
      row.appendChild(proj);

      row.appendChild(el('span', 'cca-lb-model', model));

      const wrap = el('div', 'cca-lb-bar-wrap');
      const fill = el('div', 'cca-lb-bar-fill');
      fill.style.width = Math.max(1, Math.round((num(s.total_tokens) / max) * 100)) + '%';
      wrap.appendChild(fill);
      row.appendChild(wrap);

      row.appendChild(el('span', 'cca-lb-tok', fmtNum(s.total_tokens)));
      row.appendChild(el('span', 'cca-lb-usd', fmtUsd(s.total_usd)));
      list.appendChild(row);
    });
    host.appendChild(list);
  }

  /* ── mount / load / cleanup ────────────────────────────────────────────── */

  let current = null; // active mounted instance: { state, load }

  function mount(container) {
    injectCss();
    const t = theme();
    applyChartTheme(t);

    const state = { charts: [], ctrl: null };

    const root = el('div', 'cca-root');
    const inner = el('div', 'cca-inner');
    root.appendChild(inner);

    const tip = el('div', 'cca-tip');
    tip.hidden = true;
    root.appendChild(tip);

    const panel = (parent, title) => {
      const sec = el('section', 'cca-sec');
      sec.appendChild(el('h3', 'cca-sec-title', title));
      const body = el('div', 'cca-sec-body');
      sec.appendChild(body);
      parent.appendChild(sec);
      return body;
    };

    const ui = {};
    ui.tiles = el('div');
    inner.appendChild(ui.tiles);

    const rowDaily = el('div', 'cca-grid-2');
    inner.appendChild(rowDaily);
    ui.dailyTok = panel(rowDaily, 'Tokens per day');
    ui.dailyUsd = panel(rowDaily, 'Estimated value per day');

    const rowMid = el('div', 'cca-grid-2');
    inner.appendChild(rowMid);
    ui.cache = panel(rowMid, 'Cache efficiency');
    ui.hours = panel(rowMid, 'Peak hours');

    const rowModels = el('div', 'cca-grid-2');
    inner.appendChild(rowModels);
    ui.modelTok = panel(rowModels, 'Usage by model');
    ui.modelUsd = panel(rowModels, 'Estimated value by model');

    ui.heatmap = panel(inner, 'Daily tokens');
    ui.sessions = panel(inner, 'Recent sessions');

    container.appendChild(root);

    function load() {
      if (state.ctrl) state.ctrl.abort();
      state.ctrl = new AbortController();
      const sig = state.ctrl.signal;
      destroyCharts(state);
      tip.hidden = true;

      skelTiles(ui.tiles);
      skel(ui.dailyTok, 220);
      skel(ui.dailyUsd, 220);
      skel(ui.cache, 220);
      skel(ui.hours, 220);
      skel(ui.modelTok, 180);
      skel(ui.modelUsd, 180);
      skel(ui.heatmap, 140);
      skel(ui.sessions, 200);

      const guard = (fn) => (d) => { if (!sig.aborted) fn(d); };
      const fail = (hosts, msg) => (err) => {
        if (sig.aborted || (err && err.name === 'AbortError')) return;
        hosts.forEach((h) => note(h, msg));
      };
      const UNAVAILABLE = 'Usage data unavailable.';

      ccGet('/cc/status', sig)
        .then(guard((d) => renderTiles(ui.tiles, d)))
        .catch(fail([ui.tiles], UNAVAILABLE));

      ccGet('/cc/aggregate', sig)
        .then(guard((d) => {
          const agg = d && typeof d === 'object' ? d : {};
          renderDaily(state, ui.dailyTok, ui.dailyUsd, agg.daily);
          renderCache(state, ui.cache, agg.cache);
          renderModels(state, ui.modelTok, ui.modelUsd, agg.by_model);
          renderHours(state, ui.hours, agg.peak_hours);
        }))
        .catch(fail([ui.dailyTok, ui.dailyUsd, ui.cache, ui.modelTok, ui.modelUsd, ui.hours], UNAVAILABLE));

      ccGet('/cc/heatmap', sig)
        .then(guard((d) => renderHeatmap(ui.heatmap, tip, d)))
        .catch(fail([ui.heatmap], UNAVAILABLE));

      ccGet('/cc/usage?limit=12', sig)
        .then(guard((d) => renderLeaderboard(ui.sessions, d)))
        .catch(fail([ui.sessions], UNAVAILABLE));
    }

    current = { state, load };
    load();

    return function cleanup() {
      if (state.ctrl) state.ctrl.abort();
      destroyCharts(state);
      tip.remove();
      root.remove();
      if (current && current.state === state) current = null;
    };
  }

  /* ── registration (views.js may load just after us — retry briefly) ────── */

  const DEF = {
    label: 'Usage',
    icon: '◍',
    section: 'analytics',
    order: 1,
    onRefresh: function () { if (current) current.load(); },
    mount: mount,
  };

  (function register(tries) {
    const A = window.Atelier;
    if (A && A.views && typeof A.views.register === 'function') {
      A.views.register(VIEW_ID, DEF);
      return;
    }
    if (tries <= 0) {
      console.warn('[analytics] Atelier.views unavailable — Claude Code view not registered.');
      return;
    }
    setTimeout(function () { register(tries - 1); }, 50);
  })(100);
})();
