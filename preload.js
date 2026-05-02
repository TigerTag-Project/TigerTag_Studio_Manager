const { contextBridge, ipcRenderer } = require('electron');

// TD1S color sensor bridge (mirrors window.sensorAPI from TD1SxTigerTag-Electron)
contextBridge.exposeInMainWorld('td1s', {
  onSensorData: (callback) => ipcRenderer.on('td1s-data',   (_, data)  => callback(data)),
  onStatus:     (callback) => ipcRenderer.on('td1s-status', (_, msg)   => callback(msg)),
  onLog:        (callback) => ipcRenderer.on('td1s-log',    (_, entry) => callback(entry)),
  onClear:      (callback) => ipcRenderer.on('td1s-clear',  ()         => callback()),
  // Tell main process a TD1S-dependent UI opened / closed
  need:    () => ipcRenderer.send('td1s:need'),
  release: () => ipcRenderer.send('td1s:release'),
});

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

  // ── Auto-update preference (ON by default) ─────────────────────────────
  // Renderer toggles auto-update at runtime. Main process honours it on
  // startup and on subsequent manual checks.
  setAutoUpdate: (enabled) => ipcRenderer.send('update:set-auto', !!enabled),

  // Manually trigger an update check (used by "Check for updates" button).
  // Resolves with { ok: true } or { ok: false, error: "…" }.
  checkForUpdates: () => ipcRenderer.invoke('update:check-now'),

  // ── App info (version / platform — used by the diagnostic report) ──────
  getAppInfo: () => ipcRenderer.invoke('app:info'),

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
