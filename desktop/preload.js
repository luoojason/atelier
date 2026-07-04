'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BASE = 'http://127.0.0.1:8765';

// Shared secret for the backend's mutating routes: main.js mints it per launch
// and sets process.env before creating the window (sandboxed preloads see a
// process.env subset). Empty when the page runs outside Electron — the backend
// only enforces the header when IT was launched with the token.
const TOKEN = (typeof process !== 'undefined' && process.env && process.env.ATELIER_TOKEN) || '';
const POST_HEADERS = Object.assign(
  { 'Content-Type': 'application/json' },
  TOKEN ? { 'X-Atelier-Token': TOKEN } : {}
);

// The fetch happens here in the preload (main-world isolated) rather than in the
// renderer so the renderer's page CSP never has to allow-list a network origin.
contextBridge.exposeInMainWorld('atelier', {
  chat: (message) =>
    fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({ message }),
    }).then((r) => r.json()),
  // Renderer modules that POST the backend directly (core's /chat/stream,
  // sessions.js) attach this themselves. Exposing it to the isolated main
  // world is fine: webview guests never see it (separate contents, preload
  // stripped by will-attach-webview), and renderer XSS is already game over.
  token: TOKEN,
  health: () => fetch(`${BASE}/health`).then((r) => r.json()),
  // GET http://127.0.0.1:8765<path> parsed as JSON. path must start with '/'.
  get: (path) => {
    if (typeof path !== 'string' || path[0] !== '/') {
      return Promise.reject(new Error('atelier.get: path must be a string starting with "/"'));
    }
    return fetch(BASE + path).then((r) => r.json());
  },
  // Capture a window region (rect in PHYSICAL pixels, caller pre-multiplies by
  // devicePixelRatio) -> 480px-wide JPEG(70) data URL, or null on ANY failure.
  capturePage: (rect) =>
    ipcRenderer.invoke('atelier:capture-page', rect).catch(() => null),
  // Scheduler daemon liveness -> { running, pid } from main's schedulerProc
  // handle; null on ANY failure (same never-reject idiom as capturePage).
  schedulerStatus: () =>
    ipcRenderer.invoke('atelier:scheduler-status').catch(() => null),
  // main.js denies tab-disposition popups from browser-card webviews and sends
  // them here as { url }; apps.js opens each as a tab in a browser card.
  onWebviewNewWindow: (cb) =>
    ipcRenderer.on('atelier:webview-new-window', (_e, data) => cb(data)),
  // Document card export: render self-contained document HTML to a PDF the
  // user picks a path for (Electron printToPDF, main process). Resolves
  // { saved } | { canceled } | { error } and never rejects.
  savePDF: (html, name) =>
    ipcRenderer.invoke('atelier:save-pdf', { html, name })
      .catch((e) => ({ error: String((e && e.message) || e) })),
  // Save arbitrary text (HTML/Markdown) to a user-chosen path.
  saveText: (text, name, ext) =>
    ipcRenderer.invoke('atelier:save-text', { text, name, ext })
      .catch((e) => ({ error: String((e && e.message) || e) })),
  // Save base64-encoded bytes (e.g. a .pptx from the Deck card) to a path.
  saveBinary: (b64, name, ext, filterName) =>
    ipcRenderer.invoke('atelier:save-binary', { b64, name, ext, filterName })
      .catch((e) => ({ error: String((e && e.message) || e) })),
  // Open the agent's file-write workspace folder in the OS file manager.
  // Resolves { ok } | { error }; never rejects. Path is guarded to the home
  // folder in the main process.
  revealFolder: (dirPath) =>
    ipcRenderer.invoke('atelier:reveal-folder', dirPath)
      .catch((e) => ({ error: String((e && e.message) || e) })),
  // UploadFile: attach a workspace file to a file <input> on a browser-card
  // webview via main-process CDP (renderer JS cannot set a file input to a
  // path). arg = { webContentsId, selector, path }. path is the backend-resolved
  // absolute workspace path; main re-checks it is inside the workspace. Resolves
  // { ok, text } | { ok:false, error }; never rejects.
  uploadToWebview: (arg) =>
    ipcRenderer.invoke('atelier:upload-to-webview', arg)
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
});
