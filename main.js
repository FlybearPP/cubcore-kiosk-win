const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const log = require('electron-log');
const path = require('path');

const ROOT_DOMAIN = 'cubcore.com';
const SLUG_KEY = 'warehouseSlug';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

const store = new Store();

let mainWindow = null;
let powerSaveId = null;
let inKioskMode = false;

// ─── Setup window ────────────────────────────────────────────────────────────

function createSetupWindow() {
  inKioskMode = false;

  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }

  mainWindow = new BrowserWindow({
    width: 480,
    height: 540,
    resizable: false,
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
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep screen awake
  powerSaveId = powerSaveBlocker.start('prevent-display-sleep');

  const kioskUrl = `https://${slug}.${ROOT_DOMAIN}/kiosk`;
  mainWindow.loadURL(kioskUrl);

  // Block navigation away from *.cubcore.com
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const host = new URL(navUrl).hostname;
      if (!host.endsWith(`.${ROOT_DOMAIN}`) && host !== ROOT_DOMAIN) {
        event.preventDefault();
      }
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
}

function returnToSetup() {
  store.delete(SLUG_KEY);
  inKioskMode = false;
  if (mainWindow) mainWindow.destroy();
  createSetupWindow();
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Register in Windows startup (runs when the user logs in)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
  }

  const slug = store.get(SLUG_KEY);
  if (slug) {
    createKioskWindow(slug);
  } else {
    createSetupWindow();
  }

  // Auto-update only in production
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), UPDATE_INTERVAL_MS);
  }
});

// Only quit from setup window; kiosk window blocks close via event handler above
app.on('window-all-closed', () => {
  if (!inKioskMode) app.quit();
});

// ─── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.handle('save-slug', (_, slug) => {
  const trimmed = slug.trim().toLowerCase();
  store.set(SLUG_KEY, trimmed);
  if (mainWindow) mainWindow.destroy();
  createKioskWindow(trimmed);
});

ipcMain.handle('get-version', () => app.getVersion());

// ─── Auto-updater ─────────────────────────────────────────────────────────────

autoUpdater.on('update-downloaded', (info) => {
  log.info(`Update downloaded: v${info.version} — installing in 5 seconds`);
  // Give the kiosk page a moment, then silently restart and install
  setTimeout(() => {
    inKioskMode = false; // Allow the window to close
    autoUpdater.quitAndInstall(true, true);
  }, 5000);
});

autoUpdater.on('error', (err) => {
  log.error('Auto-updater error:', err.message);
});
