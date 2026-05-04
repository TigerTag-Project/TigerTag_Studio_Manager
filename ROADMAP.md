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

### 3D printer integration
- ✅ **Per-brand subcollections** under `users/{uid}/printers/{brand}/devices/{id}`
- ✅ **5 brands wired** in the brand picker: Bambu Lab · Creality · Elegoo · FlashForge · Snapmaker
- ✅ **Per-brand model picker** with thumbnails (`data/printers/<brand>_printer_models.json`)
- ✅ Printer side panel · drag-drop reorder · inline edit · online/offline indicator (HTTP ping) (v1.4.7)
- ✅ **Snapmaker Live integration** (Moonraker WebSocket) — live temperatures, filament per slot, print job card with thumbnail + progress + state + layer counter (v1.4.7)
- ✅ **WebRTC camera** stream embed in printer hero
- ✅ **Snapmaker LAN discovery** — mDNS browse + parallel port-scan + per-source batch sizing + brand-confirm filter + one-click add (v1.4.8)
- ✅ **Add by IP** collapsible widget — live IPv4 validation + Validate probe (v1.4.8)
- ✅ **Manual filament edit bottom-sheet** — Filament + Color sub-pickers (v1.4.8)
- ✅ **Read-only filament sheet** for RFID-locked extruders — same layout, native `disabled` controls (v1.4.8)
- ✅ **Settings reconnect** — saving an IP change tears down + reconnects WebSocket (v1.4.8)

### Sensors & devices
- ✅ **ACR122U NFC reader** (USB) via `nfc-pcsc` — `main.js` ↔ renderer IPC bridge
- ✅ **TD1S sensor** integration — TD + color reading, auto-detect on USB plug, log panel
- ✅ **TigerScale heartbeat** — `users/{uid}/scales/{mac}` with 90s online threshold, scale panel render

### Distribution & i18n
- ✅ **9 locales** — en · fr · de · es · it · zh · pt (Brasil) · pt-pt · pl
- ✅ **Plural inflection** for all duration keys (`{one, other}` everywhere) (v1.4.9)
- ✅ **Auto-updater** via GitHub Releases (electron-builder)
- ✅ **macOS code signing + notarization** (App Store Connect API Key path)
- ✅ **Windows code signing** via Microsoft Trusted Signing (Azure)
- ✅ **Cross-platform builds** — macOS (x64 + arm64), Windows (NSIS), Linux (AppImage)
- ✅ **Diagnostic report** — last 50 errors + env in a copyable Markdown blob

### Dev tooling
- ✅ **`npm run i18n:add`** — one command updates all 9 locales (v1.4.9)
- ✅ **`npm run i18n:check`** + **pre-commit hook** (.githooks/) — blocks commits on locale drift (v1.4.9)
- ✅ **CSS modularization** — split 8047-line `inventory.css` into 8 themed files under `renderer/css/` (v1.4.9)
- ✅ **`renderer/CODEMAP.md`** — feature → line range index for the 12k-line `inventory.js` (post-v1.4.9)

---

## 🚧 Next up — concrete work

Items where the spec is written and we know roughly how to do it. Ranked by ratio (impact / effort × risk).

### 🥇 TigerTag POD — dual-reader scan / write / recycle workstation

The TigerTag POD is a desktop hardware unit with **two ACR122U USB NFC readers**. It turns the desktop app into a one-stop tool for the full chip lifecycle — read into inventory, write fresh chips, repurpose chips that are no longer needed.

Today, only **one** reader is supported (single-card detail-panel-open flow). The POD use case requires a richer model: identify which slot fired, treat both slots as a coordinated workstation, and add **surgical page-level write** capability (never erase-and-rewrite — see *Cross-cutting: surgical page-level writes* below).

#### 🔧 Sub-feature A — Multi-reader detection
- **Where**: [`main.js` L153-200](main.js) — `initNFC()` already binds `nfc.on('reader', …)` per reader, but the IPC payload doesn't carry a stable reader id, so the renderer overwrites slot 1 with slot 2 on every `reader-status` message. Fix: include `reader.name` (or a hashed `slotId`) in every IPC payload, and the renderer keeps a `Map<slotId, status>` instead of one global state.
- **UI**: dual-status pill in the header (`POD slot 1 ✓ · POD slot 2 ✓`) replacing the single `#rfidStatus`.
- **Persistence**: assign each reader a stable role (`primary` / `secondary`) on first plug-in, persist in `localStorage` keyed by the reader name so the same physical reader keeps the same slot across launches.
- **Effort**: S
- **Risk**: low (read-only changes to existing IPC).

#### 🔧 Sub-feature B — Spool scan workflow → inventory
- **Trigger**: chip detected on either slot. If a matching `state.rows` entry exists → open detail panel (current behaviour, kept).
- **New**: if the UID is unknown (not yet in Firestore inventory), open a **new "Add spool from scan" sheet** prefilled with the parsed TigerTag fields (TAG_ID, PRODUCT_ID, MATERIAL_ID, ASPECT, TYPE, DIAMETER, color RGB, …). One-click "Add to inventory" writes to `users/{uid}/inventory/{spoolId}`.
- **Spec**: full byte-layout in [`docs/rfid-vendors/tigertag.md`](docs/rfid-vendors/tigertag.md) — read offsets, field types, lookup table references.
- **Twin auto-detect**: if a chip is detected on slot 2 within ≤ 5 s of a chip on slot 1, AND both share the same `id_brand` + `id_material` + `id_type` + RGB, propose a "These are twins → link?" inline confirmation. Same atomic batch as the existing manual `linkTwinPair` (renderer/inventory.js L2410-2558) — write `twin_tag_uid` cross-references on both docs.
- **Effort**: M
- **Risk**: low (writes are batched + reversible).

#### 🔧 Sub-feature C — Write fresh TigerTag chip
- **Goal**: blank NTAG → fully-formatted TigerTag chip with brand/material/color/RGB metadata, ready to be put on a new spool.
- **`nfc-pcsc` API**: supports `reader.write(blockNumber, buffer)` and `reader.transmit(cmd, responseLen)` — raw APDU available. Need to add a new `ipcMain.handle('nfc:write', …)` channel in main.js that takes `(slotId, payloadBytes)`.
- **UI**: a new "Create chip" wizard in the spool detail panel (visible only when the POD is detected and a blank chip is on slot 2). Steps: pick brand/material/type/diameter → pick color (TD1S sensor, color picker, or copy from another chip) → confirm → write all 4-byte chunks per [tigertag.md](docs/rfid-vendors/tigertag.md). Show a per-page progress bar.
- **Validation**: read-back-and-compare after write. Refuse to mark the chip as ready if any byte differs.
- **Signature** *(non-issue by design)*:
  - **TigerTag (basic)** chips are unsigned — write freely.
  - **TigerTag+ (premium)** chips carry a factory ECDSA signature computed only over **pages 4 & 5** of the chip — the `TAG_ID` (`OFF_TAG_ID`) + `PRODUCT_ID` (`OFF_PRODUCT_ID`) immutable identity. Every other field (`MATERIAL_ID` onwards, color, TD, aspect, etc.) is on later pages and is **freely rewritable without invalidating the signature**. The signature stays valid because we never touch pages 4-5.
  - **Implementation guard**: refuse any write whose target page < 6. The write path should refuse to touch the identity region as a safety net even if a future bug computes the wrong offset.
- **Effort**: M (was L before the signing clarification)
- **Risk**: low-medium — surgical page-level writes (no erase pass) cut the failure surface, but chip writes are still non-reversible at the byte level. Stage on disposable NTAGs first.

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
- **Confirmation**: hold-to-confirm 1.5 s pattern (same as Delete spool) before triggering the write sequence. Show "This action cannot be undone — chip data will be replaced."
- **Where in code**: new file `renderer/lib/rfid/tigertag-recycle.js` for the byte-level operations, `renderer/lib/rfid/ndef-builder.js` for the NDEF record generation. UI lives in a new "Recycle" tab inside the existing toolbox of the spool detail panel (visible only for empty/deleted spools when a chip is on the POD).
- **Effort**: M (NDEF record format is well documented + widely implemented).
- **Risk**: low — surgical writes mean the immutable identity stays intact and the user can always tell the chip was originally a TigerTag.

#### 🔧 Sub-feature E — Sync edits back to chip (write-when-present)

The user can already edit TD and color from the spool detail panel today (TD modal + Color modal → Firestore). The chip is **not** updated automatically — instead, the spool gets flagged `needUpdateAt = Date.now()`, a refresh badge appears in the table / grid / detail panel, and a banner offers a "Updated" button which the user clicks **after** re-programming the chip with a separate tool. With the POD, this last step becomes automatic.

Existing infrastructure to reuse (already in `renderer/inventory.js`):
- `CHIP_FIELDS = ["TD", "online_color_list"]` — list of fields that live on the chip
- `_saveTdHex()` — sets `needUpdateAt = Date.now()` when a `CHIP_FIELDS` member is included in the update; writes both spools in a single batch when the spool has a twin
- `chipPendingHint` / `btnChipDone` — banner + clear-flag UX already wired and translated in 9 locales
- Badges: `chip-badge thumb-chip-badge` (table), `card-chip-badge` (grid), `panel-img-icon-badge` (detail panel hero), `chip-update-banner` (detail panel section)

What changes with the POD:
- **Detect-on-slot logic**: when a chip lands on the POD AND `state.rows.find(r.uid==chipUid).needUpdateAt != null`, instead of opening the detail panel, open a **"Sync changes" modal** showing a diff (`color: #6e6e6e → #d83b3b`, `TD: 1.85 → 2.10`) with a single "Apply to chip" button.
- **Batched diff write**: on confirm, the renderer asks main.js to write all diff fields in one APDU sequence (fewer writes = lower risk of partial state). On success → batch-clear `needUpdateAt` on the spool + its twin (already wired by the existing "Updated" button code path — just trigger it programmatically).
- **Read-back-and-verify** after every write — refuse to clear `needUpdateAt` if any byte didn't take.
- **Multi-pending UX**: if 3 fields were edited since the last sync, the modal shows all 3 in one list — same chip write, one round trip. (The existing `needUpdateAt` is just a timestamp, but at sync time we re-parse the chip and compare to the Firestore doc, so the diff is automatically the union of all pending edits — no need to track per-field flags.)
- **Writable field set**: the spec at [`docs/rfid-vendors/tigertag.md`](docs/rfid-vendors/tigertag.md) suggests we could expand `CHIP_FIELDS` beyond `TD` + `online_color_list` to include `MATERIAL_ID`, `ASPECT1_ID`, `ASPECT2_ID`, `TYPE_ID`, `DIAMETER_ID`. Out of scope for first ship — keep the existing 2-field set, then expand. All these fields live on pages ≥ 6, safely away from the signature.
- **Signature**: not an issue (see Sub-feature C). The TigerTag+ factory signature is computed only over pages 4-5 (`TAG_ID` + `PRODUCT_ID` — immutable identity), and Sub-feature E never touches those pages. Basic TigerTag chips are unsigned. The signature stays valid through any number of edit cycles.

- **Effort**: S (the UI plumbing exists; only the diff modal + the IPC `nfc:write-fields` handler are new — provided Sub-feature C's write infrastructure is in place).
- **Risk**: low (read-back verification + transactional clear; same code paths as the existing manual flow).
- **Dependency**: Sub-feature C (write capability). E can ship the **diff modal + UX** independently and stub the actual write to no-op until C lands; that gives users a clearer "what changed" view today even without the chip-write path.

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

Three drivers cover most of the universe:
1. **`drivers/moonraker.js`** — WebSocket on `:7125/websocket`. Snapmaker today; Creality K-series, Wondermaker, generic Klipper all reuse this verbatim.
2. **`drivers/bambu-mqtt.js`** — MQTTS on `:8883`. Bambu LAN mode + Cloud bridge.
3. **`drivers/flashforge-http.js`** — HTTP polling on Flashforge's `/control/*` endpoints (AD5X / 5M / 5M Pro).

A `drivers/index.js` dispatcher routes by `printer.brand` (with a `printer.protocol` override for "generic Klipper" printers that need explicit Moonraker selection).

A possible 4th driver later: `drivers/elegoo-mqtt.js` for Centauri — **research-gated** (see F5 below).

#### Per-brand status

| Brand | Protocol | Discovery | Driver | Status |
|---|---|---|---|---|
| **Snapmaker** | Moonraker WS (`:7125`) | mDNS `_snapmaker._tcp.local.` | `moonraker` | ✅ shipping |
| **Bambu Lab** | MQTTS (`:8883`) — LAN mode + Cloud bridge | mDNS `_bambu._tcp.local.` (broadcasts model + serial) | `bambu-mqtt` | New driver. Auth = printer access code (printed on the device, user enters once). LAN mode requires "Local print" enabled on the printer. |
| **Creality K-series** (K1, K1 Max, K2 Plus) | Moonraker WS (`:7125`) | mDNS `_octoprint._tcp.local.` (when present) or hostname-based | `moonraker` | Reuses existing driver. Plug into the Snapmaker codepath via brand-aware connect URL. |
| **Elegoo Centauri** | MQTTS — Chitu cloud bridge | TBD (research) | `elegoo-mqtt` (research-gated) | Lower priority — research first whether LAN mode exists or if cloud-only. |
| **FlashForge** (AD5X, 5M, 5M Pro) | HTTP polling on `:8898` for status; WebSocket on `:8899` for live updates on newer firmware | UDP broadcast on `48899` with magic byte | `flashforge-http` | New driver. Less rich than Moonraker (no temperature stream — poll every 2s). |
| **Generic Klipper / Wondermaker** | Moonraker WS (`:7125`) | mDNS varies; falls back to manual IP | `moonraker` | Reuses existing driver. New brand entry "Klipper machine" with a manual-IP-only flow (auto-discovery is hit-or-miss across Klipper distros). |
| (Future) Prusa MK4 / MINI | PrusaLink HTTP (`:80`) | mDNS `_prusalink._tcp.local.` | `prusa-http` | Out of scope for first ship; add to the model JSON files later. |

#### Sub-features — recommended ship order

##### F1 — Driver interface extraction *(refactor)*
- Create `renderer/lib/drivers/index.js` + `moonraker.js`. Move all `snap*` functions out of `inventory.js` into the Moonraker driver. The `renderPrinterDetail()` codepath calls `drivers[printer.brand].getStatus()` instead of `snapMergeStatus()` directly.
- **Effort**: M  ·  **Risk**: low (zero new functionality, only reshapes existing code; live tests on Snapmaker keep regressions visible).
- **Win**: code-map for `inventory.js` shrinks by ~1700 lines; new brands plug in cleanly afterwards. Partial down-payment on the long-parked "modularize inventory.js" item.

##### F2 — Klipper-class enablement *(quick win after F1)*
- With F1 done, **Creality K-series, Wondermaker, and generic Klipper** light up immediately by reusing the Moonraker driver.
- For Creality K-series: detect at `/server/info` time whether the host is a Klipper-class device and surface a "Connect via Moonraker" path (some older Creality models run a different stack — fall back to read-only card).
- For "generic Klipper": brand picker gets a new entry labelled `Klipper machine (generic)`, single field "IP / hostname", no model picker (or a "free text" model field).
- **Effort**: S each, M for the three combined  ·  **Risk**: low.

##### F3 — Bambu Lab MQTT driver *(headline feature)*
- New driver hitting `mqtts://{ip}:8883` with username `bblp`, password = printer access code, topic `device/{serial}/report` for telemetry, `device/{serial}/request` for commands.
- **Reuses the Snapmaker live block UI** — filament grid, temps, print-job card. Bambu's protocol carries the same shape of data, just under different field names.
- **Camera**: Bambu uses an RTSP stream — known cross-platform pain point. First ship probably skips camera and shows the "Photo card" fallback. Phase 2 if a JS RTSP→MJPEG bridge proves stable.
- **Discovery**: mDNS `_bambu._tcp.local.` — reuse the existing `bonjour-service` integration in `main.js`.
- **Effort**: L  ·  **Risk**: medium (MQTT is well-understood, but Bambu has rolled out sudden firmware changes that broke 3rd-party tools historically — keep the parser defensive).

##### F4 — FlashForge HTTP driver *(medium reach)*
- Polling design: every 2s call `/control/getStatus` and equivalent. Newer firmware exposes a WebSocket — opportunistic upgrade after first poll succeeds.
- Discovery: UDP broadcast on port 48899 with the documented magic packet.
- Live block: temps + active job. No mid-print filament editing (Snapmaker's bottom-sheet stays a unique capability — Flashforge's HTTP API doesn't expose the equivalent endpoints today).
- **Effort**: M  ·  **Risk**: low-medium (protocol is documented; friction is FlashForge's mix of firmware versions in the wild).

##### F5 — Elegoo Centauri MQTT driver *(research-gated)*
- **Decide first**: does Centauri expose a LAN MQTT endpoint, or is everything through Chitu cloud?
- If LAN MQTT exists: same scope as F3.
- If cloud-only: **out of scope** (the app is local-first; cloud integrations require a different trust model, secrets handling, OAuth flows, …). Park as a separate feature with its own design doc.
- **Effort**: S (research) + L (impl if LAN exists)  ·  **Risk**: high (unknown reachability).

##### F6 — Brand picker + discovery flow polish
- Per-brand discovery panels analogous to the Snapmaker scan side panel: mDNS browse, port-scan fallback, "Add by IP" widget. Generic-Klipper gets only "Add by IP" (no auto-discovery).
- Per-brand settings form — different fields per brand: Bambu wants `ip` + `accessCode` + `serial`, Klipper just wants `ip`, FlashForge `ip` only.
- **Effort**: M  ·  **Risk**: low.

#### 🧮 Total effort
F1: M  ·  F2: M  ·  F3: L  ·  F4: M  ·  F5: ~S+L (gated)  ·  F6: M → **~XL combined**, ships incrementally:
- **Quickest win → biggest reach**: F1 → F2 → F6 (Klipper-class brands live with mostly-existing UI)
- **Headline brand**: F3 (Bambu)
- **Long tail**: F4 (FlashForge) → F5 (Elegoo, gated on research)

#### 🎯 Recommended sequence
1. **F1** — extract the driver interface (no new functionality, but clears the way and shrinks `inventory.js`)
2. **F2** — Klipper-class brands light up immediately by reusing the Moonraker driver (Creality K-series, Wondermaker, generic Klipper). Big perceived progress for low effort.
3. **F6** — brand picker UX cleanup so the new brands are clickable with the right per-brand forms
4. **F3** — Bambu Lab MQTT (headline feature, biggest user base after Snapmaker)
5. **F4** — FlashForge HTTP
6. **F5** — Elegoo Centauri (research first, build only if LAN mode is reachable)

#### 📐 Cross-cutting note
After F1 + F2, the CODEMAP entry for the Snapmaker section will need a rewrite (it'll point to `renderer/lib/drivers/moonraker.js` instead of an inline range in `inventory.js`). Update CODEMAP.md as part of F1's commit.

---

### 🥉 Multi-vendor RFID parsers — 7 vendors remaining
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
- **TigerScale enhancements** — current scale panel shows heartbeat + battery; could add: tare action, multi-spool weighing, automatic transfer of weight to the active spool.
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
