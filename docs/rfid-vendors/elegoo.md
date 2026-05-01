# Elegoo RFID — technical reference

> Reference: OpenRFID `src/tag/elegoo/` (vendored under `OpenRFID/`)

## Tag type

- **Chip family**: NXP **Mifare Ultralight**
- The processor (`ElegooTagProcessor`) extends `MifareUltralightTagProcessor` and rejects any scan whose `tag_type` is not `TagType.MifareUltralight`.

## Authentication

- **None at the protocol level documented in the processor.** The processor consumes a fully-read dump (`data: bytes`) supplied by the reader layer. There is no per-page key, password, or signature verification step in the Python source.
- Mifare Ultralight (non-C, non-EV1 password mode) is read in the clear; no key derivation is performed for Elegoo tags.

## Block layout

The processor reads a 41-byte slice, hereafter the **filament block**:

```
filament_data = data[0x40:0x69]
```

`data` is the full dump returned by the reader. The slice `0x40..0x68` corresponds to user pages immediately after the manufacturer/OTP/lock area (page 0x10 onward at 4 bytes/page → byte offset 0x40).

All offsets below are **relative to `filament_data`** (i.e. offset 0x00 of the slice = byte 0x40 of the raw dump).

| Offset | Length | Type | Field |
|--------|--------|------|-------|
| 0x00   | 1      | u8   | (unused / unknown leading byte) |
| 0x01   | 4      | bytes | **Magic** — must equal `EE EE EE EE` |
| 0x05   | 3      | bytes | (unused / unknown) |
| 0x08   | 4      | bytes | **Material ID string** (BCD-encoded ASCII, see below) |
| 0x0C   | 1      | u8   | **Material primary ID** (high byte of subtype) |
| 0x0D   | 1      | u8   | **Material modifier ID** (low byte of subtype) |
| 0x0E   | 2      | bytes | (unused / unknown) |
| 0x10   | 1      | u8   | **Color R** |
| 0x11   | 1      | u8   | **Color G** |
| 0x12   | 1      | u8   | **Color B** |
| 0x13   | 1      | u8   | **Color A** (alpha) |
| 0x14   | 2      | u16 BE | **Hotend min temp (°C)** |
| 0x16   | 2      | u16 BE | **Hotend max temp (°C)** |
| 0x18   | 4      | bytes | (unused / unknown) |
| 0x1C   | 2      | u16 BE | **Filament diameter** (× 100, e.g. 175 = 1.75 mm) |
| 0x1E   | 2      | u16 BE | **Net spool weight (grams)** |
| 0x20   | 9      | bytes | (unused / unknown — possibly a manufacturing date, undecoded) |

Total slice = 0x29 (41 bytes), ending at exclusive offset 0x69 of the raw dump.

### Magic-byte gate

```python
if filament_data[0x1:0x5] != b'\xEE\xEE\xEE\xEE':
    return None
```

If the magic does not match, the processor returns `None` (silently skipping the tag — this is the canonical "not-an-Elegoo-tag" signal).

## Field semantics

### Material ID string (offset 0x08, length 4) — BCD-as-ASCII

```python
material_id = filament_data[0x08:0x0C]
material_type = [chr(int(hex(x)[2:], 10)) for x in material_id if x != 0]
```

For each non-zero byte `x` in the 4-byte slice:

1. Format as hex (e.g. `0x50` → `"50"`).
2. Parse those two hex digits as a **decimal** integer (e.g. `"50"` → 50).
3. Take the ASCII character at that codepoint (e.g. 50 → `'P'`).

Equivalent JS:

```js
function decodeBcdAscii(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === 0) continue;
    // hex string of byte, e.g. 0x50 -> "50"
    const hex = b.toString(16).padStart(2, '0');
    // parse those two hex digits as base-10
    const code = parseInt(hex, 10);
    out.push(String.fromCharCode(code));
  }
  return out; // array of single-char strings (kept as a list, not joined)
}
```

The result is stored on `GenericFilament.unique_id` as a contributing factor and is not directly surfaced as the human-readable material name (that comes from the lookup table below). Note the Python keeps it as a `list[str]`, not a joined string.

### Material subtype lookup (offset 0x0C, 2 bytes)

```python
material_subtype = binary.extract_uint16_be(filament_data, 0x0C)
material = Constants.get_elegoo_material(material_subtype >> 8, material_subtype & 0xFF)
```

- High byte (`material_subtype >> 8`) → primary material id → resolves to a base type string (`"PLA"`, `"PETG"`, ...).
- Low byte (`material_subtype & 0xFF`) → modifier id → resolves to a list of modifier strings (`['+']`, `['CF']`, `['Silk']`, ...).
- If either id is not in the table, the processor **logs a warning and returns `None`**.

### `ElegooMaterial` post-processing rule

When constructing the lookup entry, the modifier list is mutated:

- If `'6'` is in the modifier list → it is removed and `"6"` is appended to `material_type` (e.g. `PA` + `['6']` → type `"PA6"`, modifier `[]`).
- If `'12'` is in the modifier list → it is removed and `"12"` is appended to `material_type` (e.g. `PA` + `['12']` → type `"PA12"`, modifier `[]`).

This rule is applied **once at table-build time** (in `ElegooMaterial.__init__`), not at scan time. The result is what the processor reads from the lookup.

### Color (offsets 0x10–0x13)

Bytes are read as `R, G, B, A` in that order. The processor packs them into a single 32-bit ARGB int:

```python
argb = (a << 24) | (r << 16) | (g << 8) | b
```

That single ARGB int is what is exported as `colors=[argb]` (always a one-element list — Elegoo tags are single-color).

### Temperatures (offsets 0x14, 0x16)

- `hotend_min_temp_c` = `u16 BE` at 0x14
- `hotend_max_temp_c` = `u16 BE` at 0x16
- `bed_temp_c`, `drying_temp_c`, `drying_time_hours` are **not stored on the tag** and are returned as `0` (TODO in the Python source: "Possibly create an internal registry of types for this.").

### Diameter (offset 0x1C)

```python
diameter = binary.extract_uint16_be(filament_data, 0x1C) / 100.0
```

Stored as hundredths of a millimetre. A 1.75 mm filament reads as `175` → `1.75`.

### Weight (offset 0x1E)

`u16 BE`, in grams. No decimal scaling. Net (filament-only) weight, not gross.

### Manufacturing date

Not decoded. The Python source comment says: *"Supposedly there's a date in there somewhere too, but that's still a mystery how to decode."* The output sets `manufacturing_date="0001-01-01"` as a placeholder.

## Material lookup tables (verbatim)

Top-level dispatch — `__add_to_materials(primary_id, type_name, modifier_table)`:

| `material_id` (high byte) | `material_type` |
|---------------------------|-----------------|
| 0x00 | PLA  |
| 0x01 | PETG |
| 0x02 | ABS  |
| 0x03 | TPU  |
| 0x04 | PA   |
| 0x05 | CPE  |
| 0x06 | PC   |
| 0x07 | PVA  |
| 0x08 | ASA  |
| 0x09 | BVOH |
| 0x0A | EVA  |
| 0x0B | HIPS |
| 0x0C | PP   |
| 0x0D | PPA  |
| 0x0E | PPS  |

### Modifier tables (low byte → modifier list)

Tables are reproduced exactly as in `constants.py`. Lists shown as JSON arrays.

**PLA** (`0x00`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["+"]` |
| 0x02 | `["Pro"]` |
| 0x03 | `["Silk"]` |
| 0x04 | `["CF"]` |
| 0x05 | `["Carbon"]` |
| 0x06 | `["Matte"]` |
| 0x07 | `["Fluo"]` |
| 0x08 | `["Wood"]` |
| 0x09 | `["Basic"]` |
| 0x0A | `["RAPID", "+"]` |
| 0x0B | `["Marble"]` |
| 0x0C | `["Galaxy"]` |
| 0x0D | `["Red", "Copper"]` |
| 0x0E | `["Sparkle"]` |

**PETG** (`0x01`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["CF"]` |
| 0x02 | `["GF"]` |
| 0x03 | `["Pro"]` |
| 0x04 | `["Translucent"]` |
| 0x05 | `["RAPID"]` |

**ABS** (`0x02`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["GF"]` |

**TPU** (`0x03`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["95A"]` |
| 0x02 | `["RAPID", "95A"]` |

**PA** (`0x04`) — note: `'6'` and `'12'` are absorbed into the type name:
| modifier_id | raw modifiers | effective `type` | effective `modifiers` |
|-------------|---------------|------------------|-----------------------|
| 0x00 | `[]` | `PA`   | `[]` |
| 0x01 | `["CF"]` | `PA` | `["CF"]` |
| 0x03 | `["HT", "CF"]` | `PA` | `["HT", "CF"]` |
| 0x04 | `["6"]` | `PA6`  | `[]` |
| 0x05 | `["6", "CF"]` | `PA6` | `["CF"]` |
| 0x06 | `["12"]` | `PA12` | `[]` |
| 0x07 | `["12", "CF"]` | `PA12` | `["CF"]` |

(Note: `0x02` is intentionally absent in the source.)

**CPE** (`0x05`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**PC** (`0x06`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["TG"]` |
| 0x02 | `["FR"]` |

**PVA** (`0x07`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**ASA** (`0x08`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**BVOH** (`0x09`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**EVA** (`0x0A`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**HIPS** (`0x0B`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |

**PP** (`0x0C`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["CF"]` |
| 0x02 | `["GF"]` |

**PPA** (`0x0D`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x01 | `["CF"]` |
| 0x02 | `["GF"]` |

**PPS** (`0x0E`):
| modifier_id | modifiers |
|-------------|-----------|
| 0x00 | `[]` |
| 0x02 | `["CF"]` |

(Note: `PPS` skips `0x01` in the source.)

### Lookup contract

```
get_elegoo_material(material_id, modifier_id) -> ElegooMaterial | None
```

Returns `None` if either `material_id` is unknown or `modifier_id` is not present in that material's table. The processor treats `None` as a hard reject (logs a warning and returns `None` itself).

## Crypto / signing

**None.** No HMAC, no signature, no per-tag key, no challenge/response. The only integrity check is the `EE EE EE EE` magic at offset 0x01 of the filament block. Anything past that is plaintext binary fields with the layout above.

## Read-only port — JavaScript notes

Recommended sketch for a JS port of the read path:

```js
// data: Uint8Array (full Mifare Ultralight dump)
function decodeElegoo(data) {
  if (data.length < 0x69) return null;
  const f = data.subarray(0x40, 0x69);

  // magic gate
  if (!(f[1] === 0xEE && f[2] === 0xEE && f[3] === 0xEE && f[4] === 0xEE)) {
    return null;
  }

  // BCD-as-ASCII material id string
  const materialIdBytes = f.subarray(0x08, 0x0C);
  const materialType = [];
  for (const b of materialIdBytes) {
    if (b === 0) continue;
    const code = parseInt(b.toString(16).padStart(2, '0'), 10);
    materialType.push(String.fromCharCode(code));
  }

  // u16 BE helper
  const u16be = (off) => (f[off] << 8) | f[off + 1];

  const subtype = u16be(0x0C);
  const primaryId  = (subtype >> 8) & 0xFF;
  const modifierId =  subtype       & 0xFF;
  const material = lookupElegooMaterial(primaryId, modifierId);
  if (!material) return null;  // unknown material = reject

  const r = f[0x10], g = f[0x11], b = f[0x12], a = f[0x13];
  // ARGB packed int (signed in JS if you use |, use >>> 0 for unsigned)
  const argb = (((a << 24) | (r << 16) | (g << 8) | b) >>> 0);

  const minTemp = u16be(0x14);
  const maxTemp = u16be(0x16);

  const diameterMm = u16be(0x1C) / 100;   // hundredths of mm
  const weightG    = u16be(0x1E);         // grams, net

  return {
    manufacturer: 'Elegoo',
    type: material.type,                   // already includes "6"/"12" suffix where applicable
    modifiers: material.modifiers,         // list, "6"/"12" already removed
    colors: [argb],
    diameterMm,
    weightGrams: weightG,
    hotendMinTempC: minTemp,
    hotendMaxTempC: maxTemp,
    bedTempC: 0,                           // not on tag
    dryingTempC: 0,                        // not on tag
    dryingTimeHours: 0,                    // not on tag
    manufacturingDate: '0001-01-01',       // not decoded
    // raw extras for debugging / unique_id
    materialIdAscii: materialType,         // array of chars, kept unjoined to match Python
    materialSubtype: subtype,
  };
}
```

### Lookup table generation

When porting `constants.py`, build the table once and apply the `'6'`/`'12'` rule **at table-build time** (not at lookup time), exactly as Python does in `ElegooMaterial.__init__`. Concretely:

```js
function makeMaterial(typeName, modifiers) {
  const mods = [...modifiers];
  let type = typeName;
  // order matters: '6' first, then '12' — matches Python source
  if (mods.includes('6'))  { type += '6';  mods.splice(mods.indexOf('6'), 1); }
  if (mods.includes('12')) { type += '12'; mods.splice(mods.indexOf('12'), 1); }
  return { type, modifiers: mods };
}
```

### Gotchas

- **Endianness**: every multi-byte numeric field is **big-endian** (`u16 BE`). Do not use little-endian helpers.
- **Diameter scale**: divide by 100, not 1000.
- **Color order on tag is RGBA**, but the packed integer is **ARGB**. Don't swap.
- **Magic gate is the only "is-this-an-Elegoo-tag?" check.** Treat its absence as a clean `None` (skip), not as an error.
- **Unknown subtype = reject.** Even a known primary material with an unknown modifier id returns `None` from `get_elegoo_material`, and the processor returns `None` for the whole scan with a warning. Mirror this behaviour in the JS port.
- **Material-id string at 0x08 is BCD-as-ASCII**, not plain ASCII. `0x50` decodes to `'P'` (because `int("50", 10) === 50 === 'P'.charCodeAt(0)`), not to `'P'` directly via byte → char.
- **Bed temp / drying / manufacturing date are not on the tag.** Hard-code the placeholders unless and until a registry is added.
- **No write path is described here.** This document covers the read/decoding path only, matching the Python processor.

## Source files (for sync)

- `OpenRFID/src/tag/elegoo/processor.py`
- `OpenRFID/src/tag/elegoo/constants.py`
