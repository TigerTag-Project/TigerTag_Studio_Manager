# TigerTag RFID — technical reference

> Reference: OpenRFID `src/tag/tigertag/` (vendored under `OpenRFID/`)
> NOTE: This is OUR own format. This doc captures how the upstream OpenRFID
> project parses it; cross-check against our own implementation in
> `renderer/inventory.js` (normalizeRow function).

## Tag type

NXP **MIFARE Ultralight** family (NTAG-class). The OpenRFID processor extends
`MifareUltralightTagProcessor` and rejects any scan whose `scan_result.tag_type`
is not `TagType.MifareUltralight`.

The chip is read as a flat byte array. The processor skips the first **4 pages
(16 bytes)** of system / OTP / lock data and operates on the *user data*
region from page 4 onward:

```
USER_DATA_PAGE_OFFSET = 4
USER_DATA_BYTE_OFFSET = 4 * 4 = 16
user_data = data[16:]
```

A minimum readable payload of **96 bytes** (`MIN_DATA_LENGTH = 96`) of user
data is expected. The processor enforces a softer guard: it requires at least
`USER_DATA_BYTE_OFFSET + OFF_TIMESTAMP + 4 = 16 + 32 + 4 = 52` bytes of total
buffer before attempting to parse, but reads up to `OFF_TD + 1` for the
optional TD field.

## Authentication

None on the read path. The chip is read in clear; no key exchange, no
challenge-response, no MIFARE Classic-style `KeyA/KeyB`.

Integrity is asserted out-of-band by **ECDSA over secp256r1** (P-256). Each
**version ID** carries a public key:

```json
{ "id": 1542820452, "version": "1.0", "name": "TigerTag",
  "tag": "TIGER_TAG_MAKER_V1.0",
  "public_key": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwtX8JRYMoAXTbkU7EXJYKX7g4Mf0\nZ3WUuuGzlfyiEiS5UseXT6l1t1ZbMgzsg5IVA0TB7+/w6eyTlgnz/HXONw==\n-----END PUBLIC KEY-----" }
```

The processor in OpenRFID does **not** verify the signature today — bytes
80…end are read but unused in `processor.py`. See *Crypto / signing* below.

## Block layout

All offsets are **relative to `user_data`** (i.e. raw page 4 = offset 0).
Multi-byte numeric fields are **big-endian**. Source: `constants.py`.

| Offset (dec) | Size | Field            | Type   | Notes |
|-------------:|-----:|------------------|--------|-------|
|  0           | 4    | `OFF_TAG_ID`     | `>I`   | Format/version magic. Must be in `TIGERTAG_VALID_DATA_IDS` (see below). |
|  4           | 4    | `OFF_PRODUCT_ID` | `>I`   | Manufacturer SKU / product reference. |
|  8           | 2    | `OFF_MATERIAL_ID`| `>H`   | Lookup → `id_material.json`. |
| 10           | 1    | `OFF_ASPECT1_ID` | `B`    | Lookup → `id_aspect.json`. |
| 11           | 1    | `OFF_ASPECT2_ID` | `B`    | Lookup → `id_aspect.json`. |
| 12           | 1    | `OFF_TYPE_ID`    | `B`    | Lookup → `id_type.json` (filament / resin). |
| 13           | 1    | `OFF_DIAMETER_ID`| `B`    | Lookup → `id_diameter.json` (e.g. `56` → 1.75 mm, `221` → 2.85 mm). |
| 14           | 2    | `OFF_BRAND_ID`   | `>H`   | Lookup → `id_brand.json`. |
| 16           | 4    | `OFF_COLOR_RGBA` | 4×`B`  | Bytes are stored R, G, B, A; processor builds `argb_color = (a<<24)|(r<<16)|(g<<8)|b`. |
| 20           | 3    | `OFF_WEIGHT`     | 3×`B`  | 24-bit big-endian unsigned: `(b0<<16)\|(b1<<8)\|b2`. |
| 23           | 1    | `OFF_UNIT_ID`    | `B`    | Lookup → `id_measure_unit.json`. Drives unit conversion. |
| 24           | 2    | `OFF_TEMP_MIN`   | `>H`   | Hotend min °C. |
| 26           | 2    | `OFF_TEMP_MAX`   | `>H`   | Hotend max °C. |
| 28           | 1    | `OFF_DRY_TEMP`   | `B`    | Drying temperature °C. |
| 29           | 1    | `OFF_DRY_TIME`   | `B`    | Drying time, hours. |
| 30           | 1    | `OFF_BED_TEMP_MIN`| `B`   | Bed min °C. |
| 31           | 1    | `OFF_BED_TEMP_MAX`| `B`   | Bed max °C. |
| 32           | 4    | `OFF_TIMESTAMP`  | `>I`   | Manufacturing date, custom epoch (see below). |
| 44           | 2    | `OFF_TD`         | `>H`   | TD raw; `td_mm = raw / 10.0`. Optional — only read if `len(user_data) > OFF_TD + 1`. |
| 48           | 32   | `OFF_METADATA`   | bytes  | Reserved metadata block. Not parsed by `processor.py`. |
| 80           | ≤16  | `OFF_SIGNATURE`  | bytes  | ECDSA signature region. Not verified by `processor.py`. |

`MIN_DATA_LENGTH = 96` user-data bytes (signature inclusive).

### Format magic

```python
TIGERTAG_VALID_DATA_IDS = {0x5BF59264, 0xBC0FCB97}
```

If `tag_id` is not one of these, the processor returns `None`. The human-readable
version name is then resolved from `registry.version_ids` (loaded from
`id_version.json`); unknown ids fall back to `"Unknown"`.

### Custom epoch

```python
TIGERTAG_EPOCH_OFFSET = 946684800   # 2000-01-01 00:00:00 UTC, in Unix seconds
```

`unix_ts = chip_timestamp + TIGERTAG_EPOCH_OFFSET`. A `chip_timestamp == 0`
means "no date" and is rendered as `"0001-01-01"`. Any
`OSError | OverflowError | ValueError` from `datetime.fromtimestamp` is also
mapped to `"0001-01-01"`.

## Field semantics

### Color

Bytes at offset 16 are read in **RGBA** order, then re-packed as **ARGB**:

```python
argb_color = (a << 24) | (r << 16) | (g << 8) | b
```

`GenericFilament.colors` is set to `[argb_color]` — single-color only at this
layer. (Multi-tone aspects are flagged via `aspect1_id` / `aspect2_id`
look-ups, not as additional color words.)

### Weight conversion

```python
def __convert_to_grams(self, value: int, unit_id: int) -> float:
    match unit_id:
        case 1 | 21: return float(value)        # gram
        case 2 | 35: return value * 1000.0      # kilogram
        case 10:     return value / 1000.0      # milligram
        case _:      return float(value)        # unknown → assume grams
```

The on-chip 24-bit weight is therefore implicitly capped at 16 777 215 of the
declared unit. `id_measure_unit.json` carries non-weight units too (volume,
size) — those fall through the `_` arm and are returned as raw grams, which is
almost certainly wrong for non-weight units. (Worth double-checking against our
producer side.)

### Material composition

The same `id_material.json` row is consulted three times to produce three
parallel maps:

| Registry key          | JSON candidate fields                                              | Use |
|-----------------------|--------------------------------------------------------------------|-----|
| `material_ids`        | `name`, `label`, `title`, `description`                            | Display label, e.g. `"PE-CF"`. |
| `material_type_ids`   | `material_type`, `name`, `label`, `title`, `description`           | Base polymer, e.g. `"PE"`. |
| `filled_type_ids`     | `filled_type`                                                      | Reinforcement, e.g. `"CF"`. Empty for non-filled. |

The processor then composes:

```python
resolved_material_type = material_type if not filled_type else f"{material_type}-{filled_type}"
```

Example record from the vendored database:

```json
{ "id": 18775, "label": "PE-CF", "material_type": "PE", "filled_type": "CF",
  "density": 1.1, "filled": true, "product_type_id": 142,
  "recommended": { "nozzleTempMin": 175, "nozzleTempMax": 220,
                   "dryTemp": 80, "dryTime": 12,
                   "bedTempMin": 55, "bedTempMax": 60 },
  "metadata": { "bambuID": "GFP98" } }
```

### Aspects (modifiers)

`aspect1_id` and `aspect2_id` are each looked up against `aspect_ids`. Any
non-empty label that is not `"None"`, `""`, or `"-"` is appended to
`GenericFilament.modifiers` (preserving order: aspect1 then aspect2).

### TD (Transmission Distance)

Two bytes at offset 44, big-endian, divided by 10 to yield millimetres. Only
read when the buffer is long enough; defaults to `0.0` otherwise.

### Output mapping → `GenericFilament`

| GenericFilament attr     | Source |
|--------------------------|--------|
| `source_processor`       | Processor `name` (Mifare Ultralight base). |
| `unique_id`              | `GenericFilament.generate_unique_id("TigerTag", brand_name, resolved_material_type, argb_color, product_id, timestamp_raw)`. |
| `manufacturer`           | `brand_name`. |
| `type`                   | `resolved_material_type` (`"PE"` or `"PE-CF"`, …). |
| `modifiers`              | Filtered aspect labels. |
| `colors`                 | `[argb_color]`. |
| `diameter_mm`            | `diameter_ids.get(diameter_id, 1.75)`. |
| `weight_grams`           | After `__convert_to_grams`. |
| `hotend_min_temp_c`      | `float(temp_min)`. |
| `hotend_max_temp_c`      | `float(temp_max)`. |
| `bed_temp_c`             | Hard-coded `0.0` (per-spool bed range stays in chip but isn't propagated here). |
| `drying_temp_c`          | `float(dry_temp)`. |
| `drying_time_hours`      | `float(dry_time)`. |
| `manufacturing_date`     | `"YYYY-MM-DD"` from `__timestamp_to_date`. |
| `td`                     | `td_mm`. |

## ID lookup tables (registry / database)

The registry is a frozen dataclass (`TigerTagRegistry`) cached at module level
(`_REGISTRY_CACHE`) and populated lazily by `get_tigertag_registry()`. Source:
`registry.py`.

`_load_registry()` reads JSON files from
`OpenRFID/src/tag/tigertag/database/` (path is resolved relative to
`registry.py`, so the directory ships next to the code). One JSON file per
domain:

| Registry attribute     | JSON file                  | Value transform | Label fields searched (in order) |
|------------------------|----------------------------|------------------|----------------------------------|
| `version_ids`          | `id_version.json`          | `str`            | `name`, `label`, `title`, `description`, `version` |
| `material_ids`         | `id_material.json`         | `str`            | `name`, `label`, `title`, `description` |
| `material_type_ids`    | `id_material.json` (re-read) | `str`          | `material_type`, `name`, `label`, `title`, `description` |
| `filled_type_ids`      | `id_material.json` (re-read) | `str`          | `filled_type` |
| `aspect_ids`           | `id_aspect.json`           | `str`            | `name`, `label`, `title`, `description` |
| `type_ids`             | `id_type.json`             | `str`            | `name`, `label`, `title`, `description` |
| `diameter_ids`         | `id_diameter.json`         | `float`          | `diameter`, `value`, `name`, `label`, `title` |
| `brand_ids`            | `id_brand.json`            | `str`            | `name`, `label`, `title`, `description`, `brand` |
| `unit_ids`             | `id_measure_unit.json`     | `str`            | `name`, `label`, `title`, `description`, `symbol`, `unit` |

### Loader robustness

`_load_id_map` is permissive:

- Accepts top-level **list of records** (current shape) or **dict keyed by id**, or a wrapper dict containing one of `data`, `items`, `results`, `response`, `content`.
- For each record, `_extract_id` tries fields `id`, `value`, `code`, `identifier`.
- For each record, `_extract_label` tries the per-table list above and returns the first non-`None`, non-empty value.
- IDs are coerced via `int(stripped, 0)` so `"0x5BF59264"`, `"42"`, `"42.0"`, ints, and floats all parse.
- File missing or invalid JSON → returns the supplied fallback (currently always `{}`). This means **any registry table can silently end up empty**, which the parser tolerates (every `.get(id, default)` call provides a fallback).

### Vendored database snapshot

Files under `OpenRFID/src/tag/tigertag/database/` (committed to the repo):

| File                   | Shape           | Notes |
|------------------------|-----------------|-------|
| `id_version.json`      | list of records | Each row has `id`, `version`, `name`, `tag`, and `public_key` (PEM secp256r1). |
| `id_material.json`     | list of records | Rich rows: `id`, `label`, `material_type`, `filled_type`, `density`, `filled`, `product_type_id`, `recommended` block, optional `metadata` (e.g. `bambuID`). |
| `id_aspect.json`       | list of records | `id`, `label`, `color_count`. Examples: `0=-`, `21=Clear`, `24=Tricolor`, `64=Glitter`, `67=Translucent`, `91=Glow in the Dark`, `92=Silk`, `97=Lithophane`, `104=Basic`. |
| `id_type.json`         | list of records | `142=Filament`, `173=Resin`. |
| `id_diameter.json`     | list of records | `56=1.75`, `221=2.85`. Loader converts `label` to float. |
| `id_brand.json`        | list of records | `id`, `name`, `type_ids` (list of allowed product-type ids). |
| `id_measure_unit.json` | list of records | `id`, `label`, `type` ∈ `weight`/`volume`/`size`. Includes `1?` (not present in shipped file — `__convert_to_grams` references unit_id `1` and `2` but the shipped JSON only contains `10=mg`, `21=g`, `35=kg`, …). Cross-check: the conversion table seems to be a **superset** of the shipped lookup — IDs 1 and 2 may exist on production servers but aren't in the cached file. |

### Mismatches worth flagging

- `__convert_to_grams` matches `unit_id` 1, 2, 21, 35, 10. The shipped `id_measure_unit.json` only has 10/21/35 (plus volume/size IDs). If a chip is encoded with unit 1 or 2 it will convert correctly but the **label lookup will fall back to `"g"`** (the registry default).
- `bed_temp_c` is hard-coded to `0.0` in the output — the chip bed-temp range fields (offsets 30 and 31) are decoded for the debug log only.

## download_json.py

A standalone helper that **refreshes the vendored `database/` cache** from the
TigerTag public API. Source: `download_json.py`.

```python
JSON_FILES = [
  ("https://api.tigertag.io/api:tigertag/version/get/all",          "id_version.json"),
  ("https://api.tigertag.io/api:tigertag/material/get/all",         "id_material.json"),
  ("https://api.tigertag.io/api:tigertag/aspect/get/all",           "id_aspect.json"),
  ("https://api.tigertag.io/api:tigertag/type/get/all",             "id_type.json"),
  ("https://api.tigertag.io/api:tigertag/diameter/filament/get/all","id_diameter.json"),
  ("https://api.tigertag.io/api:tigertag/brand/get/all",            "id_brand.json"),
  ("https://api.tigertag.io/api:tigertag/measure_unit/get/all",     "id_measure_unit.json"),
]
JSON_DIRECTORY = "database"
```

Behaviour:

- Entry point: `download_json_files(target_folder=None, timeout=10.0)` — when
  `target_folder` is `None`, files land next to `download_json.py` itself
  (`Path(__file__).parent / "database"`).
- `destination.mkdir(parents=True, exist_ok=True)`.
- For each URL: `requests.get(...).raise_for_status()`, then
  `file_path.write_text(response.text, encoding="utf-8")`.
- Failures are caught per-file and printed; the script never aborts.
- No checksum, no signature, no diff, no atomic rename. Each run **overwrites
  in place** with the latest server text.
- No automatic invocation. The runtime registry is loaded once from disk
  (`_REGISTRY_CACHE`) and held until process exit. To pick up a refreshed
  database, the host must restart, **or** clear `_REGISTRY_CACHE` manually
  (not exposed publicly).

Cache strategy in one line: **filesystem cache, manual refresh, last-writer
wins, in-process memoisation for the lifetime of the parser**.

## Crypto / signing

- Each `id_version.json` row carries a PEM **secp256r1** public key. Two
  versions ship with real keys (`TIGER_TAG_MAKER_V1.0`, `TIGER_TAG_INIT`); the
  `TIGER_TAG_UNINITIALIZED` row has an empty key.
- `OFF_SIGNATURE = 80` is reserved for an ECDSA signature; `MIN_DATA_LENGTH =
  96` allows 16 bytes of signature payload (typical compact ECDSA-P256 needs
  64 bytes raw or up to ~72 bytes DER, so this 16-byte slot is *not* sufficient
  for a full P-256 signature — possibly a truncated MAC, or signature continues
  past the end of the user-data window. **Cross-check needed.**).
- `OFF_METADATA = 48`..79 is a 32-byte block marked as reserved metadata.
- The OpenRFID processor reads neither block: signature verification is
  **not** implemented. A forged tag whose `OFF_TAG_ID` matches one of
  `TIGERTAG_VALID_DATA_IDS` and whose body fields decode without exception
  will pass through unchallenged.

## Read-only port — JavaScript notes

The Studio Manager's `renderer/inventory.js` does **not** parse raw chip
bytes. Instead, it consumes already-decoded Firestore documents
(`users/{uid}/inventory/{spoolId}`) populated server-side. So the comparison
below is between *two parsers of the same logical record*, not two byte-level
parsers.

### Where they agree

| Concept                | OpenRFID (`processor.py`)                              | Studio Manager (`normalizeRow`)                                      |
|------------------------|---------------------------------------------------------|----------------------------------------------------------------------|
| Custom 2000-01-01 epoch | `TIGERTAG_EPOCH_OFFSET = 946684800`                    | `CHIP_EPOCH_OFFSET = 946684800` (`fmtChipTs`).                       |
| Brand resolution       | `registry.brand_ids[brand_id]`                          | `dbFind("brand", id_brand)` against `data/id_brand.json`.            |
| Material resolution    | `registry.material_ids[material_id]`                    | `dbFind("material", id_material)` against `data/id_material.json`.   |
| Aspect resolution      | `registry.aspect_ids[aspect_id]`                        | `dbFind("aspect", id_aspect1/2)`.                                    |
| Diameter resolution    | `registry.diameter_ids[diameter_id]` → float            | `dbFind("diameter", data1)` then appends `" mm"`.                    |
| Type resolution        | `registry.type_ids[type_id]`                            | `dbFind("type", id_type)`.                                           |
| Version resolution     | `registry.version_ids[tag_id]`                          | `dbFind("version", id_tigertag)`.                                    |
| Two-aspect modifiers   | aspect1 + aspect2 list                                  | `aspect1` + `aspect2` fields in row.                                 |

The lookup files in `data/` mirror those in
`OpenRFID/src/tag/tigertag/database/` — same shape, same id space.

### Where they differ

- **Diameter chip slot.** OpenRFID reads `OFF_DIAMETER_ID` (offset 13). Studio
  Manager reads `data1`. The Firestore producer apparently re-uses generic
  `dataN` slots for chip bytes — `data1` ≈ diameter, `data2/3` ≈ nozzle
  min/max, `data4` ≈ dry temp, `data5` ≈ dry time, `data6/7` ≈ bed min/max.
  Confirm against the Cloud Function that writes the document.
- **Color.** OpenRFID emits a single 32-bit ARGB integer.
  `normalizeRow` exposes up to **three** RGB triples (`color_r/g/b`,
  `color_r2/g2/b2`, `color_r3/g3/b3`) plus an `online_color_list` array of
  hex strings. Multi-tone colors are therefore richer in our document than in
  the chip-decoded `GenericFilament` (where multi-tone is signalled only via
  aspect labels like `Tricolor`).
- **Weight unit conversion.** OpenRFID converts the on-chip 24-bit value to
  grams via `__convert_to_grams`. Studio Manager doesn't — it simply reads
  `weight_available`, `container_weight`, and `measure_gr || measure` as the
  Firestore doc supplies them. Whatever upstream writes the doc must perform
  the unit normalisation.
- **TD.** OpenRFID always normalises `td_raw / 10.0` to mm. Studio Manager
  passes `data.TD` through unchanged — confirm the producer scales it.
- **Bed temp.** OpenRFID hard-codes `bed_temp_c = 0.0` in
  `GenericFilament` and only logs the chip range. Studio Manager exposes
  `bedMin` and `bedMax` (`data6`, `data7`).
- **Signature.** Neither side validates ECDSA today.
- **Filled-type composition.** OpenRFID computes
  `material_type-filled_type` (e.g. `PE-CF`). Studio Manager just shows the
  raw `label` from `id_material.json` (which already contains `"PE-CF"` in
  the example), so the user-visible string usually matches. **Cross-check
  records where `label` differs from `material_type-filled_type`.**
- **Refill / recycled / filled flags.** Studio Manager reads `info1`/`info2`/
  `info3` booleans straight from the Firestore doc. OpenRFID has no
  equivalent in `processor.py` — those bits are not pulled out of any
  documented offset.
- **External links.** Studio Manager surfaces `LinkYoutube`, `LinkMSDS`,
  `LinkTDS`, `LinkROHS`, `LinkREACH`, `LinkFOOD`. None of these live in the
  chip layout — they're added server-side from the brand/SKU catalogue.
- **Twin tag.** Studio Manager reads `twin_tag_uid`. The chip layout has no
  twin field; this is a Firestore-side feature.

### Validation checklist

When the Studio Manager parses a doc that originated from a real chip read:

1. `data.id_brand`, `data.id_material`, `data.id_aspect1/2`, `data.id_type`,
   `data.id_tigertag` should all hit valid IDs in our `data/*.json` (mirrors
   of `database/*.json`).
2. `data.timestamp` is the chip-relative timestamp. Display via
   `fmtChipTs(data.timestamp)` (adds 946684800 s).
3. `data.measure_gr` should already be in grams; if you ever see exotic
   units, blame the producer pipeline, not the chip.
4. The hex returned by `toHex(color_r,g,b)` should match the lower 24 bits
   of OpenRFID's `argb_color`.

## Source files (for sync)

- `OpenRFID/src/tag/tigertag/__init__.py` — exports `TigerTagProcessor`.
- `OpenRFID/src/tag/tigertag/processor.py` — main parser (see line-by-line table above).
- `OpenRFID/src/tag/tigertag/constants.py` — all offsets, magic IDs, epoch.
- `OpenRFID/src/tag/tigertag/registry.py` — JSON loader, frozen dataclass, in-process cache.
- `OpenRFID/src/tag/tigertag/download_json.py` — refreshes `database/*.json` from `api.tigertag.io`.
- `OpenRFID/src/tag/tigertag/database/`
  - `id_version.json`     — version magic ↔ name + ECDSA P-256 PEM.
  - `id_material.json`    — material id ↔ label/material_type/filled_type/density/recommended profile.
  - `id_aspect.json`      — aspect id ↔ label + `color_count`.
  - `id_type.json`        — `142=Filament`, `173=Resin`.
  - `id_diameter.json`    — `56=1.75`, `221=2.85`.
  - `id_brand.json`       — brand id ↔ name + allowed `type_ids`.
  - `id_measure_unit.json`— unit id ↔ label + kind (`weight`/`volume`/`size`).
- Studio Manager mirror: `data/id_*.json`, `renderer/inventory.js` `normalizeRow` (≈ line 230).
