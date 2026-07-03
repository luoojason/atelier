'use strict';

/* ===========================================================================
   Atelier feature module — premium gate / Workflow AI   (app/premium.js)

   A PAYWALL SCAFFOLD for the future "Workflow AI" — a paid assistant that will
   design multi-step agent workflows for you. The product itself is deliberately
   NOT built yet (Jason's call: "way in the future"); what ships here is the
   Atelier-native GATE so the paywall pattern has a real home and the premium
   surface exists, ready to wire to the real product + a real license/payment
   backend later.

   What it is today
   ----------------
   • A "Workflow AI" card (⌘K → Add app: Workflow AI, or /workflowai). LOCKED by
     default: a short pitch, a "Preview" badge, and a license-key field.
   • Entering a license key UNLOCKS a placeholder surface ("coming soon"). There
     is NO real license server or payment here — unlock just records the key in
     Atelier.store 'atelier.premium.license' (registered GLOBAL in boards.js so
     the unlock follows the user across boards). Real validation + checkout are a
     future integration; this module only owns the gate + the two visual states.
   • The card is honest about being a preview — it never claims a working
     product, invents pricing, or takes a payment.

   Persistence mirrors the other cards (board-scoped position via
   Atelier.store 'atelier.premium'); the license itself is a single global key.

   Contract: builds ONLY against window.Atelier. Injects its own CSS. XSS rule:
   every dynamic string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store) {
    console.warn('[premium] Atelier core not available — skipping.');
    return;
  }

  const STORE_KEY = 'atelier.premium';        // board-scoped card placements
  const LICENSE_KEY = 'atelier.premium.license'; // global unlock token
  const CARD_W = 320;
  const CARD_H = 380;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function isUnlocked() {
    return !!String(A.store.get(LICENSE_KEY, '') || '').trim();
  }

  (function injectStyles() {
    if (document.getElementById('atl-premium-styles')) return;
    const css = `
      .atl-prem-body { display: flex; flex-direction: column; height: 100%;
        padding: 16px; gap: 12px; overflow-y: auto; }
      .atl-prem-badge { align-self: flex-start; font-size: 10px; text-transform: uppercase;
        letter-spacing: .06em; font-weight: 700; color: #fff; background: var(--accent);
        border-radius: 6px; padding: 2px 8px; }
      .atl-prem-badge.unlocked { background: var(--ok, #3fa66a); }
      .atl-prem-h { font-size: 17px; font-weight: 700; color: var(--ink); display: flex;
        align-items: center; gap: 8px; }
      .atl-prem-lock { font-size: 16px; }
      .atl-prem-p { font-size: 13px; color: var(--ink-mid); line-height: 1.5; }
      .atl-prem-list { font-size: 12.5px; color: var(--ink-mid); line-height: 1.6; margin: 0;
        padding-left: 18px; }
      .atl-prem-gate { margin-top: auto; display: flex; flex-direction: column; gap: 8px;
        border-top: 1px solid var(--border-soft); padding-top: 12px; }
      .atl-prem-in { border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-prem-in:focus { border-color: var(--accent); }
      .atl-prem-btn { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-prem-btn:hover { background: var(--accent-2); }
      .atl-prem-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); }
      .atl-prem-btn.ghost:hover { border-color: var(--accent); background: transparent; }
      .atl-prem-note { font-size: 11px; color: var(--ink-dim); line-height: 1.4; }
      .atl-prem-note.err { color: var(--accent); }
      .atl-prem-row { display: flex; gap: 8px; }
      .atl-prem-composer { display: flex; gap: 8px; }
      .atl-prem-composer textarea { flex: 1; resize: none; min-height: 40px; max-height: 100px;
        border: 1px solid var(--border); border-radius: 10px; padding: 8px 11px; font: inherit;
        font-size: 13px; background: #faf7f1; color: var(--ink-dim); }
    `;
    const style = el('style');
    style.id = 'atl-premium-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  const instances = new Map();
  let restoring = false;
  let dragId = null;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const r = inst.handle.getRect();
      arr.push({ id: inst.id, x: r.x, y: r.y, w: r.w, h: r.h });
    });
    A.store.set(STORE_KEY, arr);
  }

  function renderLocked(inst) {
    const body = inst.bodyEl;
    body.textContent = '';
    body.appendChild(el('span', 'atl-prem-badge', 'Preview · Premium'));
    const h = el('div', 'atl-prem-h');
    h.append(el('span', 'atl-prem-lock', '🔒'), document.createTextNode('Workflow AI'));
    body.appendChild(h);
    body.appendChild(el('div', 'atl-prem-p',
      'A paid assistant that designs multi-step agent workflows for you — describe a goal and it drafts the orchestrator, the sub-agents, the tools, and the loop.'));
    const list = el('ul', 'atl-prem-list');
    ['Turns a plain-English goal into a runnable workflow',
      'Wires orchestrator, sub-agents, tools and schedule',
      'Editable on the canvas before you run it'].forEach((t) => {
      const li = document.createElement('li'); li.textContent = t; list.appendChild(li);
    });
    body.appendChild(list);

    const gate = el('div', 'atl-prem-gate');
    const note = el('div', 'atl-prem-note',
      'This is a preview of an upcoming paid feature. Pricing and checkout are coming later.');
    const row = el('div', 'atl-prem-row');
    const input = document.createElement('input');
    input.className = 'atl-prem-in'; input.type = 'text';
    input.placeholder = 'License key'; input.style.flex = '1'; input.maxLength = 200;
    const btn = el('button', 'atl-prem-btn', 'Unlock');
    btn.type = 'button';
    const err = el('div', 'atl-prem-note');
    btn.addEventListener('click', () => {
      const key = String(input.value || '').trim();
      if (!key) { err.textContent = 'Enter a license key to unlock.'; err.classList.add('err'); return; }
      // NOTE: no real license server yet — recording the key is the gate. Real
      // validation + checkout land when the product does.
      A.store.set(LICENSE_KEY, key);
      instances.forEach((i) => renderState(i));
    });
    row.append(input, btn);
    gate.append(note, row, err);
    body.appendChild(gate);
  }

  function renderUnlocked(inst) {
    const body = inst.bodyEl;
    body.textContent = '';
    body.appendChild(el('span', 'atl-prem-badge unlocked', 'Unlocked'));
    const h = el('div', 'atl-prem-h');
    h.append(el('span', 'atl-prem-lock', '✦'), document.createTextNode('Workflow AI'));
    body.appendChild(h);
    body.appendChild(el('div', 'atl-prem-p',
      'Premium unlocked. The Workflow AI builder is coming soon — describe the workflow you want and it will draft it on the canvas.'));
    const composer = el('div', 'atl-prem-composer');
    const ta = document.createElement('textarea');
    ta.placeholder = 'e.g. "Every morning, research my three watchlist tickers and post a digest note."';
    ta.disabled = true; // the real builder is not shipped yet — honest placeholder
    composer.appendChild(ta);
    body.appendChild(composer);
    body.appendChild(el('div', 'atl-prem-note', 'The builder itself is still in development.'));

    const gate = el('div', 'atl-prem-gate');
    const relock = el('button', 'atl-prem-btn ghost', 'Remove license');
    relock.type = 'button';
    relock.addEventListener('click', () => {
      A.store.set(LICENSE_KEY, '');
      instances.forEach((i) => renderState(i));
    });
    gate.appendChild(relock);
    body.appendChild(gate);
  }

  function renderState(inst) {
    if (isUnlocked()) renderUnlocked(inst); else renderLocked(inst);
  }

  function spawnCard(opts = {}) {
    const id = opts.id || ('prem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const card = el('section', 'card app-card atl-prem-card');
    card.dataset.premInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'), el('span', 'card-title', 'Workflow AI'), el('span', 'card-x', '×'));
    const body = el('div', 'app-body atl-prem-body');
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
    const inst = { id, handle, bodyEl: body };
    instances.set(id, inst);
    card.addEventListener('mousedown', () => { dragId = id; }, true);
    renderState(inst);
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
    const rid = node && node.dataset && node.dataset.premInstance;
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
        spawnCard({ id: String(rec.id), rect: { x: Number(rec.x) || 0, y: Number(rec.y) || 0,
          w: Number(rec.w) || CARD_W, h: Number(rec.h) || CARD_H } });
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

  A.registerApp('workflowai', {
    label: 'Workflow AI',
    icon: '✦',
    create(worldPos) {
      const inst = spawnCard(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  window.AtelierPremium = {
    spawn: spawnCard, instances, STORE_KEY,
    isUnlocked, setLicense(k) { A.store.set(LICENSE_KEY, k || ''); instances.forEach((i) => renderState(i)); },
  };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('workflowai');
    console.assert(registered, '[premium] workflowai app type not registered');
    if (registered) console.log('[premium] ready — Workflow AI (premium preview) registered.');
  })();
})();
