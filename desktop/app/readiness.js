/* ===========================================================================
   READINESS WIZARD — the front door stops silently assuming a logged-in CLI.

   Round-2 P1's top blocker: "What should we make?" greets everyone, but the
   core agent only answers if the Claude CLI was ALREADY signed in from a
   terminal, or an API key was already pasted. A newcomer's first message
   failed with a raw CLI error. This module asks the backend's GET /readiness
   (can the configured provider authenticate right now?) and, when the answer
   is no, offers the honest three-way branch:

     1. I use Claude (Max/Pro)  -> terminal instructions + a Check-again probe
     2. I have an API key       -> jump to Settings' Core agent card
     3. Just looking            -> play the free sample run (sample.js)

   Sequencing: stands down while the egress notice is pending or the tour is
   active; re-checks each launch until ready (no permanent dismissal — the
   broken front door is the thing being fixed). "Not now" quiets it for the
   session. Reopen: ⌘K -> "Set up your model".

   Contract: builds only against window.Atelier (+ fetch + window.atelier
   token bridge). Injects its own CSS. XSS rule: textContent only.
   =========================================================================== */

(function () {
  'use strict';
  const A = window.Atelier;
  if (!A || !A.ui || typeof A.ui.openPanel !== 'function' || !A.bus) {
    console.warn('[readiness] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  let panel = null;
  let snoozedThisSession = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  (function injectStyles() {
    if (document.getElementById('atl-ready-styles')) return;
    const css = `
      .atl-ready { display: flex; flex-direction: column; gap: 10px; width: 420px; }
      .atl-ready p { margin: 0; font-size: 13px; color: var(--ink-mid); line-height: 1.55; }
      .atl-ready-choices { display: flex; flex-direction: column; gap: 8px; }
      .atl-ready-choice { display: flex; flex-direction: column; gap: 2px; text-align: left;
        border: 1px solid var(--border); border-radius: 10px; background: #faf7f1;
        padding: 10px 12px; cursor: pointer; font: inherit; }
      .atl-ready-choice:hover { border-color: var(--accent); }
      .atl-ready-choice .t { font-size: 13px; font-weight: 600; color: var(--ink); }
      .atl-ready-choice .d { font-size: 11.5px; color: var(--ink-mid); line-height: 1.45; }
      .atl-ready-steps { display: flex; flex-direction: column; gap: 6px; }
      .atl-ready-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px; color: var(--ink); background: var(--accent-soft);
        border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; user-select: all; }
      .atl-ready-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .atl-ready-main { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-ready-main:hover { background: var(--accent-2); }
      .atl-ready-ghost { border: 1px solid var(--border); border-radius: 9px; background: #faf7f1;
        color: var(--ink-mid); font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; }
      .atl-ready-ghost:hover { border-color: var(--accent); }
      .atl-ready-note { font-size: 12px; color: var(--ink-mid); min-height: 15px; }
      .atl-ready-note.ok { color: var(--ok); font-weight: 600; }
    `;
    const style = el('style');
    style.id = 'atl-ready-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  async function fetchReadiness() {
    try {
      const headers = {};
      if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
      const res = await fetch(BASE + '/readiness', { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  function closePanel() {
    if (panel) { try { panel.close(); } catch { /* already gone */ } panel = null; }
  }

  function showSubscriptionSteps(body) {
    body.textContent = '';
    const wrap = el('div', 'atl-ready');
    wrap.appendChild(el('p', '', 'Atelier runs on the Claude CLI, signed into your Claude plan. One-time setup, in Terminal:'));
    const steps = el('div', 'atl-ready-steps');
    steps.appendChild(el('div', 'atl-ready-cmd', 'npm install -g @anthropic-ai/claude-code'));
    steps.appendChild(el('div', 'atl-ready-cmd', 'claude login'));
    wrap.appendChild(steps);
    wrap.appendChild(el('p', '', 'The login opens your browser; approve it, then come back here.'));
    const note = el('div', 'atl-ready-note', '');
    const row = el('div', 'atl-ready-row');
    const back = el('button', 'atl-ready-ghost', 'Back');
    const again = el('button', 'atl-ready-main', 'Check again');
    back.type = 'button'; again.type = 'button';
    back.addEventListener('click', () => showChoices(body));
    again.addEventListener('click', async () => {
      note.classList.remove('ok');
      note.textContent = 'Checking…';
      const r = await fetchReadiness();
      if (r && r.ready) {
        note.classList.add('ok');
        note.textContent = 'You are set — the core agent can sign in. Make something.';
        setTimeout(closePanel, 1600);
      } else {
        note.textContent = 'Not seeing a login yet. Finish `claude login` in Terminal, then try again.';
      }
    });
    row.append(back, again);
    wrap.append(note, row);
    body.appendChild(wrap);
  }

  function showChoices(body) {
    body.textContent = '';
    const wrap = el('div', 'atl-ready');
    wrap.appendChild(el('p', '', 'The built-in agent has nothing to sign in with yet, so a first request would fail. Pick how you want to run it:'));

    const choices = el('div', 'atl-ready-choices');

    const sub = el('button', 'atl-ready-choice');
    sub.type = 'button';
    sub.append(el('span', 't', 'I use Claude (Max or Pro plan)'),
      el('span', 'd', 'Included in your plan — no per-token billing. Needs a one-time Claude CLI login in Terminal.'));
    sub.addEventListener('click', () => showSubscriptionSteps(body));

    const key = el('button', 'atl-ready-choice');
    key.type = 'button';
    key.append(el('span', 't', 'I have an Anthropic API key'),
      el('span', 'd', 'Metered per token. Paste it in Settings under Core agent — it is validated before use.'));
    key.addEventListener('click', () => {
      closePanel();
      if (A.views && typeof A.views.select === 'function') A.views.select('settings');
    });

    const look = el('button', 'atl-ready-choice');
    look.type = 'button';
    look.append(el('span', 't', 'Just looking — show me a sample'),
      el('span', 'd', 'A free scripted run. Nothing is sent, nothing is spent, no account needed.'));
    look.addEventListener('click', () => {
      closePanel();
      if (window.AtelierSample && typeof window.AtelierSample.play === 'function') {
        window.AtelierSample.play();
      }
    });

    choices.append(sub, key, look);
    wrap.appendChild(choices);

    const row = el('div', 'atl-ready-row');
    const later = el('button', 'atl-ready-ghost', 'Not now');
    later.type = 'button';
    later.addEventListener('click', () => { snoozedThisSession = true; closePanel(); });
    row.appendChild(later);
    wrap.appendChild(row);
    body.appendChild(wrap);
  }

  function openWizard() {
    closePanel();
    const host = el('div');
    showChoices(host);
    panel = A.ui.openPanel('Set up your model', host, { backdrop: true });
  }

  // ── auto-show: each launch, once the egress notice + tour are out of the way ─
  function overlaysBusy() {
    const eg = window.AtelierEgress;
    if (eg && typeof eg.pending === 'function' && eg.pending()) return true;
    if (A.tour && typeof A.tour.active === 'function' && A.tour.active()) return true;
    return false;
  }

  let polls = 0;
  async function autoCheck() {
    if (snoozedThisSession || panel) return;
    if (overlaysBusy()) {
      if (polls++ < 60) setTimeout(autoCheck, 3000); // wait out notice + tour
      return;
    }
    const r = await fetchReadiness();
    if (r && r.ready === false && !snoozedThisSession) openWizard();
  }
  setTimeout(autoCheck, 2500);

  A.bus.emit('palette:add', {
    id: 'readiness.setup', label: 'Set up your model', icon: '⚙', section: 'Help',
    keywords: 'setup login sign in claude api key subscription model ready onboarding',
    run() { snoozedThisSession = false; openWizard(); },
  });

  window.AtelierReadiness = { open: openWizard, check: fetchReadiness };
})();
