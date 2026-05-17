# Tiger Studio Manager — Roadmap

A single, opinionated map of what's done, what's coming, and what's parked.

- **Source of truth** for "what's next" — keep it in sync when picking up or finishing items.
- **Per-version detail** lives in [`README.md` → Changelog](./README.md#changelog). This file groups by domain instead of by date.
- **Handoff docs** for in-progress topics live in `docs/<topic>/NEXT_STEPS.md` (e.g. [`docs/rfid-vendors/NEXT_STEPS.md`](docs/rfid-vendors/NEXT_STEPS.md) for the multi-vendor RFID port).

Sizes: **S** = a few hours · **M** = a day · **L** = several days · **XL** = a week+

---

## ✅ Done

Grouped by domain. Versions in parentheses are the release that landed the feature; the changelog has the detail.

### Inventory & spools
- ✅ Real-time Firestore sync of inventory · table + grid views · column sort · search filter (v1.0+)
- ✅ Spool detail side panel — color block, print settings, weight slider with debounced auto-save, links, container, raw JSON (v1.0+)
- ✅ NFC RFID reading via ACR122U (`nfc-pcsc`) — auto-opens the matching spool (v1.0+)
- ✅ Manufacturing date (TigerTag standard only) · TD1S sensor for color + TD value · color editing modal (v1.3+)
- ✅ **Twin-pair auto-link** by timestamp (factory programmer < 2 s window) (v1.4.x)
- ✅ **Twin-pair manual repair** — picker filtered by brand/material/type/RGB (v1.4.8)
- ✅ **Spool toolbox** in detail panel — Scan colour / Scan TD / Twin link / Remove from rack / Delete (v1.4.8)
- ✅ **Image cache** for spool photos — local persistence, color-fallback if remote dies
- ✅ **Add Product side panel** — full TigerTag creator iso to the mobile app: Brand / Material picker bottom-sheets with favourites pinned and persisted, mobile-style HSV colour picker (preset grid + custom 2D SV rectangle + rainbow hue slider), advanced mode revealing Type / Diameter / Aspect 1+2 / temps / TD / weight unit, live RFID Data preview (debug only), 28-byte UTF-8 cap on the colour-name field, integer-only fields with live clamp (v1.4.11 + v1.4.12)
- ✅ **TigerTag Cloud — 100 % digital filaments** — Add Product writes a doc with id `CLOUD_<10-digit>` and the new "TigerTag Cloud" tier badge (purple) when there's no physical chip yet. Promoted in place to a real 7-byte hex UID via the existing `uidMigrationMap` rename pipeline the moment the user programs a chip — every field, twin pointer, rack assignment and friend ACL follows the doc through the rename. Atomic, idempotent. Mobile companion ships the same label in the inventory bottom-sheet header AND the search index (v1.4.12)
- ✅ **Custom product image** (`url_img` + `url_img_user: true`) — DIY and TigerTag Cloud spools can carry a product image from any external URL. Edit trigger in the colour square (or toolbox when an image is already set); also available in the Add Product advanced section. Broken URLs fall back to the colour placeholder; `isPlus` stays false so the spool keeps its DIY/Cloud identity. TigerTag+ images (from catalogue) are read-only. (v1.4.13)
- ✅ **Toolbox — Clear TD split-button** — hold-to-confirm trash button (1 200 ms) on the "Scan TD" toolbox row, visible only when `r.td != null`. Deletes the `TD` field via `FieldValue.delete()`. Row hidden entirely when no TD is set. (v1.4.13)
- ✅ **TigerTag Cloud stat tile** — purple tile in the inventory header always showing the count of `CLOUD_` spools; DIY count now correctly excludes Cloud entries. (v1.4.13)

### Multi-account & auth
- ✅ Firebase auth with **per-account `firebase.app(uid)` instances** (independent sessions) (v1.4+)
- ✅ Login / Create / Forgot-password modal (Firebase) · Google sign-in via popup (v1.4+)
- ✅ Profiles modal · color avatars (13 presets + custom hex) · pseudo (`displayName`) flow
- ✅ **Migration from API-key accounts** to Firebase (auto-wipe of legacy entries on first launch)
- ✅ **UID format migration** — decimal big-endian → hex uppercase (with consent modal + lock-screen sweep) (v1.4.x)
- ✅ **Rack-shape migration** — flat fields → nested `rack` object (consent + progress UI) (v1.4.x)
- ✅ **Display-name setup modal** on first launch when pseudo is missing
- ✅ Debug mode toggle (admin-only via `users/{uid}.roles == "admin"`) — exposes Firestore explorer + API tab

### Friends & sharing
- ✅ **Discovery code `XXX-XXX`** (`publicKey`) — atomic claim with 10-retry transaction (v1.4+)
- ✅ **Access token** (`privateKey`, 40-char hex) used by Firestore rules to authorise friend reads
- ✅ **Bidirectional friendship** — accept writes both `friends/{uid}` docs in a single batch
- ✅ **Friend inventory view** in main interface — read-only banner, swap-back, defense-in-depth against owner-data bleed-through (v1.4.x)
- ✅ **Sidebar friends quick-list** with per-friend avatar colors + click-to-open
- ✅ Friend request modal (accept / refuse / **block**) · blacklist render
- ✅ **`isPublic` flag** in user doc (frictionless friend discovery) — *flag persists, public discovery page itself is in 🌱 backlog*

### Storage / racks
- ✅ **Rack create/edit modal** — presets + name + grid + total-slots label (v1.4+)
- ✅ **Drag-and-drop** between slots, slots ↔ unranked panel, rack head reordering (v1.4+)
- ✅ **Skyline-packing masonry** layout for rack cards
- ✅ **Slot locking** (right-click) · **Auto-fill / Auto-store / Auto-unstorage**
- ✅ **Rich hover tooltip** for filled slots (mini puck preview)
- ✅ **Drop-to-void unassign** — drop outside any rack card, cascade-out animation (v1.4.8)
- ✅ **Empty-spool handling** — visible in unranked, excluded from counts (v1.4.8)
- ✅ Press-and-hold (1.2 s) for destructive rack ops (Clear all / Delete) (v1.4+)

### Data layer
- ✅ **`tigertagDbService` — unified reference data layer** — single IPC service for all TigerTag lookup tables (brands, materials, aspects, types, diameters, units, versions). Renderer loads via `window.electronAPI.db.getLookups()`; no direct `fetch()` to JSON files. API → GitHub mirror (≤6 h stale) → `userData/db/tigertag/` → `assets/db/tigertag/` fallback chain. Atomic writes with JSON validation before overwrite. First-launch metadata seeding from `assets/db/tigertag/last_update.json`. (v1.7.0)

### 3D printer integration
- ✅ **Per-brand subcollections** under `users/{uid}/printers/{brand}/devices/{id}`
- ✅ **5 brands wired** in the brand picker: Bambu Lab · Creality · Elegoo · FlashForge · Snapmaker
- ✅ **Per-brand model picker** with thumbnails (`data/printers/<brand>_printer_models.json`)
- ✅ Printer side panel · drag-drop reorder · inline edit · online/offline indicator (HTTP ping) (v1.4.7)
- ✅ **Snapmaker Live integration** (Moonraker WebSocket) — live temperatures, filament per slot, print job card with thumbnail + progress + state + layer counter (v1.4.7)
- ✅ **Camera banner architecture** — per-brand `widget_camera.js` widgets; `inventory.js` calls `renderCamBanner(p)` dispatch only, never builds camera HTML inline
  - ✅ **Snapmaker** — iframe Crowsnest WebRTC player (port 80 `/webcam/webrtc`)
  - ✅ **FlashForge** — MJPEG `<img>` with single-stream error overlay + Retry (port 8898)
  - ✅ **Creality** — direct `RTCPeerConnection` + `<video>` (port 8000); probed on real Ender-3 V4 hardware; CSS in `55-creality.css`
- ✅ **Snapmaker LAN discovery** — mDNS browse + parallel port-scan + per-source batch sizing + brand-confirm filter + one-click add (v1.4.8)
- ✅ **Add by IP** collapsible widget — live IPv4 validation + Validate probe (v1.4.8)
- ✅ **Manual filament edit bottom-sheet** — Filament + Color sub-pickers (v1.4.8)
- ✅ **Read-only filament sheet** for RFID-locked extruders — same layout, native `disabled` controls (v1.4.8)
- ✅ **Settings reconnect** — saving an IP change tears down + reconnects WebSocket (v1.4.8)
- ✅ **FlashForge live integration** — HTTP polling port 8898, MJPEG camera, 5-slot matlStation grid (`Ext.` + `1A`–`1D`), click-to-edit per slot via HTTP API (v1.4.x)
- ✅ **Creality live integration** — WebSocket port 9999, heartbeat, live temps, CFS colour grid, WebRTC camera (v1.4.15)
- ✅ **Elegoo live integration** — MQTT port 1883, UDP discovery port 52700; job card, temp card, mono + 4-slot Canvas filament card, control card (XY circle jog pad + Z pill + X/Y home pill + fans + LED + files button), filament edit sheet (colour + material + vendor pickers), Files/History sheet, camera; surgical DOM patch on control card to eliminate MQTT-tick flash (v1.6.0)
- ✅ **Bambu Lab live integration** — MQTTS port 8883 TLS, LAN mode; job card, temp card, AMS filament grid (Ext. + module rows), camera widget, online badge (v1.6.0); filament edit bottom-sheet redesigned ISO with Snapmaker/Elegoo/FlashForge (2 rows, auto-close on color pick, "Edit filament" title) (v1.7.0)
- ✅ **Printer grid & table — live status pills** — every connected printer shows its live state directly in the grid card and table row without opening the sidecard. ISO visual style: same `snap-job-state` pill classes as the sidecard (spinner on printing, colour-coded per state). Progress bar + `XX% · Nh Nm` for active jobs; filename truncated below the bar. Online badge in cards now matches the sidecard pill (coloured background + border). (v1.7.1)
- ✅ **Grid Online/Offline partition — fixed for all brands** — `ctx.onPrinterGridChange` referenced an out-of-scope variable (`_printerSub`) causing a silent ES-module `ReferenceError` that swallowed every re-partition call. Also fixed: shared RAF coalescing flag across `statusChanged=true/false` paths blocked the grid re-partition on fast LANs. Both fixed in all 4 brand drivers. (v1.7.1)
- ✅ **Cam wall card → click → sidecard** — clicking a camera wall card opens the sidecard for that printer; CSS hover feedback on `.cam-wall-card`. (v1.7.1)
- ✅ **FlashForge MJPEG multiplexer** (`cam_mux.js`) — single `fetch()` stream shared across cam wall tile + sidecard simultaneously, respecting FlashForge's 1-client limit. Auto-stops when the last consumer unregisters. (v1.7.1)
- ✅ **Creality camera persistence** — `_activeIp` guard prevents WebRTC restart on WS reconnect; `#creCamContainer` persists in DOM with CSS visibility toggle. (v1.7.1)

### Sensors & devices
- ✅ **ACR122U NFC reader** (USB) via `nfc-pcsc` — `main.js` ↔ renderer IPC bridge
- ✅ **TD1S sensor** integration — TD + color reading, auto-detect on USB plug, log panel
- ✅ **TigerScale heartbeat** — `users/{uid}/scales/{mac}` with 90s online threshold, scale panel render
- ✅ **TigerScale live WebSocket panel** — connect/disconnect toggle, WS event log, gradient live card matching mobile app, send-status badge, filament mini-panel (WS-driven: brand/material/color from firmware), 56 px weight display, UID reader 2-col grid with `resolve()` twin logic (vert = cloud, blanc = physique), TARE hold-to-confirm 1 s → POST `/api/tare`, card + button hidden on disconnect. (v1.5.0)
- ✅ **TD1S button in Add Product panel** — icon in the ADP header: disconnected → opens connect modal; connected → glows green and auto-fills colour HEX + TD value fields on scan. State syncs on every `onStatus` event and `openAddProductPanel()` call. (v1.4.13)

### Distribution & i18n
- ✅ **9 locales** — en · fr · de · es · it · zh · pt (Brasil) · pt-pt · pl
- ✅ **Plural inflection** for all duration keys (`{one, other}` everywhere) (v1.4.9)
- ✅ **Auto-updater** via GitHub Releases (electron-builder)
- ✅ **macOS code signing + notarization** (App Store Connect API Key path)
- ✅ **Windows code signing** via Microsoft Trusted Signing (Azure)
- ✅ **Cross-platform builds** — macOS (x64 + arm64), Windows (NSIS), Linux (AppImage)
- ✅ **Diagnostic report** — last 50 errors + env in a copyable Markdown blob
- ✅ **Dark window chrome** — `nativeTheme.themeSource = 'dark'` forces the native macOS/Windows title bar to dark mode (dark background, white text). `hasShadow: false` removes the OS-level drop shadow along the window edges. (v1.4.13)
- ✅ **Update status icon** — icon to the right of the cloud health indicator: orange spinning refresh while downloading, green glowing dot when ready to install. Tooltip via the existing `.health[data-tooltip]` system. Click when ready → `installUpdate()`. (v1.4.13)

### Dev tooling
- ✅ **`npm run i18n:add`** — one command updates all 9 locales (v1.4.9)
- ✅ **`npm run i18n:check`** + **pre-commit hook** (.githooks/) — blocks commits on locale drift (v1.4.9)
- ✅ **CSS modularization** — split 8047-line `inventory.css` into 8 themed files under `renderer/css/` (v1.4.9)
- ✅ **`renderer/CODEMAP.md`** — feature → line range index for the 12k-line `inventory.js` (post-v1.4.9)
- ✅ **Panel shadow bleed fix** — `detail-panel`, `sfe-sheet` (Snapmaker filament edit) and `rp-side` (rack side panel) were leaking `box-shadow` into the viewport when translated off-screen. Shadow now applied only on `.open` / `.is-open`; transitions include `box-shadow .25s`. (v1.4.13)

---

## 🚧 Next up — concrete work

Items where the spec is written and we know roughly how to do it. Ranked by ratio (impact / effort × risk).

> ### 🐿️🐿️ Sprint mode — days, not months
>
> The 3 top-tier items below (POD + Multi-brand live + Printer control panel) total ~**XXL on paper for a single developer over months**. We don't have months; we have **a few days**, working as a duo (Tic & Tac).
>
> **What this changes**:
> - **Pair on every non-trivial sub-feature**. Pair-programming roughly doubles single-developer speed on tricky parts and catches subtle bugs immediately (much cheaper than fixing them post-merge). Trivial stuff (rename, mechanical refactor) one of us takes solo while the other moves the next ticket forward.
> - **Maximize reuse, minimize new code**. Every sub-feature has a `♻️ Reuses` section — read it FIRST. The estimate sizes already assume aggressive reuse; if a path looks like "this is going to be 2k lines from scratch", **stop and find what to reuse instead**.
> - **MVP first, scope expansion later**. Each sub-feature has a `🐿️ Sprint scope` line: the minimum that ships in a single day session vs. the full version. Ship the MVP, mark the rest as Phase 2 in the same entry, **don't let perfect block good**.
> - **Debug interfaces matter from day 1**. Every new code path gets a debug surface (raw log, force-X toggle, inspector) — see the `🐛 Debug surface` block in each entry. We've been bitten enough by silent failures (the i18n-check hook found 24 silent ones in v1.4.9 alone) to know that debug-from-day-1 is cheaper than debug-when-things-break.
> - **Ship daily**. Even partial work merges to `main` daily (gated behind a feature flag if not user-facing yet). Long-lived branches kill velocity at this pace.
>
> **Prioritisation in days-not-months mode**:
> - Day 1: highest-reuse / lowest-risk items (POD A, F1 driver extraction, G1 print job control)
> - Day 2-3: dependents of day 1 (POD B/E, F2 Creality driver, G2/G3/G4 control)
> - Day 4-5: bigger lifts that benefit from day 1-3 foundations (POD C/D, F3 Bambu, G5 files)
> - Beyond: F4 FlashForge, F5 Elegoo (gated), G6 advanced
>
> Effort sizes (S/M/L/XL) below are still based on single-developer convention so they stay comparable to historical estimates — **mentally divide by ~1.7×** for pair-work output.
>
> #### 🗓️ Day-by-day Tic-and-Tac plan (illustrative — adjust as we ship)
>
> Items chosen for ratio (existing-code reuse × user value × low risk). Cross-references point to sub-feature IDs in the entries below.
>
> | Day | What lands | Why this slot |
> |---|---|---|
> | **D1** AM | **POD A** (multi-reader IPC) | ~30 min of edits across 3 files; unblocks B/C/D/E |
> | **D1** AM | **F1** (extract `drivers/snapmaker.js`) | Pure refactor of L5557-7216 + L8030-8226. Pair on it — one reads, one moves blocks. CODEMAP gets a fresh entry. |
> | **D1** PM | **G1** (print job control: pause/resume/cancel/cooldown/E-stop) | `snapSendGcode` already exists, `setupHoldToConfirm` already exists — pure UI assembly + 5 IPC wrappers. Big user value. |
> | **D1** PM | **POD E (UX half)** — diff modal for chip-pending changes | ~80% of UX already shipped (`needUpdateAt`, banner, badges, i18n, twin-aware batch clear). Stub the chip-write call, ship the diff modal. |
> | **D2** AM | **POD B** (scan → inventory + twin auto-detect) | Requires the TigerTag JS parser at `renderer/lib/rfid/tigertag.js`. Spec is 386 lines so the parser writes itself. Plug into `normalizeRow` shape. |
> | **D2** AM | **F2** (`drivers/creality.js`) | Built **in parallel** with snapmaker.js — Rule of Three. Test on real Creality K-series hardware if available; otherwise stub the deltas + ship as opt-in. |
> | **D2** PM | **G3** (temp & filament) | The Snapmaker bottom-sheet already does the temp-and-load dance — extract the helper, wire it to per-printer config + material lookup table chips. |
> | **D2** PM | **G2** (homing + jog) | All `snapSendGcode` wrappers + 4-direction pad UI. Mid-print lockout reads existing `printer.status`. |
> | **D3** AM | **POD C** (write fresh chip) | New `nfc:write-pages` IPC handler + wizard UI. Spec has the byte layout — translation is mechanical. **Pair on this one** — it's irreversible and benefits from 4-eye review. |
> | **D3** AM | **POD D** (recycle to NDEF) | Reuses C's `nfc:write-pages` + new NDEF builder. Independent of which sub-feature ships first; pick based on which printer you have on hand. |
> | **D3** PM | **G4** (live tuning sliders) | S-effort, fast win. Reuses the weight-slider debounce pattern. |
> | **D3** PM | **F6** (brand picker UX cleanup) | Required so Creality (and future brands) become clickable with the right per-brand forms. |
> | **D4** AM | **POD E (write half)** — wire actual chip-write into the diff modal | Now that POD C exists, plug its write helper in behind the modal's "Apply" button. |
> | **D4** all | **F3** (Bambu MQTT driver) | Biggest single-day item. Pair work strongly recommended — one drives MQTT lib + protocol, the other adapts the live block UI to Bambu's status shape. |
> | **D5** AM | **G5** (file browser + custom G-code console) | Reuses thumbnail pipeline (`snapBestThumb` etc.) + drag-drop pattern from racks. |
> | **D5** PM | **F2b** (`klipper-generic.js` + planned extraction of `_moonraker-base.js`) | With three Klipper-class implementations now shipped, the empirical common surface is clear — refactor with confidence. |
> | **D6+** | F4 FlashForge, G6 advanced, F5 Elegoo (research-gated) | Long-tail items, ship as reach permits. |
>
> **Stretch goals if any day finishes early**: README screenshots (🎖️), Firestore Security Rules for `roles`/`Debug` (🏅, S-effort), pre-commit hook extensions (🏅).
>
> **Re-plan checkpoints**: end of D2 and end of D4. Move items between days based on what's actually shipping vs blocking.

### 🥇 TigerTag POD — dual-reader scan / write / recycle workstation

The TigerTag POD is a desktop hardware unit with **two ACR122U USB NFC readers**. It turns the desktop app into a one-stop tool for the full chip lifecycle — read into inventory, write fresh chips, repurpose chips that are no longer needed.

Today, only **one** reader is supported (single-card detail-panel-open flow). The POD use case requires a richer model: identify which slot fired, treat both slots as a coordinated workstation, and add **surgical page-level write** capability (never erase-and-rewrite — see *Cross-cutting: surgical page-level writes* below).

#### 🔧 Sub-feature A — Multi-reader detection  ·  **Effort: S**  ·  **Risk: low**
The IPC payload from `main.js` doesn't carry a stable reader id, so when 2 readers are connected the renderer overwrites slot 1 with slot 2 on every `reader-status` message. Fix: include `reader.name` (or a hashed `slotId`) in every IPC payload, and the renderer keeps a `Map<slotId, status>` instead of one global state.

♻️ **Reuses (mostly already done)**:
- `main.js` L154-200 (`initNFC()`) — `nfc.on('reader', …)` already fires per reader, just need to add `reader.name` to the IPC payload (~5 lines).
- `preload.js` L20-24 — `onReaderStatus` / `onRfid` callbacks already in place; payload just gets one extra field.
- `inventory.js` L12214-12266 — Renderer-side handler already wired; needs to switch from "single global status" to "Map keyed by slot id" (~30 lines).

**UI**: dual-status pill in the header (`POD slot 1 ✓ · POD slot 2 ✓`) replacing the single `#rfidStatus`.
**Persistence**: assign each reader a stable role (`primary` / `secondary`) on first plug-in, persist in `localStorage` keyed by the reader name so the same physical reader keeps the same slot across launches.

#### 🔧 Sub-feature B — Spool scan workflow → inventory  ·  **Effort: M**  ·  **Risk: low**
**Trigger**: chip detected on either slot. If a matching `state.rows` entry exists → open detail panel (current behaviour, kept).

**New**: if the UID is unknown (not yet in Firestore inventory), open a **new "Add spool from scan" sheet** prefilled with the parsed TigerTag fields (TAG_ID, PRODUCT_ID, MATERIAL_ID, ASPECT, TYPE, DIAMETER, color RGB, …). One-click "Add to inventory" writes to `users/{uid}/inventory/{spoolId}`.

**Twin auto-detect**: if a chip is detected on slot 2 within ≤ 5 s of a chip on slot 1, AND both share the same `id_brand` + `id_material` + `id_type` + RGB, propose a "These are twins → link?" inline confirmation.

♻️ **Reuses (substantial — most of the parsing + matching logic exists)**:
- `inventory.js` L503-576 — `normalizeRow(spoolId, data)` already maps the parser output to the renderer's row shape. Reusable verbatim.
- `inventory.js` L2410-2558 — `findTwinCandidates()` (filter compatible spools by brand/material/type/RGB) + `linkTwinPair()` (atomic batch write of `twin_tag_uid` cross-references). The 5s-window detection is new logic, but the linking step is a 1-line call.
- `inventory.js` L8241-8633 — `snapAddDiscoveredPrinter()` is the architectural twin of "Add spool from scan" — same one-click write-to-Firestore-and-open-detail pattern. Copy as a starting template.
- [`docs/rfid-vendors/tigertag.md`](docs/rfid-vendors/tigertag.md) — full byte-layout spec (offsets, field types, lookup tables). Need to write the actual byte parser (no `renderer/lib/rfid/tigertag.js` exists yet — `normalizeRow` works on Firestore docs, not raw bytes).
- The TigerTag spec sheet contains pseudo-code transcribed verbatim from the Python OpenRFID reference — most of the JS port is mechanical translation.

#### 🔧 Sub-feature C — Write fresh TigerTag chip  ·  **Effort: M**  ·  **Risk: low-medium**
**Goal**: blank NTAG → fully-formatted TigerTag chip with brand/material/color/RGB metadata, ready to be put on a new spool.

**`nfc-pcsc` API**: supports `reader.write(blockNumber, buffer)` and `reader.transmit(cmd, responseLen)` — raw APDU available. Need a new `ipcMain.handle('nfc:write-pages', …)` channel in main.js that runs the read-diff-write-verify loop (see *Cross-cutting: surgical page-level writes*).

**UI**: a new "Create chip" wizard in the spool detail panel (visible only when the POD is detected and a blank chip is on slot 2). Steps: pick brand/material/type/diameter → pick color (TD1S sensor, color picker, or copy from another chip) → confirm → write all 4-byte chunks per [tigertag.md](docs/rfid-vendors/tigertag.md). Show a per-page progress bar.

**Signature** *(non-issue by design)*:
- **TigerTag (basic)** chips are unsigned — write freely.
- **TigerTag+ (premium)** chips carry a factory ECDSA signature computed only over **pages 4 & 5** of the chip — the `TAG_ID` + `PRODUCT_ID` immutable identity. Every other field (`MATERIAL_ID` onwards, color, TD, aspect, etc.) is on later pages and is **freely rewritable without invalidating the signature**. The signature stays valid because we never touch pages 4-5.
- **Implementation guard**: refuse any write whose target page < 6. The write path should refuse to touch the identity region as a safety net even if a future bug computes the wrong offset.

♻️ **Reuses (mostly new code, but spec is comprehensive)**:
- [`docs/rfid-vendors/tigertag.md`](docs/rfid-vendors/tigertag.md) — 386-line spec with full byte layout, field types, lookup table references. The encoder is mechanical translation.
- `inventory.js` L399-491 — existing lookup tables (`brandName`, `materialLabel`, `typeName`, `dbFind`) that resolve display labels back to IDs for chip encoding. Reuse for the wizard's pickers.
- `data/id_brand.json` / `id_material.json` / `id_aspect.json` / `id_type.json` / `id_diameter.json` — the same lookup files used at parse time, used in reverse at encode time.
- TD1S sensor reading code (`inventory.js` L12267-12389) — reusable for the "pick color via TD1S" wizard step.
- Output of Sub-feature A (multi-reader detection) — without it, the wizard can't know which slot has the blank chip.

**Risk**: low-medium — surgical page-level writes cut the failure surface, but chip writes are still non-reversible at the byte level. Stage on disposable NTAGs first.

#### 🔧 Sub-feature D — Recycle TigerTag → plain NFC
- **Goal**: a chip the user is done with (broken spool, weight depleted, sold) gets repurposed as a normal NFC tag — keychain, badge, business card, URL launcher.
- **Record types offered**:
  - 🌐 **Web URL** — text input with auto-https prefix
  - 👤 **vCard** — name, email, phone, company; renders as standard vCard 3.0
  - 📝 **Plain text** — short note (≤ 100 chars)
  - 📞 **Tel** — `tel:` URI
  - ✉️ **Email** — `mailto:` URI with subject/body
  - 🔗 **Wi-Fi** — SSID + password + auth type (WPA2 default)
- **Steps** (all chip writes obey the surgical page-level rule, see *Cross-cutting* below):
  1. **Read** — confirm it's a TigerTag (so we don't accidentally repurpose someone else's tag), and confirm the current Firestore spool is either deleted or has `weight_available <= 0`.
  2. **Compute target layout** — build the full NDEF byte layout for the chosen record type. Pages 4-5 (`TAG_ID` + `PRODUCT_ID`) stay as-is — even on recycle, the immutable identity is never touched, so a "former TigerTag" remains identifiable as such.
  3. **Diff against current chip pages** — page-by-page comparison; build the minimal write list. Pages that already hold the target bytes get skipped.
  4. **Write only the diff pages** — using the cross-cutting `nfc:write-pages` helper. No blanket "erase to 0x00" pass.
**Confirmation**: hold-to-confirm 1.5 s pattern (same as Delete spool) before triggering the write sequence. Show "This action cannot be undone — chip data will be replaced."

**Where in code**: new file `renderer/lib/rfid/tigertag-recycle.js` for the byte-level operations, `renderer/lib/rfid/ndef-builder.js` for the NDEF record generation. UI lives in a new "Recycle" tab inside the existing toolbox of the spool detail panel (visible only for empty/deleted spools when a chip is on the POD).

♻️ **Reuses**:
- `inventory.js` toolbox section in the spool detail panel (visible at L4096-4283 per CODEMAP) — the new "Recycle" entry slots in next to the existing Delete tool with the same hold-to-confirm CSS.
- The `nfc:write-pages` IPC handler from Sub-feature C (centralized read-diff-write-verify loop). E and D both call through it.
- NDEF record format is widely documented (NFC Forum spec) — no existing code, but plenty of JS reference implementations (`ndef-lib`, `@ndef/web`) to study.

**Effort**: M  ·  **Risk**: low — surgical writes mean the immutable identity stays intact and the user can always tell the chip was originally a TigerTag.

#### 🔧 Sub-feature E — Sync edits back to chip (write-when-present)  ·  **Effort: S**  ·  **Risk: low**
The user can already edit TD and color from the spool detail panel today (TD modal + Color modal → Firestore). The chip is **not** updated automatically — instead, the spool gets flagged `needUpdateAt = Date.now()`, a refresh badge appears in the table / grid / detail panel, and a banner offers a "Updated" button which the user clicks **after** re-programming the chip with a separate tool. With the POD, this last step becomes automatic.

♻️ **Reuses (~80% of the UX exists already)**:
- `inventory.js` L3351 — `CHIP_FIELDS = ["TD", "online_color_list"]` already lists chip-bound fields.
- `inventory.js` L3358 — `_saveTdHex()` already sets `needUpdateAt = Date.now()` when a `CHIP_FIELDS` member is in the update. Twin-aware (writes both spools in a single batch).
- `inventory.js` L3263-3294 — existing "Updated" button click handler already does the batch-clear of `needUpdateAt` on spool + twin. The new POD flow just triggers the same code path programmatically.
- `inventory.js` L572 — `normalizeRow` already exposes `needUpdateAt` on the row shape.
- `inventory.js` L2852, L2901, L3777, L4068 — existing badges + banner DOM rendering for chip-pending state. Zero CSS work needed.
- `chipPendingHint` / `btnChipDone` i18n keys — already translated in 9 locales.
- The `nfc:write-pages` IPC handler from Sub-feature C — same write infrastructure.

What changes with the POD:
- **Detect-on-slot logic**: when a chip lands on the POD AND `state.rows.find(r.uid==chipUid).needUpdateAt != null`, instead of opening the detail panel, open a **"Sync changes" modal** showing a diff (`color: #6e6e6e → #d83b3b`, `TD: 1.85 → 2.10`) with a single "Apply to chip" button.
- **Batched diff write**: on confirm, the renderer asks main.js to write all diff fields in one APDU sequence (fewer writes = lower risk of partial state). On success → batch-clear `needUpdateAt` on the spool + its twin (already wired by the existing "Updated" button code path — just trigger it programmatically).
- **Read-back-and-verify** after every write — refuse to clear `needUpdateAt` if any byte didn't take.
- **Multi-pending UX**: if 3 fields were edited since the last sync, the modal shows all 3 in one list — same chip write, one round trip. (The existing `needUpdateAt` is just a timestamp, but at sync time we re-parse the chip and compare to the Firestore doc, so the diff is automatically the union of all pending edits — no need to track per-field flags.)
- **Writable field set**: the spec at [`docs/rfid-vendors/tigertag.md`](docs/rfid-vendors/tigertag.md) suggests we could expand `CHIP_FIELDS` beyond `TD` + `online_color_list` to include `MATERIAL_ID`, `ASPECT1_ID`, `ASPECT2_ID`, `TYPE_ID`, `DIAMETER_ID`. Out of scope for first ship — keep the existing 2-field set, then expand. All these fields live on pages ≥ 6, safely away from the signature.
- **Signature**: not an issue (see Sub-feature C). The TigerTag+ factory signature is computed only over pages 4-5 (`TAG_ID` + `PRODUCT_ID` — immutable identity), and Sub-feature E never touches those pages. Basic TigerTag chips are unsigned. The signature stays valid through any number of edit cycles.

**Dependency**: Sub-feature C (write capability). E can ship the **diff modal + UX** independently and stub the actual write to no-op until C lands; that gives users a clearer "what changed" view today even without the chip-write path.

#### 🐛 Debug surface — POD
The existing app already gates a `🐛 Debug` panel on `users/{uid}.Debug = true` (admin-set), with a Firestore explorer + last-API-request inspector. The POD work doubles the surface area of NFC code, so it gets dedicated debug interfaces:

- **🔬 NFC log tab** (new tab in the Debug panel) — every `card`, `card.off`, `error`, and `end` event from every connected reader, with raw UID hex, parsed UID, parser output (or "unknown format" + raw bytes), reader name, slot id, timestamp. Newest first; clearable; copy-to-clipboard for support tickets. Reuses the existing debug log scroll/copy CSS from the Snapmaker WS log.
- **🔬 Chip pages dump** — when a chip is on either slot, debug-only "Read all pages" button shows the full byte dump (page 0 to N) with offsets, hex, and the parser's interpretation side-by-side. Lets the user spot field-decode mismatches at a glance.
- **🔬 Write log tab** — every `nfc:write-pages` invocation: `{slotId, pages: [{index, before, after}]}` plus the read-back-and-verify result page-by-page. Failed verifies stay in the log highlighted red. Critical for debugging Sub-features C / D / E.
- **🔬 Force POD mode toggle** in Settings → Debug — surfaces the dual-slot UI even with 1 reader plugged in. Already mentioned in *Cross-cutting: POD detection model* below; wire it as a debug-only setting.
- **🔬 Twin-pair candidate inspector** (Sub-feature B) — when a chip lands on slot 1, show a debug-only banner listing every `findTwinCandidates()` match with the matched fields. Helps catch the "should have matched but didn't" class of bugs.
- **🔬 Pending diff inspector** (Sub-feature E) — debug-only "Show pending changes" link in the chip-update banner, expanding to the full Firestore-vs-chip diff with all field types (not just the simplified UI view).

**Reuses**: existing `inventory.js` L4355-4365 (debug panel toggle), L4697-4777 (Firestore explorer pattern), L6681-7130 (Snapmaker WS request log — same UI shape, just a different feed). Most of the debug surfaces are new tabs + new feeds plugged into the existing debug panel chrome.

#### 📐 Cross-cutting: POD detection model
- The app is **not** POD-aware today — it just sees N readers. Detection rule: if the user has ≥ 2 ACR122U readers connected at the same time, surface the "POD mode" UI; otherwise stay in single-reader mode (current behaviour, kept identical).
- A user-visible toggle in Settings → POD lets them force POD mode even with 1 reader (for testing/debug).

#### 📐 Cross-cutting: surgical page-level writes (never erase-and-rewrite)
**Hard rule for every chip-write code path** (B's twin link doesn't write the chip; C writes fresh; D recycles; E syncs edits):
1. **Read first** — every write operation begins with a fresh chip read.
2. **Diff at page granularity** — MIFARE Ultralight pages are 4 bytes each. Build the target byte layout, compare page-by-page with the current chip read, produce a list of `{page, bytes}` only for pages whose 4-byte content differs.
3. **Write only the diff pages** — never blanket-overwrite a region. Each page written = one APDU, one write cycle. Skipping unchanged pages saves write-cycle endurance and rules out partial-state corruption on the unchanged regions.
4. **Pages 4 & 5 are sacred** — `TAG_ID` + `PRODUCT_ID` (the factory-signed identity). The write helper rejects any `{page < 6}` entry as a defensive guard, even if upstream code asked for it by mistake.
5. **Read-back-and-verify** — after each write, re-read the page and bit-compare to the intended bytes. If any byte differs, abort the sequence and surface a clear error in the UI (don't pretend the write succeeded).
6. **No "erase"** — the recycle flow (D) is implemented as "compute the NDEF target layout, diff against current pages, write only the differing pages". The pages that happen to already hold the target bytes get skipped. There's no separate erase pass that overwrites with `0x00`.

Implementation home: `main.js` exposes one IPC handler `nfc:write-pages` that takes `{slotId, pages: [{index, bytes}]}` and runs the read-diff-write-verify loop. All four sub-features (C / D / E and any future write) call through it. Centralising the code path means the safety rules above live in one place.

#### 🧮 Total effort
- A: S, B: M, C: M, D: M, E: S — **~L combined** (was XL before the signing-question removal cut C from L to M).

#### 🎯 Recommended sequence
1. **A — multi-reader IPC fix** (clears the way, no UX surface)
2. **B — scan → inventory + twin auto-detect** (immediate user value; reuses existing parser + twin-link code)
3. **E (UX half) — diff modal for pending chip changes** (the existing `needUpdateAt` flag already drives the UX; the new modal shows *what* would change, even before the chip-write side exists — replace the manual "Updated" button with this richer view)
4. **D — recycle to NDEF** (popular feature, low risk; useful even before write-chip lands)
5. **C — write fresh chip** (no longer blocked on signing — pages 4-5 stay untouched, factory signature stays valid)
6. **E (write half)** — once C lands, plug the actual chip-write call in behind the diff modal's "Apply" button. The `needUpdateAt` clear already exists; just promote it from manual to automatic on successful write.

---

### 🥈 Multi-brand live integration — Snapmaker-parity for the other brands

Today only **Snapmaker** has a live block (real-time temps, filament per slot, print-job card, camera). The four other brands in the picker (Bambu Lab · Creality · Elegoo · FlashForge) render as **read-only cards** with an HTTP ping for online/offline. This entry brings them — plus a generic Klipper bucket and Wondermaker — to feature parity.

#### 🏗️ Architectural prerequisite — Driver layer
The Snapmaker code (renderer/inventory.js L5533-7216 per CODEMAP) is monolithic. Before adding new brands, extract a small `LiveDriver` interface so each protocol slots in cleanly:

```js
interface LiveDriver {
  connect(printer, callbacks)   // open transport, start streaming
  disconnect(printer)
  sendGcode(printer, script)
  getStatus(printer)            // sync getter, reads cached snapshot
  getCameraStream(printer)      // optional — returns URL or null
}
```

##### Rule of Three — no premature `moonraker.js`
The current Snapmaker code talks Moonraker, but it carries Snapmaker-isms that are NOT generic Moonraker behaviour:
- `/machine/system_info` filter on `machine_type` containing `"Snapmaker"` (in the LAN scan flow)
- Filament bottom-sheet wired to U1's 4-extruder layout + Snapmaker material/vendor palette
- Camera URL pattern (Snapmaker custom WebRTC stream)
- Per-printer macros for filament load/unload (Snapmaker firmware specific)

Extracting a `drivers/moonraker.js` from a single implementation = textbook leaky abstraction. The implementation looks generic, then breaks when the second Klipper-class printer lands and expects a different camera path / material palette / macro set.

**Discipline**:
1. **1st impl** (Snapmaker, the existing code) → `drivers/snapmaker.js`. All current behaviour preserved verbatim.
2. **2nd impl** (e.g. Creality K1) → `drivers/creality.js`. Built in parallel, even if 80% of the code looks like a copy of `snapmaker.js`. We **resist** extracting common parts at this stage.
3. **3rd impl** (e.g. Wondermaker or generic Klipper) → THEN we have enough comparison points to identify what's truly common, and extract a `drivers/_moonraker-base.js` that the brand drivers compose with.

Cost: ~20% temporary duplication across drivers 1 & 2. Benefit: zero forced re-refactor when the 3rd brand reveals a Snapmaker-only assumption that wasn't visible from the Snapmaker code alone.

##### Driver map (post-3rd-impl factoring)
| Driver | Protocol | Brands / models |
|---|---|---|
| `drivers/snapmaker.js` | Moonraker WS (`:7125`) + Snapmaker-specifics | Snapmaker (today) |
| `drivers/creality.js` | Moonraker WS (`:7125`) + Creality-specifics | **All Creality printers in scope** — K1, K1 Max, K2 Plus, current-gen Enders running Klipper. One driver covers every model on the Creality side because they share the same Moonraker-Klipper stack. **Per-model specialization is a future concern** — only forked into `creality-k2.js` etc. if/when a specific model needs different behaviour (UI/macros) that pollutes the base. |
| `drivers/klipper-generic.js` | Moonraker WS (`:7125`) — assumed-vanilla path | Wondermaker, generic Klipper machines (any printer running Moonraker that's not one of the named brands) |
| `drivers/_moonraker-base.js` | shared primitives (WS lifecycle, gcode, status subscribe) | extracted only after 3 implementations exist and the common surface is empirically clear |
| `drivers/bambu-mqtt.js` | MQTTS on `:8883` | Bambu Lab (entire range — same MQTT API across X1/P1/A1/H2D) |
| `drivers/flashforge-http.js` | HTTP polling on `/control/*` | FlashForge (AD5X / 5M / 5M Pro) |

**Per-brand vs per-model rule of thumb**: one driver per **brand** unless a specific model breaks the brand's protocol contract. Most brands have one stack across their lineup (Bambu MQTT, Creality Klipper); the per-model split is for outliers.

A `drivers/index.js` dispatcher routes by `printer.brand` (with a `printer.protocol` override for "generic Klipper" printers that need explicit Moonraker selection without being one of the named brands).

A possible 7th driver later: `drivers/elegoo-mqtt.js` for Centauri — **research-gated** (see F5 below).

#### Per-brand status

| Brand | Protocol | Discovery | Driver | Status |
|---|---|---|---|---|
| **Snapmaker** | Moonraker WS (`:7125`) | mDNS `_snapmaker._tcp.local.` | `snapmaker` | ✅ shipping (lives in `inventory.js` today, extracted to its own driver in F1) |
| **Bambu Lab** | MQTTS (`:8883`) — LAN mode + Cloud bridge | mDNS `_bambu._tcp.local.` (broadcasts model + serial) | `bambu-mqtt` | New driver. Auth = printer access code (printed on device, user enters once). LAN mode requires "Local print" enabled on the printer. |
| **Creality** (K1, K1 Max, K2 Plus, current-gen Enders running Klipper) | Moonraker WS (`:7125`) | mDNS `_octoprint._tcp.local.` (when present) or hostname-based | `creality` (single driver across all current models — see *Per-brand vs per-model rule of thumb* above) | New driver — built **in parallel** with `snapmaker.js`, even if much of the code looks similar. We resist extracting a shared `_moonraker-base.js` until the 3rd Klipper-class brand lands (Rule of Three above). |
| **Elegoo Centauri** | MQTTS — Chitu cloud bridge | TBD (research) | `elegoo-mqtt` (research-gated) | Lower priority — research first whether LAN mode exists or if cloud-only. |
| **FlashForge** (AD5X, 5M, 5M Pro) | HTTP polling on `:8898` for status; WebSocket on `:8899` for live updates on newer firmware | UDP broadcast on `48899` with magic byte | `flashforge-http` | New driver. Less rich than Moonraker (no temperature stream — poll every 2s). |
| **Generic Klipper / Wondermaker** | Moonraker WS (`:7125`) | mDNS varies; falls back to manual IP | `klipper-generic` | New driver — at this point we have 3 Klipper-class implementations (Snapmaker + Creality K + Generic) and the empirical common surface is clear, so this is the right moment to extract `_moonraker-base.js`. New brand entry "Klipper machine" with a manual-IP-only flow (auto-discovery is hit-or-miss across Klipper distros). |
| (Future) Prusa MK4 / MINI | PrusaLink HTTP (`:80`) | mDNS `_prusalink._tcp.local.` | `prusa-http` | Out of scope for first ship; add to the model JSON files later. |

#### Sub-features — recommended ship order

##### F1 — Driver interface extraction *(refactor)*  ·  **Effort: M**  ·  **Risk: low**
Create `renderer/lib/drivers/index.js` + `snapmaker.js`. Move all `snap*` functions out of `inventory.js` into the Snapmaker driver verbatim — no behaviour change. The `renderPrinterDetail()` codepath calls `drivers[printer.brand].getStatus()` instead of `snapMergeStatus()` directly. Result: Snapmaker logic is in its own driver, ready for the 2nd parallel implementation in F2.

♻️ **Reuses (existing, exploitable)**:
- `inventory.js` L5557-7216 — the entire `snap*` block. WS lifecycle (`snapConnect` L5640, `snapOpenSocket` L5674, `snapScheduleReconnect` L5767, `snapDisconnect` L5781), status merge (`snapMergeStatus` L5793), gcode (`snapSendGcode` L5932), filament edit bottom-sheet (L5971-6343), Moonraker file/thumbnail helpers (L6344-6486), live block render (`renderSnapmakerLiveInner` L6520), WS request log (L6681-7130).
- `inventory.js` L8030-8226 — Phase 0/1/2 LAN discovery (mDNS browse + subnet enumeration + port-scan).
- `inventory.js` L8634-8777 — Add by IP widget.
- Goes WITH a CODEMAP refresh (the giant `Snapmaker Live` section in `renderer/CODEMAP.md` becomes a 3-line "see drivers/snapmaker.js" stub).

**Win**: `inventory.js` loses ~1700 lines, code-map shrinks meaningfully. Partial down-payment on the long-parked *modularize inventory.js* item from the 🌱 Internal section.

##### F2 — Second-impl Klipper-class brand (Creality K-series)  ·  **Effort: L**  ·  **Risk: low-medium**
Build `drivers/creality.js` **in parallel** with `snapmaker.js`. Even though Moonraker's WS protocol is the same on the wire, **resist extracting a shared base** — the goal is to **discover empirically** what's actually common vs Snapmaker-specific by having two real implementations side-by-side. Expected behaviour deltas (educated guesses, to validate by implementing):
- Camera URL pattern (Creality K1 has its own MJPEG endpoint; Snapmaker uses WebRTC)
- `machine_type` filter ("Creality" vs "Snapmaker")
- Multi-extruder layout (K1 = 1 extruder, K1 Max = 1, K2 Plus = up to 4)
- Filament macros (K1 ships with `LOAD_FILAMENT` / `UNLOAD_FILAMENT` macros, but the syntax/parameters differ from Snapmaker)
- Print-job thumbnail location

♻️ **Reuses**:
- `drivers/snapmaker.js` (output of F1) — copy as a starting point, then strip Snapmaker-specifics
- `inventory.js` brand picker plumbing (`PRINTER_BRANDS` L5130, `PRINTER_BRAND_META` L5217, `openPrinterBrandPicker` L7321) — Creality entry already exists, need to wire the live driver
- `data/printers/cre_printer_models.json` — model picker data already populated
- The dual-extraction question: **only after F2 is done and battle-tested**, decide whether to refactor a `_moonraker-base.js` containing the empirically-common parts. Don't decide it before the second implementation ships.

**Note**: F2's effort is **L (not M)** because building a parallel implementation responsibly (testing on a real K1, validating the deltas, wiring the brand picker) is more than mechanical reuse. The discipline of "build twice before extracting" costs effort upfront and pays back at F3+ when there's no leaky-abstraction debt to fix.

##### F2b — Generic Klipper / Wondermaker driver  ·  **Effort: M**  ·  **Risk: low**
With Snapmaker and Creality K both shipping, build `drivers/klipper-generic.js` for any Klipper printer not specifically wired (manual IP entry, no auto-discovery, no model picker — single "IP / hostname" field).

After this third implementation, perform the **planned extraction**: identify the genuinely common code across all three drivers and lift it into `drivers/_moonraker-base.js`. The three brand drivers become thin specializations that compose the base.

♻️ **Reuses**:
- `drivers/snapmaker.js` + `drivers/creality.js` — diff them to find the genuinely common parts
- The result becomes the architectural decision deferred from F1 — backed by 3 concrete data points instead of 1.

##### ✅ F3 — Bambu Lab MQTT driver *(shipped v1.6.0)*  ·  **Effort: L**  ·  **Risk: medium**
New driver hitting `mqtts://{ip}:8883` with username `bblp`, password = printer access code, topic `device/{serial}/report` for telemetry, `device/{serial}/request` for commands. **Reuses the Snapmaker live block UI** — filament grid, temps, print-job card. Bambu's protocol carries the same shape of data, just under different field names.

♻️ **Reuses**:
- `inventory.js` L6520-6680 (`renderSnapmakerLiveInner`) — same DOM structure, just feed it the Bambu-derived status object. Most of this can move into a shared "live-block-renderer" helper (rename `renderSnapmakerLiveInner` to something brand-agnostic during F1's refactor).
- `main.js` `bonjour-service` integration (added in v1.4.8 for Snapmaker mDNS) — works for `_bambu._tcp.local.` with no change.
- The mDNS UI panels from `inventory.js` L8410+ (`openSnapmakerScan` and friends) — generalize during F6.
- npm: needs `mqtt` package (well-maintained MQTT client). Check existing `package.json` deps before adding.

**Camera**: Bambu uses an RTSP stream — known cross-platform pain point. First ship probably skips camera and shows the "Photo card" fallback. Phase 2 if a JS RTSP→MJPEG bridge proves stable.

**Bambu firmware risk**: Bambu has rolled out sudden firmware changes that broke 3rd-party tools historically — keep the parser defensive (every field optional, every numeric range-checked).

##### F4 — FlashForge HTTP driver  ·  **Effort: M**  ·  **Risk: low-medium**
Polling design: every 2s call `/control/getStatus` and equivalent. Newer firmware exposes a WebSocket — opportunistic upgrade after first poll succeeds.

♻️ **Reuses**:
- Same shared "live-block-renderer" helper extracted in F1
- `inventory.js` brand picker plumbing — FlashForge entry already in `PRINTER_BRANDS`, `data/printers/ffg_printer_models.json` already populated
- Discovery: UDP broadcast on port 48899 — needs a small `dgram` socket helper in `main.js` (no existing equivalent; fully new code, ~30 lines)

**Live block scope**: temps + active job. No mid-print filament editing (Snapmaker's bottom-sheet stays a unique capability — Flashforge's HTTP API doesn't expose the equivalent endpoints today).

##### ✅ F5 — Elegoo MQTT driver *(shipped v1.6.0)*  ·  **Effort: L**  ·  **Risk: medium**
LAN MQTT confirmed on port 1883 (no cloud bridge required). Full implementation shipped: MQTT connect/disconnect, UDP discovery, job card, temp card, filament card (mono + Canvas 4-slot), control card (jog pad, fans, LED, files), filament edit sheet, Files/History sheet, camera.
- Research confirmed: Elegoo Neptune / Centauri range exposes a plain TCP MQTT endpoint on the LAN — no Chitu cloud relay needed.
- Surgical DOM patch on control card (fan %, LED state, XYZ position updated in-place) eliminates the per-tick flash.

♻️ **Reuses** (only if LAN exists):
- `drivers/bambu-mqtt.js` (output of F3) as a starting point — both are MQTT, payload schemas differ
- Same `mqtt` npm dep as F3

##### F6 — Brand picker + discovery flow polish  ·  **Effort: M**  ·  **Risk: low**
Per-brand discovery panels analogous to the Snapmaker scan side panel: mDNS browse, port-scan fallback, "Add by IP" widget. Generic-Klipper gets only "Add by IP" (no auto-discovery).

Per-brand settings form — different fields per brand: Bambu wants `ip` + `accessCode` + `serial`, Klipper just wants `ip`, FlashForge `ip` only.

♻️ **Reuses**:
- `inventory.js` L8410+ — `openSnapmakerScan` and the entire scan side-panel UI (mDNS phase, port-scan phase, results list, one-click add). Refactor into a generic `openPrinterScan(brand, config)` taking a per-brand config (mDNS service name, scan port, brand-confirm filter, etc.).
- `inventory.js` L8634-8777 — `openPrinterAddByIp` collapsible widget. Already brand-agnostic in shape; just needs per-brand validation rules.
- `inventory.js` L7521-8029 — Debug scan journal. Brand-agnostic UI; passes through.
- `data/printers/<brand>_printer_models.json` — model JSON files already in place for the 5 named brands.

#### 🧮 Total effort
F1: M  ·  F2: L  ·  F2b: M (includes the deferred `_moonraker-base.js` extraction)  ·  F3: L  ·  F4: M  ·  F5: ~S+L (gated)  ·  F6: M → **~XXL combined**.

The F2 → L bump (vs. the original M estimate) reflects the *Rule of Three* discipline: building a parallel `creality.js` instead of refactoring Snapmaker into a forced abstraction. The cost is real (extra implementation work) but the saving is also real (no leaky-abstraction debt to fix when F2b lands).

#### 🎯 Recommended sequence
1. **F1** — extract `drivers/snapmaker.js` from inventory.js (no new functionality, refactor only).
2. **F2** — second parallel implementation: `drivers/creality.js`. **Resist** any extraction urge; the goal is to discover what's truly common by having two real impls side-by-side.
3. **F6** — brand picker UX cleanup so the new brands are clickable with the right per-brand forms.
4. **F2b** — third Klipper-class implementation (`drivers/klipper-generic.js`) + planned extraction of `drivers/_moonraker-base.js` from the empirically-common parts of all three.
5. **F3** — Bambu Lab MQTT (headline feature, biggest user base after Snapmaker).
6. **F4** — FlashForge HTTP.
7. **F5** — Elegoo Centauri (research first, build only if LAN mode is reachable).

#### 🐛 Debug surface — Multi-brand live
Snapmaker already has a debug-only WS request log (`inventory.js` L6681-7130). Generalising to multi-brand means the debug surface multiplies — each driver gets its own log feed, plus brand-agnostic inspectors:

- **🔬 Per-driver request log** (one tab per active driver) — every command sent + response received, wire-format. Moonraker WS frames, MQTT topic+payload, FlashForge HTTP status. Same UI shape as today's WS log; the feed source changes per driver.
- **🔬 Live status inspector** — debug-only side panel that shows the **parsed** status object the driver hands back to the renderer, in real time. Lets us catch field-name mismatches and stale-data bugs without reading wire protocol traces.
- **🔬 Connection state machine** — visualizes `idle → connecting → connected → reconnecting → disconnected` per printer. Shows last error, retry count, ms since last frame. Cures the "why does this printer keep disconnecting" black hole.
- **🔬 Force-connect-to-IP** debug button — bypasses discovery entirely; types in an IP + protocol and starts a session. Critical for testing Bambu / Creality / FlashForge during F3-F4 development.
- **🔬 Driver dispatch trace** — shows which driver was selected for each printer in `state.printers`, and **why** (brand match, protocol override, fallback). Helps diagnose F2/F2b extraction edge cases.
- **🔬 Discovery scan journal** — already exists for Snapmaker (`inventory.js` L7521-8029); generalise to per-brand journals during F6 so any brand's scan can be exported as a JSON dump for support tickets.
- **🔬 Raw frame replay** — paste a captured wire frame back into the active driver to test the parser in isolation. Lower priority but very useful for regression-testing after Bambu firmware updates.

**Reuses**: existing `inventory.js` L7521-8029 (Snapmaker scan journal — generalise during F6), L6681-7130 (WS log UI), L4697-4777 (debug panel tab pattern). Most of the multi-brand debug surfaces are mechanical extensions of patterns already shipped for Snapmaker.

#### 📐 Cross-cutting note
After F1, the CODEMAP entry for the Snapmaker section needs a rewrite (it'll point to `renderer/lib/drivers/snapmaker.js` instead of an inline range in `inventory.js`). Update CODEMAP.md as part of F1's commit. The same applies to F2 (add Creality), F2b (add Klipper-generic + base), F3 (add Bambu), F4 (add FlashForge): every driver added bumps the CODEMAP.

---

### 🥉 Printer control panel — beyond monitoring, into commanding

Today the printer detail panel is **read-only** — it shows live temperatures, the loaded filament per slot, the active print job, and the camera feed. The only command surface is the bottom-sheet filament edit (which sends a single `M104` + filament-load macro). The user wants what OrcaSlicer / Mainsail / Fluidd offer: **interactive controls** to pause/resume, home, jog axes, load/unload filament, set temperatures, run macros, browse the printer's file list, etc.

The primitive exists already: `snapSendGcode(conn, script)` (renderer/inventory.js, in the Snapmaker live block) wraps the Moonraker `printer.gcode.script` JSON-RPC. What's missing is the UI surface, the per-action handlers, the safety patterns, and the per-brand portability.

#### Driver interface extension
This entry **extends** the `LiveDriver` interface from F1 of *Multi-brand live integration* with control methods. Strict prerequisite: F1 must land first so the same UI calls `drivers[brand].pause()` regardless of the underlying transport.

```js
interface LiveDriver {
  // (from F1 — already planned)
  connect, disconnect, sendGcode, getStatus, getCameraStream

  // print job control
  pause()
  resume()
  cancel()
  emergencyStop()

  // movement
  home(axes = ['x', 'y', 'z'])
  jog(axis, distance, speed?)
  disableSteppers()

  // temperature
  setNozzleTemp(temp, extruder = 0)
  setBedTemp(temp)
  setChamberTemp?(temp)
  cooldown()

  // filament
  loadFilament(extruder = 0, profile?)
  unloadFilament(extruder = 0)

  // live tuning
  setPrintSpeedFactor(percent)
  setFlowRate(percent, extruder = 0)
  setFanSpeed(speed, fanIndex = 0)

  // files (Phase D)
  listFiles?()
  startPrint?(filename)
  uploadFile?(buffer, filename)
  deleteFile?(filename)

  // macros (Phase D)
  listMacros?()
  runMacro?(name)
}
```

Per-protocol implementation:
- **Moonraker** — most actions are `sendGcode(<script>)` wrappers (e.g. `pause` → `PAUSE`, `home` → `G28`); files via `server.files.*` JSON-RPC; uploads via HTTP POST to `/server/files/upload`. Full feature surface available.
- **Bambu MQTT** — commands go through `device/{serial}/request` with brand-specific JSON payloads (`{"print": {"command": "pause"}}` etc.). Filament macros are baked into the printer firmware. File API exists but uploads are FTP, not MQTT. Phase A-C reachable; Phase D partial.
- **Flashforge HTTP** — `/control/*` endpoints cover Phase A and most of B; live tuning more limited; no file upload via the official API on most firmwares.

#### Sub-features by ship phase

##### G1 — Print job control *(safety-critical, biggest user value)*  ·  **Effort: M**  ·  **Risk: medium**
- **Pause / Resume** — single button that swaps role based on `printer.status`. Disabled when no print active.
- **Cancel print** — hold-to-confirm 1.5s pattern. Modal with "Are you sure?" + the active filename for clarity.
- **Cooldown all** — sets nozzle + bed (and chamber if supported) to 0. Always available.
- **Emergency stop** — hold-to-confirm 2.5s. Warning copy: "Hardware will halt immediately. Mid-print stop may damage the part or extruder."

♻️ **Reuses**:
- `inventory.js` L5932 — `snapSendGcode(conn, script)` already wraps Moonraker's `printer.gcode.script`. Pause/Resume/Cancel are one-line calls (`PAUSE`, `RESUME`, `CANCEL_PRINT`). Cooldown = `M104 S0` + `M140 S0`. Emergency = `M112` + `FIRMWARE_RESTART`.
- `inventory.js` `setupHoldToConfirm()` (L194-240) — exact pattern already used by Delete spool and Recycle. Same CSS, same UX.
- `inventory.js` L6520+ (`renderSnapmakerLiveInner`) — print-job card header is where the controls bar lands.

##### G2 — Movement *(homing + jog)*  ·  **Effort: M**  ·  **Risk: low-medium**
- **Home all / X / Y / Z** — disabled mid-print (firmware would refuse anyway, but better UX to grey out the buttons).
- **Jog axes** — 4-direction pad for X/Y, up/down for Z. Step picker: 0.1 / 1 / 10 / 100 mm (clamped to printer's max-jog config). Optional speed override.
- **Disable steppers** — for manually moving the bed/head.
- **Mid-print lockout** — all jog + home disabled, with a tooltip explaining why.

♻️ **Reuses**:
- `snapSendGcode` again (`G28`, `G91`+`G1 X<step>`, `M84`).
- `data/printers/<brand>_printer_models.json` model files — needs new `max_jog_speed` / `max_jog_distance` fields for input clamps (soft dependency noted in the "soft dependency" section).
- Status-aware UI gating — `printer.status` already in the Snapmaker WS subscribe data; just add a `state.printers[id].canMove` derived boolean.

##### G3 — Temperature & filament  ·  **Effort: M**  ·  **Risk: medium**
- **Set nozzle / bed / chamber temp** — number inputs with clamps from per-printer config. Quick-set chips: PLA (215/60), PETG (240/80), ABS (250/100) — pulled from existing material lookup tables.
- **Load / Unload filament** — per-extruder. Confirms target temp is reached before extruding. Default macros tied to the active filament's material when known.
- **Mid-print behaviour**: temp adjustments allowed (live tuning), but load/unload disabled.

♻️ **Reuses**:
- `inventory.js` L5971-6343 — the Snapmaker filament bottom-sheet already does the temp-and-load dance for filament edits. Extract the "wait for target reached, then run load macro" logic into a reusable helper.
- `inventory.js` L399-491 — material lookup tables (`materialLabel`, `materialFull`) drive the quick-set chips.
- `data/id_material.json` — already populated with material names and reference temperatures; quick-set values pull from here.
- `snapSendGcode` for `M104` / `M140` / `M141` (chamber).

##### G4 — Live tuning *(during print)*  ·  **Effort: S**  ·  **Risk: low**
- **Print speed factor** — slider 50-200%, sends `M220 S<percent>`. Persists across sessions per printer.
- **Flow rate** — per-extruder, slider 80-120%, sends `M221`.
- **Fan speed** — part cooling fan slider 0-100%. Auxiliary fan if the printer reports one.

♻️ **Reuses**:
- `snapSendGcode` for `M220` / `M221` / `M106`.
- `inventory.js` weight-slider auto-save debounce pattern (`_sliderDebounce` at L3290 + CLAUDE.md "Weight slider auto-save" section) — exact same UX (slider + 500ms debounce) for the print-speed and flow sliders. Copy + adapt.

##### G5 — Files & macros  ·  **Effort: L**  ·  **Risk: medium**
- **File browser** — list `gcode_files/` (Moonraker) or printer-specific roots. Show filename, modtime, est. duration, thumbnail.
- **Start print from file** — single click + confirm modal showing filename + thumbnail.
- **Upload G-code** — drag-drop onto the file browser. Requires a free-space check first.
- **Delete file** — hold-to-confirm.
- **Custom G-code input** — textarea + Send. History dropdown of last 20 sent commands per printer.
- **User-defined macros** — saved per printer (Firestore `users/{uid}/printers/{brand}/devices/{id}/macros/{slug}`). Each macro is `{ name, gcode, color, icon? }`. Renders as a row of one-click buttons.

♻️ **Reuses**:
- `inventory.js` L6344-6486 — `snapNormalizePath`, `snapJoinPath`, `snapFilenameRel`, `snapBestThumb`, `snapThumbUrl`, `snapFileUrl`. The thumbnail rendering pipeline is fully built — just need to feed it a list of files.
- `inventory.js` L6720 — `snapSendCustomJson()` already supports custom JSON-RPC — extend to wrap `server.files.list`, `server.files.delete`, `printer.print.start`.
- `inventory.js` rack drag-drop (L10886+) — drag-drop wiring pattern already established. Reuse for the G-code upload drop zone.
- The Custom G-code input is essentially the existing `inventory.js` L6720+ debug log "Send" widget promoted to a first-class UI element — already there in debug mode.

##### G6 — Multi-tool & advanced  ·  **Effort: M**  ·  **Risk: low**
- **Tool selection** — for printers with multiple extruders, a tool picker (T0/T1/T2/…) above the load/unload area. Sends the appropriate `T<n>` before subsequent commands.
- **Skip current object** — Klipper `SKIP_CURRENT_OBJECT` (with object list browser).
- **Firmware restart** — `FIRMWARE_RESTART` for Klipper, brand-specific for others. Hold-to-confirm 2.5s.

♻️ **Reuses**:
- `snapSendGcode` for everything.
- `inventory.js` L6618-6680 — Snapmaker's per-extruder filament grid already iterates extruders 0-3 with click handlers. The tool selection chip strip slots in above it with the same pattern.
- The current Snapmaker WS subscription already includes `extruder.position` and `print_stats.objects` — no additional subscriptions needed.

#### 🐛 Debug surface — Printer control panel
Printer control is the highest-risk feature surface (a misclick can damage hardware), so the debug interfaces are also the most important. They're not optional polish — they're a precondition for shipping confidently.

- **🔬 Action audit log** — every command issued via the control panel: `{ts, printer, brand, action, payload, gcode, response, durationMs}`. Newest first; persistent (Firestore `users/{uid}/printers/{brand}/devices/{id}/actionLog/{auto}` with a 30-day retention rule) so multi-day debugging works. Filterable by action type. Critical for "what command did I send before the print failed?".
- **🔬 Custom G-code console** (already partially shipped in Snapmaker debug — promote it) — textarea + Send + history of last 50 commands sent on this printer (per-printer, persisted to localStorage). Each sent command shows its response inline. Use this to test new control bindings before wiring them to UI buttons.
- **🔬 Mid-print lockout bypass** — debug-only toggle that disables the "is printing" gate on home/jog/load-filament/etc. **Strictly debug** — leaves a banner at the top of the panel reminding "Lockout bypassed" and the audit log records every command sent in this mode.
- **🔬 Macro execution trace** — when a user-defined macro runs, debug shows the expansion: which gcode lines fired, the response after each, the elapsed time. Helps debug macros that mostly-but-not-quite work.
- **🔬 Live status diff** — when a state change is expected (e.g. pause → paused), debug shows the printer state before / after / delta-ms. Surfaces optimistic-rollback misfires (Sub-feature G1's "if printer doesn't transition in 5s, revert").
- **🔬 Temperature target / actual graph** (small) — last 5 minutes of nozzle + bed target vs actual, plotted. Spot temp-control oscillations before they cause print issues.
- **🔬 File operation log** — every `listFiles`/`uploadFile`/`deleteFile`/`startPrint` call with bytes-transferred + duration. File API is the most likely source of brand-specific bugs; this catches them.

**Reuses**: existing `inventory.js` L4355-4365 (debug panel toggle), L6681-7130 (Snapmaker WS log shape), L4524-4696 (deleted-spools list — same "debug-tab with filters" pattern). New tabs in the existing debug panel chrome — no new chrome needed.

**Sprint scope**: ship the Action audit log + Custom G-code console + Mid-print lockout bypass with G1. The rest can land progressively as the corresponding G-feature ships (e.g. File operation log alongside G5).

#### 🛡️ Cross-cutting: safety patterns
1. **Hold-to-confirm gradients** by danger level:
   - 1.5s: Cancel print, Delete file, Unload filament (low risk if cold)
   - 2.5s: Emergency stop, Firmware restart (irreversible / disruptive)
   - No hold: Pause, Resume, temp adjustments, jog (instantly reversible)
2. **Mid-print lockout** — every method declares which states it's allowed in. The UI greys out unavailable actions and shows a tooltip explaining the lockout reason ("Print active — pause first to home").
3. **Sane temp defaults** — load filament defaults to the active filament's material temp when known (from `state.rows[…].nozzleTemp`); falls back to PLA 215°C with a warning toast.
4. **Visual feedback** — every command button shows a `loading` state during transit, then a transient success/error toast based on the printer's response (Moonraker returns the `klippy_state` after every script).
5. **Optimistic UI rollback** — if a `pause` request is sent and the printer doesn't transition to paused within 5s, revert the button state and show an error.

#### Per-brand support level (initial ship)

| Brand | G1 (job) | G2 (move) | G3 (temp/fil) | G4 (tune) | G5 (files) | G6 (advanced) |
|---|---|---|---|---|---|---|
| Snapmaker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Klipper-class (Creality K, Wondermaker, generic) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bambu Lab | ✅ | ✅ | ✅ | ✅ | partial | ✅ |
| FlashForge | ✅ | ✅ | ✅ | partial | ❌ (no upload API) | ❌ |
| Elegoo | ✅ | ✅ | ✅ | ✅ | ✅ | partial |

#### 🎯 Recommended sequence
1. **G1 — Print job control** for Snapmaker (uses existing `snapSendGcode`). Ship to validate the safety patterns + UX before generalizing.
2. **G3 — Temperature & filament** for Snapmaker. Replaces the bottom-sheet filament edit's duplicate temp logic with the shared driver method.
3. **G2 — Movement** for Snapmaker.
4. **G4 — Live tuning** for Snapmaker.
5. **(After F1 of Multi-brand live integration ships)** Port G1-G4 to the Moonraker driver interface — automatically lights up Klipper-class brands.
6. **G5 — Files & macros** for Moonraker drivers (Snapmaker + Klipper-class).
7. **(After F3 of Multi-brand live integration ships)** Add Bambu MQTT command paths for G1-G4. Bambu G5 partial. Bambu G6 advanced features.
8. **G6 — Multi-tool & advanced** features for Snapmaker first, then ported.

#### 🧮 Total effort
G1: M, G2: M, G3: M, G4: S, G5: L, G6: M  ·  **~XL combined** for Snapmaker; multiplier per brand is small once F1 of *Multi-brand live integration* is in (each new brand reuses the UI + safety patterns; only the driver methods need a per-protocol implementation).

#### 📐 Dependency
**Strict prerequisite**: F1 of *🥈 Multi-brand live integration* (driver layer extraction). Without it, this work would all be locked into the Snapmaker codepath and would have to be ported again afterwards.

**Soft dependency**: the per-printer config in `data/printers/<brand>_printer_models.json` should grow new fields (`max_jog_speed`, `max_nozzle_temp`, `extruder_count`, `has_chamber_heater`) so the UI can clamp inputs and hide unavailable controls per model.

---

### 🏅 Multi-vendor RFID parsers — 7 vendors remaining
- **Spec**: [`docs/rfid-vendors/NEXT_STEPS.md`](docs/rfid-vendors/NEXT_STEPS.md) is a complete handoff doc — read it first.
- **What's there**: OpenRFID submodule + 8 self-contained spec sheets. ACR122U reader stack already done.
- **What's missing**: JS parsers under `renderer/lib/rfid/<vendor>.js`. Only TigerTag is decoded today.
- **Recommended order** (easy → hard): Openspool → Anycubic → Elegoo → Qidi → Creality → Bambu → Snapmaker.
- **Open questions**: where parsed-but-not-in-inventory tags live, conflict resolution with TigerTag tags, lookup-table delivery (bundled vs CDN-served).
- **Effort**: M (Openspool / Anycubic / Elegoo / Qidi each), L (Creality), XL (Bambu, Snapmaker — crypto).
- **Risk**: low (parsers are pure functions, no UI changes until dispatcher hooks them in).

### 🏅 Firestore Security Rules for `roles` + `Debug` fields
- **Where**: per [CLAUDE.md L175](CLAUDE.md#debug-mode), the `roles` and `Debug` fields in `users/{uid}` should be writable only via Firebase Admin SDK / Cloud Functions, never by the client. Today's UI toggle is a UX convenience but a malicious client could grant itself `roles: "admin"`.
- **Action**: add a Firestore Security Rule denying writes to those two fields except by admin SDK. Optionally a Cloud Function exposed to a separate admin tool to flip them.
- **Effort**: S (rules), M (Cloud Function setup if going that route).
- **Risk**: medium — bad rule = lockout. Test in Firebase emulator first.

### 🏅 Phase 2 Snapmaker — NFC scan from the printer
- **Spec**: code at [`renderer/inventory.js` L5542](renderer/inventory.js) leaves a Phase 2 marker: *"manual filament edit ✅, NFC scan, thumbnail metadata."* Manual filament edit shipped in v1.4.8 — what's left is reading filament tags via the printer's own NFC reader (Snapmaker U1 has one) instead of forcing the user to scan via ACR122U.
- **Approach unknown**: the Moonraker WebSocket likely doesn't expose NFC scan natively — would require a Snapmaker-specific G-code or HTTP endpoint. Research before scoping.
- **Effort**: L (research-heavy).
- **Risk**: high — depends on what Snapmaker exposes.

### 🏅 Pre-commit hook extensions
- Hook is at `.githooks/pre-commit`. Currently runs only `npm run i18n:check`.
- **Could add** when the project gains the corresponding tools:
  - `eslint --max-warnings 0` on staged `.js` (project has zero JS lint config today)
  - `prettier --check` (zero formatter config today)
  - `tsc --noEmit` (project is plain JS, no TS step today)
- **Effort**: S each, but each requires onboarding the corresponding tool first.
- **Risk**: low.

### 🎖️ README screenshots
- README has the line *"Screenshots coming soon"* in the Distribution section.
- **Action**: capture 4-6 screenshots (inventory, rack view, printer detail, friends modal, login, debug panel) at consistent window sizes, drop into `assets/img/screenshots/`, embed in README.
- **Effort**: S.
- **Risk**: zero.

---

## 🏅 Backlog — ideas worth keeping

No commitment, no ETA. Listed roughly by likely impact.

- **Public inventory page** — `state.isPublic` already persists in `users/{uid}.isPublic`, but no public read-only view renders it. Would let a maker share their stash via a public URL. Needs: separate route/page, Firestore rule allowing `read` on `isPublic == true`, link generation in the friends panel.
- **Other-brand live integration** — Bambu Lab (MQTT LAN), Creality (Klipper WS), Elegoo (MQTT), FlashForge (HTTP) currently render as **read-only cards** with online ping. Each could grow a live block matching Snapmaker's Phase 1 (temps + active job). Bambu MQTT first probably (largest user base). Each = L.
- **Print history per spool** — track which printer used which spool over time. Needs: schema decision (top-level `printJobs/` collection? embedded in spool doc?), capture hook in Snapmaker WS layer (the print job card already has the data we'd need), history UI in spool detail panel.
- **Spool predictions** — *"this spool will run out around X day"* based on historical usage. Depends on print history existing first.
- **Filament cost tracking** — per-spool cost field, aggregate by month / by printer / by material in stats. Pure UI + schema addition.
- **TigerScale — auto weight transfer** — after a successful TARE + send cycle, auto-update the matched spool's `weight_available` in Firestore from `netWeight`.
- **Marketplace / shared filament profiles** — share a `(material, brand, optimal_settings)` triple to a public registry; users could pull recommended print profiles for a given spool.
- **Web build** — multiple comments in `inventory.js` mention *"future web build hosted on tigertag-cdn"*. Sidesteps Electron's NFC requirement (no NFC = no scan, but read-only inventory works fine in browser). Needs: Electron-API polyfills/stubs, build target split.
- **Mobile companion app deep-linking** — the desktop app shows a QR for the mobile app; mobile could deep-link back into a specific spool / printer / friend on desktop.

---

## 🌱 Internal / dev-experience

Lower priority but worth noting.

- **Modularize `inventory.js`** — split the 12k-line IIFE into ES modules (auth, inventory, racks, snapmaker, friends, ui-helpers, …). XL effort, medium risk (every cross-file dep needs an import). Discussed but parked because the CODEMAP gives most of the navigation benefit at zero risk.
- **TypeScript port** — only worth it after modularization. Would catch a real class of bugs (type mismatches in Firestore schemas, plural-object inconsistencies the i18n hook now catches manually). XL.
- **Unit tests** — zero unit tests today. Project is UI-heavy so e2e would matter more (Playwright / Spectron). Start with auth flow + i18n consistency + rack drag-drop (the bug-prone bits). L.
- **Storybook for CSS** — with the new `renderer/css/*.css` split, individual modules could be previewed in isolation. M, useful when introducing visual regressions.

---

## 🤝 Conventions

When picking up a 🚧 item:
1. Read the corresponding `docs/<topic>/NEXT_STEPS.md` first if one exists.
2. Move it from 🚧 to ✅ when shipped, with the version it landed in.
3. Add the changelog entry to README.md (under the new version section).
4. If the work uncovers new TODOs, add them here — don't let them rot in a code comment.

When adding to 🏅 / 🌱:
- Be specific. Vague ideas (*"improve UX"*) get pruned.
- If you have a rough approach, write a one-liner. If not, leave it as a question.

When pruning:
- Items here for >12 months with no movement → either move to ✅ ("decided not to do") or to a separate `docs/parked/` doc with the reasoning.
