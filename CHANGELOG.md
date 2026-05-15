# Changelog

All notable changes to Tiger Studio Manager are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

---

## v1.7.0 — 2026-05-15

### DB pipeline — unified reference data layer
- **`tigertagDbService`** is now the single source of truth for all TigerTag reference JSON files (brands, materials, aspects, types, diameters, units, versions). The renderer loads these via IPC (`window.electronAPI.db.getLookups()`) instead of direct `fetch()` calls, so both the inventory view and the live printer integrations draw from the same data.
- **`assets/db/tigertag/`** — reference files relocated to `assets/db/tigertag/id_*.json` (official TigerTag naming). A `last_update.json` timestamp file is bundled alongside so the app knows the embedded data's age from day one.
- **GitHub mirror fallback** — `tigertagDbService` tries the TigerTag API first; if unreachable it falls back to the auto-synced GitHub mirror (≤ 6 h stale). Offline users still get their last cached copy from `userData/db/tigertag/`.
- **Atomic writes with JSON validation** — every dataset is validated (non-empty array, each entry has `id`) before overwriting the local cache file. A truncated or malformed API response is rejected; the previous good file is kept intact.
- **First-launch seed** — on a fresh install, `tigertagDbService` reads `last_update.json` bundled in `assets/db/tigertag/` and seeds the metadata store so the app skips unnecessary network downloads for data that shipped with the installer.

### Bambu Lab — filament edit sheet redesign
- **ISO layout** — the Bambu filament edit bottom-sheet now matches the Snapmaker / FlashForge / Elegoo design: two rows only (Filament + Color), no summary bar, no close ✕ button, no horizontal separators.
- **Auto-close on color select** — picking a color from the preset grid or the OS color picker closes the color sub-sheet automatically (150 ms delay, same behavior as other brands).
- **Title corrected** — sheet is now labeled "Edit filament" instead of the previous "Change filament".

### i18n
- Added **`snapState_idle`** key across all 9 locales (EN/FR/DE/ES/IT/ZH/PT/PT-PT/PL) — resolves the raw-key label that was showing in the Bambu Lab printer state badge.

---

## v1.6.0 — 2026-05-14

### Elegoo — full MQTT live integration
- **Real-time MQTT connection** on port 1883 (plain TCP). UDP discovery on port 52700 auto-detects Elegoo printers; manual IP entry is the fallback.
- **Job card** — active filename, progress bar + percentage, estimated remaining time, layer counter (`current / total`), print thumbnail, and state badge (`printing`, `paused`, `complete`, `standby`, …).
- **Temperature card** — nozzle `current / target°C`, bed `current / target°C`, chamber temperature; heating indicator when target is set and sensor is below threshold.
- **Filament card** — mono-extruder mode (`Ext.`) and Canvas hub 4-slot mode (`S1`–`S4`); each slot shows colour square, material type, vendor, and filament name. Partial MQTT updates (method 6000 `mono_filament_info`) merge only the fields present in the payload — existing data is preserved.
- **Control card** — jog pad with XY circle (4-direction buttons + sector highlight + centre home-XY), Z pill (Z↑ / home-Z / Z↓), X/Y home pill, step selector (0.1 / 1 / 10 / 30 mm), print-speed selector (Silent / Normal / Sport / Ludicrous), current-position display (X / Y / Z), LED toggle, and folder button.
- **Fan cards** — Model / Aux / Case fans as three compact column cards each with icon toggle, − / % / + step buttons (±10% per step).
- **Files sheet** — two tabs: Print History (thumbnails + filename + duration) and Files (printer-side file list). Refresh reloads the active tab without closing the sheet.
- **Filament edit sheet** — colour preset grid + custom hex picker, material type list, vendor picker, summary preview, sends correct MQTT payloads (method 1055 for mono, method 2003 for Canvas).
- **No-flash control card** — surgical DOM patch on every MQTT tick: fan percentages, LED state, and XYZ position are updated in-place without re-creating the control card DOM.
- **i18n** — all UI strings covered across 9 locales (EN / FR / DE / ES / IT / ZH / PT / PT-PT / PL).

### Bambu Lab — live integration
- **MQTTS connection** on port 8883 (TLS). Auth via printer access code (entered once). Requires "LAN mode" enabled on the printer.
- **Job card** — filename, progress bar, estimated remaining time, layer counter, and print state.
- **Temperature card** — nozzle, bed, and chamber temperatures with heating indicators.
- **Filament / AMS card** — row 1 is `[Ext.] [A1][A2][A3][A4]`; additional rows for extra AMS units. AMS humidity and temperature shown when a single module is connected.
- **Camera widget** — JPEG stream from the printer's built-in camera.
- **Online badge** — driven by the MQTT connection state, shown in the printer grid and side panel.

### UI polish — printer live blocks
- Elegoo control card — borders removed for a cleaner look; home buttons keep orange hover/active state.
- Fan cards — columns layout (one card per fan), no borders, 8 px gap between cards.
- Filament mono slot — `Ext.` alone capped to `max-width: calc((100% - 32px) / 5)` so it renders at the same size as one slot in a full Ext. + AMS row.

---

## v1.5.0 — 2026-05-11

### TigerScale — live WebSocket panel
- **Connect / disconnect toggle** on each scale card. Manual disconnect suppresses auto-reconnect.
- **WS event log** — collapsible strip showing the last 80 events (connect, raw frames, errors, retries) with direction arrows and per-line timestamps.
- **CORS fix** — removed the pre-connect `fetch()` ping (blocked by Chromium CORS in Electron). `connectScaleWs` now opens the WebSocket directly; `onclose` handles retries.
- **Field-name fix** — WS parser corrected from snake_case to the actual camelCase fields the firmware sends (`netWeight`, `scaleStatus`).
- **Gradient live card** — shows live data with a purple gradient matching the TigerScale mobile app. Hidden when WS is disconnected; reappears on reconnect.
- **Send-status badge** — maps `scaleStatus` firmware values (`idle`, `scanning:N`, `stable:N`, `send`, `success`, `error`, `done`, `ready`) to emoji + text with per-state background colours.
- **Filament mini-panel** — colour dot, brand, and material. Appears only when the firmware sends non-empty brand or material; clears automatically when `scaleStatus` becomes `"ready"`.
- **Weight display** — 56 px bold weight number with unit.
- **UID reader grid** — 2-column grid (Left reader / Right reader). `resolve()` fills the empty slot with the twin UID in green.
- **TARE hold-to-confirm** — 1-second press fills a white progress bar then POSTs `/api/tare`. Button hidden when disconnected.

### Elegoo — thumbnail correlation fix
- History thumbnail responses are now correlated by `_historyThumbPendingFn !== null` rather than by request ID. The Elegoo firmware echoes the method number (1045) as the response `id` — not our incremental request ID — so ID-based matching never worked and thumbnails were silently dropped.

---

## v1.4.15 — 2026-05-09

### Creality live integration
- Real-time WebSocket connection on port 9999 with automatic heartbeat (polling every 2 s).
- Live nozzle, bed, and enclosure temperatures; print state (`idle` / `printing` / `finished`), job progress bar, layer counter, estimated duration.
- **CFS colour grid** — activated when `cfsConnect=1` and `materialBoxs[]` is non-empty; shows each slot's assigned colour pill and material label.
- **WebRTC camera** — inline `<iframe>` at `http://$ip/webcam/webrtc` when `webrtcSupport=1`.
- **Print thumbnail** — fetched from `http://$ip/downloads/original/current_print_image.png` while a job is active.
- WS event log with Pause / Clear / row-expand, same UI as Snapmaker and FlashForge.
- Online / Offline badge driven by a lightweight WS probe (30 s TTL).

---

## v1.4.14 — 2026-05-08

### Add Product — multi-colour picker (Mono / Dual / Tri / Rainbow)
- New **Mono / Dual / Tri / Rainbow** selector in the colour picker bottom-sheet. Tap a colour square to switch the active slot, then pick its colour.
- The colour circle updates in real time: solid (Mono), hard half-split (Dual), conic-gradient sectors (Tri), smooth linear-gradient (Rainbow).
- Selecting a mode auto-sets `id_aspect2` to the matching aspect. The link is bidirectional — changing the aspect2 dropdown also flips the mode selector.
- `color_r2/g2/b2` and `color_r3/g3/b3` now written from the actual slot colours picked.

### Version / protocol filter
- The **Type** quick-filter in the inventory toolbar now filters by **protocol version** (TigerTag / TigerTag+ / TigerTag Cloud / TigerTag Init / …) instead of filament product type.

### Search & filter reset on instance switch
- The search bar and all quick-filters are now automatically cleared when switching between accounts or entering / leaving a friend's inventory view.

---

## v1.4.13 — 2026-05-07

### Custom product image for DIY & Cloud spools
- **`url_img` + `url_img_user: true`** — DIY and Cloud spools can now carry a product image from an external URL. TigerTag+ spools are not editable.
- **Edit pill in the colour square** — expands rightward on click to reveal the URL input and a confirm button. `Enter` = confirm, `Escape` = dismiss.
- **Toolbox entry** — when a valid user image is already set, the edit action moves to the spool toolbox.
- **Broken-link recovery** — `onerror` handler detects failed image loads, swaps in the colour placeholder, and surfaces the edit trigger.
- **Add Product integration** — the ADP advanced section has an image URL field.

### Toolbox — Clear TD value
- New split-button on the "Scan TD" toolbox row: a hold-to-confirm trash button (1 200 ms) appears to the right when `r.td != null`. Holding it deletes the `TD` field via `FieldValue.delete()`.

### Add Product panel — TD1S sensor button
- TD1S icon added to the ADP header. **Not connected** → opens the TD1S connect modal. **Connected** → glows green; scanning a filament auto-fills the colour HEX and TD value fields.

### Stats bar — TigerTag Cloud counter
- New purple stat tile ("TigerTag Cloud") always visible in the inventory header bar. DIY count now correctly excludes Cloud entries.

### Window chrome
- **Dark title bar** — `nativeTheme.themeSource = 'dark'` forces the native macOS/Windows title bar to dark mode.
- **No window shadow** — `hasShadow: false` removes the OS-level drop shadow along window edges.
- **Update status icon** — sits to the right of the cloud health indicator. Orange + spinning during download; green + glow when ready. Clicking the green icon triggers the install.
- **Panel shadow bleed fix** — `detail-panel`, `sfe-sheet`, and `rp-side` were leaking `box-shadow` outside the viewport when off-screen. Shadow now applied only on `.open` / `.is-open` state.

---

## v1.4.12 — 2026-05-06

> 🌥️ **The big one: TigerTag goes Cloud.** Create a filament in your inventory without owning an RFID chip. When you eventually program a chip, the doc is atomically renamed to its real hex UID — all fields, twins, rack assignments, and friend ACLs follow with no manual effort.

### TigerTag Cloud — third tier
- **100 % digital filaments** — the Add Product side panel writes a complete inventory entry with a `CLOUD_<10-digit>` doc id. Same schema, same fields, same display surfaces, same friend-sharing rules as chip-backed spools.
- **Promotion path** — when a physical chip is programmed, the `uidMigrationMap` rename pipeline carries the document over atomically. Twin pointers, rack assignments, weight history, friend ACLs — everything follows the rename. Idempotent.
- **New tier label "TigerTag Cloud"** — sits alongside TigerTag+ (orange) and TigerTag (grey). Cloud takes precedence when both signals would apply. Shown across table row, grid card, panel image overlay, and panel details footer.
- New CSS class `.tag-cloud` — purple gradient (`#7c4dff → #a37bff`).

### Add Product — full HSV colour picker
- Anthracite preset sheet matching the Brand / Material sheets.
- Custom slot shows the current colour as background.
- Custom-colour bottom-sheet rebuilt as an HSV picker: hex input row, saturation × value rectangle, hue slider, colour preview circle, OK button.
- Live main-circle update while dragging the SV thumb / hue slider / typing.

### Add Product — RFID Data debug surface
- Gated to `state.debugEnabled` (admin only). Non-admin users never see the section.
- Moved out of Advanced mode — always visible to debug users.
- Switched to the canonical `<details class="debug">` pattern with `pre.json` dark theme.

---

## v1.4.11 — 2026-05-05

### FlashForge live integration
- **HTTP polling** — 2 s tick on `POST /detail`, bridged through the Electron main process to bypass CORS. Capped exponential backoff on network errors (2 s → 30 s).
- **Camera (MJPEG)** — edge-to-edge `<img>` stream. Handles mjpg-streamer's 1-client limit: cache-buster on open, explicit tear-down on close, graceful fallback + Retry button on error.
- **5-slot matlStation grid** — `[Ext.] [1A] [1B] [1C] [1D]`. Ext. → `indepMatlInfo`; bays → `slotInfos[1..4]`. Three visual states per slot: filled (solid fill), configured-but-empty (coloured inset ring), unconfigured (grey hatch).
- **Auto SN-prefix** — auto-prefixes `SN` when the entered serial is missing it. Idempotent.
- **Request log (debug mode)** — every poll pushes an outbound + inbound entry. Click to expand JSON; Pause / Clear toolbar; capped at 100 entries (FIFO).

### UX — Inventory toolbar redesign
- **View selector moved below the search bar** — own dedicated row under the search, keeping its full width regardless of how wide the filters above end up.
- **Search input — clear button (✕)** — appears on the left of the magnifier icon as soon as the input contains a value.

---

## v1.4.10 — 2026-05-05

Hot-fix release for the Windows auto-updater.

- **Windows auto-update fixed.** `build.publish.publisherName: null` set to skip publisher-name verification on Windows (the SHA-512 hash check from `latest.yml` still enforces integrity). Fixes the `Could not check: New version is not signed by the application owner` error that blocked v1.4.9 auto-updates.
- **Mobile-app prerequisite warning** added to the inventory format upgrade consent modal — a small amber banner reminds the user to update their TigerTag mobile app to v1.0.3+ before continuing.

---

## v1.4.9 — 2026-05-04

Quality-of-life release. Three internal-tooling improvements and one user-visible bug fix found by the new tooling on its first run.

### i18n bug fixes
- `autoUnstorageTitle` and `autoUnstorageSub` were missing from `zh.json` and `pt-pt.json`.
- Five duration keys (`agoMin`, `agoHour`, `agoDay`, `agoMonth`, `agoYear`) now use the same plural-object structure (`{one, other}`) across all 9 locales.

### Internal tooling
- **`npm run i18n:add`** — single command adds or updates one i18n key across all 9 locale files.
- **`npm run i18n:check` + pre-commit hook** — validates locale consistency on every commit. Wired automatically via `core.hooksPath=.githooks/` from the `prepare` script.
- **CSS modularization** — the 8047-line monolithic `inventory.css` split into 8 themed files under `renderer/css/` (`00-base.css` through `70-detail-misc.css`).

---

## v1.4.8 — 2026-05-04

Discovery, repair & ergonomics release.

### Snapmaker LAN discovery
- **Side-panel scan** — slides in from the right. mDNS browse of `_snapmaker._tcp.local.` via `bonjour-service` (IPC bridge `mdns:browse-snapmaker`), plus port-scan fallback on Moonraker port 7125.
- **Per-source batch sizing** — local subnets with batch=24, user-declared extra subnets with batch=4 + 80 ms inter-batch gap.
- **One-click add** — writes the printer doc to Firestore and opens the new printer's detail card with the WebSocket already connecting.
- **Add by IP** collapsible — live IPv4 validation, "Validate" probe, "Continue anyway" fallback.
- **Debug-only scan log** — full journal exportable as JSON.
- **Settings reconnect** — saving an IP change tears down the old WebSocket and reconnects.

### Twin-pair manual repair
- **Repair tool** in the spool detail panel toolbox when the spool isn't paired AND at least one compatible candidate exists.
- **Strict candidate filter** — same `id_brand` + `id_material` + `id_type` + `id_tigertag` + exact RGB. Excludes already-paired and tombstoned rows.
- **Atomic batch write** — `twin_tag_uid` cross-referenced on both docs in a single Firestore batch.
- **Debug-only Unlink** — hold-to-confirm "Unlink" tool when Debug mode is on.

### Spool toolbox (detail panel)
- Bundles: Scan colour (TD1S), Scan TD (TD1S), Link/Unlink twin, Remove from rack, Delete.
- Apple-style row design — borderless soft surface, capsule shapes, hold-to-confirm fill animation for destructive actions.

### Rack management
- **Drop-to-void unassign** — dragging a spool outside any rack card sends it back to the unranked panel.
- **Eject animation** reuses `rp-slot-cascade-out`, matching auto-store / auto-fill visual grammar.
- **Empty-spool handling in unranked** — visible but excluded from every count.
- **Per-spool "Remove from rack"** in the toolbox (hold 1.5 s).

### Filament slot UI (Snapmaker live block)
- Cleaner colour square layout — BASE material only in the square, full identity below.
- **Read-only filament sheet** — same layout as editable mode; `<select>` and "Apply" are `disabled`.

---

## v1.4.7 — 2026-05-04

Major release — 3D Printer integration as a first-class citizen.

### Printer management
- **New "Printers" tab** — drag & drop grid of all printers across 5 brands. Per-card: photo, brand pill, model, online/offline indicator (HTTP ping every 30 s).
- **Side card** — slides from the right; hero shows static photo or live WebRTC camera for Snapmaker.
- **"Add a printer" flow** — brand picker → form. Brand-aware model picker with thumbnails. Written to `users/{uid}/printers/{brand}/devices/{auto-id}` in Firestore.
- **Inline editing in the side card** — every field editable on click; Enter / blur saves to Firestore.

### Snapmaker live integration (Moonraker WebSocket)
- WebSocket to `ws://{ip}:7125/websocket`, JSON-RPC subscribe, capped exponential backoff.
- **Camera** — full-width WebRTC iframe at the top of the side card.
- **Print job card** — preview thumbnail, filename, percentage, elapsed time, progress bar, state pill, layer counter.
- **Temperature row** — compact pills per extruder + bed, red when heating.
- **Filament grid** — 4 large coloured squares (one per extruder), tap-to-edit with pencil / eye icon.
- **Inline filament editor** — bottom sheet: Summary, Filament picker (vendor × material), Color picker (5×5 grid + OS-native custom), Sub-type `<select>`.
- **Request log** (debug mode) — every WS frame in / out, pause / clear, custom JSON send.

### Storage data — schema migration
- `rack_id` / `level` / `position` top-level fields repackaged into a nested `rack: { id, level, position }` sub-object. Same UX pattern as the v1.4.5 UID migration. Twin-aware — every rack write mirrors to the linked twin's doc in the same atomic batch.

---

## v1.4.6 — 2026-05-03

Hot-fix — Windows packaging.

- **Windows artifact name standardised.** `win.artifactName` set to `Tiger-Studio-Manager-Setup-${version}.${ext}` (space-free). Fixes the auto-updater 404 that resulted from GitHub's space→dot rewrite disagreeing with electron-builder's dash encoding in `latest.yml`.
- **Windows code-signature check temporarily disabled.** `nsis.publisherName: []` added. electron-builder was auto-deriving the publisher name from the macOS Apple Developer ID, which never matches the unsigned `.exe`. SHA-512 + size check from `latest.yml` is still enforced.

---

## v1.4.5 — 2026-05-03

- **Google sign-in via Touch ID / passkey.** Loopback OAuth flow (RFC 8252 + PKCE) — the system browser opens for auth so Touch ID, passkeys, and hardware keys work natively. System browser brought back to foreground automatically after the handshake.
- **Lazy on-the-fly migration of legacy decimal spool ids → hex uppercase.** Idempotent, atomic per spool (single Firestore batch per migration), polite (250-500 ms gap between writes). `users/{uid}/uidMigrationMap/{decimal_uid}` serves as a bridge for in-flight legacy UIDs.
- **Migration consent + progress UI.** Consent modal shows spool count + estimated duration; lock-screen progress modal during the sweep. Cmd+Q during migration intercepted by main process — native dialog asks for confirmation before quitting.
- **TigerScale v2 schema cutover.** New field names: `last_heartbeat_at`, `display_name`, `current_spool_uid_1/2`, `wifi_signal_dbm`, `power_source`, `battery_percent`, `is_charging`, `hardware_revision`.
- **Twin-pair display on the TigerScale side-card.** Two tags that reference each other via `twin_tag_uid` render as a single physical spool card.
- **Friend banner repositioned** — the READ-ONLY pill now lives in the top header (left of KPI stats). Own-user mode shows a random welcome greeting instead.
- **Sidebar avatar — swap-back affordance** — a ⇄ badge appears when a friend's inventory is being previewed. The whole avatar acts as a one-click "return to my own inventory" button.

---

## v1.4.4 — 2026-05-02

- **Auto-update toggle.** New "Updates" section in Settings — enable / disable automatic update downloads, and a "Check for updates now" button. Preference persisted to `<userData>/auto-update.json`.
- **Settings panel rebuilt.** Flat panel with hairline-separated sections — Updates / Data / Tools / About — replacing the old card-in-card layout.
- **Top header KPI stats.** 4 stat tiles (Spools / Stock / TigerTag / TigerTag+) moved from the sidebar to the top of the main pane.
- **Storage — `EMPTY` stat for depleted spools.** Slot "Empty" → "Free"; spool "Depleted" → "Empty".
- **Spool detail — Storage location row.** Shows `Rack name · A3` for placed spools; **Auto-assign** button for unplaced spools.
- **Auto Storage + Auto Unstorage** toggles — snapshot-driven, `_inFlight` flag prevents loops.
- **Sidebar — friends quick-access list.** Friends appear under the Friends button as flat rows (avatar + name); click switches the inventory view to that friend's read-only inventory.
- **Readable initials on light avatar colours.** `readableTextOn(bg)` helper computes WCAG relative luminance and switches initials to `#1a1a1a` on light backgrounds.

---

## v1.4.3 — 2026-05-02

Storage view major UX overhaul.

- **Stats bar** — pill tiles: total racks, filled-vs-total slots (mini progress bar), empty count, locked count, clickable "Not Stored" tile. Empty / Locked tiles double as filter chips.
- **Inline rack header** — `Rack 4 · 5/5` on a single line.
- **Kebab menu (⋮)** — per-rack actions: Edit · Auto-fill · Lock all / Unlock all · Clear all · Delete.
- **Press-and-hold for destructive actions** — 1.2-second hold for Clear all and Delete.
- **Visible drop zones during drag** — valid slots pulse, locked slots dim, target slot pops with orange ring + scale-up. Swap targets show `⇄` glyph overlay.
- **Slot animations** — bounce-in on land, staggered 30 ms auto-fill wave, cascade-out for clear-all.
- **Skyline masonry layout** — racks pack tightly into available width; recomputes on resize via `ResizeObserver`.
- **Rich hover tooltip on filled slots** — brand, material · color name, coordinate badge, weight bar.
- **+ New Rack as a stat tile** — first tile of the stats bar, dashed border, `+` glyph.

---

## v1.4.2 — 2026-05-02

- **CI — macOS code signing + notarization.** Releases signed with Apple Developer ID Application + notarized via `notarytool`. No Gatekeeper warning on download. Certificate and App Store Connect API Key decoded from GitHub Secrets at build time.
- **Native modules** (`@pokusew/pcsclite`, `@serialport/bindings-cpp`) correctly signed inside the bundle via `entitlementsInherit` and `cs.disable-library-validation`.
- New `build:mac:unsigned` script for fast local builds without Apple credentials.

---

## v1.4.1 — 2026-05-01

- **Fix — silent login failure on email/password** sign-in. Auth listener was gated on `getActiveId()` matching the new uid, but `setActiveId()` only ran inside the listener. Reordered: `setActiveId` runs after `updateCurrentUser` and before `setupNamedAuth`.
- **Diagnostic report system.** Every caught auth/network error and every `window.error` / `unhandledrejection` captured into a circular buffer. Copy a Markdown report from **Settings → Debug → Report a problem** — includes app version, Electron/Chrome/Node, OS, locale, account count, and the last 50 errors with stack traces.
- Storage / Rack feature gated off in this build until the visualisation skeleton is finalised.
