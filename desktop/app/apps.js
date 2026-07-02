'use strict';

/* Atelier feature module — apps  (OpenSwarm parity)
   ==================================================
   Real, movable/resizable app cards spawned from the bottom dock (and the
   palette / registry). Registers five app-card types via Atelier.registerApp
   (overriding core's boot stubs — registerApp overwrites by key) and owns the
   dock wiring, plus persistence of open apps + positions.

   Types:
     note      — editable sticky note (textarea), text persisted per note.
     browser   — a real Electron <webview> tile (partition
                 'persist:atelier-browser') with back/forward/reload/URL/open
                 toolbar; falls back to an <iframe> in a plain browser or when
                 webviewTag is off.
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
     store key "atelier.apps" and restored on load. A note's text and the
     browser's URL live in each app's config, so they survive a reload.

   Contract: builds ONLY against window.Atelier (+ the window.atelier preload
     bridge). Does not touch index.html, core.js, styles.css, or any other
     module. All CSS is injected below.

   ── SELF-CHECK ────────────────────────────────────────────────────────────
   Runtime assertions run at the bottom (see selfCheck): five types registered,
   the store key is an array, the dock has its buttons. On success the console
   logs "[apps] self-check passed".

   ── MANUAL TEST ───────────────────────────────────────────────────────────
     1. `npm start` in desktop/ (webview path needs main.js webviewTag:true) —
        or open index.html in a plain browser for the iframe + HTTP fallbacks.
     2. Browser dock button (🌐) → a card with a back/forward/reload/URL/open
        toolbar loads https://duckduckgo.com in a <webview>. Type
        "example.com" ↵ → https://example.com loads and the URL bar follows;
        type "weather today" ↵ → a DuckDuckGo search; Back re-enables after
        the second navigation; the card title follows the page title; a thin
        accent bar under the toolbar pulses while loading. In a plain browser
        the same toolbar drives an <iframe> and a hint line offers "Open in
        browser" for sites that block embedding.
     3. History (🕘) → newest-first rows from /runs (green dot for ok, red
        otherwise; name; HH:MM; latency ms + tokens when present) and a
        Notifications section ("name: error") beneath; refreshes every 20s.
        With an empty ledger it shows "No runs yet — the scheduler ledger is
        empty."; with the backend down, an offline note.
     4. Campaign (↺) → one row per scheduler job: name, verbatim schedule
        pill, first-80-chars prompt excerpt, agent when set; the jobs file
        path is the footer. Calendar (🗓) → the same jobs as one line each:
        "name — cron 0 9 * * 1" or "name — every 30m". Both re-poll /jobs
        every 30s, so an edit to the jobs file shows up without respawning.
     5. Notes (🗒): type text, reload (Cmd-R) → the note reopens at its
        position with the text intact.
     6. Close a History, Campaign, or Calendar card (×) → its poll stops
        (watch the Network tab).
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
    A.bus.on('card:removed', ({ el }) => {
      const appId = el && el.dataset && el.dataset.atlAppId;
      if (!appId || !openApps.has(appId)) return;
      const rec = openApps.get(appId);
      (rec.cleanups || []).forEach((fn) => { try { fn(); } catch { /* best effort */ } });
      openApps.delete(appId);
      persist();
    });
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

  // Live-card poll shared by History/Workflow/Calendar: run refresh now, again
  // every `ms`, and stop the timer when the card closes.
  function pollWhileOpen(ctl, refresh, ms) {
    refresh();
    const timer = setInterval(refresh, ms);
    ctl.onRemove(() => clearInterval(timer));
  }

  // ── builders (function declarations so TYPES below can reference them) ─────
  function buildNote(body, cfg, ctl) {
    body.classList.add('atl-note-body');
    const ta = document.createElement('textarea');
    ta.className = 'note-area';
    ta.placeholder = 'Write a note…';
    ta.value = cfg.text || '';
    ta.addEventListener('input', () => ctl.setConfig({ text: ta.value }));
    body.appendChild(ta);
  }

  // ponytail: no tabs, one page per card — tabs are the upgrade path; popups
  // are denied by main in v1 (OAuth-in-browser-card needs routing later).
  function buildBrowser(body, cfg, ctl) {
    body.classList.add('atl-browser-body');

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
    body.append(bar, loadbar, frameWrap);

    const startUrl = cfg.url || HOME_URL;

    // Try the real <webview>. Attributes must be set BEFORE insertion —
    // Electron reads partition/useragent at attach time.
    let wv = null;
    if (window.atelier) {
      const el = document.createElement('webview');
      el.setAttribute('partition', 'persist:atelier-browser');
      el.setAttribute('src', 'about:blank');
      el.setAttribute('useragent', navigator.userAgent.replace(/\s*Electron\/\S+/i, ''));
      el.setAttribute('webpreferences', 'autoplayPolicy=no-user-gesture-required');
      el.className = 'atl-frame';
      frameWrap.appendChild(el);
      if (typeof el.loadURL === 'function') wv = el;   // webviewTag on → element upgraded
      else el.remove();                                // webviewTag off → dead node; iframe below
    }

    if (wv) {
      // ── webview mode ──────────────────────────────────────────────────────
      let attached = false;      // webview methods throw before the guest attaches
      let queued = startUrl;     // first real URL loads on the first dom-ready
      const call = (fn) => {     // guard EVERY method call + swallow ERR_ABORTED rejections
        try {
          const r = fn();
          if (r && typeof r.catch === 'function') r.catch(() => {});
          return r;
        } catch { return undefined; }
      };

      wv.addEventListener('dom-ready', () => {
        attached = true;
        if (queued) { const u = queued; queued = null; call(() => wv.loadURL(u)); }
      }, { once: true });

      function currentUrl() {
        const u = attached ? call(() => wv.getURL()) : null;
        return (u && u !== 'about:blank') ? u : (input.value || startUrl);
      }
      function syncNav() {
        if (!attached) return;
        const u = call(() => wv.getURL());
        if (u && u !== 'about:blank') {
          if (document.activeElement !== input) input.value = u;
          ctl.setConfig({ url: u });
        }
        backBtn.disabled = !call(() => wv.canGoBack());
        fwdBtn.disabled = !call(() => wv.canGoForward());
      }
      function load(u) {
        if (!u) return;
        ctl.setConfig({ url: u });
        if (attached) call(() => wv.loadURL(u));
        else queued = u;
      }

      wv.addEventListener('did-navigate', syncNav);
      wv.addEventListener('did-navigate-in-page', syncNav);
      wv.addEventListener('page-title-updated', (e) => { if (e.title) ctl.setTitle(e.title); });
      wv.addEventListener('did-start-navigation', (e) => {
        if (e.isMainFrame && !e.isInPlace) loadbar.classList.add('on');
      });
      wv.addEventListener('did-stop-loading', () => loadbar.classList.remove('on'));

      backBtn.addEventListener('click', () => call(() => wv.goBack()));
      fwdBtn.addEventListener('click', () => call(() => wv.goForward()));
      reloadBtn.addEventListener('click', () => { if (attached) call(() => wv.reload()); });
      extBtn.addEventListener('click', () => {
        // window.open routes through main.js's setWindowOpenHandler for the
        // main window, which hands http(s) URLs to shell.openExternal — this
        // really opens the OS default browser in Electron.
        const u = currentUrl();
        if (u && u !== 'about:blank') window.open(u, '_blank', 'noopener');
      });
      bar.addEventListener('submit', (e) => { e.preventDefault(); load(normalizeUrl(input.value)); });

      input.value = startUrl;
      backBtn.disabled = true;
      fwdBtn.disabled = true;
    } else {
      // ── iframe fallback (plain browser, or webviewTag off) ────────────────
      const iframe = document.createElement('iframe');
      iframe.className = 'atl-frame';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      frameWrap.appendChild(iframe);

      // Blank-iframe detection is unreliable cross-origin, so the escape hatch
      // is always visible instead.
      const hint = document.createElement('div');
      hint.className = 'atl-frame-note';
      hint.append(document.createTextNode('Iframe mode — sites that block embedding stay blank. '));
      const escLink = document.createElement('a');
      escLink.textContent = 'Open in browser';
      escLink.target = '_blank';
      escLink.rel = 'noopener noreferrer';
      hint.appendChild(escLink);
      body.insertBefore(hint, frameWrap);

      let current = '';
      function load(u) {
        if (!u) return;
        current = u;
        iframe.src = u;
        escLink.href = u;
        if (document.activeElement !== input) input.value = u;
        ctl.setConfig({ url: u });
        loadbar.classList.add('on');
      }
      iframe.addEventListener('load', () => loadbar.classList.remove('on'));

      // Cross-origin frames refuse history access; best effort only.
      backBtn.addEventListener('click', () => { try { iframe.contentWindow.history.back(); } catch { /* cross-origin */ } });
      fwdBtn.addEventListener('click', () => { try { iframe.contentWindow.history.forward(); } catch { /* cross-origin */ } });
      reloadBtn.addEventListener('click', () => { if (current) iframe.src = current; });
      extBtn.addEventListener('click', () => { if (current) window.open(current, '_blank', 'noopener'); });
      bar.addEventListener('submit', (e) => { e.preventDefault(); load(normalizeUrl(input.value)); });

      load(startUrl);
    }
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

  // ── restore previously-open apps ──────────────────────────────────────────
  (function restore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    saved.forEach((rec) => {
      if (!rec || !TYPES[rec.type]) return;
      makeApp(rec.type, { id: rec.id, config: rec.config, rect: rec.rect || undefined });
    });
  })();

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
    if (!missing.length && Array.isArray(stored) && dock.length >= 6) {
      console.log('[apps] self-check passed — 5 app types registered, dock wired, store ok.');
    }
  })();
})();
