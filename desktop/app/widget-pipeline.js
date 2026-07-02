'use strict';

/* Atelier feature module — campaign gate-pipeline widget ('campaignflow')
   =============================================================================
   Registers ONE widget type via Atelier.registerWidget: a four-node pipeline
   showing how far the newest campaign has moved through its gates:

       brief → produce → critic → publish

   Each node is a dot + label connected by lines; a node lights up (accent glow,
   label darkens, CSS transition) when its stage is real in the stored data:

     • brief   — a campaign exists at all
     • produce — >=1 deliverable recorded (status advanced past "planned", or a
                 non-empty path is present)
     • critic  — >=1 deliverable carrying a verdict (any non-empty verdict)
     • publish — >=1 deliverable whose verdict is "ship" — campaign_core.gate()
                 is fail-safe and only ever publishes verdict == "ship"
                 (revise / block / unknown / missing all gate out), so nothing
                 weaker lights this node.

   Under the nodes: one caption line with the campaign goal (CSS-ellipsis
   truncated, set via textContent). No campaigns -> 'No campaigns yet.'

   Data source and stored shape
   ----------------------------
   GET /campaigns every 20s -> {"campaigns": [entry, ...]} — the kind=="campaign"
   entries from the swarm memory store, newest first, limit 20, passed through
   verbatim by the backend. Per campaign_agent/campaign_core.save_campaign each
   entry looks like:

     { "ts": iso, "kind": "campaign", "text": goal, "project": str|null,
       "id": str|null,
       "campaign": { "id", "goal", "project", "brief",
                     "deliverables": [ { "type", "spec", "status",
                                         "path": str|null,
                                         "verdict": "ship"|"revise"|"block"|null } ],
                     "stage": "planned"|"producing"|"gated",
                     "created_ts": str|null } }

   Everything here reads that shape DEFENSIVELY: a missing "campaign" key falls
   back to treating the entry itself as the campaign dict, non-dict deliverables
   are skipped, and missing status/path/verdict keys just leave a stage unlit —
   a malformed entry can dim the widget but never throw. The newest campaign is
   the first entry that yields a readable campaign (the route sorts newest
   first). While the route is absent or the backend is down, the last painted
   state stays and the widget dims (.cpf-stale) — the poll never writes error
   states into the DOM.

   Boundaries (per the module contract)
   ------------------------------------
   • Touches ONLY window.Atelier + standard DOM; owns ONLY this file. Does NOT
     edit index.html, core.js, styles.css, widgets.js, or any sibling module.
   • All CSS is injected from the <style> this module creates (warm palette via
     the :root vars: --accent / --ink / --ink-dim; track rgba(192,92,55,.15)).
   • Spawn / persist / gear-config / board-switch re-mount all ride widgets.js:
     externally registered types get that machinery for free, and the
     double-click picker lists registry entries automatically — verified:
     widgets.js openPicker() iterates A.widgets.forEach, so 'campaignflow'
     shows up as '⛓ Campaign gates' with no extra wiring.
   • mount() returns a cleanup that clears its ONLY timer (one setInterval;
     no rAF, no EventSource — the lit transition is pure CSS).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. npm start in desktop/ → double-click empty canvas → pick 'Campaign gates'.
   2. Fresh machine (no campaigns): all four nodes unlit, caption reads
      'No campaigns yet.', console clean. Backend off: same, plus the widget
      dims after the first failed poll.
   3. Start a campaign (StartCampaign) → within 20s 'brief' lights.
      RecordDeliverable with a path → 'produce' lights; with verdict=revise →
      'critic' lights; with verdict=ship → 'publish' lights. Caption shows the
      campaign goal, long goals ellipsize.
   4. Close the card → the poll stops (watch the Network tab).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   console.assert at the bottom verifies the type registered. The pure stage
   derivation is exposed as window.AtelierPipelineWidget.stageStates for
   headless testing.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function') {
    console.warn('[widget-pipeline] Atelier core not available — skipping.');
    return;
  }

  const TYPE = 'campaignflow';
  const POLL_MS = 20000; // contract cadence: GET /campaigns every 20s

  // ── tiny DOM helper (same idiom as widgets.js) ─────────────────────────────
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── inject module CSS ──────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-pipeline-styles')) return;
    const css = `
      .cpf { flex: 1; min-height: 0; display: flex; flex-direction: column;
        justify-content: center; gap: 12px; }

      /* nodes: dot over label; the row top-aligns so connector lines can sit
         at the dots' vertical center regardless of label height */
      .cpf-row { display: flex; align-items: flex-start; padding: 0 6px; }
      .cpf-node { display: flex; flex-direction: column; align-items: center;
        gap: 6px; min-width: 52px; }
      .cpf-dot { width: 14px; height: 14px; border-radius: 50%;
        background: rgba(192,92,55,.15); border: 1px solid rgba(192,92,55,.25);
        transition: background .45s ease, box-shadow .45s ease,
          border-color .45s ease; }
      .cpf-lab { font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
        text-transform: uppercase; color: var(--ink-dim);
        transition: color .45s ease; }
      .cpf-node.lit .cpf-dot { background: var(--accent);
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(192,92,55,.18), 0 0 10px rgba(192,92,55,.55); }
      .cpf-node.lit .cpf-lab { color: var(--ink); }

      /* connector line — dot is 14px + 1px border, so center ~= 7px; the line
         is 2px, margin-top 6px centers it on the dots */
      .cpf-line { flex: 1; height: 2px; margin: 6px 4px 0; border-radius: 1px;
        background: rgba(192,92,55,.15); transition: background .45s ease; }
      .cpf-line.lit { background: var(--accent); }

      /* goal caption (server string -> textContent; CSS truncation) */
      .cpf-caption { font-size: 11.5px; color: var(--ink-dim);
        text-align: center; padding: 0 8px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }

      /* last poll failed — keep values, just dim (widgets.js .wgt-stale idiom) */
      .cpf.cpf-stale { opacity: .55; transition: opacity .3s ease; }
    `;
    const style = el('style');
    style.id = 'atelier-widget-pipeline-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── backend access (widgets.js contract fallback idiom) ───────────────────
  // Preload bridge in the app, plain fetch in a browser tab for manual testing.
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  const STAGES = ['brief', 'produce', 'critic', 'publish'];

  // ── stage derivation (pure, defensive over the stored shape) ──────────────
  // Accepts one /campaigns item: normally the verbatim memory entry (campaign
  // dict under the "campaign" key), defensively also a bare campaign dict.
  // Returns { brief, produce, critic, publish, goal } or null when unreadable.
  function stageStates(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const wrapped = entry.campaign;
    const camp = (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped))
      ? wrapped : entry;

    const dels = (Array.isArray(camp.deliverables) ? camp.deliverables : [])
      .filter((d) => d && typeof d === 'object' && !Array.isArray(d));
    const statusOf = (d) => String(d.status == null ? '' : d.status).trim().toLowerCase();
    const verdictOf = (d) => String(d.verdict == null ? '' : d.verdict).trim().toLowerCase();
    const hasPath = (d) => d.path != null && String(d.path).trim() !== '';

    // produce: the deliverable lifecycle is planned -> produced -> gated, so
    // anything past "planned" (or carrying an artifact path) counts as recorded.
    const produce = dels.some((d) =>
      statusOf(d) === 'produced' || statusOf(d) === 'gated' || hasPath(d));
    // critic: any verdict at all means the Critic (or a gate call) weighed in.
    const critic = dels.some((d) => verdictOf(d) !== '');
    // publish: campaign_core.gate() publishes ONLY verdict == "ship" — revise /
    // block / unknown all fail safe to non-publishable, so we match "ship" only.
    const publish = dels.some((d) => verdictOf(d) === 'ship');

    let goal = camp.goal != null ? String(camp.goal) : '';
    if (!goal && entry.text != null) goal = String(entry.text); // entry-level fallback
    return { brief: true, produce, critic, publish, goal };
  }

  // First readable campaign in the list — the route returns newest first
  // (limit 20), so this is the newest campaign.
  function newestStages(list) {
    for (let i = 0; i < list.length; i++) {
      const s = stageStates(list[i]);
      if (s) return s;
    }
    return null;
  }

  // ── painting (in-place DOM update; lit transitions are pure CSS) ──────────
  function paint(root, states) {
    const nodes = root.querySelectorAll('.cpf-node');
    const lines = root.querySelectorAll('.cpf-line');
    STAGES.forEach((key, i) => {
      const lit = !!(states && states[key]);
      if (nodes[i]) nodes[i].classList.toggle('lit', lit);
      // line i sits between stage i and stage i+1: light it when the
      // downstream stage is lit, so the accent visibly flows left to right.
      if (i > 0 && lines[i - 1]) lines[i - 1].classList.toggle('lit', lit);
    });
    const cap = root.querySelector('.cpf-caption');
    if (cap) {
      const goal = states ? String(states.goal || '').trim() : '';
      cap.textContent = states
        ? (goal || '(no goal recorded)')
        : 'No campaigns yet.';
      cap.title = goal; // full goal on hover; CSS ellipsis truncates the line
    }
  }

  // ── the widget def ─────────────────────────────────────────────────────────
  A.registerWidget(TYPE, {
    label: 'Campaign gates',
    icon: '⛓',
    size: { w: 340, h: 150 },
    defaultConfig: { title: '' }, // empty -> the card bar shows the label
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
    ],

    // Static skeleton: four unlit nodes + connectors + the empty-state caption.
    // The first poll (immediate, in mount) paints real state over it.
    render() {
      const w = el('div', 'wgt cpf');
      const row = el('div', 'cpf-row');
      STAGES.forEach((key, i) => {
        if (i) row.appendChild(el('i', 'cpf-line'));
        const node = el('div', 'cpf-node');
        node.dataset.stage = key;
        node.append(el('span', 'cpf-dot'), el('span', 'cpf-lab', key));
        row.appendChild(node);
      });
      w.append(row, el('div', 'cpf-caption', 'No campaigns yet.'));
      return w;
    },

    // Poll /campaigns every 20s (immediate first tick). Failure keeps the last
    // painted state and dims; an unexpected payload shape is ignored the same
    // way (never-crash). Returns a cleanup clearing the ONLY timer.
    mount(root) {
      let stopped = false;
      const tick = () => {
        api('/campaigns')
          .then((data) => {
            if (stopped) return;
            root.classList.remove('cpf-stale');
            const list = data && Array.isArray(data.campaigns) ? data.campaigns : null;
            if (!list) return; // route missing / error body: keep last values
            try { paint(root, newestStages(list)); }
            catch (e) { console.error('[widget-pipeline] paint', e); }
          })
          .catch(() => { if (!stopped) root.classList.add('cpf-stale'); });
      };
      tick();
      const iv = setInterval(tick, POLL_MS);
      return () => { stopped = true; clearInterval(iv); };
    },
  });

  // ── scriptable hook for headless testing ──────────────────────────────────
  window.AtelierPipelineWidget = { type: TYPE, stageStates, newestStages };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = !!(A.widgets && typeof A.widgets.has === 'function' && A.widgets.has(TYPE));
    console.assert(ok, '[widget-pipeline] widget type "' + TYPE + '" failed to register');
    if (ok) {
      console.log('[widget-pipeline] ready — "' + TYPE + '" registered; it appears in the double-click picker as "⛓ Campaign gates".');
    }
  })();
})();
