const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const log = require('electron-log');
const path = require('path');
const { buildSlipHtml } = require('./slip');

const ROOT_DOMAIN = 'cubcore.com';
// Dev only: point at a local server, e.g. CUBCORE_DEV_URL=http://localhost:3000
const DEV_URL = process.env.CUBCORE_DEV_URL || null;
const API_BASE = DEV_URL || `https://${ROOT_DOMAIN}`;
const kioskUrl = (slug) => (DEV_URL ? `${DEV_URL}/${slug}/kiosk` : `https://${slug}.${ROOT_DOMAIN}/kiosk`);

const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HEARTBEAT_MS = 5 * 60 * 1000;        // terminal check-in (shows "online" in admin)

// Stored keys:
//   warehouseSlug  — tenant slug
//   terminalToken  — secret issued by /api/kiosk/register
//   terminal       — { id, name, siteName }
//   printer        — { deviceName: string | null, paperWidth: 58 | 80 }
const store = new Store();

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

let mainWindow = null;
let powerSaveId = null;
let heartbeatTimer = null;
let inKioskMode = false;

// ─── Server calls ────────────────────────────────────────────────────────────

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'x-kiosk-terminal': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** 'ok' | 'revoked' | 'offline' */
async function checkTerminal() {
  const token = store.get('terminalToken');
  if (!token) return 'revoked';
  try {
    const r = await api('/api/kiosk/terminal', { token });
    if (r.ok) {
      store.set('terminal', r.data.terminal);
      return 'ok';
    }
    return r.status === 401 ? 'revoked' : 'offline';
  } catch {
    return 'offline';
  }
}

function clearRegistration() {
  store.delete('terminalToken');
  store.delete('terminal');
}

// ─── Setup window ────────────────────────────────────────────────────────────

function createSetupWindow() {
  inKioskMode = false;
  stopKioskTimers();

  // Kiosk screens are portrait touch panels with no keyboard: open the setup
  // screen large enough for its on-screen keyboard.
  const { workAreaSize } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: Math.min(760, workAreaSize.width),
    height: Math.min(1100, workAreaSize.height),
    center: true,
    autoHideMenuBar: true,
    title: 'Cubcore Kiosk — Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Kiosk window ────────────────────────────────────────────────────────────

function createKioskWindow(slug) {
  inKioskMode = true;

  mainWindow = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    title: 'Cubcore Kiosk',
    webPreferences: {
      preload: path.join(__dirname, 'kiosk-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep screen awake
  powerSaveId = powerSaveBlocker.start('prevent-display-sleep');

  mainWindow.loadURL(kioskUrl(slug));

  // Block navigation away from *.cubcore.com
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const u = new URL(navUrl);
      const allowed = DEV_URL
        ? u.origin === new URL(DEV_URL).origin
        : u.hostname === ROOT_DOMAIN || u.hostname.endsWith(`.${ROOT_DOMAIN}`);
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  // Block new windows from opening
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Admin shortcut: Ctrl+Shift+Q → go back to setup
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toUpperCase() === 'Q') {
      returnToSetup();
    }
  });

  // Block Alt+F4 / window close in kiosk mode
  mainWindow.on('close', (event) => {
    if (inKioskMode) event.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Check in periodically; if an admin removed this terminal, fall back to setup
  heartbeatTimer = setInterval(async () => {
    if ((await checkTerminal()) === 'revoked') {
      log.warn('Terminal was removed by an admin — returning to setup');
      clearRegistration();
      returnToSetup();
    }
  }, HEARTBEAT_MS);
}

function stopKioskTimers() {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Back to the setup screen. The registration is kept: setup offers
// "Back to kiosk", printer settings, or "Set up again".
function returnToSetup() {
  inKioskMode = false;
  if (mainWindow) mainWindow.destroy();
  createSetupWindow();
}

function launchKiosk() {
  const slug = store.get('warehouseSlug');
  if (mainWindow) mainWindow.destroy();
  createKioskWindow(slug);
}

// ─── Printing ────────────────────────────────────────────────────────────────

async function printSlip(slip) {
  const printer = store.get('printer') || { deviceName: null, paperWidth: 80 };
  const html = await buildSlipHtml(slip, printer.paperWidth || 80);

  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await new Promise((resolve) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          margins: { marginType: 'none' },
          ...(printer.deviceName ? { deviceName: printer.deviceName } : {}),
        },
        (success, failureReason) => {
          if (!success) log.error('Slip print failed:', failureReason);
          resolve(success ? { ok: true } : { ok: false, error: failureReason || 'Print failed' });
        }
      );
    });
  } catch (err) {
    log.error('Slip print error:', err);
    return { ok: false, error: err.message };
  } finally {
    // Give the spooler a moment before tearing the window down
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 2000);
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// Only one copy — a second launch would fight over the fullscreen kiosk
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // Register in Windows startup (runs when the user logs in)
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
    }

    // Terminals set up before v2 only stored a slug; they must register once.
    const registered = store.get('warehouseSlug') && store.get('terminalToken');
    if (registered && (await checkTerminal()) !== 'revoked') {
      // 'offline' still launches: the kiosk page shows its own network errors
      createKioskWindow(store.get('warehouseSlug'));
    } else {
      if (registered) clearRegistration();
      createSetupWindow();
    }

    // Auto-update only in production
    if (app.isPackaged) {
      autoUpdater.checkForUpdates();
      setInterval(() => autoUpdater.checkForUpdates(), UPDATE_INTERVAL_MS);
    }
  });
}

// Only quit from setup window; kiosk window blocks close via event handler above
app.on('window-all-closed', () => {
  if (!inKioskMode) app.quit();
});

// ─── IPC: setup screen ───────────────────────────────────────────────────────

ipcMain.handle('get-state', () => ({
  slug: store.get('warehouseSlug') || '',
  registered: !!store.get('terminalToken'),
  terminal: store.get('terminal') || null,
  printer: store.get('printer') || { deviceName: null, paperWidth: 80 },
}));

// Step 1: Warehouse ID + PIN → sites to choose from
ipcMain.handle('verify-pin', async (_, { slug, pin }) => {
  try {
    const r = await api('/api/kiosk/setup', { method: 'POST', body: { slug, pin } });
    return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data.error || `Server error (${r.status})` };
  } catch {
    return { ok: false, error: 'Cannot reach Cubcore. Check the internet connection.' };
  }
});

// Step 2: name + location → register, save, launch
ipcMain.handle('register', async (_, { slug, pin, name, siteId, printer }) => {
  try {
    const r = await api('/api/kiosk/register', { method: 'POST', body: { slug, pin, name, siteId } });
    if (!r.ok) return { ok: false, error: r.data.error || `Server error (${r.status})` };
    store.set('warehouseSlug', r.data.tenant.slug);
    store.set('terminalToken', r.data.token);
    store.set('terminal', r.data.terminal);
    store.set('printer', printer);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Cannot reach Cubcore. Check the internet connection.' };
  }
});

ipcMain.handle('save-printer', (_, printer) => {
  store.set('printer', printer);
});

ipcMain.handle('list-printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
});

ipcMain.handle('test-print', async (_, printer) => {
  store.set('printer', printer);
  const terminal = store.get('terminal');
  return printSlip({
    tenantName: 'Cubcore — Test Print',
    terminalName: terminal?.name || null,
    siteName: terminal?.siteName || null,
    queueNumber: 'A000',
    displayId: 'TEST',
    createdAt: new Date().toISOString(),
    kind: 'ready',
    orderIds: ['586278941293446388', 'MY2512345678901'],
    qrPayload: 'CUBCORE:test:ABC234',
    verificationCode: 'ABC234',
  });
});

ipcMain.handle('launch', () => launchKiosk());

ipcMain.handle('reset-terminal', () => {
  clearRegistration();
});

ipcMain.handle('get-version', () => app.getVersion());

// ─── IPC: kiosk page bridge (window.cubcoreKiosk) ────────────────────────────

ipcMain.handle('kiosk:get-terminal', () => {
  const token = store.get('terminalToken');
  const terminal = store.get('terminal');
  if (!token || !terminal) return null;
  return { token, name: terminal.name, siteName: terminal.siteName ?? null };
});

ipcMain.handle('kiosk:print-slip', (_, slip) => printSlip(slip));

// Touch-only admin gesture (5 taps in the top-left corner) — see kiosk-preload.js
ipcMain.on('admin-gesture', () => {
  if (inKioskMode) returnToSetup();
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    sendUpdateStatus('error', { message: 'Updates only work in the installed app, not in dev mode.' });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Also surfaced via the 'error' event below; swallow here to avoid an unhandled rejection.
    log.error('checkForUpdates failed:', err.message);
  }
});

// ─── Auto-updater ─────────────────────────────────────────────────────────────

function sendUpdateStatus(status, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, ...extra });
  }
}

autoUpdater.on('checking-for-update', () => {
  sendUpdateStatus('checking');
});

autoUpdater.on('update-available', (info) => {
  sendUpdateStatus('downloading', { version: info.version });
});

autoUpdater.on('update-not-available', () => {
  sendUpdateStatus('up-to-date');
});

autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus('downloading', { percent: Math.round(progress.percent) });
});

autoUpdater.on('update-downloaded', (info) => {
  log.info(`Update downloaded: v${info.version} — installing in 5 seconds`);
  sendUpdateStatus('installing', { version: info.version });
  // Give the kiosk page a moment, then silently restart and install
  setTimeout(() => {
    inKioskMode = false; // Allow the window to close
    autoUpdater.quitAndInstall(true, true);
  }, 5000);
});

autoUpdater.on('error', (err) => {
  log.error('Auto-updater error:', err.message);
  sendUpdateStatus('error', { message: err.message });
});
