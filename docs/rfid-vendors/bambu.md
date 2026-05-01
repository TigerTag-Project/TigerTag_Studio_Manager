# Bambu Lab RFID — technical reference

> Reference: OpenRFID `src/tag/bambu/` (vendored under `OpenRFID/`)

## Tag type

**Mifare Classic 1K** (`TagType.MifareClassic1k`).

- Total dump size: **1024 bytes** (`TAG_TOTAL_SIZE = 1024`)
- 16 sectors × 4 blocks × 16 bytes = 64 blocks total
- Layout follows the public Bambu Research Group spec: <https://github.com/Bambu-Research-Group/RFID-Tag-Guide/blob/main/BambuLabRfid.md>

The processor class extends `MifareClassicTagProcessor` and rejects any other tag type:

```python
if scan_result.tag_type != TagType.MifareClassic1k:
    raise ValueError("BambuTagProcessor can only authenticate Mifare Classic 1K tags")
```

## Authentication

Each Mifare Classic sector is protected by a 6-byte Key A / Key B pair. Bambu derives **Key A per-sector from the tag UID** using HKDF-SHA256. Key B is unused (set to all zeros).

### Key derivation (HKDF)

```python
hkdf = HKDF(
    algorithm = hashes.SHA256(),
    length    = 6 * 16,        # 96 bytes — 16 sectors × 6 bytes
    salt      = BAMBU_SALT,    # vendor-specific 32-byte salt (loaded from config)
    info      = b"RFID-A\0",   # ASCII "RFID-A" + null terminator (7 bytes)
)
okm = hkdf.derive(uid)         # uid = 4-byte Mifare UID from block 0
```

The 96-byte output (`okm`) is split into 16 consecutive 6-byte slices, one per sector:

```python
keys_a = [list(okm[i*6:(i+1)*6]) for i in range(16)]   # sector 0..15
keys_b = [[0x00] * 6           for _    in range(16)]  # all zero
```

### HKDF parameters (verbatim, for the JS port)

| Parameter | Value |
|---|---|
| Hash | SHA-256 |
| Output length (L) | 96 bytes |
| Salt | 32-byte vendor secret loaded from config under name `BAMBU_SALT_HASH` |
| Info | `0x52 0x46 0x49 0x44 0x2D 0x41 0x00` (`"RFID-A\0"`) |
| IKM | Mifare UID (4 bytes from block 0) |

> The salt is **not** in the source repo. The constants file ships only a hash string used as a config lookup key (`BAMBU_SALT_HASH = "19cc3c63cb8802668800c3b3bf3fee05b3c59bf59fc5fd256b68e868084ec304"`). The actual salt bytes are loaded at runtime via `self.load_hex_key_from_config(BAMBU_SALT_HASH)`. If config returns empty, the processor disables itself. **Do not hard-code key material; load the same way in JS.**

### Per-block authentication flow (read-only)

For each block we want to read:
1. Compute `sector = floor(block / 4)`.
2. `MIFARE_AUTH_KEY_A` against that block using `keys_a[sector]`.
3. `MIFARE_READ` 16 bytes.
4. Concatenate into the 1024-byte `data` buffer at offset `block * 16`.

Sector trailers (blocks 3, 7, 11, …) are not parsed; they only carry keys + access bits.

## Block layout

All offsets below are **absolute byte offsets into the 1024-byte dump**, identical to `block_number * 16 + intra_block_offset`.

| Block | Offset | Size | Field | Type | Notes |
|---|---|---|---|---|---|
| 0 | 0–3 | 4 | UID | bytes | Mifare manufacturer block (read-only). Used as HKDF IKM. |
| 0 | 4–15 | 12 | Manufacturer data | bytes | Ignored by parser |
| 1 | 16–23 | 8 | `material_variant_id` | UTF-8 string | Null-padded |
| 1 | 24–31 | 8 | `material_id` | UTF-8 string | Null-padded |
| 2 | 32–47 | 16 | `filament_type` | UTF-8 string | E.g. `"PLA"`, `"PETG"`, `"ABS"`, `"PA"`. Null-padded. |
| 3 | 48–63 | 16 | Sector 0 trailer | — | Keys + access bits, not parsed |
| 4 | 64–79 | 16 | `detailed_filament_type` | UTF-8 string | E.g. `"PLA Basic"`, `"PETG HF"`. Null-padded. |
| 5 | 80–83 | 4 | Color RGBA | 4× uint8 | Order on tag: R, G, B, A |
| 5 | 84–85 | 2 | `spool_weight` | uint16 LE | grams (net filament weight, capacity) |
| 5 | 86–87 | 2 | (reserved) | — | not parsed |
| 5 | 88–91 | 4 | `filament_diameter` | float32 LE | mm (typically 1.75 or 2.85) |
| 6 | 96–97 | 2 | `drying_temp` | uint16 LE | °C |
| 6 | 98–99 | 2 | `drying_time` | uint16 LE | hours |
| 6 | 100–101 | 2 | `bed_temp_type` | uint16 LE | enum |
| 6 | 102–103 | 2 | `bed_temp` | uint16 LE | °C |
| 6 | 104–105 | 2 | `hotend_max_temp` | uint16 LE | °C |
| 6 | 106–107 | 2 | `hotend_min_temp` | uint16 LE | °C |
| 7 | 112–127 | 16 | Sector 1 trailer | — | not parsed |
| 8 | 128–139 | 12 | `xcam_info` | bytes | Defined in constants, not parsed by current processor |
| 8 | 140–143 | 4 | `nozzle_diameter` | float32 LE (presumed) | Defined in constants, not parsed by current processor |
| 9 | 144–159 | 16 | `tray_uid` | bytes | Logged as colon-separated hex, not used in `GenericFilament` output |
| 10 | 164–165 | 2 | `spool_width` | uint16 LE | Defined in constants, not parsed by current processor (offset is BLOCK_10 + 4) |
| 11 | 176–191 | 16 | Sector 2 trailer | — | not parsed |
| 12 | 192–207 | 16 | `production_datetime` | ASCII string | Format `"YYYY_MM_DD_HH_MM"`. Null-padded. |
| 13 | 208–223 | 16 | `short_production_datetime` | string | Defined in constants, not parsed by current processor |
| 14 | 228–229 | 2 | `filament_length` | uint16 LE | meters (presumed). Offset = BLOCK_14 + 4. Not parsed by current processor. |
| 15 | 240–255 | 16 | Sector 3 trailer | — | not parsed |
| 16 | 256–257 | 2 | `format_identifier` | uint16 LE | `0x0000` empty / `0x0002` color info present |
| 16 | 258–259 | 2 | `color_count` | uint16 LE | 1 = single color, 2 = dual/bicolor |
| 16 | 260–263 | 4 | `second_color` | uint32 LE | **ABGR** byte order — see note below |

Sector trailers for sectors 4+ (blocks 19, 23, …) and any unlisted blocks are not used by the current parser.

## Field semantics

### Strings (block 1, 2, 4, 12)

All strings are **fixed-length, UTF-8, null-padded**. Helper signature in `tag.binary`:

```python
binary.extract_string(data, offset, length)
```

JS equivalent: read `length` bytes, trim trailing `\0` bytes, decode as UTF-8.

```js
function extractString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0x00) end--;
  return new TextDecoder("utf-8").decode(slice.subarray(0, end));
}
```

### Color (block 5, bytes 80–83)

Stored as four consecutive bytes **R, G, B, A**. The processor packs them into a 32-bit ARGB integer:

```
argb = (A << 24) | (R << 16) | (G << 8) | B
```

JS:
```js
const r = data[80], g = data[81], b = data[82], a = data[83];
const argb = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;  // unsigned
const hex  = "#" + ((argb & 0xFFFFFF).toString(16).padStart(6, "0"));
```

### Second color (block 16, bytes 260–263) — note the byte swap

Block 16 stores the secondary color in **ABGR** order (the reverse of block 5). The Python code reads it as a single `uint32_le` and then unpacks/repacks to ARGB:

```python
second_color_abgr = extract_uint32_le(data, 260)
a2 = (second_color_abgr >> 24) & 0xFF
b2 = (second_color_abgr >> 16) & 0xFF
g2 = (second_color_abgr >>  8) & 0xFF
r2 =  second_color_abgr        & 0xFF
argb2 = (a2 << 24) | (r2 << 16) | (g2 << 8) | b2
```

Equivalent direct interpretation: byte at offset 260 = R, 261 = G, 262 = B, 263 = A — i.e. the RGBA byte order is reversed compared to block 5.

The second color is included only if:
```
format_identifier == 0x0002 (FORMAT_COLOR_INFO) AND color_count > 1
```
Otherwise the colors list contains a single entry.

### Numeric primitives

| Helper | Bytes | Notes |
|---|---|---|
| `extract_uint16_le(data, off)` | 2 | Little-endian unsigned 16-bit |
| `extract_uint32_le(data, off)` | 4 | Little-endian unsigned 32-bit |
| `extract_float_le(data, off)` | 4 | IEEE-754 single-precision, little-endian |

Node.js Buffer equivalents:
```js
data.readUInt16LE(off)
data.readUInt32LE(off)
data.readFloatLE(off)
```

### Material codes

The constants file does **not** ship a numeric → name lookup table for materials. The material name is stored directly as a UTF-8 string in block 2 (`filament_type`) and block 4 (`detailed_filament_type`). The numeric `material_id` and `material_variant_id` are also stored as 8-byte ASCII strings (block 1), not as integers.

There is therefore no enum to transcribe — the JS port should treat these fields as strings.

### Filament modifier (derived)

`filament_modifier = detailed_filament_type[len(filament_type):].strip()` when `detailed_filament_type` starts with `filament_type`, otherwise it falls back to the full detailed string. Empty modifiers and modifiers identical to `filament_type` are discarded.

Example: `filament_type = "PLA"`, `detailed_filament_type = "PLA Basic"` → `modifier = "Basic"`.

### Production date

Source format: `"YYYY_MM_DD_HH_MM"` (ASCII, in block 12, 16 bytes, null-padded).

Parse algorithm:
1. Split on `_`.
2. If at least 3 parts: take `[year, month, day]`, zero-pad month/day to width 2.
3. Return ISO 8601 date `"YYYY-MM-DD"`.
4. On any error, return fallback `"1970-01-01"`.

Hour and minute are present in the raw string but not surfaced in the parsed output.

### Format identifier (block 16)

| Value | Constant | Meaning |
|---|---|---|
| `0x0000` | `FORMAT_EMPTY` | No extra color info |
| `0x0002` | `FORMAT_COLOR_INFO` | Block 16 carries `color_count` and `second_color` |

### Output object

Final parsed result is a `GenericFilament` with these fields populated from the tag:

| Output field | Source |
|---|---|
| `unique_id` | hash of `("Bambu Lab", filament_type, detailed_filament_type, argb_color, production_datetime)` |
| `manufacturer` | hard-coded `"Bambu"` |
| `type` | `filament_type` (block 2) |
| `modifiers` | `[filament_modifier]` if non-empty and != type, else `[]` |
| `colors` | `[argb_color, argb_color2?]` (1 or 2 entries) |
| `diameter_mm` | block 5 float |
| `weight_grams` | block 5 uint16 |
| `hotend_min_temp_c` | block 6 uint16 |
| `hotend_max_temp_c` | block 6 uint16 |
| `bed_temp_c` | block 6 uint16 |
| `drying_temp_c` | block 6 uint16 |
| `drying_time_hours` | block 6 uint16 |
| `manufacturing_date` | parsed ISO date string |

Note: `tray_uid`, `xcam_info`, `nozzle_diameter`, `spool_width`, `filament_length`, `bed_temp_type`, `material_id`, and `material_variant_id` are read by the parser but not currently surfaced in the output object. They are available in the dump if needed.

## Crypto / signing

- **Encryption**: none. Sectors are protected only by Mifare Classic Crypto-1 sector keys.
- **Signature / HMAC**: none observed in the read path. The tag is authentic if and only if its sectors decrypt with HKDF-derived keys from its UID — i.e. authenticity is anchored in the secrecy of the salt.
- **Salt**: vendor-specific 32-byte value, loaded from runtime config; **not present in the OpenRFID source tree**. Treat as a secret. The constants file references it only by a SHA-256 hash literal used as a config lookup key:
  - `BAMBU_SALT_HASH = "19cc3c63cb8802668800c3b3bf3fee05b3c59bf59fc5fd256b68e868084ec304"`
- **No write/lock logic** in the processor; it is read-only.

## Read-only port — JavaScript notes

### Required from `nfc-pcsc`

- `reader.on('card', card => …)` — provides `card.uid` (4 bytes for Classic 1K). Use this directly as HKDF IKM.
- `reader.authenticate(blockNumber, keyType, key)` where:
  - `keyType = 0x60` for Key A, `0x61` for Key B
  - `key` = 6-byte `Buffer`
- `reader.read(blockNumber, 16)` — returns 16-byte `Buffer` for one block.

Pseudo-loop:
```js
const dump = Buffer.alloc(1024);
const keysA = deriveBambuKeys(card.uid);   // HKDF as above, 16×6 bytes

for (let block = 0; block < 64; block++) {
  if ((block + 1) % 4 === 0) continue;     // skip sector trailers (3, 7, 11, …, 63)
  const sector = Math.floor(block / 4);
  await reader.authenticate(block, 0x60, Buffer.from(keysA[sector]));
  const chunk = await reader.read(block, 16);
  chunk.copy(dump, block * 16);
}
return parseBambuDump(dump);
```

For just the parsed fields, only sectors 0–4 (blocks 0–19) are required: blocks 0, 1, 2, 4, 5, 6, 9, 12, 16. You can short-circuit after block 16 if speed matters.

### HKDF in Node.js

Use the built-in `crypto.hkdfSync`:
```js
const { hkdfSync } = require("node:crypto");
const okm = Buffer.from(hkdfSync("sha256", uid, salt, Buffer.from("RFID-A\0", "ascii"), 96));
const keysA = [];
for (let i = 0; i < 16; i++) keysA.push(okm.subarray(i * 6, (i + 1) * 6));
```

> `hkdfSync` returns an `ArrayBuffer` — wrap with `Buffer.from(...)` before slicing.

### Pitfalls

- **Endianness**: every multi-byte numeric field is little-endian. Use `readUInt16LE` / `readUInt32LE` / `readFloatLE`. The lone exception is the RGBA bytes in block 5, which are individual bytes (no endianness), and the second color in block 16 which is reversed (ABGR, not RGBA).
- **String termination**: fixed-length, null-padded, **not** null-terminated. A string of exactly `length` bytes has no trailing `\0`. Trim trailing zeros only — do not stop at the first `\0` if you allow embedded nulls (Bambu doesn't, but be safe).
- **Color byte order between blocks**: block 5 = `R G B A`, block 16 second color = `R G B A` when read byte-by-byte but appears as ABGR when read as a single LE uint32. Pick one mental model and be consistent.
- **HKDF info string includes a trailing null**: `b"RFID-A\0"` is 7 bytes, not 6. Forgetting the null breaks every key.
- **Salt is configuration, not source**: do not commit the salt to the JS repo. Load it at runtime the same way OpenRFID does (config / env / Firestore).
- **UID length**: Classic 1K UIDs are 4 bytes. If you ever encounter a 7-byte UID it's a different tag family — refuse it.
- **Sector trailers**: block 3, 7, 11, … contain keys and access bits. Skipping them is correct; reading them after Key A auth typically returns zeroed key bytes anyway.
- **Disabled processor**: if the salt is empty/missing, the Python processor sets `enabled = False` and returns `None`. The JS port should mirror this — fail closed, do not attempt to parse with a zero key.

### What we explicitly do NOT need

- No write, format, or value-block operations.
- No sector-trailer manipulation, no key rotation, no access-bit changes.
- No Key B handling (it's all zeros, never used).
- No CRC/HMAC verification — there is none.
- No production hour/minute parsing — date only is sufficient for `manufacturing_date`.

## Source files (for sync)

- `OpenRFID/src/tag/bambu/processor.py` — main parser (`BambuTagProcessor`)
- `OpenRFID/src/tag/bambu/constants.py` — block addresses, field offsets, format identifiers, salt-hash lookup key
- Helpers used: `tag.binary.extract_string`, `extract_uint16_le`, `extract_uint32_le`, `extract_float_le`
- Base class: `tag.mifare_classic_tag_processor.MifareClassicTagProcessor` (handles dump assembly + auth dispatch)
- Public spec the parser is based on: <https://github.com/Bambu-Research-Group/RFID-Tag-Guide/blob/main/BambuLabRfid.md>
