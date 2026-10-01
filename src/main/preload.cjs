const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  dataDir: () => ipcRenderer.invoke('config:dir'),
  saveFile: (defaultName, data, filters) => ipcRenderer.invoke('file:save', { defaultName, data, filters }),
  openFile: (filters) => ipcRenderer.invoke('file:open', { filters }),
  leerCaptura: (data) => ipcRenderer.invoke('ocr:leer', data),
});
