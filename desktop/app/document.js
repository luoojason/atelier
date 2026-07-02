'use strict';

/* ===========================================================================
   Atelier feature module — document card   (app/document.js)

   The OpenSwarm docs_agent capability, ported to Atelier's zero-key idiom: the
   agent authors a print-ready HTML document on demand; this card collects the
   request, POSTs it to the backend, previews the result in a fully-sandboxed
   iframe, and exports it to PDF (via Electron's bundled printToPDF — no
   weasyprint/Chromium to ship) or HTML. Registers the 'document' app type via
   Atelier.registerApp — no dock button; spawns from the ⌘K palette
   ("Add app: Document") or Atelier.spawnApp('document').

   Backend contract (lite_server.py, never 500):
     POST /document {"description": str, "title"?: str}   (X-Atelier-Token)
       -> {"html": "<!doctype html>…", "title": str} on success
       -> {"error": "<why>"} on any failure

   Card states: prompt (textarea + Write) → busy (spinner) → doc (a header with
   the title + Rewrite + export buttons, over the preview iframe).

   SECURITY INVARIANT — the preview iframe uses sandbox="" (EMPTY): the document
   is static (the generator is instructed to emit NO JavaScript), so scripts,
   forms, popups, and same-origin are ALL denied. This is strictly stronger
   than the mini-app card's allow-scripts: nothing inside can run code, reach
   localStorage, or walk to the preload bridge (window.atelier.token).

   PDF export renders the same self-contained HTML in an offscreen, node-less,
   script-disabled BrowserWindow in the main process (main.js atelier:save-pdf)
   and printToPDF's it to a user-chosen path — the document HTML never gains
   any capability it lacks in the preview.

   Persistence + board switch mirror app/miniapp.js exactly (board-scoped
   A.store key, html capped, idempotent restore, will-switch draft flush).

   Contract: builds ONLY against window.Atelier + fetch (+ the optional
   window.atelier bridge for export). Injects its own CSS.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store) {
    console.warn('[document] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.documents';
  const CARD_W = 480;
  const CARD_H = 560;
  const PERSIST_HTML_MAX = 300000; // larger docs render but persist prompt-only
  const DESC_MIN = 3;
  const DESC_MAX = 4000;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  (function injectStyles() {
    if (document.getElementById('atl-document-styles')) return;
    const css = `
      .atl-document-body { padding: 0; display: flex; flex-direction: column; }
      .atl-document-prompt { flex: 1; min-height: 0; display: flex;
        flex-direction: column; gap: 10px; padding: 12px; }
      .atl-document-prompt textarea { flex: 1; min-height: 0; resize: none;
        border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1;
        outline: none; }
      .atl-document-prompt textarea:focus { border-color: var(--accent); }
      .atl-document-title-in { border: 1px solid var(--border); border-radius: 8px;
        padding: 7px 11px; font: inherit; font-size: 12.5px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-document-title-in:focus { border-color: var(--accent); }
      .atl-document-note { font-size: 12px; color: var(--accent); }
      .atl-document-note:empty { display: none; }
      .atl-document-actions { display: flex; justify-content: flex-end; }
      .atl-document-write { border: none; border-radius: 9px;
        background: var(--accent); color: #fff; padding: 8px 16px;
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-document-write:hover { background: var(--accent-2); }
      .atl-document-write:disabled { opacity: 0.5; cursor: default; }
      .atl-document-busy { flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px;
        color: var(--ink-dim); font-size: 12.5px; padding: 12px;
        text-align: center; }
      .atl-document-spin { width: 22px; height: 22px; border-radius: 50%;
        border: 3px solid var(--border); border-top-color: var(--accent);
        animation: atl-document-spin 0.8s linear infinite; }
      @keyframes atl-document-spin { to { transform: rotate(360deg); } }
      .atl-document-head { display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-document-name { flex: 1; min-width: 0; font-size: 11.5px;
        color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .atl-document-btn { flex: 0 0 auto; border: 1px solid var(--border);
        border-radius: 7px; background: #faf7f1; color: var(--ink-mid);
        font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-document-btn:hover { border-color: var(--accent); }
      .atl-document-btn:disabled { opacity: 0.5; cursor: default; }
      .atl-document-view { flex: 1; min-height: 0; display: flex; }
      .atl-document-view iframe { flex: 1; min-height: 0; width: 100%;
        border: none; display: block; background: #fff; }
    `;
    const style = el('style');
    style.id = 'atl-document-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  async function apiPost(path, bodyObj) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + path, {
      method: 'POST', headers, body: JSON.stringify(bodyObj),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // id -> { id, handle, bodyEl, description, title, html, promptTa }
  const instances = new Map();
  let restoring = false;
  let dragId = null;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const rect = inst.handle.getRect();
      const fits = typeof inst.html === 'string' && inst.html.length <= PERSIST_HTML_MAX;
      arr.push({
        id: inst.id,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        description: inst.description || '',
        title: inst.title || '',
        html: fits ? inst.html : null,
        oversize: inst.html ? !fits : !!inst.oversize,
      });
    });
    A.store.set(STORE_KEY, arr);
  }

  function showPrompt(inst, prefill, noteText) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';
    const wrap = el('div', 'atl-document-prompt');
    const titleIn = document.createElement('input');
    titleIn.className = 'atl-document-title-in';
    titleIn.type = 'text';
    titleIn.placeholder = 'Title (optional)';
    titleIn.maxLength = 200;
    titleIn.value = inst.title || '';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Describe the document — e.g. a one-page competitive brief on X, '
      + 'a project status report, a formal letter…';
    ta.maxLength = DESC_MAX;
    ta.value = prefill || '';
    const note = el('div', 'atl-document-note', noteText || '');
    const actions = el('div', 'atl-document-actions');
    const writeBtn = el('button', 'atl-document-write', 'Write');
    writeBtn.type = 'button';
    actions.appendChild(writeBtn);
    wrap.append(titleIn, ta, note, actions);
    body.appendChild(wrap);
    inst.promptTa = ta;
    inst.titleIn = titleIn;

    writeBtn.addEventListener('click', () => {
      const desc = ta.value.trim();
      if (desc.length < DESC_MIN) {
        note.textContent = 'Describe the document in a few more words.';
        return;
      }
      inst.title = titleIn.value.trim();
      build(inst, desc);
    });
  }

  function showBusy(inst) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';
    const wrap = el('div', 'atl-document-busy');
    wrap.append(
      el('div', 'atl-document-spin'),
      el('div', null, 'Writing your document — this can take a minute…')
    );
    body.appendChild(wrap);
  }

  function showDoc(inst) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';

    const head = el('div', 'atl-document-head');
    const name = el('span', 'atl-document-name', inst.title || inst.description || 'Document');
    name.title = inst.title || inst.description || '';
    const rewriteBtn = el('button', 'atl-document-btn', 'Rewrite');
    rewriteBtn.type = 'button';
    rewriteBtn.title = 'Describe and write again';
    head.append(name, rewriteBtn);

    // export buttons only when the desktop bridge is present
    const bridge = window.atelier;
    if (bridge && typeof bridge.savePDF === 'function') {
      const pdfBtn = el('button', 'atl-document-btn', 'PDF');
      pdfBtn.type = 'button';
      pdfBtn.title = 'Export as PDF';
      pdfBtn.addEventListener('click', () => {
        pdfBtn.disabled = true;
        Promise.resolve(bridge.savePDF(inst.html, inst.title || inst.description || 'document'))
          .then((r) => { if (r && r.error) name.textContent = 'Export failed: ' + r.error; })
          .finally(() => { pdfBtn.disabled = false; });
      });
      head.append(pdfBtn);
    }
    if (bridge && typeof bridge.saveText === 'function') {
      const htmlBtn = el('button', 'atl-document-btn', 'HTML');
      htmlBtn.type = 'button';
      htmlBtn.title = 'Save the HTML source';
      htmlBtn.addEventListener('click', () => {
        htmlBtn.disabled = true;
        Promise.resolve(bridge.saveText(inst.html, inst.title || inst.description || 'document', 'html'))
          .then((r) => { if (r && r.error) name.textContent = 'Save failed: ' + r.error; })
          .finally(() => { htmlBtn.disabled = false; });
      });
      head.append(htmlBtn);
    }

    const view = el('div', 'atl-document-view');
    const frame = document.createElement('iframe');
    // SECURITY INVARIANT: sandbox="" (EMPTY) — the document is static, so
    // scripts/forms/popups/same-origin are all denied. Stronger than the
    // mini-app card's allow-scripts; nothing inside can run code or reach the
    // preload bridge.
    frame.setAttribute('sandbox', '');
    frame.srcdoc = inst.html;
    view.append(frame);
    body.append(head, view);

    rewriteBtn.addEventListener('click', () => {
      showPrompt(inst, inst.description || '', '');
    });
  }

  function build(inst, desc) {
    inst.description = desc;
    showBusy(inst);
    const bodyObj = inst.title ? { description: desc, title: inst.title } : { description: desc };
    apiPost('/document', bodyObj)
      .then((r) => {
        if (instances.get(inst.id) !== inst) return; // closed/replaced mid-build
        if (r.ok && r.data && typeof r.data.html === 'string' && r.data.html) {
          inst.html = r.data.html;
          if (r.data.title) inst.title = String(r.data.title);
          showDoc(inst);
          persist();
          return;
        }
        const msg = (r.data && r.data.error)
          ? String(r.data.error)
          : 'Writing failed (HTTP ' + r.status + ').';
        showPrompt(inst, desc, msg);
      })
      .catch(() => {
        if (instances.get(inst.id) !== inst) return;
        showPrompt(inst, desc, 'Backend unreachable — is the Atelier server running?');
      });
  }

  function spawnDocument(opts = {}) {
    const id = opts.id
      || ('d-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const card = el('section', 'card app-card atl-document-card');
    card.dataset.documentInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(
      el('span', 'card-dot'),
      el('span', 'card-title', 'Document'),
      el('span', 'card-x', '×')
    );
    const body = el('div', 'app-body atl-document-body');
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

    const inst = {
      id,
      handle,
      bodyEl: body,
      description: typeof opts.description === 'string' ? opts.description : '',
      title: typeof opts.title === 'string' ? opts.title : '',
      html: typeof opts.html === 'string' && opts.html ? opts.html : null,
      oversize: !!opts.oversize,
      promptTa: null,
    };
    instances.set(id, inst);

    card.addEventListener('mousedown', () => { dragId = id; }, true);

    if (inst.html) {
      showDoc(inst);
    } else {
      showPrompt(inst, inst.description, opts.oversize
        ? 'This document was too large to save — press Write to regenerate it.'
        : '');
    }

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
    const rid = node && node.dataset && node.dataset.documentInstance;
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
        if (!rec || !rec.id) return;
        if (instances.has(rec.id)) return;
        spawnDocument({
          id: String(rec.id),
          rect: {
            x: Number(rec.x) || 0,
            y: Number(rec.y) || 0,
            w: Number(rec.w) || CARD_W,
            h: Number(rec.h) || CARD_H,
          },
          description: typeof rec.description === 'string' ? rec.description : '',
          title: typeof rec.title === 'string' ? rec.title : '',
          html: typeof rec.html === 'string' && rec.html ? rec.html : null,
          oversize: !!rec.oversize,
        });
      });
    } finally {
      restoring = false;
    }
  }
  restoreFromStore();

  A.bus.on('boards:will-switch', () => {
    let dirty = false;
    instances.forEach((inst) => {
      if (!inst.promptTa || !inst.promptTa.isConnected) return;
      const draft = inst.promptTa.value.trim();
      if (draft && draft !== inst.description) {
        inst.description = draft;
        dirty = true;
      }
    });
    if (dirty) persist();
  });

  A.bus.on('boards:switched', () => {
    instances.forEach((inst, id) => {
      if (inst.handle && inst.handle.el && inst.handle.el.isConnected) return;
      instances.delete(id);
    });
    restoreFromStore();
  });

  A.registerApp('document', {
    label: 'Document',
    icon: '▤',
    create(worldPos) {
      const inst = spawnDocument(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  window.AtelierDocuments = {
    spawn: spawnDocument,
    restoreFromStore,
    instances,
    STORE_KEY,
  };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('document');
    console.assert(registered, '[document] document app type not registered');
    const styles = !!document.getElementById('atl-document-styles');
    console.assert(styles, '[document] styles not injected');
    if (registered && styles) {
      console.log('[document] self-check passed — document app registered '
        + '(palette + spawnApp reachable), styles injected.');
    }
  })();
})();
