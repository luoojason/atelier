'use strict';

/* Atelier feature module — SVG arrows layer
   =============================================================================
   Draws living connector arrows between canvas cards. Built ONLY against
   window.Atelier (core.js) + standard DOM; sessions.js uses this (guarded) to
   link a spawned sub-agent card back to its parent card.

   How it works
   ------------
   • ONE <svg class="atl-arrow-layer"> is appended to #content (1x1, overflow
     visible, pointer-events none, z-index 5 — cards start at z-index 10+, so
     arrows always render UNDER cards). Because #content carries the world
     transform (translate + scale), every path is drawn in WORLD coordinates
     and pan/zoom follow for free — no viewport math in this module at all.
   • Each link is a cubic bezier between the NEAREST edge midpoints of the two
     cards' world rects (left/top from inline style, w/h from offsetWidth/
     offsetHeight — the same rect convention core.js uses everywhere). The
     nearest sides are recomputed on every refresh, so an arrow flips to a
     sensible edge when cards move around each other.
   • Stroke var(--accent), width 2, opacity .55, dasharray 6 6 with a slow
     dash-offset animation (CSS injected below) — a subtle flowing feel; an
     arrowhead marker in <defs> (added once) caps the destination end.
   • Redraw triggers: a MutationObserver per linked element (style attribute
     only — drags/resizes/setRect all write inline style); bus 'card:removed'
     auto-unlinks any link touching the removed card; bus 'cards:rearranged'
     runs a requestAnimationFrame follow loop for ~500ms so arrows glide with
     the tidy animation (.tidying is a .35s CSS transition, which mutates NO
     attributes mid-flight — the observers only see the start value).

   API (published as window.Atelier.arrows)
   ----------------------------------------
     link(fromEl, toEl) -> unlink()   register + draw; returns its remover
     refresh()                        redraw every live link now
     count()                          number of live links
     unlinkTouching(el)               unlink every live link with from===el
                                       or to===el (e.g. a sweep-drawn arrow
                                       govern.js has no handle for)

   Boundaries (per the module contract)
   ------------------------------------
   • Loads AFTER core.js and BEFORE sessions.js (index.html script order is
     the orchestrator's; this file never touches index.html or styles.css).
   • Touches ONLY window.Atelier + standard DOM; all CSS is injected here.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser).
   2. Open DevTools console — expect "[arrows] ready".
   3. Spawn a second card (dock Apps button, or Atelier.spawnApp('note')),
      then in the console:
        const cs = document.querySelectorAll('#content .card');
        const un = Atelier.arrows.link(cs[0], cs[1]);
      A terracotta dashed curve with an arrowhead appears between the two
      cards' nearest edges, dashes slowly flowing, drawn UNDER both cards.
   4. Drag either card by its bar — the arrow follows live, and when one card
      is dragged around to the other side, the arrow re-anchors to the now-
      nearest edges. Resize from the corner handle — same.
   5. Pan the canvas and wheel-zoom — the arrow tracks exactly (world coords
      inside the transformed #content).
   6. Zoombar ✦ (Auto-arrange) — the arrow glides along with the animating
      cards for the whole ~350ms transition instead of snapping at the end.
   7. Atelier.arrows.count() → 1. Close one linked card via its × — the arrow
      disappears and count() → 0 (bus 'card:removed' auto-unlink).
   8. Re-link the two cards, then call un() — the arrow is removed, count()
      is back to 0, and dragging no longer redraws anything.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.canvas || !A.bus) {
    console.warn('[arrows] Atelier core not available — skipping.');
    return;
  }
  const content = document.getElementById('content');
  if (!content) {
    console.warn('[arrows] #content not found — skipping.');
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── injected styles (layer geometry + the dash-flow animation) ────────────
  (function injectStyles() {
    if (document.getElementById('atl-arrows-styles')) return;
    const style = document.createElement('style');
    style.id = 'atl-arrows-styles';
    style.textContent = `
      .atl-arrow-layer { position: absolute; left: 0; top: 0;
        width: 1px; height: 1px; overflow: visible;
        pointer-events: none; z-index: 5; }
      .atl-arrow-layer .atl-arrow { stroke: var(--accent); stroke-width: 2.5;
        fill: none; opacity: .82; stroke-dasharray: 7 5; stroke-linecap: round;
        filter: drop-shadow(0 1px 2px rgba(179, 74, 38, .35));
        animation: atl-arrow-flow 1.4s linear infinite; }
      @keyframes atl-arrow-flow { to { stroke-dashoffset: -12; } }
      /* group hull: a soft rounded box around each connected cluster of cards
         (an orchestrator + its sub-agents + linked tools). Rendered behind the
         arrows (inserted before the paths), tinted with the accent. */
      .atl-arrow-layer .atl-group-hull {
        fill: color-mix(in srgb, var(--accent) 5%, transparent);
        stroke: color-mix(in srgb, var(--accent) 38%, transparent);
        stroke-width: 1.5; pointer-events: none; }
    `;
    document.head.appendChild(style);
  })();

  // ── the one layer + the one arrowhead marker ──────────────────────────────
  const layer = document.createElementNS(SVG_NS, 'svg');
  layer.setAttribute('class', 'atl-arrow-layer');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'atl-arrow-head');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');    // tip sits ~at the path end, tail under it
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto');
  const head = document.createElementNS(SVG_NS, 'path');
  head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  head.style.fill = 'var(--accent)';
  marker.appendChild(head);
  defs.appendChild(marker);
  layer.appendChild(defs);
  content.appendChild(layer);

  // ── geometry ──────────────────────────────────────────────────────────────
  // World rect by core.js convention: inline left/top + offset size. During
  // the tidy follow window (live=true) read COMPUTED left/top instead — the
  // .tidying transition animates the rendered position while the style
  // attribute already sits at the target, and computed style is the only
  // place the in-flight value exists. Outside a transition the two agree.
  function worldRect(el, live) {
    const src = live ? getComputedStyle(el) : el.style;
    return {
      x: parseFloat(src.left) || 0,
      y: parseFloat(src.top) || 0,
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  }

  // Edge midpoints + outward normals (normals aim the bezier control points).
  function edgePoints(r) {
    return [
      { x: r.x + r.w / 2, y: r.y,           nx: 0,  ny: -1 }, // top
      { x: r.x + r.w,     y: r.y + r.h / 2, nx: 1,  ny: 0  }, // right
      { x: r.x + r.w / 2, y: r.y + r.h,     nx: 0,  ny: 1  }, // bottom
      { x: r.x,           y: r.y + r.h / 2, nx: -1, ny: 0  }, // left
    ];
  }

  // Nearest pair among the 4x4 midpoint combos — recomputed every refresh so
  // the arrow re-anchors when cards move around each other.
  function nearestPair(ra, rb) {
    const as = edgePoints(ra), bs = edgePoints(rb);
    let best = null, bestD = Infinity;
    for (const p of as) {
      for (const q of bs) {
        const dx = q.x - p.x, dy = q.y - p.y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = [p, q]; }
      }
    }
    return best;
  }

  function drawLink(link, live) {
    const [p, q] = nearestPair(worldRect(link.from, live), worldRect(link.to, live));
    // Control points push outward along each edge's normal; bend scales with
    // distance but is clamped so short hops stay gentle and long ones sane.
    const bend = Math.min(140, Math.max(24, Math.hypot(q.x - p.x, q.y - p.y) * 0.35));
    link.path.setAttribute('d',
      `M ${p.x} ${p.y} C ${p.x + p.nx * bend} ${p.y + p.ny * bend}, ` +
      `${q.x + q.nx * bend} ${q.y + q.ny * bend}, ${q.x} ${q.y}`);
  }

  // ── group hulls: a rounded box around each connected cluster ───────────────
  // Cards joined (transitively) by arrows form a "connected setup" — an
  // orchestrator + its sub-agents + linked tools/browsers/loops. A soft rounded
  // rect is drawn around each such cluster (>=2 cards), recomputed every refresh
  // so it follows drags/pan/zoom for free (world coords in #content).
  const hullRects = []; // pooled <rect>, reused across frames (hidden when spare)
  const HULL_PAD = 18;

  function ensureHulls(n) {
    while (hullRects.length < n) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'atl-group-hull');
      rect.setAttribute('rx', '20'); rect.setAttribute('ry', '20');
      layer.insertBefore(rect, layer.firstChild); // behind the arrow paths
      hullRects.push(rect);
    }
  }

  // connected components of the arrow graph, via union-find over linked els.
  function components() {
    const parent = new Map();
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
      return r;
    };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
    links.forEach((l) => { add(l.from); add(l.to); parent.set(find(l.from), find(l.to)); });
    const groups = new Map();
    parent.forEach((_, el) => {
      const root = find(el);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(el);
    });
    return Array.from(groups.values()).filter((g) => g.length >= 2);
  }

  function drawHulls(live) {
    const comps = components();
    ensureHulls(comps.length);
    hullRects.forEach((rect, i) => {
      if (i >= comps.length) { rect.style.display = 'none'; return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      comps[i].forEach((el) => {
        if (!el || !el.isConnected) return;
        const r = worldRect(el, live);
        if (minX > r.x) minX = r.x;
        if (minY > r.y) minY = r.y;
        if (maxX < r.x + r.w) maxX = r.x + r.w;
        if (maxY < r.y + r.h) maxY = r.y + r.h;
      });
      if (!isFinite(minX)) { rect.style.display = 'none'; return; }
      rect.style.display = '';
      rect.setAttribute('x', String(minX - HULL_PAD));
      rect.setAttribute('y', String(minY - HULL_PAD));
      rect.setAttribute('width', String(maxX - minX + HULL_PAD * 2));
      rect.setAttribute('height', String(maxY - minY + HULL_PAD * 2));
    });
  }

  // ── link registry + redraw scheduling ─────────────────────────────────────
  const links = new Set(); // { from, to, path, observers[], unlink }

  let rafId = 0;
  function scheduleRefresh() { // collapse a burst of style mutations to one frame
    if (rafId) return;
    // While the tidy follow loop is active, observer-triggered redraws must
    // also read live positions, or they repaint at the transition target for
    // a frame and the arrow stutters.
    rafId = requestAnimationFrame(() => { rafId = 0; refresh(following); });
  }

  function refresh(live) {
    links.forEach((link) => {
      // Safety net: card:removed covers every core.js removal path (close ×,
      // Delete key, handle.remove()), but a card yanked from the DOM some
      // other way must not leave a stale arrow floating forever.
      if (!link.from.isConnected || !link.to.isConnected) { link.unlink(); return; }
      drawLink(link, live);
    });
    drawHulls(live); // group boxes recompute every frame -> follow drags/pan/zoom
  }

  // link(fromEl, toEl, opts) — opts.kind (optional) tags the arrow so a
  // caller can later clear ONLY arrows of one kind. Kinds in use: 'parent'
  // (orchestrator/sweep -> sub-agent), 'browser' (a marquee/OpenBrowser
  // ride-along), 'content' (agent -> a note/document it created). govern.js
  // clears only 'parent' arrows into a re-parented child, so governing an
  // agent no longer wipes its linked browser (direction alone can't tell them
  // apart — a browser ride-along is also incoming to the agent).
  function link(fromEl, toEl, opts) {
    if (!fromEl || !toEl || fromEl === toEl) {
      console.warn('[arrows] link() needs two distinct elements.');
      return function unlink() {};
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'atl-arrow');
    path.setAttribute('marker-end', 'url(#atl-arrow-head)');
    layer.appendChild(path);

    // One observer per linked element, per pair — so unlinking this pair
    // never silences another link that shares one of the same cards.
    const observers = [fromEl, toEl].map((el) => {
      const obs = new MutationObserver(scheduleRefresh);
      obs.observe(el, { attributes: true, attributeFilter: ['style'] });
      return obs;
    });

    const entry = { from: fromEl, to: toEl, path, observers, unlink,
      kind: (opts && opts.kind) || null };
    function unlink() {
      if (!links.delete(entry)) return; // idempotent
      observers.forEach((o) => o.disconnect());
      path.remove();
      scheduleRefresh(); // recompute group hulls without this link
    }
    links.add(entry);
    drawLink(entry);
    scheduleRefresh(); // recompute group hulls with this new link
    return unlink;
  }

  function count() { return links.size; }

  // Unlink every live link touching el, regardless of who drew it — the
  // escape hatch for callers (govern.js) that need to clear an arrow they
  // hold no unlink() handle for (e.g. sessions.js's sweep auto-reveal draws
  // straight into this module's own registry). Snapshot first: unlink()
  // mutates `links` mid-iteration otherwise.
  // dir (optional): 'to' unlinks only arrows POINTING AT el (to === el); 'from'
  // only arrows LEAVING el; omitted = either endpoint (the original behavior).
  // kind (optional): when set, only arrows tagged that kind are unlinked.
  // Together they let govern.js clear a child's INCOMING 'parent' arrow when it
  // is re-parented WITHOUT wiping the child's OWN outgoing arrows to its
  // sub-agents (a chain A3->A1->A2 keeps A1->A2 when A3 governs A1) AND without
  // wiping a browser ride-along that is also incoming to the same agent.
  function unlinkTouching(el, dir, kind) {
    if (!el) return;
    Array.from(links).forEach((entry) => {
      if (kind && entry.kind !== kind) return;
      const match = dir === 'to' ? entry.to === el
        : dir === 'from' ? entry.from === el
        : (entry.from === el || entry.to === el);
      if (match) entry.unlink();
    });
  }

  // ── bus wiring ────────────────────────────────────────────────────────────
  A.bus.on('card:removed', ({ el }) => {
    links.forEach((l) => { if (l.from === el || l.to === el) l.unlink(); });
  });

  // Tidy animates left/top via a CSS transition (.tidying, .35s) — the style
  // ATTRIBUTE jumps straight to the target, so the observers alone would snap
  // arrows ahead of the gliding cards. Follow with a short rAF loop reading
  // the LIVE computed position each frame instead.
  let followUntil = 0, following = false;
  function follow() {
    refresh(true);
    if (performance.now() < followUntil) requestAnimationFrame(follow);
    else following = false;
  }
  A.bus.on('cards:rearranged', () => {
    followUntil = performance.now() + 520; // .35s transition + settle margin
    if (!following) { following = true; requestAnimationFrame(follow); }
  });

  // ── publish + self-check ──────────────────────────────────────────────────
  A.arrows = { link, refresh, count, unlinkTouching };

  (function selfCheck() {
    const api = window.Atelier.arrows;
    const ok = api &&
      typeof api.link === 'function' &&
      typeof api.refresh === 'function' &&
      typeof api.count === 'function' &&
      typeof api.unlinkTouching === 'function';
    console.assert(ok, '[arrows] API surface incomplete:', api);
    if (ok) console.log('[arrows] ready');
  })();
})();
