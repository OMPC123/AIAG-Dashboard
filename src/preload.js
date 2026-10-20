const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboard', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  refresh: () => ipcRenderer.invoke('refresh'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  patchSettings: (p) => ipcRenderer.invoke('settings:patch', p),
  newShareToken: () => ipcRenderer.invoke('share:newToken'),
  parseRemote: (text) => ipcRenderer.invoke('remote:parse', text),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
});
