'use strict';

/* ===========================================================================
   Atelier feature module — marquee-link   (app/link.js)

   Boxing a browser card and an agent card together with the core.js
   shift-drag marquee links the browser TO the agent: sessions.js then rides
   the browser's current page (title + url) along with every message sent
   from that agent card. Boxing the same pair again unlinks it.

   How it works
   ------------
   • core.js finalizes a marquee on mouseup and emits bus 'selection:changed'.
     On every such event this module reads A.selection.get() and proceeds
     ONLY when exactly two cards are selected and exactly one of them is a
     browser card (window.AtelierApps.browserInfo(el) !== null — read lazily
     at event time, so load order against apps.js does not matter) and the
     other is an agent card (class 'atl-agent-card', owned by sessions.js).
   • Toggle semantics: an already-linked identical pair unlinks (toast
     'Browser unlinked from <agent title>', selection cleared so a stray
     re-emission of selection:changed cannot immediately relink the pair);
     anything else links — an agent
     holds at most ONE linked browser, so relinking a different browser first
     unlinks the old arrow, then the new pair is stored in a module Map
     (agentEl -> { browserEl, unlink }), the arrow is drawn via
     A.arrows.link(browserEl, agentEl) keeping the returned unlink fn, a
     toast confirms, and the selection is cleared.
   • bus 'card:removed' on either side drops the pair. arrows.js already
     removes its path for removed cards, but the stored unlink is called
     anyway (defensively — it is idempotent) so the Map can never hold a
     live arrow for a dead card.
   • No CSS is injected: the arrow (arrows.js) and the toast (core.js) are
     the whole visual surface of a link.

   API (published as window.Atelier.links)
   ----------------------------------------
     browserFor(agentEl) -> {url, title} | null
         LIVE read: resolves the linked browser card's ACTIVE tab through
         window.AtelierApps.browserInfo at CALL time — never cached, so the
         rider always carries the page showing right now.
     browserElFor(agentEl) -> the linked browser card ELEMENT | null
         (round 16) the raw element straight from the link Map — no tab
         resolution. sessions.js hands it to AtelierApps.browserNavigate
         when the agent requests navigation of the user-linked browser.
     link(agentEl, browserEl) -> true if linked
         (round 22) the marquee toggle-ON path WITHOUT the gesture: draws the
         browser->agent arrow and registers the pair in the same Map. Used by
         sessions.js after the OpenBrowser tool spawns a browser card so the
         auto-created browser behaves exactly like a user-linked one.
     unlink(agentEl)  -> true if a link was removed
     count()          -> number of live links

   Boundaries (per the module contract)
   ------------------------------------
   • Loads AFTER arrows.js and sessions.js (index.html script order is the
     orchestrator's; this file never touches index.html or styles.css).
   • Touches ONLY window.Atelier + window.AtelierApps.browserInfo (guarded).

   Known contract-level edge: the bus event carries no source, so ANY
   selection:changed that lands on exactly a browser+agent pair toggles —
   e.g. closing a third selected card while a linked pair stays selected
   unlinks it. Distinguishing marquee finalizes from other emissions needs
   a source tag on core.js's event (not this module's file to change).

   ponytail: links are page-session-scoped, NOT persisted — a board switch
   recreates cards (removeAllCards -> card:removed) and links die with their
   cards; the user re-boxes the pair on the new board. Persisting would need
   stable card identities across restores, which no card type guarantees.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect "[link] ready".
   2. Spawn a browser card (dock Browser) and an agent card (⌘K → agent),
      navigate the browser somewhere real.
   3. SHIFT-drag a marquee around BOTH cards (and nothing else) — on mouseup
      a terracotta arrow appears browser -> agent, toast 'Browser linked to
      Agent 1 — its current page now rides along with every message', and
      the selection clears. Atelier.links.count() → 1.
   4. Atelier.links.browserFor(agentCardEl) → {url, title} of the ACTIVE tab;
      switch tabs in the browser card and call again — it tracks live.
   5. Send a message from the agent card — sessions.js prefixes the POSTed
      text with the linked page context (its MANUAL TEST covers the rest).
   6. Marquee the same pair again — the arrow disappears, toast 'Browser
      unlinked from Agent 1', count() → 0.
   7. Link again, then marquee the agent with a SECOND browser card — the old
      arrow is replaced by the new one, count() stays 1.
   8. Close either linked card via its × — the arrow goes away and count()
      → 0. Same on board switch (links are session-scoped by design).
   9. A marquee catching 3+ cards, two agents, or two browsers does nothing.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.selection || !A.ui) {
    console.warn('[link] Atelier core not available — skipping.');
    return;
  }

  // ── card classification (both read lazily, at event time) ─────────────────
  function browserInfo(el) {
    const api = window.AtelierApps;
    if (!api || typeof api.browserInfo !== 'function') return null;
    try { return api.browserInfo(el); } catch { return null; }
  }
  function isAgent(el) {
    return !!(el && el.classList && el.classList.contains('atl-agent-card'));
  }
  function titleOf(el) {
    const t = el.querySelector('.card-title');
    const s = t && t.textContent ? t.textContent.trim() : '';
    return s || 'agent';
  }

  // ── link registry: agentEl -> { browserEl, unlink } ───────────────────────
  // One browser per agent (relinking replaces); a browser MAY back several
  // agents — nothing in the ride-along contract needs it exclusive.
  const links = new Map();

  function dropLink(agentEl) {
    const entry = links.get(agentEl);
    if (!entry) return false;
    try { entry.unlink(); } catch { /* arrows unlink is idempotent; belt and braces */ }
    links.delete(agentEl);
    return true;
  }

  // ── link registration (shared by the marquee gesture + the public API) ─────
  // Registers browserEl as agentEl's linked browser: replaces any prior link
  // for that agent (an agent holds at most one — relink drops the old arrow
  // first), draws the browser->agent arrow, and stores the unlink handle.
  // Returns true once the pair is linked; a same-pair call is a no-op that
  // still returns true (already linked). NO toast / selection side effects —
  // the marquee handler and sessions.js each own their own user feedback.
  function setLink(agentEl, browserEl) {
    if (!agentEl || !browserEl || agentEl === browserEl) return false;
    const existing = links.get(agentEl);
    if (existing && existing.browserEl === browserEl) return true; // already linked
    if (existing) dropLink(agentEl);
    const arrows = A.arrows;
    const unlink = (arrows && typeof arrows.link === 'function')
      ? arrows.link(browserEl, agentEl, { kind: 'browser' }) // not a 'parent' arrow:
      : function () {}; // govern must not wipe it. arrows.js absent -> link still works
    links.set(agentEl, { browserEl, unlink });
    return true;
  }

  // ── the gesture: marquee finalize -> toggle ────────────────────────────────
  A.bus.on('selection:changed', () => {
    const sel = A.selection.get();
    if (sel.length !== 2) return;
    const [a, b] = sel;
    let agentEl = null, browserEl = null;
    if (isAgent(a) && !isAgent(b) && browserInfo(b) !== null) { agentEl = a; browserEl = b; }
    else if (isAgent(b) && !isAgent(a) && browserInfo(a) !== null) { agentEl = b; browserEl = a; }
    else return; // not exactly one agent + one browser — not our gesture

    const existing = links.get(agentEl);
    if (existing && existing.browserEl === browserEl) {
      // toggle OFF: the exact pair is already linked. Clear the selection
      // here too (mirroring the link branch): core.js re-emits
      // selection:changed from non-marquee paths as well (Escape mid-drag
      // restores preSel; an empty shift-marquee mouseup re-emits), and a
      // still-selected pair would silently RELINK on the next such event.
      dropLink(agentEl);
      A.ui.toast('Browser unlinked from ' + titleOf(agentEl));
      A.selection.clear();
      return;
    }

    // toggle ON (an agent holds at most one browser: replace, old arrow first)
    setLink(agentEl, browserEl);
    A.ui.toast('Browser linked to ' + titleOf(agentEl) +
      ' — its current page now rides along with every message');
    A.selection.clear(); // re-emits selection:changed with 0 selected — a no-op here
  });

  // ── teardown: either side removed -> the pair dies ─────────────────────────
  // arrows.js already removes its path on card:removed; dropLink still calls
  // the stored unlink defensively (idempotent) so the Map never outlives a card.
  A.bus.on('card:removed', (data) => {
    const el = data && data.el;
    if (!el) return;
    links.forEach((entry, agentEl) => {
      if (agentEl === el || entry.browserEl === el) dropLink(agentEl);
    });
  });

  // ── publish the API ────────────────────────────────────────────────────────
  A.links = {
    // LIVE read at call time — never a cached snapshot: the active tab (and
    // its url/title) may have changed since the pair was boxed.
    browserFor(agentEl) {
      const entry = links.get(agentEl);
      if (!entry) return null;
      return browserInfo(entry.browserEl);
    },
    // round 16: the linked browser card ELEMENT (or null) — the same Map
    // read browserFor starts from, without the active-tab resolution.
    // sessions.js passes it to AtelierApps.browserNavigate when the agent's
    // NavigateBrowser tool requests a page load in the user-linked browser.
    browserElFor(agentEl) {
      const entry = links.get(agentEl);
      return entry ? entry.browserEl : null;
    },
    // round 22: programmatic link — the marquee gesture's toggle-ON path
    // without the gesture. sessions.js calls it after the OpenBrowser tool
    // spawns a browser card, so the auto-created browser registers in the
    // SAME Map that browserElFor/browserFor read — subsequent NavigateBrowser
    // then drives it exactly as a user-linked one. Draws the arrow, replaces
    // any prior link for the agent, returns true once linked (false only on
    // bad args). No toast (the caller sets its own note).
    link(agentEl, browserEl) { return setLink(agentEl, browserEl); },
    unlink(agentEl) { return dropLink(agentEl); },
    count() { return links.size; },
  };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const api = window.Atelier.links;
    const ok = api &&
      typeof api.browserFor === 'function' &&
      typeof api.browserElFor === 'function' &&
      typeof api.link === 'function' &&
      typeof api.unlink === 'function' &&
      typeof api.count === 'function' &&
      api.count() === 0 &&
      api.browserFor(document.body) === null &&
      api.browserElFor(document.body) === null;
    console.assert(ok, '[link] API surface incomplete:', api);
    if (ok) console.log('[link] ready');
  })();
})();
