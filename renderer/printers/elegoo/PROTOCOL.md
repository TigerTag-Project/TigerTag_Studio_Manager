# Elegoo MQTT — Agent Skill

> **Navigation agent** — `Read limit=140` pour le QUICK-REF complet (ci-dessous, lignes 1–140). Pour un §detail : `grep -n "^## N\." PROTOCOL.md` → `Read offset=N limit=80`. Ne jamais lire le fichier entier.

---

## QUICK-REF ─── tout en une lecture ───────────────────────────────────

### Connexion
```
MQTT TCP plain  192.168.x.x:1883
user / pass     elegoo / Q2CQoJ  (ou Access Code custom)
clientId        TTG_XXXX  (préfixe TTG_ + rand 1000-9999)
requestId       TTG_XXXX_req
SN              obligatoire · topics sans SN = silence
```

### Topics
```
SUB  elegoo/{sn}/#                        tout le trafic
PUB  elegoo/{sn}/api_register             1 seule fois à la connexion
PUB  elegoo/{sn}/{cid}/api_request        toutes les commandes
```
Réponses unicast → `elegoo/{sn}/{cid}/api_response`  
Push broadcast → `elegoo/{sn}/api_status` (method 6000 continu)

### Toutes les méthodes

| Method | Fonction | Params clés | §detail |
|--------|----------|-------------|---------|
| 1001 | Infos imprimante | `{}` | §5 |
| 1002 | Snapshot complet (temps/fans/axes/status) | `{}` | §5 |
| 1003 | machine_status seul | `{}` | §5 |
| 1004 | État ventilateurs | `{}` | §5 |
| **1005** | Statut impression (current_layer, state, uuid) | `{}` | §21 |
| 1020 | **Démarrer impression** | `{filename, storage_media, config:{bedlevel_force, delay_video, print_layout, printer_check, slot_map}}` | §15 |
| **1021** | **Pause** | `{}` | §15 |
| **1022** | **Annuler (cancel)** | `{}` | §15 |
| **1023** | **Reprendre (resume)** | `{}` | §15 |
| 1026 | Homing | `{homed_axes:"xyz"}` | §16 |
| 1027 | Jog relatif | `{axes:"z", distance:-1}` | §16 |
| **1028** | **Set temp** | `{extruder:N}` OU `{heater_bed:N}` — 1 champ/commande | §19 |
| 1029 | LED | `{power:0\|1}` | §17 |
| 1030 | Ventilateurs | `{fan\|aux_fan\|box_fan: 0-255}` | §17 |
| 1031 | Vitesse / timelapse (ambigu) | `{mode:0-3}` | §17 |
| **1036** | Historique impressions | `{}` | §22 |
| **1042** | **URL caméra MJPEG** | `{}` → `result.url` | §12 |
| **1051** | **Timelapse URL resolver** | `{url:"picture/…"}` → `result.url = "video/….mp4"` | §23 |
| 1043 | Enregistrer hostname client | `{hostname:"…"}` | §4 |
| **1044** | **Liste fichiers** | `{}` | §10 |
| **1045** | **Thumbnail** (base64 PNG) | `{filename:"…"}` | §9 |
| 1046 | Infos fichier (layers, size, color_map) | `{filename:"…"}` | §4 |
| 1047 | **Supprimer fichier** | `{storage_media:"local", file_path:["name.gcode"]}` | §10 |
| 1055 | Écrire filament mono | `{filament_type, filament_code, filament_name, …}` | §11 |
| 1061 | Lire filament mono | `{}` | §11 |
| **2001** | Canvas Load filament | `{canvas_id:0, tray_id:N}` ← bloquant ~120s | §20 |
| **2002** | Canvas Unload filament | `{canvas_id:0, tray_id:N}` ← bloquant ~33s | §20 |
| 2003 | Canvas write filament | `{filament_type, filament_code, …}` | §11 |
| **2004** | Canvas auto-refill (avant 1020) | `{auto_refill:true}` | §15 |
| **2005** | Canvas read état + slots | `{}` | §8 |
| 6000 | Push live api_status (broadcast) | — push entrant | §6 |
| 6008 | Push connexion autre client | — push entrant | §6 |
| 7000 | UDP discovery probe | UDP port 52700 | §13 |

### sub_status (machine_status.sub_status dans 6000)

| Code | Phase | UI |
|------|-------|----|
| `0` | idle | standby |
| `1066` `2075` | printing actif | printing |
| `1045` | changement couleur Canvas | printing |
| `1150`-`1157` | séquences de couche / finish | printing |
| `1405` | init impression | preparing |
| `2401` `2402` | resuming (debut/fin) | printing |
| `2501` `2502` | pausing (debut/confirmé) | paused |
| `2503` `2504` | stopping (debut/fin) | standby |
| `2801` `2802` | bed leveling | heating |
| `2901` `2902` | chauffe | heating |
| `3000` `3001` | upload gcode HTTP — **ignorer** < 2s | — |
| `3020` `3021` | téléchargement timelapse (début/fin) — status=12 | — |

### print_status.state

| Valeur | UI |
|--------|-----|
| `"printing"` `"running"` `"busy"` | Impression active |
| `"paused"` | En pause |
| `"preparing"` `"heating"` | Chauffe / init |
| `"complete"` `"completed"` | Terminé |
| `"cancelled"` `"canceled"` | Annulé |
| `""` ← chaîne vide | standby / veille |

### Séquences critiques (compact)

```
INIT      api_register → 1043{hostname} → 1002{} → 6000 subscribe

START     [2004{auto_refill:true} si Canvas]
          → 1020{filename, storage_media:"local",
                 config:{bedlevel_force:false, delay_video:true,
                         print_layout:"A", printer_check:true,
                         slot_map:[{canvas_id:0, t:0, tray_id:0}]}}
          → 6000: uuid + state="printing"
          → poll 1005{} toutes 10s pour current_layer

PAUSE     1021{} → sub 2501 → state="paused" → sub 2502 → response(~4s)
RESUME    1023{} → sub 2401 → sub 2402 → state="printing" → response
CANCEL    1022{} → sub 2503→2504 → state="cancelled" → response(~9s)
          → 1031{mode:1} (timelapse?) → 1036{} (historique)

TEMP      1028{extruder:N}   ou   1028{heater_bed:N}   (1 champ/cmd)
CAMERA    1042{} → result.url → <img src=url> (MJPEG, pas d'auth)
TIMELAPSE 1036{} → time_lapse_video_url="video/….mp4" (status=2) → HTTP GET http://{ip}:8080/{url}
          → 6000: status=12/sub=3020 (dl) → sub=3021 (done) → status=1/sub=0
          (1051 inutile — l'URL video/ est déjà dans 1036)
UPLOAD    HTTP POST → 6000: sub_status 3000→3001→0 (ignorer)
DELETE    1047{storage_media:"local", file_path:["file.gcode"]}
```

### Codes error_code

| Code | Signification |
|------|---------------|
| `0` | Succès |
| `1003` | Thumbnail absent / Canvas non connecté |
| `1010` | Timelapse non disponible |

### Index sections (grep `^## N\.`)

```
§1  Connexion MQTT     §9  Thumbnail 1045      §17 LED/fans/speed
§2  Topics             §10 Fichiers 1044/1047  §18 Méthodes inconnues
§3  Séq. init slicer   §11 Écriture filament   §19 Températures 1028
§4  Rafale init burst  §12 Caméra 1042         §20 Canvas Load/Unload
§5  Méthodes poll      §13 Découverte UDP       §21 Statut 1005
§6  Push 6000          §14 Erreurs             §22 Historique 1036
§7  États impression   §15 Print 1020-1023     §23 Checklist implémentation
§8  Canvas 2005        §16 Axes 1026/1027      §23 Timelapse 1051 + HTTP DL
```

─────────────────────────────────────────────────────────────────────────

**Rôle de ce document** : référence autonome (live-sniffé sur Centauri Carbon 2, firmware 01.03.02.51) pour implémenter l'intégration Elegoo dans Tiger Studio sans le source Flutter.

---

## 1. Paramètres de connexion

| Paramètre | Valeur |
|---|---|
| Transport | MQTT plain TCP (pas de TLS) |
| Port | **1883** |
| Username | `"elegoo"` (fixe pour tous les modèles) |
| Password | `"123456"` par défaut — peut être surchargé par l'utilisateur ("Access Code") |
| keepAlive | 60 s |
| clientId | `"TTG_XXXX"` — préfixe `TTG_` + 4 chiffres aléatoires (1000–9999) |
| requestId | `"${clientId}_req"` — utilisé comme suffixe dans le topic register_response |
| SN requis | Oui — le numéro de série est obligatoire avant toute connexion |

Génération du clientId (JS) :
```js
const clientId = `TTG_${Math.floor(1000 + Math.random() * 9000)}`;
const requestId = `${clientId}_req`;
```

---

## 2. Structure des topics

Toutes les variables :
- `{sn}` = serial number de l'imprimante
- `{cid}` = clientId généré (`TTG_XXXX`)
- `{rid}` = requestId (`TTG_XXXX_req`)

### Subscribe (à l'ouverture de connexion)

| Topic | Rôle |
|---|---|
| `elegoo/{sn}/api_status` | **Push live** — broadcaster vers tous les clients ; méthode 6000 en continu |
| `elegoo/{sn}/{cid}/api_response` | **Réponses unicast** — réponses aux commandes envoyées par ce client |
| `elegoo/{sn}/{rid}/register_response` | **Ack registration** — observé live : topic = `{sn}/{requestId}/register_response` (ex. `F01PLJ.../TTG_1234_reg/register_response`) |

### Publish (commandes vers l'imprimante)

| Topic | Rôle |
|---|---|
| `elegoo/{sn}/api_register` | Envoyer la demande d'enregistrement |
| `elegoo/{sn}/{cid}/api_request` | Envoyer toutes les commandes/requêtes |

---

## 3. Séquence d'initialisation

> **Observée live par sniffer MQTT** — le slicer Elegoo officiel utilise deux clients distincts.
> Tiger Studio n'en utilise qu'un seul (plus simple, suffisant).

### Séquence du slicer Elegoo (référence ISO, observée live)

Le slicer ouvre **deux connexions MQTT simultanées** :

**Client 1 — contrôle imprimante** (client_id = `"1_PC_4447"`, PING toutes les ~10 s)
```
PUB elegoo/{sn}/api_register  {"client_id":"1_PC_4447","request_id":"1_PC_4447_req"}
SUB elegoo/{sn}/1_PC_4447_req/register_response  → {"client_id":"1_PC_4447","error":"ok"}

PUB method:1043  {"hostname":"Elegoo Centauri Carbon 2"}   ← PREMIÈRE commande obligatoire
PUB method:1002  {}
PUB method:1001  {}
```

**Client 2 — fichiers + filaments** (client_id = `"0cli7ebbb5"`, PING toutes les ~45 s)
```
PUB elegoo/{sn}/api_register  {"request_id":"0cli7ebbb5","client_id":"0cli7ebbb5"}
                                ↑ request_id == client_id (format différent du client 1)
SUB elegoo/{sn}/0cli7ebbb5/register_response  → {"client_id":"0cli7ebbb5","error":"ok"}

PUB method:1036  {}                                      ← historique
PUB method:2005  {}                                      ← canvas filaments
PUB method:1044  {"storage_media":"local","offset":0,"limit":20}
PUB method:1002  {}
PUB method:1044  {"storage_media":"u-disk","dir":"/","offset":0,"limit":20}
PUB method:1001  {}
PUB method:1042  {}                                      ← URL caméra
PUB method:1061  {}                                      ← mono filament
```

### Séquence Tiger Studio (client unique)

```
1. Créer clientId + requestId
   clientId  = "TTG_XXXX"  (4 chiffres aléatoires)
   requestId = "TTG_XXXX_req"

2. Connecter MQTT (host, port 1883, user="elegoo", password, keepAlive=60s)

3. SUB elegoo/{sn}/api_status
   SUB elegoo/{sn}/{cid}/api_response
   SUB elegoo/{sn}/{cid}_req/register_response
   SUB elegoo/{sn}/{rid}/register_response

4. PUB elegoo/{sn}/api_register
   { "client_id": "{cid}", "request_id": "{rid}" }

5. Sur register_response OU timeout 1200 ms → envoyer la rafale initiale (§4)
   (La rafale ne s'envoie qu'une fois par connexion — guard _initSnapshotSent)

6. PING/PONG toutes les 10 s (voir §11 Règles communes)
```

**Register_response observé live** (CC2, SN F01PLJ817DP6Y5Z) :

```
PUB  elegoo/F01PLJ.../api_register
     { "client_id": "TTG_1234", "request_id": "TTG_1234_req" }

SUB  elegoo/F01PLJ.../TTG_1234_req/register_response
     { "client_id": "TTG_1234", "error": "ok" }
```

`"error": "ok"` signifie succès (champ nommé de manière contre-intuitive). Toute valeur différente de `"ok"` indique un refus.

---

## 4. Rafale d'initialisation (snapshot burst)

> **⚠️ Attention** : les IDs de méthodes du document Flutter source ne correspondent pas
> au firmware Centauri Carbon 2 (testé en live). Tableau corrigé ci-dessous.
> **Ordre calé sur le slicer Elegoo officiel** — observé live par sniffer MQTT.

Envoyer dans l'ordre, avec **50 ms de délai entre chaque** :

| Ordre | Method | Params | Rôle réel (vérifié live) |
|---|---|---|---|
| 1 | `1043` | `{"hostname":"TigerTag Studio"}` | **Obligatoire en premier** — annonce l'identité du client ; le slicer l'envoie toujours avant toute autre commande |
| 2 | `1002` | `{}` | Status complet : extruder/bed/chamber temp + targets + fans + print_status + machine_status (§5.1) |
| 3 | `1005` | `{}` | print_status seul (state, filename, uuid, current_layer, remaining_time_sec) (§5.2) |
| 4 | `2005` | `{}` | Filament canvas 4-slots — ou vide si Canvas déconnecté (§8) |
| 5 | `1061` | `{}` | Filament mono-extruder — fallback quand Canvas absent (§8.2) |
| 6 | `1042` | `{}` | URL caméra dynamique → `{"url":"http://{ip}:8080/?action=stream"}` (§12) |
| 7 | `1001` | `{}` | Info machine : hostname, ip, sn, firmware (§4.1) |
| 8 | `1044` | `{"storage_media":"local","offset":0,"limit":50}` | Liste fichiers + total layers (§10) |

### 4.1 Method 1001 — Machine info

**Payload response** (observé live CC2) :
```json
{
  "id": 6,
  "method": 1001,
  "result": {
    "error_code": 0,
    "hardware_version": "",
    "hostname": "Elegoo Centauri Carbon 2",
    "ip": "192.168.40.113",
    "machine_model": "Centauri Carbon 2",
    "protocol_version": "1.0.0",
    "sn": "F01PLJ817DP6Y5Z",
    "software_version": {
      "mcu_version": "00.00.00.00",
      "ota_version": "01.03.02.51",
      "soc_version": ""
    }
  }
}
```

Utile pour afficher la version firmware (`ota_version`) et confirmer le modèle.

### 4.2 Method 1043 — Set hostname

Annonce l'identité du client à l'imprimante. Le slicer l'envoie **en premier**, avant toute autre requête.

```json
{ "id": 1, "method": 1043, "params": { "hostname": "TigerTag Studio" } }
```

Réponse : `{"error_code": 0}`. L'imprimante connaît désormais le nom du client connecté.

### 4.3 Autres méthodes connues

| Method | Retour réel observé |
|---|---|
| `1003` | machine_status seul (progress, status, sub_status) |
| `1004` | État des ventilateurs |
| `1020` | Démarrer une impression — voir §15 |
| `1021` | Pause impression — voir §15.2 |
| `1022` | Annuler impression — voir §15.4 |
| `1023` | Reprendre impression (resume) — voir §15.3 |
| `1005` | Statut impression temps réel (current_layer, state, uuid…) — voir §21 |
| `1024` | Inconnu — appelé lors de l'inspection/édition filament — voir §18 |
| `1025` | Inconnu — appelé lors de l'inspection/édition filament — voir §18 |
| `1026` | Homing axes — voir §16 |
| `1027` | Jog axes — voir §16 |
| `1029` | Contrôle LED — voir §17 |
| `1030` | Contrôle ventilateurs — voir §17 |
| `1031` | Mode vitesse / timelapse (ambigu) — voir §17 |
| `1036` | Historique des tâches d'impression (30 dernières) — voir §22 |
| `1046` | Métadonnées d'un fichier individuel (color_map, layers, size…) — voir §4.5 |

### 4.4 Method 1036 — Historique

Retourne les 30 dernières tâches d'impression. Chaque entrée :
```json
{
  "task_id":    "2250ae9f-04fb-4057-...",
  "task_name":  "ECC2_0.4_Hook_Elegoo PLA Matte_0.2_39m3s.gcode",
  "task_status": 1,
  "begin_time": 1771806960,
  "end_time":   1771810040,
  "time_lapse_video_url": "picture/ECC2_0.4_Hook...gcode20260223083602"
}
```
`task_status` : `1` = succès, `2` = annulé/échoué.

### 4.5 Method 1046 — Métadonnées fichier individuel

Retourne les détails d'un seul fichier (sans télécharger le gcode).

**Request** :
```json
{
  "id": 15,
  "method": 1046,
  "params": {
    "storage_media": "u-disk",
    "filename": "/3.Model/7.Scraper/ECC2_0.4_Scraper_Elegoo PLA _0.2_1h22m.gcode"
  }
}
```

**Response** :
```json
{
  "id": 15,
  "method": 1046,
  "result": {
    "error_code": 0,
    "color_map": [
      {"color": "#000000", "name": "PLA", "t": 0},
      {"color": "#FFFFFF", "name": "PLA", "t": 1}
    ],
    "create_time": 1760665590,
    "filename": "ECC2_0.4_Scraper_Elegoo PLA _0.2_1h22m.gcode",
    "layer": 225,
    "print_time": 4942,
    "size": 6003025,
    "total_filament_used": 42.11
  }
}
```

Enveloppe d'une requête :
```json
{ "id": <int incrémental>, "method": <int>, "params": {} }
```

**Polling périodique recommandé :** re-demander method `1005` toutes les **10 s**
car le push 6000 n'envoie jamais print_status — seulement les températures.

---

## 5. Méthodes de poll — Payloads live observés

### 5.1 Method 1002 — Snapshot complet (CC2, imprimante idle)

> Observé live sur Centauri Carbon 2 (SN F01PLJ817DP6Y5Z, firmware production).

```json
{
  "id": 3,
  "method": 1002,
  "result": {
    "error_code": 0,
    "external_device": {
      "camera": true,
      "type": "0",
      "u_disk": true
    },
    "extruder": {
      "filament_detect_enable": 1,
      "filament_detected": 0,
      "target": 0,
      "temperature": 28
    },
    "fans": {
      "aux_fan":        { "speed": 0.0 },
      "box_fan":        { "speed": 0.0 },
      "controller_fan": { "speed": 0.0 },
      "fan":            { "speed": 0.0 },
      "heater_fan":     { "speed": 0.0 }
    },
    "gcode_move": {
      "extruder":   0.0,
      "speed":      1500,
      "speed_mode": 1,
      "x": 5.0,
      "y": 5.0,
      "z": 0.122114
    },
    "heater_bed": { "target": 0, "temperature": 23 },
    "led":        { "status": 1 },
    "machine_status": {
      "exception_status": [],
      "progress": 0,
      "status": 1,
      "sub_status": 0,
      "sub_status_reason_code": 0
    },
    "print_status": {
      "bed_mesh_detect":   false,
      "current_layer":     0,
      "enable":            false,
      "filament_detect":   false,
      "filename":          "",
      "print_duration":    0,
      "remaining_time_sec": 0,
      "state":             "",
      "total_duration":    0,
      "uuid":              ""
    },
    "tool_head": { "homed_axes": "" },
    "ztemperature_sensor": {
      "measured_max_temperature": 0,
      "measured_min_temperature": 0,
      "temperature": 24
    }
  }
}
```

**Champs notables** :
- `external_device.camera` — `true` si caméra connectée ; `type:"0"` = USB cam
- `external_device.u_disk` — `true` si clé USB insérée
- `extruder.filament_detect_enable` / `filament_detected` — détection filament (`0` = absent)
- `gcode_move.speed_mode` — `1` = normal, `2` = silencieux, `3` = sport (hypothèse)
- `led.status` — `1` = LED allumée
- `tool_head.homed_axes` — `"xyz"` si homé, `""` si pas encore homé
- `ztemperature_sensor.measured_max/min_temperature` — extremes chambre historiques

### 5.2 Method 1005 — print_status seul (CC2, imprimante idle)

```json
{
  "id": 84,
  "method": 1005,
  "result": {
    "error_code": 0,
    "print_status": {
      "bed_mesh_detect":    false,
      "current_layer":      0,
      "enable":             false,
      "filament_detect":    false,
      "filename":           "",
      "print_duration":     0,
      "remaining_time_sec": 0,
      "state":              "",
      "total_duration":     0,
      "uuid":               ""
    }
  }
}
```

`print_status.enable` vaut `false` quand aucune impression n'est en cours.  
`print_status.state = ""` → mapper vers `"standby"` (voir §7.1).

---

## 6. Method 6000 — Push live `api_status`

Le push principal. L'imprimante l'envoie en continu sur `elegoo/{sn}/api_status`.

> **⚠️ Comportement réel (vérifié live)** : le push 6000 n'envoie que les champs
> dont la valeur **vient de changer**. En pratique : uniquement les températures
> (`extruder.temperature`, `heater_bed.temperature`). Les champs `print_status`,
> `machine_status.progress`, et `ztemperature_sensor` ne sont jamais poussés.
> Utiliser method `1005` (poll 10 s) pour print_status et method `1002` pour le snapshot complet.

### Payload observé en idle (imprimante en veille)

```json
{ "id": 4217, "method": 6000, "result": { "heater_bed": { "temperature": 24 } } }
```

En idle, seule la température du plateau est poussée (toutes les secondes). L'extrudeur à température ambiante n'est pas inclus quand sa valeur est stable.

### Payload observé (pendant une impression active)

```json
{
  "id": 1087,
  "method": 6000,
  "result": {
    "extruder":       { "temperature": 210 },
    "gcode_move":     { "extruder": 1.26, "speed": 7474, "x": 122.1, "y": 138.3, "z": 9.0 },
    "machine_status": { "progress": 27 },
    "print_status":   {
      "current_layer": 45,
      "print_duration": 472,
      "remaining_time_sec": 1166,
      "total_duration": 529
    }
  }
}
```

> **Correction par rapport à la doc Flutter** : le push 6000 envoie bien plus que les températures.
> Il pousse `machine_status.progress` (progression %), `print_status.current_layer`,
> `remaining_time_sec`, `total_duration` et `gcode_move.*` à chaque seconde.
> Ce qui n'est **jamais** dans le push 6000 : `print_status.state`, `print_status.uuid`,
> `print_status.filename`, `heater_bed` (quand le bed est à température stable).

### Push filament — changement depuis l'écran tactile

**Observé live** : quand l'utilisateur change le filament depuis l'écran de l'imprimante (sans passer par le slicer), l'imprimante pousse immédiatement un message 6000 via `api_status` contenant `mono_filament_info` :

```json
{
  "id": 3083,
  "method": 6000,
  "result": {
    "mono_filament_info": {
      "filament_code":  "0x0A00",
      "filament_color": "#A03BF7",
      "filament_name":  "EVA",
      "filament_type":  "EVA",
      "max_nozzle_temp": 220,
      "min_nozzle_temp": 220
    }
  }
}
```

→ Traiter ce cas dans le handler `api_status` : si `result.mono_filament_info` est présent, appeler `_mergeMonoFilament` en plus de `_mergeStatus`.  
→ De même pour `result.canvas_info` si le Canvas est connecté et que l'utilisateur change un slot depuis l'écran.

### Champs poussés par method 6000 (observés en live)

Le push 6000 n'envoie que les champs dont la valeur vient de changer. Les champs absents conservent leur dernière valeur connue.

| Chemin JSON | Clé interne | Fréquence |
|---|---|---|
| `result.extruder.temperature` | `nozzleTemp` | À chaque changement °C |
| `result.heater_bed.temperature` | `bedTemp` | À chaque changement °C (absent quand stable) |
| `result.ztemperature_sensor.temperature` | `chamberTemp` | À chaque changement °C |
| `result.machine_status.progress` | `printProgress` (÷100) | **Quand le % change** — toutes les ~15–17 s en pratique |
| `result.print_status.current_layer` | `printLayerCur` | **Quand la couche change** uniquement |
| `result.print_status.remaining_time_sec` | `printRemainingMs` (×1000) | La plupart des pushes (absent si inchangé) |
| `result.print_status.total_duration` | `printDuration` | La plupart des pushes |
| `result.print_status.print_duration` | *(non stocké)* | Durée écoulée (s) |
| `result.gcode_move.x/y/z` | *(non stocké)* | Position tête mm (présent quand change) |
| `result.gcode_move.speed` | *(non stocké)* | Vitesse mm/min (présent quand change) |
| `result.gcode_move.extruder` | *(non stocké)* | Position extrudeur mm |

> **Correction** : `print_status.state`, `print_status.uuid` et `print_status.filename` **sont** poussés par 6000 au démarrage d'une impression (transition d'état). En cours d'impression, seuls les champs qui changent apparaissent (progress, layer, remaining). Ne jamais les considérer comme "absents définitivement" — les mettre en cache à la première réception.
> `machine_status.progress` est le seul champ progress disponible — `print_status.progress` n'existe pas.

### Champs disponibles seulement via poll (method 1002 / 1005)

| Chemin JSON (method 1002 result) | Clé interne |
|---|---|
| `result.extruder.temperature` / `.target` | `nozzleTemp` |
| `result.heater_bed.temperature` / `.target` | `bedTemp` |
| `result.ztemperature_sensor.temperature` | `chamberTemp` |
| `result.print_status.state` | `printState` |
| `result.print_status.current_layer` | `printLayerCur` |
| `result.print_status.remaining_time_sec` | `printRemainingMs` (×1000) |
| `result.print_status.total_duration` | `printDuration` (secondes) |
| `result.print_status.filename` | `printFilename` |
| `result.print_status.uuid` | `printUuid` |
| `result.machine_status.status` | *(derive printState — voir §7.2)* |
| `result.machine_status.sub_status` | *(derive printState — voir §7.2)* |
| `result.machine_status.progress` | `printProgress` (0–1) |
| `result.machine_status.exception_status` | `lastException` (tableau int) |
| `result.external_device.camera` | *(non stocké)* | `true` si caméra connectée |
| `result.extruder.filament_detected` | *(non stocké)* | `1` = filament présent |
| `result.extruder.target` | *(non stocké)* | Température cible buse (°C) |
| `result.heater_bed.target` | *(non stocké)* | Température cible plateau (°C) |
| `result.led.status` | *(non stocké)* | `1` = LED allumée |
| `result.tool_head.homed_axes` | *(non stocké)* | `"xyz"` si axes homés |
| `result.ztemperature_sensor.measured_max_temperature` | *(non stocké)* | Max chambre historique |

### 6.1 Champs additionnels poussés occasionnellement par 6000

Le push 6000 peut inclure d'autres champs lors de changements — tous ignorés sauf temperatures.
Documentés ici pour référence :

```json
{
  "result": {
    "extruder":            { "temperature": 210 },
    "heater_bed":          { "temperature": 60 },
    "ztemperature_sensor": { "temperature": 28 },
    "gcode_move":          { "extruder": 1.26, "speed": 7474, "x": 122.1, "y": 138.3, "z": 9.0 },
    "machine_status":      { "progress": 28 },
    "print_status": {
      "current_layer": 46,
      "print_duration": 491,
      "remaining_time_sec": 1149,
      "total_duration": 548
    }
  }
}
```

> Tous ces champs sont **optionnels** dans chaque push — seuls les champs qui ont changé sont inclus.
> Un push typique ne contient que 2–4 champs (ex. température + gcode_move + print_status partiel).

**Fans** — présents dans method 1002 ET poussés par 6000 quand la vitesse change :
```json
{
  "fans": {
    "aux_fan":        { "speed": 0.0   },
    "box_fan":        { "speed": 25.5  },
    "controller_fan": { "speed": 255.0 },
    "fan":            { "speed": 252.0 },
    "heater_fan":     { "speed": 255.0 }
  }
}
```
**LED** — également poussée par 6000 quand l'état change : `{"result":{"led":{"status":1}}}`

**Targets températures** — `extruder.target` et `heater_bed.target` sont poussés par 6000 au démarrage de la chauffe.

Ces champs sont **ignorés** dans l'implémentation actuelle — seules températures + progress + layer sont extraits.

### 6.2 Method 6008 — Notification nouvelle connexion (push `api_status`)

Émis sur `elegoo/{sn}/api_status` chaque fois qu'un client se connecte et envoie la commande `method 1043` (set hostname). Tous les abonnés reçoivent ce push.

```json
{ "id": 4978, "method": 6008, "result": { "hostname": "Elegoo Centauri Carbon 2" } }
{ "id": 4979, "method": 6008, "result": { "hostname": "TigerTag-Sniffer" } }
```

> Un seul push par client qui se connecte. Si deux clients se connectent en même temps, deux push 6008 arrivent en rafale.
> Utile pour savoir si le slicer officiel ou un autre client est actif sur l'imprimante — peut servir à afficher un avertissement de connexion multiple.

---

## 7. États d'impression

### 7.1 `print_status.state` (method 1002 / 1005)

> **⚠️ Observation critique (live)** : quand l'impression est terminée ou que l'imprimante est en veille,
> `print_status.state` vaut `""` (chaîne vide), **pas** `"standby"` ou `"idle"`.
> Toujours utiliser `'state' in ps` pour détecter la présence du champ, et mapper `""` → `"standby"`.

```js
// Code correct
if ('state' in ps) {
  const rawState = String(ps.state).toLowerCase().trim();
  d.printState = rawState || 'standby';   // '' → 'standby'
}
```

| Valeur `print_status.state` | Signification | UI |
|---|---|---|
| `"printing"` | Impression en cours | Barre de progression + spinner |
| `"running"` | Alias printing | Idem |
| `"busy"` | Alias actif | Idem |
| `"paused"` | En pause | Badge "Paused" |
| `"preparing"` | Préparation / chauffe | Spinner |
| `"heating"` | Phase de chauffe | Spinner |
| `"complete"` | Terminé | Masquer progress card |
| `"completed"` | Alias complete | Idem |
| `"cancelled"` / `"canceled"` | Annulé | Masquer progress card |
| `"standby"` / `""` | Inactif / veille (≈ even empty string) | Masquer progress card |
| `"error"` / `"failed"` | Erreur | Badge "Error" |

Regroupements utiles :
```js
const ELEGOO_ACTIVE  = ["printing","running","busy","preparing","heating"];
const ELEGOO_PAUSED  = ["paused"];
const ELEGOO_DONE    = ["complete","completed","cancelled","canceled","standby"];
```

### 7.2 `machine_status` — codes observés en live

Disponible via method 1002 et 1003. Utiliser en fallback quand `print_status.state` est absent.

**`machine_status.status`**

| Code | Signification | printState dérivé |
|------|--------------|------------------|
| `1`  | Standby / idle | `"standby"` |
| `2`  | Actif (impression / chauffe) | voir `sub_status` |
| `3`  | Séquence de fin (purge, nettoyage) | `"printing"` (encore actif) |
| `11` | Opération fichier en cours (upload reçu / traitement gcode) | ignorer — retour à `1` en < 2 s |
| `12` | Transfert fichier en cours (téléchargement timelapse MP4) | ignorer — retour à `1` après fin |
| `14` | Erreur / exception | `"error"` |

**`machine_status.sub_status`**

| Code | Phase | printState dérivé |
|------|-------|------------------|
| `0`    | Idle | `"standby"` |
| `1066` | Impression active (phase 1) | `"printing"` |
| `2075` | Impression active (phase 2 / vitesse variable) | `"printing"` |
| `1155` | Finishing | `"printing"` |
| `1156` | Purge / wipe | `"printing"` |
| `1157` | Nettoyage final | `"printing"` |
| `2901` | Phase de chauffe | `"heating"` |
| `1045` | Changement de couleur / outil en cours (Canvas auto-refill) | `"printing"` |
| `1405` | Initialisation démarrage impression (phase préparatoire) | `"preparing"` |
| `2801` | Bed leveling / mesh — phase de mesure | `"heating"` |
| `2802` | Bed leveling — mesure terminée | `"heating"` |
| `2902` | Phase de chauffe secondaire (outil suivant) | `"heating"` |
| `2401` | Reprise en cours — début (après method 1023) | `"printing"` |
| `2402` | Reprise effectuée | `"printing"` |
| `2501` | Mise en pause en cours (après method 1021) | `"paused"` |
| `2502` | Pause confirmée (extrudeur arrêté) | `"paused"` |
| `2503` | Annulation en cours (après method 1022) | `"standby"` |
| `2504` | Annulation terminée, retour idle en cours | `"standby"` |
| `3000` | Fichier reçu (HTTP upload) — début traitement | ignorer (transitoire) |
| `3001` | Fichier en cours de traitement (parse gcode metadata) | ignorer (transitoire) |
| `3020` | Téléchargement timelapse en cours (status=12) | ignorer (transitoire) |
| `3021` | Téléchargement timelapse terminé — retour idle immédiat | ignorer (transitoire) |

> **Note** : plusieurs codes `sub_status` correspondent à "impression active" (1066, 2075…).
> Ne pas tester l'égalité exacte pour détecter une impression — utiliser `machine_status.status === 2`.
> `sub_status_reason_code` est toujours `0` dans les observations.
>
> **`status=11` + `sub_status=3000/3001`** : séquence transitoire après upload HTTP d'un gcode. Durée < 2 s. Ne pas mapper vers un état d'impression — ignorer et attendre le retour à `status=1, sub_status=0`.

**Champs complets de `machine_status` (method 1002)**

```json
{
  "machine_status": {
    "exception_status": [],
    "progress": 35,
    "status": 2,
    "sub_status": 2075,
    "sub_status_reason_code": 0
  }
}
```

**`machine_status.exception_status`** — tableau d'entiers, vide en temps normal.

| Code observé | Situation |
|---|---|
| `[803]` | Erreur pendant l'impression (possiblement détection filament) |

### 7.3 Cycle de vie complet (observé en live — Centauri Carbon 2)

```
Démarrage impression :
  machine_status.status=2, sub_status=2901
  print_status.state="printing", progress=0, current_layer=0
  → nozzle target monte à 140°, bed à 60°

Impression active :
  machine_status.status=2, sub_status=1066
  6000 push : uniquement températures (nozzle/bed)
  → poll 1005 toutes les 10 s pour progress + current_layer

Séquence de fin normale :
  machine_status.exception_status=[803]     ← erreur / alerte
  machine_status.status=14                  ← état erreur
  machine_status.status=3, sub_status=1155  ← finishing
  machine_status.status=3, sub_status=1156  ← purge / wipe
  machine_status.status=3, sub_status=1157  ← nettoyage final
  machine_status.status=1, sub_status=0     ← retour standby
  print_status.state=""                     ← chaîne vide = done

Pause (method 1021) :
  sub_status=2501                           ← "pausing" début
  print_status.state="paused"              ← ~1 s
  sub_status=2502                           ← pause confirmée

Reprise (method 1023 — depuis "paused") :
  sub_status=2401                           ← "resuming" début
  sub_status=2402                           ← reprise effectuée
  sub_status=2075                           ← transitoire (<100 ms)
  print_status.state="printing"             ← impression reprise

Annulation (method 1022) :
  sub_status=2503                           ← "stopping" début
  sub_status=2504                           ← arrêt effectué
  machine_status.status=1, sub_status=0    ← idle
  print_status.state="cancelled"            ← confirmé
  extruder.target=0, heater_bed.target=0   ← chauffe éteinte

Téléchargement timelapse (HTTP GET après method 1051) :
  machine_status.status=12, sub_status=3020  ← transfert en cours
  machine_status.sub_status=3021            ← transfert terminé
  machine_status.status=1, sub_status=0    ← retour idle
```

---

## 8. Filament — Method 2005 response

### Payload response

```json
{
  "method": 2005,
  "result": {
    "canvas_info": {
      "canvas_list": [
        {
          "canvas_id": 0,
          "tray_list": [
            {
              "tray_id": 0,
              "filament_color": "#FF5733",
              "filament_type": "PLA",
              "brand": "ELEGOO",
              "filament_name": "PLA Silk",
              "filament_code": "0x0000",
              "min_nozzle_temp": 190,
              "max_nozzle_temp": 230,
              "status": 1
            }
          ]
        }
      ]
    }
  }
}
```

Lire `canvas_list[0].tray_list` (4 entrées, tray_id 0–3).  
Si `canvas_list` est absent → fallback sur arrays plats dans `params` (§8.1).

### Canvas déconnecté — champ `connected`

Quand le hub Canvas multi-filament est débranché, `canvas_list[0].connected = 0` et tous les slots ont des chaînes vides :

```json
{
  "method": 2005,
  "result": {
    "canvas_info": {
      "active_canvas_id": 0,
      "active_tray_id": -1,
      "auto_refill": false,
      "canvas_list": [{
        "canvas_id": 0,
        "connected": 0,
        "tray_list": [
          {"brand":"","filament_code":"","filament_color":"","filament_name":"","filament_type":"","max_nozzle_temp":0,"min_nozzle_temp":0,"status":0,"tray_id":0},
          {"brand":"","filament_code":"","filament_color":"","filament_name":"","filament_type":"","max_nozzle_temp":0,"min_nozzle_temp":0,"status":0,"tray_id":0},
          {"brand":"","filament_code":"","filament_color":"","filament_name":"","filament_type":"","max_nozzle_temp":0,"min_nozzle_temp":0,"status":0,"tray_id":0},
          {"brand":"","filament_code":"","filament_color":"","filament_name":"","filament_type":"","max_nozzle_temp":0,"min_nozzle_temp":0,"status":0,"tray_id":0}
        ]
      }]
    },
    "error_code": 0
  }
}
```

Dans ce cas : ne pas utiliser les données du `tray_list` vide. Envoyer la méthode **1061** à la place pour obtenir les infos de l'extrudeur unique (§8.2).

### Champs par slot

| JSON key | Type | Rôle |
|---|---|---|
| `tray_id` | `int` 0–3 | Index du slot |
| `filament_color` | `string` `#RRGGBB` | Couleur |
| `filament_type` | `string` | Type de base (`PLA`, `PETG`, …) |
| `brand` | `string` | Vendeur |
| `filament_name` | `string` | Nom complet / série |
| `filament_code` | `string` | Code matériau (`0x0000` = inconnu) |
| `min_nozzle_temp` | `int` °C | Température minimum buse |
| `max_nozzle_temp` | `int` °C | Température maximum buse |
| `status` | `int` | 1 = slot actif, 0 = vide |

### 8.1 Fallback — arrays plats (certains firmwares)

Certains firmwares poussent les données filament sous forme de tableaux de 4 éléments dans `params` :
```json
{
  "params": {
    "filament_color":    ["#FF5733","#00FF00","",""],
    "filament_type":     ["PLA","PETG","",""],
    "filament_vendor":   ["ELEGOO","Generic","",""],
    "filament_name":     ["PLA Silk","","",""],
    "filament_code":     ["0x0000","","",""],
    "filament_min_temp": [190, 200, 0, 0],
    "filament_max_temp": [230, 250, 0, 0],
    "filament_status":   [1, 1, 0, 0]
  }
}
```
Toujours 4 éléments. Slot vide = string vide ou 0.

### 8.2 Mono-extruder — Method 1061 (Canvas déconnecté)

**Observé sur CC2 (hardware live, Canvas débranché) :**

```json
{
  "id": 2,
  "method": 1061,
  "result": {
    "error_code": 0,
    "mono_filament_info": {
      "brand": "ELEGOO",
      "filament_code": "0x0000",
      "filament_color": "#FFFFFF",
      "filament_name": "PLA",
      "filament_type": "PLA",
      "max_nozzle_temp": 230,
      "min_nozzle_temp": 190,
      "status": 0,
      "tray_id": 0
    }
  }
}
```

**Logique d'intégration :**
1. Toujours inclure `1061` dans le SNAPSHOT_BURST initial.
2. Dans le handler `2005` : si `canvas_list[0].connected === 0`, ne pas utiliser `tray_list`, déclencher `1061`.
3. Dans le handler `1061` : si `_canvasConnected !== true`, écrire `conn.data.filaments` comme un tableau d'un seul slot (traité comme `active: true`).
4. Format couleur : `#RRGGBB` (pas RRGGBBAA — contrairement à Snapmaker).

> **✅ Écriture possible via méthode 1055** — voir §11.2. `mono_filament_info` est bien
> modifiable via MQTT : le slicer Elegoo utilise la méthode `1055` (pas `2003` ni `1061`).
> Le refresh post-save doit envoyer `1061` (pas `2005`) pour lire la valeur mise à jour.

---

## 9. Thumbnail — Method 1045

> **⚠️ Observation live** : pendant la phase de chauffe, method 1045 retourne
> `{"error_code": 1003}` (not found). La miniature n'est disponible qu'une fois
> l'impression démarrée. Ne pas afficher d'erreur — réessayer après transition d'état.

### Request

```json
{
  "id": 4,
  "method": 1045,
  "params": {
    "file_name": "ECC2_0.4_The Buddha_Elegoo PLA _0.2_25m47s.gcode",
    "storage_media": "local"
  }
}
```

> **Note** : le paramètre correct est **`file_name`** + **`storage_media:"local"`**, pas `uuid`.
> `uuid` retourne toujours `error_code:1003`. Utiliser `print_status.filename` du snapshot 1005.
> Déclencher sur changement de `filename` (plus fiable que `uuid`).

### Response (succès)

```json
{
  "method": 1045,
  "result": {
    "thumbnail": "<base64 PNG string>"
  }
}
```

### Response (erreur — phase de chauffe ou aucune impression)

```json
{ "id": 1045, "method": 1045, "result": { "error_code": 1003 } }
```

**Règles de déclenchement** :
- Déclencher quand `print_status.uuid` change (nouvelle impression détectée)
- Throttle : minimum 1500 ms entre deux tentatives
- Sur `error_code 1003` : ne pas logguer comme erreur — simplement ignorer et réessayer au prochain changement d'UUID
- Mettre en cache le dernier thumbnail valide par imprimante

---

## 10. Gestion des fichiers — Methods 1044 / 1047

> **Observées live** par sniffer MQTT (Centauri Carbon 2, firmware 01.03.02.51).

### 10.1 Liste des fichiers — Method 1044

Retourne la liste des fichiers gcode sur le stockage local ou USB, avec métadonnées.

**Request — stockage local :**
```json
{ "method": 1044, "params": { "storage_media": "local", "offset": 0, "limit": 20 }, "id": 3 }
```

**Request — clé USB :**
```json
{ "method": 1044, "params": { "storage_media": "u-disk", "dir": "/", "offset": 0, "limit": 20 }, "id": 5 }
```

**Response (Centauri Carbon 2 — observée live) :**
```json
{
  "error_code": 0,
  "file_list": [
    {
      "filename": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_13m46s.gcode",
      "type": "file",
      "create_time": 1760665400,
      "size": 5190855,
      "layer": 227,
      "print_time": 1547,
      "total_filament_used": 9.83,
      "last_print_time": 0,
      "total_print_times": 0,
      "color_map": [
        { "color": "#FFFFFF", "name": "PLA", "t": 0 }
      ]
    },
    {
      "filename": "3.Model",
      "type": "folder"
    }
  ],
  "offset": 0,
  "total": 7
}
```

| Champ | Type | Description |
|---|---|---|
| `filename` | string | Nom du fichier ou dossier |
| `type` | string | `"file"` ou `"folder"` |
| `layer` | number | Nombre total de couches |
| `print_time` | number | Durée estimée en secondes |
| `total_filament_used` | number | Filament total en grammes |
| `color_map` | array | Couleurs par outil `{ color, name, t }` |
| `last_print_time` | number | Timestamp dernière impression (0 si jamais imprimé) |
| `total_print_times` | number | Nombre d'impressions effectuées |

### 10.2 Suppression de fichier — Method 1047

**Request :**
```json
{
  "method": 1047,
  "params": {
    "storage_media": "local",
    "file_path": ["ECC2_0.4_Cube_Generic PLA High Speed _0.2_13m46s.gcode"]
  },
  "id": 39
}
```

**Response (succès, < 200 ms) :**
```json
{ "id": 39, "method": 1047, "result": { "error_code": 0 } }
```

- `file_path` est un **array** — suppression multiple possible en une seule commande
- `storage_media` : `"local"` ou `"u-disk"`
- **Aucun push MQTT** après suppression — faire un refresh 1044 manuellement
- L'app Elegoo enchaîne 1047 → 1044 immédiatement après (< 200 ms)

### 10.3 Upload de fichier — HTTP (non MQTT)

Le transfert du fichier gcode vers l'imprimante se fait **en HTTP**, pas en MQTT. L'endpoint exact n'a pas encore été capturé.

**Notification MQTT à la fin de l'upload** : le printer pousse automatiquement sur `api_status` :
```json
{ "method": 6000, "result": { "machine_status": { "status": 11, "sub_status": 3000 } } }
{ "method": 6000, "result": { "machine_status": { "sub_status": 3001 } } }
{ "method": 6000, "result": { "machine_status": { "status": 1, "sub_status": 0 } } }
```
Durée totale < 2 s. Utiliser cette séquence pour déclencher un refresh 1044 automatique après upload.

Si `file_list` est absent ou vide sur 1044, ne pas afficher de couche totale.
`current_layer` reste disponible via method 1005 → `print_status.current_layer`.

---

## 11. Écriture filament

Deux méthodes selon si le Canvas est connecté ou non — **observées live par sniffer MQTT sur le trafic du slicer Elegoo officiel**.

### 11.1 Canvas connecté — Method 2003

Écrit dans un slot du hub Canvas. Requiert que le Canvas soit physiquement branché — sans Canvas, `error_code: 1003` (INVALID_PARAMETER).

```json
{
  "id": 1,
  "method": 2003,
  "params": {
    "canvas_id": 0,
    "tray_id": 0,
    "brand": "ELEGOO",
    "filament_type": "PLA",
    "filament_name": "PLA",
    "filament_code": "0x0000",
    "filament_color": "#FF5733",
    "filament_min_temp": 190,
    "filament_max_temp": 230
  }
}
```

Après succès (`error_code === 0`), envoyer `2005` après 1000 ms pour rafraîchir.

### 11.2 Sans Canvas (mono-extruder) — Method 1055

**Observé live** : le slicer Elegoo utilise la méthode **1055** pour écrire le filament de l'extrudeur unique quand le Canvas n'est pas connecté. `error_code: 0` confirmé.

```json
{
  "id": 29,
  "method": 1055,
  "params": {
    "canvas_id": 0,
    "tray_id": 0,
    "brand": "ELEGOO",
    "filament_type": "PLA",
    "filament_name": "PLA",
    "filament_code": "0x0000",
    "filament_color": "#D4B1DD",
    "filament_min_temp": 190,
    "filament_max_temp": 230
  }
}
```

Après succès, envoyer `1061` après 1000 ms pour lire la valeur mise à jour.

**Exemples observés (sniffer) :**
```
method:1055  PLA  #D4B1DD  → error_code:0  ✅
method:1055  PETG #FFF242  filament_code:0x0100 → error_code:0  ✅
method:1055  PLA  #433089  → error_code:0  ✅
```

### 11.3 Table de correspondance `filament_code` — capturée live

> **Source** : sniffer MQTT sur le trafic du slicer Elegoo officiel (method 2003 / 1055).
> Chaque code est la valeur `filament_code` envoyée par le slicer pour chaque combinaison Type × Name.
> Capturé en totalité sur Centauri Carbon 2 (firmware 01.03.02.51) — 2026-05-16. **50 entrées.**

| Type   | Name             | filament_code | Nozzle min | Nozzle max |
|--------|------------------|--------------|-----------|-----------|
| PLA    | PLA              | `0x0000`     | 190 °C    | 230 °C    |
| PLA    | PLA+             | `0x0001`     | 190 °C    | 230 °C    |
| PLA    | PLA PRO          | `0x0002`     | 190 °C    | 230 °C    |
| PLA    | PLA Silk         | `0x0003`     | 190 °C    | 230 °C    |
| PLA    | PLA-CF           | `0x0004`     | 210 °C    | 240 °C    |
| PLA    | PLA Carbon       | `0x0005`     | 190 °C    | 230 °C    |
| PLA    | PLA Matte        | `0x0006`     | 190 °C    | 230 °C    |
| PLA    | PLA Fluo         | `0x0007`     | 190 °C    | 230 °C    |
| PLA    | PLA Wood         | `0x0008`     | 190 °C    | 230 °C    |
| PLA    | PLA Basic        | `0x0009`     | 190 °C    | 230 °C    |
| PLA    | RAPID PLA+       | `0x000A`     | 190 °C    | 230 °C    |
| PLA    | PLA Marble       | `0x000B`     | 190 °C    | 230 °C    |
| PLA    | PLA Galaxy       | `0x000C`     | 190 °C    | 230 °C    |
| PLA    | PLA Red Copper   | `0x000D`     | 190 °C    | 230 °C    |
| PLA    | PLA Sparkle      | `0x000E`     | 190 °C    | 230 °C    |
| PETG   | PETG             | `0x0100`     | 230 °C    | 260 °C    |
| PETG   | PETG-CF          | `0x0101`     | 240 °C    | 270 °C    |
| PETG   | PETG-GF          | `0x0102`     | 240 °C    | 270 °C    |
| PETG   | PETG PRO         | `0x0103`     | 230 °C    | 260 °C    |
| PETG   | PETG Translucent | `0x0104`     | 230 °C    | 260 °C    |
| PETG   | RAPID PETG       | `0x0105`     | 230 °C    | 260 °C    |
| ABS    | ABS              | `0x0200`     | 240 °C    | 280 °C    |
| ABS    | ABS-GF           | `0x0201`     | 240 °C    | 280 °C    |
| TPU    | TPU              | `0x0300`     | 220 °C    | 240 °C    |
| TPU    | TPU 95A          | `0x0301`     | 220 °C    | 240 °C    |
| TPU    | RAPID TPU 95A    | `0x0302`     | 220 °C    | 240 °C    |
| PA     | PA               | `0x0400`     | 260 °C    | 290 °C    |
| PA     | PA-CF            | `0x0401`     | 260 °C    | 300 °C    |
| PA     | PAHT-CF          | `0x0402`     | 280 °C    | 320 °C    |
| PA     | PA6              | `0x0403`     | 260 °C    | 290 °C    |
| PA     | PA6-CF           | `0x0404`     | 270 °C    | 310 °C    |
| PA     | PA12             | `0x0405`     | 240 °C    | 270 °C    |
| PA     | PA12-CF          | `0x0406`     | 260 °C    | 290 °C    |
| CPE    | CPE              | `0x0500`     | 220 °C    | 250 °C    |
| PC     | PC               | `0x0600`     | 260 °C    | 290 °C    |
| PC     | PCTG             | `0x0601`     | 260 °C    | 290 °C    |
| PC     | PC-FR            | `0x0602`     | 260 °C    | 290 °C    |
| PVA    | PVA              | `0x0700`     | 180 °C    | 210 °C    |
| ASA    | ASA              | `0x0800`     | 240 °C    | 280 °C    |
| BVOH   | BVOH             | `0x0900`     | 190 °C    | 210 °C    |
| EVA    | EVA              | `0x0A00`     | 180 °C    | 220 °C    |
| HIPS   | HIPS             | `0x0B00`     | 220 °C    | 250 °C    |
| PP     | PP               | `0x0C00`     | 210 °C    | 250 °C    |
| PP     | PP-CF            | `0x0C01`     | 220 °C    | 260 °C    |
| PP     | PP-GF            | `0x0C02`     | 230 °C    | 250 °C    |
| PPA    | PPA              | `0x0D00`     | 290 °C    | 310 °C    |
| PPA    | PPA-CF           | `0x0D01`     | 300 °C    | 320 °C    |
| PPA    | PPA-GF           | `0x0D02`     | 290 °C    | 310 °C    |
| PPS    | PPS              | `0x0E00`     | 330 °C    | 340 °C    |
| PPS    | PPS-CF           | `0x0E01`     | 340 °C    | 360 °C    |

> Les températures marquées `—` n'ont pas été capturées lors de la session de sniffing
> (variants non visibles dans ElegooSlicer pour le firmware 01.03.02.51).
> Le code est confirmé ; les températures sont à compléter si nécessaire.

**Utilisation** : lors de l'écriture (methods 2003 / 1055), chercher le code exact par `(filament_type, filament_name)`. Si non trouvé, utiliser `"0x0000"` comme fallback.

### Règles communes (2003 et 1055)
- `canvas_id` : toujours `0`
- `tray_id` : `0`–`3` (Canvas) ou `0` (mono)
- `filament_type` : type de base uniquement — supprimer les modificateurs. Ex. `"PLA+ Silk"` → `"PLA"`. Logique : split sur `/[\s+\-_\/]+/`, prendre le premier token.
- `filament_color` : `#RRGGBB` majuscules
- `filament_code` : utiliser la table §11.3 ; `"0x0000"` si type/name inconnu
- `brand` : `"ELEGOO"` par défaut si inconnu
- `filament_name` : même valeur que `filament_type` si pas de nom complet

### PING/PONG — heartbeat applicatif

Le slicer envoie un heartbeat custom **en plus** du keepAlive MQTT standard.
**Recommandé** : sans PING/PONG, certains brokers Elegoo peuvent fermer la session.

```
PUB elegoo/{sn}/{cid}/api_request  {"type":"PING"}
SUB elegoo/{sn}/{cid}/api_response {"type":"PONG"}
```

Intervalles observés :
- Client contrôle (slicer principal) : **~10 s**
- Client fichiers/filaments : **~45 s**

Tiger Studio : implémenter à **10 s** (calé sur le client principal du slicer).
Ignorer les messages `{"type":"PONG"}` dans `_routeMessage` (pas de méthode numérique → `default: break`).

---

## 12. Caméra

### URL dynamique via Method 1042

Ne jamais hardcoder l'URL — la demander via method 1042 au démarrage :

```json
// Request
{ "id": 7, "method": 1042, "params": {} }

// Response (observé live CC2)
{ "id": 7, "method": 1042, "result": { "error_code": 0, "url": "http://192.168.40.113:8080/?action=stream" } }
```

Stocker l'URL retournée dans `conn.data.cameraUrl`. L'utiliser pour le flux vidéo.

### Flux

Flux MJPEG standard, pas d'authentification. Afficher avec un `<img src="...">` en streaming (même approche que FlashForge). Pas de WebRTC, pas d'iframe — juste un `<img>`.

Format observé : `http://{ip}:8080/?action=stream`

---

## 13. Découverte LAN — UDP port 52700

### Envoi (probe)

Envoyer en UDP sur le port `52700` à chaque IP du réseau :
```json
{"id": 0, "method": 7000}
```
Envoyer **deux fois** par IP, avec **60 ms d'intervalle**.

### Réponse (datagramme UDP de l'imprimante)

```json
{
  "host_name": "MyElegooPrinter",
  "machine_model": "Centauri Carbon 2",
  "sn": "EG12345678",
  "protocol_version": "1.0",
  "software_version": { "ota_version": "1.2.3" },
  "token_status": 1,
  "lan_status": 1
}
```

Les champs peuvent être à la racine ou imbriqués sous `result`, `params`, `data` ou `msg` — les aplatir.

### Variantes de clés à accepter

| Champ interne | JSON keys acceptées |
|---|---|
| `hostName` | `host_name`, `hostName`, `hostname` |
| `machineModel` | `machine_model`, `machineModel`, `model` |
| `serialNumber` | `sn`, `serial`, `serial_number` |
| `protocolVersion` | `protocol_version`, `protocolVersion` |
| `otaVersion` | `software_version.ota_version` |

### Stratégie de scan

1. Dériver le subnet `/24` des IPs déjà connues + IP Wi-Fi locale
2. Ajouter toujours : `192.168.1.x`, `192.168.40.x` (`includeCommonSubnets` = **true** par défaut)
3. Ouvrir **un seul socket UDP** partagé (bind port 0, `reuseAddress: true`)
4. Sprayer toutes les IPs `.1`–`.254` en séquence rapide — **1 envoi par IP**
   - Yield toutes les **16 IPs** (`await Future.delayed(Duration.zero)`) pour laisser les réponses entrer
5. Fenêtre d'écoute : **2400 ms** après le dernier envoi (full scan) / **1400 ms** (probe rapide)
6. Dédupliquer par IP — si deux réponses arrivent pour la même IP, garder le score le plus élevé

> **Différence probe vs scan** : en mode `probe(ip)` direct, la trame est envoyée **deux fois** avec 60 ms d'intervalle. En mode `scan()`, chaque IP ne reçoit qu'**une seule** trame (la fenêtre d'écoute compense).

### Score de qualité d'un candidat

```dart
// Tri : score décroissant, puis IP croissante
int qualityScore(candidate) {
  if (hostName?.trim().isNotEmpty)     score += 4;
  if (machineModel?.trim().isNotEmpty) score += 3;
  if (serialNumber?.trim().isNotEmpty) score += 5;  // champ le plus utile
  if (protocolVersion?.trim().isNotEmpty) score += 1;
  if (otaVersion?.trim().isNotEmpty)   score += 1;
  if (tokenStatus != null)             score += 1;
  if (lanStatus != null)               score += 1;
  // max théorique : 16
}
```

### Fallback réponse non-JSON

Si le datagramme reçu n'est pas un JSON valide, il est conservé **uniquement** si le texte brut contient `"elegoo"` ou `"centauri"` (insensible à la casse). Dans ce cas, le payload est stocké sous `{ "message": "<texte brut>" }` pour diagnostic.

---

## 14. Gestion d'erreurs

| Situation | Comportement |
|---|---|
| SN manquant | Bloquer la connexion, afficher erreur |
| IP manquante | Bloquer la connexion, afficher erreur |
| MQTT connexion échouée | `throw` → log + badge offline |
| Disconnect | Vider flags `connected`/`connecting`, retirer guard `initSnapshot`, reconnexion auto |
| Publish sans connexion | Log `"MQTT not connected"`, ignorer sans crash |
| Base64 thumbnail invalide | Retirer du cache, afficher placeholder |
| `filament_type` absent | Defaulter à string vide, afficher `?` dans le slot |
| État inconnu | Capitaliser la première lettre et afficher tel quel |
| `print_status.state = ""` | Mapper → `"standby"` (cas observé après fin d'impression) |

### Codes `error_code` observés en live

| Code | Méthode | Signification |
|------|---------|--------------|
| `0`  | toutes  | Succès |
| `1003` | 1045 (thumbnail) | Miniature non trouvée (print pas encore démarrée, ou chauffe) |
| `1003` | 2003 (write canvas filament) | INVALID_PARAMETER — Canvas non connecté ; utiliser 1055 en mode mono |
| `1010` | 1031 (timelapse) | Vidéo timelapse non disponible (impression annulée avant fin, ou timelapse désactivé) |

### Authentification MQTT — comportement en cas d'erreur (observé live)

L'authentification Elegoo est **exclusivement au niveau du broker MQTT** (CONNECT packet — username + password). Il n'y a **aucun code applicatif** dans le payload `api_register`.

| Cas | Comportement observé |
|-----|---------------------|
| Connexion sans password | Broker ferme la socket immédiatement — MQTT CONNACK return code 4 (`Connection Refused, bad user name or password`) |
| Mauvais password | Identique — CONNACK rc=4, socket fermée |
| Bon password | CONNACK rc=0, connexion établie, `api_register` peut être publié |
| Mauvais SN dans les topics | Connexion MQTT réussie mais aucune réponse aux méthodes — les topics n'existent tout simplement pas |

> Ces rejets sont **invisibles** pour un abonné déjà connecté : aucune trace dans les topics. Le client fautif ne peut rien publier ni souscrire — la socket est close avant toute échange.
>
> **Implication pour Tiger Studio** : en cas d'échec MQTT CONNECT, le callback `on('error')` ou `on('close')` se déclenche immédiatement (délai < 500 ms). Pas besoin de timeout long.

Le password `Q2CQoJ` est le même pour tous les appareils Elegoo observés (Centauri Carbon 2 firmware 01.03.02.51). Il est possiblement commun à toute la gamme ou par firmware — à vérifier sur d'autres appareils.

---

## 15. Contrôle d'impression — Methods 1020 / 1021 / 1022 / 1023

**Observées live** par sniffer MQTT (`elegoo/{sn}/{cid}/api_request`) lors d'une session d'impression complète. Toutes renvoient `{"error_code": 0}` en cas de succès.

### 15.0 Pré-impression — Method 2004 (Canvas auto-refill)

Envoyé par le slicer **juste avant** `method 1020`, uniquement si un Canvas est connecté. Configure le mode auto-refill (rechargement automatique entre les couleurs).

```json
{ "id": 100015, "method": 2004, "params": { "auto_refill": true } }
```

Response : `{ "error_code": 0 }`. Si pas de Canvas, ignorer cette méthode.

---

### 15.1 Démarrer une impression — Method 1020

> **Payload complet observé live** (Centauri Carbon 2, impression avec Canvas 4-slots) :

```json
{
  "id": 100016,
  "method": 1020,
  "params": {
    "filename": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode",
    "storage_media": "local",
    "config": {
      "bedlevel_force": false,
      "delay_video": true,
      "print_layout": "A",
      "printer_check": true,
      "slot_map": [
        { "canvas_id": 0, "t": 0, "tray_id": 0 }
      ]
    }
  }
}
```

| Champ | Type | Description |
|---|---|---|
| `filename` | string | Nom du fichier gcode sur l'imprimante |
| `storage_media` | string | `"local"` (stockage interne) ou `"u-disk"` (USB) |
| `config.bedlevel_force` | bool | Forcer le bed leveling même si déjà fait (`false` = seulement si nécessaire) |
| `config.delay_video` | bool | Activer le time-lapse vidéo |
| `config.printer_check` | bool | Vérification de l'imprimante avant impression |
| `config.print_layout` | string | Layout `"A"` (valeur observée, signification inconnue) |
| `config.slot_map` | array | Mapping outil→slot Canvas : `t` = numéro d'outil gcode, `tray_id` = slot Canvas |

**`slot_map`** : mappé outil par outil. Impression monocolore → `[{canvas_id:0, t:0, tray_id:0}]`. Multicolore → une entrée par outil. Si pas de Canvas, champ absent.

**Séquence 6000 immédiate après `method 1020` (observée live) :**
```
→ 1020  { filename, slot_map, … }
← 1020  { error_code:0 }                                 (immédiat)
  6000  { machine_status:{ progress:0 },
          print_status:{ filename:"…", remaining_time_sec:223, uuid:"0f3b72e4-…" } }
  6000  { canvas_info:{ auto_refill:true }, gcode_move:{ z:0.111 },
          print_status:{ state:"printing", enable:true, bed_mesh_detect:true } }
  6000  { extruder:{ target:140 }, heater_bed:{ target:55 },
          fans:{ box_fan:25.5, heater_fan:255 },
          machine_status:{ progress:1 }, print_status:{ remaining_time_sec:219 } }
```
→ `print_status.uuid` est l'identifiant unique de la session d'impression.
→ `print_status.remaining_time_sec` = durée estimée issue du gcode.
→ `extruder.target` + `heater_bed.target` sont poussés dès que la chauffe démarre.

### 15.2 Pause — Method 1021

> **Observé live** (mobile app `0clieb8105`, impression en cours layer 10/26) :

**Request :**
```json
{ "id": 74, "method": 1021 }
```

Aucun paramètre. Réponse (`error_code: 0`) arrive **après** que la pause est physiquement effective (~4 s).

**Séquence 6000 observée :**
```
→ 1021  {}
  6000  machine_status.sub_status = 2501          ← "pausing" (début)
  6000  print_status.state = "paused"             ← effectif ~1 s après
        + remaining_time_sec, total_duration
  6000  machine_status.sub_status = 2502          ← "paused" (confirmé)
← 1021  { error_code: 0 }                        ← ~4 s après la requête
```

| sub_status | Phase |
|---|---|
| `2501` | Début de la mise en pause |
| `2502` | Pause confirmée (extrudeur arrêté) |

Poll `method 1005` pour confirmer `state: "paused"` + `current_layer`.

---

### 15.3 Reprendre (Resume/Restart) — Method 1023

> **Observé live** : envoyé ~1 s après la réponse 1021 (depuis paused → printing).

**Request :**
```json
{ "id": 75, "method": 1023 }
```

Aucun paramètre. Réponse arrive **après** reprise physique (~18 s si nozzle doit rechauffer).

**Séquence 6000 observée :**
```
→ 1023  {}
  6000  machine_status.sub_status = 2401          ← "resuming" (début)
  … [quelques secondes de traitement] …
  6000  machine_status.sub_status = 2402          ← "resuming" (fin)
← 1023  { error_code: 0 }
  6000  machine_status.sub_status = 2075          ← transitoire (< 100 ms)
  6000  print_status.state = "printing"           ← impression reprise
        + current_layer, remaining_time_sec mis à jour
```

| sub_status | Phase |
|---|---|
| `2401` | Début de la reprise |
| `2402` | Reprise effectuée |
| `2075` | Transitoire — impression active (disparaît immédiatement) |

---

### 15.4 Annuler — Method 1022

> **Observé live** : utilisable depuis `"printing"` ou `"paused"`. Annulation immédiate.

**Request :**
```json
{ "id": 76, "method": 1022 }
```

Aucun paramètre. Réponse (`error_code: 0`) arrive ~9 s après la requête (pendant que l'imprimante remet la tête en position de repos).

**Séquence 6000 observée :**
```
→ 1022  {}
  6000  machine_status.sub_status = 2503          ← "stopping" (début)
  6000  machine_status.sub_status = 2504          ← "stopping" (fin)
  6000  machine_status.progress = 0
        print_status = { current_layer:0, filename:"", print_duration:0,
                         remaining_time_sec:0, total_duration:0, uuid:"" }
  6000  machine_status = { status:1, sub_status:0 }  ← retour idle
  6000  print_status.state = "cancelled"          ← confirmé dans le flux
← 1022  { error_code: 0 }                        ← ~9 s après la requête
  6000  extruder.target = 0, heater_bed.target = 0  ← chauffe éteinte
        tool_head.homed_axes = ""
```

| sub_status | Phase |
|---|---|
| `2503` | Début annulation |
| `2504` | Annulation terminée, retour en cours |

**Après annulation, le mobile app envoie automatiquement :**
1. `method 1031 { "mode": 1 }` — requête timelapse (error_code 1010 si pas de vidéo)
2. `method 1002 {}` — snapshot complet de statut
3. `method 1036 {}` — liste des impressions récentes (§22)

---

## 16. Contrôle des axes — Methods 1026 / 1027

**Observées live** lors de commandes de déplacement manuel envoyées via le slicer Elegoo.

### 16.1 Homing — Method 1026

Renvoie tous les axes à la position d'origine.

```json
{
  "id": 5,
  "method": 1026,
  "params": {
    "homed_axes": "xyz"
  }
}
```

| Champ | Valeur observée | Description |
|---|---|---|
| `homed_axes` | `"xyz"` | Axes à hommer (peut être sous-ensemble, ex. `"z"`) |

### 16.2 Jog (déplacement relatif) — Method 1027

Déplace un axe d'une distance relative en millimètres.

```json
{
  "id": 6,
  "method": 1027,
  "params": {
    "axes": "z",
    "distance": -1
  }
}
```

| Champ | Type | Description |
|---|---|---|
| `axes` | string | Axe cible : `"x"`, `"y"`, `"z"` (un seul axe par commande observé) |
| `distance` | number | Distance en mm, signée (positif = sens +, négatif = sens −) |

**Valeurs observées** : `distance: -1` (descente Z de 1 mm). Pas d'unité autre que mm observée.

---

## 17. LED, ventilateurs, vitesse — Methods 1029 / 1030 / 1031

**Observées live** lors de contrôles manuels via le slicer Elegoo. Toutes renvoient `error_code: 0`. Le push 6000 émet les nouvelles valeurs dès que l'imprimante les applique.

### 17.1 LED — Method 1029

```json
{
  "id": 7,
  "method": 1029,
  "params": { "power": 1 }
}
```

| `power` | Effet |
|---|---|
| `1` | LED allumée |
| `0` | LED éteinte |

### 17.2 Ventilateurs — Method 1030

Chaque ventilateur est contrôlé indépendamment dans un payload séparé.

```json
{ "id": 8,  "method": 1030, "params": { "fan":     255 } }
{ "id": 9,  "method": 1030, "params": { "aux_fan": 255 } }
{ "id": 10, "method": 1030, "params": { "box_fan": 255 } }
```

| Champ | Description |
|---|---|
| `fan` | Ventilateur principal (refroidissement pièce) |
| `aux_fan` | Ventilateur auxiliaire |
| `box_fan` | Ventilateur de boîtier (filtration) |

**Plage** : `0` (arrêt) à `255` (pleine vitesse). Les paliers observés du slicer sont des multiples de `25.5` (0, 25, 51, 76, 102, 127, 153, 178, 204, 229, 255 — correspondant à 0 % à 100 % par pas de 10 %).

### 17.3 Mode vitesse d'impression — Method 1031

```json
{
  "id": 11,
  "method": 1031,
  "params": { "mode": 0 }
}
```

| `mode` | Vitesse |
|---|---|
| `0` | Normale |
| `1` | Silencieuse (supposé) |
| `2` | Sport (supposé) |
| `3` | Ludicrous (supposé) |

Seul `mode: 0` a été observé live pour le contrôle de vitesse. Les autres valeurs sont extrapolées par analogie avec d'autres firmwares Klipper-dérivés.

> **⚠️ Ambiguïté** : `method 1031 { "mode": 1 }` est également envoyé par l'app mobile **immédiatement après une annulation** (method 1022), et retourne `error_code: 1010` si le timelapse n'est pas disponible. Dans ce contexte, "mode" pourrait signifier autre chose qu'une vitesse (ex. requête timelapse). À investiguer : le champ `mode` pourrait être multifonction selon le contexte d'impression.

---

## 18. Méthodes inconnues — 1024 / 1025

Appelées **séquentiellement** (1024 puis 1025) lors de l'ouverture du panneau d'inspection ou d'édition du filament dans le slicer Elegoo. Aucun paramètre envoyé dans les deux cas. Elles retournent `error_code: 0`.

```json
{ "id": 12, "method": 1024, "params": {} }
{ "id": 13, "method": 1025, "params": {} }
```

**Hypothèse** : 1024 pourrait demander un lock d'accès filament ou initialiser un mode édition ; 1025 pourrait acquitter ou confirmer. À reverse-engineer lors d'une prochaine session de sniffer ciblée sur la réponse complète.

---

## 19. Contrôle des températures — Method 1028

> **Observé live** par sniffer MQTT lors d'une session avec l'app mobile Elegoo (client `0clieb8105`).

Permet de régler la température cible du nozzle **ou** du bed — un seul champ à la fois dans `params`.

### Request — nozzle

```json
{ "id": 8, "method": 1028, "params": { "extruder": 40 } }
```

### Request — bed

```json
{ "id": 9, "method": 1028, "params": { "heater_bed": 30 } }
```

### Response (succès)

```json
{ "id": 8, "method": 1028, "result": { "error_code": 0 } }
```

| Champ `params` | Type | Description |
|---|---|---|
| `extruder` | number | Température cible nozzle en °C. `0` = chauffage éteint |
| `heater_bed` | number | Température cible bed en °C. `0` = chauffage éteint |

**Règles** :
- Un seul champ par commande (pas `{ "extruder": 200, "heater_bed": 60 }` en une fois)
- La commande répond immédiatement (`error_code: 0`) — la chauffe est asynchrone
- Le push 6000 sur `api_status` émet `extruder.target` / `heater_bed.target` au moment où la chauffe démarre, puis les températures courantes toutes les ~1–4 s
- Pour lire l'état courant : `method 1002` → `result.extruder.target` + `result.extruder.temperature` et `result.heater_bed.target` + `result.heater_bed.temperature`

---

## 20. Filament Canvas — Load / Unload — Methods 2001 / 2002

> **Observé live** par sniffer MQTT (client `0clieb8105`, Centauri Carbon 2).
> Ces méthodes sont **Canvas-only** — elles s'appliquent à un slot du hub Canvas.

### 20.1 Load filament — Method 2001

Chauffe le nozzle à la température du filament configuré dans le slot, puis avance l'extrudeur pour charger le filament. Opération longue (~2 minutes).

**Request :**
```json
{ "id": 10, "method": 2001, "params": { "canvas_id": 0, "tray_id": 1 } }
```

**Response (après achèvement) :**
```json
{ "id": 10, "method": 2001, "result": { "error_code": 0 } }
```

> La réponse n'arrive qu'**après** la fin physique de l'opération (~120 s). L'app doit afficher un spinner et ne pas timeout avant 3 min.

### 20.2 Unload filament — Method 2002

Chauffe le nozzle (si nécessaire), puis recule l'extrudeur pour décharger le filament. Plus rapide si le nozzle est déjà chaud (~33 s dans l'observation vs ~120 s à froid).

**Request :**
```json
{ "id": 16, "method": 2002, "params": { "canvas_id": 0, "tray_id": 1 } }
```

**Response (après achèvement) :**
```json
{ "id": 16, "method": 2002, "result": { "error_code": 0 } }
```

| Champ | Type | Description |
|---|---|---|
| `canvas_id` | number | ID du Canvas — `0` pour le premier (seul observé) |
| `tray_id` | number | Numéro du slot (0–3 sur CC2 4-slots) |

**Séquence typique observée dans l'app :**
```
→ REQ  method=2001  { canvas_id:0, tray_id:1 }    ← Load (nozzle chauffe)
← RES  method=2001  { error_code:0 }               ← ~120 s plus tard
→ REQ  method=2005  {}                             ← Refresh état canvas
← RES  method=2005  ...

→ REQ  method=2002  { canvas_id:0, tray_id:1 }    ← Unload (nozzle encore chaud)
← RES  method=2002  { error_code:0 }               ← ~33 s plus tard
→ REQ  method=2005  {}                             ← Refresh état canvas
← RES  method=2005  ...
```

**Pendant l'opération** : le push 6000 `api_status` émet la température courante de l'extrudeur toutes les ~1 s (montée de 25°C jusqu'à la température cible du filament, puis redescente). Surveiller ce flux pour afficher une barre de progression.

> **Note** : pour les imprimantes **sans Canvas** (mono-extrudeur), ces méthodes ne s'appliquent pas. L'équivalent mono n'a pas encore été capturé.

---

## 21. Statut impression en temps réel — Method 1005

> **Observé live** : envoyé toutes les ~10 s par l'app mobile `TTG_XXXX` pendant une impression (et après pause). Fournit `current_layer` et `state` non disponibles dans le flux 6000.

**Request :**
```json
{ "id": 214, "method": 1005, "params": {} }
```

**Response :**
```json
{
  "id": 214,
  "method": 1005,
  "result": {
    "error_code": 0,
    "print_status": {
      "bed_mesh_detect": true,
      "current_layer": 10,
      "enable": true,
      "filament_detect": false,
      "filename": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode",
      "print_duration": 177,
      "remaining_time_sec": 226,
      "state": "paused",
      "total_duration": 460,
      "uuid": "0f3b72e4-6508-4bb3-967e-f145372f687d"
    }
  }
}
```

| Champ | Type | Description |
|---|---|---|
| `bed_mesh_detect` | bool | Bed leveling a été effectué pour cette impression |
| `current_layer` | number | Couche actuelle (commence à 0) |
| `enable` | bool | Impression active |
| `filament_detect` | bool | Détection filament active (runout sensor) |
| `filename` | string | Nom du fichier gcode en cours |
| `print_duration` | number | Durée effective d'impression en secondes (hors pause) |
| `remaining_time_sec` | number | Temps restant estimé en secondes |
| `state` | string | État courant (`"printing"`, `"paused"`, `""`) |
| `total_duration` | number | Durée totale depuis le début (pause incluse) |
| `uuid` | string | ID unique de la session d'impression |

**Usage recommandé** : poll 1005 toutes les **10 s** pendant une impression pour mettre à jour `current_layer` et `remaining_time_sec` — ces champs ne sont pas toujours présents dans le flux 6000.

> `total_layers` n'est pas dans cette réponse — le récupérer depuis `method 1044` ou `method 1046` (champ `layer`).

---

## 22. Historique des impressions — Method 1036

> **Observé live** : envoyé par l'app mobile après annulation d'une impression. Retourne la liste des dernières sessions avec statut timelapse.

**Request :**
```json
{ "id": 79, "method": 1036 }
```

**Response :**
```json
{
  "id": 79,
  "method": 1036,
  "result": {
    "error_code": 0,
    "history_task_list": [
      {
        "begin_time": 1778890203,
        "end_time": 1778890706,
        "task_id": "0f3b72e4-6508-4bb3-967e-f145372f687d",
        "task_name": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode",
        "task_status": 2,
        "time_lapse_video_duration": 0,
        "time_lapse_video_size": 0,
        "time_lapse_video_status": 0,
        "time_lapse_video_url": ""
      },
      {
        "begin_time": 1778890795,
        "end_time": 1778891093,
        "task_id": "61e9f140-b301-43bf-aa40-cbc6ef8970b9",
        "task_name": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode",
        "task_status": 1,
        "time_lapse_video_duration": 1,
        "time_lapse_video_size": 276222,
        "time_lapse_video_status": 2,
        "time_lapse_video_url": "video/ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode20260516081955.mp4"
      },
      {
        "begin_time": 1778895031,
        "end_time": 1778895636,
        "task_id": "9995acb9-59b6-4288-a158-052330f7a94c",
        "task_name": "ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode",
        "task_status": 1,
        "time_lapse_video_duration": 1,
        "time_lapse_video_size": 273961,
        "time_lapse_video_status": 2,
        "time_lapse_video_url": "video/ECC2_0.4_Cube_Generic PLA High Speed _0.2_3m43s.gcode20260516093031.mp4"
      }
    ],
    "total": 5
  }
}
```

> **Correction live (2026-05-16)** : contrairement à la documentation initiale, `time_lapse_video_url` contient déjà le chemin `video/….mp4` directement — pas `picture/…`. La méthode 1051 est inutile pour le téléchargement.

| Champ | Type | Description |
|---|---|---|
| `task_id` | string | UUID de la session (= `print_status.uuid` pendant l'impression) |
| `task_name` | string | Nom du fichier gcode |
| `begin_time` / `end_time` | number | Timestamps Unix de début/fin |
| `task_status` | number | `1` = terminé normalement, `2` = annulé / incomplet |
| `time_lapse_video_status` | number | `0` = pas de vidéo, `2` = vidéo disponible, `3` = en cours d'enregistrement |
| `time_lapse_video_url` | string | Chemin relatif `video/….mp4` — URL complète = `http://{ip}:8080/{url}` |
| `time_lapse_video_duration` | number | Durée en secondes |
| `time_lapse_video_size` | number | Taille en octets |

**Usage** : appeler après fin ou annulation pour afficher l'historique et détecter si un timelapse est disponible.

---

## 23. Timelapse — Téléchargement HTTP direct

> **Observé live (2026-05-16, tcpdump)** : le slicer Elegoo utilise **port 80** (libhv), endpoint `/download` avec `X-Token` + `file_name`. **Port 8080 = caméra MJPEG uniquement** — toute requête y retourne le flux caméra quelle que soit l'URL. La méthode 1051 est inutile.

### Flux complet

```
1036{}  → history_task_list[N].time_lapse_video_url = "video/….mp4"  (si time_lapse_video_status=2)

HTTP GET  http://{ip}/download?X-Token={mqttPassword}&file_name={encodeURIComponent(time_lapse_video_url)}
          ← port 80, libhv/1.3.4
          ← Content-Length présent, pas de streaming
          ← Content-Disposition: attachment; filename="video/….mp4"
```

**Exemple (observé tcpdump) :**
```
GET /download?X-Token=Q2CQoJ&file_name=video%2FECC2_0.4_Cube_Generic+PLA+High+Speed+_0.2_3m43s.gcode20260516093031.mp4 HTTP/1.1
Host: 192.168.40.113
→ HTTP/1.1 200 OK  Content-Length: 273961  Server: libhv/1.3.4
```

**Séquence 6000 pendant le téléchargement :**
```
  6000  machine_status.status=12, sub_status=3020   ← transfert en cours
  … [durée selon taille du fichier] …
  6000  machine_status.sub_status=3021              ← transfert terminé
  6000  machine_status.status=1, sub_status=0       ← retour idle
```

> `status=12` pendant le transfert — ignorer pour l'UI (pas une impression active).  
> `time_lapse_video_status=0` → pas de vidéo. `time_lapse_video_status=2` → vidéo disponible. `time_lapse_video_status=3` → enregistrement en cours (URL vide).

### Séquence d'affichage de la liste timelapse

```
api_register → 1036{} → 2005{} → 1044{local} → 1002{}   ← burst simultané à la connexion
← 1036: history_task_list (filtrer: time_lapse_video_status > 0)
← afficher liste des timelapse disponibles

[utilisateur clique télécharger]
→ HTTP GET http://{ip}/download?X-Token={password}&file_name={encodeURIComponent(url)}
← fichier MP4 (~274 KB pour 3m43s)
```

---

## 24. Checklist d'implémentation pour Tiger Studio

- [ ] Paquet npm `mqtt` (déjà présent si Bambu est implémenté)
- [ ] `printers/elegoo/index.js` — lifecycle MQTT (connect / disconnect / reconnect)
- [ ] `printers/elegoo/widget_camera.js` — `renderElegooCamBanner(p)` → `<img>` MJPEG (port 8080)
- [ ] `printers/elegoo/cards.js` — `renderElegooJobCard`, `renderElegooTempCard`, `renderElegooFilamentCard`
- [ ] CSS dans `renderer/css/57-elegoo.css` — classes dédiées, pas de dépendance à `.snap-camera-frame`
- [ ] `renderCamBanner` dans `inventory.js` : ajouter `case "elegoo": return renderElegooCamBanner(p)`
- [ ] Discovery UDP port 52700 → intégrer dans le flow scan printers
- [ ] Normalisation progress : si `value > 1` → `value / 100`
- [ ] Cache `Map<filename, totalLayers>` depuis réponse 1044
- [ ] Throttle thumbnail 1045 : 1500 ms ou changement de `uuid`
- [ ] Suppression fichier : `method 1047` → `{ storage_media, file_path: [filename] }` → refresh 1044 (§10.2)
- [ ] Upload gcode : HTTP (endpoint à déterminer) → écouter push 6000 `machine_status.status=11` → refresh 1044 auto (§10.3)
- [ ] Avant method 1020 : envoyer `method 2004 { "auto_refill": true }` si Canvas connecté (§15.0)
- [ ] method 1020 : inclure `slot_map` si Canvas — mapper chaque outil `t` vers `tray_id` (§15.1)
- [ ] method 1020 : inclure `bedlevel_force: false` dans `config`
- [ ] Après 1020 : écouter push 6000 pour `print_status.uuid` + `remaining_time_sec` + `state:"printing"`
- [ ] sub_status 1045/1405/2801/2802/2902 → mapper vers `"printing"` ou `"heating"` (§7.2)
- [ ] sub_status 2501/2502 → `"paused"` ; 2401/2402 → `"printing"` ; 2503/2504 → `"standby"` (§7.2 + §15)
- [ ] Auth MQTT : erreur connexion → feedback immédiat (CONNACK rc≠0 = mauvais password, pas de retry)
- [ ] Set temp nozzle : `method 1028` → `{ "extruder": N }` ; set bed : `{ "heater_bed": N }` (§19)
- [ ] Canvas Load/Unload : `method 2001` / `2002` → spinner jusqu'à response, timeout 3 min (§20)
- [ ] Pause : `method 1021 {}` → attendre sub_status=2502 OU `state="paused"` dans 6000 (§15.2)
- [ ] Resume : `method 1023 {}` → attendre sub_status=2402 OU `state="printing"` dans 6000 (§15.3)
- [ ] Cancel : `method 1022 {}` → attendre `state="cancelled"` + `extruder.target=0` dans 6000 (§15.4)
- [ ] Poll `method 1005 {}` toutes les 10 s pour `current_layer` + `remaining_time_sec` (§21)
- [ ] `total_layers` depuis `method 1044` ou `1046` (champ `layer`) — NE PAS attendre `1005` (§21)
- [ ] Après cancel : appeler `method 1036 {}` pour historique + statut timelapse (§22)
- [ ] Timelapse : `1036{}` → filtrer `time_lapse_video_status=1` → `1051{url:entry.time_lapse_video_url}` → HTTP GET `http://{ip}:8080/{result.url}` (§23)
- [ ] status=12 / sub_status 3020/3021 → ignorer en UI (téléchargement vidéo en cours, pas une impression)
- [ ] Écouter push 6008 sur `api_status` → détecter autres clients connectés (optionnel)
