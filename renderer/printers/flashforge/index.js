/**
 * printers/flashforge/index.js — FlashForge HTTP integration (cleartext POST polling).
 *
 * Ported from the Flutter FlashforgeHttpPage.
 * HTTP polling on port 8898 (/detail + /control), 2s cadence.
 * Self-registers into the brands registry at module evaluation time.
 */
import { ctx } from '../context.js';
import { registerBrand, brands } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { renderFfgJobCard, renderFfgTempCard, renderFfgFilamentCard } from './cards.js';
import { schemaWidget } from '../modal-helpers.js';
import { ffgMuxStopAll } from './cam_mux.js';

const $ = id => document.getElementById(id);

// ── Private connection state ──────────────────────────────────────────────

// Per-printer live state, keyed by `${brand}:${id}` (parallels _snapConns).
// Module-scope (not in `state`) since it's transient — never persisted.
const _ffgConns = new Map();
// Reachability cache for the Online/Offline badge on the printer grid card,
// refreshed every 30s (mirror _snapPings).
const _ffgPings = new Map(); // key -> { online: bool|null, lastChecked: number }

// ── Public key helper ─────────────────────────────────────────────────────

export function ffgKey(p) { return `${p.brand}:${p.id}`; }

// Read-only access to a live connection object (for panel event handlers in
// inventory.js that need to mutate conn.log / conn.logPaused).
export function ffgGetConn(key) { return _ffgConns.get(key) ?? null; }

// ── Camera teardown ───────────────────────────────────────────────────────

// Force any active MJPEG stream to release. The FlashForge mjpg-streamer
// accepts a single concurrent client — if we don't break the held-open
// connection on close, reopening the side-card (or opening a different
// FlashForge after this one) hits the printer while it still thinks
// the previous client is connected, and the second `<img>` never
// receives a frame. Setting `src=""` then removing the attribute
// signals Chromium to abort the in-flight load → the TCP socket gets
// FIN'd → printer frees the slot. We also clear cached URLs from the
// attribute so even a quick reopen-with-same-URL forces a new GET.
export function ffgTearDownCamera() {
  ffgMuxStopAll();
}

// ── Online helpers ────────────────────────────────────────────────────────

// Authoritative "is this FlashForge reachable?" reading.
// 1. Active poller status wins.  2. HTTP ping cache as fallback.
// 3. Returns null when no signal yet (renders as "checking" dot).
export function ffgIsOnline(printer) {
  if (printer?.brand !== "flashforge") return null;
  const k = ffgKey(printer);
  if (ctx.isForcedOffline?.(k)) return false; // explicitly disconnected via button
  const conn = _ffgConns.get(k);
  if (conn) return conn.status === "connected";
  const ping = _ffgPings.get(k);
  return ping ? ping.online : null;
}

// ── URL / auth helpers ────────────────────────────────────────────────────

// The Flutter UI accepts both bare IPs ("192.168.1.52") and full URLs
// ("http://192.168.1.52:8898" / with custom port). We mirror that here so
// power users can override the default 8898 port via the printer's IP field.
function ffgBaseUrl(ipField) {
  const raw = String(ipField || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return `http://${raw}:8898`;
}

// Normalize a FlashForge serial to the form the firmware expects on
// its HTTP API (port 8898 /detail + /control). The label printed on
// the AD5X / 5M chassis shows the SN as e.g. "MQQE9501368", but the
// firmware's authentication compares against the internal value
// "SNMQQE9501368" (queryable via `~M115` on port 8899). The mobile
// companion app strips the `SN` prefix when it shows the SN to the
// user, so anyone who copies it off-screen ends up with the short
// form — and the printer rejects every poll with `code:1, "SN is
// different"`. We force the prefix back on. Idempotent: an SN that
// already starts with `SN` (any case) is left as-is.
function ffgNormalizeSerial(raw) {
  const sn = String(raw || "").trim();
  if (!sn) return "";
  if (/^sn/i.test(sn)) return sn;
  return "SN" + sn;
}

function ffgAuthBody(printer) {
  // Both fields land on the printer doc when the user adds a FlashForge
  // (see PRINTER_ADD_SCHEMA.flashforge above). Falsy values still get
  // sent — the printer answers with the helpful "sn is different" /
  // "access code is different" payloads we surface as toasts.
  return {
    serialNumber: ffgNormalizeSerial(printer.serialNumber),
    checkCode:    String(printer.password || "").trim()
  };
}

// ── HTTP ping ─────────────────────────────────────────────────────────────

// Quick reachability check used to drive the Online/Offline badge on the
// printer grid card BEFORE the full polling loop opens. Cached for 30s.
export async function ffgPingPrinter(printer) {
  if (!printer || printer.brand !== "flashforge") return;
  const base = ffgBaseUrl(printer.ip);
  if (!base) return;
  const k = ffgKey(printer);
  const cached = _ffgPings.get(k);
  const now = Date.now();
  if (cached && now - cached.lastChecked < 30_000) return;
  _ffgPings.set(k, { online: cached?.online ?? null, lastChecked: now });
  // Route through main process to bypass renderer CORS (the FlashForge
  // firmware doesn't handle CORS preflight; see main.js ffg:http-post).
  // Same defensive shape as ffgPollOnce — bridge unavailability /
  // rejection / non-object response all collapse to "offline" without
  // breaking the periodic ping.
  // Resolve conn if already open — log the ping traffic through it so it
  // appears in the Request Log alongside regular /detail poll entries.
  // Before the polling loop opens conn is null; we still send the request
  // but skip logging (no log panel exists yet for this printer).
  const pingConn = _ffgConns.get(k) || null;
  const wireBody = ffgAuthBody(printer);
  if (pingConn) ffgLogPush(pingConn, "→", wireBody, `POST ${base}/detail  (ping)`);
  let online = false;
  try {
    const bridge = window.electronAPI && window.electronAPI.ffgHttpPost;
    if (typeof bridge === "function") {
      const j = await bridge(`${base}/detail`, wireBody);
      if (pingConn) ffgLogPush(pingConn, "←", j);
      const code = j?.code;
      const msg  = String(j?.message || "");
      // Even an auth failure (code:1, "sn is different") implies the
      // printer is reachable — only network errors count as "offline".
      online = !(code === -2 || /network error/i.test(msg));
    }
  } catch (_) {
    online = false;
  }
  _ffgPings.set(k, { online, lastChecked: now });
  ffgRefreshOnlineUI(k);
}

export function ffgPingAllPrinters() {
  for (const p of ctx.getState().printers) {
    if (p.brand === "flashforge" && p.ip) ffgPingPrinter(p);
  }
}
setInterval(ffgPingAllPrinters, 30_000);

// ── Online UI helpers ─────────────────────────────────────────────────────

// Surgical DOM update — replaces just the status dot/label in the grid
// card and (if open) the side-card hero. Mirrors snapRefreshOnlineUI.
function ffgRefreshOnlineUI(key) {
  document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
    const p = ctx.getState().printers.find(x => ffgKey(x) === key);
    el.outerHTML = renderFfgOnlineBadge(p, "card");
  });
  const activePrinter = ctx.getActivePrinter();
  if (activePrinter && ffgKey(activePrinter) === key) {
    const host = $("ppOnlineRow");
    if (host) host.outerHTML = renderFfgOnlineBadge(activePrinter, "side");
  }
}

// Single source of truth for the FlashForge online badge HTML — used in
// both the grid card and the side-card. Reuses the same `.printer-online`
// classes as Snapmaker so styling stays consistent.
export function renderFfgOnlineBadge(printer, where) {
  if (!printer || printer.brand !== "flashforge") return "";
  const online = ffgIsOnline(printer);
  const cls = online === true ? "is-online" : (online === false ? "is-offline" : "is-checking");
  const lbl = online === true  ? ctx.t("snapStatusOnline")
            : online === false ? ctx.t("snapStatusOffline")
            :                    ctx.t("snapStatusConnecting");
  const id  = where === "side" ? ` id="ppOnlineRow"` : "";
  return `<span class="printer-online printer-online--${ctx.esc(where)} ${cls}"${id}>
            <span class="printer-online-dot"></span>
            <span class="printer-online-lbl">${ctx.esc(lbl)}</span>
          </span>`;
}

// ── Connection lifecycle ──────────────────────────────────────────────────

// Open or refresh the polling loop for a printer. Idempotent — calling
// again on the same printer with the same IP is a no-op.
export function ffgConnect(printer) {
  const key = ffgKey(printer);
  const existing = _ffgConns.get(key);
  if (existing && existing.intervalId && existing.ip === printer.ip) {
    // Already polling the same target — refresh the printer ref so
    // renames / credential edits reach the next poll without a tear-down.
    existing.printer = printer;
    return;
  }
  if (existing) ffgDisconnect(key);
  const conn = {
    key,
    ip: printer.ip,
    printer,                  // kept in sync with the live Firestore doc
    status: "connecting",     // "connecting" | "connected" | "offline" | "error"
    lastError: null,
    lastPollAt: 0,
    retry: 0,
    retryTimer: null,
    intervalId: null,
    // Cache-buster stamped on every camera URL emitted during this
    // session so the browser never reuses a held-open MJPEG connection
    // from a previous open. The FlashForge MJPEG server (mjpg-streamer
    // on port 8080) only serves ONE concurrent client — without a
    // fresh URL the second open would attach to a stale connection
    // (or the printer would refuse the stream because it still thinks
    // the previous client is connected). Set ONCE per ffgConnect so
    // partial re-renders during the same open keep the same URL and
    // don't initiate a new GET on every poll tick.
    camSession: Date.now(),
    // Surface the camera fallback when the `<img>` errors out (most
    // common cause: another client already streaming, since the
    // printer's mjpg-streamer accepts only ONE concurrent viewer).
    // Reset to false on every status transition into "connected" and
    // when the user clicks the in-banner Retry button (which also
    // bumps camSession to force a new GET).
    camFailed: false,
    // Flat shape — same field structure as the Snapmaker conn so the
    // renderer can reuse format helpers across both brands.
    data: {
      temps: {},              // { e1_temp, e1_target, bed_temp, bed_target, chamber_temp }
      filaments: [],          // up to 4 entries: { color, vendor, type, subType, official, slotId }
      printState: null,       // "printing" | "idle" | "ready" | "complete" | …
      printFilename: null,
      printDuration: 0,
      progress: 0,             // 0..1 (normalised from 0..100 if needed)
      currentLayer: 0,
      totalLayer: 0,
      printPreviewUrl: null,
      printEstimated: null,    // estimated time remaining, seconds
      camera: { url: null, enabled: false },
      snMismatch: false,
      // Last raw /detail response — used by the request log (when added).
      lastDetail: null
    },
    log: []
  };
  _ffgConns.set(key, conn);
  // First poll right away so the side-card lights up without waiting 2s.
  ffgPollOnce(conn);
  conn.intervalId = setInterval(() => ffgPollOnce(conn), 2000);
  ffgNotifyChange(conn, /*statusChanged*/ true);
}

export function ffgDisconnect(key) {
  const conn = _ffgConns.get(key);
  if (!conn) return;
  if (conn.intervalId) { clearInterval(conn.intervalId); conn.intervalId = null; }
  if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
  _ffgConns.delete(key);
}

// Capped exponential backoff — used when the printer becomes unreachable
// mid-session. We pause the steady 2s polling loop and retry on growing
// delays (2s → 4s → 8s → 16s → 30s) until a poll succeeds, at which
// point ffgPollOnce restores the steady cadence.
function ffgScheduleReconnect(conn) {
  if (conn.retryTimer) return;
  if (!_ffgConns.has(conn.key)) return; // disposed
  if (conn.intervalId) { clearInterval(conn.intervalId); conn.intervalId = null; }
  conn.retry = Math.min(conn.retry + 1, 5);
  const delay = Math.min(2000 * (1 << (conn.retry - 1)), 30000);
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    if (!_ffgConns.has(conn.key)) return;
    ffgPollOnce(conn);
    // Restore steady polling — ffgPollOnce will move us back into
    // backoff if the next call also fails.
    if (!conn.intervalId && _ffgConns.has(conn.key)) {
      conn.intervalId = setInterval(() => ffgPollOnce(conn), 2000);
    }
  }, delay);
}

// ── Request log ───────────────────────────────────────────────────────────

/* ── Request log (debug-mode only) ────────────────────────────────
   Mirrors the Snapmaker log block (snapLogPush / renderSnapmakerLogInner)
   but tailored to HTTP polling: every poll pushes one outbound entry
   (→ POST /detail) immediately followed by one inbound entry (← <json>).
   Stored as `conn.log` — array of { dir, ts, summary, raw, expanded }.
   The visible buffer is capped so memory stays bounded over hours of
   polling. Surfaced via the collapsible Request log section under the
   side-card body when state.debugEnabled is true. */
const FFG_LOG_MAX = 100;
// `summaryOverride` lets the outbound caller stamp the row head with
// "POST <url>" while keeping `raw` equal to the EXACT body that goes
// on the wire — that way the expanded JSON never shows a UI envelope
// the user could mistake for the real payload.
function ffgLogPush(conn, dir, raw, summaryOverride = null) {
  if (!conn) return;
  if (conn.logPaused) return;
  if (!conn.log) conn.log = [];
  let summary = summaryOverride || "";
  if (!summary) {
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      // Inbound /detail response — surface code + a couple of useful
      // detail keys so you can see at a glance whether the printer
      // returned a real status payload or an auth error.
      if (obj && typeof obj === "object") {
        if (typeof obj.code !== "undefined") {
          summary = `code:${obj.code}`;
          if (obj.message) summary += `  ${String(obj.message).slice(0, 40)}`;
        }
        if (obj.detail && typeof obj.detail === "object") {
          const keys = Object.keys(obj.detail).slice(0, 4);
          summary += (summary ? "  · " : "") + "detail · " + keys.join(", ");
        }
        if (!summary) summary = "(empty)";
      } else {
        summary = "(non-object)";
      }
    } catch { summary = "(non-json)"; }
  }
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  conn.log.push({ dir, ts, summary, raw: rawStr });
  if (conn.log.length > FFG_LOG_MAX) conn.log.splice(0, conn.log.length - FFG_LOG_MAX);
}

// ── HTTP poll ─────────────────────────────────────────────────────────────

async function ffgPollOnce(conn) {
  if (!conn || !_ffgConns.has(conn.key)) return;
  const printer = conn.printer;
  const base = ffgBaseUrl(printer?.ip);
  if (!base) {
    conn.status = "error";
    conn.lastError = "no IP";
    ffgNotifyChange(conn, true);
    return;
  }
  conn.lastPollAt = Date.now();
  // Outbound frame — `wireBody` is the EXACT body main-process fetch()
  // will serialise. The HTTP verb + URL go in the row-head summary so
  // the expanded JSON in the log matches what's on the wire byte for
  // byte (no nested envelope to confuse the user).
  const wireBody = ffgAuthBody(printer);
  ffgLogPush(conn, "→", wireBody, `POST ${base}/detail`);
  // Bridge through main: the renderer can't POST application/json
  // cross-origin to the printer (CORS preflight blocked by firmware).
  // Wrap every failure mode into the same `{ code:-2, message }`
  // envelope the FlashForge driver already understands — preload
  // missing, IPC handler not registered (e.g. partial reload before
  // main restart), main process throwing, all surface uniformly so
  // the inbound log row always renders and polling keeps going.
  let resp;
  try {
    const bridge = window.electronAPI && window.electronAPI.ffgHttpPost;
    if (typeof bridge !== "function") {
      resp = { code: -2, message: "Network error: ffgHttpPost bridge unavailable (full app restart required)" };
    } else {
      resp = await bridge(`${base}/detail`, wireBody);
    }
  } catch (e) {
    resp = { code: -2, message: `Network error: IPC failed — ${e?.message || e}` };
  }
  if (!resp || typeof resp !== "object") {
    resp = { code: -2, message: "Network error: empty response from bridge" };
  }
  // Stash for the request log + debug overlay.
  conn.data.lastDetail = resp;
  // Inbound frame — log every response (success, auth error, network
  // failure) so the user can pinpoint where a connection breaks down.
  ffgLogPush(conn, "←", resp);
  ffgMergeStatus(conn, resp);
}

// ── Status parser ─────────────────────────────────────────────────────────

/* ── Status parser ─────────────────────────────────────────────────
   Flatten a FlashForge /detail response into our common `conn.data`
   shape, picking the same keys we use for Snapmaker so the renderer
   in F3 can branch on data, not on protocol. We accept liberal input
   types because firmware revisions return numbers as strings ("220")
   or sentinels ("--") interchangeably. */

// Parse FlashForge / Creality "#RRGGBB" colour strings to a normalised
// upper-case hex. Returns null when the input isn't a recognisable hex.
function ffgParseHexColor(s) {
  let v = String(s || "").trim();
  if (!v) return null;
  if (v.startsWith("#")) v = v.slice(1);
  if (v.length === 3) v = v.split("").map(c => c + c).join(""); // "abc" → "aabbcc"
  if (v.length === 8) v = v.slice(0, 6); // drop alpha if present
  if (!/^[0-9a-f]{6}$/i.test(v)) return null;
  return "#" + v.toUpperCase();
}

// Coerce "220" / 220 / "--" / null → number | null.
function ffgNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || s === "--" || /^-+$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// The Flutter UI surfaces these errors as a top-of-screen Flushbar.
// We do the equivalent with toast() but throttle to one notification
// per session per printer so a user with a misconfigured printer
// doesn't get spammed every 2 seconds.
const _ffgErrSeen = new Set(); // Set<`${key}:${kind}`>
function ffgWarnOnce(conn, kind, message) {
  const sig = `${conn.key}:${kind}`;
  if (_ffgErrSeen.has(sig)) return;
  _ffgErrSeen.add(sig);
  try { ctx.toast(message, "error"); } catch (_) { /* toast may not be ready during very first poll */ }
}
// Reset the throttle when the user toggles the side-card so the next
// open after fixing credentials in the printer surfaces the toast again.
function ffgClearWarnings(key) {
  for (const sig of Array.from(_ffgErrSeen)) {
    if (sig.startsWith(key + ":")) _ffgErrSeen.delete(sig);
  }
}

function ffgMergeStatus(conn, resp) {
  if (!conn) return;
  const code = resp?.code;
  const msg  = String(resp?.message || "");
  const msgLower = msg.toLowerCase();
  // Track the previous status so we only flag statusChanged when a
  // poll *actually* moves us to a different state. Without this, every
  // failing poll re-flags `true` and triggers a full renderPrinterDetail()
  // every 2s — which resets data-collapsed on every section (closing
  // the user's open Request log) and makes the whole sidecard flicker.
  const prev = conn.status;

  // ── Error contract (lifted from the Flutter monolith) ─────────────
  // Network error → mark offline + schedule reconnect.
  if (code === -2 || /network error/.test(msgLower)) {
    conn.status = "offline";
    conn.lastError = msg || "network error";
    ffgNotifyChange(conn, /*statusChanged*/ prev !== "offline");
    ffgScheduleReconnect(conn);
    return;
  }
  // SN mismatch — printer is reachable but the credentials don't match.
  // Surface a toast once per session, keep polling so reconfiguration
  // on the printer side recovers the link without a manual restart.
  if (code === 1 && /sn is different/.test(msgLower)) {
    conn.status = "error";
    conn.lastError = msg;
    conn.data.snMismatch = true;
    ffgWarnOnce(conn, "sn", ctx.t("ffgErrSnMismatch"));
    ffgNotifyChange(conn, prev !== "error");
    return;
  }
  if (code === 1 && /access code is different/.test(msgLower)) {
    conn.status = "error";
    conn.lastError = msg;
    ffgWarnOnce(conn, "pwd", ctx.t("ffgErrBadPassword"));
    ffgNotifyChange(conn, prev !== "error");
    return;
  }
  // Anything else with code !== 0 and no `detail` payload — stay silent
  // but keep polling. Status drops back to "connecting" so the badge
  // doesn't claim the printer is online when we got an unintelligible
  // response.
  const detail = resp?.detail;
  if (!detail || typeof detail !== "object") {
    if (code !== 0) {
      conn.status = "connecting";
      ffgNotifyChange(conn, prev !== "connecting");
    }
    return;
  }

  // ── Successful payload — extract every field we know about. We
  // detect status changes (connecting → connected) so the renderer can
  // do the more expensive full re-render only when needed.
  const wasConnected = conn.status === "connected";
  conn.status = "connected";
  conn.lastError = null;
  conn.retry = 0;
  // Status is freshly back online — give the camera another shot. If
  // the previous open hit the 1-stream limit and we showed the fallback,
  // a successful poll suggests the printer is reachable again so the
  // viewer should re-attempt automatically. The user can still
  // manually clear an error via the in-banner Retry button.
  if (!wasConnected) {
    conn.camFailed = false;
  }
  const d = conn.data;

  // Temperatures — `rightTemp` is the active extruder; on dual-extruder
  // models `leftTemp` is reported separately. The bed lives at `platTemp`,
  // chamber at `chamberTemp`. FlashForge does not surface target temps
  // in the obvious places — leave targets null so the renderer
  // gracefully renders just "26°C" instead of "26/0°C".
  const nozzle  = ffgNum(detail.rightTemp ?? detail.leftTemp);
  const bed     = ffgNum(detail.platTemp);
  const chamber = ffgNum(detail.chamberTemp);
  if (nozzle  !== null) d.temps.e1_temp    = nozzle;
  if (bed     !== null) d.temps.bed_temp   = bed;
  if (chamber !== null) d.temps.chamber_temp = chamber;
  // We deliberately DON'T write the *_target keys — the renderer
  // checks for their presence with `typeof === "number"` and falls
  // back to the no-target display when they're absent.

  // Filament — two layouts:
  //   1. matlStation (multi-tray) → matlStationInfo.slotInfos[1..4]
  //   2. independent (single)     → root materialName / materialColor
  //                              OR detail.indepMatlInfo.materialName/Color
  // We prefer matlStation when hasMatlStation is true.
  const hasMs = detail.hasMatlStation === true || detail.hasMatlStation === 1;
  if (hasMs && detail.matlStationInfo && typeof detail.matlStationInfo === "object") {
    const ms = detail.matlStationInfo;
    const currentSlot = (typeof ms.currentSlot === "number") ? ms.currentSlot : 0;
    const slots = Array.isArray(ms.slotInfos) ? ms.slotInfos : [];
    // 5-slot layout: [Ext.] + [1A 1B 1C 1D].
    //   • Ext.  = indepMatlInfo  → ipdMsConfig_cmd on save
    //   • 1A-D = matlStationInfo → msConfig_cmd with slot 1-4
    // Each entry carries `slotKind` ("ext" | "ms") so the renderer
    // can pick the right tag and the edit sheet can dispatch the
    // right /control command WITHOUT relying on array length tricks.
    // Ext is always rendered (even with no material assigned) so the
    // user has a fixed entry point to configure the indep extruder
    // without needing to hunt through the matlStation slots.
    const indep = (detail.indepMatlInfo && typeof detail.indepMatlInfo === "object")
                  ? detail.indepMatlInfo : {};
    const indepName  = String(indep.materialName || "").trim();
    const indepColor = ffgParseHexColor(indep.materialColor);
    // Ext is "live" only when the matlStation isn't actively feeding
    // (currentSlot === 0) AND the extruder reports filament loaded.
    // Otherwise the active feed is via matlStation, Ext is
    // configured-but-not-active.
    const anyExtruderHas = (detail.hasLeftFilament === true || detail.hasLeftFilament === 1)
                        || (detail.hasRightFilament === true || detail.hasRightFilament === 1);
    const extActive = currentSlot === 0 && anyExtruderHas;
    const merged = [];
    merged.push({
      slotId: 0,
      slotKind: "ext",
      hasFilament: extActive,       // only "loaded" when currentSlot===0 + extruder reports filament
      color: indepColor,
      vendor: null,
      type: indepName || null,
      subType: null,
      official: false,
      isActive: extActive
    });
    for (let i = 1; i <= 4; i++) {
      const s = slots.find(x => x && x.slotId === i) || {};
      const has = s.hasFilament === true || s.hasFilament === 1;
      const name = String(s.materialName || "").trim();
      const colorHex = ffgParseHexColor(s.materialColor);
      // KEEP the slot's assigned color + material even when
      // hasFilament is false. The AD5X firmware always reports the
      // last configured `materialColor` / `materialName` per slot;
      // surfacing them lets the user see at a glance which filament
      // is *intended* for each bay so they can refill the right one.
      // Vendor stays null — /detail doesn't carry brand info.
      merged.push({
        slotId: i,
        slotKind: "ms",
        hasFilament: has,
        color: colorHex,            // preserved across has/!has
        vendor: null,               // unknown — not in /detail
        type: name || null,         // preserved across has/!has
        subType: null,              // not exposed by /detail
        official: false,            // FlashForge slots are always editable
        isActive: has && (i === currentSlot)
      });
    }
    d.filaments = merged;
  } else {
    // Independent-extruder fallback — single-slot inventory.
    const indep = detail.indepMatlInfo;
    const indepName  = (indep && typeof indep === "object" ? indep.materialName  : null) ?? detail.materialName;
    const indepColor = (indep && typeof indep === "object" ? indep.materialColor : null) ?? detail.materialColor;
    const name = String(indepName || "").trim();
    const colorHex = ffgParseHexColor(indepColor);
    if (name || colorHex) {
      // Same rationale as the matlStation branch — vendor isn't in
      // the payload, so we leave it null rather than mislabel it.
      d.filaments = [{
        slotId: 1,
        slotKind: "ext",             // no matlStation → indep extruder is the only path
        hasFilament: true,           // single-extruder only renders when loaded
        color: colorHex,
        vendor: null,
        type: name || null,
        subType: null,
        official: false,
        isActive: true
      }];
    } else {
      d.filaments = [];
    }
  }

  // Print job state. FlashForge `status` strings include: "ready",
  // "preparing", "heating", "printing", "paused", "completed",
  // "cancelled", "busy", "idle". We map them onto our internal
  // vocabulary so the renderer can branch on isActive uniformly.
  const rawState = String(detail.status || "").toLowerCase().trim();
  d.printState = rawState || "idle";
  // `printProgress` may be reported as 0..1 OR as 0..100 depending on
  // firmware. Detect via magnitude.
  let progressRaw = ffgNum(detail.printProgress);
  if (progressRaw === null) progressRaw = 0;
  if (progressRaw > 1.0001) progressRaw = progressRaw / 100; // 0..100 → 0..1
  progressRaw = Math.max(0, Math.min(1, progressRaw));
  d.progress = progressRaw;
  // Layer counters
  const cur = ffgNum(detail.printLayer);
  const tot = ffgNum(detail.targetPrintLayer);
  d.currentLayer = cur != null ? Math.round(cur) : 0;
  d.totalLayer   = tot != null ? Math.round(tot) : 0;
  // Estimated time remaining — surface as `printEstimated` to align with
  // the Snapmaker conn shape (where the field carries metadata-derived
  // total estimated time). The renderer treats both as "time hint".
  const eta = ffgNum(detail.estimatedTime);
  d.printEstimated = (eta != null && eta > 0) ? eta : null;
  // Filename — FlashForge exposes either `printFileName` or `printJobName`
  // depending on firmware. We accept either.
  const fn = String(detail.printFileName || detail.printJobName || "").trim();
  d.printFilename = fn || null;
  // Slicer thumbnail — already a fully-qualified URL, just stash it.
  const thumb = String(detail.printFileThumbUrl || "").trim();
  d.printPreviewUrl = thumb || null;

  // Camera — multiple field aliases used across firmware versions.
  const camUrl = String(
    detail.cameraStreamUrl
    || detail.cameraUrl
    || detail.camera_url
    || detail.streamUrl
    || ""
  ).trim();
  const camFlag = (
    detail.camera === true || detail.camera === 1 || detail.camera === "1" ||
    detail.hasCamera === true || detail.hasCamera === 1 ||
    detail.cameraEnabled === true || detail.cameraEnabled === 1 || detail.cameraEnabled === "1" ||
    detail.camera_enabled === true || detail.camera_enabled === 1 || detail.camera_enabled === "1"
  );
  d.camera = {
    url: camUrl || null,
    enabled: !!camUrl || !!camFlag
  };

  // The FlashForge `status` string drives our "is the printer actively
  // printing?" decision — used by the renderer to show / hide the
  // print-job card. We keep it on `d.printState` so it stays alongside
  // the Snapmaker equivalent.

  ffgNotifyChange(conn, /*statusChanged*/ !wasConnected);
}

// ── rAF-coalesced re-renders ──────────────────────────────────────────────

// Coalesce burst of poll-driven updates into a single rAF re-render.
// Mirror of snapNotifyChange — full re-render on status change so the
// hero camera + badge can swap, otherwise just the data block.
let _ffgRenderRaf = null;
let _ffgGridRaf   = null; // data updates  → onGridJobsChange
let _ffgStatusRaf = null; // status changes → onPrinterGridChange (separate to avoid coalescing with data RAF)
let _ffgRenderStatusFlag = false;
function ffgNotifyChange(conn, statusChanged = false) {
  if (statusChanged) {
    if (!_ffgStatusRaf) _ffgStatusRaf = requestAnimationFrame(() => { _ffgStatusRaf = null; ctx.onPrinterGridChange(); });
    return;
  }
  if (!_ffgGridRaf) _ffgGridRaf = requestAnimationFrame(() => { _ffgGridRaf = null; ctx.onGridJobsChange(); });
  const activePrinter = ctx.getActivePrinter();
  if (!activePrinter) return;
  if (ffgKey(activePrinter) !== conn.key) return;
  if (_ffgRenderRaf) return;
  _ffgRenderRaf = requestAnimationFrame(() => {
    _ffgRenderRaf = null;
    const fullRerender = _ffgRenderStatusFlag;
    _ffgRenderStatusFlag = false;
    if (fullRerender) {
      ctx.onFullRender();
    } else {
      const liveHost = $("ffgLive");
      if (liveHost) {
        liveHost.innerHTML = renderFlashforgeLiveInner(activePrinter);
      }
      // Request log — incremental update so the section's open /
      // closed state survives every poll tick. Mirrors the Snapmaker
      // partial-render path at L6492.
      const logHost = $("ffgLog");
      if (logHost) logHost.innerHTML = renderFlashforgeLogInner(activePrinter);
      const countEl = $("ffgLogCount");
      if (countEl) countEl.textContent = String(conn.log?.length || 0);
    }
  });
}

// ── Live inner renderers ──────────────────────────────────────────────────
// Camera banner moved to widget_camera.js — see renderFfgCamBanner().

export function renderFlashforgeLiveInner(p) {
  const conn = _ffgConns.get(ffgKey(p));
  if (!conn) return `
    <div class="snap-empty">
      <span class="icon icon-cloud icon-18"></span>
      <span>${ctx.esc(ctx.t("snapNoConnection"))}</span>
    </div>`;
  const b = brands.get('flashforge');
  return `
    ${b.renderJobCard(p, conn)}
    ${b.renderTempCard(conn)}
    ${b.renderFilamentCard(p, conn)}`;
}

/* ── Request log render ──────────────────────────────────────────
   Inner contents of the #ffgLog container — replaced on every poll
   tick (incremental, no full side-card rebuild). Mirrors
   renderSnapmakerLogInner so the UI feels identical across brands.
   Each row click toggles the pretty-printed JSON detail panel. */
export function renderFlashforgeLogInner(p) {
  const conn = _ffgConns.get(ffgKey(p));
  const log = conn?.log || [];
  if (!log.length) {
    return `<div class="snap-log-empty">${ctx.esc(ctx.t("snapLogEmpty"))}</div>`;
  }
  const rows = log.slice().reverse().map((e, i) => {
    let pretty = e.raw;
    try { pretty = JSON.stringify(JSON.parse(e.raw), null, 2); } catch (_) {}
    const expanded = !!e.expanded;
    return `
      <div class="snap-log-row snap-log-row--${e.dir === "→" ? "out" : "in"}${expanded ? " snap-log-row--expanded" : ""}"
           data-log-idx="${log.length - 1 - i}">
        <button type="button" class="snap-log-row-head" data-row-toggle="1">
          <span class="snap-log-dir">${ctx.esc(e.dir)}</span>
          <span class="snap-log-ts">${ctx.esc(e.ts)}</span>
          <span class="snap-log-summary">${ctx.esc(e.summary)}</span>
          <span class="snap-log-row-chev icon icon-chevron-r icon-13"></span>
        </button>
        <div class="snap-log-detail"${expanded ? "" : " hidden"}>
          <button type="button" class="snap-log-detail-copy" data-copy="${ctx.esc(pretty)}" title="${ctx.esc(ctx.t("copyLabel"))}">
            <span class="icon icon-copy icon-13"></span>
            <span>${ctx.esc(ctx.t("copyLabel"))}</span>
          </button>
          <pre class="snap-log-detail-pre">${ctx.esc(pretty)}</pre>
        </div>
      </div>`;
  }).join("");
  return `<div class="snap-log">${rows}</div>`;
}

// ── Filament edit bottom sheet ────────────────────────────────────────────

/* ── Manual filament edit — bottom sheet ──────────────────────────
   Click on a colour square in the FlashForge live block opens a
   bottom-sheet pre-filled with the slot's current filament data.
   On Apply we POST /control with the FlashForge command:
     • matlStation (4-bay): { cmd: "msConfig_cmd",   args: { slot, mt, rgb } }
     • independent extruder: { cmd: "ipdMsConfig_cmd", args: { mt, rgb } }
   Sheet structure mirrors the Snapmaker `.sfe-*` sheet (we even
   reuse its CSS classes); IDs are `ffg*` / `ffgFilEdit*` so both
   flows coexist. */

// Vendor → materials catalogue. FlashForge accepts arbitrary `mt`
// strings, but we surface a curated list mirroring the Snapmaker
// chooser so the user picks documented values (PLA / PETG / …) by
// default. Custom material names still flow through via the typed
// input hooks.
// The vendor isn't sent to the printer (the /control payload only
// carries `mt` + `rgb`), so we keep the catalogue intentionally tiny:
// "Generic" first as the safe default, then "FlashForge" for users
// who specifically want to track that. Other brands were removed —
// they were mislabelling slots without changing what reaches the
// wire.
const FFG_FIL_VENDOR_MATERIALS = {
  "Generic":    ["PLA", "PETG", "ABS", "TPU", "ASA", "PA", "PC", "PVA", "HIPS", "Wood"],
  "FlashForge": ["PLA", "PETG", "ABS", "TPU", "ASA"]
};
const FFG_FIL_BRANDS = Object.keys(FFG_FIL_VENDOR_MATERIALS);
const FFG_FIL_PRIORITY = ["PLA", "PETG", "ABS", "TPU"];

// Same 24-colour preset palette as the Snapmaker sheet so the user
// visually recognises the colour grid across brands.
// (Accessed via ctx at call time — not a module-level const, since ctx is populated after module load.)

function ffgSortMaterials(list) {
  const upper = list.map(s => s.toUpperCase());
  const used = new Set();
  const priority = [];
  for (const p of FFG_FIL_PRIORITY) {
    const idx = upper.findIndex((u, i) => !used.has(i) && u === p);
    if (idx >= 0) { priority.push(list[idx]); used.add(idx); }
  }
  const rest = list.filter((_, i) => !used.has(i))
                   .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return [...priority, ...rest];
}

// FlashForge expects the colour as "#RRGGBB" upper-case (per the
// Flutter monolith's _ffgSetMsSlot / _ffgSetExtMaterial calls). The
// existing ffgParseHexColor already returns that exact shape.
function ffgColorToHash(hex) {
  return ffgParseHexColor(hex) || "#000000";
}

let _ffgFilEdit = null;             // { brand, deviceId, key, slotId, isMatlStation }
let _ffeSelectedBrand = "";
let _ffeSelectedMaterial = "";

function ffgFilRenderVendorList(selected) {
  return FFG_FIL_BRANDS.map(v => {
    const isSel = v.toLowerCase() === (selected || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}"
                    data-val="${ctx.esc(v)}">${ctx.esc(v)}</button>`;
  }).join("");
}
function ffgFilRenderMaterialList(vendor, selectedMat) {
  const list = (FFG_FIL_VENDOR_MATERIALS[vendor]?.length
                ? FFG_FIL_VENDOR_MATERIALS[vendor]
                : FFG_FIL_VENDOR_MATERIALS["Generic"]);
  const sorted = ffgSortMaterials(list);
  return sorted.map(m => {
    const isSel = m.toLowerCase() === (selectedMat || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}" data-val="${ctx.esc(m)}">
              <span class="sfe-fil-row-text">${ctx.esc(m)}</span>
              ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ""}
            </button>`;
  }).join("");
}

function ffeRenderColorGrid(currentColor) {
  const grid = $("ffgColorGrid");
  if (!grid) return;
  const cur = (currentColor || "").toLowerCase();
  const presetCells = ctx.SNAP_FIL_COLOR_PRESETS.map(c => {
    const isSel = c.toLowerCase() === cur;
    return `<button type="button" class="sfe-color-cell${isSel ? " is-selected" : ""}"
                    data-color="${ctx.esc(c)}"
                    style="background:${ctx.esc(c)}"
                    title="${ctx.esc(c)}"></button>`;
  }).join("");
  const safeColor = currentColor && /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#888888";
  const customCell = `
    <div class="sfe-color-cell sfe-color-cell--custom" id="ffgColorCustomBtn"
         style="background:${ctx.esc(safeColor)}"
         title="${ctx.esc(ctx.t("snapFilEditCustomColor") || "Custom")}">
      <span class="icon icon-edit icon-13"></span>
      <input type="color" class="sfe-color-cell-native" id="ffgColorPickerInline"
             value="${ctx.esc(safeColor)}" aria-label="Custom color"/>
    </div>`;
  grid.innerHTML = presetCells + customCell;
}

function ffeOpenFilamentSheet() {
  $("ffgFilamentSheet")?.classList.add("open");
  $("ffgFilamentSheet")?.setAttribute("aria-hidden", "false");
}
function ffeCloseFilamentSheet() {
  $("ffgFilamentSheet")?.classList.remove("open");
  $("ffgFilamentSheet")?.setAttribute("aria-hidden", "true");
}
function ffeOpenColorSheet() {
  $("ffgColorSheet")?.classList.add("open");
  $("ffgColorSheet")?.setAttribute("aria-hidden", "false");
}
function ffeCloseColorSheet() {
  $("ffgColorSheet")?.classList.remove("open");
  $("ffgColorSheet")?.setAttribute("aria-hidden", "true");
}

function ffeUpdateSummary() {
  // The vendor isn't sent on the wire (printer only stores `mt` +
  // `rgb`), so the summary header just shows the material the user
  // is selecting — no brand prefix. Keeps the bottom-sheet visually
  // honest about what will actually reach the printer.
  const m = _ffeSelectedMaterial || "—";
  const valEl = $("ffgFilSummaryVal");
  if (valEl) valEl.textContent = m;
  const dot = $("ffgColorSummaryDot");
  if (dot) dot.style.background = $("ffgColorInput")?.value || "#888";
}

export function openFlashforgeFilamentEdit(printer, extruderIndex) {
  const conn = _ffgConns.get(ffgKey(printer));
  const fil = (conn?.data?.filaments?.[extruderIndex]) || {};
  // Derive the dispatch flag from the slot's own `slotKind` instead
  // of the array length — the array is now 5-long for matlStation
  // rigs (Ext + 1A-D), so the old `length === 4` heuristic would
  // mis-dispatch every slot. "ms" → msConfig_cmd with slot 1-4;
  // "ext" → ipdMsConfig_cmd (no slot).
  const isMatlStation = fil.slotKind === "ms";
  const slotId = fil.slotId || (extruderIndex + 1);
  _ffgFilEdit = {
    brand: printer.brand,
    deviceId: printer.id,
    key: ffgKey(printer),
    slotId,
    slotKind: fil.slotKind || "ext",
    isMatlStation,
    printer
  };
  // The driver no longer stamps `fil.vendor` (the /detail payload
  // doesn't carry one and we won't make one up). Default to Generic
  // — first in FFG_FIL_BRANDS — so the picker has a valid selection
  // even when we genuinely don't know the brand.
  _ffeSelectedBrand    = (fil.vendor && FFG_FIL_BRANDS.includes(fil.vendor))
                          ? fil.vendor
                          : "Generic";
  _ffeSelectedMaterial = fil.type   || "PLA";

  const colorInp = $("ffgColorInput");
  if (colorInp) colorInp.value = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color))
                                  ? fil.color.slice(0, 7) : "#FF5722";

  $("ffgFilEditSub").textContent = "";
  $("ffgError").hidden = true;

  const initialColor = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color))
                     ? fil.color.slice(0, 7) : "#FF5722";
  ffeRenderColorGrid(initialColor);

  const vendorList = $("ffgVendorList");
  const matList    = $("ffgMaterialList");
  if (vendorList) {
    const vendorMatch = FFG_FIL_BRANDS.find(b => b.toLowerCase() === _ffeSelectedBrand.toLowerCase())
                     || FFG_FIL_BRANDS[0];
    _ffeSelectedBrand = vendorMatch;
    vendorList.innerHTML = ffgFilRenderVendorList(vendorMatch);
  }
  if (matList) {
    matList.innerHTML = ffgFilRenderMaterialList(_ffeSelectedBrand, _ffeSelectedMaterial);
  }

  ffeCloseFilamentSheet();
  ffeCloseColorSheet();
  ffeUpdateSummary();

  $("ffgFilEditSheet").classList.add("open");
  $("ffgFilEditSheet").setAttribute("aria-hidden", "false");
  $("ffgFilEditBackdrop").classList.add("open");
}

export function closeFlashforgeFilamentEdit() {
  $("ffgFilEditSheet")?.classList.remove("open");
  $("ffgFilEditSheet")?.setAttribute("aria-hidden", "true");
  $("ffgFilEditBackdrop")?.classList.remove("open");
  ffeCloseFilamentSheet();
  ffeCloseColorSheet();
  _ffgFilEdit = null;
}

// ── DOM event wiring ──────────────────────────────────────────────────────

// (Delegated where useful so re-rendered nodes stay live)
$("ffgFilEditClose")?.addEventListener("click", closeFlashforgeFilamentEdit);
$("ffgFilEditBackdrop")?.addEventListener("click", closeFlashforgeFilamentEdit);

$("ffgOpenFilament")?.addEventListener("click", () => {
  ffeOpenFilamentSheet();
  setTimeout(() => {
    const sel = $("ffgVendorList")?.querySelector(".is-selected");
    if (sel) sel.scrollIntoView({ block: "center", behavior: "auto" });
  }, 0);
});
$("ffgOpenColor")?.addEventListener("click", () => {
  ffeOpenColorSheet();
});

$("ffgFilamentBack")?.addEventListener("click", () => {
  ffeUpdateSummary();
  ffeCloseFilamentSheet();
});
$("ffgFilamentClose")?.addEventListener("click", () => {
  ffeUpdateSummary();
  ffeCloseFilamentSheet();
});
$("ffgColorBack")?.addEventListener("click", () => {
  ffeUpdateSummary();
  ffeCloseColorSheet();
});
$("ffgColorClose")?.addEventListener("click", () => {
  ffeUpdateSummary();
  ffeCloseColorSheet();
});

$("ffgVendorList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _ffeSelectedBrand = row.dataset.val || "";
  $("ffgVendorList").querySelectorAll(".sfe-fil-row").forEach(r =>
    r.classList.toggle("is-selected", r === row));
  const matList = $("ffgMaterialList");
  if (matList) matList.innerHTML = ffgFilRenderMaterialList(_ffeSelectedBrand, _ffeSelectedMaterial);
  const v = $("ffgVendor"); if (v) v.value = "";
});
$("ffgMaterialList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _ffeSelectedMaterial = row.dataset.val || "";
  const m = $("ffgMaterial"); if (m) m.value = "";
  $("ffgMaterialList").innerHTML = ffgFilRenderMaterialList(_ffeSelectedBrand, _ffeSelectedMaterial);
  setTimeout(() => {
    ffeUpdateSummary();
    ffeCloseFilamentSheet();
  }, 180);
});

$("ffgColorGrid")?.addEventListener("click", e => {
  if (e.target.closest("#ffgColorPickerInline")) return;
  const cell = e.target.closest(".sfe-color-cell:not(.sfe-color-cell--custom)");
  if (!cell) return;
  const c = cell.dataset.color;
  if (!c) return;
  $("ffgColorInput").value = c;
  ffeRenderColorGrid(c);
  setTimeout(() => {
    ffeUpdateSummary();
    ffeCloseColorSheet();
  }, 150);
});
$("ffgColorGrid")?.addEventListener("input", e => {
  if (!e.target.matches?.("#ffgColorPickerInline")) return;
  const c = e.target.value;
  $("ffgColorInput").value = c;
  const wrap = e.target.closest(".sfe-color-cell--custom");
  if (wrap) wrap.style.background = c;
});
$("ffgColorGrid")?.addEventListener("change", e => {
  if (!e.target.matches?.("#ffgColorPickerInline")) return;
  const c = e.target.value;
  $("ffgColorInput").value = c;
  ffeRenderColorGrid(c);
  setTimeout(() => {
    ffeUpdateSummary();
    ffeCloseColorSheet();
  }, 100);
});

// Apply → POST /control with the right cmd shape based on whether
// the printer is a matlStation (slot-based) or single-extruder.
$("ffgFilEditSave")?.addEventListener("click", async () => {
  if (!_ffgFilEdit) return;
  const conn = _ffgConns.get(_ffgFilEdit.key);
  const printer = _ffgFilEdit.printer;
  const errEl = $("ffgError");
  errEl.hidden = true;

  // Vendor never reaches the wire (the /control payload only
  // carries `mt` + `rgb`), but we still resolve it locally so the
  // optimistic state and any future TigerTag tagging has a value.
  // Default Generic — same first-in-list logic as the picker.
  const vendor   = String($("ffgVendor").value || _ffeSelectedBrand   || "Generic").trim();
  const material = String($("ffgMaterial").value || _ffeSelectedMaterial || "PLA").trim();
  const rgb      = ffgColorToHash($("ffgColorInput").value);

  // The FlashForge protocol takes the material name in `mt` directly —
  // no vendor field is sent (per the Flutter _ffgSetMsSlot /
  // _ffgSetExtMaterial calls). We keep the vendor in our local state
  // so the UI summary stays in sync, but the wire payload is just
  // the material + colour pair.
  const _vendorUnused = vendor; // retained for future extension; suppresses lint
  void _vendorUnused;

  const base = ffgBaseUrl(printer.ip);
  if (!base) {
    errEl.textContent = ctx.t("ffgErrNetwork");
    errEl.hidden = false;
    return;
  }
  const payload = _ffgFilEdit.isMatlStation
    ? {
        ...ffgAuthBody(printer),
        payload: { cmd: "msConfig_cmd",   args: { slot: _ffgFilEdit.slotId, mt: material, rgb } }
      }
    : {
        ...ffgAuthBody(printer),
        payload: { cmd: "ipdMsConfig_cmd", args: { mt: material, rgb } }
      };

  const btn = $("ffgFilEditSave");
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    // Bridge through main process — same CORS bypass story as /detail.
    // Defensive shape: bridge missing → user-friendly error.
    const bridge = window.electronAPI && window.electronAPI.ffgHttpPost;
    if (typeof bridge !== "function") {
      errEl.textContent = "Bridge unavailable — restart Tiger Studio Manager";
      errEl.hidden = false;
      return;
    }
    const cmdLabel = _ffgFilEdit.isMatlStation
      ? `POST ${base}/control  msConfig_cmd slot:${_ffgFilEdit.slotId}`
      : `POST ${base}/control  ipdMsConfig_cmd`;
    ffgLogPush(conn, "→", payload, cmdLabel);
    const resp = await bridge(`${base}/control`, payload);
    ffgLogPush(conn, "←", resp);
    if (resp && resp.code !== 0 && resp.code !== undefined) {
      // Surface the printer's own message verbatim — varies a lot
      // between firmware revisions and is the most actionable hint.
      const m = String(resp.message || "").trim();
      errEl.textContent = m || ctx.t("ffgErrNetwork");
      errEl.hidden = false;
      return;
    }
    // Optimistic local update: the printer will echo the new values
    // on the next /detail poll (≤ 2 s), but we patch conn.data right
    // away so the user sees instant feedback.
    if (conn) {
      const idx = (_ffgFilEdit.slotId - 1) | 0;
      const fils = Array.isArray(conn.data.filaments) ? conn.data.filaments.slice() : [];
      if (fils[idx]) {
        // Don't stamp a vendor — the printer doesn't store one, and
        // the next /detail poll will reset vendor to null anyway.
        // Setting "FlashForge" here would briefly mislabel the slot.
        // For matlStation slots, hasFilament:true is wrong if the
        // user just *configured* the bay without loading filament —
        // the next /detail poll corrects this within ≤2s. For Ext,
        // editing IS the act of assignment (no physical "load"
        // step), so we treat it the same way and let the poll fix
        // any drift.
        fils[idx] = {
          ...fils[idx],
          color: rgb,
          type: material,
          vendor: null
        };
        conn.data.filaments = fils;
        ffgNotifyChange(conn, false);
      }
    }
    closeFlashforgeFilamentEdit();
  } catch (e) {
    console.warn("[ffg] filament edit send failed:", e?.message);
    errEl.textContent = ctx.t("ffgErrNetwork");
    errEl.hidden = false;
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
});

// ── Self-registration ─────────────────────────────────────────────────────
registerBrand('flashforge', {
  meta, schema, helper,
  renderJobCard:        renderFfgJobCard,
  renderTempCard:       renderFfgTempCard,
  renderFilamentCard:   renderFfgFilamentCard,
  renderSettingsWidget: schemaWidget(schema),
});
