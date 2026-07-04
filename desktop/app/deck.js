'use strict';

/* ===========================================================================
   Atelier feature module — slide deck card   (app/deck.js)

   The OpenSwarm slides_agent capability in Atelier's zero-key idiom, WITHOUT
   its heavy toolchain (LibreOffice + Node html2pptx + Poppler + playwright).
   The agent authors a STRUCTURED deck; the backend renders an HTML preview and
   builds a real, editable .pptx with python-pptx. This card collects the
   request, previews the deck (sandboxed iframe), and exports the .pptx (and
   the HTML preview). Registers the 'deck' app type; spawns from the ⌘K palette
   ("Add app: Slides") or Atelier.spawnApp('deck').

   Backend contract (lite_server.py, never 500):
     POST /deck {"description","title"?} -> {"deck","html","title"} | {"error"}
     POST /deck/pptx {"title","subtitle","slides"} -> {"pptx_b64","title"} | {"error"}

   Reuses app/document.js's shared card CSS (style id 'atl-document-styles').
   Persistence + board switch mirror document.js / research.js exactly (it also
   persists the structured `deck` so a reloaded card can still export the .pptx).
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store) {
    console.warn('[deck] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.decks';
  const CARD_W = 500;
  const CARD_H = 560;
  const PERSIST_HTML_MAX = 300000;
  const DESC_MIN = 3;
  const DESC_MAX = 4000;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // Shared card CSS lives under document.js's style id; inject (guarded) so
  // this module also works if document.js is absent.
  (function injectStyles() {
    if (document.getElementById('atl-document-styles')) return;
    const css = `
      .atl-document-body { padding: 0; display: flex; flex-direction: column; }
      .atl-document-prompt { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; }
      .atl-document-prompt textarea { flex: 1; min-height: 0; resize: none; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-document-prompt textarea:focus { border-color: var(--accent); }
      .atl-document-title-in { border: 1px solid var(--border); border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 12.5px; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-document-title-in:focus { border-color: var(--accent); }
      .atl-document-note { font-size: 12px; color: var(--accent); } .atl-document-note:empty { display: none; }
      .atl-document-actions { display: flex; justify-content: flex-end; }
      .atl-document-write { border: none; border-radius: 9px; background: var(--accent); color: #fff; padding: 8px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-document-write:hover { background: var(--accent-2); } .atl-document-write:disabled { opacity: 0.5; cursor: default; }
      .atl-document-busy { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--ink-dim); font-size: 12.5px; padding: 12px; text-align: center; }
      .atl-document-spin { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--accent); animation: atl-document-spin 0.8s linear infinite; }
      @keyframes atl-document-spin { to { transform: rotate(360deg); } }
      .atl-document-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); }
      .atl-document-name { flex: 1; min-width: 0; font-size: 11.5px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-document-btn { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 7px; background: #faf7f1; color: var(--ink-mid); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; }
      .atl-document-btn:hover { border-color: var(--accent); } .atl-document-btn:disabled { opacity: 0.5; cursor: default; }
      .atl-document-view { flex: 1; min-height: 0; display: flex; }
      .atl-document-view iframe { flex: 1; min-height: 0; width: 100%; border: none; display: block; background: #ece7dd; }
    `;
    const style = el('style');
    style.id = 'atl-document-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  async function apiPost(path, bodyObj) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

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
        id: inst.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        description: inst.description || '', title: inst.title || '',
        html: fits ? inst.html : null,
        deck: fits ? (inst.deck || null) : null,
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
    titleIn.placeholder = 'Deck title (optional)';
    titleIn.maxLength = 200;
    titleIn.value = inst.title || '';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Describe the deck — e.g. an investor pitch for X, a Q3 review, '
      + 'an onboarding deck for Y…';
    ta.maxLength = DESC_MAX;
    ta.value = prefill || '';
    const note = el('div', 'atl-document-note', noteText || '');
    const actions = el('div', 'atl-document-actions');
    const writeBtn = el('button', 'atl-document-write', 'Create deck');
    writeBtn.type = 'button';
    actions.appendChild(writeBtn);
    wrap.append(titleIn, ta, note, actions);
    body.appendChild(wrap);
    inst.promptTa = ta;

    writeBtn.addEventListener('click', () => {
      const desc = ta.value.trim();
      if (desc.length < DESC_MIN) {
        note.textContent = 'Describe the deck in a few more words.';
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
    wrap.append(el('div', 'atl-document-spin'), el('div', null, 'Designing your deck — this can take a minute…'));
    body.appendChild(wrap);
  }

  function showDeck(inst) {
    inst.promptTa = null;
    const body = inst.bodyEl;
    body.textContent = '';
    const head = el('div', 'atl-document-head');
    const slideCount = (inst.deck && inst.deck.slides) ? inst.deck.slides.length : 0;
    const name = el('span', 'atl-document-name',
      (inst.title || inst.description || 'Deck') + (slideCount ? '  ·  ' + slideCount + ' slides' : ''));
    name.title = inst.title || inst.description || '';
    const newBtn = el('button', 'atl-document-btn', 'New');
    newBtn.type = 'button';
    newBtn.title = 'Create a new deck';
    head.append(name, newBtn);

    const bridge = window.atelier;
    if (bridge && typeof bridge.saveBinary === 'function' && inst.deck) {
      const pptxBtn = el('button', 'atl-document-btn', 'PPTX');
      pptxBtn.type = 'button';
      pptxBtn.title = 'Export as PowerPoint (.pptx)';
      pptxBtn.addEventListener('click', () => {
        pptxBtn.disabled = true;
        const nm = name.textContent;
        name.textContent = 'Building .pptx…';
        apiPost('/deck/pptx', {
          title: inst.deck.title || inst.title || 'Presentation',
          subtitle: inst.deck.subtitle || '',
          slides: inst.deck.slides || [],
        })
          .then((r) => {
            if (r.ok && r.data && r.data.pptx_b64) {
              return bridge.saveBinary(r.data.pptx_b64, inst.title || inst.deck.title || 'deck', 'pptx', 'PowerPoint');
            }
            throw new Error((r.data && r.data.error) || ('HTTP ' + r.status));
          })
          .then((res) => { name.textContent = (res && res.error) ? 'Export failed: ' + res.error : nm; })
          .catch((e) => { name.textContent = 'Export failed: ' + ((e && e.message) || e); })
          .finally(() => { pptxBtn.disabled = false; });
      });
      head.append(pptxBtn);
    }
    if (bridge && typeof bridge.saveText === 'function') {
      const htmlBtn = el('button', 'atl-document-btn', 'HTML');
      htmlBtn.type = 'button';
      htmlBtn.title = 'Save the HTML preview';
      htmlBtn.addEventListener('click', () => {
        htmlBtn.disabled = true;
        Promise.resolve(bridge.saveText(inst.html, inst.title || 'deck', 'html'))
          .then((r) => { if (r && r.error) name.textContent = 'Save failed: ' + r.error; })
          .finally(() => { htmlBtn.disabled = false; });
      });
      head.append(htmlBtn);
    }

    const view = el('div', 'atl-document-view');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', ''); // static preview — no scripts
    frame.srcdoc = inst.html;
    view.append(frame);
    body.append(head, view);
    newBtn.addEventListener('click', () => { showPrompt(inst, inst.description || '', ''); });
  }

  function build(inst, desc) {
    inst.description = desc;
    showBusy(inst);
    const bodyObj = inst.title ? { description: desc, title: inst.title } : { description: desc };
    apiPost('/deck', bodyObj)
      .then((r) => {
        if (instances.get(inst.id) !== inst) return;
        if (r.ok && r.data && typeof r.data.html === 'string' && r.data.html && r.data.deck) {
          inst.html = r.data.html;
          inst.deck = r.data.deck;
          if (r.data.title) inst.title = String(r.data.title);
          showDeck(inst);
          persist();
          return;
        }
        const msg = (r.data && r.data.error) ? String(r.data.error) : 'Deck creation failed (HTTP ' + r.status + ').';
        showPrompt(inst, desc, msg);
      })
      .catch(() => {
        if (instances.get(inst.id) !== inst) return;
        showPrompt(inst, desc, 'Backend unreachable — is the Atelier server running?');
      });
  }

  function spawnDeck(opts = {}) {
    const id = opts.id
      || ('k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const card = el('section', 'card app-card atl-deck-card');
    card.dataset.deckInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'), el('span', 'card-title', 'Slides'), el('span', 'card-x', '×'));
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
      id, handle, bodyEl: body,
      description: typeof opts.description === 'string' ? opts.description : '',
      title: typeof opts.title === 'string' ? opts.title : '',
      html: typeof opts.html === 'string' && opts.html ? opts.html : null,
      deck: (opts.deck && typeof opts.deck === 'object') ? opts.deck : null,
      oversize: !!opts.oversize, promptTa: null,
    };
    instances.set(id, inst);
    card.addEventListener('mousedown', () => { dragId = id; }, true);

    if (inst.html && inst.deck) {
      showDeck(inst);
    } else {
      showPrompt(inst, inst.description, opts.oversize
        ? 'This deck was too large to save — press Create to regenerate it.' : '');
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
    const rid = d && d.el && d.el.dataset && d.el.dataset.deckInstance;
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
        spawnDeck({
          id: String(rec.id),
          rect: { x: Number(rec.x) || 0, y: Number(rec.y) || 0, w: Number(rec.w) || CARD_W, h: Number(rec.h) || CARD_H },
          description: typeof rec.description === 'string' ? rec.description : '',
          title: typeof rec.title === 'string' ? rec.title : '',
          html: typeof rec.html === 'string' && rec.html ? rec.html : null,
          deck: (rec.deck && typeof rec.deck === 'object') ? rec.deck : null,
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
      if (draft && draft !== inst.description) { inst.description = draft; dirty = true; }
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

  A.registerApp('deck', {
    label: 'Slides',
    icon: '▦',
    create(worldPos) {
      const inst = spawnDeck(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  window.AtelierDecks = { spawn: spawnDeck, restoreFromStore, instances, STORE_KEY };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('deck');
    console.assert(registered, '[deck] deck app type not registered');
    if (registered) console.log('[deck] self-check passed — deck app registered.');
  })();
})();
