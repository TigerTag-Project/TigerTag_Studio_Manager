# Creality — Rétro-ingénierie & état de l'intégration

> **Matériel testé** : Ender-3 V4 (`model: "F009"`) @ `192.168.40.106`
> OpenWrt 21.02-SNAPSHOT · armv7l · Klipper + Moonraker + serveur Creality propriétaire
>
> **Sources croisées** :
> - Session SSH live sur l'imprimante (mai 2026)
> - Code Flutter source : `lib/screens/creality_websocket_page.dart`
> - Intégration Home Assistant : `github.com/3dg1luk43/ha_creality_ws`
>
> **Légende** :
> ✅ Exploité — implémenté et affiché dans l'UI Tiger Studio
> 🔶 Capturé — reçu et stocké dans `conn.data`, pas encore affiché
> ⬜ Connu — documenté, pas encore capturé
> ❌ Non supporté / inconnu sur cette imprimante

---

## 1. Transport

| Propriété | Valeur |
|-----------|--------|
| Protocole | WebSocket (plain, pas de TLS) |
| Port | **9999** |
| URL | `ws://<ip>:9999` |
| Auth | Aucune (réseau local) ou Basic via URL credentials |
| Caméra | WebRTC port **8000** (HTML page avec signaling `/call/webrtc_local`) |
| Moonraker | HTTP port **7125** (start print, delete file) |
| Web-server propriétaire | HTTP port **80** (`/downloads/humbnail/<file>.png`) |

### Heartbeat — critique

Le printer envoie `{"ModeCode":"heart_beat"}` périodiquement.
On **doit** répondre avec la chaîne littérale `ok` (pas du JSON) sous peine de déconnexion silencieuse.

```
Printer → Client : {"ModeCode":"heart_beat"}
Client  → Printer: ok                          ← ASCII brut, PAS {"ok":true}
```

---

## 2. Format des messages

### Client → Printer : `get`
```json
{ "method": "get", "params": { "<paramName>": 1, ... } }
```
Plusieurs params dans la même trame OK.

### Client → Printer : `set`
```json
{ "method": "set", "params": { "<commandName>": { ...payload } } }
```

### Printer → Client : réponses
Objets JSON plats (pas d'enveloppe, pas d'écho du `method`).
Plusieurs réponses peuvent arriver en rafale suite à une seule requête.

⚠️ Beaucoup de valeurs numériques arrivent en **strings JSON** (`"27.940000"`) — toujours parser avec `parseFloat()`.

---

## 3. Paramètres `get` — usage et exemples de réponse

### Stratégie d'envoi (Tiger Studio)

| Moment | Requête |
|--------|---------|
| Connexion WS (une seule fois) | `CRE_INIT_QUERY` — tous les params + `reqMaterials` + `getGcodeFileInfo2` |
| Ouverture du file explorer | `CRE_QUERY_FILES` — `getGcodeFileInfo2` uniquement |
| Après impression / suppression | `CRE_QUERY_FILES` — rafraîchir la liste |

Le printer **pousse des updates tout seul** après `CRE_INIT_QUERY`. Pas de polling périodique.

---

### 3.1 `boxsInfo` ✅

**Usage** : état complet du système de filament (extrudeur EXT + modules CFS).

**Requête** :
```json
{ "method": "get", "params": { "boxsInfo": 1 } }
```

**Réponse réelle** (Ender-3 V4 avec module CFS 4 slots) :
```json
{
  "boxsInfo": {
    "same_material": [
      ["000003", "0D4C8AA", [{"boxId": 1, "materialId": 0}], "PETG"],
      ["001001", "0FF8B1F", [{"boxId": 1, "materialId": 2}], "PLA"]
    ],
    "materialBoxs": [
      {
        "id": 0,
        "state": 0,
        "type": 1,
        "materials": [
          {
            "id": 0,
            "vendor": "Generic",
            "type": "PLA",
            "color": "#0ff00ff",
            "name": "Generic PLA",
            "minTemp": 0,
            "maxTemp": 0,
            "selected": 0,
            "pressure": 0.04,
            "percent": 100,
            "editStatus": 1,
            "rfid": "00001",
            "state": 1
          }
        ]
      },
      {
        "id": 1,
        "state": 1,
        "type": 0,
        "temp": 27,
        "humidity": 45,
        "materials": [
          {
            "id": 0,
            "vendor": "Generic",
            "type": "PETG",
            "name": "Generic PETG",
            "rfid": "00003",
            "color": "#0d4c8aa",
            "minTemp": 0,
            "maxTemp": 0,
            "pressure": 0.07,
            "percent": 100,
            "state": 1,
            "selected": 0,
            "editStatus": 1
          },
          {
            "id": 1,
            "vendor": "Hyper",
            "type": "PLA",
            "name": "Hyper PLA",
            "rfid": "0",
            "color": "#0ff5722",
            "minTemp": 0,
            "maxTemp": 0,
            "pressure": 0.04,
            "percent": 100,
            "state": 0,
            "selected": 0,
            "editStatus": 0
          },
          {
            "id": 2,
            "vendor": "Creality",
            "type": "PLA",
            "name": "Hyper PLA",
            "rfid": "01001",
            "color": "#0ff8b1f",
            "minTemp": 190,
            "maxTemp": 240,
            "pressure": 0.04,
            "percent": 100,
            "state": 1,
            "selected": 0,
            "editStatus": 1
          },
          {
            "id": 3,
            "vendor": "Generic",
            "type": "HIPS",
            "name": "Generic HIPS",
            "rfid": "0",
            "color": "#0c8a4d6",
            "minTemp": 0,
            "maxTemp": 0,
            "pressure": 0.04,
            "percent": 100,
            "state": 0,
            "selected": 0,
            "editStatus": 0
          }
        ]
      }
    ]
  }
}
```

**Règles** :
- `type: 1` → slot EXT (toujours `id: 0`, 1 seul slot, pas de `temp`/`humidity`)
- `type: 0` → module CFS multi-slots (4 slots sur V4)
- `temp` / `humidity` : capteur interne du module CFS (entiers — 27 °C, 45 %)
- `state: 0` sur un slot EXT = pas de filament chargé dans l'extrudeur
- `editStatus: 0` + `rfid: "0"` = slot non configuré
- `same_material` : tableau de tuples `[rfidCode, colorCode, [{boxId, materialId}], type]` — slots physiquement matchés par RFID
- Couleur au format `#0rrggbb` — voir §7

---

### 3.2 `boxConfig` 🔶

**Usage** : configuration des boîtes (capacité, firmware boîte, etc.). Stocké brut, non affiché.

**Requête** :
```json
{ "method": "get", "params": { "boxConfig": 1 } }
```

**Réponse réelle** (Ender-3 V4) :
```json
{
  "boxConfig": {
    "autoRefill": 1,
    "cAutoFeed": 1,
    "cSelfTest": 0,
    "cAutoUpdateFilament": 0
  }
}
```

| Champ | Valeur | Signification |
|-------|--------|---------------|
| `autoRefill` | 0/1 | Refill automatique activé |
| `cAutoFeed` | 0/1 | Alimentation auto CFS |
| `cSelfTest` | 0/1 | Auto-test actif |
| `cAutoUpdateFilament` | 0/1 | Mise à jour auto du profil filament |

---

### 3.3 `reqGcodeFile` ✅

**Usage** : forcer l'envoi du nom du fichier courant / dernier imprimé.

**Requête** :
```json
{ "method": "get", "params": { "reqGcodeFile": 1 } }
```

**Réponse** : pas de message séparé — le printer inclut `printFileName` dans le blob statut initial.

```json
{
  "printFileName": "/mnt/UDISK/printer_data/gcodes/Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
  "printFileType": 1,
  "printProgress": 100,
  "printStartTime": 1778377703
}
```

⚠️ Path complet — extraire le basename avec `path.substring(path.lastIndexOf("/") + 1)`.

---

### 3.4 `reqGcodeList` ❌

**Usage** : liste brute des fichiers gcode (sans thumbnails ni durées).
Non utilisé dans Tiger Studio — remplacé par `getGcodeFileInfo2`.

**Requête** :
```json
{ "method": "get", "params": { "reqGcodeList": 1 } }
```

**Réponse** : aucune réponse distincte observée sur Ender-3 V4 lors des tests réels.
Le param est inclus dans `CRE_INIT_QUERY` mais ne génère pas de message séparé.
Possible que le résultat soit embarqué dans le blob statut ou non supporté sur ce FW.

---

### 3.5 `reqMaterials` 🔶

**Usage** : catalogue Klipper des profils matière (params d'impression par type).
Envoyé uniquement à la connexion initiale (`CRE_INIT_QUERY`). Stocké brut.

**Requête** :
```json
{ "method": "get", "params": { "reqMaterials": 1 } }
```

**Réponse réelle** (structure réelle — profil complet Klipper, exemple PLA tronqué) :
```json
{
  "retMaterials": [
    {
      "engineVersion": "3.0.0",
      "printerIntName": "F009",
      "nozzleDiameter": ["0.4"],
      "kvParam": {
        "filament_type": "PLA",
        "filament_vendor": "Creality",
        "nozzle_temperature": "220",
        "nozzle_temperature_initial_layer": "220",
        "nozzle_temperature_range_high": "240",
        "nozzle_temperature_range_low": "190",
        "hot_plate_temp": "60",
        "hot_plate_temp_initial_layer": "60",
        "filament_density": "1.24",
        "filament_diameter": "1.75",
        "filament_flow_ratio": "0.95",
        "pressure_advance": "0.04",
        "fan_max_speed": "100",
        "fan_min_speed": "100",
        "filament_max_volumetric_speed": "23",
        "temperature_vitrification": "60",
        "inherits": "Hyper PLA @Creality Ender V4 0.4 nozzle"
        // … ~50 champs supplémentaires
      },
      "base": {
        "id": "01001",
        "brand": "Creality",
        "name": "Hyper PLA",
        "meterialType": "PLA",
        "colors": ["#ffffff"],
        "density": 1.24,
        "diameter": "1.75",
        "minTemp": 190,
        "maxTemp": 240,
        "isSoluble": false,
        "isSupport": false,
        "dryingTemp": 0,
        "dryingTime": 0
      }
    }
    // … un objet par profil matière dans la bibliothèque (PLA-CF, PETG, …)
  ]
}
```

**Champs clés dans `base`** (les seuls utilisés dans Tiger Studio) :

| Champ | Type | Valeur exemple | Usage |
|-------|------|----------------|-------|
| `id` | string | `"01001"` | RFID-like ID interne |
| `meterialType` | string | `"PLA"` | Type (⚠️ typo : `meterial`) |
| `name` | string | `"Hyper PLA"` | Nom commercial |
| `minTemp` | number | `190` | Temp nozzle min |
| `maxTemp` | number | `240` | Temp nozzle max |
| `dryingTemp` | number | `0` | Étuvage °C (0 = non renseigné) |
| `dryingTime` | number | `0` | Étuvage heures (0 = non renseigné) |

---

### 3.6 `getGcodeFileInfo2` ✅

**Usage** : liste enrichie des fichiers gcode avec thumbnails, durées, couleurs, températures, poids filament.
C'est la requête principale du file explorer Tiger Studio.

**Requête** :
```json
{ "method": "get", "params": { "getGcodeFileInfo2": 1 } }
```

**Réponse réelle** (Ender-3 V4 — 2 exemples : mono-couleur et 4 couleurs) :
```json
{
  "retGcodeFileInfo2": [
    {
      "custom_types":   1,
      "type":           8,
      "name":           "Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
      "path":           "/mnt/UDISK/printer_data/gcodes/Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
      "file_size":      138548,
      "create_time":    1761292120,
      "timeCost":       208,
      "consumables":    158,
      "floorHeight":    20,
      "modelX":         0,
      "modelY":         0,
      "modelZ":         0,
      "modelHeight":    4200,
      "layerHeight":    0,
      "material":       "PLA",
      "nozzleTemp":     22000,
      "bedTemp":        6000,
      "software":       "Creality",
      "thumbnail":      "/mnt/UDISK/creality/local_gcode/humbnail/Wheel logo-Ender-3 V4-PLA_3m28s.png",
      "preview":        "/mnt/UDISK/creality/local_gcode/original/Wheel logo-Ender-3 V4-PLA_3m28s.png",
      "startPixel":     1700,
      "endPixel":       22900,
      "materialColors": "#00FF00",
      "materialIds":    "01001",
      "filamentWeight": "0.47",
      "match":          "T1A=T1C "
    },
    {
      "custom_types":   1,
      "type":           8,
      "name":           "Maker2-Ender-3 V4-PLA_1h1m.gcode",
      "path":           "/mnt/UDISK/printer_data/gcodes/Maker2-Ender-3 V4-PLA_1h1m.gcode",
      "file_size":      2106025,
      "create_time":    1761292118,
      "timeCost":       3662,
      "consumables":    4462,
      "floorHeight":    20,
      "modelX":         0,
      "modelY":         0,
      "modelZ":         0,
      "modelHeight":    1000,
      "layerHeight":    0,
      "material":       "PLA;PLA;PLA;PLA",
      "nozzleTemp":     19000,
      "bedTemp":        6000,
      "software":       "Creality",
      "thumbnail":      "/mnt/UDISK/creality/local_gcode/humbnail/Maker2-Ender-3 V4-PLA_1h1m.png",
      "preview":        "/mnt/UDISK/creality/local_gcode/original/Maker2-Ender-3 V4-PLA_1h1m.png",
      "startPixel":     2200,
      "endPixel":       20300,
      "materialColors": "#211C16;#65B167;#FFFFFF;#B1BBBD",
      "materialIds":    ";;;",
      "filamentWeight": "8.74, 2.20, 0.89, 1.47",
      "match":          "T1A=  T1B=  T1C=  T1D=T1C "
    }
  ]
}
```

**Encodages à connaître** :

| Champ | Encodage | Exemple | Valeur réelle |
|-------|----------|---------|---------------|
| `nozzleTemp` | °C × 100 | `22000` | 220 °C |
| `bedTemp` | °C × 100 | `6000` | 60 °C |
| `timeCost` | secondes | `208` | 3 min 28 s |
| `consumables` | mm × 100 ? | `158` | ~1.58 m filament |
| `floorHeight` | µm | `20` | 0.02 mm (1ère couche) |
| `modelHeight` | µm | `4200` | 4.2 mm |
| `materialColors` | hex RGB séparés par `;` | `"#211C16;#65B167"` | 2 couleurs |
| `material` | labels séparés par `;` | `"PLA;PLA;PLA;PLA"` | 4 matières |
| `materialIds` | IDs séparés par `;` | `"01001"` ou `";;;"` si non mappé |
| `filamentWeight` | grammes séparés par `,` | `"8.74, 2.20, 0.89, 1.47"` | poids par couleur |
| `file_size` | octets | `138548` | ⚠️ `file_size` (underscore), pas `fileSize` |
| `create_time` | timestamp UNIX (secondes) | `1761292120` | tri par date |
| `match` | mapping slots | `"T1A=T1C "` | correspondance CFS↔filament |

**Champs non documentés dans les anciennes versions** :
- `preview` : path PNG grande résolution (vs `thumbnail` petite)
- `startPixel` / `endPixel` : zone de prévisualisation dans le PNG
- `match` : ex. `"T1A=T1C "` = extrudeur T1 alimenté par slot C du module
- `software` : slicer utilisé (`"Creality"` = Creality Print)

**URL thumbnail** : voir §9.3 — `_creThumbUrl()` extrait le basename du champ `thumbnail` et construit `http://<ip>/downloads/humbnail/<basename>.png`.

Pour la miniature du **print en cours** (URL fixe, indépendante du nom de fichier) — voir §9.2.

---

### 3.7 Bundle statut (réponse initiale + push périodique)

**Réponse initiale** : un seul message de **76 clés** arrive immédiatement après `CRE_INIT_QUERY`.
Il contient l'état complet de l'imprimante (remplace tous les params individuels).

**Push périodique** : uniquement `nozzleTemp` + `bedTemp0` (mini-blob, toutes ~1.5 s).
```json
{ "nozzleTemp": "76.900000", "bedTemp0": "50.200000" }
```

**Blob initial complet réel** (Ender-3 V4, idle après impression, CFS connecté) :
```json
{
  "TotalLayer":         0,
  "accelToDecelLimits": 3000,
  "accelerationLimits": 6000,
  "aiDetection":        0,
  "aiFirstFloor":       0,
  "aiPausePrint":       0,
  "aiSw":               0,
  "autoLevelResult":    "148:0.79",
  "autohome":           "X:0 Y:0 Z:0",
  "auxiliaryFanPct":    0,
  "bedTemp0":           "50.350000",
  "bedTemp1":           "0.000000",
  "bedTemp2":           "0.000000",
  "bedTempAutoPid":     0,
  "boxTemp":            0,
  "caseFanPct":         0,
  "cfsConnect":         1,
  "connect":            1,
  "cornerVelocityLimits": 8,
  "curFeedratePct":     100,
  "curFlowratePct":     100,
  "curPosition":        "X:0.00 Y:220.00 Z:58.56",
  "dProgress":          0,
  "deviceState":        0,
  "enableSelfTest":     0,
  "err":                { "errcode": 0, "key": 0, "value": "" },
  "fan":                0,
  "fanAuxiliary":       0,
  "fanCase":            0,
  "feedState":          0,
  "hostname":           "Ender-3_V4-574A",
  "layer":              0,
  "lightSw":            1,
  "materialDetect":     0,
  "materialDetector1":  1,
  "materialDetector2":  0,
  "materialStatus":     0,
  "maxBedTemp":         100,
  "maxBoxTemp":         0,
  "maxNozzleTemp":      300,
  "model":              "F009",
  "modelFanPct":        0,
  "modelVersion":       "printer hw ver:;printer sw ver:;DWIN hw ver:CR4NU200360C20;DWIN sw ver:1.1.0.45;",
  "nozzleMoveSnapshot": 0,
  "nozzleTemp":         "77.910000",
  "nozzleTempAutoPid":  0,
  "powerLoss":          0,
  "pressureAdvance":    "0.040000",
  "printFileName":      "/mnt/UDISK/printer_data/gcodes/Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
  "printFileType":      1,
  "printId":            "",
  "printJobTime":       0,
  "printLeftTime":      0,
  "printProgress":      100,
  "printStartTime":     1778377703,
  "realTimeFlow":       "72.160000",
  "realTimeSpeed":      "50.000000",
  "repoPlrStatus":      0,
  "smoothTime":         "0.040000",
  "state":              0,
  "targetBedTemp0":     0,
  "targetBedTemp1":     0,
  "targetBedTemp2":     0,
  "targetBoxTemp":      0,
  "targetNozzleTemp":   0,
  "tfCard":             1,
  "upgradeStatus":      0,
  "usedMaterialLength": 0,
  "velocityLimits":     500,
  "video":              1,
  "video1":             0,
  "videoElapse":        1,
  "videoElapseFrame":   15,
  "videoElapseInterval":1,
  "webrtcSupport":      1,
  "withSelfTest":       100
}
```

**Clés non documentées avant le test réel** :
| Clé | Valeur observée | Interprétation |
|-----|-----------------|----------------|
| `autoLevelResult` | `"148:0.79"` | `<nb_points>:<écart_max_mm>` |
| `autohome` | `"X:0 Y:0 Z:0"` | Position home |
| `accelToDecelLimits` | 3000 | Accélération entrée/sortie mm/s² |
| `accelerationLimits` | 6000 | Accélération max mm/s² |
| `cornerVelocityLimits` | 8 | Junction deviation mm/s |
| `velocityLimits` | 500 | Vitesse max mm/s |
| `materialDetector1/2` | 1 / 0 | Capteur runout slot 1/2 (1 = filament présent) |
| `materialStatus` | 0 | État général alimentation |
| `repoPlrStatus` | 0 | État reprise impression power-loss |
| `withSelfTest` | 100 | % auto-test |
| `videoElapse` | 1 | Timelapse activé |
| `videoElapseFrame` | 15 | Nb frames timelapse |
| `printProgress` | 100 | 100% = dernière impression terminée |
| `printStartTime` | 1778377703 | Timestamp UNIX début du dernier job |
| `smoothTime` | `"0.040000"` | Paramètre lissage de courbe |
| `dProgress` | 0 | Progression transfert fichier USB |
| `boxTemp` | 0 | Température chambre (0 = non mesuré sur V4 sans enceinte) |

---

## 4. Champs de statut — détail complet

### 4.1 Températures

| Clé wire | Type | Stocké dans | UI | Notes |
|----------|------|-------------|-----|-------|
| `nozzleTemp` | `string` | `d.nozzleTemp` | ✅ | Ex : `"27.940000"` — parser `asF` |
| `targetNozzleTemp` | `string` | `d.nozzleTarget` | ✅ | Set-point |
| `bedTemp0` | `string` | `d.bedTemp` | ✅ | |
| `targetBedTemp0` | `string` | `d.bedTarget` | ✅ | |
| `boxTemp` | `string` | `d.chamberTemp` | ✅ affiché si > 0 | Alias: `chamberTemp` certains FW |
| `maxNozzleTemp` | `number` | `d.maxNozzleTemp` | 🔶 | 300 sur V4 |
| `maxBedTemp` | `number` | `d.maxBedTemp` | 🔶 | 100 sur V4 |

### 4.2 État impression

| Clé wire | Type | Stocké dans | UI | Notes |
|----------|------|-------------|-----|-------|
| `state` | `number` | `d.state` | ✅ | 0=idle 1=printing 2=fini |
| `deviceState` | `number` | `d.deviceState` | 🔶 | Sous-état interne |
| `feedState` | `number` | `d.feedState` | 🔶 | État alimentation |
| `printProgress` | `number` | `d.printProgress` | ✅ | 0–100 |
| `dProgress` | `number` | `d.dProgress` | ✅ fallback | Transfert fichier |
| `layer` | `number` | `d.layer` | ✅ | Couche courante |
| `TotalLayer` | `number` | `d.totalLayer` | ✅ | Note : T majuscule |
| `printLeftTime` | `number` | `d.printLeftTime` | ✅ | Secondes restantes |
| `printJobTime` | `number` | `d.printJobTime` | ✅ | Secondes écoulées |
| `printFileName` | `string` | `d.printFileName` | ✅ | Path complet — extraire basename |
| `historyList` | `array` | `d.lastHistoryFilename` | ✅ fallback | `[{ filename }]` |
| `pause` | `number` | `d.isPaused` | ✅ | 1 = en pause |
| `isPaused` | `number` | `d.isPaused` | ✅ | Alias FW alternatif |

### 4.3 Vitesse / mouvement

| Clé wire | Type | Stocké dans | UI | Notes |
|----------|------|-------------|-----|-------|
| `curFeedratePct` | `number` | `d.curFeedratePct` | 🔶 | Multiplicateur vitesse % |
| `curFlowratePct` | `number` | `d.curFlowratePct` | 🔶 | Multiplicateur débit % |
| `curPosition` | `string` | `d.curPosition` | 🔶 | `"X:5.00 Y:110.00 Z:20.59"` |
| `realTimeSpeed` | `string` | `d.realTimeSpeed` | 🔶 | mm/s — parser `asF` |
| `realTimeFlow` | `string` | `d.realTimeFlow` | 🔶 | mm³/s |
| `pressureAdvance` | `string` | `d.pressureAdvance` | 🔶 | Ex : `"0.040000"` |
| `usedMaterialLength` | `string` | `d.usedMaterialLength` | 🔶 | mm consommés |

### 4.4 Hardware / périphériques

| Clé wire | Type | Stocké dans | UI | Notes |
|----------|------|-------------|-----|-------|
| `lightSw` | `number` | `d.lightSw` | ✅ | 1 = LED allumée |
| `cfsConnect` | `number` | `d.cfsConnect` | 🔶 | 1 = module CFS branché |
| `webrtcSupport` | `number` | `d.webrtcSupport` | 🔶 | |
| `video` | `number` | `d.video` | 🔶 | Caméra dispo |
| `hostname` | `string` | `d.hostname` | ✅ | Ex : `"Ender-3V4-574A"` |
| `model` | `string` | `d.model` | 🔶 | `"F009"` = Ender-3 V4 |
| `modelVersion` | `string` | `d.modelVersion` | 🔶 | String DWIN hw/sw complet |
| `err` | `object` | `d.errCode/Key/Value` | 🔶 | `{ errcode, key, value }` |

---

## 5. `boxsInfo` — structure CFS (détail)

```
boxsInfo.materialBoxs[]
  ├── id        : index dans le tableau (0-based)
  ├── boxId     : ID physique à renvoyer dans modifyMaterial
  ├── type      : 1 = slot EXT, 0 = boîte CFS multi-slots
  ├── temp      : température interne boîte CFS (°C, 0 si EXT)
  ├── humidity  : humidité relative interne (%)
  └── materials[]
        ├── id         : index slot dans la boîte (0-based)
        ├── vendor     : "Generic", "Creality", …
        ├── type       : "PLA", "PETG", …
        ├── color      : "#0rrggbb" — voir §7
        ├── name       : "<vendor> <type>"
        ├── rfid       : code type matière ("00001" = PLA)
        ├── minTemp    : temp min nozzle
        ├── maxTemp    : temp max nozzle
        ├── pressure   : pressure advance (float)
        ├── percent    : % restant (0–100)
        ├── selected   : 1 si slot actif
        └── editStatus : 1 = configuré par l'utilisateur

boxsInfo.same_material[]
  // Tableau de tuples — matériaux RFID identifiés présents dans le système
  // Format : [rfidCode, colorCode, [{boxId, materialId}], materialType]
  // Ex : ["001001", "0FF8B1F", [{"boxId": 1, "materialId": 2}], "PLA"]
  //   → rfid "001001" (couleur #0FF8B1F) est en slot 2 du CFS box 1
```

| Layout Ender-3 V4 + CFS | boxId | type | Slots |
|--------------------------|-------|------|-------|
| Extrudeur externe (EXT) | 0 | 1 | 1 (id: 0) |
| Module CFS | 1 | 0 | 4 (id: 0–3) |

---

## 6. Commandes `set`

### 6.1 `modifyMaterial` ✅

```json
{
  "method": "set",
  "params": {
    "modifyMaterial": {
      "id":         0,
      "boxId":      1,
      "rfid":       "00001",
      "type":       "PLA",
      "vendor":     "Generic",
      "name":       "Generic PLA",
      "color":      "#0ff5722",
      "minTemp":    190,
      "maxTemp":    230,
      "pressure":   0.04,
      "selected":   1,
      "percent":    100,
      "editStatus": 1,
      "state":      1
    }
  }
}
```

### 6.2 `lightSw` ✅

```json
{ "method": "set", "params": { "lightSw": 1 } }
{ "method": "set", "params": { "lightSw": 0 } }
```

### 6.3 `pause` / reprise ✅

```json
{ "method": "set", "params": { "pause": 1 } }
{ "method": "set", "params": { "pause": 0 } }
```

### 6.4 `stop` ✅

```json
{ "method": "set", "params": { "stop": 1 } }
```

### 6.5 Commandes connues, non implémentées ⬜

| Commande | Payload exemple | Effet |
|----------|----------------|-------|
| `curFeedratePct` | `{"curFeedratePct": 120}` | Multiplicateur vitesse (0–200) |
| `curFlowratePct` | `{"curFlowratePct": 95}` | Multiplicateur débit (0–200) |

---

## 7. Format couleur : `#0rrggbb`

Creality utilise du **ARGB 8 caractères** avec l'octet alpha toujours à `0` :

```
#0rrggbb
 ^       octet alpha fixe à "0" (= pleinement opaque dans leur convention)
  ^^^^^^ R, G, B en hex
```

| Wire | RGB | Couleur |
|------|-----|---------|
| `#0d4c8aa` | `(212,200,170)` | Beige |
| `#0ff5722` | `(255,87,34)` | Orange |
| `#0ff8b1f` | `(255,139,31)` | Ambre |
| `#0ff00ff` | `(255,0,255)` | Magenta |

**Conversions** (✅ implémentées) :
```js
// Printer → color picker HTML (#rrggbb)
if (/^#0[0-9a-f]{6}$/i.test(raw)) colorVal = "#" + raw.slice(2);

// Color picker HTML → printer (#0rrggbb)
const colorHex = "#0" + pickerValue.replace("#", "").toLowerCase();
```

---

## 8. Moonraker HTTP (port 7125)

Utilisé en parallèle du WS pour les actions fichiers.

| Action | Méthode | Endpoint | Body |
|--------|---------|----------|------|
| Lancer impression | `POST` | `/printer/print/start` | `{"filename": "benchy.gcode"}` |
| Supprimer fichier | `DELETE` | `/server/files/gcodes/<filename>` | — |
| Liste fichiers (non utilisé) | `GET` | `/server/files/list?root=gcodes` | — |

---

## 9. Web-server propriétaire (port 80) — images

### 9.1 Vue d'ensemble

Le firmware expose un serveur HTTP minimaliste sur le port 80, **distinct de Moonraker (port 7125)**.
Il sert uniquement des fichiers statiques depuis `/mnt/UDISK` mappé en `/downloads/`.

⚠️ Typo intentionnelle dans le firmware : le dossier s'appelle `humbnail` (sans `t`).

---

### 9.2 Miniature du print en cours ← le cas clé

**URL fixe** (ne dépend pas du nom de fichier) :
```
http://<ip>/downloads/original/current_print_image.png
```

**Comportement** :
- Le firmware **écrase ce fichier à chaque frame** pendant l'impression — c'est une image live, pas un static.
- Résolution : variable selon le modèle (typiquement 200×200 à 400×400 px sur V4).
- Retourne **HTTP 404** si aucune impression n'est en cours (ou si le fichier n'a jamais été créé).
- Reste accessible après fin d'impression jusqu'au prochain démarrage (snapshot de la dernière frame).

**Logique d'affichage dans Tiger Studio** :

```js
// renderCreJobCard() — index.js

// 1. Priorité : thumbnail pré-slicé du fichier (fiable, spécifique au fichier)
let thumbUrl = null;
if (fileName && Array.isArray(d.fileList)) {
  const match = d.fileList.find(f => f.name === fileName);
  if (match) thumbUrl = _creThumbUrl(conn, match); // /downloads/humbnail/<file>.png
}
// 2. Fallback : frame caméra live — UNIQUEMENT pendant une impression active
if (!thumbUrl && isPrinting) {
  thumbUrl = `http://${conn.ip}/downloads/original/current_print_image.png`;
}
// 3. Pas de thumbnail (job terminé sans fileList chargée, ou idle sans contexte)
```

**Pourquoi ne PAS utiliser `current_print_image.png` pour les jobs terminés** :
après la fin d'une impression, cette image reste celle du job précédent jusqu'au prochain boot.
Si l'utilisateur n'a pas relancé d'impression, il verrait la miniature du **mauvais fichier**.
Le thumbnail pré-slicé du fichier (`/downloads/humbnail/`) est toujours correct et disponible même hors impression.

**Pourquoi `background-image` et pas `<img>`** : si l'URL répond 404, un `<img>` afficherait l'icône "image cassée". Un `background-image` échoue silencieusement — le div reste vide, sans artefact visuel.

---

### 9.3 Thumbnails des fichiers gcode (liste)

Chaque entrée `retGcodeFileInfo2` contient deux champs de chemin filesystem :

| Champ | Chemin exemple | Usage |
|-------|----------------|-------|
| `thumbnail` | `/mnt/UDISK/creality/local_gcode/humbnail/Wheel logo-….png` | Miniature ~96×96 px |
| `preview` | `/mnt/UDISK/creality/local_gcode/original/Wheel logo-….png` | Grande résolution |

**Conversion chemin → URL HTTP** (fonction `_creThumbUrl()` — index.js) :

```js
function _creThumbUrl(conn, f) {
  // On extrait uniquement le basename (le sous-dossier varie selon FW)
  const base = String(f.thumbnail || "").split("/").pop();
  return base
    ? `http://${conn.ip}/downloads/humbnail/${encodeURIComponent(base)}`
    : "";
}
// Exemple : f.thumbnail = "/mnt/UDISK/creality/local_gcode/humbnail/Benchy.png"
//           → http://192.168.40.106/downloads/humbnail/Benchy.png
```

**⚠️ Le sous-dossier dans le chemin filesystem (`local_gcode/humbnail/`) n'est pas la route HTTP.**
Seul le **basename** (nom de fichier) est utilisé — le serveur le mappe directement sous `/downloads/humbnail/`.

---

### 9.4 Résumé des routes

| Route HTTP | Chemin filesystem | Contenu | Quand disponible |
|------------|-------------------|---------|-----------------|
| `/downloads/original/current_print_image.png` | `/mnt/UDISK/creality/local_gcode/original/current_print_image.png` | Frame live du print en cours | Pendant et après impression |
| `/downloads/humbnail/<file>.png` | `/mnt/UDISK/creality/local_gcode/humbnail/<file>.png` | Miniature ~96×96 du gcode | Dès le slicing |
| `/downloads/original/<file>.png` | `/mnt/UDISK/creality/local_gcode/original/<file>.png` | Preview grande résolution | Dès le slicing |

---

## 10. Codes modèle

| `model` | Imprimante |
|---------|-----------|
| `F009` | Ender-3 V4 |

`modelVersion` sur V4 : `"DWIN hw ver:CR4NU200360C20;DWIN sw ver:1.1.0.45;"`

---

## 11. Ce qui est implémenté dans Tiger Studio

### ✅ Opérationnel

| Fonctionnalité | Fichier / Fonction |
|----------------|-------------------|
| Connexion WebSocket + reconnexion exponentielle | `creOpenSocket()` |
| Heartbeat `{ModeCode:"heart_beat"}` → `"ok"` | handler message |
| Init unique `CRE_INIT_QUERY` (pas de polling) | `ws.open` |
| Températures nozzle / bed / chambre + indicateur chauffe | `renderCreTempCard()` |
| Progression impression, couche, temps restant/écoulé | `renderCreJobCard()` |
| Thumbnail job en cours (`/downloads/original/`) | `renderCreJobCard()` |
| Spinner animation sur état "Printing" | CSS `.snap-job-state--printing::before` |
| Slots filament EXT + CFS 4 slots | `renderCreFilamentCard()` |
| Bottom-sheet édition filament (type, vendor, couleur) | `openCreFilamentEdit()` |
| Commande `modifyMaterial` (format vérifié live) | `creSendSet()` |
| Conversion couleur `#0rrggbb` ↔ `#rrggbb` | `openCreFilamentEdit()` |
| Toggle LED (`lightSw`) — hold-button ampoule | `creActionLed()` |
| Pause / reprise — hold 1 s | `creActionPause()` |
| Annulation impression — hold 2 s | `creActionStop()` |
| File explorer en bottom sheet (dossier icône) | `openCreFileSheet()` |
| Thumbnails fichiers (`/downloads/humbnail/`) | `_creThumbUrl()` |
| Infos fichiers : durée, couleurs, poids, matière, temps | `_creFileListHtml()` |
| Lancer impression via Moonraker POST | `creActionPrintFile()` |
| Supprimer fichier Moonraker DELETE — hold 2 s | `creActionDeleteFile()` |
| Log WS (entrées/sorties, expandable, copy) | `renderCreLogInner()` |
| Badge online/offline + ping 30 s | `crePingPrinter()` |
| Caméra WebRTC — `<iframe>` vers `http://<ip>:8000/webrtc` (même approche Snapmaker) | `renderCrealityLiveInner()` cam-banner block |

### 🔶 Capturé, pas encore affiché

| Champ(s) | Action future |
|----------|----|
| `boxsInfo.materialBoxs[].temp` / `.humidity` | Afficher temp °C + humidité % par module CFS |
| `d.curFeedratePct`, `d.curFlowratePct` | Curseurs vitesse/débit dans job card |
| `d.curPosition` | Affichage XYZ en debug ou job card |
| `d.realTimeSpeed`, `d.realTimeFlow` | Stats live sous la progress bar |
| `d.pressureAdvance` | Info slot filament actif |
| `d.usedMaterialLength` | Consommation mm dans job card |
| `d.cfsConnect` | Masquer section CFS si `0` |
| `d.errCode`, `d.errKey`, `d.errValue` | Bandeau erreur dans job card |
| `d.maxNozzleTemp`, `d.maxBedTemp` | Clamper slider températures |
| `d.model`, `d.modelVersion` | Affichage dans settings imprimante |
| `boxsInfo.same_material[]` | Groupage visuel slots identiques |

### ⬜ Connu mais pas encore capturé

| Commande / champ | Notes |
|-----------------|-------|
| `set curFeedratePct/curFlowratePct` | Tuning live pendant impression |
| Événements `ModeCode: "notify"` | Re-fetch boxsInfo sur événement |

---

## 12. Bugs / dettes connues

| Problème | Impact | Fix |
|----------|--------|-----|
| Section CFS affichée même si `cfsConnect: 0` | Slot vide visible à tort | Conditionner sur `d.cfsConnect` |
| `creStateLabel()` ne couvre que 3 états (0/1/2) | État `3`/`4` affiché "Idle" | Étendre le switch |
| Pas de gestion `err.errcode !== 0` | Erreurs silencieuses | Bandeau rouge dans job card |
| ~~Thumbnail job fixe `current_print_image.png` — image du mauvais fichier après fin d'impression~~ | **Fixé** — priorité au thumbnail pré-slicé du fichier (`/downloads/humbnail/`) ; `current_print_image.png` uniquement en fallback pendant une impression active | `renderCreJobCard()` |

---

*Mis à jour : 2026-05-10 — post-refacto Tiger Studio (no-poll, file sheet, hold-to-confirm)*
