'use strict';

/* Atelier feature module — apps  (OpenSwarm parity)
   ==================================================
   Real, movable/resizable app cards spawned from the bottom dock (and the
   palette / registry). Registers five app-card types via Atelier.registerApp
   (overriding core's boot stubs — registerApp overwrites by key) and owns the
   dock wiring, plus persistence of open apps + positions.

   Types:
     note      — sticky note: textarea that renders a SAFE markdown subset on
                 blur or Cmd/Ctrl+Enter (# ## ### headings, **bold**, *italic*,
                 `code`, ``` fences, - bullets, [text](http/https) links,
                 [[wikilinks]] as accent chips); click the rendered view to
                 edit again. Text persisted per note.
     browser   — a real multi-TAB Electron <webview> tile (partition
                 'persist:atelier-browser'): tab strip above the toolbar
                 (favicon + title + × per tab, [+] for a new tab), one webview
                 PER TAB — all stacked, inactive ones visibility:hidden
                 (keep-alive, OpenSwarm's model) — and the toolbar/URL bar/
                 card title follow the ACTIVE tab only. Falls back to per-tab
                 <iframe>s in a plain browser or when webviewTag is off.
                 Tab URLs + active index persist with the card. Popup routing
                 (contract): tab-disposition window.opens from ANY webview are
                 denied in main.js and arrive here over the preload bridge
                 (window.atelier.onWebviewNewWindow); they open as a new tab
                 in the most-recently-interacted browser card, or spawn a
                 fresh browser card when none exists.
     workflow  — live list of scheduler jobs from GET /jobs, refreshed
                 every 30s.
     calendar  — the same jobs as a compact readable schedule list,
                 refreshed every 30s.
     history   — live run ledger (GET /runs) + notifications
                 (GET /notifications), refreshed every 20s.

   Backend access: window.atelier.get(path) via the preload bridge when
   present, else plain fetch to http://127.0.0.1:8765 (plain-browser testing).
   All endpoint strings reach the DOM via textContent — never innerHTML.

   Dock wiring: index.html has six .dock-btn with title=Chat/Apps/Browser/
     Campaign/Notes/History. core.js already attached its own click handlers to
     these buttons, so this module CLONE-REPLACES each button (which strips
     core's listeners) and attaches its own — otherwise every click would spawn
     twice. This also fixes the "Notes" button, which core left inert.

   Persistence: open apps (type + config + rect) are stored under the Atelier
     store key "atelier.apps" and restored by restoreFromStore() — at load AND
     on 'boards:switched' (the in-place board switch: boards.js runs
     canvas.removeAllCards, which fires card:removed per app card — emptying
     openApps/browserCards and stopping every poll timer — swaps the live
     store keys to the target board, then emits 'boards:switched'; no page
     reload). A note's text and the browser's tab URLs + active index live in
     each app's config, so they survive a reload and a board round-trip
     (legacy configs with a single `url` still restore).

   Contract: builds ONLY against window.Atelier (+ the window.atelier preload
     bridge). Does not touch index.html, core.js, styles.css, or any other
     module. All CSS is injected below.

   ── SELF-CHECK ────────────────────────────────────────────────────────────
   Runtime assertions run at the bottom (see selfCheck): five types registered,
   the store key is an array, the dock has its buttons, normalizeUrl behaves,
   and the markdown renderer builds real DOM nodes (an <img …onerror…> payload
   must come out as literal text). On success the console logs
   "[apps] self-check passed".

   ── MANUAL TEST ───────────────────────────────────────────────────────────
     1. `npm start` in desktop/ (webview path needs main.js webviewTag:true) —
        or open index.html in a plain browser for the iframe + HTTP fallbacks.
     2. Browser dock button (🌐) → a card with a TAB STRIP above a back/
        forward/reload/URL/open toolbar loads https://duckduckgo.com. Type
        "example.com" ↵ → https://example.com loads and the URL bar follows;
        type "weather today" ↵ → a DuckDuckGo search; Back re-enables after
        the second navigation; the card title follows the page title; a thin
        accent bar under the toolbar pulses while loading. In a plain browser
        the same chrome drives per-tab <iframe>s and a hint line offers
        "Open in browser" for sites that block embedding.
     3. Tabs: [+] opens a second tab at the homepage; the tab shows a favicon
        (dot until 'page-favicon-updated') and the page title. Navigate tab 2
        somewhere, click tab 1 → URL bar, back/forward state, loading bar,
        and card title all snap back to tab 1 (events are wired per-tab).
        Tab 2 keeps playing/loading while hidden (keep-alive). × on a tab
        removes its webview; × on the LAST tab closes the whole card.
        Reload (Cmd-R) → the card reopens with the same tab URLs and the
        same active tab.
     4. Popups: inside a webview page, cmd-click a link / target=_blank →
        main.js denies the native window and the URL opens as a NEW TAB in
        the most-recently-interacted browser card (mousedown on a card, tab
        switch, and URL submit all count as interaction). With zero browser
        cards open, a browser card spawns at that URL. Real window.open
        popups (OAuth) still get main.js's hardened child window. In a plain
        browser the bridge is absent and nothing is registered.
     5. Notes (🗒): type "# Title", "- a", "- b", "**bold** *it* `code`",
        "[DDG](https://duckduckgo.com)", "[[Atelier]]", a ``` fence — then
        click away (blur) or hit Cmd/Ctrl+Enter → the textarea swaps to a
        rendered view (heading, bullets, bold/italic/code, accent link that
        opens the OS browser, accent wikilink chip, code block). Click the
        rendered view → back to the textarea, focused, cursor at the end.
        Reload (Cmd-R) → the note reopens RENDERED with the text intact.
        An all-whitespace note stays in edit mode. Paste
        "<img src=x onerror=alert(1)>" → renders as literal text (no HTML).
     6. History (🕘) → newest-first rows from /runs (green dot for ok, red
        otherwise; name; HH:MM; latency ms + tokens when present) and a
        Notifications section ("name: error") beneath; refreshes every 20s.
        With an empty ledger it shows "No runs yet — the scheduler ledger is
        empty."; with the backend down, an offline note.
     7. Campaign (↺) → one row per scheduler job: name, verbatim schedule
        pill, first-80-chars prompt excerpt, agent when set; the jobs file
        path is the footer. Calendar (🗓) → the same jobs as one line each:
        "name — cron 0 9 * * 1" or "name — every 30m". Both re-poll /jobs
        every 30s, so an edit to the jobs file shows up without respawning.
     8. Close a History, Campaign, or Calendar card (×) → its poll stops
        (watch the Network tab).
     9. Boards: open a browser (2 tabs) + a note, switch boards in the
        sidebar → both cards vanish with their polls/registries cleared (no
        /runs or /jobs requests from the old cards in the Network tab), the
        target board's own app cards mount in place, NO page reload; switch
        back → browser returns with both tab URLs + the active tab, the note
        returns rendered with its text.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.store) {
    console.warn('[apps] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.apps';
  const HOME_URL = 'https://duckduckgo.com';

  // Renderer HTTP fallback (contract): preload bridge when present, else plain
  // fetch so the module still works when index.html is opened in a browser.
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  // ── injected styles (warm palette via the shared CSS vars) ────────────────
  (function injectStyles() {
    if (document.getElementById('atl-apps-styles')) return;
    const css = `
      .atl-note-body { padding: 10px; }
      .atl-note-body .note-area { border-radius: 8px; padding: 8px; }
      .atl-note-view { height: 100%; overflow: auto; cursor: text;
        background: #fffdf7; border-radius: 8px; padding: 8px; }
      .atl-note-render { font-size: 13.5px; color: var(--ink); line-height: 1.55; }
      .atl-note-render h1 { font-size: 17px; margin: 4px 0 6px; }
      .atl-note-render h2 { font-size: 15px; margin: 4px 0 5px; }
      .atl-note-render h3 { font-size: 13.5px; margin: 4px 0 4px; }
      .atl-md-p { margin: 0 0 3px; }
      .atl-md-ul { margin: 2px 0 6px; padding-left: 18px; }
      .atl-md-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px; background: rgba(60, 48, 34, 0.07); border-radius: 4px;
        padding: 1px 4px; }
      .atl-md-pre { background: #f6f2ea; border: 1px solid var(--border-soft);
        border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 4px 0 6px; }
      .atl-md-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px; color: var(--ink); }
      .atl-md-wikilink { color: var(--accent); background: var(--accent-soft);
        border-radius: 4px; padding: 0 3px; }
      .atl-md-link { color: var(--accent); }

      .atl-tab-strip { flex: 0 0 auto; display: flex; align-items: center;
        gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border-soft);
        background: #f6f2ea; overflow-x: auto; }
      .atl-tab { display: flex; align-items: center; gap: 6px; flex: 0 1 150px;
        min-width: 56px; padding: 4px 6px 4px 8px; border-radius: 8px;
        cursor: pointer; font-size: 11.5px; color: var(--ink-mid);
        border: 1px solid transparent; }
      .atl-tab.active { background: var(--panel); border-color: var(--border);
        color: var(--ink); box-shadow: var(--shadow-sm); }
      .atl-tab-ico { flex: 0 0 12px; width: 12px; height: 12px; display: flex;
        align-items: center; justify-content: center; }
      .atl-tab-ico img { width: 12px; height: 12px; border-radius: 3px; }
      .atl-tab-dot { width: 7px; height: 7px; border-radius: 50%;
        background: var(--dot); }
      .atl-tab-title { flex: 1; min-width: 0; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .atl-tab-x { flex: 0 0 auto; border: none; background: transparent;
        color: var(--ink-dim); cursor: pointer; font-size: 13px; line-height: 1;
        padding: 0 2px; border-radius: 4px; }
      .atl-tab-x:hover { color: var(--accent); }
      .atl-tab-new { flex: 0 0 22px; width: 22px; height: 22px; border: none;
        border-radius: 6px; background: transparent; color: var(--ink-mid);
        cursor: pointer; font-size: 14px; line-height: 1; }
      .atl-tab-new:hover { background: rgba(60, 48, 34, 0.06); }

      .atl-browser-body { padding: 0; display: flex; flex-direction: column; }
      .atl-url-bar { display: flex; align-items: center; gap: 6px;
        padding: 8px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-tool-btn { flex: 0 0 auto; width: 28px; height: 28px; border: none;
        background: transparent; color: var(--ink-mid); border-radius: 8px;
        cursor: pointer; font-size: 15px; line-height: 1; }
      .atl-tool-btn:hover { background: rgba(60, 48, 34, 0.06); }
      .atl-tool-btn:disabled { opacity: 0.35; cursor: default; }
      .atl-url-input { flex: 1; min-width: 0; border: 1px solid var(--border);
        border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 12.5px;
        color: var(--ink); background: #faf7f1; outline: none; }
      .atl-url-input:focus { border-color: var(--accent); }
      .atl-loadbar { flex: 0 0 auto; height: 2px; background: transparent; }
      .atl-loadbar.on { background: var(--accent);
        animation: atl-load-pulse 1s ease-in-out infinite; }
      @keyframes atl-load-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.8; } }
      .atl-frame-note { font-size: 11.5px; color: var(--ink-dim);
        padding: 6px 10px; line-height: 1.4; }
      .atl-frame-note a { color: var(--accent); }
      .atl-frame-wrap { flex: 1; position: relative; background: #fff; }
      .atl-frame { position: absolute; inset: 0; width: 100%; height: 100%;
        border: none; background: #fff; }

      .atl-list-body { padding: 0; display: flex; flex-direction: column; }
      .atl-list-note { font-size: 11.5px; color: var(--ink-dim);
        padding: 9px 12px; border-bottom: 1px solid var(--border-soft); }
      .atl-row { display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--border-soft); }
      .atl-row:last-child { border-bottom: none; }
      .atl-row-main { flex: 1; min-width: 0; }
      .atl-row-title { font-size: 13px; color: var(--ink); font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .atl-row-sub { font-size: 11.5px; color: var(--ink-dim); margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .atl-dot { flex: 0 0 9px; width: 9px; height: 9px; border-radius: 50%;
        background: var(--ink-dim); }
      .atl-dot.ok { background: var(--ok); }
      .atl-dot.bad { background: var(--accent); }
      .atl-pill { font-size: 10.5px; font-weight: 600; padding: 2px 8px;
        border-radius: 20px; white-space: nowrap; color: var(--accent);
        background: var(--accent-soft); }
      .atl-sec-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em;
        text-transform: uppercase; color: var(--ink-dim); padding: 10px 12px 4px;
        border-top: 1px solid var(--border-soft); }
      .atl-notif-line { font-size: 11.5px; color: var(--ink-mid);
        padding: 4px 12px; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; }
      .atl-foot { margin-top: auto; font-size: 11px; color: var(--ink-dim);
        padding: 8px 12px; border-top: 1px solid var(--border-soft);
        word-break: break-all; }
      .atl-foot:empty { display: none; }
      .atl-sched-row { font-size: 12.5px; color: var(--ink); padding: 9px 12px;
        border-bottom: 1px solid var(--border-soft); white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .atl-sched-row:last-child { border-bottom: none; }
    `;
    const style = document.createElement('style');
    style.id = 'atl-apps-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── open-app registry + persistence ───────────────────────────────────────
  const openApps = new Map();     // appId -> { id, type, config, handle, cleanups }
  let idSeq = 0;
  function genId(type) { return type + '-' + Date.now().toString(36) + '-' + (idSeq++).toString(36); }

  function safeRect(handle) { try { return handle.getRect(); } catch { return null; } }
  function snapshot() {
    return [...openApps.values()].map((r) => ({
      id: r.id, type: r.type, config: r.config, rect: safeRect(r.handle),
    }));
  }
  function persist() { A.store.set(STORE_KEY, snapshot()); }
  let persistTimer = null;
  function persistDebounced() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 250); }

  // Save rects after a drag/resize. Capture-phase mousedown is used so it still
  // fires even though core's resize-handle listener calls stopPropagation().
  let pendingSave = false;
  document.addEventListener('mousedown', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (card && card.dataset.atlAppId && openApps.has(card.dataset.atlAppId)) pendingSave = true;
  }, true);
  document.addEventListener('mouseup', () => {
    if (pendingSave) { pendingSave = false; persist(); }
  });

  // Card closed via its × button → core emits card:removed; run the card's
  // cleanups (poll intervals etc.) and drop it from state.
  if (A.bus && typeof A.bus.on === 'function') {
    // boards.js emits this just before snapshotting a board switch: flush the
    // debounced save NOW and disarm the timer so it cannot fire after the
    // board's keys are swapped and leak this board's apps into the next one.
    A.bus.on('boards:will-switch', () => { clearTimeout(persistTimer); persist(); });
    // core's tidy() (zoombar ✦) repositions EVERY card with no mouse gesture
    // on the cards themselves — flush rects when it announces the rearrange,
    // or a reload would snap app cards back to their pre-tidy spots.
    A.bus.on('cards:rearranged', () => { clearTimeout(persistTimer); persist(); });
    A.bus.on('card:removed', ({ el }) => {
      const appId = el && el.dataset && el.dataset.atlAppId;
      if (!appId || !openApps.has(appId)) return;
      const rec = openApps.get(appId);
      (rec.cleanups || []).forEach((fn) => { try { fn(); } catch { /* best effort */ } });
      openApps.delete(appId);
      persist();
    });
    // In-place board switch: by the time boards.js emits this, every app card
    // is already gone (canvas.removeAllCards → card:removed above emptied
    // openApps/browserCards and cleared the poll timers) and the live store
    // keys hold the TARGET board's state — re-mount its apps. (Function
    // declaration below hoists; the handler only fires long after load.)
    A.bus.on('boards:switched', () => restoreFromStore());
  }

  // ── card shell (matches core's expected structure) ────────────────────────
  function cardShell(title) {
    const card = document.createElement('section');
    card.className = 'card app-card';
    card.innerHTML =
      '<div class="card-bar"><span class="card-dot"></span>' +
      '<span class="card-title"></span><span class="card-x">×</span></div>' +
      '<div class="app-body"></div>';
    card.querySelector('.card-title').textContent = title;
    return { card, body: card.querySelector('.app-body') };
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  // scheme -> as-is; ~ or / -> file://; localhost/IP[:port] -> http://;
  // single token with a dot -> https://; anything else -> DDG search.
  function normalizeUrl(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(about|data|mailto|file):/i.test(raw)) return raw;
    if (raw[0] === '~' || raw[0] === '/') return 'file://' + raw;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(raw)) return 'http://' + raw;
    if (!/\s/.test(raw) && raw.includes('.')) return 'https://' + raw;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
  }

  function fmtHHMM(ts) {
    if (ts == null || ts === '') return '';
    const d = new Date(typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : ts);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function noteEl(text) {
    const n = document.createElement('div');
    n.className = 'atl-list-note';
    n.textContent = text;
    return n;
  }

  const INTERVAL_RE = /^\s*(\d+)\s*([smhd])\s*$/i;   // scheduler shorthand: 30s/30m/2h/1d

  // Guard EVERY webview method call (they throw before the guest attaches)
  // and swallow ERR_ABORTED promise rejections.
  function wvCall(fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch(() => {});
      return r;
    } catch { return undefined; }
  }

  // ── tiny safe markdown (createElement/textContent ONLY — never innerHTML) ──
  // Subset: # ## ### headings, - bullets, ``` fences, **bold**, *italic*,
  // `code`, [text](http/https url), [[wikilinks]] (accent chips, no nav).
  // Alternation order matters: code first (its content is left verbatim),
  // bold before italic, wikilink before link.
  const MD_INLINE_RE =
    /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*(?=\S)[^*\n]+?(?<=\S)\*)|(\[\[([^\]\n]+)\]\])|(\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\))/;

  // ponytail: one inline level — no nesting (**bold *inside***); notes don't need it.
  function mdInline(target, text) {
    let rest = String(text);
    for (;;) {
      const m = MD_INLINE_RE.exec(rest);
      if (!m) break;
      if (m.index > 0) target.appendChild(document.createTextNode(rest.slice(0, m.index)));
      if (m[1]) {                       // `code`
        const c = document.createElement('code');
        c.className = 'atl-md-code';
        c.textContent = m[1].slice(1, -1);
        target.appendChild(c);
      } else if (m[2]) {                // **bold**
        const b = document.createElement('strong');
        b.textContent = m[2].slice(2, -2);
        target.appendChild(b);
      } else if (m[3]) {                // *italic*
        const it = document.createElement('em');
        it.textContent = m[3].slice(1, -1);
        target.appendChild(it);
      } else if (m[4]) {                // [[wikilink]] — accent chip, non-navigating
        const s = document.createElement('span');
        s.className = 'atl-md-wikilink';
        s.textContent = m[5];
        target.appendChild(s);
      } else {                          // [text](url) — regex admits http(s) only
        const a = document.createElement('a');
        a.className = 'atl-md-link';
        a.textContent = m[7] || m[8];
        a.href = m[8];
        a.target = '_blank';            // main.js window-open handler → OS browser
        a.rel = 'noopener noreferrer';
        target.appendChild(a);
      }
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) target.appendChild(document.createTextNode(rest));
  }

  function mdRender(text) {
    const root = document.createElement('div');
    root.className = 'atl-note-render';
    const lines = String(text).split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {          // fenced code block (verbatim, one <pre>)
        const buf = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;                         // skip the closing fence (or run off the end)
        const pre = document.createElement('pre');
        pre.className = 'atl-md-pre';
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        root.appendChild(pre);
        continue;
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        const el = document.createElement('h' + h[1].length);
        mdInline(el, h[2]);
        root.appendChild(el);
        i += 1;
        continue;
      }
      if (/^-\s+/.test(line)) {         // consecutive "- " lines form one list
        const ul = document.createElement('ul');
        ul.className = 'atl-md-ul';
        while (i < lines.length && /^-\s+/.test(lines[i])) {
          const li = document.createElement('li');
          mdInline(li, lines[i].replace(/^-\s+/, ''));
          ul.appendChild(li);
          i += 1;
        }
        root.appendChild(ul);
        continue;
      }
      if (line.trim() === '') { i += 1; continue; }
      // ponytail: one <p> per line — keeps a note's manual line breaks visible.
      const p = document.createElement('p');
      p.className = 'atl-md-p';
      mdInline(p, line);
      root.appendChild(p);
      i += 1;
    }
    return root;
  }

  // Live-card poll shared by History/Workflow/Calendar: run refresh now, again
  // every `ms`, and stop the timer when the card closes.
  function pollWhileOpen(ctl, refresh, ms) {
    refresh();
    const timer = setInterval(refresh, ms);
    ctl.onRemove(() => clearInterval(timer));
  }

  // ── builders (function declarations so TYPES below can reference them) ─────
  // Note: edit in a textarea, render markdown on blur (or Cmd/Ctrl+Enter),
  // click the rendered view to edit again. Persistence is unchanged — cfg.text
  // is written on every input, and the view toggle never touches it.
  function buildNote(body, cfg, ctl) {
    body.classList.add('atl-note-body');
    const ta = document.createElement('textarea');
    ta.className = 'note-area';
    ta.placeholder = 'Write a note…';
    ta.value = cfg.text || '';
    ta.addEventListener('input', () => ctl.setConfig({ text: ta.value }));

    const view = document.createElement('div');
    view.className = 'atl-note-view';
    view.title = 'Click to edit';
    view.style.display = 'none';
    body.append(ta, view);

    function showRendered() {
      if (!ta.value.trim()) return;      // nothing to render — stay editable
      view.textContent = '';             // clears children; no HTML parsing
      view.appendChild(mdRender(ta.value));
      ta.style.display = 'none';
      view.style.display = '';
    }
    function showEditor() {
      view.style.display = 'none';
      ta.style.display = '';
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);    // cursor at the end
    }

    ta.addEventListener('blur', showRendered);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ta.blur(); }
    });
    view.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let [text](url) links reach the OS browser
      showEditor();
    });

    if (ta.value.trim()) showRendered(); // restored notes open rendered
  }

  // ── browser: multi-tab card ────────────────────────────────────────────────
  // Most-recently-interacted browser card registry (module level). Popup URLs
  // routed by main.js over 'atelier:webview-new-window' land in the freshest
  // card via openTab; mousedown on a card, tab switches, and URL submits bump
  // the interaction stamp.
  const browserCards = new Set();   // { ts, openTab(url) }
  let interactionSeq = 0;

  function buildBrowser(body, cfg, ctl) {
    body.classList.add('atl-browser-body');

    // ── tab strip (above the toolbar) ─────────────────────────────────────
    const strip = document.createElement('div');
    strip.className = 'atl-tab-strip';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'atl-tab-new';
    newBtn.textContent = '+';
    newBtn.title = 'New tab';
    strip.appendChild(newBtn);

    // ── toolbar ───────────────────────────────────────────────────────────
    const bar = document.createElement('form');
    bar.className = 'atl-url-bar';
    function toolBtn(label, title) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'atl-tool-btn';
      b.textContent = label;
      b.title = title;
      return b;
    }
    const backBtn = toolBtn('‹', 'Back');
    const fwdBtn = toolBtn('›', 'Forward');
    const reloadBtn = toolBtn('⟳', 'Reload');
    const input = document.createElement('input');
    input.className = 'atl-url-input';
    input.type = 'text';
    input.placeholder = 'Search or enter a URL…';
    const extBtn = toolBtn('↗', 'Open in default browser');
    bar.append(backBtn, fwdBtn, reloadBtn, input, extBtn);

    const loadbar = document.createElement('div');
    loadbar.className = 'atl-loadbar';
    const frameWrap = document.createElement('div');
    frameWrap.className = 'atl-frame-wrap';
    body.append(strip, bar, loadbar, frameWrap);

    // ── tab state ─────────────────────────────────────────────────────────
    // tab = { el, icoHost, titleEl, frame, kind: 'webview'|'iframe', url,
    //         title, loading, canBack, canFwd, attached?, queued? }
    const tabs = [];
    let active = -1;
    let mode = null;      // decided by the first tab: 'webview' | 'iframe'
    let escLink = null;   // iframe-mode escape hatch; follows the active tab

    function activeTab() { return tabs[active] || null; }
    function isActive(tab) { return tabs[active] === tab; }
    function hostOf(u) { try { return new URL(u).host || u; } catch { return u || 'New tab'; } }

    function persistTabs() {
      const t = activeTab();
      ctl.setConfig({ tabs: tabs.map((x) => x.url || ''), active, url: (t && t.url) || '' });
    }

    function setTabTitle(tab, text) {
      tab.title = String(text || '');
      tab.titleEl.textContent = tab.title;                  // web-derived → textContent
      if (isActive(tab)) ctl.setTitle(tab.title || 'Browser');
    }
    function setTabIcon(tab, url) {
      tab.icoHost.textContent = '';
      if (url && /^(https?:|data:image\/)/i.test(url)) {    // favicon URL is web-derived
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;                                      // attribute set, never innerHTML
        img.addEventListener('error', () => setTabIcon(tab, ''));
        tab.icoHost.appendChild(img);
      } else {
        const dot = document.createElement('span');         // fallback dot
        dot.className = 'atl-tab-dot';
        tab.icoHost.appendChild(dot);
      }
    }
    function setLoading(tab, on) {
      tab.loading = !!on;
      if (isActive(tab)) loadbar.classList.toggle('on', tab.loading);
    }
    // The shared chrome (URL bar, back/fwd, loadbar, card title, esc link)
    // always mirrors the ACTIVE tab — per-tab events call this only when
    // their tab is the active one.
    function syncToolbar() {
      const t = activeTab();
      if (!t) return;
      if (document.activeElement !== input) input.value = t.url || '';
      backBtn.disabled = !t.canBack;
      fwdBtn.disabled = !t.canFwd;
      loadbar.classList.toggle('on', !!t.loading);
      ctl.setTitle(t.title || 'Browser');
      if (escLink) escLink.href = t.url || '#';
    }

    // ── frames (one per tab, stacked; inactive = visibility:hidden) ────────
    function createWebview(tab, startUrl) {
      // Attributes must be set BEFORE insertion — Electron reads
      // partition/useragent at attach time.
      const el = document.createElement('webview');
      el.setAttribute('partition', 'persist:atelier-browser');
      el.setAttribute('src', 'about:blank');
      el.setAttribute('useragent', navigator.userAgent.replace(/\s*Electron\/\S+/i, ''));
      el.setAttribute('webpreferences', 'autoplayPolicy=no-user-gesture-required');
      el.className = 'atl-frame';
      frameWrap.appendChild(el);
      if (typeof el.loadURL !== 'function') { el.remove(); return null; } // webviewTag off

      tab.attached = false;    // webview methods throw before the guest attaches
      tab.queued = startUrl;   // first real URL loads on the first dom-ready
      el.addEventListener('dom-ready', () => {
        tab.attached = true;
        if (tab.queued) { const u = tab.queued; tab.queued = null; wvCall(() => el.loadURL(u)); }
      }, { once: true });

      // Nav events are wired PER TAB: they update this tab's state and only
      // touch the shared UI while this tab is active.
      const syncNav = () => {
        const u = tab.attached ? wvCall(() => el.getURL()) : null;
        if (u && u !== 'about:blank') tab.url = u;
        tab.canBack = !!wvCall(() => el.canGoBack());
        tab.canFwd = !!wvCall(() => el.canGoForward());
        if (isActive(tab)) syncToolbar();
        persistTabs();
      };
      el.addEventListener('did-navigate', syncNav);
      el.addEventListener('did-navigate-in-page', syncNav);
      el.addEventListener('page-title-updated', (e) => { if (e.title) setTabTitle(tab, e.title); });
      el.addEventListener('page-favicon-updated', (e) => {
        setTabIcon(tab, (e.favicons && e.favicons[0]) || '');
      });
      el.addEventListener('did-start-navigation', (e) => {
        if (e.isMainFrame && !e.isInPlace) setLoading(tab, true);
      });
      el.addEventListener('did-stop-loading', () => setLoading(tab, false));
      return el;
    }

    function ensureIframeHint() {
      // Blank-iframe detection is unreliable cross-origin, so the escape
      // hatch is always visible instead (once per card).
      if (escLink) return;
      const hint = document.createElement('div');
      hint.className = 'atl-frame-note';
      hint.append(document.createTextNode('Iframe mode — sites that block embedding stay blank. '));
      escLink = document.createElement('a');
      escLink.textContent = 'Open in browser';
      escLink.target = '_blank';
      escLink.rel = 'noopener noreferrer';
      hint.appendChild(escLink);
      body.insertBefore(hint, frameWrap);
    }
    function createIframe(tab, startUrl) {
      const iframe = document.createElement('iframe');
      iframe.className = 'atl-frame';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      frameWrap.appendChild(iframe);
      iframe.addEventListener('load', () => setLoading(tab, false));
      tab.loading = true;
      iframe.src = startUrl;
      return iframe;
    }

    // ── tab ops ─────────────────────────────────────────────────────────────
    function newTab(url, activate) {
      const tab = { url: url || HOME_URL, title: '', loading: false, canBack: false, canFwd: false };

      const el = document.createElement('div');
      el.className = 'atl-tab';
      const ico = document.createElement('span');
      ico.className = 'atl-tab-ico';
      const titleEl = document.createElement('span');
      titleEl.className = 'atl-tab-title';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'atl-tab-x';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      el.append(ico, titleEl, closeBtn);
      strip.insertBefore(el, newBtn);
      tab.el = el; tab.icoHost = ico; tab.titleEl = titleEl;
      setTabIcon(tab, '');

      if (mode !== 'iframe' && window.atelier) {
        tab.frame = createWebview(tab, tab.url);
        if (tab.frame) { tab.kind = 'webview'; mode = 'webview'; }
      }
      if (!tab.frame) {                 // plain browser, or webviewTag off
        mode = 'iframe';
        ensureIframeHint();
        tab.kind = 'iframe';
        tab.frame = createIframe(tab, tab.url);
      }
      tab.frame.style.visibility = 'hidden';   // setActive reveals the active one
      setTabTitle(tab, hostOf(tab.url));       // provisional until page-title-updated

      tabs.push(tab);
      el.addEventListener('click', (e) => {
        if (e.target === closeBtn) return;
        setActive(tabs.indexOf(tab));
        bumpInteraction();
      });
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });

      if (activate) setActive(tabs.length - 1);
      else persistTabs();
      return tab;
    }

    function setActive(i) {
      if (i < 0 || i >= tabs.length) return;
      active = i;
      tabs.forEach((t, idx) => {
        t.el.classList.toggle('active', idx === i);
        // keep-alive (OpenSwarm's model): inactive tabs stay attached and
        // loaded, just hidden — never display:none, which detaches a webview.
        t.frame.style.visibility = idx === i ? 'visible' : 'hidden';
      });
      syncToolbar();
      persistTabs();
    }

    function closeTab(tab) {
      const i = tabs.indexOf(tab);
      if (i < 0) return;
      tabs.splice(i, 1);
      tab.el.remove();
      tab.frame.remove();                       // destroys the webview guest
      if (!tabs.length) { ctl.close(); return; } // closing the last tab closes the card
      if (i < active) active -= 1;
      else if (i === active) active = Math.min(i, tabs.length - 1);
      setActive(active);
    }

    function loadInTab(tab, u) {
      if (!tab || !u) return;
      tab.url = u;
      setTabTitle(tab, hostOf(u));              // provisional until the page titles itself
      if (tab.kind === 'webview') {
        if (tab.attached) wvCall(() => tab.frame.loadURL(u));
        else tab.queued = u;
      } else {
        setLoading(tab, true);
        tab.frame.src = u;
      }
      if (isActive(tab)) syncToolbar();
      persistTabs();
    }

    function currentUrl() {
      const t = activeTab();
      if (!t) return '';
      if (t.kind === 'webview' && t.attached) {
        const u = wvCall(() => t.frame.getURL());
        if (u && u !== 'about:blank') return u;
      }
      return t.url || '';
    }

    // ── toolbar wiring (acts on the ACTIVE tab) ─────────────────────────────
    backBtn.addEventListener('click', () => {
      const t = activeTab();
      if (!t) return;
      if (t.kind === 'webview') wvCall(() => t.frame.goBack());
      else { try { t.frame.contentWindow.history.back(); } catch { /* cross-origin */ } }
    });
    fwdBtn.addEventListener('click', () => {
      const t = activeTab();
      if (!t) return;
      if (t.kind === 'webview') wvCall(() => t.frame.goForward());
      else { try { t.frame.contentWindow.history.forward(); } catch { /* cross-origin */ } }
    });
    reloadBtn.addEventListener('click', () => {
      const t = activeTab();
      if (!t) return;
      if (t.kind === 'webview') { if (t.attached) wvCall(() => t.frame.reload()); }
      else if (t.url) { setLoading(t, true); t.frame.src = t.url; }
    });
    extBtn.addEventListener('click', () => {
      // window.open routes through main.js's setWindowOpenHandler for the
      // main window, which hands http(s) URLs to shell.openExternal — this
      // really opens the OS default browser in Electron.
      const u = currentUrl();
      if (u && u !== 'about:blank') window.open(u, '_blank', 'noopener');
    });
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      loadInTab(activeTab(), normalizeUrl(input.value));
      bumpInteraction();
    });
    newBtn.addEventListener('click', () => { newTab(HOME_URL, true); bumpInteraction(); });

    // ── most-recently-interacted registry (popup routing target) ───────────
    const cardApi = { ts: ++interactionSeq, openTab: (u) => { newTab(u, true); } };
    function bumpInteraction() { cardApi.ts = ++interactionSeq; }
    browserCards.add(cardApi);
    ctl.onRemove(() => browserCards.delete(cardApi));
    const cardEl = body.closest('.card');
    if (cardEl) cardEl.addEventListener('mousedown', bumpInteraction);
    // Marquee-link read surface (r15): window.AtelierApps.browserInfo(cardEl)
    // resolves to this card via the registry and reads the ACTIVE tab live —
    // current url (webview getURL when attached, else tab.url) + display
    // title (titleEl text, falling back to the card title text).
    cardApi.el = cardEl;
    cardApi.info = () => {
      const t = activeTab();
      if (!t) return null;
      let title = (t.titleEl && t.titleEl.textContent) || '';
      if (!title && cardEl) {
        const ct = cardEl.querySelector('.card-title');
        title = (ct && ct.textContent) || '';
      }
      return { url: currentUrl(), title };
    };
    // r16 (agent-driven linked browser): navigate THIS card's ACTIVE tab
    // through the exact normalize/load path the URL bar submit uses above.
    cardApi.navigate = (u) => { loadInTab(activeTab(), normalizeUrl(u)); };

    // ── boot tabs (legacy configs carry a single `url`) ─────────────────────
    // Scheme allowlist, not just "non-empty string": boards.js import writes
    // attacker-editable JSON into this config, so a crafted board file could
    // otherwise boot a tab at javascript:/data:/chrome: URLs. Normal
    // persistence only ever writes normalizeUrl/getURL output — http(s)/file.
    const bootableUrl = (u) => typeof u === 'string' && /^(https?|file):/i.test(u);
    const startTabs = (Array.isArray(cfg.tabs) ? cfg.tabs : []).filter(bootableUrl);
    if (!startTabs.length) startTabs.push(bootableUrl(cfg.url) ? cfg.url : HOME_URL);
    // Read the saved index BEFORE creating tabs — each newTab persists and
    // would overwrite cfg.active with the boot-time -1.
    const startActive = Math.min(Math.max(0, cfg.active | 0), startTabs.length - 1);
    startTabs.forEach((u) => newTab(u, false));
    setActive(startActive);
  }

  function buildHistory(body, cfg, ctl) {
    body.classList.add('atl-list-body');
    const host = document.createElement('div');
    body.appendChild(host);

    function render(runs, notifications) {
      host.textContent = '';
      if (!runs.length) {
        host.appendChild(noteEl('No runs yet — the scheduler ledger is empty.'));
      } else {
        // the ledger tail arrives oldest-first → show newest first
        runs.slice().reverse().forEach((r) => {
          const row = document.createElement('div');
          row.className = 'atl-row';
          const dot = document.createElement('span');
          dot.className = 'atl-dot ' + (r.status === 'ok' ? 'ok' : 'bad');
          const main = document.createElement('div');
          main.className = 'atl-row-main';
          const t = document.createElement('div');
          t.className = 'atl-row-title';
          t.textContent = r.name || '(unnamed)';
          const bits = [fmtHHMM(r.ts)];
          if (r.latency_ms != null) bits.push(r.latency_ms + ' ms');
          if (r.tokens != null) bits.push(r.tokens + ' tok');
          const s = document.createElement('div');
          s.className = 'atl-row-sub';
          s.textContent = bits.filter(Boolean).join(' · ');
          main.append(t, s);
          row.append(dot, main);
          host.appendChild(row);
        });
      }
      if (notifications.length) {
        const h = document.createElement('div');
        h.className = 'atl-sec-head';
        h.textContent = 'Notifications';
        host.appendChild(h);
        notifications.slice().reverse().forEach((n) => {
          const line = document.createElement('div');
          line.className = 'atl-notif-line';
          line.textContent = (n.name || '(unnamed)') + ': ' + (n.error || n.status || '');
          host.appendChild(line);
        });
      }
    }

    async function refresh() {
      try {
        const [rd, nd] = await Promise.all([
          api('/runs?limit=15'),
          api('/notifications?limit=5'),
        ]);
        render((rd && rd.runs) || [], (nd && nd.notifications) || []);
      } catch {
        host.textContent = '';
        host.appendChild(noteEl('Backend offline — the run ledger is unreachable.'));
      }
    }

    pollWhileOpen(ctl, refresh, 20000);
  }

  function buildWorkflow(body, cfg, ctl) {
    body.classList.add('atl-list-body');
    const host = document.createElement('div');
    host.appendChild(noteEl('Loading jobs…'));
    const foot = document.createElement('div');
    foot.className = 'atl-foot';
    body.append(host, foot);

    function refresh() {
      api('/jobs').then((data) => {
        host.textContent = '';
        const jobs = (data && data.jobs) || [];
        if (data && data.error) host.appendChild(noteEl(String(data.error)));
        if (!jobs.length) {
          if (!(data && data.error)) host.appendChild(noteEl('No scheduled jobs.'));
        } else {
          jobs.forEach((j) => {
            const row = document.createElement('div');
            row.className = 'atl-row';
            const main = document.createElement('div');
            main.className = 'atl-row-main';
            const t = document.createElement('div');
            t.className = 'atl-row-title';
            t.textContent = j.name || '(unnamed)';
            const s = document.createElement('div');
            s.className = 'atl-row-sub';
            const excerpt = String(j.prompt || '').slice(0, 80);
            s.textContent = excerpt + (j.agent ? ' · ' + j.agent : '');
            main.append(t, s);
            const pill = document.createElement('span');
            pill.className = 'atl-pill';
            pill.textContent = String(j.schedule || '');
            row.append(main, pill);
            host.appendChild(row);
          });
        }
        foot.textContent = (data && data.file) ? String(data.file) : '';
      }).catch(() => {
        host.textContent = '';
        host.appendChild(noteEl('Backend offline — jobs unavailable.'));
      });
    }

    pollWhileOpen(ctl, refresh, 30000);
  }

  // ponytail: a readable schedule list, not a month grid — grid is decoration
  // until jobs carry dates.
  function buildCalendar(body, cfg, ctl) {
    body.classList.add('atl-list-body');
    const host = document.createElement('div');
    host.appendChild(noteEl('Loading schedule…'));
    body.appendChild(host);

    function refresh() {
      api('/jobs').then((data) => {
        host.textContent = '';
        const jobs = (data && data.jobs) || [];
        if (!jobs.length) {
          host.appendChild(noteEl((data && data.error) ? String(data.error) : 'No scheduled jobs.'));
          return;
        }
        jobs.forEach((j) => {
          const line = document.createElement('div');
          line.className = 'atl-sched-row';
          const name = j.name || '(unnamed)';
          const sched = String(j.schedule || '');
          const m = INTERVAL_RE.exec(sched);
          line.textContent = m
            ? name + ' — every ' + m[1] + m[2].toLowerCase()
            : name + ' — cron ' + sched;
          host.appendChild(line);
        });
      }).catch(() => {
        host.textContent = '';
        host.appendChild(noteEl('Backend offline — schedule unavailable.'));
      });
    }

    pollWhileOpen(ctl, refresh, 30000);
  }

  // ── type table ────────────────────────────────────────────────────────────
  const TYPES = {
    note:     { label: 'Note', icon: '🗒', title: 'Note', w: 300, h: 240, defaultConfig: { text: '' }, build: buildNote },
    browser:  { label: 'Browser', icon: '🌐', title: 'Browser', w: 520, h: 420, defaultConfig: { url: '' }, build: buildBrowser },
    workflow: { label: 'Workflow', icon: '↺', title: 'Workflow', w: 380, h: 290, defaultConfig: {}, build: buildWorkflow },
    calendar: { label: 'Calendar', icon: '🗓', title: 'Calendar', w: 340, h: 280, defaultConfig: {}, build: buildCalendar },
    history:  { label: 'History', icon: '🕘', title: 'History', w: 380, h: 320, defaultConfig: {}, build: buildHistory },
  };

  // ── spawn (also the registered create() path) ─────────────────────────────
  function centerPos(w, h) {
    const canvasEl = document.getElementById('canvas');
    const r = canvasEl.getBoundingClientRect();
    const world = A.canvas.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    const off = (openApps.size % 6) * 26;            // cascade so cards don't stack exactly
    return { x: world.x - w / 2 + off, y: world.y - h / 2 + off };
  }

  function makeApp(type, opts) {
    opts = opts || {};
    const def = TYPES[type];
    if (!def) return null;
    const appId = opts.id || genId(type);
    const cfg = Object.assign({}, def.defaultConfig || {}, opts.config || {});
    const shell = cardShell(def.title);
    shell.card.dataset.atlAppId = appId;

    const cleanups = [];
    const ctl = {
      setConfig(patch) { Object.assign(cfg, patch); persistDebounced(); },
      setTitle(text) {
        const t = shell.card.querySelector('.card-title');
        if (t) t.textContent = String(text);
      },
      onRemove(fn) { cleanups.push(fn); },
      close() {
        // Route through the handle so core emits card:removed → cleanups run.
        // Only callable after spawn (user interaction), when the handle exists.
        const rec = openApps.get(appId);
        if (rec && rec.handle) rec.handle.remove();
      },
    };
    def.build(shell.body, cfg, ctl);

    const rect = opts.rect || {};
    let x, y;
    if (rect.x != null && rect.y != null) { x = rect.x; y = rect.y; }
    else if (opts.pos) { x = opts.pos.x; y = opts.pos.y; }
    else { const p = centerPos(def.w, def.h); x = p.x; y = p.y; }
    const w = rect.w || def.w;
    const h = rect.h || def.h;

    const handle = A.canvas.addCard(shell.card, { x, y, w, h });
    openApps.set(appId, { id: appId, type, config: cfg, handle, cleanups });
    persist();
    return handle;
  }

  // ── register the five app types (overrides core's stubs) ──────────────────
  Object.keys(TYPES).forEach((type) => {
    const def = TYPES[type];
    A.registerApp(type, {
      label: def.label,
      icon: def.icon,
      defaultConfig: def.defaultConfig,
      // core.spawnApp / the palette call this; makeApp already runs addCard, so
      // core sees dataset.cardId and returns the element without re-adding it.
      create(worldPos) { const h = makeApp(type, { pos: worldPos }); return h ? h.el : null; },
    });
  });

  // ── restore open apps from the store (load + every board switch) ──────────
  // Formerly a load-only IIFE; 'boards:switched' re-runs it after an in-place
  // switch. Idempotent: records whose id is still mounted are skipped, and any
  // registry entry whose card element left the DOM without card:removed (core
  // routes removals through the handles, so this should never happen — belt
  // and braces) is swept, cleanups and all, BEFORE mounting. That keeps every
  // internal registry — openApps, browserCards, per-card poll timers, and the
  // browser cards' tab/webview keep-alive state (card-scoped closures + DOM,
  // freed with the card) — from outliving its card into the next board. No
  // persist() in the sweep: mid-switch the store already holds the TARGET
  // board's keys, and writing leftovers would clobber them.
  function restoreFromStore() {
    clearTimeout(persistTimer);   // a stale debounce must not race the mount
    openApps.forEach((rec, appId) => {
      if (rec.handle && rec.handle.el && rec.handle.el.isConnected) return;
      (rec.cleanups || []).forEach((fn) => { try { fn(); } catch { /* best effort */ } });
      openApps.delete(appId);
    });
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    saved.forEach((rec) => {
      if (!rec || !TYPES[rec.type]) return;
      if (rec.id && openApps.has(rec.id)) return;   // already live — skip
      makeApp(rec.type, { id: rec.id, config: rec.config, rect: rec.rect || undefined });
    });
  }
  restoreFromStore();

  // ── own the dock (clone-replace strips core's listeners → no double-spawn) ─
  const DOCK_MAP = {
    apps: 'note', browser: 'browser', campaign: 'workflow',
    notes: 'note', history: 'history', calendar: 'calendar',
  };
  (function wireDock() {
    document.querySelectorAll('.dock-btn').forEach((btn) => {
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        document.querySelectorAll('.dock-btn').forEach((x) => x.classList.remove('active'));
        fresh.classList.add('active');
        const t = (fresh.getAttribute('title') || '').toLowerCase();
        if (t === 'chat') { const i = document.getElementById('input'); if (i) i.focus(); return; }
        const type = DOCK_MAP[t];
        if (type) makeApp(type, {});
      });
    });
  })();

  // ── webview popup routing (contract interface 1, apps.js side) ────────────
  // main.js denies tab-disposition window.opens from <webview>s and forwards
  // the URL over 'atelier:webview-new-window'; the preload bridge surfaces it
  // as window.atelier.onWebviewNewWindow. ONE module-level registration: open
  // the URL as a new tab in the most-recently-interacted browser card, else
  // spawn a browser card at that URL. Guarded — in a plain browser (or until
  // the preload side lands) the bridge method is simply absent.
  if (window.atelier && typeof window.atelier.onWebviewNewWindow === 'function') {
    window.atelier.onWebviewNewWindow((data) => {
      const url = data && data.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return; // web URLs only
      let best = null;
      browserCards.forEach((c) => { if (!best || c.ts > best.ts) best = c; });
      if (best) best.openTab(url);
      else makeApp('browser', { config: { tabs: [url], active: 0 } });
    });
  }

  // ── public surface (r15): read accessor for link.js marquee-linking ───────
  // browserInfo(cardEl) -> { url, title } when cardEl is a LIVE browser card
  // (active tab's current url + display title), null for anything else —
  // closed/removed cards leave browserCards via their card:removed cleanup.
  function browserInfo(cardEl) {
    if (!cardEl) return null;
    for (const c of browserCards) {
      if (c.el === cardEl) return typeof c.info === 'function' ? c.info() : null;
    }
    return null;
  }
  // browserNavigate(cardEl, url) -> boolean (r16): navigate a LIVE browser
  // card's ACTIVE tab. Only http(s) URLs are accepted; a non-browser card,
  // a removed card, or any other scheme is refused with false. Delegates to
  // the card's own navigate closure — the same normalize/load path as its
  // URL bar — so title sync, loading state, and persistence all apply.
  function browserNavigate(cardEl, url) {
    if (!cardEl || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    for (const c of browserCards) {
      if (c.el === cardEl && typeof c.navigate === 'function') {
        c.navigate(url);
        return true;
      }
    }
    return false;
  }
  window.AtelierApps = { browserInfo, browserNavigate };

  // ── self-check ────────────────────────────────────────────────────────────
  (function selfCheck() {
    const need = ['note', 'browser', 'workflow', 'calendar', 'history'];
    const missing = need.filter((t) => !(A.apps && A.apps.has(t)));
    console.assert(missing.length === 0, '[apps] missing registered types:', missing);
    const stored = A.store.get(STORE_KEY, []);
    console.assert(Array.isArray(stored), '[apps] store key atelier.apps is not an array');
    const dock = document.querySelectorAll('.dock-btn');
    console.assert(dock.length >= 6, '[apps] expected 6 dock buttons, got', dock.length);
    console.assert(normalizeUrl('example.com') === 'https://example.com', '[apps] normalizeUrl token+dot failed');
    console.assert(normalizeUrl('localhost:8765') === 'http://localhost:8765', '[apps] normalizeUrl localhost failed');
    console.assert(normalizeUrl('hello world') === 'https://duckduckgo.com/?q=hello%20world', '[apps] normalizeUrl search failed');
    // markdown renderer: DOM-built, HTML-inert, subset works
    const md = mdRender('# T\n- a\n**b** *i* `c` [x](https://example.com) [[Wiki]] <img src=x onerror=alert(1)>');
    console.assert(!md.querySelector('img'), '[apps] markdown rendered raw HTML — XSS regression');
    const mdA = md.querySelector('a');
    console.assert(mdA && mdA.href.indexOf('https://example.com') === 0 && mdA.target === '_blank',
      '[apps] markdown link failed');
    console.assert(md.querySelector('h1') && md.querySelector('ul li') && md.querySelector('strong')
      && md.querySelector('em') && md.querySelector('code') && md.querySelector('.atl-md-wikilink'),
      '[apps] markdown subset failed');
    if (!missing.length && Array.isArray(stored) && dock.length >= 6) {
      console.log('[apps] self-check passed — 5 app types registered, dock wired, store ok.');
    }
  })();
})();
