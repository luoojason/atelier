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
});
