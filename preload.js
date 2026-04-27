const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // True when running inside Electron
  isElectron: true,

  // Called when a card is scanned — callback(uid, rawHex)
  onRfid: (callback) =>
    ipcRenderer.on('rfid-uid', (_, uid, rawHex) => callback(uid, rawHex)),

  // Called when reader connects/disconnects — callback({ connected, name, error? })
  onReaderStatus: (callback) =>
    ipcRenderer.on('reader-status', (_, status) => callback(status)),

  // Called when an app update is available or ready to install
  onUpdateStatus: (callback) =>
    ipcRenderer.on('update-status', (_, info) => callback(info)),

  // Ask main process to install the downloaded update and restart
  installUpdate: () => ipcRenderer.send('install-update'),

  // ── Image cache (main-process side) ─────────────────────────────────────
  imgGet: (url) => ipcRenderer.invoke('img:get', url),

  // ── Local DB (main-process side) ─────────────────────────────────────────
  db: {
    getLabel:                 (category, id) => ipcRenderer.invoke('db:getLabel', category, id),
    getMaterialLabel:         (id)           => ipcRenderer.invoke('db:getMaterialLabel', id),
    getPublicKeyForId:        (id)           => ipcRenderer.invoke('db:getPublicKeyForId', id),
    getAllLastUpdateTimestamps: ()            => ipcRenderer.invoke('db:getAllLastUpdateTimestamps'),
    isUpdateAvailable:        ()             => ipcRenderer.invoke('db:isUpdateAvailable'),
    updateIfNeeded:           ()             => ipcRenderer.invoke('db:updateIfNeeded'),
    downloadAndSaveLatestData: ()            => ipcRenderer.invoke('db:downloadAndSaveLatestData'),
  },
});
