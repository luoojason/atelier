'use strict';

/* ===========================================================================
   Atelier feature module — Recipe gallery front door   (app/recipes.js)

   A full-canvas, dismissible "front door" that greets an EMPTY board with a
   gallery of ready-to-run recipes (Top-5 video, Reddit story, Etsy listings,
   realtor packages, side-hustle picks, and so on). Pick one, fill a couple of
   blanks, hit Go, and it spawns an orchestrator agent card and drives it —
   the plain-English composer text is written for you, and a progress strip
   narrates the run ("Researching… Making it… Ready to review").

   Why an overlay and not a "view"
   -------------------------------
   views.js "views" are sidebar-nav analytics dashboards persisted to
   'view.current' and closed on board switch. A front door is none of those,
   so this mounts its OWN overlay into #canvas (mirroring views.js's proven
   .view-overlay mechanics: stop canvas gestures, hide the dock/zoombar/minimap
   while open) at a z-index that beats any raised card.

   When it shows
   -------------
   Only when the active board has NO user-created cards (the two static
   builtins — metrics + chat — don't count). Evaluated on first load and on
   every board switch; auto-dismisses the instant a user card appears and
   re-offers itself when the board empties again. Never covers real work.
   A per-session flag (sessionStorage) remembers a manual dismiss so it does
   not nag; the dock "Recipes" button and the ⌘K palette re-open it any time.

   Contract: builds ONLY against window.Atelier (+ fetch and the optional
   window.atelier token bridge for the progress strip). Injects its own CSS.
   XSS rule: every dynamic string enters the DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.canvas || !A.store || !A.ui) {
    console.warn('[recipes] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const OVERLAY_Z = 4000;            // above any realistic raised-card z-index
  const MOUNT_WAIT_MS = 1600;        // let the agent card's session settle (double-POST guard)
  const POLL_MS = 1500;              // run-status poll cadence
  const DISMISS_KEY = 'atelier-recipes-dismissed'; // sessionStorage, raw (per session)

  // ── recipe catalog (embedded) ──────────────────────────────────────────────
  const RECIPES = [
    {
      id: 'top-5-video',
      title: 'Make a Top-5 video',
      blurb: 'Countdown the 5 best of anything and get a ready-to-post video.',
      category: 'Faceless Channel',
      blanks: [
        { key: 'topic', label: 'What should the Top-5 be about?', placeholder: 'best budget wireless earbuds' },
        { key: 'vibe', label: 'Tone (optional)', placeholder: 'upbeat and helpful' },
      ],
      promptTemplate: 'You are the orchestrator for a small team that makes a Top-5 countdown video about {{topic}}, in a {{vibe}} tone. Work in three steps and use SpawnAgent for each.\n\n1) SpawnAgent a Researcher: use WebSearch and WebFetch to find the 5 best {{topic}}, and for each one capture a real, checkable detail (price, spec, or fact) plus one clear reason it earns its spot. Save the findings as a notes file in the workspace.\n\n2) SpawnAgent a Maker: turn those 5 picks into a punchy ranking script that counts down from #5 to #1 (one or two lines each, a strong hook at the top), then hand the script to the ranking video pipeline at workspace/video-making/ranking to render the MP4.\n\n3) SpawnAgent a Publisher: confirm the video actually rendered, save it in the workspace along with a suggested title and description, and tell me the exact file path.\n\nKeep every detail factual, no invented specs. If the research is thin, narrow the topic to something you can back up.',
    },
    {
      id: 'reddit-story-video',
      title: 'Turn a Reddit story into a video',
      blurb: 'Turn a viral Reddit story into a captioned vertical video.',
      category: 'Faceless Channel',
      blanks: [
        { key: 'source', label: 'What kind of stories?', placeholder: 'r/tifu' },
      ],
      promptTemplate: 'You are the orchestrator for a small team that turns a Reddit story into a video, sourced from {{source}}. Work in three steps and use SpawnAgent for each.\n\n1) SpawnAgent a Researcher: pull recent top posts from {{source}} using WebFetch on its Reddit RSS feed. Pick ONE story that is genuinely engaging, has a clear beginning-middle-end, and is safe to narrate (no slurs, no doxxing, no naming private people). Lightly clean it up for read-aloud and save the final narration text as a file.\n\n2) SpawnAgent a Maker: hand that narration text to the Reddit-story video pipeline at workspace/video-making/reddit to render the vertical, captioned video.\n\n3) SpawnAgent a Publisher: confirm the MP4 rendered, save it with a scroll-stopping hook title and a few hashtags, and report the exact file path.\n\nUse a real post, never a made-up one. If nothing good is in the feed, say so instead of forcing it.',
    },
    {
      id: 'plan-faceless-channel',
      title: 'Plan my faceless channel',
      blurb: 'Get a channel name, format, posting schedule, and 30 video ideas.',
      category: 'Faceless Channel',
      blanks: [
        { key: 'niche', label: "What's your channel about?", placeholder: 'scary ocean facts' },
        { key: 'platform', label: 'Where will you post?', placeholder: 'YouTube Shorts + TikTok' },
      ],
      promptTemplate: 'You are the orchestrator for a research-plan-save team that plans a faceless {{niche}} channel for {{platform}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to see what\'s working in the {{niche}} space right now. Find 5-8 channels or accounts, note their video format, posting frequency, and which types of videos pull the most views. Save the notes.\n\n2) SpawnAgent a Maker: write a simple channel plan: a channel name idea and handle, the single format that best fits the built-in video pipelines (Top-5 ranking at workspace/video-making/ranking, or Reddit-story at workspace/video-making/reddit), a realistic posting schedule, and 30 specific video title ideas ready to film.\n\n3) SpawnAgent a Publisher: save the plan as a clean file in the workspace, tell me the path, and flag the 5 titles I should film first.\n\nGround the recommendations in what you actually found, not guesses.',
    },
    {
      id: 'etsy-listings',
      title: 'Write my Etsy listings',
      blurb: 'Get 3 keyword-optimized, ready-to-paste Etsy listings.',
      category: 'Small Business & Etsy',
      blanks: [
        { key: 'product', label: 'What are you selling?', placeholder: 'hand-poured soy candles' },
        { key: 'shop', label: 'Shop name (optional)', placeholder: 'Willow & Wick' },
      ],
      promptTemplate: 'You are the orchestrator for a research-write-save team that creates Etsy listings for {{product}} for the shop {{shop}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to study top-selling Etsy listings for {{product}}. Note the keywords buyers search, the title patterns that rank, and the price ranges that sell. Save the notes.\n\n2) SpawnAgent a Maker: write 3 ready-to-paste listings. Each needs an SEO title (under 140 characters), 13 tags, a warm description with a short story plus bullet-point features, and a suggested price.\n\n3) SpawnAgent a Publisher: save all three listings as one file in the workspace and tell me the exact path.\n\nNo invented claims about materials, sourcing, or shipping. If a detail isn\'t known, leave a clearly marked blank for me to fill.',
    },
    {
      id: 'etsy-market-research',
      title: "Find what's selling right now",
      blurb: "See what's actually selling and where the open gaps are.",
      category: 'Small Business & Etsy',
      blanks: [
        { key: 'niche', label: 'What niche or category?', placeholder: 'cottagecore home decor' },
      ],
      promptTemplate: 'You are the orchestrator for a research team that finds what\'s selling right now in {{niche}} on Etsy. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch and WebFetch to find trending {{niche}} products, best-seller signals, typical price points, and things buyers complain about. Pull from Etsy trend pages, seller blogs, and relevant subreddit discussions via their RSS feeds. Save every source.\n\n2) SpawnAgent a Maker: write a short opportunity report: the top 10 product ideas ranked by demand versus competition, a price band for each, and 3 angles nobody is covering well yet.\n\n3) SpawnAgent a Publisher: save the report as a file in the workspace and tell me the path.\n\nOnly include a product idea if a real source backs it, and mark how confident you are in each one.',
    },
    {
      id: 'week-of-social-posts',
      title: 'Plan a week of social posts',
      blurb: 'Seven days of captions, hashtags, and shot ideas, done for you.',
      category: 'Small Business & Etsy',
      blanks: [
        { key: 'business', label: "What's your business?", placeholder: 'a downtown coffee shop' },
        { key: 'platform', label: 'Which platform?', placeholder: 'Instagram' },
      ],
      promptTemplate: 'You are the orchestrator for a research-write-save team that plans one week of {{platform}} posts for {{business}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to find current trends, hooks, and popular hashtags for a business like {{business}} on {{platform}}. Save the notes.\n\n2) SpawnAgent a Maker: write 7 posts, one per day. Each post needs a caption, a clear call to action, 5-10 hashtags, and a one-line note on what photo or clip to shoot. Vary the types across the week (promo, behind-the-scenes, quick tip, a question, a customer story).\n\n3) SpawnAgent a Publisher: save the week as a simple file the owner can follow day by day, and tell me the exact path.\n\nKeep the voice friendly and human, not salesy.',
    },
    {
      id: 'just-listed-post',
      title: 'Make a "Just Listed" package',
      blurb: 'Listing copy, social captions, and an email blast in one go.',
      category: 'Realtor',
      blanks: [
        { key: 'address', label: 'Property address or details', placeholder: '123 Oak St, 3 bed 2 bath, $340k' },
        { key: 'feature', label: 'Best feature to highlight (optional)', placeholder: 'renovated kitchen + big backyard' },
      ],
      promptTemplate: 'You are the orchestrator for a research-write-save team that builds a \'Just Listed\' package for {{address}}, playing up {{feature}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to learn the neighborhood: nearby schools, walkability, recent comparable sale prices, and what buyers love about the area. Save the notes with sources.\n\n2) SpawnAgent a Maker: write the full package: an MLS-style listing description, 3 social captions (Instagram, Facebook, and a short one for Stories), an email blast for my contact list, and 5 hashtags. Keep claims accurate and Fair-Housing safe (describe the home, never the ideal buyer).\n\n3) SpawnAgent a Publisher: save it all as one file in the workspace and tell me the path.\n\nDon\'t invent prices or features. If a number isn\'t sourced, leave it clearly blank.',
    },
    {
      id: 'neighborhood-guide',
      title: 'Build a neighborhood guide',
      blurb: "A friendly buyer's guide to any neighborhood you sell in.",
      category: 'Realtor',
      blanks: [
        { key: 'area', label: 'Which neighborhood or town?', placeholder: 'German Village, Columbus OH' },
      ],
      promptTemplate: 'You are the orchestrator for a research-write-save team that builds a buyer\'s guide to {{area}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to gather the real picture of {{area}}: schools, parks, restaurants, commute, general safety, and recent home-price trends. Save each source with its date.\n\n2) SpawnAgent a Maker: write a friendly one-page guide a buyer would actually keep: the vibe, who it suits, the highlights, price ranges, and a few honest trade-offs.\n\n3) SpawnAgent a Publisher: save the guide as a clean file plus 3 social captions promoting it, and tell me the path.\n\nCite where the numbers came from and don\'t guess at prices or stats.',
    },
    {
      id: 'pick-side-hustle',
      title: 'Pick my next side hustle',
      blurb: 'A ranked shortlist of hustles that fit your time and budget.',
      category: 'Side Hustle',
      blanks: [
        { key: 'budget', label: 'Starting budget', placeholder: '$200' },
        { key: 'hours', label: 'Hours you can spare each week', placeholder: '10' },
        { key: 'skills', label: "What you're into or good at (optional)", placeholder: 'video editing, dogs' },
      ],
      promptTemplate: 'You are the orchestrator for a research-analyze-save team that finds my best next side hustle. My constraints: budget {{budget}}, about {{hours}} hours a week, and I\'m into {{skills}}. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch to find realistic side hustles that fit those constraints. Pull honest earnings reports and real experiences from relevant subreddits via their RSS feeds. Save the sources.\n\n2) SpawnAgent a Maker: write a ranked shortlist of 5 hustles. For each: startup cost, weekly time, a realistic first-90-days income range, how hard it is to start, and the first 3 steps to try it.\n\n3) SpawnAgent a Publisher: save the report in the workspace and tell me the path.\n\nBe honest about risk and slow starts, and clearly label anything that reads like hype instead of real results.',
    },
    {
      id: 'plan-game-night',
      title: 'Plan a game night',
      blurb: 'A full run-of-show: games, snacks, playlist, and shopping list.',
      category: 'Just for Fun',
      blanks: [
        { key: 'occasion', label: "What's the occasion?", placeholder: "friends' game night" },
        { key: 'guests', label: 'How many people?', placeholder: '8' },
      ],
      promptTemplate: 'You are the orchestrator for a research-plan-save team that plans a great {{occasion}} for {{guests}} people. Use SpawnAgent for each step.\n\n1) SpawnAgent a Researcher: use WebSearch for fun ideas that fit the group: games that work well for {{guests}} players, easy crowd-pleasing snacks, a light theme, and a playlist vibe. Save the best finds.\n\n2) SpawnAgent a Maker: write a simple run-of-show: a rough timeline, 4-5 games with quick rules, a snack menu with a plain shopping list, and a playlist idea.\n\n3) SpawnAgent a Publisher: save it as a one-page plan I can follow on the night, and tell me the path.\n\nKeep everything low-effort and cheap to pull off.',
    },
    {
      id: 'fun-facts-video',
      title: 'Make a fun facts video',
      blurb: 'Five true, surprising facts turned into a snappy video.',
      category: 'Just for Fun',
      blanks: [
        { key: 'topic', label: 'What should the video be about?', placeholder: 'the creepiest deep-sea creatures' },
      ],
      promptTemplate: 'You are the orchestrator for a small team that makes a fun Top-5 facts video about {{topic}}. Work in three steps and use SpawnAgent for each.\n\n1) SpawnAgent a Researcher: use WebSearch to find 5 genuinely surprising, true facts about {{topic}}, each with a source. Save them.\n\n2) SpawnAgent a Maker: turn those facts into a snappy countdown script (#5 down to #1, one or two lines each, a strong hook up top), then run it through the ranking video pipeline at workspace/video-making/ranking to render the MP4.\n\n3) SpawnAgent a Publisher: confirm it rendered, save the video with a clickable title and a few hashtags, and tell me the exact file path.\n\nEvery fact has to be true and sourced. Drop any fact you can\'t verify and find another.',
    },
  ];

  // ── small helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function categoriesInOrder() {
    const seen = [];
    RECIPES.forEach((r) => { if (seen.indexOf(r.category) === -1) seen.push(r.category); });
    return seen;
  }

  function composePrompt(recipe, values) {
    let out = recipe.promptTemplate;
    (recipe.blanks || []).forEach((b) => {
      const raw = values && values[b.key] != null ? String(values[b.key]).trim() : '';
      const v = raw || b.placeholder || '';
      out = out.split('{{' + b.key + '}}').join(v);
    });
    return out;
  }

  function freePrompt(text) {
    const t = String(text || '').trim();
    return 'You are the orchestrator for a small team. The user asked: "' + t + '". ' +
      'Break it into clear steps and use SpawnAgent to research it, make the result, and save it, ' +
      'then tell me the exact file path of anything you produce. ' +
      'Keep everything factual and never invent details.';
  }

  // ── backend read helper (guarded token, never throws) ──────────────────────
  async function apiGet(path) {
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ── injected CSS ────────────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('atl-recipes-styles')) return;
    const css = `
      .atl-recipes-overlay { position: absolute; inset: 0; z-index: ${OVERLAY_Z};
        display: flex; flex-direction: column; background: var(--canvas);
        animation: atl-recipes-fade .18s ease; }
      @keyframes atl-recipes-fade { from { opacity: 0; } to { opacity: 1; } }
      /* hide canvas chrome while the front door is open (same intent as views.js) */
      .canvas--recipes .dock, .canvas--recipes .zoombar, .canvas--recipes .minimap { display: none; }
      body:has(.canvas--recipes) .wgt-add-btn { display: none; }

      .atl-recipes-head { flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
        padding: 16px 24px; border-bottom: 1px solid var(--border-soft); }
      .atl-recipes-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .atl-recipes-brand .mark { width: 26px; height: 26px; border-radius: 8px; flex: 0 0 26px;
        background: linear-gradient(150deg, #d0714a, #b34a26); color: #fff; font-weight: 700;
        display: flex; align-items: center; justify-content: center; font-size: 14px;
        box-shadow: 0 4px 16px rgba(180, 74, 38, 0.35); }
      .atl-recipes-brand .ttl { font-size: 15px; font-weight: 700; color: var(--ink); }
      .atl-recipes-brand .sub { font-size: 12.5px; color: var(--ink-dim); }
      .atl-recipes-head-sp { flex: 1; }
      .atl-recipes-x { border: 1px solid var(--border); background: var(--panel);
        color: var(--ink-mid); border-radius: 8px; padding: 7px 12px; cursor: pointer;
        font: inherit; font-size: 12.5px; font-weight: 600; }
      .atl-recipes-x:hover { background: var(--active); color: var(--ink); }

      .atl-recipes-scroll { flex: 1; overflow-y: auto; padding: 24px; }
      .atl-recipes-inner { width: 100%; max-width: 940px; margin: 0 auto;
        display: flex; flex-direction: column; gap: 22px; }

      .atl-recipes-hero { text-align: center; display: flex; flex-direction: column; gap: 6px; }
      .atl-recipes-hero h1 { font-size: 26px; font-weight: 800; color: var(--ink); margin: 0; }
      .atl-recipes-hero p { font-size: 14px; color: var(--ink-mid); margin: 0; }

      .atl-recipes-free { display: flex; gap: 10px; align-items: stretch;
        background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow-sm); padding: 10px; flex-wrap: wrap; }
      .atl-recipes-free input { flex: 1; min-width: 180px; border: 1px solid var(--border);
        border-radius: 10px; padding: 11px 13px; font: inherit; font-size: 14px;
        color: var(--ink); background: #faf7f1; outline: none; }
      .atl-recipes-free input:focus { border-color: var(--accent); }
      .atl-recipes-btn { border: none; border-radius: 10px; background: var(--accent); color: #fff;
        padding: 11px 18px; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
      .atl-recipes-btn:hover { background: var(--accent-2); }
      .atl-recipes-btn:disabled { opacity: .5; cursor: default; }
      .atl-recipes-btn.ghost { background: transparent; color: var(--ink-mid);
        border: 1px solid var(--border); font-weight: 600; }
      .atl-recipes-btn.ghost:hover { border-color: var(--accent); background: transparent; color: var(--ink); }

      .atl-recipes-cat { display: flex; flex-direction: column; gap: 12px; }
      .atl-recipes-cat-h { font-size: 12px; text-transform: uppercase; letter-spacing: .07em;
        font-weight: 700; color: var(--ink-dim); }
      .atl-recipes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 14px; }

      .atl-recipe-card { text-align: left; background: var(--panel); border: 1px solid var(--border);
        border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: 16px;
        display: flex; flex-direction: column; gap: 8px; cursor: pointer;
        transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease; }
      .atl-recipe-card:hover { transform: translateY(-3px); border-color: var(--accent);
        box-shadow: var(--shadow); }
      .atl-recipe-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .atl-recipe-title { font-size: 15px; font-weight: 700; color: var(--ink); }
      .atl-recipe-blurb { font-size: 13px; color: var(--ink-mid); line-height: 1.45; }
      .atl-recipe-go { margin-top: 2px; font-size: 12px; font-weight: 700; color: var(--accent); }

      /* inline blanks form (swaps the grid area) */
      .atl-recipes-form { width: 100%; max-width: 560px; margin: 0 auto;
        background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
        box-shadow: var(--shadow); padding: 22px; display: flex; flex-direction: column; gap: 16px; }
      .atl-recipes-form-h { display: flex; flex-direction: column; gap: 4px; }
      .atl-recipes-form-h .t { font-size: 19px; font-weight: 800; color: var(--ink); }
      .atl-recipes-form-h .b { font-size: 13px; color: var(--ink-mid); line-height: 1.45; }
      .atl-recipes-field { display: flex; flex-direction: column; gap: 6px; }
      .atl-recipes-field label { font-size: 12.5px; font-weight: 600; color: var(--ink-mid); }
      .atl-recipes-field input { border: 1px solid var(--border); border-radius: 10px;
        padding: 10px 12px; font: inherit; font-size: 14px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-recipes-field input:focus { border-color: var(--accent); }
      .atl-recipes-form-actions { display: flex; gap: 10px; justify-content: flex-end;
        align-items: center; margin-top: 2px; }

      /* progress strip (fixed, plain-English run status) */
      .atl-recipes-strip { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        z-index: 9200; display: flex; align-items: center; gap: 12px; max-width: 460px;
        background: var(--panel); border: 1px solid var(--border); border-radius: 999px;
        box-shadow: var(--shadow); padding: 10px 14px 10px 16px;
        animation: atl-recipes-rise .2s ease; }
      @keyframes atl-recipes-rise { from { opacity: 0; transform: translate(-50%, 10px); }
        to { opacity: 1; transform: translate(-50%, 0); } }
      .atl-recipes-strip .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 9px;
        background: var(--accent); animation: atl-recipes-pulse 1.1s ease-in-out infinite; }
      @keyframes atl-recipes-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      .atl-recipes-strip.done .dot { background: var(--ok, #3fa66a); animation: none; }
      .atl-recipes-strip.err .dot { background: var(--accent); animation: none; }
      .atl-recipes-strip .txt { font-size: 13px; color: var(--ink); font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .atl-recipes-strip .close { border: none; background: transparent; color: var(--ink-dim);
        cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }
      .atl-recipes-strip .close:hover { color: var(--ink); }

      .atl-recipes-sample { display: flex; justify-content: center; margin: 2px 0 6px; }
      .atl-recipes-cost { display: flex; flex-direction: column; gap: 10px; width: 380px; }
      .atl-recipes-cost p { margin: 0; font-size: 13px; color: var(--ink-mid); line-height: 1.55; }
      .atl-recipes-cost-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

      @media (prefers-reduced-motion: reduce) {
        .atl-recipes-overlay, .atl-recipes-strip { animation: none; }
        .atl-recipe-card { transition: none; }
        .atl-recipe-card:hover { transform: none; }
        .atl-recipes-strip .dot { animation: none; }
      }
    `;
    const style = el('style');
    style.id = 'atl-recipes-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  // ── overlay state ────────────────────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  let overlayRoot = null;   // the persistent gallery element (built once)
  let scrollHost = null;    // the scroll region we swap between gallery + form
  let isOpen = false;

  function dismissedThisSession() {
    try { return window.sessionStorage.getItem(DISMISS_KEY) === '1'; }
    catch { return false; }
  }
  function rememberDismiss() {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
  }

  function buildGallery() {
    const inner = el('div', 'atl-recipes-inner');

    const hero = el('div', 'atl-recipes-hero');
    hero.appendChild(el('h1', null, 'What should we make?'));
    hero.appendChild(el('p', null, 'Pick a starting point, or just tell it what you want. A team gets built and runs for you.'));
    inner.appendChild(hero);

    // free-text "make me ___" box + Surprise me
    const free = el('div', 'atl-recipes-free');
    const freeInput = document.createElement('input');
    freeInput.type = 'text';
    freeInput.placeholder = 'Make me… (e.g. a video ranking the best coffee gadgets)';
    freeInput.setAttribute('aria-label', 'Describe what you want to make');
    const freeGo = el('button', 'atl-recipes-btn', 'Go');
    freeGo.type = 'button';
    const surprise = el('button', 'atl-recipes-btn ghost', 'Surprise me');
    surprise.type = 'button';
    free.append(freeInput, freeGo, surprise);
    inner.appendChild(free);

    freeGo.addEventListener('click', () => {
      const t = freeInput.value.trim();
      if (!t) { freeInput.focus(); return; }
      launch({ title: 'your request', prompt: freePrompt(t) });
    });
    freeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); freeGo.click(); }
    });
    surprise.addEventListener('click', () => {
      const pick = RECIPES[Math.floor(Math.random() * RECIPES.length)];
      openForm(pick);
    });

    // The zero-cost first win (sample.js): visible before any auth or spend,
    // so a newcomer can see a full run before connecting anything.
    if (window.AtelierSample && typeof window.AtelierSample.play === 'function') {
      const sampleRow = el('div', 'atl-recipes-sample');
      const sampleBtn = el('button', 'atl-recipes-btn ghost', '▶ Watch a sample run first — free, nothing is sent');
      sampleBtn.type = 'button';
      sampleBtn.addEventListener('click', () => {
        closeOverlay({ remember: false });
        window.AtelierSample.play();
      });
      sampleRow.appendChild(sampleBtn);
      inner.appendChild(sampleRow);
    }

    // grouped recipe grids
    categoriesInOrder().forEach((cat) => {
      const sec = el('div', 'atl-recipes-cat');
      sec.appendChild(el('div', 'atl-recipes-cat-h', cat));
      const grid = el('div', 'atl-recipes-grid');
      RECIPES.filter((r) => r.category === cat).forEach((r) => {
        grid.appendChild(recipeCard(r));
      });
      sec.appendChild(grid);
      inner.appendChild(sec);
    });

    return inner;
  }

  function recipeCard(recipe) {
    const card = el('div', 'atl-recipe-card');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-label', recipe.title + '. ' + recipe.blurb);
    card.appendChild(el('div', 'atl-recipe-title', recipe.title));
    card.appendChild(el('div', 'atl-recipe-blurb', recipe.blurb));
    card.appendChild(el('div', 'atl-recipe-go', 'Set it up →'));
    const activate = () => openForm(recipe);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    return card;
  }

  // ── inline blanks form (progressive step before the run) ───────────────────
  let formOpen = false;

  function showGallery() {
    formOpen = false;
    if (!scrollHost) return;
    scrollHost.textContent = '';
    scrollHost.appendChild(buildGallery());
  }

  function openForm(recipe) {
    if (!scrollHost) return;
    // recipe may carry a prebuilt prompt (free-text path uses launch directly);
    // this path is only for catalog recipes with blanks.
    if (!recipe.blanks || !recipe.blanks.length) {
      launch({ title: recipe.title, prompt: composePrompt(recipe, {}) });
      return;
    }
    formOpen = true;
    scrollHost.textContent = '';

    const form = el('div', 'atl-recipes-form');
    const head = el('div', 'atl-recipes-form-h');
    head.appendChild(el('div', 't', recipe.title));
    head.appendChild(el('div', 'b', recipe.blurb));
    form.appendChild(head);

    const inputs = {};
    recipe.blanks.forEach((b, i) => {
      const field = el('div', 'atl-recipes-field');
      const lab = el('label', null, b.label);
      const inputId = 'atl-recipe-in-' + recipe.id + '-' + b.key;
      lab.setAttribute('for', inputId);
      const input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      input.placeholder = b.placeholder || '';
      input.setAttribute('aria-label', b.label);
      inputs[b.key] = input;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
      });
      field.append(lab, input);
      form.appendChild(field);
      if (i === 0) setTimeout(() => input.focus(), 30);
    });

    const actions = el('div', 'atl-recipes-form-actions');
    const back = el('button', 'atl-recipes-btn ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', showGallery);
    const goBtn = el('button', 'atl-recipes-btn', 'Go');
    goBtn.type = 'button';
    goBtn.addEventListener('click', go);
    actions.append(back, goBtn);
    form.appendChild(actions);

    scrollHost.appendChild(form);

    function go() {
      const values = {};
      Object.keys(inputs).forEach((k) => { values[k] = inputs[k].value; });
      launch({ title: recipe.title, prompt: composePrompt(recipe, values) });
    }
  }

  // ── open / close the front door ────────────────────────────────────────────
  function ensureOverlay() {
    if (overlayRoot) return overlayRoot;
    const root = el('div', 'atl-recipes-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Recipe gallery');
    // The overlay lives inside #canvas, so stop gestures from acting on the
    // hidden board underneath (wheel-zoom, pan/marquee, dblclick widget picker).
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('dblclick', (e) => e.stopPropagation());

    const head = el('div', 'atl-recipes-head');
    const brand = el('div', 'atl-recipes-brand');
    brand.appendChild(el('span', 'mark', 'A'));
    const bt = el('div');
    bt.appendChild(el('div', 'ttl', 'Atelier recipes'));
    bt.appendChild(el('div', 'sub', 'Ready-to-run starting points'));
    brand.appendChild(bt);
    const sp = el('div', 'atl-recipes-head-sp');
    const backstage = el('button', 'atl-recipes-x', 'Show me the canvas');
    backstage.type = 'button';
    backstage.title = 'Hide the gallery and work on a blank canvas';
    backstage.addEventListener('click', () => closeOverlay({ remember: true }));
    head.append(brand, sp, backstage);

    const scroll = el('div', 'atl-recipes-scroll');
    scrollHost = scroll;

    root.append(head, scroll);
    overlayRoot = root;
    return root;
  }

  function openOverlay() {
    if (isOpen || !canvas) return;
    ensureOverlay();
    showGallery();                       // always land on the gallery, not a stale form
    canvas.appendChild(overlayRoot);
    canvas.classList.add('canvas--recipes');
    isOpen = true;
    updateDockActive();
  }

  function closeOverlay(opts) {
    if (opts && opts.remember) rememberDismiss();
    if (!isOpen) return;
    if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot);
    if (canvas) canvas.classList.remove('canvas--recipes');
    isOpen = false;
    formOpen = false;
    updateDockActive();
  }

  // ── emptiness detection ─────────────────────────────────────────────────────
  function hasUserCard() {
    return !!document.querySelector('#content > .card:not([data-atl-builtin="1"])');
  }

  function evaluate() {
    if (hasUserCard()) { if (isOpen) closeOverlay(); return; }
    if (dismissedThisSession()) return;
    if (!isOpen) openOverlay();
  }

  // ── run flow: spawn an orchestrator, drive its composer, narrate progress ──
  let runToken = 0;

  async function listSessionIds() {
    const d = await apiGet('/sessions');
    const set = new Set();
    if (d && Array.isArray(d.sessions)) {
      d.sessions.forEach((s) => { if (s && s.id != null) set.add(s.id); });
    }
    return set;
  }

  // ── pre-run cost sheet (Round-2 P2): metered runs ask before spending ──────
  // Subscription runs are plan-included and launch immediately; the api-key
  // path is real dollars, so the first thing a run does is say so. Fail-open:
  // an unreachable /config must never block making.
  let costSheetPanel = null;
  async function confirmMeteredRun() {
    const cfg = await apiGet('/config');
    if (!cfg || cfg.provider !== 'api') return true;
    return new Promise((resolve) => {
      if (costSheetPanel) { try { costSheetPanel.close(); } catch { /* gone */ } }
      const wrap = el('div', 'atl-recipes-cost');
      const cap = typeof cfg.spend_cap_usd === 'number' ? cfg.spend_cap_usd : 0;
      // null/absent = the server could not read the spend ledger, so today's
      // total is UNKNOWN. Never render that as $0.00 — the old `: 0` fallback
      // printed "Today so far: $0.00 of your $5.00 daily cap" while the cap
      // was in fact unenforceable.
      const spent = typeof cfg.api_spend_today_usd === 'number' ? cfg.api_spend_today_usd : null;
      wrap.appendChild(el('p', null,
        'This run is metered on your Anthropic API key. Simple asks usually cost cents; research or video runs cost more.'));
      let capLine;
      if (cap <= 0) {
        capLine = 'Your daily spend cap is turned off, so nothing will stop a long run — you can set a cap in Settings.';
      } else if (spent === null) {
        capLine = 'Atelier cannot read today’s spend ledger, so your $' + cap.toFixed(2)
          + ' daily cap cannot be enforced right now — so runs are paused until it can be read again. '
          + 'Fix or delete ~/.atelier/spend.json to restore it.';
      } else {
        capLine = 'Today so far: $' + spent.toFixed(2) + ' of your $' + cap.toFixed(2)
          + ' daily cap. Atelier pauses at the cap.';
      }
      wrap.appendChild(el('p', null, capLine));
      const row = el('div', 'atl-recipes-cost-row');
      const cancel = el('button', 'atl-recipes-btn ghost', 'Not now');
      const go = el('button', 'atl-recipes-btn', 'Start the run');
      cancel.type = 'button'; go.type = 'button';
      row.append(cancel, go);
      wrap.appendChild(row);
      const done = (val) => {
        if (costSheetPanel) { try { costSheetPanel.close(); } catch { /* gone */ } }
        costSheetPanel = null;
        resolve(val);
      };
      cancel.addEventListener('click', () => done(false));
      go.addEventListener('click', () => done(true));
      costSheetPanel = A.ui.openPanel('Before this run spends', wrap, { backdrop: true });
    });
  }

  async function launch(job) {
    // 0) metered runs say what they cost before anything spawns
    if (!(await confirmMeteredRun())) return;

    // 1) make sure there is a board to spawn onto (there always is one, but be safe)
    if (A.boards && typeof A.boards.active === 'function' && typeof A.boards.create === 'function') {
      if (!A.boards.active()) {
        try { await A.boards.create(); } catch { /* fall through — spawn still works */ }
      }
    }

    // 2) snapshot existing sessions so we can spot the new orchestrator
    const before = await listSessionIds();

    // 3) spawn the orchestrator agent card
    if (typeof A.spawnApp !== 'function') { A.ui.toast('Agents are unavailable here.'); return; }
    const cardEl = A.spawnApp('agent');
    if (!cardEl) { A.ui.toast('Could not start a team — the agent app is not loaded.'); return; }

    // spawning adds a card, which trips card:added -> the overlay auto-closes;
    // close explicitly too so the strip is the only thing on screen.
    closeOverlay();
    showStrip('Setting up your team…');

    const token = ++runToken;

    // 4) wait for the card's session to settle, then fill + send (double-POST guard)
    await delay(MOUNT_WAIT_MS);
    if (token !== runToken) return;      // superseded by a newer launch
    const ta = cardEl.querySelector('.atl-agent-composer textarea');
    const send = cardEl.querySelector('.atl-agent-send');
    if (!ta || !send) { setStrip('Could not reach the composer — type the request into the card.', 'err'); return; }
    ta.value = job.prompt;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();

    // 5) find the new orchestrator session and narrate its status
    trackRun(before, token);
  }

  function trackRun(beforeIds, token) {
    let attempts = 0;
    const find = async () => {
      if (token !== runToken || stripClosed) return;
      const d = await apiGet('/sessions');
      const sessions = (d && Array.isArray(d.sessions)) ? d.sessions : [];
      const fresh = sessions.filter((s) => s && s.parent_id == null && !beforeIds.has(s.id));
      if (fresh.length) { pollRun(fresh[fresh.length - 1].id, token); return; }
      if (++attempts > 25) { setStrip('Your team is on it — watch the card for updates.'); return; }
      setTimeout(find, 800);
    };
    find();
  }

  function phraseFor(detail) {
    const msgs = Array.isArray(detail.messages) ? detail.messages : [];
    let lastNote = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'note' && m.text) { lastNote = String(m.text); break; }
    }
    const ops = Array.isArray(detail.canvas_ops) ? detail.canvas_ops : [];
    const kinds = ops.map((o) => o && o.kind);
    if (kinds.indexOf('document') !== -1) return 'Writing it up…';
    if (lastNote) {
      const t = lastNote.replace(/^[\s→\-]+/, '').trim();
      if (t) return t.length > 72 ? t.slice(0, 71) + '…' : t;
    }
    return 'Researching…';
  }

  function pollRun(sessionId, token) {
    const tick = async () => {
      if (token !== runToken || stripClosed) return;
      const d = await apiGet('/sessions/' + sessionId);
      if (!d) { setTimeout(tick, POLL_MS); return; }
      if (d.status === 'running') { setStrip(phraseFor(d)); setTimeout(tick, POLL_MS); return; }
      if (d.status === 'error') { setStrip('Something went wrong — open the card to see.', 'err'); return; }
      setStrip('Ready to review on the canvas.', 'ok');
      autoHideStrip(token);
    };
    tick();
  }

  // ── progress strip UI ────────────────────────────────────────────────────────
  let stripEl = null;
  let stripTextEl = null;
  let stripClosed = true;

  function showStrip(text) {
    stripClosed = false;
    if (!stripEl) {
      stripEl = el('div', 'atl-recipes-strip');
      stripEl.setAttribute('role', 'status');
      stripEl.setAttribute('aria-live', 'polite');
      stripEl.appendChild(el('span', 'dot'));
      stripTextEl = el('span', 'txt');
      stripEl.appendChild(stripTextEl);
      const close = el('button', 'close', '×');
      close.type = 'button';
      close.title = 'Dismiss';
      close.setAttribute('aria-label', 'Dismiss progress');
      close.addEventListener('click', hideStrip);
      stripEl.appendChild(close);
      document.body.appendChild(stripEl);
    }
    stripEl.classList.remove('done', 'err');
    stripTextEl.textContent = text;
    stripEl.style.display = '';
  }

  function setStrip(text, kind) {
    if (!stripEl || stripClosed) return;
    stripTextEl.textContent = text;
    stripEl.classList.toggle('done', kind === 'ok');
    stripEl.classList.toggle('err', kind === 'err');
  }

  function hideStrip() {
    stripClosed = true;
    runToken++;                          // stop any in-flight poll
    if (stripEl) stripEl.style.display = 'none';
  }

  function autoHideStrip(token) {
    setTimeout(() => { if (token === runToken && !stripClosed) hideStrip(); }, 6000);
  }

  // ── re-open affordances: dock button + palette command ─────────────────────
  let dockBtn = null;
  function updateDockActive() {
    if (dockBtn) dockBtn.classList.toggle('active', isOpen);
  }
  (function addDockButton() {
    const dock = document.querySelector('.dock');
    if (!dock) return;
    // apps.js clone-replaces the six builtin dock buttons at its init; appending
    // a fresh one afterwards (this module loads last) keeps only our handler.
    dockBtn = document.createElement('button');
    dockBtn.className = 'dock-btn';
    dockBtn.title = 'Recipes';
    dockBtn.textContent = '📖';
    dockBtn.setAttribute('aria-label', 'Open the recipe gallery');
    dockBtn.addEventListener('click', () => {
      if (isOpen) closeOverlay(); else openOverlay();
    });
    dock.appendChild(dockBtn);
  })();

  function registerPaletteCommand() {
    A.bus.emit('palette:add', {
      id: 'recipes.open', label: 'Recipes', icon: '📖', section: 'Create',
      keywords: 'recipe gallery template start make video etsy realtor hustle',
      run() { openOverlay(); },
    });
  }
  registerPaletteCommand();
  A.bus.on('palette:ready', registerPaletteCommand); // covers palette.js loading later

  // ── wire the lifecycle ──────────────────────────────────────────────────────
  A.bus.on('core:ready', () => setTimeout(evaluate, 0));
  A.bus.on('boards:switched', () => setTimeout(evaluate, 0));
  A.bus.on('shortcut:escape', () => {
    if (!isOpen) return;
    if (formOpen) showGallery(); else closeOverlay({ remember: true });
  });
  A.bus.on('card:added', (d) => {
    if (d && d.el && d.el.dataset && d.el.dataset.atlBuiltin !== '1') {
      if (isOpen) closeOverlay();        // user started work — get out of the way
    }
  });
  A.bus.on('card:removed', (d) => {
    if (d && d.el && d.el.dataset && d.el.dataset.atlBuiltin === '1') return;
    setTimeout(evaluate, 0);             // board may have just gone empty
  });

  // core:ready may already have fired before this deferred script ran — evaluate
  // once directly (deferred a tick so sibling modules finish restoring cards).
  setTimeout(evaluate, 0);

  // ── public surface + self-check ─────────────────────────────────────────────
  ensureOverlay();                       // build the gallery element up front
  window.AtelierRecipes = {
    open: openOverlay,
    close: closeOverlay,
    isOpen: () => isOpen,
    recipes: RECIPES,
  };

  (function selfCheck() {
    const registered = !!(window.AtelierRecipes && typeof window.AtelierRecipes.open === 'function');
    const galleryExists = !!(overlayRoot && overlayRoot.nodeType === 1);
    console.assert(registered, '[recipes] module did not register window.AtelierRecipes');
    console.assert(galleryExists, '[recipes] gallery overlay element missing');
    if (registered && galleryExists) {
      console.log('[recipes] self-check passed — ' + RECIPES.length + ' recipes, front door ready.');
    }
  })();
})();
