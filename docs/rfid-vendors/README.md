# RFID vendor specs

Reference sheets extracted from the [OpenRFID](https://github.com/suchmememanyskill/OpenRFID) project (vendored as a Git submodule under `OpenRFID/`). Each sheet documents how to **read** a given vendor's RFID tag in enough detail to write a JavaScript port without re-reading the Python source.

> **Read-only** — these specs cover decoding only. Writing/cloning tags is intentionally out of scope.

## Vendors covered

| Vendor | Tag type | Auth | Crypto | Spec |
|---|---|---|---|---|
| 🐯 **TigerTag** | NTAG / NDEF | None | Reserved 16-byte signature slot (not verified) | [tigertag.md](./tigertag.md) |
| 🟢 **Bambu Lab** | Mifare Classic 1K | HKDF-SHA256 (UID-derived) | Salt is operator-provisioned | [bambu.md](./bambu.md) |
| 🟠 **Creality** | Mifare Classic 1K | AES-128-ECB key for sector 1 | Optional payload encryption | [creality.md](./creality.md) |
| 🔴 **Anycubic** | Mifare Ultralight | None | None — trivially clonable | [anycubic.md](./anycubic.md) |
| ⚫ **Elegoo** | Mifare Ultralight | None | Magic bytes only (`EE EE EE EE`) | [elegoo.md](./elegoo.md) |
| 🟣 **Snapmaker** | Mifare Classic 1K | HKDF per-sector (operator salt) | RSA-2048 PKCS#1 v1.5 + SHA-256 | [snapmaker.md](./snapmaker.md) |
| 🟡 **Qidi** | Mifare Classic 1K | Default key `FF×6` | None | [qidi.md](./qidi.md) |
| 🌐 **OpenSpool** | NFC Type 2 (NDEF JSON) | None | None — open standard | [openspool.md](./openspool.md) |

## How to keep this in sync with OpenRFID

The `OpenRFID/` directory is a Git submodule. To pull upstream changes:

```bash
git submodule update --remote OpenRFID
git diff OpenRFID                      # see what changed in the submodule pointer
git -C OpenRFID log --oneline -10      # see actual upstream commits
```

If a vendor parser changes upstream, regenerate that one sheet by re-reading `OpenRFID/src/tag/<vendor>/processor.py` + `constants.py` and update the corresponding `<vendor>.md` here.

## Roadmap — JS port

When porting a vendor to `renderer/lib/rfid/<vendor>.js`:

1. Read the spec sheet here
2. Implement the read path with `nfc-pcsc` (already used by the app for ACR122U)
3. Cross-check field semantics against the spec — especially endianness, BCD-as-ASCII, RGBA vs ARGB, and lookup tables
4. Never implement write/format/lock — read-only by design

The spec sheets contain ready-to-paste JavaScript reference decoders for the simpler vendors (Anycubic, Elegoo, Openspool, Qidi).
