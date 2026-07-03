'use strict';

/* ===========================================================================
   Atelier feature module — live job cards   (app/jobcards.js)

   When a SCHEDULED JOB fires, its run is now a tracked backend _AgentSession
   tagged with the job name (lite_server: get_response_compat -> _run_job_as_
   session). This module watches for those job sessions and AUTO-REVEALS each
   one as a live chat card on the dashboard, so the user watches the job's
   conversation happen — the same transcript, delegation notes, and sub-agent
   arrows as any Agent card — instead of only a Runs-ticker line.

   How it works
   ------------
   • Polls GET /sessions every 4s (a light read; runs always, even with no
     Agent cards open, since a job can fire while the user isn't chatting).
   • A job session is one with a non-null `job_name` (user Agent cards and
     sub-agents have job_name null, so they are never touched here — that is
     the discriminator; depth/parent alone would misfire on the user's own
     depth-0 cards).
   • FIRST successful poll BASELINES: every job session already present is
     added to `seen` WITHOUT revealing, so jobs that fired before the app
     opened (or before this module loaded) do not all pop up at once. Only
     jobs that appear AFTER the baseline are revealed.
   • Each newly-seen job session is revealed via
     AtelierSessions.reveal(id, job_name, {keepAlive:true}). keepAlive makes the
     card a VIEW that does NOT delete its backend session on close (closing the
     card or switching boards must never abort a still-running job); LRU
     reclaims the session once the job finishes. The revealed card is an
     ordinary attach-mode agent card, so its own transcript streams and — being
     a depth-0 session — the existing child-discovery sweep reveals any
     sub-agents it spawns, with arrows.
   • `seen` is grow-only (uuid ids never recur): a job the user closes stays in
     `seen` and is never re-revealed. No card:removed bookkeeping needed here.
   • User toggle: a RAW localStorage flag `atelier-jobcards-reveal` (default ON;
     '0' = off), flipped by the "Live job cards" row in the Settings view.
     While OFF, new job sessions are still marked seen (so flipping ON later
     reveals only jobs that fire from then on, not a backlog).

   Contract: builds ONLY against window.Atelier + window.AtelierSessions +
   fetch. Loads AFTER sessions.js (index.html order) — guarded so an absent
   dependency is harmless. Injects no CSS, owns no dock/UI beyond the reveal.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start`. Console: expect "[jobcards] ready".
   2. Trigger a job (e.g. the scheduler fires morning-brief, or POST
      /open-swarm/get_response {"message":"say hi","job_name":"demo"}) → within
      ~4s a chat card titled "demo" appears showing the job's note + prompt +
      streaming reply. If the job SpawnAgents, a child card + arrow appear.
   3. Close the card → the backend session is NOT deleted (Network tab: no
      DELETE), the job keeps running; the card does not reappear (seen).
   4. Settings → "Live job cards" → Off. Fire another job → no card. Back On →
      only jobs firing AFTER count.
   5. Reload before firing anything → no old job cards resurrect (baseline).
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus) {
    console.warn('[jobcards] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const POLL_MS = 4000;
  const REVEAL_KEY = 'atelier-jobcards-reveal';

  // default ON: absent (or anything but '0') -> reveal. The Settings row writes
  // '0' to disable and removeItem to re-enable (see views.js).
  function revealOn() {
    try { return localStorage.getItem(REVEAL_KEY) !== '0'; } catch { return true; }
  }

  const seen = new Set();   // grow-only: job session ids already handled
  let baselined = false;    // suppress the pre-existing/pre-load backlog once
  let sweeping = false;     // one fetch at a time; a slow backend must not stack

  async function fetchSessions() {
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + '/sessions', { headers });
    const data = await res.json();
    return (data && Array.isArray(data.sessions)) ? data.sessions : [];
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const jobs = (await fetchSessions()).filter((s) => s && s.id && s.job_name);
      if (!baselined) {
        baselined = true;
        // Baseline only FINISHED jobs so a backlog of old runs doesn't pop up.
        // A job still RUNNING at the first poll (one firing as the app opens —
        // exactly when the user wants to watch it) is left OUT of `seen` and
        // falls through to the reveal loop below. No early return.
        jobs.forEach((s) => { if (s.status !== 'running') seen.add(String(s.id)); });
      }
      // While OFF, mark new jobs seen anyway so flipping ON never dumps a
      // backlog — only jobs firing while ON are revealed.
      const on = revealOn();
      const canReveal = on
        && window.AtelierSessions
        && typeof window.AtelierSessions.reveal === 'function';
      for (const s of jobs) {
        const id = String(s.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (canReveal) {
          try {
            window.AtelierSessions.reveal(id, String(s.job_name || 'Scheduled job'),
              { keepAlive: true });
          } catch { /* a torn-down reveal path must not kill the sweep */ }
        }
      }
    } catch {
      // backend unreachable (still starting, or offline) — retry next tick.
      // baselined stays false until a poll succeeds, so nothing is missed.
    } finally {
      sweeping = false;
    }
  }

  const timer = setInterval(sweep, POLL_MS);
  sweep(); // baseline promptly at load (before the first interval)

  // published for the Settings toggle + tests (guarded consumers only)
  window.AtelierJobCards = {
    revealOn,
    setReveal(on) {
      try {
        if (on) localStorage.removeItem(REVEAL_KEY);
        else localStorage.setItem(REVEAL_KEY, '0');
      } catch { /* private mode / disabled storage — the in-memory sweep still runs */ }
    },
    _stop() { clearInterval(timer); }, // test hook
  };

  (function selfCheck() {
    const ok = !!window.AtelierJobCards
      && typeof window.AtelierJobCards.revealOn === 'function'
      && typeof window.AtelierSessions !== 'undefined';
    console.assert(typeof window.AtelierSessions !== 'undefined',
      '[jobcards] AtelierSessions missing — jobcards must load AFTER sessions.js');
    if (ok) console.log('[jobcards] ready — polling /sessions for job runs to reveal.');
  })();
})();
