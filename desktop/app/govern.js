'use strict';

/* ===========================================================================
   Atelier feature module — govern select-mode   (app/govern.js)

   A per-chat "govern mode": while a session card's composer target-cursor is
   armed (chatcontrols.js, Part C), clicking another agent card toggles it as a
   GOVERNED subagent of that chat. Governing POSTs the backend govern link
   (child.parent_id = parent, child.depth = parent.depth+1), draws a persistent
   orchestrator -> subagent arrow via A.arrows.link, and records the pair;
   ungoverning DELETEs the link and removes the arrow. Real delegation over the
   link is Part E; this module owns only the link's frontend lifecycle.

   How it works
   ------------
   • Element -> backend session id is read from cardEl.dataset.atlSession, a
     stamp chatcontrols.mount() writes on every session composer it mounts.
     A card with no stamp (the main chat, or a card whose composer never
     mounted) is not a valid govern endpoint — govern() toasts and bails.
   • Single-parent invariant: a child has exactly one orchestrator. The backend
     POST reassigns parent_id on re-govern; this module MOVES the child locally
     (detachChild drops the old arrow first) so the canvas matches. No stray
     DELETE on a move — the POST already reassigned the link.
   • Registry: parentEl -> Map(childEl -> { unlink }). count() sums every map.
     Every mutation emits bus 'govern:changed' {parentEl} so the composer
     (chatcontrols) repaints that chat's chip strip from childrenOf().
   • Teardown (mirrors link.js:159): bus 'card:removed' drops every link the
     removed card touches. A removed PARENT ungoverns its children (best-effort
     DELETE so each child persists UNGOVERNED per the spec) and drops arrows.
     A removed CHILD only drops its arrow here — sessions.js DELETEs the child's
     whole backend session on the same event, which clears its parent_id
     server-side, so a govern DELETE would 404 a gone session.
   • No CSS: the arrow (arrows.js) and the toast (core.js) are the whole visual
     surface owned here; the button/chip/highlight chrome lives in chatcontrols.
   • sessions.js's own GET /sessions sweep (auto-reveal of children by
     parent_id) draws its own arrow directly via A.arrows.link and never
     hands this module the unlink() it gets back — that arrow lives ONLY in
     arrows.js's internal registry, invisible to childrenOf/detachChild here.
     This used to leave a stale duplicate arrow when a still-sweep-owned
     child got (re-)governed to a parent. Fixed via arrows.js's
     unlinkTouching(el) (unlink-by-element, no handle required): detachChild
     and unlink() both call it (guarded) so any arrow into childEl this
     registry never tracked — sweep-drawn or otherwise — is cleared whenever
     the child's governance changes.

   API (published as window.Atelier.govern)
   ----------------------------------------
     childrenOf(parentEl) -> Element[]              governed child card elements
     govern(parentEl, childEl) -> Promise<boolean>  POST + draw arrow; false on fail
     unlink(parentEl, childEl) -> boolean           DELETE + remove arrow
     count() -> number                              live governed links

   Boundaries (per the module contract)
   ------------------------------------
   • Loads AFTER arrows.js and sessions.js (index.html order is the
     orchestrator's; this file never touches index.html or styles.css).
   • Touches ONLY window.Atelier (+ guarded window.atelier.token) and fetch.

   ponytail: like link.js, the chip strip is page-session UI and this registry
   is NOT rehydrated from GET /sessions on reload. Governance itself survives
   reload on the backend (parent_id) and the sessions.js sweep redraws the
   arrow; only the composer chips repopulate solely for links made this session.
   Rehydrating chips from the backend on mount is the upgrade.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect "[govern] ready".
   2. Spawn two chats (dock 💬 twice) — Chat A and Chat B. Confirm each card's
      composer shows the ◎ govern button (chatcontrols, Task C2).
   3. In A's composer click ◎ — A's composer button goes active, every agent
      card outlines dashed (A itself solid). Click B once: POST
      /sessions/{A}/govern {child_id:B}, a terracotta arrow A -> B appears,
      toast 'Now governing Agent 2', and a "Agent 2" chip lands in A's chip
      strip. Atelier.govern.count() -> 1; Atelier.govern.childrenOf(A_cardEl)
      returns [B_cardEl].
   4. Click B again while still in govern mode (or click the chip ✕): DELETE
      /sessions/{A}/govern/{B}, the arrow and chip vanish, count() -> 0.
   5. Re-govern B from A, then arm a THIRD chat C and click B: B moves — the
      A -> B arrow is removed, a C -> B arrow is drawn, and B's chip leaves A's
      strip and appears in C's (single-parent invariant). count() stays 1.
   6. Cycle guard: arm B, click A (A already governs... use a chain). Backend
      400 'would create a cycle' surfaces a toast 'Could not govern: would
      create a cycle' and NO arrow/chip is added.
   7. Cap/depth: govern a 5th child of one parent -> toast 'Could not govern:
      child limit reached'; a 4th-deep chain -> 'Could not govern: max depth
      reached'. No arrow/chip on either.
   8. Close A's card via × -> B stays on canvas (persists, ungoverned), the
      A -> B arrow disappears, and a DELETE ungoverns B on the backend. Close a
      governed B directly -> its arrow leaves and count() drops (sessions.js
      DELETEs B's session, clearing parent_id).
   9. Backend down: click a target in govern mode -> toast 'Could not govern:
      backend unreachable' and no local link is kept. Without app/arrows.js
      loaded everything still works (link/unlink are guarded), just no arrow.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui) {
    console.warn('[govern] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';

  // token-gated JSON fetch — never throws on HTTP errors, only on network
  // (same convention as sessions.js apiJson; the shared secret is present only
  // when main.js launched the backend via preload).
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const init = Object.assign({ headers }, opts || {});
    let res;
    try { res = await fetch(BASE + path, init); }
    catch { return { ok: false, status: 0, data: null }; }
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // element -> backend session id, via the dataset stamp chatcontrols writes.
  function sidOf(el) {
    return (el && el.dataset && el.dataset.atlSession) || null;
  }
  function titleOf(el) {
    const t = el && el.querySelector && el.querySelector('.card-title');
    const s = t && t.textContent ? t.textContent.trim() : '';
    return s || 'agent';
  }

  // registry: parentEl -> Map(childEl -> { unlink })
  const govs = new Map();

  function dropOne(parentEl, childEl) {
    const m = govs.get(parentEl);
    if (!m) return false;
    const entry = m.get(childEl);
    if (!entry) return false;
    try { entry.unlink(); } catch { /* arrows unlink is idempotent */ }
    m.delete(childEl);
    if (m.size === 0) govs.delete(parentEl);
    return true;
  }

  // single-parent invariant: strip childEl from whatever parent governs it now
  // (local only — the caller's backend POST already reassigned parent_id).
  function detachChild(childEl) {
    let old = null;
    govs.forEach((m, parentEl) => { if (m.has(childEl)) old = parentEl; });
    if (old) { dropOne(old, childEl); A.bus.emit('govern:changed', { parentEl: old }); }
    // Unconditional (not gated on `old`): a still-sweep-owned child has NO
    // entry in `govs` yet may already have a sweep-drawn arrow into it —
    // clear any arrow this registry never tracked so a fresh govern() below
    // never draws a stale duplicate. Directional 'to': clear only arrows
    // POINTING AT childEl (its incoming parent arrow), NEVER the child's OWN
    // outgoing arrows to its sub-agents — else re-parenting the middle of a
    // chain (A3 governs A1 while A1 governs A2) would wipe the A1->A2 arrow.
    if (A.arrows && typeof A.arrows.unlinkTouching === 'function') A.arrows.unlinkTouching(childEl, 'to', 'parent');
    return old;
  }

  async function govern(parentEl, childEl) {
    const pid = sidOf(parentEl), cid = sidOf(childEl);
    if (!pid || !cid) { A.ui.toast("Can't link these chats yet. One hasn't started."); return false; }
    if (parentEl === childEl || pid === cid) { A.ui.toast("A chat can't be put in charge of itself."); return false; }
    const r = await apiJson('/sessions/' + pid + '/govern', {
      method: 'POST',
      body: JSON.stringify({ child_id: cid }),
    });
    if (!r.ok) {
      const msg = (r.data && r.data.error) ? r.data.error : 'backend unreachable';
      A.ui.toast("Couldn't link the chats: " + msg);
      return false;
    }
    // move: drop the old parent's arrow first — detachChild also clears any
    // arrow into childEl this registry never tracked (e.g. a still-sweep-
    // owned child), so the arrows.link() below never draws a duplicate.
    detachChild(childEl);
    const arrows = A.arrows;
    const unlink = (arrows && typeof arrows.link === 'function')
      ? arrows.link(parentEl, childEl, { kind: 'parent' })  // orchestrator -> subagent
      : function () {};                  // arrows.js absent (plain-browser test)
    let m = govs.get(parentEl);
    if (!m) { m = new Map(); govs.set(parentEl, m); }
    m.set(childEl, { unlink });
    A.ui.toast('Now directing ' + titleOf(childEl));
    A.bus.emit('govern:changed', { parentEl });
    return true;
  }

  function unlink(parentEl, childEl) {
    const pid = sidOf(parentEl), cid = sidOf(childEl);
    const removed = dropOne(parentEl, childEl);
    if (removed) {
      // guard against an orphan arrow into childEl this registry never
      // tracked (e.g. a sweep-drawn arrow) so ungoverning leaves no stale
      // line behind. Gated on `removed` so an unlink() called for a pair
      // that isn't actually governed can't wipe a DIFFERENT parent's arrow.
      // Directional 'to': clear only the child's INCOMING arrow, never its
      // own outgoing arrows to its sub-agents.
      if (A.arrows && typeof A.arrows.unlinkTouching === 'function') A.arrows.unlinkTouching(childEl, 'to', 'parent');
    }
    if (removed && pid && cid) {
      apiJson('/sessions/' + pid + '/govern/' + cid, { method: 'DELETE' }).catch(() => {});
      A.bus.emit('govern:changed', { parentEl });
    }
    return removed;
  }

  function childrenOf(parentEl) {
    const m = govs.get(parentEl);
    return m ? Array.from(m.keys()) : [];
  }

  function count() {
    let n = 0;
    govs.forEach((m) => { n += m.size; });
    return n;
  }

  // teardown: a removed card drops every link it touches (mirrors link.js:159).
  A.bus.on('card:removed', (data) => {
    const el = data && data.el;
    if (!el) return;
    // removed as a PARENT: ungovern its children so they persist ungoverned
    if (govs.has(el)) {
      const pid = sidOf(el);
      const m = govs.get(el);
      Array.from(m.keys()).forEach((childEl) => {
        const cid = sidOf(childEl);
        if (pid && cid) apiJson('/sessions/' + pid + '/govern/' + cid, { method: 'DELETE' }).catch(() => {});
        dropOne(el, childEl);
      });
      A.bus.emit('govern:changed', { parentEl: el });
    }
    // removed as a CHILD: drop its arrow (sessions.js DELETEs the child session)
    govs.forEach((m, parentEl) => {
      if (m.has(el)) { dropOne(parentEl, el); A.bus.emit('govern:changed', { parentEl }); }
    });
  });

  // ── publish the API ────────────────────────────────────────────────────────
  A.govern = { childrenOf, govern, unlink, count };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const api = window.Atelier.govern;
    const ok = api &&
      typeof api.childrenOf === 'function' &&
      typeof api.govern === 'function' &&
      typeof api.unlink === 'function' &&
      typeof api.count === 'function' &&
      api.count() === 0 &&
      Array.isArray(api.childrenOf(document.body)) &&
      api.childrenOf(document.body).length === 0 &&
      api.unlink(document.body, document.body) === false;
    console.assert(ok, '[govern] API surface incomplete:', api);
    if (ok) console.log('[govern] ready');
  })();
})();
