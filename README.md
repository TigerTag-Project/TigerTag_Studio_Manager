# TigerTag Studio Manager

> Desktop application to manage your 3D printing filament inventory via NFC RFID tags and your TigerTag account.

### ⬇ [Download the latest version](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/releases/latest)
> Available for **macOS** · **Windows** · **Linux** — no installation knowledge required.

---

[![Build & Release](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/actions/workflows/build.yml/badge.svg)](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-blue)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24-green)](https://nodejs.org/)

---

## Features

- **Inventory management** — Real-time sync with your TigerTag inventory via Firebase/Firestore
- **Table & Grid views** — Switch between a compact table or a visual card grid
- **Column sorting** — Click any column header to sort ascending / descending
- **NFC RFID reading** — Plug in an ACR122U reader to automatically open a spool's detail panel on scan
- **Weight tracking** — Update spool weight directly from the app (slider or manual entry); inventory syncs in real time after a successful update
- **Material details** — Print temperatures, bed temps, drying settings, density, MSDS/TDS/RoHS links
- **Product type** — Type label (Filament, Resin, …) resolved from lookup tables and displayed in the detail panel
- **Manufacturing date** — Chip programming timestamp shown for standard TigerTag (hidden on TigerTag+ to protect factory dates)
- **Color display** — Smart color circles with conic-gradient (bicolor/tricolor/multi), linear rainbow, and solid color rendering; `online_color_list` takes priority for mono-color spools
- **Color editing** — Click the color circle in the detail panel to open the Set Color modal; choose between a native color picker or the TD1S sensor; save color only or color + TD value together
- **TD1S sensor integration** — Connect the TD1S sensor via USB to read filament color (HEX) and TD value; TD1S Viewer shows live sensor feed; auto-opens when sensor is detected
- **Filament identity block** — Brand, Series, Material and Name displayed above the color section in the detail panel; name falls back to aspect labels when absent
- **Image cache** — Spool images are downloaded and cached locally; works offline, falls back to color placeholder if the remote link is dead
- **Multi-account** — Add and switch between multiple TigerTag accounts; profiles are shown as vertical cards with per-account color avatars (13 presets + custom color picker)
- **Friends system** — Share a 6-character public code (`XXX-XXX`) with friends, send/accept/refuse/block friend requests, view a friend's inventory in the main interface in read-only mode, optional public inventory toggle for frictionless sharing
- **Friend inventory view** — A friend appears as a switchable pseudo-account in the avatar dropdown and profiles modal; clicking opens their inventory in the same table/grid UI with a "Read-only" banner and a quick "← My inventory" button
- **Multi-language** — EN, FR, DE, ES, IT, PL, PT (Brasil), PT (Portugal), 中文 — switch any time from the account modal
- **Auto-updater** — Receives updates automatically via GitHub Releases
- **Cross-platform** — Windows, macOS (Intel + Apple Silicon), Linux

---

## Download

**[⬇ Download the latest release](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/releases/latest)**

| Platform | File |
|---|---|
| macOS | `.dmg` |
| Windows | `.exe` |
| Linux | `.AppImage` |

---

## Screenshots

> _Screenshots coming soon._

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Electron](https://www.electronjs.org/) 41 |
| UI | Vanilla HTML / CSS / JavaScript (no framework) |
| Auth & data | [Firebase](https://firebase.google.com/) (Auth + Firestore) |
| NFC reading | [nfc-pcsc](https://github.com/pokusew/nfc-pcsc) + ACR122U reader |
| Auto-update | [electron-updater](https://www.electron.build/auto-update) |
| Build & packaging | [electron-builder](https://www.electron.build/) |
| CI / Releases | GitHub Actions |

---

## Requirements

- **Node.js** 24+
- **npm** 10+
- A **TigerTag account** — [tigertag.io](https://tigertag.io)
- _(Optional)_ An **ACR122U** NFC reader for automatic spool scanning

### Linux only

```bash
sudo apt-get install libpcsclite-dev libusb-1.0-0-dev build-essential
```

### macOS / Windows

No extra system dependencies required.

---

## Installation

```bash
git clone https://github.com/TigerTag-Project/TigerTag_Studio_Manager.git
cd TigerTag_Studio_Manager
npm install
```

> `postinstall` automatically runs `electron-rebuild` to compile the native NFC module for your platform.

---

## Running locally

```bash
npm start
```

The app launches directly into the inventory view if an account is already saved, or opens the **Sign in** modal on first launch. Credentials are stored locally in `localStorage` and authenticated through Firebase.

---

## Building installers

| Platform | Command | Output |
|---|---|---|
| macOS | `npm run build:mac` | `.dmg` (x64 + arm64) |
| Windows | `npm run build:win` | `.exe` NSIS installer |
| Linux | `npm run build:linux` | `.AppImage` |
| All | `npm run build:all` | All three |

Built installers are placed in the `dist/` folder (ignored by git).

---

## Releases via GitHub Actions

Pushing a version tag automatically triggers a build on all three platforms and publishes a GitHub Release with the installers attached.

```bash
git tag v1.3.2
git push origin v1.3.2
```

The workflow file is at [`.github/workflows/build.yml`](.github/workflows/build.yml).

---

## Project Structure

```
TigerTag_Studio_Manager/
├── main.js                  # Electron main process (window, NFC, image cache, auto-updater)
├── preload.js               # IPC bridge (contextBridge)
├── renderer/
│   ├── inventory.html       # Single-page UI (markup + modals, no inline JS)
│   ├── inventory.css        # All app styles
│   ├── inventory.js         # All application logic (IIFE)
│   ├── firebase.js          # Firebase SDK initialisation
│   ├── lib/firebase/        # Bundled Firebase compat SDKs (app, auth, firestore)
│   └── locales/             # i18n JSON files (en, fr, de, es, it, pl, zh, pt, pt-pt)
├── data/                    # Local JSON lookup tables (brands, materials, types, aspects…)
├── assets/
│   ├── img/                 # App icons + spool container images
│   └── svg/
│       ├── icons/           # UI icon SVGs (23 icons)
│       └── logos/           # TigerTag logo SVGs (normal + contouring variant)
├── .github/
│   └── workflows/
│       └── build.yml        # CI: build + publish on tag push
└── package.json
```

---

## UI overview

### Sidebar

The left sidebar is always visible and shows the active account as soon as the app loads (from `localStorage`, before any Firestore call). It contains:

- **Avatar** — initials with a gradient color (13 presets or custom hex picker); clicking opens a contextual dropdown with connected accounts, "Manage profiles", a "Friends" section with per-friend avatars, and a quick "+ Add a friend" button
- **Stats** — active spools, TigerTag+ count, TigerTag count, total available weight
- **Refresh button** — reloads the full inventory; the icon spins during loading
- **Friends button** — opens the Friends panel
- **Community links** — GitHub, Discord, mobile app QR code
- **Export button** — opens the data/export panel

### Account dropdown (avatar click)

A compact contextual menu opens when the avatar is clicked, organised top-to-bottom:

1. **Connected accounts** — every signed-in account with active checkmark; click to switch
2. **Manage profiles** — opens the profiles modal
3. **My friends** — every friend with their real avatar color and an eye icon; click to view their inventory in read-only mode
4. **+ Add a friend** — opens the Add friend modal

### Profiles modal ("Manage profiles")

Lists all saved accounts as vertical cards (avatar + name + email + chevron). A "My friends" section under the accounts list shows every friend with the same card style; clicking a friend card opens their inventory in friend-view mode. A "+ Add a friend" button is always visible at the bottom.

### Edit account modal

- **Avatar + name/email** displayed side by side (compact horizontal layout)
- **Color picker** — 13 gradient presets + a custom hex color input; the avatar gradient updates live
- **Language selector** — changes the UI language instantly
- **Display name** — user's chosen pseudo, synced with Firestore
- **Disconnect** — requires a 1.5-second press-and-hold (animated fill progress) to prevent accidental disconnection

### Sign in modal

- Email / password sign-in with a "Forgot password?" link
- Google sign-in (one click)
- Account creation (email + password)
- "Stay signed in" checkbox

### Inventory

- **Table view** and **Grid view** — toggled from the toolbar
- **Search** — filters by material, brand, color name, UID
- **Show / hide deleted** toggle
- **Detail panel** (right slide-in) — opens on row/card click, shows:
  - Product image or color placeholder
  - **Identity block** — Brand · Series on line 1, Material + Name (or aspect fallback) on line 2
  - Color circle (clickable) + aspect / badge chips on the same flex-wrap row
  - Twin RFID badge shown as overlay on the thumbnail (table & grid)
  - Weight section (slider + manual input) with real-time Firestore sync
  - Container card — brand, label, image, type, weight; edit button appears on hover
  - Print settings (nozzle, bed, dry temp/time, density)
  - **Video player** — YouTube links open as a clickable thumbnail; direct MP4/WebM plays inline
  - Documents & links with PDF icon (MSDS, TDS, RoHS, REACH, food-safe)
  - Details rows: UID, Type, Series, Brand, Material, Diameter, Tag type, SKU, Barcode, Container, Twin tag, Updated, Manufactured
  - Raw JSON viewer with copy button

---

## Image cache

Spool images (TigerTag+ only) are fetched from `cdn.tigertag.io` on first load and stored locally in `userData/img_cache/`. The cache key is an MD5 hash of the image URL.

| Situation | Behaviour |
|---|---|
| Image available online | Downloaded, cached, displayed |
| Dead link — cache exists | Cached version displayed |
| Dead link — no cache | Color placeholder shown |
| No network — cache exists | Cached version displayed |
| No network — no cache | Color placeholder shown |

---

## Multi-account

Multiple TigerTag accounts can be added and switched between at any time:

- **Add account** — click the avatar in the sidebar (or the `+` button in the profiles modal) and sign in with your email/password or Google account
- **Switch account** — open the profiles modal, click any account card; the inventory, language, and avatar switch instantly
- **Edit account** — color avatar (13 gradient presets or custom hex), language preference, display name
- **Disconnect** — requires a 1.5-second press-and-hold on the disconnect button to prevent accidental removal; the account and its cached inventory are removed from the device
- **Per-account language** — each account remembers its own UI language; switching accounts automatically restores the correct language
- **Independent cache** — each account's inventory is cached separately under `tigertag.inv.<id>` in `localStorage`

---

## Friends & Sharing

The Friends system lets you share your inventory with other TigerTag users without exposing it publicly.

### Discovery code (public key)

Each user has a short 6-character code in the form `XXX-XXX` (e.g. `4X7-K3M`). This is your discovery handle — share it with someone and they can add you as a friend by typing it into the **Add a friend** modal.

- The code is auto-generated on first opening of the Friends panel
- It can be regenerated at any time (the previous one stops working)
- Stored in a dedicated `publicKeys/{key}` collection for O(1) uniqueness lookup

### Friend requests workflow

1. **Send** — type a friend's `XXX-XXX` code; the modal previews the user (avatar + name) before sending
2. **Receive** — when someone sends you a request, an incoming-request modal appears with **Accept**, **Refuse** and **Block** buttons
3. **Accept** — both sides become friends bidirectionally in a single Firestore batch
4. **Refuse / Block** — request is removed; blocked users can't re-send

### Viewing a friend's inventory

When you accept a friend, they appear in:
- The **avatar dropdown** under "My friends" with their real profile color
- The **profiles modal** under "My friends"
- The **Friends panel** with full-card layout

Clicking a friend loads their inventory into the same main table/grid UI as your own — same search, same sorting, same filters — but in **read-only mode** (no weight slider, no TD edit, no container change). A banner at the top shows their avatar + name + a "← My inventory" button to return to your own.

### Public mode

A toggle in the Friends panel lets you mark your inventory as **public** — anyone signed in can view it without sending a friend request. Useful for makers who showcase their stash on Discord or YouTube.

### Profile sync

Display name and avatar color are read live from `userProfiles/{uid}` every time the friends list loads — if a friend renames themselves or changes their color, you see the update on next refresh, without needing to re-add them.

### Architecture notes

- `userProfiles/{uid}` — public, readable by any authenticated user; contains `displayName`, `publicKey`, `isPublic`, `color` (hex string)
- `users/{uid}/friends/{friendUid}` — private, owned by the user; presence alone grants inventory read access (no key check — Firestore rules verify only the friendship existence)
- `users/{uid}/friendRequests/{requesterUid}` — private incoming requests
- `users/{uid}/blacklist/{blockedUid}` — private block list
- The `friends/{friendId}` document can only be created by the friend if a valid `friendRequest` from the owner exists, preventing self-injection

---

## i18n — supported languages

| Code | Language | File |
|---|---|---|
| `en` | English | `locales/en.json` |
| `fr` | Français | `locales/fr.json` |
| `de` | Deutsch | `locales/de.json` |
| `es` | Español | `locales/es.json` |
| `it` | Italiano | `locales/it.json` |
| `pl` | Polski | `locales/pl.json` |
| `pt` | Português (Brasil) | `locales/pt.json` |
| `pt-pt` | Português (Portugal) | `locales/pt-pt.json` |
| `zh` | 中文 | `locales/zh.json` |

### Adding a language

UI strings live in `renderer/locales/<lang>.json`. To add a new language:

1. Copy `renderer/locales/en.json` to `renderer/locales/<lang>.json`
2. Translate all values (keys must stay identical)
3. Add `"<lang>"` to the `loadLocales()` array in `renderer/inventory.js`
4. Add an `<option>` in the `#langSelect` dropdown in `renderer/inventory.html`

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a branch** for your feature or fix: `git checkout -b feat/my-feature`
3. **Make your changes** — keep the code style consistent (vanilla JS, no frameworks)
4. **Test locally** with `npm start`
5. **Open a Pull Request** with a clear description of what you changed and why

### Guidelines

- Keep the UI vanilla (no React, Vue, etc.) — the goal is zero build step for the renderer
- New i18n strings must be added to **all 9 locale files** in `renderer/locales/`
- Don't commit `node_modules/`, `dist/`, or any credentials
- One feature / fix per PR

### Reporting issues

Please use [GitHub Issues](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/issues) to report bugs or suggest features. Include your OS, Node.js version, and steps to reproduce.

---

## License

[MIT](LICENSE) — © TigerTag Project

You are free to use, modify, and distribute this software. See the [LICENSE](LICENSE) file for details.
