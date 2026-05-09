# Tiger Studio Manager — Dev Log

Journal de travail par session. Plus granulaire que ROADMAP.md, moins public que README.md.
Mis à jour en fin de chaque session Claude.

---

## 2026-05-09 — v1.4.15

### Demandes
- Intégration Creality dans le panel 3D printers (live WebSocket port 9999)
- Affichage temps réel : températures nozzle/bed/box, état impression, progression, couches, durée
- CFS : grille de slots couleur si `cfsConnect=1` et `materialBoxs` présent
- Caméra WebRTC (iframe, même pattern que Snapmaker) si `webrtcSupport=1`
- Log des requêtes WS (même UI pause/clear/expand que Snapmaker/FlashForge)
- Badge Online/Offline dans la grille et le side panel (ping WS léger 30 s TTL)

### Fichiers modifiés
| Fichier | Nature de la modification |
|---------|--------------------------|
| `renderer/inventory.js` | Section Creality (~300 lignes) : `_creConns`, `creKey`, `creIsOnline`, `crePingPrinter`, `creRefreshOnlineUI`, `renderCreOnlineBadge`, `creConnect`, `creOpenSocket`, `creScheduleReconnect`, `creDisconnect`, `creMergeStatus`, `creNotifyChange`, `renderCrealityLiveInner`, `creLogPush`, `renderCreLogInner` ; wiring dans `renderPrintersView`, `openPrinterDetail`, `closePrinterDetail`, `renderPrinterDetail` |
| `renderer/CODEMAP.md` | Entrée Creality dans bird's-eye + cookbook |
| `package.json` | version `1.4.14` → `1.4.15` |
| `DEVLOG.md` | Ce fichier |

### Notes techniques
- **Protocole Creality** : WebSocket `ws://$ip:9999`, request/response (pas push) — on envoie `{"method":"get","params":{"boxsInfo":1,...}}` et on re-poll toutes les 2 s
- **Probe live** : Ender-3 V4 à 192.168.40.106 répond en 7 845 octets JSON plat (tous les champs en root) — vérifié via socket Python
- **`state`** : 0=idle, 1=printing, 2=finished — mappé vers les clés i18n `snapState_*` existantes
- **Températures** : champs string dans le proto (`"25.880000"`) → `parseFloat()` systématique
- **CFS** : `cfsConnect: 0` sur Ender-3 V4 mono-extrudeur → grille absente ; activée si `cfsConnect: 1` + `materialBoxs[]` non vide
- **Caméra** : `webrtcSupport: 1` détecté sur l'Ender-3 V4 → iframe `http://$ip/webcam/webrtc` (identique Snapmaker/Crowsnest)
- **Thumbnail** : `http://$ip/downloads/original/current_print_image.png` (chemin fixe Creality pendant/après impression)
- **Helpers réutilisés** : `snapFmtDuration`, `snapFmtTempPair`, `SNAP_ICON_NOZZLE/BED/CLOCK`, `snapTextColor`, classes CSS `.snap-*`
- **Ping** : WS léger (open → marquer online → close immédiatement), 30 s TTL, même pattern que Snapmaker HTTP ping
- **Log buttons** : Pause/Clear/row-expand câblés dans le bloc `snapDelegated` de `renderPrinterDetail`

---

## 2026-05-08 — v1.4.14

### Demandes
- ADP : sélecteur Mono / Dual / Tri / Rainbow dans la bottom-sheet couleur
- Lien bidirectionnel mode couleur ↔ `id_aspect2` (252 Bicolor / 24 Tricolor / 145 Rainbow / 0 "-")
- Rainbow affiche le même dégradé lisse que dans l'inventaire (`linear-gradient`)
- Filtre "Type" dans la barre de recherche → rebrancher sur la version/protocole (TigerTag, TigerTag+, TigerTag Cloud)
- Effacer la search bar + filtres au changement de compte ou de vue ami

### Fichiers modifiés
| Fichier | Nature de la modification |
|---------|--------------------------|
| `renderer/inventory.js` | `_adpColorMode` + `_adpSlotCount()` + `_adpSetColorMode()` (remplace `_adpSetColorCount`), `_adpModeForAspect2()`, `_ADP_MODE_TO_ASPECT2`, listener aspect2 bidirectionnel, `_adpUpdateCircle()` Rainbow linear-gradient, `normalizeRow` champ `protocol`, `populateOneQuickFilter` → `filterAllVersions` + `pickValue: r.protocol`, filtre appliqué sur `r.protocol` (×2), `_clearSearchFilters()`, appels dans `switchToFriendView` / `switchBackToOwnView` / `switchAccountUI` |
| `renderer/inventory.html` | Sélecteur `data-mode` (Mono/Dual/Tri/Rainbow), slot row, `#typeFilter` → `filterAllVersions` |
| `renderer/css/60-modals.css` | `.adp-color-count-row`, `.adp-color-count-btn`, `.adp-color-slots-row`, `.adp-color-slot-btn` |
| `renderer/locales/*.json` | `colorCountMono/Dual/Tri/Rainbow`, `filterAllVersions` (9 locales) |
| `package.json` | version `1.4.13` → `1.4.14` |
| `README.md` | Section changelog v1.4.14 |
| `DEVLOG.md` | Ce fichier |

### Notes techniques
- `_adpColorMode` = "mono" | "dual" | "tri" | "rainbow" — dérivé en slot count via `_adpSlotCount()`
- Rainbow : `linear-gradient(90deg, c1, c2, c3)` — identique à `colorBg()` dans l'inventaire
- Dual : `linear-gradient(90deg, c1 50%, c2 50%)` (hard cut, pas de dégradé)
- Tri : `conic-gradient` 120° × 3 secteurs
- Boucle infinie évitée par `{ skipAspect2: true }` sur le listener aspect2
- `protocol` dans `normalizeRow` : Cloud → "TigerTag Cloud", sinon `versionName(id_tigertag)`
- `_clearSearchFilters()` remet aussi les `<select>` DOM à "" et retire `.is-active`

---

## 2026-05-07 — v1.4.13

### Demandes
- Custom product image (`url_img` + `url_img_user: true`) — DIY et Cloud uniquement
- Toolbox : bouton "Clear TD" (hold-to-confirm 1 200 ms) sur la ligne Scan TD
- Bouton TD1S dans le header du Add Product panel
- Stat tile "TigerTag Cloud" (violet) dans la barre KPI
- Titre de fenêtre en dark mode natif (`nativeTheme.themeSource = 'dark'`)
- Suppression de l'ombre OS de la fenêtre (`hasShadow: false`)
- Icône de mise à jour (orange spinning = téléchargement, vert brillant = prêt) à droite du nuage
- Fix : ombre des panels off-screen qui saignait dans le viewport
- Redesign barre URL image en pill unifiée (trigger à gauche, input au centre, ✓ à droite)
- Fix : barre blanche WebKit sur le focus de l'input URL

### Fichiers modifiés
| Fichier | Nature de la modification |
|---------|--------------------------|
| `renderer/inventory.js` | `customImgBar` pill (trigger + input + ok), `onUpdateStatus` + click handler icône update, toolbox Clear TD split-button, bouton TD1S dans ADP header |
| `renderer/inventory.html` | `#updateStatusIcon` ajouté dans `.top-status-icons` (dernier enfant) |
| `renderer/css/70-detail-misc.css` | `.custom-img-bar` pill CSS complet (collapsed → `.open` via `max-width` transition) ; `-webkit-appearance: none` sur l'input pour supprimer le focus ring blanc |
| `renderer/css/60-modals.css` | `.update-health-icon` + `.update-health.downloading` + `.update-health.ready` + `@keyframes updateSpin` |
| `renderer/css/50-snapmaker.css` | `.sfe-sheet` : `box-shadow` uniquement sur `.open` |
| `renderer/css/30-racks.css` | `.rp-side` : `box-shadow` uniquement sur `.is-open` |
| `renderer/css/00-base.css` | `.detail-panel` : `box-shadow` uniquement sur `.open` |
| `main.js` | `nativeTheme.themeSource = 'dark'` ; `hasShadow: false` dans BrowserWindow |
| `package.json` | version `1.4.12` → `1.4.13` |
| `README.md` | Section changelog v1.4.13 ajoutée |
| `ROADMAP.md` | ✅ Done mis à jour : custom image, Clear TD, Cloud tile, TD1S ADP, dark chrome, update icon, shadow fix |

### Notes techniques
- Le pill bar utilise `max-width` (pas `width`) pour animer depuis `auto` → transition fluide
- `box-shadow` sur panels cachés : toujours appliquer uniquement sur l'état `.open` / `.is-open` pour éviter le bleed hors viewport
- GitHub Actions se déclenche sur les tags `v*` uniquement — penser à `git tag vX.Y.Z && git push origin vX.Y.Z`
- `hasShadow: false` supprime l'ombre OS, pas les `box-shadow` CSS — deux mécanismes indépendants

---
