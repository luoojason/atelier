/* ===========================================================================
   SAMPLE RUN — the zero-cost guaranteed first win (Round-2 P1).

   A canned research -> make -> publish playback that shows what a real run
   looks and feels like BEFORE the user connects a subscription, pastes a key,
   or spends a cent. Nothing is sent and nothing is spent: the narration is
   scripted right here, and the one real side effect is POST /demo/sample
   writing a bundled markdown deliverable into the workspace so "open the file
   it made" is true at the end.

   Honesty rules: the card is labeled "Sample" everywhere, the publish step
   says outbound actions HOLD for approval and that nothing was sent, and the
   closing line says the run was scripted.

   Surfaces: A.registerApp('sample') (dock/palette spawn), a ⌘K entry, and
   window.AtelierSample.play() for the recipes gallery tile + the upcoming
   readiness wizard's "try it first" branch.

   Contract: builds only against window.Atelier (+ fetch and the optional
   window.atelier token bridge). Injects its own CSS. XSS rule: every dynamic
   string enters the DOM via textContent only. Reduced motion -> instant.
   =========================================================================== */

(function () {
  'use strict';
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.ui) {
    console.warn('[sample] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';

  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  (function injectStyles() {
    if (document.getElementById('atl-sample-styles')) return;
    const css = `
      .atl-sample-body { display: flex; flex-direction: column; gap: 0; height: 100%; overflow-y: auto; }
      .atl-sample-badge { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        border-bottom: 1px solid var(--border-soft); background: var(--accent-soft); }
      .atl-sample-badge .tag { font-size: 10px; font-weight: 700; letter-spacing: .05em;
        text-transform: uppercase; color: var(--accent-2); border: 1px solid rgba(192,92,55,.3);
        border-radius: 6px; padding: 1px 6px; background: #fff; }
      .atl-sample-badge .why { font-size: 11.5px; color: var(--ink-mid); }
      .atl-sample-steps { display: flex; flex-direction: column; gap: 4px; padding: 12px; }
      .atl-sample-actor { font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .05em; color: var(--accent-2); margin-top: 8px; }
      .atl-sample-line { font-size: 12.5px; color: var(--ink-mid); line-height: 1.5;
        padding-left: 10px; border-left: 2px solid var(--border); }
      .atl-sample-line.done { color: var(--ink); }
      .atl-sample-fade { opacity: 0; transition: opacity .35s ease; }
      .atl-sample-fade.in { opacity: 1; }
      .atl-sample-actions { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border-soft);
        align-items: center; flex-wrap: wrap; }
      .atl-sample-open { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 14px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
      .atl-sample-open:hover { background: var(--accent-2); }
      .atl-sample-again { border: 1px solid var(--border); border-radius: 9px; background: #faf7f1;
        color: var(--ink-mid); font: inherit; font-size: 12.5px; padding: 7px 12px; cursor: pointer; }
      .atl-sample-path { font-size: 11px; color: var(--ink-dim);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .atl-sample-note { font-size: 11.5px; color: var(--ink-dim); padding: 0 12px 12px; line-height: 1.5; }
    `;
    const style = el('style');
    style.id = 'atl-sample-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // The scripted run. Each entry: [actor|null, line]. Pacing per line below.
  const SCRIPT = [
    ['Researcher', 'Looking for desk plants that genuinely survive low light…'],
    [null, 'Found care guidance for snake plant, ZZ plant, pothos, peace lily, cast iron plant.'],
    [null, 'Captured a checkable care fact for each (light needs, watering rhythm).'],
    ['Maker', 'Writing the piece: a ranked list with a care card table…'],
    [null, 'Saved the deliverable to the workspace as five-desk-plants.md.'],
    ['Publisher', 'A real run would now offer to publish or send this somewhere.'],
    [null, 'Outbound actions always HOLD for your approval — this sample sent nothing.'],
  ];
  const LINE_MS = 750;

  function playInto(body, inst) {
    body.textContent = '';

    const badge = el('div', 'atl-sample-badge');
    badge.appendChild(el('span', 'tag', 'Sample'));
    badge.appendChild(el('span', 'why', 'Nothing was sent, nothing was spent. Scripted playback.'));
    body.appendChild(badge);

    const steps = el('div', 'atl-sample-steps');
    body.appendChild(steps);

    const note = el('div', 'atl-sample-note', '');
    const actions = el('div', 'atl-sample-actions');

    const instant = prefersReducedMotion();
    let cancelled = false;
    inst.cancelPlayback = () => { cancelled = true; };

    function addLine([actor, text], idx, done) {
      if (cancelled || !document.body.contains(body)) return;
      if (actor) steps.appendChild(el('div', 'atl-sample-actor', actor));
      const line = el('div', 'atl-sample-line' + (instant ? '' : ' atl-sample-fade'), text);
      steps.appendChild(line);
      if (!instant) requestAnimationFrame(() => line.classList.add('in'));
      if (done) finish();
    }

    async function finish() {
      // the one real effect: materialize the deliverable (no network beyond loopback)
      let rel = null;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
        const res = await fetch(BASE + '/demo/sample', { method: 'POST', headers, body: '{}' });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) rel = data.path;
      } catch { /* backend down — the playback still stands on its own */ }
      if (cancelled || !document.body.contains(body)) return;

      if (rel) {
        const open = el('button', 'atl-sample-open', 'Open the file it made');
        open.type = 'button';
        open.addEventListener('click', () => {
          const url = BASE + '/workspace/raw?path=' + encodeURIComponent(rel)
            + (window.atelier && window.atelier.token
              ? '&atk=' + encodeURIComponent(window.atelier.token) : '');
          try { window.open(url, '_blank'); } catch { /* popup blocked */ }
        });
        actions.appendChild(open);
        actions.appendChild(el('span', 'atl-sample-path', 'workspace/' + rel));
      } else {
        actions.appendChild(el('span', 'atl-sample-path', 'Deliverable unavailable (backend not reachable).'));
      }
      const again = el('button', 'atl-sample-again', 'Play again');
      again.type = 'button';
      again.addEventListener('click', () => playInto(body, inst));
      actions.appendChild(again);
      note.textContent = 'This run was scripted, start to finish. A real run does the same dance with live agents: research with sources, a made deliverable, and every outbound step held for your OK.';
      body.appendChild(actions);
      body.appendChild(note);
    }

    if (instant) {
      SCRIPT.forEach((entry, i) => addLine(entry, i, i === SCRIPT.length - 1));
    } else {
      SCRIPT.forEach((entry, i) => {
        setTimeout(() => addLine(entry, i, i === SCRIPT.length - 1), LINE_MS * (i + 1));
      });
    }
  }

  // ── card plumbing (the shared canvas idiom: addCard wires drag + the ×) ─────
  const CARD_W = 380, CARD_H = 380;
  const instances = new Map();

  function spawnCard(opts = {}) {
    const id = 'sample-' + Date.now().toString(36);
    const card = el('section', 'card app-card atl-sample-card');
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'), el('span', 'card-title', 'Sample run'), el('span', 'card-x', '×'));
    const body = el('div', 'app-body atl-sample-body');
    card.append(bar, body);

    let pos = opts.worldPos;
    if (!pos) {
      const c = A.canvas.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      pos = { x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 };
    }
    const handle = A.canvas.addCard(card, { x: pos.x, y: pos.y, w: CARD_W, h: CARD_H });
    const inst = { id, handle, el: card, body, cancelPlayback: null };
    instances.set(id, inst);
    A.bus.on('card:removed', ({ el: removed }) => {
      if (removed === card) {
        if (inst.cancelPlayback) inst.cancelPlayback();
        instances.delete(id);
      }
    });

    playInto(body, inst);
    return inst;
  }

  A.registerApp('sample', {
    label: 'Sample run',
    icon: '▶',
    create(worldPos) {
      const inst = spawnCard(worldPos ? { worldPos } : {});
      return inst ? inst.el : null;
    },
  });

  A.bus.emit('palette:add', {
    id: 'sample.play', label: 'Watch a sample run (free)', icon: '▶', section: 'Help',
    keywords: 'sample demo free first run try example zero cost',
    run() { spawnCard({}); },
  });

  window.AtelierSample = { play: () => spawnCard({}), instances };
})();
