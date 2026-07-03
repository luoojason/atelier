'use strict';

/* ===========================================================================
   Atelier feature module — Loop card   (app/loopcard.js)

   A canvas-native, visual scheduler: a "Loop" card you place on the board,
   configure by picking a schedule (every N minutes/hours/days, OR on chosen
   weekdays at a time) and a task prompt, and save. It becomes a real scheduler
   job (POST /jobs -> the daemon hot-reloads ~/.atelier/jobs.yaml), and a
   countdown RING fills toward the next fire and pulses when it runs. When the
   loop fires, app/jobcards.js reveals the run as a live chat card bound to it
   (whose sub-agent tree IS the workflow) — the "Loop -> Chat -> etc" flow.

   Backend contract (all existing — this card is a friendly front-end):
     GET    /jobs               -> {"jobs":[{name,schedule,prompt|builtin,
                                    next_fire,fire_after,...}], "file"}
     POST   /jobs {name,schedule,prompt,type:"prompt"}  -> upsert (400/409)
     DELETE /jobs/{name}        -> {"ok":bool}
     GET    /runs?limit=N       -> newest-last ledger lines {name,ts,status}
   Schedule strings are what scheduler/jobs_core.py accepts: an interval
   shorthand ('30m'/'2h'/'1d') or a 5-field cron ('30 9 * * 1,3'). This card
   only ever GENERATES those two shapes and stores the friendly UI state per
   board, so it never has to parse arbitrary cron back.

   Persistence mirrors app/document.js exactly (board-scoped A.store key,
   instances Map, idempotent restore, will-switch flush). The JOB itself lives
   in the daemon's jobs file; the card stores {jobName, saved, mode, every,
   unit, days, time, prompt} so it re-mounts with its config on a board switch.

   Contract: builds ONLY against window.Atelier + fetch (+ the optional
   window.atelier token bridge). Injects its own CSS. XSS rule: every
   server-derived string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store) {
    console.warn('[loopcard] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.loops';
  const CARD_W = 320;
  const CARD_H = 460;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // cron dow 0..6
  const RING_R = 30;
  const RING_C = 2 * Math.PI * RING_R;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  (function injectStyles() {
    if (document.getElementById('atl-loop-styles')) return;
    const css = `
      .atl-loop-body { padding: 0; display: flex; flex-direction: column;
        overflow-y: auto; }
      .atl-loop-inner { padding: 12px; display: flex; flex-direction: column; gap: 11px; }
      .atl-loop-row { display: flex; align-items: center; gap: 8px; }
      .atl-loop-name { flex: 1; min-width: 0; border: 1px solid var(--border);
        border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 13px;
        font-weight: 600; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-loop-name:focus { border-color: var(--accent); }
      .atl-loop-name:disabled { background: transparent; border-color: transparent;
        padding-left: 0; }
      .atl-loop-seg { display: inline-flex; border: 1px solid var(--border);
        border-radius: 9px; overflow: hidden; }
      .atl-loop-seg button { border: none; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer; }
      .atl-loop-seg button.on { background: var(--accent); color: #fff; }
      .atl-loop-lbl { font-size: 11.5px; color: var(--ink-dim); }
      .atl-loop-num { width: 56px; border: 1px solid var(--border); border-radius: 8px;
        padding: 6px 8px; font: inherit; font-size: 13px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-loop-num:focus { border-color: var(--accent); }
      .atl-loop-unit, .atl-loop-time { border: 1px solid var(--border);
        border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px;
        color: var(--ink); background: #faf7f1; outline: none; }
      .atl-loop-days { display: flex; gap: 4px; flex-wrap: wrap; }
      .atl-loop-day { width: 30px; height: 30px; border-radius: 8px;
        border: 1px solid var(--border); background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
      .atl-loop-day.on { background: var(--accent); color: #fff; border-color: var(--accent); }
      .atl-loop-prompt { min-height: 60px; resize: vertical; border: 1px solid var(--border);
        border-radius: 10px; padding: 8px 11px; font: inherit; font-size: 13px;
        color: var(--ink); background: #faf7f1; outline: none; }
      .atl-loop-prompt:focus { border-color: var(--accent); }
      .atl-loop-preview { font-size: 12px; color: var(--accent); line-height: 1.4; }
      .atl-loop-preview:empty { display: none; }
      .atl-loop-status { display: flex; align-items: center; gap: 12px; }
      .atl-loop-ring-wrap { position: relative; width: 72px; height: 72px; flex: 0 0 72px; }
      .atl-loop-ring { transform: rotate(-90deg); }
      .atl-loop-ring .track { stroke: var(--border-soft); fill: none; stroke-width: 6; }
      .atl-loop-ring .prog { stroke: var(--accent); fill: none; stroke-width: 6;
        stroke-linecap: round; transition: stroke-dashoffset 1s linear;
        stroke-dasharray: ${RING_C.toFixed(1)}; }
      .atl-loop-ring-wrap.dim .prog { stroke: var(--border); }
      .atl-loop-ring-wrap.pulse-ok .prog { stroke: var(--ok); filter: drop-shadow(0 0 6px var(--ok)); }
      .atl-loop-ring-wrap.pulse-bad .prog { stroke: var(--accent); filter: drop-shadow(0 0 6px var(--accent)); }
      .atl-loop-ctr { position: absolute; inset: 0; display: flex; align-items: center;
        justify-content: center; font-size: 12px; font-weight: 600; color: var(--ink); }
      .atl-loop-nextinfo { flex: 1; min-width: 0; font-size: 12px; color: var(--ink-dim);
        line-height: 1.4; }
      .atl-loop-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .atl-loop-save { border: none; border-radius: 9px; background: var(--accent);
        color: #fff; padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600;
        cursor: pointer; }
      .atl-loop-save:hover { background: var(--accent-2); }
      .atl-loop-save:disabled { opacity: 0.5; cursor: default; }
      .atl-loop-del { border: 1px solid var(--border); border-radius: 9px;
        background: #faf7f1; color: var(--ink-mid); padding: 7px 12px; font: inherit;
        font-size: 12px; cursor: pointer; }
      .atl-loop-del:hover { border-color: var(--accent); }
      .atl-loop-note { font-size: 11.5px; color: var(--ink-dim); line-height: 1.4; }
      .atl-loop-note.err { color: var(--accent); }
      .atl-loop-note:empty { display: none; }
    `;
    const style = el('style');
    style.id = 'atl-loop-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend helpers (guarded token, never throw on HTTP) ──────────────────
  async function api(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    let res;
    try {
      res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
    } catch {
      // backend down / network failure — NEVER throw (else save() leaves its
      // button disabled forever and the pollers raise unhandled rejections).
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // ── schedule compile + human preview (only two shapes are ever produced) ──
  function compileSchedule(s) {
    if (s.mode === 'interval') {
      // clamp so the compiled string is ALWAYS a plain integer + unit — a huge
      // value would stringify as '1e+21' and the backend interval regex rejects it
      const n = Math.min(100000, Math.max(1, parseInt(s.every, 10) || 1));
      const u = ({ minutes: 'm', hours: 'h', days: 'd' })[s.unit] || 'm';
      return n + u;
    }
    const [hh, mm] = String(s.time || '09:00').split(':');
    const h = Math.min(23, Math.max(0, parseInt(hh, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(mm, 10) || 0));
    const days = Array.isArray(s.days) ? s.days.slice().sort((a, b) => a - b) : [];
    const dow = (days.length === 0 || days.length === 7) ? '*' : days.join(',');
    return `${m} ${h} * * ${dow}`;
  }

  function previewText(s) {
    if (s.mode === 'interval') {
      const n = Math.max(1, parseInt(s.every, 10) || 1);
      const u = s.unit || 'minutes';
      return 'Runs every ' + n + ' ' + (n === 1 ? u.replace(/s$/, '') : u) + '.';
    }
    const days = Array.isArray(s.days) ? s.days.slice().sort((a, b) => a - b) : [];
    const when = (days.length === 0 || days.length === 7)
      ? 'every day'
      : 'on ' + days.map((d) => DAYS[d]).join(', ');
    return 'Runs at ' + (s.time || '09:00') + ' ' + when + '.';
  }

  // ── time formatting for the ring/next-fire label ──────────────────────────
  function fmtCountdown(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }
  // GET /jobs serves next_fire/fire_after as local ISO seconds; parse to epoch ms.
  function parseIso(v) {
    if (!v || typeof v !== 'string') return null;
    const t = Date.parse(v);
    return isFinite(t) ? t : null;
  }

  // ── one Loop card ─────────────────────────────────────────────────────────
  // id -> { id, handle, bodyEl, state, saved, pollTimer, runsTimer, tickTimer,
  //         lastRunTs, nextFire, fireAfter, ...dom refs }
  const instances = new Map();
  let restoring = false;
  let dragId = null;
  let loopSeq = 0;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const r = inst.handle.getRect();
      const s = inst.state;
      arr.push({
        id: inst.id, x: r.x, y: r.y, w: r.w, h: r.h,
        jobName: inst.saved ? s.name : '',
        name: s.name, mode: s.mode, every: s.every, unit: s.unit,
        days: s.days, time: s.time, prompt: s.prompt, saved: !!inst.saved,
      });
    });
    A.store.set(STORE_KEY, arr);
  }

  function ringWrap(inst) {
    const wrap = el('div', 'atl-loop-ring-wrap dim');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'atl-loop-ring');
    svg.setAttribute('viewBox', '0 0 72 72');
    svg.setAttribute('width', '72'); svg.setAttribute('height', '72');
    const mk = (cls) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', '36'); c.setAttribute('cy', '36');
      c.setAttribute('r', String(RING_R)); c.setAttribute('class', cls);
      return c;
    };
    const track = mk('track');
    const prog = mk('prog');
    prog.setAttribute('stroke-dashoffset', String(RING_C)); // empty until scheduled
    svg.append(track, prog);
    const ctr = el('div', 'atl-loop-ctr', '—');
    wrap.append(svg, ctr);
    inst.ringWrap = wrap; inst.ringProg = prog; inst.ringCtr = ctr;
    return wrap;
  }

  function setRing(inst, fill, label, dim) {
    inst.ringWrap.classList.toggle('dim', !!dim);
    const f = Math.max(0, Math.min(1, fill));
    inst.ringProg.setAttribute('stroke-dashoffset', String(RING_C * (1 - f)));
    inst.ringCtr.textContent = label;
  }

  function pulse(inst, ok) {
    const cls = ok ? 'pulse-ok' : 'pulse-bad';
    inst.ringWrap.classList.add(cls);
    setTimeout(() => inst.ringWrap.classList.remove(cls), 1200);
  }

  function setNote(inst, text, isErr) {
    inst.noteEl.textContent = text || '';
    inst.noteEl.classList.toggle('err', !!isErr);
  }

  function render(inst) {
    const body = inst.bodyEl;
    body.textContent = '';
    const s = inst.state;
    const wrap = el('div', 'atl-loop-inner');

    // name
    const nameRow = el('div', 'atl-loop-row');
    const nameIn = document.createElement('input');
    nameIn.className = 'atl-loop-name';
    nameIn.type = 'text';
    nameIn.placeholder = 'Loop name';
    nameIn.maxLength = 100;
    nameIn.value = s.name;
    nameIn.disabled = !!inst.saved; // name is the job key; locked once saved
    nameIn.addEventListener('input', () => { s.name = nameIn.value; persist(); });
    nameRow.appendChild(nameIn);

    // schedule mode segmented control
    const seg = el('div', 'atl-loop-seg');
    const everyBtn = el('button', s.mode === 'interval' ? 'on' : '', 'Every');
    const daysBtn = el('button', s.mode === 'weekly' ? 'on' : '', 'On days');
    everyBtn.type = 'button'; daysBtn.type = 'button';
    seg.append(everyBtn, daysBtn);

    // interval controls
    const intRow = el('div', 'atl-loop-row');
    intRow.appendChild(el('span', 'atl-loop-lbl', 'Every'));
    const numIn = document.createElement('input');
    numIn.className = 'atl-loop-num'; numIn.type = 'number'; numIn.min = '1'; numIn.max = '100000';
    numIn.value = String(s.every || 30);
    const unitSel = document.createElement('select');
    unitSel.className = 'atl-loop-unit';
    ['minutes', 'hours', 'days'].forEach((u) => {
      const o = document.createElement('option'); o.value = u; o.textContent = u;
      if (u === s.unit) o.selected = true;
      unitSel.appendChild(o);
    });
    intRow.append(numIn, unitSel);

    // weekly controls
    const wkRow = el('div', 'atl-loop-row');
    const daysWrap = el('div', 'atl-loop-days');
    const dayBtns = DAYS.map((d, i) => {
      const b = el('button', (s.days || []).includes(i) ? 'atl-loop-day on' : 'atl-loop-day', d[0]);
      b.type = 'button'; b.title = d;
      b.addEventListener('click', () => {
        const set = new Set(s.days || []);
        if (set.has(i)) set.delete(i); else set.add(i);
        s.days = Array.from(set);
        b.classList.toggle('on', set.has(i));
        refreshPreview(); persist();
      });
      return b;
    });
    dayBtns.forEach((b) => daysWrap.appendChild(b));
    const timeWrap = el('div', 'atl-loop-row');
    timeWrap.appendChild(el('span', 'atl-loop-lbl', 'at'));
    const timeIn = document.createElement('input');
    timeIn.className = 'atl-loop-time'; timeIn.type = 'time'; timeIn.value = s.time || '09:00';
    timeWrap.appendChild(timeIn);
    wkRow.append(daysWrap);

    const preview = el('div', 'atl-loop-preview');
    function refreshPreview() { preview.textContent = previewText(s); }

    function showMode() {
      const iv = s.mode === 'interval';
      everyBtn.classList.toggle('on', iv);
      daysBtn.classList.toggle('on', !iv);
      intRow.style.display = iv ? '' : 'none';
      wkRow.style.display = iv ? 'none' : '';
      timeWrap.style.display = iv ? 'none' : '';
      refreshPreview();
    }
    everyBtn.addEventListener('click', () => { s.mode = 'interval'; showMode(); persist(); });
    daysBtn.addEventListener('click', () => { s.mode = 'weekly'; showMode(); persist(); });
    numIn.addEventListener('input', () => { s.every = numIn.value; refreshPreview(); persist(); });
    unitSel.addEventListener('change', () => { s.unit = unitSel.value; refreshPreview(); persist(); });
    timeIn.addEventListener('input', () => { s.time = timeIn.value; refreshPreview(); persist(); });

    // prompt
    const prompt = document.createElement('textarea');
    prompt.className = 'atl-loop-prompt';
    prompt.placeholder = 'What should this loop do each time? e.g. "Summarize my '
      + 'unread notes and write a short digest."';
    prompt.maxLength = 8000;
    prompt.value = s.prompt || '';
    prompt.addEventListener('input', () => { s.prompt = prompt.value; persist(); });

    // status: ring + next-fire info
    const statusRow = el('div', 'atl-loop-status');
    const rw = ringWrap(inst);
    const nextInfo = el('div', 'atl-loop-nextinfo', inst.saved ? 'Saved.' : 'Not saved yet.');
    inst.nextInfoEl = nextInfo;
    statusRow.append(rw, nextInfo);

    // note + actions
    const note = el('div', 'atl-loop-note');
    inst.noteEl = note;
    const actions = el('div', 'atl-loop-actions');
    const delBtn = el('button', 'atl-loop-del', 'Delete');
    delBtn.type = 'button';
    delBtn.style.display = inst.saved ? '' : 'none';
    const saveBtn = el('button', 'atl-loop-save', inst.saved ? 'Update' : 'Save loop');
    saveBtn.type = 'button';
    actions.append(delBtn, saveBtn);

    inst.nameIn = nameIn; inst.saveBtn = saveBtn; inst.delBtn = delBtn;
    inst.promptEl = prompt;

    saveBtn.addEventListener('click', () => save(inst));
    delBtn.addEventListener('click', () => remove(inst));

    wrap.append(nameRow, seg, intRow, wkRow, timeWrap, preview,
      el('span', 'atl-loop-lbl', 'Task'), prompt, statusRow, note, actions);
    body.appendChild(wrap);
    showMode();
    if (inst.saved) startPolling(inst);
  }

  async function save(inst) {
    const s = inst.state;
    const name = (s.name || '').trim();
    if (!name) { setNote(inst, 'Give the loop a name.', true); return; }
    if (s.mode === 'weekly' && (!s.days || s.days.length === 0)) {
      setNote(inst, 'Pick at least one day (or switch to "Every").', true); return;
    }
    if (!(s.prompt || '').trim()) { setNote(inst, 'Write the task this loop runs.', true); return; }
    const schedule = compileSchedule(s);
    inst.saveBtn.disabled = true;
    setNote(inst, 'Saving…', false);
    // A NEW loop must not silently clobber a job of the same name (jobs are one
    // global namespace; POST is an upsert). Cards on other boards / a stale
    // default 'loop-N' could collide — refuse and ask to rename. An Update on
    // the card that already OWNS the name is fine (inst.saved).
    if (!inst.saved) {
      const existing = await api('/jobs', { method: 'GET' });
      if (existing.ok && existing.data && Array.isArray(existing.data.jobs)
          && existing.data.jobs.some((j) => j && j.name === name)) {
        setNote(inst, 'A loop named "' + name + '" already exists — rename this one.', true);
        inst.saveBtn.disabled = false;
        return;
      }
    }
    const r = await api('/jobs', {
      method: 'POST',
      body: JSON.stringify({ name, schedule, prompt: s.prompt, type: 'prompt' }),
    });
    inst.saveBtn.disabled = false;
    if (r.status === 0) {
      setNote(inst, 'Backend unreachable — is Atelier running?', true);
      return;
    }
    if (r.status === 409) {
      setNote(inst, 'No jobs file is configured on the backend — cannot schedule.', true);
      return;
    }
    if (!r.ok) {
      const why = (r.data && r.data.error) ? String(r.data.error) : 'save failed (HTTP ' + r.status + ')';
      setNote(inst, why, true);
      return;
    }
    inst.saved = true;
    inst.nameIn.disabled = true;
    inst.saveBtn.textContent = 'Update';
    inst.delBtn.style.display = '';
    setNote(inst, 'Saved — the scheduler will run it on schedule.', false);
    persist();
    startPolling(inst);
  }

  async function remove(inst) {
    const name = (inst.state.name || '').trim();
    if (name) await api('/jobs/' + encodeURIComponent(name), { method: 'DELETE' });
    // remove the card entirely (its card:removed handler stops timers + persists)
    if (inst.handle && inst.handle.remove) inst.handle.remove();
  }

  // ── live polling: countdown ring + fire pulse (mirrors schedring cadence) ──
  function stopPolling(inst) {
    clearInterval(inst.pollTimer); clearInterval(inst.runsTimer); clearInterval(inst.tickTimer);
    inst.pollTimer = inst.runsTimer = inst.tickTimer = null;
  }

  async function refreshJob(inst) {
    const r = await api('/jobs', { method: 'GET' });
    if (!r.ok || !r.data || !Array.isArray(r.data.jobs)) return;
    const job = r.data.jobs.find((j) => j && j.name === inst.state.name);
    if (!job) { inst.nextFire = inst.fireAfter = null; return; }
    inst.nextFire = parseIso(job.next_fire);
    inst.fireAfter = parseIso(job.fire_after);
  }

  async function checkRuns(inst) {
    const r = await api('/runs?limit=10', { method: 'GET' });
    if (!r.ok || !r.data || !Array.isArray(r.data.runs)) return;
    const mine = r.data.runs.filter((x) => x && x.name === inst.state.name && x.ts);
    const newest = mine.length ? mine[mine.length - 1] : null; // ledger newest-last
    if (!inst.primed) {
      // prime on the FIRST completed poll, EVEN with an empty ledger — else a
      // brand-new loop's very first fire is swallowed as the seed and only the
      // second fire pulses (mirrors widget-ring.js's primed flag).
      inst.primed = true;
      inst.lastRunTs = newest ? newest.ts : null;
      return;
    }
    if (newest && newest.ts !== inst.lastRunTs) {
      inst.lastRunTs = newest.ts;
      pulse(inst, newest.status === 'ok');
      refreshJob(inst); // re-arm the ring toward the fresh next fire
    }
  }

  function tick(inst) {
    if (!inst.nextFire) { setRing(inst, 0, '—', true); if (inst.nextInfoEl) inst.nextInfoEl.textContent = 'Unscheduled.'; return; }
    const now = Date.now();
    const remaining = inst.nextFire - now;
    let fill = 0;
    if (inst.fireAfter && inst.fireAfter > inst.nextFire) {
      const period = inst.fireAfter - inst.nextFire;
      fill = 1 - Math.max(0, remaining) / period;
    } else {
      fill = remaining <= 0 ? 1 : 0.05; // no window known: show a small primed arc
    }
    setRing(inst, fill, fmtCountdown(remaining), false);
    if (inst.nextInfoEl) inst.nextInfoEl.textContent = remaining <= 0
      ? 'Running now…'
      : 'Next run in ' + fmtCountdown(remaining) + '.';
  }

  function startPolling(inst) {
    stopPolling(inst);
    refreshJob(inst).then(() => tick(inst));
    checkRuns(inst);
    inst.pollTimer = setInterval(() => refreshJob(inst), 30000);
    inst.runsTimer = setInterval(() => checkRuns(inst), 15000);
    inst.tickTimer = setInterval(() => tick(inst), 1000);
  }

  function spawnLoop(opts = {}) {
    const id = opts.id || ('loop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const state = {
      name: opts.name || ('loop-' + (++loopSeq)),
      mode: opts.mode || 'interval',
      every: opts.every != null ? opts.every : 30,
      unit: opts.unit || 'minutes',
      days: Array.isArray(opts.days) ? opts.days : [1, 2, 3, 4, 5],
      time: opts.time || '09:00',
      prompt: typeof opts.prompt === 'string' ? opts.prompt : '',
    };

    const card = el('section', 'card app-card atl-loop-card');
    card.dataset.loopInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'), el('span', 'card-title', 'Loop'), el('span', 'card-x', '×'));
    const body = el('div', 'app-body atl-loop-body');
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
    const inst = { id, handle, bodyEl: body, state, saved: !!opts.saved,
      pollTimer: null, runsTimer: null, tickTimer: null, lastRunTs: null,
      primed: false, nextFire: null, fireAfter: null };
    instances.set(id, inst);

    card.addEventListener('mousedown', () => { dragId = id; }, true);
    render(inst);
    if (!restoring) persist();
    return inst;
  }

  window.addEventListener('mouseup', () => {
    if (dragId && instances.has(dragId)) persist();
    dragId = null;
  });
  A.bus.on('cards:rearranged', () => persist());

  A.bus.on('card:removed', (d) => {
    const node = d && d.el;
    const rid = node && node.dataset && node.dataset.loopInstance;
    if (!rid || !instances.has(rid)) return;
    const inst = instances.get(rid);
    stopPolling(inst);
    instances.delete(rid);
    persist();
  });

  function restoreFromStore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    restoring = true;
    try {
      // seed loopSeq past any restored 'loop-N' default so a fresh loop never
      // reuses a live default name (which would collide on save)
      saved.forEach((rec) => {
        const m = /^loop-(\d+)$/.exec((rec && rec.name) || '');
        if (m) loopSeq = Math.max(loopSeq, parseInt(m[1], 10));
      });
      saved.forEach((rec) => {
        if (!rec || !rec.id || instances.has(rec.id)) return;
        spawnLoop({
          id: String(rec.id),
          rect: { x: Number(rec.x) || 0, y: Number(rec.y) || 0,
            w: Number(rec.w) || CARD_W, h: Number(rec.h) || CARD_H },
          name: rec.name, mode: rec.mode, every: rec.every, unit: rec.unit,
          days: rec.days, time: rec.time, prompt: rec.prompt, saved: !!rec.saved,
        });
      });
    } finally {
      restoring = false;
    }
  }
  restoreFromStore();

  A.bus.on('boards:switched', () => {
    instances.forEach((inst, id) => {
      if (inst.handle && inst.handle.el && inst.handle.el.isConnected) return;
      stopPolling(inst);
      instances.delete(id);
    });
    restoreFromStore();
  });

  A.registerApp('loop', {
    label: 'Loop',
    icon: '↻',
    create(worldPos) {
      const inst = spawnLoop(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  window.AtelierLoops = { spawn: spawnLoop, instances, STORE_KEY };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('loop');
    console.assert(registered, '[loopcard] loop app type not registered');
    console.assert(compileSchedule({ mode: 'interval', every: '30', unit: 'minutes' }) === '30m',
      '[loopcard] interval compile wrong');
    console.assert(compileSchedule({ mode: 'weekly', time: '09:30', days: [1, 3] }) === '30 9 * * 1,3',
      '[loopcard] weekly compile wrong');
    console.assert(compileSchedule({ mode: 'weekly', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }) === '0 7 * * *',
      '[loopcard] all-days should compile to daily');
    if (registered) console.log('[loopcard] ready — Loop card registered (⌘K → Add app: Loop).');
  })();
})();
