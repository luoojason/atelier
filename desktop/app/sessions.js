'use strict';

/* ===========================================================================
   Atelier feature module — agent sessions   (app/sessions.js)

   Multi-card agent sessions: every "Agent" card is its OWN conversation on
   the backend's sessions API (each backend session owns a fresh
   ClaudeSDKClient — separate from the main chat card's client and from
   scheduled jobs). Registers the 'agent' app type via Atelier.registerApp;
   the 💬 Chat dock button (apps.js) spawns cards via A.spawnApp('agent') —
   this module wires no dock button of its own.

   Backend contract (lite_server.py, fixed shapes):
     POST   /sessions                {"name"?}   -> {"id","name"}
     GET    /sessions                            -> {"sessions":[{id,name,status,
                                                    messages_len,parent_id,depth}]}
     GET    /sessions/{id}                       -> {id,name,status,parent_id,
                                                    depth,browser_nav,
                                                    messages:[{role,text,ts}]}
     POST   /sessions/{id}/message   {"message"} -> 202 {"status":"running"}
                                       (409 {"error":"turn in progress"} mid-turn)
     DELETE /sessions/{id}                       -> {"ok":true}
   Fire-and-poll: send POSTs the message, then this card polls GET every 1.5s
   while status is "running" and appends any new messages. Turn errors come
   back as an assistant message with status "error" — rendered like any reply.

   Sub-agent auto-reveal: depth-0 agent sessions can spawn children server-side
   (the backend's SpawnAgent orchestra tool). ONE module-level sweep polls
   GET /sessions every 2.5s — only while at least one card here owns a session
   id — and any listed session whose parent_id belongs to a card on this canvas
   and that has no card of its own is revealed as an ATTACHED card beside its
   parent. Attach mode never POSTs /sessions (the card is a live view onto the
   existing child session) and never recreates it on 404 (a fresh session would
   orphan the parent link). When app/arrows.js is loaded, a parent→child arrow
   is drawn; window.Atelier.arrows is optional and guarded at every use.

   Direct-fetch pattern (same as core's streamChat + the widget fetches):
   plain fetch to http://127.0.0.1:8765 — no preload hop needed.
   XSS rule: every server-derived string enters the DOM via textContent.

   Linked browser context (round 15): app/link.js (optional, loads after this
   module) lets a shift-drag marquee link ONE browser card to an agent card
   and publishes window.Atelier.links. When a link exists for this card,
   send() prefixes the POSTED message with the browser's live page (title +
   url, read via links.browserFor at send time). The prefix is transport-level
   only: the optimistic bubble and the on-error composer refill stay the typed
   text, and renderedCount already skips re-rendering the sent message, so the
   prefix never renders. While linked, a small note under the composer says
   'linked to browser — page context rides along' — it renders only when the
   error note is empty (link status never clobbers an error). Every
   Atelier.links access is guarded: without link.js nothing changes.

   Agent-driven navigation (round 16): the backend's NavigateBrowser orchestra
   tool lets an agent REQUEST that the user-linked browser card open a URL —
   no CDP, no autonomous browsing; the user creates the link, the navigation
   is visible. The session detail (GET /sessions/{id}) carries browser_nav =
   {url, seq} | null. Each card gates on a monotonic lastNavSeq (start 0):
   polls re-deliver the same detail every 1.5s, so only seq > lastNavSeq
   fires, exactly once per tool call. When link.js holds a browser for this
   card (Atelier.links.browserElFor) AND apps.js is loaded
   (AtelierApps.browserNavigate), the linked browser's active tab navigates
   and the note reports it; with no linked browser the note explains nothing
   was linked. Both modules are optional and guarded at every access — the
   r15 note-clobbering rule stays (the link-status note yields to any note
   text, including these).

   Sessions accessor (round 17): window.AtelierSessions = { reveal(id, name) }
   is the small cross-module surface other modules (the agent-orbs widget's
   orb click) use to jump to a session's card. A card already on canvas is
   raised through core's own bringToFront path — a synthetic NON-BUBBLING
   mousedown dispatched on the card element, which core listens on directly;
   the bar's drag handler (a child) never sees a target-dispatched event, and
   the canvas pan/marquee handlers are out of the propagation path — then
   flashed with a 1s accent outline (injected class, restartable via a reflow
   between back-to-back reveals). An unknown id spawns an ATTACHED card at
   canvas center: createAgentCard(null, {id, name, parentEl: null}). Verified:
   the attach path never reads attach.parentEl (only the discovery sweep uses
   parentEl, for positioning + arrows), and a null worldPos already falls back
   to canvas center — parentEl: null needs no fix. The revealed card is the
   standard attach-mode live view onto the EXISTING backend session: no
   POST /sessions, no recreate on 404, same close semantics as any agent
   card. An explicit reveal also clears the id from dismissedSessions — that
   set only exists to stop the background sweep from resurrecting
   user-closed children, and a user click is fresh intent.

   Dock note: the standalone ✳ Agent dock button was removed (index.html) once
   the 💬 Chat button started spawning agent cards directly via
   A.spawnApp('agent') (apps.js). This module registers the 'agent' app type
   for that call to find but no longer attaches any dock click handler.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Does not touch core.js, apps.js, boards.js, or styles.css.

   Board switches (round 14, in-place): agent cards are per-page-load and not
   board-scoped (nothing here touches localStorage, so board snapshots never
   carry them). Under the old location.reload() switch they simply vanished;
   the in-place switch closes them at boards' canvas.removeAllCards() step —
   every agent card is an ordinary addCard card, so core removes it through
   its handle, card:removed fires per card, arrows unlink, each backend
   session gets its best-effort DELETE (sooner than the old reload-then-LRU
   path), and the discovery sweep stops when the map empties. Deliberately NO
   'boards:will-switch' close here: will-switch fires BEFORE boards' quota
   gate, and a quota-aborted switch (toast, board unchanged) must leave live
   agent conversations intact — removeAllCards only runs after the gate.

   ponytail: agent cards are NOT persisted (backend sessions are in-memory and
   die with the server; a board switch closes the cards in place — see above —
   and the backend's LRU cap reclaims anything the best-effort DELETE missed).
   Disk persistence on both sides is the upgrade.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 .venv-ext/bin/python lite_server.py) and
      `npm start` in desktop/ — or open index.html in a plain browser.
   2. Click the 💬 Chat dock button → an "Agent 1" card spawns (messages list
      + its own composer). Click again → "Agent 2". Network tab shows one
      POST /sessions per card. The dock has no ✳ button.
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
   8. Sub-agents: in Agent 1 ask "spawn a sub-agent to write a haiku about
      rivers, then collect its result" → within ~2.5s a new card appears to
      the right of Agent 1 (hollow title-bar dot + "Sub-agent" tooltip) and
      its transcript streams in live via the normal poll. With app/arrows.js
      loaded, an arrow links parent → child. A second child of the same
      parent stacks 210px below the first. Network tab shows the sweep's
      GET /sessions every 2.5s ONLY while agent cards exist.
   9. Close the parent card → the child card stays (it owns its own poll).
      Closing a child card DELETEs its backend session like any Agent card
      (the parent's CheckAgent then reports it gone — that is expected).
  10. Restart the backend, then send in a revealed child card → the inline
      sub-agent-expired note appears and the card does NOT create a fresh
      session; the message stays in the composer.
  11. Board switch: with two agent cards open (one with a revealed child),
      switch boards in the sidebar → all agent cards close in place (no
      reload), Network tab shows one DELETE /sessions/{id} per card, arrows
      disappear, and the GET /sessions sweep stops. Exporting a board leaves
      agent cards untouched, and so does a FAILED switch (fill localStorage
      until the "storage is full" toast fires → the board stays put and the
      agent conversations survive).
  12. Linked browser (app/link.js + apps.js loaded): shift-drag a marquee
      around exactly a Browser card and an Agent card → the link toast fires
      and 'linked to browser — page context rides along' appears under the
      Agent card's composer. Send "what page am I looking at?" → the bubble
      shows ONLY the typed text, but the request body (Network tab, POST
      /sessions/{id}/message) carries the '[Linked browser context — …]'
      prefix with the live tab's title + url, and the transcript never shows
      the prefix. Error notes win: stop the backend and send → the offline
      note appears and the link note yields until the error clears. Marquee
      the same pair again (unlink) → the link note vanishes. Without
      app/link.js loaded everything behaves exactly as before (all
      Atelier.links access is guarded).
  13. Agent-driven navigation (round 16): with the browser still linked from
      step 12, tell the agent "open https://example.com in my browser" → its
      NavigateBrowser tool stamps the session, the next poll carries
      browser_nav, the LINKED browser card's active tab loads the page and
      the note reads 'Agent opened https://example.com in the linked
      browser'. The navigation fires exactly once (seq-gated) even though
      every subsequent poll repeats the same browser_nav payload. Unlink and
      ask again → the browser stays put and the note explains no browser is
      linked (shift-drag a box around a browser card and this card). Without
      app/link.js or app/apps.js loaded, sends and polls behave as before.
  15. Accessor (round 17): with an Agent card open, run in the console
      AtelierSessions.reveal(<that card's session id>) → the card jumps to
      the front (core's bringToFront) and flashes a 1s accent outline; no
      drag starts and the canvas does not pan. Now curl-create a session the
      canvas does not know (curl -X POST 127.0.0.1:8765/sessions) and reveal
      ITS id → an attached card (hollow dot) spawns at canvas center,
      flashes, and streams the session's transcript via the normal poll;
      closing it DELETEs the backend session like any agent card. Reveal the
      same open card twice in a row → the outline flash restarts both times.
  16. Console shows "[sessions] self-check passed" and no assert failures.
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
  const SWEEP_MS = 2500; // child-discovery sweep cadence (GET /sessions list)
  const CHILD_DX = 70;   // revealed child sits this far right of its parent
  const CHILD_DY = 210;  // vertical step per already-revealed sibling
  const CHILD_GONE_NOTE = 'This sub-agent session expired on the backend — '
    + 'it cannot be restarted from this card.';

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
      .atl-agent-linknote { font-size: 11px; color: var(--ink-dim);
        padding: 4px 14px 8px; line-height: 1.4; font-style: italic; }
      .atl-agent-linknote:empty { display: none; }
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
      .atl-agent-subdot { background: #fff; border: 2px solid var(--accent);
        box-sizing: border-box; }
      .atl-agent-reveal { animation: atl-agent-reveal-flash 1s ease-out; }
      @keyframes atl-agent-reveal-flash {
        0%, 55% { outline: 3px solid var(--accent); outline-offset: 3px; }
        100% { outline: 3px solid rgba(192, 92, 55, 0); outline-offset: 3px; }
      }
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

  // ── linked-context value hygiene ───────────────────────────────────────────
  // The ride-along title/url are WEB-derived: a visited page fully controls
  // its own <title> (apps.js mirrors page-title-updated verbatim), so a
  // hostile page could craft a title that closes the bracketed context frame
  // early and poses as top-level user instructions to a tool-capable agent.
  // Neutralize the VALUES before interpolation — newlines collapse to
  // spaces, ']' (the frame's closer) becomes ')', length is capped. The
  // frame text itself stays exactly as contracted; only injected values are
  // cleaned.
  function cleanLinkValue(value, max) {
    return String(value || '')
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/\]/g, ')')
      .slice(0, max)
      .trim();
  }

  // ── sub-agent auto-reveal (module-level, one sweep for every card) ────────
  // cardBySession tracks EVERY live card that owns a backend session id
  // (fresh cards register when POST /sessions resolves; attached cards
  // immediately). The sweep runs only while that map is non-empty, so an
  // agent-free canvas makes zero background requests.
  const cardBySession = new Map(); // session id -> card element
  // ids the user closed: the DELETE is fired async, so a sweep response
  // already in flight can still list the child — without this the card would
  // resurrect as a dead "expired" ghost the user has to close twice.
  // Grow-only on purpose: uuid4 ids never recur, and a desktop session
  // closes a handful of cards at most.
  const dismissedSessions = new Set();
  let sweepTimer = null;
  let sweeping = false; // one fetch at a time; a slow backend must not stack

  function syncSweep() {
    if (cardBySession.size > 0 && sweepTimer == null) {
      sweepTimer = setInterval(sweepForChildren, SWEEP_MS);
    } else if (cardBySession.size === 0 && sweepTimer != null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }
  function trackSession(id, cardEl) { cardBySession.set(id, cardEl); syncSweep(); }
  function untrackSession(id) { cardBySession.delete(id); syncSweep(); }

  // k in the reveal-position formula: children of this parent already on
  // canvas (the sweep stamps data-atl-parent-session on each revealed card,
  // and card:removed drops the map entry, so the count is self-maintaining).
  function revealedChildCount(parentId) {
    let n = 0;
    cardBySession.forEach((el) => {
      if (el.dataset.atlParentSession === parentId) n += 1;
    });
    return n;
  }

  async function sweepForChildren() {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await apiJson('/sessions', { method: 'GET' });
      if (!r.ok || !r.data || !Array.isArray(r.data.sessions)) return;
      for (const item of r.data.sessions) {
        if (!item || !item.id || item.parent_id == null) continue;
        if (dismissedSessions.has(item.id)) continue; // closed; DELETE racing
        const parentEl = cardBySession.get(item.parent_id);
        if (!parentEl || cardBySession.has(item.id)) continue;
        // reveal beside the parent; siblings stack downward
        const k = revealedChildCount(item.parent_id);
        const pos = {
          x: (parseFloat(parentEl.style.left) || 0) + parentEl.offsetWidth + CHILD_DX,
          y: (parseFloat(parentEl.style.top) || 0) + k * CHILD_DY,
        };
        const childEl = createAgentCard(pos, {
          id: String(item.id),
          name: String(item.name || 'Sub-agent'),
          parentEl,
        });
        if (!childEl) continue;
        childEl.dataset.atlParentSession = String(item.parent_id);
        // arrows.js loads separately and may be absent (plain-browser test);
        // it auto-unlinks on card:removed, so the unlink handle can be dropped
        const arrows = window.Atelier && window.Atelier.arrows;
        if (arrows && typeof arrows.link === 'function') {
          arrows.link(parentEl, childEl);
        }
      }
    } catch {
      // backend unreachable — each card's own poll already reports that
    } finally {
      sweeping = false;
    }
  }

  // ── one agent card ─────────────────────────────────────────────────────────
  // attach = null (fresh card: creates its own backend session) or
  // {id, name, parentEl} (sub-agent reveal: a view onto an EXISTING session —
  // no POST /sessions, transcript arrives via the first poll). parentEl is
  // caller-side metadata only — the sweep uses it to compute the child's
  // position and draw the arrow BEFORE/AFTER this call; nothing in here reads
  // it, so AtelierSessions.reveal passes parentEl: null and a null worldPos
  // lands on the canvas-center fallback below (verified — no fix needed).
  function createAgentCard(worldPos, attach) {
    const attached = !!(attach && attach.id);
    let name;
    if (attached) {
      name = attach.name || 'Sub-agent';
    } else {
      agentSeq += 1;
      name = 'Agent ' + agentSeq;
    }

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
    if (attached) {
      // sub-agent hint: hollow dot + tooltip; .card-bar structure untouched
      dot.classList.add('atl-agent-subdot');
      bar.title = 'Sub-agent — spawned by another agent card';
    }

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
    // link-status note sits UNDER the composer (dedicated element so it never
    // fights the error note above — see refreshLinkNote)
    const linkNote = document.createElement('div');
    linkNote.className = 'atl-agent-linknote';
    body.append(msgs, note, composer, linkNote);
    card.append(bar, body);

    // state
    let sessionId = attached ? attach.id : null;
    let renderedCount = 0;  // server messages already in the DOM
    let running = false;
    let closed = false;
    let expired = false;    // attached only: child session gone, never rebuilt
    let pollTimer = null;
    let thinkingRow = null;
    let lastNavSeq = 0;     // r16: highest agent-requested browser_nav.seq handled

    if (attached) trackSession(sessionId, card); // fresh cards register in ensureSession

    function setNote(text) {
      note.textContent = text || '';
      refreshLinkNote(); // an error note wins the space; re-yield when it clears
    }

    // Guarded live read of the marquee-link (app/link.js may be absent, or
    // its accessor may throw on a torn-down card — treat both as "no link").
    function browserLinkInfo() {
      const links = window.Atelier && window.Atelier.links;
      if (!links || typeof links.browserFor !== 'function') return null;
      let info = null;
      try { info = links.browserFor(card); } catch { return null; }
      return (info && typeof info.url === 'string') ? info : null;
    }

    // Persistent 'linked to browser' note under the composer. Link status
    // must not clobber an error message, so it renders only while the error
    // note is otherwise empty; setNote() re-runs this on every transition.
    function refreshLinkNote() {
      if (closed) return;
      const show = !!browserLinkInfo() && !note.textContent;
      linkNote.textContent = show ? 'linked to browser — page context rides along' : '';
    }

    // Agent-driven linked-browser navigation (round 16). The backend's
    // NavigateBrowser tool sets browser_nav = {url, seq} on the session; the
    // detail poll re-delivers it every cycle, so the monotonic lastNavSeq
    // gate fires each request exactly once. link.js (Atelier.links) and
    // apps.js (AtelierApps.browserNavigate) are BOTH optional modules —
    // every access is guarded, and without them the payload is consumed
    // (seq still advances) but nothing else happens beyond the note.
    // The url is server-derived and only ever lands via setNote/textContent.
    function handleBrowserNav(nav) {
      if (closed || !nav || typeof nav.seq !== 'number') return;
      if (nav.seq <= lastNavSeq) return; // already handled (polls repeat it)
      lastNavSeq = nav.seq;
      const url = String(nav.url || '');
      const links = window.Atelier && window.Atelier.links;
      const browserEl = (links && typeof links.browserElFor === 'function')
        ? links.browserElFor(card)
        : null;
      const api = window.AtelierApps;
      if (browserEl && api && typeof api.browserNavigate === 'function') {
        let done = false;
        try { done = api.browserNavigate(browserEl, url); } catch { done = false; }
        setNote(done
          ? 'Agent opened ' + url + ' in the linked browser'
          : 'Agent asked to open ' + url + ' but the linked browser card refused it.');
      } else {
        setNote('Agent asked to open ' + url + ' but no browser card is '
          + 'linked — shift-drag a box around a browser card and this card '
          + 'to link one.');
      }
    }

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
      if (attached) {
        // this card views a session another agent owns — never recreate it
        const e = new Error('sub-agent session gone');
        e.expired = true;
        throw e;
      }
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
      // r16: reset the nav high-water mark with the session. The server's
      // browser_nav counter is module-wide and restarts at 1 with the
      // backend; a stale lastNavSeq from the previous session would make
      // handleBrowserNav silently drop every new request until the fresh
      // counter climbed past it.
      lastNavSeq = 0;
      if (!closed) trackSession(sessionId, card); // card:removed cleans this up
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
        hideThinking();
        settle();
        if (attached) {
          // the parent-spawned session is gone (backend restart / LRU after
          // it finished). Recreating would orphan the parent link, so this
          // card only reports it; sends fail gracefully with the same note.
          expired = true;
          setNote(CHILD_GONE_NOTE);
          return;
        }
        // evicted server-side (LRU cap / restart) — next send starts fresh
        untrackSession(sessionId);
        sessionId = null;
        setNote('This session expired on the backend — the next message starts a fresh one.');
        return;
      }
      if (!r.ok || !r.data) { schedulePoll(); return; }
      setNote('');
      hideThinking(); // new messages must land ABOVE the thinking bubble
      renderNew(r.data.messages || []);
      // r16: AFTER the routine setNote('') so a fresh nav request's note
      // wins this cycle (the next healthy poll clears it — transient by
      // design; a nav landing on the turn's final poll stays visible).
      handleBrowserNav(r.data.browser_nav);
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
      if (attached && expired) { setNote(CHILD_GONE_NOTE); return; }
      ta.value = '';
      setNote('');
      // Linked browser context (app/link.js, optional — guarded read): when a
      // browser card is marquee-linked to this agent, the POSTED message gets
      // a transport-level prefix carrying the browser's live page. Only the
      // wire copy changes: the optimistic bubble below and the on-error
      // composer refill stay the TYPED text, and renderedCount += 1 after a
      // 202 skips re-rendering the sent server message — the prefix never
      // reaches the DOM. Title/url pass through cleanLinkValue first (see
      // its comment): a hostile page must not break out of the frame.
      let posted = text;
      const linkInfo = browserLinkInfo();
      if (linkInfo && linkInfo.url) {
        posted = '[Linked browser context — the user has a browser card linked'
          + ' to this conversation, currently showing: '
          + cleanLinkValue(linkInfo.title, 300) + ' — '
          + cleanLinkValue(linkInfo.url, 2000) + ']\n\n' + text;
      }
      const optimistic = addBubble('user', text);
      running = true;
      sendBtn.disabled = true;
      try {
        await ensureSession();
        const body = { method: 'POST', body: JSON.stringify({ message: posted }) };
        let r = await apiJson('/sessions/' + sessionId + '/message', body);
        if (r.status === 404) {
          if (attached) {
            // child session gone mid-conversation — same no-recreate rule
            expired = true;
            const e = new Error('sub-agent session gone');
            e.expired = true;
            throw e;
          }
          // session evicted between turns — recreate once and retry
          untrackSession(sessionId);
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
          : err && err.expired
            ? CHILD_GONE_NOTE
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

    // link.js toggles links inside ITS 'selection:changed' handler and drops
    // entries on 'card:removed'; it loads after this module, so its handlers
    // run after these — defer the read one tick so the note sees the settled
    // state. Guarded like every links access (no-ops when link.js is absent).
    const offLinkSel = A.bus.on('selection:changed', () => { setTimeout(refreshLinkNote, 0); });
    const offLinkRem = A.bus.on('card:removed', () => { setTimeout(refreshLinkNote, 0); });

    // card closed (×, board switch's removeAllCards, or programmatically) →
    // stop polling + free the backend
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      clearTimeout(pollTimer);
      off();
      offLinkSel();
      offLinkRem();
      if (sessionId) {
        untrackSession(sessionId);
        // dismissed BEFORE the async DELETE: a sweep response already in
        // flight can still list this child, and without the set it would be
        // re-revealed as a dead card mid-deletion.
        dismissedSessions.add(sessionId);
        // best-effort: the backend also reclaims leaked sessions via LRU cap.
        // An attached card deletes the CHILD session too — same close
        // semantics as any Agent card; the parent's CheckAgent then reports
        // the child gone, which the backend handles gracefully. ponytail: a
        // detach-without-delete close is the upgrade.
        apiJson('/sessions/' + sessionId, { method: 'DELETE' }).catch(() => {});
      }
    });

    // Mount the shared per-composer model picker (chatcontrols.js, optional).
    // Deferred until the session id exists — the picker POSTs the per-session
    // model endpoint, which needs it. Guarded so a missing module no-ops.
    // Known v1 edge: if the backend evicts and send() recreates the session,
    // the picker keeps the original id in its ctx; a stale POST 404s and the
    // dropdown reverts with a toast (acceptable — recreation is rare).
    function mountChatControls() {
      const cc = window.Atelier && window.Atelier.chatcontrols;
      if (!cc || typeof cc.mount !== 'function' || !sessionId || closed) return;
      cc.mount(composer, { scope: 'session', sessionId, cardEl: card });
    }

    if (attached) {
      // the child is usually mid-turn when revealed — poll right away so the
      // existing transcript renders (renderedCount starts at 0) and the
      // thinking state appears while the spawned task runs.
      poll();
      mountChatControls(); // sessionId is known upfront for attached cards
    } else {
      // create the backend session up front so the card is ready to poll; a
      // failure is fine — ensureSession() retries on the first send.
      ensureSession().then(mountChatControls).catch((err) => {
        setNote(err && err.limit
          ? 'Session limit reached — close an Agent card or wait for a turn to finish, then send.'
          : 'Backend offline — the session will be created when you send.');
      });
    }

    // an auto-revealed child must not yank focus from wherever the user is
    // typing (the sweep spawns it in the background); fresh cards keep it
    if (!attached) ta.focus();
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (palette + spawnApp pick this up) ───────────────
  A.registerApp('agent', {
    label: 'Agent',
    icon: '✳',
    create(worldPos) { return createAgentCard(worldPos); },
  });

  // ── public accessor: window.AtelierSessions (round 17) ────────────────────
  // reveal(sessionId, name) — jump to a session's card. Known id: raise +
  // flash the live card. Unknown id: spawn an attached view at canvas center.
  // Consumers (widget-orbs' orb click) must guard on window.AtelierSessions —
  // this module may be absent from a stripped-down page.
  function flashReveal(el) {
    // restart the outline animation even when the class is still on from a
    // reveal moments ago: drop it, force one reflow, re-add
    el.classList.remove('atl-agent-reveal');
    void el.offsetWidth;
    el.classList.add('atl-agent-reveal');
    const onEnd = (e) => {
      if (e.animationName !== 'atl-agent-reveal-flash') return; // child anims bubble
      el.classList.remove('atl-agent-reveal');
      el.removeEventListener('animationend', onEnd);
    };
    el.addEventListener('animationend', onEnd);
  }

  window.AtelierSessions = {
    reveal(sessionId, name) {
      const id = String(sessionId == null ? '' : sessionId);
      if (!id) return null;
      const existing = cardBySession.get(id);
      if (existing) {
        // raise through core's own path: core listens for mousedown on the
        // card element itself (bringToFront). Non-bubbling on purpose — the
        // bar's drag handler sits on a CHILD (never sees a target dispatch)
        // and the canvas pan/marquee handlers stay out of the picture.
        existing.dispatchEvent(new MouseEvent('mousedown'));
        flashReveal(existing);
        return existing;
      }
      // an explicit reveal is fresh user intent: lift the sweep-suppression
      // flag a past close may have left (see dismissedSessions), or the
      // discovery sweep would fight this card's re-tracking
      dismissedSessions.delete(id);
      // attach path: live view onto the existing backend session — no
      // POST /sessions, 404 renders the expired note instead of recreating.
      // null worldPos -> canvas-center fallback; parentEl is never read.
      const el = createAgentCard(null, {
        id,
        name: String(name || 'Agent'),
        parentEl: null,
      });
      if (el) flashReveal(el);
      return el;
    },
  };

  // ── dock wiring ────────────────────────────────────────────────────────────
  // The ✳ Agent dock button was removed. The 💬 Chat button (wired in apps.js)
  // now spawns agent cards via A.spawnApp('agent'). No Agent-specific dock
  // handler lives in this module anymore.

  // ── board switch ───────────────────────────────────────────────────────────
  // Nothing to do here on purpose. Agent cards are ordinary addCard cards, so
  // boards' in-place switch closes them at its canvas.removeAllCards() step
  // (AFTER the snapshot quota gate) and each card's card:removed handler above
  // does the full teardown: stop poll, untrack, mark dismissed, best-effort
  // DELETE, arrows unlink. An earlier 'boards:will-switch' close was removed —
  // it fired BEFORE the quota gate, so a switch that aborted on the "storage
  // is full" toast (board unchanged) had already destroyed every agent
  // conversation on both sides. Nothing to flush either: this module never
  // writes board-scoped store keys.

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('agent');
    console.assert(registered, '[sessions] agent app type not registered');
    // The ✳ Agent button was removed; 💬 Chat (apps.js) now spawns agents.
    const dockLabel = (b) => (b.getAttribute('data-tip') || b.getAttribute('title') || '').toLowerCase();
    const noAgentBtn = !Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => dockLabel(b) === 'agent');
    console.assert(noAgentBtn, '[sessions] stale ✳ Agent dock button still present');
    const chatBtn = Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => dockLabel(b) === 'chat');
    console.assert(chatBtn, '[sessions] Chat dock button missing from index.html');
    const sweepIdle = cardBySession.size === 0 && sweepTimer === null;
    console.assert(sweepIdle,
      '[sessions] child sweep must stay idle until a card owns a session');
    // link.js loads AFTER this module, so Atelier.links is normally absent
    // here — that is the guarded path send() and handleBrowserNav must
    // survive. If some load-order change put it first, it must expose both
    // accessors this module calls (browserFor in send, browserElFor in the
    // r16 nav handler).
    const linksOk = !A.links ||
      (typeof A.links.browserFor === 'function' &&
       typeof A.links.browserElFor === 'function');
    console.assert(linksOk,
      '[sessions] Atelier.links present but missing browserFor()/browserElFor()');
    // r17 accessor: the surface widget-orbs guards on must exist with the
    // exact shape the contract names, and the flash class must be injected
    const accessorOk = !!window.AtelierSessions
      && typeof window.AtelierSessions.reveal === 'function';
    console.assert(accessorOk, '[sessions] AtelierSessions.reveal missing');
    const flashCssOk = /atl-agent-reveal-flash/
      .test((document.getElementById('atl-sessions-styles') || {}).textContent || '');
    console.assert(flashCssOk, '[sessions] reveal flash keyframes not injected');
    if (registered && noAgentBtn && chatBtn && sweepIdle && linksOk && accessorOk && flashCssOk) {
      console.log('[sessions] self-check passed — agent app registered, '
        + '✳ button removed (💬 Chat spawns agents), child sweep idle, '
        + 'links access guarded, AtelierSessions.reveal published.');
    }
  })();
})();
