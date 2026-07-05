'use strict';

/* ===========================================================================
   Atelier feature module — Publish / Export   (app/publish.js)

   The own-the-last-mile card. An agent produced a finished deliverable (a
   rendered short, an image, a PDF, a note); this card takes ONE such file and
   helps a human get it out into the world — honestly.

   Two ways out, and the card never blurs the line between them:

     1. EXPORT / DOWNLOAD — works on day one, zero backend. Picks a file from
        the agent workspace (GET /workspace/files) and saves its raw bytes
        (GET /workspace/raw?path=…) to a location you choose, via the
        window.atelier.saveBinary bridge (a plain <a download> fallback covers
        a non-Electron page).

     2. POST TO A CHANNEL — split into two HONEST buckets:
        • "Posts automatically" (X, Bluesky, Reddit, Webhook): an API scaffold.
          The card reads a per-channel token you saved in its Settings panel and
          POSTs to a single backend endpoint the host wires in later
          (POST /publish {channel, path, caption, token}). Until that endpoint
          exists — or until you save a token — the button is disabled with a
          plain reason. It NEVER claims a post happened: success is shown only
          on an explicit {ok:true} from the backend, and the returned URL (if
          any) is surfaced so you can verify it yourself.
        • "Get it ready — you post it" (TikTok, Instagram, LinkedIn, YouTube):
          the truthful default for platforms with no easy write API. The button
          downloads the file and opens the platform's upload page in a browser
          card (reusing that card's logged-in session), then hands off to you.

   The single hard rule: never tell the user something posted that did not.
   Every failure path says so; every "automatic" channel is gated on a real
   backend response.

   Storage: card placement is board-scoped (Atelier.store 'atelier.publish',
   like every other card). The saved channel tokens live in localStorage
   ('atelier.publish.tokens') on purpose — a credential should follow the USER
   across boards, and localStorage is global without needing a boards.js edit
   (same reasoning as approvals.js's remembered decisions). See backendNeeded
   in the handoff for the more secure server-side-store alternative.

   Public API: window.AtelierPublish.open(opts) — spawn/focus a card, optionally
   prefilled with { path, caption, worldPos }.

   Contract: builds ONLY against window.Atelier (+ the optional window.atelier
   token/save bridge and window.AtelierApps for the browser-card hand-off).
   Injects its own CSS. XSS rule: every server-/user-derived string enters the
   DOM via textContent.
   =========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || typeof A.registerApp !== 'function' || !A.canvas || !A.bus || !A.store || !A.ui) {
    console.warn('[publish] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const STORE_KEY = 'atelier.publish';           // board-scoped card placements
  const TOKENS_KEY = 'atelier.publish.tokens';   // localStorage, global creds map
  const CARD_W = 400;
  const CARD_H = 520;
  const CAPTION_MAX = 4000;

  // Extensions worth showing as a publishable deliverable (export still works on
  // anything, but the picker leads with what people actually ship).
  const SHIP_EXT = ['.mp4', '.mov', '.webm', '.mp3', '.wav', '.png', '.jpg', '.jpeg',
    '.gif', '.webp', '.pdf', '.pptx', '.md', '.txt', '.json'];
  const FILTER_NAME = {
    mp4: 'Video', mov: 'Video', webm: 'Video', mp3: 'Audio', wav: 'Audio',
    png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
    pdf: 'PDF', pptx: 'PowerPoint', md: 'Markdown', txt: 'Text', json: 'JSON',
  };

  // Channels that CAN post through the API scaffold. `cred` is the human label
  // for the single secret the Settings panel collects for that channel.
  const AUTO_CHANNELS = [
    { id: 'x', label: 'X', cred: 'X API token (OAuth2 bearer or user token)' },
    { id: 'bluesky', label: 'Bluesky', cred: 'Bluesky app password (handle:app-password)' },
    { id: 'reddit', label: 'Reddit', cred: 'Reddit OAuth token' },
    { id: 'webhook', label: 'Webhook', cred: 'Webhook URL' },
  ];
  // Channels with no easy write API — get it ready, you post it.
  const MANUAL_CHANNELS = [
    { id: 'tiktok', label: 'TikTok', url: 'https://www.tiktok.com/upload' },
    { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/' },
    { id: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/feed/?shareActive=true' },
    { id: 'youtube', label: 'YouTube', url: 'https://studio.youtube.com/' },
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function baseName(path) {
    const p = String(path || '');
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  }
  function extOf(path) {
    const b = baseName(path);
    const i = b.lastIndexOf('.');
    return i === -1 ? '' : b.slice(i + 1).toLowerCase();
  }
  function stem(path) {
    const b = baseName(path);
    const i = b.lastIndexOf('.');
    return i === -1 ? b : b.slice(0, i);
  }
  function last4(s) {
    const t = String(s || '');
    return t.length <= 4 ? t : '…' + t.slice(-4);
  }

  /* ── global saved-token store (localStorage, survives board switches) ─────── */
  function loadTokens() {
    try { return JSON.parse(window.localStorage.getItem(TOKENS_KEY) || '{}') || {}; }
    catch { return {}; }
  }
  function saveTokens(map) {
    try { window.localStorage.setItem(TOKENS_KEY, JSON.stringify(map)); }
    catch { /* private mode — tokens just won't persist */ }
  }
  function tokenFor(channelId) {
    return String(loadTokens()[channelId] || '').trim();
  }

  /* ── backend helpers (guarded, never throw) ───────────────────────────────── */
  async function apiGet(path) {
    try {
      if (window.atelier && typeof window.atelier.get === 'function') {
        return await window.atelier.get(path);
      }
    } catch { return null; }
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    try {
      const res = await fetch(BASE + path, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  async function apiPost(path, bodyObj) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    let res;
    try {
      res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
    } catch { return { ok: false, status: 0, data: null }; }
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // Fetch a workspace file as base64 (for the saveBinary bridge). Never throws
  // to the caller through the returned promise's reject path being unhandled —
  // callers await inside try/catch.
  async function fileToBase64(path) {
    const headers = {};
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const res = await fetch(BASE + '/workspace/raw?path=' + encodeURIComponent(path), { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('read failed'));
      fr.onload = () => {
        const s = String(fr.result || '');
        const i = s.indexOf(',');
        resolve(i === -1 ? '' : s.slice(i + 1));
      };
      fr.readAsDataURL(blob);
    });
  }

  (function injectStyles() {
    if (document.getElementById('atl-publish-styles')) return;
    const css = `
      .atl-pub-body { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
      .atl-pub-pick { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid var(--border-soft); }
      .atl-pub-sel { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 8px;
        padding: 6px 9px; font: inherit; font-size: 12.5px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-pub-sel:focus { border-color: var(--accent); }
      .atl-pub-icon { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 7px;
        background: #faf7f1; color: var(--ink-mid); font: inherit; font-size: 12px; line-height: 1;
        padding: 6px 9px; cursor: pointer; }
      .atl-pub-icon:hover { border-color: var(--accent); }
      .atl-pub-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex;
        flex-direction: column; gap: 12px; }
      .atl-pub-cap { resize: none; min-height: 52px; max-height: 120px; border: 1px solid var(--border);
        border-radius: 10px; padding: 8px 11px; font: inherit; font-size: 13px; color: var(--ink);
        background: #faf7f1; outline: none; }
      .atl-pub-cap:focus { border-color: var(--accent); }
      .atl-pub-export { display: flex; align-items: center; gap: 8px; }
      .atl-pub-channels { display: flex; flex-direction: column; gap: 8px; }
      .atl-pub-btn { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-pub-btn:hover { background: var(--accent-2); }
      .atl-pub-btn:disabled { opacity: 0.5; cursor: default; }
      .atl-pub-btn.ghost { background: transparent; color: var(--ink-mid); border: 1px solid var(--border); }
      .atl-pub-btn.ghost:hover:not(:disabled) { border-color: var(--accent); background: transparent; }
      .atl-pub-sechead { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--ink-dim); font-weight: 700; margin-top: 2px; }
      .atl-pub-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px;
        border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
      .atl-pub-rname { font-size: 13px; font-weight: 600; color: var(--ink); flex: 0 0 auto; min-width: 74px; }
      .atl-pub-rmid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .atl-pub-badge { align-self: flex-start; font-size: 10px; text-transform: uppercase;
        letter-spacing: .04em; font-weight: 700; border-radius: 6px; padding: 1px 6px;
        border: 1px solid var(--border); color: var(--ink-dim); white-space: nowrap; }
      .atl-pub-badge.auto { color: #fff; background: var(--accent); border-color: transparent; }
      .atl-pub-badge.manual { color: var(--ink-mid); background: transparent; }
      .atl-pub-rnote { font-size: 11px; color: var(--ink-dim); line-height: 1.35;
        overflow: hidden; text-overflow: ellipsis; }
      .atl-pub-rnote.err { color: var(--accent); }
      .atl-pub-rnote.ok { color: var(--ok, #3fa66a); }
      .atl-pub-rnote a { color: inherit; text-decoration: underline; }
      .atl-pub-raction { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 8px;
        background: #faf7f1; color: var(--ink-mid); font: inherit; font-size: 11.5px; font-weight: 600;
        padding: 5px 11px; cursor: pointer; }
      .atl-pub-raction:hover:not(:disabled) { border-color: var(--accent); }
      .atl-pub-raction:disabled { opacity: 0.5; cursor: default; }
      .atl-pub-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 8px 12px; border-top: 1px solid var(--border-soft); }
      .atl-pub-footnote { font-size: 11px; color: var(--ink-dim); line-height: 1.35; }

      .atl-pm-wrap { display: flex; flex-direction: column; gap: 14px; width: 380px; }
      .atl-pm-intro { font-size: 12px; color: var(--ink-mid); line-height: 1.5; }
      .atl-pm-field { display: flex; flex-direction: column; gap: 5px; }
      .atl-pm-label { font-size: 12px; font-weight: 600; color: var(--ink); }
      .atl-pm-in { border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
        font: inherit; font-size: 13px; color: var(--ink); background: #faf7f1; outline: none;
        width: 100%; box-sizing: border-box; }
      .atl-pm-in:focus { border-color: var(--accent); }
      .atl-pm-hint { font-size: 11px; color: var(--ink-dim); line-height: 1.35; }
      .atl-pm-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px;
        border-top: 1px solid var(--border-soft); padding-top: 12px; }
      .atl-pm-note { font-size: 11.5px; color: var(--ink-dim); }
      .atl-pm-note.ok { color: var(--ok, #3fa66a); }
      .atl-pm-save { border: none; border-radius: 9px; background: var(--accent); color: #fff;
        padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .atl-pm-save:hover { background: var(--accent-2); }
    `;
    const style = el('style');
    style.id = 'atl-publish-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  /* ── shared workspace-file cache (one list feeds every card + the picker) ─── */
  let filesCache = null; // [{path,size,mtime}]
  async function fetchFiles(force) {
    if (filesCache && !force) return filesCache;
    const data = await apiGet('/workspace/files');
    filesCache = (data && Array.isArray(data.files)) ? data.files.slice() : [];
    // ship-worthy first, then the rest, each newest-first
    filesCache.sort((a, b) => {
      const sa = SHIP_EXT.indexOf('.' + extOf(a.path)) !== -1 ? 0 : 1;
      const sb = SHIP_EXT.indexOf('.' + extOf(b.path)) !== -1 ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (b.mtime || 0) - (a.mtime || 0);
    });
    return filesCache;
  }

  /* =========================================================================
     THE SETTINGS PANEL (per-channel tokens)
     ========================================================================= */
  let smPanel = null;

  function buildSettingsBody() {
    const wrap = el('div', 'atl-pm-wrap');
    wrap.appendChild(el('div', 'atl-pm-intro',
      'Save a credential for a channel to turn on automatic posting. Tokens are '
      + 'stored on this device and sent with each post request. Leave a field blank '
      + 'to keep that channel manual.'));

    const saved = loadTokens();
    const inputs = {};
    AUTO_CHANNELS.forEach((ch) => {
      const field = el('div', 'atl-pm-field');
      const label = el('label', 'atl-pm-label', ch.label);
      const inId = 'atl-pm-' + ch.id;
      label.htmlFor = inId;
      const input = document.createElement('input');
      input.className = 'atl-pm-in';
      input.id = inId;
      input.type = 'password';
      input.autocomplete = 'off';
      input.maxLength = 4000;
      const has = String(saved[ch.id] || '').trim();
      input.placeholder = has ? ('saved (' + last4(has) + ') — leave blank to keep') : ch.cred;
      const hint = el('div', 'atl-pm-hint', ch.cred);
      field.append(label, input, hint);
      wrap.appendChild(field);
      inputs[ch.id] = input;
    });

    const actions = el('div', 'atl-pm-actions');
    const note = el('div', 'atl-pm-note');
    const right = el('div', 'atl-pub-export');
    const clearBtn = el('button', 'atl-pub-btn ghost', 'Clear all');
    clearBtn.type = 'button';
    const saveBtn = el('button', 'atl-pm-save', 'Save');
    saveBtn.type = 'button';
    right.append(clearBtn, saveBtn);
    actions.append(note, right);
    wrap.appendChild(actions);

    saveBtn.addEventListener('click', () => {
      const map = loadTokens();
      AUTO_CHANNELS.forEach((ch) => {
        const v = String(inputs[ch.id].value || '').trim();
        if (v) map[ch.id] = v; // blank keeps the existing value
      });
      saveTokens(map);
      AUTO_CHANNELS.forEach((ch) => { inputs[ch.id].value = ''; });
      note.textContent = 'Saved.';
      note.classList.add('ok');
      instances.forEach((inst) => renderChannels(inst));
    });
    clearBtn.addEventListener('click', () => {
      saveTokens({});
      AUTO_CHANNELS.forEach((ch) => { inputs[ch.id].value = ''; inputs[ch.id].placeholder = ch.cred; });
      note.textContent = 'All channel tokens cleared.';
      note.classList.remove('ok');
      instances.forEach((inst) => renderChannels(inst));
    });

    return wrap;
  }

  function openSettings() {
    if (smPanel && smPanel.el && document.body.contains(smPanel.el)) {
      const x = smPanel.el.querySelector('.card-x');
      if (x && x.scrollIntoView) x.scrollIntoView({ block: 'nearest' });
      return;
    }
    smPanel = A.ui.openPanel('Publishing channels', buildSettingsBody(), { backdrop: true });
    if (smPanel && smPanel.el) {
      const x = smPanel.el.querySelector('.card-x');
      if (x) x.addEventListener('click', () => { smPanel = null; });
    }
  }

  /* =========================================================================
     ONE PUBLISH CARD
     ========================================================================= */
  const instances = new Map();
  let restoring = false;
  let dragId = null;

  function persist() {
    if (restoring) return;
    const arr = [];
    instances.forEach((inst) => {
      const r = inst.handle.getRect();
      arr.push({ id: inst.id, x: r.x, y: r.y, w: r.w, h: r.h,
        path: inst.path || '', caption: inst.caption || '' });
    });
    A.store.set(STORE_KEY, arr);
  }

  function selectedPath(inst) {
    return inst.picker && inst.picker.value ? inst.picker.value : '';
  }

  function populatePicker(inst) {
    const sel = inst.picker;
    const files = filesCache || [];
    const prev = inst.path || '';
    sel.textContent = '';
    sel.appendChild(new Option(files.length ? 'Choose a deliverable…' : 'No files in the workspace yet', ''));
    files.forEach((f) => {
      const b = baseName(f.path);
      sel.appendChild(new Option(b, f.path));
    });
    if (prev && files.some((f) => f.path === prev)) sel.value = prev;
    else if (prev) { inst.path = ''; sel.value = ''; }
    updateActionState(inst);
  }

  function updateActionState(inst) {
    const has = !!selectedPath(inst);
    if (inst.exportBtn) inst.exportBtn.disabled = !has || inst.busy;
    inst.actionBtns.forEach((btn) => {
      const chId = btn.dataset.chId;
      const isAuto = AUTO_CHANNELS.some((c) => c.id === chId);
      const ready = isAuto ? !!tokenFor(chId) : true;
      btn.disabled = !has || inst.busy || !ready;
    });
  }

  function setExportNote(inst, text, kind) {
    inst.exportNote.textContent = text || '';
    inst.exportNote.className = 'atl-pub-rnote' + (kind ? ' ' + kind : '');
  }

  // ── EXPORT: fetch raw bytes, save to a chosen path (bridge), else <a download>
  async function doExport(inst) {
    const path = selectedPath(inst);
    if (!path) return;
    const bridge = window.atelier;
    const ext = extOf(path) || 'bin';
    const name = stem(path) || 'deliverable';
    const filter = FILTER_NAME[ext] || 'File';

    if (bridge && typeof bridge.saveBinary === 'function') {
      inst.busy = true; updateActionState(inst);
      setExportNote(inst, 'Preparing download…');
      try {
        const b64 = await fileToBase64(path);
        const res = await bridge.saveBinary(b64, name, ext, filter);
        if (res && res.canceled) setExportNote(inst, '');
        else if (res && res.error) setExportNote(inst, 'Export failed: ' + res.error, 'err');
        else if (res && res.saved) setExportNote(inst, 'Saved ' + baseName(String(res.saved)) + '.', 'ok');
        else setExportNote(inst, 'Saved.', 'ok');
      } catch (e) {
        setExportNote(inst, 'Export failed: ' + ((e && e.message) || e), 'err');
      } finally {
        inst.busy = false; updateActionState(inst);
      }
      return;
    }

    // Plain-browser fallback: let the browser download the streamed bytes.
    try {
      const a = document.createElement('a');
      // Anchor downloads cannot carry headers -> `atk` query-param carrier.
      a.href = BASE + '/workspace/raw?path=' + encodeURIComponent(path)
        + (window.atelier && window.atelier.token
          ? '&atk=' + encodeURIComponent(window.atelier.token) : '');
      a.download = baseName(path);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExportNote(inst, 'Download started.', 'ok');
    } catch (e) {
      setExportNote(inst, 'Export failed: ' + ((e && e.message) || e), 'err');
    }
  }

  // ── AUTO channel: POST to the backend publish endpoint. Success is claimed
  //    ONLY on an explicit {ok:true} response; every other path says so plainly.
  async function doAutoPost(inst, ch, row) {
    const path = selectedPath(inst);
    if (!path) { setRowNote(row, 'Pick a deliverable first.', 'err'); return; }
    const token = tokenFor(ch.id);
    if (!token) { setRowNote(row, 'Add a ' + ch.label + ' token in Settings first.', 'err'); return; }

    const btn = row._action;
    btn.disabled = true;
    inst.busy = true; updateActionState(inst);
    setRowNote(row, 'Posting to ' + ch.label + '…');

    const r = await apiPost('/publish', {
      channel: ch.id,
      path,
      caption: String(inst.caption || ''),
      token,
    });

    inst.busy = false; updateActionState(inst);

    if (r.status === 0) {
      setRowNote(row, 'Backend not wired yet — nothing was posted. (POST /publish is unreachable.)', 'err');
      return;
    }
    if (r.status === 404) {
      setRowNote(row, 'Backend not wired yet — the host has not added POST /publish. Nothing was posted.', 'err');
      return;
    }
    // The one success gate: an explicit ok:true from the backend.
    if (r.ok && r.data && r.data.ok === true) {
      const url = typeof r.data.url === 'string' ? r.data.url : '';
      setRowSuccess(row, 'Posted to ' + ch.label + '.', url);
      A.ui.toast('Posted to ' + ch.label);
      return;
    }
    const why = (r.data && (r.data.error || r.data.detail)) ? String(r.data.error || r.data.detail)
      : ('Post failed (HTTP ' + r.status + ').');
    setRowNote(row, why + ' Nothing was posted.', 'err');
  }

  // ── MANUAL channel: get it ready (download), then open the upload page in a
  //    browser card so the user finishes the post in a logged-in session.
  async function doManualPrepare(inst, ch, row) {
    const path = selectedPath(inst);
    if (!path) { setRowNote(row, 'Pick a deliverable first.', 'err'); return; }
    setRowNote(row, 'Getting it ready…');
    await doExport(inst); // downloads the file for you to attach

    // Copy the caption so it is one paste away on the platform.
    let copied = false;
    const cap = String(inst.caption || '').trim();
    if (cap && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(cap); copied = true; } catch { /* not fatal */ }
    }

    const opened = openInBrowserCard(ch.url, inst);
    const tail = copied ? ' Caption copied to your clipboard.' : '';
    if (opened) setRowNote(row, 'Downloaded. Opened ' + ch.label + ' — attach the file and post.' + tail, 'ok');
    else setRowNote(row, 'Downloaded. Open ' + ch.label + ' and upload the file.' + tail, 'ok');
  }

  // Spawn a browser card and navigate it to the platform's upload page. Returns
  // true on success. Guarded: without the browser app / AtelierApps bridge (a
  // plain browser), returns false and the caller degrades to a plain message.
  function openInBrowserCard(url, inst) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    try {
      if (typeof A.spawnApp !== 'function') return false;
      const worldPos = neighborPos(inst);
      const cardEl = A.spawnApp('browser', worldPos);
      if (!cardEl) return false;
      if (window.AtelierApps && typeof window.AtelierApps.browserNavigate === 'function') {
        // navigate on the next tick so the webview has attached
        setTimeout(() => { try { window.AtelierApps.browserNavigate(cardEl, url); } catch { /* ignore */ } }, 60);
        return true;
      }
      return false;
    } catch { return false; }
  }

  // A world position just to the right of this card, so a spawned browser card
  // lands beside it rather than dead-center.
  function neighborPos(inst) {
    try {
      const r = inst.handle.getRect();
      return { x: r.x + r.w + 40, y: r.y };
    } catch { return null; }
  }

  function setRowNote(row, text, kind) {
    row._note.textContent = text || '';
    row._note.className = 'atl-pub-rnote' + (kind ? ' ' + kind : '');
  }
  function setRowSuccess(row, text, url) {
    row._note.textContent = '';
    row._note.className = 'atl-pub-rnote ok';
    const span = el('span', null, text + (url ? ' ' : ''));
    row._note.appendChild(span);
    if (url) {
      const a = el('a', null, 'View');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      row._note.appendChild(a);
    }
  }

  function channelRow(inst, ch, isAuto) {
    const row = el('div', 'atl-pub-row');
    row.appendChild(el('span', 'atl-pub-rname', ch.label));
    const mid = el('div', 'atl-pub-rmid');
    const hasToken = isAuto && !!tokenFor(ch.id);
    const badge = el('span', 'atl-pub-badge ' + (isAuto ? 'auto' : 'manual'),
      isAuto ? 'Posts automatically' : 'Get it ready — you post it');
    const note = el('div', 'atl-pub-rnote',
      isAuto
        ? (hasToken ? 'Token saved — posts through the backend.' : 'No token yet — add one in Settings, or post it by hand.')
        : 'Downloads the file and opens the upload page in a browser card.');
    mid.append(badge, note);
    const action = el('button', 'atl-pub-raction', isAuto ? 'Post' : 'Prepare');
    action.type = 'button';
    action.dataset.chId = ch.id;
    action.setAttribute('aria-label', (isAuto ? 'Post to ' : 'Prepare for ') + ch.label);
    row.append(mid, action);
    row._note = note; row._action = action;
    action.addEventListener('click', () => {
      if (isAuto) doAutoPost(inst, ch, row);
      else doManualPrepare(inst, ch, row);
    });
    inst.actionBtns.push(action);
    return row;
  }

  function renderChannels(inst) {
    if (!inst.channelsEl) return;
    inst.channelsEl.textContent = '';
    inst.actionBtns = [];

    inst.channelsEl.appendChild(el('div', 'atl-pub-sechead', 'Posts automatically'));
    AUTO_CHANNELS.forEach((ch) => inst.channelsEl.appendChild(channelRow(inst, ch, true)));
    inst.channelsEl.appendChild(el('div', 'atl-pub-sechead', 'Get it ready — you post it'));
    MANUAL_CHANNELS.forEach((ch) => inst.channelsEl.appendChild(channelRow(inst, ch, false)));

    updateActionState(inst);
  }

  function render(inst) {
    const body = inst.bodyEl;
    body.textContent = '';

    // deliverable picker + refresh
    const pick = el('div', 'atl-pub-pick');
    const picker = document.createElement('select');
    picker.className = 'atl-pub-sel';
    picker.setAttribute('aria-label', 'Choose a deliverable to publish');
    const refresh = el('button', 'atl-pub-icon', '⟳');
    refresh.type = 'button';
    refresh.title = 'Refresh the file list';
    refresh.setAttribute('aria-label', 'Refresh the file list');
    pick.append(picker, refresh);

    const scroll = el('div', 'atl-pub-scroll');

    // caption
    const cap = document.createElement('textarea');
    cap.className = 'atl-pub-cap';
    cap.placeholder = 'Caption (used by the automatic channels and copied for the manual ones)…';
    cap.maxLength = CAPTION_MAX;
    cap.value = inst.caption || '';
    cap.setAttribute('aria-label', 'Caption');

    // export row
    const exportRow = el('div', 'atl-pub-export');
    const exportBtn = el('button', 'atl-pub-btn', 'Download');
    exportBtn.type = 'button';
    exportBtn.setAttribute('aria-label', 'Download the selected deliverable');
    const exportNote = el('div', 'atl-pub-rnote');
    exportRow.append(exportBtn, exportNote);

    // channels
    const channelsEl = el('div', 'atl-pub-channels');

    scroll.append(cap, el('div', 'atl-pub-sechead', 'Export'), exportRow, channelsEl);

    // footer
    const foot = el('div', 'atl-pub-foot');
    foot.appendChild(el('div', 'atl-pub-footnote', 'Automatic channels need a token and the backend.'));
    const settingsBtn = el('button', 'atl-pub-btn ghost', 'Settings');
    settingsBtn.type = 'button';
    settingsBtn.setAttribute('aria-label', 'Open publishing channel settings');
    foot.appendChild(settingsBtn);

    body.append(pick, scroll, foot);

    inst.picker = picker;
    inst.exportBtn = exportBtn;
    inst.exportNote = exportNote;
    inst.channelsEl = channelsEl;
    inst.actionBtns = [];

    picker.addEventListener('change', () => {
      inst.path = picker.value || '';
      setExportNote(inst, '');
      updateActionState(inst);
      persist();
    });
    refresh.addEventListener('click', () => {
      refresh.disabled = true;
      fetchFiles(true).then(() => { populatePicker(inst); }).finally(() => { refresh.disabled = false; });
    });
    cap.addEventListener('input', () => {
      inst.caption = cap.value;
      cap.style.height = 'auto';
      cap.style.height = Math.min(cap.scrollHeight, 120) + 'px';
    });
    exportBtn.addEventListener('click', () => doExport(inst));
    settingsBtn.addEventListener('click', openSettings);

    renderChannels(inst);
    populatePicker(inst);
  }

  function spawnCard(opts = {}) {
    const id = opts.id || ('pub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    if (instances.has(id)) return instances.get(id);

    const card = el('section', 'card app-card atl-pub-card');
    card.dataset.pubInstance = id;
    const bar = el('div', 'card-bar');
    bar.append(el('span', 'card-dot'), el('span', 'card-title', 'Publish'), el('span', 'card-x', '×'));
    const body = el('div', 'app-body atl-pub-body');
    card.append(bar, body);

    let rect = opts.rect;
    if (!rect) {
      let pos = opts.worldPos;
      if (!pos) {
        const c = A.canvas.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
        pos = { x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 };
      }
      rect = { x: pos.x, y: pos.y, w: CARD_W, h: CARD_H };
    }
    const handle = A.canvas.addCard(card, rect);
    const inst = {
      id, handle, bodyEl: body,
      path: typeof opts.path === 'string' ? opts.path : '',
      caption: typeof opts.caption === 'string' ? opts.caption : '',
      busy: false, actionBtns: [],
    };
    instances.set(id, inst);

    card.addEventListener('mousedown', () => { dragId = id; }, true);
    // warm the shared file cache, THEN render (the picker needs it)
    fetchFiles().then(() => { render(inst); });
    if (!restoring) persist();
    return inst;
  }

  window.addEventListener('mouseup', () => {
    if (dragId && instances.has(dragId)) persist();
    dragId = null;
  });
  A.bus.on('cards:rearranged', () => persist());

  A.bus.on('card:removed', (d) => {
    const node = d && d.el;
    const rid = node && node.dataset && node.dataset.pubInstance;
    if (!rid || !instances.has(rid)) return;
    instances.delete(rid);
    persist();
  });

  function restoreFromStore() {
    const saved = A.store.get(STORE_KEY, []);
    if (!Array.isArray(saved)) return;
    restoring = true;
    try {
      saved.forEach((rec) => {
        if (!rec || !rec.id || instances.has(rec.id)) return;
        spawnCard({
          id: String(rec.id),
          rect: { x: Number(rec.x) || 0, y: Number(rec.y) || 0,
            w: Number(rec.w) || CARD_W, h: Number(rec.h) || CARD_H },
          path: typeof rec.path === 'string' ? rec.path : '',
          caption: typeof rec.caption === 'string' ? rec.caption : '',
        });
      });
    } finally {
      restoring = false;
    }
  }
  restoreFromStore();

  A.bus.on('boards:switched', () => {
    instances.forEach((inst, id) => {
      if (inst.handle && inst.handle.el && inst.handle.el.isConnected) return;
      instances.delete(id);
    });
    restoreFromStore();
  });

  A.registerApp('publish', {
    label: 'Publish',
    icon: '➤',
    create(worldPos) {
      const inst = spawnCard(worldPos ? { worldPos } : {});
      return inst ? inst.handle.el : null;
    },
  });

  // ⌘K entry for the channel settings (mirrors external.js's manager entry)
  A.bus.emit('palette:add', {
    id: 'publish.settings', label: 'Publishing channels…', icon: '➤', section: 'App',
    keywords: 'publish export post share channels tokens x twitter bluesky reddit webhook youtube tiktok instagram linkedin',
    run() { openSettings(); },
  });

  // Public API: open (or focus) a Publish card, optionally prefilled.
  window.AtelierPublish = {
    open(opts = {}) {
      const inst = spawnCard({
        worldPos: opts.worldPos,
        path: typeof opts.path === 'string' ? opts.path : '',
        caption: typeof opts.caption === 'string' ? opts.caption : '',
      });
      return inst ? inst.handle.el : null;
    },
    spawn: spawnCard,
    openSettings,
    instances,
    STORE_KEY,
  };

  (function selfCheck() {
    const registered = A.apps && A.apps.has && A.apps.has('publish');
    console.assert(registered, '[publish] publish app type not registered');
    console.assert(typeof window.AtelierPublish.open === 'function', '[publish] AtelierPublish.open missing');
    if (registered) console.log('[publish] ready — Publish card registered (⌘K → Add app: Publish). Export works now; automatic posting waits on POST /publish + a saved token.');
  })();
})();
