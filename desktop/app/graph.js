'use strict';

/* ===========================================================================
   Atelier feature module — Graph view   (app/graph.js)

   An Obsidian-style global graph of the vault. Registers a sidebar "Graph"
   view (Atelier.views, section 'analytics'), fetches GET /vault/graph, and
   renders it on a <canvas> with a dependency-free force simulation.

   Load is a SLOW, CONTROLLED SPAWN-IN (like Obsidian): nodes are revealed
   hub-first, then outward along links, over ~3s; each fades + scales in and is
   seeded next to its already-placed neighbours, so the graph grows organically
   instead of exploding. Forces are a Barnes-Hut quadtree charge repulsion
   (O(n log n), stable at 1500+ nodes) + link springs + gentle centering, with
   velocity clamping and a cooling alpha so it eases into place and then rests.

   Node radius scales with degree; hover highlights a node + its direct
   neighbours and dims the rest; wheel zooms, background drag pans, a node drag
   pins while held; clicking a node opens that note (GET /vault/note → a note
   card via Atelier.spawnApp when available). Ghost nodes (unresolved links)
   render hollow. Respects the theme via canvas reads of CSS vars.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Reload the app. Console shows "[graph] view registered." with no
      console.assert failures. A "Graph" row appears in the sidebar Analytics
      group.
   2. Click "Graph" → a full-canvas view opens and the vault SPAWNS IN slowly
      over ~3s: a few hub notes appear first, then more fade/scale in and drift
      outward from their neighbours until the layout settles (no explosion).
      Bigger (higher-degree) notes are larger. Ghost nodes are hollow.
   3. Hover a node → it + its neighbours stay bright, everything else dims;
      the node's title label shows.
   4. Wheel over the canvas → zoom in/out about the cursor. Drag the background
      → pan. Drag a node → it follows the cursor and pins while held, releasing
      it lets the sim resume.
   5. Click a node → its note opens as a card (or, with spawnApp absent, a
      toast/console line naming the note). Ghost nodes (no file) do nothing.
   6. Header ↻ re-fetches /vault/graph and replays the spawn-in. × closes.
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

  // ── tunables ───────────────────────────────────────────────────────────────
  const SPAWN_MS = 520;          // per-node fade/scale-in duration
  const REPULSE = 900;           // charge strength (Barnes-Hut)
  const THETA = 0.9;             // Barnes-Hut opening angle (accuracy vs speed)
  const LINK_LEN = 46;           // spring rest length
  const LINK_K = 0.035;          // spring stiffness
  const CENTER_K = 0.0016;       // centering gravity
  const DAMPING = 0.86;          // velocity damping per step
  const MAX_SPEED = 14;          // world units / step (clamp = no violent jumps)
  const REVEAL_WARM = 0.4;       // alpha floor while nodes are still spawning in

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }
  function smoothstep(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

  function mount(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'graph-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let nodes = [];               // all nodes (revealed incrementally)
    let edges = [];               // all edges
    let activeNodes = [];         // nodes revealed so far (in sim + draw)
    let activeEdges = [];         // edges with both endpoints revealed
    let byId = new Map();         // id -> node
    let edgesByNode = new Map();  // id -> [edge] (incident)
    const neighbours = new Map(); // id -> Set(neighbour ids) — for hover highlight

    let revealOrder = [];         // node refs, hub-first BFS
    let revealIdx = 0;            // how many revealed
    let revealStart = 0;          // ms
    let revealMs = 3000;          // total spawn-in duration

    let raf = 0;
    let alpha = 0.5;
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

    // Deterministic per-node jitter (no Math.random — stable across resumes).
    function jitter(i, span) {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      return ((a - Math.floor(a)) - 0.5) * span;
    }

    function prepare() {
      view = size();
      byId = new Map(nodes.map((n) => [n.id, n]));
      edgesByNode = new Map(nodes.map((n) => [n.id, []]));
      neighbours.clear();
      nodes.forEach((n) => {
        neighbours.set(n.id, new Set());
        n.revealed = false;
        n.born = 0;
        n.vx = 0;
        n.vy = 0;
        n.r = 4 + Math.sqrt(n.degree || 0) * 3;
      });
      edges.forEach((e) => {
        if (edgesByNode.has(e.source)) edgesByNode.get(e.source).push(e);
        if (edgesByNode.has(e.target)) edgesByNode.get(e.target).push(e);
        if (neighbours.has(e.source)) neighbours.get(e.source).add(e.target);
        if (neighbours.has(e.target)) neighbours.get(e.target).add(e.source);
      });

      // reveal order: highest-degree unvisited node as a BFS root, then outward
      // along links (neighbours by descending degree) — hubs first, then leaves.
      const deg = (id) => (byId.get(id) ? byId.get(id).degree || 0 : 0);
      const byDeg = nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0));
      const seen = new Set();
      revealOrder = [];
      for (const root of byDeg) {
        if (seen.has(root.id)) continue;
        const q = [root.id];
        seen.add(root.id);
        while (q.length) {
          const id = q.shift();
          revealOrder.push(byId.get(id));
          const nb = (edgesByNode.get(id) || [])
            .map((e) => (e.source === id ? e.target : e.source))
            .sort((x, y) => deg(y) - deg(x));
          for (const m of nb) {
            if (!seen.has(m) && byId.has(m)) { seen.add(m); q.push(m); }
          }
        }
      }

      activeNodes = [];
      activeEdges = [];
      revealIdx = 0;
      revealStart = nowMs();
      revealMs = Math.min(4200, 900 + nodes.length * 1.6);
      alpha = 0.5;
    }

    function revealNode(n) {
      if (n.revealed) return;
      n.revealed = true;
      n.born = nowMs();
      // seed next to already-revealed neighbours (grow out from the structure)
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      for (const e of edgesByNode.get(n.id) || []) {
        const o = byId.get(e.source === n.id ? e.target : e.source);
        if (o && o.revealed) { sx += o.x; sy += o.y; cnt++; }
      }
      const i = activeNodes.length;
      if (cnt) {
        n.x = sx / cnt + jitter(i * 2 + 1, 34);
        n.y = sy / cnt + jitter(i * 2 + 7, 34);
      } else {
        n.x = view.w / 2 + jitter(i * 2 + 1, 120);
        n.y = view.h / 2 + jitter(i * 2 + 7, 120);
      }
      n.vx = 0;
      n.vy = 0;
      activeNodes.push(n);
      // wire up any edges whose other endpoint is already revealed
      for (const e of edgesByNode.get(n.id) || []) {
        const o = byId.get(e.source === n.id ? e.target : e.source);
        if (o && o.revealed && o !== n) activeEdges.push(e);
      }
    }

    function advanceReveal() {
      if (revealIdx >= revealOrder.length) return false;
      const p = Math.min(1, (nowMs() - revealStart) / revealMs);
      const target = Math.ceil(smoothstep(p) * revealOrder.length);
      let changed = false;
      while (revealIdx < target && revealIdx < revealOrder.length) {
        revealNode(revealOrder[revealIdx]);
        revealIdx++;
        changed = true;
      }
      return revealIdx < revealOrder.length || changed;
    }

    // ── Barnes-Hut quadtree charge repulsion (O(n log n)) ──────────────────────
    function buildTree() {
      if (!activeNodes.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of activeNodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const sizeSq = Math.max(maxX - minX, maxY - minY, 1) + 2;
      const root = { x0: minX - 1, y0: minY - 1, s: sizeSq, mass: 0, cx: 0, cy: 0, body: null, kids: null };
      for (const n of activeNodes) insert(root, n, 0);
      return root;
    }
    function insert(node, b, depth) {
      // accumulate centre of mass
      node.cx = (node.cx * node.mass + b.x) / (node.mass + 1);
      node.cy = (node.cy * node.mass + b.y) / (node.mass + 1);
      node.mass += 1;
      if (node.body === null && node.kids === null) { node.body = b; return; }
      if (node.kids === null) {
        node.kids = [null, null, null, null];
        const existing = node.body;
        node.body = null;
        placeInKid(node, existing, depth);
      }
      if (depth < 20) placeInKid(node, b, depth);
    }
    function placeInKid(node, b, depth) {
      const half = node.s / 2;
      const right = b.x >= node.x0 + half ? 1 : 0;
      const bottom = b.y >= node.y0 + half ? 1 : 0;
      const q = bottom * 2 + right;
      let kid = node.kids[q];
      if (!kid) {
        kid = {
          x0: node.x0 + right * half, y0: node.y0 + bottom * half, s: half,
          mass: 0, cx: 0, cy: 0, body: null, kids: null,
        };
        node.kids[q] = kid;
      }
      insert(kid, b, depth + 1);
    }
    function applyRepulsion(node, b) {
      if (!node || node.mass === 0) return;
      const dx = b.x - node.cx;
      const dy = b.y - node.cy;
      let d2 = dx * dx + dy * dy;
      if (node.kids === null) {
        if (node.body === b || node.body === null) return;
        if (d2 < 1) d2 = 1;
        const f = (REPULSE * node.mass * alpha) / d2;
        const d = Math.sqrt(d2);
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
        return;
      }
      // far enough to approximate this cell by its centre of mass?
      if ((node.s * node.s) < THETA * THETA * d2) {
        if (d2 < 1) d2 = 1;
        const f = (REPULSE * node.mass * alpha) / d2;
        const d = Math.sqrt(d2);
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
        return;
      }
      for (let i = 0; i < 4; i++) if (node.kids[i]) applyRepulsion(node.kids[i], b);
    }

    function step() {
      const spawning = advanceReveal();
      const cx = view.w / 2;
      const cy = view.h / 2;

      const tree = buildTree();
      if (tree) for (const n of activeNodes) applyRepulsion(tree, n);

      // link springs
      for (const e of activeEdges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - LINK_LEN) * LINK_K * alpha;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f; a.vy += uy * f;
        b.vx -= ux * f; b.vy -= uy * f;
      }

      // centering gravity + integrate (with velocity clamp)
      for (const n of activeNodes) {
        if (n === dragNode) continue;
        n.vx += (cx - n.x) * CENTER_K * alpha;
        n.vy += (cy - n.y) * CENTER_K * alpha;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (sp > MAX_SPEED) { n.vx = (n.vx / sp) * MAX_SPEED; n.vy = (n.vy / sp) * MAX_SPEED; }
        n.x += n.vx;
        n.y += n.vy;
      }

      // keep the sim warm while spawning, then cool to rest
      if (spawning) alpha = Math.max(alpha, REVEAL_WARM);
      else alpha *= 0.985;
      return spawning;
    }

    function draw() {
      const edgeCol = cssVar('--line', 'rgba(120,120,120,0.35)');
      const nodeCol = cssVar('--accent', '#c98a5e');
      const inkCol = cssVar('--ink', '#333');
      const t = nowMs();
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      const active = hoverNode ? (neighbours.get(hoverNode.id) || new Set()) : null;

      // edges
      for (const e of activeEdges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const grow = Math.min(spawnT(a, t), spawnT(b, t));
        const lit = !hoverNode || a === hoverNode || b === hoverNode;
        ctx.globalAlpha = (lit ? 0.5 : 0.07) * grow;
        ctx.strokeStyle = edgeCol;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // nodes
      for (const n of activeNodes) {
        const grow = spawnT(n, t);
        const lit = !hoverNode || n === hoverNode || (active && active.has(n.id));
        const r = n.r * easeOutCubic(grow);
        ctx.globalAlpha = (lit ? 1 : 0.2) * grow;
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.max(0.5, r), 0, Math.PI * 2);
        if (n.ghost) {
          ctx.strokeStyle = nodeCol;
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
        } else {
          ctx.fillStyle = nodeCol;
          ctx.fill();
        }
        if (grow > 0.6 && lit && (hoverNode || scale > 1.4)) {
          ctx.globalAlpha = 0.9 * grow;
          ctx.fillStyle = inkCol;
          ctx.font = (11 / scale) + 'px system-ui, sans-serif';
          ctx.fillText(n.title || n.id, n.x + r + 2 / scale, n.y + 3 / scale);
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function spawnT(n, t) {
      if (!n.born) return 0;
      return Math.min(1, (t - n.born) / SPAWN_MS);
    }

    function frame() {
      if (disposed) return;
      const spawning = step();
      draw();
      // keep animating while spawning in or still spawn-fading; rest when calm
      const fading = activeNodes.length && spawnT(activeNodes[activeNodes.length - 1], nowMs()) < 1;
      if (!spawning && !fading && alpha < 0.004 && !dragNode) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }

    function kick() {
      alpha = Math.max(alpha, 0.3);
      if (!raf) frame();
    }

    function pickNode(sx, sy) {
      const w = toWorld(sx, sy);
      for (let i = activeNodes.length - 1; i >= 0; i--) {
        const n = activeNodes[i];
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
      if (!raf) { draw(); }        // repaint even when settled
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
        if (!raf) draw();
      } else {
        const prevHover = hoverNode;
        hoverNode = pickNode(sx, sy);
        canvas.style.cursor = hoverNode ? 'pointer' : 'default';
        if (hoverNode !== prevHover) { if (raf) { /* live */ } else draw(); }
      }
    }
    function onUp() {
      if (dragNode && !dragNode.moved) openNote(dragNode);
      dragNode = null;
      panning = false;
    }
    function onResize() { view = size(); if (!raf) draw(); }

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
          // A missing / unreadable vault root comes back as an explicit error
          // (503), not an empty graph — draw the reason, because a blank
          // canvas reads as "your vault has no notes".
          if (d && d.error) {
            ctx.fillStyle = cssVar('--ink-dim', '#999');
            ctx.font = '13px system-ui, sans-serif';
            ctx.fillText(String(d.error).slice(0, 140), 20, 30);
            return;
          }
          nodes = (d.nodes || []).map((n) => Object.assign({}, n));
          edges = (d.edges || []).slice();
          prepare();
          if (!raf) frame();
        })
        .catch(() => {
          ctx.fillStyle = cssVar('--ink-dim', '#999');
          ctx.font = '13px system-ui, sans-serif';
          ctx.fillText("Graph unavailable. Can't reach Atelier.", 20, 30);
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
