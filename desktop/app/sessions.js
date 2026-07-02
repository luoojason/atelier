'use strict';

/* ===========================================================================
   Atelier feature module — agent sessions   (app/sessions.js)

   Multi-card agent sessions: every "Agent" card is its OWN conversation on
   the backend's sessions API (each backend session owns a fresh
   ClaudeSDKClient — separate from the main chat card's client and from
   scheduled jobs). Registers the 'agent' app type via Atelier.registerApp
   and wires the ✳ Agent dock button.

   Backend contract (lite_server.py, fixed shapes):
     POST   /sessions                {"name"?}   -> {"id","name"}
     GET    /sessions/{id}                       -> {id,name,status,messages:[{role,text,ts}]}
     POST   /sessions/{id}/message   {"message"} -> 202 {"status":"running"}
                                       (409 {"error":"turn in progress"} mid-turn)
     DELETE /sessions/{id}                       -> {"ok":true}
   Fire-and-poll: send POSTs the message, then this card polls GET every 1.5s
   while status is "running" and appends any new messages. Turn errors come
   back as an assistant message with status "error" — rendered like any reply.

   Direct-fetch pattern (same as core's streamChat + the widget fetches):
   plain fetch to http://127.0.0.1:8765 — no preload hop needed.
   XSS rule: every server-derived string enters the DOM via textContent.

   Dock note: core.js's dock handler would spawn any registered type by
   lowercased button title, but apps.js CLONE-REPLACES every .dock-btn at load
   (stripping core's listeners) and its replacement handler only knows its own
   DOCK_MAP types — 'agent' is not among them. This module loads after
   apps.js, so it attaches the one real click handler to the ✳ button itself
   (apps.js's handler still runs first and only toggles the active class; no
   double spawn).

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Does not touch core.js, apps.js, boards.js, or styles.css.

   ponytail: agent cards are NOT persisted (backend sessions are in-memory and
   die with the server; a board switch reloads the page and drops the cards —
   the backend's LRU cap reclaims the orphaned sessions). Disk persistence on
   both sides is the upgrade.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 .venv-ext/bin/python lite_server.py) and
      `npm start` in desktop/ — or open index.html in a plain browser.
   2. Click the ✳ Agent dock button → an "Agent 1" card spawns (messages list
      + its own composer). Click again → "Agent 2". Network tab shows one
      POST /sessions per card.
   3. Type "remember the word mango" ↵ in Agent 1 → your bubble appears
      right-aligned, an italic "Thinking…" bubble follows, and the card polls
      GET /sessions/{id} every 1.5s until the reply lands.
   4. While Agent 1 is thinking, chat in Agent 2 → both turns run
      concurrently. Ask "what word did I ask you to remember?" in Agent 2 →
      it does NOT know mango (sessions are isolated); Agent 1 does.
   5. Send in Agent 1 mid-turn → the composer is gated (button disabled);
      racing it with curl gets 409 {"error":"turn in progress"}.
   6. Close a card (×) → DELETE /sessions/{id} fires and polling stops
      (Network tab).
   7. Stop the backend, send → the message returns to the composer with an
      inline "Could not reach the Atelier backend" note. Restart the backend,
      send again → works (a fresh session is created if the old one is gone).
   8. Console shows "[sessions] self-check passed" and no assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[sessions] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 1500;
  const CARD_W = 380;
  const CARD_H = 340;

  let agentSeq = 0; // 'Agent N' naming for cards spawned this page-load

  // ── injected styles (mirrors the main chat card, self-contained) ──────────
  (function injectStyles() {
    if (document.getElementById('atl-sessions-styles')) return;
    const css = `
      .atl-agent-body { padding: 0; display: flex; flex-direction: column; }
      .atl-agent-msgs { flex: 1; overflow-y: auto; padding: 14px; }
      .atl-agent-row { display: flex; gap: 8px; margin-bottom: 10px; }
      .atl-agent-row.user { flex-direction: row-reverse; }
      .atl-agent-avatar { width: 22px; height: 22px; flex: 0 0 22px;
        border-radius: 7px; display: flex; align-items: center;
        justify-content: center; font-size: 10px; font-weight: 700; color: #fff; }
      .atl-agent-row.assistant .atl-agent-avatar {
        background: linear-gradient(150deg, #d0714a, #b34a26); }
      .atl-agent-row.user .atl-agent-avatar {
        background: #e6ddcf; color: var(--ink-mid); }
      .atl-agent-bubble { padding: 8px 12px; border-radius: 12px; max-width: 82%;
        white-space: pre-wrap; word-wrap: break-word; font-size: 13px;
        line-height: 1.5; }
      .atl-agent-row.assistant .atl-agent-bubble { background: #f6f2ea;
        border: 1px solid var(--border-soft); color: var(--ink); }
      .atl-agent-row.user .atl-agent-bubble { background: var(--accent); color: #fff; }
      .atl-agent-bubble.thinking { color: var(--ink-dim); font-style: italic; }
      .atl-agent-note { font-size: 11.5px; color: var(--ink-dim);
        padding: 0 14px 6px; line-height: 1.4; }
      .atl-agent-note:empty { display: none; }
      .atl-agent-composer { display: flex; align-items: flex-end; gap: 8px;
        padding: 10px; border-top: 1px solid var(--border-soft); }
      .atl-agent-composer textarea { flex: 1; resize: none;
        border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1;
        outline: none; max-height: 120px; }
      .atl-agent-composer textarea:focus { border-color: var(--accent); }
      .atl-agent-send { width: 32px; height: 32px; flex: 0 0 32px; border: none;
        border-radius: 9px; background: var(--accent); color: #fff;
        cursor: pointer; font-size: 13px; }
      .atl-agent-send:disabled { opacity: 0.5; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-sessions-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend helper: fetch JSON, never throw on HTTP errors (only network) ─
  // Mutating routes require the shared-secret header when the backend was
  // launched by main.js (window.atelier.token via preload); in a plain browser
  // the bridge is absent and a hand-run backend has no token to enforce.
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const init = Object.assign({ headers }, opts || {});
    const res = await fetch(BASE + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // ── one agent card ─────────────────────────────────────────────────────────
  function createAgentCard(worldPos) {
    agentSeq += 1;
    const name = 'Agent ' + agentSeq;

    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = document.createElement('section');
    card.className = 'card app-card atl-agent-card';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = name;
    const closeX = document.createElement('span');
    closeX.className = 'card-x';
    closeX.textContent = '×';
    bar.append(dot, title, closeX);

    const body = document.createElement('div');
    body.className = 'app-body atl-agent-body';
    const msgs = document.createElement('div');
    msgs.className = 'atl-agent-msgs';
    const note = document.createElement('div');
    note.className = 'atl-agent-note';
    const composer = document.createElement('div');
    composer.className = 'atl-agent-composer';
    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.placeholder = 'Message ' + name + '…';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'atl-agent-send';
    sendBtn.textContent = '➤';
    sendBtn.title = 'Send';
    composer.append(ta, sendBtn);
    body.append(msgs, note, composer);
    card.append(bar, body);

    // state
    let sessionId = null;
    let renderedCount = 0;  // server messages already in the DOM
    let running = false;
    let closed = false;
    let pollTimer = null;
    let thinkingRow = null;

    function setNote(text) { note.textContent = text || ''; }

    function addBubble(role, text) {
      const row = document.createElement('div');
      row.className = 'atl-agent-row ' + (role === 'user' ? 'user' : 'assistant');
      const av = document.createElement('div');
      av.className = 'atl-agent-avatar';
      av.textContent = role === 'user' ? 'You' : 'A';
      const b = document.createElement('div');
      b.className = 'atl-agent-bubble';
      b.textContent = text; // XSS rule: server text only ever lands here
      row.append(av, b);
      msgs.appendChild(row);
      msgs.scrollTop = msgs.scrollHeight;
      return row;
    }

    function showThinking() {
      if (thinkingRow) return;
      thinkingRow = addBubble('assistant', 'Thinking…');
      thinkingRow.querySelector('.atl-agent-bubble').classList.add('thinking');
    }
    function hideThinking() {
      if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
    }

    function renderNew(messages) {
      for (let i = renderedCount; i < messages.length; i++) {
        const m = messages[i] || {};
        addBubble(m.role === 'user' ? 'user' : 'assistant', String(m.text || ''));
      }
      if (messages.length > renderedCount) renderedCount = messages.length;
    }

    async function ensureSession() {
      if (sessionId) return sessionId;
      const r = await apiJson('/sessions', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (r.status === 409) {
        // backend session cap with every session mid-turn — retrying won't
        // help until a turn finishes or a card is closed; say THAT, not
        // "backend may still be starting".
        const e = new Error('session limit');
        e.limit = true;
        throw e;
      }
      if (!r.ok || !r.data || !r.data.id) throw new Error('session create failed');
      sessionId = r.data.id;
      renderedCount = 0; // fresh server session starts with an empty ledger
      return sessionId;
    }

    function settle() {
      running = false;
      sendBtn.disabled = false;
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS);
    }

    async function poll() {
      if (closed || !sessionId) return;
      let r;
      try {
        r = await apiJson('/sessions/' + sessionId, { method: 'GET' });
      } catch {
        // backend gone mid-turn — keep polling quietly; it may come back
        setNote('Backend unreachable — retrying…');
        schedulePoll();
        return;
      }
      if (r.status === 404) {
        // evicted server-side (LRU cap / restart) — next send starts fresh
        hideThinking();
        settle();
        sessionId = null;
        setNote('This session expired on the backend — the next message starts a fresh one.');
        return;
      }
      if (!r.ok || !r.data) { schedulePoll(); return; }
      setNote('');
      hideThinking(); // new messages must land ABOVE the thinking bubble
      renderNew(r.data.messages || []);
      if (r.data.status === 'running') {
        showThinking();
        schedulePoll();
      } else {
        settle(); // "idle" or "error" — the error text arrived as a bubble
      }
    }

    async function send() {
      const text = ta.value.trim();
      if (!text || running || closed) return;
      ta.value = '';
      setNote('');
      const optimistic = addBubble('user', text);
      running = true;
      sendBtn.disabled = true;
      try {
        await ensureSession();
        const body = { method: 'POST', body: JSON.stringify({ message: text }) };
        let r = await apiJson('/sessions/' + sessionId + '/message', body);
        if (r.status === 404) {
          // session evicted between turns — recreate once and retry
          sessionId = null;
          await ensureSession();
          r = await apiJson('/sessions/' + sessionId + '/message', body);
        }
        if (r.status === 409) {
          const e = new Error('turn in progress');
          e.busy = true;
          throw e;
        }
        if (r.status === 413) {
          // per-session message-ledger ceiling (backend rejects, never trims)
          const e = new Error('session ledger full');
          e.full = true;
          throw e;
        }
        if (r.status !== 202 && !r.ok) throw new Error('send failed');
        renderedCount += 1; // the server ledger now holds our user message
        showThinking();
        poll(); // immediate check, then every 1.5s while running
      } catch (err) {
        optimistic.remove();
        ta.value = text; // hand the message back so a retry is one keystroke
        settle();
        setNote(err && err.busy
          ? 'Atelier is still on the previous turn — try again in a moment.'
          : err && err.limit
            ? 'Session limit reached — close an Agent card or wait for a turn to finish, then try again.'
            : err && err.full
              ? 'This conversation is full — close this card and start a fresh Agent.'
              : 'Could not reach the Atelier backend. It may still be starting — try again in a moment.');
      }
    }

    sendBtn.addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
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

    // card closed (×, or programmatically) → stop polling + free the backend
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      clearTimeout(pollTimer);
      off();
      if (sessionId) {
        // best-effort: the backend also reclaims leaked sessions via LRU cap
        apiJson('/sessions/' + sessionId, { method: 'DELETE' }).catch(() => {});
      }
    });

    // create the backend session up front so the card is ready to poll; a
    // failure is fine — ensureSession() retries on the first send.
    ensureSession().catch((err) => {
      setNote(err && err.limit
        ? 'Session limit reached — close an Agent card or wait for a turn to finish, then send.'
        : 'Backend offline — the session will be created when you send.');
    });

    ta.focus();
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (palette + spawnApp pick this up) ───────────────
  A.registerApp('agent', {
    label: 'Agent',
    icon: '✳',
    create(worldPos) { return createAgentCard(worldPos); },
  });

  // ── dock wiring (see header: apps.js stripped core's dock handler) ────────
  (function wireDock() {
    const btn = Array.from(document.querySelectorAll('.dock-btn'))
      .find((b) => (b.getAttribute('title') || '').toLowerCase() === 'agent');
    if (!btn) { console.warn('[sessions] no Agent dock button found.'); return; }
    btn.addEventListener('click', () => { A.spawnApp('agent'); });
  })();

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('agent');
    console.assert(registered, '[sessions] agent app type not registered');
    const btn = Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => (b.getAttribute('title') || '').toLowerCase() === 'agent');
    console.assert(btn, '[sessions] Agent dock button missing from index.html');
    if (registered && btn) {
      console.log('[sessions] self-check passed — agent app registered, dock wired.');
    }
  })();
})();
