# TigerTag Studio Manager — Claude reference

## Stack
Electron (no bundler) + vanilla HTML/CSS/JS. Entry: `main.js`. Renderer: `renderer/inventory.html` + `renderer/inventory.css` + `renderer/inventory.js`. Preload bridge: `preload.js`.

## File map
```
renderer/
  inventory.html   — pure markup + modals
  inventory.css    — all styles
  inventory.js     — all application logic (IIFE)
  locales/         — en.json fr.json de.json es.json it.json zh.json pt.json pt-pt.json
data/
  id_brand.json id_material.json id_aspect.json id_type.json
  id_diameter.json id_measure_unit.json id_version.json
  container_spool/spools_filament.json
assets/svg/
  tigertag_logo.svg  tigertag_logo_contouring.svg
```

## LocalStorage keys
| Key | Content |
|-----|---------|
| `tigertag.accounts` | `Account[]` JSON array |
| `tigertag.activeAccount` | active account id string |
| `tigertag.inv.<id>` | cached inventory JSON for that account |
| `tigertag.view` | `"table"` \| `"grid"` |
| `tigertag.lang` | `"en"` \| `"fr"` \| `"de"` \| `"es"` \| `"it"` \| `"zh"` \| `"pt"` \| `"pt-pt"` |
| `tigertag.sidebar` | `"collapsed"` \| `"expanded"` |
| `tigertag.panelWidth.detail` | detail panel width in px (user-resized) |
| `tigertag.panelWidth.debug` | debug panel width in px (user-resized) |

## Account object shape
```js
{ id: uid, email, displayName, photoURL, lang, color?, customColor? }
```
- `displayName` — user's chosen pseudo (from Firestore `users/{uid}.displayName`), never the Google real name
- `lang` — per-account language preference, synced with Firestore `users/{uid}/prefs/app.lang`

## API base
`https://cdn.tigertag.io` — endpoints: `/healthz/`, `/setSpoolWeightByRfid?ApiKey=&uid=&weight=`

---

## Firebase integration

### SDK config (public)
```
https://tigertag-cdn.web.app/__/firebase/init.json
```
Third-party apps can fetch this URL to get the Firebase project config and call `firebase.initializeApp(config)`. Authentication is required — users must sign in with their TigerTag account. The config is intentionally public (standard Firebase pattern); security is enforced server-side via Firestore Security Rules.

### Firestore data structure
```
users/
  {uid}/
    displayName   string   — user's chosen pseudo
    googleName    string   — real name from Google Auth (admin reference only, never displayed)
    firstName     string   — first word of googleName
    lastName      string   — remainder of googleName
    email         string
    roles         string   — "admin" | undefined
    Debug         boolean  — debug mode enabled
    
    inventory/
      {spoolId}/            — one document per spool
        uid                 string   — RFID tag UID
        id_brand            number
        id_material         number
        color_name          string
        online_color_list   string[] — hex colors
        weight_available    number   — grams net
        container_weight    number   — grams
        container_id        string   — references data/container_spool/spools_filament.json
        capacity            number   — total spool capacity in grams
        last_update         number   — timestamp ms
        deleted             boolean
        deleted_at          number?
        twin_uid            string?  — linked RFID tag UID
        
    prefs/
      app/
        lang      string   — language code, synced across devices
```

### Connecting from a third-party app
```js
// 1. Fetch config
const config = await fetch("https://tigertag-cdn.web.app/__/firebase/init.json").then(r => r.json());
firebase.initializeApp(config);

// 2. Sign in (user must have a TigerTag account)
await firebase.auth().signInWithEmailAndPassword(email, password);
// or: firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider())

// 3. Read inventory
const uid = firebase.auth().currentUser.uid;
const snap = await firebase.firestore()
  .collection("users").doc(uid)
  .collection("inventory")
  .get();
snap.forEach(doc => console.log(doc.id, doc.data()));

// 4. Update spool weight
await firebase.firestore()
  .collection("users").doc(uid)
  .collection("inventory").doc(spoolId)
  .update({ weight_available: 450, last_update: Date.now() });
```

---

## Debug mode

Debug mode gives access to the **Debug panel** (Firestore explorer + API inspector). It is off by default and can only be activated by users with `roles: "admin"` in their Firestore user document.

### Activating debug mode
1. In the Firestore console, set `users/{uid}.roles = "admin"` for the target user
2. The user opens their account modal (click avatar → edit)
3. A **Debug mode** toggle appears — flip it ON
4. The toggle writes `Debug: true` to `users/{uid}` in Firestore
5. The `⌥ Open debug panel` button appears in the sidebar immediately

### Deactivating debug mode
Same toggle → OFF, or set `users/{uid}.Debug = false` directly in Firestore.

### What debug mode exposes
- **API tab** — last HTTP request & response to `cdn.tigertag.io`
- **Firestore tab** — path explorer: type any Firestore path, click Fetch, copy JSON result to clipboard. Quick-access chips for `user doc`, `prefs`, `inventory`, `printers`, `tags`

### Security note
`roles` and `Debug` fields should only be writable via Firebase Admin SDK / Cloud Function — never by the client. Firestore Security Rules must prevent users from writing these fields themselves. *(Rules implementation pending.)*

---

## Key JS patterns

### i18n
`t(key, params?)` — looks up `state.i18n[state.lang][key]`, falls back to `en`, then key itself.
Supports: plain string, `{{param}}` interpolation, `["array"]` random pick, `{"one":"…","other":"…"}` plurals (`params.n`).
`applyTranslations()` — applies `[data-i18n]`, `[data-i18n-placeholder]`, `.lang-btn.active`.

### Modals
All modals: `.modal-overlay` + `.modal-card`, toggled via `.open` class. Backdrop blur + spring animation.
- `#addAccountModalOverlay` — login / create account (Firebase Auth)
- `#editAccountModalOverlay` — edit active account (openEditAccountModal / closeEditAccountModal)
- `#containerPickerOverlay` — pick a spool container (openContainerPicker / closeContainerPicker)
- `#profilesModalOverlay` — manage multiple accounts

### Resizable panels
Both `#detailPanel` and `#debugPanel` are resizable via a drag handle on their left edge.
`makePanelResizable(panelEl, handleEl, storageKey)` — handles drag + localStorage persistence.
Width is restored on page load. Min: 280 px, max: 85 vw.

### Health indicator
`#health` cloud icon in the sidebar. State driven by Firestore `{ includeMetadataChanges: true }`:
- `snapshot.metadata.fromCache === false` → green (live)
- `snapshot.metadata.fromCache === true` → red (offline / cache)
- Disconnected → neutral (idle)

Lazy ping: on `mouseenter`, fires one `fetch` to `/healthz/` and updates the tooltip with measured RTT (`Backend: ok — 47 ms`). Zero background polling.

### Weight slider auto-save
The weight slider in the detail panel debounces writes to Firestore: after **500 ms of inactivity** the value is committed automatically. The fill bar pulses (`.wb-saving` class) during the debounce window. Clicking "Update" cancels the pending debounce and saves immediately. Closing the panel cancels any pending save.

### State
```js
state = {
  inventory,        // raw Firestore docs { [spoolId]: data }
  rows,             // normalizeRow() output array
  selected,         // open detail panel spoolId
  keyValid,
  displayName,      // user's pseudo
  showDeleted,
  search,
  viewMode,         // "table" | "grid"
  lang,
  sortCol, sortDir,
  activeAccountId,
  i18n,
  imgCache,
  invLoading,       // true while waiting for first Firestore snapshot
  isAdmin,          // from users/{uid}.roles === "admin"
  debugEnabled,     // from users/{uid}.Debug (admin only)
  db                // { brand, material, aspect, type, diameter, unit, version, containers }
}
```

### Auth flow
`onAuthStateChanged` → `setConnected()` → load localStorage cache → `subscribeInventory(uid)` → `syncLangFromFirestore(uid)` → `syncUserDoc(uid)`

`syncUserDoc(uid)` reads `users/{uid}`, applies:
- `displayName` (pseudo) → sidebar, localStorage (priority over Google Auth name)
- `roles` → `state.isAdmin`
- `Debug` → `state.debugEnabled` → shows/hides `#btnDebug`

Google real name (`user.displayName` from Firebase Auth) is saved to Firestore as `googleName` / `firstName` / `lastName` for admin reference but **never displayed in the UI**.

### Container picker
`openContainerPicker(r)` — opens `#containerPickerOverlay` with all 46 containers from `data/container_spool/spools_filament.json`, filtered by search. Selecting one writes `container_id` + `container_weight` to Firestore `users/{uid}/inventory/{spoolId}`. onSnapshot propagates the change automatically.

---

## i18n keys — complete reference
Do NOT re-read locale JSON files; use this table instead. All **8 locales** (en/fr/de/es/it/zh/pt/pt-pt) have every key below.

### App / status
| Key | Purpose |
|-----|---------|
| `appSubtitle` | Header subtitle |
| `backendIdle` | Health tooltip idle |
| `backendOk` | Health tooltip ok (also used with `— N ms` suffix) |
| `backendErr` | Health tooltip error `{{n}}` |
| `backendOffline` | Health tooltip offline |
| `rfidConnected` | RFID label `{{name}}` |
| `rfidNoReader` | RFID no reader |
| `rfidScanned` | RFID scanned `{{uid}}` |
| `rfidNotFound` | RFID unknown UID `{{uid}}` |
| `welcomeBack` | Array of random greeting strings |

### Community / links
| Key | Purpose |
|-----|---------|
| `githubBtn` | GitHub button |
| `discordBtn` | Discord button |
| `mobileApp` | QR label |
| `mobileScan` | QR sub-label |

### Settings panel
| Key | Purpose |
|-----|---------|
| `settingsOpenBtn` | Settings button label |
| `settingsTitle` | Panel title |
| `settingsAccount` | Account tab label |
| `settingsData` | Data & Export tab label |
| `settingsLang` | Language section label |
| `settingsDebug` | Debug tab label |
| `settingsSave` | Save & reload button |
| `settingsApiLink` | Export URL field label |
| `settingsExport` | Download JSON button |
| `settingsCopied` | Copy confirmation |
| `debugOpenBtn` | Open debug panel button |

### Account management
| Key | Purpose |
|-----|---------|
| `addAccountLabel` | Add account button / modal title |
| `addAccountSave` | Add & load (legacy, kept) |
| `addAccountAuthError` | Friendly error for invalid email/API key |
| `editAccountTitle` | Edit account modal title |
| `btnSignIn` | Sign in button |
| `btnEditAccount` | Edit account button |
| `btnDisconnect` | Disconnect button |
| `btnRefresh` | Refresh button |
| `btnSwitchAccount` | Switch account button |
| `noAccounts` | Empty accounts message |
| `accountActive` | "Active" badge |
| `btnActivate` | Switch button for other accounts |
| `btnDeleteAccount` | Trash button tooltip |
| `btnEditApiKey` | Edit API key (legacy) |
| `btnUpdateApiKey` | Update button in edit-account modal |
| `cancelAddAccount` | Cancel label |
| `otherAccounts` | "Other accounts" heading |
| `confirmDeleteAccount` | (legacy) |
| `delModalTitle` | Disconnect modal title |
| `delModalWarn` | Disconnect modal warning |
| `cancelLabel` | Cancel button in modals |
| `displayNameLabel` | Display name field label in edit-account modal |

### Login modal
| Key | Purpose |
|-----|---------|
| `loginSignInTitle` | Modal title (sign-in mode) |
| `loginSignInSubtitle` | Modal subtitle (sign-in mode) |
| `loginCreateTitle` | Modal title (create account mode) |
| `loginCreateSubtitle` | Modal subtitle (create account mode) |
| `loginGoogle` | Google sign-in button |
| `loginOr` | Separator label |
| `loginEmailPlaceholder` | Email input placeholder |
| `loginPasswordPlaceholder` | Password input placeholder |
| `loginConfirmPasswordPlaceholder` | Confirm password placeholder |
| `loginForgotPassword` | Forgot password link |
| `loginRememberMe` | Stay signed in checkbox |
| `loginNoAccount` | "Don't have an account?" |
| `loginCreateAccount` | "Create account" toggle button |
| `loginHaveAccount` | "Already have an account?" |
| `loginResetSent` | Password reset email sent confirmation |
| `loginPasswordMismatch` | Passwords don't match error |
| `loginPasswordTooShort` | Password too short error |
| `loginAccountCreated` | Account created confirmation |
| `loginEmailInUse` | Email already registered error |

### Credentials card
| Key | Purpose |
|-----|---------|
| `credTitle` | Section title |
| `credEmail` | Email label |
| `credApiKey` | API Key label |
| `credStatus` | Status label |
| `statusUntested` | Badge: untested |
| `statusValid` | Badge: valid |
| `statusInvalid` | Badge: invalid |
| `statusChecking` | Badge: checking… |
| `btnLoadInv` | Load inventory button |
| `btnTestKey` | Test API key button |
| `btnClearSaved` | Clear saved data button |

### Inventory / filters
| Key | Purpose |
|-----|---------|
| `invTitle` | Section title |
| `btnViewTable` | Table view button |
| `btnViewGrid` | Grid view button |
| `btnShowDeleted` | Show deleted toggle |
| `btnHideDeleted` | Hide deleted toggle |
| `btnExport` | Export JSON button |
| `searchPlaceholder` | Search input placeholder |
| `noInventory` | Empty state: no inventory |
| `noMatch` | Empty state: no match |
| `invLoading` | Loading spinner label |

### Stats
| Key | Purpose |
|-----|---------|
| `statActive` | Active spools label (full) |
| `statPlus` | TigerTag+ label |
| `statDiy` | TigerTag label |
| `statTotal` | Total available label |
| `statActiveMini` `statPlusMini` `statDiyMini` `statTotalMini` | Collapsed sidebar labels |

### Table headers
`thUid` `thType` `thMaterial` `thBrand` `thColor` `thName` `thWeight` `thCapacity` `thUpdated`

### Debug panel
| Key | Purpose |
|-----|---------|
| `debugLabel` | Panel title |
| `debugSubtitle` | Panel subtitle |
| `debugNoReqs` | Empty state |

### Detail panel — sections
`sectionColors` (plural object) `sectionPrint` `sectionWeight` `sectionLinks` `sectionContainer` `sectionDetails` `sectionRaw`

### Detail panel — print settings
`lbNozzle` `lbBed` `lbDryTemp` `lbDryTime` `lbDensity`

### Weight section
| Key | Purpose |
|-----|---------|
| `weightTotal` | Total capacity `{{cap}}` |
| `weightContainer` | Container weight `{{cw}}` (also used as change-container trigger label) |
| `weightOk` | Success result `{{wa}} {{w}} {{cw}}` |
| `weightOkTwin` | Twin updated suffix |
| `weightErr` | Error result `{{r}}` |
| `weightErrComputed` | Computed weight suffix `{{c}}` |
| `rawScaleLabel` | Raw scale input label |
| `rawScaleHint` | Raw scale hint text |
| `btnUpdate` | Update weight button |
| `btnEditManually` | Toggle manual input |
| `btnCloseManual` | Close manual input |
| `enterNumeric` | Validation error |

### Container picker
| Key | Purpose |
|-----|---------|
| `containerPickerTitle` | Modal title |
| `btnChangeContainer` | Change button label / tooltip |

### Feedback / errors
| Key | Purpose |
|-----|---------|
| `loadedSpools` | Plural `{{n}}` |
| `invError` | Inventory load error `{{r}}` |
| `invalidKey` | Key validation error `{{r}}` |
| `networkError` | Generic network error |

### Links (detail panel)
`linkYt` `linkFood`

### Detail rows
`detUid` `detSeries` `detBrand` `detMaterial` `detDiameter` `detTagType` `detSku` `detBarcode` `detContainer` `detTwin` `detUpdated` `detManufactured`

### Badges
`badgeRefill` `badgeRecycled` `badgeFilled` `badgeDeleted`

### Auto-update
`updateDownloading` `updateReady` `btnRestartUpdate`

### Twin tag
`twinBadge` `twinTitle` `twinTabThis` `twinTabTwin`

### Time ago
`agoNow` `agoMin {{n}}` `agoHour {{n}}` `agoDay {{n}}` `agoMonth {{n}}` `agoYear {{n}}` (object with one/other in most locales)

---

## Rules
- **i18n**: always add all **8** translations (en/fr/de/es/it/zh/pt/pt-pt) in the same edit batch — never add a key to only one locale.
- **Commits**: no `Co-Authored-By` line.
- **JS**: all logic lives in `inventory.js`. Do not inline JS in `inventory.html`.
- **CSS**: all styles in `inventory.css`. Scoped to `#editAccountModalOverlay`, `#addAccountModalOverlay`, etc. where needed.
- **displayName**: always read from Firestore `users/{uid}.displayName` (pseudo). Never use Firebase Auth `user.displayName` for UI display — it contains the Google real name.
- **Admin fields**: `roles` and `Debug` in `users/{uid}` must only be written via Firebase Admin SDK / Cloud Function. The client toggle is a UX convenience for admins already authenticated.
