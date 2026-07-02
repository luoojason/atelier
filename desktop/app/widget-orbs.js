'use strict';

/* Atelier feature module — agent status orbs ('agentorbs' widget)
   =============================================================================
   Registers exactly ONE widget type via Atelier.registerWidget: a field of
   breathing orbs, one per live agent session, read from GET /sessions
   (rows: {id, name, status, parent_id, depth}; status is "idle" | "running" |
   "error" per lite_server.py — anything else renders as idle, defensively).

   widgets.js owns everything around the def: spawn, drag/resize persistence,
   the gear config form (built from `fields` — its buildForm reads f.name, so
   fields here use `name`), and re-mount on config save / board switch. Its
   double-click "Add widget" picker iterates the Atelier.widgets registry at
   open time (openPicker → A.widgets.forEach), so this externally registered
   type shows up there automatically — verified against widgets.js, no extra
   wiring needed. core.js's pre-widgets inline fallback ignores `mount`, but
   the shipped app always loads widgets.js, which runs it.

   Orb states (pure CSS animations — no rAF; nothing here tracks geometry):
   • idle    — slow soft terracotta breath (4s)
   • running — faster, brighter accent pulse with a glow (1.2s)
   • error   — steady red (#b04a3a), no motion
   Sessions with depth >= 1 (server-side sub-agents) render slightly smaller.
   Display caps at 8 orbs; the remainder collapses into a '+N' chip. Clicking
   an orb calls window.AtelierSessions.reveal(id, name) — guarded, since that
   accessor module may be absent (plain browser, partial build).

   Data: GET /sessions every 5s with an immediate first tick, via the preload
   bridge window.atelier.get and a plain-fetch fallback for browser testing
   (same idiom as widgets.js). A failed poll keeps the last orbs and dims the
   widget (.orbs-stale); recovery undims on the next good tick. Between good
   ticks the DOM is only touched where something changed — re-inserting a node
   restarts its CSS animation, so unchanged orbs keep their breathing phase.
   Every server-derived string lands via textContent, never innerHTML.

   Boundaries: touches ONLY window.Atelier + standard DOM, injects its own
   <style>, edits no sibling file and not index.html (the orchestrator's).

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ with the backend running.
   2. Double-click empty canvas → the picker lists "Agent orbs" (☉) → place it.
      With no sessions the body shows 'No agent sessions.' and nothing polls
      into an error (fresh-machine empty state).
   3. Open an Agent card in the sidebar → within 5s a terracotta orb appears,
      breathing slowly. Send the agent a message → the orb pulses faster and
      brighter until the turn ends; a failed turn leaves it steady red.
   4. Click an orb → the matching agent card is raised / revealed
      (sessions.js accessor). Without sessions.js the click is a no-op.
   5. Spawn a sub-agent (depth 1) → its orb renders smaller than its parent's.
      With 9+ sessions the ninth and beyond fold into a '+N' chip.
   6. Kill the backend → the widget dims but keeps the last orbs; restart →
      it recovers on the next 5s tick. Close the card → polling stops (watch
      the Network tab).

   ── SELF-CHECK ─────────────────────────────────────────────────────────────
   A console.assert at the bottom verifies the type registered. Headless
   empty-state proof lives in the build notes: render + mount against a
   stubbed /sessions [] shows the empty text, zero errors, cleanup clears
   the interval.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerWidget !== 'function') {
    console.warn('[widget-orbs] Atelier core not available — skipping.');
    return;
  }

  const TYPE = 'agentorbs';
  const POLL_MS = 5000; // contract cadence for /sessions
  const MAX_ORBS = 8;   // display cap; the rest becomes '+N'

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── inject module CSS (warm palette via the :root vars in styles.css) ─────
  (function injectStyles() {
    if (document.getElementById('atelier-widget-orbs-styles')) return;
    const css = `
      .orbs-wgt { justify-content: flex-start; overflow: hidden; }
      .orbs-row {
        display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-start;
        justify-content: center; align-content: flex-start; padding-top: 6px;
        overflow: auto; flex: 1; min-height: 0;
      }
      .orbs-cell {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        width: 58px; border: none; background: transparent; padding: 2px 0 0;
        font: inherit; cursor: pointer;
      }
      .orbs-orb { width: 34px; height: 34px; border-radius: 50%; }
      .orbs-cell.orbs-sub .orbs-orb { width: 24px; height: 24px; }
      .orbs-name {
        font-size: 10.5px; color: var(--ink-dim); max-width: 56px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* idle: slow soft terracotta breath */
      .orbs-orb.orbs-idle {
        background: radial-gradient(circle at 32% 30%, #f0c9b2, var(--accent) 78%);
        animation: orbs-breathe 4s ease-in-out infinite;
      }
      /* running: faster, brighter pulse with an accent glow */
      .orbs-orb.orbs-running {
        background: radial-gradient(circle at 32% 30%, #ffd9c2, var(--accent) 68%);
        animation: orbs-pulse 1.2s ease-in-out infinite;
      }
      /* error: steady red, deliberately motionless */
      .orbs-orb.orbs-error {
        background: radial-gradient(circle at 32% 30%, #d98a7c, #b04a3a 72%);
      }

      @keyframes orbs-breathe {
        0%, 100% { transform: scale(0.94); opacity: 0.55; }
        50%      { transform: scale(1.04); opacity: 0.8; }
      }
      @keyframes orbs-pulse {
        0%, 100% { transform: scale(0.96); opacity: 0.85;
                   box-shadow: 0 0 0 0 rgba(192, 92, 55, 0); }
        50%      { transform: scale(1.12); opacity: 1;
                   box-shadow: 0 0 14px 3px rgba(192, 92, 55, 0.45); }
      }

      .orbs-more {
        width: 34px; height: 34px; border-radius: 50%; margin-top: 2px;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; color: var(--ink-dim);
        background: rgba(192, 92, 55, 0.15);
      }
      .orbs-empty { color: var(--ink-dim); font-size: 12.5px; }

      /* last poll failed — keep the orbs, just dim (widgets.js stale idiom) */
      .orbs-wgt.orbs-stale { opacity: 0.55; transition: opacity 0.3s ease; }
    `;
    const style = el('style');
    style.id = 'atelier-widget-orbs-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // preload bridge in the app, plain fetch in a browser tab (widgets.js idiom)
  const api = (p) => window.atelier && window.atelier.get
    ? window.atelier.get(p)
    : fetch('http://127.0.0.1:8765' + p).then((r) => r.json());

  A.registerWidget(TYPE, {
    label: 'Agent orbs',
    icon: '☉',
    size: { w: 300, h: 170 },
    defaultConfig: { title: 'Agent orbs' },
    fields: [{ name: 'title', label: 'Title', type: 'text' }],

    render() {
      const w = el('div', 'wgt orbs-wgt');
      const row = el('div', 'orbs-row');
      row.style.display = 'none';
      w.append(row, el('div', 'orbs-empty', 'No agent sessions.'));
      return w;
    },

    mount(root) {
      const row = root.querySelector('.orbs-row');
      const empty = root.querySelector('.orbs-empty');
      if (!row || !empty) return null;
      const more = el('div', 'orbs-more');

      // id -> { wrap, orb, nameEl, status, name, sub } — reused across ticks
      // so unchanged orbs keep their CSS animation phase.
      const orbs = new Map();
      let lastOrder = '';
      let stopped = false;

      function makeOrb(id) {
        const wrap = el('button', 'orbs-cell');
        wrap.type = 'button';
        const orb = el('span', 'orbs-orb orbs-idle');
        const nameEl = el('span', 'orbs-name');
        wrap.append(orb, nameEl);
        const entry = { wrap, orb, nameEl, status: 'idle', name: '', sub: false };
        // guarded reveal: the sessions accessor module may be absent
        wrap.addEventListener('click', () => {
          if (window.AtelierSessions && typeof window.AtelierSessions.reveal === 'function') {
            window.AtelierSessions.reveal(id, entry.name);
          }
        });
        return entry;
      }

      function update(list) {
        const visible = list.slice(0, MAX_ORBS);
        const extra = list.length - visible.length;
        const ids = visible.map((s) => String(s.id == null ? '' : s.id));

        // drop orbs whose session vanished
        const keep = new Set(ids);
        orbs.forEach((entry, id) => {
          if (keep.has(id)) return;
          if (entry.wrap.parentNode) entry.wrap.parentNode.removeChild(entry.wrap);
          orbs.delete(id);
        });

        visible.forEach((s, i) => {
          const id = ids[i];
          let entry = orbs.get(id);
          if (!entry) { entry = makeOrb(id); orbs.set(id, entry); }
          const status = (s.status === 'running' || s.status === 'error') ? s.status : 'idle';
          if (entry.status !== status) {
            entry.orb.className = 'orbs-orb orbs-' + status;
            entry.status = status;
          }
          const sub = Number(s.depth) >= 1; // sub-agents render smaller
          if (entry.sub !== sub) {
            entry.wrap.classList.toggle('orbs-sub', sub);
            entry.sub = sub;
          }
          const name = s.name == null ? '' : String(s.name);
          if (entry.name !== name) {
            entry.nameEl.textContent = name || id.slice(0, 8);
            entry.nameEl.title = name;
            entry.name = name;
          }
        });

        // re-append only when membership/order changed: moving a node restarts
        // its CSS animation, so a stable list must leave the DOM untouched
        const order = ids.join(' ');
        if (order !== lastOrder) {
          ids.forEach((id) => row.appendChild(orbs.get(id).wrap));
          row.appendChild(more);
          lastOrder = order;
        }

        if (extra > 0) { more.textContent = '+' + extra; more.style.display = ''; }
        else more.style.display = 'none';

        const has = visible.length > 0;
        row.style.display = has ? '' : 'none';
        empty.style.display = has ? 'none' : '';
      }

      const tick = () => {
        api('/sessions')
          .then((data) => {
            if (stopped) return;
            const list = data && Array.isArray(data.sessions) ? data.sessions : null;
            if (!list) return; // malformed payload: keep last values
            try {
              update(list.filter((s) => s && typeof s === 'object'));
            } catch (e) {
              console.error('[widget-orbs] update', e);
            }
            root.classList.remove('orbs-stale');
          })
          .catch(() => { if (!stopped) root.classList.add('orbs-stale'); });
      };
      tick();
      const iv = setInterval(tick, POLL_MS);
      return () => { stopped = true; clearInterval(iv); };
    },
  });

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const ok = A.widgets && typeof A.widgets.has === 'function' && A.widgets.has(TYPE);
    console.assert(ok, '[widget-orbs] agentorbs failed to register');
    if (ok) {
      console.log('[widget-orbs] ready — agentorbs registered; the double-click picker lists it automatically.');
    }
  })();
})();
