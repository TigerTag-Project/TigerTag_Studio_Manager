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

  // ── Google sign-in via loopback OAuth (RFC 8252 + PKCE) ────────────────
  // Opens the system browser (Safari on macOS, default on Win/Linux) so the
  // user can authenticate with Touch ID / passkey / hardware key NATIVELY.
  // The Chromium popup spawned by firebase.auth().signInWithPopup() can't
  // talk to the macOS authd daemon, which is why "Use your passkey" was
  // inert. Resolves with `{ ok, idToken, accessToken }` or `{ ok:false, error }`.
  signInWithGoogleLoopback: () => ipcRenderer.invoke('auth:google-loopback'),

  // ── UID migration in-flight signal ─────────────────────────────────────
  // Renderer announces when the inventory migration sweep starts and
  // finishes. Main uses this to intercept Cmd+Q / window close and prompt
  // the user before letting them quit mid-migration (which would leave
  // a partial state, even though the next launch would resume cleanly).
  setMigrationInFlight: (inFlight) => ipcRenderer.send('migration:set-in-flight', !!inFlight),

  // ── App info (version / platform — used by the diagnostic report) ──────
  getAppInfo:      () => ipcRenderer.invoke('app:info'),
  // Absolute path to renderer/ dir — used to build file:// preload paths
  // for <webview> elements (e.g. Creality camera preload script).
  getRendererPath: () => ipcRenderer.invoke('app:renderer-path'),

  // ── Local network — list active /24 LAN subnets (e.g. "192.168.1") so
  // the renderer can scan them for Snapmaker / Moonraker printers. Falls
  // back to common defaults in the renderer if this returns nothing.
  getLocalSubnets: () => ipcRenderer.invoke('net:get-local-subnets'),

  // ── mDNS — browse `_snapmaker._tcp.local.` for instant Snapmaker
  // discovery. Returns { ok, candidates: [{ name, host, port, fqdn,
  // addresses: [...], txt: { ip, machine_type, device_name, sn,
  // version, link_mode, ... } }] }. Empty array means either no
  // Snapmaker on the LAN OR mDNS multicast is filtered (firewall /
  // multi-VLAN without reflector) — renderer falls back to port-scan.
  mdnsBrowseSnapmaker: () => ipcRenderer.invoke('mdns:browse-snapmaker'),

  // ── FlashForge HTTP — bridge through main process to bypass CORS.
  // The FlashForge firmware (port 8898 /detail + /control) doesn't handle
  // CORS preflight, so direct fetch() from the renderer fails. This IPC
  // lets the renderer issue the same POST through Node's fetch (no CORS).
  // Returns the parsed JSON or { code:-1|-2, message } error envelopes —
  // identical shape to what the renderer used to build inline.
  ffgHttpPost: (url, body) => ipcRenderer.invoke('ffg:http-post', url, body),

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
