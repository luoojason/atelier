'use strict';

const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

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
    // ponytail: popups denied in v1 — OAuth-in-browser-card needs routing later
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

    const ready = await waitForBackend();
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    intentionalKill = true;
    killBackend();
    app.quit();
  });

  app.on('before-quit', () => {
    intentionalKill = true;
    killBackend();
  });
}
