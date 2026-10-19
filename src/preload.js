const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboard', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  refresh: () => ipcRenderer.invoke('refresh'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:alwaysOnTop', on),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  newShareToken: () => ipcRenderer.invoke('share:newToken'),
});
