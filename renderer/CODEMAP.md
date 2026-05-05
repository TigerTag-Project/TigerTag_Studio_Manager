# `renderer/inventory.js` — code map

`inventory.js` is one ~12,400-line IIFE holding **every** runtime behaviour of the renderer. This file maps each feature to its line range so an AI assistant (or human) can jump directly to the right block instead of reading the file linearly.

Keep this map in sync with the code: when you move a section, update the line range here. CI does not enforce it — drift is the cost of skipping the update.

---

## Bird's-eye structure

```
L1            (() => {                                        // IIFE opens
L1-491        Foundation        — Firebase helpers, state, i18n, helpers, lookups
L492-2917     Inventory pipeline — normalize → render
                ├── L492-602    data layer (Timestamp, normalizeRow, health)
                ├── L603-1366   account modals + sidebar
                ├── L1367-2272  persistence, migrations, auth, Firestore subs
                └── L2273-2917  load → stats → filter → twin auto-link → render
L2918-4283    Spool detail panel + per-spool modals
L4284-5072    App-level UI (resize, debug, settings, language, friends, …)
L5073-5532    Storage / scales / 3D printers (subscribe + render printers grid)
L5533-7216    Snapmaker Live integration (Moonraker WebSocket)
L7288-8345    FlashForge Live integration (HTTP polling + filament edit)
L8347-…       Add-printer flow (mDNS → port-scan → Add by IP → manual probe)
…             Storage view (rack rendering, drag-drop, masonry, rack-edit modal)
…             Friend view (friend's inventory in main interface)
…             Display-name setup + Friends system (requests, accept, blacklist)
…             Public/private key helpers + late utilities
…             Init bootstrap (loadLocales → loadLookups → wire DOM → start)
}             })();                                           // IIFE closes
```

---

## Foundation (L1-491)

| L | What | Anchors |
|---|---|---|
| 1-3 | IIFE open + `API_BASE` constant | |
| 4-34 | **Firebase helpers** — per-account named app instances (`firebase.app(uid)`), each with its own auth session | `fbAuth(id)`, `fbDb(id)` |
| 36-69 | Avatar gradient/shadow helpers | `hexToGradientPair`, `getAccGradient`, `applyAvatarStyle` |
| 71-120 | **`state` object declaration** — single source of truth (inventory, rows, selected, lang, racks, friends, isAdmin, db, imgCache, …) | `const state = { … }` |
| 122-138 | **`t(key, params)`** — i18n lookup with fallback, supports `{{param}}`, `["array"]` random pick, `{one,other}` plurals | `function t` |
| 140-156 | `applyTranslations()` — applies `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-title]`, `.lang-btn.active` | |
| 159-240 | **General helpers** — `v()`, `toHex()`, `timeAgo()`, `fmtTs()`, `fmtChipTs()`, `setLoading()`, `setupHoldToConfirm()` | |
| 241-254 | `toast()` — top banner with kind (info/error/success) + auto-dismiss | |
| 255-396 | **Error reporting / diagnostic system** — `reportError()`, app version line, diag badge, `buildDiagnosticReport()`, modal open/close | |
| 399-491 | **Lookups** — `loadLocales`, `loadLookups` (brand/material/aspect/type/diameter/version/containers), `findPrinterModel`, `dbFind`, `brandName`, `materialLabel`, `typeName` | |

---

## Inventory pipeline (L492-2917)

### Data layer (L492-602)
| L | What | Anchors |
|---|---|---|
| 492-501 | `tsToMs()` — Firestore Timestamp → ms (accepts `number`, `Timestamp`, `{_seconds}`) | |
| 502-576 | **`normalizeRow(spoolId, data)`** — Firestore doc → flat row used by every view (color, online_color_list, weight_available, last_update, container_id, twin_uid, …) | |
| 577-602 | Health icon driven by Firestore `metadata.fromCache` | `setHealthLive`, `setHealthOffline` |

### Account UI / modals / sidebar (L603-1366)
| L | What | Anchors |
|---|---|---|
| 603-661 | Connected vs no-account UI states | `setConnected`, `renderNoAccount` |
| 662-765 | **Account dropdown** (avatar click) — connected accounts list, manage profiles, friends section, add friend | `openAccountDropdown`, `closeAccountDropdown` |
| 766-777 | Profiles modal stub | |
| 778-962 | **Settings panel** — language, debug toggle, API URL copy, JSON export, auto-update, about | `openSettings`, `closeSettings` |
| 963-1142 | **Edit account modal** + disconnect-account modal | `openEditAccountModal`, `closeEditAccountModal` |
| 1144-1354 | **Login modal** (Firebase) — Google sign-in, email/password sign-in + create flow, forgot password | `openAddAccountModal`, `closeAddAccountModal` |
| 1355-1366 | Sidebar collapse toggle (persisted to `tigertag.sidebar`) | |

### Persistence + migrations + auth (L1367-2272)
| L | What | Anchors |
|---|---|---|
| 1367-1392 | LocalStorage save/load helpers; legacy API-key account wipe | |
| 1393-1400 | Per-account `firebase.app(uid).auth().signOut()` | |
| 1401-1469 | **UID format migration** — decimal big-endian → hex uppercase | `runUidMigration` |
| 1471-1947 | **Rack-shape migration** — flat fields → nested `rack` object (with consent modal + lock-screen sweep) | |
| 1948-2021 | **Firestore inventory subscription** — `onSnapshot` with friend-view defense-in-depth | `subscribeInventory`, `unsubscribeInventory` |
| 2022-2132 | **Auth state → app state** — `onAuthStateChanged` orchestrator | |
| 2133-2272 | Sidebar account section UI + welcome line + friends quick-list | `renderAccountSection`, `renderSidebarFriends` |

### Load → stats → filter → render (L2273-2917)
| L | What | Anchors |
|---|---|---|
| 2273-2293 | Key validation status + inventory load action | |
| 2294-2311 | **Stats** computed from rows | `renderStats` |
| 2312-2335 | Search/filter pipeline (case-insensitive on multiple fields) | `applyFilter` |
| 2336-2409 | **Twin auto-link by timestamp** — bridges 2 RFID tags written within a 2 s window | `autoLinkTwinsByTimestamp` |
| 2410-2558 | **Manual twin pairing** — user-assisted repair when auto-link missed | `findTwinCandidates`, `linkTwinPair`, `unlinkTwinPair` |
| 2559-2917 | **`renderInventory()`** — table view + grid view + welcome card; `_justPlacedSpools` bounce-in | |

---

## Spool detail panel + per-spool modals (L2918-4283)

| L | What | Anchors |
|---|---|---|
| 2918-2988 | View toggle (table ⇄ grid), persisted | |
| 2989-3294 | **Detail panel** — header, color block, print settings, weight slider w/ debounce, links, container row, raw JSON, **toolbox** | `openDetail`, `closeDetail`, `buildPanelHTML` |
| 3019-3294 | (Toolbox actions — Scan colour, Scan TD, Twin link, Remove from rack, Delete) | |
| 3295-3379 | Shared helpers (color picker math, weight bar render, etc.) | |
| 3380-3458 | **TD Edit modal** (dark) — TD only / Color only / All | |
| 3459-3568 | **Color Edit modal** (dark, mirrors TD Edit) | |
| 3569-3589 | TD1S connect modal | |
| 3590-3621 | TD1S tester modal | |
| 3622-3688 | **Twin-link picker modal** — list of compatible candidates | `openTwinLinkPicker` |
| 3689-4283 | **Container picker modal** — pick from `data/container_spool/spools_filament.json` | `openContainerPicker`, `closeContainerPicker` |

---

## App-level UI (L4284-5072)

| L | What | Anchors |
|---|---|---|
| 4285-4339 | Resizable panels (detail + debug) — drag handle, persisted width | `makePanelResizable` |
| 4340-4354 | TD1S panel (slide-in) | |
| 4355-4365 | Debug panel toggle | |
| 4366-4439 | Diagnostic / report-problem modal | |
| 4440-4523 | Settings → About → auto-update toggle + "Check for updates now" | |
| 4524-4696 | **Deleted spools list** (debug tab) | |
| 4697-4777 | **Firestore explorer** (debug tab) — type a path, fetch JSON, copy | |
| 4778-4788 | Community buttons (GitHub, Discord, MakerWorld) | |
| 4789-4813 | Language select | |
| 4814-5072 | **Friends UI** — friends panel slide-in, list rendering, search | `openFriends`, `closeFriends` |

---

## Storage / Scales / Printers (subscribe + render printers grid) (L5073-5532)

| L | What | Anchors |
|---|---|---|
| 5073-5103 | Racks subscription | `subscribeRacks`, `unsubscribeRacks` |
| 5104-5122 | **Scales** subscription (TigerScale heartbeat, 90 s online threshold) | `subscribeScales` |
| 5123-5215 | **3D printers** subscription — per-brand subcollections (`users/{uid}/printers/{brand}/devices`) | `subscribePrinters` |
| 5216-5224 | Brand metadata (label + accent + connection hint) | |
| 5225-5361 | Render 3D printers in main panel | `renderPrintersView` |
| 5362-5462 | Printer drag & drop reordering (writes `sortIndex`) | |
| 5463-5532 | **Printer detail side panel** | `openPrinterDetail`, `closePrinterDetail`, `refreshOpenPrinterDetail` |

---

## Snapmaker Live (Moonraker WebSocket) (L5533-7216)

Big section divider at L5533. Ported from the Flutter `SnapmakerWebSocketPage`. Connects to `ws://{ip}:7125/websocket`.

| L | What | Anchors |
|---|---|---|
| 5557-5639 | Per-printer state map; online detection; Online/Offline badge render | `snapKey`, `snapIsOnline`, `renderSnapOnlineBadge` |
| 5640-5792 | **WebSocket lifecycle** — open, subscribe, reconnect with backoff, disconnect | `snapConnect`, `snapOpenSocket`, `snapScheduleReconnect`, `snapDisconnect` |
| 5793-5945 | Status merger (temps, filament, print job); G-code send helper | `snapMergeStatus`, `snapSendGcode` |
| 5946-6159 | **Manual filament edit — bottom sheet (entry)** — vendor/material lists, summary, render flow | `openSnapFilamentEdit`, `closeSnapFilamentEdit` |
| 6160-6201 | Bottom-sheet sub-pickers (Filament + Color stack on top of summary) | `sfeOpenFilamentSheet`, `sfeOpenColorSheet` |
| 6202-6243 | Filament screen (vendor → material click handlers) | |
| 6244-6343 | **Color screen** — 5×5 grid (24 presets + custom), inline custom slot | `sfeRenderColorGrid` |
| 6344-6486 | **Moonraker file/thumbnail helpers** — path normalize, thumbnail URL, RGBA/hex parse, format temp/duration | `snapFileUrl`, `snapThumbUrl`, `snapParseRgbaHex` |
| 6487-6519 | Text-color contrast picker for color squares | `snapTextColor` |
| 6520-6680 | **Live block render** — `renderSnapmakerLiveInner()`: connection header, camera, print-job card, temperature row, **filament grid (big colored squares)** | `renderSnapmakerLiveInner` |
| 6681-7130 | **WS request log** — push, custom JSON send, render | `snapLogPush`, `snapSendCustomJson`, `renderSnapmakerLogInner` |
| 6798-7130 | `renderPrinterDetail()` — composes hero + camera + status + live block + log | `renderPrinterDetail` |
| 7131-7216 | **Inline edit** for printer name / IP / port (pencil hint, click to edit, Enter/Escape) | `startInlineEdit` |

---

## FlashForge Live (HTTP polling) (L7288-8345)

Big section divider at L7288. Mirrors the Snapmaker block (`snap*` →
`ffg*` prefix). Polls `POST http://<ip>:8898/detail` every 2 s with
`{ serialNumber, checkCode }` body. Filament changes go to
`POST http://<ip>:8898/control` with `cmd: "msConfig_cmd"` (matlStation)
or `cmd: "ipdMsConfig_cmd"` (independent extruder).

| L | What | Anchors |
|---|---|---|
| 7288-7320 | Per-printer state map (`_ffgConns`, `_ffgPings`); `ffgKey`, `ffgIsOnline`, `ffgBaseUrl`, `ffgAuthBody` | |
| 7321-7370 | **`ffgPingPrinter`** — 2.5 s POST probe used for the printer-grid online dot. 30 s cache. | `ffgPingPrinter`, `ffgPingAllPrinters` |
| 7371-7385 | Surgical DOM update of online badges (grid card + side card) | `ffgRefreshOnlineUI`, `renderFfgOnlineBadge` |
| 7386-7450 | **Polling lifecycle** — `ffgConnect` opens a 2 s `setInterval`, `ffgDisconnect` tears it down. Capped exponential backoff on offline. | `ffgConnect`, `ffgDisconnect`, `ffgScheduleReconnect` |
| 7451-7510 | **`ffgPollOnce`** — single `fetch` POST `/detail`, parses JSON, dispatches to `ffgMergeStatus` | `ffgPollOnce` |
| 7511-7650 | **`ffgMergeStatus`** — full `/detail` parser. Error contract (-2 / sn / pwd), then field extraction (temps, filament matlStation vs indep, print job, camera). Throttles SN/password toasts to one per session per printer. | `ffgMergeStatus`, `ffgWarnOnce` |
| 7651-7670 | rAF-coalesced re-renders. Full re-render on status change (camera swap), live-only on data change. | `ffgNotifyChange` |
| 7671-7820 | **Live block render** — `renderFlashforgeLiveInner()` returns the side-card inner HTML. Reuses `.snap-*` CSS classes for visual parity. | `renderFlashforgeLiveInner`, `ffgFmtTempSolo`, `ffgIsActiveState`, `ffgStateLabel`, `ffgFmtDuration` |
| 7821-7880 | **Filament-edit catalogue** — vendor → materials map, color presets aliased to `SNAP_FIL_COLOR_PRESETS` | `FFG_FIL_VENDOR_MATERIALS`, `ffgSortMaterials` |
| 7881-7960 | Bottom-sheet open/close + sub-pickers (filament, colour). Mirrors Snapmaker's `sfe*` flow with `ffe*` prefix. | `openFlashforgeFilamentEdit`, `closeFlashforgeFilamentEdit`, `ffeOpenFilamentSheet`, `ffeOpenColorSheet`, `ffeUpdateSummary`, `ffeRenderColorGrid` |
| 7961-8050 | Click delegation on vendor / material lists + colour grid + native colour picker overlay | |
| 8051-8345 | **Apply (`POST /control`)** — branches on matlStation vs independent extruder. Optimistic local patch of `conn.data.filaments` so the colour square updates immediately. | `$("ffgFilEditSave") click` |

Wiring (cross-cutting with Snapmaker):
- `renderPrintersView` (L5300+) emits `renderFfgOnlineBadge` and triggers `ffgPingPrinter` for FlashForge cards.
- `openPrinterDetail` / `closePrinterDetail` (L5475+) call `ffgConnect` / `ffgDisconnect`.
- `renderPrinterDetail` (L6800+) builds `#ffgLive`, swaps the side-card hero camera for an MJPEG `<img>` when `ffgConn.data.camera.url` is non-empty.
- HTML parallel sheets at `inventory.html` L460+ (`#ffgFilEditSheet`, `#ffgFilamentSheet`, `#ffgColorSheet`).

---

## Add-printer flow (L8347+)

| L | What | Anchors |
|---|---|---|
| 7217-7320 | Two-step flow stub (brand picker → form) | |
| 7321-7362 | **Brand picker modal** | `openPrinterBrandPicker`, `closePrinterBrandPicker` |
| 7363-7421 | Snapmaker discovery flow entry | |
| 7422-7520 | **User-declared extra subnets** widget (persisted in localStorage) | `snapLoadExtraSubnets`, `snapSaveExtraSubnets`, `snapValidateIp`, `snapValidatePrefix` |
| 7521-8029 | **Debug scan journal** — in-memory log + Export-to-clipboard JSON dump | |
| 8030-8064 | **Phase 0** — mDNS browse `_snapmaker._tcp.local.` via `bonjour-service` | |
| 8065-8130 | **Phase 1** — enumerate subnets (IPC `os.networkInterfaces()` + WebRTC ICE candidates + user extras) | |
| 8131-8226 | **Phase 2** — per-source port-scan (batch=24 local, batch=4+80ms gap for extras to bypass IDS/IPS) | |
| 8227-8240 | LAN scanner orchestrator | |
| 8241-8633 | **One-click add** — clicking a candidate writes the printer doc directly to Firestore (with full discovery payload preserved) | `snapAddDiscoveredPrinter` |
| 8634-8777 | **Add by IP** collapsible — inline IPv4 validation, error bubble, Validate probe | |
| 8778-9095 | Manual IP probe (step 2b) — `printer/info` + `server/info` + `machine/system_info` | |
| 9096-9344 | **Custom model picker** — list of models with thumbnails (data/printers/`{brand}_printer_models.json`) | |

---

## Storage view (rack rendering + drag-drop) (L9345-11327)

| L | What | Anchors |
|---|---|---|
| 9345-9505 | **Scale v2 field accessors** — `scaleHeartbeatAt`, `scaleDisplayName`, `scaleCurrentSpoolUid1/2`, `scaleWifiSignalDbm`, `scaleBatteryPercent`, `isScaleOnline`, `renderScaleHealth`, `renderScalesPanel` | |
| 9505-9613 | `agoString(ms)` — relative time formatter | |
| 9614-9727 | Empty-rack cascade animation; twin spoolId resolver; slot fill HTML | `playEmptyRackCascade`, `slotFillInnerHTML` |
| 9728-9747 | `findSpoolInSlot(rackId, level, position)` | |
| 9748-9827 | **Slot locking** — right-click toggles lock; persisted in rack doc | `slotLockKey`, `isSlotLocked`, `positionRackMenu` |
| 9828-10010 | **Auto-fill / Auto-store / Auto-unstorage** — assign unranked spools to empty unlocked slots | |
| 9976-10010 | Search dim — non-matching slots fade | `applyRackSearchDim` |
| 10011-10067 | `isEmptyRow`, `getUnrackedSpools`, `unrackedRowHTML` (empty spools visible but not counted) | |
| 10068-10204 | **Skyline-packing masonry** layout for rack cards | `layoutRacksMasonry`, `scheduleMasonryRelayout` |
| 10205-10307 | **Rich hover tooltip** for filled rack slots (mini puck preview + filament info) | `ensureRackTooltipEl`, `buildRackTooltipHTML`, `showRackTooltipFor`, `wireRackTooltipDelegation` |
| 10308-10885 | **`renderRackView()`** — stats bar, two-column layout, masonry, kebab menus, live search wiring, click handlers, "+ Rack" button | `renderRackView` |
| 10886-10942 | Drag sources (slot puck or unranked row) | `wireDragSources` |
| 10943-11037 | Drop targets (slot, unranked panel) + cross-target highlight clearing | `wireDropTargets`, `clearOtherDropHighlights` |
| 11038-11102 | **Drop-to-void unassign** — drop outside any `.rp-rack` sends spool back to unranked | |
| 11103-11122 | Cascade animation when removing from rack via toolbox | `playUnrankAnimation` |
| 11123-11327 | **Rack create/edit modal** — name, presets, rows×columns, total slots label | `openRackEditModal`, `closeRackEditModal`, `renderRackPresets`, `confirmDeleteRack` |

---

## Friend view (L11328-11765)

| L | What | Anchors |
|---|---|---|
| 11328-11383 | Friend inventory subscription (one-shot read, no live updates) | `openFriendInventory` |
| 11384-11401 | Tear-down on close | `closeFriendInventory` |
| 11402-11550 | **Friend banner** + main-interface render (friend mode vs own mode) | `renderFriendBanner` |
| 11448-11550 | Auth helper for friend mode — turns off all owner subscriptions before mutating UI | |
| 11551-11572 | `switchBackToOwnView()` — restores all owner subscriptions | |
| 11574-11765 | Friends section render in account dropdown; friend request modal; add-friend modal | `renderFriendsSection`, `showFriendRequestModal`, `openAddFriendModal` |

---

## Display name + Friends system (L11766-12027)

| L | What | Anchors |
|---|---|---|
| 11766-11806 | **Display-name setup modal** — first-login pseudo picker | `openDisplayNameSetup`, `closeDisplayNameSetup` |
| 11807-11824 | Friend requests subscription | `subscribeFriendRequests` |
| 11828-11922 | Request badge render + accept/decline batch writes (bidirectional) | `renderFriendRequestBadge` |
| 11923-12027 | Blacklist render + add/remove blacklist entries | `renderBlacklist` |

---

## Key helpers + late utilities (L12028-12204)

| L | What | Anchors |
|---|---|---|
| 12028-12035 | `generatePublicKey()` — `XXX-XXX` candidate generator | |
| 12036-12190 | `generatePrivateKey()` (40-char hex) + `claimPublicKey(uid, oldKey)` atomic transaction (10 retries) | |
| 12191-12204 | `applyLang(lang)` — switches locale, saves prefs to Firestore | |

---

## Init bootstrap (L12205-12389)

```
loadLocales()
  → loadLookups()
    → runMigration()      // wipe legacy API-key accounts
    → onAuthStateChanged  // wire Firebase
    → DOM event listeners // wire all buttons + modals
    → Electron IPC bridge // RFID + TD1S
```

| L | What | Anchors |
|---|---|---|
| 12214-12266 | **Electron RFID integration** — main-process `nfc:scan` events, autofill weight/UID actions | |
| 12267-12389 | **TD1S sensor integration** — serial port events, log render, copy/clear log | |

---

## "Find X by feature" cookbook

Most common navigation tasks → start here:

| You want to … | Open this section first |
|---|---|
| Add or change an i18n key | `t()` L122, then `applyTranslations()` L140; *use `npm run i18n:add` for the actual write* |
| Touch the spool detail panel | L2989 (`buildPanelHTML`) → toolbox at L3019 |
| Touch the weight slider | L2989-3294 (debounced auto-save inside detail panel) |
| Add/change a modal | L3380 (TD), L3459 (Color), L3622 (Twin link), L3689 (Container), L11125 (Rack edit) |
| Touch the storage view | `renderRackView` L10308 — biggest function in the file |
| Touch a rack drag-drop behaviour | `wireDragSources` L10886, `wireDropTargets` L10951, drop-to-void L11038 |
| Touch the printer detail card | `renderPrinterDetail` L6798 |
| Touch the Snapmaker WS layer | `snapConnect` L5640, `snapMergeStatus` L5793 |
| Touch the Snapmaker live block UI | `renderSnapmakerLiveInner` L6520 |
| Touch the FlashForge HTTP polling | `ffgConnect` L7390, `ffgPollOnce` L7460, `ffgMergeStatus` L7515 |
| Touch the FlashForge live block UI | `renderFlashforgeLiveInner` L7700 |
| Touch the FlashForge filament edit sheet | `openFlashforgeFilamentEdit` L7900, Apply at `$("ffgFilEditSave")` L8060 |
| Touch the bottom-sheet filament edit | `openSnapFilamentEdit` L5971, color grid L6244 |
| Touch the Add-printer scan flow | mDNS L8030, port-scan L8131, one-click add L8241 |
| Touch the Add by IP widget | L8634 |
| Touch the Friends system | UI L4814, friend view L11392, requests L11807 |
| Touch the auth flow | `onAuthStateChanged` L2022, login modal L1144 |
| Touch the Firestore subscriptions | inventory L1948, racks L5073, scales L5104, printers L5123, friend reqs L11809 |
| Touch the auto-update banner | L4440 |
| Touch the diagnostic / report-problem modal | L4366 |

---

## Notes for AI assistants

- **State** is at L71. Read it first when reasoning about anything cross-cutting.
- **Selectors**: `$` is `document.getElementById`. Many DOM nodes have IDs that match the section (e.g. `#detailPanel`, `#snapScanPanel`, `#friendsPanel`).
- **i18n**: 9 locales (en/fr/de/es/it/zh/pt/pt-pt/pl) under `renderer/locales/`. Never hand-edit — use `npm run i18n:add`. The `npm run i18n:check` pre-commit hook blocks drift.
- **CSS**: split into 8 themed files under `renderer/css/` (`00-base.css` → `70-detail-misc.css`). When this file references a UI section, the corresponding styles live in the matching CSS module.
- **Line numbers will drift** as the file changes. If a range looks wrong, grep for the anchor function name rather than trusting the L-number.
