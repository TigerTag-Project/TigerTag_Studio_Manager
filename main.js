const { app, BrowserWindow, ipcMain, shell, session, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');
const db = require('./services/tigertagDbService');

// ── App display name (macOS menu bar, About dialog, Dock, etc.)
// package.json `name` is "tigertag-inventory" (npm-friendly slug). Force the
// human-readable product name so macOS shows "Tiger Studio Manager" in:
//   - app menu (Apple menu → "About Tiger Studio Manager", "Quit Tiger Studio Manager")
//   - Dock tooltip
//   - Window menu items
// Must be called BEFORE app.whenReady() / before any window is created.
app.setName('Tiger Studio Manager');

// ── Single-instance lock ────────────────────────────────────────────────────
// Prevent multiple Electron processes from sharing the same userData directory
// (which would deadlock IndexedDB / LevelDB — Firebase Auth, image cache, etc.).
// If a 2nd launch is attempted, focus the existing window and quit immediately.
const _hasInstanceLock = app.requestSingleInstanceLock();
if (!_hasInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Minimal static file server so location.protocol === 'http:' (required by Firebase Auth)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};
let _devServer;
let _devPort;
// Port fixe = même origin à chaque démarrage → Firebase Auth + localStorage persistent
const RENDERER_PORT = 5784;

function startRendererServer(rendererDir) {
  return new Promise((resolve, reject) => {
    _devServer = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/' || urlPath === '') urlPath = '/inventory.html';
      const filePath = path.join(rendererDir, urlPath);
      try {
        const data = fs.readFileSync(filePath);
        const ext  = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    _devServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port déjà utilisé → port aléatoire en fallback (session non persistée)
        console.warn(`[Renderer] port ${RENDERER_PORT} occupé, fallback port aléatoire`);
        _devServer.listen(0, 'localhost', () => {
          _devPort = _devServer.address().port;
          console.log(`[Renderer] http://localhost:${_devPort} (fallback)`);
          resolve(_devPort);
        });
      } else { reject(err); }
    });
    _devServer.listen(RENDERER_PORT, 'localhost', () => {
      _devPort = RENDERER_PORT;
      console.log(`[Renderer] http://localhost:${_devPort}`);
      resolve(_devPort);
    });
  });
}

let imgCacheDir;

let mainWindow;

// NFC state — replayed to renderer on every (re)load
const _nfcReaders     = new Map();  // name → reader object
const _nfcCardPresent = new Map();  // name → { uid, rawUid }

// ── Convert hex UID (e.g. "1D895E7C004A80") to decimal string used by TigerTag
function hexToDecimalUid(hex) {
  try {
    return BigInt('0x' + hex.replace(/[:\s]/g, '')).toString();
  } catch {
    return hex;
  }
}

// ── TigerTag binary parser (isolated module) ──────────────────────────────────
const { parseTigerTag } = require('./renderer/rfid_protocol/tigertag/parser.js');

// ── Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Tiger Studio Manager',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,    // required for <webview> Creality camera (cross-origin JS injection)
    },
  });

  startRendererServer(__dirname).then(port => {
    mainWindow.loadURL(`http://localhost:${port}/renderer/inventory.html`);
  });

  // Firebase auth popup → ouvrir en interne (postMessage doit fonctionner)
  // Tous les autres liens → navigateur système
  const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tigertag-connect.firebaseapp.com/__/auth/')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // nécessaire pour que window.opener.postMessage fonctionne
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Appliquer un vrai user-agent Chrome sur la fenêtre popup
  // pour que Google ne bloque pas le webview Electron
  mainWindow.webContents.on('did-create-window', (win) => {
    win.webContents.setUserAgent(CHROME_UA);
    // Aussi bloquer les redirections externes depuis le popup auth
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

// ── NFC / RFID reader
function initNFC() {
  let nfc;
  try {
    const { NFC } = require('nfc-pcsc');  // named export, not the module object
    nfc = new NFC();
  } catch (err) {
    console.warn('[NFC] not available:', err.message);
    return;
  }

  nfc.on('reader', (reader) => {
    const rName = reader.name;
    console.log(`[NFC] Reader connected: ${rName}`);
    _nfcReaders.set(rName, reader);
    mainWindow?.webContents.send('rfid-reader-update', { name: rName, connected: true });

    reader.on('card', (card) => {
      const rawUid = card.uid;
      const uid    = hexToDecimalUid(rawUid);
      console.log(`[NFC] Card present on ${rName} — uid: ${uid}`);
      _nfcCardPresent.set(rName, { uid, rawUid });
      // Notify inventory for automatic spool lookup
      mainWindow?.webContents.send('rfid-uid', uid, rawUid);
      // Notify RFID tester modal — card present, not yet read
      mainWindow?.webContents.send('rfid-card-present', { readerName: rName, uid, rawUid });
    });

    reader.on('card.off', () => {
      console.log(`[NFC] Card removed from ${rName}`);
      _nfcCardPresent.delete(rName);
      mainWindow?.webContents.send('rfid-card-present', { readerName: rName, uid: null, rawUid: null });
    });

    reader.on('error', (err) => {
      console.error(`[NFC] Reader error on ${rName}:`, err.message);
    });

    reader.on('end', () => {
      console.log(`[NFC] Reader disconnected: ${rName}`);
      _nfcReaders.delete(rName);
      _nfcCardPresent.delete(rName);
      mainWindow?.webContents.send('rfid-reader-update', { name: rName, connected: false });
    });
  });

  nfc.on('error', (err) => {
    console.error('[NFC] NFC error:', err.message);
  });
}

// On-demand card read — called by renderer "Read" button in RFID tester
ipcMain.handle('rfid:read-now', async (_evt, readerName) => {
  const reader = _nfcReaders.get(readerName);
  if (!reader)                         return { ok: false, error: 'Reader not connected' };
  const card = _nfcCardPresent.get(readerName);
  if (!card)                           return { ok: false, error: 'No card present' };
  try {
    const data      = await reader.read(0, 180, 4);  // 45 pages × 4 bytes
    const rawPagesHex = data.toString('hex');
    const tigerTag  = parseTigerTag(data);
    console.log('[NFC] read-now result:', tigerTag ? tigerTag.version : 'unknown format');
    return { ok: true, uid: card.uid, rawUid: card.rawUid, rawPagesHex, tigerTag };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// ── TD1S color sensor ────────────────────────────────────────────────────────
function initTD1S() {
  // Lazy require — same pattern as initNFC(), non-fatal if unavailable
  let SerialPort, ReadlineParser;
  try {
    SerialPort    = require('serialport').SerialPort;
    ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
  } catch (err) {
    console.warn('[TD1S] serialport not available:', err.message);
    return;
  }

  const TD1S_VID  = 'e4b2';
  const TD1S_PID  = '0045';
  const TD1S_BAUD = 115200;

  let td1sPort      = null;
  let td1sConnected = false;
  let td1sLastPair  = null;
  let td1sReconnect = null;
  let td1sNeedCount = 0;   // how many UI panels currently need TD1S

  // ── State replayed to renderer on every page (re)load ────────────────────
  let currentStatus  = 'Status: Starting…';
  let currentTd      = null;
  let currentHex     = null;
  const logBuffer    = [];   // ring buffer – last 80 entries
  const LOG_BUF_MAX  = 80;

  function td1sTs() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function td1sLog(type, message) {
    const entry = { time: td1sTs(), type, message };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUF_MAX) logBuffer.shift();
    mainWindow?.webContents.send('td1s-log', entry);
    console.log(`[TD1S:${type.toUpperCase()}] ${message}`);
  }

  function td1sStatus(msg) {
    currentStatus = msg;
    mainWindow?.webContents.send('td1s-status', msg);
  }

  function td1sData(td, hex) {
    currentTd  = td;
    currentHex = hex;
    mainWindow?.webContents.send('td1s-data', { TD: td, HEX: hex });
  }

  // On every renderer (re)load: replay the log buffer + push current state
  mainWindow.webContents.on('did-finish-load', () => {
    for (const entry of logBuffer) {
      mainWindow.webContents.send('td1s-log', entry);
    }
    mainWindow.webContents.send('td1s-status', currentStatus);
    if (currentTd !== null) {
      mainWindow.webContents.send('td1s-data', { TD: currentTd, HEX: currentHex });
    }
    // Replay NFC reader + card state — needed when reader was already connected at startup
    for (const name of _nfcReaders.keys()) {
      mainWindow.webContents.send('rfid-reader-update', { name, connected: true });
    }
    for (const [name, card] of _nfcCardPresent.entries()) {
      mainWindow.webContents.send('rfid-card-present', { readerName: name, uid: card.uid, rawUid: card.rawUid });
    }
  });

  function extractTdHex(rawLine) {
    const parts = rawLine.split(',').map(p => p.trim()).filter(p => p.length > 0);
    let scanTd = null, scanHex = null, hexIndex = null;

    for (let i = 0; i < parts.length; i++) {
      if (parts[i].toLowerCase().startsWith('td:')) {
        if (i + 1 < parts.length) {
          const v = parseFloat(parts[i + 1].replace(',', '.'));
          if (!isNaN(v)) scanTd = v;
        }
        break;
      }
    }
    for (let i = 0; i < parts.length; i++) {
      const cleaned = parts[i].replace(/\s/g, '');
      if (cleaned.length === 6 && /^[0-9A-Fa-f]{6}$/.test(cleaned)) {
        scanHex = cleaned.toUpperCase(); hexIndex = i; break;
      }
    }
    if (scanTd === null && hexIndex !== null) {
      for (let i = 0; i < hexIndex; i++) {
        const v = parseFloat(parts[i].replace(',', '.'));
        if (!isNaN(v) && v >= 0 && v <= 100) { scanTd = v; break; }
      }
    }
    if (scanTd !== null && scanHex !== null) return { td: scanTd.toFixed(1), hex: scanHex };
    return null;
  }

  async function td1sFind() {
    td1sLog('debug', `Scan serial ports (VID=${TD1S_VID} PID=${TD1S_PID})...`);
    const ports = await SerialPort.list();
    if (ports.length === 0) { td1sLog('debug', 'No serial ports detected'); return null; }
    td1sLog('debug', `${ports.length} port(s) found:`);
    for (const p of ports) {
      const vid = (p.vendorId || '').toLowerCase();
      const pid = (p.productId || '').toLowerCase();
      const label = p.manufacturer ? ` [${p.manufacturer}]` : '';
      const match = vid === TD1S_VID && pid === TD1S_PID;
      td1sLog(match ? 'success' : 'debug',
        `  ${p.path}  VID=${vid || '----'} PID=${pid || '----'}${label}${match ? '  ← MATCH TD1S' : ''}`
      );
      if (match) return p.path;   // use path as-is (tty.* works, no cu.* conversion needed)
    }
    return null;
  }

  function td1sClose() {
    if (td1sPort) { if (td1sPort.isOpen) td1sPort.close(() => {}); td1sPort = null; }
    td1sConnected = false;
  }

  // Cancel any pending poll timer
  function td1sStopWatcher() {
    if (td1sReconnect) { clearTimeout(td1sReconnect); td1sReconnect = null; }
  }

  // Schedule one connect attempt in 1.5 s (called only when a UI panel needs TD1S)
  function td1sStartPolling() {
    if (td1sReconnect || td1sConnected || app.isQuitting) return;
    td1sLog('info', 'TD1S needed by UI — polling...');
    td1sReconnect = setTimeout(() => { td1sReconnect = null; td1sConnect(); }, 1500);
  }

  // IPC: renderer tells us a TD1S-dependent panel opened / closed
  ipcMain.on('td1s:need', () => {
    td1sNeedCount++;
    if (!td1sConnected) td1sStartPolling();
  });
  ipcMain.on('td1s:release', () => {
    td1sNeedCount = Math.max(0, td1sNeedCount - 1);
    if (td1sNeedCount === 0 && !td1sConnected) {
      td1sStopWatcher();
      td1sLog('info', 'No UI needs TD1S — polling stopped.');
      td1sStatus('Status: Sensor not detected');
    }
  });

  async function td1sConnect() {
    if (td1sConnected || app.isQuitting) return;
    td1sStopWatcher();
    const portPath = await td1sFind();
    if (!portPath) {
      td1sStatus('Status: Sensor not detected');
      if (td1sNeedCount > 0) { td1sStartPolling(); } else { td1sLog('info', 'TD1S not found.'); }
      return;
    }
    td1sLog('info', `Port found: ${portPath} — opening at ${TD1S_BAUD} baud...`);
    td1sStatus(`Status: Connecting to ${portPath}...`);
    try {
      td1sPort = new SerialPort({ path: portPath, baudRate: TD1S_BAUD, autoOpen: false });
      await new Promise((resolve, reject) => { td1sPort.open(err => err ? reject(err) : resolve()); });
      td1sLog('success', `Port ${portPath} opened`);

      const parser = td1sPort.pipe(new ReadlineParser({ delimiter: '\n' }));
      let state = 'WAITING_READY';

      td1sLog('info', 'Handshake → sending "connect"');
      td1sPort.write('connect\n');

      parser.on('data', line => {
        const raw = line.toString().trim();
        if (state === 'WAITING_READY') {
          td1sLog('debug', `← received: "${raw}"`);
          if (raw === 'ready') {
            td1sLog('success', 'Sensor ready — sending "P" (start stream)');
            td1sPort.write('P\n');
            state = 'WAITING_FIRST';
          } else {
            td1sLog('warn', `Unexpected response (expected "ready"): "${raw}"`);
          }
          return;
        }
        if (state === 'WAITING_FIRST') {
          td1sLog('debug', `← first line discarded: "${raw}"`);
          state = 'READING'; td1sConnected = true;
          td1sLog('success', 'Stream active — reading data');
          td1sStatus('Status: Sensor connected');
          return;
        }
        // READING
        td1sLog('debug', `← raw: "${raw}"`);
        if (raw === 'clearScreen') {
          td1sLog('debug', `  ↳ screen clear — filament removed`);
          td1sLastPair = null;   // reset dedup so same value fires again on re-insert
          mainWindow?.webContents.send('td1s-clear');
          return;
        }
        const result = extractTdHex(raw);
        if (!result) { td1sLog('debug', `  ↳ unparseable, ignored`); return; }
        const pairKey = `${result.td}-${result.hex}`;
        if (pairKey === td1sLastPair) { td1sLog('debug', `  ↳ duplicate (TD=${result.td} HEX=${result.hex}), ignored`); return; }
        td1sLastPair = pairKey;
        td1sLog('data', `  ↳ NEW value  TD=${result.td}  HEX=#${result.hex}`);
        td1sData(result.td, result.hex);
      });

      td1sPort.on('close', () => {
        td1sConnected = false; td1sPort = null;
        if (!app.isQuitting) {
          td1sLog('warn', `Port ${portPath} closed (disconnected?)`);
          td1sStatus('Status: Sensor not detected');
          if (td1sNeedCount > 0) td1sStartPolling();
        }
      });
      td1sPort.on('error', err => {
        td1sLog('error', `Serial error: ${err.message}`);
        td1sConnected = false; td1sClose();
        td1sStatus('Status: Sensor not detected');
        if (td1sNeedCount > 0) td1sStartPolling();
      });
    } catch (err) {
      td1sLog('error', `Cannot open ${portPath}: ${err.message}`);
      td1sClose();
      td1sStatus('Status: Sensor not detected');
      if (td1sNeedCount > 0) td1sStartPolling();
    }
  }

  app.on('before-quit', () => {
    td1sStopWatcher();
    td1sClose();
  });

  // Start immediately — logs before first did-finish-load go into the buffer
  // and are replayed when the renderer is ready
  td1sLog('info', `TD1S bridge ready — Electron ${process.versions.electron}`);
  td1sLog('info', `Target: VID=0x${TD1S_VID.toUpperCase()} PID=0x${TD1S_PID.toUpperCase()} @ ${TD1S_BAUD} baud`);
  td1sConnect();
}

// ── Auto-updater preference ─────────────────────────────────────────────
// Persisted in <userData>/auto-update.json so it survives across launches
// and is read at startup BEFORE the renderer has had a chance to send its
// localStorage value. Renderer can override at runtime via 'update:set-auto'.
const _autoUpdatePrefsPath = () => path.join(app.getPath('userData'), 'auto-update.json');
function readAutoUpdatePref() {
  try {
    const raw = fs.readFileSync(_autoUpdatePrefsPath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj.enabled !== false;     // default ON if file missing or malformed
  } catch (_) {
    return true;
  }
}
function writeAutoUpdatePref(enabled) {
  try {
    fs.writeFileSync(_autoUpdatePrefsPath(),
      JSON.stringify({ enabled: !!enabled }, null, 2));
  } catch (e) {
    console.warn('[updater] failed to write pref:', e.message);
  }
}

// ── Auto-updater
// Lifecycle events are wired ONCE here; the actual check is gated by the
// stored preference and can be re-triggered manually via 'update:check-now'.
let _updaterEventsWired = false;
function wireUpdaterEvents() {
  if (_updaterEventsWired) return;
  _updaterEventsWired = true;
  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-status', { status: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-status', { status: 'available', version: info?.version });
  });
  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update-status', { status: 'ready', version: info?.version });
  });
  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-status', { status: 'error', error: err?.message || String(err) });
  });
}

function initUpdater() {
  wireUpdaterEvents();
  if (!readAutoUpdatePref()) {
    console.log('[updater] auto-update disabled by user preference — skipping startup check');
    return;
  }
  autoUpdater.checkForUpdatesAndNotify();
}

// IPC: renderer asks to install downloaded update
// ─────────────────────────────────────────────────────────────────────────
// UID migration — block accidental app quit during the initial sweep
// ─────────────────────────────────────────────────────────────────────────
//
// Tiger Studio Manager migrates legacy decimal-format inventory ids to hex
// uppercase in the background (see renderer/inventory.js). On the first
// launch after the new mobile-app-version cutover, a user with a large
// pre-existing inventory may have several hundred docs to migrate, taking
// 30–120 seconds. The renderer puts up a lock-screen modal saying "do not
// close the app", but a determined user can still hit Cmd+Q.
//
// The renderer signals via the `migration:set-in-flight` IPC when the
// sweep starts/ends. While in flight, we intercept `before-quit` and
// `mainWindow.close` events and pop a confirm dialog: leaving mid-sweep
// is safe (next launch resumes), but we want the user to KNOW that.
let _migrationInFlight = false;
ipcMain.on('migration:set-in-flight', (_evt, inFlight) => {
  _migrationInFlight = !!inFlight;
});

const { dialog } = require('electron');
let _quitConfirmedDuringMigration = false;
app.on('before-quit', (event) => {
  if (!_migrationInFlight || _quitConfirmedDuringMigration) return;
  // Block this quit attempt and ask the user to confirm
  event.preventDefault();
  if (mainWindow) mainWindow.show();
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type:    'warning',
    title:   'Migration in progress',
    message: 'Inventory upgrade is still running.',
    detail:  'Closing now is safe — the migration will resume the next time you open Tiger Studio Manager — but for the cleanest experience, please let it finish (it usually takes less than a minute).\n\nQuit anyway?',
    buttons: ['Wait for it to finish', 'Quit anyway'],
    defaultId: 0,
    cancelId:  0,
  });
  if (choice === 1) {
    _quitConfirmedDuringMigration = true;
    app.quit();   // re-trigger the quit, this time we let it through
  }
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// IPC: renderer flips the auto-update preference (persisted to disk)
ipcMain.on('update:set-auto', (_evt, enabled) => {
  writeAutoUpdatePref(enabled);
  console.log(`[updater] auto-update preference set to ${!!enabled}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Google sign-in via loopback OAuth (RFC 8252) + PKCE (RFC 7636)
// ─────────────────────────────────────────────────────────────────────────
//
// Why we don't use firebase.auth().signInWithPopup() in Electron
// ─────────────────────────────────────────────────────────────
// signInWithPopup spawns a Chromium BrowserWindow inside Electron. When
// Google's auth flow hits a passkey step (now the default for many users),
// Chromium's WebAuthn implementation tries to talk to the macOS authd
// daemon to invoke Touch ID. In a stock Electron BrowserWindow that path
// is broken — the user sees the "Use your passkey" UI but the button is
// inert, leaving Google sign-in stuck.
//
// The loopback OAuth pattern fixes this by NOT opening a popup. Instead:
//   1. main spawns a tiny http.Server on 127.0.0.1:<random-port>
//   2. main builds a Google OAuth URL with code_challenge=S256(verifier)
//      and redirect_uri = http://127.0.0.1:<port>/callback
//   3. main calls shell.openExternal(url) → Safari (or default browser)
//      opens. Touch ID / passkeys work there NATIVELY because Safari
//      has full WebAuthn integration with the OS keychain.
//   4. After auth, Google redirects to localhost:<port>/callback?code=…
//   5. The loopback server captures the code, POSTs it to Google's token
//      endpoint with the PKCE verifier (no client_secret needed for
//      Desktop OAuth clients), receives id_token + access_token.
//   6. Renderer turns those into a firebase.auth.GoogleAuthProvider
//      credential and signs in via signInWithCredential — same end state
//      as signInWithPopup would have produced.
//
// Configuration — Desktop OAuth Client ID (REQUIRED)
// ──────────────────────────────────────────────────
// You MUST create a "Desktop app" OAuth Client in Google Cloud Console
// for the tigertag-connect project. Steps:
//   1. https://console.cloud.google.com/apis/credentials?project=tigertag-connect
//   2. + CREATE CREDENTIALS → OAuth client ID
//   3. Application type: "Desktop app"
//   4. Name: "Tiger Studio Manager"
//   5. Save and copy the Client ID (no secret needed thanks to PKCE).
//   6. Paste it below as GOOGLE_DESKTOP_CLIENT_ID, or set the
//      TIGERTAG_GOOGLE_DESKTOP_CLIENT_ID env var at launch.
//
// Note on Firebase audience: an id_token minted for the Desktop client
// has aud = Desktop_Client_ID, which Firebase Auth may reject. We pass
// BOTH id_token and access_token to GoogleAuthProvider.credential(...);
// when the id_token audience check fails, Firebase falls back to using
// the access_token against Google's userinfo endpoint, which has no
// audience constraint. This dual-token call is what makes the flow
// portable across project setups.
const GOOGLE_DESKTOP_CLIENT_ID =
  process.env.TIGERTAG_GOOGLE_DESKTOP_CLIENT_ID ||
  // Desktop OAuth client created in Google Cloud Console for the
  // tigertag-connect project on 2026-05-03 ("Tiger Studio Manager"). This
  // value is PUBLIC by design — Desktop OAuth clients use PKCE instead of
  // a client_secret, so even though this string ends up bundled in the
  // signed app binary, an attacker who extracts it cannot impersonate the
  // app: each sign-in flow generates a fresh code_verifier that only this
  // process knows.
  '298062874545-c3d61latpmhp6qn9l1q87hvhmng8aadi.apps.googleusercontent.com';

ipcMain.handle('auth:google-loopback', async () => {
  if (!GOOGLE_DESKTOP_CLIENT_ID) {
    return {
      ok: false,
      error: 'GOOGLE_DESKTOP_CLIENT_ID is not configured. See main.js header.',
    };
  }

  // PKCE: verifier is a high-entropy random string, challenge is its
  // SHA-256 (base64url-encoded). Server requires us to present the
  // verifier at code-exchange time, proving we're the same app that
  // initiated the flow.
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256')
    .update(codeVerifier).digest('base64url');
  // Random state for CSRF protection — Google echoes it back on the
  // redirect, we verify the round-trip before trusting the code.
  const state = crypto.randomBytes(16).toString('base64url');

  // Spawn the loopback HTTP server on an ephemeral port. We bind to
  // 127.0.0.1 explicitly (not 0.0.0.0) so the listener is unreachable
  // from the local network — only the user's own browser can hit it.
  const { server, port } = await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',             GOOGLE_DESKTOP_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',          redirectUri);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('scope',                 'openid email profile');
    authUrl.searchParams.set('code_challenge',        codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state',                 state);
    // `prompt=select_account` mirrors the existing popup behaviour so users
    // with multiple Google accounts see the chooser every time.
    authUrl.searchParams.set('prompt',                'select_account');

    // Wait for the OAuth redirect to land on /callback. 5-minute timeout
    // — beyond that we assume the user abandoned the flow.
    const codePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OAuth timeout: no callback received in 5 minutes'));
      }, 5 * 60 * 1000);

      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404); res.end(); return;
        }
        clearTimeout(timeout);

        const code          = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const oauthError    = reqUrl.searchParams.get('error');

        // Always answer the browser — never leave the tab spinning. We
        // serve a tiny HTML page that auto-closes after 1.5s so the user
        // immediately knows they can return to the desktop app.
        const renderPage = (title, body, color) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Tiger Studio Manager — ${title}</title></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0f1117;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px"><div style="font-size:48px;color:${color}">${title === 'Signed in' ? '✓' : '×'}</div><h1 style="font-weight:600;margin:0;font-size:22px">${title}</h1><p style="margin:0;color:rgba(255,255,255,.6);font-size:14px">${body}</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`);
        };

        if (oauthError) {
          renderPage('Sign-in cancelled', 'You can close this tab and try again.', '#ef4444');
          reject(new Error(`OAuth error: ${oauthError}`));
          return;
        }
        if (returnedState !== state) {
          renderPage('Security check failed', 'State mismatch — please try again.', '#ef4444');
          reject(new Error('OAuth state mismatch — possible CSRF attempt'));
          return;
        }
        if (!code) {
          renderPage('No code received', 'Something went wrong on Google\'s side.', '#ef4444');
          reject(new Error('OAuth: no authorization code returned'));
          return;
        }

        renderPage('Signed in', 'Returning to Tiger Studio Manager…', '#10b981');
        resolve(code);
      });
    });

    // Hand off to the system browser — Touch ID / passkey works there.
    await shell.openExternal(authUrl.toString());

    const code = await codePromise;

    // Bring the Electron app to the foreground the instant the OAuth
    // hand-shake lands. Safari can't close its own tab via window.close()
    // (the tab wasn't opened by a JS window.open(), so the browser
    // sandbox blocks the close), but raising our window means the user
    // is immediately back in the app — the dangling Safari tab becomes
    // a non-issue, they can close it whenever. `app.focus({ steal })`
    // on macOS actually pulls focus from Safari; on Win/Linux it's a
    // no-op or polite focus request.
    try {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      if (process.platform === 'darwin') app.focus({ steal: true });
      else app.focus();
    } catch { /* focus is best-effort, never block the auth flow */ }

    // Exchange the code for tokens. Desktop clients use PKCE instead of
    // a client_secret, so we don't need to ship anything truly secret in
    // the binary — the verifier is regenerated per flow and never leaves
    // this process.
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     GOOGLE_DESKTOP_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
      }).toString(),
    });
    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      throw new Error(`Google token exchange failed (${tokenResp.status}): ${txt}`);
    }
    const tokens = await tokenResp.json();
    return {
      ok: true,
      idToken:     tokens.id_token     || null,
      accessToken: tokens.access_token || null,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    server.close();
  }
});

// IPC: renderer triggers a manual update check (regardless of the
// auto-update preference — explicit user action). Resolves with the
// outcome so the UI can show "Checking…" / "Up to date" / etc.
ipcMain.on('shell:open-external', (_evt, url) => {
  if (url && typeof url === 'string') shell.openExternal(url);
});

ipcMain.handle('update:check-now', async () => {
  wireUpdaterEvents();
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// ── FlashForge HTTP — main-process bridge (CORS bypass) ───────────────────
// Why this can't run in the renderer: Electron renderers ARE Chromium, so
// an HTTP POST from `http://localhost:5784` to `http://192.168.40.107:8898`
// is treated as a cross-origin request. Sending JSON triggers a CORS
// preflight (OPTIONS) that the FlashForge firmware doesn't handle — the
// browser blocks the request before the actual POST is even sent. Node's
// fetch (here in main) is not subject to CORS, so it goes through cleanly.
// Mirrors the Flutter monolith's `http.post()` exactly:
//   url   → http://<ip>:8898/{detail|control}
//   body  → { serialNumber, checkCode, … }   (already JSON-encoded by caller)
//   headers → Content-Type: application/json, Accept: */*
// Returns the parsed JSON body, or { code:-1|-2, message } envelopes that
// match what the Flutter side produces on parse / network errors. The
// renderer treats those exactly like a regular FlashForge error code.
const FFG_TIMEOUT_MS = 4000;
ipcMain.handle('ffg:http-post', async (_evt, url, body, timeoutMs) => {
  if (!url || typeof url !== 'string') {
    return { code: -2, message: 'Network error: missing url' };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { code: -2, message: 'Network error: invalid url scheme' };
  }
  // Tight allowlist on the path so a renderer compromise can't pivot
  // this IPC into a generic outbound HTTP proxy. Both endpoints take
  // the SAME auth body so this list will rarely grow.
  const ok = /\/(detail|control)$/i.test(new URL(url).pathname);
  if (!ok) {
    return { code: -2, message: 'Network error: path not allowed' };
  }
  const timeout = (typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= 10000)
    ? timeoutMs : FFG_TIMEOUT_MS;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
      body: typeof body === 'string' ? body : JSON.stringify(body || {}),
    });
    let parsed;
    try {
      parsed = await res.json();
    } catch (_) {
      parsed = { code: -1, message: 'Invalid JSON', httpStatus: res.status };
    }
    return parsed;
  } catch (e) {
    return { code: -2, message: `Network error: ${e?.message || e}` };
  } finally {
    clearTimeout(tm);
  }
});

// ── FlashForge UDP Multicast discovery (Adventurer 4 era) ────────────────────
// Older FlashForge printers (Adventurer 4 and earlier) don't respond reliably
// to HTTP probes but DO answer a UDP multicast "Hello World!" broadcast on the
// standard FlashForge group 225.0.0.9:19000. The reply body is the printer
// name (null-terminated UTF-8). We collect all replies for 2.5 s then return
// the IP+name list; the renderer probes each IP via ffg:http-post for details.
// Runs in parallel with the HTTP subnet scan — complements it for old models.
ipcMain.handle('ffg:multicast-discover', async () => {
  const dgram = require('dgram');
  const MULTICAST_GROUP = '225.0.0.9';
  const MULTICAST_PORT  = 19000;
  const BIND_PORT       = 8002;
  const LISTEN_MS       = 2500;
  const PAYLOAD         = Buffer.from('Hello World!');

  return new Promise((resolve) => {
    const candidates = new Map(); // dedupe by source IP
    let done = false;

    const finish = () => {
      if (done) return; done = true;
      try { socket.close(); } catch {}
      resolve({ ok: true, candidates: Array.from(candidates.values()) });
    };

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', (err) => {
      console.warn('[ffg-multicast] socket error:', err.message);
      if (!done) { done = true; resolve({ ok: false, error: err.message, candidates: [] }); }
    });

    socket.on('message', (buf, rinfo) => {
      const ip = rinfo.address;
      if (candidates.has(ip)) return;
      const end = buf.indexOf(0); // null-terminator in printer name
      const printerName = buf.slice(0, end >= 0 ? end : buf.length).toString('utf8').trim();
      candidates.set(ip, { ip, printerName: printerName || null });
    });

    socket.bind({ port: BIND_PORT, address: '0.0.0.0' }, () => {
      try {
        socket.addMembership(MULTICAST_GROUP);
        socket.setMulticastTTL(4);
        socket.send(PAYLOAD, MULTICAST_PORT, MULTICAST_GROUP, (err) => {
          if (err) console.warn('[ffg-multicast] send error:', err.message);
        });
      } catch (e) {
        console.warn('[ffg-multicast] setup failed:', e.message);
        finish();
        return;
      }
      setTimeout(finish, LISTEN_MS);
    });
  });
});

// ── FlashForge TCP probe — port 8899, M115 identity command ──────────────────
// The ~M115 command returns machine type, name, firmware, serial, MAC even when
// the printer's HTTP /detail response is incomplete. Used as an identity fallback
// when the HTTP probe returns sparse data (e.g. older firmware with partial JSON).
// Allowlisted to port 8899 only — not a generic TCP proxy.
ipcMain.handle('ffg:tcp-probe', async (_evt, ip) => {
  if (!ip || typeof ip !== 'string') return { ok: false, error: 'missing ip' };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, error: 'invalid ip' };

  const net = require('net');
  const TIMEOUT_MS = 700;

  return new Promise((resolve) => {
    let buffer = '';
    let resolved = false;

    const finish = (result) => {
      if (resolved) return; resolved = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const socket = new net.Socket();
    socket.setTimeout(TIMEOUT_MS);

    socket.on('connect', () => { socket.write('~M115\r\n'); });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('ok')) return; // wait for end marker
      const fields = {};
      for (const line of buffer.split('\r\n')) {
        const m = line.match(/^([^:]+):\s*(.+)$/);
        if (!m) continue;
        const key = m[1].trim();
        const val = m[2].trim();
        if      (key === 'Machine Type') fields.machineModel  = val;
        else if (key === 'Machine Name') fields.machineName   = val;
        else if (key === 'Firmware')     fields.firmware      = val;
        else if (key === 'SN')           fields.serialNumber  = val.replace(/^SN/i, '');
        else if (key === 'Mac Address')  fields.macAddress    = val;
      }
      finish({ ok: true, fields });
    });

    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.on('error',   (e) => finish({ ok: false, error: e.message }));

    socket.connect(8899, ip);
  });
});

// ── Snapmaker HTTP GET — main-process bridge (CORS bypass) ───────────────────
// Mirrors the FlashForge bridge above. The renderer's Chromium engine treats
// requests from http://localhost:<port> to http://192.168.x.x:7125 as cross-
// origin, so direct fetch() from probe.js fails silently (no CORS headers on
// Moonraker). Node's fetch() here in main is not subject to CORS, so it goes
// through cleanly — exactly like the Flutter http.get() calls.
//
// Allowed paths: /printer/info  /server/info  /machine/system_info
// Returns: { ok: true, status, json } | { ok: false, status, error }
const SNAP_HTTP_TIMEOUT_MS = 3500;
ipcMain.handle('snap:http-get', async (_evt, url, timeoutMs) => {
  if (!url || typeof url !== 'string') {
    return { ok: false, status: 0, error: 'missing url' };
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    return { ok: false, status: 0, error: 'invalid url' };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, status: 0, error: 'url scheme not allowed' };
  }
  // Tight allowlist — only the three Moonraker probe paths used by
  // snapProbeIp(). Prevents this IPC from becoming a generic HTTP proxy
  // if the renderer is ever compromised.
  const ALLOWED = ['/printer/info', '/server/info', '/machine/system_info'];
  if (!ALLOWED.includes(parsed.pathname)) {
    return { ok: false, status: 0, error: 'path not allowed' };
  }
  const timeout = (typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= 10000)
    ? timeoutMs : SNAP_HTTP_TIMEOUT_MS;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(tm);
  }
});

// ── Image cache IPC handler ───────────────────────────────────────────────────
ipcMain.handle('img:get', async (_, url) => {
  if (!url || url === '--') return null;
  const hash = crypto.createHash('md5').update(url).digest('hex');
  const ext  = (url.match(/\.(jpe?g|png|webp|gif|avif)/i) || [])[1] || 'jpg';
  const file = path.join(imgCacheDir, `${hash}.${ext}`);
  function toDataUrl(buf, contentType) {
    const mime = contentType && contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(file, buf);
      return toDataUrl(buf, resp.headers.get('content-type'));
    }
    if (fs.existsSync(file)) return toDataUrl(fs.readFileSync(file), null);
    return null;
  } catch {
    if (fs.existsSync(file)) return toDataUrl(fs.readFileSync(file), null);
    return null;
  }
});

// ── Network — list active LAN /24 subnets for printer scanning. ──────────
// Used by the Snapmaker LAN-scan flow (Add Printer → Scan). Returns a
// deduplicated array of "<a>.<b>.<c>" prefixes, derived from every
// non-internal IPv4 interface that's currently up. The renderer then
// iterates 1..254 on each prefix to probe Moonraker `/printer/info` +
// `/server/info`. Falls back to a small set of common defaults so the
// scan still works on machines where `os.networkInterfaces()` returns
// nothing useful (eg. behind weird VPN setups).
ipcMain.handle('net:get-local-subnets', () => {
  const ifaces = require('os').networkInterfaces();
  const prefixes = new Set();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.internal) continue;
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      const parts = String(ni.address).split('.');
      if (parts.length !== 4) continue;
      const a = +parts[0];
      // Skip loopback, link-local, multicast, broadcast.
      if (a === 0 || a === 127 || a === 169 || a >= 224) continue;
      prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
    }
  }
  return Array.from(prefixes);
});

// ── mDNS — browse for `_snapmaker._tcp.local.` (gold-standard discovery).
// Snapmaker firmware advertises this service on every printer (hardcoded in
// u1-moonraker/components/zeroconf.py: ZC_SERVICE_TYPE = "_snapmaker._tcp.local.").
// The TXT record carries everything we need to pre-fill the add form
// without ANY HTTP probe:
//   - ip            (e.g. "192.168.20.118")
//   - machine_type  (e.g. "Snapmaker U1")
//   - device_name   (user nickname, e.g. "U1-showroom")
//   - sn            (serial number)
//   - version       (firmware version)
//   - link_mode     (lan|cloud)
// This is dramatically faster than a port-scan and works across VLANs IF
// the network has an mDNS reflector (Avahi bridge / OPNsense / UniFi
// site-to-site mDNS). Single-VLAN networks (the common case) get
// instant discovery (≤ 2 sec) with zero probes.
ipcMain.handle('mdns:browse-snapmaker', async () => {
  // Lazy require so a failed install doesn't take down the whole app —
  // browse silently returns [] and the renderer falls back to port-scan.
  let Bonjour;
  try { ({ Bonjour } = require('bonjour-service')); }
  catch (e) {
    console.warn('[mdns] bonjour-service not available:', e.message);
    return { ok: false, error: 'bonjour-service not installed', candidates: [] };
  }
  const bj = new Bonjour();
  const seen = new Map(); // dedupe by fqdn (handles re-broadcasts during the browse window)
  // 2.5s is enough for any printer that's announced in the last 60s to
  // reply to our query — bonjour fires the question immediately and
  // collects answers continuously. Snapmakers reply within ~50ms on a
  // healthy LAN.
  const BROWSE_MS = 2500;
  return await new Promise((resolve) => {
    let browser;
    let resolved = false;
    const finish = () => {
      if (resolved) return; resolved = true;
      try { browser?.stop(); } catch {}
      try { bj.destroy(); } catch {}
      resolve({ ok: true, candidates: Array.from(seen.values()) });
    };
    try {
      browser = bj.find({ type: 'snapmaker' }, (svc) => {
        // svc shape (bonjour-service):
        //   { name, host, port, fqdn, addresses: [...], txt: {...} }
        // We keep both `addresses` (the actual A records resolved during
        // the browse — the most reliable IP source) and `txt.ip` (what
        // the firmware itself thinks its IP is — sanity check).
        if (!svc) return;
        const fqdn = svc.fqdn || svc.name;
        if (seen.has(fqdn)) return;
        seen.set(fqdn, {
          name:      svc.name      || null,
          host:      svc.host      || null,
          port:      svc.port      || null,
          fqdn:      svc.fqdn      || null,
          addresses: Array.isArray(svc.addresses) ? svc.addresses : [],
          txt:       svc.txt       || {},
        });
      });
      browser.on?.('error', (err) => {
        console.warn('[mdns] browse error:', err?.message || err);
      });
    } catch (e) {
      console.warn('[mdns] browse setup failed:', e?.message || e);
      finish();
      return;
    }
    setTimeout(finish, BROWSE_MS);
  });
});

// ── App info (used by the diagnostic / error report panel) ─────────────────
ipcMain.handle('app:info', () => ({
  appVersion:     app.getVersion(),
  electron:       process.versions.electron,
  chrome:         process.versions.chrome,
  node:           process.versions.node,
  platform:       process.platform,
  arch:           process.arch,
  osRelease:      require('os').release(),
}));

// Expose the absolute renderer directory path so the renderer can build
// a file:// preload path for <webview> elements (e.g. Creality camera).
ipcMain.handle('app:renderer-path', () => path.join(__dirname, 'renderer'));

// ── DB IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('db:getLookups',              ()           => db.getLookups());
ipcMain.handle('db:getLabel',                (_, cat, id) => db.getLabel(cat, id));
ipcMain.handle('db:getMaterialLabel',        (_, id)      => db.getMaterialLabel(id));
ipcMain.handle('db:getBambuMaterials',       ()           => db.getBambuMaterials());
ipcMain.handle('db:getPublicKeyForId',       (_, id)      => db.getPublicKeyForId(id));
ipcMain.handle('db:getAllLastUpdateTimestamps', ()         => db.getAllLastUpdateTimestamps());
ipcMain.handle('db:isUpdateAvailable',       ()           => db.isUpdateAvailable());
ipcMain.handle('db:updateIfNeeded',          ()           => db.updateIfNeeded());
ipcMain.handle('db:downloadAndSaveLatestData', ()         => db.downloadAndSaveLatestData());

// ── Timelapse download ───────────────────────────────────────────────────────
// Shows a native Save dialog then streams the video from the printer over HTTP.
ipcMain.handle('timelapse:download', async (_evt, videoUrl, suggestedFilename) => {
  const defaultName = suggestedFilename || 'timelapse.mp4';
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Timelapse',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'cancelled' };

  return new Promise((resolve) => {
    const dest = fs.createWriteStream(filePath);
    const cleanup = (err) => {
      dest.destroy();
      try { fs.unlinkSync(filePath); } catch (_) {}
      resolve({ ok: false, reason: err?.message || 'error' });
    };
    // URL is: http://<ip>/download?X-Token=<pwd>&file_name=<encoded_path>
    // Pass the full URL string directly — no path manipulation needed.
    http.get(videoUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return cleanup(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(dest);
      dest.on('finish', () => { dest.close(); resolve({ ok: true, path: filePath }); });
      dest.on('error', cleanup);
    }).on('error', cleanup).on('timeout', function() { this.destroy(); cleanup(new Error('timeout')); });
  });
});

// ── Elegoo MQTT bridge ───────────────────────────────────────────────────────
// Each connected printer gets its own mqtt.Client stored in _elegooClients.
// The renderer sends connect/disconnect/publish; this bridge forwards
// incoming messages back via webContents.send.
{
  const mqtt = require('mqtt');
  const _elegooClients = new Map(); // key → { client, webContents }

  ipcMain.on('elegoo:connect', (event, opts) => {
    const { key, host, port, sn, password, clientId, requestId } = opts || {};
    if (!key || !host || !sn) {
      event.sender.send('elegoo:status', key, 'error:missing-params');
      return;
    }
    // Tear down any existing client for this key
    const existing = _elegooClients.get(key);
    if (existing) { try { existing.client.end(true); } catch (_) {} _elegooClients.delete(key); }

    const client = mqtt.connect({
      host, port: port || 1883,
      protocol: 'mqtt',
      username: 'elegoo',
      password: password || '123456',
      clientId: clientId || `TTG_${Math.floor(1000 + Math.random() * 9000)}`,
      keepalive: 60,
      connectTimeout: 8000,
    });
    _elegooClients.set(key, { client, webContents: event.sender, sn, clientId, requestId });

    client.on('connect', () => {
      const topics = [
        `elegoo/${sn}/api_status`,
        `elegoo/${sn}/${clientId}/api_response`,
        `elegoo/${sn}/${clientId}_req/register_response`,
        `elegoo/${sn}/${requestId}/register_response`,
      ];
      client.subscribe(topics, (err) => {
        if (err) { event.sender.send('elegoo:status', key, 'error:subscribe'); return; }
        event.sender.send('elegoo:status', key, 'connected');
        // Send registration
        client.publish(`elegoo/${sn}/api_register`,
          JSON.stringify({ client_id: clientId, request_id: requestId }));
      });
    });

    client.on('message', (topic, payload) => {
      let data;
      try { data = JSON.parse(payload.toString()); }
      catch (_) { data = { _raw: payload.toString() }; }
      if (!event.sender.isDestroyed()) event.sender.send('elegoo:message', key, topic, data);
    });

    client.on('error', (err) => {
      if (!event.sender.isDestroyed()) event.sender.send('elegoo:status', key, `error:${err?.message || err}`);
    });
    client.on('close',   () => { if (!event.sender.isDestroyed()) event.sender.send('elegoo:status', key, 'disconnected'); });
    client.on('offline', () => { if (!event.sender.isDestroyed()) event.sender.send('elegoo:status', key, 'offline'); });
    client.on('reconnect', () => { if (!event.sender.isDestroyed()) event.sender.send('elegoo:status', key, 'connecting'); });
  });

  ipcMain.on('elegoo:disconnect', (_evt, key) => {
    const entry = _elegooClients.get(key);
    if (entry) { try { entry.client.end(true); } catch (_) {} _elegooClients.delete(key); }
  });

  ipcMain.on('elegoo:publish', (_evt, key, topic, payload) => {
    const entry = _elegooClients.get(key);
    if (!entry) return;
    try { entry.client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload)); }
    catch (_) {}
  });
}

// ── Bambu Lab MQTT (TLS mqtts port 8883) + JPEG-TCP camera (port 6000)
//    + RTSP camera (X1C / X1E / P2S / H2x — port 322) via ffmpeg
{
  const mqtt  = require('mqtt');
  const tls   = require('tls');
  const { spawn } = require('child_process');

  // Locate ffmpeg — tries bundled ffmpeg-static first, then common system paths.
  let _ffmpegBin = null;
  (function _detectFfmpeg() {
    const fs = require('fs');
    const candidates = [];
    try { const s = require('ffmpeg-static'); if (s) candidates.push(s); } catch (_) {}
    candidates.push(
      '/opt/homebrew/bin/ffmpeg',  // macOS Homebrew (Apple Silicon)
      '/usr/local/bin/ffmpeg',     // macOS Homebrew (Intel)
      '/usr/bin/ffmpeg',           // Linux
      'ffmpeg',                    // PATH fallback
    );
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); _ffmpegBin = p; return; } catch (_) {}
    }
  })();

  const _bambuClients    = new Map(); // key → { client, wc }
  const _bambuCamSockets = new Map(); // key → net.Socket

  // ── MQTT ──────────────────────────────────────────────────────────────
  ipcMain.on('bambulab:connect', (event, { key, ip, serial, password }) => {
    if (!key || !ip || !serial || !password) {
      event.sender.send('bambulab:status', key, 'error:missing-params');
      return;
    }
    const existing = _bambuClients.get(key);
    if (existing) { try { existing.client.end(true); } catch (_) {} _bambuClients.delete(key); }

    const client = mqtt.connect({
      host: ip, port: 8883,
      protocol: 'mqtts',
      rejectUnauthorized: false,
      username: 'bblp',
      password,
      clientId: `studio_${Date.now()}`,
      keepalive: 20,
      clean: true,
      connectTimeout: 10000,
    });
    _bambuClients.set(key, { client, wc: event.sender, serial });

    client.on('connect', () => {
      if (event.sender.isDestroyed()) return;
      client.subscribe(`device/${serial}/report`, { qos: 1 });
      event.sender.send('bambulab:status', key, 'connected');
    });
    client.on('message', (topic, payload) => {
      if (event.sender.isDestroyed()) return;
      try { event.sender.send('bambulab:message', key, topic, JSON.parse(payload.toString())); }
      catch (_) {}
    });
    client.on('error',    (err) => { if (!event.sender.isDestroyed()) event.sender.send('bambulab:status', key, `error:${err?.message || err}`); });
    client.on('close',    ()    => { if (!event.sender.isDestroyed()) event.sender.send('bambulab:status', key, 'disconnected'); });
    client.on('offline',  ()    => { if (!event.sender.isDestroyed()) event.sender.send('bambulab:status', key, 'offline'); });
    client.on('reconnect',()    => { if (!event.sender.isDestroyed()) event.sender.send('bambulab:status', key, 'connecting'); });
  });

  ipcMain.on('bambulab:disconnect', (_evt, key) => {
    const e = _bambuClients.get(key);
    if (e) { try { e.client.end(true); } catch (_) {} _bambuClients.delete(key); }
  });

  ipcMain.on('bambulab:publish', (_evt, key, payload) => {
    const e = _bambuClients.get(key);
    if (!e) return;
    try { e.client.publish(`device/${e.serial}/request`, JSON.stringify(payload), { qos: 1 }); }
    catch (_) {}
  });

  // ── JPEG TCP camera (A1 / A1 Mini / P1P / P1S — port 6000) ──────────
  function _bambuCamAuthPacket(password) {
    const buf = Buffer.alloc(80, 0);
    buf.writeUInt32LE(0x40, 0);
    buf.writeUInt32LE(0x3000, 4);
    Buffer.from('bblp', 'utf8').copy(buf, 16);
    Buffer.from(password, 'utf8').slice(0, 32).copy(buf, 48);
    return buf;
  }

  ipcMain.on('bambulab:cam-start', (event, { key, ip, password }) => {
    const prev = _bambuCamSockets.get(key);
    if (prev) { try { prev.destroy(); } catch (_) {} _bambuCamSockets.delete(key); }

    const sock = tls.connect({ host: ip, port: 6000, rejectUnauthorized: false }, () => {
      sock.write(_bambuCamAuthPacket(password));
    });
    _bambuCamSockets.set(key, sock);

    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16) {
        const payloadSize = buf.readUInt32LE(0);
        if (payloadSize <= 0 || payloadSize > 8 * 1024 * 1024) { buf = Buffer.alloc(0); break; }
        if (buf.length < 16 + payloadSize) break;
        const payload = buf.slice(16, 16 + payloadSize);
        buf = buf.slice(16 + payloadSize);
        if (payload[0] === 0xFF && payload[1] === 0xD8 &&
            payload[payload.length - 2] === 0xFF && payload[payload.length - 1] === 0xD9) {
          if (!event.sender.isDestroyed())
            event.sender.send('bambulab:cam-frame', key, payload.toString('base64'));
        }
      }
    });
    sock.on('error', () => { _bambuCamSockets.delete(key); });
    sock.on('close', () => { _bambuCamSockets.delete(key); });
  });

  ipcMain.on('bambulab:cam-stop', (_evt, key) => {
    const s = _bambuCamSockets.get(key);
    if (s) { try { s.destroy(); } catch (_) {} _bambuCamSockets.delete(key); }
  });

  // ── RTSP camera (X1C / X1E / P2S / H2x — port 322 TLS) ─────────────
  // ffmpeg pulls the rtsps:// stream and outputs MJPEG frames to stdout.
  // Frames are parsed (SOI=FF D8 … EOI=FF D9) and sent via the same
  // 'bambulab:cam-frame' IPC channel as the JPEG TCP camera above.
  const _bambuRtspProcs = new Map(); // key → ChildProcess

  ipcMain.on('bambulab:cam-start-rtsp', (event, { key, ip, password }) => {
    // Kill any existing process for this key (mark as intentionally stopped)
    const prev = _bambuRtspProcs.get(key);
    if (prev) { prev._stopped = true; try { prev.kill('SIGTERM'); } catch (_) {} _bambuRtspProcs.delete(key); }

    if (!_ffmpegBin) {
      console.warn('[bambu-rtsp] ffmpeg not found — RTSP camera disabled');
      return;
    }

    let restarts = 0;
    const MAX_RESTARTS = 10;

    const launch = () => {
      if (event.sender.isDestroyed()) return;

      // Never URL-encode the access code — Bambu codes are alphanumeric hex.
      // encodeURIComponent can corrupt them when ffmpeg parses the URL.
      const rtspUrl = `rtsps://bblp:${password}@${ip}:322/streaming/live/1`;

      const proc = spawn(_ffmpegBin, [
        '-loglevel', 'error',          // show errors in main-process console
        '-rtsp_transport', 'tcp',
        '-tls_verify',    '0',         // ignore self-signed printer cert
        '-i', rtspUrl,
        '-vf', 'fps=5',                // ~5 fps is plenty for a status cam
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-qscale:v', '3',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] }); // pipe stderr for logging

      proc._stopped = false;
      _bambuRtspProcs.set(key, proc);

      // Forward ffmpeg errors to the main-process console so we can debug.
      proc.stderr.on('data', chunk => {
        const msg = chunk.toString().trim();
        if (msg) console.error(`[bambu-rtsp:${key}]`, msg);
      });

      // Parse raw stdout for JPEG frames: SOI (FF D8) → EOI (FF D9).
      // ffmpeg -f image2pipe -vcodec mjpeg outputs raw JPEG files concatenated.
      let buf = Buffer.alloc(0);
      proc.stdout.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        let start = -1;
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i] === 0xFF && buf[i + 1] === 0xD8) { start = i; }
          if (start !== -1 && buf[i] === 0xFF && buf[i + 1] === 0xD9) {
            const frame = buf.slice(start, i + 2);
            buf = buf.slice(i + 2);
            if (!event.sender.isDestroyed())
              event.sender.send('bambulab:cam-frame', key, frame.toString('base64'));
            start = -1;
            i = -1; // restart scan from new buf[0]
          }
        }
      });

      proc.on('close', (code) => {
        if (_bambuRtspProcs.get(key) === proc) _bambuRtspProcs.delete(key);
        if (proc._stopped) return; // intentional stop — do not restart
        if (restarts < MAX_RESTARTS) {
          restarts++;
          const delay = Math.min(1500 * restarts, 12000); // 1.5 s → 12 s backoff
          console.log(`[bambu-rtsp:${key}] exited (code=${code}), retry ${restarts}/${MAX_RESTARTS} in ${delay} ms`);
          setTimeout(launch, delay);
        } else {
          console.warn(`[bambu-rtsp:${key}] gave up after ${MAX_RESTARTS} restarts`);
        }
      });

      proc.on('error', (err) => {
        console.error(`[bambu-rtsp:${key}] spawn error:`, err.message);
        if (_bambuRtspProcs.get(key) === proc) _bambuRtspProcs.delete(key);
      });
    };

    launch();
  });

  ipcMain.on('bambulab:cam-stop-rtsp', (_evt, key) => {
    const p = _bambuRtspProcs.get(key);
    if (p) { p._stopped = true; try { p.kill('SIGTERM'); } catch (_) {} _bambuRtspProcs.delete(key); }
  });
}

// ── App lifecycle
app.whenReady().then(async () => {
  imgCacheDir = path.join(app.getPath('userData'), 'img_cache');
  fs.mkdirSync(imgCacheDir, { recursive: true });

  // Force dark window chrome (title bar, traffic lights) on all platforms
  nativeTheme.themeSource = 'dark';

  // macOS native "About Tiger Studio Manager" menu (Apple menu → About)
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName:    'Tiger Studio Manager',
      applicationVersion: app.getVersion(),
      version:            `Electron ${process.versions.electron}`,
      copyright:          '© TigerTag Project',
      website:            'https://github.com/TigerTag-Project/TigerTag_Studio_Manager',
    });
  }

  await db.initTigerTagDB();

  createWindow();
  initNFC();
  initTD1S();

  // Check for updates after window is shown (not on dev)
  if (app.isPackaged) {
    setTimeout(initUpdater, 3000);
  }

  // Sync DB in background — non-blocking, no crash if offline
  db.updateIfNeeded().then(n => {
    if (n > 0) console.log(`[DB] ${n} dataset(s) updated from API`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
