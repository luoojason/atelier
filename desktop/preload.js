'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BASE = 'http://127.0.0.1:8765';

// The fetch happens here in the preload (main-world isolated) rather than in the
// renderer so the renderer's page CSP never has to allow-list a network origin.
contextBridge.exposeInMainWorld('atelier', {
  chat: (message) =>
    fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).then((r) => r.json()),
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
});
