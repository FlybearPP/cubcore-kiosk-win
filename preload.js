const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  getState: () => ipcRenderer.invoke('get-state'),
  verifyPin: (slug, pin) => ipcRenderer.invoke('verify-pin', { slug, pin }),
  register: (details) => ipcRenderer.invoke('register', details),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  savePrinter: (printer) => ipcRenderer.invoke('save-printer', printer),
  testPrint: (printer) => ipcRenderer.invoke('test-print', printer),
  launch: () => ipcRenderer.invoke('launch'),
  resetTerminal: () => ipcRenderer.invoke('reset-terminal'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
