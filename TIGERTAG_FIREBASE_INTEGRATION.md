# TigerTag Firebase Integration — Guide for AI / Embedded Clients

This document explains how any client (ESP32, AI agent, backend service) can authenticate against the TigerTag Firebase project, read spool data, and update filament weights after a scale measurement.

---

## 1. Firebase Project Config

Fetch the public config (no credentials needed):

```
GET https://tigertag-cdn.web.app/__/firebase/init.json
```

Response shape:
```json
{
  "apiKey": "...",
  "authDomain": "...",
  "projectId": "tigertag-XXX",
  "storageBucket": "...",
  "messagingSenderId": "...",
  "appId": "..."
}
```

Store `apiKey` and `projectId` — you will need them for every subsequent call.

---

## 2. Authentication

### 2a. Email + Password (works on any HTTP client, including ESP32)

```
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={apiKey}
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secret",
  "returnSecureToken": true
}
```

Response:
```json
{
  "localId": "{uid}",
  "idToken": "{JWT — valid 1 hour}",
  "refreshToken": "{long-lived token — never expires unless revoked}"
}
```

Store `localId` (= Firebase UID), `idToken`, and `refreshToken`.

---

### 2b. Google Auth (requires a browser)

Google OAuth requires a browser redirect. On devices with a web interface (e.g. ESP32 serving a local page), use the Firebase JS SDK in the browser and POST the resulting tokens back to the device.

**In the browser page served by the device:**
```html
<script src="https://www.gstatic.com/firebasejs/9.x.x/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.x.x/firebase-auth-compat.js"></script>
<script>
async function authenticate() {
  const config = await fetch("https://tigertag-cdn.web.app/__/firebase/init.json").then(r => r.json());
  firebase.initializeApp(config);

  // Google Auth
  const provider = new firebase.auth.GoogleAuthProvider();
  await firebase.auth().signInWithPopup(provider);
  // OR: await firebase.auth().signInWithEmailAndPassword(email, password)

  const user  = firebase.auth().currentUser;
  const idToken      = await user.getIdToken();
  const refreshToken = user.refreshToken;

  // POST tokens to the local device
  await fetch("/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: user.uid, idToken, refreshToken })
  });
}
</script>
```

The device receives `uid`, `idToken`, and `refreshToken` on its local `/auth` endpoint and stores them in persistent storage (NVS on ESP32).

---

### 2c. Refresh the idToken (run every ~55 minutes, or on 401 error)

```
POST https://securetoken.googleapis.com/v1/token?key={apiKey}
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "{refreshToken}"
}
```

Response:
```json
{
  "id_token": "{new JWT}",
  "refresh_token": "{new refreshToken — replace the stored one}",
  "user_id": "{uid}"
}
```

Always replace both `idToken` and `refreshToken` with the new values.

If this call returns `TOKEN_EXPIRED` or `USER_DISABLED`, erase stored credentials and re-run the setup flow.

---

## 3. Firestore Data Structure

```
users/
  {uid}/                          ← Firebase Auth UID of the account owner
    displayName    string          ← user's chosen pseudo
    inventory/
      {spoolId}/                  ← document ID (auto-generated)
        uid               string  ← RFID tag UID (primary tag)
        twin_uid          string? ← RFID UID of the linked second tag (if any)
        weight_available  number  ← net filament weight in grams (what you write)
        container_weight  number  ← tare/container weight in grams (what you read)
        capacity          number  ← total spool capacity in grams
        container_id      string  ← references spools_filament.json
        id_brand          number
        id_material       number
        color_name        string
        last_update       number  ← Unix timestamp in milliseconds (what you write)
        deleted           boolean
```

---

## 4. Finding a Spool by Scanned RFID UID

The scale scans a physical RFID tag. Its UID maps to the `uid` field (primary) or `twin_uid` field (secondary) in an inventory document.

### Firestore REST — structured query

```
POST https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents:runQuery
Authorization: Bearer {idToken}
Content-Type: application/json

{
  "structuredQuery": {
    "from": [{ "collectionId": "inventory" }],
    "where": {
      "fieldFilter": {
        "field": { "fieldPath": "uid" },
        "op": "EQUAL",
        "value": { "stringValue": "{scanned_rfid_uid}" }
      }
    },
    "limit": 1
  }
}
```

**Base path** for the query:
```
/v1/projects/{projectId}/databases/(default)/documents/users/{uid}:runQuery
```

This searches only within the authenticated user's inventory.

If no document is found with `uid == scanned_rfid_uid`, run the same query with `twin_uid` instead:
```json
"field": { "fieldPath": "twin_uid" },
"value": { "stringValue": "{scanned_rfid_uid}" }
```

A successful response returns an array; the first element has a `document` key containing the full document with its `name` path and `fields`.

---

## 5. Weight Calculation

```
weight_available = measured_raw_weight - container_weight
```

- `measured_raw_weight` — total weight read from the scale (spool + filament + container), in grams
- `container_weight` — read from `fields.container_weight.integerValue` (or `doubleValue`) in the Firestore document
- `weight_available` — net filament mass to write back, in grams (minimum 0)

```
weight_available = max(0, measured_raw_weight - container_weight)
```

---

## 6. Updating Weight in Firestore

```
PATCH https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/users/{uid}/inventory/{spoolId}?updateMask.fieldPaths=weight_available&updateMask.fieldPaths=last_update
Authorization: Bearer {idToken}
Content-Type: application/json

{
  "fields": {
    "weight_available": { "integerValue": 450 },
    "last_update":      { "integerValue": 1714500000000 }
  }
}
```

- `{spoolId}` — the document ID extracted from the `name` field of the query result (last path segment)
- `last_update` — current Unix timestamp in **milliseconds** (`Date.now()` equivalent)
- Use `updateMask` to avoid overwriting other fields

---

## 7. Complete Scale Logic — 1 or 2 RFID Tags

```
SCALE READS 1 or 2 RFID UIDs
          │
          ▼
For each scanned UID:
  Query inventory where uid == scanned_uid
    └─ Not found? Query where twin_uid == scanned_uid
  → Resolve to spoolDocument + spoolId
          │
          ▼
┌─────────────────────────────────────────────────────┐
│  CASE A — 2 UIDs scanned                           │
│                                                     │
│  UID_1 → spoolDoc_1  (weight_available_1 = W - CW1)│
│  UID_2 → spoolDoc_2  (weight_available_2 = W - CW2)│
│                                                     │
│  If UID_1 and UID_2 resolve to the SAME document   │
│  (primary + twin of the same spool):               │
│    → write once, use the document's container_weight│
│                                                     │
│  If they resolve to 2 different documents:         │
│    → write each independently                       │
│    (two separate spools on the scale simultaneously)│
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  CASE B — 1 UID scanned                            │
│                                                     │
│  UID_1 → spoolDoc                                   │
│  weight_available = W - spoolDoc.container_weight   │
│  → PATCH spoolDoc (weight_available + last_update)  │
│                                                     │
│  spoolDoc.twin_uid is set?                          │
│    └─ YES → Query inventory where uid == twin_uid   │
│             → Resolve twinDoc + twinSpoolId         │
│             → PATCH twinDoc with same               │
│               weight_available + last_update        │
└─────────────────────────────────────────────────────┘
```

### Twin tag — resolving the linked document

If only one tag was scanned but `twin_uid` is present in the resolved document:

```
GET https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/users/{uid}/inventory:runQuery
Authorization: Bearer {idToken}

→ structuredQuery where uid == {twin_uid from spoolDoc}
→ resolve twinSpoolId
→ PATCH same weight_available + last_update
```

---

## 8. Alternative — TigerTag CDN API (simpler, no Firestore auth needed)

If you only need to update weight by RFID UID and have an API key:

```
GET https://cdn.tigertag.io/setSpoolWeightByRfid?ApiKey={key}&uid={rfid_uid}&weight={grams}
```

- `uid` — RFID tag UID (primary or twin)
- `weight` — **net filament weight** (already subtracted container), in grams
- The API handles twin tag propagation server-side

This does not require Firebase Auth — only the user's TigerTag API key.

---

## 9. Full Boot Sequence (ESP32 / embedded client)

```
1. Boot
2. Connect to WiFi
3. Read NVS: refreshToken, uid, apiKey, projectId
4. NVS empty? → Serve setup page → wait for /auth POST → store tokens → continue
5. POST securetoken.googleapis.com → get fresh idToken
6. Start scale loop:
     a. Read RFID tag(s)
     b. Read scale weight (raw grams)
     c. For each UID → query Firestore → get spoolId + container_weight
     d. Compute weight_available = raw - container_weight (min 0)
     e. PATCH Firestore: weight_available + last_update (now in ms)
     f. If 1 UID and twin_uid present → resolve twin → PATCH twin doc
7. Refresh idToken every 55 min (or on any 401 response)
```

---

## 10. Error Handling

| HTTP status | Meaning | Action |
|-------------|---------|--------|
| `401` | idToken expired | Refresh token → retry |
| `403` | Wrong UID or Security Rules | Check uid matches authenticated user |
| `404` | Document not found | RFID tag not registered in this account |
| `TOKEN_EXPIRED` on refresh | refreshToken invalid | Erase NVS → re-run setup |
| `USER_DISABLED` | Account suspended | Show error to user |
| No WiFi | Can't reach Firebase | Retry loop, do not erase NVS |

---

## 11. Firestore Field Types — Reference

When writing to Firestore REST, integer values must use `integerValue` (string-encoded), floats use `doubleValue`:

```json
{
  "fields": {
    "weight_available": { "integerValue": "450" },
    "last_update":      { "integerValue": "1714500000000" }
  }
}
```

When reading, check both `integerValue` and `doubleValue` since the field type depends on what was written previously.
