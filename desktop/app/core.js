'use strict';

/* ===========================================================================
   Atelier core — desktop/app/core.js

   Owns the canvas (pan / wheel-zoom), floating cards (drag / resize / raise),
   marquee multi-select, tidy/auto-arrange, the live minimap, the dock, the
   chat card, and the backend status. Builds and exposes `window.Atelier`,
   the single API every feature module builds against.

   Feature modules (app/widgets.js, app/apps.js, app/palette.js,
   app/customization.js) load AFTER this file and must only touch
   `window.Atelier` — never the DOM shell, styles.css, or each other.

   The look and feel (warm cream canvas, dotted grid, terracotta accent) lives
   in index.html + styles.css and is intentionally untouched here — this file
   only moves behavior, it does not restyle.

   ── MANUAL TEST ──────────────────────────────────────────────────────────
   1. `npm start` in desktop/ (or open index.html in a browser).
   2. Open DevTools console — expect: "[Atelier] core ready — API surface
      verified." and NO console.assert failures.
   3. Drag the metrics card and the chat card by their title bars; drag the
      little handle at each card's bottom-right corner to resize. Both must
      move/resize (proving they now route through Atelier.canvas.addCard).
   4. Drag empty canvas to pan; wheel to zoom (zoom % updates bottom-right).
   5. Double-click empty canvas — a toast "world (x, y)" appears (registered
      by the smoke hook below), proving onDoubleClick + screenToWorld.
   6. Click dock buttons (Apps / Browser / Campaign / Notes / History) — an
      app card spawns near center and is itself draggable/resizable.
   7. In the console run:
        Atelier.ui.toast('hi'); Atelier.ui.openPanel('Test', Object.assign(
          document.createElement('div'), { textContent: 'panel body' }));
      A toast and a draggable floating panel appear.
   8. Click the zoombar ⤢ (Fit) button — the view frames every card with a
      ~60px margin (zoom clamped to 20–200%); with zero cards it resets to
      pan (0,0) at 100%. Same via Atelier.canvas.fitToView(). In the console,
      Atelier.canvas.setViewport({panX: 40, panY: 40, zoom: 1.2}) repaints.
   9. Press Cmd/Ctrl+M on empty canvas — a Note card spawns (fallback; a
      module listening on bus 'shortcut:add-app' claims the key instead).
      Press Escape while a floating panel is open — the topmost panel
      closes; with none open, bus 'shortcut:escape' fires. Cmd/Ctrl+M is
      ignored while typing in an input/textarea; Escape always works.
  10. SHIFT-drag on empty canvas draws a selection marquee (plain drag still
      pans); after a 4px threshold the box appears and cards whose world
      rect intersects it get class 'selected' (accent outline). Shift-drag
      across already-selected cards XORs them against the pre-drag
      selection. Bus 'selection:changed' {count} fires. Escape clears the
      selection BEFORE panel-closing (mid-drag it cancels the marquee and
      restores the pre-drag selection). Dragging ANY selected card's bar
      moves the whole selection together. Delete/Backspace (not while
      typing) removes every selected card — each fires card:removed. The
      builtin metrics/chat cards are permanent: no × in their bars and
      Delete skips them (the in-place board switch dropped reload, so a
      closed builtin would stay dead on every board until app restart).
  11. Zoombar ✦ (Auto-arrange) or Atelier.canvas.tidy() — cards sort by
      (y, x) and flow left→right into viewport-wide rows with 24px gutters,
      animating (CSS transition via .tidying) into place, then fitToView().
  12. Zoombar ▣ (Minimap) toggles the minimap; the static .mm-card divs are
      replaced at boot by a live SVG (cards = soft accent rects, viewport =
      stroked rect), redrawn throttled ~250ms on card add/remove/drag-end
      and pan/zoom. Click or drag on it pans so that world point centers.
      On/off persists in Atelier.store key 'minimap' (default ON).
  13. In the console spawn a card (Atelier.spawnApp('note')), select it, then
      run Atelier.canvas.removeAllCards() — the spawned card disappears with
      a 'card:removed' bus event, the built-in metrics + chat cards (stamped
      data-atl-builtin at boot) stay, and the selection is cleared. Boards
      use this for in-place board switches.
   =========================================================================== */

(function () {
  // ── shell elements ────────────────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  const content = document.getElementById('content');
  const dotEl = document.getElementById('status-dot');
  const statusTextEl = document.getElementById('status-text');
  const zoomLabel = document.getElementById('zoom-level');

  // ── viewport state (pan + zoom) ───────────────────────────────────────────
  let panX = 0, panY = 0, zoom = 1;
  const MIN_Z = 0.2, MAX_Z = 2;

  function applyTransform() {
    content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    // The dotted grid is a CSS background on the (static) .canvas, so it must be
    // panned/zoomed by hand to track #content's transform — otherwise the dots
    // sit still while the cards move. background-position follows the pan and
    // background-size scales the 22px world spacing by zoom, so the dots stay
    // locked to world coordinates.
    canvas.style.backgroundPosition = `${panX}px ${panY}px`;
    canvas.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    scheduleMinimap(); // hoisted; throttled ~250ms, so per-mousemove calls are cheap
  }
  function zoomAt(nz, cx, cy) {              // keep screen point (cx,cy) fixed
    nz = Math.min(MAX_Z, Math.max(MIN_Z, nz));
    panX = cx - (cx - panX) * (nz / zoom);
    panY = cy - (cy - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }
  function zoomCenter(nz) {
    const r = canvas.getBoundingClientRect();
    zoomAt(nz, r.width / 2, r.height / 2);
  }

  document.getElementById('zoom-in').onclick = () => zoomCenter(zoom * 1.15);
  document.getElementById('zoom-out').onclick = () => zoomCenter(zoom / 1.15);

  // Wheel zooms the board — UNLESS the pointer is over a scrollable region
  // inside a card (a chat transcript, a note, a list, a textarea, …), in which
  // case that region scrolls and the board does not zoom. Walk from the wheel
  // target up to the card and bail if any ancestor can actually scroll.
  function overScrollableCard(el) {
    if (!el || !el.closest || !el.closest('.card')) return false;
    let n = el;
    while (n && n !== canvas && n.nodeType === 1) {
      if (n.tagName === 'TEXTAREA') return true;
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
      n = n.parentElement;
    }
    return false;
  }
  canvas.addEventListener('wheel', (e) => {
    if (overScrollableCard(e.target)) return; // let the card region scroll
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const factor = e.ctrlKey ? (1 - e.deltaY * 0.01) : (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    zoomAt(zoom * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ── pan by dragging empty canvas ──────────────────────────────────────────
  let panning = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
    if (e.shiftKey) return; // shift-drag is the selection marquee (see below), never pan
    panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    canvas.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    panX = panning.px + (e.clientX - panning.x);
    panY = panning.py + (e.clientY - panning.y);
    applyTransform();
  });
  window.addEventListener('mouseup', () => { panning = null; canvas.classList.remove('panning'); });

  // world <-> screen ---------------------------------------------------------
  function screenToWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  function viewport() { return { panX, panY, zoom }; }
  function centerWorld(cardW = 340, cardH = 230) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (r.width / 2 - panX) / zoom - cardW / 2,
      y: (r.height / 2 - panY) / zoom - cardH / 2,
    };
  }

  // fit all cards in view with a ~60px margin; no cards -> reset viewport
  function fitToView() {
    const cards = Array.from(content.children).filter((el) => el.classList.contains('card'));
    if (!cards.length) { panX = 0; panY = 0; zoom = 1; applyTransform(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cards.forEach((el) => {
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + el.offsetWidth);
      maxY = Math.max(maxY, y + el.offsetHeight);
    });
    const r = canvas.getBoundingClientRect();
    const bw = maxX - minX, bh = maxY - minY;
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, Math.min(r.width / (bw + 120), r.height / (bh + 120))));
    zoom = nz;
    panX = (r.width - bw * nz) / 2 - minX * nz;  // center the bbox horizontally
    panY = (r.height - bh * nz) / 2 - minY * nz; // ...and vertically
    applyTransform();
  }
  const fitBtn = document.querySelector('.zoombar [title="Fit"]');
  if (fitBtn) fitBtn.addEventListener('click', fitToView);

  // apply an explicit viewport (boards restore theirs through this) + repaint
  function setViewport(v = {}) {
    if (typeof v.panX === 'number' && isFinite(v.panX)) panX = v.panX;
    if (typeof v.panY === 'number' && isFinite(v.panY)) panY = v.panY;
    if (typeof v.zoom === 'number' && isFinite(v.zoom)) zoom = Math.min(MAX_Z, Math.max(MIN_Z, v.zoom));
    applyTransform();
  }

  // ── event bus ─────────────────────────────────────────────────────────────
  const listeners = new Map();
  const bus = {
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name) && listeners.get(name).delete(cb);
    },
    emit(name, data) {
      const set = listeners.get(name);
      if (!set) return;
      set.forEach((cb) => { try { cb(data); } catch (err) { console.error('[Atelier] bus handler for', name, err); } });
    },
  };

  // ── JSON store (localStorage) ─────────────────────────────────────────────
  const STORE_PREFIX = 'atelier:';
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };

  // ── backend (proxies the preload bridge window.atelier) ───────────────────
  const backend = {
    chat(message) {
      return Promise.resolve().then(() => {
        if (!window.atelier || typeof window.atelier.chat !== 'function') {
          throw new Error('Atelier backend bridge unavailable');
        }
        return window.atelier.chat(message);
      });
    },
    health() {
      return Promise.resolve().then(() => {
        if (!window.atelier || typeof window.atelier.health !== 'function') {
          throw new Error('Atelier backend bridge unavailable');
        }
        return window.atelier.health();
      });
    },
  };

  // ── cards: drag (by .card-bar), resize (handle), raise on mousedown ────────
  let zTop = 10;
  let cardSeq = 0;
  function bringToFront(card) { card.style.zIndex = ++zTop; }

  // ── selection state (marquee gestures live after addCard, below) ──────────
  const selected = new Set();        // card elements carrying class 'selected'
  const cardHandles = new WeakMap(); // card element -> addCard handle (for Delete)
  function emitSelection() { bus.emit('selection:changed', { count: selected.size }); }
  function setSelected(el, on) {
    if (on) { if (!selected.has(el)) { selected.add(el); el.classList.add('selected'); } }
    else if (selected.delete(el)) el.classList.remove('selected');
  }
  function clearSelection() {
    if (!selected.size) return;
    selected.forEach((el) => el.classList.remove('selected'));
    selected.clear();
    emitSelection();
  }

  function makeInteractive(card) {
    bringToFront(card);
    card.addEventListener('mousedown', () => bringToFront(card));

    const bar = card.querySelector('.card-bar');
    if (bar) {
      bar.addEventListener('mousedown', (e) => {
        if (e.target.closest('.card-x')) return;
        // Dragging a SELECTED card's bar moves the whole selection together.
        // ponytail: group-drag persistence rides on the module owning the
        // grabbed card (apps/widgets each persist ALL their instances on
        // mouseup); foreign cards in a mixed selection catch up on their
        // module's next gesture or the boards:will-switch flush.
        const group = card.classList.contains('selected') && selected.size
          ? Array.from(selected) : [card];
        const start = {
          x: e.clientX, y: e.clientY,
          cards: group.map((el) => ({
            el,
            l: parseFloat(el.style.left) || 0,
            t: parseFloat(el.style.top) || 0,
          })),
        };
        const move = (ev) => {
          const dx = (ev.clientX - start.x) / zoom;
          const dy = (ev.clientY - start.y) / zoom;
          start.cards.forEach((c) => {
            c.el.style.left = c.l + dx + 'px';
            c.el.style.top = c.t + dy + 'px';
          });
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
      });
    }

    // resize handle
    let handle = card.querySelector('.resize-handle');
    if (!handle) { handle = document.createElement('div'); handle.className = 'resize-handle'; card.appendChild(handle); }
    handle.addEventListener('mousedown', (e) => {
      const start = { x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
      const move = (ev) => {
        card.style.width = Math.max(240, start.w + (ev.clientX - start.x) / zoom) + 'px';
        card.style.height = Math.max(160, start.h + (ev.clientY - start.y) / zoom) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * addCard(el, {x, y, w?, h?, title?}) -> handle
   * Appends `el` into the canvas content at WORLD coords (x,y), sizes it,
   * makes it draggable by its .card-bar, resizable, raises it on mousedown.
   */
  function addCard(el, opts = {}) {
    const { x = 0, y = 0, w, h, title } = opts;
    el.classList.add('card');
    el.style.position = 'absolute';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (w != null) el.style.width = (typeof w === 'number' ? w + 'px' : w);
    if (h != null) el.style.height = (typeof h === 'number' ? h + 'px' : h);
    if (title) {
      const t = el.querySelector('.card-title');
      if (t) t.textContent = title;
    }
    content.appendChild(el);

    const id = 'card-' + (++cardSeq);
    el.dataset.cardId = id;
    makeInteractive(el);

    const handle = {
      el,
      id,
      remove() {
        const wasSelected = selected.delete(el);
        if (wasSelected) el.classList.remove('selected');
        el.remove();
        bus.emit('card:removed', { id, el });
        if (wasSelected) emitSelection();
      },
      setRect(rect = {}) {
        if (rect.x != null) el.style.left = rect.x + 'px';
        if (rect.y != null) el.style.top = rect.y + 'px';
        if (rect.w != null) el.style.width = rect.w + 'px';
        if (rect.h != null) el.style.height = rect.h + 'px';
      },
      getRect() {
        return {
          x: parseFloat(el.style.left) || 0,
          y: parseFloat(el.style.top) || 0,
          w: el.offsetWidth,
          h: el.offsetHeight,
        };
      },
    };

    cardHandles.set(el, handle); // Delete-key removal routes through the handle

    // close button routes through the handle so card:removed fires. Builtin
    // shell cards (index.html metrics/chat, stamped data-atl-builtin in the
    // boot loop below) are PERMANENT: since the in-place board switch dropped
    // location.reload(), nothing would ever recreate a closed builtin —
    // removeAllCards skips-but-never-rebuilds them and every board's saved
    // 'atelier.layout' expects them to exist — so their × is hidden and never
    // wired (deleteSelected skips them too). ponytail: hide-on-close +
    // reshow-on-switch is the upgrade if closable builtins are ever wanted.
    const x0 = el.querySelector('.card-x');
    if (el.dataset.atlBuiltin === '1') {
      if (x0) x0.style.display = 'none';
    } else if (x0) {
      x0.addEventListener('click', () => handle.remove());
    }

    bus.emit('card:added', { id, el });
    return handle;
  }

  // double-click on EMPTY canvas -> world coords
  const dblClickCbs = new Set();
  canvas.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    dblClickCbs.forEach((cb) => { try { cb(x, y, e); } catch (err) { console.error('[Atelier] onDoubleClick handler', err); } });
  });
  function onDoubleClick(cb) { dblClickCbs.add(cb); return () => dblClickCbs.delete(cb); }

  // ── marquee multi-select (Shift+drag on empty canvas) ─────────────────────
  // Screen-space overlay div; on move/up, cards whose WORLD rect AABB-
  // intersects the marquee are XORed against the pre-drag selection.
  let marq = null; // { sx, sy, preSel, box } — box appears past the 4px threshold

  function marqueeApply(x1, y1, x2, y2) { // screen corners -> live XOR select
    const a = screenToWorld(x1, y1), b = screenToWorld(x2, y2);
    Array.from(content.children).forEach((el) => {
      if (!el.classList.contains('card')) return;
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      const hit = x < b.x && x + el.offsetWidth > a.x &&
                  y < b.y && y + el.offsetHeight > a.y;
      setSelected(el, hit ? !marq.preSel.has(el) : marq.preSel.has(el));
    });
  }

  function cancelMarquee() { // Escape mid-drag: restore the pre-drag selection
    if (!marq) return;
    const pre = marq.preSel;
    if (marq.box) marq.box.remove();
    marq = null;
    Array.from(content.children).forEach((el) => {
      if (el.classList.contains('card')) setSelected(el, pre.has(el));
    });
    emitSelection();
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!e.shiftKey) return; // plain drag stays pan (handler above owns it)
    if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
    e.preventDefault();
    marq = { sx: e.clientX, sy: e.clientY, preSel: new Set(selected), box: null };
  });
  window.addEventListener('mousemove', (e) => {
    if (!marq) return;
    if (!marq.box) {
      const dx = e.clientX - marq.sx, dy = e.clientY - marq.sy;
      if (dx * dx + dy * dy < 16) return; // 4px threshold before the marquee appears
      ensureStyles();
      marq.box = document.createElement('div');
      marq.box.className = 'atelier-marquee';
      canvas.appendChild(marq.box);
    }
    const r = canvas.getBoundingClientRect();
    const x1 = Math.min(marq.sx, e.clientX), y1 = Math.min(marq.sy, e.clientY);
    const x2 = Math.max(marq.sx, e.clientX), y2 = Math.max(marq.sy, e.clientY);
    marq.box.style.left = (x1 - r.left) + 'px';
    marq.box.style.top = (y1 - r.top) + 'px';
    marq.box.style.width = (x2 - x1) + 'px';
    marq.box.style.height = (y2 - y1) + 'px';
    marqueeApply(x1, y1, x2, y2); // live preview; mouseup only finalizes
  });
  window.addEventListener('mouseup', () => {
    if (!marq) return;
    const drew = !!marq.box; // sub-threshold shift-click leaves selection alone
    if (marq.box) marq.box.remove();
    marq = null;
    if (drew) emitSelection();
  });

  function deleteSelected() {
    // route through the handles so card:removed fires for every card;
    // builtin shell cards are permanent (no re-create path — see addCard)
    Array.from(selected).forEach((el) => {
      if (el.dataset.atlBuiltin === '1') return;
      const h = cardHandles.get(el);
      if (h) h.remove();
    });
  }

  // removeAllCards(): board-switch teardown (boards.js calls this before
  // restoring the target board's snapshot). Removes every non-builtin card
  // THROUGH its addCard handle so 'card:removed' fires per card and modules
  // can drop their per-card state; the static index.html cards (stamped
  // data-atl-builtin in the boot loop) survive. Any selection left on the
  // survivors is cleared afterwards.
  function removeAllCards() {
    Array.from(content.children).forEach((el) => {
      if (!el.classList.contains('card')) return;
      if (el.dataset.atlBuiltin === '1') return;
      const h = cardHandles.get(el);
      if (h) h.remove();
      else el.remove(); // never addCard-adopted (should not happen) — drop quietly
    });
    clearSelection();
  }

  // ── tidy / auto-arrange (zoombar ✦) ───────────────────────────────────────
  // OpenSwarm-style: sort by (y, then x), flow left→right into rows of total
  // width ~ the current viewport in world units, 24px gutters, row height =
  // tallest card in the row; animate via .tidying, then fitToView().
  function tidy() {
    const cards = Array.from(content.children).filter((el) => el.classList.contains('card'));
    if (!cards.length) return;
    ensureStyles();
    cards.sort((c1, c2) => {
      const dy = (parseFloat(c1.style.top) || 0) - (parseFloat(c2.style.top) || 0);
      return dy || ((parseFloat(c1.style.left) || 0) - (parseFloat(c2.style.left) || 0));
    });
    const r = canvas.getBoundingClientRect();
    const origin = screenToWorld(r.left + 24, r.top + 24); // near viewport top-left
    const maxW = Math.max(360, r.width / zoom - 48);
    let cx = origin.x, cy = origin.y, rowH = 0;
    cards.forEach((el) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      if (cx > origin.x && cx - origin.x + w > maxW) { cx = origin.x; cy += rowH + 24; rowH = 0; }
      el.classList.add('tidying');
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      cx += w + 24;
      rowH = Math.max(rowH, h);
    });
    setTimeout(() => cards.forEach((el) => el.classList.remove('tidying')), 400);
    fitToView(); // reads the already-set target positions, so it fits the end state
    // Tidy moves cards without any mousedown/mouseup on them, so the app and
    // widget modules' gesture-based persistence never fires — announce the
    // rearrange so they flush their rects now (customization.js's observer
    // already catches the built-in cards).
    bus.emit('cards:rearranged', {});
  }
  const tidyBtn = document.querySelector('.zoombar [title="Auto-arrange"]');
  if (tidyBtn) tidyBtn.addEventListener('click', tidy);

  // ── minimap (zoombar ▣; replaces the static .mm-card divs with live SVG) ──
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const minimapEl = document.querySelector('.minimap');
  let mmSvg = null;
  let mmMap = null; // world->minimap transform of the last draw (for inverse)
  let mmVisible = store.get('minimap', true) !== false; // default ON (shell shows one)
  let mmLast = 0, mmTimer = null;
  let mmDrag = null; // frozen world->minimap transform held for a whole drag

  function drawMinimap() {
    if (!mmSvg || !mmVisible) return;
    const box = mmSvg.getBoundingClientRect();
    const W = box.width || 166, H = box.height || 104;
    const r = canvas.getBoundingClientRect();
    const rects = Array.from(content.children)
      .filter((el) => el.classList.contains('card'))
      .map((el) => ({
        x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
        w: el.offsetWidth, h: el.offsetHeight,
      }));
    // union bbox of all card world-rects plus the viewport rect
    const vp = { x: -panX / zoom, y: -panY / zoom, w: r.width / zoom, h: r.height / zoom };
    let minX = vp.x, minY = vp.y, maxX = vp.x + vp.w, maxY = vp.y + vp.h;
    rects.forEach((c) => {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
    });
    if (mmDrag) {
      // FROZEN frame: during a minimap drag the transform is held fixed so the
      // coordinate system cannot re-fit under the cursor (the viewport rect is
      // part of the union bbox above, so panning would otherwise shift the frame
      // and make the drag jump). Only the viewport indicator moves in this frame.
      mmMap = mmDrag;
    } else {
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const scale = Math.min(W / bw, H / bh);
      mmMap = { scale, minX, minY, ox: (W - bw * scale) / 2, oy: (H - bh * scale) / 2 };
    }
    const px = (wx) => (wx - mmMap.minX) * mmMap.scale + mmMap.ox;
    const py = (wy) => (wy - mmMap.minY) * mmMap.scale + mmMap.oy;
    const scale = mmMap.scale; // used below for rect sizing (frozen or fresh)

    mmSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    mmSvg.textContent = '';
    rects.forEach((c) => {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', px(c.x)); el.setAttribute('y', py(c.y));
      el.setAttribute('width', Math.max(2, c.w * scale));
      el.setAttribute('height', Math.max(2, c.h * scale));
      el.setAttribute('rx', 2);
      el.setAttribute('fill-opacity', '0.25');
      el.style.fill = 'var(--accent)';
      mmSvg.appendChild(el);
    });
    const v = document.createElementNS(SVG_NS, 'rect');
    v.setAttribute('x', px(vp.x)); v.setAttribute('y', py(vp.y));
    v.setAttribute('width', Math.max(2, vp.w * scale));
    v.setAttribute('height', Math.max(2, vp.h * scale));
    v.setAttribute('rx', 2);
    v.setAttribute('fill', 'none');
    v.setAttribute('stroke-width', '1.5');
    v.style.stroke = 'var(--accent)';
    mmSvg.appendChild(v);
  }

  function scheduleMinimap() { // throttled ~250ms with a trailing call
    if (!mmSvg || !mmVisible) return;
    clearTimeout(mmTimer);
    const wait = Math.max(0, 250 - (Date.now() - mmLast));
    mmTimer = setTimeout(() => { mmLast = Date.now(); drawMinimap(); }, wait);
  }

  function minimapPanTo(clientX, clientY) { // inverse transform; center that point
    if (!mmMap || !mmSvg) return;
    const box = mmSvg.getBoundingClientRect();
    const wx = (clientX - box.left - mmMap.ox) / mmMap.scale + mmMap.minX;
    const wy = (clientY - box.top - mmMap.oy) / mmMap.scale + mmMap.minY;
    const r = canvas.getBoundingClientRect();
    setViewport({ panX: r.width / 2 - wx * zoom, panY: r.height / 2 - wy * zoom });
  }

  function applyMinimapVisibility() {
    if (minimapEl) minimapEl.style.display = mmVisible ? '' : 'none';
  }

  // Called from the boot section (ensureStyles reads state declared below).
  function minimapInit() {
    if (!minimapEl) return;
    ensureStyles();
    minimapEl.textContent = ''; // drop the static .mm-frame / .mm-card markup
    mmSvg = document.createElementNS(SVG_NS, 'svg');
    mmSvg.setAttribute('class', 'mm-svg');
    minimapEl.appendChild(mmSvg);
    // click (or drag) pans the canvas so the pointed world point centers
    mmSvg.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Freeze the current fit for the whole drag so the frame can't shift under
      // the cursor (see drawMinimap) — this is what makes the drag smooth. Redraw
      // directly on each move (cheap; a few rects) so the indicator tracks live
      // rather than lagging behind the 250ms throttle.
      drawMinimap();     // refresh mmMap to the current state
      mmDrag = mmMap;    // freeze it
      minimapPanTo(e.clientX, e.clientY);
      drawMinimap();
      const move = (ev) => { minimapPanTo(ev.clientX, ev.clientY); drawMinimap(); };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        mmDrag = null;   // unfreeze; re-fit to the new viewport/cards
        drawMinimap();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    const btn = document.querySelector('.zoombar [title="Minimap"]');
    if (btn) btn.addEventListener('click', () => {
      mmVisible = !mmVisible;
      // ponytail: 'atelier:minimap' is board-scoped under boards.js, so the
      // toggle travels with each board; a GLOBAL_KEYS entry is the upgrade.
      store.set('minimap', mmVisible);
      applyMinimapVisibility();
      if (mmVisible) drawMinimap();
    });
    applyMinimapVisibility();
    bus.on('card:added', scheduleMinimap);
    bus.on('card:removed', scheduleMinimap);
    window.addEventListener('mouseup', scheduleMinimap); // drag/resize/pan/marquee end
    drawMinimap();
  }

  // ── app + widget registries ───────────────────────────────────────────────
  const appRegistry = new Map();
  const widgetRegistry = new Map();

  function registerApp(type, def) {
    appRegistry.set(type, def || {});
    bus.emit('app:registered', { type, def });
  }
  function registerWidget(type, def) {
    widgetRegistry.set(type, def || {});
    bus.emit('widget:registered', { type, def });
  }

  function spawnApp(type, worldPos) {
    const def = appRegistry.get(type);
    if (!def || typeof def.create !== 'function') return null;
    const pos = worldPos || centerWorld();
    const el = def.create(pos);
    if (!el) return null;
    if (el.dataset && el.dataset.cardId) return el; // create() already used addCard
    return addCard(el, { x: pos.x, y: pos.y });
  }

  function spawnWidget(type, config, worldPos) {
    // widgets.js owns config forms, live-data mounts, and persistence — route
    // through it when loaded so every spawn path (palette, scripts) behaves
    // like the picker. The inline path below is only the pre-widgets fallback.
    if (window.AtelierWidgets && typeof window.AtelierWidgets.spawn === 'function') {
      return window.AtelierWidgets.spawn(type, config, worldPos);
    }
    const def = widgetRegistry.get(type);
    if (!def || typeof def.render !== 'function') return null;
    const cfg = Object.assign({}, def.defaultConfig || {}, config || {});
    const inner = def.render(cfg);
    const card = document.createElement('section');
    card.className = 'card widget-card';
    card.innerHTML =
      '<div class="card-bar"><span class="card-dot"></span>' +
      '<span class="card-title"></span><span class="card-x">×</span></div>';
    card.querySelector('.card-title').textContent = cfg.title || def.label || type;
    const body = document.createElement('div');
    body.className = 'app-body';
    if (inner) body.appendChild(inner);
    card.appendChild(body);
    const pos = worldPos || centerWorld(300, 200);
    return addCard(card, { x: pos.x, y: pos.y, w: 300, h: 200 });
  }

  // ── ui: toast + floating panel (styles injected here, not in styles.css) ──
  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .atelier-toasts { position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
        display: flex; flex-direction: column; gap: 8px; z-index: 9999; pointer-events: none; }
      .atelier-toast { background: var(--panel); color: var(--ink);
        border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px;
        box-shadow: var(--shadow); font-size: 13px; max-width: 340px;
        opacity: 0; transform: translateY(-6px); transition: opacity .18s ease, transform .18s ease; }
      .atelier-toast.show { opacity: 1; transform: translateY(0); }
      .atelier-panel { position: fixed; top: 90px; left: 50%; transform: translateX(-50%);
        min-width: 280px; max-width: 520px; background: var(--panel);
        border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow); z-index: 9000; display: flex; flex-direction: column;
        overflow: hidden; }
      .atelier-panel-body { padding: 14px; overflow: auto; max-height: 60vh; color: var(--ink); }
      .card.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
      .card.tidying { transition: left .35s ease, top .35s ease; }
      .atelier-marquee { position: absolute; z-index: 9998; pointer-events: none;
        border: 1.5px solid var(--accent); background: var(--accent-soft);
        opacity: 0.45; border-radius: 4px; }
      .minimap .mm-svg { display: block; width: 100%; height: 100%; }
      body.sidebar-collapsed .sidebar { display: none; }
      .atelier-panel-backdrop { position: fixed; inset: 0; z-index: 8990;
        background: rgba(20, 15, 10, 0.10); }
    `;
    const style = document.createElement('style');
    style.id = 'atelier-core-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  let toastHost = null;
  function toast(text) {
    ensureStyles();
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'atelier-toasts';
      document.body.appendChild(toastHost);
    }
    const t = document.createElement('div');
    t.className = 'atelier-toast';
    t.textContent = text;
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, 2600);
    return t;
  }

  function openPanel(title, el, opts) {
    ensureStyles();
    opts = opts || {};
    // Optional dismiss-on-click-off backdrop (Escape already closes the topmost
    // panel in the keyboard handler below). Linked to the panel via _backdrop so
    // an Escape close tears it down too.
    let backdrop = null;
    if (opts.backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'atelier-panel-backdrop';
      document.body.appendChild(backdrop);
    }
    const panel = document.createElement('div');
    panel.className = 'atelier-panel';
    const bar = document.createElement('div');
    bar.className = 'card-bar';
    bar.innerHTML = '<span class="card-dot"></span><span class="card-title"></span><span class="card-x">×</span>';
    bar.querySelector('.card-title').textContent = title || 'Panel';
    const body = document.createElement('div');
    body.className = 'atelier-panel-body';
    if (el) body.appendChild(el);
    panel.append(bar, body);
    document.body.appendChild(panel);

    const close = () => { panel.remove(); if (backdrop) backdrop.remove(); };
    if (backdrop) { panel._backdrop = backdrop; backdrop.addEventListener('click', close); }
    bar.querySelector('.card-x').addEventListener('click', close);

    // draggable (screen-space; panels float above the canvas, unaffected by zoom)
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.card-x')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      const start = { x: e.clientX, y: e.clientY, l: rect.left, t: rect.top };
      const move = (ev) => {
        panel.style.left = start.l + (ev.clientX - start.x) + 'px';
        panel.style.top = start.t + (ev.clientY - start.y) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });

    return { el: panel, body, close };
  }

  // ── chat card ─────────────────────────────────────────────────────────────
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const messagesEl = document.getElementById('messages');
  let sending = false;

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function clearEmpty() { const e = document.getElementById('empty-state'); if (e) e.remove(); }
  function avatar(role) {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.textContent = role === 'assistant' ? 'A' : 'You';
    return a;
  }
  function addMessage(role, text) {
    clearEmpty();
    const row = document.createElement('div');
    row.className = `row ${role}`;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    row.append(avatar(role), b);
    messagesEl.appendChild(row);
    scrollBottom();
    return b;
  }
  function addThinking() {
    clearEmpty();
    const row = document.createElement('div');
    row.className = 'row assistant';
    const b = document.createElement('div');
    b.className = 'bubble thinking';
    b.textContent = 'Thinking…';
    row.append(avatar('assistant'), b);
    messagesEl.appendChild(row);
    scrollBottom();
    return b;
  }
  function extractReply(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    return d.response ?? d.reply ?? d.message ?? d.text ?? d.output ?? d.content ?? '';
  }
  function extractError(d) {
    if (!d) return 'No response.';
    return d.message ?? d.detail ?? (typeof d.error === 'string' ? d.error : null) ?? 'Something went wrong.';
  }
  // SSE token streaming for the chat card. Reads POST /chat/stream directly
  // with fetch (the page has no CSP and widgets already fetch the backend
  // directly); throws on any transport/shape problem so send() can fall back
  // to the blocking POST /chat. onDelta(text) fires per token chunk.
  // ponytail: direct fetch, no preload hop — but mutating routes carry the
  // shared-secret header (window.atelier.token, minted by main.js) when the
  // preload bridge is present; absent (plain browser) the backend has no token
  // set and does not enforce it.
  async function streamChat(message, onDelta) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch('http://127.0.0.1:8765/chat/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) throw new Error('stream unavailable');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line.slice(6)); } catch { continue; }
        if (obj.delta) { try { onDelta(obj.delta); } catch { /* UI callback */ } }
        if (obj.done) final = obj;
      }
    }
    if (!final) throw new Error('stream ended without a final event');
    return final;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true; sendEl.disabled = true; inputEl.value = ''; grow();
    addMessage('user', text);
    bus.emit('chat:sent', { text });
    const t = addThinking();
    let streamedAny = false;
    try {
      const data = await streamChat(text, (delta) => {
        if (!streamedAny) { streamedAny = true; t.classList.remove('thinking'); t.textContent = ''; }
        t.textContent += delta;
        scrollBottom();
      });
      t.classList.remove('thinking');
      // Replace accumulated deltas with the canonical final text.
      t.textContent = (data && data.error) ? extractError(data) : (extractReply(data) || '(empty response)');
      bus.emit('chat:reply', { data });
    } catch {
      if (streamedAny) {
        // Deltas already arrived, then the stream died. Do NOT re-send (the
        // turn already ran server-side); keep what streamed and say so.
        t.classList.remove('thinking');
        t.textContent += '\n\n[connection to the stream was lost — reply may be incomplete]';
      } else {
        // Streaming endpoint missing/unreachable (older backend, cold start):
        // fall back to the blocking chat exactly as before.
        try {
          const data = await backend.chat(text);
          t.classList.remove('thinking');
          t.textContent = (data && data.error) ? extractError(data) : (extractReply(data) || '(empty response)');
          bus.emit('chat:reply', { data });
        } catch {
          t.classList.remove('thinking');
          t.textContent = 'Could not reach the Atelier backend. It may still be starting — try again in a moment.';
        }
      }
    } finally {
      sending = false; sendEl.disabled = false; scrollBottom(); inputEl.focus();
    }
  }
  function grow() { if (!inputEl.value) { inputEl.style.height = ''; return; } inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }
  inputEl.addEventListener('input', grow);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendEl.addEventListener('click', send);

  // Mount the shared model picker (chatcontrols.js) on the main chat composer.
  // chatcontrols.js is a deferred script that loads AFTER core.js, so
  // window.Atelier.chatcontrols does not exist yet at this point; deferred
  // scripts all run before DOMContentLoaded, so mounting on that event runs
  // after chatcontrols.js has published its API. Guarded: a missing module
  // (404) leaves the composer exactly as it was.
  window.addEventListener('DOMContentLoaded', () => {
    const cc = window.Atelier && window.Atelier.chatcontrols;
    const composer = inputEl && inputEl.parentElement; // the .composer div
    if (cc && typeof cc.mount === 'function' && composer) {
      cc.mount(composer, { scope: 'main' });
    }
  });

  // ── backend status polling ────────────────────────────────────────────────
  function setStatus(ok) {
    dotEl.classList.remove('ok', 'bad');
    if (ok === true) { dotEl.classList.add('ok'); statusTextEl.textContent = 'on subscription'; }
    else if (ok === false) { dotEl.classList.add('bad'); statusTextEl.textContent = 'backend offline'; }
    else { statusTextEl.textContent = 'connecting…'; }
    bus.emit('backend:status', { ok });
  }
  async function pollHealth() {
    try {
      const h = await backend.health();
      setStatus(!!(h && (h.ok === true || h.status === 'ok')));
    } catch { setStatus(false); }
  }

  // ── built-in dock app types (preserve existing spawn behavior) ────────────
  function makeAppCard(title, bodyHTML) {
    const card = document.createElement('section');
    card.className = 'card app-card';
    card.innerHTML =
      `<div class="card-bar"><span class="card-dot"></span>` +
      `<span class="card-title">${title}</span><span class="card-x">×</span></div>` +
      `<div class="app-body">${bodyHTML}</div>`;
    return card;
  }
  registerApp('note', { label: 'Note', icon: '🗒', create: () => makeAppCard('Note', `<textarea class="note-area" placeholder="Write a note…"></textarea>`) });
  registerApp('browser', { label: 'Browser', icon: '🌐', create: () => makeAppCard('Browser', `<div class="app-stub">🌐 Browser card — open a site as a card. (Wire to a webview to enable.)</div>`) });
  registerApp('workflow', { label: 'Workflow', icon: '↺', create: () => makeAppCard('Workflow', `<div class="app-stub">↺ Workflow — a scheduled Atelier job (research → gate → publish).</div>`) });
  registerApp('calendar', { label: 'Calendar', icon: '🗓', create: () => makeAppCard('Calendar', `<div class="app-stub">🗓 Calendar — schedule campaigns and posts.</div>`) });
  registerApp('history', { label: 'History', icon: '🕘', create: () => makeAppCard('History', `<div class="app-stub">🕘 Recent sessions and run ledger.</div>`) });

  document.querySelectorAll('.dock-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.dock-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      // data-tip || title: tooltip.js strips title -> data-tip on hover, so a
      // click-time title read would be null. (apps.js re-wires these buttons,
      // superseding this handler, but keep it correct in case it runs first.)
      const t = (b.getAttribute('data-tip') || b.getAttribute('title') || '').toLowerCase();
      if (t === 'chat') { inputEl.focus(); return; }
      if (t === 'apps') { spawnApp('note'); return; }
      if (t === 'campaign') { spawnApp('workflow'); return; }
      if (appRegistry.has(t)) spawnApp(t);
    });
  });

  // ── topbar buttons (were decorative in the UI clone — now wired) ───────────
  // ▨ Toggle sidebar; ‹ Back / › Forward = previous/next board. Selected by
  // POSITION within .tb-left, not title (tooltip.js strips title on hover).
  (function wireTopbar() {
    ensureStyles();                                  // needs .sidebar-collapsed css
    const btns = Array.from(document.querySelectorAll('.topbar .tb-left .icon-btn'));
    const toggleBtn = btns[0];
    const backBtn = btns[1];
    const fwdBtn = btns[2];
    if (toggleBtn) {
      if (store.get('atelier.sidebar.collapsed') === '1') {
        document.body.classList.add('sidebar-collapsed');
      }
      toggleBtn.addEventListener('click', () => {
        const on = document.body.classList.toggle('sidebar-collapsed');
        store.set('atelier.sidebar.collapsed', on ? '1' : '');
        // the canvas width just changed ~248px; nudge size-on-resize consumers
        // (e.g. the open Graph view's canvas) so they don't keep a stale bitmap.
        window.dispatchEvent(new Event('resize'));
      });
    }
    const navBoard = (dir) => {
      const boards = window.Atelier && window.Atelier.boards;   // set by boards.js (loads later)
      if (!boards) return;
      const list = boards.list();
      const act = boards.active();
      const i = act ? list.findIndex((x) => x.id === act.id) : -1;
      const j = i + dir;
      if (j >= 0 && j < list.length) boards.switch(list[j].id);
      else toast(dir < 0 ? 'Already at the first board' : 'Already at the last board');
    };
    if (backBtn) backBtn.addEventListener('click', () => navBoard(-1));
    if (fwdBtn) fwdBtn.addEventListener('click', () => navBoard(1));
  })();

  // ── keyboard shortcuts (Escape, Delete/Backspace, Cmd/Ctrl+M add-app) ─────
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return; // palette & friends handle their own keys
    if (e.key === 'Escape') {
      // Escape works even while typing. Marquee/selection clearing comes
      // FIRST; then close the topmost floating panel if one is open
      // (uniform z-index, so last in DOM order paints on top).
      if (marq) { cancelMarquee(); return; }
      if (selected.size) { clearSelection(); return; }
      const panels = document.querySelectorAll('.atelier-panel');
      if (panels.length) {
        const p = panels[panels.length - 1];
        if (p._backdrop) p._backdrop.remove();       // tear down the dismiss backdrop too
        p.remove();
      } else bus.emit('shortcut:escape');
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
      e.preventDefault();
      deleteSelected(); // via the handles, so card:removed fires per card
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      bus.emit('shortcut:add-app', {});
      const subs = listeners.get('shortcut:add-app');
      // ponytail: note-spawn fallback until an app-launcher module registers
      // a 'shortcut:add-app' bus listener and owns the key.
      if (!subs || subs.size === 0) spawnApp('note');
    }
  });

  // ── publish the API ───────────────────────────────────────────────────────
  window.Atelier = {
    canvas: { addCard, removeAllCards, onDoubleClick, viewport, screenToWorld, fitToView, setViewport, tidy },
    selection: {
      get: () => Array.from(selected),   // selected card elements
      clear: clearSelection,
      count: () => selected.size,
    },
    bus,
    store,
    backend,
    ui: { toast, openPanel },
    registerApp,
    registerWidget,
    // helpers feature modules use to spawn what they register:
    spawnApp,
    spawnWidget,
    apps: appRegistry,
    widgets: widgetRegistry,
  };

  // ── boot: register the pre-existing metrics + chat cards through addCard ──
  ensureStyles();   // selection/marquee/tidy/minimap CSS must exist up front
  minimapInit();    // before the addCard loop so card:added redraws are caught
  document.querySelectorAll('#content > .card').forEach((el) => {
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    el.dataset.atlBuiltin = '1'; // static shell cards; removeAllCards skips these
    addCard(el, { x, y }); // width/height stay from CSS; look unchanged
  });

  applyTransform();
  setStatus(null);
  pollHealth();
  setInterval(pollHealth, 4000);
  inputEl.focus();


  // ── self-check: assert the documented API surface exists ──────────────────
  (function selfCheck() {
    const A = window.Atelier;
    const checks = [
      ['canvas.addCard', A.canvas && typeof A.canvas.addCard === 'function'],
      ['canvas.removeAllCards', A.canvas && typeof A.canvas.removeAllCards === 'function'],
      ['canvas.onDoubleClick', typeof A.canvas.onDoubleClick === 'function'],
      ['canvas.viewport', typeof A.canvas.viewport === 'function'],
      ['canvas.screenToWorld', typeof A.canvas.screenToWorld === 'function'],
      ['canvas.fitToView', typeof A.canvas.fitToView === 'function'],
      ['canvas.setViewport', typeof A.canvas.setViewport === 'function'],
      ['canvas.tidy', typeof A.canvas.tidy === 'function'],
      ['selection.get', A.selection && typeof A.selection.get === 'function'],
      ['selection.clear', A.selection && typeof A.selection.clear === 'function'],
      ['selection.count', A.selection && typeof A.selection.count === 'function'],
      ['bus.on', A.bus && typeof A.bus.on === 'function'],
      ['bus.emit', A.bus && typeof A.bus.emit === 'function'],
      ['store.get', A.store && typeof A.store.get === 'function'],
      ['store.set', A.store && typeof A.store.set === 'function'],
      ['backend.chat', A.backend && typeof A.backend.chat === 'function'],
      ['backend.health', A.backend && typeof A.backend.health === 'function'],
      ['ui.toast', A.ui && typeof A.ui.toast === 'function'],
      ['ui.openPanel', A.ui && typeof A.ui.openPanel === 'function'],
      ['registerApp', typeof A.registerApp === 'function'],
      ['registerWidget', typeof A.registerWidget === 'function'],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([n]) => n);
    console.assert(missing.length === 0, '[Atelier] MISSING API methods:', missing);
    if (!missing.length) console.log('[Atelier] core ready — API surface verified.');
    bus.emit('core:ready', { api: A });
  })();
})();
