'use strict';

/* ===========================================================================
   Atelier feature module — external agents   (app/external.js)

   Connect an agent that runs OUTSIDE Atelier's own backend — Iris, Hermes,
   OpenClaw, or any OpenAI-compatible chat endpoint — as a first-class canvas
   chat card. The external service does its own work (and guides its own
   sub-agents there); Atelier just shows the conversation.

   Two pieces:
     • A MANAGER panel (⌘K → "Manage external agents…", or the card's picker →
       "Manage agents…") to add/edit/delete connections. Each connection =
       {name, base_url, api_key?, model?} stored server-side
       (~/.atelier/external_agents.json, 0600). The key never comes back to the
       UI (only a last-4 hint) — same contract as the Anthropic key.
     • An EXTERNAL AGENT card (⌘K → Add app: External agent, or /external): a
       chat card with a small agent PICKER at the top. Pick a configured agent
       and every message is forwarded to it via the backend
       (POST /external/agents/{id}/message {message, history}) and its reply is
       shown as a bubble.

   The card reuses the Agent card's body classes (.atl-agent-msgs / -composer /
   -bubble) so it matches the native cards AND the "/" slash menu works inside
   it. Its OUTER class is .atl-ext-card (NOT .atl-agent-card) so govern.js and
   the sub-agent discovery sweep — which key on .atl-agent-card — leave it be.

   Persistence mirrors document.js/loopcard.js: board-scoped A.store, instances
   Map, idempotent restore, will-switch flush. The card stores its position +
   the chosen agent id; the conversation is page-session DOM like Agent cards.

   Contract: builds ONLY against window.Atelier + fetch (+ the optional
   window.atelier token bridge). Injects its own CSS. XSS rule: every
   server-/user-derived string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store || !A.ui) {
    console.warn('[external] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.external';
  const CARD_W = 380;
  const CARD_H = 460;
  const MANAGE = '__manage';

  // Preset hints for the manager form — all speak the 'openai' adapter today;
  // the preset only PREFILLS empty base_url/model fields as a convenience.
  const PRESETS = {
    iris: { label: 'Iris', base: 'http://HOST:PORT/v1', model: '' },
    hermes: { label: 'Hermes', base: 'http://HOST:PORT/v1', model: '' },
    openclaw: { label: 'OpenClaw', base: 'http://HOST:PORT/v1', model: '' },
    openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama: { label: 'Ollama (local)', base: 'http://127.0.0.1:11434/v1', model: 'llama3' },
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function api(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    let res;
    try {
      res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
    } catch {
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  }

  (function injectStyles() {
    if (document.getElementById('atl-ext-styles')) return;
    const css = `
      .atl-ext-body { display: flex; flex-direction: column; height: 100%; }
      .atl-ext-pick { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border-bottom: 1px solid var(--border-soft); }
      .atl-ext-sel { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 8px;
        padding: 6px 9px; font: inherit; font-size: 12.5px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-ext-sel:focus { border-color: var(--accent); }
      .atl-ext-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--ink-dim); border: 1px solid var(--border); border-radius: 6px; padding: 1px 5px;
        white-space: nowrap; }
      .atl-ext-empty { padding: 16px; font-size: 12.5px; color: var(--ink-dim); text-align: center;
        line-height: 1.5; }
      .atl-ext-empty button { margin-top: 8px; }

      .atl-xm-wrap { display: flex; flex-direction: column; gap: 16px; width: 360px; }
      .atl-xm-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; }
      .atl-xm-list { display: flex; flex-direction: column; gap: 6px; max-height: 210px; overflow-y: auto; }
      .atl-xm-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border: 1px solid var(--border); border-radius: 9px; background: var(--panel); }
      .atl-xm-row .nm { font-size: 13px; font-weight: 600; color: var(--ink); }
      .atl-xm-row .meta { font-size: 11px; color: var(--ink-dim); flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-xm-form { display: flex; flex-direction: column; gap: 8px;
        border-top: 1px solid var(--border-soft); padding-top: 12px; }
      .atl-xm-in, .atl-xm-sel { border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1; outline: none;
        width: 100%; box-sizing: border-box; }
      .atl-xm-in:focus, .atl-xm-sel:focus { border-color: var(--accent); }
      .atl-xm-inrow { display: flex; gap: 8px; }
      .atl-xm-btn { border: 1px solid var(--border); border-radius: 7px; background: #faf7f1;
        color: var(--ink-mid); font: inherit; font-size: 11px; padding: 4px 8px; cursor: pointer; }
      .atl-xm-btn:hover { border-color: var(--accent); }
      .atl-xm-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .atl-xm-save { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-xm-save:hover { background: var(--accent-2); }
      .atl-xm-note { font-size: 11.5px; color: var(--ink-dim); line-height: 1.4; }
      .atl-xm-note.err { color: var(--accent); }
      .atl-xm-note:empty { display: none; }
      .atl-xm-hint { font-size: 11px; color: var(--ink-dim); line-height: 1.4; }
    `;
    const style = el('style');
    style.id = 'atl-ext-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── shared agent-list cache (one fetch feeds every card + the manager) ──────
  let agentCache = null; // [{id,name,base_url,model,adapter,key_present,key_hint}]
  async function fetchAgents(force) {
    if (agentCache && !force) return agentCache;
    const r = await api('/external/agents', { method: 'GET' });
    agentCache = (r.ok && r.data && Array.isArray(r.data.agents)) ? r.data.agents : [];
    return agentCache;
  }
  function agentsChanged() {
    fetchAgents(true).then(() => {
      instances.forEach((inst) => populatePicker(inst));
      A.bus.emit('external:agents-changed');
    });
  }

  /* =========================================================================
     THE MANAGER PANEL
     ========================================================================= */
  let mgr = null;      // control refs for the single open manager
  let mgrPanel = null; // singleton handle

  function setMgrNote(text, isErr) {
    if (!mgr) return;
    mgr.note.textContent = text || '';
    mgr.note.classList.toggle('err', !!isErr);
  }

  function renderMgrList() {
    if (!mgr) return;
    const list = mgr.list;
    list.textContent = '';
    const agents = agentCache || [];
    if (!agents.length) {
      list.appendChild(el('div', 'atl-xm-hint', 'No external agents yet. Add one below — e.g. your Iris or an OpenAI-compatible endpoint.'));
      return;
    }
    agents.forEach((a) => {
      const row = el('div', 'atl-xm-row');
      row.appendChild(el('span', 'nm', a.name));
      const meta = a.base_url + (a.model ? ' · ' + a.model : '') + (a.key_present ? ' · key ' + a.key_hint : '');
      row.appendChild(el('span', 'meta', meta));
      const edit = el('button', 'atl-xm-btn', 'Edit');
      const del = el('button', 'atl-xm-btn', 'Delete');
      edit.addEventListener('click', () => loadIntoForm(a));
      del.addEventListener('click', async () => {
        await api('/external/agents/' + encodeURIComponent(a.id), { method: 'DELETE' });
        if (mgr && mgr.editing === a.id) loadIntoForm(null);
        await fetchAgents(true);
        renderMgrList();
        setMgrNote('Deleted ' + a.name + '.', false);
        instances.forEach((inst) => populatePicker(inst));
        A.bus.emit('external:agents-changed');
      });
      row.append(edit, del);
      list.appendChild(row);
    });
  }

  function loadIntoForm(a) {
    if (!mgr) return;
    mgr.editing = a ? a.id : null;
    mgr.name.value = a ? a.name : '';
    mgr.url.value = a ? a.base_url : '';
    mgr.model.value = a && a.model ? a.model : '';
    mgr.key.value = '';
    mgr.key.placeholder = a && a.key_present ? 'key set (' + a.key_hint + ') — leave blank to keep' : 'API key (optional)';
    setMgrNote(a ? 'Editing ' + a.name + '.' : '', false);
    mgr.name.focus();
  }

  async function saveForm() {
    if (!mgr) return;
    const name = String(mgr.name.value || '').trim();
    if (!name) { setMgrNote('Give the agent a name.', true); return; }
    const url = String(mgr.url.value || '').trim();
    if (!/^https?:\/\/.+/i.test(url)) { setMgrNote('Base URL must start with http:// or https://', true); return; }
    const payload = { name, base_url: url, model: String(mgr.model.value || '').trim(), adapter: 'openai' };
    if (mgr.editing) payload.id = mgr.editing;
    const key = String(mgr.key.value || '');
    if (key) payload.api_key = key;
    mgr.saveBtn.disabled = true;
    const r = await api('/external/agents', { method: 'POST', body: JSON.stringify(payload) });
    mgr.saveBtn.disabled = false;
    if (r.status === 0) { setMgrNote('Backend unreachable — is Atelier running?', true); return; }
    if (!r.ok) { setMgrNote((r.data && r.data.error) ? String(r.data.error) : 'Save failed.', true); return; }
    await fetchAgents(true);
    loadIntoForm(null);
    setMgrNote('Saved ' + name + '.', false);
    renderMgrList();
    instances.forEach((inst) => populatePicker(inst));
    A.bus.emit('external:agents-changed');
  }

  function syncPreset() {
    if (!mgr) return;
    const p = PRESETS[mgr.preset.value];
    if (!p) return;
    if (!mgr.url.value.trim()) mgr.url.value = p.base;
    if (!mgr.model.value.trim() && p.model) mgr.model.value = p.model;
  }

  function buildManagerBody() {
    const wrap = el('div', 'atl-xm-wrap');
    const list = el('div', 'atl-xm-list');

    const form = el('div', 'atl-xm-form');
    form.appendChild(el('div', 'atl-xm-title', 'Add / edit a connection'));

    const preset = document.createElement('select');
    preset.className = 'atl-xm-sel';
    preset.appendChild(new Option('Preset (prefills the fields)…', ''));
    Object.keys(PRESETS).forEach((k) => preset.appendChild(new Option(PRESETS[k].label, k)));

    const row1 = el('div', 'atl-xm-inrow');
    const name = document.createElement('input');
    name.className = 'atl-xm-in'; name.type = 'text'; name.placeholder = 'Name (e.g. Iris)'; name.maxLength = 80;
    const model = document.createElement('input');
    model.className = 'atl-xm-in'; model.type = 'text'; model.placeholder = 'model (optional)'; model.maxLength = 120;
    row1.append(name, model);

    const url = document.createElement('input');
    url.className = 'atl-xm-in'; url.type = 'text'; url.placeholder = 'Base URL, e.g. http://127.0.0.1:5000/v1'; url.maxLength = 2000;

    const key = document.createElement('input');
    key.className = 'atl-xm-in'; key.type = 'password'; key.placeholder = 'API key (optional)'; key.maxLength = 4000;
    key.autocomplete = 'off';

    const hint = el('div', 'atl-xm-hint', 'Speaks the OpenAI chat-completions shape (POST {base}/chat/completions). Works with Iris, Hermes, OpenClaw, Ollama, or any OpenAI-compatible server.');
    const note = el('div', 'atl-xm-note');
    const actions = el('div', 'atl-xm-actions');
    const clearBtn = el('button', 'atl-xm-btn', 'Clear form');
    const saveBtn = el('button', 'atl-xm-save', 'Save connection');
    actions.append(clearBtn, saveBtn);

    form.append(preset, row1, url, key, hint, note, actions);
    wrap.append(list, form);

    mgr = { list, note, preset, name, url, model, key, saveBtn, editing: null };
    preset.addEventListener('change', syncPreset);
    clearBtn.addEventListener('click', () => loadIntoForm(null));
    saveBtn.addEventListener('click', saveForm);

    fetchAgents(true).then(() => renderMgrList());
    return wrap;
  }

  function openManager() {
    if (mgrPanel && mgrPanel.el && document.body.contains(mgrPanel.el)) {
      const x = mgrPanel.el.querySelector('.card-x');
      if (x && x.scrollIntoView) x.scrollIntoView({ block: 'nearest' });
      return;
    }
    const body = buildManagerBody();
    mgrPanel = A.ui.openPanel('External agents', body);
    if (mgrPanel && mgrPanel.el) {
      const x = mgrPanel.el.querySelector('.card-x');
      if (x) x.addEventListener('click', () => { mgr = null; mgrPanel = null; });
    }
  }

  /* =========================================================================
     ONE EXTERNAL AGENT CARD
     ========================================================================= */
  const instances = new Map();
  let restoring = false;
  let dragId = null;
  let extSeq = 0;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const r = inst.handle.getRect();
      arr.push({ id: inst.id, x: r.x, y: r.y, w: r.w, h: r.h, agentId: inst.agentId || '' });
    });
    A.store.set(STORE_KEY, arr);
  }

  function setNote(inst, text, isErr) {
    inst.note.textContent = text || '';
    inst.note.style.color = isErr ? 'var(--accent)' : 'var(--ink-dim)';
  }

  function addBubble(inst, role, text) {
    const row = el('div', 'atl-agent-row ' + (role === 'user' ? 'user' : 'assistant'));
    const av = el('div', 'atl-agent-avatar', role === 'user' ? 'You' : '↯');
    const b = el('div', 'atl-agent-bubble', text);
    row.append(av, b);
    inst.msgs.appendChild(row);
    inst.msgs.scrollTop = inst.msgs.scrollHeight;
    return row;
  }
  function addThinking(inst) {
    const row = addBubble(inst, 'assistant', 'thinking…');
    row.querySelector('.atl-agent-bubble').classList.add('thinking');
    return row;
  }

  function currentAgent(inst) {
    return (agentCache || []).find((a) => a.id === inst.agentId) || null;
  }

  function setTitle(inst) {
    const a = currentAgent(inst);
    inst.titleEl.textContent = a ? a.name : 'External agent';
  }

  function populatePicker(inst) {
    const sel = inst.picker;
    const agents = agentCache || [];
    const prev = inst.agentId || '';
    sel.textContent = '';
    sel.appendChild(new Option(agents.length ? 'Choose an agent…' : 'No agents — add one…', ''));
    agents.forEach((a) => {
      const o = new Option(a.name, a.id);
      sel.appendChild(o);
    });
    sel.appendChild(new Option('Manage agents…', MANAGE));
    // keep the current binding if it still exists; else clear it
    if (prev && agents.some((a) => a.id === prev)) sel.value = prev;
    else { sel.value = ''; if (prev) inst.agentId = ''; }
    setTitle(inst);
    updateComposerState(inst);
  }

  function updateComposerState(inst) {
    const hasAgent = !!inst.agentId;
    inst.ta.disabled = !hasAgent;
    inst.sendBtn.disabled = !hasAgent || inst.running;
    // lock the picker mid-turn: switching agents while a reply is in flight
    // would drop the reply into the wrong thread and desync history.
    if (inst.picker) inst.picker.disabled = inst.running;
    inst.ta.placeholder = hasAgent
      ? 'Message ' + (currentAgent(inst) ? currentAgent(inst).name : 'agent') + '…'
      : 'Pick an agent above to start…';
  }

  // hand the failed message back ONLY if the composer is still empty — the user
  // may have started typing the next message while this turn was in flight, and
  // clobbering that would lose their text.
  // size the composer to its content (capped 120px): collapses to one row when
  // cleared, re-fits when the value is restored.
  function growComposer(ta) {
    if (!ta.value) { ta.style.height = ''; return; } // empty -> exact CSS one-row height
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }
  function refillOnFailure(inst, text) {
    if (!inst.ta.value.trim()) { inst.ta.value = text; growComposer(inst.ta); }
  }

  async function send(inst) {
    const text = inst.ta.value.trim();
    if (!text || inst.running) return;
    if (!inst.agentId) { setNote(inst, 'Pick an agent to connect to first.', true); return; }
    const boundAgent = inst.agentId; // pin the target for this whole turn
    inst.ta.value = '';
    growComposer(inst.ta); // collapse back to one row after sending
    setNote(inst, '');
    addBubble(inst, 'user', text);
    inst.history.push({ role: 'user', content: text });
    inst.running = true;
    updateComposerState(inst); // also disables the picker for the turn
    const thinking = addThinking(inst);
    // server appends `message` itself, so send the PRIOR turns as history.
    const priorHistory = inst.history.slice(0, -1);
    const r = await api('/external/agents/' + encodeURIComponent(boundAgent) + '/message', {
      method: 'POST',
      body: JSON.stringify({ message: text, history: priorHistory }),
    });
    thinking.remove();
    inst.running = false;
    updateComposerState(inst);
    // Guard: if the card was rebound to a different agent while awaiting (should
    // be impossible now the picker is locked, but belt-and-braces), do not fold
    // this reply into the new thread.
    if (inst.agentId !== boundAgent) return;
    if (r.status === 0) {
      setNote(inst, 'Backend unreachable — is Atelier running?', true);
      inst.history.pop(); refillOnFailure(inst, text);
      return;
    }
    if (!r.ok || !r.data || typeof r.data.response !== 'string') {
      const why = (r.data && r.data.error) ? String(r.data.error) : 'The external agent did not respond.';
      setNote(inst, why, true);
      inst.history.pop(); refillOnFailure(inst, text);
      return;
    }
    addBubble(inst, 'assistant', r.data.response);
    inst.history.push({ role: 'assistant', content: r.data.response });
  }

  function render(inst) {
    const body = inst.bodyEl;
    body.textContent = '';

    const pick = el('div', 'atl-ext-pick');
    const picker = document.createElement('select');
    picker.className = 'atl-ext-sel';
    pick.appendChild(picker);
    pick.appendChild(el('span', 'atl-ext-badge', 'external'));

    const msgs = el('div', 'atl-agent-msgs');
    const note = el('div', 'atl-agent-note');
    const composer = el('div', 'atl-agent-composer');
    const ta = document.createElement('textarea');
    ta.rows = 1;
    const sendBtn = el('button', 'atl-agent-send', '➤');
    sendBtn.type = 'button'; sendBtn.title = 'Send';
    composer.append(ta, sendBtn);

    body.append(pick, msgs, note, composer);

    inst.picker = picker; inst.msgs = msgs; inst.note = note; inst.ta = ta; inst.sendBtn = sendBtn;

    picker.addEventListener('change', () => {
      if (picker.value === MANAGE) {
        picker.value = inst.agentId || '';
        openManager();
        return;
      }
      inst.agentId = picker.value || '';
      inst.history = []; msgs.textContent = ''; // switching agents starts a fresh thread
      setTitle(inst);
      updateComposerState(inst);
      persist();
    });
    sendBtn.addEventListener('click', () => send(inst));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inst); }
    });
    ta.addEventListener('input', () => growComposer(ta));

    populatePicker(inst);
  }

  function spawnCard(opts = {}) {
    const id = opts.id || ('ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const card = el('section', 'card app-card atl-ext-card');
    card.dataset.extInstance = id;
    const bar = el('div', 'card-bar');
    const title = el('span', 'card-title', 'External agent');
    bar.append(el('span', 'card-dot'), title, el('span', 'card-x', '×'));
    const body = el('div', 'app-body atl-ext-body');
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
    const inst = { id, handle, bodyEl: body, titleEl: title, agentId: opts.agentId || '',
      history: [], running: false };
    instances.set(id, inst);

    card.addEventListener('mousedown', () => { dragId = id; }, true);
    // ensure the shared cache is warm, THEN render (picker needs it)
    fetchAgents().then(() => { render(inst); });
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
    const rid = node && node.dataset && node.dataset.extInstance;
    if (!rid || !instances.has(rid)) return;
    instances.delete(rid);
    persist();
  });

  function restoreFromStore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    restoring = true;
    try {
      saved.forEach((rec) => {
        if (!rec || !rec.id || instances.has(rec.id)) return;
        spawnCard({
          id: String(rec.id),
          rect: { x: Number(rec.x) || 0, y: Number(rec.y) || 0,
            w: Number(rec.w) || CARD_W, h: Number(rec.h) || CARD_H },
          agentId: rec.agentId || '',
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
      instances.delete(id);
    });
    restoreFromStore();
  });

  A.registerApp('external', {
    label: 'External agent',
    icon: '⇄',
    create(worldPos) {
      const inst = spawnCard(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  // ⌘K entry for the manager (mirrors the slash-commands manager entry)
  A.bus.emit('palette:add', {
    id: 'external.manage', label: 'Manage external agents…', icon: '⇄', section: 'App',
    keywords: 'external agent iris hermes openclaw connect remote openai',
    run() { openManager(); },
  });

  window.AtelierExternal = { spawn: spawnCard, openManager, instances, STORE_KEY };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('external');
    console.assert(registered, '[external] external app type not registered');
    if (registered) console.log('[external] ready — External agent card registered (⌘K → Add app: External agent).');
  })();
})();
