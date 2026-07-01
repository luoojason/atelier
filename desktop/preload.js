'use strict';

const { contextBridge } = require('electron');

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
});
