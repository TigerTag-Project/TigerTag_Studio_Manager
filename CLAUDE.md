# Tiger Studio Manager — Claude reference

## ⚡ Token efficiency — read this first

Every file read and grep costs tokens. Follow these rules on every task to keep context lean:

| Do | Don't |
|----|-------|
| Read `CODEMAP.md` → jump to the exact line range | Read `inventory.js` from the top |
| `grep -n "anchorFn"` → read only that range (`offset`/`limit`) | Read an entire 1000-line file to find one function |
| Re-use content already in context this session | Re-read a file you read 2 messages ago |
| `Read` with `offset`+`limit` to fetch the exact slice | `Read` without limits on files > 200 lines |
| `Edit` with the minimal `old_string` that is unique | Rewrite whole sections when only 3 lines change |
| Run `grep` + `Read` in parallel when targets are independent | Sequential read-then-grep round-trips |
| Check `CODEMAP.md` line ranges before any `inventory.js` read | Blind grep across the 15 000-line file |

**Workflow for any `inventory.js` change:**
1. `CODEMAP.md` → find section + anchor function name
2. `grep -n "anchorFn"` → get exact line number
3. `Read offset=N limit=40` → confirm context, draft edit
4. `Edit` minimal diff

**Workflow for any CSS change:**
1. Identify the right file from the file map (00-base → 70-detail-misc)
2. `grep -n "selector"` in that file → get line
3. `Read offset=N limit=20` → confirm, then `Edit`

> Warn the user when context is getting large (> ~60 k tokens used) so they can start a new session before quality degrades.

**Model fit — signal proactively, don't wait to be asked:**
- **Tâche simple** (CSS tweak, i18n key, valeur à changer, question courte) → suggérer de passer sur **claude-haiku** ou **claude-sonnet** pour économiser. Formulation : *"Cette tâche est simple — tu peux la faire sur Sonnet/Haiku pour économiser des tokens."*
- **Tâche complexe** (refacto multi-fichiers, nouveau système, débogage multi-couches, architecture) → si tu sens que le raisonnement manque de profondeur ou que tu te trompes, demander de passer sur **claude-opus**. Formulation : *"Cette tâche est complexe — passer sur Opus donnera un meilleur résultat."*
- Ne pas attendre que l'utilisateur remarque un problème : signaler dès que le mismatch est évident.

## Stack
Electron (no bundler) + vanilla HTML/CSS/JS. Entry: `main.js`. Renderer: `renderer/inventory.html` + modular CSS in `renderer/css/` + `renderer/inventory.js`. Preload bridge: `preload.js`.

> **`renderer/CODEMAP.md`** maps every feature in the 12k-line `inventory.js` to a line range and key function names. Read it BEFORE searching the file — it's faster, cheaper, and less error-prone than grepping. Keep it in sync when you move sections.
>
> **`ROADMAP.md`** at the repo root holds the "what's done / next / backlog" picture grouped by domain. Read it BEFORE proposing new features — chances are it's already there with a sizing and risk note. Update it when you ship or pick up an item.

## File map
```
renderer/
  inventory.html   — pure markup + modals
  inventory.js     — all application logic (IIFE) — see CODEMAP.md for line ranges
  CODEMAP.md       — feature → line range index for inventory.js (read first, grep last)
  css/             — split inventory styles, loaded in order via 8 <link> tags
    00-base.css         — root vars, reset, sidebar, header, app-layout
    10-settings.css     — Settings panel
    20-friends.css      — Friends slide-in panel
    30-racks.css        — Storage / rack inventory view + drag-drop + unranked panel
    40-printers.css     — Printers list view + add/scan/manual modals + side panel
    50-snapmaker.css    — Snapmaker live block + filament edit bottom-sheet
    60-modals.css       — Rack-edit / friend / account / login / alert modals
    70-detail-misc.css  — icons, stats, table/grid, detail panel, debug, twin-link, toolbox, TD edit, TD1S, display-name
  locales/         — en.json fr.json de.json es.json it.json zh.json pt.json pt-pt.json pl.json
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
| `tigertag.lang` | `"en"` \| `"fr"` \| `"de"` \| `"es"` \| `"it"` \| `"zh"` \| `"pt"` \| `"pt-pt"` \| `"pl"` |
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
publicKeys/
  {key}/                    — key = public code e.g. "4X7-K3M" (XXX-XXX format)
    uid         string      — owner uid
    claimedAt   timestamp   — when claimed

userProfiles/
  {uid}/                    — public profile, readable by all authenticated users
    publicKey   string      — same as publicKeys entry (denormalised for display)
    displayName string      — user's chosen pseudo
    isPublic    boolean     — whether inventory is publicly visible
    (color fields for avatar)

users/
  {uid}/
    displayName   string   — user's chosen pseudo
    googleName    string   — real name from Google Auth (admin reference only, never displayed)
    firstName     string   — first word of googleName
    lastName      string   — remainder of googleName
    email         string
    roles         string   — "admin" | undefined
    Debug         boolean  — debug mode enabled
    publicKey     string   — discovery code XXX-XXX (also in publicKeys/{key})
    privateKey    string   — 40-char hex access token (used by Firestore rules)
    isPublic      boolean  — inventory publicly visible
    
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

    friends/
      {friendUid}/
        displayName string
        addedAt     timestamp
        key         string   — friend's privateKey at time of accept (used to verify access)

    friendRequests/
      {requesterUid}/
        displayName string
        requestedAt timestamp
        key         string   — requester's privateKey (used for bidirectional accept)

    blacklist/
      {blockedUid}/
        displayName string
        blockedAt   timestamp
        
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
- `#friendsPanel` + `#friendsOverlay` — dedicated Friends slide-in panel (openFriends / closeFriends)
- `#addFriendOverlay` — add friend by code (split field `[XXX]—[XXX]`, auto-advance on 3 chars)
- `#friendRequestOverlay` — incoming request modal (accept / refuse / block)

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
  publicKey,        // user's discovery code XXX-XXX (from users/{uid}.publicKey)
  privateKey,       // user's 40-char hex access token (from users/{uid}.privateKey)
  isPublic,         // whether inventory is publicly visible (from users/{uid}.isPublic)
  friends,          // [{ uid, displayName, addedAt, key }]
  friendRequests,   // [{ uid, displayName, requestedAt, key }]
  db                // { brand, material, aspect, type, diameter, unit, version, containers }
}
```

### Auth flow
`onAuthStateChanged` → `setConnected()` → load localStorage cache → `subscribeInventory(uid)` → `syncLangFromFirestore(uid)` → `syncUserDoc(uid)`

`syncUserDoc(uid)` reads `users/{uid}`, applies:
- `displayName` (pseudo) → sidebar, localStorage (priority over Google Auth name)
- `roles` → `state.isAdmin`
- `Debug` → `state.debugEnabled` → shows/hides `#btnDebug`
- `publicKey` / `privateKey` → `state.publicKey` / `state.privateKey` (generated via `claimPublicKey` on first login if missing)
- `isPublic` → `state.isPublic`

Google real name (`user.displayName` from Firebase Auth) is saved to Firestore as `googleName` / `firstName` / `lastName` for admin reference but **never displayed in the UI**.

### Friends system
- **`publicKey`** (`XXX-XXX` format) — discovery code shared with friends. Stored in both `users/{uid}.publicKey` and `publicKeys/{key}.uid`. Lookup is O(1) by document ID.
- **`privateKey`** (40-char hex) — access token. Stored in `users/{uid}.privateKey` and copied into each friend's `friends/{uid}.key`. Firestore rules grant inventory read access if `friends/{uid}.key == users/{uid}.privateKey`.
- **`claimPublicKey(uid, oldKey)`** — atomic transaction: generates `XXX-XXX`, checks `publicKeys/{candidate}` doesn't exist, writes it. Retries up to 10 times. Deletes `oldKey` after success.
- **Bidirectional friendship**: when Alice accepts Bob's request, a batch writes to both `users/alice/friends/bob` (key=alice.privateKey) and `users/bob/friends/alice` (key=bob.privateKey from request doc). Removal also deletes from both sides.
- **`openFriends()`** — auto-generates a publicKey if `state.publicKey` is null before opening the panel.

### Container picker
`openContainerPicker(r)` — opens `#containerPickerOverlay` with all 46 containers from `data/container_spool/spools_filament.json`, filtered by search. Selecting one writes `container_id` + `container_weight` to Firestore `users/{uid}/inventory/{spoolId}`. onSnapshot propagates the change automatically.

---

## i18n keys — complete reference
Do NOT re-read locale JSON files; use this table instead. All **9 locales** (en/fr/de/es/it/zh/pt/pt-pt/pl) have every key below.

### Adding new keys — use the helper script
**Never edit the 9 locale files by hand.** Use `npm run i18n:add` instead — it writes every locale in one shot, validates JSON, and falls back to the EN value when a translation is missing.

```bash
# Append at end of every locale file
npm run i18n:add -- myKey en="Hello" fr="Bonjour" de="Hallo" es="Hola" it="Ciao" zh="你好" pt="Olá" pt-pt="Olá" pl="Cześć"

# Insert just after an existing key (keeps related keys grouped)
npm run i18n:add -- myKey --after toolboxTitle en="Hello" fr="Bonjour" ...

# JSON payload form (handy for programmatic use)
npm run i18n:add -- myKey --json '{"en":"Hello","fr":"Bonjour"}'
```

Behaviour:
- Updates the value in-place if the key already exists (preserves order).
- Missing locales fall back to the EN value with a stderr warning.
- Re-parses every file after write — aborts the entire run if any output isn't valid JSON.
- Source: `scripts/i18n-add.mjs`.

### Consistency check (auto-run on every commit)
A pre-commit hook runs `npm run i18n:check` automatically — the commit is blocked if the 9 locale files drift apart. Activated by the `prepare` npm script which sets `core.hooksPath=.githooks/`. To run manually:

```bash
npm run i18n:check
# → "OK — 9 locales × N keys, all consistent." (exit 0)
# or a per-file list of missing/extra/empty/type-mismatch issues (exit 1)
```

What it checks:
- Every locale file parses as valid JSON.
- Same key set as `en.json` (no missing, no extras).
- Same value type per key (plural objects stay plural objects, etc.).
- No empty string values.

To bypass once (don't): `git commit --no-verify`.
Source: `scripts/check-i18n-consistency.mjs` + `.githooks/pre-commit`.

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

### Friends system
| Key | Purpose |
|-----|---------|
| `friendsTitle` | Section title / sidebar button label |
| `friendsMyCode` | "My code" label above publicKey display |
| `friendsPublicLabel` | Public inventory toggle label |
| `friendsPublicSub` | Toggle sub-label ("Visible to everyone") |
| `friendsList` | "My friends" section heading |
| `friendsEmpty` | Empty state when no friends |
| `friendsAdd` | Add friend button |
| `friendRemove` | Remove friend button on each row |
| `friendReqSub` | Subtitle on incoming request modal ("wants to view your inventory") |
| `friendReqBlock` | Block button on request modal |
| `friendReqRefuse` | Decline button on request modal |
| `friendReqAccept` | Accept button on request modal |
| `addFriendTitle` | Add friend modal title |
| `addFriendSub` | Add friend modal subtitle |
| `addFriendSend` | Send request button |
| `friendSearching` | Preview state: searching |
| `friendNotFound` | Preview state: no user found |
| `friendSelf` | Preview state: own code entered |
| `friendRequestSent` | Success message after sending |
| `friendRegenConfirm` | (kept in locales, no longer used in UI — reserved) |

---

## Rules
- **i18n**: always add all **9** translations (en/fr/de/es/it/zh/pt/pt-pt/pl) in the same edit batch. **Use `npm run i18n:add` — do NOT hand-edit the locale JSON files.** See the *Adding new keys* section above for syntax.
- **Commits**: no `Co-Authored-By` line.
- **JS**: all logic lives in `inventory.js`. Do not inline JS in `inventory.html`.
- **CSS**: split across `renderer/css/00-base.css … 70-detail-misc.css` (loaded in numeric order). Add new rules in the section file that matches the feature — e.g. Snapmaker tweaks go in `50-snapmaker.css`, modal tweaks in `60-modals.css`. Asset URLs use `url('../../assets/svg/icons/…')` (two `..` because we're in `renderer/css/`). Scoped IDs (`#editAccountModalOverlay`, `#addAccountModalOverlay`, etc.) still apply where needed.
- **displayName**: always read from Firestore `users/{uid}.displayName` (pseudo). Never use Firebase Auth `user.displayName` for UI display — it contains the Google real name.
- **Admin fields**: `roles` and `Debug` in `users/{uid}` must only be written via Firebase Admin SDK / Cloud Function. The client toggle is a UX convenience for admins already authenticated.

## CSS coding standards

### SVG icons via `-webkit-mask-image`
Always constrain **one dimension only** and derive the other from the SVG's intrinsic `viewBox` ratio using `aspect-ratio`. Never hard-code both `width` and `height` — doing so silently distorts the icon if the SVG is ever edited.

```css
/* ✅ correct — only height forced, width auto-derived */
.my-icon {
  height: 18px;
  aspect-ratio: 52 / 22; /* viewBox="0 0 52 22" */
  background-color: var(--muted);
  -webkit-mask-image: url('../../assets/svg/icons/icon_foo.svg');
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
}

/* ❌ wrong — both dimensions hard-coded, ratio broken if SVG changes */
.my-icon { width: 40px; height: 18px; … }
```

To find the ratio: `head -1 assets/svg/icons/icon_foo.svg` → read `viewBox="0 0 W H"` → use `aspect-ratio: W / H`.

### CSS specificity
When a global rule (e.g. `input[type="text"]` — specificity 0,1,1) overrides a class rule (0,1,0), **double the class selector** to reach 0,2,0 rather than adding `!important`:
```css
/* beats input[type="text"] without !important */
.my-sheet .my-input { background: transparent; }
```

### Hold-to-confirm buttons
Use `setupHoldToConfirm(el, durationMs, callback)`. The element must contain a `<span class="hold-progress"></span>` child. Duration guideline: 1200 ms for reversible actions, 1500 ms for hard-destructive (delete/unlink).
