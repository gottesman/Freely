// Preload script: expose secure window control and app metadata APIs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    restore: () => ipcRenderer.send('window:restore'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChanged: (cb) => {
      ipcRenderer.on('window:maximized', (_ev, val) => cb(val))
    }
  },
});
