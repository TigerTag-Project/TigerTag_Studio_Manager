/**
 * printers/snapmaker/index.js — Snapmaker live integration (Moonraker over WebSocket).
 *
 * Ported from the Flutter SnapmakerWebSocketPage.
 * Snapmaker U1 runs a Klipper / Moonraker stack; we open a WebSocket to
 * ws://{ip}:7125/websocket and subscribe to printer objects to stream live
 * temperatures, filament data, and print job state.
 * Self-registers into the brands registry at module evaluation time.
 */
import { ctx } from '../context.js';
import { registerBrand, brands } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { renderSnapJobCard, renderSnapTempCard, renderSnapFilamentCard } from './cards.js';
import { schemaWidget } from '../modal-helpers.js';

const $ = id => document.getElementById(id);

// ── Private connection state ──────────────────────────────────────────────

// Per-printer live state. Keyed by `${brand}:${id}` (same composite key
// used elsewhere). Value carries the WebSocket, latest snapshot, and
// reconnect bookkeeping. Stays in module scope (not in `state`) since
// it's transient — never persisted.
const _snapConns = new Map();

// Lightweight reachability cache, populated by snapPingPrinter (HTTP
// GET to /server/info on the Moonraker port). Used to drive the
// "Online / Offline" indicator in the printer grid + side card hero
// even when no WebSocket session is open. Refreshed every 30 s.
const _snapPings = new Map(); // key -> { online: bool|null, lastChecked: number }

// ── Public key helpers ────────────────────────────────────────────────────

export function snapKey(p) { return `${p.brand}:${p.id}`; }

// Read-only access to a live connection object (for panel event handlers
// in inventory.js that need to read conn.log / conn.logPaused etc.).
export function snapGetConn(key) { return _snapConns.get(key) ?? null; }

// ── Online helpers ────────────────────────────────────────────────────────

// Authoritative "is this Snapmaker reachable?" reading.
// 1. If a live WebSocket exists, use its status (most accurate).
// 2. Otherwise fall back to the last HTTP ping result.
// 3. Returns `null` when we have no signal yet (renders as a "checking" dot).
export function snapIsOnline(printer) {
  if (printer?.brand !== "snapmaker") return null;
  const k = snapKey(printer);
  const conn = _snapConns.get(k);
  if (conn) return conn.status === "connected";
  const ping = _snapPings.get(k);
  return ping ? ping.online : null;
}

// ── HTTP ping ─────────────────────────────────────────────────────────────

export async function snapPingPrinter(printer) {
  if (!printer || printer.brand !== "snapmaker" || !printer.ip) return;
  const k = snapKey(printer);
  const cached = _snapPings.get(k);
  const now = Date.now();
  // 30 s cache — avoid pinging the same printer on every render.
  if (cached && now - cached.lastChecked < 30_000) return;
  _snapPings.set(k, { online: cached?.online ?? null, lastChecked: now });
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://${printer.ip}:7125/server/info`, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store"
    });
    clearTimeout(tm);
    _snapPings.set(k, { online: res.ok, lastChecked: now });
  } catch (_) {
    _snapPings.set(k, { online: false, lastChecked: now });
  }
  // Patch the affected card / side-card without rebuilding everything.
  snapRefreshOnlineUI(k);
}

export function snapPingAllPrinters() {
  for (const p of ctx.getState().printers) {
    if (p.brand === "snapmaker" && p.ip) snapPingPrinter(p);
  }
}
// Background refresh — kicks in once the user has signed in and
// state.printers is populated. We only ping while at least one
// Snapmaker is in the list, otherwise it's a no-op.
setInterval(snapPingAllPrinters, 30_000);

// ── Online UI helpers ─────────────────────────────────────────────────────

// Surgical DOM update — replaces just the status dot + label in the
// affected card and (if open) the side-card hero. Avoids re-rendering
// the whole grid on every ping resolution.
function snapRefreshOnlineUI(key) {
  document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
    const p = ctx.getState().printers.find(x => snapKey(x) === key);
    el.outerHTML = renderSnapOnlineBadge(p, "card");
  });
  const activePrinter = ctx.getActivePrinter();
  if (activePrinter && snapKey(activePrinter) === key) {
    const host = $("ppOnlineRow");
    if (host) host.outerHTML = renderSnapOnlineBadge(activePrinter, "side");
  }
}

// Single source of truth for the badge HTML — used in both the grid
// card and the side-card. `where` toggles a class for slightly
// different styling between the two locations.
export function renderSnapOnlineBadge(printer, where) {
  if (!printer || printer.brand !== "snapmaker") return "";
  const online = snapIsOnline(printer);
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

// Open or refresh the connection for a printer. Idempotent — calling
// again on the same printer is a no-op while the socket is OPEN.
export function snapConnect(printer) {
  const key = snapKey(printer);
  const existing = _snapConns.get(key);
  if (existing && existing.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
    // Already connected/connecting — if the ip changed, tear down first.
    if (existing.ip === printer.ip) return;
    snapDisconnect(key);
  }
  const conn = {
    ip: printer.ip,
    key,
    ws: null,
    status: "connecting", // "connecting" | "connected" | "offline" | "error"
    lastError: null,
    retry: 0,
    retryTimer: null,
    // Latest parsed data — kept flat for cheap reads in the renderer.
    data: {
      temps: {},          // { e1_temp, e1_target, e2_temp, ... bed_temp, bed_target }
      filaments: [],      // [{ color: "#RRGGBB", vendor, type, subType, official }] × up to 4
      printState: null,   // "standby" | "printing" | "paused" | "complete" | "error"
      printFilename: null,
      printDuration: 0,
      progress: 0,        // 0..1
      currentLayer: 0,
      totalLayer: 0,
      printPreviewUrl: null,  // slicer thumbnail (set by snapFetchMetadata)
      printEstimated: null    // estimated_time in seconds (from metadata)
    }
  };
  _snapConns.set(key, conn);
  snapOpenSocket(conn);
}

function snapOpenSocket(conn) {
  if (!conn.ip) { conn.status = "error"; conn.lastError = "no IP"; return; }
  const url = `ws://${conn.ip}:7125/websocket`;
  let ws;
  try { ws = new WebSocket(url); }
  catch (e) {
    console.warn("[snap] WS construct failed:", e?.message);
    conn.status = "error";
    conn.lastError = String(e?.message || e);
    snapNotifyChange(conn);
    snapScheduleReconnect(conn);
    return;
  }
  conn.ws = ws;
  conn.status = "connecting";
  snapNotifyChange(conn);

  // Wrap send so every outbound payload is captured for the log view.
  const sendLogged = (obj) => {
    const json = JSON.stringify(obj);
    snapLogPush(conn, "→", json);
    ws.send(json);
  };

  ws.addEventListener("open", () => {
    conn.status = "connected";
    conn.lastError = null;
    conn.retry = 0;
    // Subscribe to all the printer objects we care about. The 4 extruder
    // names match the Snapmaker U1 4-tool firmware naming convention.
    sendLogged({
      jsonrpc: "2.0",
      id: 1,
      method: "printer.objects.subscribe",
      params: { objects: {
        print_task_config: null,
        print_stats: null,
        virtual_sdcard: null,
        display_status: null,
        extruder:  ["temperature", "target"],
        extruder1: ["temperature", "target"],
        extruder2: ["temperature", "target"],
        extruder3: ["temperature", "target"],
        heater_bed:["temperature", "target"]
      }}
    });
    // Initial snapshot — `subscribe` returns the current state synchronously
    // but we send a query too in case the firmware version doesn't.
    sendLogged({
      jsonrpc: "2.0", id: 1001,
      method: "printer.objects.query",
      params: { objects: {
        print_stats: null, virtual_sdcard: null, display_status: null,
        extruder: null, extruder1: null, extruder2: null, extruder3: null,
        heater_bed: null
      }}
    });
    // Status changed (connecting → connected) — the hero camera depends
    // on this, so we ask for a full re-render not just the live block.
    snapNotifyChange(conn, /*statusChanged*/ true);
  });

  ws.addEventListener("message", ev => {
    // Capture every inbound frame for the log first — so even non-status
    // notifications (logs / RPC results we don't otherwise inspect) are
    // visible to the developer.
    snapLogPush(conn, "←", ev.data);

    let obj; try { obj = JSON.parse(ev.data); } catch { return; }
    let status = null;
    if (obj.result && obj.result.status) status = obj.result.status;
    else if ((obj.method === "notify_status_update" || obj.method === "notify_status_changed")
             && Array.isArray(obj.params) && obj.params[0]) {
      status = obj.params[0];
    }
    if (status && typeof status === "object") snapMergeStatus(conn, status);
    // Always notify so the log row appears even when the payload didn't
    // carry a status update (RPC results, etc.).
    snapNotifyChange(conn);
  });

  ws.addEventListener("close", () => {
    conn.status = "offline";
    snapNotifyChange(conn, /*statusChanged*/ true);
    snapScheduleReconnect(conn);
  });

  ws.addEventListener("error", () => {
    // The 'close' handler will fire next; just record the error here.
    conn.lastError = "websocket error";
  });
}

function snapScheduleReconnect(conn) {
  if (conn.retryTimer) return;
  if (!_snapConns.has(conn.key)) return; // disposed
  // Capped exponential backoff: 2s, 4s, 8s, 16s, then 30s.
  conn.retry = Math.min(conn.retry + 1, 5);
  const delay = Math.min(2000 * (1 << (conn.retry - 1)), 30000);
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    // The user might have closed the panel in the meantime.
    if (!_snapConns.has(conn.key)) return;
    snapOpenSocket(conn);
  }, delay);
}

export function snapDisconnect(key) {
  const conn = _snapConns.get(key);
  if (!conn) return;
  if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
  if (conn.ws) {
    try { conn.ws.close(); } catch (_) {}
    conn.ws = null;
  }
  _snapConns.delete(key);
}

// ── Status parser ─────────────────────────────────────────────────────────

// Merge a Moonraker `status` payload into our flat `data` shape.
function snapMergeStatus(conn, status) {
  const d = conn.data;

  // Live temps: extruder*, heater_bed
  const tempPair = (objName, prefix) => {
    const obj = status[objName];
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.temperature === "number") d.temps[`${prefix}_temp`]   = obj.temperature;
    if (typeof obj.target === "number")      d.temps[`${prefix}_target`] = obj.target;
  };
  tempPair("extruder",   "e1");
  tempPair("extruder1",  "e2");
  tempPair("extruder2",  "e3");
  tempPair("extruder3",  "e4");
  tempPair("heater_bed", "bed");

  // Filament info — `print_task_config` carries arrays of length 4.
  const cfg = status.print_task_config;
  if (cfg && typeof cfg === "object") {
    const colors  = Array.isArray(cfg.filament_color_rgba) ? cfg.filament_color_rgba : null;
    const vendors = Array.isArray(cfg.filament_vendor)     ? cfg.filament_vendor     : null;
    const types   = Array.isArray(cfg.filament_type)       ? cfg.filament_type       : null;
    const subs    = Array.isArray(cfg.filament_sub_type)   ? cfg.filament_sub_type   : null;
    const offs    = Array.isArray(cfg.filament_official)   ? cfg.filament_official   : null;
    // Only overwrite if at least one array landed — `notify_status_update`
    // for a single field would otherwise nuke the others.
    if (colors || vendors || types || subs || offs) {
      const merged = d.filaments.length === 4 ? d.filaments.slice() : [{},{},{},{}];
      for (let i = 0; i < 4; i++) {
        merged[i] = { ...(merged[i] || {}) };
        if (colors  && colors[i]  != null) merged[i].color    = snapParseRgbaHex(String(colors[i]));
        if (vendors && vendors[i] != null) merged[i].vendor   = String(vendors[i]);
        if (types   && types[i]   != null) merged[i].type     = String(types[i]);
        if (subs    && subs[i]    != null) merged[i].subType  = String(subs[i]);
        if (offs    && offs[i]    != null) merged[i].official = !!offs[i];
      }
      d.filaments = merged;
    }
  }

  // Print job state
  const ps = status.print_stats;
  if (ps && typeof ps === "object") {
    if (typeof ps.state === "string")          d.printState = ps.state;
    if (typeof ps.filename === "string")       d.printFilename = ps.filename;
    if (typeof ps.print_duration === "number") d.printDuration = ps.print_duration;
    // Layer counters live under `print_stats.info` — Moonraker schema.
    if (ps.info && typeof ps.info === "object") {
      if (typeof ps.info.current_layer === "number") d.currentLayer = ps.info.current_layer;
      if (typeof ps.info.total_layer   === "number") d.totalLayer   = ps.info.total_layer;
    }
    // Trigger an HTTP metadata fetch for the slicer-rendered thumbnail.
    // Only does work when the filename actually changes.
    const rel = snapFilenameRel(d.printFilename);
    if (rel) snapFetchMetadata(conn, rel);
  }
  const ds = status.display_status;
  if (ds && typeof ds === "object" && typeof ds.progress === "number") {
    d.progress = ds.progress;
  }
  const vsd = status.virtual_sdcard;
  if (vsd && typeof vsd === "object" && typeof vsd.progress === "number" && !d.progress) {
    d.progress = vsd.progress;
  }
}

// ── rAF-coalesced re-renders ──────────────────────────────────────────────

// Whenever the live data changes we update the side card if it's
// still showing this printer.
//   • Default path: cheap re-render of `#snapLive` (data updates only).
//   • statusChanged=true: full re-render of the side card via
//     ctx.onFullRender() — needed because the hero camera iframe is
//     conditional on the connection being open.
let _snapRenderRaf = null;
let _snapRenderStatusFlag = false;
function snapNotifyChange(conn, statusChanged = false) {
  const activePrinter = ctx.getActivePrinter();
  if (!activePrinter) return;
  if (snapKey(activePrinter) !== conn.key) return;
  if (statusChanged) _snapRenderStatusFlag = true;
  if (_snapRenderRaf) return; // coalesce bursts
  _snapRenderRaf = requestAnimationFrame(() => {
    _snapRenderRaf = null;
    const fullRerender = _snapRenderStatusFlag;
    _snapRenderStatusFlag = false;
    if (fullRerender) {
      ctx.onFullRender();
    } else {
      // Live data block
      const liveHost = $("snapLive");
      if (liveHost) liveHost.innerHTML = renderSnapmakerLiveInner(activePrinter);
      // Request-log block — the log no longer has a nested scroll
      // (the panel body scrolls instead), so a plain innerHTML swap
      // is enough. Older entries stay visible above; new ones append
      // at the top of the list because we sort newest-first.
      const logHost = $("snapLog");
      if (logHost) logHost.innerHTML = renderSnapmakerLogInner(activePrinter);
      const countEl = $("snapLogCount");
      if (countEl) {
        const c = _snapConns.get(snapKey(activePrinter))?.log?.length || 0;
        countEl.textContent = String(c);
      }
    }
  });
}

// ── Format helpers ────────────────────────────────────────────────────────

function snapFmtTemp(v) { return (typeof v === "number" && isFinite(v)) ? `${Math.round(v)}` : "—"; }
export function snapFmtTempPair(cur, tgt) {
  return `${snapFmtTemp(cur)}/${snapFmtTemp(tgt)}°C`;
}
export function snapFmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}
// Pick black or white text for a coloured background using sRGB luma —
// matches the contrast convention used elsewhere in the app.
export function snapTextColor(hex) {
  if (!hex || hex.length < 7) return "#fff";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#000" : "#fff";
}

// Inline SVGs for the small temp icons — kept as renderer constants so
// they pick up `currentColor` from the parent without extra CSS wiring.
export const SNAP_ICON_NOZZLE  = `<svg class="snap-temp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v6l-3 4-3-4z"/><path d="M9 17q1 2 0 4"/><path d="M12 17q1 2 0 4"/><path d="M15 17q1 2 0 4"/></svg>`;
export const SNAP_ICON_BED     = `<svg class="snap-temp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="16" x2="21" y2="16"/><path d="M7 12q1-3 0-5"/><path d="M12 12q1-3 0-5"/><path d="M17 12q1-3 0-5"/></svg>`;
export const SNAP_ICON_CHAMBER = `<svg class="snap-temp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M9 13q1-2 0-4"/><path d="M15 13q1-2 0-4"/></svg>`;
export const SNAP_ICON_CLOCK   = `<svg class="snap-job-time-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`;

// ── Filament edit — bottom sheet ──────────────────────────────────────────

/* ── Snapmaker manual filament edit — bottom sheet ───────────────
   Click on a colour square (or its edit icon) → opens a modal
   pre-filled with the current filament data. Confirming sends the
   SET_PRINT_FILAMENT_CONFIG g-code via the existing WebSocket so
   the printer's `print_task_config` updates and the new values
   stream back through `notify_status_update`.                       */

// 24 colour presets shown in the "Select Color" screen, ordered to
// match the mobile companion app's palette (5 per row, neutrals → cool
// → green → warm → red/pink → purple). The 25th slot is a "custom"
// chip that opens the native colour picker.
export const SNAP_FIL_COLOR_PRESETS = [
  "#000000", "#808080", "#CDCDCD", "#FFFFFF", "#135E7E",
  "#B6C3CB", "#4AB1F0", "#2641E9", "#2CDCA6", "#157F5F",
  "#1CB01C", "#C2E58C", "#FFE600", "#FF9933", "#6E4519",
  "#B58137", "#F0E6D6", "#D4C8AA", "#ED1C24", "#EC5A85",
  "#FF00FF", "#C8A4D6", "#8526D3", "#4B1F97"
];

// Vendor → materials map — iso to the mobile companion. The mobile
// ships with these 8 brands and the Generic 10-material catalogue;
// each brand falls back to the Generic list when it has no specific
// products (matches the Flutter "vendorToLabels.putIfAbsent + union
// fallback" pattern).
const SNAP_FIL_VENDOR_MATERIALS = {
  "Generic":   ["PLA", "PETG", "ABS", "TPU", "ABS-AF", "ABS-CF", "ASA", "ASA-CF", "ASA-GF", "Biopolymer"],
  "JamgHe":    [],
  "Landu":     [],
  "R3D":       [],
  "Rosa3D":    [],
  "Snapmaker": [],
  "Sunlu":     [],
  "eSun":      []
};
// Backwards compat — the chip-based code paths still reference these.
const SNAP_FIL_BRANDS    = Object.keys(SNAP_FIL_VENDOR_MATERIALS);
const SNAP_FIL_MATERIALS = SNAP_FIL_VENDOR_MATERIALS["Generic"];

// Sort materials with priority — PLA / PETG / ABS / TPU come first
// when they appear EXACTLY (variants like "ABS-AF" or "PLA Matte"
// fall to the alphabetical section, matching the mobile app's order).
const SNAP_FIL_PRIORITY = ["PLA", "PETG", "ABS", "TPU"];
export function snapSortMaterials(list) {
  const upper    = list.map(s => s.toUpperCase());
  const used     = new Set();
  const priority = [];
  for (const p of SNAP_FIL_PRIORITY) {
    const idx = upper.findIndex((u, i) => !used.has(i) && u === p);
    if (idx >= 0) { priority.push(list[idx]); used.add(idx); }
  }
  const rest = list.filter((_, i) => !used.has(i))
                   .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return [...priority, ...rest];
}

let _snapFilEdit = null; // { brand, deviceId, extruderIndex, conn }
let _sfeSelectedBrand = "";    // last chip-or-text value picked
let _sfeSelectedMaterial = ""; // last chip-or-text value picked

// Convert "#RRGGBB" or "#RRGGBBAA" to a Klipper-friendly 8-char
// lowercase RGBA hex string. We default alpha to ff (full opacity).
export function snapColorToRgbaHex(hex) {
  let v = (hex || "").trim();
  if (v.startsWith("#")) v = v.slice(1);
  if (v.length === 6) v += "ff";
  return v.toLowerCase().slice(0, 8);
}

// Sanitise free-text inputs so the resulting g-code line stays
// parseable on the Klipper side (no embedded spaces, no quotes).
export function snapSanitiseGcodeArg(s) {
  return String(s || "").trim().replace(/\s+/g, "-").replace(/["'`]/g, "");
}

// Send a single g-code line via the printer's existing WebSocket.
// Logs the outbound frame so it's visible in the request log too.
export function snapSendGcode(conn, script) {
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
  const msg = {
    jsonrpc: "2.0", id: 201,
    method: "printer.gcode.script",
    params: { script }
  };
  const json = JSON.stringify(msg);
  snapLogPush(conn, "→", json);
  conn.ws.send(json);
  return true;
}

// Render the LEFT column: list of vendors. Selected one is highlighted.
export function snapFilRenderVendorList(selected) {
  return SNAP_FIL_BRANDS.map(v => {
    const brandEntry = brands.get(v.toLowerCase().replace(/\s+/g, ""));
    const accent = brandEntry?.meta?.accent;
    const accentStyle = accent ? `style="--brand-accent:${accent}"` : "";
    const isSel = v.toLowerCase() === (selected || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}${accent ? " sfe-fil-row--brand" : ""}"
                    data-val="${ctx.esc(v)}" ${accentStyle}>${ctx.esc(v)}</button>`;
  }).join("");
}

// Render the RIGHT column: materials for the chosen vendor. Falls back
// to the Generic catalogue when the vendor has no specific products.
export function snapFilRenderMaterialList(vendor, selectedMat) {
  const list  = (SNAP_FIL_VENDOR_MATERIALS[vendor]?.length
                 ? SNAP_FIL_VENDOR_MATERIALS[vendor]
                 : SNAP_FIL_VENDOR_MATERIALS["Generic"]);
  const sorted = snapSortMaterials(list);
  return sorted.map(m => {
    const isSel = m.toLowerCase() === (selectedMat || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}" data-val="${ctx.esc(m)}">
              <span class="sfe-fil-row-text">${ctx.esc(m)}</span>
              ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ""}
            </button>`;
  }).join("");
}

export function openSnapFilamentEdit(printer, extruderIndex) {
  const conn = _snapConns.get(snapKey(printer));
  // The modal opens whatever the WS state — opening it should always
  // feel responsive on click. If the connection is down the Send
  // button will surface the error at submit time.
  const fil = (conn?.data?.filaments?.[extruderIndex]) || {};
  // RFID-locked filaments (`fil.official === true`) still open the
  // sheet, but in READ-ONLY mode: SAME layout / order / presentation
  // as the editable sheet, controls just disabled. The user reads
  // what the printer reported but can't mutate it.
  const readonly = !!fil.official;
  const sheetEl = $("snapFilEditSheet");
  if (sheetEl) sheetEl.classList.toggle("sfe-sheet--readonly", readonly);
  // Title swaps between "Edit filament" and "Read-only filament".
  const titleEl = $("snapFilEditTitle");
  if (titleEl) {
    const newKey = readonly ? "snapFilEditTitleReadonly" : "snapFilEditTitle";
    titleEl.textContent = ctx.t(newKey);
    titleEl.dataset.i18n = newKey; // keep i18n applier in sync if locale changes
  }
  // Native disabled flips — same controls, just inert. We re-apply
  // every open since the sheet is reused for every extruder click.
  const subEl   = $("sfeSubtype");
  const applyEl = $("snapFilEditSave");
  if (subEl)   subEl.disabled   = readonly;
  if (applyEl) applyEl.disabled = readonly;
  _snapFilEdit = { brand: printer.brand, deviceId: printer.id, extruderIndex, key: snapKey(printer), readonly };
  _sfeSelectedBrand    = fil.vendor  || "";
  _sfeSelectedMaterial = fil.type    || "";

  // Pre-fill form values
  const colorInp = $("sfeColorInput");
  const vendorInp= $("sfeVendor");
  const matInp   = $("sfeMaterial");
  const subInp   = $("sfeSubtype");
  if (colorInp) colorInp.value = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color)) ? fil.color.slice(0, 7) : "#FF5722";
  // Custom-text inputs: only show a value when the current vendor/material
  // is NOT in the predefined chip lists (otherwise the chip + the input
  // would echo the same value, which is noisy).
  if (vendorInp) vendorInp.value = SNAP_FIL_BRANDS.some(b => b.toLowerCase() === _sfeSelectedBrand.toLowerCase()) ? "" : (fil.vendor || "");
  if (matInp)    matInp.value    = SNAP_FIL_MATERIALS.some(m => m.toLowerCase() === _sfeSelectedMaterial.toLowerCase()) ? "" : (fil.type || "");

  // Sub-type select — populated from the id_aspect catalog so we
  // always send a documented value to the printer. Filter out the
  // "-" / "None" placeholders. Sort alphabetically but pin "Basic"
  // to the top since it's the default + most common.
  if (subInp && subInp.tagName === "SELECT") {
    const aspects = (ctx.getState().db?.aspect || [])
      .filter(a => a && a.label && a.label !== "-" && a.label.toLowerCase() !== "none")
      .map(a => a.label);
    aspects.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const basicIdx = aspects.findIndex(l => l.toLowerCase() === "basic");
    if (basicIdx > 0) { aspects.splice(basicIdx, 1); aspects.unshift("Basic"); }
    // Add the current value as a custom option if it doesn't match any
    // aspect — preserves user-typed legacy values without silently
    // dropping them.
    const cur = String(fil.subType || "").trim();
    const isKnown = !!cur && aspects.some(a => a.toLowerCase() === cur.toLowerCase());
    const opts = [];
    if (cur && !isKnown) opts.push(`<option value="${ctx.esc(cur)}" selected>${ctx.esc(cur)} (custom)</option>`);
    for (const label of aspects) {
      const isSel = isKnown ? cur.toLowerCase() === label.toLowerCase()
                            : label === "Basic";
      opts.push(`<option value="${ctx.esc(label)}"${isSel ? " selected" : ""}>${ctx.esc(label)}</option>`);
    }
    subInp.innerHTML = opts.join("");
  }

  // Header sub on the summary screen
  // Subtitle deliberately blank — the user already sees which
  // printer + extruder they tapped from in the side card behind the
  // sheet, no need to repeat it here.
  $("snapFilEditSub").textContent = "";
  $("sfeError").hidden = true;

  // Render the colour grid (24 presets + 1 custom). The custom slot has
  // its own inline <input type="color"> rendered by sfeRenderColorGrid —
  // we just feed it the initial colour.
  const initialColor = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color)) ? fil.color.slice(0, 7) : "#FF5722";
  sfeRenderColorGrid(initialColor);

  // Two-column filament picker. Pre-select the vendor that matches
  // the current filament (or the first one if nothing matches).
  const vendorList = $("sfeVendorList");
  const matList    = $("sfeMaterialList");
  if (vendorList) {
    const vendorMatch = SNAP_FIL_BRANDS.find(b => b.toLowerCase() === _sfeSelectedBrand.toLowerCase())
                     || SNAP_FIL_BRANDS[0];
    _sfeSelectedBrand = vendorMatch;
    vendorList.innerHTML = snapFilRenderVendorList(vendorMatch);
  }
  if (matList) {
    matList.innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
  }

  // Always start with the sub-pickers closed so only the summary shows.
  sfeCloseFilamentSheet();
  sfeCloseColorSheet();
  sfeUpdateSummary();

  // Show the sheet
  $("snapFilEditSheet").classList.add("open");
  $("snapFilEditSheet").setAttribute("aria-hidden", "false");
  $("snapFilEditBackdrop").classList.add("open");
}

// Both sub-pickers (Filament + Colour) are now standalone sheets that
// STACK on top of the summary sheet — the summary stays visible
// behind so the user keeps their context. Each has its own slide-up
// animation triggered by the .open class.
function sfeOpenFilamentSheet() {
  $("sfeFilamentSheet")?.classList.add("open");
  $("sfeFilamentSheet")?.setAttribute("aria-hidden", "false");
}
function sfeCloseFilamentSheet() {
  $("sfeFilamentSheet")?.classList.remove("open");
  $("sfeFilamentSheet")?.setAttribute("aria-hidden", "true");
}
function sfeOpenColorSheet() {
  $("sfeColorSheet")?.classList.add("open");
  $("sfeColorSheet")?.setAttribute("aria-hidden", "false");
}
function sfeCloseColorSheet() {
  $("sfeColorSheet")?.classList.remove("open");
  $("sfeColorSheet")?.setAttribute("aria-hidden", "true");
}

// Refresh the summary screen — Line 1 (filament summary text), Line 2
// (colour dot). Called whenever a sub-screen commits a new value.
function sfeUpdateSummary() {
  const v   = _sfeSelectedBrand    || "—";
  const m   = _sfeSelectedMaterial || "—";
  const sub = $("sfeSubtype")?.value?.trim() || "";
  const summary = sub ? `${v} ${m} ${sub}` : `${v} ${m}`;
  const valEl = $("sfeFilSummaryVal");
  if (valEl) valEl.textContent = summary;
  const dot = $("sfeColorSummaryDot");
  if (dot) dot.style.background = $("sfeColorInput")?.value || "#888";
}

// Render the colour grid: 24 presets + a 25th "custom" slot. The
// custom slot is a wrapper containing a transparent `<input
// type="color">` overlaid on top — the wrapper shows the current
// colour + edit icon, the input receives the click and anchors the
// OS-native picker right where it lives. Without this overlay trick
// the picker pops up in the top-left of the window because a
// `display:none` input has no visual anchor.
function sfeRenderColorGrid(currentColor) {
  const grid = $("sfeColorGrid");
  if (!grid) return;
  const cur = (currentColor || "").toLowerCase();
  const presetCells = SNAP_FIL_COLOR_PRESETS.map(c => {
    const isSel = c.toLowerCase() === cur;
    return `<button type="button" class="sfe-color-cell${isSel ? " is-selected" : ""}"
                    data-color="${ctx.esc(c)}"
                    style="background:${ctx.esc(c)}"
                    title="${ctx.esc(c)}"></button>`;
  }).join("");
  const safeColor = currentColor && /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#888888";
  const customCell = `
    <div class="sfe-color-cell sfe-color-cell--custom" id="sfeColorCustomBtn"
         style="background:${ctx.esc(safeColor)}"
         title="${ctx.esc(ctx.t("snapFilEditCustomColor") || "Custom")}">
      <span class="icon icon-edit icon-13"></span>
      <input type="color" class="sfe-color-cell-native" id="sfeColorPickerInline"
             value="${ctx.esc(safeColor)}" aria-label="Custom color"/>
    </div>`;
  grid.innerHTML = presetCells + customCell;
}

export function closeSnapFilamentEdit() {
  $("snapFilEditSheet")?.classList.remove("open");
  $("snapFilEditSheet")?.setAttribute("aria-hidden", "true");
  $("snapFilEditBackdrop")?.classList.remove("open");
  // Both stacked sub-sheets follow the summary down so nothing is
  // left dangling when the whole edit flow is closed.
  sfeCloseFilamentSheet();
  sfeCloseColorSheet();
  _snapFilEdit = null;
}

// ── DOM event wiring ──────────────────────────────────────────────────────

// ✕ on the SUMMARY closes the whole flow (summary + any open picker).
// ✕ on a picker only closes that picker (handled separately below).
$("snapFilEditClose")?.addEventListener("click", closeSnapFilamentEdit);
$("snapFilEditBackdrop")?.addEventListener("click", closeSnapFilamentEdit);
$("sfeColorClose")?.addEventListener("click", () => {
  sfeUpdateSummary();
  sfeCloseColorSheet();
});

// ── Summary → sub-sheet navigation. Each sub-picker is its own sheet
// that stacks on top of the summary; the summary stays visible behind. ─
$("sfeOpenFilament")?.addEventListener("click", () => {
  // Read-only mode (RFID-locked filament): the summary rows are
  // still visible but the user can't dive into sub-pickers — the
  // chevron is hidden but the underlying button still listens, so
  // we guard here so clicks don't pop open the picker silently.
  if (_snapFilEdit?.readonly) return;
  sfeOpenFilamentSheet();
  // Auto-scroll the selected vendor into view in the left column.
  setTimeout(() => {
    const sel = $("sfeVendorList")?.querySelector(".is-selected");
    if (sel) sel.scrollIntoView({ block: "center", behavior: "auto" });
  }, 0);
});
$("sfeOpenColor")?.addEventListener("click", () => {
  if (_snapFilEdit?.readonly) return; // read-only: no colour picker
  sfeOpenColorSheet();
});

// Back buttons on the stacked sub-sheets — close the sheet, leave
// the summary visible behind, and refresh its preview values.
$("sfeFilamentBack")?.addEventListener("click", () => {
  sfeUpdateSummary();
  sfeCloseFilamentSheet();
});
$("sfeColorBack")?.addEventListener("click", () => {
  sfeUpdateSummary();
  sfeCloseColorSheet();
});
// Filament close (X on the picker header) — same behaviour as Back
// (both keep the summary alive, only kill the picker).
$("sfeFilamentClose")?.addEventListener("click", () => {
  sfeUpdateSummary();
  sfeCloseFilamentSheet();
});

// Sub-type changes update the summary line live. `change` covers
// <select> dropdowns; `input` covers any future free-text fallback.
$("sfeSubtype")?.addEventListener("change", sfeUpdateSummary);
$("sfeSubtype")?.addEventListener("input",  sfeUpdateSummary);

// ── Filament screen — vendor/material clicks ──────────────────────
$("sfeVendorList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _sfeSelectedBrand = row.dataset.val || "";
  $("sfeVendorList").querySelectorAll(".sfe-fil-row").forEach(r =>
    r.classList.toggle("is-selected", r === row));
  const matList = $("sfeMaterialList");
  if (matList) matList.innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
  const v = $("sfeVendor"); if (v) v.value = "";
});
// Tapping a material commits the (vendor, material) pair and goes
// back to the summary screen — same flow as the mobile app. Picking
// a new filament also wipes the sub-type input: the previous
// sub-type was specific to the old filament and is meaningless for
// the new one (e.g. "Speed Matt" stops making sense once you switch
// from Rosa3D ASA to Bambu Lab PETG).
$("sfeMaterialList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _sfeSelectedMaterial = row.dataset.val || "";
  const m = $("sfeMaterial"); if (m) m.value = "";
  // Reset the sub-type to "Basic" when picking a new filament — the
  // previous sub-type was specific to the old filament. Falls back
  // to the first option if "Basic" isn't there for some reason.
  const sub = $("sfeSubtype");
  if (sub && sub.tagName === "SELECT") {
    const basicOpt = Array.from(sub.options).find(o => o.value.toLowerCase() === "basic");
    if (basicOpt) sub.value = basicOpt.value;
    else if (sub.options.length) sub.selectedIndex = 0;
  } else if (sub) {
    sub.value = "";
  }
  // Re-render with the green check, then close the picker — the
  // summary sheet underneath shows the new "Brand Material" line.
  $("sfeMaterialList").innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
  setTimeout(() => {
    sfeUpdateSummary();
    sfeCloseFilamentSheet();
  }, 180);
});

// ── Color screen — preset cell click + custom slot inline input ──
// The custom slot has its native <input type="color"> overlaid on top
// (transparent), so a click on the slot opens the OS picker anchored
// to the slot itself. We listen to `input` (live drag) and `change`
// (final pick) via delegation since the grid is re-rendered on each
// colour change.
$("sfeColorGrid")?.addEventListener("click", e => {
  // Don't intercept clicks bubbling from the inline picker — let the
  // native input handle them (it's covered by the wrapper anyway).
  if (e.target.closest("#sfeColorPickerInline")) return;
  const cell = e.target.closest(".sfe-color-cell:not(.sfe-color-cell--custom)");
  if (!cell) return;
  const c = cell.dataset.color;
  if (!c) return;
  $("sfeColorInput").value = c;
  sfeRenderColorGrid(c);
  setTimeout(() => {
    sfeUpdateSummary();
    sfeCloseColorSheet();
  }, 150);
});
// Live preview while the user drags the OS picker — updates the
// hidden input + repaints the custom slot so it reflects the chosen
// hue in real time. Delegated since the grid re-renders.
$("sfeColorGrid")?.addEventListener("input", e => {
  if (!e.target.matches?.("#sfeColorPickerInline")) return;
  const c = e.target.value;
  $("sfeColorInput").value = c;
  // Update just the wrapper background — re-rendering the whole grid
  // here would close the OS picker mid-drag.
  const wrap = e.target.closest(".sfe-color-cell--custom");
  if (wrap) wrap.style.background = c;
});
// Final commit (the user closed the OS picker) — re-render the grid
// so the new colour shows as "selected" if it matches a preset, then
// bounce back to the summary.
$("sfeColorGrid")?.addEventListener("change", e => {
  if (!e.target.matches?.("#sfeColorPickerInline")) return;
  const c = e.target.value;
  $("sfeColorInput").value = c;
  sfeRenderColorGrid(c);
  setTimeout(() => {
    sfeUpdateSummary();
    sfeCloseColorSheet();
  }, 100);
});

// Send button → build the SET_PRINT_FILAMENT_CONFIG line and push it
// to the printer. Format ported from the Flutter mobile app.
$("snapFilEditSave")?.addEventListener("click", async () => {
  if (!_snapFilEdit) return;
  const conn = _snapConns.get(_snapFilEdit.key);
  if (!conn) return;
  const errEl = $("sfeError");
  errEl.hidden = true;

  // Vendor + material come either from a chip (last clicked) or from
  // the custom-text input — whichever the user touched most recently.
  const vendor   = snapSanitiseGcodeArg($("sfeVendor").value || _sfeSelectedBrand)    || "Generic";
  const material = snapSanitiseGcodeArg($("sfeMaterial").value || _sfeSelectedMaterial) || "PLA";
  const subtype  = snapSanitiseGcodeArg($("sfeSubtype").value);
  const rgba     = snapColorToRgbaHex($("sfeColorInput").value);

  // Snapmaker firmware requires every named arg to be present in the
  // command line — omitting `FILAMENT_SUBTYPE` causes it to silently
  // ignore the whole call. We always emit the key, with an empty
  // value when the user didn't provide a sub-type.
  const parts = [
    "SET_PRINT_FILAMENT_CONFIG",
    `CONFIG_EXTRUDER=${_snapFilEdit.extruderIndex}`,
    `VENDOR=${vendor}`,
    `FILAMENT_TYPE=${material}`,
    `FILAMENT_SUBTYPE=${subtype}`,
    `FILAMENT_COLOR_RGBA=${rgba}`
  ];
  const script = parts.join(" ");

  // Mirror the outgoing g-code to DevTools so the user can verify the
  // exact line that was pushed to Klipper without scrolling the log.
  console.log("[snap] → gcode:", script);

  const btn = $("snapFilEditSave");
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    const ok = snapSendGcode(conn, script);
    if (!ok) throw new Error("websocket not open");
    // Close immediately; the printer's notify_status_update will arrive
    // moments later and refresh the colour square / vendor labels.
    closeSnapFilamentEdit();
  } catch (e) {
    console.warn("[snap] filament edit send failed:", e?.message);
    errEl.textContent = ctx.t("snapFilEditError");
    errEl.hidden = false;
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
});

// ── Moonraker file path / thumbnail helpers ───────────────────────────────

/* ── Moonraker file path / thumbnail helpers ──────────────────────
   Klipper exposes the active job's filename as something like
   "/printer_data/gcodes/folder/Lame ryobi.gcode" — we have to peel it
   down to "folder/Lame ryobi.gcode" before we can pass it to the
   metadata endpoint, and again to build thumbnail URLs.              */

function snapNormalizePath(path) {
  const out = [];
  for (const raw of String(path || "").split("/")) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}
function snapJoinPath(a, b) {
  const left  = (a || "").trim();
  const right = (b || "").trim();
  if (!left)  return snapNormalizePath(right);
  if (!right) return snapNormalizePath(left);
  return snapNormalizePath(`${left}/${right}`);
}
export function snapFilenameRel(absPath) {
  let s = String(absPath || "").trim();
  if (!s) return "";
  if (s.startsWith("/")) {
    const i = s.indexOf("/gcodes/");
    if (i >= 0) s = s.slice(i + "/gcodes/".length);
    else {
      const i2 = s.indexOf("/printer_data/gcodes/");
      if (i2 >= 0) s = s.slice(i2 + "/printer_data/gcodes/".length);
    }
  } else if (s.startsWith("gcodes/")) {
    s = s.slice("gcodes/".length);
  }
  return snapNormalizePath(s);
}
function snapParentFolder(filename) {
  const c = snapNormalizePath(filename);
  const i = c.lastIndexOf("/");
  return i <= 0 ? "" : c.substring(0, i);
}
function snapFileUrl(ip, relativePath) {
  const cleaned = snapNormalizePath(relativePath);
  const parts = cleaned.split("/").filter(Boolean).map(encodeURIComponent);
  return `http://${ip}:7125/server/files/gcodes/${parts.join("/")}`;
}
function snapBestThumb(metadata) {
  const arr = metadata?.thumbnails;
  if (!Array.isArray(arr) || !arr.length) return null;
  let best = null, bestScore = -1;
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const w = +t.width || 0, h = +t.height || 0, sz = +t.size || 0;
    const score = (w > 0 && h > 0) ? (w * h) : sz;
    if (score >= bestScore) { bestScore = score; best = t; }
  }
  return best;
}
function snapThumbUrl(ip, filename, metadata) {
  const t = snapBestThumb(metadata);
  if (!t) return null;
  const rel = String(t.relative_path || t.thumbnail_path || "").trim();
  if (!rel) return null;
  const folder = snapParentFolder(filename);
  return snapFileUrl(ip, snapJoinPath(folder, rel));
}

// GET http://{ip}:7125/server/files/metadata?filename=...
// Stores the slicer thumbnail URL + estimated print time on the
// connection so the job card can render them. Idempotent — guarded by
// `_lastMetaFile` so we don't refetch on every WS frame.
async function snapFetchMetadata(conn, relFilename) {
  if (!relFilename || !conn.ip) return;
  if (conn.data._lastMetaFile === relFilename) return;
  conn.data._lastMetaFile = relFilename;
  const url = `http://${conn.ip}:7125/server/files/metadata?filename=${encodeURIComponent(relFilename)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return;
    const json = await res.json();
    const meta = (json && json.result) ? json.result : json;
    if (!meta || typeof meta !== "object") return;
    conn.data.printPreviewUrl = snapThumbUrl(conn.ip, relFilename, meta) || null;
    conn.data.printEstimated  = (typeof meta.estimated_time === "number") ? meta.estimated_time : null;
    snapNotifyChange(conn);
  } catch (_) {
    // Network failure is non-fatal — the card falls back to the
    // printer's catalog image and skips the estimated-time display.
  }
}

// Convert a Klipper RGBA-hex string ("#RRGGBBAA" or "RRGGBB") to a
// browser-friendly "#RRGGBB" string, dropping the alpha.
export function snapParseRgbaHex(s) {
  let v = (s || "").trim();
  if (!v) return null;
  if (v.startsWith("#")) v = v.slice(1);
  if (v.length === 8) v = v.slice(0, 6); // drop alpha
  if (v.length !== 6) return null;
  return "#" + v.toUpperCase();
}

// ── Request log ───────────────────────────────────────────────────────────

/* ── Request log — what we send / what the printer answers ──────────
   Stored on `conn.log` as an array of { dir: "→"|"←", ts, summary, raw }.
   The UI is a collapsible section at the bottom of the live block.
   Each line is clickable to copy the raw JSON to the clipboard.       */
// Visible-buffer cap. Older entries fall off so we never grow without
// bound — 100 frames is enough to debug a request flow without bloating
// memory on long-running sessions.
const SNAP_LOG_MAX = 100;
function snapLogPush(conn, dir, raw) {
  // When the user has frozen the log via the Pause toggle, drop new
  // frames so what's on screen stays stable for inspection.
  if (conn.logPaused) return;
  if (!conn.log) conn.log = [];
  let summary = "";
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj?.method) summary = obj.method;
    else if (obj?.result && typeof obj.result === "object") {
      const keys = obj.result.status ? Object.keys(obj.result.status) : Object.keys(obj.result);
      summary = "result · " + keys.slice(0, 4).join(", ");
    } else summary = "(no method)";
    if (typeof obj?.id !== "undefined") summary += `  id:${obj.id}`;
  } catch { summary = "(non-json)"; }
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  conn.log.push({ dir, ts, summary, raw: rawStr });
  if (conn.log.length > SNAP_LOG_MAX) conn.log.splice(0, conn.log.length - SNAP_LOG_MAX);
}

// ── Live block renderer ───────────────────────────────────────────────────

// Returns the inner HTML for the Snapmaker live container.
// Layout (matches the TigerTag mobile companion app):
//   1. Connection header (LED + status + IP)
//   2. Camera (full-width, on top — first signal of "yes the printer is there")
//   3. Print-job card (only when actively printing)
//   4. Temperature row — compact pills "26/0°C" for each E + bed
//   5. Filament grid — big coloured squares with material name centered,
//      vendor + sub-type below
export function renderSnapmakerLiveInner(p) {
  const conn = _snapConns.get(snapKey(p));
  if (!conn) return `
    <div class="snap-empty">
      <span class="icon icon-cloud icon-18"></span>
      <span>${ctx.esc(ctx.t("snapNoConnection"))}</span>
    </div>`;
  const b = brands.get('snapmaker');
  return `
    ${b.renderJobCard(p, conn)}
    ${b.renderTempCard(conn)}
    ${b.renderFilamentCard(p, conn)}`;
}

// ── Custom JSON sender ────────────────────────────────────────────────────

// Send a hand-crafted JSON-RPC frame from the paste textarea straight
// through the WebSocket. Useful for testing custom Moonraker calls
// without leaving the UI. The pasted payload is forwarded VERBATIM —
// we don't wrap it in a JSON-RPC envelope, the user is expected to
// provide a complete `{ jsonrpc, id, method, params }` object.
export function snapSendCustomJson() {
  const ta  = $("snapLogPasteInput");
  const err = $("snapLogPasteError");
  if (!ta || !err) return;
  err.hidden = true;

  const activePrinter = ctx.getActivePrinter();
  const conn = activePrinter ? _snapConns.get(snapKey(activePrinter)) : null;
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) {
    err.textContent = ctx.t("snapPasteNotConnected") || "Printer not connected.";
    err.hidden = false;
    return;
  }

  let obj;
  try { obj = JSON.parse(ta.value); }
  catch (e) {
    err.textContent = (ctx.t("snapPasteInvalidJson") || "Invalid JSON:") + " " + (e?.message || e);
    err.hidden = false;
    return;
  }

  const json = JSON.stringify(obj);
  snapLogPush(conn, "→", json);
  try {
    conn.ws.send(json);
  } catch (e) {
    err.textContent = (ctx.t("snapPasteSendError") || "Send failed:") + " " + (e?.message || e);
    err.hidden = false;
    return;
  }
  // Re-render the log so the new outbound frame appears at the top.
  const host = $("snapLog");
  if (host) host.innerHTML = renderSnapmakerLogInner(activePrinter);
  const countEl = $("snapLogCount");
  if (countEl) countEl.textContent = String(conn.log?.length || 0);
  // Visual confirmation on the Send button.
  const btn = $("snapLogPasteSendBtn");
  if (btn) {
    btn.classList.add("snap-log-paste-send--ok");
    setTimeout(() => btn.classList.remove("snap-log-paste-send--ok"), 700);
  }
}

// ── Log renderer ──────────────────────────────────────────────────────────

// Inner contents of the log container — replaced on every re-render.
// Rows are click-to-expand: each shows a one-line summary; on click,
// the full pretty-printed JSON appears inline with its own copy
// button. Pausing the stream (via the toolbar) freezes the log so the
// user can inspect a long frame at their own pace.
export function renderSnapmakerLogInner(p) {
  const conn = _snapConns.get(snapKey(p));
  const log = conn?.log || [];
  if (!log.length) {
    return `<div class="snap-log-empty">${ctx.esc(ctx.t("snapLogEmpty"))}</div>`;
  }
  const rows = log.slice().reverse().map((e, i) => {
    let pretty = e.raw;
    try { pretty = JSON.stringify(JSON.parse(e.raw), null, 2); } catch (_) {}
    // We index from the END (newest first) because that's the visible
    // order. The expanded flag lives on the entry object so it persists
    // across partial re-renders (when paused, no re-render happens; when
    // streaming, expansions reset — that's the trade-off).
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

// ── Self-registration ─────────────────────────────────────────────────────

registerBrand('snapmaker', {
  meta, schema, helper,
  renderJobCard:        renderSnapJobCard,
  renderTempCard:       renderSnapTempCard,
  renderFilamentCard:   renderSnapFilamentCard,
  renderSettingsWidget: schemaWidget(schema),
});

// ── Additional exports (for inventory.js to import) ──────────────────────
// Functions below are used internally AND need to be callable from
// inventory.js event handlers / Object.assign(_printerCtx) block.
// Functions already declared with `export function` above don't need
// a second export statement — they are re-listed here only for clarity.

export {
  snapNormalizePath,
  snapJoinPath,
  snapParentFolder,
  snapFileUrl,
  snapBestThumb,
  snapThumbUrl,
  snapFetchMetadata,
};
