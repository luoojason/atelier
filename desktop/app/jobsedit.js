'use strict';

/* ===========================================================================
   Atelier feature module — workflow editor card   (app/jobsedit.js)

   A list/edit/create card over the scheduler's jobs file. Registers the
   'jobs' app type ('Workflows') via Atelier.registerApp.

   BACKLOG NOTE: this card completes the 'Workflow cards (card + hub +
   monitor)' backlog row — the list state is the hub, the editor state is the
   step add/edit surface, and the pre-existing workflow/calendar cards remain
   the monitor.

   Backend contract (lite_server.py, Builder A this round):
     GET    /jobs               -> {"jobs":[{name,schedule,prompt|builtin,
                                    next_fire,fire_after,...}],"file","error"?}
                                   (never 500; next_fire/fire_after are ISO
                                   local seconds or null)
     POST   /jobs               -> upsert by name; body {"name","schedule",
                                    "prompt","type":"prompt"|"builtin:digest"}
                                   400 {"error": reason} on validation failure,
                                   409 {"error":"no user jobs file configured"}
                                   when SWARM_JOBS_FILE is unset (repo fallback
                                   is never written). Token-gated.
     DELETE /jobs/{name}        -> {"ok": bool}; unknown name -> ok:false.
                                   Token-gated.

   Schedule strings are what scheduler/jobs_core.py accepts: an interval
   shorthand ('30s'/'30m'/'2h'/'1d') or a 5/6-field cron string ('0 9 * * *').
   The server validates with the SAME rules the scheduler uses, so its 400
   text is authoritative — we render it inline verbatim (textContent) instead
   of duplicating the validation client-side.

   Two stacked states inside one card (w 460 h 420, warm-cream idiom):
     1. Job list  — GET /jobs on spawn/Refresh/post-write; one two-line row
                    per job: name + Edit + Delete buttons on top, schedule ·
                    type · human next_fire underneath. 'New job' button.
     2. Form      — name (locked when editing), schedule (text), type select
                    (prompt / builtin:digest; the prompt textarea hides for
                    builtin), prompt textarea, Save + Cancel. Server 400/409
                    error text renders inline under the form.

   Delete uses a two-click arm pattern (the button turns into 'Really
   delete?' for 3s, then disarms) — window.confirm is banned in Electron per
   the alerts rule. After any successful write (save or delete) the list is
   refreshed and the note line reads 'saved — the scheduler picks this up
   within ~30s' (the daemon's hot-reload cadence, Builder B this round).

   Editing scope: the form round-trips name/schedule/type/prompt only. The
   server upserts the job as POSTed, so extra yaml keys on the EDITED job
   (agent/endpoint/catch_up) follow the server's upsert semantics; unknown
   keys on OTHER jobs are preserved server-side per the round-17 contract.

   XSS rule: every server-derived string (names, schedules, prompts, error
   messages) only ever enters the DOM via textContent.

   Stale-response guard: navigation bumps a sequence counter and every async
   render re-checks it (same discipline as versions.js), so a slow response
   for a view the user already left — or a closed card — never lands.

   Reachability: no dock button — the card spawns from the ⌘K palette
   ("Add app: Workflows") or Atelier.spawnApp('jobs'). Verified the same way
   versions/runlog did: palette.js buildCommands() iterates A.apps at open()
   time, so registerApp alone puts this module in the palette.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Loads after core.js (orchestrator owns the index.html script tag).

   ponytail: jobs cards are not persisted (board switch removes them via
   removeAllCards -> card:removed, same as versions/runlog). No polling — the
   list refreshes on spawn, Refresh, and after writes; the schedring widget is
   the live monitor. Client-side schedule preview and a cron helper are the
   upgrades.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend with a writable jobs file
      (SWARM_JOBS_FILE=/tmp/jobs.yaml PORT=8765 .venv-ext/bin/python
      lite_server.py) and `npm start` in desktop/ — or open index.html in a
      plain browser.
   2. ⌘K → "workflows" → "Add app: Workflows" → a warm-cream 460x420 card
      spawns and GET /jobs fires once (Network tab; no polling after).
   3. Fresh file (no jobs) → empty state reads 'No scheduled jobs yet — click
      New job to create one.'
   4. New job → form: name, schedule, type select, prompt textarea. Pick
      type 'builtin:digest' → the prompt row hides; back to 'prompt' → shows.
   5. Save with schedule "junk" → the server's 400 reason renders inline
      under the form (literal text, no HTML), the form stays editable.
   6. Save name=t1 schedule=30m prompt=hello → POST /jobs (X-Atelier-Token
      under Electron) → the list re-renders with t1 (schedule · type · human
      next fire) and the note reads 'saved — the scheduler picks this up
      within ~30s'.
   7. Edit t1 → the name input is disabled; change the schedule to
      '0 9 * * *', Save → list shows the new schedule.
   8. Delete t1 → the button reads 'Really delete?' (warn color); wait 3s →
      it disarms back to 'Delete'; click twice quickly → DELETE /jobs/t1 →
      the row is gone, saved-note shown.
   9. Without SWARM_JOBS_FILE (repo fallback) → Save answers 409 and the
      message 'no user jobs file configured' renders inline.
  10. Stop the backend → Refresh shows 'Backend unreachable — click Refresh
      to retry.'; Save/Delete show a not-saved note; no crash, no console
      spam. Restart + Refresh → the list loads.
  11. Close the card (×) or switch boards mid-fetch → no errors (stale
      responses dropped, arm timers cleared). Console shows
      "[jobsedit] self-check passed".
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[jobsedit] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const CARD_W = 460;
  const CARD_H = 420;
  const ARM_MS = 3000; // two-click delete arm window
  const TYPES = ['prompt', 'builtin:digest']; // mirrors jobs_core BUILTIN_JOBS

  // ── injected styles (list + form inside the standard warm-cream card) ─────
  (function injectStyles() {
    if (document.getElementById('atl-jobsedit-styles')) return;
    const css = `
      .atl-jobs-body { padding: 0; display: flex; flex-direction: column; }
      .atl-jobs-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-dim); }
      .atl-jobs-crumb { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: var(--ink-mid); }
      .atl-jobs-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-jobs-btn:hover { border-color: var(--accent); }
      .atl-jobs-btn:disabled { opacity: 0.5; cursor: default; }
      .atl-jobs-btn.atl-jobs-armed { color: #fff; background: #b04a3a;
        border-color: #b04a3a; }
      .atl-jobs-note { font-size: 11px; color: var(--ink-dim);
        padding: 3px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-jobs-note:empty { display: none; }
      .atl-jobs-list { flex: 1; overflow: auto; }
      .atl-jobs-row { padding: 7px 10px;
        border-bottom: 1px solid var(--border-soft); }
      .atl-jobs-row-top { display: flex; align-items: center; gap: 8px; }
      .atl-jobs-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 12px; color: var(--ink); }
      .atl-jobs-row-sub { display: flex; gap: 6px; margin-top: 2px;
        font-size: 11px; color: var(--ink-dim); overflow: hidden;
        white-space: nowrap; }
      .atl-jobs-sched { font-family: ui-monospace, SFMono-Regular, Menlo,
        monospace; color: var(--ink-mid); }
      .atl-jobs-empty { padding: 16px 14px; font-size: 12px;
        color: var(--ink-dim); line-height: 1.5; }
      .atl-jobs-form { flex: 1; overflow: auto; padding: 10px 12px;
        display: flex; flex-direction: column; gap: 8px; }
      .atl-jobs-field { display: flex; flex-direction: column; gap: 3px; }
      .atl-jobs-label { font-size: 11px; color: var(--ink-dim); }
      .atl-jobs-input, .atl-jobs-select, .atl-jobs-area {
        border: 1px solid var(--border); border-radius: 7px;
        background: #fbf8f2; color: var(--ink); font: inherit;
        font-size: 12px; padding: 5px 8px; }
      .atl-jobs-input:disabled { opacity: 0.6; }
      .atl-jobs-input:focus, .atl-jobs-select:focus, .atl-jobs-area:focus {
        outline: none; border-color: var(--accent); }
      .atl-jobs-area { resize: vertical; min-height: 72px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px; line-height: 1.5; }
      .atl-jobs-err { font-size: 11px; color: #b04a3a; line-height: 1.4;
        white-space: pre-wrap; word-break: break-word; }
      .atl-jobs-err:empty { display: none; }
      .atl-jobs-actions { display: flex; gap: 8px; margin-top: 2px; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-jobsedit-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend helper: fetch JSON, never throw on HTTP errors (only network) ─
  // Mutating routes require the shared-secret header when the backend was
  // launched by main.js (window.atelier.token via preload); in a plain
  // browser the bridge is absent and a hand-run backend has no token to
  // enforce. Same idiom as versions.js/sessions.js.
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const init = Object.assign({ headers }, opts || {});
    const res = await fetch(BASE + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // Human next-fire: server sends ISO local seconds ("2026-07-02T09:00:00")
  // or null. new Date() on an offset-less ISO string parses as LOCAL time per
  // spec, which matches how the server computed it.
  function fmtNext(iso) {
    if (iso === undefined) return ''; // field absent (older backend) — say nothing
    if (!iso) return 'unscheduled';
    const t = new Date(String(iso)).getTime();
    if (!isFinite(t)) return String(iso); // unparsable — show the raw string
    const secs = Math.round((t - Date.now()) / 1000);
    if (secs <= 0) return 'due now';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return 'next in ' + d + 'd ' + h + 'h';
    if (h > 0) return 'next in ' + h + 'h ' + m + 'm';
    if (m > 0) return 'next in ' + m + 'm';
    return 'next in <1m';
  }

  // A stored job carries exactly one of prompt|builtin (jobs_core.validate_job).
  function jobTypeOf(job) {
    return job && job.builtin ? 'builtin:' + String(job.builtin) : 'prompt';
  }

  // ── one workflows card ─────────────────────────────────────────────────────
  function createJobsCard(worldPos) {
    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = document.createElement('section');
    card.className = 'card app-card atl-jobs-card';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = 'Workflows';
    const closeX = document.createElement('span');
    closeX.className = 'card-x';
    closeX.textContent = '×';
    bar.append(dot, title, closeX);

    const body = document.createElement('div');
    body.className = 'app-body atl-jobs-body';
    const head = document.createElement('div');
    head.className = 'atl-jobs-head';
    const backBtn = document.createElement('button');
    backBtn.className = 'atl-jobs-btn';
    backBtn.textContent = '← Back';
    backBtn.hidden = true; // the list is the root state
    const crumb = document.createElement('span');
    crumb.className = 'atl-jobs-crumb';
    crumb.textContent = 'Scheduled jobs';
    const newBtn = document.createElement('button');
    newBtn.className = 'atl-jobs-btn';
    newBtn.textContent = 'New job';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'atl-jobs-btn';
    refreshBtn.textContent = 'Refresh';
    head.append(backBtn, crumb, newBtn, refreshBtn);
    const note = document.createElement('div');
    note.className = 'atl-jobs-note';
    const content = document.createElement('div');
    content.className = 'atl-jobs-list';
    body.append(head, note, content);
    card.append(bar, body);

    // state
    let closed = false;
    let seq = 0; // bumped per navigation; stale fetch results are dropped
    let cur = { view: 'list' }; // {view:'list'} | {view:'form', mode, job}
    const armTimers = new Set(); // pending delete-disarm timeouts

    function setNote(text) { note.textContent = text || ''; }

    function clearContent() {
      content.textContent = '';
      content.scrollTop = 0;
    }

    function clearArmTimers() {
      armTimers.forEach((id) => clearTimeout(id));
      armTimers.clear();
    }

    function emptyRow(text) {
      const div = document.createElement('div');
      div.className = 'atl-jobs-empty';
      div.textContent = text;
      return div;
    }

    // ── state 1: job list (the hub) ──────────────────────────────────────────
    // `notice` (optional) is shown AFTER a successful reload — the post-write
    // confirmation survives the refresh instead of being wiped by it.
    async function showList(notice) {
      cur = { view: 'list' };
      const my = ++seq;
      backBtn.hidden = true;
      newBtn.hidden = false;
      refreshBtn.hidden = false;
      crumb.textContent = 'Scheduled jobs';
      setNote('');
      clearArmTimers();
      clearContent();
      let jobs = null;
      let fileErr = '';
      try {
        const { ok, data } = await apiJson('/jobs');
        if (ok && data && Array.isArray(data.jobs)) {
          jobs = data.jobs;
          if (data.error) fileErr = String(data.error); // malformed jobs file
        }
      } catch { /* backend unreachable — handled below */ }
      if (closed || my !== seq) return; // user navigated away / card closed
      if (jobs === null) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      setNote(notice || fileErr); // server strings: textContent only (setNote)
      if (jobs.length === 0) {
        content.appendChild(emptyRow(fileErr
          ? 'No loadable jobs — fix the jobs file or create one here.'
          : 'No scheduled jobs yet — click New job to create one.'));
        return;
      }
      for (const job of jobs) {
        if (!job || typeof job !== 'object') continue;
        content.appendChild(jobRow(job));
      }
    }

    function jobRow(job) {
      const name = String(job.name || '');
      const row = document.createElement('div');
      row.className = 'atl-jobs-row';

      const top = document.createElement('div');
      top.className = 'atl-jobs-row-top';
      const nameEl = document.createElement('span');
      nameEl.className = 'atl-jobs-row-name';
      nameEl.textContent = name; // server strings: textContent only
      nameEl.title = name;
      const editBtn = document.createElement('button');
      editBtn.className = 'atl-jobs-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => showForm('edit', job));
      const delBtn = document.createElement('button');
      delBtn.className = 'atl-jobs-btn';
      delBtn.textContent = 'Delete';
      wireDelete(delBtn, name);
      top.append(nameEl, editBtn, delBtn);

      const sub = document.createElement('div');
      sub.className = 'atl-jobs-row-sub';
      const sched = document.createElement('span');
      sched.className = 'atl-jobs-sched';
      sched.textContent = String(job.schedule || '');
      const type = document.createElement('span');
      type.textContent = '· ' + jobTypeOf(job);
      const next = document.createElement('span');
      const nextText = fmtNext(job.next_fire);
      next.textContent = nextText ? '· ' + nextText : '';
      sub.append(sched, type, next);

      row.append(top, sub);
      return row;
    }

    // Two-click arm pattern (window.confirm is banned in Electron per the
    // alerts rule): first click arms the button ('Really delete?', warn
    // color) for ARM_MS, second click inside the window performs the DELETE.
    function wireDelete(btn, name) {
      let armed = false;
      let timer = null;
      const disarm = () => {
        armed = false;
        btn.textContent = 'Delete';
        btn.classList.remove('atl-jobs-armed');
      };
      btn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          btn.textContent = 'Really delete?';
          btn.classList.add('atl-jobs-armed');
          timer = setTimeout(() => {
            disarm();
            armTimers.delete(timer);
          }, ARM_MS);
          armTimers.add(timer);
          return;
        }
        clearTimeout(timer);
        armTimers.delete(timer);
        btn.disabled = true;
        let res = null;
        try {
          res = await apiJson('/jobs/' + encodeURIComponent(name), { method: 'DELETE' });
        } catch { /* backend unreachable — res stays null */ }
        if (closed) return;
        if (res && res.ok && res.data && res.data.ok) {
          showList('saved — the scheduler picks this up within ~30s');
        } else if (res === null) {
          // failure paths DISARM: the armed red button must not linger as a
          // one-click live trigger the user can misread minutes later
          setNote('Backend unreachable — job not deleted.');
          disarm();
          btn.disabled = false;
        } else {
          // unknown name (ok:false) or a token/HTTP failure — refresh shows truth
          const msg = res.data && res.data.error ? String(res.data.error)
            : 'Delete failed — the job may already be gone. Refresh to re-sync.';
          setNote(msg);
          disarm();
          btn.disabled = false;
        }
      });
    }

    // ── state 2: form (new / edit — the step add/edit surface) ──────────────
    function showForm(mode, job) {
      cur = { view: 'form', mode, job };
      ++seq; // any in-flight list render is now stale
      backBtn.hidden = false;
      newBtn.hidden = true;
      refreshBtn.hidden = true;
      crumb.textContent = mode === 'edit' ? 'Edit: ' + String(job.name || '') : 'New job';
      setNote('');
      clearArmTimers();
      clearContent();

      const form = document.createElement('div');
      form.className = 'atl-jobs-form';

      function field(labelText, control) {
        const wrap = document.createElement('div');
        wrap.className = 'atl-jobs-field';
        const label = document.createElement('span');
        label.className = 'atl-jobs-label';
        label.textContent = labelText;
        wrap.append(label, control);
        return wrap;
      }

      const nameIn = document.createElement('input');
      nameIn.className = 'atl-jobs-input';
      nameIn.type = 'text';
      nameIn.placeholder = 'morning-standup';
      if (mode === 'edit') {
        nameIn.value = String(job.name || '');
        nameIn.disabled = true; // the name is the upsert key — locked when editing
      }

      const schedIn = document.createElement('input');
      schedIn.className = 'atl-jobs-input';
      schedIn.type = 'text';
      // the two formats jobs_core accepts: interval shorthand or 5/6-field cron
      schedIn.placeholder = "30m  or  0 9 * * *";
      if (mode === 'edit') schedIn.value = String(job.schedule || '');

      const typeSel = document.createElement('select');
      typeSel.className = 'atl-jobs-select';
      const curType = mode === 'edit' ? jobTypeOf(job) : 'prompt';
      const options = TYPES.includes(curType) ? TYPES : TYPES.concat([curType]);
      for (const t of options) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        typeSel.appendChild(opt);
      }
      typeSel.value = curType;

      const promptArea = document.createElement('textarea');
      promptArea.className = 'atl-jobs-area';
      promptArea.placeholder = 'What should run each time…';
      if (mode === 'edit') promptArea.value = String(job.prompt || '');
      const promptField = field('Prompt', promptArea);

      function syncTypeVisibility() {
        // prompt textarea is meaningless for a builtin — hide it
        promptField.hidden = typeSel.value !== 'prompt';
      }
      typeSel.addEventListener('change', syncTypeVisibility);
      syncTypeVisibility();

      const err = document.createElement('div');
      err.className = 'atl-jobs-err';

      const actions = document.createElement('div');
      actions.className = 'atl-jobs-actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'atl-jobs-btn';
      saveBtn.textContent = 'Save';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'atl-jobs-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => showList());
      actions.append(saveBtn, cancelBtn);

      form.append(
        field('Name', nameIn),
        field('Schedule (interval like 30m, or cron like 0 9 * * *)', schedIn),
        field('Type', typeSel),
        promptField,
        err,
        actions,
      );
      content.appendChild(form);
      if (mode !== 'edit') nameIn.focus();

      saveBtn.addEventListener('click', async () => {
        err.textContent = '';
        // This form's generation: showList AND showForm both bump seq, so a
        // slow save resolving after the user opened a DIFFERENT form must
        // not showList over it (checking only cur.view would let it).
        const my = seq;
        const payload = {
          name: nameIn.value.trim(),
          schedule: schedIn.value.trim(),
          type: typeSel.value,
        };
        // POST shape per the round-17 contract; prompt only rides along for
        // type "prompt" (the server requires it there, rejects it elsewhere)
        if (typeSel.value === 'prompt') payload.prompt = promptArea.value;
        saveBtn.disabled = true; // one save at a time
        let res = null;
        try {
          res = await apiJson('/jobs', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        } catch { /* backend unreachable — res stays null */ }
        if (closed) return;
        if (cur.view !== 'form' || my !== seq) return; // navigated away mid-POST
        if (res && res.ok) {
          showList('saved — the scheduler picks this up within ~30s');
          return;
        }
        saveBtn.disabled = false;
        if (res === null) {
          err.textContent = "Can't reach Atelier. Not saved.";
          return;
        }
        // 400 validation / 409 no-user-jobs-file / 403 token — the server's
        // human-readable reason renders inline, textContent only
        err.textContent = res.data && res.data.error
          ? String(res.data.error)
          : 'Save failed (HTTP ' + res.status + ').';
      });
    }

    // ── navigation wiring ────────────────────────────────────────────────────
    backBtn.addEventListener('click', () => showList());
    newBtn.addEventListener('click', () => showForm('new', null));
    refreshBtn.addEventListener('click', () => {
      if (cur.view === 'list') showList();
    });

    // place the card (spawnApp passes a world pos; fall back to canvas center)
    let pos = worldPos;
    if (!pos) {
      const canvasEl = document.getElementById('canvas');
      const rct = canvasEl.getBoundingClientRect();
      pos = A.canvas.screenToWorld(rct.left + rct.width / 2, rct.top + rct.height / 2);
      pos = { x: pos.x - CARD_W / 2, y: pos.y - CARD_H / 2 };
    }
    const handle = A.canvas.addCard(card, { x: pos.x, y: pos.y, w: CARD_W, h: CARD_H });

    // card closed (×, Delete key, board switch's removeAllCards) → drop any
    // in-flight render and clear the delete-arm timers (the only timers here)
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      clearArmTimers();
      off();
    });

    showList(); // first fetch now; everything after is click/write-driven
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('jobs', {
    label: 'Workflows',
    icon: '↺',
    create(worldPos) { return createJobsCard(worldPos); },
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('jobs');
    console.assert(registered, '[jobsedit] jobs app type not registered');
    const styles = !!document.getElementById('atl-jobsedit-styles');
    console.assert(styles, '[jobsedit] styles not injected');
    if (registered && styles) {
      console.log('[jobsedit] self-check passed — jobs app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
