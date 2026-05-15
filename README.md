# Tiger Studio Manager

> Desktop companion for the [TigerTag](https://tigertag.io) RFID filament-tracking ecosystem.
> Manage your spool inventory, connect your 3D printers, and keep everything in sync — across devices, across accounts, across friends.

### ⬇ [Download the latest version](https://github.com/TigerTag-Project/TigerTag-Studio-Manager/releases/latest)
> **macOS** (Intel + Apple Silicon) · **Windows** · **Linux** — no installation knowledge required.

---

[![Build & Release](https://github.com/TigerTag-Project/TigerTag-Studio-Manager/actions/workflows/build.yml/badge.svg)](https://github.com/TigerTag-Project/TigerTag-Studio-Manager/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-blue)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24-green)](https://nodejs.org/)

---

## What is it?

Tiger Studio Manager is an Electron desktop app that bridges your physical 3D-printing filament collection with the TigerTag cloud. Scan a spool's NFC chip, see its full profile (material, color, weight, print settings), update its weight on the scale, and push filament data directly to your connected printers — all in one window.

It works standalone (no reader needed), but unlocks its full potential with:
- an **ACR122U NFC reader** for automatic spool identification on scan
- a **TigerScale** ESP32 scale for live weight tracking
- one or more **3D printers** from the 5 supported brands

---

## Features

### 🗂 Inventory
- Real-time Firestore sync — table view + grid view, column sort, full-text search
- Detail side panel — color, print settings, weight slider with auto-save, container, raw JSON
- Weight tracking — slider or manual entry; instant cloud sync after update
- **TigerTag Cloud** — create fully-digital spools with no chip; promote to a real chip later, atomically
- Custom product image for DIY & Cloud spools
- Manufacturing date, twin-tag detection and manual repair
- Spool toolbox — scan color (TD1S), scan TD, link twin, remove from rack, delete

### 🖨 3D Printer integration
Live integrations for 5 brands — real-time temperatures, filament per slot, active print job, camera:

| Brand | Protocol | Status |
|---|---|---|
| **Bambu Lab** | MQTTS 8883 (TLS) + AMS | ✅ Live |
| **Creality** | WebSocket 9999 + CFS | ✅ Live |
| **Elegoo** | MQTT 1883 + Canvas | ✅ Live |
| **FlashForge** | HTTP polling 8898 + matlStation | ✅ Live |
| **Snapmaker** | Moonraker WebSocket 7125 | ✅ Live |

Each brand supports: filament edit per slot, printer discovery (mDNS + port-scan + Add by IP), camera widget.

### 📦 Storage / Racks
- Drag-and-drop rack editor — Skyline masonry layout, slot locking, auto-fill / auto-store
- Unranked panel — spools not yet assigned to a rack
- Rich hover tooltip on filled slots (color, weight bar, coordinates)

### 🤝 Friends & Sharing
- Discovery code `XXX-XXX` — share with friends for O(1) lookup
- Send / accept / refuse / block friend requests
- View a friend's inventory in read-only mode, inline in the same UI
- Public inventory toggle for frictionless sharing

### ⚖ Sensors & Devices
- **ACR122U NFC reader** — auto-opens the matching spool on scan
- **TD1S color sensor** — read filament color (HEX) and TD value via USB
- **TigerScale** — live weight over WebSocket, TARE button, filament mini-panel

### 🌍 Accounts & i18n
- Multi-account — switch between multiple TigerTag accounts
- **9 locales** — EN · FR · DE · ES · IT · PL · PT (Brasil) · PT (Portugal) · 中文
- Per-account language preference synced with Firestore
- Google sign-in via loopback OAuth (RFC 8252 + PKCE) — Touch ID / passkey native support

---

## Screenshots

> _Screenshots coming soon._

---

## Getting started

### Requirements

- **Node.js** 24+
- **npm** 10+
- A **TigerTag account** — [tigertag.io](https://tigertag.io)
- _(Optional)_ An **ACR122U** NFC reader

#### Linux only

```bash
sudo apt-get install libpcsclite-dev libusb-1.0-0-dev build-essential
```

### Install & run

```bash
git clone --recurse-submodules https://github.com/TigerTag-Project/TigerTag-Studio-Manager.git
cd TigerTag-Studio-Manager
npm install   # also runs electron-rebuild for native NFC module
npm start
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Electron](https://www.electronjs.org/) 41 |
| UI | Vanilla HTML / CSS / JavaScript (no framework, no bundler) |
| Auth & data | [Firebase](https://firebase.google.com/) (Auth + Firestore) |
| NFC reading | [nfc-pcsc](https://github.com/pokusew/nfc-pcsc) + ACR122U |
| Auto-update | [electron-updater](https://www.electron.build/auto-update) via GitHub Releases |
| Build & packaging | [electron-builder](https://www.electron.build/) |
| macOS signing | Apple Developer ID + `notarytool` (App Store Connect API Key) |
| Windows signing | Microsoft Trusted Signing (Azure) |
| CI / Releases | GitHub Actions — triggered on `v*` tag push |

---

## Building installers

Push a `v*` tag to trigger a parallel build on all three platforms and publish a GitHub Release automatically:

```bash
git tag v1.7.0
git push origin v1.7.0
```

| Platform | Command | Output | Signed |
|---|---|---|---|
| macOS (signed) | `npm run build:mac` | `.dmg` + `.zip` (x64 + arm64) | ✅ Developer ID + Notarized |
| macOS (fast, local) | `npm run build:mac:unsigned` | `.dmg` | ❌ |
| Windows | `npm run build:win` | `.exe` NSIS | ✅ Azure Trusted Signing |
| Linux | `npm run build:linux` | `.AppImage` | N/A |
| All | `npm run build:all` | All three | — |

Built artifacts go to `dist/` (git-ignored).

> `npm run build:mac` requires Apple Developer credentials in a local `.env` file (see `.env.example`). The signing + notarization pipeline is documented in `docs/code-signing.md`.

---

## i18n tooling

UI strings live in `renderer/locales/<lang>.json`. Never edit the 9 locale files by hand — use the helper instead:

```bash
# Add a new key across all 9 locales
npm run i18n:add -- myKey en="Hello" fr="Bonjour" de="Hallo" \
  es="Hola" it="Ciao" zh="你好" pt="Olá" pt-pt="Olá" pl="Cześć"

# Insert after an existing key (keeps related keys grouped)
npm run i18n:add -- myKey --after toolboxTitle en="Hello" ...

# Check consistency (also runs automatically as a pre-commit hook)
npm run i18n:check
```

The pre-commit hook blocks any commit that leaves locale files inconsistent (missing keys, type mismatches, empty strings). It is activated automatically by `npm install` via the `prepare` script.

---

## Multi-vendor RFID (planned)

The app currently reads only TigerTag chips. Per-vendor spec sheets for extending support are in `docs/rfid-vendors/`:

| Vendor | Tag type | Auth | Spec |
|---|---|---|---|
| 🐯 TigerTag | NTAG/NDEF | None | [tigertag.md](./docs/rfid-vendors/tigertag.md) |
| 🟢 Bambu Lab | Mifare Classic 1K | HKDF-SHA256 | [bambu.md](./docs/rfid-vendors/bambu.md) |
| 🟠 Creality | Mifare Classic 1K | AES-128-ECB | [creality.md](./docs/rfid-vendors/creality.md) |
| 🔴 Anycubic | Mifare Ultralight | None | [anycubic.md](./docs/rfid-vendors/anycubic.md) |
| ⚫ Elegoo | Mifare Ultralight | Magic bytes | [elegoo.md](./docs/rfid-vendors/elegoo.md) |
| 🟣 Snapmaker | Mifare Classic 1K | HKDF + RSA-2048 | [snapmaker.md](./docs/rfid-vendors/snapmaker.md) |
| 🟡 Qidi | Mifare Classic 1K | Default key | [qidi.md](./docs/rfid-vendors/qidi.md) |
| 🌐 Openspool | NFC Type 2 NDEF | None | [openspool.md](./docs/rfid-vendors/openspool.md) |

The [OpenRFID](https://github.com/suchmememanyskill/OpenRFID) project is vendored as a Git submodule under `OpenRFID/` as a read-only reference.

---

## Project structure

```
TigerTag-Studio-Manager/
├── main.js                  # Electron main process
├── preload.js               # contextBridge IPC
├── services/
│   └── tigertagDbService.js # Reference data layer (API → GitHub mirror → userData → assets)
├── renderer/
│   ├── inventory.html       # Single-page UI markup
│   ├── inventory.js         # All application logic (IIFE — see CODEMAP.md)
│   ├── CODEMAP.md           # Line-range index for inventory.js
│   ├── css/                 # Styles split into 8 themed files (00-base → 70-detail-misc)
│   ├── locales/             # i18n JSON — en fr de es it pl pt pt-pt zh
│   └── printers/            # Per-brand live integrations + PROTOCOL.md agent skills
│       ├── bambulab/
│       ├── creality/
│       ├── elegoo/
│       ├── flashforge/
│       └── snapmaker/
├── assets/
│   ├── db/tigertag/         # Bundled reference JSONs (id_brand, id_material, …)
│   ├── img/                 # App icons + printer photos
│   └── svg/                 # UI icons + TigerTag logos
├── data/
│   └── container_spool/     # Spool container catalog
├── docs/
│   └── rfid-vendors/        # Per-vendor RFID spec sheets
├── OpenRFID/                # Git submodule — upstream multi-vendor parsers (read-only)
└── .github/workflows/
    └── build.yml            # CI: parallel build + publish on tag push
```

---

## Contributing

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feat/my-feature`
3. **Make your changes** — vanilla JS, no frameworks
4. **Run**: `npm start` to test locally
5. **Open a Pull Request**

Guidelines: keep the renderer vanilla (no React/Vue), add i18n strings with `npm run i18n:add` (all 9 locales), don't commit `node_modules/` or `dist/`.

**Reporting issues** — use [GitHub Issues](https://github.com/TigerTag-Project/TigerTag-Studio-Manager/issues). Use **Settings → Debug → Report a problem** in the app to copy a self-contained diagnostic report (version, platform, last 50 errors) to paste into your issue.

---

## Changelog · Roadmap

- 📋 **[CHANGELOG.md](./CHANGELOG.md)** — full version history
- 🗺 **[ROADMAP.md](./ROADMAP.md)** — planned features, in-flight work, and backlog

---

## License

[MIT](LICENSE) — © TigerTag Project

You are free to use, modify, and distribute Tiger Studio Manager — including commercially.
The **"TigerTag"** name is a trademark of the TigerTag Project — see [TRADEMARK.md](TRADEMARK.md) for usage conditions.
All npm dependencies are permissive (MIT / ISC / BSD / Apache) — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
