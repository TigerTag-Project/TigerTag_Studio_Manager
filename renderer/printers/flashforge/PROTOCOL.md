# FlashForge HTTP — Agent Skill

> Référence complète pour implémenter l'intégration FlashForge dans une app Node.js/Electron.
> Extraite de l'app Flutter TigerTag Connect (tigertag_connect1).

---

## 1. Vue d'ensemble du transport

FlashForge utilise **HTTP polling** — pas de WebSocket, pas de MQTT, pas de TCP persistant pour les données live.

| Paramètre | Valeur |
|-----------|--------|
| Protocole données | HTTP/1.1 POST polling |
| Port HTTP | **8898** |
| Intervalle de polling | **2–3 secondes** |
| Format requête | JSON (`Content-Type: application/json`) |
| Format réponse | JSON |
| Authentification | Champ JSON dans le body (pas de header HTTP) |

### Ports utilisés

| Port | Protocole | Usage |
|------|-----------|-------|
| **8898** | HTTP POST | Données live (`/detail`) + commandes (`/control`) |
| **8899** | TCP raw   | Probe identité `~M115\r\n` (découverte uniquement) |
| **8080** | HTTP GET  | Flux caméra MJPEG |

```
Discovery  → HTTP POST :8898/detail  (probe)
           → TCP :8899 ~M115\r\n     (identité fallback)
Live data  → HTTP POST :8898/detail  (polling toutes les 2-3 s)
Control    → HTTP POST :8898/control (commandes filament)
Camera     → HTTP GET  :8080/?action=stream  (MJPEG)
```

---

## 2. Découverte réseau

### 2.1 Stratégie de scan

| Paramètre | Valeur |
|-----------|--------|
| Batches parallèles | **24 IPs** |
| Timeout par hôte | **350 ms** |
| Sous-réseaux toujours scannés | `192.168.1.x`, `192.168.40.x` |
| Port probe | `8898` (HTTP) + `8899` (TCP fallback) |

### 2.2 Probe HTTP — port 8898

```
POST http://<ip>:8898/detail
Content-Type: application/json

{
  "serialNumber": "",
  "checkCode": ""
}
```

**Réponse valide** : JSON contenant au moins un de `printerName`, `machineModel`, `serialNumber`, `detail`, `code`.

**Parsing de la réponse** :

```js
function flattenMap(map) {
  const out = { ...map };
  for (const key of ['result', 'detail', 'params', 'data', 'msg']) {
    if (map[key] && typeof map[key] === 'object') Object.assign(out, map[key]);
  }
  return out;
}

function firstString(obj, keys) {
  for (const k of keys) if (obj[k] && String(obj[k]).trim()) return String(obj[k]).trim();
  return '';
}

const flat = flattenMap(parsed);
const d = flat.detail || flat;

const hostName     = firstString(d, ['printerName','host_name','hostname','deviceName','name']);
const machineModel = firstString(d, ['machineModel','machine_model','model','printerModel']);
const serialNumber = firstString(d, ['serialNumber','serial_number','sn']);
const firmware     = firstString(d, ['firmwareVersion','firmware','version']);
const macAddress   = firstString(d, ['macAddr','macAddress','mac_address']);
```

### 2.3 Probe TCP — port 8899 (fallback identité)

Si la réponse HTTP est incomplète :

```js
// Connexion TCP brute
socket.connect(ip, 8899, { timeout: 700 })
socket.write("~M115\r\n")
// Lire jusqu'à "ok"
```

**Réponse M115** :
```
Machine Type: Adventurer 5M Pro
Machine Name: AD5M_Pro_XXXXXX
Firmware: v2.7.6
SN: SNXXXXXXXXXXXXXXXXXX
Mac Address: XX:XX:XX:XX:XX:XX
ok
```

| Clé M115 | Champ interne |
|----------|---------------|
| `Machine Type` | machineModel |
| `Machine Name` | machineName |
| `Firmware` | firmware |
| `SN` | serialNumber |
| `Mac Address` | macAddress |

**Normalisation serial** : retirer le préfixe `SN` pour le stockage local (re-ajouté à l'envoi API — voir §3).

### 2.4 Score de qualité (tri des résultats)

```js
function qualityScore(c) {
  let s = 0;
  if (c.hostName?.trim())     s += 4;
  if (c.machineName?.trim())  s += 4;
  if (c.machineModel?.trim()) s += 3;
  if (c.firmware?.trim())     s += 1;
  if (c.serialNumber?.trim()) s += 5;
  return s;
}
// Tri : score décroissant, puis IP croissante
```

### 2.5 Résolution du modèle

| Token dans la réponse | Modèle ID | Nom |
|-----------------------|-----------|-----|
| `ad5x` | `"1"` | AD5X |
| `5m pro`, `5mpro`, `adventurer 5m pro` | `"3"` | 5M Pro |
| `5m`, `adventurer 5m` (sans "pro") | `"2"` | 5M |
| `a5`, `adventurer a5` | `"4"` | A5 |
| (aucun match) | `"0"` | Select Printer |

---

## 3. Authentification

Pas de header HTTP — l'identité est passée dans le **body JSON** de chaque requête.

| Champ JSON | Type | Valeur |
|-----------|------|--------|
| `serialNumber` | string | Avec préfixe `SN` — ex: `"SN1234567890ABCDEF"` |
| `checkCode` | string | Code d'accès / mot de passe (peut être vide `""`) |

```js
function serialNumberForApi(rawSerial) {
  const s = rawSerial.trim();
  return s.startsWith('SN') ? s : 'SN' + s;
}
```

Le serial est stocké **sans préfixe** en local, mais **toujours envoyé avec `SN`** à l'API.

---

## 4. Séquence d'initialisation

```
1. Charger config : { ip, serialNumber, checkCode }
2. POST http://<ip>:8898/detail  { serialNumber: "SN...", checkCode }
   ├── code == -2 ou erreur réseau  → connected=false, arrêt
   ├── code == 1 + "SN is different" → connected=false, arrêt
   ├── code == 1 + "access code is different" → connected=false, arrêt
   └── code == 0 OU detail présent → connected=true ✓
3. Démarrer setInterval(2000) → POST /detail en boucle
4. Chaque réponse → parser snapshot (état, temps, filaments, caméra)
```

---

## 5. Endpoints HTTP

### 5.1 POST /detail

État complet (polling) :

```
POST http://<ip>:8898/detail
Content-Type: application/json
Accept: */*

{
  "serialNumber": "SNXXXXXXXXXXXXXXXXXX",
  "checkCode": "monMotDePasse"
}
```

### 5.2 POST /control

Commandes filament :

```
POST http://<ip>:8898/control
Content-Type: application/json
Accept: */*

{
  "serialNumber": "SNXXXXXXXXXXXXXXXXXX",
  "checkCode": "monMotDePasse",
  "payload": {
    "cmd": "<nom_commande>",
    "args": { ... }
  }
}
```

---

## 6. Payloads de réponse

### 6.1 Impression en cours

```json
{
  "code": 0,
  "message": "Success",
  "detail": {
    "printerName": "Adventurer 5M Pro",
    "status": "printing",
    "printProgress": 45,
    "printLayer": 120,
    "targetPrintLayer": 267,
    "estimatedTime": 3600,
    "printFileName": "mon_modele.gx",
    "printFileThumbUrl": "http://192.168.1.100:8898/thumb/mon_modele.jpg",
    "rightTemp": 220.5,
    "leftTemp": 0.0,
    "platTemp": 60.0,
    "chamberTemp": 35.0,
    "hasMatlStation": true,
    "indepMatlInfo": {
      "materialName": "PLA",
      "materialColor": "#FF5733"
    },
    "matlStationInfo": {
      "currentSlot": 2,
      "slotInfos": [
        { "slotId": 1, "hasFilament": true,  "materialName": "PLA",  "materialColor": "#FF0000" },
        { "slotId": 2, "hasFilament": true,  "materialName": "ABS",  "materialColor": "#0000FF" },
        { "slotId": 3, "hasFilament": false, "materialName": "",     "materialColor": "" },
        { "slotId": 4, "hasFilament": false, "materialName": "",     "materialColor": "" }
      ]
    },
    "cameraStreamUrl": "http://192.168.1.100:8080/?action=stream",
    "camera": true,
    "firmwareVersion": "v2.7.6",
    "serialNumber": "SNXXXXXXXXXXXXXXXXXX",
    "macAddr": "AA:BB:CC:DD:EE:FF"
  }
}
```

### 6.2 Codes d'erreur

| `code` | `message` | Signification |
|--------|-----------|---------------|
| `0` | `"Success"` | OK — parser `detail` |
| `1` | `"SN is different"` | Mauvais numéro de série |
| `1` | `"access code is different"` | Mauvais mot de passe |
| `-1` | `"Invalid JSON"` | Réponse non parsable (généré côté client) |
| `-2` | `"Network error: ..."` | Erreur réseau (généré côté client) |

---

## 7. Table d'extraction des champs

Tous les champs sont extraits de `resp.detail` (si présent) ou de `resp` directement.

### 7.1 Impression

| Chemin JSON (`detail.*`) | Clé interne | Type | Notes |
|--------------------------|-------------|------|-------|
| `status` | `status` | string | État — voir §8 |
| `printProgress` | `progressPct` | number | 0–100 **ou** 0.0–1.0 — normaliser |
| `printLayer` | `currentLayer` | int | Couche actuelle |
| `targetPrintLayer` | `totalLayer` | int | Nombre total de couches |
| `estimatedTime` | `remainingSeconds` | int | Secondes restantes |
| `printFileName` / `fileName` | `jobName` | string | Nom du fichier |
| `printFileThumbUrl` | `thumbnailUrl` | string | URL HTTP miniature |

**Normalisation progression** :

```js
const p = detail.printProgress ?? 0;
const progressPct = p <= 1.0 ? Math.round(p * 100) : Math.round(p);
```

### 7.2 Températures

| Chemin JSON | Clé interne | Type | Notes |
|-------------|-------------|------|-------|
| `rightTemp` | `nozzleCurrent` | float | Nozzle principal |
| `leftTemp` | `nozzleCurrentLeft` | float | Nozzle gauche (fallback) |
| `platTemp` | `bedCurrent` | float | Plateau |
| `chamberTemp` | `chamberCurrent` | float | Enceinte |

> Pas de températures cibles (consignes) dans `/detail` FlashForge.

### 7.3 Filament — bobine externe

Chemin : `detail.indepMatlInfo`

| Champ JSON | Clé interne | Type |
|-----------|-------------|------|
| `materialName` | `materialType` | string |
| `materialColor` | `color` | string `#RRGGBB` |

### 7.4 Filament — Material Station (CFS)

Présence CFS : `detail.hasMatlStation === true`  
Chemin station : `detail.matlStationInfo`

| Champ JSON | Clé interne | Type | Notes |
|-----------|-------------|------|-------|
| `matlStationInfo.currentSlot` | `currentSlot` | int | Slot actif (1–4), 0 = aucun |
| `matlStationInfo.slotInfos[]` | `slots` | array | 4 slots |
| `slotInfos[i].slotId` | `slotId` | int | **1-indexé** (pas 0) |
| `slotInfos[i].hasFilament` | `hasFilament` | bool | Filament présent |
| `slotInfos[i].materialName` | `materialType` | string | Matière |
| `slotInfos[i].materialColor` | `color` | string | Hex avec `#` |

### 7.5 Caméra

| Chemin JSON | Type | Notes |
|-------------|------|-------|
| `detail.cameraStreamUrl` (ou `cameraUrl`, `camera_url`, `streamUrl`, `url`) | string | URL MJPEG explicite |
| `detail.camera` | bool/int | Flag présence caméra |
| `detail.hasCamera` | bool | Alias |
| `detail.cameraEnabled` / `camera_enabled` | bool/int | Alias |

---

## 8. États d'impression (`detail.status`)

| Valeur | Signification | Spinner |
|--------|---------------|---------|
| `"printing"` | Impression en cours | oui |
| `"preparing"` / `"prepare"` | Préparation / chauffe | oui |
| `"busy"` | Occupé | oui |
| `"heating"` | Chauffe | oui |
| `"ready"` | Prêt | non |
| `"idle"` | Inactif | non |
| `"complete"` | Terminé | non |
| `"cancelled"` | Annulé | non |
| `""` vide | Traité comme idle | non |

```js
const ACTIVE_STATES = ['printing','preparing','prepare','busy','heating'];
const DONE_STATES   = ['','ready','idle','complete','cancelled'];
```

---

## 9. Températures

```js
function parseTemperatures(detail) {
  return {
    nozzleCurrent:  parseFloat(detail.rightTemp) || parseFloat(detail.leftTemp) || null,
    bedCurrent:     parseFloat(detail.platTemp)  || null,
    chamberCurrent: parseFloat(detail.chamberTemp) || null,
    // Pas de consignes disponibles via /detail
    nozzleTarget: null,
    bedTarget:    null,
    chamberTarget: null,
  };
}
```

---

## 10. Données filament / extrudeur

### Parsing complet

```js
function parseFilament(detail) {
  const slots = [];

  // Slot 0 — bobine externe
  if (detail.indepMatlInfo && typeof detail.indepMatlInfo === 'object') {
    const i = detail.indepMatlInfo;
    slots.push({
      index: 0, label: i.materialName || 'External',
      materialType: i.materialName || null,
      color: parseHexColor(i.materialColor || ''),
      active: true, isExternal: true,
    });
  }

  // Slots 1–4 — Material Station (CFS)
  if (detail.hasMatlStation === true) {
    const ms = detail.matlStationInfo;
    if (ms && Array.isArray(ms.slotInfos)) {
      for (const slot of ms.slotInfos) {
        const id = slot.slotId; // 1-indexé
        slots.push({
          index: id, label: slot.materialName || `Slot ${id}`,
          materialType: slot.materialName || null,
          color: parseHexColor(slot.materialColor || ''),
          active: slot.hasFilament === true,
          isExternal: false, hasFilament: slot.hasFilament === true,
        });
      }
    }
  }

  return slots;
}
```

### Parsing couleur

```js
function parseHexColor(s) {
  let hex = s.trim().replace(/^#/, '');
  // Bug firmware : longueur 7 commençant par '0' → retirer premier char
  if (hex.length === 7 && hex.startsWith('0')) hex = hex.slice(1);
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0,2), 16);
  const g = parseInt(hex.slice(2,4), 16);
  const b = parseInt(hex.slice(4,6), 16);
  return { r, g, b, hex: `#${hex.toUpperCase()}` };
}
```

---

## 11. Miniature / aperçu

URL fournie directement dans `/detail` :

```js
const thumbUrl = (detail.printFileThumbUrl || '').trim() || null;
// Charger via <img src="..."> — pas d'auth requise
// Placeholder si vide ou erreur 404
```

---

## 12. Flux caméra (MJPEG)

### Résolution de l'URL

```js
function resolveCameraUrl(printer, detail) {
  // 1. URL explicite dans /detail
  const explicit = detail.cameraStreamUrl || detail.cameraUrl
    || detail.camera_url || detail.streamUrl || detail.url;
  if (explicit?.trim()) return explicit.trim();

  // 2. Flag caméra présent
  const hasFlag = detail.camera === true || detail.camera === 1
    || detail.hasCamera === true
    || detail.cameraEnabled === true || detail.cameraEnabled === 1
    || detail.camera_enabled === true || detail.camera_enabled === 1;

  // 3. Modèle connu avec caméra (AD5X, 5M, 5M Pro, A5)
  const modelHasCamera = ['1','2','3','4'].includes(printer.printerModelId);

  if (!hasFlag && !modelHasCamera) return null;
  const ip = printer.ip.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  return `http://${ip}:8080/?action=stream`;
}
```

### URL standard

```
http://<ip>:8080/?action=stream
```

### Contrainte : 1 seul client simultané

Le mjpg-streamer FlashForge n'accepte **qu'un seul client à la fois**. Si un second se connecte → `onerror` sur le `<img>`.

```js
// Cache-buster pour forcer un nouveau slot TCP
const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + '_=' + Date.now();
```

Gérer via `onerror` → vue fallback (photo statique + bouton Retry).

---

## 13. Commandes de contrôle

### 13.1 Configurer un slot CFS (Material Station)

```json
{
  "serialNumber": "SNXXXXXXXXXXXXXXXXXX",
  "checkCode": "motDePasse",
  "payload": {
    "cmd": "msConfig_cmd",
    "args": {
      "slot": 2,
      "mt": "PLA",
      "rgb": "FF5733"
    }
  }
}
```

| Champ `args` | Type | Notes |
|-------------|------|-------|
| `slot` | int | **1–4** (1-indexé) |
| `mt` | string | Matière ex: `"PLA"`, `"ABS"`, `"PETG"` |
| `rgb` | string | Hex 6 chars **SANS `#`** ex: `"FF5733"` |

### 13.2 Configurer la bobine externe

```json
{
  "serialNumber": "SNXXXXXXXXXXXXXXXXXX",
  "checkCode": "motDePasse",
  "payload": {
    "cmd": "ipdMsConfig_cmd",
    "args": {
      "mt": "PLA",
      "rgb": "FF5733"
    }
  }
}
```

> Pas de champ `slot` — s'applique uniquement à la bobine externe.

### 13.3 Encodage couleur pour envoi

```js
function colorToRgb6(r, g, b) {
  return (
    r.toString(16).padStart(2,'0').toUpperCase() +
    g.toString(16).padStart(2,'0').toUpperCase() +
    b.toString(16).padStart(2,'0').toUpperCase()
  );
  // ex: { r:255, g:87, b:51 } → "FF5733"  (SANS '#')
}
```

### 13.4 Résolution destination (slot → cmd)

```js
function resolveDestination(slot) {
  const label = (slot.label || '').trim().toUpperCase();
  if (label.startsWith('EXT')) return { isExternal: true, slot1to4: 0 };
  const m = label.match(/^\d+([A-D])$/);
  if (m) return { isExternal: false, slot1to4: m[1].charCodeAt(0) - 64 }; // A=1..D=4
  return { isExternal: false, slot1to4: Math.max(1, slot.index) };
}
```

### 13.5 Pause / reprise / stop

Non documentés dans les sources Flutter lues. Ces commandes existent dans l'API FlashForge mais n'ont pas encore été reverse-engineerées. À implémenter après capture du trafic réseau.

---

## 14. Gestion des erreurs

```js
function handleDetailResponse(resp, state) {
  const code = resp.code;
  const msg  = (resp.message || '').toLowerCase();

  if (code === -2 || msg.includes('network error')) {
    state.connected = false;
    state.stopPoll();
    return;
  }
  if (code === 1 && msg.includes('sn is different')) {
    state.connected = false;
    state.stopPoll();
    showAlert('Numéro de série incorrect — vérifier les paramètres');
    return;
  }
  if (code === 1 && msg.includes('access code is different')) {
    state.connected = false;
    state.stopPoll();
    showAlert('Mot de passe incorrect — vérifier les paramètres');
    return;
  }
  if (code === 0 || resp.detail != null) {
    state.connected  = true;
    state.connecting = false;
  }
  updateSnapshot(resp);
}
```

| Situation | Action |
|-----------|--------|
| Erreur réseau (code -2) | Déconnecter, arrêter le poll |
| Mauvais serial (code 1) | Déconnecter, alerter, arrêter le poll |
| Mauvais mot de passe (code 1) | Déconnecter, alerter, arrêter le poll |
| JSON invalide (code -1) | Logger, réessayer au prochain tick |
| Caméra 1 seul client | Vue fallback + bouton Retry avec cache-buster |
| `printFileThumbUrl` vide | Afficher placeholder |
| Couleur hex longueur 7 + `0` | Corriger : retirer le 1er char (bug firmware) |

---

## 15. Checklist d'implémentation

### Config

- [ ] `FlashforgePrinterConfig` : `{ id, printerName, ip, printerModelId, serialNumber, password, isActive, updatedAt }`
- [ ] `serialNumberForApi()` : préfixer avec `SN` si absent

### Découverte

- [ ] Scan subnet /24, batches 24, timeout 350 ms/host
- [ ] Probe `POST :8898/detail { serialNumber:"", checkCode:"" }`
- [ ] Probe TCP `:8899 ~M115\r\n` en fallback identité
- [ ] Parser M115 (lignes `Key: Value`)
- [ ] Score qualité + tri
- [ ] Résoudre modèle par tokens (ad5x / 5m pro / 5m / a5)

### Connexion et polling

- [ ] `POST /detail` → `code===0` ou `detail` présent → `connected=true`
- [ ] `setInterval(2000)` → poll en boucle
- [ ] Arrêter le poll sur erreur réseau ou bad credentials
- [ ] Normaliser `printProgress` (≤1.0 → ×100)

### Parsing

- [ ] Extraire `detail` de `resp.detail` ou `resp`
- [ ] Parser `status` → état
- [ ] Extraire couches, temps restant, nom fichier
- [ ] Températures : `rightTemp` (nozzle), `platTemp` (bed), `chamberTemp`
- [ ] Parser `indepMatlInfo` (slot externe)
- [ ] Vérifier `hasMatlStation` → parser `matlStationInfo.slotInfos[]`
- [ ] Corriger bug couleur hex longueur 7 + `0`

### Caméra

- [ ] Chercher URL dans `detail.cameraStreamUrl` et variantes
- [ ] Fallback → `http://<ip>:8080/?action=stream` si flag ou modèle connu
- [ ] Afficher via `<img src="...">` (MJPEG)
- [ ] Gérer `onerror` → vue fallback + Retry avec cache-buster `?_=<ts>`

### Miniature

- [ ] Extraire `detail.printFileThumbUrl`
- [ ] Charger via `<img>` sans auth

### Commandes filament

- [ ] `ipdMsConfig_cmd` : `{ mt, rgb }` (bobine externe, sans slot)
- [ ] `msConfig_cmd` : `{ slot: 1-4, mt, rgb }` (CFS)
- [ ] Couleur → hex 6 chars SANS `#`, majuscules

### Modèles supportés

| Model ID | Nom | Caméra | CFS |
|----------|-----|--------|-----|
| `"1"` | AD5X | oui | oui |
| `"2"` | 5M | oui | oui |
| `"3"` | 5M Pro | oui | oui |
| `"4"` | A5 | oui | oui |
| `"0"` | Select Printer | — | — |
