# Tiger Studio Manager

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
- **3D printer management** — Dedicated "Printers" tab with a drag-and-drop grid of all your printers across the 5 supported brands (Bambu Lab / Creality / Elegoo / FlashForge / Snapmaker); per-brand "Add" flow with model picker, side card with editable connection details, and online / offline indicator driven by an HTTP ping
- **Snapmaker live integration** — Real-time WebRTC camera, live extruder + bed temperatures, filament data per slot (color, brand, material) with click-to-edit, and active-print job card (preview thumbnail + progress + state + layer counter) over the Moonraker WebSocket
- **Snapmaker LAN discovery** — Side-panel scanner that finds Snapmaker printers on the local network: instant mDNS browse on `_snapmaker._tcp.local.` (TXT record carries IP / model / device name / serial), parallel Moonraker port-scan as fallback (port 7125 with `/printer/info` + `/server/info` + `/machine/system_info`), per-source batch sizing (24 on local LAN, 4 on user-declared extras to survive anti-scan firewalls), brand-confirmed candidates only (`machine_type` containing "Snapmaker"), one-click add that writes the printer doc directly to Firestore and opens its detail panel, plus inline "Add by IP" with live IPv4 validation
- **Twin-pair manual repair** — User-assisted tool to link two RFID tags that the auto-linker missed (timestamps drifted > 2 s at programming). The spool detail panel offers a "Link to a twin spool" picker filtered to candidates with the same brand, material, type, version (`id_tigertag`) and exact RGB; one click writes `twin_tag_uid` cross-referenced on both docs in a single Firestore batch. Empty when no compatible candidate exists, hidden when already paired
- **Spool toolbox** — Action-bundling section in the spool detail panel: scan colour with TD1S, scan TD with TD1S, link to a twin spool (when applicable), remove from rack (when placed) with eject animation, and delete (hold-to-confirm). Contextual visibility — empty rows are skipped so the toolbox never shows a button without a target
- **Rack drag-to-void** — Drop a spool anywhere outside a rack card to unassign it. Slot uses the same cascade-out animation as Empty rack, the spool bounces in at its new home in the unranked panel — same visual grammar as auto-store / auto-fill
- **Multi-language** — EN, FR, DE, ES, IT, PL, PT (Brasil), PT (Portugal), 中文 — switch any time from the account modal
- **Auto-updater** — Receives updates automatically via GitHub Releases
- **Diagnostic report** — Built-in error-capture system: every uncaught error is logged with its stack and context. Users can open **Settings → Debug → Report a problem** (or the same link inside the Sign-in modal) to copy a self-contained Markdown report — app version, Electron/Chrome/Node versions, platform, locale, and the last 50 errors with stack traces — to send to support
- **Cross-platform** — Windows, macOS (Intel + Apple Silicon), Linux

---

## Changelog

### v1.4.9 — 2026-05-04

Quality-of-life release. Three internal-tooling improvements that make the codebase healthier going forward — and one user-visible bug fix that was found by the new tooling on its very first run.

#### i18n bug fixes (user-visible)
- **Missing translations** — `autoUnstorageTitle` and `autoUnstorageSub` (the toggle row in Storage view that tells the rack to free a slot when a spool reaches 0 g) were missing from `zh.json` and `pt-pt.json`. Chinese and European-Portuguese users saw the raw `[autoUnstorageTitle]` key as a fallback string. Both keys are now translated natively (`自动取出` / `线轴为 0g 时自动释放槽位`, `Remoção auto` / `Liberta o espaço quando a bobine chega a 0g`).
- **Plural inflection consistency** — five duration keys (`agoMin`, `agoHour`, `agoDay`, `agoMonth`, `agoYear`) were a flat string in some locales and a `{one,other}` plural object in others. Renderer's `t()` already supports both forms so nothing was broken at runtime, but the inconsistency would eventually have caused a singular-vs-plural mismatch in a future feature. All 9 locales now use the same plural-object structure (`vor 1 Tag` vs `vor 5 Tagen`, `1 giorno fa` vs `5 giorni fa`, etc., with proper inflection where the language requires it).

#### Internal tooling
- **`npm run i18n:add`** — single command that adds (or updates) one i18n key across all 9 locale files in one shot. Validates JSON before committing any write, falls back to the EN value when a locale is missing with a stderr warning, supports `--after <anchorKey>` for grouped insertion. Replaces the previous workflow of editing 9 JSON files by hand.
- **`npm run i18n:check` + pre-commit hook** — validates that every locale file is consistent with `en.json`: same key set (no missing, no extras), same value type per key (plurals stay plurals), no empty strings, valid JSON. Wired as a pre-commit hook via `.githooks/pre-commit` (activated automatically by the npm `prepare` script which sets `core.hooksPath=.githooks/`, no husky dependency). Drift in any locale now blocks the commit with a clear per-file error report. The check itself runs in ~50 ms.
- **CSS modularization** — the 8047-line monolithic `renderer/inventory.css` is now split into 8 themed files under `renderer/css/` (`00-base.css` through `70-detail-misc.css`), loaded in numeric cascade order. Largest file is 1836 lines (was 8047). Bytes-identical with the original (verified by SHA1 before the per-file headers were added) and asset URLs adjusted from `'../assets/...'` to `'../../assets/...'` since CSS now lives one directory deeper.

---

### v1.4.8 — 2026-05-04

Discovery, repair & ergonomics release. Adds Snapmaker LAN auto-discovery, manual twin-pair repair for spools the auto-linker missed, a unified spool toolbox, and several rack-management refinements.

#### Snapmaker LAN discovery (Add Printer → Snapmaker)
- **Side-panel scan** sliding in from the right — same width as the printer detail panel for visual continuity. Replaces the previous centred modal so the user can keep an eye on the rest of the app while scanning.
- **mDNS browse** of `_snapmaker._tcp.local.` via `bonjour-service` (lazy-loaded in main process, IPC bridge `mdns:browse-snapmaker`). The TXT record published by stock Snapmaker firmware carries `ip` / `machine_type` / `device_name` / `sn` / `version` — enough to render a candidate card without any HTTP probe. Browses for 2.5 s; instant on healthy single-VLAN networks.
- **Port-scan fallback** when mDNS multicast is filtered (typical multi-VLAN setup without an Avahi reflector). Iterates discovered subnets (IPC `os.networkInterfaces()` + WebRTC ICE candidates + user-declared extras) in parallel batches, hitting `/printer/info` + `/server/info` + `/machine/system_info`. The latter is the gold-standard identification source — `machine_type` (e.g. "Snapmaker U1") + `device_name` (user nickname) + `serial_number` + `firmware_version` are extracted with a strict "machine_type contains Snapmaker" filter so generic Moonraker hosts (Voron, Bambu-Klipper, Creality K1) get logged in debug as ambiguous but never appear in the result list.
- **Per-source batch sizing** — local subnets scan with batch=24 (no firewall in the way), user-declared "extra subnets" scan with batch=4 + 80 ms inter-batch gap (gentle enough to survive UniFi/OPNsense IDS/IPS that flag bursts as port-scan attacks). When an extra subnet finishes in < 4 s with 0 hits, the empty state shows a firewall-block hint pointing at "Add by IP".
- **One-click add** — clicking a candidate writes the printer doc directly to Firestore (`users/{uid}/printers/snapmaker/devices/{auto-id}`) with the full discovery payload preserved under `discovery` (raw mDNS TXT + raw HTTP responses + derived identity), then closes the scan panel and opens the new printer's detail card with the WebSocket already connecting. No form, no confirmation step.
- **Add by IP** collapsible — inline IPv4 validation, error bubble on invalid format, "Validate" button that probes the typed IP and pre-fills the printer using whatever the device returned. Falls back to a "Continue anyway" path when the host doesn't reply.
- **Extra subnets** widget — persisted in `localStorage` (`tigertag.snapScanExtraSubnetsKey`) so a once-declared `192.168.40` keeps being scanned on every future run. Validation rejects loopback / link-local / multicast prefixes.
- **Debug-only scan log** — every step (mDNS browse, IPC subnet, WebRTC discovery, user extras, scanning ranges, hits, ambiguous Moonraker hosts, scan completion timing) lands in an in-memory journal. The "Export" button copies a self-contained JSON dump (meta + environment + log entries) to the clipboard so users can share their network state for support tickets.
- **Settings reconnect** — saving printer settings with a changed IP automatically tears down the old WebSocket and reconnects with the new address; idempotent when other fields change.

#### Twin-pair manual repair
- **Repair tool** for cases where the factory programmer left > 2 s between writing the two halves of a twin pair, breaking the existing `autoLinkTwinsByTimestamp` heuristic. The spool detail panel now exposes a "Link to a twin spool" entry in the toolbox when the spool isn't paired AND at least one compatible candidate exists.
- **Strict candidate filter** — same `id_brand` + `id_material` + `id_type` (Filament / Resin) + `id_tigertag` (TigerTag / TigerTag+) + exact RGB triplet. Excludes spools already paired and tombstoned rows. Shown as a list of cards with colour swatch, brand, material, and the candidate's RFID UID.
- **Atomic batch write** — `twin_tag_uid: B.uid` on A, `twin_tag_uid: A.uid` on B, single Firestore batch with `serverTimestamp()` `last_update`. The rest of the codebase (`writeWithTwin`, `hasTwinPair`, twin badge, "This tag" / "Twin tag" raw JSON tabs) picks up the pair on the next snapshot with no further glue.
- **Debug-only Unlink** — when Debug mode is on, a paired spool exposes a hold-to-confirm "Unlink" tool in the toolbox that clears `twin_tag_uid` on both docs.

#### Spool toolbox (in the detail panel)
- New **Toolbox** section bundles every action available on a spool — Scan colour (TD1S), Scan TD (TD1S), Link/Unlink twin, Remove from rack, Delete. Each row uses native `disabled` attributes when the prerequisite isn't met (TD1S not connected → opens the connect modal first).
- **Apple-style row design** — borderless soft surface, capsule shapes, hover bg only, hold-to-confirm fill animation in the row itself for destructive actions (Remove from rack with amber palette, Delete with red palette).
- **Contextual visibility** — Remove from rack only appears when the spool is placed; Link only when there are compatible candidates; the previously-bottom Delete button moved into the toolbox so all spool-level actions live in one place.

#### Rack management
- **Drop-to-void unassign** — dragging a spool out of a rack slot and dropping it ANYWHERE outside a rack card sends it back to the unranked panel. The cursor must be strictly outside every `.rp-rack` (slot padding / titles / inter-slot gaps DON'T count) to prevent accidental unassigns when lifting a spool a few pixels then dropping it back on the same rack.
- **Eject animation** for the void-drop reuses the existing `rp-slot-cascade-out` keyframe (the same one Empty Rack fires on every slot at once), and the landed spool bounces in at its new home via `_justPlacedSpools` — same visual grammar as auto-store / auto-fill.
- **Empty-spool handling in unranked** — spools with `weight_available ≤ 0` stay visible in the unranked side panel but are excluded from every count (panel header badge, stats-bar tile, search counter). The unranked panel no longer auto-opens when the active count is 0 — saves screen real estate without overriding the user's persisted preference.
- **Per-spool "Remove from rack"** — a dedicated tool in the spool detail panel toolbox (hold 1.5 s) for users who prefer pointing-and-clicking over drag-and-drop. Same eject animation, same Firestore batch.

#### Filament slot UI (Snapmaker live block)
- **Cleaner colour square layout** — the big coloured square inside each extruder slot now shows the BASE material only (`PLA`, `PETG`, etc.) — no more cluttered "PLA Speed Matt" text-wrap. The full identity (`Type Subtype`) appears below the brand name, matching the hierarchy a user reads from a real spool label.
- **Read-only filament sheet** — clicking an RFID-locked filament slot (eye icon) now opens the bottom-sheet in read-only mode with the SAME layout, order and presentation as the editable mode. The `<select>` and "Apply" button use their native `disabled` state, the title swaps to "Read-only filament", and the sub-picker handlers no-op so even an accidental click doesn't slip through.
- **Card visibility fixes** — the U1's `machine_type` field is reported on `/machine/system_info` (not `/printer/info`), so the scan now interrogates all three Moonraker endpoints and prefers `machine_type` over the old `hostname` codename for model resolution.

#### Printer detail panel
- **Online status moved** under the printer name on its own row (was inline next to the brand pill). The brand + model pills stay on the title row; the online/offline badge sits below in a smaller, muted style.
- **Cleaner hero block** — feature pills (Camera / Multi-extruder / etc.) under the photo were removed; the horizontal separator between the photo (or live camera) and the live block was dropped; padding tightened so the photo flows directly into the print-job card and the temperature row.
- **Print-job card frame removed** — the thumbnail + progress + state + layer counter render flush in the live block (no more border around the card) for a more integrated look.
- **No print-job card when disconnected** — when the WebSocket isn't connected the card is hidden entirely instead of showing a frozen snapshot of stale state.
- **Backdrop click closes everything** — clicking the dim area outside the printer side-panel now also closes the filament-edit bottom-sheet if it's open, instead of leaving an orphan sheet floating after the panel slid out.
- **No more ✕ button** — the printer detail panel and the Snapmaker scan panel now close on backdrop click + Escape only.
- **Toolbox replaces standalone delete + twin-link sections** — see the Spool toolbox section above; the Delete button moved out of its own panel section into the toolbox.

#### Brand picker → Snapmaker direct
- **Choice modal removed** — picking "Snapmaker" in the brand list now opens the Scan panel directly. The previous "+ Scan Add / + Manual Add" intermediate modal was retired since both paths are now exposed inline on the scan panel itself (auto-scan in the background + collapsible "Add by IP" widget).

#### i18n
- ~30 new translation keys across the 9 supported locales for the discovery flow, twin-link picker, toolbox actions, scan log, firewall-block hint, and read-only filament sheet title.

---

### v1.4.7 — 2026-05-04

Major release introducing **3D Printer integration** as a first-class citizen alongside the inventory: a new dedicated tab, full-featured side card, and live Snapmaker U1 telemetry over Moonraker WebSocket. Same generic UI patterns as the rest of the app (drag & drop, slide-in side panels, multi-account, multi-language).

#### Printer management
- **New "Printers" tab** in the main toolbar — flat flex grid of all printers across the 5 supported brands (Bambu Lab, Creality, Elegoo, FlashForge, Snapmaker), drag & drop reordering with persisted `sortIndex` written to Firestore in a single atomic batch. Each card shows the printer photo (resolved from the brand's catalog under `data/printers/<brand>_printer_models.json`), brand pill, model name, and "Online" / "Offline" indicator (driven by an HTTP ping to the printer every 30 s).
- **Side card** sliding in from the right when a printer card is clicked. Shows brand + model pills next to the printer name in the header, plus an online indicator pill, plus a gear button (⚙) to edit the printer. The hero shows the printer photo by default; for Snapmaker printers that are online, the photo is swapped for a live WebRTC camera feed (`http://{ip}/webcam/webrtc` in a sandboxed iframe). Sections include features pills (AMS / Camera / Lidar / Enclosed) resolved from the catalog, raw JSON (debug-only), and brand-specific live telemetry blocks.
- **"Add a printer" flow** — gradient `+` card at the end of the grid opens a 2-step modal: brand picker (5 cards with brand accent colours and connection-method hints) → form. The form is brand-aware — a custom model picker with thumbnails (always pre-selecting the "Select Printer" placeholder so the user can fall back to it), printer name (auto-prefilled from the chosen model on selection), then brand-specific fields (`broker` / `ip`, `serialNumber` / `sn` / `account`, `password` / `mqttPassword` / access code) with eye-toggle reveal and per-field hint text. All values written to `users/{uid}/printers/{brand}/devices/{auto-id}` in Firestore with `serverTimestamp()` `updatedAt`, `sortIndex` set to append-end, `isActive: false`. Same modal pre-filled in edit mode when the gear button is clicked from the side card.
- **Inline editing in the side card** — every field except `id` / `isActive` / `sortIndex` (printer name in the hero, all `connection` and `credentials` rows) becomes editable on click; Enter / blur saves the new value to Firestore with `serverTimestamp()`; Escape cancels.

#### Snapmaker live integration (Moonraker WebSocket)
Read-only telemetry block in the printer side card, live-updated as Moonraker pushes status frames. Iso to the TigerTag mobile companion app's UI.
- **WebSocket connection** to `ws://{ip}:7125/websocket`, opens automatically when the side card opens for a Snapmaker printer with a configured IP. JSON-RPC subscribe to `print_task_config` / `print_stats` / `virtual_sdcard` / `display_status` / `extruder` / `extruder1-3` / `heater_bed`. Reconnect with capped exponential backoff (2 s → 30 s).
- **Camera** — full-width edge-to-edge WebRTC iframe at the top of the side card replacing the static product photo when the printer is online.
- **Print job card** — always visible, with the slicer-rendered preview thumbnail (fetched from `http://{ip}:7125/server/files/metadata`) on the left, filename + percentage + elapsed time + progress bar + state pill ("Printing" / "Paused" / "Complete" / "Error" / "Standby") + layer counter (`current/total`) on the right. Falls back to the printer photo + a muted "No active print" placeholder when idle.
- **Temperature row** — compact pills showing each active extruder + bed (e.g. `26/0°C`) with custom inline SVG nozzle / bed icons; pills turn red when actively heating.
- **Filament grid** — 4 large coloured squares (one per extruder, all on the same row) with the material name centered in luminance-aware contrasting text. Below each square: stacked icon + brand + material. Tap-to-edit: the icon switches between a pencil (editable, manual) and a "view-only" eye when the printer detected an RFID tag (`filament_official === true`).
- **Inline filament editor** — bottom sheet anchored to the side card sliding up from below (z-index above the side card so the printer context stays visible behind). Three stacked sub-sheets:
  - **Summary** — tap-rows for "Filament" (current `Brand Material Subtype`), "Color" (current colour dot), and a sub-type select. Apply button sends a `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=N VENDOR=… FILAMENT_TYPE=… FILAMENT_SUBTYPE=… FILAMENT_COLOR_RGBA=…` g-code via JSON-RPC `printer.gcode.script`. Sub-type is always sent (Snapmaker firmware ignores the call when an arg is missing).
  - **Filament picker** — two-column iso-mobile picker, vendors on the left (8 brands: Generic / JamgHe / Landu / R3D / Rosa3D / Snapmaker / Sunlu / eSun), materials for the selected vendor on the right with priority sort (PLA / PETG / ABS / TPU first). Falls back to the Generic catalog when a vendor has no specific products.
  - **Color picker** — 5×5 grid (24 fixed presets + 1 custom slot). The custom slot is a wrapper containing a transparent `<input type="color">` overlaid on top, so the OS-native picker dialog anchors right to the click position instead of the top-left of the window. Live preview while dragging.
  - **Sub-type** is now a `<select>` populated from `data/id_aspect.json`, defaulting to "Basic" so the user always sends a documented value.
- **Request log** — collapsible section at the bottom of the side card (debug-only) showing every WebSocket frame in / out with timestamp, summary, and full JSON on click-to-expand. Toolbar with **Pause** (freezes incoming frames so the user can inspect a long burst), **Clear**, and a **"Send custom JSON"** paste zone for hand-crafted Moonraker calls. Capped at 100 entries (FIFO).

#### Storage data — schema migration
The `rack_id` / `level` / `position` top-level fields on every spool inventory doc are repackaged into a single nested `rack: { id, level, position }` sub-object. Cleaner schema, easier to find, easier to serialise. The migration uses the same UX pattern as the v1.4.5 UID migration (consent modal → progress modal → silent done state) but with **generic copy** (`migrationConfirmTitle` / `migrationConfirmMsg` / `migrationProgressTitle` / `migrationProgressMsg` / `migrationProgressWarn`) reusable for any future schema upgrade. Studio Manager is the sole client that touches rack data — Flutter mobile and TigerScale firmware ignore these fields — so the migration is safely destructive (`FieldValue.delete()` on the legacy keys). Twin-aware: every rack write across all 5 functions (`assignSpoolToSlot` / `unassignSpool` / `autoFillEmptySlots` / `autoUnstoreDepletedSpools` / `autoAssignSingleSpool`) mirrors the location to the linked twin tag's doc in the same atomic batch. The `where("rack_id", "==", rackId)` queries in `updateRack` / `deleteRack` / `emptyRack` were rewritten to filter `state.rows` (which `normalizeRow` reads schema-agnostically) so they keep working through the migration window.

#### Other
- **Debug mode gates the developer-facing UI** — the printer raw JSON, the Snapmaker request log, and the spool raw JSON are now only rendered when `users/{uid}.Debug === true` (admin-only flag). Toggling the switch in the Edit-account modal re-renders any open side panel immediately so the sections appear / disappear without forcing the user to close & reopen.
- **i18n** — ~80 new keys across all 9 locales for printers (add flow, edit modal, brand picker, model selector), Snapmaker live (status / temperature / filament / job states / log toolbar / paste zone / filament edit sheet), generic migration modal, and the bottom-sheet filament editor.
- **Brand catalog data** committed under `data/printers/{bbl,cre,eleg,ffg,snap}_printer_models.json` with each brand's product line + photo paths under `assets/img/<brand>_printers/`. New SVG icons: `icon_pause.svg`, `icon_printer.svg`.

### v1.4.6 — 2026-05-03

Hot-fix release for two Windows-side issues that surfaced during the v1.4.5 rollout. Same feature set as v1.4.5; only Windows packaging changed.

- **Windows artifact name standardised.** `package.json` `win.artifactName` set to `Tiger-Studio-Manager-Setup-${version}.${ext}`. The default electron-builder NSIS naming used spaces, which GitHub auto-rewrote to dots on upload — but `latest.yml` then referenced the file with dashes (electron-builder's URL encoding), so the auto-updater hit a 404 on every check. With an explicit space-free `artifactName`, all three layers (local `dist/`, asset on the GitHub release, manifest URL in `latest.yml`) now agree. (Existing v1.4.5 release was hot-patched in place by re-uploading the binary under the dashed name.)
- **Windows code-signature check temporarily disabled.** `nsis.publisherName: []` added. electron-builder was auto-deriving the Windows publisher name from the macOS Apple Developer ID `3D France (RT4W5WC9P2)`, which never matches the unsigned `.exe` we currently ship, so electron-updater on Windows was failing every update check with `New version is not signed by the application owner`. With an empty `publisherName` array, the authenticode verification step is skipped — the SHA-512 + size check in `latest.yml` is still enforced, so update integrity is preserved over the HTTPS download. Once Microsoft Trusted Signing for STARGATE GROUP is approved (currently `In Progress` at Microsoft), the `.exe` will be signed and we'll restore `publisherName: ["TigerTag Project"]` (or the actual cert subject) so the check re-engages.

### v1.4.5 — 2026-05-03

- **Google sign-in via Touch ID / passkey.** Replaced `firebase.auth().signInWithPopup()` (whose Chromium popup couldn't reach macOS authd, leaving "Use your passkey" inert) with the loopback OAuth flow (RFC 8252 + PKCE). The system browser opens for the auth step, so Touch ID, passkeys, and hardware keys work natively. After the auth handshake completes, the Electron window is brought back to the foreground automatically. Falls back to popup gracefully if the loopback step fails for any reason.
- **Lazy on-the-fly migration of legacy decimal spool ids → hex uppercase.** Whenever Studio sees an inventory doc whose id is in the legacy decimal big-endian form (e.g. `8307741719072896`), it migrates it to the canonical hex form (`1D895E7C004A80`) in the background. Migration is idempotent, atomic per spool (single Firestore batch per migration: SET hex doc + SET map entry + UPDATE twin partner's `twin_tag_uid` + DELETE decimal doc), polite (250-500 ms gap between writes to stay well within Firestore quota), and safe vs concurrent mobile-app writes. A new `users/{uid}/uidMigrationMap/{decimal_uid}` collection serves as a bridge — any client still holding a legacy decimal UID can resolve it to the canonical hex doc in one read.
- **Migration consent + progress UI.** Two modals coordinate the migration UX:
  - A **consent modal** asks for confirmation before any write, showing the spool count and an estimated duration ("about N seconds" / "about N minutes"). Two buttons: "Update now" / "Remind me later" (re-prompts at next app launch). Fully translated across all 9 locales.
  - A **lock-screen progress modal** shows during the initial sweep (≥ 3 docs) with a progress bar and an explicit "do not close the app" warning. Cmd+Q during this phase is intercepted by the main process — a native macOS dialog asks the user to confirm before quitting mid-migration.
- **TigerScale v2 schema cutover.** The scale heartbeat document at `users/{uid}/scales/{mac}` is now read with the v2 field names: `last_heartbeat_at` (Firestore serverTimestamp), `display_name`, `current_spool_uid_1` / `_2` (twin-pair detection), `wifi_signal_dbm`, `power_source` (enum `ac` | `battery` | `usb` | `poe`), `battery_percent`, `is_charging`, `hardware_revision`. No backward compatibility with v1 names — firmwares writing the legacy `name` / `last_seen` / `last_spool` / `rssi` / `battery_pct` fields will appear offline / unnamed until they ship a v2 update. Full contract documented at https://github.com/TigerTag-Project/TigerTag_Firebase_Integration/blob/main/docs/clients/tigerscale-doc-schema.md.
- **Twin-pair display on the TigerScale side-card.** When two RFID tags are simultaneously present and reference each other via `twin_tag_uid`, Studio renders them as a single physical spool (one card). Two unrelated tags render as two cards.
- **Friend banner repositioned + own-user variant.** The "READ-ONLY" pill that used to sit inside `#card-inv` now lives in the top header, to the left of the KPI stats. Same chip frame in own-user mode shows a random welcome greeting from `t("welcomeBack")` instead of the READ-ONLY badge. Avatar size aligned to the stat tiles' height (50×50). The decorative card frame around the chip was removed for a cleaner top-row look.
- **Sidebar avatar — swap-back affordance.** A small ⇄ badge appears at the bottom-right of the user's own avatar in the sidebar while a friend's inventory is being previewed. The whole avatar acts as a one-click "return to my own inventory" button in that mode. Pointer-events on the badge funnel clicks to the avatar itself.
- **Storage view "Not Stored" tile — double chevron.** Single `›` replaced with a double `»` to better telegraph that clicking opens a side-card. Color inherits the orange of the `.rv-stat-chev` rule.
- **Scale health icon — red when no scale paired.** When `state.scales.length === 0`, the ⚖ icon in the header turns red as a discoverability cue. Stays at default 18px size with no animation per user feedback.
- **Friend-view bug fixed — previous user's data no longer bleeds through.** Three layers of protection: `unsubscribeInventory()` + `unsubscribeRacks()` are called BEFORE any state mutation in `switchToFriendView`, both `subscribeInventory` and `subscribeRacks` snapshot callbacks now have a `state.friendView` early-return guard (defence-in-depth against in-flight buffered events), and `switchBackToOwnView` calls `renderStats()` + `renderInventory()` immediately so the friend's data is wiped from the DOM the same frame the user clicks "swap back". `renderInventory()` also now hands off to `renderRackView()` even on empty/loading state when `viewMode === "rack"` so stale rack DOM is cleared.
- **Initials contrast on coloured avatars.** A new `readableTextOn(bg)` helper computes WCAG luminance via a 1×1 canvas and switches initials text colour to `#1a1a1a` for light avatar backgrounds. Applied to all 10 avatar render sites.
- **i18n.** 9 new keys for migration consent / progress modals, with proper `{{count}}` and `{{duration}}` interpolation, plus pluralised duration formatters (`one` / `other`). All 9 locales (en / fr / de / es / it / pl / pt / pt-pt / zh).

### v1.4.4 — 2026-05-02

- **Auto-update toggle.** New "Updates" section in **Settings** lets the user enable or disable automatic update downloads, and exposes a **Check for updates now** button. The preference persists to `<userData>/auto-update.json`. When enabled, the existing `electron-updater` flow runs on launch and prompts for restart when an update is ready; when disabled, the app stays on the installed version until the user manually checks. (`main.js`, `preload.js`, `renderer/inventory.js`)
- **Settings panel rebuilt.** The old card-in-card layout was replaced by a single flat panel with hairline-separated sections — **Updates / Data / Tools / About** — and inline collapsibles for Data and Tools. The "Export" button became "Settings" (gear icon) and the API URL is now exposed as a read-only field with a one-click **Copy** button.
- **macOS app name fix.** `app.setName('Tiger Studio Manager')` is set before `whenReady` so the About menu, Cmd+Q, and the dock all read the proper product name instead of `tigertag-inventory`. (`main.js`)
- **Top header KPI stats.** The 4 stat tiles (Spools / Stock / TigerTag / TigerTag+) moved from the sidebar to the top of the main pane, replacing the old title block. They now greet the user with at-a-glance numbers immediately on load.
- **Status icons always pinned to the right.** TD1S / Scale / Cloud (and the optional RFID pill) now always sit at the far-right of the top header via `margin-left: auto`, regardless of whether the stats wrap is visible. They no longer drift to the left when stats are hidden during initial load.
- **Storage — `EMPTY` stat for depleted spools.** A new tile counts spools whose remaining weight is 0 g. The two existing labels were renamed to remove a confusion users were running into: slot **"Empty"** → **"Free"** (a free spot in a rack), and spool **"Depleted"** → **"Empty"** (a spool with no filament left). German/French/Spanish/Italian/Polish/Portuguese/Chinese updated in the same edit.
- **Spool detail — Storage location row.** A new section in the spool side panel shows `Rack name · A3` for spools that are placed, and a single **Auto-assign** button for spools that are not. Clicking the location row closes the side panel, switches to the Storage view, and pre-fills the search field with the spool's UID so the slot is found instantly. The auto-assign button places the spool into the next available slot in one click.
- **Auto Storage + Auto Unstorage** toggles in the "Spools not stored" sidecard. When auto storage is on, every newly-detected spool that has no rack assignment is placed automatically; when auto unstorage is on, any spool whose weight drops to 0 g is removed from its slot automatically. Both run snapshot-driven with an `_inFlight` flag so they can't loop.
- **Depleted spools now visible in racks.** Spools at 0 g previously showed `height: 0%` and looked invisible. They now display a 6 px coloured strip plus a "0 g" tag inside their slot, so the user can still see the spool occupies that position. Search hits also get a positive orange ring + animated glow on the matching slot, instead of relying solely on dimming the non-matches.
- **Sidebar — friends quick-access list.** Friends now appear under the **Friends** button in the sidebar as flat rows (avatar + display name), and as avatar-only circles when the sidebar is collapsed. Click switches the inventory view to that friend's read-only inventory; click again to go back to your own view. The list shows a body-appended floating tooltip on hover in collapsed mode (escapes the sidebar's `overflow: hidden`).
- **Sidebar — user header redesign.** The user avatar moved from a centered column to a horizontal row: avatar on the left, "Welcome back" + display name stacked to its right. Reads cleaner and matches the friend chip layout below.
- **Readable initials on light avatar colours.** Initials previously rendered white-on-white when a user picked a near-white custom colour. A new `readableTextOn(bg)` helper computes WCAG relative luminance via a 1×1 canvas and switches the text to `#1a1a1a` on light backgrounds. Applied across all 10 avatar render sites (sidebar, dropdowns, friend chips, profile modal, friends panel, blocklist, friend-request preview, friend-view banner, edit-account modal). Cached per colour for negligible cost.
- **Display name prompt — race condition fix.** On first login, the prompt sometimes fired even when Firestore already had a display name, because `syncUserDoc` was reading from cache. Now uses `{ source: "server" }` plus a 1-second grace period that re-fetches from Firestore before prompting, so users with an existing pseudo are no longer asked again.

### v1.4.3 — 2026-05-02

- **Storage view — major UX overhaul.** The rack management screen has been restructured around a dense, scannable toolbar and tighter spatial logic so users with a dozen+ racks can navigate at a glance.
- **Stats bar.** A row of pill-shaped tiles at the top of Storage exposes the global state in one look: total racks, filled-vs-total slots (with a mini progress bar), empty count, locked count, and a clickable "Not Stored" tile that opens the unranked-spools side panel. The Empty / Locked tiles double as filter chips — clicking them highlights every matching slot across all racks with an animated orange ring.
- **Inline rack header.** Each rack card now shows `Rack 4 · 5/5` on a single line (name + counter), saving vertical space. The counter dims to muted grey so the rack name remains the dominant element.
- **Kebab menu (⋮).** Per-rack actions moved into a contextual menu that fades in on rack hover: Edit · Auto-fill · Lock all / Unlock all · Clear all · Delete. Reduces visual noise at rest, surfaces all actions when needed.
- **Press-and-hold for destructive actions.** Both *Clear all* and *Delete* in the kebab menu require a 1.2-second hold (with an animated progress bar filling left-to-right) before firing — a misclick can no longer wipe a rack or remove it.
- **Visible drop zones during drag.** When dragging a spool, valid empty slots gently pulse, locked slots dim out, and the slot under the cursor pops with a strong orange ring + 12 % scale-up. Filled drop targets (= swap) get a `⇄` glyph overlay so the user knows it's an exchange, not an overwrite.
- **Slot animations.** Spools that just landed in a slot bounce in with overshoot. Auto-fill is staggered 30 ms per slot for a left-to-right, top-to-bottom "wave" effect. Clear-all triggers a cascade where every spool flies out to the right toward the unranked panel.
- **Contextual coordinates.** Shelf letters (A–Z bottom→top) and slot numbers (1–N) are hidden by default to reduce noise. They reveal on rack hover or while dragging a spool, so the user can aim precisely without permanent clutter. Per-slot tooltips still expose `[B3]` etc. on hover.
- **Rich hover tooltip on filled slots.** Hovering a colored slot opens a custom info bubble showing brand, material · color name, coordinate badge, weight bar with current/total grams + percentage, and a "Locked" tag if applicable. Hidden during drag so it doesn't fight the drop-target ring.
- **Skyline masonry layout.** Racks of varying widths and heights pack tightly into the available width via a custom skyline-packing algorithm — narrow racks no longer leave dead vertical space below them. Recomputes on resize and after every render via a width-only `ResizeObserver`.
- **Toolbar styling alignment.** The search input and the brand / material / type quick-filter dropdowns now share the exact same pill style as the stat tiles (same height, padding, radius, and `surface-2` background) so the entire top section reads as one cohesive toolbar.
- **Spools-not-stored side panel.** Per-row layout shows brand on line 1 and material · color name on line 2 — easier to scan by manufacturer first. The colored puck inside each row matches the rack-slot dimensions exactly (32 × ~53 px, 3/5 ratio).
- **+ New Rack as a stat tile.** The "create new rack" affordance is the first tile of the stats bar — same height and padding as the data tiles, dashed border to read as a "create" affordance, with a `+` glyph playing the role of a number and "NEW RACK" as its unit label.
- **Inner rack frame removed.** The white sub-card surrounding the slot grid inside each rack has been dropped; slots now sit directly on the rack-card surface, lightening the layout and removing the nested-container look.

### v1.4.2 — 2026-05-02

- **CI — macOS code signing + notarization.** Releases for macOS are now signed with our Apple Developer ID Application certificate and notarized by Apple via `notarytool`. Users opening the `.dmg` no longer see any Gatekeeper warning. The auto-updater accepts notarized `.zip` updates from GitHub Releases. The [`build.yml`](./.github/workflows/build.yml) workflow decodes the certificate and the App Store Connect API Key from GitHub Secrets at build time. See the new [Code signing & notarization](#code-signing--notarization-macos) section in this README for verification commands and instructions for setting up signing in a fork.
- **Native modules** (`@pokusew/pcsclite`, `@serialport/bindings-cpp`) are now correctly signed inside the bundle via `entitlementsInherit` and `cs.disable-library-validation`, so the Hardened Runtime accepts them at launch.
- **New `build:mac:unsigned`** script for fast local builds without Apple credentials. The default `build:mac` now runs the full sign + notarize pipeline.
- New `build/entitlements.mac.plist` with `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables` — minimum set for Electron + native modules under Hardened Runtime.

### v1.4.1 — 2026-05-01

- **Fix — silent login failure on email/password** sign-in (and Google sign-in for fresh accounts) on desktop. The auth listener was gated on `getActiveId()` matching the new uid, but `setActiveId()` only ran inside the listener — a chicken-and-egg that left a successfully authenticated user with no UI update. Reordered so `setActiveId` runs after `updateCurrentUser` and before `setupNamedAuth`. (`renderer/inventory.js`)
- **New — diagnostic report system.** Every caught auth/network error and every `window.error` / `unhandledrejection` is captured into a circular buffer. Users open a copy-friendly Markdown report from **Settings → Debug → Report a problem** or directly from the Sign-in modal. The report includes app version, Electron/Chrome/Node versions, OS / arch / release, locale, account count, online state, and the last 50 errors with full stack traces. New IPC `app:info` exposes runtime info via the preload bridge.
- **Storage / Rack feature gated off** in this build (button hidden, `tigertag.view = "rack"` falls back to `table`) until the visualisation skeleton is finalised.
- 7 new i18n keys (`errReport*`, `errDetailsLink`) translated across all 9 locales.

---

## Download

**[⬇ Download the latest release](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/releases/latest)**

| Platform | File | Signed |
|---|---|---|
| macOS (Intel + Apple Silicon) | `.dmg` | ✅ Apple Developer ID + Notarized |
| Windows | `.exe` | ❌ Not yet (planned) |
| Linux | `.AppImage` | N/A |

> **macOS** — the `.dmg` is signed with our Developer ID certificate and notarized by Apple. Gatekeeper opens it without any warning. See [Code signing & notarization](#code-signing--notarization-macos) below for verification commands.

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
| macOS code signing | Apple Developer ID Application + `notarytool` (App Store Connect API Key) |
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

## i18n tooling

The app ships with **9 locales** (en, fr, de, es, it, zh, pt, pt-pt, pl) under `renderer/locales/`. Two helpers keep them in sync.

### Add or update a key — `npm run i18n:add`
One command updates all 9 locale files. Never edit them by hand.

```bash
# Append at end of every file
npm run i18n:add -- myKey en="Hello" fr="Bonjour" de="Hallo" \
  es="Hola" it="Ciao" zh="你好" pt="Olá" pt-pt="Olá" pl="Cześć"

# Insert just after an existing key (keeps related keys grouped)
npm run i18n:add -- myKey --after toolboxTitle en="Hello" fr="Bonjour" ...

# JSON payload form
npm run i18n:add -- myKey --json '{"en":"Hello","fr":"Bonjour"}'
```

Behaviour: updates in-place if the key exists, preserves file order, falls back to the EN value for missing locales (stderr warning), and aborts the run if any file would become invalid JSON. Source: [`scripts/i18n-add.mjs`](scripts/i18n-add.mjs).

### Consistency check — `npm run i18n:check` + pre-commit hook
A pre-commit hook runs the validator automatically and **blocks the commit** if any locale drifts. Hook activation: the npm `prepare` script (run by `npm install`) sets `core.hooksPath=.githooks/` so the check follows the repo with no per-machine setup.

```bash
npm run i18n:check
# → "[i18n-check] OK — 9 locales × 556 keys, all consistent."   (exit 0)
# or a per-file list of issues + "FAIL — N error(s)"            (exit 1)
```

What it checks:
- Every locale file parses as valid JSON.
- Same key set as `en.json` — no missing, no extras.
- Same value type per key — a plural object (`{"one":"…","other":"…"}`) in `en.json` must stay a plural object in every locale.
- No empty string values.

The hook is at [`.githooks/pre-commit`](.githooks/pre-commit) — extend it with lint/format/typecheck as the project grows. To bypass once (don't): `git commit --no-verify`.

---

## Building installers

| Platform | Command | Output |
|---|---|---|
| macOS (signed + notarized) | `npm run build:mac` | `.dmg` + `.zip` (x64 + arm64) |
| macOS (unsigned, fast)     | `npm run build:mac:unsigned` | `.dmg` + `.zip` (no Apple credentials needed) |
| Windows | `npm run build:win` | `.exe` NSIS installer |
| Linux | `npm run build:linux` | `.AppImage` |
| All | `npm run build:all` | All three |

Built installers are placed in the `dist/` folder (ignored by git).

> `npm run build:mac` requires Apple Developer credentials in a local `.env` file (see [`.env.example`](./.env.example) for the expected variables). For development without credentials, use `build:mac:unsigned` — the app builds and runs locally but Gatekeeper will refuse to open it without right-click → Open. The full signing pipeline is documented in [Code signing & notarization](#code-signing--notarization-macos) below.

---

## Releases via GitHub Actions

Pushing a version tag automatically triggers a parallel build on **macOS, Windows, and Linux** and publishes a GitHub Release with the installers attached.

```bash
git tag v1.4.4
git push origin v1.4.4
```

| Platform | Output | Signed? |
|---|---|---|
| macOS | `.dmg` + `.zip` (Intel + Apple Silicon) | ✅ Developer ID + notarized by Apple |
| Windows | `.exe` (NSIS) | ❌ Not yet (planned) |
| Linux | `.AppImage` | N/A (no signing on Linux) |

The workflow is at [`.github/workflows/build.yml`](./.github/workflows/build.yml). For the macOS signing setup details, see the [Code signing & notarization](#code-signing--notarization-macos) section below.

---

## Code signing & notarization (macOS)

Releases for macOS are **signed with an Apple Developer ID Application certificate and notarized by Apple**, which means:

- The `.dmg` opens with **no Gatekeeper warning** when downloaded from GitHub Releases
- macOS verifies the binary hasn't been tampered with after leaving our build server
- The auto-updater (`electron-updater`) accepts incoming `.zip` updates because they carry the notarization staple

### Verifying a downloaded release

After downloading from [Releases](https://github.com/TigerTag-Project/TigerTag_Studio_Manager/releases/latest), you can audit the signature yourself:

```bash
# Mount the DMG, then:
spctl --assess --type execute --verbose \
  "/Volumes/Tiger Studio Manager/Tiger Studio Manager.app"
# Expected: "accepted" — "source=Notarized Developer ID"

codesign --verify --deep --strict --verbose=2 \
  "/Volumes/Tiger Studio Manager/Tiger Studio Manager.app"
# Expected: "valid on disk" — "satisfies its Designated Requirement"
```

### How the CI signs builds

The [`build.yml`](./.github/workflows/build.yml) workflow runs on `macos-latest` and:

1. **Decodes** the Developer ID `.p12` certificate from a base64 GitHub Secret. electron-builder reads `CSC_LINK` + `CSC_KEY_PASSWORD` and imports the cert into the runner's temporary keychain
2. **Decodes** the App Store Connect API Key (`.p8`) from a base64 secret to a file, exposed via `APPLE_API_KEY` env var
3. Runs `electron-builder --mac --publish always` with `hardenedRuntime: true` and the entitlements declared in [`build/entitlements.mac.plist`](./build/entitlements.mac.plist)
4. electron-builder signs the `.app` bundle (Electron framework + native modules + main app), packages the `.dmg` + `.zip`, then calls Apple's `notarytool` and **staples** the notarization ticket onto the artifacts

Notarization usually completes in 1–5 minutes on Apple's side.

### For forks / contributors who want signed builds

If you fork this repo and want your own signed releases, you need:

| Requirement | Where |
|---|---|
| **Apple Developer Program** membership ($99/year) | [developer.apple.com](https://developer.apple.com/) |
| **Developer ID Application** certificate, exported as `.p12` | Keychain Access → My Certificates → Export |
| **App Store Connect API Key** with role *Developer* | [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api) |

Then add these **6 secrets** to your fork's `Settings → Secrets and variables → Actions`:

| Secret name | Value |
|---|---|
| `MACOS_CERTIFICATE` | base64 of your Developer ID `.p12` export |
| `MACOS_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_API_KEY_BASE64` | base64 of your App Store Connect API `.p8` file |
| `APPLE_API_KEY_ID` | 10-char Key ID from App Store Connect |
| `APPLE_API_ISSUER` | UUID Issuer ID from App Store Connect |
| `APPLE_TEAM_ID` | your Apple Developer Team ID (10-char) |

The repo includes [`scripts/print-github-secrets.sh`](./scripts/print-github-secrets.sh), a helper that reads your local `.env` + `.p12` and prints all six values formatted ready to paste into GitHub:

```bash
cp .env.example .env   # then edit .env with your API key info
./scripts/print-github-secrets.sh ~/path/to/your/DeveloperID.p12
```

### Local signed build (full pipeline)

For testing the signing + notarization pipeline locally before tagging a release:

1. Copy `.env.example` → `.env` and fill in your API key path + Key ID + Issuer ID + Team ID
2. Make sure your Developer ID Application certificate is in your **login** keychain
3. Run `npm run build:mac` — the [`build/sign-and-notarize.sh`](./build/sign-and-notarize.sh) wrapper loads `.env`, validates credentials, and invokes electron-builder with the notarization step enabled

Notarization runs against Apple's servers and adds 1–5 min to the build. For iteration loops, prefer `npm run build:mac:unsigned`.

---

## Project Structure

```
TigerTag_Studio_Manager/
├── main.js                  # Electron main process (window, NFC, image cache, auto-updater)
├── preload.js               # IPC bridge (contextBridge)
├── renderer/
│   ├── inventory.html       # Single-page UI (markup + modals, no inline JS)
│   ├── inventory.js         # All application logic (IIFE)
│   ├── css/                 # App styles split into 8 themed files (00-base → 70-detail-misc)
│   ├── firebase.js          # Firebase SDK initialisation
│   ├── lib/firebase/        # Bundled Firebase compat SDKs (app, auth, firestore)
│   └── locales/             # i18n JSON files (en, fr, de, es, it, pl, zh, pt, pt-pt)
├── data/                    # Local JSON lookup tables (brands, materials, types, aspects…)
├── assets/
│   ├── img/                 # App icons + spool container images
│   └── svg/
│       ├── icons/           # UI icon SVGs (23 icons)
│       └── logos/           # TigerTag logo SVGs (normal + contouring variant)
├── docs/
│   └── rfid-vendors/        # Per-vendor RFID tag spec sheets (read-only reference)
├── OpenRFID/                # Git submodule — upstream multi-vendor RFID parsers
├── .github/
│   └── workflows/
│       └── build.yml        # CI: build + publish on tag push
├── .gitmodules
└── package.json
```

> **Note on `OpenRFID/`** — vendored as a Git submodule pointing at [suchmememanyskill/OpenRFID](https://github.com/suchmememanyskill/OpenRFID). Used as a **read-only reference** to extend tag support to other vendors (Bambu, Creality, Anycubic, Elegoo, Snapmaker, Qidi, Openspool). Source is **never modified** — sync upstream with `git submodule update --remote OpenRFID`. See `docs/rfid-vendors/README.md` for the per-vendor reference sheets distilled from the Python parsers.

---

## Multi-vendor RFID (planned)

The app currently reads only TigerTag chips. To prepare for reading other vendors' tags **read-only** (no clone, no write), the project vendors the [OpenRFID](https://github.com/suchmememanyskill/OpenRFID) Python project as a Git submodule under `OpenRFID/` and ships a set of per-vendor technical reference sheets in `docs/rfid-vendors/`.

| Vendor | Tag type | Auth | Crypto | Spec |
|---|---|---|---|---|
| 🐯 TigerTag | NTAG/NDEF | None | Reserved sig slot | [tigertag.md](./docs/rfid-vendors/tigertag.md) |
| 🟢 Bambu Lab | Mifare Classic 1K | HKDF-SHA256 | Salt operator-provisioned | [bambu.md](./docs/rfid-vendors/bambu.md) |
| 🟠 Creality | Mifare Classic 1K | AES-128-ECB key (sector 1) | Optional payload encryption | [creality.md](./docs/rfid-vendors/creality.md) |
| 🔴 Anycubic | Mifare Ultralight | None | None | [anycubic.md](./docs/rfid-vendors/anycubic.md) |
| ⚫ Elegoo | Mifare Ultralight | None | Magic bytes | [elegoo.md](./docs/rfid-vendors/elegoo.md) |
| 🟣 Snapmaker | Mifare Classic 1K | HKDF per-sector | RSA-2048 PKCS#1 v1.5 + SHA-256 | [snapmaker.md](./docs/rfid-vendors/snapmaker.md) |
| 🟡 Qidi | Mifare Classic 1K | Default key | None | [qidi.md](./docs/rfid-vendors/qidi.md) |
| 🌐 Openspool | NFC Type 2 (NDEF JSON) | None | None | [openspool.md](./docs/rfid-vendors/openspool.md) |

Each spec sheet is self-contained: tag layout, field semantics, lookup tables transcribed verbatim, encoding pitfalls, and JS port notes. The plan is to write `renderer/lib/rfid/<vendor>.js` parsers from these specs without re-reading the Python source. Cloning the repo with submodules:

```bash
git clone --recurse-submodules https://github.com/TigerTag-Project/TigerTag_Studio_Manager.git
# or, if already cloned:
git submodule update --init --recursive
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

> **Tip:** the app has a built-in diagnostic panel — open **Settings → Debug → Report a problem** (or the link at the bottom of the Sign-in modal). Click **Copy report** and paste the content into your issue. The report includes app version, Electron/Chrome/Node versions, platform, and the last 50 captured errors with full stack traces. No personal data is included.

---

## License

[MIT](LICENSE) — © TigerTag Project

You are free to use, modify, and distribute this software. See the [LICENSE](LICENSE) file for details.
