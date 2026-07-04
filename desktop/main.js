'use strict';

const { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, screen, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');

// A Finder/launchd-launched app inherits a minimal PATH that omits the user's
// bin dirs, so the backend's `claude` CLI (the subscription model) would not be
// found. Rebuild a full PATH for the spawned backend.
const FULL_PATH = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || '',
].filter(Boolean).join(':');

// ── config ──────────────────────────────────────────────────────────────────
// The lite backend runs on the user's Claude Max subscription. Packaged, the
// backend sources live at <Resources>/backend and the relocatable interpreter
// (python-build-standalone, built by scripts/build-python-env.sh) at
// <Resources>/python-env — the .app has no dependency on the repo. In dev the
// repo + its light venv are used directly so edits run without a rebuild.
const PORT = 8765;
const DEV_REPO = '/Users/jasonluo08/Desktop/openswarm';
const BACKEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : DEV_REPO;
const BACKEND_PY = app.isPackaged
  ? path.join(process.resourcesPath, 'python-env', 'bin', 'python3')
  : path.join(DEV_REPO, '.venv-ext', 'bin', 'python');
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

// Jobs file for BOTH sidecars: the scheduler daemon fires it, and the backend's
// GET /jobs reads it (via SWARM_JOBS_FILE) so the Workflow/Calendar cards show
// the SAME file the daemon runs — not the repo's example fallback.
const JOBS_FILE = path.join(os.homedir(), '.atelier', 'jobs.yaml');
const JOBS_TEMPLATE = path.join(BACKEND_DIR, 'scheduler', 'jobs.atelier.yaml');

// Shared secret for the backend's MUTATING routes (POST /sessions etc.). The
// backend's origin regex must keep allowing Origin "null" (the file:// renderer
// sends it), and any internet page can mint "null" via a sandboxed iframe — so
// origin gating alone cannot protect agent-spawning writes. Minted fresh per
// launch, threaded to the backend + scheduler via spawn env and to the renderer
// via preload (process.env is part of the sandboxed-preload surface).
const ATELIER_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.ATELIER_TOKEN = ATELIER_TOKEN; // preload.js reads it from here

let backendProc = null;
let mainWindow = null;
let intentionalKill = false;   // set on quit/replace so the exit handler won't respawn
let respawns = 0;
let lastSpawnAt = 0;

// ── backend log (Finder-launched apps discard child stdio; keep a file) ──────
const LOG_DIR = path.join(os.homedir(), '.atelier', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backend.log');
let logStream = null;
const recentStderr = []; // last N lines, surfaced in the failure dialog
function openLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* first run */ }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.write(`\n[main] --- launch ${new Date().toISOString()} ---\n`);
  } catch { logStream = null; }
}
function logLine(s) {
  if (logStream) { try { logStream.write(s.endsWith('\n') ? s : s + '\n'); } catch { /* stream gone */ } }
}

// Kill whatever already holds our port. Our own backend is always killed on a
// clean quit, so anything listening here is a stale orphan (crash leftover) or
// a second launch — either way the fresh code must bind. Precise: kill only the
// PID(s) on the port, never a dev server on a different port.
async function clearStalePort() {
  try {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) return;
  } catch { return; } // nobody listening — normal path
  try {
    const out = cp.execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, { env: { PATH: FULL_PATH } }).toString();
    for (const pid of out.trim().split('\n').filter(Boolean)) {
      logLine(`[main] killing stale backend pid ${pid} holding port ${PORT}`);
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* lsof missing or nothing to kill */ }
}

// ── backend ─────────────────────────────────────────────────────────────────

function startBackend() {
  lastSpawnAt = Date.now();
  backendProc = cp.spawn(BACKEND_PY, [path.join(BACKEND_DIR, 'lite_server.py')], {
    cwd: BACKEND_DIR, // sys.path[0] -> config/shared_tools/campaign_agent/scheduler imports
    env: {
      ...process.env,
      PATH: FULL_PATH,
      DEFAULT_MODEL: 'claude-cli',
      PORT: String(PORT),
      SWARM_JOBS_FILE: JOBS_FILE, // GET /jobs must read the daemon's file, not the repo fallback
      ATELIER_TOKEN, // mutating routes require this header once set
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1', // never write .pyc into the sealed Resources tree
      CLAUDE_ISOLATED: '1',
    },
  });

  backendProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
    logLine(`[out] ${chunk}`.trimEnd());
  });
  backendProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend-err] ${chunk}`);
    logLine(`[err] ${chunk}`.trimEnd());
    for (const line of String(chunk).split('\n')) if (line.trim()) recentStderr.push(line);
    while (recentStderr.length > 60) recentStderr.shift();
  });
  backendProc.on('error', (err) => {
    console.error('[backend] failed to spawn:', err);
    logLine(`[main] spawn error: ${err}`);
  });
  backendProc.on('close', (code, signal) => {
    logLine(`[main] backend exited code=${code} signal=${signal}`);
    backendProc = null;
    if (intentionalKill) return;
    // Unexpected death (OOM under load, a crash, a lost port race). Respawn a
    // bounded number of times with backoff; reset the counter once it has been
    // healthy for a while so a genuinely broken build still gives up.
    if (Date.now() - lastSpawnAt > 10 * 60 * 1000) respawns = 0;
    if (respawns < 5) {
      const delay = [1000, 5000, 15000, 30000, 30000][respawns];
      respawns++;
      logLine(`[main] respawning backend in ${delay}ms (attempt ${respawns})`);
      setTimeout(() => { if (!backendProc && !intentionalKill) startBackend(); }, delay);
    } else {
      logLine('[main] giving up on backend after repeated exits');
    }
  });
}

async function waitForBackend(attempts = 90, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function killBackend() {
  if (!backendProc) return;
  const proc = backendProc;
  backendProc = null;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
  } catch {
    /* already gone */
  }
}

// ── scheduler daemon ────────────────────────────────────────────────────────
// Second sidecar: scheduler/scheduler.py fires the vault jobs in
// ~/.atelier/jobs.yaml (JOBS_FILE, declared with the config up top) at the lite
// backend (POST /open-swarm/get_response), populating ~/.openswarm/runs.jsonl
// so the app's live widgets show real data.

let schedulerProc = null;
let powerBlockerId = null;

function stopPowerBlocker() {
  if (powerBlockerId === null) return;
  try { powerSaveBlocker.stop(powerBlockerId); } catch { /* already stopped */ }
  powerBlockerId = null;
}

// Seed the jobs file from the shipped template on first boot only — an
// existing file is the user's and is never overwritten.
function ensureJobsFile() {
  if (fs.existsSync(JOBS_FILE)) return true;
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.copyFileSync(JOBS_TEMPLATE, JOBS_FILE);
    logLine(`[sched] seeded ${JOBS_FILE} from template`);
    return true;
  } catch (err) {
    logLine(`[sched] could not seed jobs file from ${JOBS_TEMPLATE}: ${err} — scheduler not started`);
    return false;
  }
}

function startScheduler() {
  if (schedulerProc || intentionalKill) return;
  if (!ensureJobsFile()) return;
  schedulerProc = cp.spawn(BACKEND_PY, [path.join(BACKEND_DIR, 'scheduler', 'scheduler.py')], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PATH: FULL_PATH,
      SWARM_BASE_URL: `http://127.0.0.1:${PORT}`,
      SWARM_JOBS_FILE: JOBS_FILE,
      SWARM_AIEOS_URL: 'http://127.0.0.1:7824',
      ATELIER_TOKEN, // the daemon POSTs the backend's compat route (mutating)
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1', // never write .pyc into the sealed Resources tree
    },
  });

  // A 7am job must fire even with the lid closed at 6:59.
  // ponytail: blanket blocker while the daemon lives; scoping it to due-jobs
  // windows is the upgrade.
  if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');

  schedulerProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[sched] ${chunk}`);
    logLine(`[sched] ${chunk}`.trimEnd());
  });
  schedulerProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[sched-err] ${chunk}`);
    logLine(`[sched] ${chunk}`.trimEnd());
  });
  schedulerProc.on('error', (err) => {
    console.error('[sched] failed to spawn:', err);
    logLine(`[sched] spawn error: ${err}`);
  });
  schedulerProc.on('close', (code, signal) => {
    logLine(`[sched] scheduler exited code=${code} signal=${signal}`);
    schedulerProc = null;
    stopPowerBlocker();
    // ponytail: no respawn for the daemon in v1 — missed fires are covered by
    // catch_up on next launch, and a daemon that dies twice is a bug to read
    // in the log, not to paper over.
  });
}

function killScheduler() {
  stopPowerBlocker();
  if (!schedulerProc) return;
  const proc = schedulerProc;
  schedulerProc = null;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
  } catch {
    /* already gone */
  }
}

// ── window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    title: 'Atelier',
    backgroundColor: '#17151f',
    icon: path.join(__dirname, '..', 'assets', 'atelier_1024.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // browser cards render sites in <webview partition="persist:atelier-browser">
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── webview hardening + renderer IPC ────────────────────────────────────────

// A clean Chrome UA (Electron + the app's own product token stripped), derived
// from Electron's default so the Chrome major/build always matches this runtime.
function cleanChromeUA() {
  return String(app.userAgentFallback || '')
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s*Atelier\/\S+/i, '');
}

// Rewrite the User-Agent Client Hints on a browser partition session so sites
// see plain Chrome (not Electron). Registered once per session (WeakSet guard);
// only ever called with a webview's partition session, never the default one.
const _chPatched = new WeakSet();
function patchClientHints(sess) {
  if (!sess || _chPatched.has(sess)) return;
  _chPatched.add(sess);
  const ua = cleanChromeUA();
  const major = (ua.match(/Chrome\/(\d+)/i) || [, '130'])[1];
  const full = (ua.match(/Chrome\/([\d.]+)/i) || [, '130.0.0.0'])[1];
  const brandList = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  const fullList = `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not?A_Brand";v="99.0.0.0"`;
  try {
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'sec-ch-ua') h[k] = brandList;
        else if (lk === 'sec-ch-ua-full-version-list') h[k] = fullList;
        else if (lk === 'sec-ch-ua-platform') h[k] = '"macOS"';
        else if (lk === 'sec-ch-ua-mobile') h[k] = '?0';
      }
      cb({ requestHeaders: h });
    });
  } catch { /* leave the apps.js UA-string tweak in place */ }
}

// The header rewrite above fixes what the NETWORK sees, but page JS still reads
// navigator.userAgentData.brands as "Chromium" under Electron — the exact tell
// Google uses to block embedded sign-in ("this browser may not be secure").
// CDP Network.setUserAgentOverride with userAgentMetadata is the only in-webview
// primitive that rewrites that in-page object (it is what Puppeteer/Playwright
// use for page.setUserAgent). It is passive — only sets the override, never
// pauses execution — so there is no hang risk. Attaching drops when the user
// opens the card's DevTools, so re-apply on devtools-closed. Best-effort: if CDP
// is unavailable the UA string + Sec-CH-UA rewrite still stand.
function attachUaMetadata(contents) {
  const ua = cleanChromeUA();
  const major = (ua.match(/Chrome\/(\d+)/i) || [, '130'])[1];
  const full = (ua.match(/Chrome\/([\d.]+)/i) || [, '130.0.0.0'])[1];
  const brands = (fullVer) => [
    { brand: 'Chromium', version: fullVer ? full : major },
    { brand: 'Google Chrome', version: fullVer ? full : major },
    { brand: 'Not?A_Brand', version: fullVer ? '99.0.0.0' : '99' },
  ];
  const apply = () => {
    try { contents.debugger.attach('1.3'); } catch { /* already attached */ }
    try {
      contents.debugger
        .sendCommand('Network.setUserAgentOverride', {
          userAgent: ua,
          acceptLanguage: 'en-US,en',
          platform: 'macOS',
          userAgentMetadata: {
            brands: brands(false),
            fullVersionList: brands(true),
            fullVersion: full,
            platform: 'macOS',
            platformVersion: '',
            architecture: process.arch === 'arm64' ? 'arm' : 'x86',
            model: '',
            mobile: false,
          },
        })
        .catch(() => { /* async reject — the header/UA-string disguise still stands */ });
    } catch { /* debugger not attached — ignore */ }
  };
  apply();
  contents.on('devtools-closed', apply);   // DevTools steals the CDP target; restore on close
}

app.on('web-contents-created', (_event, contents) => {
  // No webview preload in v1: strip any preload a <webview> tag (or a
  // compromised page) tries to attach. The effective key lives on the
  // webPreferences argument; params carries the tag attributes — clear both.
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    delete params.preload;
    delete params.preloadURL;
    // Defense-in-depth beyond the contract's "leave the rest default": pin the
    // dangerous webPreferences so a future renderer foothold cannot inject
    // <webview nodeintegration> and escalate to Node.
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
  });
  if (contents.getType() === 'webview') {
    // Make the Chrome disguise CONSISTENT: the UA string is stripped to Chrome
    // in apps.js, but the User-Agent Client Hints (Sec-CH-UA* request headers)
    // still carry the embedded/Electron brand, and a UA/Client-Hints mismatch is
    // itself a fingerprint. Rewrite the headers to match, on the browser
    // partition session only (the default session — app + backend — is never
    // touched). NOTE: this alone does NOT guarantee Google account sign-in works
    // — Google deliberately blocks embedded browsers via deeper signals too;
    // this just removes the easy tells.
    patchClientHints(contents.session);
    attachUaMetadata(contents); // also rewrite the in-page navigator.userAgentData
    // Tab dispositions (target=_blank links, cmd-click) are routed to the
    // renderer over 'atelier:webview-new-window' — apps.js opens them as tabs
    // in a browser card. Everything else (a real window.open popup, i.e. an
    // OAuth flow) gets a hardened child window: no Node, isolated, sandboxed,
    // parented to the main window so it dies with it.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // Scheme allowlist FIRST: web content can request any URL (file:///…,
      // javascript:, custom schemes) via window.open + a features string that
      // forces a 'new-window' disposition. Only http(s) may leave the webview
      // — for tab routing AND real popups (the OAuth use case is https).
      if (!/^https?:/i.test(url)) return { action: 'deny' };
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        mainWindow.webContents.send('atelier:webview-new-window', { url });
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          parent: mainWindow,
          fullscreenable: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            // Pin the OAuth popup to the SAME per-card partition as its opener so
            // a popup sign-in lands cookies in THIS card's jar and stays isolated
            // from other browser cards — without this the popup falls back to the
            // default session and the "each card = its own account" guarantee
            // breaks. `contents` is this card's webview.
            session: contents.session,
          },
        },
      };
    });
  } else {
    // window.open from the app's own pages must never spawn an in-app
    // BrowserWindow (chromeless, un-handled, popup-spammable). Hand http(s)
    // URLs to the OS default browser — this is what the browser card's
    // "Open in default browser" button rides on — and deny everything else.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

// atelier:capture-page — capture a region of the sender's window and return a
// 480px-wide JPEG data URL. rect is in PHYSICAL pixels (the renderer already
// multiplied by devicePixelRatio). Returns null on ANY failure, never throws.
// capturePage() itself takes the rect in DIP page coordinates (a physical-pixel
// rect on a 2x display returns an empty image), so convert here — the contract
// keeps the renderer side physical.
ipcMain.handle('atelier:capture-page', async (event, rect) => {
  try {
    const wc = event.sender;
    if (!wc || wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return null;
    let dip;
    if (rect) {
      const win = BrowserWindow.fromWebContents(wc);
      const sf = (win && screen.getDisplayMatching(win.getBounds()).scaleFactor) || 1;
      dip = {
        x: Math.round(rect.x / sf),
        y: Math.round(rect.y / sf),
        width: Math.round(rect.width / sf),
        height: Math.round(rect.height / sf),
      };
    }
    const img = await wc.capturePage(dip);
    if (!img || img.isEmpty()) return null;
    return 'data:image/jpeg;base64,' + img.resize({ width: 480 }).toJPEG(70).toString('base64');
  } catch {
    return null;
  }
});

// atelier:scheduler-status — is the scheduler daemon sidecar alive? Read from
// the same schedulerProc handle start/kill maintain; pid null when down.
ipcMain.handle('atelier:scheduler-status', () => ({
  running: !!schedulerProc,
  pid: schedulerProc ? schedulerProc.pid : null,
}));

// atelier:save-pdf — render a self-contained document HTML to a PDF the user
// picks a path for. Used by the Document card's export. The HTML is fully
// self-contained (the generator emits no network refs and no JS); we load it
// into an OFFSCREEN, node-less, JAVASCRIPT-DISABLED BrowserWindow, printToPDF,
// then write the chosen path. Returns { saved } | { canceled } | { error };
// never throws to the renderer.
ipcMain.handle('atelier:save-pdf', async (event, payload) => {
  const html = payload && typeof payload.html === 'string' ? payload.html : '';
  const suggested = (payload && payload.name) ? String(payload.name) : 'document';
  if (!html) return { error: 'no document to export' };
  const safe = suggested.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';
  let win = null;
  try {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { filePath, canceled } = await dialog.showSaveDialog(parent, {
      title: 'Export PDF',
      defaultPath: safe + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(filePath, pdf);
    return { saved: filePath };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
});

// atelier:save-text — write text (HTML/Markdown) to a user-chosen path.
ipcMain.handle('atelier:save-text', async (event, payload) => {
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  const suggested = (payload && payload.name) ? String(payload.name) : 'document';
  const ext = (payload && payload.ext) ? String(payload.ext).replace(/[^\w]/g, '').slice(0, 8) : 'txt';
  const safe = suggested.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';
  try {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { filePath, canceled } = await dialog.showSaveDialog(parent, {
      title: 'Save file',
      defaultPath: safe + '.' + (ext || 'txt'),
      filters: [{ name: (ext || 'txt').toUpperCase(), extensions: [ext || 'txt'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, text, 'utf8');
    return { saved: filePath };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// atelier:save-binary — write base64-encoded bytes (e.g. a .pptx from the Deck
// card) to a user-chosen path. base64 travels over IPC cleanly; the main
// process decodes and writes it. Returns { saved } | { canceled } | { error }.
ipcMain.handle('atelier:save-binary', async (event, payload) => {
  const b64 = payload && typeof payload.b64 === 'string' ? payload.b64 : '';
  const suggested = (payload && payload.name) ? String(payload.name) : 'file';
  const ext = (payload && payload.ext) ? String(payload.ext).replace(/[^\w]/g, '').slice(0, 8) : 'bin';
  const safe = suggested.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  if (!b64) return { error: 'nothing to save' };
  try {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { filePath, canceled } = await dialog.showSaveDialog(parent, {
      title: 'Save',
      defaultPath: safe + '.' + (ext || 'bin'),
      filters: [{ name: (payload && payload.filterName) || (ext || 'bin').toUpperCase(), extensions: [ext || 'bin'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
    return { saved: filePath };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// atelier:reveal-folder — open a folder (the agent's file-write workspace) in
// the OS file manager. Guarded to a directory UNDER the user's home so a
// compromised renderer cannot point it at an arbitrary system path; the folder
// is created if missing so a never-yet-used workspace still opens. Returns
// { ok } | { error }, never rejects.
ipcMain.handle('atelier:reveal-folder', async (event, dirPath) => {
  try {
    if (typeof dirPath !== 'string' || !dirPath.trim()) return { error: 'no path' };
    const home = fs.realpathSync(os.homedir());
    const target = path.resolve(dirPath);
    // Must be the home dir itself or strictly inside it (compare with a trailing
    // separator so '/Users/xevil' cannot pass as inside '/Users/x').
    if (target !== home && !target.startsWith(home + path.sep)) {
      return { error: 'refusing to reveal a path outside your home folder' };
    }
    fs.mkdirSync(target, { recursive: true });
    const err = await shell.openPath(target); // '' on success
    return err ? { error: err } : { ok: true };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// ── boot ────────────────────────────────────────────────────────────────────

// Single-instance lock: a second launch must not spawn a second backend that
// then dies on the port the first one holds (the exact "exited before
// answering" failure). Hand focus back to the running window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    openLog();
    await clearStalePort(); // take down any orphaned backend before we bind
    startBackend();

    // Open the window right away; the renderer shows a live status dot and starts
    // working as soon as the backend answers (its cold import can take 15-30s).
    createWindow();

    // Re-open the window on dock-icon activation (macOS). Registered HERE, inside
    // whenReady, on purpose: the 'activate' event can fire before the app is ready
    // during launch, and creating a BrowserWindow before ready throws
    // "Cannot create BrowserWindow before app is ready" — the crash users hit on
    // every open. Inside whenReady, activate only ever runs post-launch.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    const ready = await waitForBackend();
    // Spawn the scheduler after the health wait either way. Sequencing behind a
    // healthy backend is only a nicety (a job firing into a dead backend just
    // burns a retry, and the daemon's retry/notify machinery tolerates it);
    // never spawning it — a cold import slower than the 45s wait, a backend
    // that comes up via the respawn path — would silently lose every cron fire
    // and catch-up for the whole session.
    startScheduler();
    if (!ready) {
      console.warn('[backend] not ready after 45s — the window is open; it will connect when the backend answers.');
      // Only surface a dialog if the backend is not currently alive (a respawn
      // may be pending). Include the tail of stderr so the failure is not a
      // dead end, and point at the full log.
      if (!backendProc) {
        const tail = recentStderr.slice(-12).join('\n');
        dialog.showErrorBox(
          'Atelier backend could not start',
          [
            'The agency backend process exited before answering.',
            '',
            'Check that:',
            `  1. the interpreter exists: ${BACKEND_PY}`,
            `  2. lite_server.py exists at: ${BACKEND_DIR}`,
            '  3. the Claude CLI is logged into Claude Max (run: claude login)',
            '',
            `Full log: ${LOG_FILE}`,
            tail ? `\nLast backend output:\n${tail}` : '',
          ].join('\n'),
        );
      }
    }
  });

  app.on('window-all-closed', () => {
    intentionalKill = true;
    killScheduler();
    killBackend();
    app.quit();
  });

  app.on('before-quit', () => {
    intentionalKill = true;
    killScheduler();
    killBackend();
  });
}
