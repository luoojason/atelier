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

  // Preset hints for the manager form — every one speaks the OpenAI-compatible
  // /chat/completions protocol with a Bearer api_key, which is what forward()
  // sends, so all of these "just work" once you add your key. The preset only
  // PREFILLS the base_url + a sensible default model; edit the model freely
  // (provider model names change often). Cloud providers need YOUR api_key
  // (a paid DEVELOPER API key for that service, billed per token — NOT a
  // consumer chat subscription like ChatGPT Plus, which has no API); local
  // ones (Ollama/LM Studio) usually need no key.
  // Each preset prefills base_url + a default `model`, and `models` seeds the
  // model field's suggestion list so you pick THAT provider's models (a GPT
  // connection can't run Claude models, so it offers gpt-* etc.). The field
  // stays free text — provider model names change often and local models vary,
  // so any string is still allowed; the list is guidance, not a lock.
  const PRESETS = {
    // ── cloud providers (bring your own developer API key, billed per token) ──
    openai: { label: 'OpenAI · metered (your key)', base: 'https://api.openai.com/v1', model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'] },
    gemini: { label: 'Google Gemini · metered (your key)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash',
      models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
    xai: { label: 'xAI (Grok) · metered (your key)', base: 'https://api.x.ai/v1', model: 'grok-2-latest',
      models: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'] },
    deepseek: { label: 'DeepSeek · metered (your key)', base: 'https://api.deepseek.com', model: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'] },
    mistral: { label: 'Mistral · metered (your key)', base: 'https://api.mistral.ai/v1', model: 'mistral-large-latest',
      models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'] },
    groq: { label: 'Groq · metered (your key)', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'] },
    together: { label: 'Together AI · metered (your key)', base: 'https://api.together.xyz/v1', model: '',
      models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'mistralai/Mistral-Nemo-Instruct-2407'] },
    openrouter: { label: 'OpenRouter (any model) · metered (your key)', base: 'https://openrouter.ai/api/v1', model: '',
      models: ['openai/gpt-4o', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat'] },
    perplexity: { label: 'Perplexity · metered (your key)', base: 'https://api.perplexity.ai', model: 'sonar',
      models: ['sonar', 'sonar-pro', 'sonar-reasoning'] },
    // ── local / self-hosted ── (a tool-capable model so the Tools toggle works;
    // the base 'llama3' template can't do tool calls)
    ollama: { label: 'Ollama (local) · free', base: 'http://127.0.0.1:11434/v1', model: 'llama3.1',
      models: ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral-nemo'] },
    lmstudio: { label: 'LM Studio (local) · free', base: 'http://127.0.0.1:1234/v1', model: '',
      models: ['qwen2.5-7b-instruct', 'llama-3.1-8b-instruct'] },
    // ── your own agents ── (model is whatever your endpoint serves)
    iris: { label: 'Iris', base: 'http://HOST:PORT/v1', model: '', models: [] },
    hermes: { label: 'Hermes', base: 'http://HOST:PORT/v1', model: '', models: [] },
    openclaw: { label: 'OpenClaw', base: 'http://HOST:PORT/v1', model: '', models: [] },
    openaicompat: { label: 'Other OpenAI-compatible…', base: 'https://', model: '', models: [] },
  };

  // A preset whose base_url matches this one (so an EDIT of an existing agent
  // can also show that provider's model suggestions). Trailing slashes ignored.
  function presetForBase(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    return Object.values(PRESETS).find((p) => p.base.replace(/\/+$/, '') === u) || null;
  }

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
      .atl-ext-tools { display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
        color: var(--ink-dim); cursor: pointer; user-select: none; white-space: nowrap; }
      .atl-ext-tools.disabled { opacity: .45; cursor: not-allowed; }
      .atl-ext-tools input { margin: 0; cursor: inherit; }
      .atl-ext-steps { display: flex; flex-direction: column; gap: 3px; margin: 2px 0 6px 34px; }
      .atl-ext-step { display: flex; align-items: baseline; gap: 6px; font-size: 11px;
        color: var(--ink-dim); background: #faf7f1; border: 1px solid var(--border-soft);
        border-radius: 7px; padding: 3px 8px; }
      .atl-ext-step-ic { opacity: .7; }
      .atl-ext-step-nm { font-weight: 600; color: var(--ink-mid); white-space: nowrap; }
      .atl-ext-step-res { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .8; }

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
      .atl-xm-chip { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--accent-2); border: 1px solid var(--accent-soft); background: var(--accent-soft);
        border-radius: 6px; padding: 1px 6px; white-space: nowrap; font-weight: 700; }
      .atl-xm-chip.free { color: var(--ok); border-color: rgba(63, 166, 106, .25); background: rgba(63, 166, 106, .12); }

      .atl-ext-consent { display: flex; flex-direction: column; gap: 10px; width: 380px; }
      .atl-ext-consent p { margin: 0; font-size: 13px; color: var(--ink-mid); line-height: 1.5; }
      .atl-ext-consent .host { font-weight: 700; color: var(--ink); }
      .atl-ext-consent-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .atl-ext-consent-allow { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-ext-consent-allow:hover { background: var(--accent-2); }
      .atl-ext-consent-cancel { border: 1px solid var(--border); border-radius: 9px; background: #faf7f1;
        color: var(--ink-mid); font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; }
      .atl-ext-consent-cancel:hover { border-color: var(--accent); }
      .atl-ext-grants { display: flex; flex-direction: column; gap: 6px; }
      .atl-ext-grant { display: flex; align-items: baseline; gap: 8px; cursor: pointer; }
      .atl-ext-grant input { margin: 0; cursor: inherit; }
      .atl-ext-grant-txt { display: flex; gap: 6px; align-items: baseline; font-size: 12.5px; }
      .atl-ext-grant-nm { font-weight: 600; color: var(--ink); }
      .atl-ext-grant-what { color: var(--ink-mid); font-size: 11.5px; }
      .atl-xm-grants-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; margin-top: 2px; }
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
    // Cache only SUCCESS. Caching a failure as [] poisons every picker for the
    // rest of the session — restored cards fetch at module boot, which can race
    // the backend still binding :8765, and the stuck empty cache then hides all
    // agents until a manager action happens to force a refetch.
    if (r.ok && r.data && Array.isArray(r.data.agents)) agentCache = r.data.agents;
    return agentCache || [];
  }
  function agentsChanged() {
    fetchAgents(true).then(() => {
      instances.forEach((inst) => populatePicker(inst));
      A.bus.emit('external:agents-changed');
    });
  }

  // Persist an agent's tools_enabled flag (a blank api_key keeps the stored key).
  // tools_enabled lives ON the agent, not the card, so every card bound to the
  // same agent shares the setting. Returns true on success.
  async function setAgentTools(agent, on, grants) {
    const payload = {
      id: agent.id, name: agent.name, base_url: agent.base_url,
      model: agent.model || '', adapter: agent.adapter || 'openai',
      tools_enabled: !!on,
    };
    if (grants) payload.tool_grants = grants; // omitted -> stored grants kept
    const r = await api('/external/agents', { method: 'POST', body: JSON.stringify(payload) });
    if (r.ok) await fetchAgents(true);
    return r.ok;
  }

  // ── one-time tools consent (per provider HOST, stored globally) ─────────────
  // Turning tools ON means every tool result — vault notes, workspace file
  // contents, web pages — is sent to the agent's provider as conversation
  // context. That egress must be consented to once per host, by name, before
  // the first enable; the choice is remembered globally (boards.js GLOBAL_KEYS)
  // so the user is not re-asked per card or per board.
  const TOOLS_CONSENT_KEY = 'atelier.ext.tools.consent';

  function agentHost(agent) {
    const raw = String((agent && agent.base_url) || '');
    try { return new URL(raw).host || raw; } catch { return raw; }
  }
  function toolsConsented(host) {
    const m = A.store.get(TOOLS_CONSENT_KEY, {});
    return !!(m && typeof m === 'object' && m[host]);
  }
  function recordToolsConsent(host) {
    const m = A.store.get(TOOLS_CONSENT_KEY, {});
    const next = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    next[host] = true;
    A.store.set(TOOLS_CONSENT_KEY, next);
  }

  // The grantable tool families (mirrors external_agents.GRANT_KEYS). What a
  // family can DO is spelled out so the consent is informed, not a label.
  const GRANT_FAMILIES = [
    ['files', 'Files', 'write and read files in the workspace'],
    ['vault', 'Vault & Notion', 'read and write your notes'],
    ['web', 'Web', 'search and fetch pages'],
    ['memory', 'Memory', 'remember facts and track campaigns'],
  ];

  function grantCheckboxes(current) {
    const wrap = el('div', 'atl-ext-grants');
    const boxes = {};
    GRANT_FAMILIES.forEach(([key, label, what]) => {
      const lab = el('label', 'atl-ext-grant');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !current || current[key] !== false;
      cb.setAttribute('aria-label', label + ': ' + what);
      boxes[key] = cb;
      const txt = el('span', 'atl-ext-grant-txt');
      txt.append(el('span', 'atl-ext-grant-nm', label), el('span', 'atl-ext-grant-what', what));
      lab.append(cb, txt);
      wrap.appendChild(lab);
    });
    return {
      el: wrap,
      read: () => {
        const out = {};
        GRANT_FAMILIES.forEach(([key]) => { out[key] = !!boxes[key].checked; });
        return out;
      },
      set: (grants) => {
        GRANT_FAMILIES.forEach(([key]) => {
          boxes[key].checked = !grants || grants[key] !== false;
        });
      },
    };
  }

  // Consent panel. XSS rule: host + agent name enter the DOM via textContent
  // only (el() sets textContent). Closing any way other than "Allow" leaves
  // tools OFF — the toggle was already reset before the panel opened.
  let consentPanel = null;
  function openToolsConsent(agent, onAllow) {
    if (consentPanel) { try { consentPanel.close(); } catch { /* already gone */ } }
    const host = agentHost(agent) || 'this provider';
    const wrap = el('div', 'atl-ext-consent');
    const p1 = el('p', '');
    p1.append(
      document.createTextNode('Tools let "' + String(agent.name || 'this agent') + '" write files in the workspace, read and write your vault and memory, and search the web.')
    );
    const p2 = el('p', '');
    p2.append(
      document.createTextNode('Everything a tool returns, including vault notes and file contents, is sent to '),
      el('span', 'host', host),
      document.createTextNode(' as part of the conversation, under that provider\'s terms.')
    );
    const grants = grantCheckboxes(agent.tool_grants);
    const row = el('div', 'atl-ext-consent-row');
    const cancel = el('button', 'atl-ext-consent-cancel', 'Not now');
    const allow = el('button', 'atl-ext-consent-allow', 'Allow and turn on');
    cancel.type = 'button'; allow.type = 'button';
    row.append(cancel, allow);
    wrap.append(p1, p2, grants.el, row);
    const panel = A.ui.openPanel('Send data to ' + host + '?', wrap, { backdrop: true });
    consentPanel = panel;
    cancel.addEventListener('click', () => { panel.close(); consentPanel = null; });
    allow.addEventListener('click', () => {
      recordToolsConsent(host);
      panel.close();
      consentPanel = null;
      onAllow(grants.read());
    });
  }

  // Persist + reflect a tools_enabled change (shared by the direct toggle path
  // and the consent panel's Allow).
  async function applyToolsSetting(inst, agent, on, grants) {
    const cb = inst.toolsCb;
    if (cb) { cb.checked = on; cb.disabled = true; }
    const ok = await setAgentTools(agent, on, grants);
    if (cb) cb.disabled = false;
    if (!ok) {
      if (cb) cb.checked = !on;
      setNote(inst, 'Could not save the tools setting.', true);
      updateToolsToggle(inst);
      return;
    }
    // tools_enabled lives on the AGENT, so refresh every card bound to it —
    // otherwise a sibling card would route its next turn on a stale toggle.
    instances.forEach((i) => updateToolsToggle(i));
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

  // Repopulate the model field's suggestion list with a provider's models.
  function setModelSuggestions(models) {
    if (!mgr || !mgr.modelList) return;
    mgr.modelList.textContent = '';
    (models || []).forEach((m) => mgr.modelList.appendChild(new Option(m)));
  }

  function renderMgrList() {
    if (!mgr) return;
    const list = mgr.list;
    list.textContent = '';
    const agents = agentCache || [];
    if (!agents.length) {
      list.appendChild(el('div', 'atl-xm-hint', 'No outside assistants yet. Add one below to run a card on another provider — OpenAI, Gemini, Groq, a local model, your own Iris, or any OpenAI-compatible service.'));
      return;
    }
    agents.forEach((a) => {
      const row = el('div', 'atl-xm-row');
      row.appendChild(el('span', 'nm', a.name));
      // cost-class chip (review quick win): who pays when this card runs.
      // Same loopback rule as the backend's spend meter (spend.is_metered).
      let chipHost = '';
      try { chipHost = new URL(a.base_url).hostname.toLowerCase(); } catch { /* odd URL -> metered */ }
      const isLocal = chipHost === 'localhost' || chipHost === '::1' || /^127\./.test(chipHost);
      const chip = el('span', 'atl-xm-chip' + (isLocal ? ' free' : ''), isLocal ? 'Free · local' : 'Metered · your key');
      row.appendChild(chip);
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
    mgr.grants.set(a ? a.tool_grants : null);
    setModelSuggestions((presetForBase(a && a.base_url) || {}).models || []);
    mgr.key.value = '';
    mgr.key.placeholder = a && a.key_present ? 'key set (' + a.key_hint + ') — leave blank to keep' : 'API key (optional)';
    setMgrNote(a ? 'Editing ' + a.name + '.' : '', false);
    mgr.name.focus();
  }

  // Wrong-paste detection: the review's day-one failure mode is pasting a
  // chat login, email, URL, or the WRONG provider's key into the key field
  // and then hitting a baffling 401 later. Warn at save time on confident
  // mismatches only; a second Save with the same value keeps it anyway
  // (proxies exist, so nothing is hard-blocked).
  function keyPasteWarning(key, baseUrl) {
    const k = key.trim();
    if (!k) return null;
    let host = '';
    try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* checked later */ }
    if (k.split(/\s+/).length > 1) {
      return 'That looks like more than one value (it has spaces or line breaks). Paste just the key.';
    }
    if (k.includes('@')) return 'That looks like an email address, not an API key.';
    if (/^https?:\/\//i.test(k)) return 'That looks like a URL, not an API key.';
    const mismatches = [
      [/^sk-ant-/, /anthropic\./, 'an Anthropic key (sk-ant-…)'],
      [/^AIza/, /googleapis\./, 'a Google key (AIza…)'],
      [/^gsk_/, /groq\./, 'a Groq key (gsk_…)'],
      [/^xai-/, /(^|\.)x\.ai$/, 'an xAI key (xai-…)'],
      [/^pplx-/, /perplexity\./, 'a Perplexity key (pplx-…)'],
      [/^sk-or-/, /openrouter\./, 'an OpenRouter key (sk-or-…)'],
    ];
    for (const [keyRe, hostRe, label] of mismatches) {
      if (keyRe.test(k) && host && !hostRe.test(host)) {
        return 'That looks like ' + label + ', but this connection points at ' + host + '.';
      }
    }
    if (k.length < 20) {
      return 'That looks too short to be an API key. Keys come from the provider\'s developer console, not your chat login.';
    }
    return null;
  }

  async function saveForm() {
    if (!mgr) return;
    const name = String(mgr.name.value || '').trim();
    if (!name) { setMgrNote('Give the agent a name.', true); return; }
    const url = String(mgr.url.value || '').trim();
    if (!/^https?:\/\/.+/i.test(url)) { setMgrNote('Base URL must start with http:// or https://', true); return; }
    const payload = { name, base_url: url, model: String(mgr.model.value || '').trim(), adapter: 'openai' };
    payload.tool_grants = mgr.grants.read();
    if (mgr.editing) payload.id = mgr.editing;
    const key = String(mgr.key.value || '');
    if (key) {
      const warning = keyPasteWarning(key, url);
      if (warning && mgr.warnedKey !== key) {
        mgr.warnedKey = key; // a second Save with the same value proceeds
        setMgrNote(warning + ' Click Save again to keep it anyway.', true);
        return;
      }
      payload.api_key = key;
    }
    mgr.warnedKey = null;
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
    if (!p) { setModelSuggestions([]); return; }
    if (!mgr.url.value.trim()) mgr.url.value = p.base;
    if (!mgr.model.value.trim() && p.model) mgr.model.value = p.model;
    setModelSuggestions(p.models || []);
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
    model.className = 'atl-xm-in'; model.type = 'text'; model.placeholder = 'model (pick a preset, or type)'; model.maxLength = 120;
    model.setAttribute('list', 'atl-xm-models');
    model.autocomplete = 'off';
    const modelList = document.createElement('datalist');
    modelList.id = 'atl-xm-models';
    row1.append(name, model, modelList);

    const url = document.createElement('input');
    url.className = 'atl-xm-in'; url.type = 'text'; url.placeholder = 'Base URL, e.g. http://127.0.0.1:5000/v1'; url.maxLength = 2000;

    const key = document.createElement('input');
    key.className = 'atl-xm-in'; key.type = 'password'; key.placeholder = 'API key (optional)'; key.maxLength = 4000;
    key.autocomplete = 'off';

    // granular tool grants: editable here after the first consent (the consent
    // sheet sets them on first enable; this is the change-your-mind surface)
    const grantsTitle = el('div', 'atl-xm-grants-title', 'Tool access (when Tools is on)');
    const grantsCtl = grantCheckboxes(null);

    const hint = el('div', 'atl-xm-hint', 'Connect another provider — OpenAI, Google Gemini, Groq, xAI, DeepSeek, Mistral, OpenRouter, a local model (Ollama or LM Studio), or your own Iris/Hermes. Cloud providers need that provider’s own developer API key (billed per token), NOT your chat subscription like ChatGPT Plus; local models are free. Pick a preset, add the key, Save.');
    const note = el('div', 'atl-xm-note');
    const actions = el('div', 'atl-xm-actions');
    const clearBtn = el('button', 'atl-xm-btn', 'Clear form');
    const saveBtn = el('button', 'atl-xm-save', 'Save connection');
    actions.append(clearBtn, saveBtn);

    form.append(preset, row1, url, key, grantsTitle, grantsCtl.el, hint, note, actions);
    wrap.append(list, form);

    mgr = { list, note, preset, name, url, model, modelList, key, saveBtn, editing: null, warnedKey: null, grants: grantsCtl };
    preset.addEventListener('change', syncPreset);
    key.addEventListener('input', () => { mgr.warnedKey = null; });
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
  function addThinking(inst, label) {
    const row = addBubble(inst, 'assistant', label || 'thinking…');
    row.querySelector('.atl-agent-bubble').classList.add('thinking');
    return row;
  }

  // A muted transcript of the tools the agent ran this turn (name + a one-line
  // result), rendered above the final assistant bubble. server-derived strings
  // enter via textContent (el()).
  function renderSteps(inst, steps) {
    const box = el('div', 'atl-ext-steps');
    steps.forEach((s) => {
      const row = el('div', 'atl-ext-step');
      row.appendChild(el('span', 'atl-ext-step-ic', '⚙'));
      row.appendChild(el('span', 'atl-ext-step-nm', String((s && s.tool) || 'tool')));
      const resText = String((s && s.result) || '').replace(/\s+/g, ' ').trim();
      const res = el('span', 'atl-ext-step-res', resText);
      res.title = resText;
      row.appendChild(res);
      box.appendChild(row);
    });
    inst.msgs.appendChild(box);
    inst.msgs.scrollTop = inst.msgs.scrollHeight;
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
    updateToolsToggle(inst);
  }

  // Reflect the bound agent's tools_enabled + capability onto the Tools toggle.
  // Hidden with no agent; greyed for a known-incapable model (e.g. Perplexity
  // sonar) or mid-turn. inst.toolsOn is the send() gate.
  function updateToolsToggle(inst) {
    if (!inst.toolsCb) return;
    const a = currentAgent(inst);
    // The tools lane needs a model (the backend 400s a blank-model tools turn),
    // so a missing model disables the toggle just like a known-incapable model.
    const hasModel = !!(a && a.model && String(a.model).trim());
    const capable = !!(a && a.tools_capable !== false && hasModel);
    inst.toolsLabel.style.display = a ? '' : 'none';
    inst.toolsCb.disabled = !a || !capable || inst.running;
    inst.toolsCb.checked = !!(a && a.tools_enabled && capable);
    inst.toolsOn = inst.toolsCb.checked;
    inst.toolsLabel.classList.toggle('disabled', inst.toolsCb.disabled && !inst.running);
    inst.toolsLabel.title = !a ? ''
      : !hasModel ? 'Set a model on this agent (in Manage agents) to use tools.'
      : (a.tools_capable === false) ? "This model can't use tools — it will answer as plain chat."
      : 'Let this agent use Atelier tools: write files, read/write the vault, search the web.';
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
    // Tools ON routes to the LiteLLM tool-loop lane; OFF stays on plain forward().
    // Captured before the turn mutates state (the toggle greys out mid-run).
    const useTools = !!inst.toolsOn && inst.toolsCb && !inst.toolsCb.disabled;
    inst.ta.value = '';
    growComposer(inst.ta); // collapse back to one row after sending
    setNote(inst, '');
    addBubble(inst, 'user', text);
    inst.history.push({ role: 'user', content: text });
    inst.running = true;
    updateComposerState(inst); // also disables the picker for the turn
    const thinking = addThinking(inst, useTools ? 'working…' : 'thinking…');
    // server appends `message` itself, so send the PRIOR turns as history.
    const priorHistory = inst.history.slice(0, -1);
    const route = useTools ? '/agent_message' : '/message';
    const r = await api('/external/agents/' + encodeURIComponent(boundAgent) + route, {
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
      setNote(inst, 'Can\'t reach Atelier. Is it running?', true);
      inst.history.pop(); refillOnFailure(inst, text);
      return;
    }
    if (!r.ok || !r.data || typeof r.data.response !== 'string') {
      const why = (r.data && r.data.error) ? String(r.data.error) : 'The external agent did not respond.';
      setNote(inst, why, true);
      inst.history.pop(); refillOnFailure(inst, text);
      return;
    }
    if (useTools && Array.isArray(r.data.steps) && r.data.steps.length) renderSteps(inst, r.data.steps);
    addBubble(inst, 'assistant', r.data.response);
    inst.history.push({ role: 'assistant', content: r.data.response });
    // collapse-to-final-text: only the assistant TEXT re-enters history, so a
    // follow-up turn never resends a dangling tool_calls message.
    if (r.data.note) setNote(inst, r.data.note, false);
  }

  function render(inst) {
    const body = inst.bodyEl;
    body.textContent = '';

    const pick = el('div', 'atl-ext-pick');
    const picker = document.createElement('select');
    picker.className = 'atl-ext-sel';
    picker.setAttribute('aria-label', 'Choose an assistant');
    const toolsLabel = el('label', 'atl-ext-tools');
    const toolsCb = document.createElement('input');
    toolsCb.type = 'checkbox';
    toolsCb.setAttribute('aria-label', 'Let this agent use Atelier tools');
    toolsLabel.append(toolsCb, el('span', null, 'Tools'));
    pick.appendChild(picker);
    pick.appendChild(toolsLabel);
    pick.appendChild(el('span', 'atl-ext-badge', 'external'));

    const msgs = el('div', 'atl-agent-msgs');
    const note = el('div', 'atl-agent-note');
    const composer = el('div', 'atl-agent-composer');
    const ta = document.createElement('textarea');
    ta.rows = 1;
    const sendBtn = el('button', 'atl-agent-send', '➤');
    sendBtn.type = 'button'; sendBtn.title = 'Send'; sendBtn.setAttribute('aria-label', 'Send message');
    composer.append(ta, sendBtn);

    body.append(pick, msgs, note, composer);

    inst.picker = picker; inst.msgs = msgs; inst.note = note; inst.ta = ta; inst.sendBtn = sendBtn;
    inst.toolsCb = toolsCb; inst.toolsLabel = toolsLabel;

    toolsCb.addEventListener('change', async () => {
      const a = currentAgent(inst);
      if (!a) { toolsCb.checked = false; return; }
      const on = toolsCb.checked;
      if (on && !toolsConsented(agentHost(a))) {
        // First enable for this host: keep the toggle OFF until the user
        // explicitly allows sending tool output to the named provider.
        toolsCb.checked = false;
        openToolsConsent(a, (grants) => applyToolsSetting(inst, a, true, grants));
        return;
      }
      await applyToolsSetting(inst, a, on);
    });

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
