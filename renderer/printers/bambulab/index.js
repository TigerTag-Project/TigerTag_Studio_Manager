/**
 * printers/bambulab/index.js — Bambu Lab MQTT TLS live integration.
 *
 * Protocol: MQTTS port 8883 (TLS, cert ignored), username "bblp",
 * password = Access Code printed on the printer screen.
 * Subscribe: device/{serial}/report
 * Publish:   device/{serial}/request
 *
 * Camera:
 *   Model IDs 1–4 (A1, A1 Mini, P1P, P1S) → JPEG TCP port 6000 via main process.
 *   Model IDs 5+  (X1C, X1E, P2S, H2x)    → RTSP rtsps://{ip}:322/... (copy-URL only).
 *
 * Self-registers into the brands registry at module evaluation time.
 */
import { ctx } from '../context.js';
import { registerBrand } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { renderBambuJobCard, renderBambuTempCard, renderBambuFilamentCard } from './cards.js';
import { schemaWidget } from '../modal-helpers.js';

const $ = id => document.getElementById(id);

// ── Private connection state ───────────────────────────────────────────────

/** Per-printer live state. Keyed by `${brand}:${id}`. */
const _bambuConns = new Map();

// ── Model helpers ──────────────────────────────────────────────────────────

// Serial prefix → model ID (fallback when printerModelId is absent).
const _SERIAL_PREFIX_MODEL = {
  '039': 2, '030': 1, '01S': 4, '01P': 3,
  '22E': 10, '03W': 6, '00M': 5,
};

// Model IDs whose camera uses JPEG TCP (port 6000) instead of RTSP.
const _JPEG_CAM_IDS = new Set([1, 2, 3, 4]);

export function bambuModelId(p) {
  const id = parseInt(p.printerModelId, 10);
  if (id >= 1 && id <= 11) return id;
  const prefix = String(p.serialNumber || "").slice(0, 3).toUpperCase();
  return _SERIAL_PREFIX_MODEL[prefix] || 0;
}

export function bambuUsesJpegCam(p) {
  return _JPEG_CAM_IDS.has(bambuModelId(p));
}

// ── Public key helpers ─────────────────────────────────────────────────────

export function bambuKey(p) { return `${p.brand}:${p.id}`; }
export function bambuGetConn(key) { return _bambuConns.get(key) ?? null; }

// ── Online status ──────────────────────────────────────────────────────────

export function bambuIsOnline(printer) {
  if (printer?.brand !== "bambulab") return null;
  const key = bambuKey(printer);
  if (ctx.isForcedOffline?.(key)) return false; // explicitly disconnected via button
  const conn = _bambuConns.get(key);
  if (conn) return conn.status === "connected";
  return null; // no live connection → unknown
}

function _bambuRefreshOnlineUI(key) {
  document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
    const p = ctx.getState().printers.find(x => bambuKey(x) === key);
    el.outerHTML = renderBambuOnlineBadge(p, "card");
  });
  const active = ctx.getActivePrinter();
  if (active && bambuKey(active) === key) {
    const host = $("ppOnlineRow");
    if (host) host.outerHTML = renderBambuOnlineBadge(active, "side");
  }
}

export function renderBambuOnlineBadge(printer, where) {
  if (!printer || printer.brand !== "bambulab") return "";
  const online = bambuIsOnline(printer);
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

// ── Sequence ID ────────────────────────────────────────────────────────────

let _seqId = 0;
function _nextSeq() {
  if (_seqId >= 4086) _seqId = 0;
  return String(_seqId++);
}

// ── Connection lifecycle ───────────────────────────────────────────────────

/**
 * Connect (or reconnect) a Bambu Lab printer.
 *
 * @param {object} printer  — printer record from state.printers
 * @param {object} [opts]
 * @param {boolean} [opts.skipCam=false]  — true for background auto-connects
 *   (no camera stream started; saves bandwidth when the sidecard is closed).
 *   When the sidecard opens, call bambuConnect again without skipCam and the
 *   camera will start on the already-live MQTT session.
 */
export function bambuConnect(printer, { skipCam = false } = {}) {
  const key = bambuKey(printer);
  const ip       = printer.broker || printer.ip || "";
  const password = printer.password || "";
  const existing = _bambuConns.get(key);

  // Idempotent: already connected/connecting with the same IP →
  // only (re-)start the camera if the caller wants it AND the stream
  // is not already delivering frames in the background (panel close no
  // longer stops the camera, so lastCamFrame being non-null means the
  // ffmpeg/JPEG-TCP process is alive — restarting it would cause a
  // brief interruption for no benefit).
  if (existing) {
    if (existing.status === "connected" || existing.status === "connecting") {
      if (existing.ip === ip) {
        if (!skipCam && ip && password && !existing.data?.lastCamFrame) {
          if (bambuUsesJpegCam(printer)) {
            window.bambulab?.camStart({ key, ip, password });
          } else {
            window.bambulab?.camStartRtsp({ key, ip, password });
          }
        }
        return;
      }
    }
    bambuDisconnect(key);
  }

  const serial   = printer.serialNumber || "";

  const conn = {
    key,
    ip,
    serial,
    password,
    status:       "connecting",
    lastError:    null,
    refreshTimer: null,
    log:          [],
    logPaused:    false,
    logExpanded:  false,
    data: {
      printState:    null,
      printFilename: null,
      progress:      0,
      remainingTime: 0,
      layerNum:      0,
      totalLayerNum: 0,
      nozzleCurrent: null, nozzleTarget: null,
      bedCurrent:    null, bedTarget:    null,
      chamberCurrent: null,
      ams:           [],
      externalTray:  null,
      lastCamFrame:  null,
    },
  };
  _bambuConns.set(key, conn);

  // Start camera feed — only when the sidecard is open (skipCam = false).
  // JPEG TCP  → A1 / A1 Mini / P1P / P1S (model IDs 1–4), port 6000.
  // RTSP/ffmpeg → X1C / X1E / P2S / H2x  (model IDs 5+),  port 322.
  if (!skipCam && ip && password) {
    if (bambuUsesJpegCam(printer)) {
      window.bambulab?.camStart({ key, ip, password });
    } else {
      window.bambulab?.camStartRtsp({ key, ip, password });
    }
  }

  // Initiate MQTT connection in the main process
  window.bambulab?.connect({ key, ip, serial, password });
}

/** Stop only the camera stream (JPEG TCP + RTSP); keep the MQTT session alive. */
export function bambuStopCam(key) {
  if (!_bambuConns.has(key)) return;
  window.bambulab?.camStop(key);
  window.bambulab?.camStopRtsp(key);
}

export function bambuDisconnect(key) {
  const conn = _bambuConns.get(key);
  if (!conn) return;
  if (conn.refreshTimer) { clearTimeout(conn.refreshTimer); conn.refreshTimer = null; }
  window.bambulab?.camStop(key);
  window.bambulab?.camStopRtsp(key);
  window.bambulab?.disconnect(key);
  _bambuConns.delete(key);
}

// ── MQTT publish ───────────────────────────────────────────────────────────

function _publish(conn, payload) {
  if (!conn) return;
  _bblLogPush(conn, "→", payload);
  window.bambulab?.publish(conn.key, payload);
}

// ── Refresh timer ──────────────────────────────────────────────────────────

// If no message in 5 s, push a `pushall` to refresh state.
function _scheduleRefresh(conn) {
  if (conn.refreshTimer) clearTimeout(conn.refreshTimer);
  conn.refreshTimer = setTimeout(() => {
    conn.refreshTimer = null;
    if (!_bambuConns.has(conn.key)) return;
    _publish(conn, { pushing: { sequence_id: _nextSeq(), command: "pushall", version: 1, push_target: 1 } });
    _scheduleRefresh(conn);
  }, 5_000);
}

// ── Global IPC listeners (registered once at module load) ─────────────────
// Using single global listeners avoids accumulating duplicate handlers
// when bambuConnect is called repeatedly (e.g. panel open → close → open).

if (typeof window !== "undefined" && window.bambulab) {
  window.bambulab.onStatus((key, status) => {
    const conn = _bambuConns.get(key);
    if (!conn) return;
    conn.status = status;
    if (status === "connected") {
      conn.lastError = null;
      // Init sequence: get_version → pushall
      _publish(conn, { info:    { sequence_id: _nextSeq(), command: "get_version" } });
      _publish(conn, { pushing: { sequence_id: _nextSeq(), command: "pushall" } });
      _scheduleRefresh(conn);
    }
    _bblNotify(conn, /*statusChanged*/ true);
    _bambuRefreshOnlineUI(key);
  });

  window.bambulab.onMessage((key, _topic, data) => {
    const conn = _bambuConns.get(key);
    if (!conn) return;
    _bblLogPush(conn, "←", data);
    _bblMerge(conn, data);
  });

  window.bambulab.onCamFrame((key, b64) => {
    const conn = _bambuConns.get(key);
    if (!conn) return;
    const firstFrame = !conn.data.lastCamFrame;
    conn.data.lastCamFrame = b64;
    // Surgical DOM update — only touch the img that belongs to THIS printer.
    // Multiple Bambu printers can stream simultaneously (cam wall); query by
    // data-bbl-key so each printer's img is found regardless of DOM order.
    const img = document.querySelector(`[data-bbl-key="${CSS.escape(key)}"]`);
    if (!img) return;
    img.src = `data:image/jpeg;base64,${b64}`;
    // On the very first frame for this panel, remove the loading overlay.
    if (firstFrame) {
      const wrap = img.closest(".pp-cam-loading");
      if (wrap) {
        wrap.classList.remove("pp-cam-loading");
        wrap.querySelector(".pp-cam-loading-overlay")?.remove();
      }
    }
  });
}

// ── Message parser ────────────────────────────────────────────────────────

function _decodePackedTemp32(raw) {
  const v = typeof raw === "number" ? raw : parseInt(raw);
  if (isNaN(v)) return { current: null, target: null };
  return { current: v & 0xFFFF, target: (v >> 16) & 0xFFFF };
}

function _normState(p) {
  const raw = (p.gcode_state || p.print_type || p.state || p.status || "").toLowerCase();
  if (["failed", "failure", "error"].includes(raw)) {
    const alt = (p.print_type || p.state || p.status || "").toLowerCase();
    if (alt && alt !== raw && ["idle", "finish", "finished"].includes(alt)) return "idle";
  }
  switch (raw) {
    case "running":  case "printing": return "printing";
    case "prepare":  case "preparing": case "heating": return "preparing";
    case "busy":     return "busy";
    case "pause":    case "paused": return "paused";
    case "finish":   case "finished": return "finished";
    case "failed":   case "failure": return "failed";
    case "error":    return "error";
    default:         return "idle";
  }
}

function _parseColor(hex) {
  if (!hex) return null;
  const h = String(hex).replace(/^#/, "").toUpperCase();
  // RRGGBBAA (8) or RRGGBB (6) — drop alpha, return #RRGGBB
  if (h.length === 8 || h.length === 6) return "#" + h.slice(0, 6);
  return null;
}

function _bblMerge(conn, msg) {
  const p = msg?.print;
  if (!p || typeof p !== "object") return;
  const d = conn.data;

  // State
  const st = _normState(p);
  if (st) d.printState = st;

  // Progress
  if (p.mc_percent != null) d.progress = +(p.mc_percent) || 0;

  // Time remaining
  const rt = p.mc_remaining_time ?? p.remaining_time;
  if (rt != null) d.remainingTime = +(rt) || 0;

  // Layers
  if (typeof p.layer_num      === "number") d.layerNum      = p.layer_num;
  if (typeof p.total_layer_num === "number") d.totalLayerNum = p.total_layer_num;

  // Filename (first non-empty field wins)
  const fn = p.gcode_file || p.subtask_name || p.project_file
           || p.project_name || p.filename || p.task_name || p.ipcam?.file_name;
  if (fn) {
    try { d.printFilename = decodeURIComponent(String(fn).split("/").pop()); }
    catch { d.printFilename = String(fn).split("/").pop(); }
  }

  // ── Temperatures (new-firmware packed 32-bit first, then fallback) ──
  const dev = p.device;
  if (dev) {
    // Nozzle
    const ext = dev.extruder;
    if (ext?.info && Array.isArray(ext.info)) {
      const state = typeof ext.state === "number" ? ext.state : null;
      const activeIdx = state !== null ? (state >> 4) & 0xF : null;
      const nozzle = (activeIdx !== null && ext.info.find(e => e?.id === activeIdx)) || ext.info[0];
      if (nozzle?.temp != null) {
        const t = _decodePackedTemp32(nozzle.temp);
        d.nozzleCurrent = t.current; d.nozzleTarget = t.target;
      }
    }
    // Bed
    if (dev.bed?.info?.temp != null) {
      const t = _decodePackedTemp32(dev.bed.info.temp);
      d.bedCurrent = t.current; d.bedTarget = t.target;
    }
    // Chamber
    if (dev.ctc?.info?.temp != null) {
      const t = _decodePackedTemp32(dev.ctc.info.temp);
      d.chamberCurrent = t.current;
    }
  }
  // Fallback: old-firmware float fields
  if (d.nozzleCurrent == null && p.nozzle_temper       != null) d.nozzleCurrent = Math.round(+p.nozzle_temper);
  if (d.nozzleTarget  == null && p.nozzle_target_temper != null) d.nozzleTarget  = Math.round(+p.nozzle_target_temper);
  if (d.bedCurrent    == null && p.bed_temper           != null) d.bedCurrent    = Math.round(+p.bed_temper);
  if (d.bedTarget     == null && p.bed_target_temper    != null) d.bedTarget     = Math.round(+p.bed_target_temper);
  if (d.chamberCurrent == null && p.chamber_temper      != null) d.chamberCurrent = Math.round(+p.chamber_temper);

  // ── AMS ────────────────────────────────────────────────────────────────
  if (p.ams?.ams && Array.isArray(p.ams.ams)) {
    d.ams = p.ams.ams.map(mod => ({
      id:       String(mod.id ?? ""),
      humidity: String(mod.humidity ?? ""),
      temp:     String(mod.temp ?? ""),
      tray:     Array.isArray(mod.tray) ? mod.tray.map(t => ({
        id:     String(t.id ?? ""),
        color:  _parseColor(t.tray_color),
        type:   String(t.tray_type || ""),
        active: t.is_active === true || t.state === 11,
      })) : [],
    }));
  }

  // ── External spool (vt_tray = old fw, vir_slot[0] = new fw) ────────────
  const ext2 = (p.vt_tray && typeof p.vt_tray === "object") ? p.vt_tray
             : (Array.isArray(p.vir_slot) && p.vir_slot.length > 0) ? p.vir_slot[0]
             : null;
  if (ext2) {
    d.externalTray = {
      color:  _parseColor(ext2.tray_color),
      type:   String(ext2.tray_type || ""),
      active: ext2.is_active === true || ext2.state === 11,
    };
  }

  // If partial update has vt_tray but no AMS → schedule a pushall refresh
  if ((p.vt_tray || p.vir_slot) && !p.ams && !d.ams.length) {
    _scheduleRefresh(conn);
  }

  _bblNotify(conn);
}

// ── rAF-coalesced re-renders ───────────────────────────────────────────────

let _raf     = null;
let _bblGridRaf   = null; // data updates  → onGridJobsChange
let _bblStatusRaf = null; // status changes → onPrinterGridChange (separate to avoid coalescing with data RAF)
let _rafStatus = false;

function _bblNotify(conn, statusChanged = false) {
  if (statusChanged) {
    if (!_bblStatusRaf) _bblStatusRaf = requestAnimationFrame(() => { _bblStatusRaf = null; ctx.onPrinterGridChange(); });
    return;
  }
  if (!_bblGridRaf) _bblGridRaf = requestAnimationFrame(() => { _bblGridRaf = null; ctx.onGridJobsChange(); });
  const active = ctx.getActivePrinter();
  if (!active) return;
  if (bambuKey(active) !== conn.key) return;
  if (_raf) return; // coalesce bursts
  _raf = requestAnimationFrame(() => {
    _raf = null;
    const full = _rafStatus;
    _rafStatus = false;
    if (full) {
      ctx.onFullRender();
    } else {
      const liveHost = $("bblLive");
      if (liveHost) liveHost.innerHTML = renderBambuLiveInner(active);
      const logHost  = $("bblLog");
      if (logHost)  logHost.innerHTML  = renderBambuLogInner(active);
      const countEl  = $("bblLogCount");
      if (countEl) countEl.textContent = String(_bambuConns.get(bambuKey(active))?.log?.length || 0);
    }
  });
}

// ── Request log ────────────────────────────────────────────────────────────

const BBL_LOG_MAX = 100;

function _bblLogPush(conn, dir, raw) {
  if (conn.logPaused) return;
  if (!conn.log) conn.log = [];
  let summary = "";
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if      (obj?.print?.command)   summary = `print:${obj.print.command}`;
    else if (obj?.info?.command)    summary = `info:${obj.info.command}`;
    else if (obj?.pushing?.command) summary = `push:${obj.pushing.command}`;
    else { summary = Object.keys(obj || {}).slice(0, 3).join(", ") || "(msg)"; }
    const gst = obj?.print?.gcode_state || obj?.print?.state || "";
    if (gst) summary += ` · ${gst}`;
  } catch { summary = "(non-json)"; }
  const ts     = new Date().toLocaleTimeString([], { hour12: false });
  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  conn.log.push({ dir, ts, summary, raw: rawStr });
  if (conn.log.length > BBL_LOG_MAX) conn.log.splice(0, conn.log.length - BBL_LOG_MAX);
}

// ── Live block renderer ────────────────────────────────────────────────────

export function renderBambuLiveInner(p) {
  const conn = _bambuConns.get(bambuKey(p));
  if (!conn) return `
    <div class="snap-empty">
      <span class="icon icon-cloud icon-18"></span>
      <span>${ctx.esc(ctx.t("snapNoConnection"))}</span>
    </div>`;
  return `
    ${renderBambuJobCard(p, conn)}
    ${renderBambuTempCard(conn)}
    ${renderBambuFilamentCard(p, conn)}`;
}

// ── Log renderer ───────────────────────────────────────────────────────────

export function renderBambuLogInner(p) {
  const conn = _bambuConns.get(bambuKey(p));
  const log  = conn?.log || [];
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
          <button type="button" class="snap-log-detail-copy" data-copy="${ctx.esc(pretty)}"
                  title="${ctx.esc(ctx.t("copyLabel"))}">
            <span class="icon icon-copy icon-13"></span>
            <span>${ctx.esc(ctx.t("copyLabel"))}</span>
          </button>
          <pre class="snap-log-detail-pre">${ctx.esc(pretty)}</pre>
        </div>
      </div>`;
  }).join("");
  return `<div class="snap-log">${rows}</div>`;
}

// ── Filament edit sheet ────────────────────────────────────────────────────

let _bblMatCache = null;   // loaded once via IPC, refreshed on sheet open
let _bblFilEdit  = null;   // { printer, amsId, trayId }
let _bblSelMat   = null;   // { label, tray_type, bambuID, tempMin, tempMax }
let _bblSelColor = '#FF5722';

async function _bblLoadMaterials() {
  if (_bblMatCache) return _bblMatCache;
  try {
    const mats = await window.electronAPI?.db?.getBambuMaterials?.();
    _bblMatCache = Array.isArray(mats) ? mats : [];
  } catch (e) {
    console.warn('[BBL] Could not load materials:', e);
    _bblMatCache = [];
  }
  return _bblMatCache;
}

function _bblRenderMaterialList(filter) {
  const mats = _bblMatCache || [];
  const q = (filter || '').trim().toLowerCase();
  const list = q ? mats.filter(m => m.label.toLowerCase().includes(q)) : mats;
  if (!list.length) return `<div class="sfe-fil-empty">${ctx.esc(ctx.t('noMatch') || 'No match')}</div>`;
  return list.map(m => {
    const isSel = _bblSelMat?.bambuID === m.bambuID;
    const tempHint = `<span class="sfe-fil-row-temp">${m.tempMin}–${m.tempMax}°</span>`;
    return `<button type="button" class="sfe-fil-row${isSel ? ' is-selected' : ''}" data-bbl-mat='${JSON.stringify({label:m.label,tray_type:m.tray_type,bambuID:m.bambuID,tempMin:m.tempMin,tempMax:m.tempMax})}'>
      <span class="sfe-fil-row-text">${ctx.esc(m.label)}</span>
      ${tempHint}
      ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ''}
    </button>`;
  }).join('');
}

function _bblRenderColorGrid(currentColor) {
  const grid = $('bblColorGrid');
  if (!grid) return;
  const cur = (currentColor || '').toLowerCase();
  const presetCells = ctx.SNAP_FIL_COLOR_PRESETS.map(c => {
    const isSel = c.toLowerCase() === cur;
    return `<button type="button"
      class="sfe-color-cell${isSel ? ' is-selected' : ''}"
      data-color="${ctx.esc(c)}"
      style="background:${ctx.esc(c)}"></button>`;
  }).join('');
  const customStyle = `background:${currentColor || '#FF5722'}`;
  const customCell = `<button type="button"
    class="sfe-color-cell sfe-color-cell--custom" id="bblColorCustom"
    style="${customStyle}" title="Custom color">
    <span class="icon icon-edit icon-13" style="background:#fff;opacity:.8"></span>
  </button>`;
  grid.innerHTML = presetCells + customCell;
}

function _bblUpdateSummary() {
  const label = _bblSelMat?.label || '—';
  const matVal = $('bblMaterialTriggerVal');
  if (matVal) matVal.textContent = label;
  const colorDot = $('bblColorTriggerVal');
  if (colorDot) colorDot.style.background = _bblSelColor || 'transparent';
}

function _bblOpenColorSheet() {
  _bblRenderColorGrid(_bblSelColor);
  const inp = $('bblColorInput'); if (inp) inp.value = _bblSelColor;
  $('bblColorSheet')?.classList.add('open');
  $('bblColorSheet')?.setAttribute('aria-hidden', 'false');
}
function _bblCloseColorSheet() {
  $('bblColorSheet')?.classList.remove('open');
  $('bblColorSheet')?.setAttribute('aria-hidden', 'true');
}
function _bblOpenFilamentSheet() {
  const search = $('bblMatSearch'); if (search) search.value = '';
  const matList = $('bblMaterialList');
  if (matList) matList.innerHTML = _bblRenderMaterialList('');
  $('bblFilamentSheet')?.classList.add('open');
  $('bblFilamentSheet')?.setAttribute('aria-hidden', 'false');
}
function _bblCloseFilamentSheet() {
  $('bblFilamentSheet')?.classList.remove('open');
  $('bblFilamentSheet')?.setAttribute('aria-hidden', 'true');
}

export async function openBambuFilamentEdit(printer, amsId, trayId) {
  const conn = _bambuConns.get(bambuKey(printer));
  if (!conn) return;
  _bblFilEdit = { printer, amsId, trayId };

  // Find existing slot data to pre-fill color & material
  let existingTray = null;
  if (amsId === 255) {
    existingTray = conn.data?.externalTray ?? null;
  } else {
    const mod = conn.data?.ams?.[amsId];
    existingTray = mod?.tray?.find(t => parseInt(t.id, 10) === trayId) ?? null;
  }

  const rawColor = existingTray?.color
    ? '#' + String(existingTray.color).slice(0, 6)
    : '#FF5722';
  _bblSelColor = rawColor;

  await _bblLoadMaterials();

  // Pre-select material by tray_type match
  const trayType = existingTray?.type || '';
  _bblSelMat = (_bblMatCache || []).find(m => m.label === trayType)
            || (_bblMatCache || []).find(m => m.tray_type === trayType)
            || _bblMatCache?.[0]
            || null;

  _bblCloseColorSheet();
  _bblCloseFilamentSheet();
  _bblUpdateSummary();

  $('bblFilEditSheet')?.classList.add('open');
  $('bblFilEditSheet')?.setAttribute('aria-hidden', 'false');
  $('bblFilEditBackdrop')?.classList.add('open');
}

export function closeBambuFilamentEdit() {
  $('bblFilEditSheet')?.classList.remove('open');
  $('bblFilEditSheet')?.setAttribute('aria-hidden', 'true');
  $('bblFilEditBackdrop')?.classList.remove('open');
  _bblCloseColorSheet();
  _bblCloseFilamentSheet();
}

// ── Filament sheet event listeners ────────────────────────────────────────

$('bblFilEditBackdrop')?.addEventListener('click', closeBambuFilamentEdit);
$('bblFilEditClose')?.addEventListener('click', closeBambuFilamentEdit);

$('bblColorTrigger')?.addEventListener('click', _bblOpenColorSheet);
$('bblMaterialTrigger')?.addEventListener('click', _bblOpenFilamentSheet);

$('bblColorBack')?.addEventListener('click', () => { _bblUpdateSummary(); _bblCloseColorSheet(); });
$('bblColorClose')?.addEventListener('click', () => { _bblUpdateSummary(); _bblCloseColorSheet(); });
$('bblFilamentBack')?.addEventListener('click', () => { _bblUpdateSummary(); _bblCloseFilamentSheet(); });
$('bblFilamentClose')?.addEventListener('click', () => { _bblUpdateSummary(); _bblCloseFilamentSheet(); });

$('bblColorGrid')?.addEventListener('click', e => {
  const custom = e.target.closest('#bblColorCustom');
  if (custom) { $('bblColorInput')?.click(); return; }
  const cell = e.target.closest('.sfe-color-cell:not(.sfe-color-cell--custom)');
  if (!cell) return;
  _bblSelColor = cell.dataset.color || _bblSelColor;
  _bblRenderColorGrid(_bblSelColor);
  // Auto-close after a brief visual confirmation (same as Snapmaker)
  setTimeout(() => { _bblUpdateSummary(); _bblCloseColorSheet(); }, 150);
});

$('bblColorInput')?.addEventListener('change', e => {
  // Native OS picker closed — commit and return to summary
  _bblSelColor = e.target.value;
  _bblRenderColorGrid(_bblSelColor);
  _bblUpdateSummary();
  _bblCloseColorSheet();
});

$('bblColorInput')?.addEventListener('input', e => {
  // Live preview while dragging the OS picker
  _bblSelColor = e.target.value;
  _bblRenderColorGrid(_bblSelColor);
  _bblUpdateSummary();
});

$('bblMaterialList')?.addEventListener('click', e => {
  const row = e.target.closest('[data-bbl-mat]');
  if (!row) return;
  try { _bblSelMat = JSON.parse(row.dataset.bblMat); } catch (_) { return; }
  const matList = $('bblMaterialList');
  if (matList) matList.innerHTML = _bblRenderMaterialList($('bblMatSearch')?.value || '');
  setTimeout(() => { _bblUpdateSummary(); _bblCloseFilamentSheet(); }, 180);
});

$('bblMatSearch')?.addEventListener('input', e => {
  const matList = $('bblMaterialList');
  if (matList) matList.innerHTML = _bblRenderMaterialList(e.target.value);
});

$('bblFilEditSave')?.addEventListener('click', () => {
  if (!_bblFilEdit || !_bblSelMat) return;
  const { printer, amsId, trayId } = _bblFilEdit;
  const conn = _bambuConns.get(bambuKey(printer));
  if (!conn) return;

  // Color: RRGGBBAA uppercase (add FF alpha)
  const hex6 = _bblSelColor.replace('#', '').toUpperCase().slice(0, 6);
  const trayColor = hex6 + 'FF';

  const isExt = amsId === 255;
  _publish(conn, {
    print: {
      sequence_id: _nextSeq(),
      command: 'ams_filament_setting',
      ams_id:  isExt ? 255 : amsId,
      tray_id: isExt ? 254 : trayId,
      slot_id: isExt ? 0   : trayId,
      tray_color:      trayColor,
      nozzle_temp_min: _bblSelMat.tempMin,
      nozzle_temp_max: _bblSelMat.tempMax,
      tray_type:       _bblSelMat.tray_type,
      tray_info_idx:   _bblSelMat.bambuID,
    },
  });

  // Optimistic local update
  const d = conn.data;
  if (isExt) {
    if (!d.externalTray) d.externalTray = {};
    d.externalTray.color = trayColor;
    d.externalTray.type  = _bblSelMat.label;
  } else {
    const mod = d.ams?.[amsId];
    if (mod?.tray) {
      const slot = mod.tray.find(t => parseInt(t.id, 10) === trayId);
      if (slot) { slot.tray_color = trayColor; slot.type = _bblSelMat.label; }
    }
  }

  closeBambuFilamentEdit();
});

// ── Self-registration ──────────────────────────────────────────────────────

registerBrand('bambulab', {
  meta, schema, helper,
  renderJobCard:        renderBambuJobCard,
  renderTempCard:       renderBambuTempCard,
  renderFilamentCard:   renderBambuFilamentCard,
  renderSettingsWidget: schemaWidget(schema),
});
