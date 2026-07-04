'use strict';

/* ===========================================================================
   Atelier feature module — Approval gate ("hold for approval" lane)
   (app/approvals.js)

   A persistent review lane. The framing is simple: nothing an agent produces is
   "done" until a human approves it. Workspace files an agent writes, and the
   note / document deliverables it drops on the canvas, land here first as
   PENDING items. Each one shows a plain-language preview with Approve and
   Dismiss, and an Undo right after you act so a slip is one click to fix.

   How it fills up
   ---------------
   No central run bus exists, so this mirrors recipes.js: it polls GET /sessions
   on a light cadence and watches each session flip running -> idle (a finished
   turn). On that edge it reads GET /sessions/{id} to collect the note/document
   canvas ops that turn produced, and it rescans the workspace for files written
   or changed since the module started. Everything found that has not already
   been decided gets held in the lane for review.

   Two output channels
   -------------------
   1. Canvas deliverables (note / document ops) — reachable today from
      GET /sessions/{id}, no backend work needed.
   2. Workspace files (WriteFile output) — needs two small read endpoints the
      host wires in (see the header note near WORKSPACE_* below). Until they
      exist this module degrades to empty for files and still gates canvas
      deliverables; it never throws.

   Publish comes later. So this only gates workspace OUTPUTS for now, but the
   lane exposes enqueue()/gate() so a future publish step can require approval
   through the exact same surface (see the public API at the bottom).

   Contract: builds only against window.Atelier (+ the optional window.atelier
   token bridge for reads, and localStorage for remembered decisions). Injects
   its own CSS. XSS rule: every dynamic/server string enters the DOM via
   textContent only; document HTML is turned into a plain-text peek with
   DOMParser (which does not execute scripts) and never innerHTML'd.

   Cost note: all polling here hits the local FastAPI server, so it spends zero
   subscription / rate-limit headroom. Only agents spend tokens.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui || !A.store) {
    console.warn('[approvals] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 2000;                        // session-status poll cadence (token-free)
  const PREVIEW_CHARS = 1400;                  // cap on any preview text put in the DOM
  const UNDO_KEYS = 'atelier.approvals.decided'; // localStorage: key -> { status, ts }

  // Workspace read endpoints assumed on the host (see backendNeeded in the
  // handoff). Both degrade to empty here if absent, so the lane still works.
  const WORKSPACE_LIST = '/workspace/files';   // -> { files: [{ path, size, mtime }] }
  const WORKSPACE_FILE = '/workspace/file';    // ?path=... -> { path, text }

  // ── tiny helpers ────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clamp(str, n) {
    const s = String(str == null ? '' : str);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function baseName(path) {
    const p = String(path || '');
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  }
  // Turn document HTML into a readable plain-text peek WITHOUT executing it.
  // DOMParser('text/html') builds an inert tree (no script execution, no
  // resource loads); we only read textContent off it.
  function htmlToText(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      return (doc.body && doc.body.textContent ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  // ── backend read helper (guarded, never throws) ─────────────────────────────
  // Prefer the window.atelier bridge (no CSP origin allow-list needed); fall
  // back to a plain fetch with the optional token header, like recipes.js.
  async function apiGet(path) {
    try {
      if (window.atelier && typeof window.atelier.get === 'function') {
        return await window.atelier.get(path);
      }
    } catch {
      return null;
    }
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ── remembered decisions (localStorage, global — survives board switches) ───
  // Kept out of Atelier.store on purpose: store keys are board-scoped unless a
  // module is listed in boards.js GLOBAL_KEYS, and an approval decision should
  // follow the artifact, not the board it was reviewed on.
  function loadDecided() {
    try { return JSON.parse(window.localStorage.getItem(UNDO_KEYS) || '{}') || {}; }
    catch { return {}; }
  }
  function saveDecided(map) {
    try { window.localStorage.setItem(UNDO_KEYS, JSON.stringify(map)); }
    catch { /* private mode — decisions just won't persist */ }
  }
  function decisionOf(key) {
    const d = loadDecided();
    return d[key] ? d[key].status : null;   // 'approved' | 'dismissed' | null
  }
  function setDecision(key, status) {
    const d = loadDecided();
    if (status == null) delete d[key];
    else d[key] = { status, ts: Date.now() };
    saveDecided(d);
  }

  // ── in-memory pending queue ─────────────────────────────────────────────────
  // item: { key, kind:'file'|'note'|'document'|'publish', title, path?, sessionId?,
  //         preview, previewLoaded, html?, ts, onApprove?, onDismiss? }
  const items = [];
  const seen = new Set();                   // keys ever enqueued (dedupe)

  function pendingCount() { return items.length; }

  function enqueue(item) {
    if (!item || !item.key) return false;
    if (seen.has(item.key)) return false;
    if (decisionOf(item.key)) { seen.add(item.key); return false; } // already reviewed
    seen.add(item.key);
    items.push(Object.assign({ ts: Date.now(), kind: 'file', title: item.key }, item));
    onQueueChanged();
    return true;
  }

  function removeItem(key) {
    const i = items.findIndex((x) => x.key === key);
    if (i !== -1) items.splice(i, 1);
  }

  // ── act: approve / dismiss, with a one-step undo ────────────────────────────
  let lastAction = null;                    // { item, status } for undo

  function decide(item, status) {
    if (!item) return;
    setDecision(item.key, status);
    removeItem(item.key);
    lastAction = { item, status };
    // Let a caller (e.g. a future publish gate) resolve on the decision.
    try {
      if (status === 'approved' && typeof item.onApprove === 'function') item.onApprove();
      if (status === 'dismissed' && typeof item.onDismiss === 'function') item.onDismiss();
    } catch { /* handler is caller's concern */ }
    if (typeof item.resolve === 'function') { try { item.resolve(status === 'approved'); } catch {} }
    onQueueChanged();
    render();
    announce((status === 'approved' ? 'Approved' : 'Dismissed') + ': ' + shortTitle(item));
    showUndoToast(item, status);
  }

  function undoLast() {
    if (!lastAction) return;
    const { item } = lastAction;
    setDecision(item.key, null);            // forget the decision
    seen.delete(item.key);                  // allow it back into the queue
    lastAction = null;
    // Re-hold the item as pending (skip the "already decided" short-circuit).
    seen.add(item.key);
    items.push(item);
    if (typeof item.reopen === 'function') { try { item.reopen(); } catch {} }
    onQueueChanged();
    render();
    announce('Restored: ' + shortTitle(item));
  }

  function shortTitle(item) {
    return clamp(item.title || item.path || item.key, 60);
  }

  // ── discovery: canvas deliverables via run-complete edges ───────────────────
  const sessionStatus = new Map();          // id -> last seen status
  let seeded = false;                       // first /sessions poll seeds without firing

  async function pollSessions() {
    const d = await apiGet('/sessions');
    const sessions = (d && Array.isArray(d.sessions)) ? d.sessions : [];
    const edges = [];
    sessions.forEach((s) => {
      if (!s || s.id == null) return;
      const prev = sessionStatus.get(s.id);
      const now = s.status;
      // Skip attached/child duplicates where we can: only gate top-level runs.
      const topLevel = s.parent_id == null;
      if (seeded && prev === 'running' && now !== 'running' && topLevel) {
        edges.push(s.id);
      }
      sessionStatus.set(s.id, now);
    });
    seeded = true;
    if (edges.length) {
      // A turn finished — collect its deliverables and rescan the workspace.
      for (const id of edges) await harvestSession(id);
      await scanWorkspace();
    }
  }

  async function harvestSession(sessionId) {
    const d = await apiGet('/sessions/' + sessionId);
    if (!d) return;
    const ops = Array.isArray(d.canvas_ops) ? d.canvas_ops : [];
    ops.forEach((op) => {
      if (!op) return;
      if (op.kind === 'note') {
        enqueue({
          key: 'op:' + sessionId + ':' + op.seq,
          kind: 'note',
          sessionId,
          title: op.title || 'Note from agent',
          preview: clamp(op.content || '', PREVIEW_CHARS),
          previewLoaded: true,
        });
      } else if (op.kind === 'document') {
        enqueue({
          key: 'op:' + sessionId + ':' + op.seq,
          kind: 'document',
          sessionId,
          title: op.title || 'Document from agent',
          html: op.content || '',
          preview: clamp(htmlToText(op.content || ''), PREVIEW_CHARS),
          previewLoaded: true,
        });
      }
    });
  }

  // ── discovery: workspace files an agent wrote ───────────────────────────────
  const knownFiles = new Map();             // path -> mtime; seeded so pre-existing files aren't held
  let workspaceSeeded = false;

  async function scanWorkspace() {
    const d = await apiGet(WORKSPACE_LIST);
    const files = (d && Array.isArray(d.files)) ? d.files : null;
    if (!files) return;                     // endpoint absent or errored — degrade quietly
    const first = !workspaceSeeded;
    files.forEach((f) => {
      if (!f || !f.path) return;
      const mtime = Number(f.mtime) || 0;
      const prior = knownFiles.get(f.path);
      const isNew = prior === undefined;
      const changed = prior !== undefined && mtime > prior;
      knownFiles.set(f.path, mtime);
      if (first) return;                    // baseline pass: learn existing files, hold none
      if (isNew || changed) {
        enqueue({
          key: 'file:' + f.path + ':' + mtime,
          kind: 'file',
          path: f.path,
          title: baseName(f.path),
          preview: '',
          previewLoaded: false,
        });
      }
    });
    workspaceSeeded = true;
  }

  async function loadFilePreview(item) {
    if (item.previewLoaded) return;
    item.previewLoaded = true;
    const d = await apiGet(WORKSPACE_FILE + '?path=' + encodeURIComponent(item.path));
    item.preview = d && typeof d.text === 'string'
      ? clamp(d.text, PREVIEW_CHARS)
      : '(Preview unavailable — the file is on disk in your workspace.)';
    // Only repaint if the lane is open and this item is still pending.
    if (isOpen) render();
  }

  // ── injected CSS ────────────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-approvals-styles')) return;
    const css = `
      /* topbar affordance */
      .atl-appr-pill { display: inline-flex; align-items: center; gap: 7px;
        border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 999px; padding: 5px 11px 5px 10px; font: inherit; font-size: 12.5px;
        font-weight: 600; cursor: pointer; margin-right: 10px; }
      .atl-appr-pill:hover { color: var(--ink); border-color: var(--accent); }
      .atl-appr-pill .ic { font-size: 13px; line-height: 1; }
      .atl-appr-pill .n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center; font-size: 11px;
        font-weight: 700; background: var(--active); color: var(--ink); }
      .atl-appr-pill.has .n { background: var(--accent); color: #fff; }

      /* drawer + backdrop */
      .atl-appr-backdrop { position: fixed; inset: 0; z-index: 9400;
        background: rgba(40, 30, 18, 0.28); animation: atl-appr-fade .16s ease; }
      @keyframes atl-appr-fade { from { opacity: 0; } to { opacity: 1; } }
      .atl-appr-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 9401;
        width: 420px; max-width: 92vw; display: flex; flex-direction: column;
        background: var(--canvas); border-left: 1px solid var(--border);
        box-shadow: -18px 0 40px rgba(70, 52, 30, 0.16); animation: atl-appr-slide .2s ease; }
      @keyframes atl-appr-slide { from { transform: translateX(24px); opacity: .4; }
        to { transform: translateX(0); opacity: 1; } }

      .atl-appr-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
        padding: 15px 18px; border-bottom: 1px solid var(--border-soft); }
      .atl-appr-head .t { font-size: 15px; font-weight: 800; color: var(--ink); }
      .atl-appr-head .s { font-size: 12px; color: var(--ink-dim); }
      .atl-appr-head-sp { flex: 1; }
      .atl-appr-x { border: 1px solid var(--border); background: var(--panel); color: var(--ink-mid);
        border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font: inherit; font-size: 16px; }
      .atl-appr-x:hover { background: var(--active); color: var(--ink); }

      .atl-appr-scroll { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex;
        flex-direction: column; gap: 12px; }

      .atl-appr-empty { margin: auto; text-align: center; color: var(--ink-dim);
        display: flex; flex-direction: column; gap: 8px; padding: 40px 20px; }
      .atl-appr-empty .mk { font-size: 26px; }
      .atl-appr-empty .h { font-size: 14px; font-weight: 700; color: var(--ink-mid); }
      .atl-appr-empty .p { font-size: 12.5px; line-height: 1.5; max-width: 260px; }

      .atl-appr-item { background: var(--panel); border: 1px solid var(--border);
        border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
      .atl-appr-item-h { display: flex; align-items: center; gap: 9px; padding: 12px 14px 8px; }
      .atl-appr-kind { flex: 0 0 auto; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .05em; color: var(--ink-dim); border: 1px solid var(--border);
        border-radius: 6px; padding: 2px 6px; }
      .atl-appr-title { font-size: 13.5px; font-weight: 700; color: var(--ink); min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-appr-path { padding: 0 14px; font-size: 11.5px; color: var(--ink-dim);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-appr-prev { margin: 8px 14px 0; padding: 10px 12px; background: #faf7f1;
        border: 1px solid var(--border-soft); border-radius: 9px; font-size: 12px;
        color: var(--ink-mid); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
        max-height: 140px; overflow: auto; }
      .atl-appr-prev.muted { color: var(--ink-dim); font-style: italic; }
      .atl-appr-actions { display: flex; gap: 8px; padding: 12px 14px 14px; }
      .atl-appr-btn { border: none; border-radius: 9px; padding: 8px 14px; font: inherit;
        font-size: 12.5px; font-weight: 700; cursor: pointer; }
      .atl-appr-btn.ok { background: var(--accent); color: #fff; }
      .atl-appr-btn.ok:hover { background: var(--accent-2); }
      .atl-appr-btn.ghost { background: transparent; color: var(--ink-mid); border: 1px solid var(--border); }
      .atl-appr-btn.ghost:hover { border-color: var(--accent); color: var(--ink); }
      .atl-appr-btn:focus-visible, .atl-appr-x:focus-visible, .atl-appr-pill:focus-visible {
        outline: 2px solid var(--accent); outline-offset: 2px; }

      /* undo toast (its own, so the Undo action is a real focusable button) */
      .atl-appr-undo { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        z-index: 9500; display: flex; align-items: center; gap: 12px; max-width: 460px;
        background: var(--ink); color: #fff; border-radius: 999px; padding: 9px 12px 9px 16px;
        box-shadow: var(--shadow); animation: atl-appr-rise .18s ease; }
      @keyframes atl-appr-rise { from { opacity: 0; transform: translate(-50%, 10px); }
        to { opacity: 1; transform: translate(-50%, 0); } }
      .atl-appr-undo .txt { font-size: 12.5px; font-weight: 600; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .atl-appr-undo .act { border: none; background: transparent; color: #f0c9b6;
        font: inherit; font-size: 12.5px; font-weight: 800; cursor: pointer; padding: 2px 4px; }
      .atl-appr-undo .act:hover { color: #fff; }

      .atl-appr-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

      @media (prefers-reduced-motion: reduce) {
        .atl-appr-backdrop, .atl-appr-drawer, .atl-appr-undo { animation: none; }
      }
    `;
    const style = el('style');
    style.id = 'atl-approvals-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── screen-reader live region ───────────────────────────────────────────────
  let liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = el('div', 'atl-appr-sr');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    // reassert so repeated identical messages are still announced
    setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 30);
  }

  // ── the drawer ──────────────────────────────────────────────────────────────
  let backdropEl = null;
  let drawerEl = null;
  let scrollEl = null;
  let isOpen = false;
  let lastFocus = null;

  function buildDrawer() {
    if (drawerEl) return;
    backdropEl = el('div', 'atl-appr-backdrop');
    backdropEl.addEventListener('click', close);

    drawerEl = el('div', 'atl-appr-drawer');
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.setAttribute('aria-label', 'Approvals — items awaiting review');

    const head = el('div', 'atl-appr-head');
    const ht = el('div');
    ht.appendChild(el('div', 't', 'Hold for approval'));
    ht.appendChild(el('div', 's', 'Nothing is done until you approve it.'));
    const sp = el('div', 'atl-appr-head-sp');
    const x = el('button', 'atl-appr-x', '×');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close approvals');
    x.addEventListener('click', close);
    head.append(ht, sp, x);

    scrollEl = el('div', 'atl-appr-scroll');

    drawerEl.append(head, scrollEl);

    // keep keyboard inside the drawer while it's modal
    drawerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = drawerEl.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function itemRow(item) {
    const row = el('div', 'atl-appr-item');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', item.kind + ': ' + shortTitle(item));

    const h = el('div', 'atl-appr-item-h');
    h.appendChild(el('span', 'atl-appr-kind', item.kind));
    h.appendChild(el('span', 'atl-appr-title', item.title || item.path || item.key));
    row.appendChild(h);

    if (item.path) row.appendChild(el('div', 'atl-appr-path', item.path));

    const prev = el('div', 'atl-appr-prev');
    if (item.preview) {
      prev.textContent = item.preview;
    } else if (item.kind === 'file' && !item.previewLoaded) {
      prev.classList.add('muted');
      prev.textContent = 'Loading preview…';
      loadFilePreview(item);
    } else {
      prev.classList.add('muted');
      prev.textContent = '(No preview available.)';
    }
    row.appendChild(prev);

    const actions = el('div', 'atl-appr-actions');
    const approve = el('button', 'atl-appr-btn ok', 'Approve');
    approve.type = 'button';
    approve.setAttribute('aria-label', 'Approve ' + shortTitle(item));
    approve.addEventListener('click', () => decide(item, 'approved'));
    const dismiss = el('button', 'atl-appr-btn ghost', 'Dismiss');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss ' + shortTitle(item));
    dismiss.addEventListener('click', () => decide(item, 'dismissed'));
    actions.append(approve, dismiss);
    row.appendChild(actions);

    return row;
  }

  function render() {
    if (!scrollEl) return;
    scrollEl.textContent = '';
    if (!items.length) {
      const em = el('div', 'atl-appr-empty');
      em.appendChild(el('div', 'mk', '✓'));
      em.appendChild(el('div', 'h', 'Nothing waiting'));
      em.appendChild(el('div', 'p', 'When an agent writes a file or drops a deliverable on the canvas, it shows up here for you to approve before it counts as done.'));
      scrollEl.appendChild(em);
      return;
    }
    // newest first
    items.slice().sort((a, b) => b.ts - a.ts).forEach((it) => scrollEl.appendChild(itemRow(it)));
  }

  function open() {
    if (isOpen) return;
    buildDrawer();
    lastFocus = document.activeElement;
    document.body.appendChild(backdropEl);
    document.body.appendChild(drawerEl);
    isOpen = true;
    render();
    // focus the first actionable control
    const focusable = drawerEl.querySelector('button');
    if (focusable) focusable.focus();
    updatePill();
  }

  function close() {
    if (!isOpen) return;
    if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
    if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
    isOpen = false;
    if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus(); } catch {} }
    updatePill();
  }

  function toggle() { if (isOpen) close(); else open(); }

  // ── undo toast ──────────────────────────────────────────────────────────────
  let undoEl = null;
  let undoTimer = null;
  function showUndoToast(item, status) {
    if (!undoEl) {
      undoEl = el('div', 'atl-appr-undo');
      undoEl.setAttribute('role', 'status');
      const txt = el('span', 'txt');
      const act = el('button', 'act', 'Undo');
      act.type = 'button';
      act.addEventListener('click', () => { hideUndoToast(); undoLast(); });
      undoEl.append(txt, act);
      document.body.appendChild(undoEl);
    }
    undoEl.querySelector('.txt').textContent =
      (status === 'approved' ? 'Approved ' : 'Dismissed ') + shortTitle(item);
    undoEl.style.display = '';
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndoToast, 6000);
  }
  function hideUndoToast() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    if (undoEl) undoEl.style.display = 'none';
  }

  // ── topbar pill (persistent affordance) ─────────────────────────────────────
  let pillEl = null;
  let pillNumEl = null;
  function buildPill() {
    const host = document.querySelector('.tb-right');
    if (!host || pillEl) return;
    pillEl = el('button', 'atl-appr-pill');
    pillEl.type = 'button';
    pillEl.title = 'Approvals';
    pillEl.appendChild(el('span', 'ic', '✓'));
    pillEl.appendChild(el('span', null, 'Approvals'));
    pillNumEl = el('span', 'n', '0');
    pillEl.appendChild(pillNumEl);
    pillEl.addEventListener('click', toggle);
    // sit to the left of the brand name/mark
    host.insertBefore(pillEl, host.firstChild);
    updatePill();
  }
  function updatePill() {
    if (!pillEl) return;
    const n = pendingCount();
    pillNumEl.textContent = String(n);
    pillEl.classList.toggle('has', n > 0);
    pillEl.setAttribute('aria-label',
      n === 0 ? 'Approvals — nothing waiting' :
      n + (n === 1 ? ' item awaiting approval' : ' items awaiting approval') + '. Open approvals lane.');
    pillEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function onQueueChanged() {
    updatePill();
    if (isOpen) render();
  }

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'approvals.open', label: 'Approvals', icon: '✓', section: 'Review',
      keywords: 'approve approval review gate hold pending deliverable workspace publish',
      run() { open(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand);

  // ── lifecycle wiring ────────────────────────────────────────────────────────
  A.bus.on('core:ready', () => buildPill());
  // Rebuild the pill if the topbar was re-rendered under us (defensive).
  A.bus.on('boards:switched', () => { if (!document.querySelector('.atl-appr-pill')) { pillEl = null; buildPill(); } });
  // Global Escape (in case focus is outside the drawer when it's open).
  A.bus.on('shortcut:escape', () => { if (isOpen) close(); });

  // core:ready may have already fired before this deferred script ran.
  buildPill();

  // ── polling loop (mirrors recipes.js self-poll; no core edits) ──────────────
  let pollTimer = null;
  async function tick() {
    try { await pollSessions(); } catch { /* keep the loop alive */ }
    pollTimer = setTimeout(tick, POLL_MS);
  }
  // Seed the workspace baseline once up front so files already on disk aren't
  // held as "new", then start the loop.
  scanWorkspace().finally(() => { tick(); });

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierApprovals = {
    open,
    close,
    toggle,
    isOpen: () => isOpen,
    pendingCount,
    // Programmatic hold: drop any produced thing into the lane. A future publish
    // step calls this so publishing routes through the same approval surface.
    enqueue,
    // Promise form for a gated step (e.g. publish): resolves true on approve,
    // false on dismiss. Give a { key, kind, title, preview } descriptor.
    gate(descriptor) {
      return new Promise((resolve) => {
        const added = enqueue(Object.assign({ kind: 'publish' }, descriptor, { resolve }));
        if (!added) resolve(decisionOf(descriptor && descriptor.key) === 'approved');
      });
    },
    items,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierApprovals && typeof window.AtelierApprovals.open === 'function');
    const pillOk = !!document.querySelector('.atl-appr-pill') || !document.querySelector('.tb-right');
    console.assert(registered, '[approvals] module did not register window.AtelierApprovals');
    if (registered) {
      console.log('[approvals] self-check passed — approval lane ready (pill ' +
        (pillOk ? 'mounted' : 'pending topbar') + ', ' + pendingCount() + ' pending).');
    }
  })();
})();
