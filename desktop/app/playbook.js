'use strict';

/* ===========================================================================
   Atelier feature module — Playbooks (reproducible boards)   (app/playbook.js)

   A Playbook is a saved, portable recipe for a piece of work you have already
   set up. You point at a board whose orchestrator chat kicked off a run, save
   it under a name, and from then on one click re-runs the whole thing on a
   fresh board — no retyping the brief. Playbooks follow you across boards, and
   each one exports to a small JSON file you can hand to a teammate.

   What a Playbook stores (a "def")
   --------------------------------
   The portable JSON is deliberately tiny and self-sufficient:
     { title, prompt }              — the orchestrator kickoff, authoritative
     { recipeId, blanks }  (opt.)   — a link back to a recipes.js recipe so the
                                      prompt can be re-derived if you prefer
   {title, prompt} is always kept, so a def still runs even if the recipe
   catalog later changes or a teammate does not have the same recipes.

   How "Save this board" reads the brief
   -------------------------------------
   There is no board-origin record anywhere — boards only snapshot their cards.
   So, exactly like loopcard.js does, we read the first user bubble off an
   orchestrator agent card's DOM (.atl-agent-row.user .atl-agent-bubble) and its
   title (.card-title). Only the active board's cards live in the DOM, so this
   naturally scopes to "this board".

   How Run reproduces it
   ---------------------
   Run mirrors recipes.js launch(): ensure a board exists, A.spawnApp('agent')
   to drop an orchestrator card, wait ~1.5s for its session to settle (a
   double-POST guard), then fill the composer textarea and click send. No new
   backend — the agent card's own send path talks to the existing session API.

   Why raw localStorage (not A.store)
   ----------------------------------
   Playbooks must follow the user across boards. A.store keys are board-scoped
   unless whitelisted in boards.js GLOBAL_KEYS, so — like approvals.js and
   welcome.js keep their global facts out of A.store — the list is read/written
   straight to window.localStorage under a plain key that does NOT start with
   'atelier:' (the colon prefix is what boards' snapshot machinery watches; a
   dot key like 'atelier.playbooks' is invisible to it and stays global).

   Sharing is honest: Export downloads the JSON file, Share also copies it to
   the clipboard. It is a portable file to send, not a hosted link.

   Shared contract (market.js builds to the same surface, feature-detects this):
     window.AtelierPlaybook = {
       save(name, def) -> id, list() -> [{id,name,def,ts}], run(id),
       remove(id), exportOne(id) -> jsonString, importJson(json) -> id, open()
     }

   Contract: builds only against window.Atelier (+ the optional window.atelier
   token bridge is not even needed here — run() reuses the agent card). Injects
   its own CSS. XSS rule: every dynamic string (names, titles) enters the DOM
   via textContent only.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui || typeof A.ui.openPanel !== 'function') {
    console.warn('[playbook] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.playbooks';   // raw localStorage; global (dot, not colon)
  const MOUNT_WAIT_MS = 1600;              // match recipes.js — let the card's session settle
  const NAME_MAX = 80;
  const PROMPT_MAX = 20000;                // sanity cap on an imported/stored kickoff

  // ── tiny DOM + misc helpers (same idiom as the sibling modules) ─────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  function toast(msg) { try { A.ui.toast(msg); } catch { /* toast host not up yet */ } }
  function newId() { return 'pb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
  function clamp(str, n) {
    const s = String(str == null ? '' : str);
    return s.length > n ? s.slice(0, n) : s;
  }
  function fmtWhen(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return '';
    try { return new Date(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  }

  // ── store (raw localStorage array of {id, name, def, ts}; board-independent) ─
  function loadAll() {
    let arr = null;
    try { arr = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]'); }
    catch { arr = null; }
    if (!Array.isArray(arr)) return [];
    // keep only well-formed records so a corrupt entry can't break the list
    return arr.filter((r) => r && typeof r.id === 'string' && r.def && typeof r.def === 'object');
  }
  function saveAll(arr) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(arr)); return true; }
    catch { toast('Could not save — storage is full or unavailable.'); return false; }
  }

  // ── def validation + normalisation ──────────────────────────────────────────
  // A def is portable JSON. Minimum { title, prompt } (either may be derivable
  // from a recipe, but a stored def always keeps a literal prompt when we can).
  function normalizeDef(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    const recipeId = typeof raw.recipeId === 'string' ? raw.recipeId : '';
    const blanks = (raw.blanks && typeof raw.blanks === 'object' && !Array.isArray(raw.blanks))
      ? raw.blanks : null;
    // A def is runnable only if it can produce a prompt: a literal one, or a
    // recipeId we could compose from. Otherwise it is not a valid Playbook.
    if (!prompt && !recipeId) return null;
    const def = { title: clamp(title || 'Untitled Playbook', NAME_MAX) };
    if (prompt) def.prompt = clamp(prompt, PROMPT_MAX);
    if (recipeId) { def.recipeId = recipeId; if (blanks) def.blanks = blanks; }
    return def;
  }

  // Turn a def into the actual orchestrator kickoff text. Literal prompt wins;
  // fall back to re-deriving from a recipes.js recipe when only a recipeId
  // survived (a def a teammate exported before they filled its blanks).
  function composePromptFromDef(def) {
    if (!def) return '';
    if (def.prompt) return String(def.prompt);
    const R = window.AtelierRecipes;
    if (def.recipeId && R && Array.isArray(R.recipes)) {
      const recipe = R.recipes.find((r) => r && r.id === def.recipeId);
      if (recipe && recipe.promptTemplate) {
        let out = recipe.promptTemplate;
        (recipe.blanks || []).forEach((b) => {
          const raw = def.blanks && def.blanks[b.key] != null ? String(def.blanks[b.key]).trim() : '';
          const v = raw || b.placeholder || '';
          out = out.split('{{' + b.key + '}}').join(v);
        });
        return out;
      }
    }
    return '';
  }

  // ── capture: read the current board's orchestrator kickoff into a def ───────
  function agentTitle(card) {
    const t = card.querySelector('.card-title');
    const s = t && t.textContent ? t.textContent.trim() : '';
    return s || 'chat';
  }
  function firstUserMessage(card) {
    const b = card.querySelector('.atl-agent-row.user .atl-agent-bubble');
    return b && b.textContent ? b.textContent.trim() : '';
  }
  // Only the active board's cards are in the DOM, so this scopes to this board.
  // Pick the first orchestrator agent card that actually has a kickoff message.
  function captureCurrentBoard() {
    const cards = document.querySelectorAll('#content .atl-agent-card, .atl-agent-card');
    const seen = new Set();
    for (const card of cards) {
      if (seen.has(card)) continue;
      seen.add(card);
      const prompt = firstUserMessage(card);
      if (!prompt) continue;
      return { title: agentTitle(card), prompt: clamp(prompt, PROMPT_MAX) };
    }
    return null;
  }

  // ── public: save / list / remove ────────────────────────────────────────────
  function save(name, def) {
    const clean = normalizeDef(def);
    if (!clean) { toast('That board has nothing runnable to save yet.'); return null; }
    const nm = clamp((typeof name === 'string' && name.trim()) || clean.title || 'Untitled Playbook', NAME_MAX);
    const rec = { id: newId(), name: nm, def: clean, ts: Date.now() };
    const all = loadAll();
    all.push(rec);
    if (!saveAll(all)) return null;
    if (panelAlive()) renderList();
    return rec.id;
  }

  function list() {
    // newest first; return copies so callers can't mutate the store in place
    return loadAll()
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .map((r) => ({ id: r.id, name: r.name, def: Object.assign({}, r.def), ts: r.ts }));
  }

  function getById(id) { return loadAll().find((r) => r.id === id) || null; }

  function remove(id) {
    const all = loadAll();
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) return false;
    saveAll(next);
    if (panelAlive()) renderList();
    return true;
  }

  // ── public: run (reproduce the board, mirroring recipes.js launch) ──────────
  let runToken = 0;
  async function runDef(def) {
    const prompt = composePromptFromDef(def);
    if (!prompt) { toast('This Playbook has no prompt to run.'); return false; }

    // 1) make sure there is a board to spawn onto
    if (A.boards && typeof A.boards.active === 'function' && typeof A.boards.create === 'function') {
      if (!A.boards.active()) {
        try { await A.boards.create(); } catch { /* fall through — spawn still works */ }
      }
    }
    // 3) spawn the orchestrator agent card
    if (typeof A.spawnApp !== 'function') { toast('Agents are unavailable here.'); return false; }
    const cardEl = A.spawnApp('agent');
    if (!cardEl) { toast('Could not start a team — the agent app is not loaded.'); return false; }

    const token = ++runToken;                 // supersede any earlier in-flight run
    // 4) wait for the card's session to settle, then fill + send (double-POST guard)
    await delay(MOUNT_WAIT_MS);
    if (token !== runToken) return false;      // a newer run took over
    const ta = cardEl.querySelector('.atl-agent-composer textarea');
    const send = cardEl.querySelector('.atl-agent-send');
    if (!ta || !send) { toast('Could not reach the composer — type the request into the card.'); return false; }
    ta.value = prompt;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
    return true;
  }

  async function run(id) {
    const rec = getById(id);
    if (!rec) { toast('That Playbook is gone.'); return false; }
    if (panelAlive()) close();                 // get out of the way of the fresh board
    toast('Running "' + rec.name + '"…');
    return runDef(rec.def);
  }

  // ── public: export / import ─────────────────────────────────────────────────
  // exportOne returns a portable, self-describing JSON STRING (per the contract).
  function exportOne(id) {
    const rec = getById(id);
    if (!rec) return '';
    const payload = { format: 'atelier-playbook', version: 1, name: rec.name, def: rec.def, ts: rec.ts };
    try { return JSON.stringify(payload, null, 2); } catch { return ''; }
  }

  // importJson accepts either the export wrapper or a bare def; returns a new id.
  function importJson(json) {
    let data = null;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; }
    catch { toast('Import failed — that is not valid JSON.'); return null; }
    if (!data || typeof data !== 'object') { toast('Import failed — nothing to import.'); return null; }

    // wrapper form { format:'atelier-playbook', name, def } OR a bare def
    const isWrapper = data.format === 'atelier-playbook' && data.def && typeof data.def === 'object';
    const rawDef = isWrapper ? data.def : data;
    const def = normalizeDef(rawDef);
    if (!def) { toast('Import failed — not an Atelier Playbook.'); return null; }
    const nm = isWrapper && typeof data.name === 'string' && data.name.trim()
      ? clamp(data.name.trim(), NAME_MAX)
      : def.title;
    return save(nm, def);
  }

  // Download a Playbook's JSON as a file (boards.js data-URL idiom).
  function downloadOne(rec) {
    const json = exportOne(rec.id);
    if (!json) { toast('Export failed.'); return; }
    const slug = String(rec.name || 'playbook').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'playbook';
    try {
      const a = document.createElement('a');
      a.download = 'atelier-playbook-' + slug + '.json';
      a.href = 'data:application/json,' + encodeURIComponent(json);
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Exported "' + rec.name + '" as a JSON file.');
    } catch { toast('Export failed.'); }
  }

  // Share = export the file AND copy the JSON. Honest: it is a portable file,
  // not a hosted link — say so in the toast.
  function shareOne(rec) {
    const json = exportOne(rec.id);
    if (!json) { toast('Nothing to share.'); return; }
    downloadOne(rec);
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(json).then(
          () => toast('Copied and downloaded a portable Playbook — send the file or paste it. It is a file, not a link.'),
          () => toast('Downloaded the Playbook file — send it to share. It is a file, not a link.')
        );
        copied = true;
      }
    } catch { /* clipboard blocked — the download already happened */ }
    if (!copied) toast('Downloaded the Playbook file — send it to share. It is a file, not a link.');
  }

  // ── injected CSS (design tokens from styles.css) ────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-playbook-styles')) return;
    const css = `
      .atl-pb { width: 440px; max-width: 84vw; display: flex; flex-direction: column;
        gap: 14px; color: var(--ink); }
      .atl-pb-sub { font-size: 12.5px; color: var(--ink-mid); line-height: 1.5; margin-top: -6px; }

      .atl-pb-save { display: flex; flex-direction: column; gap: 8px;
        border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel);
        padding: 12px 13px; box-shadow: var(--shadow-sm); }
      .atl-pb-save-row { display: flex; gap: 8px; align-items: center; }
      .atl-pb-input { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--canvas);
        color: var(--ink); border-radius: 9px; padding: 8px 11px; font: inherit; font-size: 13px; }
      .atl-pb-input:focus { border-color: var(--accent); outline: none; }
      .atl-pb-hint { font-size: 11.5px; color: var(--ink-dim); line-height: 1.45; }

      .atl-pb-list { display: flex; flex-direction: column; gap: 9px; }
      .atl-pb-item { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel);
        box-shadow: var(--shadow-sm); padding: 11px 13px; display: flex; flex-direction: column; gap: 8px; }
      .atl-pb-item-h { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
      .atl-pb-name { font-size: 13.5px; font-weight: 700; color: var(--ink); min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-pb-when { flex: 0 0 auto; font-size: 11px; color: var(--ink-dim); }
      .atl-pb-brief { font-size: 12px; color: var(--ink-mid); line-height: 1.45;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; word-break: break-word; }
      .atl-pb-actions { display: flex; gap: 7px; flex-wrap: wrap; }

      .atl-pb-empty { display: flex; flex-direction: column; gap: 6px; align-items: center;
        text-align: center; padding: 18px 8px 10px; color: var(--ink-dim); }
      .atl-pb-empty .big { font-size: 26px; line-height: 1; }
      .atl-pb-empty .msg { font-size: 13px; font-weight: 700; color: var(--ink-mid); }
      .atl-pb-empty .p { font-size: 12px; line-height: 1.5; max-width: 300px; }

      .atl-pb-import { display: flex; flex-direction: column; gap: 8px;
        border-top: 1px solid var(--border-soft); padding-top: 12px; }
      .atl-pb-import summary { cursor: pointer; font-size: 12.5px; font-weight: 700; color: var(--ink-mid);
        list-style: none; }
      .atl-pb-import summary:hover { color: var(--accent); }
      .atl-pb-import summary::-webkit-details-marker { display: none; }
      .atl-pb-import textarea { width: 100%; box-sizing: border-box; min-height: 78px; resize: vertical;
        border: 1px solid var(--border); background: var(--canvas); color: var(--ink);
        border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; line-height: 1.45; }
      .atl-pb-import textarea:focus { border-color: var(--accent); outline: none; }
      .atl-pb-import-row { display: flex; gap: 8px; align-items: center; }

      .atl-pb-btn { border: none; border-radius: 9px; padding: 8px 14px; font: inherit;
        font-size: 12.5px; font-weight: 700; cursor: pointer; background: var(--accent); color: #fff; }
      .atl-pb-btn:hover { background: var(--accent-2); }
      .atl-pb-btn.ghost { background: transparent; color: var(--ink-mid); border: 1px solid var(--border); }
      .atl-pb-btn.ghost:hover { border-color: var(--accent); color: var(--ink); }
      .atl-pb-btn.danger { background: transparent; color: #b0453a; border: 1px solid var(--border); }
      .atl-pb-btn.danger:hover { border-color: #b0453a; color: #b0453a; }
      .atl-pb-btn.sm { padding: 6px 11px; font-size: 12px; }
      .atl-pb-btn:focus-visible, .atl-pb-input:focus-visible, .atl-pb-import summary:focus-visible {
        outline: 2px solid var(--accent); outline-offset: 2px; }
    `;
    const style = el('style');
    style.id = 'atl-playbook-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── panel ────────────────────────────────────────────────────────────────────
  let panelRef = null;   // { el, body, close } from openPanel
  let listHostEl = null; // the <div> the saved list renders into

  function panelAlive() { return !!(panelRef && panelRef.el && panelRef.el.isConnected); }

  function itemRow(rec) {
    const row = el('div', 'atl-pb-item');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Playbook: ' + rec.name);

    const h = el('div', 'atl-pb-item-h');
    h.appendChild(el('span', 'atl-pb-name', rec.name));
    const when = fmtWhen(rec.ts);
    if (when) h.appendChild(el('span', 'atl-pb-when', when));
    row.appendChild(h);

    const brief = composePromptFromDef(rec.def);
    if (brief) row.appendChild(el('div', 'atl-pb-brief', brief));

    const actions = el('div', 'atl-pb-actions');
    const runBtn = el('button', 'atl-pb-btn sm', 'Run');
    runBtn.type = 'button';
    runBtn.setAttribute('aria-label', 'Run playbook ' + rec.name);
    runBtn.addEventListener('click', () => run(rec.id));

    const exportBtn = el('button', 'atl-pb-btn ghost sm', 'Export');
    exportBtn.type = 'button';
    exportBtn.setAttribute('aria-label', 'Export playbook ' + rec.name + ' as JSON');
    exportBtn.addEventListener('click', () => downloadOne(rec));

    const shareBtn = el('button', 'atl-pb-btn ghost sm', 'Share');
    shareBtn.type = 'button';
    shareBtn.title = 'Copies the JSON and downloads the file — a portable file, not a hosted link.';
    shareBtn.setAttribute('aria-label', 'Share playbook ' + rec.name);
    shareBtn.addEventListener('click', () => shareOne(rec));

    const delBtn = el('button', 'atl-pb-btn danger sm', 'Delete');
    delBtn.type = 'button';
    delBtn.setAttribute('aria-label', 'Delete playbook ' + rec.name);
    delBtn.addEventListener('click', () => {
      remove(rec.id);
      toast('Deleted "' + rec.name + '".');
    });

    actions.append(runBtn, exportBtn, shareBtn, delBtn);
    row.appendChild(actions);
    return row;
  }

  function renderList() {
    if (!listHostEl) return;
    listHostEl.textContent = '';
    const all = list();
    if (!all.length) {
      const empty = el('div', 'atl-pb-empty');
      empty.setAttribute('role', 'status');
      const big = el('div', 'big', '📼');
      big.setAttribute('aria-hidden', 'true');
      empty.append(big, el('div', 'msg', 'No Playbooks yet'));
      empty.appendChild(el('div', 'p',
        'Set up a board with an orchestrator chat, then save it here to re-run the whole thing with one click — or import one a teammate shared.'));
      listHostEl.appendChild(empty);
      return;
    }
    all.forEach((rec) => listHostEl.appendChild(itemRow(rec)));
  }

  function buildBody() {
    const wrap = el('div', 'atl-pb');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Playbooks');

    wrap.appendChild(el('div', 'atl-pb-sub',
      'Save a board you have set up, then re-run it any time on a fresh board. Playbooks follow you everywhere and export to a file you can share.'));

    // Save current board
    const save = el('div', 'atl-pb-save');
    const nameLabel = el('label', 'atl-pb-hint', 'Save this board as a Playbook');
    const nameInput = el('input', 'atl-pb-input');
    nameInput.type = 'text';
    nameInput.maxLength = NAME_MAX;
    nameInput.placeholder = 'Name it (e.g. Weekly Top-5 video)';
    nameInput.setAttribute('aria-label', 'New playbook name');
    const nid = 'atl-pb-name-' + Math.random().toString(36).slice(2, 7);
    nameInput.id = nid;
    nameLabel.setAttribute('for', nid);

    const saveBtn = el('button', 'atl-pb-btn', 'Save board');
    saveBtn.type = 'button';
    const doSave = () => {
      const def = captureCurrentBoard();
      if (!def) {
        toast('No orchestrator chat on this board yet — start a team, then save.');
        return;
      }
      const name = nameInput.value.trim() || def.title;
      const id = window.AtelierPlaybook.save(name, def);
      if (id) { nameInput.value = ''; toast('Saved "' + name + '" as a Playbook.'); }
    };
    saveBtn.addEventListener('click', doSave);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });

    const row = el('div', 'atl-pb-save-row');
    row.append(nameInput, saveBtn);
    save.append(nameLabel, row);
    save.appendChild(el('div', 'atl-pb-hint',
      'Captures the first message of this board’s orchestrator chat as the kickoff prompt.'));
    wrap.appendChild(save);

    // Saved list
    listHostEl = el('div', 'atl-pb-list');
    listHostEl.setAttribute('role', 'list');
    wrap.appendChild(listHostEl);
    renderList();

    // Import (paste JSON or a file)
    const imp = el('details', 'atl-pb-import');
    const sum = el('summary', null, 'Import a shared Playbook');
    sum.setAttribute('tabindex', '0');
    imp.appendChild(sum);
    const ta = el('textarea');
    ta.placeholder = 'Paste a Playbook JSON here…';
    ta.setAttribute('aria-label', 'Paste playbook JSON');
    imp.appendChild(ta);

    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onerror = () => toast('Import failed — could not read that file.');
      reader.onload = () => {
        const id = window.AtelierPlaybook.importJson(String(reader.result));
        if (id) toast('Imported a Playbook.');
      };
      reader.readAsText(f);
    });

    const impRow = el('div', 'atl-pb-import-row');
    const pasteBtn = el('button', 'atl-pb-btn sm', 'Import pasted');
    pasteBtn.type = 'button';
    pasteBtn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { toast('Paste a Playbook JSON first.'); return; }
      const id = window.AtelierPlaybook.importJson(text);
      if (id) { ta.value = ''; toast('Imported a Playbook.'); }
    });
    const fileBtn = el('button', 'atl-pb-btn ghost sm', 'From file…');
    fileBtn.type = 'button';
    fileBtn.addEventListener('click', () => fileInput.click());
    impRow.append(pasteBtn, fileBtn, fileInput);
    imp.appendChild(impRow);
    wrap.appendChild(imp);

    return wrap;
  }

  function open() {
    if (panelAlive()) {
      panelRef.body.textContent = '';
      panelRef.body.appendChild(buildBody());
      return;
    }
    panelRef = A.ui.openPanel('Playbooks', buildBody(), { backdrop: true });
  }

  function close() {
    if (panelRef && typeof panelRef.close === 'function') { try { panelRef.close(); } catch {} }
    panelRef = null;
    listHostEl = null;
  }

  // ── palette commands ────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'playbook.open', label: 'Playbooks', icon: '📼', section: 'Create',
      keywords: 'playbook recipe rerun reproduce save export import share board template',
      run() { open(); },
    });
    A.bus.emit('palette:add', {
      id: 'playbook.save', label: 'Save this board as a Playbook', icon: '📼', section: 'Create',
      keywords: 'playbook save board reproduce reuse capture orchestrator',
      run() {
        const def = captureCurrentBoard();
        if (!def) { toast('No orchestrator chat on this board yet — start a team, then save.'); return; }
        const id = window.AtelierPlaybook.save(def.title, def);
        if (id) { toast('Saved "' + def.title + '" as a Playbook.'); open(); }
      },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);   // covers palette.js loading later

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierPlaybook = {
    save,
    list,
    run,
    remove,
    exportOne,
    importJson,
    open,
  };

  (function selfCheck() {
    const surface = window.AtelierPlaybook;
    const ok = !!surface &&
      typeof surface.save === 'function' && typeof surface.list === 'function' &&
      typeof surface.run === 'function' && typeof surface.remove === 'function' &&
      typeof surface.exportOne === 'function' && typeof surface.importJson === 'function' &&
      typeof surface.open === 'function';
    console.assert(ok, '[playbook] module did not register the full window.AtelierPlaybook surface');
    if (ok) {
      console.log('[playbook] self-check passed — Playbooks ready (palette + AtelierPlaybook, ' +
        loadAll().length + ' saved, raw-localStorage "' + STORE_KEY + '", runs via A.spawnApp("agent")).');
    }
  })();
})();
