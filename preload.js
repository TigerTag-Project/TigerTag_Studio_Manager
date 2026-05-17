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

contextBridge.exposeInMainWorld('bambulab', {
  connect:    (opts) => ipcRenderer.send('bambulab:connect',    opts),
  disconnect: (key)  => ipcRenderer.send('bambulab:disconnect', key),
  publish:    (key, payload) => ipcRenderer.send('bambulab:publish', key, payload),
  onMessage:  (cb) => ipcRenderer.on('bambulab:message',   (_, key, topic, data) => cb(key, topic, data)),
  onStatus:   (cb) => ipcRenderer.on('bambulab:status',    (_, key, status)      => cb(key, status)),
  camStart:     (opts) => ipcRenderer.send('bambulab:cam-start',      opts),
  camStop:      (key)  => ipcRenderer.send('bambulab:cam-stop',       key),
  camStartRtsp: (opts) => ipcRenderer.send('bambulab:cam-start-rtsp', opts),
  camStopRtsp:  (key)  => ipcRenderer.send('bambulab:cam-stop-rtsp',  key),
  onCamFrame:   (cb)   => ipcRenderer.on('bambulab:cam-frame', (_, key, b64) => cb(key, b64)),
});

contextBridge.exposeInMainWorld('elegoo', {
  connect:    (opts)                => ipcRenderer.send('elegoo:connect',    opts),
  disconnect: (key)                 => ipcRenderer.send('elegoo:disconnect', key),
  publish:    (key, topic, payload) => ipcRenderer.send('elegoo:publish', key, topic, payload),
  onMessage:  (cb) => ipcRenderer.on('elegoo:message', (_, key, topic, data) => cb(key, topic, data)),
  onStatus:   (cb) => ipcRenderer.on('elegoo:status',  (_, key, status)      => cb(key, status)),
});

contextBridge.exposeInMainWorld('electronAPI', {
  // True when running inside Electron
  isElectron: true,

  // Called when a card is scanned — callback(uid, rawHex)
  onRfid: (callback) =>
    ipcRenderer.on('rfid-uid', (_, uid, rawHex) => callback(uid, rawHex)),

  // Called when reader connects/disconnects — callback({ name, connected })
  onReaderStatus: (callback) =>
    ipcRenderer.on('reader-status', (_, status) => callback(status)),

  // Called when a reader connects/disconnects (new unified event)
  onRfidReaderUpdate: (callback) =>
    ipcRenderer.on('rfid-reader-update', (_, data) => callback(data)),

  // Called when a card appears/disappears on a reader — callback({ readerName, uid, rawUid })
  onRfidCardPresent: (callback) =>
    ipcRenderer.on('rfid-card-present', (_, data) => callback(data)),

  // On-demand read: returns { ok, uid, rawUid, rawPagesHex, tigerTag } | { ok:false, error }
  readRfidNow: (readerName) =>
    ipcRenderer.invoke('rfid:read-now', readerName),

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
  // Open a URL in the default system application (e.g. VLC for rtsp://).
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  // Show native Save dialog and stream a timelapse video from the printer to disk.
  downloadTimelapse: (url, filename) => ipcRenderer.invoke('timelapse:download', url, filename),

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

  // ── Snapmaker HTTP GET — bridge through main process to bypass CORS.
  // Direct fetch() from the renderer to http://<local-ip>:7125 is cross-
  // origin (page origin is http://localhost:<port>) and blocked by
  // Chromium. Node's fetch() in main is not subject to CORS, so it goes
  // through cleanly — identical to what the Flutter http.get() calls do.
  // timeoutMs is optional (main-process default is 3500 ms).
  // Returns { ok, status, json } | { ok: false, error }.
  snapHttpGet: (url, timeoutMs) => ipcRenderer.invoke('snap:http-get', url, timeoutMs),

  // ── FlashForge HTTP — bridge through main process to bypass CORS.
  // The FlashForge firmware (port 8898 /detail + /control) doesn't handle
  // CORS preflight, so direct fetch() from the renderer fails. This IPC
  // lets the renderer issue the same POST through Node's fetch (no CORS).
  // timeoutMs is optional (default 4000 ms for live polling; 350 ms for scan).
  // Returns the parsed JSON or { code:-1|-2, message } error envelopes.
  ffgHttpPost: (url, body, timeoutMs) => ipcRenderer.invoke('ffg:http-post', url, body, timeoutMs),

  // ── FlashForge UDP Multicast discovery (Adventurer 4 era).
  // Sends "Hello World!" to 225.0.0.9:19000, collects IP+name replies 2.5 s.
  // Returns { ok, candidates: [{ ip, printerName }] }.
  ffgMulticastDiscover: () => ipcRenderer.invoke('ffg:multicast-discover'),

  // ── FlashForge TCP probe — port 8899, M115 identity fallback.
  // Connects to ip:8899, sends ~M115\r\n, parses response (700 ms timeout).
  // Returns { ok, fields: { machineModel, machineName, firmware, serialNumber, macAddress } }.
  ffgTcpProbe: (ip) => ipcRenderer.invoke('ffg:tcp-probe', ip),

  // ── Image cache (main-process side) ─────────────────────────────────────
  imgGet: (url) => ipcRenderer.invoke('img:get', url),

  // ── Local DB (main-process side) ─────────────────────────────────────────
  db: {
    getLookups:               ()             => ipcRenderer.invoke('db:getLookups'),
    getLabel:                 (category, id) => ipcRenderer.invoke('db:getLabel', category, id),
    getMaterialLabel:         (id)           => ipcRenderer.invoke('db:getMaterialLabel', id),
    getBambuMaterials:        ()             => ipcRenderer.invoke('db:getBambuMaterials'),
    getPublicKeyForId:        (id)           => ipcRenderer.invoke('db:getPublicKeyForId', id),
    getAllLastUpdateTimestamps: ()            => ipcRenderer.invoke('db:getAllLastUpdateTimestamps'),
    isUpdateAvailable:        ()             => ipcRenderer.invoke('db:isUpdateAvailable'),
    updateIfNeeded:           ()             => ipcRenderer.invoke('db:updateIfNeeded'),
    downloadAndSaveLatestData: ()            => ipcRenderer.invoke('db:downloadAndSaveLatestData'),
  },
});
