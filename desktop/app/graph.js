'use strict';

/* ===========================================================================
   Atelier feature module — Graph view   (app/graph.js)

   An Obsidian-style global graph of the vault. Registers a sidebar "Graph"
   view (Atelier.views, section 'analytics'), fetches GET /vault/graph, and
   renders it on a <canvas> with a dependency-free force simulation (link
   springs + charge repulsion + centering gravity, velocity Verlet, cooling
   alpha). Node radius scales with degree; hover highlights a node + its direct
   neighbours and dims the rest; wheel zooms, background drag pans, a node drag
   pins while held; clicking a node opens that note (GET /vault/note → a note
   card via Atelier.spawnApp when available). Ghost nodes (unresolved links)
   render hollow. Respects the theme via canvas reads of CSS vars.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Reload the app. Console shows "[graph] view registered." with no
      console.assert failures. A "Graph" row appears in the sidebar Analytics
      group.
   2. Click "Graph" → a full-canvas view opens; within ~1s the vault renders as
      a moving force graph that settles. Bigger (higher-degree) notes are
      larger. Ghost nodes are hollow.
   3. Hover a node → it + its neighbours stay bright, everything else dims;
      the node's title label shows.
   4. Wheel over the canvas → zoom in/out about the cursor. Drag the background
      → pan. Drag a node → it follows the cursor and pins while held, releasing
      it lets the sim resume.
   5. Click a node → its note opens as a card (or, with spawnApp absent, a
      toast/console line naming the note). Ghost nodes (no file) do nothing.
   6. Header ↻ re-fetches /vault/graph. × closes back to the board.
   7. Toggle theme (Settings/customization) → graph colours follow.
   =========================================================================== */
(function () {
  const A = window.Atelier;
  if (!A || !A.views || typeof A.views.register !== 'function') {
    console.warn('[graph] Atelier.views not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const VIEW_ID = 'graph';

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function mount(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'graph-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let nodes = [];
    let edges = [];
    let raf = 0;
    let alpha = 1;
    let disposed = false;

    // view transform (screen = world*scale + offset)
    let scale = 1;
    let offX = 0;
    let offY = 0;

    // interaction state
    let hoverNode = null;
    let dragNode = null;
    let panning = false;
    let last = { x: 0, y: 0 };
    const neighbours = new Map(); // id -> Set(neighbour ids)

    function size() {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: rect.width, h: rect.height };
    }
    let view = size();

    function toWorld(sx, sy) {
      return { x: (sx - offX) / scale, y: (sy - offY) / scale };
    }

    function seed() {
      // deterministic-ish scatter (no Math.random dependency on layout quality)
      const cx = view.w / 2;
      const cy = view.h / 2;
      nodes.forEach((n, i) => {
        const ang = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        const r = 40 + (i % 7) * 30;
        n.x = cx + Math.cos(ang) * r;
        n.y = cy + Math.sin(ang) * r;
        n.vx = 0;
        n.vy = 0;
        n.r = 4 + Math.sqrt(n.degree || 0) * 3;
      });
    }

    function indexNeighbours() {
      neighbours.clear();
      nodes.forEach((n) => neighbours.set(n.id, new Set()));
      edges.forEach((e) => {
        if (neighbours.has(e.source)) neighbours.get(e.source).add(e.target);
        if (neighbours.has(e.target)) neighbours.get(e.target).add(e.source);
      });
    }

    function step() {
      const cx = view.w / 2;
      const cy = view.h / 2;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      // charge repulsion (O(n^2) — the vault is small)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (2600 * alpha) / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          a.vx += ux * f;
          a.vy += uy * f;
          b.vx -= ux * f;
          b.vy -= uy * f;
        }
      }
      // link springs
      edges.forEach((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02 * alpha;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      });
      // centering gravity + integrate
      nodes.forEach((n) => {
        if (n === dragNode) return;
        n.vx += (cx - n.x) * 0.002 * alpha;
        n.vy += (cy - n.y) * 0.002 * alpha;
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
      });
      alpha *= 0.992;
    }

    function draw() {
      const edgeCol = cssVar('--line', 'rgba(120,120,120,0.35)');
      const nodeCol = cssVar('--accent', '#c98a5e');
      const inkCol = cssVar('--ink', '#333');
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      const active = hoverNode
        ? neighbours.get(hoverNode.id) || new Set()
        : null;

      // edges
      const byId = new Map(nodes.map((n) => [n.id, n]));
      edges.forEach((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return;
        const lit = !hoverNode
          || a === hoverNode || b === hoverNode;
        ctx.globalAlpha = lit ? 0.55 : 0.08;
        ctx.strokeStyle = edgeCol;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });

      // nodes
      nodes.forEach((n) => {
        const lit = !hoverNode || n === hoverNode
          || (active && active.has(n.id));
        ctx.globalAlpha = lit ? 1 : 0.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (n.ghost) {
          ctx.strokeStyle = nodeCol;
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
        } else {
          ctx.fillStyle = nodeCol;
          ctx.fill();
        }
        // labels: always for hovered/neighbour, else when zoomed in
        if (lit && (hoverNode || scale > 1.4)) {
          ctx.globalAlpha = lit ? 0.9 : 0.2;
          ctx.fillStyle = inkCol;
          ctx.font = (11 / scale) + 'px system-ui, sans-serif';
          ctx.fillText(n.title || n.id, n.x + n.r + 2 / scale, n.y + 3 / scale);
        }
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function frame() {
      if (disposed) return;
      step();
      draw();
      if (alpha < 0.005 && !dragNode) {
        // settled — stop repainting until something needs it again (battery)
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function kick() {
      alpha = Math.max(alpha, 0.3);
      if (!raf) frame();
    }

    function pickNode(sx, sy) {
      const w = toWorld(sx, sy);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = n.x - w.x;
        const dy = n.y - w.y;
        if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
      }
      return null;
    }

    function authHeaders() {
      const h = {};
      if (window.atelier && window.atelier.token) h['X-Atelier-Token'] = window.atelier.token;
      return h;
    }

    function openNote(n) {
      if (!n || n.ghost || !n.path) return;
      fetch(BASE + '/vault/note?path=' + encodeURIComponent(n.id),
            { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => {
          const md = (d && d.markdown) || '';
          if (typeof A.spawnApp === 'function') {
            const el = A.spawnApp('note');
            const ta = el && el.querySelector('.app-body textarea');
            if (ta) {
              ta.value = md;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.blur();
              return;
            }
          }
          if (A.toast) A.toast('Opened note: ' + (n.title || n.id));
          else console.log('[graph] note', n.id, md.slice(0, 200));
        })
        .catch(() => { if (A.toast) A.toast('Could not open note.'); });
    }

    // ── events ────────────────────────────────────────────────────────────
    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      scale = Math.max(0.2, Math.min(5, scale * factor));
      offX = sx - before.x * scale;
      offY = sy - before.y * scale;
      kick();
    }
    function onDown(e) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const n = pickNode(sx, sy);
      last = { x: sx, y: sy };
      if (n) { dragNode = n; n.moved = false; }
      else panning = true;
      kick();
    }
    function onMove(e) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (dragNode) {
        const w = toWorld(sx, sy);
        dragNode.x = w.x;
        dragNode.y = w.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        dragNode.moved = true;
        alpha = Math.max(alpha, 0.3);
      } else if (panning) {
        offX += sx - last.x;
        offY += sy - last.y;
        last = { x: sx, y: sy };
      } else {
        const prevHover = hoverNode;
        hoverNode = pickNode(sx, sy);
        canvas.style.cursor = hoverNode ? 'pointer' : 'default';
        if (hoverNode !== prevHover) kick();
      }
    }
    function onUp(e) {
      if (dragNode && !dragNode.moved) openNote(dragNode);
      dragNode = null;
      panning = false;
    }
    function onResize() { view = size(); }

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);

    function load() {
      fetch(BASE + '/vault/graph', { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => {
          if (disposed) return;
          nodes = (d.nodes || []).map((n) => Object.assign({}, n));
          edges = (d.edges || []).slice();
          view = size();
          seed();
          indexNeighbours();
          alpha = 1;
          kick();
        })
        .catch(() => {
          ctx.fillStyle = cssVar('--ink-dim', '#999');
          ctx.font = '13px system-ui, sans-serif';
          ctx.fillText('Graph unavailable — backend unreachable.', 20, 30);
        });
    }
    load();
    mount._reload = load;

    return function cleanup() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }

  A.views.register(VIEW_ID, {
    label: 'Graph',
    icon: '◈',
    section: 'analytics',
    mount: mount,
    onRefresh: function () { if (mount._reload) mount._reload(); },
  });

  console.assert(typeof A.views.register === 'function', '[graph] views API missing');
  console.log('[graph] view registered.');
})();
