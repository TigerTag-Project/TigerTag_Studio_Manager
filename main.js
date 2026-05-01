const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');
const db = require('./services/tigertagDbService');

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

// ── Convert hex UID (e.g. "1D895E7C004A80") to decimal string used by TigerTag
function hexToDecimalUid(hex) {
  try {
    return BigInt('0x' + hex.replace(/[:\s]/g, '')).toString();
  } catch {
    return hex;
  }
}

// ── Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'TigerTag Studio Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
  let NFC, nfc;
  try {
    NFC = require('nfc-pcsc');
    nfc = new NFC();
  } catch (err) {
    console.warn('[NFC] not available:', err.message);
    return;
  }

  nfc.on('reader', (reader) => {
    console.log(`[NFC] Reader connected: ${reader.name}`);
    mainWindow?.webContents.send('reader-status', {
      connected: true,
      name: reader.name,
    });

    reader.on('card', (card) => {
      const rawUid = card.uid;                    // hex string e.g. "1d895e7c004a80"
      const uid    = hexToDecimalUid(rawUid);     // decimal e.g. "8307741719072896"
      console.log(`[NFC] Card detected — raw: ${rawUid}  →  uid: ${uid}`);
      mainWindow?.webContents.send('rfid-uid', uid, rawUid);
    });

    reader.on('card.off', () => {
      console.log('[NFC] Card removed');
    });

    reader.on('error', (err) => {
      console.error('[NFC] Reader error:', err.message);
    });

    reader.on('end', () => {
      console.log(`[NFC] Reader disconnected: ${reader.name}`);
      mainWindow?.webContents.send('reader-status', {
        connected: false,
        name: reader.name,
      });
    });
  });

  nfc.on('error', (err) => {
    console.error('[NFC] NFC error:', err.message);
    mainWindow?.webContents.send('reader-status', {
      connected: false,
      name: null,
      error: err.message,
    });
  });
}


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

// ── Auto-updater
function initUpdater() {
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    mainWindow?.webContents.send('update-status', { status: 'available' });
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update-status', { status: 'ready' });
  });
}

// IPC: renderer asks to install downloaded update
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
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

// ── DB IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('db:getLabel',                (_, cat, id) => db.getLabel(cat, id));
ipcMain.handle('db:getMaterialLabel',        (_, id)      => db.getMaterialLabel(id));
ipcMain.handle('db:getPublicKeyForId',       (_, id)      => db.getPublicKeyForId(id));
ipcMain.handle('db:getAllLastUpdateTimestamps', ()         => db.getAllLastUpdateTimestamps());
ipcMain.handle('db:isUpdateAvailable',       ()           => db.isUpdateAvailable());
ipcMain.handle('db:updateIfNeeded',          ()           => db.updateIfNeeded());
ipcMain.handle('db:downloadAndSaveLatestData', ()         => db.downloadAndSaveLatestData());

// ── App lifecycle
app.whenReady().then(async () => {
  imgCacheDir = path.join(app.getPath('userData'), 'img_cache');
  fs.mkdirSync(imgCacheDir, { recursive: true });

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
