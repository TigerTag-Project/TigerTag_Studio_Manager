# Qidi RFID — technical reference

> Reference: OpenRFID `src/tag/qidi/` (vendored under `OpenRFID/`)

## Tag type

- **MIFARE Classic 1K** (`TagType.MifareClassic1k`). Any other tag type raises `ValueError` and is rejected by the processor.
- Total payload read by the processor: 1024 bytes (16 sectors × 4 blocks × 16 bytes), but only sector 1 carries Qidi-specific data.

## Authentication

- Single key used for both Key A and Key B on every sector.
- Key value: `FF FF FF FF FF FF` (six bytes of `0xFF`) — the MIFARE Classic factory default.
- The processor builds a 16-row key table (one entry per sector) where every row is `[0xFF]*6`, and passes the same table for Key A and Key B in `TagAuthentication`.
- Note from `processor.py`: BoxRFID references a second alternative key, but the vendored implementation deliberately uses only the default `0xFF…FF` key. Tags requiring a different key are not currently handled.

## Block layout

Qidi data lives entirely in **sector 1**. The processor reads bytes `[64:112]` of the dump — that is the 48 bytes of the three data blocks of sector 1 (blocks 4, 5, 6). Block 7 (the sector trailer) is not consumed.

| Offset (within sector 1) | Byte index in raw dump | Field                | Type   | Notes                                  |
|---|---|---|---|---|
| 0  | 64 | `material_code`     | uint8  | Index into `MATERIALS` table           |
| 1  | 65 | `color_code`        | uint8  | Index into `COLORS` table              |
| 2  | 66 | `manufacturer_code` | uint8  | Used only as part of `unique_id` hash  |
| 3–47 | 67–111 | reserved/padding | bytes  | **Must be all `0x00`**, otherwise the tag is rejected as not-Qidi |

### Validation rules (all must pass, otherwise `process_tag` returns `None`)

1. `sector_one[3:]` (45 trailing bytes) is exactly `\x00 * 45`.
2. `material_code != 0x00`
3. `color_code != 0x00`
4. `manufacturer_code != 0x00`
5. `material_code` is a key in `MATERIALS` (else logs error, returns `None`).
6. `color_code` is a key in `COLORS` (else logs error, returns `None`).

If validation 1–4 fails the processor logs `"Data format does not match expected QIDI format"` at WARNING level and returns `None` — meaning the tag is silently treated as foreign rather than corrupted.

## Field semantics

The processor builds a `GenericFilament` with these values:

| Field                | Source                                                              |
|---|---|
| `source_processor`  | `self.name` (processor name set by base class)                       |
| `unique_id`         | `GenericFilament.generate_unique_id("QIDI", material_code, color_code, manufacturer_code)` |
| `manufacturer`      | Literal string `"QIDI"` (the `manufacturer_code` byte is **not** decoded into a name) |
| `type`              | `MATERIALS[material_code]["type"]`                                   |
| `modifiers`         | `MATERIALS[material_code]["modifiers"]` (list of strings, possibly empty) |
| `colors`            | `[COLORS[color_code]]` — a single 24-bit RGB integer wrapped in a list |
| `diameter_mm`       | Hard-coded `1.75`                                                    |
| `weight_grams`      | Hard-coded `1000`                                                    |
| `hotend_min_temp_c` | Hard-coded `0` (not encoded on tag)                                  |
| `hotend_max_temp_c` | Hard-coded `0` (not encoded on tag)                                  |
| `bed_temp_c`        | Hard-coded `0`                                                       |
| `drying_temp_c`     | Hard-coded `0`                                                       |
| `drying_time_hours` | Hard-coded `0`                                                       |
| `manufacturing_date`| Hard-coded `"0001-01-01"` (sentinel — Qidi tags don't carry a date) |

In short: **only `type`, `modifiers`, and `colors` come from the tag**. Diameter and spool weight are assumed; all temperatures and the manufacturing date are placeholders. A JS port can reproduce identical output by emitting these constants.

## Lookup tables

### COLORS — `material_code` byte → 24-bit RGB integer

Stored as a single integer (`0xRRGGBB`). To render: split into R/G/B or format as hex with `#` prefix.

| Code | RGB hex   |
|------|-----------|
| `0x01` | `#FAFAFA` |
| `0x02` | `#060606` |
| `0x03` | `#D9E3ED` |
| `0x04` | `#5CF30F` |
| `0x05` | `#63E492` |
| `0x06` | `#2850FF` |
| `0x07` | `#FE98FE` |
| `0x08` | `#DFD628` |
| `0x09` | `#228332` |
| `0x0A` | `#99DEFF` |
| `0x0B` | `#1714B0` |
| `0x0C` | `#CEC0FE` |
| `0x0D` | `#CADE4B` |
| `0x0E` | `#1353AB` |
| `0x0F` | `#5EA9FD` |
| `0x10` | `#A878FF` |
| `0x11` | `#FE717A` |
| `0x12` | `#FF362D` |
| `0x13` | `#E2DFCD` |
| `0x14` | `#898F9B` |
| `0x15` | `#6E3812` |
| `0x16` | `#CAC59F` |
| `0x17` | `#F28636` |
| `0x18` | `#B87F2B` |

No human-readable color names are encoded — the RGB triplet is the only color information. Codes outside this table cause the tag to be rejected.

### MATERIALS — `material_code` byte → `{ type, modifiers[] }`

| Code | type        | modifiers              |
|------|-------------|------------------------|
| `0x01` | `PLA`       | `[]`                   |
| `0x02` | `PLA`       | `["Matte"]`            |
| `0x03` | `PLA`       | `["Metal"]`            |
| `0x04` | `PLA`       | `["Silk"]`             |
| `0x05` | `PLA-CF`    | `[]`                   |
| `0x06` | `PLA`       | `["Wood"]`             |
| `0x07` | `PLA`       | `["Basic"]`            |
| `0x08` | `PLA`       | `["Matte", "Basic"]`   |
| `0x0B` | `ABS`       | `[]`                   |
| `0x0C` | `ABS-GF`    | `[]`                   |
| `0x0D` | `ABS`       | `["Metal"]`            |
| `0x0E` | `ABS`       | `["Odorless"]`         |
| `0x12` | `ASA`       | `[]`                   |
| `0x13` | `ASA-AERO`  | `[]`                   |
| `0x18` | `PA`        | `["Ultra"]`            |
| `0x19` | `PA12-CF`   | `[]`                   |
| `0x1A` | `PA-CF`     | `["Ultra", "CF25"]`    |
| `0x1E` | `PAHT-CF`   | `[]`                   |
| `0x1F` | `PAHT-GF`   | `[]`                   |
| `0x20` | `BVOH`      | `["For PAHT"]`         |
| `0x21` | `BVOH`      | `["For PET/PA"]`       |
| `0x22` | `PC-ABS`    | `["FR"]`               |
| `0x25` | `PET-CF`    | `[]`                   |
| `0x26` | `PET-GF`    | `[]`                   |
| `0x27` | `PETG`      | `["Basic"]`            |
| `0x28` | `PETG`      | `["Tough"]`            |
| `0x29` | `PETG`      | `[]`                   |
| `0x2C` | `PPS-CF`    | `[]`                   |
| `0x2D` | `PETG`      | `["Translucent"]`      |
| `0x2F` | `PVA`       | `[]`                   |
| `0x31` | `TPU`       | `["AERO"]`             |
| `0x32` | `TPU`       | `[]`                   |

Gaps in the codepoint sequence (`0x09`, `0x0A`, `0x0F`–`0x11`, `0x14`–`0x17`, `0x1B`–`0x1D`, `0x23`, `0x24`, `0x2A`, `0x2B`, `0x2E`, `0x30`) are unmapped — encountering them produces an error log and a `None` result.

## Computed fields

- **`unique_id`** — produced by the shared helper `GenericFilament.generate_unique_id("QIDI", material_code, color_code, manufacturer_code)`. Implementation lives in the OpenRFID base library (not in `qidi/`); reuse the same helper in JS for cross-vendor uniqueness. The four inputs are: literal vendor string `"QIDI"`, then the three meaningful bytes from the tag.
- **`colors`** array — always exactly one element. The integer `0xRRGGBB` is the Python-side representation; in JS the same integer or a `"#RRGGBB"` string both work as long as downstream consumers agree.
- All other "computed" fields are constants (see field-semantics table). There is no checksum, no CRC, no serial number, no batch code, no date stamp, and no temperature data on a Qidi tag.

## Crypto / signing

None. Qidi tags are unsigned and unencrypted. Authentication is the stock MIFARE Classic key-A/key-B handshake using the factory-default `FF FF FF FF FF FF` key — there is no per-tag derivation, no HMAC, and no signature byte to verify. A tag that decodes cleanly and passes the all-zero padding check is considered authentic.

This means: cloning a Qidi tag requires nothing more than copying sector 1 to a writable MIFARE Classic 1K card.

## Read-only port — JavaScript notes

For a JS read-only implementation:

1. **Tag detection** — confirm the card is MIFARE Classic 1K before attempting decode.
2. **Authentication** — authenticate sector 1 (block 4) with key A or key B = `0xFFFFFFFFFFFF`. Sectors 0 and 2–15 are not needed for decode but use the same key if you choose to read them.
3. **Read sector 1** — read blocks 4, 5, 6 (48 bytes total). Block 7 is the sector trailer; skip it.
4. **Validate** — bytes `[3..47]` of those 48 bytes must be all `0x00`; bytes 0/1/2 must each be non-zero. Reject the tag otherwise.
5. **Lookup** — index `MATERIALS[byte0]` and `COLORS[byte1]`. Unknown codes → reject.
6. **Build the result object** with the constants listed in the field-semantics table. Hard-code diameter `1.75`, weight `1000`, all temps `0`, manufacturing date `"0001-01-01"`, manufacturer `"QIDI"`. Modifiers is always an array (use `[]` for materials with no modifiers — never `null`).
7. **`unique_id`** — replicate the cross-vendor `generate_unique_id` helper (lives in the OpenRFID generic filament module, not in `qidi/`). Inputs: `("QIDI", material_code, color_code, manufacturer_code)`.

The Qidi format does not need any write paths in the read-only port.

## Source files (for sync)

- `OpenRFID/src/tag/qidi/processor.py`
- `OpenRFID/src/tag/qidi/constants.py`
