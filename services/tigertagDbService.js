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

const API_BASE    = 'https://api.tigertag.io/api:tigertag';
const GITHUB_BASE = 'https://raw.githubusercontent.com/TigerTag-Project/TigerTag-RFID-Guide/main/database';

const DATASETS = {
  versions:           { file: 'id_version.json',      endpoint: '/version/get/all',           storeAll: true  },
  filament_materials: { file: 'id_material.json',     endpoint: '/material/filament/get/all', storeAll: true  },
  aspects:            { file: 'id_aspect.json',       endpoint: '/aspect/get/all',            storeAll: false },
  types:              { file: 'id_type.json',         endpoint: '/type/get/all',              storeAll: false },
  filament_diameters: { file: 'id_diameter.json',     endpoint: '/diameter/filament/get/all', storeAll: false },
  brands:             { file: 'id_brand.json',        endpoint: '/brand/get/all',             storeAll: false },
  measure_units:      { file: 'id_measure_unit.json', endpoint: '/measure_unit/get/all',      storeAll: false },
};

// ── Path helpers ──────────────────────────────────────────────────────────────

const dbDir      = () => path.join(app.getPath('userData'), 'db', 'tigertag');
const userFile   = (f) => path.join(dbDir(), f);
const embeddedFile = (f) => path.join(app.getAppPath(), 'assets', 'db', 'tigertag', f);
const metaFile   = () => path.join(app.getPath('userData'), 'db', 'tigertag', 'db_metadata.json');

// ── In-memory state ───────────────────────────────────────────────────────────

const _cache    = {};   // key → { id: entry }
let   _metadata = {};   // { lastUpdate_<key>: timestamp }

// ── Internal helpers ──────────────────────────────────────────────────────────

function ensureDbDir() {
  const dir = dbDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMetadata() {
  // 1. Try userData/db/db_metadata.json (runtime, written after each sync)
  try {
    const f = metaFile();
    if (fs.existsSync(f)) {
      _metadata = JSON.parse(fs.readFileSync(f, 'utf8'));
      return;
    }
  } catch (e) {
    console.warn('[DB] Failed to load metadata:', e.message);
  }

  // 2. First launch — seed from embedded assets/db/last_update.json so the
  //    service knows the bundled id_*.json files are already at a known
  //    timestamp and won't re-download them unnecessarily.
  try {
    const embedded = embeddedFile('last_update.json');
    if (fs.existsSync(embedded)) {
      const raw = JSON.parse(fs.readFileSync(embedded, 'utf8'));
      // last_update.json uses { versions: ts, brands: ts, … }
      // _metadata expects { lastUpdate_versions: ts, lastUpdate_brands: ts, … }
      _metadata = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [`lastUpdate_${k}`, v])
      );
      console.log('[DB] Seeded metadata from embedded last_update.json');
    }
  } catch (e) {
    console.warn('[DB] Failed to load embedded last_update.json:', e.message);
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
 * Tries the TigerTag API first; falls back to the GitHub mirror (≤6 h stale).
 * Returns { versions: ts, brands: ts, ... } or throws if both fail.
 */
async function fetchRemoteUpdateTimestamps() {
  try {
    const res = await fetch(`${API_BASE}/all/last_update`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (apiErr) {
    console.warn('[DB] API unreachable, falling back to GitHub mirror:', apiErr.message);
    const res = await fetch(`${GITHUB_BASE}/last_update.json`);
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    return res.json();
  }
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

  let data;
  try {
    // 1. Try the TigerTag API
    const res = await fetch(`${API_BASE}${def.endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    console.log(`[DB] Downloaded ${def.file} from API`);
  } catch (apiErr) {
    // 2. Fall back to GitHub mirror (at most ~6 h stale)
    console.warn(`[DB] API failed for ${key}, trying GitHub mirror:`, apiErr.message);
    const res = await fetch(`${GITHUB_BASE}/${def.file}`);
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    data = await res.json();
    console.log(`[DB] Downloaded ${def.file} from GitHub mirror`);
  }

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

/**
 * getLookups — returns all reference arrays needed by the renderer's state.db.
 * Reads raw JSON (userData/db/ → assets/db/ fallback) so full objects are returned.
 * Keys match the renderer convention (brand, material, aspect, type, diameter, unit, version).
 */
function getLookups() {
  return {
    brand:    loadLocalJson('id_brand.json')        || [],
    material: loadLocalJson('id_material.json')     || [],
    aspect:   loadLocalJson('id_aspect.json')       || [],
    type:     loadLocalJson('id_type.json')         || [],
    diameter: loadLocalJson('id_diameter.json')     || [],
    unit:     loadLocalJson('id_measure_unit.json') || [],
    version:  loadLocalJson('id_version.json')      || [],
  };
}

/** Returns all filament materials that have a Bambu Lab bambuID, sorted alphabetically by label. */
function getBambuMaterials() {
  const all = Object.values(_cache.filament_materials || {});
  return all
    .filter(m => m?.metadata?.bambuID)
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
    .map(m => ({
      id: m.id,
      label: m.label || '',
      tray_type: m.material_type || m.label || '',
      bambuID: m.metadata.bambuID,
      tempMin: m.recommended?.nozzleTempMin ?? 190,
      tempMax: m.recommended?.nozzleTempMax ?? 240,
    }));
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
  getBambuMaterials,
  getLookups,
};
