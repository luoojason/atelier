'use strict';

/* ===========================================================================
   Atelier feature module — slash commands   (app/slashcommands.js)

   Type "/" at the START of any chat composer (the main dashboard chat OR any
   Agent card's composer) and a menu of commands pops up. Arrow keys move,
   Enter/Tab picks, Escape dismisses, click picks. A command is one of:

     • prompt  — expands a TEMPLATE into the composer (you then edit + send).
                 This is the "/goal and stuff" case. A "{{cursor}}" marker in
                 the template positions the caret after expansion.
     • app     — spawns a canvas card of a registered app type (/loop, /agent,
                 /browser, /note, /document). Clears the "/cmd" token.
     • action  — a built-in behaviour: /clear empties the composer, /commands
                 opens the manager.

   FULLY CUSTOMIZABLE: the "Manage commands…" panel (also ⌘K → "Manage slash
   commands…") lets you add / edit / delete your OWN commands — a prompt
   template or an app spawn, given a trigger name + label. User commands are
   stored under Atelier.store 'atelier.slashcommands' (registered GLOBAL in
   boards.js so they follow you across every board) and OVERRIDE a built-in of
   the same name. Reset by deleting the user command.

   HOW IT ATTACHES (zero edits to core.js / sessions.js)
   -----------------------------------------------------
   A single pair of document-level, CAPTURE-phase listeners (keydown + input)
   drive everything. They act only when the event target is a composer textarea
   — `#input` (main chat) or a `.atl-agent-composer textarea` (any Agent card,
   present or future). Capture phase is the crux: the composers register their
   OWN Enter-to-send keydown on the textarea (bubble phase), so a capture-phase
   listener on `document` runs FIRST — while the menu is open we consume
   Enter/Tab/Arrows/Escape with stopPropagation() so send() never fires; while
   it is closed we touch nothing and normal typing/sending is unaffected. New
   Agent cards need no wiring: the delegated listeners already cover them.

   The floating menu is a single position:fixed element on document.body,
   re-anchored to the active textarea each open, so the canvas transform never
   distorts it.

   Contract: builds ONLY against window.Atelier (bus/store/ui/apps/spawnApp)
   + optional window.Atelier.palette. Injects its own CSS. XSS rule: every
   user- or command-derived string enters the DOM via textContent.

   ── MANUAL TEST ─────────────────────────────────────────────────────────────
   1. `npm start` in desktop/. Console: expect "[slashcommands] ready".
   2. Click the main chat input, type "/". A menu appears above it listing
      Goal / Plan / Research / New Loop / New Agent / … Type "go" — it filters
      to Goal. Press Enter → the composer fills with the goal template, caret
      parked after "Goal: ", menu gone. Edit + Enter sends as normal.
   3. Type "/loop" then Enter → a Loop card appears on the canvas, the composer
      clears. Same for /agent, /browser, /note, /document.
   4. Spawn an Agent card (⌘K → agent). In ITS composer type "/" → the same
      menu appears anchored to that card. Arrow-down to "Plan", Enter → template
      lands in the agent composer.
   5. Type "/" then Escape → menu closes, the "/" stays, Enter sends "/" as a
      literal message (menu was closed, so send() ran normally).
   6. Type "/commands" + Enter (or ⌘K → "Manage slash commands…") → the manager
      opens. Add a command: name "standup", kind Prompt, template
      "Write my standup: {{cursor}}". Save. Now "/standup" appears in the menu
      and expands the template. Delete it → it disappears.
   7. Make a user command named "goal" → it OVERRIDES the built-in Goal.
   8. Switch boards (sidebar) — your custom commands are still there (global).
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.store || !A.ui || typeof A.spawnApp !== 'function') {
    console.warn('[slashcommands] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.slashcommands';
  const CURSOR = '{{cursor}}';
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/; // a valid trigger (after the slash)
  // The menu is live ONLY while the WHOLE composer value is a bare slash token:
  // "/", "/go", "/goal". A space or any further text closes it (the user is
  // writing a real message that merely starts with "/"). Anchored at index 0.
  const QUERY_RE = /^\/([a-z0-9_-]*)$/i;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── built-in commands ──────────────────────────────────────────────────────
  // kind 'prompt' -> body is the template ({{cursor}} optional).
  // kind 'app'    -> app is a registered A.apps type; shown only if registered.
  // kind 'action' -> action is 'clear' | 'manage'.
  const BUILTINS = [
    { name: 'goal', label: 'Goal', icon: '◎', kind: 'prompt', section: 'Prompts',
      body: 'Goal: ' + CURSOR + '\n\nContext:\n- \n\nConstraints:\n- \n\nDone when:\n- ' },
    { name: 'plan', label: 'Plan', icon: '✎', kind: 'prompt', section: 'Prompts',
      body: 'Make a step-by-step plan to: ' + CURSOR + '\n\nList the steps and call out any risks before acting.' },
    { name: 'research', label: 'Research', icon: '⌕', kind: 'prompt', section: 'Prompts',
      body: 'Research ' + CURSOR + ' and summarize the key findings with sources.' },
    { name: 'review', label: 'Review', icon: '✔', kind: 'prompt', section: 'Prompts',
      body: 'Review the following for bugs, edge cases and clarity, then list concrete fixes:\n\n' + CURSOR },
    { name: 'loop', label: 'New Loop', icon: '↻', kind: 'app', app: 'loop', section: 'Create' },
    { name: 'agent', label: 'New Agent', icon: '✦', kind: 'app', app: 'agent', section: 'Create' },
    { name: 'browser', label: 'New Browser', icon: '◐', kind: 'app', app: 'browser', section: 'Create' },
    { name: 'note', label: 'New Note', icon: '▤', kind: 'app', app: 'note', section: 'Create' },
    { name: 'document', label: 'New Document', icon: '▧', kind: 'app', app: 'document', section: 'Create' },
    { name: 'external', label: 'External agent', icon: '⇄', kind: 'app', app: 'external', section: 'Create' },
    { name: 'clear', label: 'Clear input', icon: '⌫', kind: 'action', action: 'clear', section: 'Actions' },
    { name: 'commands', label: 'Manage commands…', icon: '⚙', kind: 'action', action: 'manage', section: 'Actions' },
  ];

  // ── user command store (validated on read; malformed entries dropped) ──────
  function loadUser() {
    const raw = A.store.get(STORE_KEY, []);
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    raw.forEach((c) => {
      if (!c || typeof c !== 'object') return;
      const name = String(c.name || '').toLowerCase();
      if (!NAME_RE.test(name) || seen.has(name)) return;
      const kind = c.kind === 'app' ? 'app' : 'prompt';
      const rec = { name, label: String(c.label || name).slice(0, 60), kind, user: true,
        section: 'Custom', icon: kind === 'app' ? '▦' : '✎' };
      if (kind === 'app') { rec.app = String(c.app || ''); }
      else { rec.body = String(c.body || ''); }
      seen.add(name);
      out.push(rec);
    });
    return out;
  }
  function saveUser(list) { A.store.set(STORE_KEY, list); }

  // Merged, de-duplicated command set (user overrides built-in of same name),
  // with unregistered app-spawns filtered out so the menu never lies.
  function allCommands() {
    const byName = new Map();
    BUILTINS.forEach((c) => byName.set(c.name, c));
    loadUser().forEach((c) => byName.set(c.name, c));
    return Array.from(byName.values()).filter((c) => {
      if (c.kind !== 'app') return true;
      return !!(A.apps && typeof A.apps.has === 'function' && A.apps.has(c.app));
    });
  }

  function filterCommands(query) {
    const q = String(query || '').toLowerCase();
    const all = allCommands();
    if (!q) return all;
    const scored = [];
    all.forEach((c) => {
      const name = c.name.toLowerCase();
      const label = String(c.label || '').toLowerCase();
      let score = -1;
      if (name === q) score = 0;
      else if (name.indexOf(q) === 0) score = 1;
      else if (label.indexOf(q) === 0) score = 2;
      else if (name.indexOf(q) >= 0 || label.indexOf(q) >= 0) score = 3;
      if (score >= 0) scored.push({ c, score });
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.c);
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-slash-styles')) return;
    const css = `
      .atl-slash-menu { position: fixed; z-index: 9000; min-width: 240px; max-width: 340px;
        max-height: 300px; overflow-y: auto; background: var(--panel, #fff);
        border: 1px solid var(--border); border-radius: 12px; padding: 5px;
        box-shadow: var(--shadow, 0 12px 32px rgba(70,52,30,.18)); }
      .atl-slash-sec { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; padding: 7px 9px 3px; }
      .atl-slash-item { display: flex; align-items: center; gap: 9px; padding: 7px 9px;
        border-radius: 8px; cursor: pointer; color: var(--ink); }
      .atl-slash-item.sel, .atl-slash-item:hover { background: var(--accent-soft, #f0e2d9); }
      .atl-slash-ic { width: 18px; text-align: center; color: var(--accent); flex: 0 0 18px; }
      .atl-slash-name { font-size: 13px; font-weight: 600; white-space: nowrap; }
      .atl-slash-lbl { font-size: 12px; color: var(--ink-dim); flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
      .atl-slash-empty { padding: 10px 12px; font-size: 12.5px; color: var(--ink-dim); }

      .atl-sm-wrap { display: flex; flex-direction: column; gap: 16px; width: 340px; }
      .atl-sm-sec-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; }
      .atl-sm-list { display: flex; flex-direction: column; gap: 6px; max-height: 220px;
        overflow-y: auto; }
      .atl-sm-row { display: flex; align-items: center; gap: 9px; padding: 7px 10px;
        border: 1px solid var(--border); border-radius: 9px; background: var(--panel); }
      .atl-sm-row .nm { font-size: 13px; font-weight: 600; color: var(--ink); }
      .atl-sm-row .kd { font-size: 11px; color: var(--ink-dim); flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-sm-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--ink-dim); border: 1px solid var(--border); border-radius: 6px;
        padding: 1px 5px; }
      .atl-sm-btn { border: 1px solid var(--border); border-radius: 7px; background: #faf7f1;
        color: var(--ink-mid); font: inherit; font-size: 11px; padding: 4px 8px; cursor: pointer; }
      .atl-sm-btn:hover { border-color: var(--accent); }
      .atl-sm-form { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-soft);
        padding-top: 12px; }
      .atl-sm-inrow { display: flex; gap: 8px; }
      .atl-sm-in, .atl-sm-sel, .atl-sm-ta { border: 1px solid var(--border); border-radius: 8px;
        padding: 7px 10px; font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1;
        outline: none; width: 100%; box-sizing: border-box; }
      .atl-sm-in:focus, .atl-sm-ta:focus, .atl-sm-sel:focus { border-color: var(--accent); }
      .atl-sm-ta { min-height: 64px; resize: vertical; }
      .atl-sm-slashwrap { position: relative; flex: 1; }
      .atl-sm-slashwrap::before { content: '/'; position: absolute; left: 10px; top: 50%;
        transform: translateY(-50%); color: var(--ink-dim); font-weight: 600; pointer-events: none; }
      .atl-sm-slashwrap .atl-sm-in { padding-left: 18px; }
      .atl-sm-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .atl-sm-save { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-sm-save:hover { background: var(--accent-2); }
      .atl-sm-note { font-size: 11.5px; color: var(--ink-dim); line-height: 1.4; }
      .atl-sm-note.err { color: var(--accent); }
      .atl-sm-note:empty { display: none; }
    `;
    const style = el('style');
    style.id = 'atl-slash-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── composer identification ────────────────────────────────────────────────
  function isComposer(node) {
    if (!node || node.tagName !== 'TEXTAREA') return false;
    if (node.id === 'input') return true;                       // main chat
    return !!(node.closest && node.closest('.atl-agent-composer')); // any agent card
  }

  // ── the floating menu ──────────────────────────────────────────────────────
  let menu = null;       // { root, activeTa, items, sel }
  let applying = false;  // reentrancy guard while we mutate a composer value

  function closeMenu() {
    if (!menu) return;
    if (menu.root && menu.root.parentNode) menu.root.parentNode.removeChild(menu.root);
    menu = null;
  }

  function positionMenu(root, ta) {
    const r = ta.getBoundingClientRect();
    // measure after it is in the DOM
    const mh = root.offsetHeight || 200;
    const mw = root.offsetWidth || 260;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    if (left < 8) left = 8;
    let top = r.top - mh - 6;               // prefer ABOVE the composer
    if (top < 8) top = r.bottom + 6;        // no room above -> drop below
    // clamp fully into the viewport so a tall list near a screen edge never
    // clips off-screen (its own overflow-y scroll then reaches every row).
    const maxTop = window.innerHeight - mh - 8;
    if (top > maxTop) top = maxTop;
    if (top < 8) top = 8;
    root.style.left = Math.round(left) + 'px';
    root.style.top = Math.round(top) + 'px';
  }

  function renderMenu(query) {
    const items = filterCommands(query);
    if (!menu) return;
    menu.items = items;
    if (menu.sel >= items.length) menu.sel = items.length - 1;
    if (menu.sel < 0) menu.sel = 0;
    const root = menu.root;
    root.textContent = '';
    if (!items.length) {
      root.appendChild(el('div', 'atl-slash-empty', 'No commands match. Type /commands to add one.'));
      positionMenu(root, menu.activeTa);
      return;
    }
    let lastSec = null;
    items.forEach((c, i) => {
      const sec = c.section || 'More';
      if (sec !== lastSec) { root.appendChild(el('div', 'atl-slash-sec', sec)); lastSec = sec; }
      const row = el('div', 'atl-slash-item' + (i === menu.sel ? ' sel' : ''));
      row.dataset.idx = String(i);
      row.append(
        el('span', 'atl-slash-ic', c.icon || '›'),
        el('span', 'atl-slash-name', '/' + c.name),
        el('span', 'atl-slash-lbl', c.label || '')
      );
      // mousedown (not click): fires before the textarea loses focus, and we
      // preventDefault so the caret is never yanked out of the composer.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        apply(items[i], menu.activeTa);
      });
      root.appendChild(row);
    });
    positionMenu(root, menu.activeTa);
  }

  function openMenu(ta, query) {
    if (!menu) {
      const root = el('div', 'atl-slash-menu');
      document.body.appendChild(root);
      menu = { root, activeTa: ta, items: [], sel: 0 };
    } else {
      menu.activeTa = ta;
    }
    renderMenu(query);
  }

  function moveSel(delta) {
    if (!menu || !menu.items.length) return;
    const n = menu.items.length;
    menu.sel = (menu.sel + delta + n) % n;
    // repaint selection without rebuilding (keeps scroll position)
    Array.from(menu.root.querySelectorAll('.atl-slash-item')).forEach((row) => {
      const on = Number(row.dataset.idx) === menu.sel;
      row.classList.toggle('sel', on);
      if (on && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    });
  }

  // ── applying a chosen command ───────────────────────────────────────────────
  function fireInput(ta) {
    // let the composer's own auto-resize / listeners react to the new value
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function applyPrompt(ta, body) {
    let text = String(body == null ? '' : body);
    // caret parks at the FIRST {{cursor}}; ALL markers are stripped (a custom
    // template may carry several — leftover literal markers would be junk).
    const idx = text.indexOf(CURSOR);
    let caret = text.length;
    if (idx >= 0) { caret = idx; text = text.split(CURSOR).join(''); }
    applying = true;
    ta.value = text;
    fireInput(ta);
    applying = false;
    try { ta.setSelectionRange(caret, caret); } catch { /* value is fresh; ignore */ }
    ta.focus();
  }

  function clearComposer(ta) {
    applying = true;
    ta.value = '';
    fireInput(ta);
    applying = false;
    ta.focus();
  }

  function apply(cmd, ta) {
    closeMenu();
    if (!cmd || !ta) return;
    if (cmd.kind === 'app') {
      clearComposer(ta);
      if (A.apps && A.apps.has(cmd.app)) {
        A.spawnApp(cmd.app);
        if (A.ui && A.ui.toast) A.ui.toast('Added ' + (cmd.label || cmd.app));
      }
      return;
    }
    if (cmd.kind === 'action') {
      if (cmd.action === 'manage') { clearComposer(ta); openManager(); return; }
      clearComposer(ta); // 'clear' (and any unknown action) just empties
      return;
    }
    // prompt
    applyPrompt(ta, cmd.body || '');
  }

  // ── delegated composer listeners (capture phase) ────────────────────────────
  document.addEventListener('input', (e) => {
    if (applying) return;
    const ta = e.target;
    if (!isComposer(ta)) return;
    // a newline means the user is writing a real (multi-line) message that
    // happens to start with "/", not picking a command — close, don't match.
    // (JS `$` also matches before a trailing "\n", so guard it explicitly.)
    const m = ta.value.indexOf('\n') === -1 ? QUERY_RE.exec(ta.value) : null;
    if (m) openMenu(ta, m[1]);
    else if (menu && menu.activeTa === ta) closeMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (e.isComposing || e.keyCode === 229) return; // mid-IME-composition: never steal Enter
    const ta = e.target;
    if (ta !== menu.activeTa) return; // only steer keys for the composer that owns the menu
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); e.stopPropagation(); moveSel(1); break;
      case 'ArrowUp': e.preventDefault(); e.stopPropagation(); moveSel(-1); break;
      case 'Enter':
      case 'Tab':
        // Shift+Enter is a newline (matching the composers' own rule) — never a
        // pick. Fall through to the textarea default; the inserted newline then
        // closes the menu via the input handler's newline guard.
        if (e.key === 'Enter' && e.shiftKey) break;
        // Enter/Tab dismiss the menu AND are consumed (preventDefault +
        // stopPropagation) even with no matches, so the composer's own
        // Enter->send() never leaks the raw "/query" as a message.
        e.preventDefault(); e.stopPropagation();
        if (menu.items.length) apply(menu.items[menu.sel], ta);
        else closeMenu();
        break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closeMenu(); break;
      default: break; // let the character through; the input event re-filters
    }
  }, true);

  // Close on focus loss / scroll / resize / board churn — a stale fixed-position
  // menu anchored to a moved textarea would float wrong. (A menu-row mousedown
  // preventDefaults, so picking never triggers this blur.)
  document.addEventListener('focusout', (e) => {
    if (menu && e.target === menu.activeTa) setTimeout(() => {
      if (menu && document.activeElement !== menu.activeTa) closeMenu();
    }, 0);
  }, true);
  document.addEventListener('scroll', (e) => {
    // ignore scrolls originating INSIDE the menu — its own list overflow and the
    // scrollIntoView() in moveSel both emit scroll on menu.root; closing on those
    // would make the menu un-scrollable and self-dismiss on arrow navigation.
    if (menu && !menu.root.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('resize', () => { if (menu) closeMenu(); });
  document.addEventListener('mousedown', (e) => {
    if (!menu) return;
    if (menu.root.contains(e.target) || e.target === menu.activeTa) return;
    closeMenu();
  }, true);
  A.bus.on('cards:rearranged', () => { if (menu) closeMenu(); });
  A.bus.on('boards:will-switch', () => closeMenu());

  /* =========================================================================
     THE MANAGER PANEL  (fully-customizable command editor)
     ========================================================================= */
  let mgr = null;       // live control refs for the (single) open manager panel
  let mgrPanel = null;  // the open panel handle — a singleton (see openManager)

  function appTypeOptions() {
    // the app kinds a custom /command can spawn — the live registry, minus the
    // reserved names slash built-ins already own is fine to include (override).
    const types = [];
    if (A.apps && typeof A.apps.forEach === 'function') {
      A.apps.forEach((def, type) => types.push({ type, label: (def && def.label) || type }));
    }
    types.sort((a, b) => a.label.localeCompare(b.label));
    return types;
  }

  function setMgrNote(text, isErr) {
    if (!mgr || !mgr.noteEl) return;
    mgr.noteEl.textContent = text || '';
    mgr.noteEl.classList.toggle('err', !!isErr);
  }

  function renderMgrList() {
    if (!mgr || !mgr.listEl) return;
    const list = mgr.listEl;
    list.textContent = '';
    const user = loadUser();
    const userNames = new Set(user.map((c) => c.name));

    if (user.length) {
      list.appendChild(el('div', 'atl-sm-sec-title', 'Your commands'));
      user.forEach((c) => {
        const row = el('div', 'atl-sm-row');
        row.append(el('span', 'atl-sm-tag', c.kind === 'app' ? 'app' : 'prompt'));
        row.appendChild(el('span', 'nm', '/' + c.name));
        const desc = c.kind === 'app' ? ('→ ' + (c.app || '?')) : (c.body || '');
        row.appendChild(el('span', 'kd', desc));
        const edit = el('button', 'atl-sm-btn', 'Edit');
        const del = el('button', 'atl-sm-btn', 'Delete');
        edit.addEventListener('click', () => loadIntoForm(c));
        del.addEventListener('click', () => {
          saveUser(loadUser().filter((x) => x.name !== c.name));
          // if the deleted command was loaded in the edit form, reset editing so
          // the next Save does not resurrect it under the stale `editing` name.
          if (mgr && mgr.editing === c.name) loadIntoForm(null);
          setMgrNote('Deleted /' + c.name + '.', false);
          renderMgrList();
        });
        row.append(edit, del);
        list.appendChild(row);
      });
    }

    // built-ins (read-only; note which are overridden by a user command)
    list.appendChild(el('div', 'atl-sm-sec-title', 'Built-in'));
    BUILTINS.forEach((c) => {
      const row = el('div', 'atl-sm-row');
      const tag = c.kind === 'app' ? 'app' : (c.kind === 'action' ? 'action' : 'prompt');
      row.append(el('span', 'atl-sm-tag', tag));
      row.appendChild(el('span', 'nm', '/' + c.name));
      row.appendChild(el('span', 'kd', userNames.has(c.name) ? 'overridden by your command' : (c.label || '')));
      list.appendChild(row);
    });
  }

  function loadIntoForm(c) {
    if (!mgr) return;
    mgr.editing = c ? c.name : null;
    mgr.nameIn.value = c ? c.name : '';
    mgr.labelIn.value = c ? (c.label || '') : '';
    mgr.kindSel.value = c && c.kind === 'app' ? 'app' : 'prompt';
    mgr.bodyTa.value = c && c.kind !== 'app' ? (c.body || '') : '';
    if (c && c.kind === 'app') mgr.appSel.value = c.app || '';
    syncFormKind();
    setMgrNote(c ? 'Editing /' + c.name + '.' : '', false);
    mgr.nameIn.focus();
  }

  function syncFormKind() {
    if (!mgr) return;
    const isApp = mgr.kindSel.value === 'app';
    mgr.appWrap.style.display = isApp ? '' : 'none';
    mgr.bodyWrap.style.display = isApp ? 'none' : '';
  }

  function saveForm() {
    if (!mgr) return;
    const name = String(mgr.nameIn.value || '').trim().toLowerCase().replace(/^\/+/, '');
    if (!NAME_RE.test(name)) {
      setMgrNote('Name must be lower-case letters/numbers/-/_ (start with a letter or number).', true);
      return;
    }
    const kind = mgr.kindSel.value === 'app' ? 'app' : 'prompt';
    const label = String(mgr.labelIn.value || '').trim().slice(0, 60);
    const rec = { name, label: label || name, kind };
    if (kind === 'app') {
      const app = String(mgr.appSel.value || '');
      if (!app || !(A.apps && A.apps.has(app))) { setMgrNote('Pick an app to spawn.', true); return; }
      rec.app = app;
    } else {
      const body = String(mgr.bodyTa.value || '');
      if (!body.trim()) { setMgrNote('Write the template this command inserts.', true); return; }
      rec.body = body;
    }
    // upsert by name; if renamed while editing, drop the old entry
    const list = loadUser().filter((x) => x.name !== name && x.name !== mgr.editing);
    list.push(rec);
    saveUser(list);
    mgr.editing = null;
    loadIntoForm(null);
    setMgrNote('Saved /' + name + '.', false);
    renderMgrList();
  }

  function buildManagerBody() {
    const wrap = el('div', 'atl-sm-wrap');

    const list = el('div', 'atl-sm-list');

    // add/edit form
    const form = el('div', 'atl-sm-form');
    form.appendChild(el('div', 'atl-sm-sec-title', 'Add / edit a command'));

    const row1 = el('div', 'atl-sm-inrow');
    const nameWrap = el('div', 'atl-sm-slashwrap');
    const nameIn = document.createElement('input');
    nameIn.className = 'atl-sm-in'; nameIn.type = 'text'; nameIn.placeholder = 'name'; nameIn.maxLength = 31;
    nameWrap.appendChild(nameIn);
    const labelIn = document.createElement('input');
    labelIn.className = 'atl-sm-in'; labelIn.type = 'text'; labelIn.placeholder = 'label (optional)'; labelIn.maxLength = 60;
    row1.append(nameWrap, labelIn);

    const kindSel = document.createElement('select');
    kindSel.className = 'atl-sm-sel';
    [['prompt', 'Prompt template'], ['app', 'Spawn app']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; kindSel.appendChild(o);
    });

    const bodyWrap = el('div');
    const bodyTa = document.createElement('textarea');
    bodyTa.className = 'atl-sm-ta';
    bodyTa.placeholder = 'Template inserted into the composer. Use {{cursor}} to place the caret.';
    bodyWrap.appendChild(bodyTa);

    const appWrap = el('div');
    const appSel = document.createElement('select');
    appSel.className = 'atl-sm-sel';
    appTypeOptions().forEach((o) => {
      const opt = document.createElement('option'); opt.value = o.type; opt.textContent = o.label; appSel.appendChild(opt);
    });
    appWrap.appendChild(appSel);

    const note = el('div', 'atl-sm-note');
    const actions = el('div', 'atl-sm-actions');
    const newBtn = el('button', 'atl-sm-btn', 'Clear form');
    const saveBtn = el('button', 'atl-sm-save', 'Save command');
    actions.append(newBtn, saveBtn);

    form.append(row1, kindSel, bodyWrap, appWrap, note, actions);
    wrap.append(list, form);

    mgr = { listEl: list, noteEl: note, nameIn, labelIn, kindSel, bodyTa, bodyWrap, appSel, appWrap, editing: null };

    kindSel.addEventListener('change', syncFormKind);
    newBtn.addEventListener('click', () => loadIntoForm(null));
    saveBtn.addEventListener('click', saveForm);

    renderMgrList();
    syncFormKind();
    return wrap;
  }

  function openManager() {
    // SINGLETON: A.ui.openPanel stacks a fresh panel every call and all handlers
    // read the single module-level `mgr`, so a second panel would hijack the
    // first's refs (Save writes the wrong form) and closing either would null the
    // shared `mgr` and brick the other. If one is already on screen, keep it.
    if (mgrPanel && mgrPanel.el && document.body.contains(mgrPanel.el)) {
      const x = mgrPanel.el.querySelector('.card-x');
      if (x && x.scrollIntoView) x.scrollIntoView({ block: 'nearest' });
      return;
    }
    const body = buildManagerBody();
    mgrPanel = A.ui.openPanel('Slash commands', body);
    // drop our refs when the panel closes so a re-open rebuilds cleanly
    if (mgrPanel && mgrPanel.el) {
      const x = mgrPanel.el.querySelector('.card-x');
      if (x) x.addEventListener('click', () => { mgr = null; mgrPanel = null; });
    }
  }

  // ── palette entry (⌘K → "Manage slash commands…") ──────────────────────────
  A.bus.emit('palette:add', {
    id: 'slash.manage', label: 'Manage slash commands…', icon: '⌗', section: 'App',
    keywords: 'slash command shortcut macro template customize',
    run() { openManager(); },
  });

  // ── public API ───────────────────────────────────────────────────────────────
  A.slash = {
    openManager,
    commands: allCommands,
    isComposer,
    STORE_KEY,
  };

  (function selfCheck() {
    const problems = [];
    if (!QUERY_RE.test('/')) problems.push('query regex rejects "/"');
    if (!QUERY_RE.test('/goal')) problems.push('query regex rejects "/goal"');
    if (QUERY_RE.test('/goal ')) problems.push('query regex should reject "/goal "');
    if (QUERY_RE.test('a/goal')) problems.push('query regex should be anchored at start');
    if (!filterCommands('goa').some((c) => c.name === 'goal')) problems.push('filter misses goal');
    if (!NAME_RE.test('standup') || NAME_RE.test('Bad Name')) problems.push('name regex wrong');
    console.assert(problems.length === 0, '[slashcommands] self-check FAILED:', problems);
    if (!problems.length) console.log('[slashcommands] ready — type "/" in any chat composer.');
  })();
})();
