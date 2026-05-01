# Anycubic RFID — technical reference

> Reference: OpenRFID `src/tag/anycubic/` (vendored under `OpenRFID/`)
> Lineage: adapted from [DnG-Crafts/ACE-RFID](https://github.com/DnG-Crafts/ACE-RFID).

## Tag type

- **Chip family:** NXP Mifare Ultralight (plain — *not* Ultralight C / EV1 with auth).
  The processor inherits from `MifareUltralightTagProcessor`, which is a thin
  subclass of `TagProcessor` with no extra setup. There is no authentication
  step, no challenge/response, no key diversification.
- **Memory model expected by the processor:** a flat byte buffer where the
  first useful payload starts at offset `0x10`. Anycubic ACE spools use the
  user-memory pages directly; the buffer passed to `process_tag` is the raw
  read-out (header + user pages concatenated).
- **Vendor magic:** the first four bytes at `0x10..0x14` must equal
  `7B 00 65 00`. Any tag that does not match is rejected (the processor
  returns `None`, indicating "not an Anycubic tag").

## Authentication

None. The tag is read with stock Mifare Ultralight `READ` commands (16 bytes
per call, 4 pages at a time). No password, no PWD_AUTH, no signing. This
makes the tag trivially clonable and trivially writable from any
NTAG/Ultralight-compatible writer — there is no anti-counterfeit mechanism
on the wire.

## Block layout

All offsets are byte offsets into the contiguous read buffer (not page
numbers). Anycubic uses 16-byte aligned ASCII fields. Multi-byte integers
are **little-endian**.

| Offset (hex) | Length | Type | Field | Notes |
|--------------|-------:|------|-------|-------|
| `0x10` | 4 | bytes | Magic | Must equal `7B 00 65 00`. Reject otherwise. |
| `0x14` | 16 | ASCII | `sku` | NUL-padded. Right-trim `\x00`. See SKU table. |
| `0x24` | 4 | — | (gap / unused) | Not parsed. |
| `0x28` | 16 | ASCII | `brand` | NUL-padded. Always "Anycubic" on first-party spools. |
| `0x38` | 4 | — | (gap / unused) | Not parsed. |
| `0x3C` | 16 | ASCII | `filament_type` | NUL-padded. e.g. `"PLA"`, `"PLA+"`, `"PLA-High Speed"`, `"PLA-Silk"`, `"PLA-Matte"`, `"PLA-Luminous"`, `"ABS"`, `"TPU"`. Split on `-`/space. If first token ends with `+`, strip the `+` and append `"+"` as a modifier. |
| `0x4C` | 4 | — | (gap / unused) | Not parsed. |
| `0x50` | 1 | u8 | `color.A` | Alpha. |
| `0x51` | 1 | u8 | `color.B` | Blue.  Note the **on-tag order is A,B,G,R** — *not* the conventional A,R,G,B. |
| `0x52` | 1 | u8 | `color.G` | Green. |
| `0x53` | 1 | u8 | `color.R` | Red. |
| `0x54` | 12 | — | (reserved) | Not parsed. |
| `0x60` | 2 | u16 LE | `extruder_min_temp_c` | Hotend min, °C. |
| `0x62` | 2 | u16 LE | `extruder_max_temp_c` | Hotend max, °C. |
| `0x64` | 16 | — | (reserved) | Not parsed. |
| `0x74` | 2 | u16 LE | `heated_bed_min_temp_c` | Bed min, °C. |
| `0x76` | 2 | u16 LE | `heated_bed_max_temp_c` | Bed max (used as the headline bed temperature). |
| `0x78` | 2 | u16 LE | `filament_diameter_x100` | Diameter in 1/100 mm. Divide by 100. e.g. `175 → 1.75 mm`. |
| `0x7A` | 2 | u16 LE | `filament_length_m` | Filament length in metres. Used to derive net weight (see below). |

Total parsed payload window: `0x10 .. 0x7C` (108 bytes). The processor does
not read beyond `0x7C`.

### Length → weight mapping

`filament_length_m` is the canonical net-weight indicator. The processor
maps it as follows:

| Length (m) | Net weight (g) |
|-----------:|---------------:|
| 330 | 1000 |
| 247 |  750 |
| 198 |  600 |
| 165 |  500 |
|  82 |  250 |
| _other_ | 1000 (default) |

These ratios assume PLA-class density (~1.24 g/cm³) at 1.75 mm; values for
TPU/ABS happen to fall on the same buckets in Anycubic's catalogue, so the
table is applied uniformly.

## Field semantics

### `sku` (16 ASCII chars)

The SKU encodes line, sub-type, color, and a numeric variant suffix.
Observed prefix conventions:

| Prefix | Meaning |
|--------|---------|
| `HPL` | First-generation PLA, color encoded by trailing 2-digit code instead of letters. |
| `AHPL` | "Anycubic High-quality PLA" — base PLA. |
| `AHPLP` | PLA**+** (the `P` after `AHPL` marks the `+` line). |
| `AHHS` | PLA **High Speed**. |
| `AHSC` | PLA **Silk**. |
| `HFG` | PLA **Luminous** (glow-in-the-dark). |
| `HYG` | PLA **Matte**. |
| `SHAB` | **ABS**. |
| `STP` | **TPU**. |

Color codes (last 2 letters of the alphanumeric block, before the `-NNN`
variant suffix) seen in the catalogue:

| Code | Color |
|------|-------|
| `BK` | Black |
| `BW` | White (Bone White) |
| `GY` | Grey |
| `MG` | Marble Grey / metallic Grey variant |
| `CG` | Cool Grey / Charcoal |
| `DB` | Deep Blue / Dark Blue |
| `LB` | Light Blue |
| `KB` | Klein Blue |
| `BL` | Blue |
| `BE` | Blue (Luminous variant) |
| `RR` | Red |
| `RE` | Red (Matte) |
| `PO` | Pink / Pink-Orange |
| `VO` | Vivid Orange |
| `OR` | Orange |
| `VY` | Vivid Yellow |
| `YE` / `YL` | Yellow |
| `GE` | Green (Earth/Emerald) |
| `GN` | Green (Luminous) |
| `GR` | Green (Silk) |
| `GF` | Green (Forest/Glass) |
| `GG` / `GGR` | Glow Green / Grey |
| `BR` | Brown |
| `BZ` | Bronze |
| `SP` | Sparkle / Speckle |
| `SL` | Silver / Steel |
| `CL` | Coral / Clay |
| `CY` | Cyan |
| `CO` | Copper / Coffee |
| `CR` | Crimson / Cream |
| `CB` | (TPU) Clear Blue |
| `CP` | (TPU) Clear Pink |
| `MW` | (TPU) Milky White |
| `IB` `RB` `GB` | Matte multi-tone (Iris Blue, Rose Blush, Green Blush) |
| `SW` `SG` | Silk White / Silk Green |
| `GD` | Gold |
| `WH` | White (Silk) |
| `PK` | Pink (Silk) |
| `PU` | Purple (Silk) |
| `07..18` | Numeric Silk variants (newer additions, no letter code) |

Trailing `-NNN` variants (`-101`..`-107`) are catalogue/region/batch
revisions of the same color+material combination; they do not affect
material parsing — only `SKU_TO_MATERIAL` lookup distinguishes them, and
even then `(type, sub_type)` is identical across `-NNN` siblings of the
same prefix.

### `filament_type` (parsed at runtime)

Tokenization rule, applied verbatim from `processor.py`:

```text
tokens = filament_type.replace("-", " ").split(" ")
if tokens[0].endswith("+"):
    tokens[0] = tokens[0][:-1]   # strip "+"
    tokens.append("+")           # move "+" to modifier list
type      = tokens[0] or "PLA"
modifiers = tokens[1:]
```

Examples:

| Raw on-tag string | `type` | `modifiers` |
|-------------------|--------|-------------|
| `PLA` | `PLA` | `[]` |
| `PLA+` | `PLA` | `["+"]` |
| `PLA-High Speed` | `PLA` | `["High", "Speed"]` |
| `PLA-Silk` | `PLA` | `["Silk"]` |
| `PLA-Matte` | `PLA` | `["Matte"]` |
| `PLA-Luminous` | `PLA` | `["Luminous"]` |
| `ABS` | `ABS` | `[]` |
| `TPU` | `TPU` | `[]` |

### `color` (4 bytes at `0x50`)

Reconstruct ARGB as a 32-bit integer:

```js
const a = data[0x50];
const b = data[0x51];
const g = data[0x52];
const r = data[0x53];
const argb = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
```

The colors array on the resulting filament is `[argb]` (single entry — no
multi-color palettes on Anycubic ACE tags).

### Drying

`drying_temp_c` and `drying_time_hours` are **not present** on Anycubic
tags. The processor hard-codes them to `0`.

### `manufacturing_date`

Not present on Anycubic tags. Hard-coded to `"0001-01-01"` (sentinel). Do
not surface this field as a real date in UI.

### `unique_id` derivation

```
unique_id = generate_unique_id("Anycubic", sku, brand, filament_type, argb, filament_length_m)
```

i.e. the processor concatenates vendor + sku + brand + raw filament_type +
argb int + length(m). It does not include the tag's UID. Two physical tags
written with the same SKU and color produce the same `unique_id` — this is
*intentional* on the OpenRFID side (it represents a "logical filament
identity") but means **the tag UID must be tracked separately by the
caller** if you want to deduplicate physical spools.

## Crypto / signing

None. There is no HMAC, no signature block, no MAC, no rolling counter.
The `7B 00 65 00` magic is the only consistency check, and it is
trivial to forge. Treat any decoded data as **untrusted**: validate
ranges (temps in 150–300 °C, diameter near 1.75 ± 0.05 mm, length in the
table above) before acting on it.

## Read-only port — JavaScript notes

The Studio Manager only needs to *decode* tags read by hardware (no
write/clone path). A faithful JS port is straightforward:

```js
function decodeAnycubic(buf /* Uint8Array of >=0x7C bytes */) {
  // Magic check
  const magic = buf.subarray(0x10, 0x14);
  if (magic[0] !== 0x7B || magic[1] !== 0x00 ||
      magic[2] !== 0x65 || magic[3] !== 0x00) {
    return null; // not an Anycubic tag
  }

  const ascii = (off, len) => {
    let end = off + len;
    while (end > off && buf[end - 1] === 0) end--;
    return new TextDecoder("ascii").decode(buf.subarray(off, end));
  };
  const u16le = (off) => buf[off] | (buf[off + 1] << 8);

  const sku   = ascii(0x14, 16);
  const brand = ascii(0x28, 16);
  const rawType = ascii(0x3C, 16);

  // Tokenize filament type
  let tokens = rawType.replace(/-/g, " ").split(" ").filter(Boolean);
  if (tokens.length && tokens[0].endsWith("+")) {
    tokens[0] = tokens[0].slice(0, -1);
    tokens.push("+");
  }
  const type      = tokens[0] || "PLA";
  const modifiers = tokens.slice(1);

  // Color: tag layout is A,B,G,R (not A,R,G,B!)
  const a = buf[0x50], b = buf[0x51], g = buf[0x52], r = buf[0x53];
  const argb = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

  const hotendMin = u16le(0x60);
  const hotendMax = u16le(0x62);
  const bedMin    = u16le(0x74);
  const bedMax    = u16le(0x76);
  const diaMm     = u16le(0x78) / 100;
  const lengthM   = u16le(0x7A);

  const weightG = ({330:1000, 247:750, 198:600, 165:500, 82:250})[lengthM] ?? 1000;

  return {
    sku, brand, type, modifiers,
    color_argb: argb,
    diameter_mm: diaMm,
    length_m: lengthM,
    weight_g: weightG,
    hotend_min_c: hotendMin,
    hotend_max_c: hotendMax,
    bed_min_c: bedMin,
    bed_max_c: bedMax,
    drying_temp_c: 0,
    drying_time_hours: 0,
    manufacturing_date: null, // sentinel "0001-01-01" upstream
  };
}
```

Pitfalls to watch:

1. **Color byte order is A, B, G, R** on the tag, not A, R, G, B. This
   is the single most common bug when porting.
2. ASCII strings are NUL-padded, not NUL-terminated mid-buffer — strip
   trailing zeros only.
3. All multi-byte ints are **little-endian**.
4. `filament_length_m` of 0 / unknown silently defaults to 1000 g in the
   reference processor; preserve that behaviour or surface "unknown" in
   the UI — don't show 1000 g if you can't trust the value.
5. The buffer must be at least `0x7C` bytes; readers that hand back only
   the user pages without the OTP/header preamble will offset by 0x10
   bytes. Verify by checking the magic at `0x10`.

## SKU → material lookup table

`constants.py` provides one dictionary, `SKU_TO_MATERIAL`, with **283**
entries. The `processor.py` decoder does **not** consult this table — it
derives `(type, modifiers)` from the on-tag ASCII at `0x3C` directly. The
table is provided as reference data for product-catalogue UIs (e.g. to
look up a friendly name from a SKU printed on a box label, or to detect
tags that have been mislabelled).

Schema of each entry: `{ "type": <string>, "sub_type": <string> }`.
`sub_type` is one of `""`, `"+"`, `"High Speed"`, `"Silk"`, `"Matte"`,
`"Luminous"`. `type` is `"PLA"`, `"ABS"`, or `"TPU"`.

### Aggregated by family

These ranges are listed by SKU prefix; **every** `-101..-107` suffix
present in the source maps to the same `(type, sub_type)` shown in the
row. Suffixes observed in the source are listed in the "Variants" column.
If a SKU is on a tag and matches a row's prefix exactly, you can use
this mapping safely.

| SKU pattern | type | sub_type | Variants present |
|-------------|------|----------|------------------|
| `HPL16-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106, 107 |
| `HPL17-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `HPL18-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `HPL19-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLBK-NNN` | PLA | "" | 101, 103, 105, 106 |
| `AHPLBW-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLGY-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLGE-NNN` | PLA | "" | 105, 106 |
| `AHPLPO-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLDB-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLRR-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLVO-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLVY-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLSP-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLMG-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLCG-NNN` | PLA | "" | 101, 102, 103, 105, 106 |
| `AHPLGF-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLSL-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLCL-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLCY-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLLB-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLBZ-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLBR-NNN` | PLA | "" | 101, 102, 103, 104, 105, 106 |
| `AHPLKB-NNN` | PLA | "" | 102, 103, 104, 105, 106 |
| `AHHSBK-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSBW-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSGY-NNN` | PLA | High Speed | 102, 103, 104, 105, 106 |
| `AHHSVY-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSSP-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSBR-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSPO-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSVO-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSDB-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHHSCG-NNN` | PLA | High Speed | 101, 102, 103, 104, 105, 106 |
| `AHPLPBK-NNN` | PLA | + | 102, 103, 104, 105, 106 |
| `AHPLPGY-NNN` | PLA | + | 102, 103, 104, 105, 106 |
| `AHPLPBW-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPVO-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPLB-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPGF-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPSL-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPPO-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPVY-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPBR-NNN` | PLA | + | 101, 102, 103, 104, 105, 106 |
| `AHPLPDB-NNN` | PLA | + | 102, 103, 104, 105, 106 |
| `AHSCCG-101` | PLA | Silk | 101 only |
| `AHSCCR-NNN` | PLA | Silk | 101, 102 |
| `AHSCSW-101` | PLA | Silk | 101 only |
| `AHSCSG-NNN` | PLA | Silk | 101, 102 |
| `AHSCGD-102` | PLA | Silk | 102 |
| `AHSCSL-102` | PLA | Silk | 102 |
| `AHSCCO-102` | PLA | Silk | 102 |
| `AHSCWH-102` | PLA | Silk | 102 |
| `AHSCBL-102` | PLA | Silk | 102 |
| `AHSCGR-102` | PLA | Silk | 102 |
| `AHSCPK-102` | PLA | Silk | 102 |
| `AHSCPU-102` | PLA | Silk | 102 |
| `AHSCCG-102` | PLA | Silk | 102 |
| `AHSC07-102` … `AHSC18-102` | PLA | Silk | 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18 (all `-102`) |
| `HFGGR-102` | PLA | Luminous | 102 |
| `HFGBL-102` | PLA | Luminous | 102 |
| `HFGYE-102` | PLA | Luminous | 102 |
| `HFGBE-102` | PLA | Luminous | 102 |
| `HFGGN-102` | PLA | Luminous | 102 |
| `HYGBK-102` | PLA | Matte | 102 |
| `HYGWT-102` | PLA | Matte | 102 |
| `HYGGY-102` | PLA | Matte | 102 |
| `HYGRE-102` | PLA | Matte | 102 |
| `HYGYL-102` | PLA | Matte | 102 |
| `HYGBL-102` | PLA | Matte | 102 |
| `HYGOR-102` | PLA | Matte | 102 |
| `HYGSP-102` | PLA | Matte | 102 |
| `HYGIB-102` | PLA | Matte | 102 |
| `HYGRB-102` | PLA | Matte | 102 |
| `HYGGB-102` | PLA | Matte | 102 |
| `SHABBK-102` | ABS | "" | 102 |
| `SHABWH-102` | ABS | "" | 102 |
| `SHABGY-102` | ABS | "" | 102 |
| `STPBK-101` | TPU | "" | 101 |
| `STPMW-101` | TPU | "" | 101 |
| `STPGY-101` | TPU | "" | 101 |
| `STPCL-101` | TPU | "" | 101 |
| `STPCP-101` | TPU | "" | 101 |
| `STPCO-101` | TPU | "" | 101 |
| `STPCR-101` | TPU | "" | 101 |
| `STPCB-101` | TPU | "" | 101 |
| `STPCG-101` | TPU | "" | 101 |

### Programmatic lookup

For exhaustive byte-for-byte fidelity, the JS port should embed the full
`SKU_TO_MATERIAL` map verbatim. Because every `(prefix, sub_type)` row
above maps every listed variant suffix to the same `(type, sub_type)`,
the table can be compressed to a prefix-lookup of ~85 entries:

```js
// Expand at build time from the table above
const ANYCUBIC_SKU_PREFIX = {
  // PLA base
  "HPL16": { type: "PLA", sub_type: "" },
  "HPL17": { type: "PLA", sub_type: "" },
  "HPL18": { type: "PLA", sub_type: "" },
  "HPL19": { type: "PLA", sub_type: "" },
  "AHPLBK": { type: "PLA", sub_type: "" },
  "AHPLBW": { type: "PLA", sub_type: "" },
  // ... etc.
  // PLA+
  "AHPLPBK": { type: "PLA", sub_type: "+" },
  // ... etc.
  // PLA High Speed
  "AHHSBK": { type: "PLA", sub_type: "High Speed" },
  // ... etc.
  // PLA Silk / Luminous / Matte
  "AHSC":  { type: "PLA", sub_type: "Silk" },     // generic Silk catch-all
  "HFG":   { type: "PLA", sub_type: "Luminous" },
  "HYG":   { type: "PLA", sub_type: "Matte" },
  // ABS / TPU
  "SHAB":  { type: "ABS", sub_type: "" },
  "STP":   { type: "TPU", sub_type: "" },
};

function lookupAnycubicSku(sku) {
  // Try longest prefix match first (e.g. "AHPLPBK" before "AHPL")
  const prefix = sku.split("-")[0];
  for (let len = prefix.length; len >= 3; len--) {
    const hit = ANYCUBIC_SKU_PREFIX[prefix.slice(0, len)];
    if (hit) return hit;
  }
  return null;
}
```

Note that `AHPLP*` (PLA+) must be matched before `AHPL*` (PLA base) —
order longest-first, or use the explicit per-color entries from the
aggregated table.

## Source files (for sync)

- `OpenRFID/src/tag/anycubic/processor.py`
- `OpenRFID/src/tag/anycubic/constants.py`

Related (read-only context, not Anycubic-specific):

- `OpenRFID/src/tag/binary.py` — little-endian helpers used by the processor.
- `OpenRFID/src/tag/mifare_ultralight_tag_processor.py` — empty subclass marker.
- `OpenRFID/src/tag/tag_types.py` — `TagType.MifareUltralight` enum.
