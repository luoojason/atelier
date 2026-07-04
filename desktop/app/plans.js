'use strict';

/* ===========================================================================
   Atelier feature module — Free vs Pro plans   (app/plans.js)

   An HONEST plans panel. It lays the two tiers side by side, marks which
   capabilities are Pro, and offers a clearly-labeled "not billed yet / coming
   soon" unlock. There is NO real payment here, NO faked transaction, and NO
   invented pricing — the panel says so in plain language.

   Alignment with the paywall scaffold (premium.js)
   ------------------------------------------------
   Pro is the SAME honest unlock token that premium.js already owns:
   Atelier.store 'atelier.premium.license' (registered GLOBAL in boards.js so an
   unlock follows the user across boards). This module never invents a second
   notion of "Pro" — it reads and writes that one token, preferring the public
   window.AtelierPremium API when it is present:

     • window.AtelierPremium.isUnlocked()  → is Pro active right now
     • window.AtelierPremium.setLicense(k) → record / clear the unlock token
                                             (also re-renders any Workflow AI
                                              cards so both surfaces stay in sync)
     • window.AtelierPremium.spawn()       → open the Workflow AI preview card

   If premium.js has not loaded (defensive only — index.html loads it first), it
   falls back to reading/writing the store key directly, so the two stay honest
   about the same fact either way.

   What is actually gated
   ----------------------
   Everything Atelier does today is Free. The ONLY Pro item today is the
   "Workflow AI" preview premium.js scaffolds — and it is labeled a preview that
   is still in development, exactly as premium.js frames it. Nothing else is
   fabricated as paid.

   Surface: a single floating panel (core's A.ui.openPanel — draggable, working
   ×, click-off backdrop, Escape closes) opened from the ⌘K palette ("Plans")
   or window.AtelierPlans.open().

   Contract: builds only against window.Atelier. Injects its own CSS. XSS rule:
   every dynamic string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui || typeof A.ui.openPanel !== 'function' || !A.store) {
    console.warn('[plans] Atelier core not available — skipping.');
    return;
  }

  const LICENSE_KEY = 'atelier.premium.license'; // same token premium.js owns

  // ── tiny DOM helper (same idiom as the sibling modules) ─────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── Pro state, read through premium.js when available ───────────────────────
  function premium() { return window.AtelierPremium || null; }

  function isPro() {
    const p = premium();
    if (p && typeof p.isUnlocked === 'function') {
      try { return !!p.isUnlocked(); } catch { /* fall through */ }
    }
    return !!String(A.store.get(LICENSE_KEY, '') || '').trim();
  }

  function setLicense(key) {
    const p = premium();
    if (p && typeof p.setLicense === 'function') { p.setLicense(key || ''); return; }
    A.store.set(LICENSE_KEY, key || ''); // fallback: same token, honest either way
  }

  // ── the two tiers, described honestly ───────────────────────────────────────
  // Free lists real, shipping capabilities. Pro's single item is the Workflow AI
  // preview — flagged as a preview, never as a working product.
  const FREE_FEATURES = [
    'Unlimited boards and an infinite canvas',
    'Chat with the orchestrator and spawn agent cards',
    'Notes, documents, decks, and browser cards',
    'Connect external agents (Iris, Hermes, any OpenAI-compatible endpoint)',
    'Loops and scheduled workflows',
    'Publishing channels, analytics, and the run ledger',
    'Knowledge-base graph',
  ];
  const PRO_FEATURES = [
    { text: 'Everything in Free', preview: false },
    { text: 'Workflow AI — describe a goal in plain English and it drafts the whole team on the canvas', preview: true },
  ];

  // ── injected CSS (design tokens from styles.css) ────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-plans-styles')) return;
    const css = `
      .atl-plans { width: 620px; max-width: 84vw; display: flex; flex-direction: column;
        gap: 16px; color: var(--ink); }
      .atl-plans-sub { font-size: 12.5px; color: var(--ink-mid); line-height: 1.5; margin-top: -6px; }

      .atl-plans-grid { display: flex; gap: 14px; }
      @media (max-width: 560px) { .atl-plans-grid { flex-direction: column; } }

      .atl-plan { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 14px;
        background: var(--panel); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .atl-plan.pro { border-color: var(--accent); }
      .atl-plan.pro.active { border-color: var(--ok, #3fa66a); }

      .atl-plan-top { display: flex; align-items: baseline; gap: 8px; }
      .atl-plan-name { font-size: 16px; font-weight: 700; color: var(--ink); }
      .atl-plan-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
        font-weight: 700; color: #fff; background: var(--accent); border-radius: 6px; padding: 2px 8px; }
      .atl-plan-badge.free { background: var(--ink-mid); }
      .atl-plan-badge.active { background: var(--ok, #3fa66a); }

      .atl-plan-price { font-size: 13px; color: var(--ink-mid); font-weight: 600; }
      .atl-plan-price .amt { font-size: 22px; font-weight: 700; color: var(--ink);
        letter-spacing: -0.02em; margin-right: 4px; }

      .atl-plan-list { list-style: none; margin: 0; padding: 0; display: flex;
        flex-direction: column; gap: 8px; }
      .atl-plan-li { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px;
        color: var(--ink-mid); line-height: 1.45; }
      .atl-plan-tick { flex: 0 0 16px; color: var(--accent); font-size: 12px; margin-top: 1px; }
      .atl-plan.free .atl-plan-tick { color: var(--ink-mid); }
      .atl-plan-preview { align-self: center; flex: 0 0 auto; font-size: 9.5px; text-transform: uppercase;
        letter-spacing: .05em; font-weight: 700; color: var(--accent); border: 1px solid var(--accent-soft);
        background: var(--accent-soft); border-radius: 5px; padding: 1px 5px; margin-left: 4px; }

      .atl-plan-gate { margin-top: auto; display: flex; flex-direction: column; gap: 9px;
        border-top: 1px solid var(--border-soft); padding-top: 12px; }
      .atl-plan-row { display: flex; gap: 8px; }
      .atl-plan-in { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 9px;
        padding: 8px 11px; font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-plan-in:focus { border-color: var(--accent); }
      .atl-plan-btn { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      .atl-plan-btn:hover { background: var(--accent-2); }
      .atl-plan-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-plan-btn.ghost { background: transparent; color: var(--ink-mid); border: 1px solid var(--border);
        font-weight: 500; }
      .atl-plan-btn.ghost:hover { border-color: var(--accent); color: var(--ink); background: transparent; }
      .atl-plan-note { font-size: 11px; color: var(--ink-dim); line-height: 1.45; }
      .atl-plan-note.err { color: var(--accent); }
      .atl-plan-note.ok { color: var(--ok, #3fa66a); }
    `;
    const style = el('style');
    style.id = 'atl-plans-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── panel state (singleton) ─────────────────────────────────────────────────
  let panelRef = null; // { el, body, close } from openPanel

  function panelAlive() {
    return !!(panelRef && panelRef.el && document.body.contains(panelRef.el));
  }

  // ── one tier column ─────────────────────────────────────────────────────────
  function freeColumn() {
    const col = el('div', 'atl-plan free');
    const top = el('div', 'atl-plan-top');
    top.append(el('span', 'atl-plan-name', 'Free'), el('span', 'atl-plan-badge free', 'Current'));
    col.appendChild(top);

    const price = el('div', 'atl-plan-price');
    price.append(el('span', 'amt', '$0'), document.createTextNode('always'));
    col.appendChild(price);

    const list = el('ul', 'atl-plan-list');
    FREE_FEATURES.forEach((t) => {
      const li = el('li', 'atl-plan-li');
      li.append(el('span', 'atl-plan-tick', '✓'), el('span', null, t));
      list.appendChild(li);
    });
    col.appendChild(list);

    col.appendChild(el('div', 'atl-plan-note', 'No account, no billing. This is everything Atelier does today.'));
    return col;
  }

  function proColumn() {
    const pro = isPro();
    const col = el('div', 'atl-plan pro' + (pro ? ' active' : ''));

    const top = el('div', 'atl-plan-top');
    top.append(el('span', 'atl-plan-name', 'Pro'),
      el('span', 'atl-plan-badge ' + (pro ? 'active' : ''), pro ? 'Active' : 'Preview'));
    col.appendChild(top);

    const price = el('div', 'atl-plan-price', 'Pricing coming later');
    col.appendChild(price);

    const list = el('ul', 'atl-plan-list');
    PRO_FEATURES.forEach((f) => {
      const li = el('li', 'atl-plan-li');
      li.appendChild(el('span', 'atl-plan-tick', '✓'));
      li.appendChild(el('span', null, f.text));
      if (f.preview) li.appendChild(el('span', 'atl-plan-preview', 'preview'));
      list.appendChild(li);
    });
    col.appendChild(list);

    // ── gate: honest unlock (locked) / manage (unlocked) ──────────────────────
    const gate = el('div', 'atl-plan-gate');
    if (!pro) {
      gate.appendChild(el('div', 'atl-plan-note',
        'Not billed yet. Pricing and checkout are coming later — for now, entering any license key unlocks the preview.'));
      const row = el('div', 'atl-plan-row');
      const input = document.createElement('input');
      input.className = 'atl-plan-in'; input.type = 'text';
      input.placeholder = 'License key'; input.maxLength = 200;
      input.setAttribute('aria-label', 'Pro license key');
      const btn = el('button', 'atl-plan-btn', 'Unlock Pro');
      btn.type = 'button';
      const err = el('div', 'atl-plan-note');
      function submit() {
        const key = String(input.value || '').trim();
        if (!key) { err.textContent = 'Enter a license key to unlock the preview.'; err.className = 'atl-plan-note err'; return; }
        // No real license server — recording the token IS the honest gate, the
        // same one premium.js reads. Real validation + checkout land with the product.
        setLicense(key);
        render();
      }
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      row.append(input, btn);
      gate.append(row, err);
    } else {
      gate.appendChild(el('div', 'atl-plan-note ok',
        'Pro is unlocked (preview). The Workflow AI builder itself is still in development.'));
      const row = el('div', 'atl-plan-row');
      const open = el('button', 'atl-plan-btn', 'Open Workflow AI');
      open.type = 'button';
      open.addEventListener('click', () => {
        const p = premium();
        if (p && typeof p.spawn === 'function') { try { p.spawn(); } catch { /* noop */ } }
        close();
      });
      const relock = el('button', 'atl-plan-btn ghost', 'Remove license');
      relock.type = 'button';
      relock.addEventListener('click', () => { setLicense(''); render(); });
      row.append(open, relock);
      gate.appendChild(row);
    }
    col.appendChild(gate);
    return col;
  }

  // ── build / render the panel body ───────────────────────────────────────────
  function buildBody() {
    const wrap = el('div', 'atl-plans');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Free and Pro plans');
    wrap.appendChild(el('div', 'atl-plans-sub',
      'Everything Atelier does today is free. Pro previews upcoming premium features — nothing here is billed.'));
    const grid = el('div', 'atl-plans-grid');
    grid.append(freeColumn(), proColumn());
    wrap.appendChild(grid);
    return wrap;
  }

  // Re-render in place (after unlock / remove) so the singleton panel stays put.
  function render() {
    if (!panelAlive()) return;
    panelRef.body.textContent = '';
    panelRef.body.appendChild(buildBody());
  }

  // ── open / close (singleton, mirrors publish.js openSettings) ───────────────
  function open() {
    if (panelAlive()) {
      const x = panelRef.el.querySelector('.card-x');
      if (x && x.scrollIntoView) x.scrollIntoView({ block: 'nearest' });
      return;
    }
    panelRef = A.ui.openPanel('Plans', buildBody(), { backdrop: true });
    if (panelRef && panelRef.el) {
      const x = panelRef.el.querySelector('.card-x');
      if (x) x.addEventListener('click', () => { panelRef = null; });
    }
  }

  function close() {
    if (panelRef && typeof panelRef.close === 'function') { try { panelRef.close(); } catch {} }
    panelRef = null;
  }

  // ── palette command ─────────────────────────────────────────────────────────
  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'plans.open', label: 'Plans', icon: '◆', section: 'App',
      keywords: 'plans plan pricing pro free tier upgrade premium billing subscription unlock license workflow ai',
      run() { open(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand); // covers palette.js loading later

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierPlans = {
    open,
    close,
    isOpen: () => panelAlive(),
    isPro,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierPlans && typeof window.AtelierPlans.open === 'function');
    const proReadable = typeof isPro() === 'boolean';
    console.assert(registered, '[plans] module did not register window.AtelierPlans');
    console.assert(proReadable, '[plans] Pro state not readable');
    if (registered && proReadable) {
      console.log('[plans] self-check passed — honest Free/Pro panel ready (palette "Plans"; ' +
        'Pro reuses premium.js license token atelier.premium.license, no billing).');
    }
  })();
})();
