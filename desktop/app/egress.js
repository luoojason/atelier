/* ===========================================================================
   EGRESS NOTICE — "local UI, cloud model", said out loud before the first run.

   Atelier LOOKS local (a desktop app, a loopback backend), and the 30-persona
   launch review flagged that as misleading: when agents work, prompts and
   anything a tool reads for the run (vault notes, workspace files, web pages)
   are sent to a cloud model provider. This module states that plainly ONCE,
   on first launch, before the onboarding tour.

   Mechanics mirror tour.js: the ack flag is RAW localStorage
   ('atelier-egress-ack'), deliberately NOT Atelier.store, so it is per-machine
   and survives board wipes. Sequencing: tour.js defers its 1500ms autostart
   while this notice is pending and unacked; acking the notice hands off to
   the tour (A.tour.start) when the tour has not run yet, so a first launch
   reads notice -> tour with no overlap.

   Reopen later: ⌘K -> "Data & privacy" (palette:add), or
   window.AtelierEgress.show().

   Contract: builds only against window.Atelier. Injects its own CSS. XSS
   rule: every string enters the DOM via textContent only.
   =========================================================================== */

(function () {
  'use strict';
  const A = window.Atelier;
  if (!A || !A.ui || typeof A.ui.openPanel !== 'function' || !A.bus) {
    console.warn('[egress] Atelier core not available — skipping.');
    return;
  }

  const ACK_KEY = 'atelier-egress-ack';

  function acked() {
    try { return localStorage.getItem(ACK_KEY) === '1'; }
    catch { return true; } // private mode: cannot persist, do not nag every boot
  }
  function markAcked() {
    try { localStorage.setItem(ACK_KEY, '1'); } catch { /* private mode */ }
  }

  (function injectStyles() {
    if (document.getElementById('atl-egress-styles')) return;
    const css = `
      .atl-egress { display: flex; flex-direction: column; gap: 10px; width: 400px; }
      .atl-egress p { margin: 0; font-size: 13px; color: var(--ink-mid); line-height: 1.55; }
      .atl-egress p strong { color: var(--ink); }
      .atl-egress ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
      .atl-egress li { font-size: 13px; color: var(--ink-mid); line-height: 1.5; }
      .atl-egress-row { display: flex; justify-content: flex-end; margin-top: 4px; }
      .atl-egress-ok { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 18px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-egress-ok:hover { background: var(--accent-2); }
    `;
    const style = document.createElement('style');
    style.id = 'atl-egress-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let panel = null;

  function show(onDone) {
    if (panel) { try { panel.close(); } catch { /* already gone */ } panel = null; }

    const wrap = el('div', 'atl-egress');

    const p1 = el('p', '');
    p1.append(
      el('strong', '', 'Local UI, cloud model. '),
      document.createTextNode('The studio, your boards, and your files live on this Mac. The intelligence is a cloud model.')
    );

    const list = el('ul', '');
    list.append(
      el('li', '', 'When agents work, your prompts and anything a tool reads for the run (vault notes, workspace files, web pages) are sent to your model provider: Anthropic on your subscription, or a provider you connect.'),
      el('li', '', 'Web searches use DuckDuckGo, without an account.'),
      el('li', '', 'The local backend answers only this Mac (loopback, token-gated). Nothing is published or spent without your approval.')
    );

    const row = el('div', 'atl-egress-row');
    const ok = el('button', 'atl-egress-ok', 'Got it');
    ok.type = 'button';
    row.appendChild(ok);
    wrap.append(p1, list, row);

    panel = A.ui.openPanel('What leaves this Mac', wrap, { backdrop: true });
    ok.addEventListener('click', () => {
      markAcked();
      try { panel.close(); } catch { /* already gone */ }
      panel = null;
      if (typeof onDone === 'function') onDone();
    });
  }

  // ── first-run auto-show, sequenced BEFORE the tour ──────────────────────────
  // tour.js checks AtelierEgress.pending() inside its own autostart timer and
  // stands down while the notice is unacked; the ack hands off to the tour.
  function pending() { return !acked(); }

  function autoShow() {
    if (acked()) return;
    setTimeout(() => {
      if (acked()) return;
      show(() => {
        try {
          const tourDone = localStorage.getItem('atelier-tour-done') === '1';
          if (!tourDone && A.tour && typeof A.tour.start === 'function' && !A.tour.active()) {
            A.tour.start();
          }
        } catch { /* tour is optional */ }
      });
    }, 600);
  }

  A.bus.on('core:ready', autoShow);
  autoShow();

  // ── reopen on demand ────────────────────────────────────────────────────────
  A.bus.emit('palette:add', {
    id: 'egress.notice', label: 'Data & privacy', icon: '◍', section: 'Help',
    keywords: 'privacy data egress cloud local provider notice what leaves',
    run() { show(); },
  });

  window.AtelierEgress = { show, pending, ACK_KEY };
})();
