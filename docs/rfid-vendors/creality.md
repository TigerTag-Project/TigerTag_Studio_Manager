# Creality RFID — technical reference

> Reference: OpenRFID `src/tag/creality/` (vendored under `OpenRFID/`)

## Tag type

**Mifare Classic 1K** (`TagType.MifareClassic1k`). The processor rejects any other tag type with a `ValueError`. Standard Mifare Classic 1K layout: 16 sectors x 4 blocks x 16 bytes = 1024 bytes total.

## Authentication

Per-tag Key A is derived from the tag UID via a single AES-128-ECB encryption. Key B is left at factory default. Only **sector 1** uses the derived key; all other sectors fall back to default `FF FF FF FF FF FF` keys A and B.

### Key derivation (HKDF-style — function name is `__hkdf_create_key` but the algorithm is plain AES)

Inputs:

- `uid` — 4-byte tag UID (length is enforced; non-4-byte UIDs raise `ValueError`)
- `salt_key` — 16-byte master key, loaded from config; the SHA-256 hash of this key must match `CREALITY_SALT_HASH` (see Crypto / signing below)

Steps:

1. Build a 16-byte plaintext by repeating the UID four times: `plaintext = uid || uid || uid || uid`
2. AES-128-ECB encrypt `plaintext` with `salt_key`. Output is 16 bytes of ciphertext.
3. Take the first 6 bytes of ciphertext: `derived_key = ciphertext[0:6]`
4. Build the per-sector key tables:
   - `keys_a[i] = [0xFF] * 6` for all 16 sectors, then **override `keys_a[1] = derived_key`**
   - `keys_b[i] = [0xFF] * 6` for all 16 sectors

Only sector 1 (blocks 4–7) actually requires authentication with the derived key; every other sector authenticates with the default `FFFFFFFFFFFF`.

## Block layout

The processor reads the **full 1K dump** but only consumes a 48-byte slice located at byte offset `64..112`, which corresponds to **sector 1, blocks 4 / 5 / 6** (block 7 is the sector trailer and is skipped). Each Mifare Classic block is 16 bytes; offsets below are relative to the start of the 48-byte payload slice.

| Bytes (slice) | Mifare ref      | Size | Field            | Type / encoding | Notes |
|---------------|-----------------|------|------------------|------------------|-------|
| 0–2           | sector1/block4  | 3    | `batch`          | ASCII string     | Free-form batch code |
| 3–4           | sector1/block4  | 2    | `year`           | ASCII decimal    | `2000 + int(yy)` |
| 5             | sector1/block4  | 1    | `month`          | ASCII hex digit  | `int(c, 16)` — values 1–9 then `A`/`B`/`C` for Oct/Nov/Dec |
| 6–7           | sector1/block4  | 2    | `day`            | ASCII decimal    | `int(dd)` |
| 8–11          | sector1/block4  | 4    | `supplier`       | ASCII string     | Supplier code |
| 12–16         | sector1/block4–5| 5    | `material`       | ASCII string     | Filament code, lookup key into `CREALITY_FILAMENT_CODE_TO_DATA` |
| 17            | sector1/block5  | 1    | `color_prefix`   | ASCII char       | `'0'` or `'#'` — used as a sentinel for "is data plaintext?" check (see Encryption detection) |
| 18–23         | sector1/block5  | 6    | `color`          | ASCII hex (RGB)  | `0xFF000000 \| int(hex, 16)` — alpha-prefixed ARGB |
| 24–27         | sector1/block5  | 4    | `length_m`       | ASCII decimal    | Filament length in metres → maps to weight (see Field semantics) |
| 28–33         | sector1/block5–6| 6    | `serial`         | ASCII string     | Serial number |
| 34–47         | sector1/block6  | 14   | `reserve`        | ASCII string     | Reserved / unknown |

### Encryption detection

Before parsing, the processor inspects two specific bytes inside the 48-byte slice (still in their raw, on-tape form):

- `test1 = data_subset[3]`
- `test2 = data_subset[17]`

The data is treated as **plaintext** iff `test1 == 0x32` AND `test2 ∈ { 0x30, 0x23 }`. In other words: the first digit of the year must be ASCII `'2'` (0x32, since all dates are 20XX), and the `color_prefix` byte must be ASCII `'0'` (0x30) or `'#'` (0x23). Any other combination triggers AES decryption (see Crypto / signing) before parsing.

## Field semantics

### `length_m` → `weight_grams`

Hardcoded lookup; unknown lengths fall back to 1000 g.

| `length_m` | `weight_grams` |
|------------|----------------|
| 80         | 250            |
| 165        | 500            |
| 330        | 1000           |
| anything else | 1000        |

### `color`

Stored as 6 ASCII hex chars (RGB). The processor builds the final 32-bit ARGB integer as `(0xFF << 24) | int(rgb_hex, 16)` — so the alpha channel is forced to `0xFF` (fully opaque).

### `material` → metadata lookup (`CREALITY_FILAMENT_CODE_TO_DATA`)

Failure to find the code in the table is a hard error — `process_tag` returns `None` and logs `"Unknown Creality filament material code"`. Each entry supplies type, modifier list (subtype tags), hotend min/max temp, bed temp, drying temp, drying time. Diameter is hardcoded `1.75 mm` for every variant.

| Code  | Type  | Modifiers          | Hotend min | Hotend max | Bed | Dry T | Dry hrs |
|-------|-------|--------------------|-----------:|-----------:|----:|------:|--------:|
| 01001 | PLA   | Hyper              | 190 | 240 |  50 |  50 |  8 |
| 02001 | PLA-CF| Hyper              | 190 | 240 |  50 |  50 |  8 |
| 06002 | PETG  | Hyper              | 220 | 270 |  70 |  60 |  8 |
| 03001 | ABS   | Hyper              | 240 | 280 |  80 |  80 |  8 |
| 09002 | PLA   | Ender, Fast        | 190 | 240 |  50 |  50 |  6 |
| 04001 | PLA   | CR                 | 190 | 240 |  50 |  50 |  8 |
| 05001 | PLA   | CR, Silk           | 190 | 240 |  50 |  50 |  8 |
| 06001 | PETG  | CR                 | 220 | 270 |  70 |  60 |  8 |
| 07001 | ABS   | CR                 | 240 | 280 | 100 |  80 |  8 |
| 08001 | PLA   | Ender              | 190 | 240 |  50 |  50 |  8 |
| 09001 | PLA   | EN, PLA+           | 190 | 240 |  50 |  50 |  8 |
| 10001 | TPU   | HP                 | 190 | 240 |  40 |  65 |  8 |
| 11001 | PA    | CR, Nylon          | 250 | 270 |  50 |  80 |  8 |
| 13001 | PLA   | CR, Carbon         | 190 | 240 |  50 |  50 |  8 |
| 14001 | PLA   | CR, Matte          | 190 | 240 |  50 |  50 |  8 |
| 15001 | PLA   | CR, Fluo           | 190 | 240 |  50 |  50 |  8 |
| 16001 | TPU   | CR                 | 210 | 240 |  40 |  65 |  8 |
| 17001 | PLA   | CR, Wood           | 190 | 240 |  50 |  50 |  8 |
| 18001 | PLA   | HP, Ultra          | 190 | 240 |  50 |  50 |  8 |
| 19001 | ASA   | HP                 | 240 | 280 |  90 |  80 |  8 |
| 12003 | PA-CF | Hyper, PAHT        | 280 | 320 |  90 |  80 | 10 |
| 12002 | PA-CF | Hyper, PPA         | 280 | 320 | 100 | 100 |  8 |
| 07002 | PC    | Hyper              | 250 | 270 | 110 |  80 |  8 |
| 01601 | PLA   | Soleyin, Ultra     | 190 | 240 |  50 |  50 |  8 |

### `manufacturing_date`

Formatted as `YYYY-MM-DD` (zero-padded). Year is `2000 + yy`; month is parsed as a single hex digit (so `A` = 10, `B` = 11, `C` = 12); day is decimal.

### `unique_id`

`GenericFilament.generate_unique_id("Creality", data_str)` where `data_str` is the full 48-byte payload decoded as ASCII (errors='ignore'). Implementation lives outside this module — for the JS port, treat the unique id as an opaque hash over `("Creality", data_str)` and match the host implementation when available.

## Crypto / signing

Two distinct keys are involved. **Both are loaded from external config and verified by SHA-256 hash** — the source code does not contain the keys themselves, only the expected hashes.

| Purpose                    | Hash constant                          | SHA-256 hex (verifier)                                            |
|----------------------------|----------------------------------------|-------------------------------------------------------------------|
| Sector key salt (for KDF)  | `CREALITY_SALT_HASH`                   | `e544d94feb16159bbd7bc227df1e283eca1f38f2bb2015dfcc6161b74473b5c2` |
| Payload encryption key     | `CREALITY_ENCRYPTION_KEY_HASH`         | `acec2106007458579ba522b25610b2cf509ae59d7879cb975f65c45228e5c9a1` |

Both keys are 16 bytes (AES-128). The processor's `load_hex_key_from_config(expected_sha256, [name])` helper reads the configured hex string, hashes it, and accepts it only if the SHA-256 matches. If the salt key is missing the processor self-disables; if the encryption key is missing the processor only handles plaintext tags.

### Authentication key derivation

AES-128-ECB(`salt_key`, `uid || uid || uid || uid`) → take first 6 bytes → Key A for sector 1. See Authentication section.

### Payload encryption (when `is_encrypted == true`)

AES-128-ECB(`encryption_key`, `data_subset`) — applied to the entire 48-byte slice in one shot (3 ECB blocks, no IV, no padding handling needed since 48 = 3 × 16). The decrypted bytes replace `data_subset` and parsing proceeds as for plaintext.

No HMAC, no signature, no per-tag salt other than the UID for the sector key.

## Read-only port — JavaScript notes

### nfc-pcsc commands needed

For each tag:

1. **Get UID** (4 bytes) — typically via `reader.on('card', ...)` payload or `FF CA 00 00 00` APDU. Mifare Classic 1K UIDs are 4 bytes; 7-byte UIDs would need different handling (the Python rejects them).
2. **Authenticate sector 1** — load the derived 6-byte Key A into the reader's key slot, then authenticate block 4 (or any of 4/5/6) with Key A. With nfc-pcsc / pcsclite the standard pattern is:
   - `Load Authentication Keys` APDU: `FF 82 00 <slot> 06 <K1 K2 K3 K4 K5 K6>`
   - `General Authenticate` APDU: `FF 86 00 00 05 01 00 <block> 60 <slot>` (`60` = Key A)
3. **Read blocks 4, 5, 6** — `FF B0 00 <block> 10` returns 16 bytes. Concatenate the three responses → the 48-byte `data_subset`.
4. Sector trailer (block 7) is **not** read.

### Pitfalls

- **Endianness** — none of the numeric fields are binary; they are all ASCII-decoded substrings. The only "binary" interpretation is the hex color, which is parsed left-to-right as a normal hex string, and the ARGB assembly is `(0xFF << 24) | rgb` — JS bitwise ops produce signed 32-bit ints, so prefer `0xFF000000 | rgb` cast through `>>> 0` if you want an unsigned 32-bit color, or store as a `#RRGGBB` string with alpha tracked separately.
- **Month nibble** — parsed with `int(c, 16)` so `'A'`/`'a'` = 10, `'B'`/`'b'` = 11, `'C'`/`'c'` = 12. JS `parseInt(c, 16)` is equivalent.
- **UID length** — the KDF requires exactly 4 bytes. Reject 7-byte UIDs in the JS port to mirror Python behavior (or implement an alternate path if you support newer 7-byte tags).
- **Encryption-detection magic bytes** — the test runs on the **raw, undecrypted** slice. Bytes are: `data_subset[3] == 0x32` (ASCII `'2'`) AND `data_subset[17] ∈ {0x30, 0x23}` (ASCII `'0'` or `'#'`). Both conditions must be true to skip decryption. Don't apply the test post-decryption.
- **Default keys for other sectors** — if you want to read more than sector 1, all other sectors authenticate with `FF FF FF FF FF FF`; do not feed them the derived key.
- **AES library choice** — Node's built-in `crypto.createCipheriv('aes-128-ecb', key, null)` works; remember to call `cipher.setAutoPadding(false)` for both directions because both inputs are exact 16-byte multiples (16 bytes for KDF, 48 bytes for payload).
- **ASCII decode resilience** — Python uses `decode('ascii', errors='ignore')`, which silently drops non-ASCII bytes. In JS, `Buffer.from(slice).toString('latin1')` keeps byte alignment, or use `TextDecoder('ascii', { fatal: false })` and strip non-printables manually. The substring offsets must continue to match, so do not use a decoder that removes bytes.
- **Termination / null-padding** — fields like `batch` (3 chars), `supplier` (4 chars), and `serial` (6 chars) are taken as fixed-width substrings. There is no null terminator; trim whitespace if presenting to a user.
- **Unknown material code** — return `null` / undefined and log a warning, do not throw. Mirrors Python returning `None`.
- **Unknown length** — silently fall back to 1000 g (do not throw).
- **Key storage** — never hardcode the 16-byte salt or encryption keys in the bundled JS. Load from environment / config and verify with SHA-256 against the hashes above before use, exactly like the Python helper. The hashes themselves are safe to ship.

### What we don't need (writes)

- No `Update Binary` / `Mifare Write` (`FF D6 ...`) calls.
- No re-encryption path — read-only flow only ever decrypts.
- No HMAC/CRC computation — there is no signature in the payload.
- No sector-trailer modification, no Key B usage.
- No tag personalization (Creality-side factory programming is out of scope).

## Source files (for sync)

- `OpenRFID/src/tag/creality/processor.py`
- `OpenRFID/src/tag/creality/constants.py`
