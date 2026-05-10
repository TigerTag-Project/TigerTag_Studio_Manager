/**
 * printers/creality/index.js — Creality K-series live integration.
 *
 * WebSocket port 9999 — single init query on connect, printer pushes updates.
 * No periodic polling. Protocol documented in PROTOCOL.md.
 * Protocol ported from creality_websocket_page.dart.
 * Self-registers into the brands registry at module evaluation time.
 */
import { ctx } from '../context.js';
import { registerBrand } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { schemaWidget } from '../modal-helpers.js';

// ── Private connection state ──────────────────────────────────────────────

// Per-printer live state. Keyed by `${brand}:${id}` (same as snap/ffg).
const _creConns = new Map();
// Reachability cache for the Online/Offline grid dot (30 s TTL).
const _crePings = new Map(); // key -> { online: bool|null, lastChecked: number }

// ── Protocol constants ────────────────────────────────────────────────────

// Sent once on connect — requests everything needed for the initial render.
// The printer then pushes updates on its own; we do NOT poll periodically.
const CRE_INIT_QUERY = JSON.stringify({
  method: "get",
  params: { boxsInfo: 1, boxConfig: 1, reqGcodeFile: 1, reqGcodeList: 1, reqMaterials: 1, getGcodeFileInfo2: 1 }
});

// On-demand queries — sent only when the relevant UI is opened.
const CRE_QUERY_FILES = JSON.stringify({ method: "get", params: { getGcodeFileInfo2: 1 } });

// ── Public helpers ────────────────────────────────────────────────────────

export function creKey(p) { return `${p.brand}:${p.id}`; }

// Read-only access to a live connection object (for panel event handlers in
// inventory.js that need to mutate conn.log / conn.logPaused).
export function creGetConn(key) { return _creConns.get(key) ?? null; }

// Authoritative "is this Creality printer reachable?" reading.
// Prefers live WebSocket state; falls back to the HTTP ping cache.
export function creIsOnline(printer) {
  if (printer?.brand !== "creality") return null;
  const k = creKey(printer);
  const conn = _creConns.get(k);
  if (conn) return conn.status === "connected";
  const ping = _crePings.get(k);
  return ping ? ping.online : null;
}

// Quick reachability probe — opens a WS, marks online on open, then
// closes it. 2 s timeout. Used for the grid card dot when no live
// connection is active (panel closed).
export async function crePingPrinter(printer) {
  if (!printer || printer.brand !== "creality" || !printer.ip) return;
  const k = creKey(printer);
  const cached = _crePings.get(k);
  const now = Date.now();
  if (cached && now - cached.lastChecked < 30_000) return;
  _crePings.set(k, { online: cached?.online ?? null, lastChecked: now });
  let resolved = false;
  const done = (online) => {
    if (resolved) return; resolved = true;
    _crePings.set(k, { online, lastChecked: now });
    creRefreshOnlineUI(k);
  };
  let ws;
  try { ws = new WebSocket(`ws://${printer.ip}:9999`); } catch { done(false); return; }
  const tm = setTimeout(() => { done(false); try { ws.close(); } catch {} }, 2000);
  ws.addEventListener("open",  () => { done(true);  clearTimeout(tm); try { ws.close(); } catch {} });
  ws.addEventListener("error", () => { done(false); clearTimeout(tm); });
  ws.addEventListener("close", () => { if (!resolved) { done(false); clearTimeout(tm); } });
}

export function crePingAllPrinters() {
  for (const p of ctx.getState().printers) {
    if (p.brand === "creality" && p.ip) crePingPrinter(p);
  }
}
setInterval(crePingAllPrinters, 30_000);

// Surgical DOM update — replace just the online dot without full re-render.
export function creRefreshOnlineUI(key) {
  document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
    const p = ctx.getState().printers.find(x => creKey(x) === key);
    el.outerHTML = renderCreOnlineBadge(p, "card");
  });
  const activePrinter = ctx.getActivePrinter();
  if (activePrinter && creKey(activePrinter) === key) {
    const host = document.getElementById("ppOnlineRow");
    if (host) host.outerHTML = renderCreOnlineBadge(activePrinter, "side");
  }
}

// Online badge HTML — mirrors renderSnapOnlineBadge in shape.
export function renderCreOnlineBadge(printer, where) {
  if (!printer || printer.brand !== "creality") return "";
  const online = creIsOnline(printer);
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

// ── WebSocket lifecycle ───────────────────────────────────────────────────

export function creConnect(printer) {
  const key = creKey(printer);
  const existing = _creConns.get(key);
  if (existing && existing.ws &&
      (existing.ws.readyState === WebSocket.OPEN ||
       existing.ws.readyState === WebSocket.CONNECTING)) {
    if (existing.ip === printer.ip) return; // already connected to same IP
    creDisconnect(key);
  }
  const conn = {
    ip:       printer.ip,
    account:  (printer.account  || "").trim(),
    password: (printer.password || "").trim(),
    key,
    ws:         null,
    status:     "connecting", // "connecting" | "connected" | "offline" | "error"
    lastError:  null,
    retry:      0,
    retryTimer: null,
    log:        [],
    logPaused:  false,
    logExpanded: false,
    data: {
      nozzleTemp:    null,  nozzleTarget: null,
      bedTemp:       null,  bedTarget:    null,
      chamberTemp:   null,  // boxTemp or chamberTemp field
      state:         0,     // 0=idle, 1=printing, 2=finished
      deviceState:   null,
      feedState:     null,
      printProgress: 0,     // 0-100
      dProgress:     0,     // alternate progress field (some FW)
      printFileName: null,
      lastHistoryFilename: null, // fallback filename from historyList
      printJobTime:  0,     // elapsed seconds
      printLeftTime: 0,     // remaining seconds
      layer:         0,
      totalLayer:    0,
      // boxsInfo response — kept raw; parsed by renderCrealityLiveInner
      boxsInfoRaw:   null,  // full obj that contained key 'boxsInfo'
      hostname:      null,
      webrtcSupport: 0,
      video:         0,
      // Peripherals
      lightSw:       null,   // 1 = LED on
      cfsConnect:    null,   // 1 = CFS module plugged in
      // Motion / live stats
      curFeedratePct:  null, // speed multiplier %
      curFlowratePct:  null, // flow-rate multiplier %
      curPosition:     null, // "X:5.00 Y:110.00 Z:20.59"
      realTimeSpeed:   null, // mm/s (string from printer, stored as number)
      realTimeFlow:    null, // mm³/s  "
      pressureAdvance: null, // float  "
      usedMaterialLength: null, // mm consumed in current job
      // State nuance
      isPaused:      false,
      // Errors
      errCode:       0,
      errKey:        0,
      errValue:      "",
      // Hardware limits
      maxNozzleTemp: null,
      maxBedTemp:    null,
      // Model
      model:         null,
      modelVersion:  null,
      // File explorer (loaded via WS getGcodeFileInfo2 — see CRE_QUERY_FILES)
      fileList:        null,   // null = not loaded, [] = empty, Array = loaded
      fileListLoading: false
    }
  };
  _creConns.set(key, conn);
  creOpenSocket(conn);
}

export function creDisconnect(key) {
  const conn = _creConns.get(key);
  if (!conn) return;
  if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
  if (conn.ws) { try { conn.ws.close(); } catch {} conn.ws = null; }
  _creConns.delete(key);
}

// ── Camera — direct WebRTC in renderer (no <webview>) ─────────────────────
//
// The Creality printer exposes a WebRTC endpoint at http://<ip>:8000/.
// ── Private WebSocket internals ───────────────────────────────────────────

function creOpenSocket(conn) {
  if (!conn.ip) { conn.status = "error"; conn.lastError = "no IP"; return; }
  // Basic auth via URL credentials — the only approach available in the browser
  // WebSocket API (custom headers are not supported). Matches _buildCreAuthHeader()
  // from the Flutter app: base64(account:password) → Authorization: Basic …
  // When account and password are both empty, use the plain URL (no auth).
  let wsUrl = `ws://${conn.ip}:9999`;
  if (conn.account || conn.password) {
    wsUrl = `ws://${encodeURIComponent(conn.account)}:${encodeURIComponent(conn.password)}@${conn.ip}:9999`;
  }
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) {
    conn.status = "error"; conn.lastError = String(e?.message || e);
    creNotifyChange(conn); creScheduleReconnect(conn); return;
  }
  conn.ws = ws;
  conn.status = "connecting";
  creNotifyChange(conn);

  ws.addEventListener("open", () => {
    conn.status = "connected"; conn.lastError = null; conn.retry = 0;
    // Single init query — the printer pushes updates on its own after this.
    // No polling needed.
    creLogPush(conn, "→", CRE_INIT_QUERY);
    ws.send(CRE_INIT_QUERY);
    creNotifyChange(conn, /*statusChanged*/ true);
  });

  ws.addEventListener("message", ev => {
    // Fast-path: literal "ok" is an ACK to our sends — ignore
    if (ev.data === "ok") return;

    creLogPush(conn, "←", ev.data);
    let obj; try { obj = JSON.parse(ev.data); } catch { return; }

    // Heartbeat: printer sends {ModeCode:"heart_beat"} — must reply with literal "ok"
    if (obj?.ModeCode === "heart_beat") {
      try { ws.send("ok"); } catch {}
      return;
    }

    creMergeStatus(conn, obj);
    creNotifyChange(conn);
  });

  ws.addEventListener("close", () => {
    conn.status = "offline";
    creNotifyChange(conn, /*statusChanged*/ true);
    creScheduleReconnect(conn);
  });

  ws.addEventListener("error", () => { conn.lastError = "websocket error"; });
}

function creScheduleReconnect(conn) {
  if (conn.retryTimer) return;
  if (!_creConns.has(conn.key)) return; // disposed
  conn.retry = Math.min(conn.retry + 1, 5);
  const delay = Math.min(2000 * (1 << (conn.retry - 1)), 30000);
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    if (!_creConns.has(conn.key)) return;
    creOpenSocket(conn);
  }, delay);
}

// ── Status merger ─────────────────────────────────────────────────────────
// Creality response is a flat JSON object at root level (no nesting).

// ── Action helpers ────────────────────────────────────────────────────────

// Send a `set` command. Logs it and returns true on success.
function creSendSet(conn, params) {
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
  const msg = JSON.stringify({ method: "set", params });
  try { conn.ws.send(msg); creLogPush(conn, "→", msg); return true; }
  catch { return false; }
}

// Toggle LED strip on/off (optimistic update — don't wait for printer echo).
export function creActionLed(printer) {
  const conn = _creConns.get(creKey(printer));
  if (!conn || conn.status !== "connected") return;
  const newVal = conn.data.lightSw === 1 ? 0 : 1;
  conn.data.lightSw = newVal;
  creSendSet(conn, { lightSw: newVal });
  creNotifyChange(conn);
}

// Pause / resume active print. Printer echoes back updated state.
// Confirmation is handled by hold-to-confirm in inventory.js (1 s hold).
export function creActionPause(printer) {
  const conn = _creConns.get(creKey(printer));
  if (!conn || conn.status !== "connected") return;
  creSendSet(conn, { pause: conn.data.isPaused ? 0 : 1 });
}

// Cancel active print.
// Confirmation is handled by hold-to-confirm in inventory.js (2 s hold).
export function creActionStop(printer) {
  const conn = _creConns.get(creKey(printer));
  if (!conn || conn.status !== "connected") return;
  creSendSet(conn, { stop: 1 });
}

// ── File explorer — WebSocket `retGcodeFileInfo2` (richer than Moonraker) ─

// Request the file list over the already-open WS (fire-and-forget).
// The response arrives as `retGcodeFileInfo2` and is captured by creMergeStatus.
function creLoadFileListConn(conn) {
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return;
  conn.data.fileListLoading = true;
  creNotifyChange(conn);
  try { conn.ws.send(CRE_QUERY_FILES); creLogPush(conn, "→", CRE_QUERY_FILES); }
  catch { conn.data.fileListLoading = false; creNotifyChange(conn); }
}

export function creLoadFileList(printer) {
  const conn = _creConns.get(creKey(printer));
  if (conn) creLoadFileListConn(conn);
}

// Start a print via Moonraker HTTP (port 7125 — confirmed working).
export async function creActionPrintFile(printer, filename) {
  const conn = _creConns.get(creKey(printer));
  if (!conn || conn.status !== "connected") return;
  try {
    const resp = await fetch(`http://${conn.ip}:7125/printer/print/start`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ filename }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      console.warn("[cre] print start failed:", j?.error?.message || resp.status);
    }
  } catch (err) {
    console.warn("[cre] print start error:", err.message);
  }
}

// Delete a file — Moonraker DELETE.
// Hold-to-confirm (2 s) is bound by _creUpdateFileSheet after each render.
export async function creActionDeleteFile(printer, filename) {
  const conn = _creConns.get(creKey(printer));
  if (!conn) return;
  try {
    const resp = await fetch(
      `http://${conn.ip}:7125/server/files/gcodes/${encodeURIComponent(filename)}`,
      { method: "DELETE" }
    );
    if (resp.ok) conn.data.fileList = (conn.data.fileList || []).filter(f => f.name !== filename);
    else console.warn("[cre] delete failed:", resp.status);
  } catch (err) {
    console.warn("[cre] delete error:", err.message);
  }
  _creUpdateFileSheet(conn);
}

// ── File list renderer ────────────────────────────────────────────────────

function _creFmtDuration(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function _creThumbUrl(conn, f) {
  // Web-server (port 80) maps /mnt/UDISK → / via /downloads/humbnail/<file>
  const base = String(f.thumbnail || "").split("/").pop();
  return base ? `http://${conn.ip}/downloads/humbnail/${encodeURIComponent(base)}` : "";
}

function _creColorSwatches(colors) {
  if (!colors) return "";
  return colors.split(";").filter(Boolean).map(c =>
    `<span class="cre-file-swatch" style="background:${c.trim()}"></span>`
  ).join("");
}

function _creFmtWeight(w) {
  if (!w) return "";
  const total = String(w).split(",").reduce((s, n) => s + (parseFloat(n) || 0), 0);
  return total > 0 ? `${total < 10 ? total.toFixed(1) : Math.round(total)} g` : "";
}

// ── File explorer bottom sheet ────────────────────────────────────────────

// Build the list HTML injected into #creFileSheetBody.
function _creFileListHtml(p, conn) {
  const d = conn.data;
  const files = d.fileList;
  const activeName = String(d.printFileName || "").split("/").pop();

  if (d.fileListLoading && !files) {
    return `<div class="cre-files-empty">${ctx.esc(ctx.t("creFilesLoading"))}</div>`;
  }
  if (!files || !files.length) {
    return `<div class="cre-files-empty">${ctx.esc(ctx.t("creFilesEmpty"))}</div>`;
  }

  const isPrinting = d.state === 1;
  return `<div class="cre-files">${files.map(f => {
    const isActive = activeName && f.name === activeName;
    const thumb    = _creThumbUrl(conn, f);
    const name     = String(f.name || "").replace(/\.gcode$/i, "");
    const duration = _creFmtDuration(f.timeCost);
    const swatches = _creColorSwatches(f.materialColors);
    const weight   = _creFmtWeight(f.filamentWeight);
    const mat      = String(f.material || "").split(";")[0].trim();
    const nozzle   = f.nozzleTemp > 0 ? `${Math.round(f.nozzleTemp / 100)}°` : "";
    const bed      = f.bedTemp    > 0 ? `${Math.round(f.bedTemp    / 100)}°` : "";
    const tempStr  = [nozzle, bed].filter(Boolean).join(" / ");
    return `
      <div class="cre-file-row${isActive ? " cre-file-row--active" : ""}">
        <div class="cre-file-thumb"${thumb ? ` style="background-image:url('${ctx.esc(thumb)}')"` : ""}></div>
        <div class="cre-file-info">
          <span class="cre-file-name" title="${ctx.esc(f.name)}">${ctx.esc(name)}</span>
          <div class="cre-file-pills">
            ${duration ? `<span class="cre-file-pill">${ctx.esc(duration)}</span>` : ""}
            ${swatches}
            ${weight  ? `<span class="cre-file-pill cre-file-pill--dim">${ctx.esc(weight)}</span>` : ""}
            ${mat     ? `<span class="cre-file-pill cre-file-pill--dim">${ctx.esc(mat)}</span>` : ""}
            ${tempStr ? `<span class="cre-file-pill cre-file-pill--dim">${ctx.esc(tempStr)}</span>` : ""}
          </div>
        </div>
        <div class="cre-file-btns">
          <button type="button" class="cre-file-btn cre-file-btn--print"
                  data-cre-file-print="${ctx.esc(f.name)}"
                  title="${ctx.esc(ctx.t("crePrintFile"))}"
                  ${isPrinting ? "disabled" : ""}>
            <span class="icon icon-play icon-13"></span>
          </button>
          <button type="button"
                  class="cre-file-btn cre-file-btn--del"
                  data-cre-file-delete="${ctx.esc(f.name)}"
                  title="${ctx.esc(ctx.t("creDeleteFile"))}">
            <span class="icon icon-trash icon-13"></span>
            <span class="hold-progress"></span>
          </button>
        </div>
      </div>`;
  }).join("")}</div>`;
}

// Re-render the sheet body and rebind hold-to-confirm on delete buttons.
function _creUpdateFileSheet(conn) {
  const body    = document.getElementById("creFileSheetBody");
  const refresh = document.getElementById("creFileSheetRefresh");
  if (!body) return;
  const p = ctx.getActivePrinter();
  if (!p) return;
  body.innerHTML = _creFileListHtml(p, conn);
  if (refresh) refresh.classList.toggle("cre-file-refresh--loading", !!conn.data.fileListLoading);
  // Bind hold-to-confirm (2 s) on each delete button.
  body.querySelectorAll(".cre-file-btn--del").forEach(btn => {
    const filename = btn.dataset.creFileDelete;
    if (filename) ctx.setupHoldToConfirm(btn, 2000, () => creActionDeleteFile(p, filename));
  });
}

let _creFileSheetPrinterKey = null; // key of the printer that opened the sheet

export function openCreFileSheet(printer) {
  _creFileSheetPrinterKey = creKey(printer);
  const conn = _creConns.get(_creFileSheetPrinterKey);
  if (!conn) return;
  _creUpdateFileSheet(conn);
  // Kick off a fresh load if we have no list yet.
  if (!conn.data.fileList) creLoadFileListConn(conn);
  document.getElementById("creFileSheet")?.classList.add("open");
  document.getElementById("creFileSheet")?.setAttribute("aria-hidden", "false");
  document.getElementById("creFileSheetBackdrop")?.classList.add("open");
}

export function closeCreFileSheet() {
  _creFileSheetPrinterKey = null;
  document.getElementById("creFileSheet")?.classList.remove("open");
  document.getElementById("creFileSheet")?.setAttribute("aria-hidden", "true");
  document.getElementById("creFileSheetBackdrop")?.classList.remove("open");
}

// Wire static DOM events.
document.getElementById("creFileSheetClose")?.addEventListener("click", closeCreFileSheet);
document.getElementById("creFileSheetBackdrop")?.addEventListener("click", closeCreFileSheet);
document.getElementById("creFileSheetRefresh")?.addEventListener("click", () => {
  const key  = _creFileSheetPrinterKey;
  const conn = key ? _creConns.get(key) : null;
  if (conn) { creLoadFileListConn(conn); _creUpdateFileSheet(conn); }
});

// Merge a Creality WS response into conn.data.
// Faithfully mirrors _connectCrePrinter()'s message handler in the Flutter app.
function creMergeStatus(conn, obj) {
  const d = conn.data;
  const asNum = v => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n; };
  const asF   = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
  const base  = s => { const r = String(s || "").trim(); if (!r) return null; const i = r.lastIndexOf("/"); return i >= 0 ? r.slice(i + 1) : r; };

  // ── boxsInfo response (NESTED structure — obj.boxsInfo.materialBoxs) ──
  // The printer sends a separate "boxsInfo response" containing the CFS
  // module tree. We store the whole obj so the renderer can walk it.
  // (mirrors: if (obj.containsKey('boxsInfo')) _boxsInfoByPrinter[idx] = obj)
  if ("boxsInfo" in obj) d.boxsInfoRaw = obj;

  // ── Temperatures ─────────────────────────────────────────────────────
  if ("nozzleTemp"       in obj) d.nozzleTemp   = asF(obj.nozzleTemp);
  if ("targetNozzleTemp" in obj) d.nozzleTarget = asF(obj.targetNozzleTemp);
  if ("bedTemp0"         in obj) d.bedTemp      = asF(obj.bedTemp0);
  if ("targetBedTemp0"   in obj) d.bedTarget    = asF(obj.targetBedTemp0);
  // boxTemp → chamberTemp; fall back to explicit chamberTemp field (some FW)
  if ("boxTemp"          in obj) d.chamberTemp  = asF(obj.boxTemp);
  else if ("chamberTemp" in obj) d.chamberTemp  = asF(obj.chamberTemp);

  // ── Print status ──────────────────────────────────────────────────────
  if ("state"       in obj) d.state        = asNum(obj.state)    ?? d.state;
  if ("deviceState" in obj) d.deviceState  = asNum(obj.deviceState);
  if ("feedState"   in obj) d.feedState    = asNum(obj.feedState);

  if ("printProgress" in obj) d.printProgress = asNum(obj.printProgress) ?? 0;
  if ("dProgress"     in obj) d.dProgress     = asNum(obj.dProgress)     ?? 0;
  if ("printLeftTime" in obj) d.printLeftTime  = asNum(obj.printLeftTime) ?? 0;
  if ("printJobTime"  in obj) d.printJobTime   = asNum(obj.printJobTime)  ?? 0;
  if ("layer"         in obj) d.layer          = asNum(obj.layer)         ?? 0;
  if ("TotalLayer"    in obj) d.totalLayer      = asNum(obj.TotalLayer)   ?? 0;

  // Filename — prefer direct field; fall back to historyList on job finish.
  if ("printFileName" in obj) d.printFileName = base(obj.printFileName);
  if ("historyList" in obj && Array.isArray(obj.historyList) && obj.historyList.length) {
    const first = obj.historyList[0];
    if (first && first.filename) d.lastHistoryFilename = base(first.filename);
  }

  // ── Device info ───────────────────────────────────────────────────────
  if ("hostname"      in obj) d.hostname      = String(obj.hostname      || "");
  if ("webrtcSupport" in obj) d.webrtcSupport = asNum(obj.webrtcSupport) || 0;
  if ("video"         in obj) d.video         = asNum(obj.video)         || 0;
  if ("model"         in obj) d.model         = String(obj.model         || "");
  if ("modelVersion"  in obj) d.modelVersion  = String(obj.modelVersion  || "");

  // ── Peripherals ───────────────────────────────────────────────────────
  if ("lightSw"    in obj) d.lightSw    = asNum(obj.lightSw);
  if ("cfsConnect" in obj) d.cfsConnect = asNum(obj.cfsConnect);

  // ── Motion / live stats ───────────────────────────────────────────────
  if ("curFeedratePct"      in obj) d.curFeedratePct     = asNum(obj.curFeedratePct);
  if ("curFlowratePct"      in obj) d.curFlowratePct     = asNum(obj.curFlowratePct);
  if ("curPosition"         in obj) d.curPosition        = String(obj.curPosition || "");
  if ("realTimeSpeed"       in obj) d.realTimeSpeed      = asF(obj.realTimeSpeed);
  if ("realTimeFlow"        in obj) d.realTimeFlow       = asF(obj.realTimeFlow);
  if ("pressureAdvance"     in obj) d.pressureAdvance    = asF(obj.pressureAdvance);
  if ("usedMaterialLength"  in obj) d.usedMaterialLength = asF(obj.usedMaterialLength);

  // ── Pause state ───────────────────────────────────────────────────────
  if ("pause"    in obj) d.isPaused = asNum(obj.pause)    === 1;
  if ("isPaused" in obj) d.isPaused = asNum(obj.isPaused) === 1; // FW alias

  // ── Errors (nested object) ────────────────────────────────────────────
  if (obj.err && typeof obj.err === "object") {
    d.errCode  = asNum(obj.err.errcode) ?? 0;
    d.errKey   = asNum(obj.err.key)     ?? 0;
    d.errValue = String(obj.err.value   || "");
  }

  // ── Hardware limits ───────────────────────────────────────────────────
  if ("maxNozzleTemp" in obj) d.maxNozzleTemp = asNum(obj.maxNozzleTemp);
  if ("maxBedTemp"    in obj) d.maxBedTemp    = asNum(obj.maxBedTemp);

  // ── File list (getGcodeFileInfo2 response) ────────────────────────────
  if ("retGcodeFileInfo2" in obj && Array.isArray(obj.retGcodeFileInfo2)) {
    d.fileList = [...obj.retGcodeFileInfo2].sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
    d.fileListLoading = false;
  }
}

// ── rAF-coalesced re-renders ──────────────────────────────────────────────

let _creRafPending    = false;
let _creStatusChanged = false;
// Bind hold-to-confirm on pause (1 s) and stop (2 s) after each DOM render.
function _creBindHoldBtns(printer) {
  const pauseBtn = document.querySelector("[data-cre-action='pause']");
  const stopBtn  = document.querySelector("[data-cre-action='stop']");
  if (pauseBtn) ctx.setupHoldToConfirm(pauseBtn, 1000, () => creActionPause(printer));
  if (stopBtn)  ctx.setupHoldToConfirm(stopBtn,  2000, () => creActionStop(printer));
}

function creNotifyChange(conn, statusChanged = false) {
  if (statusChanged) _creStatusChanged = true;
  if (_creRafPending) return;
  _creRafPending = true;
  requestAnimationFrame(() => {
    _creRafPending = false;
    const sc = _creStatusChanged; _creStatusChanged = false;
    const activePrinter = ctx.getActivePrinter();
    if (!activePrinter || activePrinter.brand !== "creality") return;
    if (creKey(activePrinter) !== conn.key) return;
    if (sc) {
      ctx.onFullRender();
    } else {
      const host = document.getElementById("creLive");
      if (host) { host.innerHTML = renderCrealityLiveInner(activePrinter); _creBindHoldBtns(activePrinter); }
      const logHost = document.getElementById("creLog");
      if (logHost) logHost.innerHTML = renderCreLogInner(activePrinter);
    }
    if (_creFileSheetPrinterKey === conn.key) _creUpdateFileSheet(conn);
    _crePings.set(conn.key, { online: conn.status === "connected", lastChecked: Date.now() });
    creRefreshOnlineUI(conn.key);
  });
}

// ── Log helpers ───────────────────────────────────────────────────────────

const CRE_LOG_MAX = 100;

function creLogPush(conn, dir, raw) {
  if (conn.logPaused) return;
  if (!conn.log) conn.log = [];
  let summary = "";
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj?.method) summary = obj.method;
    else {
      const keys = Object.keys(obj).slice(0, 4);
      summary = keys.join(", ");
    }
  } catch { summary = "(non-json)"; }
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  conn.log.push({ dir, ts, summary, raw: rawStr });
  if (conn.log.length > CRE_LOG_MAX) conn.log.splice(0, conn.log.length - CRE_LOG_MAX);
}

// ── Live inner renderers ──────────────────────────────────────────────────

export function renderCrealityLiveInner(p) {
  const conn = _creConns.get(creKey(p));
  if (!conn) return `<div class="snap-connecting">${ctx.esc(ctx.t("snapStatusConnecting"))}</div>`;
  const d = conn.data;
  const ledOn = conn.data.lightSw === 1;
  const ledTip = ctx.esc(ledOn
    ? (ctx.t("creLedOnTip")  || "Turn off LED")
    : (ctx.t("creLedOffTip") || "Turn on LED"));
  const headHtml = conn.status === "connected" ? `
    <div class="snap-head">
      <button type="button"
              class="cre-action-btn cre-action-btn--files"
              data-cre-open-files="1"
              title="${ctx.esc(ctx.t("creFilesTitle"))}">
        <span class="icon icon-folder icon-16"></span>
      </button>
      <button type="button"
              class="cre-action-btn cre-action-btn--led${ledOn ? " cre-action-btn--led-on" : ""}"
              data-cre-action="led" title="${ledTip}">
        <span class="icon icon-bulb icon-16"></span>
      </button>
    </div>` : "";
  return `
    ${headHtml}
    ${renderCreJobCard(p, conn)}
    ${renderCreTempCard(conn)}
    ${renderCreFilamentCard(p, conn)}`;
}

export function renderCreLogInner(p) {
  const conn = _creConns.get(creKey(p));
  const log = conn?.log || [];
  if (!log.length) return `<div class="snap-log-empty">${ctx.esc(ctx.t("snapLogEmpty"))}</div>`;
  const rows = log.slice().reverse().map((e, i) => {
    let pretty = e.raw;
    try { pretty = JSON.stringify(JSON.parse(e.raw), null, 2); } catch {}
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

// ── Card renderers (copied from renderer/printers/creality/cards.js) ──────

function creStateLabel(state) {
  if (state === 1) return ctx.t("snapState_printing") || "Printing";
  if (state === 2) return ctx.t("snapState_complete")  || "Finished";
  return ctx.t("snapState_standby") || "Idle";
}

function renderCreJobCard(p, conn) {
  const d = conn.data;
  if (conn.status !== "connected") return "";
  const progressRaw = Math.max(d.printProgress || 0, d.dProgress || 0);
  const leftTime    = d.printLeftTime || 0;
  const jobTime     = d.printJobTime  || 0;
  const layer       = d.layer         || 0;
  const totalLayer  = d.totalLayer    || 0;
  const stateCode   = d.state ?? null;

  const hasLivePrintSignals = progressRaw > 0 || leftTime > 0 || jobTime > 0
                              || layer > 0
                              || (stateCode != null && stateCode !== 0);

  let fileName = String(d.printFileName || "").trim();
  if (!fileName && hasLivePrintSignals) fileName = String(d.lastHistoryFilename || "").trim();

  const hasPrintContext = hasLivePrintSignals || fileName !== "";
  if (!hasPrintContext) return "";

  const isFinished = progressRaw >= 100 || stateCode === 2;
  const isPrinting = !isFinished && (progressRaw > 0 || leftTime > 0 || jobTime > 0 || layer > 0);
  const nozzle = d.nozzleTemp || 0, targetNozzle = d.nozzleTarget || 0;
  const bed    = d.bedTemp    || 0, targetBed    = d.bedTarget    || 0;
  const isHeating = !isFinished && !isPrinting
                    && ((targetNozzle > 0 && (targetNozzle - nozzle) > 5)
                       || (targetBed > 0 && (targetBed - bed) > 3));

  let stateLabel, jobStateCls;
  if (isFinished)      { stateLabel = ctx.t("snapState_complete"); jobStateCls = "complete"; }
  else if (isPrinting) { stateLabel = ctx.t("snapState_printing"); jobStateCls = "printing"; }
  else if (isHeating)  { stateLabel = ctx.t("snapStateHeating");   jobStateCls = "heating";  }
  else                 { stateLabel = ctx.t("snapState_standby");  jobStateCls = "standby";  }

  const codeParts = [];
  if (stateCode      != null) codeParts.push(`s:${stateCode}`);
  if (d.deviceState  != null) codeParts.push(`d:${d.deviceState}`);
  if (d.feedState    != null) codeParts.push(`f:${d.feedState}`);
  const codesText = codeParts.join(" · ");

  const progress = isFinished ? 100 : Math.min(100, Math.max(0, progressRaw));

  let layerText = "";
  if (totalLayer > 0)      layerText = `${layer}/${totalLayer}`;
  else if (layer > 0)      layerText = progress >= 100 ? `${layer}/${layer}` : `${layer}/--`;

  const totalTime = leftTime + jobTime;
  const durationText = totalTime > 0 ? ctx.snapFmtDuration(totalTime) : "";
  const leftText     = leftTime  > 0 ? ctx.snapFmtDuration(leftTime)  : "";

  // Thumbnail: prefer the file's own pre-sliced thumbnail (reliable, file-specific).
  // Fall back to the live camera frame only during an active print.
  // current_print_image.png is a stale camera snapshot after print ends — do NOT
  // use it for finished jobs as it may show a different print entirely.
  let thumbUrl = null;
  if (fileName && Array.isArray(d.fileList)) {
    const match = d.fileList.find(f => f.name === fileName);
    if (match) thumbUrl = _creThumbUrl(conn, match);
  }
  if (!thumbUrl && isPrinting) {
    thumbUrl = `http://${conn.ip}/downloads/original/current_print_image.png`;
  }

  const displayName = fileName || (ctx.t("snapJobNoActive") || "Current print");
  const nameLine = `<div class="snap-job-name" title="${ctx.esc(displayName)}">${ctx.esc(displayName)}</div>`;

  return `
    <div class="snap-job snap-job--${ctx.esc(jobStateCls)}">
      <div class="snap-job-thumb"${thumbUrl
        ? ` style="background-image:url('${ctx.esc(thumbUrl)}')"` : ""}></div>
      <div class="snap-job-info">
        ${nameLine}
        <div class="snap-job-stats">
          <span class="snap-job-pct">${progress}%</span>
          ${durationText ? `<span class="snap-job-time">${ctx.SNAP_ICON_CLOCK}<span>${ctx.esc(durationText)}</span></span>` : ""}
          ${leftText     ? `<span class="snap-job-time snap-job-time--left">⏳ <span>${ctx.esc(leftText)}</span></span>` : ""}
        </div>
        <div class="snap-job-bar"><span style="width:${progress}%"></span></div>
        <div class="snap-job-foot">
          <span class="snap-job-state snap-job-state--${ctx.esc(jobStateCls)}">${ctx.esc(stateLabel)}</span>
          ${layerText ? `<span class="snap-job-layers">${ctx.esc(layerText)}</span>` : ""}
          ${codesText ? `<span class="snap-job-codes">${ctx.esc(codesText)}</span>` : ""}
        </div>
        ${(isPrinting || d.isPaused) ? `
        <div class="cre-actions">
          <button type="button"
                  class="cre-action-btn cre-action-btn--pause"
                  data-cre-action="pause"
                  title="${ctx.esc(ctx.t(d.isPaused ? "creResume" : "crePause"))}">
            <span class="icon ${d.isPaused ? "icon-play" : "icon-pause"} icon-16"></span>
            <span class="hold-progress"></span>
          </button>
          <button type="button"
                  class="cre-action-btn cre-action-btn--stop"
                  data-cre-action="stop"
                  title="${ctx.esc(ctx.t("creStop"))}">
            <span class="icon icon-stop icon-14"></span>
            <span class="hold-progress"></span>
          </button>
        </div>` : ""}
      </div>
    </div>`;
}

function renderCreTempCard(conn) {
  const d = conn.data;
  const tempPills = [];
  if (typeof d.nozzleTemp === "number") {
    const heating = d.nozzleTarget > 0 && d.nozzleTemp < d.nozzleTarget - 1;
    tempPills.push(`
      <div class="snap-temp${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(ctx.snapFmtTempPair(d.nozzleTemp, d.nozzleTarget))}</span>
      </div>`);
  }
  if (typeof d.bedTemp === "number") {
    const heating = d.bedTarget > 0 && d.bedTemp < d.bedTarget - 1;
    tempPills.push(`
      <div class="snap-temp snap-temp--bed${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(ctx.snapFmtTempPair(d.bedTemp, d.bedTarget))}</span>
      </div>`);
  }
  if (typeof d.chamberTemp === "number" && d.chamberTemp > 0) {
    tempPills.push(`
      <div class="snap-temp snap-temp--box">
        ${ctx.SNAP_ICON_CHAMBER}
        <span class="snap-temp-val">${ctx.esc(Math.round(d.chamberTemp) + "°C")}</span>
      </div>`);
  }
  if (!tempPills.length) return "";
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapTemperatureTitle"))}</h4>
      <div class="snap-temps">${tempPills.join("")}</div>
    </section>`;
}

function renderCreFilamentCard(p, conn) {
  const d = conn.data;
  if (conn.status !== "connected") return "";

  const parseCreHex = s => {
    let h = String(s || "").trim().replace(/^#/, "");
    if (h.length === 7 && h[0] === "0") h = h.slice(1);
    return h.length === 6 ? `#${h}` : null;
  };

  const raw      = d.boxsInfoRaw;
  const boxsInfo = raw?.boxsInfo;
  const mbox     = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];

  let extSlot = null;
  const moduleEntries = [];

  for (const e of mbox) {
    if (!e || typeof e !== "object") continue;
    const id   = e.id;
    const type = e.type;
    const mats = Array.isArray(e.materials) ? e.materials : [];
    if (id === 0 && mats.length > 0) {
      const m0 = mats[0];
      extSlot = {
        color:  parseCreHex(m0.color),
        type:   String(m0.type   || ""),
        vendor: String(m0.vendor || ""),
        active: m0.state === 1
      };
    } else if (type === 0) {
      moduleEntries.push(e);
    }
  }
  moduleEntries.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  // Build rows: row 1 = EXT + CFS module 1 slots together,
  //             row N = CFS module N slots (for N ≥ 2)
  const rows = [];

  const makeSlot = (label, color, fg, typeLbl, vendor, active, boxId, slotIdx) => `
    <div class="snap-fil snap-fil--editable${active ? " snap-fil--active" : ""}"
         data-cre-fil-edit="1"
         data-box-id="${boxId}"
         data-slot-idx="${slotIdx}">
      <div class="snap-fil-tag">${ctx.esc(label)}</div>
      <div class="snap-fil-square${color ? "" : " snap-fil-square--empty"}"
           style="${color ? `background:${ctx.esc(color)};color:${ctx.esc(fg)};border-color:${ctx.esc(color)};` : ""}">
        <span class="snap-fil-main">${ctx.esc(typeLbl)}</span>
      </div>
      <div class="snap-fil-meta">
        <span class="snap-fil-status icon icon-edit icon-13" aria-hidden="true"></span>
        ${vendor ? `<div class="snap-fil-vendor">${ctx.esc(vendor)}</div>` : ""}
      </div>
    </div>`;

  // Row 1: EXT + first CFS module slots (or just EXT if no CFS)
  {
    const row1 = [];
    // EXT
    {
      const color = extSlot?.color ?? null;
      const fg    = color ? ctx.snapTextColor(color) : "var(--text)";
      row1.push(makeSlot("Ext.", color, fg, extSlot?.type || "—", extSlot?.vendor || "", true, 0, 0));
    }
    // First CFS module
    if (moduleEntries.length > 0) {
      const e    = moduleEntries[0];
      const boxId = Number(e.id) || 1;
      const mats  = Array.isArray(e.materials) ? e.materials : [];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m || typeof m !== "object") continue;
        const color = parseCreHex(m.color);
        const fg    = color ? ctx.snapTextColor(color) : "var(--text)";
        row1.push(makeSlot(`${boxId}${String.fromCharCode(65 + i)}`, color, fg,
          String(m.type || "—"), String(m.vendor || ""), m.state === 1, boxId, i));
      }
    }
    rows.push(`<div class="cre-fil-row">${row1.join("")}</div>`);
  }

  // Additional rows: one per extra CFS module (module index ≥ 1).
  // A hidden spacer occupies the EXT column so 2A aligns under 1A, etc.
  const extSpacer = `<div class="snap-fil cre-fil-spacer" aria-hidden="true"></div>`;
  for (let mi = 1; mi < moduleEntries.length; mi++) {
    const e      = moduleEntries[mi];
    const boxId  = Number(e.id) || (mi + 1);
    const mats   = Array.isArray(e.materials) ? e.materials : [];
    const slotHtml = [];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (!m || typeof m !== "object") continue;
      const color = parseCreHex(m.color);
      const fg    = color ? ctx.snapTextColor(color) : "var(--text)";
      slotHtml.push(makeSlot(`${boxId}${String.fromCharCode(65 + i)}`, color, fg,
        String(m.type || "—"), String(m.vendor || ""), m.state === 1, boxId, i));
    }
    if (slotHtml.length) {
      rows.push(`<div class="cre-fil-row">${extSpacer}${slotHtml.join("")}</div>`);
    }
  }

  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapFilamentTitle"))}</h4>
      <div class="cre-fil-rows">${rows.join("")}</div>
    </section>`;
}

// ── Filament editor ───────────────────────────────────────────────────────

const CRE_FIL_VENDOR_MATERIALS = {
  "Generic":  ["PLA", "PLA+", "PLA High Speed", "PETG", "ABS", "TPU", "ASA", "PA", "PC", "HIPS", "PVA"],
  "Creality": ["PLA", "PLA+", "PLA High Speed", "PETG", "ABS", "TPU", "ASA", "PA", "Hyper PLA"],
  "Hyper":    ["PLA", "PETG", "ABS"],
};
const CRE_FIL_BRANDS   = Object.keys(CRE_FIL_VENDOR_MATERIALS);

// "Hyper PLA" is Creality's marketing name for PLA High Speed — map it for DB lookup
const CRE_LABEL_ALIAS = { "Hyper PLA": "PLA High Speed" };

// Lookup Creality material metadata from state.db.material (data/id_material.json).
// Returns { rfid, minTemp, maxTemp, pressure } — safe defaults if label not found.
function creGetMaterialMeta(label) {
  const resolved = CRE_LABEL_ALIAS[label] ?? label;
  const mats = ctx.getState().db?.material ?? [];
  const m = mats.find(m => m.label === resolved);
  if (!m?.metadata?.crealityID) return { rfid: "0", minTemp: 190, maxTemp: 240, pressure: 0.04 };
  return {
    rfid:     String(m.metadata.crealityID),
    minTemp:  m.recommended?.nozzleTempMin ?? 190,
    maxTemp:  m.recommended?.nozzleTempMax ?? 240,
    pressure: m.metadata.crealityPressureAdvance ?? 0.04,
  };
}
const CRE_FIL_PRIORITY = ["PLA", "PETG", "ABS", "TPU"];

function creSortMaterials(list) {
  const used = new Set();
  const priority = [];
  for (const p of CRE_FIL_PRIORITY) {
    const idx = list.findIndex((m, i) => !used.has(i) && m.toUpperCase() === p);
    if (idx >= 0) { priority.push(list[idx]); used.add(idx); }
  }
  const rest = list.filter((_, i) => !used.has(i))
                   .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return [...priority, ...rest];
}

let _creFilEdit = null;
let _creSelectedBrand    = "";
let _creSelectedMaterial = "";

function creFilRenderVendorList(selected) {
  return CRE_FIL_BRANDS.map(v => {
    const isSel = v.toLowerCase() === (selected || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}" data-val="${ctx.esc(v)}">${ctx.esc(v)}</button>`;
  }).join("");
}

function creFilRenderMaterialList(vendor, selectedMat) {
  const list = CRE_FIL_VENDOR_MATERIALS[vendor] ?? CRE_FIL_VENDOR_MATERIALS["Generic"];
  return creSortMaterials(list).map(m => {
    const isSel = m.toLowerCase() === (selectedMat || "").toLowerCase();
    return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}" data-val="${ctx.esc(m)}">
              <span class="sfe-fil-row-text">${ctx.esc(m)}</span>
              ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ""}
            </button>`;
  }).join("");
}

function creRenderColorGrid(currentColor) {
  const grid = document.getElementById("creColorGrid");
  if (!grid) return;
  const cur = (currentColor || "").toLowerCase();
  const presetCells = ctx.SNAP_FIL_COLOR_PRESETS.map(c => {
    const isSel = c.toLowerCase() === cur;
    return `<button type="button" class="sfe-color-cell${isSel ? " is-selected" : ""}"
                    data-color="${ctx.esc(c)}"
                    style="background:${ctx.esc(c)}"
                    title="${ctx.esc(c)}"></button>`;
  }).join("");
  const safeColor = /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#888888";
  const customCell = `
    <div class="sfe-color-cell sfe-color-cell--custom" id="creColorCustomBtn"
         style="background:${ctx.esc(safeColor)}"
         title="${ctx.esc(ctx.t("snapFilEditCustomColor") || "Custom")}">
      <span class="icon icon-edit icon-13"></span>
      <input type="color" class="sfe-color-cell-native" id="creColorPickerInline"
             value="${ctx.esc(safeColor)}" aria-label="Custom color"/>
    </div>`;
  grid.innerHTML = presetCells + customCell;
}

function creOpenFilamentSheet()  { document.getElementById("creFilamentSheet")?.classList.add("open");    document.getElementById("creFilamentSheet")?.setAttribute("aria-hidden", "false"); }
function creCloseFilamentSheet() { document.getElementById("creFilamentSheet")?.classList.remove("open"); document.getElementById("creFilamentSheet")?.setAttribute("aria-hidden", "true");  }
function creOpenColorSheet()     { document.getElementById("creColorSheet")?.classList.add("open");       document.getElementById("creColorSheet")?.setAttribute("aria-hidden", "false");    }
function creCloseColorSheet()    { document.getElementById("creColorSheet")?.classList.remove("open");    document.getElementById("creColorSheet")?.setAttribute("aria-hidden", "true");     }

function creUpdateSummary() {
  const v = _creSelectedBrand || "—";
  const m = _creSelectedMaterial || "—";
  const valEl = document.getElementById("creFilSummaryVal");
  if (valEl) valEl.textContent = `${v} ${m}`;
  const dot = document.getElementById("creColorSummaryDot");
  if (dot) dot.style.background = document.getElementById("creColorInput")?.value || "#888";
}

export function openCreFilamentEdit(printer, boxId, slotIndex) {
  const conn = _creConns.get(creKey(printer));

  // Find the slot's current data for pre-fill
  const mbox = conn?.data?.boxsInfoRaw?.boxsInfo?.materialBoxs ?? [];
  let slotData = null;
  for (const box of mbox) {
    if (Number(box.id) === boxId) {
      slotData = (Array.isArray(box.materials) ? box.materials : [])[slotIndex] ?? null;
      break;
    }
  }

  _creFilEdit = { printer, boxId, slotIndex, conn, key: creKey(printer) };
  _creSelectedBrand    = slotData?.vendor || "Generic";
  _creSelectedMaterial = slotData?.type   || "PLA";

  const rawColor = slotData?.color ?? "#FF5722";
  // Creality sends color as #0rrggbb (8 chars, ARGB with alpha=0) — strip the 0 for the picker
  let colorVal = "#FF5722";
  if (/^#0[0-9a-f]{6}$/i.test(rawColor))      colorVal = "#" + rawColor.slice(2); // #0rrggbb → #rrggbb
  else if (/^#[0-9a-f]{6}$/i.test(rawColor))  colorVal = rawColor;
  const colorInp   = document.getElementById("creColorInput");
  if (colorInp) colorInp.value = colorVal;

  document.getElementById("creFilEditSub").textContent = "";
  document.getElementById("creError").hidden = true;

  // Colour grid
  creRenderColorGrid(colorVal);

  // Vendor / material lists
  const vendorMatch = CRE_FIL_BRANDS.find(b => b.toLowerCase() === _creSelectedBrand.toLowerCase())
                   || CRE_FIL_BRANDS[0];
  _creSelectedBrand = vendorMatch;
  const vl = document.getElementById("creVendorList");   if (vl) vl.innerHTML = creFilRenderVendorList(vendorMatch);
  const ml = document.getElementById("creMaterialList"); if (ml) ml.innerHTML = creFilRenderMaterialList(_creSelectedBrand, _creSelectedMaterial);

  creCloseFilamentSheet();
  creCloseColorSheet();
  creUpdateSummary();

  document.getElementById("creFilEditSheet").classList.add("open");
  document.getElementById("creFilEditSheet").setAttribute("aria-hidden", "false");
  document.getElementById("creFilEditBackdrop").classList.add("open");
}

export function closeCreFilamentEdit() {
  document.getElementById("creFilEditSheet")?.classList.remove("open");
  document.getElementById("creFilEditSheet")?.setAttribute("aria-hidden", "true");
  document.getElementById("creFilEditBackdrop")?.classList.remove("open");
  creCloseFilamentSheet();
  creCloseColorSheet();
  _creFilEdit = null;
}

// ── DOM event wiring ──────────────────────────────────────────────────────
document.getElementById("creFilEditClose")?.addEventListener("click", closeCreFilamentEdit);
document.getElementById("creFilEditBackdrop")?.addEventListener("click", closeCreFilamentEdit);

document.getElementById("creOpenFilament")?.addEventListener("click", () => {
  creOpenFilamentSheet();
  setTimeout(() => {
    const sel = document.getElementById("creVendorList")?.querySelector(".is-selected");
    if (sel) sel.scrollIntoView({ block: "center", behavior: "auto" });
  }, 0);
});
document.getElementById("creOpenColor")?.addEventListener("click", creOpenColorSheet);
document.getElementById("creColorBack")?.addEventListener("click",    () => { creUpdateSummary(); creCloseColorSheet();    });
document.getElementById("creColorClose")?.addEventListener("click",   () => { creUpdateSummary(); creCloseColorSheet();    });
document.getElementById("creFilamentBack")?.addEventListener("click",  () => { creUpdateSummary(); creCloseFilamentSheet(); });
document.getElementById("creFilamentClose")?.addEventListener("click", () => { creUpdateSummary(); creCloseFilamentSheet(); });

document.getElementById("creVendorList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _creSelectedBrand = row.dataset.val || "";
  document.getElementById("creVendorList").querySelectorAll(".sfe-fil-row").forEach(r =>
    r.classList.toggle("is-selected", r === row));
  const ml = document.getElementById("creMaterialList");
  if (ml) ml.innerHTML = creFilRenderMaterialList(_creSelectedBrand, _creSelectedMaterial);
});
document.getElementById("creMaterialList")?.addEventListener("click", e => {
  const row = e.target.closest(".sfe-fil-row");
  if (!row) return;
  _creSelectedMaterial = row.dataset.val || "";
  document.getElementById("creMaterialList").innerHTML = creFilRenderMaterialList(_creSelectedBrand, _creSelectedMaterial);
  setTimeout(() => { creUpdateSummary(); creCloseFilamentSheet(); }, 180);
});

// Color grid — preset click
document.getElementById("creColorGrid")?.addEventListener("click", e => {
  if (e.target.closest("#creColorPickerInline")) return;
  const cell = e.target.closest(".sfe-color-cell:not(.sfe-color-cell--custom)");
  if (!cell?.dataset.color) return;
  document.getElementById("creColorInput").value = cell.dataset.color;
  creRenderColorGrid(cell.dataset.color);
  setTimeout(() => { creUpdateSummary(); creCloseColorSheet(); }, 150);
});
// Custom colour — live drag
document.getElementById("creColorGrid")?.addEventListener("input", e => {
  if (!e.target.matches?.("#creColorPickerInline")) return;
  document.getElementById("creColorInput").value = e.target.value;
  const wrap = e.target.closest(".sfe-color-cell--custom");
  if (wrap) wrap.style.background = e.target.value;
});
// Custom colour — final commit
document.getElementById("creColorGrid")?.addEventListener("change", e => {
  if (!e.target.matches?.("#creColorPickerInline")) return;
  const c = e.target.value;
  document.getElementById("creColorInput").value = c;
  creRenderColorGrid(c);
  setTimeout(() => { creUpdateSummary(); creCloseColorSheet(); }, 100);
});

// Save button — sends modifyMaterial via WebSocket (format from Dart app)
document.getElementById("creFilEditSave")?.addEventListener("click", async () => {
  if (!_creFilEdit) return;
  const { conn, boxId, slotIndex } = _creFilEdit;
  const errEl = document.getElementById("creError");
  errEl.hidden = true;

  const colorPicker = document.getElementById("creColorInput")?.value || "#FF5722";
  const type        = _creSelectedMaterial || "PLA";
  const vendor      = _creSelectedBrand    || "Generic";
  const meta        = creGetMaterialMeta(type);

  // Creality color format: #0rrggbb (ARGB, alpha byte = 0)
  const colorHex = "#0" + colorPicker.replace("#", "").toLowerCase();
  const name     = vendor + " " + type;

  const cmd = JSON.stringify({
    method: "set",
    params: {
      modifyMaterial: {
        id:         slotIndex,
        boxId:      boxId,
        rfid:       meta.rfid,
        type:       type,
        vendor:     vendor,
        name:       name,
        color:      colorHex,
        minTemp:    meta.minTemp,
        maxTemp:    meta.maxTemp,
        pressure:   meta.pressure,
        selected:   1,
        percent:    100,
        editStatus: 1,
        state:      1,
      }
    }
  });

  const btn = document.getElementById("creFilEditSave");
  btn.classList.add("loading"); btn.disabled = true;
  try {
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) throw new Error("ws not open");
    conn.ws.send(cmd);
    closeCreFilamentEdit();
  } catch (err) {
    console.warn("[cre] filament edit send failed:", err?.message);
    errEl.textContent = ctx.t("snapFilEditError") || "Error sending to printer";
    errEl.hidden = false;
  } finally {
    btn.classList.remove("loading"); btn.disabled = false;
  }
});

// ── Self-registration ─────────────────────────────────────────────────────
registerBrand('creality', {
  meta, schema, helper,
  renderJobCard:        renderCreJobCard,
  renderTempCard:       renderCreTempCard,
  renderFilamentCard:   renderCreFilamentCard,
  renderSettingsWidget: schemaWidget(schema),
});
