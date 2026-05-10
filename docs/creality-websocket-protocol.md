# Creality WebSocket Protocol — Field Reference & Integration Notes

> **Source of truth**: Live SSH + WebSocket session on an Ender-3 V4 (model `F009`)
> at `192.168.40.106` (root / Creality2024) — OpenWrt 21.02-SNAPSHOT, armv7l.
> Cross-referenced against the mobile Flutter source
> (`lib/screens/creality_websocket_page.dart`) and the HA integration
> (`github.com/3dg1luk43/ha_creality_ws`).

---

## 1. Transport

| Property | Value |
|----------|-------|
| Protocol | WebSocket (plain, no TLS) |
| Port | **9999** |
| URL | `ws://<ip>:9999` |
| Frame encoding | UTF-8 JSON, **except the heartbeat reply** which is the literal ASCII string `"ok"` |
| Auth | None (LAN-only; the printer trusts the local network) |

---

## 2. Message framing

### Client → Printer: `get`

```json
{ "method": "get", "params": { "<paramName>": 1, ... } }
```

Multiple params can be requested in a single frame.

### Client → Printer: `set`

```json
{ "method": "set", "params": { "<commandName>": { ...payload } } }
```

### Printer → Client: responses

Responses always arrive as flat JSON objects. There is **no envelope** with a method echo — the only way to identify what was returned is by the presence of specific top-level keys.

### Heartbeat (bidirectional)

The printer sends `{ "ModeCode": "heart_beat" }` periodically.  
You **must** reply with the literal string `ok` (not JSON) within a few seconds or the connection is dropped silently.

```
Printer → Client : {"ModeCode":"heart_beat"}
Client → Printer : ok                          ← literal ASCII, NOT {"ok":true}
```

---

## 3. Known `get` params

| Param key | Returns | Recommended cadence |
|-----------|---------|---------------------|
| `ReqPrinterPara` | Full printer status (temps, state, fans, speed, position …) | Every 5 s |
| `boxsInfo` | CFS filament module tree | On connect, then every 5 min (or on filament-change event) |
| `boxConfig` | Box configuration | On connect |
| `reqGcodeFile` | Current file on the printer | On connect / job-start event |
| `reqGcodeList` | List of files stored on printer | On demand |
| `reqMaterials` | Full Klipper material params per slot (`retMaterials`) | On connect, after boxsInfo |

**Current Studio Manager poll** (sends all of these every 2 s) is wasteful.  
Recommended split: `ReqPrinterPara` every 5 s; `boxsInfo + reqMaterials` only on connect
and on `ModeCode: "notify"` filament-change events.

---

## 4. `ReqPrinterPara` — full field reference

All fields arrive as **top-level keys** in the response object.  
⚠️ Many numeric fields are transmitted as **JSON strings** (e.g. `"27.940000"`). Always
parse with `parseFloat()` / `Number()` before arithmetic.

### 4.1 Temperatures

| Wire key | Type on wire | Description |
|----------|-------------|-------------|
| `nozzleTemp` | `string` | Actual nozzle temperature (°C) |
| `targetNozzleTemp` | `string` | Nozzle set-point |
| `bedTemp0` | `string` | Actual bed temperature (°C) |
| `targetBedTemp0` | `string` | Bed set-point |
| `boxTemp` | `string` | Chamber / enclosure temperature (alias: `chamberTemp` in some FW) |
| `maxNozzleTemp` | `number` | Hardware nozzle limit (300 on V4) |
| `maxBedTemp` | `number` | Hardware bed limit (100 on V4) |
| `maxBoxTemp` | `number` | Hardware chamber limit (0 if no enclosure) |

### 4.2 Print state

| Wire key | Type | Description |
|----------|------|-------------|
| `state` | `number` | Main print state — see §4.5 |
| `deviceState` | `number` | Sub-state / error code |
| `feedState` | `number` | Filament feed state |
| `printProgress` | `number` | Overall progress 0–100 (integer %) |
| `dProgress` | `number` | Download / transfer progress |
| `layer` | `number` | Current layer (1-based) |
| `TotalLayer` | `number` | Total layers (note capital T) |
| `printLeftTime` | `number` | Estimated remaining time (seconds) |
| `printJobTime` | `number` | Elapsed print time (seconds) |
| `printFileName` | `string` | Active filename (may include path — strip with `lastIndexOf("/")`) |
| `historyList` | `array` | Last N completed jobs — `[{ filename, … }]` |
| `pause` | `number` | 1 if paused |
| `isPaused` | `number` | Alias of `pause` seen in some FW versions |

### 4.3 Motion / speed

| Wire key | Type | Description |
|----------|------|-------------|
| `curFeedratePct` | `number` | Speed multiplier % (e.g. 50 = half speed) |
| `curFlowratePct` | `number` | Flow-rate multiplier % |
| `curPosition` | `string` | Tool position — `"X:5.00 Y:110.00 Z:20.59"` (parse manually) |
| `realTimeSpeed` | `string` | Instantaneous head speed (mm/s) as string |
| `realTimeFlow` | `string` | Instantaneous flow rate as string |
| `pressureAdvance` | `string` | Active pressure-advance value as string (e.g. `"0.040000"`) |
| `usedMaterialLength` | `string` | Filament consumed in current job (mm) as string |

### 4.4 Hardware / peripherals

| Wire key | Type | Description |
|----------|------|-------------|
| `lightSw` | `number` | LED strip on/off (1 = on) |
| `cfsConnect` | `number` | CFS module plugged in (1 = connected) |
| `webrtcSupport` | `number` | WebRTC camera support (1 = supported) |
| `video` | `number` | Live camera available |
| `hostname` | `string` | mDNS hostname |
| `model` | `string` | Model code — see §6 |
| `modelVersion` | `string` | Full firmware version string (includes DWIN hw + sw versions) |
| `err` | `object` | Error object — `{ errcode: 0, key: 0, value: "" }` (nested, not flat) |

### 4.5 `state` codes

These are Klipper-layer codes surfaced by Creality firmware:

| Value | Meaning |
|-------|---------|
| `0` | Idle / standby |
| `1` | Printing |
| `2` | Paused |
| `3` | Complete |
| `4` | Error / cancelled |

> The Studio Manager renderer already maps numeric state codes to string labels
> (`creStateLabel()`). The stateText field in `creMergeStatus` is reserved for
> future use if the printer ever sends a string state directly.

---

## 5. `boxsInfo` — CFS filament module structure

Full nested structure of the response:

```
{
  "boxsInfo": {
    "materialBoxs": [
      {
        "id":     <number>,   // slot index (0-based in the outer box array)
        "boxId":  <number>,   // physical box ID sent back in modifyMaterial
        "type":   <number>,   // 1 = external extruder slot, 0 = CFS multi-slot box
        "temp":   <number>,   // internal temp (CFS box only, °C)
        "humidity": <number>, // relative humidity inside CFS box (%)
        "materials": [
          {
            "id":         <number>,   // slot index within this box (0-based)
            "state":      <number>,   // 0 = empty?, 1 = loaded?
            "type":       <number>,   // slot type (1 = ext, 0 = CFS slot)
            "vendor":     <string>,   // e.g. "Generic", "Creality"
            "color":      <string>,   // "#0rrggbb" format — see §7
            "name":       <string>,   // display name e.g. "Generic PLA"
            "rfid":       <string>,   // material type code e.g. "00001"
            "minTemp":    <number>,   // min print temp (may be 0 if unset)
            "maxTemp":    <number>,   // max print temp (may be 0 if unset)
            "pressure":   <number>,   // pressure advance value (float)
            "percent":    <number>,   // remaining % (0-100)
            "selected":   <number>,   // 1 if this slot is active
            "editStatus": <number>,   // 1 = user-configured, 0 = factory/empty
          }
        ]
      }
    ],
    "same_material": [
      // Array of arrays — each inner array lists [boxIdx, slotIdx] pairs
      // that share the same material. Useful for multi-color grouping UI.
      // Example: [[0, 0], [1, 2]] means EXT slot 0 and CFS slot 2 are
      // loaded with the same material type.
    ]
  }
}
```

### Box types

| `type` value | Meaning |
|-------------|---------|
| `1` | External extruder (single slot, boxId typically 0) |
| `0` | CFS multi-material module (4 slots, boxId typically 1) |

### Known box / slot layout (Ender-3 V4 with CFS)

| Box index | boxId | type | Slots |
|-----------|-------|------|-------|
| 0 | 0 | 1 (EXT) | 1 (id: 0) |
| 1 | 1 | 0 (CFS) | 4 (id: 0–3) |

---

## 6. `retMaterials` — Klipper material parameters

Returned alongside the `boxsInfo` response when `reqMaterials: 1` is in the get params.
Contains a full Klipper/slicer parameter block per material slot — useful for syncing
print profiles but not required for identification or filament-edit UI.

Structure (not fully transcribed — long kvParam strings):

```json
{
  "retMaterials": {
    "materialBoxs": [
      {
        "id": 0,
        "materials": [
          {
            "id": 0,
            "kvParam": "<long klipper config string>"
          }
        ]
      }
    ]
  }
}
```

The `kvParam` contains Klipper pressure advance, extruder tuning, and slicer defaults.
**Not needed for Tiger Studio Manager filament display/edit.**

---

## 7. Color format: `#0rrggbb`

Creality uses an **8-character ARGB hex string** where the first byte is always the
alpha channel (fixed at `0`, meaning full opacity in their encoding — counter-intuitive
but confirmed):

```
#0rrggbb
 ^        always literal "0" (alpha byte, value 0 = fully opaque in Creality's scheme)
  ^^^^^^  6 hex chars for R, G, B
```

Examples confirmed from live printer:
- `#0d4c8aa` → `rgb(212, 200, 170)` (beige)
- `#0ff5722` → `rgb(255, 87, 34)` (orange)
- `#0ff8b1f` → `rgb(255, 139, 31)` (amber)
- `#0ff00ff` → `rgb(255, 0, 255)` (magenta)

### Conversion helpers (already in Studio Manager)

```js
// Printer → HTML color picker input (#rrggbb)
if (/^#0[0-9a-f]{6}$/i.test(raw)) colorVal = "#" + raw.slice(2);

// HTML color picker → printer (#0rrggbb)
const colorHex = "#0" + pickerValue.replace("#", "").toLowerCase();
```

---

## 8. `set` commands

### 8.1 `modifyMaterial` — edit a filament slot

The **only correct** command for writing filament data. The earlier `boxsInfo.materialBoxs`
set approach does NOT work.

```json
{
  "method": "set",
  "params": {
    "modifyMaterial": {
      "id":         <number>,   // slot index within the box (0-based)
      "boxId":      <number>,   // physical box ID from boxsInfo.materialBoxs[n].boxId
      "rfid":       "<string>", // material type code — use crealityID from id_material.json
      "type":       "<string>", // material label e.g. "PLA"
      "vendor":     "<string>", // vendor name e.g. "Generic"
      "name":       "<string>", // full display name — convention: "<vendor> <type>"
      "color":      "<string>", // "#0rrggbb" format
      "minTemp":    <number>,   // minimum print temp (°C)
      "maxTemp":    <number>,   // maximum print temp (°C)
      "pressure":   <number>,   // pressure advance (float, e.g. 0.04)
      "selected":   1,          // always 1
      "percent":    100,        // always 100
      "editStatus": 1,          // always 1
      "state":      1           // always 1
    }
  }
}
```

**Source of `rfid` / `minTemp` / `maxTemp` / `pressure`**: look up the material label
in `data/id_material.json` using `metadata.crealityID` and `metadata.crealityPressureAdvance`.
See §9 for the lookup function.

### 8.2 Other `set` commands (identified but not yet implemented)

| Command | Params | Effect |
|---------|--------|--------|
| `lightSw` | `{ "lightSw": 0 \| 1 }` | Turn LED strip off / on |
| `curFeedratePct` | `{ "curFeedratePct": <0-200> }` | Set speed multiplier % |
| `curFlowratePct` | `{ "curFlowratePct": <0-200> }` | Set flow-rate multiplier % |
| `pause` | `{ "pause": 1 \| 0 }` | Pause / resume active print |
| `stop` | `{ "stop": 1 }` | Cancel active print |

---

## 9. Material DB lookup (Studio Manager pattern)

Studio Manager's `data/id_material.json` contains 67 materials with Creality IDs.
The correct runtime lookup (already in `renderer/printers/creality/index.js`):

```js
const CRE_LABEL_ALIAS = {
  "Hyper PLA": "PLA High Speed",   // Creality marketing name → DB label
};

function creGetMaterialMeta(label) {
  const resolved = CRE_LABEL_ALIAS[label] ?? label;
  const mats = ctx.getState().db?.material ?? [];
  const m = mats.find(m => m.label === resolved);
  if (!m?.metadata?.crealityID) return { rfid: "0", minTemp: 190, maxTemp: 240, pressure: 0.04 };
  return {
    rfid:     String(m.metadata.crealityID),
    minTemp:  m.recommended?.nozzleTempMin ?? 190,
    maxTemp:  m.recommended?.nozzleTempMax ?? 240,
    pressure: m.metadata.crealityPressureAdvance ?? 0.04,
  };
}
```

Key material codes (rfid / crealityID):

| Label | crealityID | pressureAdvance |
|-------|-----------|----------------|
| PLA | 00001 | 0.04 |
| PLA High Speed ("Hyper PLA") | 01001 | 0.04 |
| PLA+ | 00002 | 0.04 |
| PETG | 00003 | 0.04 |
| ABS | 00004 | 0.02 |
| ASA | 00005 | 0.02 |
| TPU 95A | 00006 | 0.0 |

---

## 10. Model code mapping

| `model` value | Printer |
|---------------|---------|
| `F009` | Ender-3 V4 |

The `modelVersion` string on the V4 looks like:
```
DWIN hw ver:CR4NU200360C20;DWIN sw ver:1.1.0.45;
```

More codes can be added as they are discovered. The Studio Manager printer catalog
can be extended via `data/` JSON files using `modelCode` as the discriminator.

---

## 11. Current Studio Manager implementation status

### Already implemented (as of 2026-05-10)

| Feature | Status |
|---------|--------|
| WebSocket connect / reconnect (5 s back-off) | ✅ |
| Heartbeat (`{ModeCode:"heart_beat"}` → `"ok"`) | ✅ |
| Temperature display (nozzle / bed / chamber) | ✅ |
| Print progress, layer counter, time remaining | ✅ |
| Print state → human label | ✅ |
| Filament slot display (EXT + CFS 4-slot) | ✅ |
| Edit icon on filament color squares | ✅ |
| Filament edit bottom-sheet (type, vendor, color) | ✅ |
| `modifyMaterial` set command (correct format) | ✅ |
| Color format conversion `#0rrggbb` ↔ `#rrggbb` | ✅ |
| Material DB lookup from `id_material.json` | ✅ |
| `CRE_LABEL_ALIAS` for "Hyper PLA" → "PLA High Speed" | ✅ |
| Hostname / WebRTC / video fields | ✅ |

### Still to implement

| Feature | Notes |
|---------|-------|
| Split poll cadence | `ReqPrinterPara` every 5 s; `boxsInfo` only on connect + events |
| `lightSw` toggle in UI | Field parsed, no UI control yet |
| `cfsConnect` — show/hide CFS section | Parsed as `webrtcSupport`, needs own field |
| `curFeedratePct` / `curFlowratePct` | Parsed but not displayed |
| `curPosition` string parser | `"X:5.00 Y:110.00 Z:20.59"` → structured |
| `realTimeSpeed` / `realTimeFlow` | Arrive as strings, need parseFloat |
| `pressureAdvance` live display | Arrives as string |
| `err.errcode` error card | Nested object — `obj.err.errcode` |
| `pause` / `isPaused` → pause/resume button | Fields arrive but no UI action |
| `same_material[]` grouping in CFS UI | New discovery, no UI yet |
| Model code → model name map | `F009` = Ender-3 V4 |
| `maxNozzleTemp` / `maxBedTemp` — clamp sliders | Available in response |
| `historyList` — last job card | Useful for post-print state |
| `retMaterials` kvParam parsing | Low priority, Klipper internals |

---

## 12. Fields still needing `creMergeStatus` coverage

Add these to `creMergeStatus()` in `renderer/printers/creality/index.js`:

```js
// Peripherals
if ("lightSw"        in obj) d.lightSw        = asNum(obj.lightSw);
if ("cfsConnect"     in obj) d.cfsConnect      = asNum(obj.cfsConnect);

// Motion
if ("curFeedratePct" in obj) d.curFeedratePct  = asNum(obj.curFeedratePct);
if ("curFlowratePct" in obj) d.curFlowratePct  = asNum(obj.curFlowratePct);
if ("curPosition"    in obj) d.curPosition     = String(obj.curPosition || "");
if ("realTimeSpeed"  in obj) d.realTimeSpeed   = asF(obj.realTimeSpeed);
if ("realTimeFlow"   in obj) d.realTimeFlow    = asF(obj.realTimeFlow);
if ("pressureAdvance" in obj) d.pressureAdvance = asF(obj.pressureAdvance);
if ("usedMaterialLength" in obj) d.usedMaterialLength = asF(obj.usedMaterialLength);

// State nuance
if ("pause"          in obj) d.isPaused        = asNum(obj.pause) === 1;
if ("isPaused"       in obj) d.isPaused        = asNum(obj.isPaused) === 1; // FW alias

// Errors (nested object)
if (obj.err && typeof obj.err === "object") {
  d.errCode  = asNum(obj.err.errcode) ?? 0;
  d.errKey   = asNum(obj.err.key)     ?? 0;
  d.errValue = String(obj.err.value   || "");
}

// Limits (for slider clamping)
if ("maxNozzleTemp"  in obj) d.maxNozzleTemp   = asNum(obj.maxNozzleTemp);
if ("maxBedTemp"     in obj) d.maxBedTemp      = asNum(obj.maxBedTemp);

// Model info
if ("model"          in obj) d.model           = String(obj.model || "");
if ("modelVersion"   in obj) d.modelVersion    = String(obj.modelVersion || "");
```

---

## Appendix A — Raw WS session log excerpts

### `ReqPrinterPara` response (Ender-3 V4, idle)

```json
{
  "nozzleTemp": "27.940000", "targetNozzleTemp": "0.000000",
  "bedTemp0": "28.230000",   "targetBedTemp0": "0.000000",
  "boxTemp": "0.000000",
  "state": 0, "deviceState": 0, "feedState": 0,
  "printProgress": 100, "dProgress": 0,
  "printLeftTime": 0, "printJobTime": 0,
  "layer": 0, "TotalLayer": 0,
  "printFileName": "",
  "curFeedratePct": 50, "curFlowratePct": 100,
  "curPosition": "X:5.00 Y:110.00 Z:20.59",
  "realTimeSpeed": "50.000000", "realTimeFlow": "72.160000",
  "pressureAdvance": "0.040000", "usedMaterialLength": "0.000000",
  "lightSw": 1, "cfsConnect": 1,
  "webrtcSupport": 1, "video": 0,
  "maxNozzleTemp": 300, "maxBedTemp": 100, "maxBoxTemp": 0,
  "hostname": "Ender-3V4-xxx",
  "model": "F009",
  "modelVersion": "...DWIN hw ver:CR4NU200360C20;DWIN sw ver:1.1.0.45;",
  "err": { "errcode": 0, "key": 0, "value": "" }
}
```

### `boxsInfo` EXT slot (materialBoxs[0])

```json
{
  "id": 0, "boxId": 0, "type": 1,
  "materials": [{
    "id": 0, "state": 0, "type": 1,
    "vendor": "Generic", "type": "PLA",
    "color": "#0ff00ff", "name": "Generic PLA",
    "rfid": "00001",
    "minTemp": 0, "maxTemp": 0,
    "pressure": 0.04, "percent": 100,
    "selected": 0, "editStatus": 1, "state": 1
  }]
}
```

### `boxsInfo` CFS box (materialBoxs[1], 4 slots)

```json
{
  "id": 1, "boxId": 1, "type": 0,
  "temp": 26, "humidity": 47,
  "materials": [
    { "id": 0, "color": "#0d4c8aa", "vendor": "Generic", "name": "Generic PLA",  ... },
    { "id": 1, "color": "#0ff5722", "vendor": "Creality", "name": "Creality PLA+", ... },
    { "id": 2, "color": "#0ff8b1f", "vendor": "Generic",  "name": "Generic PETG", ... },
    { "id": 3, "color": "#0ff00ff", "vendor": "Generic",  "name": "Generic PLA",  ... }
  ]
}
```

---

*Document generated from live session — 2026-05-10.*
