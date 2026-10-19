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
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  accounts: {
    add: (name, login, type, accountUuid) => ipcRenderer.invoke('accounts:add', { name, login, type, accountUuid }),
    link: (id, accountUuid) => ipcRenderer.invoke('accounts:link', { id, accountUuid }),
    convertToWeb: (id) => ipcRenderer.invoke('accounts:convertToWeb', id),
    addFolder: () => ipcRenderer.invoke('accounts:addFolder'),
    login: (id) => ipcRenderer.invoke('accounts:login', id),
    logout: (id) => ipcRenderer.invoke('accounts:logout', id),
    open: (id) => ipcRenderer.invoke('accounts:open', id),
    copyCommand: (id) => ipcRenderer.invoke('accounts:copyCommand', id),
    showFolder: (id) => ipcRenderer.invoke('accounts:showFolder', id),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  },
});
