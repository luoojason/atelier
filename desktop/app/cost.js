'use strict';

/* ===========================================================================
   Atelier feature module — Studio load HUD   (app/cost.js)

   A compact, always-visible corner panel that answers three plain questions
   at a glance and gives one big safety lever:

     1) How busy is the studio right now?  — a live count of agents that are
        working this second (GET /sessions, status === "running").
     2) How much room is left this week?    — a headroom bar of the week's
        work against a comfort limit the user sets (GET /cc/status →
        this_week_tokens). On Atelier the per-use price is $0, so "cost" here
        means WORK VOLUME / rate-limit headroom, never dollars.
     3) Am I about to overload it?          — a settable cap on how many agents
        may run at once, with a plain-language nudge as the running count nears
        that cap.

   And the lever: one prominent "Stop everything" button that halts every
   running agent, guarded by a small inline confirm so it can never fire by
   accident.

   Why a self-contained corner overlay (not a canvas card, not a topbar edit)
   -------------------------------------------------------------------------
   The HUD must survive canvas pan/zoom and board switches and stay put, so it
   mounts its OWN fixed-position element on document.body with its own injected
   <style> — exactly the sibling-module contract used by recipes.js and the
   core toast host. It touches ONLY window.Atelier (+ the optional
   window.atelier token bridge) and never edits index.html, core.js, styles.css
   or any backend file. The human wires the <script defer src="app/cost.js">
   tag; everything else here is self-installing.

   Data sources (all already live; no new backend needed for the MVP)
   ------------------------------------------------------------------
     • GET /sessions   → running count + the ids to stop.
     • GET /cc/status  → this_week_tokens (the only rolling-window work figure)
                         and active (is any transcript being written now).
     • bus 'backend:status' (core.js emits every 4s) → online/offline, so this
       module adds no /health poll of its own.

   Stopping a run
   --------------
   Preferred, non-destructive: POST /sessions/{id}/interrupt — cancels the
   in-flight turn but keeps the card and its transcript. That endpoint is an
   OPTIONAL backend addition (the human may not have wired it yet); when it is
   absent the call returns not-ok and this falls back to the always-present
   destructive halt, DELETE /sessions/{id}, which tears the session down. Both
   paths halt the work; the first is just gentler.

   The concurrent-agent cap
   ------------------------
   The authoritative backend cap is ATELIER_MAX_SESSIONS (default 12) and is
   not readable or settable over the API today, so the number here is a
   USER-CHOSEN preference stored locally. It is surfaced for other modules to
   enforce via window.AtelierHud.cap() and the 'hud:cap-changed' bus event
   (e.g. sessions.js could refuse to spawn past it); this module only shows it
   and warns as the live count approaches it.

   Boundaries: window.Atelier + standard DOM + the guarded window.atelier
   token bridge. Every dynamic string enters the DOM via textContent. Injects
   its own CSS. Reuses the design tokens from styles.css (--ink, --accent,
   --panel, --ok, --radius, …). Keyboard + screen-reader accessible; respects
   prefers-reduced-motion. Ends with a selfCheck() console log like siblings.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store) {
    console.warn('[cost] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 5000;                 // load poll cadence (immediate first tick)
  const HUD_Z = 3200;                   // above cards, below the recipes front door (4000)

  const CAP_KEY = 'hud.max-agents';     // user-chosen concurrent-agent cap
  const BUDGET_KEY = 'hud.weekly-budget'; // user-chosen weekly comfort limit (tokens)
  const COLLAPSED_KEY = 'hud.collapsed';  // remember the minimized state

  const CAP_MIN = 1;
  const CAP_MAX = 24;
  const CAP_DEFAULT = 12;               // mirrors the backend ATELIER_MAX_SESSIONS default
  const BUDGET_DEFAULT = 50000000;      // 50M tokens/week — a soft, user-editable comfort limit

  // ── tiny DOM helper (same idiom as the sibling modules) ────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Friendly number: 1.2k / 3.4M / 5 — same shape as analytics.js fmtNum.
  function fmtNum(v) {
    const n = Number(v) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function clampCap(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return CAP_DEFAULT;
    return Math.min(CAP_MAX, Math.max(CAP_MIN, n));
  }

  // ── stored preferences ─────────────────────────────────────────────────────
  function getCap() { return clampCap(A.store.get(CAP_KEY, CAP_DEFAULT)); }
  function setCap(v) {
    const n = clampCap(v);
    A.store.set(CAP_KEY, n);
    A.bus.emit('hud:cap-changed', { cap: n });
    return n;
  }
  function getBudget() {
    const n = Number(A.store.get(BUDGET_KEY, BUDGET_DEFAULT));
    return isFinite(n) && n > 0 ? n : BUDGET_DEFAULT;
  }
  function setBudget(tokens) {
    const n = Number(tokens);
    if (isFinite(n) && n > 0) A.store.set(BUDGET_KEY, Math.round(n));
  }

  // ── guarded backend helper (token header; never throws) ────────────────────
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

  async function runningSessions() {
    const r = await api('/sessions');
    const list = r && r.data && Array.isArray(r.data.sessions) ? r.data.sessions : [];
    return list.filter((s) => s && s.status === 'running');
  }

  // ── injected CSS (reuses styles.css design tokens) ─────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-hud-style')) return;
    const css = `
      .atl-hud { position: fixed; top: 62px; right: 16px; z-index: ${HUD_Z};
        width: 248px; box-sizing: border-box; background: var(--panel);
        border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow); color: var(--ink); overflow: hidden;
        font-size: 13px; }
      .atl-hud.is-offline { opacity: .72; }

      .atl-hud-head { display: flex; align-items: center; gap: 8px;
        padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--border-soft);
        cursor: default; }
      .atl-hud-live { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px;
        background: var(--ink-dim); }
      .atl-hud-live.on { background: var(--ok);
        animation: atl-hud-pulse 1.6s ease-in-out infinite; }
      .atl-hud.is-offline .atl-hud-live { background: var(--ink-dim); animation: none; }
      @keyframes atl-hud-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
      .atl-hud-title { font-weight: 700; font-size: 12.5px; color: var(--ink); }
      .atl-hud-sp { flex: 1; }
      .atl-hud-toggle { border: none; background: transparent; color: var(--ink-dim);
        cursor: pointer; font: inherit; font-size: 14px; line-height: 1; padding: 3px 5px;
        border-radius: 7px; }
      .atl-hud-toggle:hover { background: var(--active); color: var(--ink); }
      .atl-hud-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

      .atl-hud-body { padding: 12px; display: flex; flex-direction: column; gap: 13px; }
      .atl-hud.collapsed .atl-hud-body { display: none; }
      .atl-hud.collapsed { width: auto; }
      .atl-hud.collapsed .atl-hud-title::after { content: attr(data-now); }

      .atl-hud-now { display: flex; align-items: baseline; gap: 8px; }
      .atl-hud-now .n { font-size: 26px; font-weight: 800; letter-spacing: -0.02em;
        color: var(--ink); line-height: 1; }
      .atl-hud-now .n.busy { color: var(--accent); }
      .atl-hud-now .l { font-size: 12.5px; color: var(--ink-mid); }

      .atl-hud-block { display: flex; flex-direction: column; gap: 6px; }
      .atl-hud-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .atl-hud-row .k { font-size: 12px; color: var(--ink-mid); }
      .atl-hud-row .v { font-size: 12px; font-weight: 700; color: var(--ink); }

      .atl-hud-bar { height: 8px; border-radius: 999px; background: var(--accent-soft);
        overflow: hidden; }
      .atl-hud-bar > i { display: block; height: 100%; width: 0%; border-radius: 999px;
        background: var(--ok); transition: width .35s ease, background-color .35s ease; }
      .atl-hud-bar > i.warn { background: #cf9b3a; }
      .atl-hud-bar > i.danger { background: var(--accent); }
      .atl-hud-note { font-size: 11.5px; color: var(--ink-dim); line-height: 1.4; }
      .atl-hud-note.warn { color: #b07615; }
      .atl-hud-note.danger { color: var(--accent); font-weight: 600; }

      .atl-hud-div { height: 1px; background: var(--border-soft); margin: 1px 0; }

      .atl-hud-cap { display: flex; align-items: center; gap: 8px; }
      .atl-hud-cap .lab { font-size: 12px; color: var(--ink-mid); flex: 1; line-height: 1.3; }
      .atl-hud-step { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      .atl-hud-step button { width: 26px; height: 26px; flex: 0 0 26px; border: 1px solid var(--border);
        background: var(--panel); color: var(--ink); border-radius: 8px; cursor: pointer;
        font: inherit; font-size: 15px; line-height: 1; }
      .atl-hud-step button:hover { background: var(--active); }
      .atl-hud-step button:disabled { opacity: .4; cursor: default; }
      .atl-hud-step button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .atl-hud-step .capval { min-width: 22px; text-align: center; font-weight: 800;
        font-size: 15px; color: var(--ink); }

      .atl-hud-limit { display: flex; align-items: center; gap: 6px; }
      .atl-hud-limit label { font-size: 11.5px; color: var(--ink-dim); flex: 1; }
      .atl-hud-limit input { width: 58px; border: 1px solid var(--border); border-radius: 7px;
        padding: 4px 6px; font: inherit; font-size: 12px; color: var(--ink);
        background: #faf7f1; outline: none; text-align: right; }
      .atl-hud-limit input:focus { border-color: var(--accent); }
      .atl-hud-limit .unit { font-size: 11.5px; color: var(--ink-dim); }

      .atl-hud-stop { width: 100%; border: 1px solid transparent; border-radius: 10px;
        background: var(--accent); color: #fff; padding: 9px 12px; cursor: pointer;
        font: inherit; font-size: 13px; font-weight: 700; }
      .atl-hud-stop:hover { background: var(--accent-2); }
      .atl-hud-stop:disabled { opacity: .45; cursor: default; }
      .atl-hud-stop:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

      .atl-hud-confirm { display: flex; flex-direction: column; gap: 8px; }
      .atl-hud-confirm .q { font-size: 12.5px; color: var(--ink); font-weight: 600; }
      .atl-hud-confirm-row { display: flex; gap: 8px; }
      .atl-hud-confirm-row button { flex: 1; border-radius: 9px; padding: 8px 10px; cursor: pointer;
        font: inherit; font-size: 12.5px; font-weight: 700; }
      .atl-hud-yes { border: none; background: var(--accent); color: #fff; }
      .atl-hud-yes:hover { background: var(--accent-2); }
      .atl-hud-no { border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid); }
      .atl-hud-no:hover { background: var(--active); color: var(--ink); }
      .atl-hud-confirm-row button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

      @media (prefers-reduced-motion: reduce) {
        .atl-hud-live.on { animation: none; }
        .atl-hud-bar > i { transition: none; }
      }
    `;
    const style = el('style');
    style.id = 'atl-hud-style';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── build the panel ─────────────────────────────────────────────────────────
  let rootEl = null;
  let refs = {};
  let collapsed = A.store.get(COLLAPSED_KEY, false) === true;
  let online = null;              // null unknown, true up, false down
  let confirmOpen = false;
  let lastRunning = 0;

  function build() {
    const root = el('div', 'atl-hud');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Studio activity and safety controls');

    // header
    const head = el('div', 'atl-hud-head');
    const live = el('span', 'atl-hud-live');
    live.setAttribute('aria-hidden', 'true');
    const title = el('span', 'atl-hud-title', 'Studio load');
    const sp = el('div', 'atl-hud-sp');
    const toggle = el('button', 'atl-hud-toggle', collapsed ? '▸' : '▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand studio load panel' : 'Collapse studio load panel');
    toggle.addEventListener('click', () => setCollapsed(!collapsed));
    head.append(live, title, sp, toggle);

    // body
    const body = el('div', 'atl-hud-body');

    // (1) working now
    const now = el('div', 'atl-hud-now');
    now.setAttribute('role', 'status');
    now.setAttribute('aria-live', 'polite');
    const nowN = el('span', 'atl-hud-now-n n', '0');
    const nowL = el('span', 'l', 'agents working now');
    now.append(nowN, nowL);

    // (2) headroom this week
    const hrBlock = el('div', 'atl-hud-block');
    const hrRow = el('div', 'atl-hud-row');
    hrRow.append(el('span', 'k', 'Room left this week'), el('span', 'v atl-hud-hr-v', '—'));
    const bar = el('div', 'atl-hud-bar');
    const fill = el('i');
    bar.appendChild(fill);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Weekly work headroom');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const hrNote = el('div', 'atl-hud-note', 'Waiting for usage…');
    const weekRow = el('div', 'atl-hud-row');
    weekRow.append(el('span', 'k', 'Work this week'), el('span', 'v atl-hud-week-v', '—'));
    hrBlock.append(hrRow, bar, weekRow, hrNote);

    // (3) comfort-limit editor (drives the headroom read)
    const limit = el('div', 'atl-hud-limit');
    const limId = 'atl-hud-limit-in';
    const limLab = el('label', null, 'Comfort limit / week');
    limLab.setAttribute('for', limId);
    const limIn = document.createElement('input');
    limIn.type = 'number';
    limIn.id = limId;
    limIn.min = '1';
    limIn.step = '1';
    limIn.value = String(Math.round(getBudget() / 1e6));
    limIn.setAttribute('aria-label', 'Weekly comfort limit, in millions of tokens of work');
    const unit = el('span', 'unit', 'M');
    limit.append(limLab, limIn, unit);
    const applyLimit = () => {
      const millions = Number(limIn.value);
      if (isFinite(millions) && millions > 0) {
        setBudget(Math.round(millions * 1e6));
        render();
      } else {
        limIn.value = String(Math.round(getBudget() / 1e6));
      }
    };
    limIn.addEventListener('change', applyLimit);
    limIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); limIn.blur(); } });

    const div1 = el('div', 'atl-hud-div');

    // (4) concurrent cap
    const cap = el('div', 'atl-hud-cap');
    const capLab = el('span', 'lab', 'Run at most');
    const step = el('div', 'atl-hud-step');
    const minus = el('button', null, '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Allow fewer agents at once');
    const capVal = el('span', 'capval', String(getCap()));
    capVal.setAttribute('aria-live', 'polite');
    const plus = el('button', null, '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Allow more agents at once');
    step.append(minus, capVal, plus);
    cap.append(capLab, step);
    minus.addEventListener('click', () => { setCap(getCap() - 1); render(); });
    plus.addEventListener('click', () => { setCap(getCap() + 1); render(); });
    const capNote = el('div', 'atl-hud-note', '');

    const div2 = el('div', 'atl-hud-div');

    // (5) stop everything + inline confirm
    const stopWrap = el('div');
    const stopBtn = el('button', 'atl-hud-stop', 'Stop everything');
    stopBtn.type = 'button';
    stopBtn.setAttribute('aria-label', 'Stop every agent that is running now');
    stopBtn.addEventListener('click', openConfirm);
    stopWrap.appendChild(stopBtn);

    body.append(now, hrBlock, limit, div1, cap, capNote, div2, stopWrap);
    root.append(head, body);

    refs = { root, live, title, toggle, nowN, nowL, hrV: hrRow.querySelector('.atl-hud-hr-v'),
      bar, fill, hrNote, weekV: weekRow.querySelector('.atl-hud-week-v'), limIn,
      capVal, minus, plus, capNote, stopWrap, stopBtn };
    return root;
  }

  function setCollapsed(v) {
    collapsed = !!v;
    A.store.set(COLLAPSED_KEY, collapsed);
    if (!refs.root) return;
    refs.root.classList.toggle('collapsed', collapsed);
    refs.toggle.textContent = collapsed ? '▸' : '▾';
    refs.toggle.setAttribute('aria-expanded', String(!collapsed));
    refs.toggle.setAttribute('aria-label', collapsed ? 'Expand studio load panel' : 'Collapse studio load panel');
    render();
  }

  // ── inline confirm for the stop lever ──────────────────────────────────────
  function openConfirm() {
    if (confirmOpen || !refs.stopWrap) return;
    const n = lastRunning;
    if (!n) { toast('Nothing is running right now.'); return; }
    confirmOpen = true;
    refs.stopWrap.textContent = '';
    const box = el('div', 'atl-hud-confirm');
    const q = el('div', 'q', n === 1 ? 'Stop the 1 agent that is running?' : 'Stop all ' + n + ' running agents?');
    q.setAttribute('role', 'alert');
    const row = el('div', 'atl-hud-confirm-row');
    const yes = el('button', 'atl-hud-yes', n === 1 ? 'Stop it' : 'Stop all ' + n);
    yes.type = 'button';
    const no = el('button', 'atl-hud-no', 'Keep going');
    no.type = 'button';
    yes.addEventListener('click', () => { closeConfirm(); doStopAll(); });
    no.addEventListener('click', closeConfirm);
    row.append(yes, no);
    box.append(q, row);
    refs.stopWrap.appendChild(box);
    setTimeout(() => no.focus(), 20); // land on the safe choice
  }

  function closeConfirm() {
    confirmOpen = false;
    if (!refs.stopWrap) return;
    refs.stopWrap.textContent = '';
    const stopBtn = el('button', 'atl-hud-stop', 'Stop everything');
    stopBtn.type = 'button';
    stopBtn.setAttribute('aria-label', 'Stop every agent that is running now');
    stopBtn.addEventListener('click', openConfirm);
    refs.stopWrap.appendChild(stopBtn);
    refs.stopBtn = stopBtn;
  }

  async function doStopAll() {
    if (refs.stopBtn) { refs.stopBtn.disabled = true; refs.stopBtn.textContent = 'Stopping…'; }
    const running = await runningSessions();
    if (!running.length) { toast('Nothing was running.'); if (refs.stopBtn) refs.stopBtn.textContent = 'Stop everything'; render(); return; }
    let stopped = 0;
    for (const s of running) {
      // Prefer the gentle, non-destructive interrupt when the backend has it;
      // fall back to the always-present destructive DELETE otherwise.
      const soft = await api('/sessions/' + s.id + '/interrupt', { method: 'POST' });
      if (!soft.ok) {
        const hard = await api('/sessions/' + s.id, { method: 'DELETE' });
        if (hard.ok) stopped++;
      } else {
        stopped++;
      }
    }
    toast(stopped ? ('Stopped ' + stopped + (stopped === 1 ? ' agent.' : ' agents.')) : 'Could not stop the agents.');
    if (refs.stopBtn) { refs.stopBtn.disabled = false; refs.stopBtn.textContent = 'Stop everything'; }
    refresh();
  }

  function toast(msg) {
    if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(msg);
  }

  // ── render from current numbers ────────────────────────────────────────────
  let weekTokens = null;   // this_week_tokens from /cc/status (null = unknown)
  let activeNow = false;   // /cc/status.active

  function render() {
    if (!refs.root) return;
    const cap = getCap();
    const running = lastRunning;

    // live dot + offline styling
    refs.root.classList.toggle('is-offline', online === false);
    const beating = online !== false && (activeNow || running > 0);
    refs.live.classList.toggle('on', beating);

    // collapsed chip shows the running count inline via the title's ::after
    refs.title.dataset.now = collapsed ? ('  ·  ' + running + ' running') : '';

    // (1) working now
    refs.nowN.textContent = String(running);
    refs.nowN.classList.toggle('busy', running > 0);
    refs.nowL.textContent = running === 1 ? 'agent working now' : 'agents working now';

    // (2) headroom
    const budget = getBudget();
    if (weekTokens == null) {
      refs.hrV.textContent = '—';
      refs.fill.style.width = '0%';
      refs.bar.removeAttribute('aria-valuenow');
      refs.bar.setAttribute('aria-valuetext', 'Usage not available yet');
      refs.hrNote.textContent = online === false ? 'Offline — showing the last known load.' : 'Waiting for usage…';
      refs.hrNote.className = 'atl-hud-note';
      refs.weekV.textContent = '—';
    } else {
      const usedPct = Math.max(0, Math.min(100, Math.round((weekTokens / budget) * 100)));
      const leftPct = 100 - usedPct;
      refs.hrV.textContent = leftPct + '%';
      refs.fill.style.width = usedPct + '%';
      refs.fill.className = usedPct >= 90 ? 'danger' : usedPct >= 70 ? 'warn' : '';
      refs.bar.setAttribute('aria-valuenow', String(leftPct));
      refs.bar.setAttribute('aria-valuetext', leftPct + ' percent of your weekly comfort limit left');
      refs.weekV.textContent = fmtNum(weekTokens);
      if (usedPct >= 100) {
        refs.hrNote.textContent = 'Past your comfort limit for the week.';
        refs.hrNote.className = 'atl-hud-note danger';
      } else if (usedPct >= 90) {
        refs.hrNote.textContent = 'Almost out of room for the week.';
        refs.hrNote.className = 'atl-hud-note warn';
      } else if (usedPct >= 70) {
        refs.hrNote.textContent = 'Getting busy this week.';
        refs.hrNote.className = 'atl-hud-note warn';
      } else {
        refs.hrNote.textContent = 'Plenty of room this week.';
        refs.hrNote.className = 'atl-hud-note';
      }
    }

    // (4) cap value + nearing-cap nudge
    refs.capVal.textContent = String(cap);
    refs.minus.disabled = cap <= CAP_MIN;
    refs.plus.disabled = cap >= CAP_MAX;
    if (running >= cap) {
      refs.capNote.textContent = 'At your limit — new agents will wait their turn.';
      refs.capNote.className = 'atl-hud-note danger';
    } else if (running >= cap - 1 && cap > 1) {
      refs.capNote.textContent = 'One more and you hit your limit.';
      refs.capNote.className = 'atl-hud-note warn';
    } else {
      refs.capNote.textContent = 'Room for ' + (cap - running) + ' more before they queue.';
      refs.capNote.className = 'atl-hud-note';
    }

    // (5) stop button availability
    if (!confirmOpen && refs.stopBtn) refs.stopBtn.disabled = running === 0;
  }

  // ── polling ─────────────────────────────────────────────────────────────────
  let pollIv = null;

  async function refresh() {
    const [sess, cc] = await Promise.all([api('/sessions'), api('/cc/status')]);
    if (sess.data && Array.isArray(sess.data.sessions)) {
      lastRunning = sess.data.sessions.filter((s) => s && s.status === 'running').length;
    }
    if (cc.ok && cc.data) {
      weekTokens = Number(cc.data.this_week_tokens) || 0;
      activeNow = cc.data.active === true;
    }
    render();
  }

  // ── mount ───────────────────────────────────────────────────────────────────
  function mount() {
    if (rootEl) return;
    rootEl = build();
    if (collapsed) setCollapsed(true);
    document.body.appendChild(rootEl);
    render();
    refresh();
    pollIv = setInterval(refresh, POLL_MS);
  }

  // online/offline off the shared bus (no extra /health poll)
  A.bus.on('backend:status', (d) => {
    online = d && typeof d.ok === 'boolean' ? d.ok : (d && d.ok === null ? null : online);
    render();
  });

  // ⌘K palette command to jump to / reveal the HUD
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'hud.toggle', label: 'Studio load HUD', icon: '◧', section: 'Studio',
      keywords: 'load usage tokens stop agents cap limit safety headroom rate',
      run() { if (collapsed) setCollapsed(false); if (rootEl) rootEl.scrollIntoView({ block: 'nearest' }); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);

  // build after core is ready (deferred script may load either side of it)
  A.bus.on('core:ready', () => setTimeout(mount, 0));
  setTimeout(mount, 0);

  // ── public surface + self-check ────────────────────────────────────────────
  window.AtelierHud = {
    mount,
    refresh,
    cap: getCap,
    setCap: (v) => { const n = setCap(v); render(); return n; },
    stopAll: doStopAll,
    running: () => lastRunning,
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
    el: () => rootEl,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierHud && typeof window.AtelierHud.stopAll === 'function');
    const capOk = getCap() >= CAP_MIN && getCap() <= CAP_MAX;
    console.assert(registered, '[cost] module did not register window.AtelierHud');
    console.assert(capOk, '[cost] agent cap out of range');
    if (registered && capOk) {
      console.log('[cost] self-check passed — studio load HUD ready (cap ' + getCap() + ', poll ' + POLL_MS + 'ms).');
    }
  })();
})();
