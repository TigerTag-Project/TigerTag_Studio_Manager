# Protocole Creality LAN — Référence complète pour implémentation Node.js/Electron

> Extrait à partir des sources Flutter : `creality_websocket_page.dart`, `creality_scan_printers.dart`, `creality_main.dart`, widgets `camera_card`, `temperature_card`, `filament_card`, `print_card`, `printer_settings_card`, `websocket_logs_card`, et `creality_printer_brand_adapter.dart`.

---

## 1. Transport principal — WebSocket

| Paramètre | Valeur |
|-----------|--------|
| Protocole | `ws://` (texte, pas binaire) |
| Port | **9999** |
| Chemin | `/` |
| URI complète | `ws://<ip>:9999/` |
| Format des frames | JSON texte (UTF-8) |
| Direction | Bidirectionnel (push serveur + commandes client) |

L'imprimante **pousse son état en continu** sans que le client ait besoin de demander explicitement. Les frames arrivent en rafale dans la première seconde après connexion.

### Authentification (optionnelle)

Certains firmwares requièrent une authentification HTTP Basic sur le handshake WebSocket.

```
Authorization: Basic base64("account:password")
```

- `account` et `password` sont configurables par l'utilisateur.
- **Identifiants par défaut connus** : `root` / `creality_2025` (firmware LAN de certains modèles).
- Si le champ est vide des deux côtés, aucun header n'est envoyé.

```js
// Node.js (ws library)
const WebSocket = require('ws');

const account = 'root';
const password = 'creality_2025';
const token = Buffer.from(`${account}:${password}`).toString('base64');

const ws = new WebSocket('ws://192.168.1.100:9999/', {
  headers: {
    'Authorization': `Basic ${token}`
  }
});
```

Sans authentification :

```js
const ws = new WebSocket('ws://192.168.1.100:9999/');
```

---

## 2. Caméra — WebRTC via page HTML embarquée

| Paramètre | Valeur |
|-----------|--------|
| Port caméra | **8000** |
| Protocole | HTTP |
| Point d'entrée | `http://<ip>:8000/` |
| Type de flux | WebRTC (page HTML native de l'imprimante) |
| MJPEG direct | Non utilisé |

La caméra Creality expose une **page HTML complète** qui se charge dans un WebView (ou dans un `<iframe>` / `<webview>` Electron). La page gère elle-même la signalisation WebRTC et l'affichage vidéo. Il n'y a pas d'API de signalisation JSON exposée côté client — l'imprimante agit comme son propre serveur WebRTC et présente une IHM web autonome.

**En Electron** : utiliser `<webview>` ou `BrowserWindow` secondaire qui charge `http://<ip>:8000/`.

```js
// Electron renderer — ouverture caméra dans webview
const cameraUrl = `http://${printerIp}:8000/`;
document.getElementById('cameraWebview').src = cameraUrl;
```

```html
<!-- inventory.html -->
<webview
  id="cameraWebview"
  src="about:blank"
  allowpopups
  webpreferences="allowRunningInsecureContent"
  style="width:100%; aspect-ratio:16/9;">
</webview>
```

> **Remarque** : Le port 8000 est sondé lors de la découverte pour vérifier si la caméra est disponible, mais son statut n'influence pas la décision de connexion principale (port 9999 suffit).

---

## 3. Découverte réseau LAN

### Algorithme de scan

1. Construire la liste des IPs à sonder :
   - Sous-réseaux dérivés des IPs d'imprimantes déjà connues.
   - Sous-réseaux de seed fournis manuellement.
   - IP Wi-Fi locale → dériver le `/24`.
   - Sous-réseaux communs ajoutés systématiquement : `192.168.1.x` et `192.168.40.x`.
   - Pour chaque sous-réseau : hôtes 1 à 254.
2. Pour chaque IP de la liste (concurrence = 64) :
   a. Sonder TCP port 9999 (timeout 650 ms).
   b. Si fermé → ignorer.
   c. Si ouvert → ouvrir WebSocket + lire frames (timeout 2,2 s).
   d. Envoyer une requête `get printerInfo` immédiatement après connexion pour déclencher un payload d'identité.
   e. Agréger les clés JSON reçues (top-level + `params`, `msg`, `data`, `result`).
   f. Sonder TCP port 8000 (caméra) en parallèle.
3. Valider qu'il s'agit d'une Creality (règle `isCrealityLike` ci-dessous).

### Règle de validation `isCrealityLike`

L'hôte est une Creality si **les deux conditions suivantes sont vraies** :

**Condition A — Identité forte** (au moins l'une) :
- La payload contient la clé `model`
- La payload contient la clé `modelVersion`
- La payload contient la clé `deviceSn`
- Le hostname contient : `creality`, `k1`, `k2`, `ender`, `hi-`, `hi_` (insensible à la casse)

**Condition B — Télémétrie Creality** (au moins l'une) :
```
printerStatus | printProgress | printJobTime | nozzleTemp | targetNozzleTemp
bedTemp0 | bedTemp | targetBedTemp0 | targetBedTemp | boxTemp | chamberTemp
boxsInfo | cfsConnected | retMaterials | lightSw | webrtcSupport | ModeCode
curPosition | workingLayer | totalLayers | filename
```

Cette règle écarte les faux positifs (NAS, Nagios, domotique...) qui occupent parfois le port 9999.

### Structure du résultat de scan

```js
{
  ip: "192.168.1.42",
  wsPortOpen: true,       // port 9999 ouvert
  cameraPortOpen: true,   // port 8000 ouvert
  jsonConfirmed: true,    // règle isCrealityLike validée
  hostname: "Creality-K1",
  model: "F009",          // code firmware (ex: F009 = Ender 3 V4)
  modelVersion: "1.1.0.45",
  deviceSn: "CR4CXX...",
  account: "root",        // credential qui a fonctionné (null si sans auth)
  password: "creality_2025"
}
```

### Mapping modèle connu (code `model`)

| Code `model` | Modèle |
|-------------|--------|
| `F009` | Ender 3 V4 (id interne `10`) |
| `F022` | SparkX (id interne `11`) |

---

## 4. Séquence d'initialisation

```
Client                                Imprimante
  │                                       │
  ├─── TCP connect :9999 ─────────────────►│
  │                                       │
  ├─── WS Upgrade (+ Authorization si besoin) ─►│
  │                                       │
  │◄── Frames push (état initial) ─────────┤
  │    (nozzleTemp, bedTemp, printProgress…)│
  │                                       │
  ├─── {"method":"get","params":{          │
  │      "printerInfo":1}} ───────────────►│
  │                                       │
  │◄── Payload enrichi (model, hostname…) ─┤
  │                                       │
  ├─── {"method":"get","params":{          │
  │      "reqGcodeFile":1,                 │
  │      "reqGcodeList":1,                 │
  │      "boxsInfo":1,                     │
  │      "boxConfig":1,                    │
  │      "reqMaterials":1}} ──────────────►│
  │                                       │
  │◄── boxsInfo (filaments CFS) ───────────┤
  │◄── boxConfig ──────────────────────────┤
  │◄── retGcodeFile ───────────────────────┤
  │◄── retGcodeList ───────────────────────┤
  │◄── retMaterials (catalogue filaments) ─┤
  │                                       │
  │◄── Push continu (telemetry) ───────────┤
```

### Code Node.js — connexion complète

```js
const WebSocket = require('ws');

function connectCreality(ip, options = {}) {
  const { account, password } = options;
  const wsUrl = `ws://${ip}:9999/`;

  const headers = {};
  if (account && password) {
    const token = Buffer.from(`${account}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }

  const ws = new WebSocket(wsUrl, { headers });
  let state = {};

  ws.on('open', () => {
    console.log(`[Creality] Connecté à ${wsUrl}`);

    // Étape 1 : demander l'identité de l'imprimante
    ws.send(JSON.stringify({
      method: 'get',
      params: { printerInfo: 1 }
    }));

    // Étape 2 : demander filaments + fichiers G-code
    ws.send(JSON.stringify({
      method: 'get',
      params: {
        reqGcodeFile: 1,
        reqGcodeList: 1,
        boxsInfo: 1,
        boxConfig: 1,
        reqMaterials: 1
      }
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      mergeState(state, msg);
      // Notifier l'UI...
    } catch (e) {
      console.warn('[Creality] Frame non-JSON reçue:', data.toString().slice(0, 200));
    }
  });

  ws.on('close', () => console.log('[Creality] Déconnecté'));
  ws.on('error', (err) => console.error('[Creality] Erreur WS:', err.message));

  return ws;
}
```

---

## 5. Messages envoyés (Client → Imprimante)

Tous les messages sont des objets JSON avec la structure :

```json
{ "method": "<get|set>", "params": { ... } }
```

### 5.1 Requête d'identité

```json
{
  "method": "get",
  "params": { "printerInfo": 1 }
}
```

### 5.2 Requête filaments + fichiers G-code

```json
{
  "method": "get",
  "params": {
    "reqGcodeFile": 1,
    "reqGcodeList": 1,
    "boxsInfo": 1,
    "boxConfig": 1,
    "reqMaterials": 1
  }
}
```

- `reqGcodeFile` — demande le fichier G-code courant
- `reqGcodeList` — demande la liste des fichiers G-code
- `boxsInfo` — demande l'état du système CFS (filaments multi-bobines)
- `boxConfig` — configuration des boîtes de filament
- `reqMaterials` — catalogue des matériaux disponibles (payload volumineux)

### 5.3 Modifier un slot filament (commande `modifyMaterial`)

```json
{
  "method": "set",
  "params": {
    "modifyMaterial": {
      "id": 0,
      "boxId": 1,
      "rfid": "00001",
      "type": "PLA",
      "vendor": "Creality",
      "name": "Generic PLA",
      "color": "#0ff0000",
      "minTemp": 190.0,
      "maxTemp": 240.0,
      "pressure": 0.04,
      "selected": 1,
      "percent": 100,
      "editStatus": 1,
      "state": 1
    }
  }
}
```

#### Détail des champs `modifyMaterial`

| Champ | Type | Description |
|-------|------|-------------|
| `id` | `int` | Index du slot dans la boîte (0-based) |
| `boxId` | `int` | ID de la boîte : `0` = extrudeur externe, `1+` = module CFS |
| `rfid` | `string` | Identifiant Creality du matériau (ex: `"00001"` pour PLA). Valeur `"0"` si non référencé. |
| `type` | `string` | Type de filament (`"PLA"`, `"PETG"`, `"ABS"`, `"TPU"`, etc.) |
| `vendor` | `string` | Fabricant (ex: `"Creality"`, `"Generic"`) |
| `name` | `string` | Nom d'affichage complet (ex: `"Generic PLA"`) |
| `color` | `string` | Couleur en hex Creality : format `#0RRGGBB` (8 chars, préfixe `#0`) |
| `minTemp` | `double` | Température minimale buse (°C) |
| `maxTemp` | `double` | Température maximale buse (°C) |
| `pressure` | `double` | Pressure advance (typique : `0.04`) |
| `selected` | `int` | `1` = sélectionné |
| `percent` | `int` | Pourcentage de filament restant (0–100) |
| `editStatus` | `int` | `1` = édité manuellement |
| `state` | `int` | `1` = actif |

#### Encodage couleur Creality

Format : `#0RRGGBB` (chaîne de 8 caractères)

```js
function colorToCrealityHex(r, g, b) {
  const rh = r.toString(16).padStart(2, '0');
  const gh = g.toString(16).padStart(2, '0');
  const bh = b.toString(16).padStart(2, '0');
  return `#0${rh}${gh}${bh}`.toLowerCase();
}

// Exemple : rouge pur
colorToCrealityHex(255, 0, 0); // => "#0ff0000"
```

Décodage (depuis la payload `boxsInfo`) :

```js
function parseCrealityHex(s) {
  let hex = s.trim().replace(/^#/, '');
  if (hex.length === 7 && hex.startsWith('0')) hex = hex.slice(1); // supprimer le "0" préfixe
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  return { r: 128, g: 128, b: 128 }; // fallback gris
}
```

---

## 6. Messages reçus (Imprimante → Client)

L'imprimante pousse son état via des frames JSON. **Les clés ne sont pas groupées dans une structure unique** : chaque frame peut contenir n'importe quel sous-ensemble de champs. Il faut **merger les frames** dans un objet d'état local.

### 6.1 Fonction de merge d'état

```js
function mergeState(state, msg) {
  if (typeof msg !== 'object' || msg === null) return;

  // Extraction directe des clés connues
  const direct = [
    'hostname', 'model', 'modelVersion', 'deviceSn',
    'printerStatus', 'printProgress', 'printJobTime', 'printLeftTime',
    'nozzleTemp', 'targetNozzleTemp',
    'bedTemp0', 'bedTemp', 'targetBedTemp0', 'targetBedTemp',
    'boxTemp', 'chamberTemp',
    'layer', 'TotalLayer', 'curPosition',
    'printFileName', 'printStartTime', 'printId', 'printFileType',
    'state', 'deviceState', 'feedState', 'print_state',
    'err', 'errcode',
    'dProgress', 'usedMaterialLength',
    'current_object', 'excluded_objects', 'objects',
    'lightSw', 'webrtcSupport', 'ModeCode',
    'cfsConnected', 'totalJob', 'totalUsageTime', 'totalUsageMaterial'
  ];

  for (const key of direct) {
    if (key in msg) state[key] = msg[key];
  }

  // Caches dédiés
  if ('boxsInfo' in msg) state.boxsInfo = msg.boxsInfo;
  if ('boxConfig' in msg && typeof msg.boxConfig === 'object') state.boxConfig = msg.boxConfig;
  if ('reqGcodeFile' in msg) state.gcodeFile = msg.reqGcodeFile;
  if ('retGcodeFile' in msg) state.gcodeFile = msg.retGcodeFile;
  if ('reqGcodeList' in msg) state.gcodeList = msg.reqGcodeList;
  if ('retGcodeList' in msg) state.gcodeList = msg.retGcodeList;

  // Normalisation températures (arrivées souvent comme strings "219.930000")
  for (const key of ['nozzleTemp', 'bedTemp0', 'targetNozzleTemp', 'targetBedTemp0', 'boxTemp', 'chamberTemp']) {
    if (key in state && typeof state[key] === 'string') {
      state[key] = parseFloat(state[key]) || 0;
    }
  }

  // Historique d'impression
  if ('historyList' in msg && Array.isArray(msg.historyList) && msg.historyList.length > 0) {
    state.historyList = msg.historyList;
    const first = msg.historyList[0];
    if (first?.filename) state.lastHistoryFilename = first.filename;
    if (first?.printfinish != null) state.lastHistoryPrintFinish = parseInt(first.printfinish) || 0;
  }
}
```

### 6.2 Table d'extraction des champs

| Chemin JSON | Clé interne | Type | Notes |
|-------------|-------------|------|-------|
| `.hostname` | `hostname` | `string` | Nom réseau de l'imprimante |
| `.model` | `model` | `string` | Code modèle firmware (ex: `"F009"`) |
| `.modelVersion` | `modelVersion` | `string` | Version firmware (ex: `"1.1.0.45"`) |
| `.deviceSn` | `deviceSn` | `string` | Numéro de série |
| `.nozzleTemp` | `nozzle_temp` | `float` | Température buse actuelle (°C), souvent string à parser |
| `.targetNozzleTemp` | `targetNozzleTemp` | `float` | Consigne buse (°C) |
| `.bedTemp0` | `bed_temp` | `float` | Température plateau actuelle (°C) |
| `.targetBedTemp0` | `targetBedTemp` | `float` | Consigne plateau (°C) |
| `.boxTemp` | `chamber_temp` | `float` | Température enceinte / chambre (°C) |
| `.chamberTemp` | `chamber_temp` | `float` | Alt. température chambre (certains firmwares) |
| `.printProgress` | `printProgress` | `int` | Progression d'impression 0–100 |
| `.dProgress` | `dProgress` | `int` | Progression alternative (certains firmwares) |
| `.printLeftTime` | `printLeftTime` | `int` | Temps restant en secondes |
| `.printJobTime` | `printJobTime` | `int` | Temps écoulé depuis début en secondes |
| `.layer` | `layer` | `int` | Couche en cours |
| `.TotalLayer` | `TotalLayer` | `int` | Nombre total de couches (peut rester 0) |
| `.curPosition` | `curPosition` | `string/object` | Position XYZ courante |
| `.printFileName` | `printFileName` | `string` | Chemin/nom du fichier en cours |
| `.printStartTime` | `printStartTime` | `int/string` | Timestamp de début d'impression |
| `.printId` | `printId` | `string` | Identifiant interne du job |
| `.printFileType` | `printFileType` | `string` | Type de fichier |
| `.state` | `state` | `int` | État machine : `0`=idle, `2`=finished (valeurs intermédiaires possibles) |
| `.deviceState` | `deviceState` | `int` | Signal d'état machine secondaire |
| `.feedState` | `feedState` | `int` | Signal d'état d'alimentation filament |
| `.print_state` | `print_state` | `string` | État textuel (ex: `"printing"`) |
| `.err` | `err` | `object/int` | Erreur : `{errcode: N}` ou int direct |
| `.usedMaterialLength` | `usedMaterialLength` | `float` | Longueur de filament utilisée (mm) |
| `.lightSw` | `lightSw` | `int/bool` | État éclairage |
| `.webrtcSupport` | `webrtcSupport` | `bool` | Support WebRTC caméra |
| `.cfsConnected` | `cfsConnected` | `bool` | Système CFS connecté |
| `.ModeCode` | `ModeCode` | `int` | Code mode imprimante |
| `.boxsInfo` | `boxsInfo` | `object` | État complet des boîtes filament CFS |
| `.boxConfig` | `boxConfig` | `object` | Configuration des boîtes |
| `.retGcodeFile` / `.reqGcodeFile` | `gcodeFile` | `any` | Infos fichier G-code courant |
| `.retGcodeList` / `.reqGcodeList` | `gcodeList` | `any` | Liste des fichiers G-code |
| `.historyList[0].filename` | `lastHistoryFilename` | `string` | Dernier fichier imprimé |
| `.historyList[0].printfinish` | `lastHistoryPrintFinish` | `int` | Timestamp fin d'impression |
| `.totalJob` | `totalJob` | `int` | Nombre total de jobs |
| `.totalUsageTime` | `totalUsageTime` | `int` | Temps total d'utilisation |
| `.totalUsageMaterial` | `totalUsageMaterial` | `float` | Filament total consommé |

---

## 7. États d'impression

### 7.1 Codes numériques (`state`)

| Valeur | Signification |
|--------|---------------|
| `0` | Idle |
| `2` | Terminé (Finished) |
| autre | État intermédiaire (heating, paused, etc.) |

> **Note** : Les valeurs intermédiaires ne sont pas documentées officiellement. L'application affiche le code brut (`s:N`) en mode debug pour les capturer.

### 7.2 Champ `deviceState`

Signal d'état machine secondaire. Affiché comme `d:N` en debug. Valeurs non standardisées.

### 7.3 Champ `feedState`

Signal d'état d'alimentation filament. Affiché comme `f:N` en debug. Valeurs non standardisées.

### 7.4 Logique de déduction d'état UI

```js
function deriveDisplayState(s) {
  const {
    printProgress = 0,
    printLeftTime = 0,
    printJobTime = 0,
    layer = 0,
    state,
    print_state = '',
    nozzle_temp = 0,
    targetNozzleTemp = 0,
    bed_temp = 0,
    targetBedTemp = 0,
    err
  } = s;

  // Code d'erreur (champ err peut être un objet ou un int)
  let errCode = 0;
  if (err && typeof err === 'object') errCode = err.errcode || 0;
  else if (typeof err === 'number') errCode = err;

  const isFinished = printProgress >= 100 || state === 2;
  const isPrinting = !isFinished && (
    printProgress > 0 ||
    printLeftTime > 0 ||
    printJobTime > 0 ||
    layer > 0 ||
    print_state === 'printing'
  );
  const isHeating = !isFinished && !isPrinting && (
    (targetNozzleTemp > 0 && (targetNozzleTemp - nozzle_temp) > 5) ||
    (targetBedTemp > 0 && (targetBedTemp - bed_temp) > 3)
  );

  if (errCode !== 0) return 'Error';
  if (isFinished)  return 'Completed';
  if (isPrinting)  return 'Printing';
  if (isHeating)   return 'Heating';
  if (print_state) return print_state.charAt(0).toUpperCase() + print_state.slice(1);
  if (state != null && state !== 0) return `State ${state}`;
  return 'Idle';
}
```

### 7.5 États d'affichage avec spinner

Les statuts suivants déclenchent un spinner animé dans l'UI :
- `"Printing"`, `"Preparing"`, `"Prepare"`, `"Busy"`, `"Heating"`

---

## 8. Données de température

### 8.1 Structure interne

```js
// État normalisé après merge
{
  nozzle_temp:      219.93,  // float, depuis nozzleTemp (string parsé)
  targetNozzleTemp: 220.0,   // float
  bed_temp:         60.0,    // float, depuis bedTemp0
  targetBedTemp:    60.0,    // float, depuis targetBedTemp0
  chamber_temp:     35.0     // float, depuis boxTemp ou chamberTemp
  // pas de targetChamberTemp dans le protocole observé
}
```

### 8.2 Exemple de payload brute reçue

```json
{
  "nozzleTemp": "219.930000",
  "targetNozzleTemp": 220,
  "bedTemp0": "60.001000",
  "targetBedTemp0": 60,
  "boxTemp": "35.500000"
}
```

> Les températures arrivent parfois comme **chaînes de caractères** (ex: `"219.930000"`). Toujours parser avec `parseFloat()`.

### 8.3 Variantes de noms de champs

| Firmware | Buse actuelle | Plateau actuel | Consigne plateau | Chambre |
|----------|---------------|----------------|------------------|---------|
| Standard | `nozzleTemp` | `bedTemp0` | `targetBedTemp0` | `boxTemp` |
| Variante | `nozzleTemp` | `bedTemp` | `targetBedTemp` | `chamberTemp` |

---

## 9. Structure des données filament (CFS)

### 9.1 Payload `boxsInfo` complète

```json
{
  "boxsInfo": {
    "materialBoxs": [
      {
        "id": 0,
        "type": 99,
        "materials": [
          {
            "color":   "#0ff0000",
            "type":    "PLA",
            "vendor":  "Creality",
            "state":   1
          }
        ]
      },
      {
        "id": 1,
        "type": 0,
        "materials": [
          {
            "color":   "#0ff0000",
            "type":    "PLA",
            "vendor":  "Creality",
            "state":   1
          },
          {
            "color":   "#000ff00",
            "type":    "PETG",
            "vendor":  "Generic",
            "state":   0
          },
          {
            "color":   "#00000ff",
            "type":    "ABS",
            "vendor":  "Bambu",
            "state":   0
          },
          {
            "color":   "#0ffffff",
            "type":    "TPU",
            "vendor":  "Generic",
            "state":   0
          }
        ]
      }
    ]
  }
}
```

### 9.2 Logique de parsing `boxsInfo`

```js
function parseBoxsInfo(boxsInfo) {
  const result = {
    external: null,   // slot extérieur (id=0, type≠0)
    modules: []       // boîtes CFS (type=0), triées par id croissant
  };

  const materialBoxs = boxsInfo?.materialBoxs;
  if (!Array.isArray(materialBoxs)) return result;

  const moduleEntries = [];

  for (const box of materialBoxs) {
    if (typeof box !== 'object') continue;
    const id = box.id;
    const type = box.type;
    const mats = box.materials;

    // id=0 : extrudeur externe (un seul matériau)
    if (id === 0 && Array.isArray(mats) && mats.length > 0) {
      const m = mats[0];
      result.external = {
        color:  parseCrealityHex(m.color || '#0808080'),
        type:   m.type   || '',
        vendor: m.vendor || '',
        active: m.state === 1
      };
    } else if (type === 0 && Array.isArray(mats)) {
      // Module CFS
      moduleEntries.push({ id, mats });
    }
  }

  // Trier les modules CFS par id croissant
  moduleEntries.sort((a, b) => a.id - b.id);

  for (const { id: boxId, mats } of moduleEntries) {
    const slots = mats.map((m, slotIndex) => ({
      boxId,
      slotId: slotIndex,
      color:  parseCrealityHex(m.color || '#0808080'),
      type:   m.type   || '',
      vendor: m.vendor || '',
      active: m.state === 1
    }));
    result.modules.push(slots);
  }

  return result;
}
```

### 9.3 Champs d'un slot filament

| Champ | Type | Description |
|-------|------|-------------|
| `boxId` | `int` | `0` = extrudeur externe, `1+` = module CFS |
| `slotId` | `int` | Index 0-based dans le module |
| `color` | `string` | Hex Creality `#0RRGGBB` |
| `type` | `string` | Type matériau (ex: `"PLA"`) |
| `vendor` | `string` | Fabricant |
| `state` | `int` | `1` = actif/en cours |

---

## 10. Miniature / aperçu de l'impression

L'imprimante expose l'image de l'impression courante via HTTP (pas via WebSocket) :

```
GET http://<ip>/downloads/original/current_print_image.png
```

```js
function getCurrentPrintImageUrl(ip) {
  return `http://${ip}/downloads/original/current_print_image.png`;
}
```

- Aucune authentification requise pour cet endpoint HTTP.
- Si aucune impression n'est en cours, la requête peut retourner 404 ou une image placeholder.
- Rafraîchir périodiquement (ex: toutes les 10 s) ou à chaque changement d'état.

---

## 11. Flux caméra — détails complets

### URL d'accès

```
http://<ip>:8000/
```

### Implémentation Electron (preload + renderer)

Dans le fichier `preload.js`, ajouter la permission pour les médias WebRTC si nécessaire. Dans `inventory.html`, utiliser une `<webview>` :

```html
<webview
  id="creality-camera-view"
  src="about:blank"
  allowpopups
  nodeintegration="false"
  webpreferences="allowRunningInsecureContent, autoplayPolicy=no-user-gesture-required"
  style="width: 100%; aspect-ratio: 16/9; background: #000;">
</webview>
```

```js
// Lancer la caméra
function startCrealityCamera(ip) {
  const webview = document.getElementById('creality-camera-view');
  webview.src = `http://${ip}:8000/`;
}

// Arrêter la caméra (stopper les tracks WebRTC)
function stopCrealityCamera() {
  const webview = document.getElementById('creality-camera-view');
  webview.executeJavaScript(`
    (() => {
      document.querySelectorAll('video, audio').forEach(node => {
        if (node.srcObject && node.srcObject.getTracks) {
          node.srcObject.getTracks().forEach(t => t.stop());
          node.srcObject = null;
        }
        if (node.pause) node.pause();
        node.removeAttribute('src');
        if (node.load) node.load();
      });
    })();
  `).catch(() => {});
  webview.src = 'about:blank';
}
```

### CSS d'ajustement de la page WebRTC embarquée

Injecter après `did-finish-load` :

```js
webview.addEventListener('did-finish-load', () => {
  webview.executeJavaScript(`
    (() => {
      const style = document.createElement('style');
      style.textContent = \`
        html, body {
          margin: 0 !important; padding: 0 !important;
          width: 100% !important; height: 100% !important;
          overflow: hidden !important; background: #000 !important;
        }
        video, canvas, iframe, img {
          width: 100% !important; height: 100% !important;
          object-fit: contain !important; background: #000 !important;
        }
      \`;
      document.head.appendChild(style);
      // Autoplay
      document.querySelectorAll('video').forEach(v => {
        v.autoplay = true;
        v.play && v.play().catch(() => {});
      });
    })();
  `).catch(() => {});
});
```

---

## 12. Commandes de contrôle

> **Note** : Aucune commande de contrôle d'impression (pause, reprise, stop) n'a été observée dans les sources analysées. Les sources se concentrent sur la lecture de l'état et la modification des filaments. Les commandes éventuelles suivraient vraisemblablement la même structure `{"method":"set","params":{...}}`.

Seule commande de contrôle documentée dans les sources : **modification de filament** (`modifyMaterial`, voir section 5.3).

---

## 13. Gestion des erreurs

### 13.1 Champ `err`

Le champ `err` peut prendre deux formes selon le firmware :

```json
{ "err": { "errcode": 42 } }
// ou
{ "errcode": 42 }
```

```js
function extractErrCode(state) {
  const err = state.err;
  if (err && typeof err === 'object') return err.errcode || 0;
  if (typeof err === 'number') return err;
  if (typeof state.errcode === 'number') return state.errcode;
  return 0;
}
```

### 13.2 Règles de gestion

| Situation | Comportement recommandé |
|-----------|------------------------|
| Port 9999 fermé | Ne pas ajouter dans la liste, timeout 650 ms |
| WS échec handshake | Log + retry après délai (ne pas retry immédiatement) |
| Frame non-JSON | Logger et ignorer (`try/catch` autour de `JSON.parse`) |
| Payload volumineux (> 2000 chars) | Logger uniquement la taille, pas le contenu complet |
| `errCode !== 0` | Afficher état "Error" avec le code |
| Déconnexion (onClose) | Marquer `connected = false`, tenter reconnexion sur reprise d'activité |
| Payload `retMaterials` | Très volumineux — ne pas logger en entier en prod |

### 13.3 Reconnexion automatique

```js
function watchConnection(printerState) {
  // Reconnexion 300 ms après retour de l'app en foreground
  // Ne pas tenter si déjà connected ou connecting
  if (!printerState.connected && !printerState.connecting) {
    setTimeout(() => connectCreality(printerState.ip, printerState), 300);
  }
}
```

### 13.4 Parsing robuste de `TotalLayer`

Le nombre total de couches peut arriver sous diverses formes :

```js
const TOTAL_LAYER_KEYS = new Set([
  'totallayer', 'totallayers', 'totallayernum', 'totallayercount',
  'totallayernumber', 'totallayerindex', 'total_layer', 'total_layer_num',
  'total_layer_count', 'print_layer_total', 'print_layer_num',
  'targetprintlayer', 'layernumtotal', 'layercount', 'layer_count'
]);

function normalizeKey(k) {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractTotalLayer(node, depth = 0) {
  if (depth > 5 || node == null) return null;

  if (typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (TOTAL_LAYER_KEYS.has(normalizeKey(k))) {
        const n = parseInt(v);
        if (!isNaN(n) && n > 0) return n;
        if (typeof v === 'string') {
          // "current: 16 / total: 250" — garder la plus grande valeur
          const nums = [...v.matchAll(/\d+/g)].map(m => parseInt(m[0]));
          if (nums.length) return Math.max(...nums);
        }
      }
    }
    for (const v of Object.values(node)) {
      const found = extractTotalLayer(v, depth + 1);
      if (found != null) return found;
    }
  } else if (Array.isArray(node)) {
    for (const item of node.slice(0, 40)) {
      const found = extractTotalLayer(item, depth + 1);
      if (found != null) return found;
    }
  } else if (typeof node === 'string') {
    try {
      return extractTotalLayer(JSON.parse(node), depth + 1);
    } catch {}
  }
  return null;
}
```

---

## 14. Découverte — Implémentation Node.js

```js
const net = require('net');
const WebSocket = require('ws');

const WS_PORT = 9999;
const CAMERA_PORT = 8000;
const SOCKET_TIMEOUT_MS = 650;
const WS_TIMEOUT_MS = 2200;

async function isPortOpen(ip, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.connect(port, ip);
  });
}

async function readCrealityHello(ip, credential = null) {
  return new Promise(resolve => {
    const url = `ws://${ip}:${WS_PORT}/`;
    const opts = {};
    if (credential) {
      const tok = Buffer.from(`${credential.account}:${credential.password}`).toString('base64');
      opts.headers = { 'Authorization': `Basic ${tok}` };
    }

    let ws;
    const timer = setTimeout(() => { if (ws) ws.close(); resolve(null); }, WS_TIMEOUT_MS);

    try {
      ws = new WebSocket(url, opts);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    const aggregated = {};
    let frameCount = 0;

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ method: 'get', params: { printerInfo: 1 } }));
      } catch {}
    });

    ws.on('message', (data) => {
      frameCount++;
      try {
        const msg = JSON.parse(data.toString());
        Object.assign(aggregated, msg);
        for (const key of ['params', 'msg', 'data', 'result']) {
          if (msg[key] && typeof msg[key] === 'object') Object.assign(aggregated, msg[key]);
        }
      } catch {}

      const hasId = 'model' in aggregated || 'modelVersion' in aggregated || 'deviceSn' in aggregated;
      if (hasId && frameCount >= 2) {
        clearTimeout(timer);
        ws.close();
        resolve(aggregated);
      }
      if (frameCount >= 5) {
        clearTimeout(timer);
        ws.close();
        resolve(aggregated);
      }
    });

    ws.on('error', () => { clearTimeout(timer); resolve(null); });
    ws.on('close', () => { clearTimeout(timer); resolve(aggregated.model ? aggregated : null); });
  });
}

const TELEMETRY_KEYS = new Set([
  'printerStatus', 'printProgress', 'printJobTime', 'nozzleTemp', 'targetNozzleTemp',
  'bedTemp0', 'bedTemp', 'targetBedTemp0', 'targetBedTemp', 'boxTemp', 'chamberTemp',
  'boxsInfo', 'cfsConnected', 'retMaterials', 'lightSw', 'webrtcSupport', 'ModeCode',
  'curPosition', 'workingLayer', 'totalLayers', 'filename'
]);

function isCrealityLike(payload, hostname) {
  if (!payload) return false;
  const keys = new Set(Object.keys(payload));
  const hasStrongId = keys.has('model') || keys.has('modelVersion') || keys.has('deviceSn');
  const hostnameHit = hostname && /creality|k1|k2|ender|hi-|hi_/i.test(hostname);
  const hasTelemetry = [...keys].some(k => TELEMETRY_KEYS.has(k));
  return (hasStrongId || hostnameHit) && hasTelemetry;
}

async function probeIp(ip, credentials = [null]) {
  const wsOpen = await isPortOpen(ip, WS_PORT);
  if (!wsOpen) return null;

  const cameraOpen = await isPortOpen(ip, CAMERA_PORT);

  for (const cred of credentials) {
    const hello = await readCrealityHello(ip, cred);
    if (hello && isCrealityLike(hello, hello.hostname)) {
      return {
        ip,
        wsPortOpen: true,
        cameraPortOpen: cameraOpen,
        jsonConfirmed: true,
        hostname: hello.hostname || null,
        model: hello.model || null,
        modelVersion: hello.modelVersion || null,
        deviceSn: hello.deviceSn || null,
        account: cred?.account || null,
        password: cred?.password || null
      };
    }
  }
  return null;
}

async function scanLan(options = {}) {
  const {
    subnet = '192.168.1',
    credentials = [null, { account: 'root', password: 'creality_2025' }],
    concurrency = 64,
    onCandidate = null,
    onProgress = null
  } = options;

  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const results = [];
  let done = 0;

  const queue = [...ips];

  async function worker() {
    while (queue.length) {
      const ip = queue.shift();
      const candidate = await probeIp(ip, credentials);
      done++;
      if (onProgress) onProgress(done, ips.length);
      if (candidate) {
        results.push(candidate);
        if (onCandidate) onCandidate(candidate);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ips.length) }, worker);
  await Promise.all(workers);

  return results.filter(c => c.jsonConfirmed)
    .sort((a, b) => {
      const [a1, a2, a3, a4] = a.ip.split('.').map(Number);
      const [b1, b2, b3, b4] = b.ip.split('.').map(Number);
      return ((a1<<24)+(a2<<16)+(a3<<8)+a4) - ((b1<<24)+(b2<<16)+(b3<<8)+b4);
    });
}
```

---

## 15. Checklist d'implémentation

### Transport & Connexion
- [ ] Connexion WebSocket sur `ws://<ip>:9999/`
- [ ] Header `Authorization: Basic <base64>` si credentials configurés
- [ ] Identifiants par défaut à tester : `root` / `creality_2025`
- [ ] Reconnexion automatique sur déconnexion (délai 300 ms après reprise foreground)
- [ ] Gestion `try/catch` sur tout `JSON.parse`
- [ ] Ne pas logger les payloads > 2000 chars en entier (retMaterials très volumineux)

### Séquence d'init
- [ ] À l'ouverture WS : envoyer `get printerInfo`
- [ ] Dès premier message reçu : envoyer `get {reqGcodeFile, reqGcodeList, boxsInfo, boxConfig, reqMaterials}`
- [ ] Merger toutes les frames reçues dans un objet d'état cumulatif (les clés ne sont pas toutes dans la même frame)

### Télémétrie
- [ ] Parser les températures comme `parseFloat()` (arrivées parfois comme strings)
- [ ] Utiliser les deux noms de champs pour le plateau : `bedTemp0` et `bedTemp`
- [ ] Utiliser `boxTemp` OU `chamberTemp` pour la chambre
- [ ] `printProgress` OU `dProgress` pour la progression
- [ ] Algorithme robuste pour `TotalLayer` (peut être string, ratio "X/Y", JSON nestée)

### États
- [ ] Implémenter la logique de déduction d'état (`deriveDisplayState`)
- [ ] Gérer `state === 2` = terminé
- [ ] Extraire le code d'erreur depuis `err.errcode` ET `errcode` directement

### Filaments CFS
- [ ] Parser `boxsInfo.materialBoxs[]`
- [ ] `id=0` = extrudeur externe (1 matériau)
- [ ] `type=0` = module CFS (4 slots)
- [ ] Décoder les couleurs avec `parseCrealityHex` (format `#0RRGGBB`)
- [ ] `state === 1` = slot actif

### Mise à jour filament
- [ ] Implémenter `modifyMaterial` avec tous les champs obligatoires
- [ ] Encoder la couleur avec `colorToCrealityHex` (format `#0RRGGBB`)
- [ ] `boxId=0` pour l'extrudeur externe, `1+` pour les modules CFS
- [ ] `rfid` : utiliser le crealityID de la base matériaux, ou `"0"` si inconnu

### Miniature
- [ ] Récupérer via `GET http://<ip>/downloads/original/current_print_image.png`
- [ ] Gestion d'erreur 404 (pas d'impression en cours)

### Caméra
- [ ] URL : `http://<ip>:8000/` (page HTML WebRTC complète)
- [ ] Charger dans `<webview>` Electron avec `allowRunningInsecureContent`
- [ ] Injecter CSS après `did-finish-load` pour autoplay et full-fit
- [ ] Arrêter les tracks WebRTC explicitement avant de changer d'imprimante

### Découverte
- [ ] Sonder TCP port 9999 (timeout 650 ms)
- [ ] Sonder TCP port 8000 séparément (info caméra)
- [ ] Valider `isCrealityLike` (identité forte + télémétrie)
- [ ] Tester les credentials par défaut (`root`/`creality_2025`) en fallback
- [ ] Concurrence max 64 IPs simultanées
- [ ] Balayer `192.168.1.x` et `192.168.40.x` en plus du sous-réseau local
- [ ] Trier les résultats confirmés en premier, puis par IP croissante
