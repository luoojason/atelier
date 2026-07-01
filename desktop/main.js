'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const os = require('os');
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
// The lite backend runs on the user's Claude Max subscription. It is spawned
// from the openswarm repo with the light venv so the heavy media deps are never
// imported. Paths are absolute on purpose — the packaged .app has a different
// __dirname, but the backend and its venv always live in the repo.
const PORT = 8765;
const REPO_DIR = '/Users/jasonluo08/Desktop/openswarm';
const BACKEND_PY = '/Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python';
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

let backendProc = null;
let mainWindow = null;

// ── backend ─────────────────────────────────────────────────────────────────

function startBackend() {
  backendProc = cp.spawn(BACKEND_PY, ['lite_server.py'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PATH: FULL_PATH,
      DEFAULT_MODEL: 'claude-cli',
      PORT: String(PORT),
      PYTHONUNBUFFERED: '1',
    },
  });

  backendProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  backendProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend-err] ${chunk}`);
  });
  backendProc.on('error', (err) => {
    console.error('[backend] failed to spawn:', err);
  });
  backendProc.on('close', (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    backendProc = null;
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
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  startBackend();

  // Open the window right away; the renderer shows a live status dot and starts
  // working as soon as the backend answers (its cold import can take 15-30s).
  createWindow();

  const ready = await waitForBackend();
  if (!ready) {
    console.warn('[backend] not ready after 45s — the window is open; it will connect when the backend answers.');
    // Only surface a dialog if the backend process died outright (a real config problem).
    if (!backendProc) {
      dialog.showErrorBox(
        'Atelier backend could not start',
        [
          'The agency backend process exited before answering.',
          '',
          'Check that:',
          `  1. the venv exists: ${BACKEND_PY}`,
          `  2. lite_server.py exists at: ${REPO_DIR}`,
          '  3. the Claude CLI is logged into Claude Max (run: claude login)',
        ].join('\n'),
      );
    }
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  killBackend();
  app.quit();
});

app.on('before-quit', () => {
  killBackend();
});
