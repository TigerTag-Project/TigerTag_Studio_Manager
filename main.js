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
  let NFC;
  try {
    NFC = require('nfc-pcsc');
  } catch (err) {
    console.warn('[NFC] nfc-pcsc not available:', err.message);
    return;
  }

  const nfc = new NFC();

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
