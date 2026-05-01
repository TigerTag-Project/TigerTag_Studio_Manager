# Openspool RFID — technical reference

> Reference: OpenRFID `src/tag/openspool/` (vendored under `OpenRFID/`)

OpenSpool is the open standard for filament identification: a plain-text **JSON document carried in an NDEF MIME record** on a NFC Forum Type 2 tag (Mifare Ultralight family). There is no encryption, no per-block obfuscation, no vendor key — anything that can read the NDEF payload can decode an OpenSpool tag.

## Tag type

- Physical layer: **NFC Forum Type 2 / Mifare Ultralight** (or compatible: NTAG213/215/216, Ultralight C/EV1).
- Logical layer: **NDEF** (NFC Data Exchange Format) stored in the user memory area.
- Inherits from `NdefTagProcessor` → `MifareUltralightTagProcessor`. The processor expects `scan_result.tag_type == TagType.MifareUltralight`; the NDEF parser raises if a different tag type is fed in.
- The OpenSpool processor itself is purely a **payload decoder** — it does not care about page numbers, capabilities containers, or memory layout. All of that is handled by the generic NDEF parser.

## Authentication

**None.** OpenSpool tags are unauthenticated:
- No password, no PWD/PACK pages used by the spec.
- No diversified keys, no UID-derived secrets, no MAC.
- The tag is read with plain `READ` (Mifare Ultralight `0x30`) commands.
- For JS: any Web NFC / PC/SC / libnfc reader that exposes Type 2 reads is sufficient. No Mifare auth handshake.

If a tag happens to be password-locked at the Ultralight level, that is out of scope of OpenSpool — the protocol assumes free read access to user memory.

## Block layout

OpenSpool stores its data inside the standard **NDEF wrapper** in user memory, not at fixed Mifare page offsets. The full layout, parsed by `NdefTagProcessor.__ndef_parse`:

```
+---------------------------------------------------------+
| Capability Container (4 bytes)                          |
|   byte 0 : 0xE1                  magic                  |
|   byte 1 : 0x10 / 0x11 / 0x40    version / mapping      |
|   byte 2 : memory size / 8                              |
|   byte 3 : access conditions                            |
+---------------------------------------------------------+
| TLV stream (chained Type-Length-Value blocks)           |
|   byte 0 : tag                                          |
|              0x00 = NULL TLV (skip)                     |
|              0x01 = Lock Control                        |
|              0x02 = Memory Control                      |
|              0x03 = NDEF Message  <-- the one we want   |
|              0xFD = Proprietary                         |
|              0xFE = Terminator (end of TLV stream)      |
|   byte 1 : length                                       |
|              if 0xFF -> next 2 bytes = 16-bit length    |
|   ...   : value                                         |
+---------------------------------------------------------+
| Inside the 0x03 TLV value: NDEF message                 |
|   one or more concatenated NDEF records, each:          |
|     header byte:                                        |
|       bits 2..0 = TNF (0x02 = MIME media-type)          |
|       bit  3    = IL  (ID length present)               |
|       bit  4    = SR  (Short Record: 1-byte payload len)|
|       bit  5    = CF  (chunked, ignored here)           |
|       bit  6    = ME  (Message End)                     |
|       bit  7    = MB  (Message Begin)                   |
|     type length     (1 byte)                            |
|     payload length  (1 byte if SR else 4 bytes BE)      |
|     id length       (1 byte if IL else absent)          |
|     type            (type_length bytes, ASCII)          |
|     id              (id_length bytes, optional)         |
|     payload         (payload_length bytes)              |
+---------------------------------------------------------+
```

Notable parser quirks (must be reproduced in the JS port):

1. **Loose CC search.** If the buffer's first byte isn't `0xE1`, the parser scans the **first 16 bytes** for a CC magic of `0xE1` followed by `0x10`, `0x11`, or `0x40`, and starts there. This handles dumps that include the UID + lock pages as a prefix.
2. **TLV with `0xFF` length** uses the next two bytes as a big-endian 16-bit length.
3. **Only TNF == `0x02` (MIME)** records are surfaced; everything else (well-known, URI, external, etc.) is parsed but discarded.
4. **MIME type is ASCII**, decoded with `errors='ignore'`.
5. The parser walks **all NDEF records** and returns the list. The OpenSpool processor then iterates and accepts the first record whose `mime_type == "application/json"` and whose JSON body is a valid OpenSpool document.

## Field semantics

Inside the `application/json` payload, the JSON object is the spec. Required and optional fields parsed by `OpenspoolTagProcessor.__openspool_parse_payload`:

| JSON key      | Type    | Required | Default       | Notes |
|---------------|---------|----------|---------------|-------|
| `protocol`    | string  | yes      | —             | Must equal **`"openspool"`** exactly. Any other value rejects the tag. |
| `brand`       | string  | no       | `"Generic"`   | Free-form manufacturer name. |
| `type`        | string  | no       | `"PLA"`       | Filament family. **Uppercased** before use. Drives the bed/dry temp lookup (see Crypto / signing → constants). |
| `subtype`     | string  | no       | `""`          | Variant marker (e.g. `"Silk"`, `"CF"`, `"HF"`). Empty string omitted. Surfaced as the first entry of `modifiers[]`. |
| `color_hex`   | string  | no       | `"FFFFFF"`    | RGB hex, optional `#` prefix, 6 hex digits. Invalid → `0xFFFFFF`. |
| `alpha`       | int     | no       | `255`         | 0..255, clamped. Combined with RGB to form ARGB: `(alpha << 24) | rgb`. |
| `diameter`    | number  | no       | `1.75`        | Filament diameter in mm. Falls back to `1.75` on parse error. |
| `weight`      | int     | no       | `1000`        | Net spool weight in grams. Falls back to `1000` on parse error. |
| `min_temp`    | int     | no       | `0`           | Hotend minimum °C. |
| `max_temp`    | int     | no       | `0`           | Hotend maximum °C. **Validation:** if `max_temp < min_temp` the tag is rejected. |

Fields **not present on the tag** but populated downstream from the static lookup `FILAMENT_TYPE_TO_EXTENDED_DATA[type.upper()]`:

| Output field         | Source                                          |
|----------------------|-------------------------------------------------|
| `bed_temp_c`         | constants table, default `0.0` if type unknown  |
| `drying_temp_c`      | constants table, default `0.0`                  |
| `drying_time_hours`  | constants table, default `0.0`                  |
| `manufacturing_date` | hardcoded `"0001-01-01"` (no field on tag)      |
| `unique_id`          | `GenericFilament.generate_unique_id("OpenSpool", brand, type, subtype, color_argb)` |

Lookup table (full content of `constants.py`):

| `type` (uppercased) | bed °C | dry °C | dry hours |
|---------------------|--------|--------|-----------|
| `PLA`               | 60     | 50     | 8         |
| `PETG`              | 70     | 65     | 8         |
| `ABS`               | 100    | 80     | 8         |
| `TPU`               | 50     | 70     | 8         |
| `NYLON`             | 100    | 80     | 8         |

Anything else (`PC`, `ASA`, `PA-CF`, …) gets all three values set to `0.0`. The JS port must reproduce this table verbatim — it is part of the OpenSpool reading semantics, not local UI defaults.

### Color encoding

```
rgb   = parseInt(color_hex.replace(/^#/, ''), 16)        // 24-bit
alpha = clamp(parseInt(alpha, 10) || 255, 0, 255)        // 8-bit
argb  = ((alpha & 0xff) << 24) | (rgb & 0xffffff)        // 32-bit ARGB, alpha in MSB
```

`colors[]` in the output is a **single-element array** containing this ARGB integer. Multi-color spools are not modelled by the spec.

### Example payload

```json
{
  "protocol": "openspool",
  "brand": "Polymaker",
  "type": "PLA",
  "subtype": "Silk",
  "color_hex": "#1E90FF",
  "alpha": 255,
  "diameter": 1.75,
  "weight": 1000,
  "min_temp": 190,
  "max_temp": 220
}
```

## Crypto / signing

There is **no cryptography** in OpenSpool:

- No HMAC, no signature, no checksum over the JSON.
- No key diversification, no UID-binding.
- No sector keys, no per-block scrambling.
- Tag integrity relies solely on the underlying Type 2 NDEF format (CC + TLV + record framing).

Implication for trust: OpenSpool tags are **clonable and forgeable**. The protocol is a label format, not an authenticator. Any JS implementation should treat the decoded fields as user-supplied data — clamp ranges (alpha already clamped, temperatures validated to `max ≥ min`), reject non-finite numbers, and never use the tag content to authorise sensitive operations server-side.

## Read-only port — JavaScript notes

Goal: from the raw bytes returned by a Mifare Ultralight read (or a Web NFC `NDEFReadingEvent`), produce the same `GenericFilament` shape.

Two entry paths in JS, depending on what the reader exposes:

1. **Web NFC (`NDEFReader`)** — the browser already parses NDEF for you. You receive `event.message.records[]` with `recordType`, `mediaType`, and a `DataView` for the payload.
   - Filter to `record.recordType === 'mime'` and `record.mediaType === 'application/json'`.
   - `new TextDecoder('utf-8').decode(record.data)` → JSON string.
   - Skip the entire CC/TLV parser; jump straight to JSON validation.

2. **Raw Ultralight dump** (PC/SC `READ`, libnfc, ESP32 firmware, etc.) — you have a `Uint8Array` of the user memory. Reproduce `__ndef_parse`:
   - Locate CC: byte 0 must be `0xE1`; if not, scan first 16 bytes for `0xE1` followed by `0x10|0x11|0x40` and start there. Skip the 4-byte CC.
   - Walk TLVs: read 1 byte tag; if tag `0xFE` stop; if tag `0x00` skip 1 byte and continue; otherwise read length byte. If length == `0xFF`, read next 2 bytes as big-endian 16-bit length.
   - For tag `0x03` (NDEF message), read `length` bytes and walk records inside.
   - Per record: parse header byte (bits 0–2 = TNF, bit 3 = IL, bit 4 = SR, bit 6 = ME), then `type_length`, then `payload_length` (1 byte if SR else 4 BE), then optional `id_length`, then type bytes (ASCII), then optional id bytes, then payload bytes.
   - Keep records where `tnf === 0x02` and `mimeType === 'application/json'`. Stop at first record whose JSON parses and validates.

JSON validation must mirror `__openspool_parse_payload` exactly:

```js
function decodeOpenspoolJson(jsonString) {
  let data;
  try { data = JSON.parse(jsonString); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.protocol !== 'openspool') return null;

  const brand    = typeof data.brand === 'string' ? data.brand : 'Generic';
  const type     = String(data.type || 'PLA').toUpperCase();
  const subtype  = typeof data.subtype === 'string' ? data.subtype : '';

  const rgb      = parseColorHex(data.color_hex);
  const alpha    = Math.max(0, Math.min(255, parseInt(data.alpha ?? 255, 10) || 0));
  const colorArgb = ((alpha & 0xff) << 24) | (rgb & 0xffffff);

  const diameter = numberOr(data.diameter, 1.75);
  const weight   = intOr(data.weight, 1000);

  const minTemp  = parseInt(data.min_temp ?? 0, 10) || 0;
  const maxTemp  = parseInt(data.max_temp ?? 0, 10) || 0;
  if (maxTemp < minTemp) return null;

  const ext = OPENSPOOL_TYPE_TABLE[type] || { bed: 0, dry: 0, dryHours: 0 };

  return {
    sourceProcessor: 'OpenSpool',
    manufacturer: brand,
    type,
    modifiers: subtype ? [subtype] : [],
    colors: [colorArgb >>> 0],          // unsigned 32-bit
    diameterMm: diameter,
    weightGrams: weight,
    hotendMinTempC: minTemp,
    hotendMaxTempC: maxTemp,
    bedTempC: ext.bed,
    dryingTempC: ext.dry,
    dryingTimeHours: ext.dryHours,
    manufacturingDate: '0001-01-01',
  };
}

function parseColorHex(v) {
  try {
    let s = String(v ?? 'FFFFFF');
    if (s.startsWith('#')) s = s.slice(1);
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : 0xFFFFFF;
  } catch { return 0xFFFFFF; }
}
function numberOr(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function intOr(v, fallback)    { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; }

const OPENSPOOL_TYPE_TABLE = {
  PLA:   { bed: 60,  dry: 50, dryHours: 8 },
  PETG:  { bed: 70,  dry: 65, dryHours: 8 },
  ABS:   { bed: 100, dry: 80, dryHours: 8 },
  TPU:   { bed: 50,  dry: 70, dryHours: 8 },
  NYLON: { bed: 100, dry: 80, dryHours: 8 },
};
```

JS gotchas worth calling out:

- **Bitwise ops are signed 32-bit in JS.** When packing ARGB, finish with `>>> 0` if you need an unsigned integer to render as `0xAARRGGBB` correctly.
- `parseInt(undefined, 10)` returns `NaN`; the Python code uses `int(data.get(..., default))` which never raises here because `0` is the default. Coerce explicitly.
- The Python `__parse_color_hex` returns `0xFFFFFF` on any failure (including `None`). Mirror that — never throw out of the decoder.
- The processor returns `None` for: missing/invalid payload, non-`application/json` records, `protocol != "openspool"`, non-dict JSON, `max_temp < min_temp`. All of these should yield `null` (not an exception) from the JS port so the caller can fall back to the next vendor decoder.
- Default `manufacturing_date` is **literally** the string `"0001-01-01"` — keep it as a marker for "unknown" rather than today's date.

## Source files (for sync)
- `OpenRFID/src/tag/openspool/processor.py`
- `OpenRFID/src/tag/openspool/constants.py`
