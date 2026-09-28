const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the kiosk web page (see dotbear-id src/app/[tenantSlug]/kiosk/page.tsx):
// terminal identity for site tagging, and silent slip printing.
contextBridge.exposeInMainWorld('cubcoreKiosk', {
  getTerminal: () => ipcRenderer.invoke('kiosk:get-terminal'),
  printSlip: (slip) => ipcRenderer.invoke('kiosk:print-slip', slip),
});

// Touch-only admin gesture: tap the hidden top-left corner 5x within 3s
// to reach the setup/settings screen (equivalent to Ctrl+Shift+Q).
const CORNER_SIZE = 60; // px
const TAP_WINDOW_MS = 3000;
const TAPS_REQUIRED = 5;

let tapTimestamps = [];
let badge = null;

function ensureBadge() {
  if (badge) return badge;
  badge = document.createElement('div');
  badge.style.cssText = `
    position: fixed; top: 6px; left: 6px; z-index: 2147483647;
    width: 28px; height: 28px; border-radius: 50%;
    background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.75);
    font: 700 13px -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none; opacity: 0; transition: opacity 0.2s;
  `;
  document.body.appendChild(badge);
  return badge;
}

function showBadge(count) {
  const el = ensureBadge();
  el.textContent = String(count);
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 800);
}

function onTap(x, y) {
  if (x > CORNER_SIZE || y > CORNER_SIZE) return;
  const now = Date.now();
  tapTimestamps.push(now);
  tapTimestamps = tapTimestamps.filter((t) => now - t <= TAP_WINDOW_MS);
  showBadge(tapTimestamps.length);
  if (tapTimestamps.length >= TAPS_REQUIRED) {
    tapTimestamps = [];
    ipcRenderer.send('admin-gesture');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('pointerdown', (e) => onTap(e.clientX, e.clientY), true);
});
