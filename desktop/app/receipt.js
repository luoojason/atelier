'use strict';

/* ===========================================================================
   Atelier feature module — agent-run receipt card   (app/receipt.js)

   A plain-language RECEIPT for a single agent run: what it did (its steps and
   the delegation events), the sources it consulted (the pages it opened, as
   links), the files it produced (the note/document deliverables it wrote),
   when it ran and for how long, and an honest Undo where one exists. The frame
   is trust: "here is exactly what happened, and here are the receipts."

   Registers the 'receipt' app type via Atelier.registerApp (so it shows up in
   the ⌘K palette as "Add app: Receipt") and exposes window.AtelierReceipt.open
   (sessionId) so a per-agent affordance can open a run's receipt directly. A
   small "receipt" button is also injected into every agent card's title bar
   (card:added), resolving that card's session id from its dataset stamp.

   Backend contract (lite_server.py, existing routes, no new backend needed for
   the MVP):
     GET  /sessions            -> {"sessions":[{id,name,status,messages_len,
                                    parent_id,depth,job_name}]}  (the run picker)
     GET  /sessions/{id}       -> {id,name,status,messages:[{role,text,ts}],
                                    parent_id,depth,model,job_name,browser_nav,
                                    browser_read,browser_act,canvas_ops}
                                   404 {"error":"unknown session"} if evicted.
     DELETE /sessions/{id}     -> {"ok":true}   (the Undo = "delete this run";
                                    token-gated when main.js launched the backend)

   What each field becomes on the receipt:
     • messages  → the STEPS. role "user"/"assistant" are the turns; role "note"
       is an orchestration event (delegation / job fired) — the only visible
       record of SpawnAgent / DelegateToSubagent. ts is a real ISO wall-clock
       stamp (datetime.isoformat), so first→last ts gives honest timing.
     • canvas_ops kind:"browser" {url}   → SOURCES: a page the agent opened.
     • canvas_ops kind:"note"/"document" {title,content} → FILES it produced.
     • browser_nav {url}                 → the last page it navigated to.

   HONEST GAP (surfaced in the UI, not hidden): the backend discards every
   ToolUseBlock, so WebSearch queries and WebFetch URLs are NOT recorded on the
   session. This receipt therefore shows the pages the agent OPENED as browser
   cards (+ the last navigation), and says so plainly — it does not claim to
   list every web source. A durable per-session tool-activity log on
   GET /sessions/{id} would let this section show real search/fetch sources.

   UNDO is scoped honestly to "Delete this run" (DELETE /sessions/{id}): it ends
   the conversation but does not un-spawn the canvas cards the run produced (no
   op→card DOM mapping exists), so the button says exactly that. A richer undo
   would need backend support (a stable op/card id, or POST .../undo).

   XSS rule: every server-derived string (names, message text, titles, content,
   urls) only ever enters the DOM via textContent. URLs become clickable <a>
   ONLY when they parse as http/https; anything else renders as plain text, so
   a javascript:/data: URL can never become a live link.

   Poll: a still-running run is polled every 1.5s (chained setTimeout, so slow
   responses never stack) until status !== "running"; a finished run is read
   once. Polling stops on card:removed. Injects its own CSS. Builds ONLY against
   window.Atelier + fetch + the guarded window.atelier token bridge. Loads after
   core.js and sessions.js (the orchestrator owns the index.html script tag).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 python lite_server.py) and `npm start`.
   2. ⌘K → "receipt" → "Add app: Receipt" → a warm-cream card spawns showing a
      PICKER: one row per run from GET /sessions (name + status + step count).
   3. Spawn a chat agent, give it a task; a small "receipt" button appears in
      its title bar. Click it → the card jumps straight to that run's receipt.
   4. The receipt shows: a status chip + model + timing header; a STEPS list
      (your prompt, the agent's replies, and any "→ Delegated…" note events); a
      SOURCES list of pages it opened (as links) with the honest footnote; a
      FILES list of the note/document cards it wrote (click a file to expand its
      text); and a "Delete this run" action.
   5. Have the agent OpenBrowser(url) and CreateCard('note',…) → within ~1.5s
      those appear under Sources and Files (the run is polled while running).
   6. Click "Delete this run" → inline confirm → DELETE fires, the picker
      reloads and the run is gone. (Its spawned cards remain — the button says
      so.) window.AtelierReceipt.open('<id>') opens any run by id from console.
   7. Stop the backend → a quiet "Backend unreachable" note; the card stays
      usable. Restart → Refresh reloads. Close the card (×) or switch boards →
      polling stops, no console errors. Console: "[receipt] self-check passed".
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[receipt] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 1500;   // cadence while a run is still "running"
  const CARD_W = 460;
  const CARD_H = 460;

  // ── guarded backend helper (token header on mutations; never throws) ───────
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
      let data = null;
      try { data = await res.json(); } catch { /* empty / non-JSON body */ }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  // ── tiny DOM helper (same idiom as the sibling modules) ────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A URL becomes a live link ONLY if it parses as http/https; otherwise it is
  // rendered as plain, selectable text so no javascript:/data: URL can ever
  // become a clickable link. Server text always enters via textContent.
  function makeLink(url) {
    const raw = String(url || '');
    let ok = false;
    try {
      const u = new URL(raw);
      ok = (u.protocol === 'http:' || u.protocol === 'https:');
    } catch { ok = false; }
    if (!ok) {
      const span = el('span', 'atl-rcpt-src-txt');
      span.textContent = raw;
      return span;
    }
    const a = el('a', 'atl-rcpt-src-link');
    a.textContent = raw;                 // display text: never innerHTML
    a.setAttribute('href', raw);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
    a.title = raw;
    return a;
  }

  // Parse the backend ISO stamp; returns a Date or null (never throws).
  function parseTs(ts) {
    if (!ts) return null;
    const d = new Date(String(ts));
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtClock(d) {
    if (!d) return '—';
    try { return d.toLocaleString(); } catch { return String(d); }
  }

  // Human duration between two Dates: "12s", "3m 4s", "1h 2m".
  function fmtDuration(a, b) {
    if (!a || !b) return '—';
    let s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60); s -= m * 60;
    if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
    const h = Math.floor(m / 60);
    return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }

  function firstLine(text) {
    const s = String(text || '');
    const nl = s.indexOf('\n');
    return (nl === -1 ? s : s.slice(0, nl)).trim();
  }

  // ── injected styles (reuses styles.css design tokens; warm-cream card) ─────
  (function injectStyles() {
    if (document.getElementById('atl-receipt-styles')) return;
    const css = `
      .atl-rcpt-body { padding: 0; display: flex; flex-direction: column; }
      .atl-rcpt-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-dim); }
      .atl-rcpt-back { flex: 0 0 auto; border: none; background: transparent;
        color: var(--ink-mid); font: inherit; font-size: 11px; cursor: pointer;
        padding: 2px 4px; border-radius: 6px; }
      .atl-rcpt-back:hover { color: var(--accent); }
      .atl-rcpt-crumb { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: var(--ink-mid); }
      .atl-rcpt-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-rcpt-btn:hover { border-color: var(--accent); }
      .atl-rcpt-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .atl-rcpt-note { font-size: 11px; color: var(--ink-dim);
        padding: 3px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-rcpt-note:empty { display: none; }
      .atl-rcpt-scroll { flex: 1; overflow: auto; }

      /* picker */
      .atl-rcpt-pick-row { display: flex; align-items: baseline; gap: 8px;
        padding: 8px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 12px; color: var(--ink-mid); cursor: pointer; }
      .atl-rcpt-pick-row:hover { background: #f6f1e7; }
      .atl-rcpt-pick-row:focus-visible { outline: 2px solid var(--accent);
        outline-offset: -2px; }
      .atl-rcpt-pick-name { flex: 1; font-weight: 600; color: var(--ink);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-rcpt-pick-meta { flex: 0 0 auto; font-size: 10px; color: var(--ink-dim); }
      .atl-rcpt-empty { padding: 16px 14px; font-size: 12px; color: var(--ink-dim);
        line-height: 1.5; }

      /* receipt */
      .atl-rcpt-tagline { padding: 9px 12px 10px; border-bottom: 1px solid var(--border-soft);
        background: #fbf8f2; }
      .atl-rcpt-tagline .t { font-size: 13px; font-weight: 700; color: var(--ink); }
      .atl-rcpt-tagline .s { display: block; margin-top: 2px; font-size: 11px;
        color: var(--ink-dim); line-height: 1.4; }
      .atl-rcpt-facts { display: flex; flex-wrap: wrap; gap: 6px 14px;
        padding: 9px 12px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-mid); }
      .atl-rcpt-fact { display: flex; gap: 5px; }
      .atl-rcpt-fact .k { color: var(--ink-dim); }
      .atl-rcpt-fact .v { color: var(--ink); font-weight: 600; }
      .atl-rcpt-chip { display: inline-block; font-size: 10px; line-height: 1;
        padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border);
        color: var(--ink-dim); background: #faf7f1; }
      .atl-rcpt-chip.running { border-color: var(--accent); color: var(--accent); }
      .atl-rcpt-chip.error { border-color: #c05545; color: #c05545; }
      .atl-rcpt-chip.idle { border-color: var(--border); color: var(--ink-mid); }

      .atl-rcpt-sec { border-bottom: 1px solid var(--border-soft); }
      .atl-rcpt-sec-h { display: flex; align-items: baseline; gap: 7px;
        padding: 8px 12px 4px; font-size: 11px; font-weight: 700;
        color: var(--ink); text-transform: uppercase; letter-spacing: .04em; }
      .atl-rcpt-sec-h .n { font-size: 10px; font-weight: 600; color: var(--ink-dim);
        letter-spacing: 0; text-transform: none; }
      .atl-rcpt-sec-b { padding: 2px 12px 10px; }

      .atl-rcpt-step { display: flex; gap: 8px; padding: 5px 0;
        border-top: 1px solid var(--border-soft); }
      .atl-rcpt-step:first-child { border-top: none; }
      .atl-rcpt-role { flex: 0 0 auto; font-size: 9px; font-weight: 700;
        text-transform: uppercase; letter-spacing: .05em; padding: 3px 6px;
        border-radius: 6px; height: fit-content; }
      .atl-rcpt-role.user { background: var(--accent-soft); color: var(--accent); }
      .atl-rcpt-role.assistant { background: #ece3d2; color: var(--ink-mid); }
      .atl-rcpt-role.note { background: #e4ecdf; color: #5a7150; }
      .atl-rcpt-step-txt { flex: 1; font-size: 11.5px; line-height: 1.5;
        color: var(--ink-mid); white-space: pre-wrap; word-break: break-word; }

      .atl-rcpt-list { list-style: none; margin: 0; padding: 0; }
      .atl-rcpt-li { padding: 4px 0; border-top: 1px solid var(--border-soft);
        font-size: 11.5px; word-break: break-word; }
      .atl-rcpt-li:first-child { border-top: none; }
      .atl-rcpt-src-link { color: var(--accent); text-decoration: none; }
      .atl-rcpt-src-link:hover { text-decoration: underline; }
      .atl-rcpt-src-txt { color: var(--ink-mid); }
      .atl-rcpt-src-tag { font-size: 10px; color: var(--ink-dim); margin-left: 6px; }
      .atl-rcpt-foot { margin-top: 6px; font-size: 10px; color: var(--ink-dim);
        line-height: 1.4; }

      .atl-rcpt-file { border-top: 1px solid var(--border-soft); }
      .atl-rcpt-file:first-child { border-top: none; }
      .atl-rcpt-file-h { display: flex; align-items: baseline; gap: 7px;
        padding: 5px 0; cursor: pointer; font-size: 11.5px; color: var(--ink-mid); }
      .atl-rcpt-file-h:hover { color: var(--ink); }
      .atl-rcpt-file-kind { flex: 0 0 auto; font-size: 9px; font-weight: 700;
        text-transform: uppercase; letter-spacing: .05em; padding: 3px 6px;
        border-radius: 6px; background: #ece3d2; color: var(--ink-mid); }
      .atl-rcpt-file-name { flex: 1; font-weight: 600; color: var(--ink);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-rcpt-file-toggle { flex: 0 0 auto; font-size: 10px; color: var(--ink-dim); }
      .atl-rcpt-file-content { margin: 0 0 8px; padding: 8px 10px; background: #fbf8f2;
        border: 1px solid var(--border-soft); border-radius: 8px; font-size: 11px;
        line-height: 1.5; color: var(--ink-mid); white-space: pre-wrap;
        word-break: break-word; max-height: 220px; overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .atl-rcpt-actions { padding: 10px 12px; }
      .atl-rcpt-undo { width: 100%; border: 1px solid var(--border); border-radius: 10px;
        background: #faf7f1; color: var(--ink-mid); padding: 8px 12px; cursor: pointer;
        font: inherit; font-size: 12.5px; font-weight: 700; }
      .atl-rcpt-undo:hover { border-color: #c05545; color: #c05545; }
      .atl-rcpt-undo:disabled { opacity: .45; cursor: default; }
      .atl-rcpt-undo:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .atl-rcpt-undo-hint { margin-top: 5px; font-size: 10px; color: var(--ink-dim);
        line-height: 1.4; }
      .atl-rcpt-confirm { display: flex; flex-direction: column; gap: 8px; }
      .atl-rcpt-confirm .q { font-size: 12px; color: var(--ink); font-weight: 600; }
      .atl-rcpt-confirm-row { display: flex; gap: 8px; }
      .atl-rcpt-confirm-row button { flex: 1; border-radius: 9px; padding: 7px 10px;
        cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; }
      .atl-rcpt-yes { border: none; background: #c05545; color: #fff; }
      .atl-rcpt-yes:hover { background: #a8463a; }
      .atl-rcpt-no { border: 1px solid var(--border); background: #faf7f1; color: var(--ink-mid); }
      .atl-rcpt-no:hover { color: var(--ink); }

      /* per-agent-card affordance button */
      .atl-rcpt-cardbtn { border: 1px solid var(--border); background: #faf7f1;
        color: var(--ink-dim); font: inherit; font-size: 10px; line-height: 1;
        padding: 2px 6px; border-radius: 6px; cursor: pointer; margin-left: 4px; }
      .atl-rcpt-cardbtn:hover { border-color: var(--accent); color: var(--accent); }
      .atl-rcpt-cardbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    `;
    const style = el('style');
    style.id = 'atl-receipt-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  const STATUS_CLASS = { running: 'running', error: 'error', idle: 'idle' };
  function statusClass(s) { return STATUS_CLASS[String(s)] || 'idle'; }

  // ── one receipt card ───────────────────────────────────────────────────────
  function createReceiptCard(worldPos, initialSessionId) {
    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = el('section', 'card app-card atl-rcpt-card');
    const bar = el('div', 'card-bar');
    const dot = el('span', 'card-dot');
    const title = el('span', 'card-title', 'Receipt');
    const closeX = el('span', 'card-x', '×');
    bar.append(dot, title, closeX);

    const body = el('div', 'app-body atl-rcpt-body');
    const head = el('div', 'atl-rcpt-head');
    const backBtn = el('button', 'atl-rcpt-back', '‹ Runs');
    backBtn.type = 'button';
    backBtn.hidden = true;
    const crumb = el('span', 'atl-rcpt-crumb', 'Runs');
    const refreshBtn = el('button', 'atl-rcpt-btn', 'Refresh');
    refreshBtn.type = 'button';
    head.append(backBtn, crumb, refreshBtn);
    const note = el('div', 'atl-rcpt-note');
    const scroll = el('div', 'atl-rcpt-scroll');
    body.append(head, note, scroll);
    card.append(bar, body);

    // state
    let closed = false;
    let seq = 0;              // bumped per load; stale results are dropped
    let pollTimer = null;
    let view = 'pick';        // 'pick' | 'receipt'
    let currentId = null;     // session id shown in receipt view
    const expanded = new Set(); // file seqs the user opened

    function setNote(text) { note.textContent = text || ''; }

    function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }

    // ── PICKER view ───────────────────────────────────────────────────────────
    async function loadPicker() {
      const my = ++seq;
      stopPoll();
      view = 'pick';
      currentId = null;
      backBtn.hidden = true;
      crumb.textContent = 'Runs';
      setNote('');
      const r = await apiJson('/sessions');
      if (closed || my !== seq) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.sessions)) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      renderPicker(r.data.sessions);
    }

    function renderPicker(sessions) {
      scroll.textContent = '';
      scroll.scrollTop = 0;
      crumb.textContent = sessions.length
        + (sessions.length === 1 ? ' run' : ' runs');
      if (sessions.length === 0) {
        const empty = el('div', 'atl-rcpt-empty',
          'No runs yet. Start a chat agent, then come back for its receipt.');
        scroll.appendChild(empty);
        return;
      }
      for (const s of sessions) {
        if (!s || typeof s !== 'object') continue;
        const row = el('div', 'atl-rcpt-pick-row');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const name = el('span', 'atl-rcpt-pick-name', String(s.name || s.id || 'run'));
        const bits = [];
        bits.push(String(s.status || 'idle'));
        const nMsg = Number(s.messages_len) || 0;
        bits.push(nMsg + (nMsg === 1 ? ' step' : ' steps'));
        if (s.job_name) bits.push('job');
        if (s.parent_id) bits.push('sub-agent');
        const meta = el('span', 'atl-rcpt-pick-meta', bits.join(' · '));
        row.append(name, meta);
        const go = () => openReceipt(String(s.id));
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
        scroll.appendChild(row);
      }
    }

    // ── RECEIPT view ──────────────────────────────────────────────────────────
    function openReceipt(id) {
      currentId = String(id);
      view = 'receipt';
      backBtn.hidden = false;
      expanded.clear();
      loadReceipt();
    }

    async function loadReceipt() {
      if (!currentId) return;
      const my = ++seq;
      stopPoll();
      const r = await apiJson('/sessions/' + encodeURIComponent(currentId));
      if (closed || my !== seq || view !== 'receipt') return;
      if (r.status === 404) {
        setNote('That run is gone (it was deleted or evicted).');
        crumb.textContent = 'Run not found';
        scroll.textContent = '';
        const empty = el('div', 'atl-rcpt-empty',
          'This run is no longer available. Go back to the list of runs.');
        scroll.appendChild(empty);
        return;
      }
      if (!r.ok || !r.data) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      setNote('');
      renderReceipt(r.data);
      // keep the receipt live while the run is still working
      if (r.data.status === 'running') {
        pollTimer = setTimeout(() => { if (!closed) loadReceipt(); }, POLL_MS);
      }
    }

    function section(titleText, count) {
      const sec = el('div', 'atl-rcpt-sec');
      const h = el('div', 'atl-rcpt-sec-h');
      h.appendChild(el('span', null, titleText));
      if (count != null) h.appendChild(el('span', 'n', String(count)));
      const b = el('div', 'atl-rcpt-sec-b');
      sec.append(h, b);
      return { sec, body: b };
    }

    function renderReceipt(data) {
      scroll.textContent = '';
      scroll.scrollTop = 0;
      const name = String(data.name || data.id || 'run');
      crumb.textContent = name;

      const messages = Array.isArray(data.messages) ? data.messages : [];
      const ops = Array.isArray(data.canvas_ops) ? data.canvas_ops : [];
      const sources = ops.filter((o) => o && o.kind === 'browser');
      const files = ops.filter((o) => o && (o.kind === 'note' || o.kind === 'document'));

      // trust tagline
      const tag = el('div', 'atl-rcpt-tagline');
      tag.appendChild(el('span', 't', 'Here is exactly what this run did.'));
      tag.appendChild(el('span', 's',
        'A plain record of its steps, the pages it opened, and the files it '
        + 'wrote — the receipts, so you can trust it.'));
      scroll.appendChild(tag);

      // facts row: status / model / timing
      const facts = el('div', 'atl-rcpt-facts');
      const stFact = el('span', 'atl-rcpt-fact');
      const chip = el('span', 'atl-rcpt-chip ' + statusClass(data.status),
        String(data.status || 'idle'));
      stFact.appendChild(chip);
      facts.appendChild(stFact);
      if (data.model) {
        const f = el('span', 'atl-rcpt-fact');
        f.append(el('span', 'k', 'model'), el('span', 'v', String(data.model)));
        facts.appendChild(f);
      }
      if (data.job_name) {
        const f = el('span', 'atl-rcpt-fact');
        f.append(el('span', 'k', 'job'), el('span', 'v', String(data.job_name)));
        facts.appendChild(f);
      }
      // timing from message stamps (real ISO wall-clock)
      const stamps = messages.map((m) => parseTs(m && m.ts)).filter(Boolean);
      const started = stamps.length ? stamps[0] : null;
      const ended = stamps.length ? stamps[stamps.length - 1] : null;
      if (started) {
        const f = el('span', 'atl-rcpt-fact');
        f.append(el('span', 'k', 'started'), el('span', 'v', fmtClock(started)));
        facts.appendChild(f);
        const f2 = el('span', 'atl-rcpt-fact');
        const durLabel = data.status === 'running'
          ? fmtDuration(started, new Date()) + ' (running)'
          : fmtDuration(started, ended);
        f2.append(el('span', 'k', 'took'), el('span', 'v', durLabel));
        facts.appendChild(f2);
      }
      scroll.appendChild(facts);

      // STEPS — the transcript, incl. note/delegation events
      const steps = section('What it did', messages.length);
      if (messages.length === 0) {
        steps.body.appendChild(el('div', 'atl-rcpt-empty', 'No steps recorded.'));
      } else {
        for (const m of messages) {
          if (!m || typeof m !== 'object') continue;
          const role = String(m.role || '');
          const row = el('div', 'atl-rcpt-step');
          const rc = role === 'user' ? 'user' : role === 'note' ? 'note' : 'assistant';
          const label = role === 'user' ? 'you' : role === 'note' ? 'event' : 'agent';
          row.appendChild(el('span', 'atl-rcpt-role ' + rc, label));
          row.appendChild(el('span', 'atl-rcpt-step-txt', String(m.text || '')));
          steps.body.appendChild(row);
        }
      }
      scroll.appendChild(steps.sec);

      // SOURCES — pages the agent opened (+ last navigation), honest footnote
      const navUrl = data.browser_nav && data.browser_nav.url
        ? String(data.browser_nav.url) : null;
      const srcCount = sources.length + (navUrl ? 1 : 0);
      const src = section('Sources it opened', srcCount);
      if (srcCount === 0) {
        src.body.appendChild(el('div', 'atl-rcpt-empty',
          'It did not open any web pages as browser cards.'));
      } else {
        const ul = el('ul', 'atl-rcpt-list');
        for (const o of sources) {
          const li = el('li', 'atl-rcpt-li');
          li.appendChild(makeLink(o.url));
          ul.appendChild(li);
        }
        if (navUrl) {
          const li = el('li', 'atl-rcpt-li');
          li.appendChild(makeLink(navUrl));
          li.appendChild(el('span', 'atl-rcpt-src-tag', '(last navigation)'));
          ul.appendChild(li);
        }
        src.body.appendChild(ul);
      }
      src.body.appendChild(el('div', 'atl-rcpt-foot',
        'These are the pages the agent opened as browser cards. Web searches '
        + 'and background fetches are not recorded yet, so this is not every '
        + 'source it may have consulted.'));
      scroll.appendChild(src.sec);

      // FILES — note/document deliverables it wrote
      const fsec = section('Files it produced', files.length);
      if (files.length === 0) {
        fsec.body.appendChild(el('div', 'atl-rcpt-empty',
          'It did not write any note or document cards.'));
      } else {
        for (const o of files) {
          const seqKey = String(o.seq);
          const wrap = el('div', 'atl-rcpt-file');
          const h = el('div', 'atl-rcpt-file-h');
          h.appendChild(el('span', 'atl-rcpt-file-kind', String(o.kind || 'file')));
          const nm = o.title ? String(o.title) : firstLine(o.content) || '(untitled)';
          h.appendChild(el('span', 'atl-rcpt-file-name', nm));
          const isOpen = expanded.has(seqKey);
          const toggle = el('span', 'atl-rcpt-file-toggle', isOpen ? 'hide' : 'show');
          h.appendChild(toggle);
          wrap.appendChild(h);
          let content = null;
          if (isOpen) {
            content = el('pre', 'atl-rcpt-file-content', String(o.content || ''));
            wrap.appendChild(content);
          }
          h.addEventListener('click', () => {
            if (expanded.has(seqKey)) {
              expanded.delete(seqKey);
              if (content) content.remove();
              content = null;
              toggle.textContent = 'show';
            } else {
              expanded.add(seqKey);
              content = el('pre', 'atl-rcpt-file-content', String(o.content || ''));
              wrap.appendChild(content);
              toggle.textContent = 'hide';
            }
          });
          fsec.body.appendChild(wrap);
        }
      }
      scroll.appendChild(fsec.sec);

      // ACTIONS — the honest Undo
      const actions = el('div', 'atl-rcpt-actions');
      const undoWrap = el('div');
      buildUndoButton(undoWrap, name);
      actions.appendChild(undoWrap);
      actions.appendChild(el('div', 'atl-rcpt-undo-hint',
        'Undo here deletes the run and its conversation. The cards it already '
        + 'placed on the canvas stay put — remove those by hand if you want '
        + 'them gone.'));
      scroll.appendChild(actions);
    }

    function buildUndoButton(wrap, name) {
      wrap.textContent = '';
      const btn = el('button', 'atl-rcpt-undo', 'Delete this run');
      btn.type = 'button';
      btn.addEventListener('click', () => openUndoConfirm(wrap, name));
      wrap.appendChild(btn);
    }

    function openUndoConfirm(wrap, name) {
      wrap.textContent = '';
      const box = el('div', 'atl-rcpt-confirm');
      const q = el('div', 'q', 'Delete this run and its conversation?');
      q.setAttribute('role', 'alert');
      const row = el('div', 'atl-rcpt-confirm-row');
      const yes = el('button', 'atl-rcpt-yes', 'Delete run');
      yes.type = 'button';
      const no = el('button', 'atl-rcpt-no', 'Keep it');
      no.type = 'button';
      yes.addEventListener('click', () => doDelete(wrap));
      no.addEventListener('click', () => buildUndoButton(wrap, name));
      row.append(yes, no);
      box.append(q, row);
      wrap.appendChild(box);
      setTimeout(() => { try { no.focus(); } catch {} }, 20); // land on the safe choice
    }

    async function doDelete(wrap) {
      if (!currentId) return;
      wrap.textContent = '';
      wrap.appendChild(el('div', 'atl-rcpt-undo-hint', 'Deleting…'));
      const r = await apiJson('/sessions/' + encodeURIComponent(currentId),
        { method: 'DELETE' });
      if (closed) return;
      if (r.ok && r.data && r.data.ok) {
        toast('Run deleted.');
        loadPicker();
      } else if (r.status === 404) {
        toast('That run was already gone.');
        loadPicker();
      } else {
        toast('Could not delete the run.');
        buildUndoButton(wrap, crumb.textContent || 'run');
      }
    }

    function toast(msg) {
      if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(msg);
    }

    // header controls
    backBtn.addEventListener('click', loadPicker);
    refreshBtn.addEventListener('click', () => {
      if (view === 'receipt' && currentId) loadReceipt(); else loadPicker();
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

    // card closed (×, Delete key, board switch's removeAllCards) → stop polling
    const off = A.bus.on('card:removed', ({ el: removed }) => {
      if (removed !== card) return;
      closed = true;
      stopPoll();
      off();
    });

    // initial view: a specific run (from open(id) / a card affordance) or picker
    if (initialSessionId) openReceipt(String(initialSessionId));
    else loadPicker();

    // let window.AtelierReceipt.open(id) retarget this same card
    handle.el._atlReceiptOpen = (id) => {
      if (closed) return;
      if (id) openReceipt(String(id)); else loadPicker();
    };
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('receipt', {
    label: 'Receipt',
    icon: '🧾',
    create(worldPos) { return createReceiptCard(worldPos, null); },
  });

  // ── public API: open a run's receipt directly ──────────────────────────────
  // If a receipt card already exists, retarget it; otherwise spawn a fresh one
  // focused on the requested run.
  function openReceiptFor(sessionId) {
    const existing = document.querySelector('.atl-rcpt-card');
    if (existing && typeof existing._atlReceiptOpen === 'function') {
      existing._atlReceiptOpen(sessionId ? String(sessionId) : null);
      try { existing.scrollIntoView({ block: 'nearest' }); } catch {}
      return existing;
    }
    return createReceiptCard(null, sessionId ? String(sessionId) : null);
  }

  window.AtelierReceipt = {
    open: openReceiptFor,
    spawn: () => createReceiptCard(null, null),
  };

  // ── per-agent-card affordance ──────────────────────────────────────────────
  // Inject a small "receipt" button into every agent card's title bar. The
  // run id comes from the dataset stamp chatcontrols writes (dataset.atlSession);
  // when it is not yet present we fall back to matching the card title against
  // GET /sessions, so the button still works before the composer mounts.
  A.bus.on('card:added', ({ el: cardEl }) => {
    if (!cardEl || !cardEl.classList || !cardEl.classList.contains('atl-agent-card')) return;
    const bar = cardEl.querySelector('.card-bar');
    if (!bar || bar.querySelector('.atl-rcpt-cardbtn')) return;
    const btn = el('button', 'atl-rcpt-cardbtn', 'receipt');
    btn.type = 'button';
    btn.title = 'Show a plain-language receipt for this run';
    btn.setAttribute('aria-label', 'Show a receipt for this run');
    const closeEl = bar.querySelector('.card-x');
    if (closeEl) bar.insertBefore(btn, closeEl); else bar.appendChild(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let id = cardEl.dataset && cardEl.dataset.atlSession
        ? String(cardEl.dataset.atlSession) : null;
      if (!id) {
        // fall back to a title match against the live session list
        const titleEl = bar.querySelector('.card-title');
        const wanted = titleEl ? String(titleEl.textContent || '').trim() : '';
        const r = await apiJson('/sessions');
        const list = r.ok && r.data && Array.isArray(r.data.sessions) ? r.data.sessions : [];
        const hit = wanted && list.find((s) => s && String(s.name || '').trim() === wanted);
        if (hit) id = String(hit.id);
      }
      openReceiptFor(id); // null id → the picker, which is still useful
    });
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('receipt');
    console.assert(registered, '[receipt] receipt app type not registered');
    const styles = !!document.getElementById('atl-receipt-styles');
    console.assert(styles, '[receipt] styles not injected');
    const api = !!(window.AtelierReceipt && typeof window.AtelierReceipt.open === 'function');
    console.assert(api, '[receipt] window.AtelierReceipt.open not exposed');
    if (registered && styles && api) {
      console.log('[receipt] self-check passed — receipt app registered '
        + '(palette + spawnApp reachable), window.AtelierReceipt.open ready, '
        + 'styles injected.');
    }
  })();
})();
