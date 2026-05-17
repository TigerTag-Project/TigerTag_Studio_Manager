// TigerTag binary protocol parser — Node.js / CommonJS (main process)
// Ported from OpenRFID/src/tag/tigertag/processor.py
// Reads Mifare Ultralight pages 0-44 (180 bytes from reader.read(0, 180, 4))
// User data starts at byte offset 16 (page 4).

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Valid tag-format IDs (byte 0-3 of user data, big-endian uint32)
const VALID_IDS = new Set([0x5BF59264, 0xBC0FCB97]);

// Epoch used by TigerTag timestamps (seconds since 2000-01-01 UTC)
const EPOCH_OFFSET = 946684800;

// Byte offsets inside the user-data slice (starts at page 4 = raw byte 16)
const OFF = {
  TAG_ID:     0,
  PRODUCT_ID: 4,
  MATERIAL_ID:8,
  ASPECT1:    10,
  ASPECT2:    11,
  TYPE_ID:    12,
  DIAMETER:   13,
  BRAND_ID:   14,
  COLOR:      16,   // R G B A
  WEIGHT:     20,   // 3-byte big-endian
  UNIT:       23,
  NOZZLE_MIN: 24,
  NOZZLE_MAX: 26,
  DRY_TEMP:   28,
  DRY_TIME:   29,
  BED_MIN:    30,
  BED_MAX:    31,
  TIMESTAMP:  32,
  TD:         44,   // transmission-distance, uint16 BE, /10 = mm
};

// ── Registry — lazy-loaded JSON lookup tables ─────────────────────────────────
let _registry = null;

function loadRegistry(dbBasePath) {
  if (_registry) return _registry;
  const base = dbBasePath || path.join(__dirname, '..', '..', '..', 'assets', 'db', 'tigertag');
  const loadArr = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(base, file), 'utf8')); } catch { return []; }
  };
  const toMap = (arr, valFn) => {
    const m = {};
    for (const e of arr) {
      const k = parseInt(e.id, 10);
      if (!isNaN(k)) m[k] = valFn(e);
    }
    return m;
  };
  _registry = {
    brands:    toMap(loadArr('id_brand.json'),        e => e.name),
    materials: toMap(loadArr('id_material.json'),     e => e),
    aspects:   toMap(loadArr('id_aspect.json'),       e => e.name || e.label || ''),
    diameters: toMap(loadArr('id_diameter.json'),     e => parseFloat(e.label || 0)),
    units:     toMap(loadArr('id_measure_unit.json'), e => e.name || e.label || e.symbol || ''),
    versions:  toMap(loadArr('id_version.json'),      e => e.name || e.version || ''),
  };
  return _registry;
}

/** Invalidate cached registry (call after a DB update). */
function invalidateRegistry() { _registry = null; }

// ── Weight conversion (mirrors __convert_to_grams in processor.py) ────────────
function _toGrams(value, unitId) {
  if (unitId === 2 || unitId === 35) return value * 1000;
  if (unitId === 10)                 return value / 1000;
  return value;
}

// ── Main parser ───────────────────────────────────────────────────────────────
/**
 * Parse a raw Buffer read from a Mifare Ultralight TigerTag chip.
 * @param {Buffer} buf  Raw bytes from reader.read(0, 180, 4) — 180 bytes total,
 *                      first 16 bytes are pages 0-3 (UID / lock / OTP), user
 *                      data starts at byte 16 (page 4).
 * @param {string} [dbBasePath]  Optional override for the JSON database folder.
 * @returns {object|null}  Parsed fields, or null if tag ID is not a TigerTag.
 */
function parseTigerTag(buf, dbBasePath) {
  if (!buf || buf.length < 16 + 48) return null;
  const ud    = buf.slice(16);
  const tagId = ud.readUInt32BE(OFF.TAG_ID);
  if (!VALID_IDS.has(tagId)) return null;

  const reg = loadRegistry(dbBasePath);

  const productId  = ud.readUInt32BE(OFF.PRODUCT_ID);
  const materialId = ud.readUInt16BE(OFF.MATERIAL_ID);
  const aspect1Id  = ud[OFF.ASPECT1];
  const aspect2Id  = ud[OFF.ASPECT2];
  const diamId     = ud[OFF.DIAMETER];
  const brandId    = ud.readUInt16BE(OFF.BRAND_ID);

  const r = ud[OFF.COLOR],   g = ud[OFF.COLOR+1],
        b = ud[OFF.COLOR+2], a = ud[OFF.COLOR+3];
  const colorHex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

  const wBytes    = (ud[OFF.WEIGHT] << 16) | (ud[OFF.WEIGHT+1] << 8) | ud[OFF.WEIGHT+2];
  const unitId    = ud[OFF.UNIT];
  const nozzleMin = ud.readUInt16BE(OFF.NOZZLE_MIN);
  const nozzleMax = ud.readUInt16BE(OFF.NOZZLE_MAX);
  const dryTemp   = ud[OFF.DRY_TEMP];
  const dryTime   = ud[OFF.DRY_TIME];
  const bedMin    = ud[OFF.BED_MIN];
  const bedMax    = ud[OFF.BED_MAX];
  const tsRaw     = ud.readUInt32BE(OFF.TIMESTAMP);
  const tdMm      = ud.length > OFF.TD + 1 ? ud.readUInt16BE(OFF.TD) / 10.0 : 0;

  const date = tsRaw === 0
    ? '—'
    : new Date((tsRaw + EPOCH_OFFSET) * 1000).toISOString().slice(0, 10);

  const mat      = reg.materials[materialId] || {};
  const matLabel = mat.label || mat.name || `ID:${materialId}`;
  const matType  = mat.material_type || matLabel;
  const resolved = mat.filled_type ? `${matType}-${mat.filled_type}` : matType;
  const brand    = reg.brands[brandId]    || `ID:${brandId}`;
  const diameter = reg.diameters[diamId]  || 1.75;
  const unit     = reg.units[unitId]      || 'g';
  const aspect1  = reg.aspects[aspect1Id] || '';
  const aspect2  = reg.aspects[aspect2Id] || '';
  const version  = reg.versions[tagId]    || `0x${tagId.toString(16).toUpperCase()}`;
  const weightG  = Math.round(_toGrams(wBytes, unitId));

  return {
    tagId:       '0x' + tagId.toString(16).toUpperCase(),
    version,
    productId:   '0x' + productId.toString(16).toUpperCase().padStart(8, '0'),
    brand,
    material:    resolved,
    materialLabel: matLabel,
    colorHex,
    colorAlpha:  a,
    diameter,
    weight:      weightG,
    unit,
    aspect1,
    aspect2,
    nozzleMin,
    nozzleMax,
    dryTemp,
    dryTime,
    bedMin,
    bedMax,
    date,
    tdMm,
  };
}

module.exports = { parseTigerTag, loadRegistry, invalidateRegistry, VALID_IDS, EPOCH_OFFSET, OFF };
