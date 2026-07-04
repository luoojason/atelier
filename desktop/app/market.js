'use strict';

/* ===========================================================================
   Atelier feature module — Playbook marketplace   (app/market.js)

   A recipes-style card gallery for SHAREABLE Playbooks. A "Playbook" is a
   portable little JSON that describes how to reproduce a board's work — at
   minimum { title, prompt } (the orchestrator kickoff), optionally a recipe
   reference. This module lets you:

     • browse a few tasteful BUNDLED starter Playbooks (embedded below),
     • see YOUR OWN saved Playbooks (read via window.AtelierPlaybook.list()),
     • Import a shared Playbook (a .json file or pasted text),
     • Run one (spawns an orchestrator and drives it), and
     • Share/Export one of yours back out as a .json file.

   HONEST framing: this is not a store. There are no prices, no transactions,
   and nothing is hosted anywhere. It is browse + import + run + share-a-file,
   and the UI says exactly that.

   Persistence + running are DELEGATED to window.AtelierPlaybook (its own
   module, built to a shared contract). market.js owns NO storage key and
   edits no other file. Every AtelierPlaybook call is feature-detected, so if
   that module is absent the gallery still browses — Run / Import / Share just
   disable themselves with a plain-English note.

   Not a "front door": unlike recipes.js this never auto-opens on an empty
   board. It opens only from its dock glyph or the ⌘K palette.

   Contract: builds ONLY against window.Atelier. Injects its own CSS.
   XSS rule: every dynamic string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.canvas || !A.store || !A.ui) {
    console.warn('[market] Atelier core not available — skipping.');
    return;
  }

  const OVERLAY_Z = 4000; // matches recipes.js — above any realistic raised card

  // ── bundled starter Playbooks (embedded) ───────────────────────────────────
  // Each: { id, name, blurb, category, def:{ title, prompt } }.
  // The def is the exact portable shape window.AtelierPlaybook stores + runs.
  const STARTERS = [
    {
      id: 'starter-top5-video',
      name: 'Top-5 countdown video',
      blurb: 'Research the 5 best of a topic and render a ready-to-post countdown video.',
      category: 'Content',
      def: {
        title: 'Top-5 countdown video',
        prompt: 'You are the orchestrator for a small team that makes a Top-5 countdown video. Work in three steps and use SpawnAgent for each.\n\n1) SpawnAgent a Researcher: use WebSearch and WebFetch to find the 5 best of the topic, capturing a real checkable detail and one clear reason for each. Save the findings.\n\n2) SpawnAgent a Maker: turn the picks into a punchy countdown script (#5 down to #1, a strong hook up top), then hand it to the ranking video pipeline at workspace/video-making/ranking to render the MP4.\n\n3) SpawnAgent a Publisher: confirm the video rendered, save it with a suggested title and description, and tell me the exact file path.\n\nKeep every detail factual, no invented specs.',
      },
    },
    {
      id: 'starter-reddit-video',
      name: 'Reddit story to video',
      blurb: 'Pick one genuinely engaging Reddit story and turn it into a captioned vertical video.',
      category: 'Content',
      def: {
        title: 'Reddit story to video',
        prompt: 'You are the orchestrator for a small team that turns a Reddit story into a video. Work in three steps and use SpawnAgent for each.\n\n1) SpawnAgent a Researcher: pull recent top posts from a chosen subreddit via its Reddit RSS feed. Pick ONE story that is genuinely engaging, has a clear beginning-middle-end, and is safe to narrate. Lightly clean it up for read-aloud and save the narration text.\n\n2) SpawnAgent a Maker: hand that text to the Reddit-story video pipeline at workspace/video-making/reddit to render the vertical, captioned video.\n\n3) SpawnAgent a Publisher: confirm the MP4 rendered, save it with a scroll-stopping hook title and a few hashtags, and report the exact file path.\n\nUse a real post, never a made-up one.',
      },
    },
    {
      id: 'starter-etsy-listings',
      name: 'Etsy listings pack',
      blurb: 'Three keyword-optimized, ready-to-paste Etsy listings for a product.',
      category: 'Small Business',
      def: {
        title: 'Etsy listings pack',
        prompt: 'You are the orchestrator for a research-write-save team that creates Etsy listings for a product. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to study top-selling listings for the product — the keywords buyers search, title patterns that rank, and price ranges that sell. Save the notes.\n\n2) SpawnAgent a Maker: write 3 ready-to-paste listings. Each needs an SEO title under 140 characters, 13 tags, a warm description with a short story plus bullet features, and a suggested price.\n\n3) SpawnAgent a Publisher: save all three as one file and tell me the exact path.\n\nNo invented claims about materials or shipping — leave clearly marked blanks for anything unknown.',
      },
    },
    {
      id: 'starter-social-week',
      name: 'A week of social posts',
      blurb: 'Seven days of captions, hashtags, and shot ideas for a business.',
      category: 'Small Business',
      def: {
        title: 'A week of social posts',
        prompt: 'You are the orchestrator for a research-write-save team that plans one week of social posts for a business. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to find current trends, hooks, and popular hashtags for a business like this on the chosen platform. Save the notes.\n\n2) SpawnAgent a Maker: write 7 posts, one per day. Each needs a caption, a clear call to action, 5-10 hashtags, and a one-line note on what to shoot. Vary the types across the week.\n\n3) SpawnAgent a Publisher: save the week as a simple day-by-day file and tell me the exact path.\n\nKeep the voice friendly and human, not salesy.',
      },
    },
    {
      id: 'starter-market-scan',
      name: 'Market opportunity scan',
      blurb: 'A sourced report of what is selling in a niche and where the open gaps are.',
      category: 'Research',
      def: {
        title: 'Market opportunity scan',
        prompt: 'You are the orchestrator for a research team that finds what is selling right now in a niche. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch and WebFetch to find trending products, best-seller signals, typical price points, and common buyer complaints. Pull from trend pages, seller blogs, and relevant subreddit RSS feeds. Save every source.\n\n2) SpawnAgent a Maker: write a short opportunity report — the top 10 product ideas ranked by demand versus competition, a price band for each, and 3 angles nobody covers well yet.\n\n3) SpawnAgent a Publisher: save the report and tell me the path.\n\nOnly include an idea if a real source backs it, and mark how confident you are in each.',
      },
    },
    {
      id: 'starter-game-night',
      name: 'Game-night run-of-show',
      blurb: 'Games, snacks, a playlist, and a shopping list for a fun night in.',
      category: 'Just for Fun',
      def: {
        title: 'Game-night run-of-show',
        prompt: 'You are the orchestrator for a research-plan-save team that plans a great game night. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch for ideas that fit the group — games that work well for the headcount, easy crowd-pleasing snacks, a light theme, and a playlist vibe. Save the best finds.\n\n2) SpawnAgent a Maker: write a simple run-of-show — a rough timeline, 4-5 games with quick rules, a snack menu with a plain shopping list, and a playlist idea.\n\n3) SpawnAgent a Publisher: save it as a one-page plan and tell me the path.\n\nKeep everything low-effort and cheap to pull off.',
      },
    },
  ];

  // ── small helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Feature-detect the shared Playbook module every time (it may load later).
  function pb() {
    const P = window.AtelierPlaybook;
    if (!P) return null;
    return {
      canRun: typeof P.run === 'function',
      canSave: typeof P.save === 'function',
      canList: typeof P.list === 'function',
      canRemove: typeof P.remove === 'function',
      canExport: typeof P.exportOne === 'function',
      canImport: typeof P.importJson === 'function',
      canOpen: typeof P.open === 'function',
      raw: P,
    };
  }

  function toast(msg) {
    if (A.ui && typeof A.ui.toast === 'function') A.ui.toast(msg);
  }

  function safeName(name) {
    return String(name || 'playbook').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'playbook';
  }

  function downloadJson(name, jsonString) {
    try {
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName(name) + '.playbook.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch {
      return false;
    }
  }

  // ── injected CSS (mirrors recipes.js tokens + card look) ───────────────────
  (function injectStyles() {
    if (document.getElementById('atl-market-styles')) return;
    const css = `
      .atl-market-overlay { position: absolute; inset: 0; z-index: ${OVERLAY_Z};
        display: flex; flex-direction: column; background: var(--canvas);
        animation: atl-market-fade .18s ease; }
      @keyframes atl-market-fade { from { opacity: 0; } to { opacity: 1; } }
      .canvas--market .dock, .canvas--market .zoombar, .canvas--market .minimap { display: none; }
      body:has(.canvas--market) .wgt-add-btn { display: none; }

      .atl-market-head { flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
        padding: 16px 24px; border-bottom: 1px solid var(--border-soft); }
      .atl-market-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .atl-market-brand .mark { width: 26px; height: 26px; border-radius: 8px; flex: 0 0 26px;
        background: linear-gradient(150deg, #d0714a, #b34a26); color: #fff; font-weight: 700;
        display: flex; align-items: center; justify-content: center; font-size: 14px;
        box-shadow: 0 4px 16px rgba(180, 74, 38, 0.35); }
      .atl-market-brand .ttl { font-size: 15px; font-weight: 700; color: var(--ink); }
      .atl-market-brand .sub { font-size: 12.5px; color: var(--ink-dim); }
      .atl-market-head-sp { flex: 1; }
      .atl-market-x { border: 1px solid var(--border); background: var(--panel);
        color: var(--ink-mid); border-radius: 8px; padding: 7px 12px; cursor: pointer;
        font: inherit; font-size: 12.5px; font-weight: 600; }
      .atl-market-x:hover { background: var(--active); color: var(--ink); }

      .atl-market-scroll { flex: 1; overflow-y: auto; padding: 24px; }
      .atl-market-inner { width: 100%; max-width: 940px; margin: 0 auto;
        display: flex; flex-direction: column; gap: 22px; }

      .atl-market-hero { text-align: center; display: flex; flex-direction: column; gap: 6px; }
      .atl-market-hero h1 { font-size: 26px; font-weight: 800; color: var(--ink); margin: 0; }
      .atl-market-hero p { font-size: 14px; color: var(--ink-mid); margin: 0; }

      .atl-market-note { font-size: 12.5px; color: var(--ink-dim); background: var(--panel);
        border: 1px dashed var(--border); border-radius: var(--radius); padding: 10px 14px;
        line-height: 1.45; }

      .atl-market-import { display: flex; gap: 10px; align-items: stretch;
        background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow-sm); padding: 10px; flex-wrap: wrap; }
      .atl-market-import textarea { flex: 1; min-width: 200px; min-height: 44px; resize: vertical;
        border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: inherit;
        font-size: 13px; color: var(--ink); background: #faf7f1; outline: none; }
      .atl-market-import textarea:focus { border-color: var(--accent); }
      .atl-market-import-btns { display: flex; flex-direction: column; gap: 8px; }

      .atl-market-btn { border: none; border-radius: 10px; background: var(--accent); color: #fff;
        padding: 10px 16px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
        white-space: nowrap; }
      .atl-market-btn:hover { background: var(--accent-2); }
      .atl-market-btn:disabled { opacity: .5; cursor: default; }
      .atl-market-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); font-weight: 600; }
      .atl-market-btn.ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--ink); }
      .atl-market-btn.sm { padding: 7px 12px; font-size: 12px; }

      .atl-market-cat { display: flex; flex-direction: column; gap: 12px; }
      .atl-market-cat-h { font-size: 12px; text-transform: uppercase; letter-spacing: .07em;
        font-weight: 700; color: var(--ink-dim); }
      .atl-market-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 14px; }

      .atl-market-card { text-align: left; background: var(--panel); border: 1px solid var(--border);
        border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 16px;
        display: flex; flex-direction: column; gap: 8px;
        transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease; }
      .atl-market-card:hover { transform: translateY(-3px); border-color: var(--accent);
        box-shadow: var(--shadow); }
      .atl-market-card:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-market-title { font-size: 15px; font-weight: 700; color: var(--ink); }
      .atl-market-blurb { font-size: 13px; color: var(--ink-mid); line-height: 1.45; flex: 1; }
      .atl-market-actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }

      .atl-market-empty { font-size: 13px; color: var(--ink-dim); padding: 4px 2px; }

      @media (prefers-reduced-motion: reduce) {
        .atl-market-overlay { animation: none; }
        .atl-market-card { transition: none; }
        .atl-market-card:hover { transform: none; }
      }
    `;
    const style = el('style');
    style.id = 'atl-market-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── overlay state ────────────────────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  let overlayRoot = null;
  let scrollHost = null;
  let isOpen = false;
  let fileInput = null;

  // ── card builders ────────────────────────────────────────────────────────────
  function starterCard(item) {
    const P = pb();
    const card = el('div', 'atl-market-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', item.name + '. ' + item.blurb);
    card.appendChild(el('div', 'atl-market-title', item.name));
    card.appendChild(el('div', 'atl-market-blurb', item.blurb));

    const actions = el('div', 'atl-market-actions');

    const run = el('button', 'atl-market-btn sm', 'Run');
    run.type = 'button';
    if (P && P.canRun) {
      run.title = 'Build a team and run this Playbook now';
      run.addEventListener('click', () => runDef(item.def));
    } else {
      run.disabled = true;
      run.title = 'Open the Playbooks panel to run this';
    }
    actions.appendChild(run);

    const save = el('button', 'atl-market-btn ghost sm', 'Save to mine');
    save.type = 'button';
    if (P && P.canSave) {
      save.title = 'Copy this into your saved Playbooks';
      save.addEventListener('click', () => {
        try {
          P.raw.save(item.name, cloneDef(item.def));
          toast('Saved “' + item.name + '” to your Playbooks.');
          renderGallery();
        } catch {
          toast('Could not save that Playbook.');
        }
      });
    } else {
      save.disabled = true;
      save.title = 'Playbooks module unavailable';
    }
    actions.appendChild(save);

    card.appendChild(actions);
    return card;
  }

  function userCard(entry) {
    // entry: { id, name, def, ts } from AtelierPlaybook.list()
    const P = pb();
    const def = entry && entry.def ? entry.def : {};
    const name = (entry && entry.name) || (def && def.title) || 'Untitled Playbook';
    const blurb = (def && def.prompt) ? String(def.prompt).slice(0, 120) + (def.prompt.length > 120 ? '…' : '') : 'A saved Playbook.';

    const card = el('div', 'atl-market-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', name);
    card.appendChild(el('div', 'atl-market-title', name));
    card.appendChild(el('div', 'atl-market-blurb', blurb));

    const actions = el('div', 'atl-market-actions');

    const run = el('button', 'atl-market-btn sm', 'Run');
    run.type = 'button';
    if (P && P.canRun && entry && entry.id != null) {
      run.addEventListener('click', () => {
        try { P.raw.run(entry.id); closeOverlay(); }
        catch { toast('Could not run that Playbook.'); }
      });
    } else {
      run.disabled = true;
      run.title = 'Open the Playbooks panel to run this';
    }
    actions.appendChild(run);

    const share = el('button', 'atl-market-btn ghost sm', 'Share');
    share.type = 'button';
    if (P && P.canExport && entry && entry.id != null) {
      share.title = 'Export this Playbook as a shareable .json file';
      share.addEventListener('click', () => {
        try {
          const json = P.raw.exportOne(entry.id);
          if (json && downloadJson(name, json)) toast('Exported “' + name + '”.');
          else toast('Nothing to export.');
        } catch {
          toast('Could not export that Playbook.');
        }
      });
    } else {
      share.disabled = true;
      share.title = 'Sharing unavailable';
    }
    actions.appendChild(share);

    if (P && P.canRemove && entry && entry.id != null) {
      const del = el('button', 'atl-market-btn ghost sm', 'Remove');
      del.type = 'button';
      del.title = 'Delete this Playbook from your list';
      del.addEventListener('click', () => {
        try { P.raw.remove(entry.id); renderGallery(); }
        catch { toast('Could not remove that Playbook.'); }
      });
      actions.appendChild(del);
    }

    card.appendChild(actions);
    return card;
  }

  function cloneDef(def) {
    try { return JSON.parse(JSON.stringify(def)); }
    catch { return { title: def && def.title, prompt: def && def.prompt }; }
  }

  // ── run a bundled def directly (delegates the whole run to AtelierPlaybook) ──
  function runDef(def) {
    const P = pb();
    if (!P || !P.canRun) { toast('Open the Playbooks panel to run this.'); return; }
    try {
      if (P.canSave) {
        // Reproduce the same way user Playbooks run: persist, then run by id.
        const id = P.raw.save(def.title || 'Playbook', cloneDef(def));
        P.raw.run(id);
      } else {
        P.raw.run(cloneDef(def));
      }
      closeOverlay();
    } catch {
      toast('Could not start that Playbook.');
    }
  }

  // ── import a shared Playbook (paste text or a .json file) ───────────────────
  function importText(text) {
    const P = pb();
    if (!P || !P.canImport) { toast('Importing is unavailable — open the Playbooks panel.'); return; }
    const t = String(text || '').trim();
    if (!t) { toast('Paste a Playbook JSON first.'); return; }
    try {
      const id = P.raw.importJson(t);
      if (id == null) { toast('That did not look like a Playbook.'); return; }
      toast('Imported. It is in your Playbooks now.');
      renderGallery();
    } catch {
      toast('That JSON could not be imported.');
    }
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => importText(String(reader.result || ''));
      reader.onerror = () => toast('Could not read that file.');
      reader.readAsText(f);
    });
    document.body.appendChild(fileInput);
    return fileInput;
  }

  // ── gallery ──────────────────────────────────────────────────────────────────
  function categoriesInOrder() {
    const seen = [];
    STARTERS.forEach((s) => { if (seen.indexOf(s.category) === -1) seen.push(s.category); });
    return seen;
  }

  function buildGallery() {
    const P = pb();
    const inner = el('div', 'atl-market-inner');

    const hero = el('div', 'atl-market-hero');
    hero.appendChild(el('h1', null, 'Playbook marketplace'));
    hero.appendChild(el('p', null, 'Browse, import, run, and share Playbooks. No prices, no accounts, nothing hosted — just files you can pass around.'));
    inner.appendChild(hero);

    if (!P) {
      inner.appendChild(el('div', 'atl-market-note',
        'The Playbooks panel is not loaded, so running, saving, importing, and sharing are turned off. You can still browse the starters below.'));
    }

    // Import row
    const imp = el('div', 'atl-market-import');
    const ta = document.createElement('textarea');
    ta.placeholder = 'Paste a shared Playbook JSON here…';
    ta.setAttribute('aria-label', 'Paste a shared Playbook JSON');
    const btns = el('div', 'atl-market-import-btns');
    const importBtn = el('button', 'atl-market-btn', 'Import pasted');
    importBtn.type = 'button';
    const fileBtn = el('button', 'atl-market-btn ghost', 'Import a file');
    fileBtn.type = 'button';
    if (P && P.canImport) {
      importBtn.addEventListener('click', () => importText(ta.value));
      fileBtn.addEventListener('click', () => ensureFileInput().click());
    } else {
      importBtn.disabled = true; importBtn.title = 'Importing unavailable';
      fileBtn.disabled = true; fileBtn.title = 'Importing unavailable';
      ta.disabled = true;
    }
    btns.append(importBtn, fileBtn);
    imp.append(ta, btns);
    inner.appendChild(imp);

    // Your Playbooks
    const mine = el('div', 'atl-market-cat');
    mine.appendChild(el('div', 'atl-market-cat-h', 'Your Playbooks'));
    let entries = [];
    if (P && P.canList) {
      try { entries = P.raw.list() || []; } catch { entries = []; }
    }
    if (!P || !P.canList) {
      mine.appendChild(el('div', 'atl-market-empty', 'Open the Playbooks panel to see the ones you have saved.'));
    } else if (!entries.length) {
      mine.appendChild(el('div', 'atl-market-empty', 'Nothing saved yet. Save a starter below or import a shared file to get started.'));
    } else {
      const grid = el('div', 'atl-market-grid');
      entries.forEach((e) => grid.appendChild(userCard(e)));
      mine.appendChild(grid);
    }
    inner.appendChild(mine);

    // Bundled starters, grouped by category
    categoriesInOrder().forEach((cat) => {
      const sec = el('div', 'atl-market-cat');
      sec.appendChild(el('div', 'atl-market-cat-h', cat));
      const grid = el('div', 'atl-market-grid');
      STARTERS.filter((s) => s.category === cat).forEach((s) => grid.appendChild(starterCard(s)));
      sec.appendChild(grid);
      inner.appendChild(sec);
    });

    return inner;
  }

  function renderGallery() {
    if (!scrollHost) return;
    scrollHost.textContent = '';
    scrollHost.appendChild(buildGallery());
  }

  // ── open / close ─────────────────────────────────────────────────────────────
  function ensureOverlay() {
    if (overlayRoot) return overlayRoot;
    const root = el('div', 'atl-market-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Playbook marketplace');
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('dblclick', (e) => e.stopPropagation());

    const head = el('div', 'atl-market-head');
    const brand = el('div', 'atl-market-brand');
    brand.appendChild(el('span', 'mark', 'A'));
    const bt = el('div');
    bt.appendChild(el('div', 'ttl', 'Playbook marketplace'));
    bt.appendChild(el('div', 'sub', 'Browse · import · run · share a file'));
    brand.appendChild(bt);
    const sp = el('div', 'atl-market-head-sp');
    const close = el('button', 'atl-market-x', 'Close');
    close.type = 'button';
    close.title = 'Close the marketplace';
    close.addEventListener('click', () => closeOverlay());
    head.append(brand, sp, close);

    const scroll = el('div', 'atl-market-scroll');
    scrollHost = scroll;

    root.append(head, scroll);
    overlayRoot = root;
    return root;
  }

  function openOverlay() {
    if (isOpen || !canvas) return;
    ensureOverlay();
    renderGallery();
    canvas.appendChild(overlayRoot);
    canvas.classList.add('canvas--market');
    isOpen = true;
    updateDockActive();
  }

  function closeOverlay() {
    if (!isOpen) return;
    if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot);
    if (canvas) canvas.classList.remove('canvas--market');
    isOpen = false;
    updateDockActive();
  }

  // ── dock button + palette command ──────────────────────────────────────────
  let dockBtn = null;
  function updateDockActive() {
    if (dockBtn) dockBtn.classList.toggle('active', isOpen);
  }
  (function addDockButton() {
    const dock = document.querySelector('.dock');
    if (!dock) return;
    // apps.js clone-replaces the builtin dock buttons at init; appending afterwards
    // (this module loads last, after recipes.js) keeps only our handler + order.
    dockBtn = document.createElement('button');
    dockBtn.className = 'dock-btn';
    dockBtn.title = 'Marketplace';
    dockBtn.textContent = '🛒';
    dockBtn.setAttribute('aria-label', 'Open the Playbook marketplace');
    dockBtn.addEventListener('click', () => {
      if (isOpen) closeOverlay(); else openOverlay();
    });
    dock.appendChild(dockBtn);
  })();

  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'market.open', label: 'Marketplace', icon: '🛒', section: 'Create',
      keywords: 'marketplace playbook share import run browse template gallery',
      run() { openOverlay(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand); // covers palette.js loading later

  // Re-detect the Playbook module if it loads after us; refresh if open.
  A.bus.on('playbook:ready', () => { if (isOpen) renderGallery(); });

  A.bus.on('shortcut:escape', () => { if (isOpen) closeOverlay(); });

  // ── public surface + self-check ─────────────────────────────────────────────
  window.AtelierMarket = {
    open: openOverlay,
    close: closeOverlay,
    isOpen: () => isOpen,
    starters: STARTERS,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierMarket && typeof window.AtelierMarket.open === 'function');
    const hasStarters = Array.isArray(STARTERS) && STARTERS.length > 0;
    console.assert(registered, '[market] module did not register window.AtelierMarket');
    console.assert(hasStarters, '[market] no starter playbooks embedded');
    if (registered && hasStarters) {
      console.log('[market] self-check passed — ' + STARTERS.length + ' starter playbooks, marketplace ready.');
    }
  })();
})();
