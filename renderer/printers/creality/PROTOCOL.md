# Creality LAN — Agent Skill

> Référence complète pour implémenter l'intégration Creality dans une app Node.js/Electron.
> Sources croisées :
> - Code Flutter source (`creality_websocket_page.dart`, `creality_scan_printers.dart`, widgets)
> - Session SSH live sur Ender-3 V4 (`model: "F009"`) @ `192.168.40.106` — mai 2026
> - Intégration Home Assistant : `github.com/3dg1luk43/ha_creality_ws`
>
> **Légende (sections implémentation)** :
> ✅ Implémenté dans Tiger Studio · 🔶 Capturé, pas encore affiché · ⬜ Connu, pas encore capturé

---

## 1. Transport principal — WebSocket

| Paramètre | Valeur |
|-----------|--------|
| Protocole | `ws://` (texte UTF-8, pas binaire) |
| Port | **9999** |
| URI | `ws://<ip>:9999/` |
| Format frames | JSON texte bidirectionnel |
| Push serveur | L'imprimante pousse son état sans polling |

### Authentification (optionnelle)

Certains firmwares requièrent HTTP Basic sur le handshake WS :

```js
const token = Buffer.from(`${account}:${password}`).toString('base64');
const ws = new WebSocket('ws://192.168.1.100:9999/', {
  headers: { 'Authorization': `Basic ${token}` }
});
// Identifiants par défaut connus : root / creality_2025
// Sans auth : new WebSocket('ws://192.168.1.100:9999/')
```

### Heartbeat — CRITIQUE

L'imprimante envoie périodiquement `{"ModeCode":"heart_beat"}`.
Il **faut** répondre avec la chaîne littérale `ok` — ASCII brut, **pas du JSON**.
Sans cette réponse → déconnexion silencieuse.

```
Printer → Client : {"ModeCode":"heart_beat"}
Client  → Printer: ok                    ← string brute, PAS {"ok":true}
```

```js
ws.on('message', (data) => {
  const raw = data.toString();
  try {
    const msg = JSON.parse(raw);
    if (msg?.ModeCode === 'heart_beat') {
      ws.send('ok');   // ← réponse obligatoire
      return;
    }
    mergeState(state, msg);
  } catch {
    // frame non-JSON — ignorer
  }
});
```

### Ports utilisés

| Port | Protocole | Usage |
|------|-----------|-------|
| **9999** | WebSocket | Données live + commandes |
| **8000** | HTTP | Caméra WebRTC (page HTML autonome) |
| **80** | HTTP | Thumbnails + image live impression |
| **7125** | HTTP | Moonraker — lancer / supprimer impression |

---

## 2. Caméra — WebRTC port 8000

### URL d'accès

```
http://<ip>:8000/
```

La caméra expose une **page HTML autonome** qui gère sa propre signalisation WebRTC. Il n'y a pas d'API de signalisation JSON exposée côté client.

### Approche A — `<webview>` Electron (Flutter / cross-origin)

```html
<webview id="creCamView" src="about:blank"
  allowpopups
  webpreferences="allowRunningInsecureContent, autoplayPolicy=no-user-gesture-required"
  style="width:100%; aspect-ratio:16/9; background:#000;"></webview>
```

```js
// Démarrer
document.getElementById('creCamView').src = `http://${ip}:8000/`;

// Arrêter proprement (libérer les tracks WebRTC)
const wv = document.getElementById('creCamView');
wv.executeJavaScript(`
  document.querySelectorAll('video,audio').forEach(n => {
    n.srcObject?.getTracks?.().forEach(t => t.stop());
    n.srcObject = null; n.pause?.(); n.src = '';
  });
`).catch(() => {});
wv.src = 'about:blank';
```

Injecter le CSS responsive après chargement :

```js
wv.addEventListener('did-finish-load', () => {
  wv.executeJavaScript(`
    const s = document.createElement('style');
    s.textContent = \`
      html,body { margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000; }
      video,canvas,iframe,img { width:100%!important;height:100%!important;
        object-fit:contain!important;background:#000!important; }
    \`;
    document.head.appendChild(s);
    document.querySelectorAll('video').forEach(v => { v.autoplay=true; v.play?.().catch(()=>{}); });
  `).catch(() => {});
});
```

### Approche B — RTCPeerConnection directe (Tiger Studio actuel)

Tiger Studio n'utilise pas `<webview>` mais un `<video>` + `RTCPeerConnection` direct pour avoir le contrôle total du CSS. Endpoint de signalisation sur la même machine :

```
POST http://<ip>:8000/call/webrtc_local
Content-Type: application/json
Body: { "sdp": "<SDP offer>", "type": "offer" }
```

```js
let _pc = null;

export async function startCreCam(ip) {
  stopCreCam();
  const videoEl = document.getElementById('creCamVideo');
  if (!videoEl) return;
  const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only, pas de STUN
  _pc = pc;
  pc.ontrack = ev => { videoEl.srcObject = ev.streams[0]; videoEl.play().catch(() => {}); };
  pc.addTransceiver('video', { direction: 'sendrecv' });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Attendre fin ICE gathering (max 4 s)
  await new Promise(resolve => {
    const t = setTimeout(resolve, 4000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    };
  });
  const res = await fetch(`http://${ip}:8000/call/webrtc_local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription.sdp, type: 'offer' }),
  });
  const answer = await res.json();
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export function stopCreCam() {
  if (_pc) { try { _pc.close(); } catch {} _pc = null; }
  const v = document.getElementById('creCamVideo');
  if (v) v.srcObject = null;
}
```

```html
<!-- Élément vidéo dans la sidecard -->
<div class="pp-cam-full">
  <video id="creCamVideo" class="cre-cam-video" autoplay muted playsinline></video>
</div>
```

---

## 3. Découverte réseau LAN

### Algorithme

1. Dériver le subnet `/24` de l'IP Wi-Fi locale + des IPs connues
2. Ajouter systématiquement : `192.168.1.x`, `192.168.40.x`
3. Sonder toutes les IPs `.1`–`.254` en **64 connexions parallèles**
4. Pour chaque IP : TCP port 9999 timeout **650 ms** → si ouvert → WS handshake timeout **2200 ms**
5. Sonder TCP port 8000 en parallèle (info caméra)
6. Valider avec `isCrealityLike()`

### Règle de validation `isCrealityLike`

**Condition A** (identité forte, au moins une) :
- Payload contient `model`, `modelVersion` ou `deviceSn`
- Hostname contient : `creality`, `k1`, `k2`, `ender`, `hi-`, `hi_` (insensible à la casse)

**Condition B** (télémétrie Creality, au moins une des clés) :
```
printerStatus | printProgress | printJobTime | nozzleTemp | targetNozzleTemp
bedTemp0 | bedTemp | targetBedTemp0 | targetBedTemp | boxTemp | chamberTemp
boxsInfo | cfsConnected | retMaterials | lightSw | webrtcSupport | ModeCode
curPosition | workingLayer | totalLayers | filename
```

```js
const TELEMETRY_KEYS = new Set([
  'printerStatus','printProgress','printJobTime','nozzleTemp','targetNozzleTemp',
  'bedTemp0','bedTemp','targetBedTemp0','targetBedTemp','boxTemp','chamberTemp',
  'boxsInfo','cfsConnected','retMaterials','lightSw','webrtcSupport','ModeCode',
  'curPosition','workingLayer','totalLayers','filename'
]);

function isCrealityLike(payload, hostname) {
  if (!payload) return false;
  const keys = new Set(Object.keys(payload));
  const hasStrongId = keys.has('model') || keys.has('modelVersion') || keys.has('deviceSn');
  const hostnameHit = hostname && /creality|k1|k2|ender|hi-|hi_/i.test(hostname);
  const hasTelemetry = [...keys].some(k => TELEMETRY_KEYS.has(k));
  return (hasStrongId || hostnameHit) && hasTelemetry;
}
```

### Codes modèle connus

| Code `model` | Modèle | ID interne |
|-------------|--------|------------|
| `F009` | Ender-3 V4 | `10` |
| `F022` | SparkX | `11` |

---

## 4. Séquence d'initialisation

```
1. TCP connect :9999
2. WS Upgrade (+ Authorization si credentials)
3. Recevoir frames push initiales (nozzleTemp, bedTemp, printProgress…)
4. ← gérer heartbeat {"ModeCode":"heart_beat"} → répondre "ok"
5. Envoyer : {"method":"get","params":{"printerInfo":1}}
6. Dès 1er message reçu, envoyer en une seule trame :
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
7. Merger toutes les frames reçues dans un objet d'état cumulatif
8. Après init : seuls les mini-blobs périodiques arrivent (nozzleTemp + bedTemp0, ~1.5 s)
   Pas de polling nécessaire — l'imprimante push seule.
```

**Stratégie Tiger Studio** :

| Moment | Requête |
|--------|---------|
| Connexion WS (une fois) | `printerInfo` + `reqGcodeFile` + `reqGcodeList` + `boxsInfo` + `boxConfig` + `reqMaterials` |
| Ouverture file explorer | `getGcodeFileInfo2` uniquement |
| Après impression / suppression | `getGcodeFileInfo2` pour rafraîchir |

---

## 5. Commandes `get` (Client → Imprimante)

### Format général

```json
{ "method": "get", "params": { "<paramName>": 1, ... } }
```

Plusieurs params dans la même trame acceptés.

### Commandes disponibles

| Paramètre | Réponse | Usage |
|-----------|---------|-------|
| `printerInfo` | Champs identité (`model`, `hostname`…) | Identification |
| `reqGcodeFile` | `printFileName` + `printProgress` + `printStartTime` | Fichier en cours |
| `reqGcodeList` | Liste brute des fichiers (sans thumbnails) | Peu utilisé |
| `boxsInfo` | Structure complète CFS (voir §9) | Filaments |
| `boxConfig` | Config boîtes (autoRefill, cAutoFeed…) | Config CFS |
| `reqMaterials` | Catalogue Klipper des profils matière | Base matériaux |
| `getGcodeFileInfo2` | Liste enrichie : thumbnails, durées, couleurs (voir §11) | File explorer |

---

## 6. Commandes `set` — Contrôle (Client → Imprimante)

### Format général

```json
{ "method": "set", "params": { "<commandName>": <payload> } }
```

### 6.1 Modifier un slot filament — `modifyMaterial` ✅

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

| Champ | Type | Notes |
|-------|------|-------|
| `id` | int | Index slot dans la boîte (0-based) |
| `boxId` | int | `0` = extrudeur externe, `1+` = module CFS |
| `rfid` | string | ID Creality du matériau (`"00001"` = PLA). `"0"` si inconnu |
| `type` | string | `"PLA"`, `"PETG"`, `"ABS"`, `"TPU"`… |
| `vendor` | string | `"Generic"`, `"Creality"`, `"Hyper"`… |
| `name` | string | Nom affiché (ex: `"Generic PLA"`) |
| `color` | string | Format `#0RRGGBB` — voir §10 |
| `minTemp` / `maxTemp` | float | Températures buse (°C) |
| `pressure` | float | Pressure advance (typique : `0.04`) |
| `selected` | int | `1` = sélectionné |
| `percent` | int | % filament restant (0–100) |
| `editStatus` | int | `1` = configuré manuellement |
| `state` | int | `1` = actif |

### 6.2 Pause / reprise impression ✅

```json
{ "method": "set", "params": { "pause": 1 } }
{ "method": "set", "params": { "pause": 0 } }
```

### 6.3 Stop / annulation impression ✅

```json
{ "method": "set", "params": { "stop": 1 } }
```

### 6.4 Toggle LED ✅

```json
{ "method": "set", "params": { "lightSw": 1 } }
{ "method": "set", "params": { "lightSw": 0 } }
```

### 6.5 Multiplicateurs vitesse / débit ⬜

```json
{ "method": "set", "params": { "curFeedratePct": 120 } }
{ "method": "set", "params": { "curFlowratePct": 95 } }
```

---

## 7. Messages reçus — Format et merge d'état

Les frames reçues sont des objets JSON **plats** (pas d'enveloppe, pas d'écho du `method`). Une frame peut contenir n'importe quel sous-ensemble de champs. Il faut **merger toutes les frames** dans un objet d'état local.

⚠️ Beaucoup de valeurs numériques arrivent en **strings JSON** (`"27.940000"`) — toujours parser avec `parseFloat()`.

### Fonction de merge

```js
function mergeState(state, msg) {
  if (typeof msg !== 'object' || msg === null) return;

  const direct = [
    'hostname','model','modelVersion','deviceSn',
    'printerStatus','printProgress','printJobTime','printLeftTime',
    'nozzleTemp','targetNozzleTemp',
    'bedTemp0','bedTemp','targetBedTemp0','targetBedTemp',
    'boxTemp','chamberTemp',
    'layer','TotalLayer','curPosition',
    'printFileName','printStartTime','printId','printFileType',
    'state','deviceState','feedState','print_state',
    'err','errcode',
    'dProgress','usedMaterialLength',
    'lightSw','webrtcSupport','ModeCode',
    'cfsConnect','totalJob','totalUsageTime','totalUsageMaterial',
    'pause','isPaused'
  ];

  for (const key of direct) {
    if (key in msg) state[key] = msg[key];
  }

  if ('boxsInfo'   in msg) state.boxsInfo  = msg.boxsInfo;
  if ('boxConfig'  in msg && typeof msg.boxConfig === 'object') state.boxConfig = msg.boxConfig;
  if ('retGcodeFile' in msg)  state.gcodeFile = msg.retGcodeFile;
  if ('reqGcodeFile' in msg)  state.gcodeFile = msg.reqGcodeFile;
  if ('retGcodeFileInfo2' in msg) state.fileList = msg.retGcodeFileInfo2;

  // Normalisation des températures (parfois string "219.930000")
  for (const k of ['nozzleTemp','bedTemp0','bedTemp','targetNozzleTemp',
                   'targetBedTemp0','targetBedTemp','boxTemp','chamberTemp']) {
    if (k in state && typeof state[k] === 'string') state[k] = parseFloat(state[k]) || 0;
  }

  // Historique
  if ('historyList' in msg && Array.isArray(msg.historyList) && msg.historyList.length > 0) {
    state.historyList = msg.historyList;
    const first = msg.historyList[0];
    if (first?.filename)    state.lastHistoryFilename = first.filename;
    if (first?.printfinish) state.lastHistoryPrintFinish = parseInt(first.printfinish) || 0;
  }
}
```

### Table des champs

| Clé wire | Clé interne | Type | ✅/🔶 | Notes |
|----------|-------------|------|--------|-------|
| `nozzleTemp` | `nozzleTemp` | string→float | ✅ | Ex: `"27.940000"` |
| `targetNozzleTemp` | `nozzleTarget` | string→float | ✅ | Consigne buse |
| `bedTemp0` / `bedTemp` | `bedTemp` | string→float | ✅ | |
| `targetBedTemp0` / `targetBedTemp` | `bedTarget` | string→float | ✅ | |
| `boxTemp` / `chamberTemp` | `chamberTemp` | string→float | ✅ | 0 = pas d'enceinte (V4) |
| `state` | `state` | int | ✅ | 0=idle, 1=printing, 2=fini |
| `deviceState` | `deviceState` | int | 🔶 | Sous-état interne |
| `feedState` | `feedState` | int | 🔶 | État alimentation |
| `print_state` | `print_state` | string | 🔶 | État textuel alternatif |
| `printProgress` | `printProgress` | int | ✅ | 0–100 |
| `dProgress` | `dProgress` | int | ✅ | Fallback progression |
| `layer` | `layer` | int | ✅ | Couche courante |
| `TotalLayer` | `totalLayer` | int | ✅ | Note : T majuscule |
| `printLeftTime` | `printLeftTime` | int | ✅ | Secondes restantes |
| `printJobTime` | `printJobTime` | int | ✅ | Secondes écoulées |
| `printFileName` | `printFileName` | string | ✅ | Path complet — extraire basename |
| `pause` / `isPaused` | `isPaused` | int | ✅ | 1 = en pause |
| `lightSw` | `lightSw` | int | ✅ | 1 = LED allumée |
| `cfsConnect` | `cfsConnect` | int | 🔶 | 1 = module CFS branché |
| `webrtcSupport` | `webrtcSupport` | int | 🔶 | |
| `hostname` | `hostname` | string | ✅ | Ex: `"Ender-3_V4-574A"` |
| `model` | `model` | string | 🔶 | `"F009"` = Ender-3 V4 |
| `err` | `err` | obj/int | 🔶 | `{errcode, key, value}` |
| `curFeedratePct` | `curFeedratePct` | int | 🔶 | Multiplicateur vitesse % |
| `curFlowratePct` | `curFlowratePct` | int | 🔶 | Multiplicateur débit % |
| `curPosition` | `curPosition` | string | 🔶 | `"X:0.00 Y:220.00 Z:58.56"` |
| `realTimeSpeed` | `realTimeSpeed` | string→float | 🔶 | mm/s |
| `usedMaterialLength` | `usedMaterialLength` | string→float | 🔶 | mm consommés |
| `maxNozzleTemp` | `maxNozzleTemp` | int | 🔶 | 300 sur V4 |
| `maxBedTemp` | `maxBedTemp` | int | 🔶 | 100 sur V4 |
| `boxsInfo` | `boxsInfo` | object | ✅ | Voir §9 |
| `historyList[0].filename` | `lastHistoryFilename` | string | ✅ | Fallback nom fichier |

---

## 8. États d'impression

### Valeurs numériques (`state`)

| Valeur | Signification |
|--------|---------------|
| `0` | Idle |
| `1` | En cours |
| `2` | Terminé |

### Logique de déduction d'état UI

```js
function deriveDisplayState(s) {
  const {
    printProgress = 0, printLeftTime = 0, printJobTime = 0, layer = 0,
    state, print_state = '',
    nozzleTemp: nt = 0, targetNozzleTemp: nttarget = 0,
    bedTemp0: bt = 0, targetBedTemp0: bttarget = 0,
    err
  } = s;

  let errCode = 0;
  if (err && typeof err === 'object') errCode = err.errcode || 0;
  else if (typeof err === 'number') errCode = err;

  const isFinished = printProgress >= 100 || state === 2;
  const isPrinting = !isFinished && (
    printProgress > 0 || printLeftTime > 0 || printJobTime > 0 ||
    layer > 0 || print_state === 'printing'
  );
  const isHeating = !isFinished && !isPrinting && (
    (nttarget > 0 && (nttarget - nt) > 5) ||
    (bttarget > 0 && (bttarget - bt) > 3)
  );

  if (errCode !== 0) return 'Error';
  if (isFinished)   return 'Completed';
  if (isPrinting)   return 'Printing';
  if (isHeating)    return 'Heating';
  if (print_state)  return print_state.charAt(0).toUpperCase() + print_state.slice(1);
  if (state != null && state !== 0) return `State ${state}`;
  return 'Idle';
}
```

**Spinner UI** sur : `Printing`, `Preparing`, `Prepare`, `Busy`, `Heating`.

---

## 9. Structure CFS — `boxsInfo`

### Payload réelle (Ender-3 V4 + module CFS 4 slots)

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
            "rfid": "00001",
            "minTemp": 0,
            "maxTemp": 0,
            "pressure": 0.04,
            "percent": 100,
            "editStatus": 1,
            "state": 1,
            "selected": 0
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
          { "id": 0, "vendor": "Generic", "type": "PETG", "color": "#0d4c8aa", "rfid": "00003", "state": 1 },
          { "id": 1, "vendor": "Hyper",   "type": "PLA",  "color": "#0ff5722", "rfid": "0",     "state": 0 },
          { "id": 2, "vendor": "Creality", "type": "PLA", "color": "#0ff8b1f", "rfid": "01001", "state": 1 },
          { "id": 3, "vendor": "Generic", "type": "HIPS", "color": "#0c8a4d6", "rfid": "0",     "state": 0 }
        ]
      }
    ]
  }
}
```

### Structure

| Champ | Valeur | Signification |
|-------|--------|---------------|
| `materialBoxs[].type` | `1` | Slot EXT (extrudeur externe) — toujours `id: 0`, 1 seul slot |
| `materialBoxs[].type` | `0` | Module CFS multi-slots |
| `materialBoxs[].temp` | int °C | Capteur interne du module CFS (absent sur EXT) |
| `materialBoxs[].humidity` | int % | Humidité interne du module CFS |
| `materials[].state` | `1` | Slot actif / filament présent |
| `materials[].editStatus` | `1` | Configuré manuellement |
| `materials[].rfid` | `"0"` | Slot non configuré |
| `same_material[]` | tableau | Tuples `[rfidCode, colorCode, [{boxId, materialId}], type]` |

### Layout Ender-3 V4 + CFS

| Boîte | `boxId` | `type` | Slots | Notes |
|-------|---------|--------|-------|-------|
| Extrudeur EXT | `0` | `1` | 1 (id: 0) | Pas de temp/humidity |
| Module CFS | `1` | `0` | 4 (id: 0–3) | temp + humidity disponibles |

### Parsing

```js
function parseBoxsInfo(boxsInfo) {
  const result = { external: null, modules: [] };
  const materialBoxs = boxsInfo?.materialBoxs;
  if (!Array.isArray(materialBoxs)) return result;

  const moduleEntries = [];

  for (const box of materialBoxs) {
    const mats = box.materials;
    if (box.type === 1 && Array.isArray(mats) && mats.length > 0) {
      // type 1 = extrudeur externe (id: 0)
      const m = mats[0];
      result.external = {
        color: parseCrealityHex(m.color || ''),
        type: m.type || '', vendor: m.vendor || '',
        active: m.state === 1
      };
    } else if (box.type === 0 && Array.isArray(mats)) {
      // type 0 = module CFS
      moduleEntries.push({ id: box.id, temp: box.temp, humidity: box.humidity, mats });
    }
  }

  moduleEntries.sort((a, b) => a.id - b.id);
  for (const { id: boxId, temp, humidity, mats } of moduleEntries) {
    result.modules.push({
      boxId, temp, humidity,
      slots: mats.map((m, i) => ({
        boxId, slotId: i,
        color: parseCrealityHex(m.color || ''),
        type: m.type || '', vendor: m.vendor || '',
        active: m.state === 1
      }))
    });
  }

  return result;
}
```

---

## 10. Format couleur : `#0RRGGBB`

Creality utilise ARGB 8 caractères, octet alpha toujours `0` :

```
#0rrggbb
 ^       octet alpha fixe (= opaque dans leur convention)
  ^^^^^^ R G B hex
```

| Wire | RGB | Couleur |
|------|-----|---------|
| `#0d4c8aa` | `(212,200,170)` | Beige |
| `#0ff5722` | `(255,87,34)` | Orange |
| `#0ff8b1f` | `(255,139,31)` | Ambre |

```js
// Wire → #rrggbb HTML
function parseCrealityHex(s) {
  let hex = s.trim().replace(/^#/, '');
  if (hex.length === 7 && hex.startsWith('0')) hex = hex.slice(1);
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0,2),16);
  const g = parseInt(hex.slice(2,4),16);
  const b = parseInt(hex.slice(4,6),16);
  return { r, g, b, hex: `#${hex.toUpperCase()}` };
}

// #rrggbb HTML → wire Creality
function colorToCrealityHex(r, g, b) {
  return '#0' +
    r.toString(16).padStart(2,'0') +
    g.toString(16).padStart(2,'0') +
    b.toString(16).padStart(2,'0');
}
// Ex : (255,87,34) → "#0ff5722"
```

---

## 11. Liste de fichiers — `getGcodeFileInfo2`

### Requête

```json
{ "method": "get", "params": { "getGcodeFileInfo2": 1 } }
```

### Réponse réelle (Ender-3 V4)

```json
{
  "retGcodeFileInfo2": [
    {
      "name":           "Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
      "path":           "/mnt/UDISK/printer_data/gcodes/Wheel logo-Ender-3 V4-PLA_3m28s.gcode",
      "file_size":      138548,
      "create_time":    1761292120,
      "timeCost":       208,
      "consumables":    158,
      "material":       "PLA",
      "nozzleTemp":     22000,
      "bedTemp":        6000,
      "thumbnail":      "/mnt/UDISK/creality/local_gcode/humbnail/Wheel logo-Ender-3 V4-PLA_3m28s.png",
      "preview":        "/mnt/UDISK/creality/local_gcode/original/Wheel logo-Ender-3 V4-PLA_3m28s.png",
      "materialColors": "#00FF00",
      "materialIds":    "01001",
      "filamentWeight": "0.47",
      "match":          "T1A=T1C "
    },
    {
      "name":           "Maker2-Ender-3 V4-PLA_1h1m.gcode",
      "timeCost":       3662,
      "material":       "PLA;PLA;PLA;PLA",
      "nozzleTemp":     19000,
      "bedTemp":        6000,
      "thumbnail":      "/mnt/UDISK/creality/local_gcode/humbnail/Maker2-Ender-3 V4-PLA_1h1m.png",
      "materialColors": "#211C16;#65B167;#FFFFFF;#B1BBBD",
      "materialIds":    ";;;",
      "filamentWeight": "8.74, 2.20, 0.89, 1.47",
      "match":          "T1A=  T1B=  T1C=  T1D=T1C "
    }
  ]
}
```

### Encodages

| Champ | Encodage | Exemple | Valeur réelle |
|-------|----------|---------|---------------|
| `nozzleTemp` | °C × 100 | `22000` | 220 °C |
| `bedTemp` | °C × 100 | `6000` | 60 °C |
| `timeCost` | secondes | `208` | 3 min 28 s |
| `file_size` | octets | `138548` | ⚠️ underscore |
| `create_time` | timestamp UNIX (s) | `1761292120` | tri par date |
| `materialColors` | hex RGB séparés par `;` | `"#211C16;#65B167"` | une couleur par matière |
| `material` | labels séparés par `;` | `"PLA;PLA;PLA;PLA"` | 4 matières |
| `filamentWeight` | grammes séparés par `,` | `"8.74, 2.20, 0.89, 1.47"` | poids par couleur |
| `thumbnail` | path filesystem | — | voir §12 pour URL HTTP |
| `preview` | path filesystem grande résolution | — | voir §12 |
| `match` | ex: `"T1A=T1C "` | mapping CFS↔filament | |

---

## 12. Thumbnails — Serveur HTTP port 80

### ⚠️ Typo firmware intentionnelle

Le dossier s'appelle `humbnail` (sans `t`) — c'est la vraie orthographe dans le firmware.

### Routes disponibles

| Route HTTP | Contenu | Disponible |
|------------|---------|------------|
| `http://<ip>/downloads/humbnail/<file>.png` | Miniature ~96×96 px pré-slicée | Dès le slicing |
| `http://<ip>/downloads/original/<file>.png` | Preview grande résolution | Dès le slicing |
| `http://<ip>/downloads/original/current_print_image.png` | Frame live de l'impression en cours | Pendant + après impression |

### Construction de l'URL thumbnail (fichier)

```js
function creThumbUrl(ip, fileEntry) {
  // Extraire uniquement le basename (le sous-dossier filesystem n'est pas la route HTTP)
  const base = String(fileEntry.thumbnail || '').split('/').pop();
  return base ? `http://${ip}/downloads/humbnail/${encodeURIComponent(base)}` : '';
}
// Ex : thumbnail = "/mnt/UDISK/creality/local_gcode/humbnail/Benchy.png"
//      → http://192.168.40.106/downloads/humbnail/Benchy.png
```

### Logique de priorité (Tiger Studio)

```js
function resolveJobThumbnail(conn, d) {
  const fileName = String(d.printFileName || '').split('/').pop();
  const isPrinting = deriveDisplayState(d) === 'Printing';

  // 1. Priorité : thumbnail pré-slicé du fichier (toujours correct)
  if (fileName && Array.isArray(d.fileList)) {
    const match = d.fileList.find(f => f.name === fileName);
    if (match) return creThumbUrl(conn.ip, match);
  }

  // 2. Fallback : image live — uniquement pendant une impression active
  //    (après la fin, cette image reste celle du job précédent → ne pas utiliser)
  if (isPrinting) {
    return `http://${conn.ip}/downloads/original/current_print_image.png`;
  }

  return null;
}
```

> **Pourquoi `background-image` plutôt que `<img>`** : si l'URL répond 404, un `<img>` affiche l'icône "image cassée". Un `background-image` échoue silencieusement.

---

## 13. Moonraker HTTP — port 7125

Utilisé en parallèle du WebSocket pour les actions fichiers.

| Action | Méthode | Endpoint | Body |
|--------|---------|----------|------|
| Lancer impression | POST | `/printer/print/start` | `{"filename":"benchy.gcode"}` |
| Supprimer fichier | DELETE | `/server/files/gcodes/<filename>` | — |
| Liste fichiers | GET | `/server/files/list?root=gcodes` | — |
| Metadata fichier | GET | `/server/files/metadata?filename=<name>` | — |

```js
async function creStartPrint(ip, filename) {
  await fetch(`http://${ip}:7125/printer/print/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
}

async function creDeleteFile(ip, filename) {
  await fetch(`http://${ip}:7125/server/files/gcodes/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
  });
}
```

---

## 14. Gestion des erreurs

| Situation | Comportement |
|-----------|-------------|
| Port 9999 fermé | Ignorer, timeout 650 ms |
| WS handshake échoue | Log + retry après délai, ne pas retry immédiatement |
| Heartbeat reçu | Répondre `"ok"` (string brute), obligatoire |
| Frame non-JSON | `try/catch` autour de `JSON.parse`, ignorer |
| Payload > 2000 chars | Logger uniquement la taille (retMaterials très volumineux) |
| `err.errcode !== 0` | Afficher état "Error" avec le code |
| Déconnexion (`onClose`) | `connected = false`, reconnexion au retour en foreground (délai 300 ms) |
| `current_print_image.png` 404 | Pas d'impression en cours — afficher placeholder |

### Extraction erreur

```js
function extractErrCode(state) {
  const err = state.err;
  if (err && typeof err === 'object') return err.errcode || 0;
  if (typeof err === 'number') return err;
  if (typeof state.errcode === 'number') return state.errcode;
  return 0;
}
```

### Parsing robuste de `TotalLayer`

```js
const TOTAL_LAYER_KEYS = new Set([
  'totallayer','totallayers','totallayernum','totallayercount',
  'totallayernumber','totallayerindex','total_layer','total_layer_num',
  'total_layer_count','print_layer_total','print_layer_num',
  'targetprintlayer','layernumtotal','layercount','layer_count'
]);

function normalizeKey(k) { return k.toLowerCase().replace(/[^a-z0-9]/g,''); }

function extractTotalLayer(node, depth=0) {
  if (depth > 5 || node == null) return null;
  if (typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (TOTAL_LAYER_KEYS.has(normalizeKey(k))) {
        const n = parseInt(v);
        if (!isNaN(n) && n > 0) return n;
        if (typeof v === 'string') {
          const nums = [...v.matchAll(/\d+/g)].map(m => parseInt(m[0]));
          if (nums.length) return Math.max(...nums);
        }
      }
    }
    for (const v of Object.values(node)) {
      const found = extractTotalLayer(v, depth+1);
      if (found != null) return found;
    }
  } else if (Array.isArray(node)) {
    for (const item of node.slice(0,40)) {
      const found = extractTotalLayer(item, depth+1);
      if (found != null) return found;
    }
  } else if (typeof node === 'string') {
    try { return extractTotalLayer(JSON.parse(node), depth+1); } catch {}
  }
  return null;
}
```

---

## 15. Checklist d'implémentation

### Transport & Connexion

- [ ] WebSocket `ws://<ip>:9999/`
- [ ] Header `Authorization: Basic <base64>` si credentials (`root`/`creality_2025` par défaut)
- [ ] **Heartbeat `{"ModeCode":"heart_beat"}` → répondre `"ok"` (string brute)**
- [ ] Reconnexion automatique sur `onClose` (délai 300 ms)
- [ ] `try/catch` sur tout `JSON.parse`
- [ ] Ne pas logger les payloads `retMaterials` complets en prod

### Séquence d'init

- [ ] À l'ouverture WS → envoyer `get printerInfo`
- [ ] Dès 1er message reçu → envoyer `get {reqGcodeFile, reqGcodeList, boxsInfo, boxConfig, reqMaterials}`
- [ ] Merger toutes les frames dans un état cumulatif
- [ ] Pas de polling — l'imprimante push seule (mini-blobs ~1.5 s)

### Télémétrie

- [ ] `parseFloat()` sur toutes les températures (arrivent souvent comme strings)
- [ ] Accepter `bedTemp0` ET `bedTemp` pour le plateau
- [ ] Accepter `boxTemp` ET `chamberTemp` pour l'enceinte
- [ ] `printProgress` OU `dProgress` pour la progression
- [ ] Algo robuste `extractTotalLayer()` (`TotalLayer` — T majuscule)

### États

- [ ] `deriveDisplayState()` avec heuristiques impression/chauffe
- [ ] `state === 2` = terminé
- [ ] `extractErrCode()` depuis `err.errcode` ET `errcode` direct

### Filaments CFS

- [ ] Parser `boxsInfo.materialBoxs[]`
- [ ] `type === 1` = extrudeur externe (id: 0) — **1 seul slot, pas de temp/humidity**
- [ ] `type === 0` = module CFS — 4 slots, temp + humidity disponibles
- [ ] `state === 1` = slot actif
- [ ] Décoder couleurs avec `parseCrealityHex()` (format `#0RRGGBB`)
- [ ] `modifyMaterial` avec tous les champs obligatoires
- [ ] Encoder couleur avec `colorToCrealityHex()` (format `#0rrggbb`)

### Commandes

- [ ] `set pause: 1/0` — pause/reprise
- [ ] `set stop: 1` — annulation
- [ ] `set lightSw: 1/0` — toggle LED

### Thumbnails

- [ ] `getGcodeFileInfo2` pour la liste avec thumbnails
- [ ] `nozzleTemp` et `bedTemp` dans les fichiers sont × 100 (diviser par 100)
- [ ] `timeCost` en secondes
- [ ] URL thumb → extraire **uniquement le basename** → `http://<ip>/downloads/humbnail/<basename>.png`
- [ ] ⚠️ Typo firmware : `humbnail` sans `t`
- [ ] `current_print_image.png` : uniquement en fallback pendant une impression active

### Moonraker (port 7125)

- [ ] `POST /printer/print/start { filename }` pour lancer
- [ ] `DELETE /server/files/gcodes/<filename>` pour supprimer

### Caméra

- [ ] Port 8000, page HTML WebRTC autonome
- [ ] Option A : `<webview>` + CSS injection + arrêt tracks explicite
- [ ] Option B (Tiger Studio) : `RTCPeerConnection` direct, POST offer → `/call/webrtc_local`, `<video>` CSS-contrôlé

### Découverte

- [ ] TCP port 9999, timeout 650 ms, concurrence 64
- [ ] TCP port 8000 en parallèle (info caméra)
- [ ] WS handshake + `printerInfo` → 5 frames max ou identité confirmée, timeout 2200 ms
- [ ] `isCrealityLike()` : identité forte + télémétrie
- [ ] Tester `root`/`creality_2025` en fallback auth
- [ ] Balayer `192.168.1.x` et `192.168.40.x`

---

*Sources : Flutter `creality_websocket_page.dart` · `creality_scan_printers.dart` · widgets CFS/temp/print/camera · SSH live Ender-3 V4 `model:F009` mai 2026*
