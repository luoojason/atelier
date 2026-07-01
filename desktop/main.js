'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const cp = require('child_process');

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

async function waitForBackend(attempts = 30, delayMs = 500) {
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

  const ready = await waitForBackend();
  if (!ready) {
    dialog.showErrorBox(
      'Atelier backend did not start',
      [
        `The agency backend did not answer on ${HEALTH_URL} within 15 seconds.`,
        '',
        'Common fixes:',
        `  1. The venv must exist: ${BACKEND_PY}`,
        `  2. lite_server.py must exist at: ${REPO_DIR}`,
        '  3. The Claude CLI must be logged into Claude Max:',
        '       claude login',
        '',
        'Check the terminal for [backend-err] lines, then relaunch.',
      ].join('\n'),
    );
    killBackend();
    app.quit();
    return;
  }

  createWindow();
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
