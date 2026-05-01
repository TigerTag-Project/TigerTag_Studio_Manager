# Snapmaker RFID — technical reference

> Reference: OpenRFID `src/tag/snapmaker/` (vendored under `OpenRFID/`)

## Tag type

Snapmaker filament tags are **MIFARE Classic 1K** (`TagType.MifareClassic1k`, internal label `M1_1K`).

Total payload size: **1024 bytes** (`M1_PROTO_TOTAL_SIZE = 1024`).

The processor refuses any tag that is not a Mifare Classic 1K, or whose data dump is not exactly 1024 bytes long.

Position math used throughout the layout uses the macro:

```
position = sector_num * 64 + block_num * 16 + byte_num
```

That is, sectors are 64 bytes (4 blocks × 16 bytes) — the standard MIFARE Classic 1K geometry.

## Authentication

Per-sector A/B keys are derived **per-tag** from the RFID UID using **HKDF-style** key expansion (HMAC-SHA-256), seeded by a static salt shared across all Snapmaker tags.

### Static salt (vendor secret)

```
SNAPMAKER_SALT_HASH = "19aee31a8bcadb0becc08bbaa9197ab403f9c7a2097197d127a2ab7010a7867a"
```

This is loaded from configuration via `load_hex_key_from_config(SNAPMAKER_SALT_HASH)`. If the configured key is missing or empty, the processor disables itself and rejects all scans. The hex string above is used as a **lookup name / index** — the actual 32-byte secret is provisioned by the operator into config; the constant itself just identifies which secret to retrieve.

### Key derivation

For each tag scan, the processor derives 16 sector keys × 6 bytes each, twice — once for key A and once for key B.

```python
ikm  = uid[0:4]                # 4 bytes from the tag UID
saltA = key[:25]               # first 25 bytes of the configured secret
saltB = key                    # full configured secret

keyA[i] = HKDF(salt=saltA, ikm=ikm, info=b"key_a_" + i, len=6)  for i in 0..15
keyB[i] = HKDF(salt=saltB, ikm=ikm, info=b"key_b_" + i, len=6)  for i in 0..15
```

HKDF implementation details (from `__hkdf_create_key`):

- Hash: **SHA-256**
- Trailing `\x00` is stripped from the salt before use
- `PRK = HMAC(salt, ikm)`
- For each sector `i` (0..15) and a one-byte counter starting at 1:
  - `OKM = HMAC(PRK, info || counter)` repeated until ≥ 6 bytes
  - Truncate to 6 bytes → that sector's key

The two key sets are returned in a `TagAuthentication(keysA, keysB)` object; the caller uses these to authenticate each MIFARE sector before reading.

## Block layout

All field positions and lengths are byte-precise. Multi-byte integer fields are stored **little-endian on the tag** — the processor calls `__slice(..., reversed=True)` to flip them before `__convert_to_int` (which itself reads big-endian). String fields and RGB triplets are stored in natural order (`reversed=False`).

### Sector 0 — UID and identity strings

| Field | Sector | Block | Offset | Len | Endianness | Notes |
|------|------|------|------|------|------|------|
| `M1_PROTO_UID`           | 0 | 0 | 0  | 4  | raw bytes | Card UID. Displayed as `XX:XX:XX:XX`. |
| `M1_PROTO_VENDOR`        | 0 | 1 | 0  | 16 | ASCII     | Vendor name, NUL-padded. Used as `manufacturer` on the GenericFilament. |
| `M1_PROTO_MANUFACTURER`  | 0 | 2 | 0  | 16 | ASCII     | Manufacturer name, NUL-padded. (Logged but not exposed on the GenericFilament — `vendor` is used instead.) |

### Sector 1 — Type, colors, SKU

| Field | Sector | Block | Offset | Len | Endianness | Notes |
|------|------|------|------|------|------|------|
| `M1_PROTO_VERSION`     | 1 | 0 | 0  | 2 | LE int  | Format version. |
| `M1_PROTO_MAIN_TYPE`   | 1 | 0 | 2  | 2 | LE int  | Main material code (see lookup). |
| `M1_PROTO_SUB_TYPE`    | 1 | 0 | 4  | 2 | LE int  | Sub-material / line code (see lookup). |
| `M1_PROTO_TRAY`        | 1 | 0 | 6  | 2 | LE int  | Tray slot. |
| `M1_PROTO_COLOR_NUMS`  | 1 | 0 | 8  | 1 | byte    | Number of valid RGB entries (must be ≤ 5). |
| `M1_PROTO_ALPHA`       | 1 | 0 | 9  | 1 | byte    | **Inverted** alpha. Effective `alpha = 0xFF - byte`. |
| `M1_PROTO_RGB_1`       | 1 | 1 | 0  | 3 | RGB     | First color, big-endian RRGGBB. |
| `M1_PROTO_RGB_2`       | 1 | 1 | 3  | 3 | RGB     | Second color. |
| `M1_PROTO_RGB_3`       | 1 | 1 | 6  | 3 | RGB     | Third color. |
| `M1_PROTO_RGB_4`       | 1 | 1 | 9  | 3 | RGB     | Fourth color. |
| `M1_PROTO_RGB_5`       | 1 | 1 | 12 | 3 | RGB     | Fifth color. |
| `M1_PROTO_SKU`         | 1 | 2 | 0  | 4 | LE int  | SKU number. |

### Sector 2 — Print parameters, manufacture date, signing version

| Field | Sector | Block | Offset | Len | Endianness | Notes |
|------|------|------|------|------|------|------|
| `M1_PROTO_DIAMETER`         | 2 | 0 | 0  | 2 | LE int | Hundredths of mm — divide by 100 → mm. |
| `M1_PROTO_WEIGHT`           | 2 | 0 | 2  | 2 | LE int | Spool net weight in grams. |
| `M1_PROTO_LENGTH`           | 2 | 0 | 4  | 2 | LE int | Length in meters. |
| `M1_PROTO_DRY_TEMP`         | 2 | 1 | 0  | 2 | LE int | Drying temperature, °C. |
| `M1_PROTO_DRY_TIME`         | 2 | 1 | 2  | 2 | LE int | Drying time, hours. |
| `M1_PROTO_HOTEND_MAX_TEMP`  | 2 | 1 | 4  | 2 | LE int | Max hotend °C. |
| `M1_PROTO_HOTEND_MIN_TEMP`  | 2 | 1 | 6  | 2 | LE int | Min hotend °C. |
| `M1_PROTO_BED_TYPE`         | 2 | 1 | 8  | 2 | LE int | Bed type code. |
| `M1_PROTO_BED_TEMP`         | 2 | 1 | 10 | 2 | LE int | Bed °C. |
| `M1_PROTO_FIRST_LAYER_TEMP` | 2 | 1 | 12 | 2 | LE int | First layer °C. |
| `M1_PROTO_OTHER_LAYER_TEMP` | 2 | 1 | 14 | 2 | LE int | Subsequent layers °C. |
| `M1_PROTO_MF_DATE`          | 2 | 2 | 0  | 8 | bytes  | Manufacturing date. **Format not yet decoded** in this implementation — the processor hard-codes `"2026-01-01"` and leaves a `TODO: Extract actual date`. |
| `M1_PROTO_RSA_KEY_VER`      | 2 | 2 | 8  | 2 | LE int | RSA public-key index used to sign this tag (see Crypto). Read directly via `(byte[1] << 8) \| byte[0]`. |

### Sectors 10..15 — Signature

The 256-byte PKCS#1 v1.5 RSA signature is **not stored contiguously**. It is reassembled from 6 sectors by reading the first 48 bytes of each sector starting at sector 10 (sectors 10, 11, 12, 13, 14, 15):

```python
signature_read = b''
for i in range(6):
    signature_read += data[(10 + i) * 64 : (10 + i) * 64 + 48]
# 6 * 48 = 288 bytes, of which only the first 256 are used as the signature
```

Only `signature_read[0:256]` is fed to the verifier.

## Field semantics

### Computed / derived fields

| Output field | How it's built |
|------|------|
| `diameter_mm` | `raw_diameter / 100.0` (raw is hundredths of a mm, e.g. `175 → 1.75`). |
| `alpha` | `0xFF - data[ALPHA_POS]` — the byte stored on the tag is the bitwise complement of the effective alpha. |
| `rgb_N` (N = 1..5) | `(alpha << 24) \| <3-byte BE RGB triplet>`. So all five colors share the same alpha. |
| `argb_color` | `(alpha << 24) \| (rgb_1 & 0xFFFFFF)` — same as `rgb_1` recomposed; used as the canonical "primary color" identifier (passed to `unique_id`). |
| `colors` | The list `[rgb_1, rgb_2, rgb_3, rgb_4, rgb_5]` truncated to the first `color_nums` entries. If `color_nums > 5` the tag is rejected (`FILAMENT_PROTO_COLOR_NUMS_MAX = 5`). |
| `card_uid` (display) | `bytes.hex(':').upper()` → `AA:BB:CC:DD`. |
| `unique_id` | `GenericFilament.generate_unique_id("Snapmaker", vendor, manufacturer, main_type, sub_type, argb_color, weight_grams, sku, tray)`. |
| `manufacturing_date` | **Currently hard-coded** to `"2026-01-01"` — the actual `MF_DATE` bytes are not yet parsed (`TODO` in source). |

### Lookup: main material type

Source: `FILAMENT_PROTO_MAIN_TYPE_MAPPING` in `constants.py`.

| Code | String |
|------|------|
| 0 | `Reserved` |
| 1 | `PLA` |
| 2 | `PETG` |
| 3 | `ABS` |
| 4 | `TPU` |
| 5 | `PVA` |

Codes outside this table cause the tag to be rejected (logged as `Unknown main type code`).

### Lookup: sub-type / product line

Source: `FILAMENT_PROTO_SUB_TYPE_MAPPING` in `constants.py`.

| Code | String |
|------|------|
| 0 | `Reserved` |
| 1 | `Basic` |
| 2 | `Matte` |
| 3 | `SnapSpeed` |
| 4 | `Silk` |
| 5 | `Support` |
| 6 | `HF` |
| 7 | `95A` |
| 8 | `95A HF` |

Codes outside this table cause the tag to be rejected (logged as `Unknown sub type code`).

### Color count

`FILAMENT_PROTO_COLOR_NUMS_MAX = 5`. A `color_nums` byte greater than 5 invalidates the tag.

### Bed type

`bed_type` is decoded as a raw integer code. **No textual lookup table is provided in the source** — the integer is logged as-is and is currently not surfaced on `GenericFilament` (the processor reads it but does not pass it through).

### Error codes

Defined in `constants.py` (status codes, not currently used by `process_tag` — it returns `None` on any failure instead):

| Constant | Value |
|------|------|
| `FILAMENT_PROTO_OK` | `0` |
| `FILAMENT_PROTO_ERR` | `-1` |
| `FILAMENT_PROTO_PARAMETER_ERR` | `-2` |
| `FILAMENT_PROTO_RSA_KEY_VER_ERR` | `-3` |
| `FILAMENT_PROTO_SIGN_CHECK_ERR` | `-4` |

## Crypto / signing

Tags are signed with **RSA-2048 PKCS#1 v1.5** over the **first 640 bytes** of the dump (`data[0:640]`, i.e. sectors 0..9), using **SHA-256** as the hash.

### RSA key version selection

Each tag carries a 2-byte `M1_PROTO_RSA_KEY_VER` field in sector 2, block 2, offset 8. Note: the version is **read manually** as `(byte[1] << 8) | byte[0]` — this is little-endian — rather than going through `__slice` / `__convert_to_int`.

The version indexes into `FILAMENT_PROTO_RSA_PUBLIC_KEY_MAPPING`, which contains **10 distinct RSA public keys** (versions 0..9). All 10 PEM blobs are embedded verbatim in `constants.py` (`FILAMENT_PROTO_RSA_PUBLIC_KEY_0` through `FILAMENT_PROTO_RSA_PUBLIC_KEY_9`). An unknown version causes the tag to be rejected (`Unknown RSA key version`).

### Verification flow

```python
def __verify_signature(data):
    rsa_ver = (data[RSA_KEY_VER_POS+1] << 8) | data[RSA_KEY_VER_POS]
    public_key = FILAMENT_PROTO_RSA_PUBLIC_KEY_MAPPING.get(rsa_ver)
    if public_key is None: return (False, rsa_ver)

    # Reassemble 256-byte signature from sectors 10..15, first 48 bytes each
    signature = b''.join(data[(10+i)*64 : (10+i)*64 + 48] for i in range(6))[:256]

    # PKCS#1 v1.5 + SHA-256 over the first 640 bytes
    pem = serialization.load_pem_public_key(public_key, ...)
    pem.verify(signature, data[0:640], padding.PKCS1v15(), hashes.SHA256())
```

If verification fails, `process_tag` returns `None` and the tag is treated as invalid. The full RSA verification — not just sector authentication — gates every read.

## Read-only port — JavaScript notes

For a JS/browser read-only consumer (after sectors have been authenticated and dumped to a 1024-byte `Uint8Array`):

- **Endianness**: most numeric fields are little-endian. Use `DataView.getUint16(pos, /*littleEndian=*/true)` (and `getUint32` for SKU). Do **not** little-endian the 3-byte RGB triplets or string fields — those are read in natural order.
- **Position helper**: `pos(sector, block, byte) = sector*64 + block*16 + byte`.
- **Strings (vendor, manufacturer)**: 16-byte ASCII slice, then strip trailing `\x00` (`.replace(/\x00+$/, '')`).
- **Diameter**: read u16 LE, divide by `100.0`.
- **Alpha**: read 1 byte, then `alpha = 0xFF ^ byte` (or `255 - byte`).
- **RGB**: read 3 bytes in natural order → `(r << 16) | (g << 8) | b`. Compose ARGB as `((alpha & 0xFF) << 24) | rgb`. Truncate to `colorNums`.
- **Card UID display**: `Array.from(slice).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(':')`.
- **Lookup tables**: see the two tables above (main type, sub type). Codes outside the tables should produce a "tag rejected" state.
- **Manufacturing date**: 8 bytes at sector 2, block 2, offset 0. Format is **not decoded** in the reference implementation — surface as a raw hex string until decoded.
- **Signature verification**: requires WebCrypto `RSASSA-PKCS1-v1_5` + `SHA-256` against the matching public key from a 10-entry table (versions 0..9). If signature is not enforced (read-only viewer), at minimum surface `rsaKeyVersion` so the user can see whether the tag advertises a known version.
- **Authentication keys**: HKDF-SHA-256 with truncated 6-byte output per sector, info string `"key_a_<i>"` / `"key_b_<i>"`. This requires the static salt secret, which is operator-provisioned and **not** present in the open source — a JS reader without that secret cannot authenticate the MIFARE sectors itself, but can still parse a dump produced by an authenticated reader.
- **Validation gates** (mirror Python behavior to avoid surfacing bogus tags):
  - dump length must be exactly 1024
  - `colorNums ≤ 5`
  - main and sub type must be in the lookup tables
  - RSA key version must be in `0..9`

## Source files (for sync)

- `OpenRFID/src/tag/snapmaker/processor.py`
- `OpenRFID/src/tag/snapmaker/constants.py`
