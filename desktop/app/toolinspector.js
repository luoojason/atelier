'use strict';

/* ===========================================================================
   Atelier feature module — tool-inspector card   (app/toolinspector.js)

   A read-only browser over every tool the backend exposes to agents: the ten
   LIGHT_TOOLS (server "atelier", available in all sessions) plus the orchestra
   tools SpawnAgent / CheckAgent / NavigateBrowser (server "orchestra",
   available to agent cards at depth 0). Registers the 'tools' app type via
   Atelier.registerApp.

   Backend contract (lite_server.py, fixed shape, never 500, no token):
     GET /tools -> {"tools":[{"name":<str>, "description":<str>,
                              "input_schema":{type,properties,required,...},
                              "server":<str>, "availability":<str>}]}

   One card (w 440 h 400, warm-cream idiom), fetch-on-demand like versions.js
   — NO polling: one GET /tools at spawn, then only when Refresh is clicked.
   Each tool renders as a row (name + server chip + first docstring line);
   clicking a row expands it in place: the full description, a server ·
   availability meta line, and a small table of the input schema's properties
   (name, type, required, description). Clicking again collapses it. Rows
   expand independently — no accordion, comparing two schemas side by side
   is the point of an inspector.

   XSS rule: every server-derived string (names, descriptions, schema types,
   availability) only ever enters the DOM via textContent. Backend unreachable
   -> a quiet inline note; Refresh retries. Stale-response guard: Refresh
   bumps a sequence counter and the async render re-checks it, so a slow
   response never lands over a newer one (or in a closed card).

   Reachability: NO dock button (the dock is full) — the card spawns from the
   ⌘K palette ("Add app: Tools") or Atelier.spawnApp('tools'). Same
   verification as runlog/versions: palette.js's buildCommands() runs at
   open() time and iterates A.apps, so registerApp alone is enough.

   Contract: builds ONLY against window.Atelier + fetch. Injects its own CSS.
   Loads after core.js (orchestrator owns the index.html script tag).

   ponytail: tool cards are not persisted (a board switch removes them via
   removeAllCards -> card:removed, same as runlog/versions cards). No search
   box, no JSON-schema pretty printer — the property table covers the schemas
   the backend actually serves. Filtering by server and a raw-schema toggle
   are the upgrades.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Start the backend (PORT=8765 .venv-ext/bin/python lite_server.py) and
      `npm start` in desktop/ — or open index.html in a plain browser.
   2. ⌘K → type "tools" → "Add app: Tools" → a warm-cream card spawns and
      GET /tools fires exactly once (Network tab; no polling after).
   3. The header reads "N tools" and the list shows every atelier tool plus
      SpawnAgent / CheckAgent / NavigateBrowser, each row = name + a small
      server chip (atelier / orchestra) + the first line of its description.
   4. Click a row → it expands in place: full description, a "server ·
      availability" line, and a properties table (name, type, required,
      description) matching the tool's input schema. Required params show
      "yes". Click the row again → it collapses. Two rows can be open at once.
   5. A tool whose schema has no properties (if any) expands to "No
      parameters." instead of an empty table — no crash.
   6. Click Refresh → one new GET /tools, the list rebuilds (expansions
      reset), the header count updates.
   7. Stop the backend, click Refresh → a quiet "Backend unreachable" note,
      the card stays usable, no console spam. Restart + Refresh → list loads.
   8. Close the card (×) or switch boards mid-fetch → no errors (stale
      responses are dropped). Console shows "[toolinspector] self-check
      passed" and no assert failures.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus) {
    console.warn('[toolinspector] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const CARD_W = 440;
  const CARD_H = 400;

  // ── injected styles (list + expansion inside the standard warm-cream card) ─
  (function injectStyles() {
    if (document.getElementById('atl-tools-styles')) return;
    const css = `
      .atl-tools-body { padding: 0; display: flex; flex-direction: column; }
      .atl-tools-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 11px; color: var(--ink-dim); }
      .atl-tools-crumb { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: var(--ink-mid); }
      .atl-tools-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-tools-btn:hover { border-color: var(--accent); }
      .atl-tools-note { font-size: 11px; color: var(--ink-dim);
        padding: 3px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-tools-note:empty { display: none; }
      .atl-tools-list { flex: 1; overflow: auto; }
      .atl-tools-row { display: flex; align-items: baseline; gap: 8px;
        padding: 7px 10px; border-bottom: 1px solid var(--border-soft);
        font-size: 12px; color: var(--ink-mid); cursor: pointer; }
      .atl-tools-row:hover { background: #f6f1e7; }
      .atl-tools-name { flex: 0 0 auto; font-weight: 600; color: var(--ink);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px; }
      .atl-tools-chip { flex: 0 0 auto; font-size: 10px; line-height: 1;
        padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border);
        color: var(--ink-dim); background: #faf7f1; }
      .atl-tools-chip-orchestra { border-color: var(--accent);
        color: var(--accent); }
      .atl-tools-brief { flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 11px; color: var(--ink-dim); }
      .atl-tools-detail { padding: 8px 10px 10px;
        border-bottom: 1px solid var(--border-soft); background: #fbf8f2; }
      .atl-tools-desc { margin: 0 0 6px; font-size: 11px; line-height: 1.5;
        color: var(--ink-mid); white-space: pre-wrap; word-break: break-word; }
      .atl-tools-meta { margin: 0 0 8px; font-size: 10px;
        color: var(--ink-dim); }
      .atl-tools-table { width: 100%; border-collapse: collapse;
        font-size: 11px; }
      .atl-tools-table th { text-align: left; font-weight: 600;
        color: var(--ink-dim); font-size: 10px; padding: 3px 8px 3px 0;
        border-bottom: 1px solid var(--border-soft); }
      .atl-tools-table td { vertical-align: top; color: var(--ink-mid);
        padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border-soft); }
      .atl-tools-table td.atl-tools-pname {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px; color: var(--ink); white-space: nowrap; }
      .atl-tools-noparams { font-size: 11px; color: var(--ink-dim); }
      .atl-tools-empty { padding: 16px 14px; font-size: 12px;
        color: var(--ink-dim); line-height: 1.5; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-tools-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  function firstLine(text) {
    const s = String(text || '');
    const nl = s.indexOf('\n');
    return (nl === -1 ? s : s.slice(0, nl)).trim();
  }

  // schema "type" can be a string, a list (["string","null"]), or absent —
  // render whatever the server sent as a readable string, never crash on it.
  function typeLabel(prop) {
    if (!prop || typeof prop !== 'object') return '';
    const t = prop.type;
    if (Array.isArray(t)) return t.map(String).join(' | ');
    if (t != null) return String(t);
    return '';
  }

  // ── expansion: full description + meta + schema property table ────────────
  function buildDetail(tool) {
    const detail = document.createElement('div');
    detail.className = 'atl-tools-detail';

    const desc = document.createElement('p');
    desc.className = 'atl-tools-desc';
    desc.textContent = String(tool.description || ''); // server text: textContent
    detail.appendChild(desc);

    const meta = document.createElement('p');
    meta.className = 'atl-tools-meta';
    meta.textContent = String(tool.server || '') + ' · '
      + String(tool.availability || '');
    detail.appendChild(meta);

    const schema = (tool.input_schema && typeof tool.input_schema === 'object')
      ? tool.input_schema : {};
    const props = (schema.properties && typeof schema.properties === 'object')
      ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const names = Object.keys(props);

    if (names.length === 0) {
      const none = document.createElement('div');
      none.className = 'atl-tools-noparams';
      none.textContent = 'No parameters.';
      detail.appendChild(none);
      return detail;
    }

    const table = document.createElement('table');
    table.className = 'atl-tools-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['name', 'type', 'required', 'description']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const pname of names) {
      const prop = props[pname];
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.className = 'atl-tools-pname';
      tdName.textContent = pname;
      const tdType = document.createElement('td');
      tdType.textContent = typeLabel(prop);
      const tdReq = document.createElement('td');
      tdReq.textContent = required.indexOf(pname) !== -1 ? 'yes' : '';
      const tdDesc = document.createElement('td');
      tdDesc.textContent = (prop && typeof prop === 'object')
        ? String(prop.description || '') : '';
      tr.append(tdName, tdType, tdReq, tdDesc);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    detail.appendChild(table);
    return detail;
  }

  // ── one tool-inspector card ────────────────────────────────────────────────
  function createToolsCard(worldPos) {
    // shell (same structure core's addCard expects: .card-bar / .card-x)
    const card = document.createElement('section');
    card.className = 'card app-card atl-tools-card';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = 'Tools';
    const closeX = document.createElement('span');
    closeX.className = 'card-x';
    closeX.textContent = '×';
    bar.append(dot, title, closeX);

    const body = document.createElement('div');
    body.className = 'app-body atl-tools-body';
    const head = document.createElement('div');
    head.className = 'atl-tools-head';
    const crumb = document.createElement('span');
    crumb.className = 'atl-tools-crumb';
    crumb.textContent = 'Tools';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'atl-tools-btn';
    refreshBtn.textContent = 'Refresh';
    head.append(crumb, refreshBtn);
    const note = document.createElement('div');
    note.className = 'atl-tools-note';
    const list = document.createElement('div');
    list.className = 'atl-tools-list';
    body.append(head, note, list);
    card.append(bar, body);

    // state
    let closed = false;
    let seq = 0; // bumped per load; stale fetch results are dropped

    function setNote(text) { note.textContent = text || ''; }

    function renderList(tools) {
      list.textContent = '';
      list.scrollTop = 0;
      crumb.textContent = tools.length + (tools.length === 1 ? ' tool' : ' tools');
      if (tools.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'atl-tools-empty';
        empty.textContent = 'No tools available yet.';
        list.appendChild(empty);
        return;
      }
      for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const item = document.createElement('div');
        const row = document.createElement('div');
        row.className = 'atl-tools-row';
        const name = document.createElement('span');
        name.className = 'atl-tools-name';
        name.textContent = String(tool.name || ''); // server text: textContent
        const chip = document.createElement('span');
        chip.className = 'atl-tools-chip'
          + (String(tool.server || '') === 'orchestra' ? ' atl-tools-chip-orchestra' : '');
        chip.textContent = String(tool.server || '');
        const brief = document.createElement('span');
        brief.className = 'atl-tools-brief';
        const briefText = firstLine(tool.description);
        brief.textContent = briefText;
        brief.title = briefText;
        row.append(name, chip, brief);
        item.appendChild(row);

        // click expands in place; the detail is built once, then toggled
        let detail = null;
        row.addEventListener('click', () => {
          if (detail === null) {
            detail = buildDetail(tool);
            item.appendChild(detail);
          } else {
            detail.hidden = !detail.hidden;
          }
        });
        list.appendChild(item);
      }
    }

    async function load() {
      const my = ++seq;
      setNote('');
      let tools = null;
      try {
        const headers = {};
        if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
        const res = await fetch(BASE + '/tools', { headers });
        const data = await res.json();
        if (res.ok && data && Array.isArray(data.tools)) tools = data.tools;
      } catch { /* backend unreachable — handled below */ }
      if (closed || my !== seq) return; // stale response / card closed
      if (tools === null) {
        setNote('Backend unreachable — click Refresh to retry.');
        return;
      }
      renderList(tools);
    }

    refreshBtn.addEventListener('click', load);

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
    // in-flight render (no timers here: the card never polls)
    const off = A.bus.on('card:removed', ({ el }) => {
      if (el !== card) return;
      closed = true;
      off();
    });

    load(); // one fetch now; after this only Refresh fetches
    return handle.el; // spawnApp sees dataset.cardId and won't re-add the card
  }

  // ── register the app type (⌘K palette + spawnApp pick this up) ────────────
  A.registerApp('tools', {
    label: 'Tools',
    icon: '⚙',
    create(worldPos) { return createToolsCard(worldPos); },
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('tools');
    console.assert(registered, '[toolinspector] tools app type not registered');
    const styles = !!document.getElementById('atl-tools-styles');
    console.assert(styles, '[toolinspector] styles not injected');
    if (registered && styles) {
      console.log('[toolinspector] self-check passed — tools app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
