'use strict';

/* ===========================================================================
   Atelier feature module — run ledger   (app/ledger.js)

   The "Run ledger" view: a plain-language, scrollable history of every
   scheduled run the studio has fired. It answers, at a glance and in order
   (newest on top), the ops-rigor questions you actually ask after a run:

     • Did it finish or fail?      — a plain "Finished" / "Failed" badge
                                     (never the raw "ok" / "http-500" code).
     • When did it run?            — a friendly relative time ("12m ago")
                                     with the exact local timestamp on hover.
     • How long did it take?       — wall latency in human units.
     • How much work / value?      — tokens and (when non-zero) estimated
                                     value for the run.
     • Did it have to retry?       — a quiet "retried Nx" tag when attempts>1.
     • What went wrong?            — on failures, the error (and any response
                                     excerpt) expands inline, one click.

   Above the list sits a small stat-tile header fed by GET /metrics: runs
   today / total, how many finished vs failed, tokens today / total, and total
   estimated value. A header ↻ (and window.AtelierLedger.refresh()) re-pulls.

   Wiring & boundaries
   -------------------
   Registered as a full-canvas view through window.Atelier.views (Contract 1),
   exactly like analytics.js / graph.js, and ALSO exposed as a ⌘K palette
   command that opens it. Fed by two already-live, read-only endpoints
   (Contract 2):

     GET /runs?limit=200  -> { runs: [record, ...] }   (oldest-first; we reverse)
     GET /metrics         -> header totals

   The /runs records are OLDEST-first from the API and the limit is clamped to
   200 server-side, so we request 200 and reverse for newest-on-top. tokens /
   cost may be null and status is one of "ok" | "error" | "http-<code>", so
   every number is coerced with a Number()||0 guard and the badge branches on
   the status prefix.

   Built ONLY against window.Atelier(.views) + standard DOM + the guarded
   window.atelier token bridge. Injects its own CSS reusing the styles.css
   design tokens; does NOT edit index.html, lite_server.py, styles.css, or any
   sibling module. XSS rule: every network-derived string (job name, error,
   response excerpt, timestamp) enters the DOM via textContent only — never
   innerHTML. Keyboard + screen-reader accessible; ends with a selfCheck() log.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Serve lite_server on :8765 with a non-empty ~/.openswarm/runs.jsonl.
   2. Sidebar "Analytics" group -> "Run ledger" row (▤). Click it: a
      full-canvas overlay opens with a stat-tile header and a scrollable list
      of runs, newest first, each with a Finished/Failed badge, relative time,
      duration, tokens, retries tag, and (on failures) an expandable error.
   3. Click a failed row (or press Enter/Space on it) -> the error and any
      response excerpt expand inline; click again to collapse.
   4. Header ↻ -> the list and tiles flash skeletons then repopulate.
   5. ⌘K -> "Run ledger" command opens the same view.
   6. Stop lite_server and ↻ -> quiet "couldn't load" notes; nothing throws.
   =========================================================================== */

(function () {
  const BASE = 'http://127.0.0.1:8765';
  const VIEW_ID = 'ledger';
  const STYLE_ID = 'atl-ledger-style';
  const RUNS_LIMIT = 200; // server clamps to 200; ask for the fullest history

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

  // Wall time in human units: 940ms / 3.2s / 4m 05s / 1h 12m.
  function fmtDuration(ms) {
    const n = num(ms);
    if (n <= 0) return '—';
    if (n < 1000) return Math.round(n) + 'ms';
    const s = n / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(Math.round(s - m * 60)).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + String(m - h * 60).padStart(2, '0') + 'm';
  }

  // The ledger writes naive LOCAL ISO timestamps (no zone), which new Date()
  // parses as local — exactly what we want.
  function parseTs(v) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtRelative(d) {
    if (!d) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 0) return 'just now';
    const s = Math.round(diff / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' min ago' : ' mins ago');
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(h / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return d.toLocaleDateString();
  }

  function fmtExact(d) {
    if (!d) return '';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // A run "finished" only when status is exactly "ok"; everything else
  // ("error", "http-<code>") is a failure.
  function isOk(rec) { return rec && rec.status === 'ok'; }

  // A short, plain reason chip for a non-ok status ("HTTP 500" / "errored").
  function failReason(rec) {
    const st = rec && rec.status ? String(rec.status) : '';
    const m = st.match(/^http-(\d+)$/);
    if (m) return 'HTTP ' + m[1];
    if (rec && num(rec.status_code) > 0) return 'HTTP ' + num(rec.status_code);
    return 'errored';
  }

  /* ── module CSS (reuses styles.css design tokens) ──────────────────────── */

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.atl-lg-root{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;}',
      '.atl-lg-inner{max-width:960px;margin:0 auto;padding:20px 26px 56px;display:flex;flex-direction:column;gap:16px;}',

      '.atl-lg-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;}',
      '.atl-lg-tile{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:14px 16px;min-width:0;}',
      '.atl-lg-tile-label{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.atl-lg-tile-value{font-size:24px;font-weight:650;color:var(--ink);line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.atl-lg-tile--accent .atl-lg-tile-value{color:var(--accent);}',
      '.atl-lg-tile--ok .atl-lg-tile-value{color:var(--ok);}',

      '.atl-lg-sec{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:8px 8px 10px;min-width:0;}',
      '.atl-lg-sec-head{display:flex;align-items:baseline;gap:8px;padding:8px 10px 10px;}',
      '.atl-lg-sec-title{margin:0;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-mid);}',
      '.atl-lg-count{font-size:11px;color:var(--ink-dim);font-variant-numeric:tabular-nums;}',

      '.atl-lg-list{display:flex;flex-direction:column;}',
      '.atl-lg-row{border-top:1px solid var(--border-soft);}',
      '.atl-lg-list>.atl-lg-row:first-child{border-top:none;}',
      '.atl-lg-main{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;text-align:left;background:transparent;border:none;color:inherit;font:inherit;padding:11px 10px;border-radius:8px;min-width:0;}',
      '.atl-lg-main.is-clickable{cursor:pointer;}',
      '.atl-lg-main.is-clickable:hover{background:var(--active);}',
      '.atl-lg-main:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}',

      '.atl-lg-badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;}',
      '.atl-lg-badge .dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;}',
      '.atl-lg-badge--ok{background:rgba(47,125,114,0.12);color:#2f7d72;}',
      '.atl-lg-badge--ok .dot{background:#2f7d72;}',
      '.atl-lg-badge--fail{background:rgba(192,92,55,0.12);color:var(--accent);}',
      '.atl-lg-badge--fail .dot{background:var(--accent);}',

      '.atl-lg-name{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.atl-lg-name .n{font-size:13px;color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.atl-lg-name .sub{font-size:11px;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.atl-lg-reason{color:var(--accent);}',

      '.atl-lg-meta{flex:0 0 auto;display:flex;align-items:center;gap:14px;}',
      '.atl-lg-stat{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:0;}',
      '.atl-lg-stat .v{font-size:12px;color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600;}',
      '.atl-lg-stat .k{font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-dim);}',
      '.atl-lg-retry{font-size:10.5px;font-weight:600;color:var(--viz-warn,#b9822a);background:rgba(185,130,42,0.12);border-radius:999px;padding:2px 7px;white-space:nowrap;}',
      '.atl-lg-caret{flex:0 0 12px;width:12px;color:var(--ink-dim);font-size:11px;text-align:center;transition:transform .18s ease;}',
      '.atl-lg-row.is-open .atl-lg-caret{transform:rotate(90deg);}',

      '.atl-lg-detail{padding:2px 12px 14px 12px;display:none;flex-direction:column;gap:10px;}',
      '.atl-lg-row.is-open .atl-lg-detail{display:flex;}',
      '.atl-lg-dlabel{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;}',
      '.atl-lg-pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;color:var(--ink);background:rgba(60,48,34,0.045);border:1px solid var(--border-soft);border-radius:8px;padding:9px 11px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
      '.atl-lg-pre.err{color:var(--accent);}',

      '.atl-lg-note{padding:34px 10px;text-align:center;font-size:12.5px;color:var(--ink-dim);}',
      '.atl-lg-skel{border-radius:8px;background:linear-gradient(100deg,rgba(60,48,34,0.05) 40%,rgba(60,48,34,0.10) 50%,rgba(60,48,34,0.05) 60%);background-size:200% 100%;animation:atl-lg-shimmer 1.4s infinite linear;}',
      '@keyframes atl-lg-shimmer{to{background-position:-200% 0;}}',
      '.atl-lg-skel-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;}',

      '@media (max-width:640px){.atl-lg-meta .atl-lg-stat.opt{display:none;}.atl-lg-name .sub{white-space:normal;}}',
      '@media (prefers-reduced-motion: reduce){.atl-lg-caret{transition:none;}.atl-lg-skel{animation:none;}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── data layer (guarded; never throws, token header like siblings) ────── */

  async function api(path, signal) {
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, { headers, signal });
      let data = null;
      try { data = await res.json(); } catch (e) { /* empty / non-JSON */ }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, aborted: !!(e && e.name === 'AbortError') };
    }
  }

  /* ── shared small renders ──────────────────────────────────────────────── */

  function note(host, msg) {
    host.replaceChildren();
    host.appendChild(el('div', 'atl-lg-note', msg));
  }

  function skelTiles(host) {
    host.replaceChildren();
    const grid = el('div', 'atl-lg-skel-tiles');
    for (let i = 0; i < 6; i++) {
      const b = el('div', 'atl-lg-skel');
      b.style.height = '68px';
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }

  function skelList(host) {
    host.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const b = el('div', 'atl-lg-skel');
      b.style.height = '46px';
      b.style.margin = '6px 4px';
      host.appendChild(b);
    }
  }

  /* ── header tiles from /metrics ─────────────────────────────────────────── */

  function renderTiles(host, d) {
    if (!d || typeof d !== 'object') {
      note(host, "Couldn't load the totals.");
      return;
    }
    const runs = d.runs && typeof d.runs === 'object' ? d.runs : {};
    host.replaceChildren();
    const grid = el('div', 'atl-lg-tiles');
    const tile = (label, value, mod) => {
      const c = el('div', 'atl-lg-tile' + (mod ? ' atl-lg-tile--' + mod : ''));
      c.appendChild(el('div', 'atl-lg-tile-label', label));
      c.appendChild(el('div', 'atl-lg-tile-value', value));
      grid.appendChild(c);
    };
    tile('Runs today', fmtNum(runs.today));
    tile('Runs total', fmtNum(runs.total));
    tile('Finished', fmtNum(runs.ok), 'ok');
    tile('Failed', fmtNum(runs.fail), num(runs.fail) > 0 ? 'accent' : '');
    tile('Tokens today', fmtNum(d.tokens_today));
    tile('Tokens total', fmtNum(d.tokens_total));
    if (num(d.cost_total) > 0) tile('Value total', fmtUsd(d.cost_total), 'accent');
    host.appendChild(grid);
  }

  /* ── one run row ───────────────────────────────────────────────────────── */

  function renderRow(rec) {
    const ok = isOk(rec);
    const ts = parseTs(rec.ts);
    const attempts = num(rec.attempts);
    const retried = attempts > 1;
    const errText = rec.error != null && String(rec.error).trim() !== '' ? String(rec.error) : '';
    const excerpt = rec.response_excerpt != null && String(rec.response_excerpt).trim() !== ''
      ? String(rec.response_excerpt) : '';
    const expandable = !ok && (errText || excerpt);

    const row = el('div', 'atl-lg-row');

    // main line — a <button> when expandable so it's keyboard-operable
    const main = document.createElement(expandable ? 'button' : 'div');
    main.className = 'atl-lg-main' + (expandable ? ' is-clickable' : '');
    if (expandable) main.type = 'button';

    // status badge
    const badge = el('span', 'atl-lg-badge ' + (ok ? 'atl-lg-badge--ok' : 'atl-lg-badge--fail'));
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(document.createTextNode(ok ? 'Finished' : 'Failed'));

    // name + subline (relative time · reason on failures)
    const nameWrap = el('div', 'atl-lg-name');
    nameWrap.appendChild(el('div', 'n', String(rec.name == null ? '' : rec.name) || 'unnamed run'));
    const sub = el('div', 'sub');
    const when = fmtRelative(ts) || 'unknown time';
    sub.appendChild(document.createTextNode(when));
    if (!ok) {
      sub.appendChild(document.createTextNode(' · '));
      sub.appendChild(el('span', 'atl-lg-reason', failReason(rec)));
    }
    nameWrap.appendChild(sub);
    if (ts) main.title = fmtExact(ts);

    // meta: duration, tokens, value, retry tag
    const meta = el('div', 'atl-lg-meta');
    const stat = (k, v, opt) => {
      const s = el('div', 'atl-lg-stat' + (opt ? ' opt' : ''));
      s.appendChild(el('span', 'v', v));
      s.appendChild(el('span', 'k', k));
      meta.appendChild(s);
    };
    if (retried) meta.appendChild(el('span', 'atl-lg-retry', 'retried ' + attempts + 'x'));
    stat('took', fmtDuration(rec.latency_ms), true);
    stat('tokens', fmtNum(rec.tokens));
    if (num(rec.cost) > 0) stat('value', fmtUsd(rec.cost), true);

    main.append(badge, nameWrap, meta);
    if (expandable) main.appendChild(el('span', 'atl-lg-caret', '▸'));
    row.appendChild(main);

    // expandable detail (error + response excerpt)
    if (expandable) {
      const detail = el('div', 'atl-lg-detail');
      if (errText) {
        const block = el('div');
        block.appendChild(el('div', 'atl-lg-dlabel', 'Error'));
        const pre = el('pre', 'atl-lg-pre err');
        pre.textContent = errText;
        block.appendChild(pre);
        detail.appendChild(block);
      }
      if (excerpt) {
        const block = el('div');
        block.appendChild(el('div', 'atl-lg-dlabel', 'Response excerpt'));
        const pre = el('pre', 'atl-lg-pre');
        pre.textContent = excerpt;
        block.appendChild(pre);
        detail.appendChild(block);
      }
      row.appendChild(detail);

      main.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const open = row.classList.toggle('is-open');
        main.setAttribute('aria-expanded', String(open));
        main.querySelector('.atl-lg-caret').textContent = open ? '▾' : '▸';
      };
      main.addEventListener('click', toggle);
    }

    return row;
  }

  function renderList(host, records) {
    const rows = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];
    if (!rows.length) {
      note(host, 'No runs yet. Scheduled runs will show up here as they fire.');
      return { count: 0 };
    }
    // API returns oldest-first; show newest on top.
    const ordered = rows.slice().reverse();
    host.replaceChildren();
    const list = el('div', 'atl-lg-list');
    ordered.forEach((rec) => list.appendChild(renderRow(rec)));
    host.appendChild(list);
    return { count: ordered.length };
  }

  /* ── mount / load / cleanup ────────────────────────────────────────────── */

  let current = null; // active mounted instance: { load }

  function mount(container) {
    injectCss();

    const root = el('div', 'atl-lg-root');
    const inner = el('div', 'atl-lg-inner');
    root.appendChild(inner);

    const tiles = el('div');
    inner.appendChild(tiles);

    const sec = el('section', 'atl-lg-sec');
    const head = el('div', 'atl-lg-sec-head');
    head.appendChild(el('h3', 'atl-lg-sec-title', 'Recent runs'));
    const count = el('span', 'atl-lg-count', '');
    head.appendChild(count);
    sec.appendChild(head);
    const listHost = el('div');
    sec.appendChild(listHost);
    inner.appendChild(sec);

    container.appendChild(root);

    let ctrl = null;

    function load() {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      const sig = ctrl.signal;

      skelTiles(tiles);
      skelList(listHost);
      count.textContent = '';

      api('/metrics', sig).then((r) => {
        if (sig.aborted) return;
        if (r.ok && r.data) renderTiles(tiles, r.data);
        else note(tiles, "Couldn't load the totals.");
      });

      api('/runs?limit=' + RUNS_LIMIT, sig).then((r) => {
        if (sig.aborted) return;
        const list = r.data && Array.isArray(r.data.runs) ? r.data.runs : null;
        if (r.ok && list) {
          const out = renderList(listHost, list);
          count.textContent = out.count ? out.count + (out.count === 1 ? ' run' : ' runs') : '';
        } else {
          note(listHost, "Couldn't load the runs. Is the studio backend running?");
          count.textContent = '';
        }
      });
    }

    current = { load };
    load();

    return function cleanup() {
      if (ctrl) ctrl.abort();
      root.remove();
      if (current && current.load === load) current = null;
    };
  }

  /* ── palette command (opens the view) ──────────────────────────────────── */

  function openView() {
    const A = window.Atelier;
    if (A && A.views && typeof A.views.select === 'function') A.views.select(VIEW_ID);
  }

  function registerPaletteCommand() {
    const A = window.Atelier;
    if (!A || !A.bus) return;
    A.bus.emit('palette:add', {
      id: 'ledger.open', label: 'Run ledger', icon: '▤', section: 'Studio',
      keywords: 'runs history status tokens cost value latency duration retries errors reliability ledger ops scheduled failed finished',
      run() { openView(); },
    });
  }

  /* ── registration (views.js may load just after us — retry briefly) ────── */

  const DEF = {
    label: 'Run ledger',
    icon: '▤',
    section: 'analytics',
    order: 2, // after "Claude Code" (1) / "Graph"
    onRefresh: function () { if (current) current.load(); },
    mount: mount,
  };

  (function register(tries) {
    const A = window.Atelier;
    if (A && A.views && typeof A.views.register === 'function') {
      A.views.register(VIEW_ID, DEF);
      registerPaletteCommand();
      if (A.bus) A.bus.on('palette:ready', registerPaletteCommand);
      return;
    }
    if (tries <= 0) {
      console.warn('[ledger] Atelier.views unavailable — run ledger not registered.');
      return;
    }
    setTimeout(function () { register(tries - 1); }, 50);
  })(100);

  /* ── public surface + self-check ───────────────────────────────────────── */

  window.AtelierLedger = {
    open: openView,
    refresh: function () { if (current) current.load(); },
  };

  (function selfCheck() {
    const registered = !!(window.AtelierLedger && typeof window.AtelierLedger.open === 'function');
    const fmtOk = fmtDuration(1500) === '1.5s' && fmtDuration(65000) === '1m 05s';
    console.assert(registered, '[ledger] module did not register window.AtelierLedger');
    console.assert(fmtOk, '[ledger] duration formatter miscalibrated');
    if (registered && fmtOk) {
      console.log('[ledger] self-check passed — run ledger view + palette command ready (GET /runs, /metrics).');
    }
  })();
})();
