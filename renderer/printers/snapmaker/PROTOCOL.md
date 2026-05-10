# Protocole Snapmaker (Moonraker) — Référence complète pour implémentation Node.js/Electron

> Source : analyse des fichiers Flutter `snapmaker_websocket_page.dart`, `snapmaker_scan_printers.dart`, `snapmaker_main.dart`, widgets `snapmaker_*.dart` et `snapmaker_printer_brand_adapter.dart`.
> Rédigé en français, structuré pour un agent IA devant implémenter l'intégration Snapmaker dans Studio Manager.

---

## Sommaire

1. [Transport et protocole de base](#1-transport-et-protocole-de-base)
2. [Paramètres de connexion](#2-paramètres-de-connexion)
3. [Séquence d'initialisation complète](#3-séquence-dinitialisation-complète)
4. [Format des messages envoyés (client → imprimante)](#4-format-des-messages-envoyés-client--imprimante)
5. [Format des messages reçus (imprimante → client)](#5-format-des-messages-reçus-imprimante--client)
6. [Table d'extraction des champs](#6-table-dextraction-des-champs)
7. [États d'impression — valeurs possibles](#7-états-dimpression--valeurs-possibles)
8. [Structure des données de température](#8-structure-des-données-de-température)
9. [Structure des données filament / matériaux](#9-structure-des-données-filament--matériaux)
10. [Récupération de la miniature / aperçu du fichier](#10-récupération-de-la-miniature--aperçu-du-fichier)
11. [Flux caméra — URL, port, protocole](#11-flux-caméra--url-port-protocole)
12. [Commandes de contrôle](#12-commandes-de-contrôle)
13. [Découverte réseau (scan LAN)](#13-découverte-réseau-scan-lan)
14. [Gestion des erreurs](#14-gestion-des-erreurs)
15. [Checklist d'implémentation](#15-checklist-dimplémentation)

---

## 1. Transport et protocole de base

| Couche | Valeur |
|--------|--------|
| **Transport** | WebSocket (`ws://`) — **pas** `wss://`, pas de TLS |
| **Protocole application** | JSON-RPC 2.0 |
| **Port WebSocket** | **7125** |
| **Path WebSocket** | `/websocket` |
| **Authentification** | Aucune (pas de token, pas de header) |
| **Format des frames** | UTF-8 JSON text frames exclusivement |

URI complète de connexion :
```
ws://<IP>:7125/websocket
```

Le serveur cible est **Moonraker**, le backend de Klipper utilisé par les imprimantes Snapmaker Artisan / J1 / J1s qui fonctionnent sous Klipper.

---

## 2. Paramètres de connexion

### 2.1 Configuration requise côté client

```js
const config = {
  host: '192.168.1.42',   // IP de l'imprimante sur le LAN
  port: 7125,
  path: '/websocket',
  // Aucun header supplémentaire requis
};
const uri = `ws://${config.host}:${config.port}${config.path}`;
```

### 2.2 Structure interne de configuration imprimante

```js
// Objet de config persisté (localStorage / Firestore)
{
  id: 'snap_1715347200000',       // clé unique générée : 'snap_' + timestamp ms
  printerName: 'Mon Snapmaker',   // nom d'affichage
  ip: '192.168.1.42',             // hôte WebSocket
  printerModelId: '1',            // id du modèle dans snap_printer_models.json
  isActive: false,
  updatedAt: 1715347200000        // timestamp ms pour merge hybride local/cloud
}
```

---

## 3. Séquence d'initialisation complète

L'initialisation se déroule en **4 étapes** dès l'ouverture du WebSocket :

```
Client                                    Moonraker (port 7125)
  |                                              |
  |──── WebSocket connect ──────────────────────▶|
  |                                              |
  | ① SUBSCRIBE (printer.objects.subscribe)     |
  |──── JSON-RPC id:1 ──────────────────────────▶|
  |◀─── result { status: {...} } ───────────────|  (snapshot initial)
  |                                              |
  | ② QUERY initial (printer.objects.query)     |
  |──── JSON-RPC id:1001 ───────────────────────▶|
  |◀─── result { status: {...} } ───────────────|  (températures live)
  |                                              |
  | ③ Flux continu notify_status_update         |
  |◀─── method: notify_status_update ───────────|  (push automatique)
  |◀─── method: notify_status_changed ──────────|  (push automatique)
  |                                              |
  | ④ (Optionnel) GET boxsInfo                  |
  |──── {"method":"get","params":{"boxsInfo":1}}▶|  (protocole non JSON-RPC)
  |◀─── {"result": {"boxsInfo": {...}}} ────────|
```

### Étape ① — Subscribe

Envoyé immédiatement après ouverture du WebSocket.  
Abonnement à tous les objets utiles + températures :

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.subscribe",
  "params": {
    "objects": {
      "print_task_config": null,
      "print_stats": null,
      "virtual_sdcard": null,
      "display_status": null,
      "extruder":  ["temperature", "target"],
      "extruder1": ["temperature", "target"],
      "extruder2": ["temperature", "target"],
      "extruder3": ["temperature", "target"],
      "heater_bed": ["temperature", "target"]
    }
  },
  "id": 1
}
```

> **Règle** : `null` = tous les champs de l'objet. `["temperature","target"]` = seulement ces champs.

La réponse contient un snapshot complet de l'état actuel dans `result.status`.

### Étape ② — Query initial (températures)

Envoyé juste après le subscribe pour forcer un snapshot complet des températures :

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.query",
  "params": {
    "objects": {
      "print_stats": null,
      "virtual_sdcard": null,
      "display_status": null,
      "extruder": null,
      "extruder1": null,
      "extruder2": null,
      "extruder3": null,
      "heater_bed": null
    }
  },
  "id": 1001
}
```

### Étape ③ — Flux continu

Moonraker pousse automatiquement les mises à jour via `notify_status_update` ou `notify_status_changed` sans qu'aucune requête supplémentaire soit nécessaire.

### Étape ④ — boxsInfo (CFS multi-bobines, optionnel)

Protocole propriétaire Snapmaker (non JSON-RPC standard) :

```json
{
  "method": "get",
  "params": { "boxsInfo": 1 }
}
```

---

## 4. Format des messages envoyés (client → imprimante)

### 4.1 Subscribe aux objets

Voir [Étape ①](#étape---subscribe).

### 4.2 Query ponctuel d'un objet

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.query",
  "params": {
    "objects": {
      "print_task_config": null
    }
  },
  "id": 911
}
```

### 4.3 Query des températures live

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.query",
  "params": {
    "objects": {
      "extruder": null,
      "extruder1": null,
      "extruder2": null,
      "extruder3": null,
      "heater_bed": null
    }
  },
  "id": 1001
}
```

### 4.4 Envoi d'un script G-Code

```json
{
  "jsonrpc": "2.0",
  "method": "printer.gcode.script",
  "params": {
    "script": "<gcode_string>"
  },
  "id": 200
}
```

### 4.5 Push configuration filament (G-Code spécifique Snapmaker)

```json
{
  "jsonrpc": "2.0",
  "method": "printer.gcode.script",
  "params": {
    "script": "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=0 VENDOR=Generic FILAMENT_TYPE=PLA FILAMENT_SUBTYPE= FILAMENT_COLOR_RGBA=FF5500FF"
  },
  "id": 201
}
```

Paramètres de `SET_PRINT_FILAMENT_CONFIG` :

| Paramètre | Description | Exemple |
|-----------|-------------|---------|
| `CONFIG_EXTRUDER` | Indice extrudeur (0-based) | `0`, `1`, `2`, `3` |
| `VENDOR` | Nom du fabricant (sans espaces) | `Generic`, `Snapmaker` |
| `FILAMENT_TYPE` | Type de filament (tirets au lieu d'espaces) | `PLA`, `PETG`, `ABS`, `TPU` |
| `FILAMENT_SUBTYPE` | Sous-type ou série (peut être vide) | ``, `Basic`, `Matte` |
| `FILAMENT_COLOR_RGBA` | Couleur en hexadécimal RRGGBBAA | `FF5500FF` |

> **Format de couleur** : RRGGBBAA (Rouge Vert Bleu Alpha), chacun sur 2 chiffres hex, en majuscules, sans le `#`.

### 4.6 modifyMaterial (protocole propriétaire Snapmaker)

```json
{
  "method": "set",
  "params": {
    "modifyMaterial": {
      "id": 0,
      "boxId": 1,
      "rfid": "06001",
      "type": "ABS",
      "vendor": "SnapMaker",
      "name": "Ender-PLA",
      "color": "#06c84ff",
      "minTemp": 190.0,
      "maxTemp": 240.0,
      "pressure": 0.04
    }
  }
}
```

> **Note** : Ce message utilise `"method":"set"` (sans `jsonrpc`), protocole non-standard Snapmaker. Le champ `color` utilise ici le format `#0RRGGBB` (7 chiffres avec leading zero optionnel).

### 4.7 autohome

```json
{
  "method": "set",
  "params": { "autohome": "XYZ" }
}
```

### 4.8 boxsInfo (lecture des modules CFS)

```json
{
  "method": "get",
  "params": { "boxsInfo": 1 }
}
```

---

## 5. Format des messages reçus (imprimante → client)

### 5.1 Réponse JSON-RPC standard (résultat query/subscribe)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": {
      "print_stats": {
        "filename": "benchy.gcode",
        "state": "printing",
        "print_duration": 3620.5,
        "total_duration": 3650.2,
        "info": {
          "current_layer": 42,
          "total_layer": 180
        }
      },
      "virtual_sdcard": {
        "file_path": "/printer_data/gcodes/benchy.gcode",
        "file_position": 1048576,
        "file_size": 4194304,
        "progress": 0.25
      },
      "display_status": {
        "progress": 0.2487,
        "message": ""
      },
      "print_task_config": {
        "filament_color_rgba": ["FF5500FF", "00FF00FF", "0000FFFF", "FFFFFFFF"],
        "filament_vendor":     ["Generic", "Snapmaker", "", ""],
        "filament_type":       ["PLA", "PETG", "", ""],
        "filament_sub_type":   ["Basic", "", "", ""],
        "filament_official":   [false, true, false, false],
        "filament_nozzle_temp_min": [190, 230, null, null],
        "filament_nozzle_temp_max": [220, 260, null, null],
        "filament_bed_temp_min":    [50, 70, null, null],
        "filament_bed_temp_max":    [65, 85, null, null]
      },
      "extruder": {
        "temperature": 215.3,
        "target": 215.0
      },
      "extruder1": {
        "temperature": 0.0,
        "target": 0.0
      },
      "extruder2": {
        "temperature": 0.0,
        "target": 0.0
      },
      "extruder3": {
        "temperature": 0.0,
        "target": 0.0
      },
      "heater_bed": {
        "temperature": 60.1,
        "target": 60.0
      }
    },
    "eventtime": 12345.678
  }
}
```

### 5.2 Push de mise à jour live — notify_status_update

```json
{
  "jsonrpc": "2.0",
  "method": "notify_status_update",
  "params": [
    {
      "print_stats": {
        "state": "printing",
        "print_duration": 3680.1
      },
      "extruder": {
        "temperature": 216.0,
        "target": 215.0
      }
    },
    12346.123
  ]
}
```

> **Règle** : `params[0]` est le dictionnaire de statut partiel (seuls les champs modifiés). `params[1]` est le timestamp Klipper.

### 5.3 Push de mise à jour live — notify_status_changed

Même format que `notify_status_update`, méthode différente. Les deux méthodes sont traitées de façon identique.

```json
{
  "jsonrpc": "2.0",
  "method": "notify_status_changed",
  "params": [
    { "display_status": { "progress": 0.2650 } },
    12347.456
  ]
}
```

### 5.4 Réponse boxsInfo (protocole propriétaire)

```json
{
  "result": {
    "boxsInfo": {
      "materialBoxs": [
        {
          "id": 0,
          "type": 1,
          "materials": [
            {
              "color": "#0FF5500",
              "type": "PLA",
              "state": 1
            }
          ]
        },
        {
          "id": 1,
          "type": 0,
          "materials": [
            { "color": "#0FF5500", "type": "PLA",  "state": 1 },
            { "color": "#000FF00", "type": "PETG", "state": 0 },
            { "color": "#00000FF", "type": "ABS",  "state": 0 },
            { "color": "#0FFFFFF", "type": "TPU",  "state": 0 }
          ]
        }
      ]
    }
  }
}
```

Structure `materialBoxs` :
- `id: 0` → bobine externe (extrudeur direct, type ≠ 0)
- `id >= 1, type: 0` → module CFS (rack de bobines)
- `materials[i].state: 1` → slot actif (actuellement en cours d'impression)

### 5.5 Réponse à printer.gcode.script

```json
{
  "jsonrpc": "2.0",
  "id": 201,
  "result": "ok"
}
```

En cas d'erreur G-Code :
```json
{
  "jsonrpc": "2.0",
  "id": 201,
  "error": {
    "code": -32601,
    "message": "Unknown command: SET_PRINT_FILAMENT_CONFIG"
  }
}
```

---

## 6. Table d'extraction des champs

### 6.1 Progression et statut d'impression

| Chemin JSON | Clé interne | Type | Notes |
|-------------|-------------|------|-------|
| `result.status.print_stats.state` | `printState` | string | Voir §7 |
| `result.status.print_stats.filename` | `filename` | string | Relatif au dossier gcodes |
| `result.status.print_stats.print_duration` | `printDuration` | float | Secondes |
| `result.status.print_stats.total_duration` | `totalDuration` | float | Secondes |
| `result.status.print_stats.estimated_time` | `estimatedTime` | float | Secondes (si présent) |
| `result.status.print_stats.info.current_layer` | `currentLayer` | int | Couche actuelle |
| `result.status.print_stats.info.total_layer` | `totalLayer` | int | Couche totale |
| `result.status.virtual_sdcard.progress` | `progressVsd` | float 0.0–1.0 | Progression via position |
| `result.status.virtual_sdcard.file_position` | `filePosition` | int | Octets lus |
| `result.status.virtual_sdcard.file_size` | `fileSize` | int | Taille totale en octets |
| `result.status.virtual_sdcard.file_path` | `filePath` | string | Chemin absolu |
| `result.status.display_status.progress` | `progressDisplay` | float 0.0–1.0 | Progression affichée |

> **Priorité de progression** : `display_status.progress` > `virtual_sdcard.progress` > calculé (`file_position / file_size`) > calculé (`print_duration / estimated_time`)

> **Normalisation de la progression** : si la valeur est > 1.0, elle est en pourcentage (0–100) → diviser par 100.

### 6.2 Nom de fichier — extraction depuis filePath

```js
function extractFilename(stats, vsd) {
  const candidates = [
    stats.filename || '',
    vsd.file_path || '',
  ];
  for (let raw of candidates) {
    let s = raw.trim();
    if (!s) continue;
    if (s.startsWith('/')) {
      const idx = s.indexOf('/gcodes/');
      if (idx >= 0) s = s.substring(idx + '/gcodes/'.length);
      else {
        const idx2 = s.indexOf('/printer_data/gcodes/');
        if (idx2 >= 0) s = s.substring(idx2 + '/printer_data/gcodes/'.length);
      }
    } else if (s.startsWith('gcodes/')) {
      s = s.substring('gcodes/'.length);
    }
    s = s.replace(/\/\//g, '/').trim();
    if (s) return s;
  }
  return '';
}
```

### 6.3 Températures

| Chemin JSON | Clé interne | Description |
|-------------|-------------|-------------|
| `result.status.extruder.temperature` | `e1_temp` | Extrudeur 1, temp actuelle |
| `result.status.extruder.target` | `e1_target` | Extrudeur 1, consigne |
| `result.status.extruder1.temperature` | `e2_temp` | Extrudeur 2 |
| `result.status.extruder1.target` | `e2_target` | Extrudeur 2, consigne |
| `result.status.extruder2.temperature` | `e3_temp` | Extrudeur 3 |
| `result.status.extruder2.target` | `e3_target` | Extrudeur 3, consigne |
| `result.status.extruder3.temperature` | `e4_temp` | Extrudeur 4 |
| `result.status.extruder3.target` | `e4_target` | Extrudeur 4, consigne |
| `result.status.heater_bed.temperature` | `bed_temp` | Plateau chauffant |
| `result.status.heater_bed.target` | `bed_target` | Plateau, consigne |

### 6.4 Filament — print_task_config

| Chemin JSON | Clé interne | Type | Notes |
|-------------|-------------|------|-------|
| `print_task_config.filament_color_rgba[i]` | `colors[i]` | string hex 8 chars | Format RRGGBBAA |
| `print_task_config.filament_vendor[i]` | `vendors[i]` | string | Fabricant ex: `Generic` |
| `print_task_config.filament_type[i]` | `types[i]` | string | `PLA`, `ABS`, `PETG`, `TPU`… |
| `print_task_config.filament_sub_type[i]` | `subTypes[i]` | string | Sous-type ex: `Basic`, `Matte` |
| `print_task_config.filament_official[i]` | `official[i]` | bool | true = RFID officiel détecté |
| `print_task_config.filament_nozzle_temp_min[i]` | `nozzleMin[i]` | int/null | °C minimum buse |
| `print_task_config.filament_nozzle_temp_max[i]` | `nozzleMax[i]` | int/null | °C maximum buse |
| `print_task_config.filament_bed_temp_min[i]` | `bedMin[i]` | int/null | °C minimum plateau |
| `print_task_config.filament_bed_temp_max[i]` | `bedMax[i]` | int/null | °C maximum plateau |

> `i` = 0 à 3 (4 extrudeurs max). Les listes peuvent être absentes ou courtes — toujours accéder avec un fallback.

### 6.5 Métadonnées fichier (REST HTTP)

| Champ | Description |
|-------|-------------|
| `estimated_time` | Durée estimée en secondes (float) |
| `thumbnails` | Tableau d'objets miniatures |
| `thumbnails[i].width` | Largeur px |
| `thumbnails[i].height` | Hauteur px |
| `thumbnails[i].size` | Taille en octets |
| `thumbnails[i].relative_path` | Chemin relatif de la miniature |
| `thumbnails[i].thumbnail_path` | Chemin alternatif (fallback) |

---

## 7. États d'impression — valeurs possibles

| Valeur brute (`print_stats.state`) | Couleur UI | Spinner | Description |
|------------------------------------|------------|---------|-------------|
| `printing` | Bleu | oui | Impression en cours |
| `busy` | Bleu | oui | Occupé (identique à printing) |
| `paused` | Orange | non | En pause |
| `error` | Rouge | non | Erreur |
| `heating` | Orange | oui | En phase de chauffe |
| `cancelled` | Gris | non | Annulée (masqué dans l'UI) |
| `complete` | Vert | non | Terminée (masqué dans l'UI) |
| `standby` | — | non | Veille (masqué dans l'UI) |
| `""` (vide) | — | — | Pas d'impression active |

> **Règle d'affichage** : masquer la carte d'impression si l'état est `standby`, `complete`, ou `cancelled` ET que le nom de fichier est vide.

---

## 8. Structure des données de température

### 8.1 Objet interne de températures

```js
// État interne fusionné (clés internes)
const temps = {
  e1_temp:   215.3,   // Extrudeur 1 actuel
  e1_target: 215.0,   // Extrudeur 1 consigne
  e2_temp:   0.0,
  e2_target: 0.0,
  e3_temp:   0.0,
  e3_target: 0.0,
  e4_temp:   0.0,
  e4_target: 0.0,
  bed_temp:   60.1,
  bed_target: 60.0,
};
```

### 8.2 Fusion des données de température depuis le statut

```js
function mergeLiveTemps(existing, statusPayload) {
  const merged = { ...existing };

  function putHeater(objectName, prefix) {
    const raw = statusPayload[objectName];
    if (!raw || typeof raw !== 'object') return;
    if (raw.temperature != null) merged[`${prefix}_temp`]   = parseFloat(raw.temperature);
    if (raw.target      != null) merged[`${prefix}_target`] = parseFloat(raw.target);
  }

  putHeater('extruder',  'e1');
  putHeater('extruder1', 'e2');
  putHeater('extruder2', 'e3');
  putHeater('extruder3', 'e4');
  putHeater('heater_bed', 'bed');

  return merged;
}
```

### 8.3 Affichage formaté

```js
function formatTempPair(current, target) {
  const c = current != null ? Math.round(current) : '--';
  const t = target  != null ? Math.round(target)  : '--';
  return `${c} / ${t}°C`;
}
// Ex : "215 / 215°C"
```

---

## 9. Structure des données filament / matériaux

### 9.1 Source 1 — print_task_config (Moonraker JSON-RPC)

Disponible dans l'objet `print_task_config` retourné par subscribe/query.  
Représente les 4 extrudeurs avec leur configuration courante :

```js
// Extraction des données filament
function extractFilamentSlots(printTaskConfig) {
  const colors   = printTaskConfig.filament_color_rgba   || [];
  const vendors  = printTaskConfig.filament_vendor       || [];
  const types    = printTaskConfig.filament_type         || [];
  const subTypes = printTaskConfig.filament_sub_type     || [];
  const official = printTaskConfig.filament_official     || [];

  const slots = [];
  for (let i = 0; i < 4; i++) {
    slots.push({
      index:        i,
      colorRgbaHex: colors[i]   || null,    // "FF5500FF" RRGGBBAA
      vendor:       vendors[i]  || '',
      materialType: types[i]    || '',
      subType:      subTypes[i] || '',
      isOfficial:   official[i] === true,
      active:       false,                   // non fourni dans ce payload
      label:        [vendors[i], subTypes[i], types[i]]
                      .filter(Boolean).join(' · '),
    });
  }
  return slots;
}
```

### 9.2 Parseur de couleur RGBA hex 8 chars

```js
function parseRgbaHex(s) {
  // Format RRGGBBAA (8 chars hex, sans #)
  const hex = (s || '').trim().replace(/^#/, '');
  if (hex.length !== 8) return null;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const a = parseInt(hex.substring(6, 8), 16);
  return { r, g, b, a };
}
```

### 9.3 Parseur de couleur hex 6–7 chars (format propriétaire boxsInfo)

```js
function parseCrealityHex(s) {
  // Format "#0RRGGBB" (7 chars avec leading 0) ou "#RRGGBB" (6 chars)
  let hex = (s || '').trim();
  if (hex.startsWith('#')) hex = hex.substring(1);
  if (hex.length === 7 && hex.startsWith('0')) hex = hex.substring(1); // drop leading "0"
  if (hex.length === 6) {
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return { r, g, b, a: 255 };
  }
  return null;
}
```

### 9.4 Source 2 — boxsInfo (protocole propriétaire Snapmaker)

Pour les imprimantes avec CFS (Color Filament System / multi-bobines) :

```js
function parseCfsBoxsInfo(boxsInfoPayload) {
  const result = {
    external: null,   // bobine externe (id=0)
    modules: [],      // modules CFS (id>=1, type=0)
  };

  const mbox = boxsInfoPayload?.materialBoxs;
  if (!Array.isArray(mbox)) return result;

  const moduleEntries = [];

  for (const e of mbox) {
    const id   = e.id;
    const type = e.type;
    const mats = e.materials || [];

    if (id === 0 && mats.length > 0) {
      // Bobine externe
      const m0 = mats[0];
      result.external = {
        color: parseCrealityHex(m0.color || '#000000'),
        materialType: m0.type || '',
        active: m0.state === 1,
      };
    } else if (type === 0 && mats.length > 0) {
      // Module CFS
      moduleEntries.push({ id, materials: mats });
    }
  }

  // Trier par id croissant
  moduleEntries.sort((a, b) => a.id - b.id);

  for (const entry of moduleEntries) {
    const slots = entry.materials.map((m, i) => ({
      boxId:        entry.id,
      slotId:       i,
      color:        parseCrealityHex(m.color || '#000000'),
      materialType: m.type || '',
      active:       m.state === 1,
    }));
    result.modules.push(slots);
  }

  return result;
}
```

---

## 10. Récupération de la miniature / aperçu du fichier

La miniature n'est **pas** disponible dans le flux WebSocket : elle s'obtient via deux appels HTTP REST sur le port **7125**.

### 10.1 Récupération des métadonnées

```
GET http://<IP>:7125/server/files/metadata?filename=<relative_filename>
```

Exemple :
```
GET http://192.168.1.42:7125/server/files/metadata?filename=benchy.gcode
```

Réponse (structure partielle) :
```json
{
  "result": {
    "filename": "benchy.gcode",
    "estimated_time": 3600.0,
    "thumbnails": [
      {
        "width": 32,
        "height": 32,
        "size": 1024,
        "relative_path": ".thumbnails/benchy-32x32.png"
      },
      {
        "width": 300,
        "height": 300,
        "size": 12345,
        "relative_path": ".thumbnails/benchy-300x300.png"
      }
    ]
  }
}
```

### 10.2 Sélection de la meilleure miniature

```js
function bestThumbnail(thumbnails) {
  // Critère : plus grande surface (w*h), fallback sur size
  let best = null;
  let bestScore = -1;
  for (const item of (thumbnails || [])) {
    const w = parseInt(item.width)  || 0;
    const h = parseInt(item.height) || 0;
    const size = parseInt(item.size) || 0;
    const score = (w > 0 && h > 0) ? (w * h) : size;
    if (score >= bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}
```

### 10.3 Construction de l'URL de la miniature

```js
function buildThumbnailUrl(ip, filename, metadata) {
  const thumb = bestThumbnail(metadata.thumbnails || metadata.result?.thumbnails);
  if (!thumb) return null;

  const rel = (thumb.relative_path || thumb.thumbnail_path || '').trim();
  if (!rel) return null;

  // Résoudre le chemin relatif par rapport au dossier parent du fichier
  const parentFolder = filename.substring(0, filename.lastIndexOf('/'));
  const resolved = normalizePath(`${parentFolder}/${rel}`);

  // Construire l'URL REST
  const segments = ['server', 'files', 'gcodes', ...resolved.split('/').filter(Boolean)];
  return `http://${ip}:7125/${segments.join('/')}`;
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}
```

### 10.4 Rescan forcé si miniature absente

Si les métadonnées ne contiennent pas `estimated_time` ou de `thumbnails`, déclencher un rescan :

```
POST http://<IP>:7125/server/files/metascan?filename=<relative_filename>
```

Puis ré-appeler `GET /server/files/metadata?filename=...`.

### 10.5 Exemple complet JS

```js
async function fetchPrintMetadata(ip, filename, timeout = 3000) {
  const fn = normalizePath(filename);
  if (!fn) return null;

  const baseUrl = `http://${ip}:7125`;

  async function getMetadata() {
    const url = `${baseUrl}/server/files/metadata?filename=${encodeURIComponent(fn)}`;
    const res = await fetchWithTimeout(url, timeout);
    if (!res.ok) return null;
    return await res.json();
  }

  let metadata = await getMetadata();

  // Rescan si metadata incomplète
  const hasTime   = metadata?.result?.estimated_time != null;
  const hasThumbs = Array.isArray(metadata?.result?.thumbnails) && metadata.result.thumbnails.length > 0;
  if (!hasTime || !hasThumbs) {
    await fetchWithTimeout(`${baseUrl}/server/files/metascan?filename=${encodeURIComponent(fn)}`, 4000, 'POST');
    metadata = await getMetadata();
  }

  return metadata?.result || null;
}
```

---

## 11. Flux caméra — URL, port, protocole

### 11.1 URL du flux caméra WebRTC

```
http://<IP>/webcam/webrtc
```

> **Attention** : port **80** (HTTP standard), pas 7125.  
> L'URL est une page HTML complète qui contient le player WebRTC, à charger dans une WebView.

Exemple :
```
http://192.168.1.42/webcam/webrtc
```

### 11.2 Notes d'implémentation

- Le protocole est **WebRTC** intégré dans une page web servie par le proxy Nginx embarqué de Moonraker.
- Dans l'app Flutter, cette URL est chargée dans une `WebView` (mode plein écran, `allowsInlineMediaPlayback: true`).
- Pour Electron, utiliser une `BrowserView` ou `<webview>` tag dans le renderer.
- La page doit avoir `allowMediaAccess: true` activé dans les préférences de la BrowserView.

### 11.3 Implémentation recommandée pour Electron/Node.js

```js
// Dans le main process
const { BrowserView } = require('electron');

function createCameraView(parentWindow, ip) {
  const view = new BrowserView({
    webPreferences: {
      allowRunningInsecureContent: true,
    }
  });
  parentWindow.addBrowserView(view);
  view.webContents.loadURL(`http://${ip}/webcam/webrtc`);
  return view;
}
```

---

## 12. Commandes de contrôle

Toutes les commandes de contrôle sont envoyées via G-Code (méthode `printer.gcode.script`).

### 12.1 Pause

```json
{
  "jsonrpc": "2.0",
  "method": "printer.print.pause",
  "params": {},
  "id": 300
}
```

Ou via G-Code :
```json
{
  "jsonrpc": "2.0",
  "method": "printer.gcode.script",
  "params": { "script": "PAUSE" },
  "id": 300
}
```

### 12.2 Reprise

```json
{
  "jsonrpc": "2.0",
  "method": "printer.print.resume",
  "params": {},
  "id": 301
}
```

Ou via G-Code :
```json
{
  "jsonrpc": "2.0",
  "method": "printer.gcode.script",
  "params": { "script": "RESUME" },
  "id": 301
}
```

### 12.3 Annulation

```json
{
  "jsonrpc": "2.0",
  "method": "printer.print.cancel",
  "params": {},
  "id": 302
}
```

### 12.4 Autohome

```json
{
  "method": "set",
  "params": { "autohome": "XYZ" }
}
```

> Utilise le protocole propriétaire (sans `jsonrpc`).

### 12.5 Configuration filament via G-Code

Voir §4.5. C'est la méthode principale pour pousser une configuration filament depuis TigerTag ou manuellement.

```json
{
  "jsonrpc": "2.0",
  "method": "printer.gcode.script",
  "params": {
    "script": "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=0 VENDOR=Generic FILAMENT_TYPE=PLA FILAMENT_SUBTYPE= FILAMENT_COLOR_RGBA=FF5500FF"
  },
  "id": 201
}
```

Après envoi, attendre 500ms puis ré-interroger `print_task_config` pour confirmer la mise à jour :

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.query",
  "params": { "objects": { "print_task_config": null } },
  "id": 911
}
```

### 12.6 Récapitulatif des commandes

| Action | Méthode | Protocole |
|--------|---------|-----------|
| Pause | `printer.print.pause` | JSON-RPC |
| Reprise | `printer.print.resume` | JSON-RPC |
| Annulation | `printer.print.cancel` | JSON-RPC |
| Autohome | `{"method":"set","params":{"autohome":"XYZ"}}` | Propriétaire |
| Push filament | `printer.gcode.script` + `SET_PRINT_FILAMENT_CONFIG` | JSON-RPC + G-Code |
| Modifier matériau CFS | `{"method":"set","params":{"modifyMaterial":{...}}}` | Propriétaire |
| Lire modules CFS | `{"method":"get","params":{"boxsInfo":1}}` | Propriétaire |

---

## 13. Découverte réseau (scan LAN)

### 13.1 Méthode

Le scanner interroge chaque IP du réseau LAN via **HTTP REST** (pas de broadcast UDP, pas de mDNS spécifique).

Port sondé : **7125** (Moonraker HTTP REST)

### 13.2 Endpoints REST sondés

Pour chaque IP candidate :

```
GET http://<IP>:7125/printer/info     (timeout 340ms)
GET http://<IP>:7125/server/info      (timeout 340ms)
```

### 13.3 Réponses attendues

**`/printer/info`** (exemple) :
```json
{
  "result": {
    "hostname":         "snapmaker-j1",
    "software_version": "v0.11.227",
    "klippy_state":     "ready",
    "machine_model":    "Snapmaker J1s"
  }
}
```

**`/server/info`** (exemple) :
```json
{
  "result": {
    "klippy_state":       "ready",
    "moonraker_version":  "v0.8.0",
    "api_version_string": "1.0.0"
  }
}
```

### 13.4 Extraction des champs de découverte

Le scanner applati les deux réponses (fusion des champs `result` dans un dictionnaire plat) et cherche :

| Champ final | Clés tentées dans l'ordre |
|-------------|--------------------------|
| `hostName` | `hostname`, `host_name`, `device_name`, `name` |
| `machineModel` | `machine_model`, `machineModel`, `model`, `printer_model` |
| `softwareVersion` | `software_version`, `softwareVersion`, `version` |
| `klippyState` | `klippy_state`, `state` |
| `moonrakerVersion` | `moonraker_version`, `moonrakerVersion` |
| `apiVersion` | `api_version_string`, `api_version`, `apiVersion` |

Un candidat n'est valide que si **au moins un** de ces champs est non vide.

### 13.5 Génération des IPs à scanner

```js
// Sous-réseaux communs toujours inclus
const defaultSubnets = ['192.168.1', '192.168.40'];

// + sous-réseau de l'interface WiFi locale
// + sous-réseaux des imprimantes déjà connues

// Pour chaque sous-réseau → IPs .1 à .254
// Taille de batch : 24 IPs en parallèle
// Tri final par qualityScore décroissant (plus d'infos = meilleur score)
```

### 13.6 Score de qualité d'un candidat

```js
function qualityScore(candidate) {
  let score = 0;
  if (candidate.hostName)        score += 4;
  if (candidate.machineModel)    score += 4;
  if (candidate.softwareVersion) score += 2;
  if (candidate.klippyState)     score += 1;
  if (candidate.moonrakerVersion) score += 1;
  if (candidate.apiVersion)      score += 1;
  return score;
}
```

### 13.7 Label d'affichage d'un candidat

```js
function displayName(candidate) {
  if (candidate.machineModel) return candidate.machineModel.trim();
  if (candidate.hostName)     return candidate.hostName.trim();
  return candidate.ip;
}
```

### 13.8 Implémentation Node.js complète

```js
const http = require('http');

async function probeSnapmakerIp(ip, timeoutMs = 400) {
  async function getJson(path) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: ip, port: 7125, path, timeout: timeoutMs },
        (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const inner = parsed.result || parsed;
              resolve(inner);
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  const [printerInfo, serverInfo] = await Promise.all([
    getJson('/printer/info'),
    getJson('/server/info'),
  ]);

  if (!printerInfo && !serverInfo) return null;

  const combined = { ...(serverInfo || {}), ...(printerInfo || {}) };

  function firstStr(...keys) {
    for (const k of keys) {
      const v = (combined[k] || '').toString().trim();
      if (v && v !== 'null') return v;
    }
    return null;
  }

  const hostName        = firstStr('hostname', 'host_name', 'device_name', 'name');
  const machineModel    = firstStr('machine_model', 'machineModel', 'model', 'printer_model');
  const softwareVersion = firstStr('software_version', 'softwareVersion', 'version');
  const klippyState     = firstStr('klippy_state', 'state');
  const moonrakerVersion = firstStr('moonraker_version', 'moonrakerVersion');
  const apiVersion      = firstStr('api_version_string', 'api_version', 'apiVersion');

  const hasIdentity = [hostName, machineModel, softwareVersion, klippyState, moonrakerVersion, apiVersion]
    .some(v => v);

  if (!hasIdentity) return null;

  return { ip, hostName, machineModel, softwareVersion, klippyState, moonrakerVersion, apiVersion, raw: combined };
}
```

---

## 14. Gestion des erreurs

### 14.1 Erreurs WebSocket

| Situation | Comportement |
|-----------|-------------|
| Connexion échouée | Marquer `connected = false`, `connecting = false`, logguer l'erreur |
| Déconnexion (socket closed) | Même traitement, déclencher reconnexion au retour au premier plan |
| Message non-JSON | Logguer en brut, ignorer pour le traitement logique |
| Payload JSON invalide (non-objet) | Ignorer silencieusement |

### 14.2 Reconnexion automatique

```js
// Logique de reconnexion au retour de l'app (foreground)
function attemptReconnectAfterResume(printers) {
  // Délai de 300ms pour laisser le réseau se rétablir
  setTimeout(() => {
    for (const printer of printers) {
      if (!printer.connected && !printer.connecting && printer.ip) {
        connectPrinter(printer);
      }
    }
  }, 300);
}
```

### 14.3 Règle d'envoi : JSON uniquement

```js
function sendRaw(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    JSON.parse(payload); // validation
    ws.send(payload);
  } catch {
    console.warn('[snapmaker] Ignored non-JSON payload');
  }
}
```

### 14.4 Timeout HTTP REST (métadonnées / miniatures)

- `GET /server/files/metadata` : **3 secondes**
- `POST /server/files/metascan` : **4 secondes**
- Scan LAN par IP : **340ms** (mode scan), **400ms** (probe direct)

### 14.5 Réponse d'erreur JSON-RPC

```json
{
  "jsonrpc": "2.0",
  "id": 201,
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

Codes d'erreur standard JSON-RPC :
- `-32700` : erreur de parsing
- `-32600` : requête invalide
- `-32601` : méthode introuvable
- `-32602` : paramètres invalides
- `-32603` : erreur interne

---

## 15. Checklist d'implémentation

### Phase 1 — Découverte

- [ ] Implémenter le scan LAN (port 7125, batch de 24 IPs, timeout 340ms)
- [ ] Sonder `/printer/info` et `/server/info` en parallèle
- [ ] Extraire les champs d'identification selon la table §13.4
- [ ] Calculer le qualityScore et trier les résultats
- [ ] Permettre l'ajout manuel par IP avec sonde directe

### Phase 2 — Connexion WebSocket

- [ ] Se connecter à `ws://<IP>:7125/websocket`
- [ ] Envoyer le subscribe (§3 Étape ①) dès l'ouverture
- [ ] Envoyer le query initial (§3 Étape ②) juste après
- [ ] Écouter `notify_status_update` et `notify_status_changed`
- [ ] Appliquer `mergeSnapStatusPayload` sur chaque mise à jour

### Phase 3 — Données d'impression

- [ ] Extraire `print_stats.state` et mapper selon §7
- [ ] Extraire le nom de fichier selon §6.2
- [ ] Calculer la progression selon la priorité §6.1
- [ ] Extraire `current_layer` / `total_layer` depuis `print_stats.info`
- [ ] Afficher `print_duration` formaté en HHhMMmin

### Phase 4 — Températures

- [ ] Fusionner les températures via `mergeLiveTemps` (§8.2)
- [ ] Afficher 4 extrudeurs + plateau avec format `current / target°C`

### Phase 5 — Filament

- [ ] Extraire les 4 slots depuis `print_task_config` (§9.1)
- [ ] Parser les couleurs RGBA 8 chars (§9.2)
- [ ] Interroger `boxsInfo` pour le CFS multi-bobines (§9.4)
- [ ] Parser les couleurs hex 6/7 chars du CFS (§9.3)

### Phase 6 — Miniature

- [ ] Appeler `GET /server/files/metadata?filename=...` (timeout 3s)
- [ ] Sélectionner la meilleure miniature par surface (§10.2)
- [ ] Construire l'URL de miniature (§10.3)
- [ ] Déclencher rescan si miniature absente (§10.4)

### Phase 7 — Caméra

- [ ] Construire l'URL `http://<IP>/webcam/webrtc`
- [ ] Charger dans une WebView/BrowserView avec accès média activé
- [ ] Permettre l'affichage en plein écran sur tap

### Phase 8 — Commandes

- [ ] Implémenter Pause / Reprise / Annulation
- [ ] Implémenter la push de configuration filament via `SET_PRINT_FILAMENT_CONFIG`
- [ ] Rafraîchir `print_task_config` 500ms après chaque push filament
- [ ] Valider que tout payload envoyé est du JSON valide

### Phase 9 — Persistance et sync

- [ ] Persister la config imprimante (ip, name, modelId) dans localStorage
- [ ] Synchroniser avec Firestore `users/{uid}/printers/snapmaker/devices`
- [ ] Merge hybride local/cloud avec priorité au `updatedAt` le plus récent
- [ ] Reconnecter automatiquement toutes les imprimantes au démarrage (décalage 150ms entre chaque)

---

*Fin du document de protocole Snapmaker (Moonraker). Dernière mise à jour : 2026-05-10.*
