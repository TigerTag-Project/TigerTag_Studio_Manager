/**
 * tigertagDbService.js
 *
 * Local JSON database with remote sync for TigerTag Studio Manager.
 *
 * Priority chain for each dataset:
 *   1. userData/db/<file>      ← downloaded & kept up to date
 *   2. assets/db/<file>        ← embedded in the app (offline fallback)
 *
 * Timestamps are stored in userData/db/db_metadata.json.
 * The exact remote timestamp is saved after each successful download —
 * never Date.now().
 */

'use strict';

const { app }  = require('electron');
const fs       = require('fs');
const path     = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.tigertag.io/api:tigertag';

const DATASETS = {
  versions:           { file: 'tigertag_ids.json', endpoint: '/version/get/all',           storeAll: true  },
  filament_materials: { file: 'materials.json',    endpoint: '/material/filament/get/all', storeAll: true  },
  aspects:            { file: 'aspects.json',       endpoint: '/aspect/get/all',            storeAll: false },
  types:              { file: 'types.json',          endpoint: '/type/get/all',              storeAll: false },
  filament_diameters: { file: 'diameters.json',      endpoint: '/diameter/filament/get/all', storeAll: false },
  brands:             { file: 'brands.json',          endpoint: '/brand/get/all',             storeAll: false },
  measure_units:      { file: 'units.json',           endpoint: '/measure_unit/get/all',      storeAll: false },
};

// ── Path helpers ──────────────────────────────────────────────────────────────

const dbDir      = () => path.join(app.getPath('userData'), 'db');
const userFile   = (f) => path.join(dbDir(), f);
const embeddedFile = (f) => path.join(app.getAppPath(), 'assets', 'db', f);
const metaFile   = () => path.join(dbDir(), 'db_metadata.json');

// ── In-memory state ───────────────────────────────────────────────────────────

const _cache    = {};   // key → { id: entry }
let   _metadata = {};   // { lastUpdate_<key>: timestamp }

// ── Internal helpers ──────────────────────────────────────────────────────────

function ensureDbDir() {
  const dir = dbDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMetadata() {
  try {
    const f = metaFile();
    if (fs.existsSync(f)) _metadata = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('[DB] Failed to load metadata:', e.message);
    _metadata = {};
  }
}

function saveMetadata() {
  try {
    atomicWriteFile(metaFile(), JSON.stringify(_metadata, null, 2));
  } catch (e) {
    console.error('[DB] Failed to save metadata:', e.message);
  }
}

function atomicWriteFile(targetPath, content) {
  const tmp = targetPath + '.tmp';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * loadLocalJson — reads from userData/db/ first, falls back to assets/db/.
 * Returns parsed array or null if nothing found.
 */
function loadLocalJson(filename) {
  for (const src of [userFile(filename), embeddedFile(filename)]) {
    if (!fs.existsSync(src)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
      console.log(`[DB] Loaded ${filename} from ${src}`);
      return parsed;
    } catch (e) {
      console.warn(`[DB] Could not parse ${src}:`, e.message);
    }
  }
  console.warn(`[DB] No file found for ${filename}`);
  return null;
}

/**
 * validateJsonStructure — ensures the data is a non-empty array of objects
 * each having an `id` field and at least one of `label` / `name`.
 * Returns true if valid.
 */
function validateJsonStructure(filename, contents) {
  if (!Array.isArray(contents)) {
    console.error(`[DB] ${filename}: root is not an array`);
    return false;
  }
  if (contents.length === 0) {
    console.error(`[DB] ${filename}: array is empty`);
    return false;
  }
  for (let i = 0; i < contents.length; i++) {
    const item = contents[i];
    if (!item || typeof item !== 'object') {
      console.error(`[DB] ${filename}[${i}]: not an object`);
      return false;
    }
    if (item.id == null) {
      console.error(`[DB] ${filename}[${i}]: missing 'id'`);
      return false;
    }
    // label/name check — warn only (some datasets like versions may lack it)
    if (!item.label && !item.name) {
      console.warn(`[DB] ${filename}[${i}]: missing 'label' and 'name' (id=${item.id})`);
    }
  }
  return true;
}

/**
 * atomicWriteJson — validate, then write atomically to userData/db/<filename>.
 * Never overwrites an existing file if validation fails.
 */
function atomicWriteJson(filename, contents) {
  if (!validateJsonStructure(filename, contents)) {
    throw new Error(`Validation failed — ${filename} not written`);
  }
  ensureDbDir();
  const target = userFile(filename);
  atomicWriteFile(target, JSON.stringify(contents, null, 2));
  console.log(`[DB] Saved ${filename} (${contents.length} entries)`);
}

/**
 * fetchRemoteUpdateTimestamps — GET all/last_update.
 * Returns { versions: ts, brands: ts, ... } or throws.
 */
async function fetchRemoteUpdateTimestamps() {
  const res = await fetch(`${API_BASE}/all/last_update`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Returns the locally stored timestamp for a dataset key (0 if unknown). */
function getLastUpdateTimestamp(key) {
  return _metadata[`lastUpdate_${key}`] ?? 0;
}

/** Returns all locally stored timestamps as { key: timestamp }. */
function getAllLastUpdateTimestamps() {
  return Object.fromEntries(
    Object.keys(DATASETS).map(k => [k, getLastUpdateTimestamp(k)])
  );
}

/**
 * isUpdateAvailable — compares remote vs local timestamps.
 * Returns false (not true) if the network is unreachable.
 */
async function isUpdateAvailable() {
  try {
    const remote = await fetchRemoteUpdateTimestamps();
    for (const key of Object.keys(remote)) {
      if ((remote[key] ?? 0) > getLastUpdateTimestamp(key)) return true;
    }
    return false;
  } catch (e) {
    console.warn('[DB] Could not check for updates (offline?):', e.message);
    return false;
  }
}

/**
 * updateIfNeeded — downloads only the datasets whose remote timestamp is newer.
 * Saves the exact remote timestamp after each successful download.
 * Returns the number of datasets updated.
 */
async function updateIfNeeded() {
  let remote;
  try {
    remote = await fetchRemoteUpdateTimestamps();
  } catch (e) {
    console.warn('[DB] updateIfNeeded: cannot reach API:', e.message);
    return 0;
  }

  let updated = 0;
  for (const key of Object.keys(remote)) {
    const remoteTs = remote[key] ?? 0;
    if (remoteTs <= getLastUpdateTimestamp(key)) continue;

    try {
      await _downloadDataset(key);
      _metadata[`lastUpdate_${key}`] = remoteTs; // exact remote timestamp
      console.log(`[DB] Updated ${key} — ts=${remoteTs}`);
      updated++;
    } catch (e) {
      console.error(`[DB] Failed to update ${key}:`, e.message);
    }
  }

  if (updated > 0) {
    saveMetadata();
    await _buildCache();
  }
  return updated;
}

/**
 * downloadAndSaveLatestData — force-downloads all datasets regardless of timestamps.
 */
async function downloadAndSaveLatestData() {
  let remote = {};
  try { remote = await fetchRemoteUpdateTimestamps(); } catch {}

  let updated = 0;
  for (const key of Object.keys(DATASETS)) {
    try {
      await _downloadDataset(key);
      if (remote[key]) _metadata[`lastUpdate_${key}`] = remote[key];
      updated++;
    } catch (e) {
      console.error(`[DB] Force-download failed for ${key}:`, e.message);
    }
  }
  if (updated > 0) {
    saveMetadata();
    await _buildCache();
  }
  return updated;
}

/** Returns the label string for a dataset entry by id. */
function getLabel(category, id) {
  const entry = _cache[category]?.[String(id)];
  if (entry == null) return null;
  if (typeof entry === 'object') return entry.label ?? entry.name ?? null;
  return entry;
}

/** Returns the label for a filament material id. */
function getMaterialLabel(id) {
  return getLabel('filament_materials', id);
}

/**
 * getPublicKeyForId — looks up a TigerTag hardware ID in tigertag_ids.json
 * and returns its public_key field.
 */
function getPublicKeyForId(idTigerTag) {
  const entry = _cache.versions?.[String(idTigerTag)];
  if (!entry || typeof entry !== 'object') return null;
  return entry.public_key ?? entry.key ?? null;
}

/**
 * initTigerTagDB — call once on app ready.
 * Loads all available files (userData or embedded) into the in-memory cache.
 */
async function initTigerTagDB() {
  ensureDbDir();
  loadMetadata();
  await _buildCache();
  console.log('[DB] Initialized');
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _downloadDataset(key) {
  const def = DATASETS[key];
  if (!def) throw new Error(`Unknown dataset key: ${key}`);
  const res = await fetch(`${API_BASE}${def.endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  atomicWriteJson(def.file, data); // validates before writing
}

async function _buildCache() {
  for (const [key, def] of Object.entries(DATASETS)) {
    const data = loadLocalJson(def.file);
    if (!data) { _cache[key] = {}; continue; }
    if (def.storeAll) {
      _cache[key] = Object.fromEntries(data.map(item => [String(item.id), item]));
    } else {
      _cache[key] = Object.fromEntries(
        data.map(item => [String(item.id), item.label ?? item.name ?? String(item.id)])
      );
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initTigerTagDB,
  loadLocalJson,
  validateJsonStructure,
  atomicWriteJson,
  fetchRemoteUpdateTimestamps,
  isUpdateAvailable,
  updateIfNeeded,
  downloadAndSaveLatestData,
  getLastUpdateTimestamp,
  getAllLastUpdateTimestamps,
  getLabel,
  getMaterialLabel,
  getPublicKeyForId,
};
