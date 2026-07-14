const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  saveSlug: (slug) => ipcRenderer.invoke('save-slug', slug),
  getVersion: () => ipcRenderer.invoke('get-version'),
});
