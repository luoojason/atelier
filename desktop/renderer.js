'use strict';

const canvas = document.getElementById('canvas');
const content = document.getElementById('content');
const dotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const zoomLabel = document.getElementById('zoom-level');

// ── pan + zoom (matches OpenSwarm: drag bg to pan, wheel to zoom, wide range) ──
let panX = 0, panY = 0, zoom = 1;
const MIN_Z = 0.2, MAX_Z = 2;
function applyTransform() {
  content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
}
function zoomAt(nz, cx, cy) {                       // keep point (cx,cy) fixed
  nz = Math.min(MAX_Z, Math.max(MIN_Z, nz));
  panX = cx - (cx - panX) * (nz / zoom);
  panY = cy - (cy - panY) * (nz / zoom);
  zoom = nz; applyTransform();
}
function zoomCenter(nz) { const r = canvas.getBoundingClientRect(); zoomAt(nz, r.width / 2, r.height / 2); }
document.getElementById('zoom-in').onclick = () => zoomCenter(zoom * 1.15);
document.getElementById('zoom-out').onclick = () => zoomCenter(zoom / 1.15);
canvas.addEventListener('wheel', (e) => {
  if (e.target.closest('.chat-body') || e.target.closest('textarea')) return; // let cards scroll
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const factor = e.ctrlKey ? (1 - e.deltaY * 0.01) : (e.deltaY < 0 ? 1.1 : 1 / 1.1);
  zoomAt(zoom * factor, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// pan by dragging empty canvas
let panning = null;
canvas.addEventListener('mousedown', (e) => {
  if (e.target.closest('.card, .dock, .minimap, .zoombar')) return;
  panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
  canvas.classList.add('panning');
});
window.addEventListener('mousemove', (e) => {
  if (!panning) return;
  panX = panning.px + (e.clientX - panning.x);
  panY = panning.py + (e.clientY - panning.y);
  applyTransform();
});

// ── cards: drag (by bar), resize (handle), bringToFront, close ────────────────
let zTop = 10;
function bringToFront(card) { card.style.zIndex = ++zTop; }
function makeInteractive(card) {
  bringToFront(card);
  card.addEventListener('mousedown', () => bringToFront(card));
  const bar = card.querySelector('.card-bar');
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.card-x')) return;
    const start = { x: e.clientX, y: e.clientY, l: parseFloat(card.style.left) || 0, t: parseFloat(card.style.top) || 0 };
    const move = (ev) => { card.style.left = start.l + (ev.clientX - start.x) / zoom + 'px'; card.style.top = start.t + (ev.clientY - start.y) / zoom + 'px'; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    e.preventDefault();
  });
  card.querySelector('.card-x')?.addEventListener('click', () => card.remove());
  // resize handle
  let handle = card.querySelector('.resize-handle');
  if (!handle) { handle = document.createElement('div'); handle.className = 'resize-handle'; card.appendChild(handle); }
  handle.addEventListener('mousedown', (e) => {
    const start = { x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
    const move = (ev) => {
      card.style.width = Math.max(240, start.w + (ev.clientX - start.x) / zoom) + 'px';
      card.style.height = Math.max(160, start.h + (ev.clientY - start.y) / zoom) + 'px';
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    e.preventDefault(); e.stopPropagation();
  });
}
document.querySelectorAll('.card').forEach(makeInteractive);

// ── dock spawns app cards onto the canvas (like OpenSwarm) ────────────────────
const APPS = {
  note: { title: 'Note', body: () => `<textarea class="note-area" placeholder="Write a note…"></textarea>` },
  browser: { title: 'Browser', body: () => `<div class="app-stub">🌐 Browser card — open a site as a card. (Wire to a webview to enable.)</div>` },
  workflow: { title: 'Workflow', body: () => `<div class="app-stub">↺ Workflow — a scheduled Atelier job (research → gate → publish).</div>` },
  calendar: { title: 'Calendar', body: () => `<div class="app-stub">🗓 Calendar — schedule campaigns and posts.</div>` },
  history: { title: 'History', body: () => `<div class="app-stub">🕘 Recent sessions and run ledger.</div>` },
};
function spawnCard(type) {
  const spec = APPS[type]; if (!spec) return;
  const r = canvas.getBoundingClientRect();
  const cx = (r.width / 2 - panX) / zoom - 160, cy = (r.height / 2 - panY) / zoom - 110;
  const card = document.createElement('section');
  card.className = 'card app-card';
  card.style.cssText = `left:${cx}px; top:${cy}px; width:340px; height:230px;`;
  card.innerHTML = `<div class="card-bar"><span class="card-dot"></span><span class="card-title">${spec.title}</span><span class="card-x">×</span></div><div class="app-body">${spec.body()}</div>`;
  content.appendChild(card); makeInteractive(card);
}
document.querySelectorAll('.dock-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.dock-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const t = (b.getAttribute('title') || '').toLowerCase();
    if (t === 'chat') { document.getElementById('input')?.focus(); return; }
    if (t === 'apps') { spawnCard('note'); return; }
    if (t === 'campaign') { spawnCard('workflow'); return; }
    if (APPS[t]) spawnCard(t);
  });
});

// ── chat ──────────────────────────────────────────────────────────────────────
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const messagesEl = document.getElementById('messages');
let sending = false;
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function clearEmpty() { const e = document.getElementById('empty-state'); if (e) e.remove(); }
function avatar(role) { const a = document.createElement('div'); a.className = 'avatar'; a.textContent = role === 'assistant' ? 'A' : 'You'; return a; }
function addMessage(role, text) { clearEmpty(); const row = document.createElement('div'); row.className = `row ${role}`; const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text; row.append(avatar(role), b); messagesEl.appendChild(row); scrollBottom(); return b; }
function addThinking() { clearEmpty(); const row = document.createElement('div'); row.className = 'row assistant'; const b = document.createElement('div'); b.className = 'bubble thinking'; b.textContent = 'Thinking…'; row.append(avatar('assistant'), b); messagesEl.appendChild(row); scrollBottom(); return b; }
function extractReply(d) { if (d == null) return ''; if (typeof d === 'string') return d; return d.response ?? d.reply ?? d.message ?? d.text ?? d.output ?? d.content ?? ''; }
function extractError(d) { if (!d) return 'No response.'; return d.message ?? d.detail ?? (typeof d.error === 'string' ? d.error : null) ?? 'Something went wrong.'; }
async function send() {
  const text = inputEl.value.trim(); if (!text || sending) return;
  sending = true; sendEl.disabled = true; inputEl.value = ''; grow();
  addMessage('user', text); const t = addThinking();
  try { const data = await window.atelier?.chat(text); t.classList.remove('thinking'); t.textContent = (data && data.error) ? extractError(data) : (extractReply(data) || '(empty response)'); }
  catch { t.classList.remove('thinking'); t.textContent = 'Could not reach the Atelier backend. It may still be starting — try again in a moment.'; }
  finally { sending = false; sendEl.disabled = false; scrollBottom(); inputEl.focus(); }
}
function grow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }
inputEl.addEventListener('input', grow);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
sendEl.addEventListener('click', send);

// ── status + global mouseup ─────────────────────────────────────────────────
window.addEventListener('mouseup', () => { panning = null; canvas.classList.remove('panning'); });
function setStatus(ok) { dotEl.classList.remove('ok', 'bad'); if (ok === true) { dotEl.classList.add('ok'); statusTextEl.textContent = 'on subscription'; } else if (ok === false) { dotEl.classList.add('bad'); statusTextEl.textContent = 'backend offline'; } else { statusTextEl.textContent = 'connecting…'; } }
async function pollHealth() { try { const h = await window.atelier?.health(); setStatus(!!(h && (h.ok === true || h.status === 'ok'))); } catch { setStatus(false); } }
applyTransform(); setStatus(null); pollHealth(); setInterval(pollHealth, 4000); inputEl.focus();
