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
  genius: {
    search: (q) => ipcRenderer.invoke('genius:search', q),
    getSong: (id) => ipcRenderer.invoke('genius:getSong', id),
    getArtist: (id) => ipcRenderer.invoke('genius:getArtist', id),
    getAlbum: (id) => ipcRenderer.invoke('genius:getAlbum', id),
    getLyrics: (id) => ipcRenderer.invoke('genius:getLyrics', id)
  },
  spotify: {
    search: (q, types='track') => ipcRenderer.invoke('spotify:search', q, types),
    getTrack: (id) => ipcRenderer.invoke('spotify:getTrack', id),
    getAlbum: (id) => ipcRenderer.invoke('spotify:getAlbum', id),
    getArtist: (id) => ipcRenderer.invoke('spotify:getArtist', id),
    getAlbumTracks: (id, opts) => ipcRenderer.invoke('spotify:getAlbumTracks', id, opts),
    getArtistAlbums: (id, opts) => ipcRenderer.invoke('spotify:getArtistAlbums', id, opts),
    searchPlaylists: (q) => ipcRenderer.invoke('spotify:searchPlaylists', q),
    tokenStatus: () => ipcRenderer.invoke('spotify:tokenStatus')
  },
  torrent: {
    listScrapers: () => ipcRenderer.invoke('torrent:listScrapers'),
    search: (opts) => ipcRenderer.invoke('torrent:search', opts)
  }
});


// Expose charts API for renderer to request weekly tops via main process
contextBridge.exposeInMainWorld('charts', {
  getWeeklyTops: (opts) => ipcRenderer.invoke('charts:getWeeklyTops', opts)
});

// Database persistence API exposed to renderer
contextBridge.exposeInMainWorld('freelyDB', {
  read: () => ipcRenderer.invoke('db:read'),
  write: (data) => ipcRenderer.invoke('db:write', data),
  path: () => ipcRenderer.invoke('db:path')
});
