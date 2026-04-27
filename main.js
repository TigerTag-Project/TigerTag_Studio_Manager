const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const db = require('./services/tigertagDbService');

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

  mainWindow.loadFile('renderer/inventory.html');

  // Open external links in default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
      return `file://${file}`;
    }
    // lien mort — cache si dispo, sinon null (placeholder couleur)
    return fs.existsSync(file) ? `file://${file}` : null;
  } catch {
    // pas de réseau — cache si dispo, sinon null
    return fs.existsSync(file) ? `file://${file}` : null;
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
