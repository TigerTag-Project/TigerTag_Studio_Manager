/**
 * printers/elegoo/index.js — Elegoo MQTT live integration.
 *
 * Uses the MQTT bridge exposed as window.elegoo (main-process IPC).
 * Protocol: MQTT plain TCP port 1883 — see PROTOCOL.md for full spec.
 *
 * State groups and method dispatch are documented inline.
 * Self-registers into the brands registry at module evaluation time.
 */
import { ctx } from '../context.js';
import { registerBrand, brands } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { renderElegooJobCard, renderElegooTempCard, renderElegooFilamentCard } from './cards.js';
import { renderElegooControlCard, patchElegooControlCard } from './widget_control.js';
import { schemaWidget } from '../modal-helpers.js';

const $ = id => document.getElementById(id);

// ── Per-printer live state ────────────────────────────────────────────────

// key → conn object. Module-scoped, never persisted to Firestore.
const _elegooConns = new Map();

// ── Public key helper ─────────────────────────────────────────────────────

export function elegooKey(p) { return `${p.brand}:${p.id}`; }

export function elegooGetConn(key) { return _elegooConns.get(key) ?? null; }

export function elegooIsOnline(printer) {
  if (printer?.brand !== 'elegoo') return null;
  const key = elegooKey(printer);
  if (ctx.isForcedOffline?.(key)) return false; // explicitly disconnected via button
  const conn = _elegooConns.get(key);
  if (!conn) return null;
  if (conn.status === 'connected') return true;
  if (conn.status === 'disconnected' || conn.status === 'error' || conn.status === 'offline') return false;
  return null; // connecting
}

// ── Print state groups ────────────────────────────────────────────────────

const ELEGOO_ACTIVE = new Set(['printing', 'running', 'busy', 'preparing', 'heating']);
const ELEGOO_PAUSED = new Set(['paused']);
const ELEGOO_DONE   = new Set(['complete', 'completed', 'cancelled', 'canceled', 'standby']);

const STATE_LABELS = {
  printing:  'snapState_printing',  running:   'snapState_printing',
  paused:    'snapState_paused',
  complete:  'snapState_complete',  completed: 'snapState_complete',
  cancelled: 'snapState_cancelled', canceled:  'snapState_cancelled',
  error:     'snapState_error',     failed:    'snapState_error',
  standby:   'snapState_standby',
  busy:      'elgState_busy',
  preparing: 'elgState_preparing',
  heating:   'elgState_heating',
};

// ── Material preset catalogue — ported from create_elegoo_rfid.dart ──────
// Each entry: { main: base filament_type, tempMin, tempMax }
// main  → sent as filament_type  in method 1055/2003
// key   → sent as filament_name  in method 1055/2003
// Source: elegooPresetBySubtype in TigerTag Connect Flutter app.
const ELG_MATERIAL_PRESETS = {
  // PLA family
  'PLA':           { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA+':          { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Pro':       { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Basic':     { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Matte':     { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Silk':      { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA-CF':        { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Wood':      { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Marble':    { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Galaxy':    { main: 'PLA',   tempMin: 190, tempMax: 230 },
  'PLA Red Copper':{ main: 'PLA',   tempMin: 190, tempMax: 230 },
  'RAPID PLA+':    { main: 'PLA',   tempMin: 190, tempMax: 230 },
  // PETG family
  'PETG':              { main: 'PETG',  tempMin: 220, tempMax: 250 },
  'PETG-CF':           { main: 'PETG',  tempMin: 220, tempMax: 250 },
  'PETG-GF':           { main: 'PETG',  tempMin: 220, tempMax: 250 },
  'PETG Pro':          { main: 'PETG',  tempMin: 220, tempMax: 250 },
  'PETG Translucent':  { main: 'PETG',  tempMin: 220, tempMax: 250 },
  'RAPID PETG':        { main: 'PETG',  tempMin: 220, tempMax: 250 },
  // ABS family
  'ABS':           { main: 'ABS',   tempMin: 230, tempMax: 260 },
  // TPU family
  'TPU 95A':       { main: 'TPU',   tempMin: 210, tempMax: 240 },
  'RAPID TPU 95A': { main: 'TPU',   tempMin: 210, tempMax: 240 },
  // ASA
  'ASA':           { main: 'ASA',   tempMin: 240, tempMax: 260 },
  // PA family
  'PAHT-CF':       { main: 'PA',    tempMin: 250, tempMax: 290 },
  // CPE
  'CPE':           { main: 'CPE',   tempMin: 240, tempMax: 270 },
  // PC family
  'PC':            { main: 'PC',    tempMin: 260, tempMax: 300 },
  'PC-FR':         { main: 'PC',    tempMin: 260, tempMax: 300 },
  // PVA / BVOH (support materials)
  'PVA':           { main: 'PVA',   tempMin: 190, tempMax: 220 },
  'BVOH':          { main: 'BVOH',  tempMin: 190, tempMax: 220 },
  // Specialty
  'EVA':           { main: 'EVA',   tempMin: 180, tempMax: 210 },
  'HIPS':          { main: 'HIPS',  tempMin: 230, tempMax: 250 },
  'PP':            { main: 'PP',    tempMin: 220, tempMax: 240 },
  'PPA':           { main: 'PPA',   tempMin: 280, tempMax: 320 },
  'PPS':           { main: 'PPS',   tempMin: 300, tempMax: 340 },
};

// Full alphabetically sorted list
const ELG_MATERIAL_LIST = Object.keys(ELG_MATERIAL_PRESETS)
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

// Vendor names for the brand picker (unchanged)
const ELG_VENDOR_NAMES = ['Generic', 'ELEGOO', 'Rosa3D', 'R3D', 'Landu', 'eSun', 'Sunlu', 'JamgHe'];

// ── Log helpers ───────────────────────────────────────────────────────────

const ELG_LOG_MAX = 150;

function elgLogPush(conn, dir, raw, summaryOverride = null) {
  if (!conn || conn.logPaused) return;
  if (!conn.log) conn.log = [];
  let summary = summaryOverride || '';
  if (!summary) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj === 'object') {
        const method = obj.method ?? obj.cmd;
        if (method !== undefined) summary = `method:${method}`;
        if (obj.data?.status) summary += `  ${String(obj.data.status).slice(0, 30)}`;
      }
    } catch (_) {}
  }
  if (!summary) {
    try { summary = String(raw).slice(0, 60); } catch (_) { summary = '(binary)'; }
  }
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  conn.log.push({
    dir, ts, summary,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
    expanded: false,
  });
  if (conn.log.length > ELG_LOG_MAX) conn.log.shift();
  // Update count badge without full re-render
  const countEl = $('elgLogCount');
  if (countEl) countEl.textContent = String(conn.log.length);
}

// ── rAF-coalesced re-renders ──────────────────────────────────────────────

let _elgRenderRaf     = null;
let _elgCardRaf       = null;
let _elgRenderStatusFlag = false;

// Bind hold-to-confirm on print-control buttons after each DOM render.
// Pause  (1021) — 1 s hold
// Resume (1023) — 0.8 s hold  (NOT 1022 — see PROTOCOL.md §15.3)
// Cancel (1022) — 1.5 s hold  (NOT 1023 — see PROTOCOL.md §15.4)
function _elegooBindPrintBtns(printer, conn) {
  const pauseBtn  = document.querySelector("[data-elg-print-action='pause']");
  const resumeBtn = document.querySelector("[data-elg-print-action='resume']");
  const cancelBtn = document.querySelector("[data-elg-print-action='cancel']");
  if (pauseBtn)  ctx.setupHoldToConfirm(pauseBtn,  1000, () => _elgPublish(conn, 1021, {}));
  if (resumeBtn) ctx.setupHoldToConfirm(resumeBtn,   800, () => _elgPublish(conn, 1023, {}));
  if (cancelBtn) ctx.setupHoldToConfirm(cancelBtn,  1500, () => _elgPublish(conn, 1022, {}));
}

function elgNotifyChange(conn, statusChanged = false) {
  // Always refresh the printer cards grid when connection status changes
  // (Online / Connecting / Offline badge). Independent of which printer is open.
  if (statusChanged && !_elgCardRaf) {
    _elgCardRaf = requestAnimationFrame(() => {
      _elgCardRaf = null;
      ctx.onPrintersViewChange();
    });
  }

  // Detail-panel refresh — only when this printer is open in the sidecard.
  const activePrinter = ctx.getActivePrinter();
  if (!activePrinter) return;
  if (elegooKey(activePrinter) !== conn.key) return;
  if (statusChanged) _elgRenderStatusFlag = true;
  if (_elgRenderRaf) return;
  _elgRenderRaf = requestAnimationFrame(() => {
    _elgRenderRaf = null;
    const fullRerender = _elgRenderStatusFlag;
    _elgRenderStatusFlag = false;
    if (fullRerender) {
      ctx.onFullRender();
    } else {
      const liveHost = $('elgLive');
      if (liveHost) {
        const jobEl  = $('elgLiveJob');
        const ctrlEl = $('elgLiveCtrl');
        const tempEl = $('elgLiveTemp');
        const filEl  = $('elgLiveFil');
        if (jobEl && ctrlEl && tempEl && filEl) {
          // Patch chirurgical — seules les valeurs changent, pas la structure
          const b = brands.get('elegoo');
          jobEl.innerHTML  = b.renderJobCard(activePrinter, conn);
          _elegooBindPrintBtns(activePrinter, conn);
          patchElegooControlCard(ctrlEl, conn);
          // Skip temp re-render while the user is editing a target value inline.
          if (!document.querySelector("[data-elg-set-temp][data-editing='1']")) {
            tempEl.innerHTML = b.renderTempCard(conn);
          }
          filEl.innerHTML  = b.renderFilamentCard(activePrinter, conn);
        } else {
          // Premiers render ou structure absente → innerHTML complet
          liveHost.innerHTML = renderElegooLiveInner(activePrinter);
          _elegooBindPrintBtns(activePrinter, conn);
        }
      }
      const logHost = $('elgLog');
      if (logHost) logHost.innerHTML = renderElegooLogInner(activePrinter);
      const countEl = $('elgLogCount');
      if (countEl) countEl.textContent = String(conn.log?.length || 0);
    }
  });
}

// ── MQTT topic / payload routing ──────────────────────────────────────────

let _elgGlobalHandlersStarted = false;

function _startGlobalHandlers() {
  if (_elgGlobalHandlersStarted) return;
  _elgGlobalHandlersStarted = true;

  if (!window.elegoo) return;

  window.elegoo.onStatus((key, status) => {
    const conn = _elegooConns.get(key);
    if (!conn) return;
    // Once abandoned (bad IP, 3 failures), ignore all further MQTT callbacks.
    if (conn._abandoned) return;
    const prev = conn.status;

    if (status === 'connected') {
      conn.status = 'connected';
      conn._errorCount = 0; // reset on successful connect
      elgLogPush(conn, '✓', `MQTT connected — SN:${conn.sn}  client:${conn.clientId}`);
      if (!conn._initSnapshotSent) {
        conn._initSnapshotSent = true;
        _sendInitSnapshot(conn);
        // The api_status push (method 6000) only broadcasts temperatures.
        // print_status (progress / layers / remaining) is only in method 1005
        // responses — so we poll every 10 s to keep the progress bar current.
        conn._refreshTimer = setInterval(() => {
          if (!_elegooConns.has(conn.key)) { clearInterval(conn._refreshTimer); return; }
          _elgPublish(conn, 1005, {});
        }, 10_000);
        // PING/PONG — ISO with Elegoo slicer (every 10 s).
        _startPingLoop(conn);
      }
    } else if (status.startsWith('error:') || status === 'offline') {
      conn._errorCount++;
      const MAX = 3;
      if (conn._errorCount >= MAX) {
        // Give up — bad IP or permanently unreachable host.
        // Keep conn in map (for card display) but stop the retry loop.
        conn._abandoned = true;
        conn.status = 'offline';
        if (conn._refreshTimer) { clearInterval(conn._refreshTimer); conn._refreshTimer = null; }
        if (conn._pingTimer)    { clearInterval(conn._pingTimer);    conn._pingTimer = null; }
        window.elegoo.disconnect(key); // stops the MQTT client retry loop
        elgLogPush(conn, '✗', `Unreachable after ${MAX} attempts — giving up (check IP)`);
      } else {
        conn.status = status === 'offline' ? 'offline' : 'error';
        elgLogPush(conn, '!', status === 'offline'
          ? `MQTT offline (attempt ${conn._errorCount}/${MAX})`
          : `Error (attempt ${conn._errorCount}/${MAX}): ${status.slice(6)}`);
      }
    } else if (status === 'disconnected') {
      conn.status = 'disconnected';
      elgLogPush(conn, '!', 'MQTT disconnected');
    } else if (status === 'connecting') {
      conn.status = 'connecting';
      if (conn._errorCount > 0) elgLogPush(conn, '…', `Reconnecting… (attempt ${conn._errorCount + 1}/3)`);
    } else {
      conn.status = status;
      elgLogPush(conn, '…', `Status: ${status}`);
    }
    elgNotifyChange(conn, conn.status !== prev);
  });

  window.elegoo.onMessage((key, topic, data) => {
    const conn = _elegooConns.get(key);
    if (!conn) return;
    elgLogPush(conn, '←', data);
    _routeMessage(conn, topic, data);
  });
}

// ── Snapshot burst on connect ─────────────────────────────────────────────

// Snapshot burst on connect — order ISO with Elegoo slicer (observed live via MQTT sniffer).
// Method 1043 = set hostname — MUST be first (slicer always sends it before any data request).
// Method 1002 = comprehensive status (temps + print_status + machine_status).
// Method 1005 = print_status only (state / filename / uuid / layers / remaining).
// Method 2005 = filament slots (canvas_info.canvas_list[0].tray_list).
// Method 1061 = mono-extruder filament info — used when Canvas system is disconnected.
// Method 1042 = camera URL → {"url":"http://{ip}:8080/?action=stream"} (dynamic, not hardcoded).
// Method 1001 = machine info (hostname, firmware version, model, SN).
// Method 1044 = file list → total layers cache.
const SNAPSHOT_BURST = [
  { method: 1043, params: { hostname: 'TigerTag Studio' } },  // announce client identity — FIRST
  { method: 1002, params: {} },   // temps + print_status + machine_status
  { method: 1005, params: {} },   // print_status detail (state / filename / layers)
  { method: 2005, params: {} },   // canvas filament slots (4-tray)
  { method: 1061, params: {} },   // mono-extruder filament fallback (no Canvas)
  { method: 1042, params: {} },   // camera stream URL (dynamic)
  { method: 1001, params: {} },   // machine info (firmware version, model)
  { method: 1044, params: { storage_media: 'local', offset: 0, limit: 50 } }, // file list → total layers cache
];

function _sendInitSnapshot(conn) {
  SNAPSHOT_BURST.forEach(({ method, params }, i) => {
    setTimeout(() => {
      if (!_elegooConns.has(conn.key)) return;
      _elgPublish(conn, method, params);
    }, i * 50);
  });
}

// PING/PONG — applicative heartbeat (ISO with Elegoo slicer, every 10 s).
// The MQTT keepAlive alone is not enough — the slicer sends explicit PING frames.
// Responses {"type":"PONG"} are silently ignored in _routeMessage (no method number).
function _startPingLoop(conn) {
  if (conn._pingTimer) return; // already running
  conn._pingTimer = setInterval(() => {
    if (!_elegooConns.has(conn.key)) { clearInterval(conn._pingTimer); return; }
    if (conn.status !== 'connected') return;
    const topic = `elegoo/${conn.sn}/${conn.clientId}/api_request`;
    window.elegoo.publish(conn.key, topic, { type: 'PING' });
  }, 10_000);
}

let _elgReqId = 0;

function _elgPublish(conn, method, params = {}) {
  if (!window.elegoo) return 0;
  // PROTOCOL.md §4 envelope: { id, method, params }
  const payload = { id: ++_elgReqId, method, params };
  // Publish topic: elegoo/{sn}/{clientId}/api_request  (NOT /request)
  const topic = `elegoo/${conn.sn}/${conn.clientId}/api_request`;
  elgLogPush(conn, '→', payload, `→ method:${method}`);
  window.elegoo.publish(conn.key, topic, payload);
  // Force a log re-render so outgoing entries appear even if no reply comes.
  elgNotifyChange(conn, false);
  return payload.id; // caller can use this to correlate the response
}

// ── Public command API — callable from inventory.js event handlers ────────

/**
 * Send an arbitrary MQTT command to the printer identified by `key`.
 * Returns true if the message was queued, false if not connected.
 *
 * Caller is responsible for providing valid method / params per PROTOCOL.md.
 * Used by the Control card event handlers in inventory.js.
 */
export function elegooSendCmd(key, method, params = {}) {
  const conn = _elegooConns.get(key);
  if (!conn || conn.status !== 'connected') return false;
  _elgPublish(conn, method, params);
  return true;
}

/**
 * Build the full HTTP URL for a timelapse video and dispatch the download event.
 * Live observation: time_lapse_video_url is already "video/….mp4" — no 1051 needed.
 *
 * @param {object} printer   — printer record from state.printers
 * @param {string} videoPath — time_lapse_video_url field from the 1036 history item
 */
export function elegooTimelapseDl(printer, videoPath) {
  const conn = _elegooConns.get(elegooKey(printer));
  if (!conn || !videoPath) return;
  // Port 80, libhv endpoint /download?X-Token=<mqtt_password>&file_name=<encoded_path>
  // Confirmed via tcpdump: slicer uses GET /download on port 80, NOT port 8080 (camera).
  const password = conn.printer.mqttPassword || conn.printer.password || '123456';
  const fullUrl = `http://${conn.ip}/download?X-Token=${encodeURIComponent(password)}&file_name=${encodeURIComponent(videoPath)}`;
  // Clean filename: strip the .gcode{timestamp} part → "Foo_0.2_3m43s.mp4"
  const rawName = videoPath.split('/').pop();
  const filename = rawName.replace(/\.gcode\d+\.mp4$/i, '.mp4') || rawName;
  document.dispatchEvent(new CustomEvent('elg:timelapse-ready', {
    detail: { url: fullUrl, filename },
  }));
}

// ── Message routing by method ─────────────────────────────────────────────

function _routeMessage(conn, topic, data) {
  // api_status — live push broadcast, method is always 6000.
  // Observed live: the printer also embeds mono_filament_info or canvas_info
  // in the 6000 push when the user changes filament from the touchscreen.
  // Both handlers must be called so the filament card updates instantly.
  if (topic.endsWith('/api_status')) {
    _mergeStatus(conn, data);
    const r = data?.result ?? data;
    if (r?.mono_filament_info) _mergeMonoFilament(conn, data);
    if (r?.canvas_info)        _mergeFilaments(conn, data);
    elgNotifyChange(conn, false);
    return;
  }
  // api_response — Elegoo format: { method, result, ... }
  const method = data?.method ?? data?.cmd;
  switch (method) {
    case 6000: _mergeStatus(conn, data);    break;
    // Method 1002 = comprehensive status snapshot (temps + print_status + machine_status).
    // Method 1005 = print_status only (state/filename/uuid/layer/remaining).
    // Both share the same nested structure → same merge function.
    case 1002: _mergeStatus(conn, data); break;
    case 1005: _mergeStatus(conn, data); break;
    case 2005: _mergeFilaments(conn, data);    break;
    case 1061: _mergeMonoFilament(conn, data); break;
    case 1036: _mergeHistory(conn, data);      break;
    case 1044: _mergeLayerMap(conn, data);  break;
    case 1045: _mergeThumbnail(conn, data); break;
    case 1042: _mergeCameraUrl(conn, data); break;  // camera stream URL (dynamic)
    // 1043 (set hostname ack), 1001 (machine info), 1055 (filament write ack) — no merge needed
    default: break;
  }
  elgNotifyChange(conn, false);
}

// ── Data merge handlers ───────────────────────────────────────────────────

function _mergeStatus(conn, data) {
  if (!data || typeof data !== 'object') return;
  const d = conn.data;
  // PROTOCOL.md §5 — message wraps payload in "result"
  // Also accept flat payload as fallback (some firmware variants)
  const r = data.result ?? data;

  // ── Temperatures (PROTOCOL.md §5) ────────────────────────────────────────
  const nozzle      = r?.extruder?.temperature;
  const nozzleTarget = r?.extruder?.target;
  const bed         = r?.heater_bed?.temperature;
  const bedTarget   = r?.heater_bed?.target;
  const chamber     = r?.ztemperature_sensor?.temperature;
  if (nozzle       !== undefined) d.nozzleTemp   = Number(nozzle);
  if (nozzleTarget !== undefined) d.nozzleTarget = Number(nozzleTarget);
  if (bed          !== undefined) d.bedTemp      = Number(bed);
  if (bedTarget    !== undefined) d.bedTarget    = Number(bedTarget);
  if (chamber      !== undefined) d.chamberTemp  = Number(chamber);
  // Flat fallback keys
  if (r.nozzleTemp  !== undefined) d.nozzleTemp  = Number(r.nozzleTemp);
  if (r.bedTemp     !== undefined) d.bedTemp     = Number(r.bedTemp);
  if (r.chamberTemp !== undefined) d.chamberTemp = Number(r.chamberTemp);

  // ── Print status (nested, PROTOCOL.md §5) ───────────────────────────────
  const ps = r?.print_status;
  if (ps) {
    // CRITICAL: 'state' key present but === '' means standby/done (live-observed).
    // Must check 'state' in ps — not truthiness — so empty string resets state correctly.
    if ('state' in ps) {
      const rawState = String(ps.state).toLowerCase().trim();
      d.printState = rawState || 'standby';   // '' → 'standby'
    }
    if (ps.progress !== undefined) {
      let pct = Number(ps.progress);
      if (pct > 1.0001) pct /= 100;
      d.printProgress = Math.max(0, Math.min(1, pct));
    } else if (ps.print_duration !== undefined) {
      // 1005 responses omit progress — compute from elapsed / (elapsed + remaining)
      const elapsed   = Number(ps.print_duration)     || 0;
      const remaining = Number(ps.remaining_time_sec)  || 0;
      d.printProgress = (elapsed + remaining) > 0
        ? Math.max(0, Math.min(1, elapsed / (elapsed + remaining)))
        : 0;
    }
    // Store bed-mesh flag; force progress=0 while leveling (no actual printing yet)
    if (ps.bed_mesh_detect !== undefined) d.bedMeshDetect = !!ps.bed_mesh_detect;
    if (d.bedMeshDetect && !(d.printLayerCur > 0)) d.printProgress = 0;
    if (ps.current_layer     !== undefined) d.printLayerCur   = Math.round(Number(ps.current_layer));
    if (ps.filename          !== undefined) {
      d.printFilename = String(ps.filename || '') || null;
      // Cross-reference against the layer cache built from method 1044 file_list.
      if (d.printFilename && !d.printLayerTotal) {
        const cached = conn._layerMap.get(d.printFilename);
        if (cached) d.printLayerTotal = cached;
      }
    }
    if (ps.uuid !== undefined) {
      const newUuid = String(ps.uuid || '') || null;
      // New job UUID → progress from the previous job is stale, reset immediately.
      if (newUuid && newUuid !== d.printUuid) {
        d.printProgress    = 0;
        d.printLayerCur    = 0;
        d.printLayerTotal  = null;
        d.printRemainingMs = null;
      }
      d.printUuid = newUuid;
    }
    if (ps.remaining_time_sec !== undefined) d.printRemainingMs = Number(ps.remaining_time_sec) * 1000;
    if (ps.total_duration    !== undefined) d.printDuration   = Number(ps.total_duration);
  }
  // machine_status — derive state & progress when print_status absent or incomplete
  const ms = r?.machine_status;
  if (ms) {
    // progress fallback
    if (ms.progress !== undefined && !ps?.progress) {
      let pct = Number(ms.progress);
      if (pct > 1.0001) pct /= 100;
      d.printProgress = Math.max(0, Math.min(1, pct));
    }
    // machine status code → printState fallback (live-observed, PROTOCOL.md §6.1)
    // Only apply when print_status gave no usable state
    if (!ps || !('state' in ps)) {
      const machStatus    = Number(ms.status ?? -1);
      const machSubStatus = Number(ms.sub_status ?? 0);
      if      (machStatus === 1)  d.printState = 'standby';
      else if (machStatus === 14) d.printState = 'error';
      else if (machStatus === 3)  d.printState = 'printing';   // finishing sequence still active
      else if (machStatus === 2) {
        // sub_status refines the active state (PROTOCOL.md §7.2)
        if      (machSubStatus === 2901 || machSubStatus === 2902) d.printState = 'heating';   // nozzle/bed chauffage
        else if (machSubStatus === 2801 || machSubStatus === 2802) d.printState = 'heating';   // bed leveling
        else if (machSubStatus === 1405)                           d.printState = 'preparing'; // init impression
        else if (machSubStatus === 1066)                           d.printState = 'printing';
        else                                                       d.printState = 'printing';
      }
    }
    // exception_status — convert to error state
    if (Array.isArray(ms.exception_status) && ms.exception_status.length) {
      d.lastException = ms.exception_status;
    }
  }

  // ── Flat fallback keys (older firmware / snapshot replies) ───────────────
  if (!ps) {
    const rawState = String(r.printStatus || r.status || r.state || '').toLowerCase().trim();
    if (rawState) d.printState = rawState;
    if (r.printProgress !== undefined || r.progress !== undefined) {
      let pct = Number(r.printProgress ?? r.progress ?? 0);
      if (pct > 1.0001) pct /= 100;
      d.printProgress = Math.max(0, Math.min(1, pct));
    }
    if (r.printLayer   !== undefined) d.printLayerCur   = Math.round(Number(r.printLayer));
    if (r.targetLayer  !== undefined) d.printLayerTotal = Math.round(Number(r.targetLayer));
    if (r.totalLayer   !== undefined) d.printLayerTotal = Math.round(Number(r.totalLayer));
    if (r.printFileName !== undefined) d.printFilename  = String(r.printFileName || '') || null;
    if (r.printUuid    !== undefined) d.printUuid       = String(r.printUuid     || '') || null;
    if (r.remainTime   !== undefined) d.printRemainingMs = Number(r.remainTime) * 1000;
    if (r.remainingTime !== undefined) d.printRemainingMs = Number(r.remainingTime) * 1000;
  }

  // ── Position (gcode_move) — PROTOCOL.md §5.1 ────────────────────────────
  const gm = r?.gcode_move;
  if (gm) {
    if (gm.x          !== undefined) d.posX      = Number(gm.x);
    if (gm.y          !== undefined) d.posY      = Number(gm.y);
    if (gm.z          !== undefined) d.posZ      = Number(gm.z);
    if (gm.speed_mode !== undefined) d.speedMode = Number(gm.speed_mode);
  }

  // ── Fans — PROTOCOL.md §5.1 / §17 ──────────────────────────────────────
  const fans = r?.fans;
  if (fans) {
    if (fans.fan?.speed     !== undefined) d.fanModel = Number(fans.fan.speed);
    if (fans.aux_fan?.speed !== undefined) d.fanAux   = Number(fans.aux_fan.speed);
    if (fans.box_fan?.speed !== undefined) d.fanBox   = Number(fans.box_fan.speed);
  }

  // ── LED — PROTOCOL.md §5.1 / §17 ───────────────────────────────────────
  const led = r?.led;
  if (led?.status !== undefined) d.ledOn = led.status !== 0;

  // ── Homed axes — PROTOCOL.md §5.1 ───────────────────────────────────────
  const th = r?.tool_head;
  if (th?.homed_axes !== undefined) d.homedAxes = String(th.homed_axes || '');

  // ── Thumbnail request on new filename ───────────────────────────────────
  // PROTOCOL.md §8: correct param is file_name + storage_media:"local".
  // uuid param returns error_code:1003 (confirmed live). Trigger on filename
  // change (more reliable than uuid since uuid can be null on some firmware).
  // Skip if history-thumb queue is active — the printer can't correlate IDs,
  // so we must not interleave live and history 1045 requests.
  if (d.printFilename && d.printFilename !== conn._thumbnailLastFilename
      && !conn._historyThumbPendingFn && !conn._historyThumbQueue.length) {
    const now = Date.now();
    if (now - conn._thumbnailLastFetch > 1500) {
      conn._thumbnailLastFilename = d.printFilename;
      conn._thumbnailLastFetch    = now;
      _elgPublish(conn, 1045, { file_name: d.printFilename, storage_media: 'local' });
    }
  }
}

function _mergeFilaments(conn, data) {
  if (!data) return;
  const d = conn.data;
  const r = data.result ?? data;

  // ── Canvas connection state ──────────────────────────────────────────────
  // canvas_list[0].connected: 1 = Canvas hub present, 0 = no Canvas system.
  // When Canvas is disconnected all tray entries are empty strings — useless.
  // In that case fall back to method 1061 (mono_filament_info).
  const canvasEntry = r?.canvas_info?.canvas_list?.[0];
  if (canvasEntry !== undefined) {
    const canvasConnected = canvasEntry.connected === 1;
    conn.data._canvasConnected = canvasConnected;
    if (!canvasConnected) {
      // Canvas hub absent — request mono-extruder filament info instead.
      _elgPublish(conn, 1061, {});
      return;
    }
  }

  // ── Primary path: PROTOCOL.md §7 ────────────────────────────────────────
  // result.canvas_info.canvas_list[0].tray_list
  let trays = canvasEntry?.tray_list ?? null;

  // ── Fallback 1: flat arrays in params (PROTOCOL.md §7.1) ────────────────
  if (!Array.isArray(trays) || !trays.length) {
    const p = r?.params ?? data?.params;
    if (p?.filament_type) {
      const colors   = p.filament_color    || [];
      const types    = p.filament_type     || [];
      const vendors  = p.filament_vendor   || [];
      const names    = p.filament_name     || [];
      const minTemps = p.filament_min_temp || [];
      const maxTemps = p.filament_max_temp || [];
      const statuses = p.filament_status   || [];
      trays = types.map((type, i) => ({
        tray_id:         i,
        filament_color:  colors[i]   || null,
        filament_type:   type,
        brand:           vendors[i]  || '',
        filament_name:   names[i]    || '',
        min_nozzle_temp: minTemps[i] || null,
        max_nozzle_temp: maxTemps[i] || null,
        status:          statuses[i] || 0,
      }));
    }
  }

  // ── Fallback 2: legacy flat objects ──────────────────────────────────────
  if (!Array.isArray(trays) || !trays.length) {
    const flat = Array.isArray(r) ? r : (r?.filamentInfo || r?.trayInfo || r?.trays || null);
    if (Array.isArray(flat) && flat.length) trays = flat;
  }

  if (!Array.isArray(trays) || !trays.length) return;

  d.filaments = trays.map((t, i) => ({
    trayId:  t.tray_id      ?? t.trayId      ?? i,
    color:   (t.filament_color || t.color)
               ? `#${String(t.filament_color || t.color).replace(/^#/, '')}` : null,
    type:    String(t.filament_type || t.filamentType || t.type || '').trim() || null,
    vendor:  String(t.brand || t.vendor || '').trim() || null,
    name:    String(t.filament_name || t.filamentName || t.name || '').trim() || null,
    minTemp: t.min_nozzle_temp ?? t.minTemp ?? null,
    maxTemp: t.max_nozzle_temp ?? t.maxTemp ?? null,
    active:  !!(t.status === 1 || t.active === true || t.isActive === true),
  }));
}

// ── Method 1061 — mono-extruder filament info ─────────────────────────────
// Used when the Canvas multi-filament hub is disconnected. The printer reports
// its single loaded filament via mono_filament_info instead of tray_list.
// Only applied when conn.data._canvasConnected is false/undefined.
function _mergeMonoFilament(conn, data) {
  if (!data) return;
  // If canvas became active after we sent 1061, ignore this response.
  if (conn.data._canvasConnected === true) return;
  const r = data.result ?? data;
  const m = r?.mono_filament_info;
  if (!m) return;
  const colorRaw = String(m.filament_color || m.color || '').trim();
  const color    = colorRaw ? `#${colorRaw.replace(/^#/, '')}` : null;
  const type     = String(m.filament_type  || '').trim() || null;
  // Skip if no meaningful data (e.g. printer has no filament loaded at all)
  if (!type && !color) return;

  const existing = conn.data.filaments?.[0];
  if (existing) {
    // Partial push (e.g. only filament_color from a 6000 broadcast) —
    // only overwrite the fields that are actually present in this payload.
    if (color)                          existing.color   = color;
    if (type)                           existing.type    = type;
    if (m.brand         != null)        existing.vendor  = String(m.brand).trim()         || existing.vendor;
    if (m.filament_name != null)        existing.name    = String(m.filament_name).trim() || existing.name;
    if (m.min_nozzle_temp != null)      existing.minTemp = m.min_nozzle_temp;
    if (m.max_nozzle_temp != null)      existing.maxTemp = m.max_nozzle_temp;
    if (m.filament_code != null)        existing.code    = String(m.filament_code).trim() || existing.code;
  } else {
    // First time we see filament data — create the slot from scratch.
    conn.data.filaments = [{
      trayId:  m.tray_id ?? 0,
      color,
      type,
      vendor:  String(m.brand || '').trim() || null,
      name:    String(m.filament_name || '').trim() || null,
      minTemp: m.min_nozzle_temp ?? null,
      maxTemp: m.max_nozzle_temp ?? null,
      code:    String(m.filament_code || '').trim() || '0x0000',
      active:  true,
    }];
  }
}

function _mergeLayerMap(conn, data) {
  if (!data) return;
  const r = data.result ?? data;
  // Method 1044 file list — Dart source confirms field names: filename + layer (singular)
  // Also accept total_layer / totalLayer / layers for firmware variants.
  const fileList = r?.file_list ?? r?.fileList ?? (Array.isArray(r) ? r : null);
  if (Array.isArray(fileList)) {
    fileList.forEach(f => {
      const fn  = f.filename || f.name;
      const tot = f.layer ?? f.total_layer ?? f.totalLayer ?? f.layers;
      if (fn && tot) conn._layerMap.set(fn, Number(tot));
    });
    // After rebuilding the map, backfill printLayerTotal if we already know the filename.
    const curFn = conn.data.printFilename;
    if (curFn) {
      const cached = conn._layerMap.get(curFn);
      if (cached) conn.data.printLayerTotal = cached;
    }
  }
  // Single-file shape fallback (older firmware variants)
  const fn  = r?.printFileName || r?.filename;
  const tot = r?.totalLayer    || r?.totalLayers || r?.total_layer || r?.layer;
  if (fn && tot) conn._layerMap.set(fn, Number(tot));
  if (tot !== undefined && !conn.data.printLayerTotal) {
    conn.data.printLayerTotal = Number(tot);
  }

  // ── File sheet: store list + advance sequential loading ──────────────────
  // Only runs when the file sheet explicitly requested a listing
  // (conn._pendingFileMedia is set). Burst-init 1044 (no pending media) is ignored.
  if (conn._pendingFileMedia) {
    const parsed = Array.isArray(fileList)
      ? fileList.map(f => ({
          filename:   String(f.filename || f.name || '').trim(),
          size:       Number(f.size        || 0),
          layer:      f.layer ?? f.total_layer ?? f.totalLayer ?? null,
          print_time: f.print_time ?? null,
        })).filter(f => f.filename)
      : [];

    if (conn._pendingFileMedia === 'local') {
      conn._localFiles   = parsed;
      conn._localLoading = false;
      // Immediately kick off USB request
      conn._pendingFileMedia = 'usb';
      conn._usbLoading       = true;
      _elgPublish(conn, 1044, { storage_media: 'u-disk', dir: '/', offset: 0, limit: 50 });
    } else if (conn._pendingFileMedia === 'usb') {
      conn._usbFiles         = parsed;
      conn._usbLoading       = false;
      conn._pendingFileMedia = null;
    }
    _elgUpdateFileSheet(conn);
  }
}

function _mergeCameraUrl(conn, data) {
  if (!data) return;
  const r = data.result ?? data;
  const url = String(r?.url || '').trim();
  if (url) conn.data.cameraUrl = url;
}

function _mergeThumbnail(conn, data) {
  if (!data) return;
  const r = data.result ?? data;

  // The Elegoo firmware echoes the method number (1045) as the response "id" —
  // it does NOT echo our incremental request id. So we cannot correlate by id.
  // Instead: if a history thumb is in-flight (_historyThumbPendingFn is set),
  // this response belongs to the history queue; otherwise it's the live-print thumb.
  const isHistoryThumb = conn._historyThumbPendingFn !== null;

  if (r?.error_code === 1003) {
    if (isHistoryThumb) {
      // File not on printer — skip, advance to next in queue
      _elgHistoryThumbAdvance(conn);
    } else {
      // Current-print thumbnail not available yet — reset so we retry on next filename change
      conn._thumbnailLastFilename = null;
    }
    return;
  }

  const b64 = r?.thumbnail ?? r?.thumbData ?? r?.base64 ?? r?.imageData ?? r?.image;
  if (!b64) {
    if (isHistoryThumb) _elgHistoryThumbAdvance(conn);
    return;
  }

  const dataUri = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;

  if (isHistoryThumb) {
    // Store in history cache and re-render the open sheet
    conn._historyThumbs.set(conn._historyThumbPendingFn, dataUri);
    _elgHistoryThumbAdvance(conn);
    _elgUpdateFileSheet(conn);
  } else {
    // Current-print thumbnail
    conn.data.thumbnail = dataUri;
  }
}

// ── Connection lifecycle ──────────────────────────────────────────────────

export function elegooConnect(printer) {
  if (!window.elegoo) return;
  const key = elegooKey(printer);
  const existing = _elegooConns.get(key);
  if (existing && existing.ip === printer.ip) {
    existing.printer = printer;
    return;
  }
  if (existing) elegooDisconnect(key);

  const sn        = String(printer.sn || printer.serialNumber || '').trim();
  const clientId  = `TTG_${Math.floor(1000 + Math.random() * 9000)}`;
  const requestId = `${clientId}_req`;

  const conn = {
    key,
    ip: printer.ip,
    printer,
    sn,
    clientId,
    requestId,
    status: 'connecting',
    data: {
      nozzleTemp: null, nozzleTarget: null, bedTemp: null, bedTarget: null, chamberTemp: null,
      printState: null, printProgress: 0, bedMeshDetect: false,
      printLayerCur: 0, printLayerTotal: null,
      printFilename: null, printUuid: null, printRemainingMs: null,
      printDuration: null, lastException: [],
      filaments: [],
      thumbnail: null,
      history: [],
      historyLoading: false,
      cameraUrl: null,      // populated by method 1042 response
      // Control widget state (from gcode_move / fans / led / tool_head)
      posX: null, posY: null, posZ: null,
      fanModel: null, fanAux: null, fanBox: null,
      ledOn: null,
      speedMode: null,
      homedAxes: '',
    },
    _ctrlStep: 10,          // jog step size in mm — persisted in conn, not re-rendered
    _activeFileTab: 'history',     // current tab in file sheet: 'history' | 'local' | 'usb'
    _localFiles: [],               // file list from 1044 storage_media:"local"
    _usbFiles: [],                 // file list from 1044 storage_media:"u-disk"
    _localLoading: false,
    _usbLoading: false,
    _pendingFileMedia: null,       // tracks sequential 1044 requests from the file sheet
    _layerMap: new Map(),
    _initSnapshotSent: false,
    _thumbnailLastFilename: null,
    _thumbnailLastFetch: 0,
    _refreshTimer: null,
    _pingTimer: null,       // PING/PONG heartbeat (10 s, ISO with Elegoo slicer)
    _errorCount: 0,   // counts failed attempts; gives up after MAX_CONNECT_ERRORS
    _abandoned: false, // true = bad IP, no more retries until IP changes
    // History thumbnail loader — sequential queue (one request at a time)
    // NOTE: Elegoo firmware echoes method number as response id, so we cannot
    // correlate by id. We use _historyThumbPendingFn (non-null = in-flight) instead.
    _historyThumbs: new Map(),        // filename → data-URI
    _historyThumbQueue: [],           // filenames waiting to be fetched
    _historyThumbPendingFn: null,     // filename of in-flight request (null = idle)
    _historyThumbTimer: null,         // timeout if printer doesn't respond
    log: [],
    logExpanded: false,
    logPaused: false,
  };
  _elegooConns.set(key, conn);
  _startGlobalHandlers();

  // Initial log entry — visible immediately so the user knows a connection
  // attempt is underway even before MQTT responds.
  elgLogPush(conn, '…', `Connecting to mqtt://${printer.ip}:1883  SN:${sn || '(missing)'}  client:${clientId}`);

  window.elegoo.connect({
    key,
    host: printer.ip,
    port: 1883,
    sn,
    password: printer.mqttPassword || printer.password || '123456',
    clientId,
    requestId,
  });
  elgNotifyChange(conn, true);
}

export function elegooDisconnect(key) {
  const conn = _elegooConns.get(key);
  if (conn?._refreshTimer) { clearInterval(conn._refreshTimer); conn._refreshTimer = null; }
  if (conn?._pingTimer)    { clearInterval(conn._pingTimer);    conn._pingTimer = null; }
  if (window.elegoo) window.elegoo.disconnect(key);
  _elegooConns.delete(key);
}

// ── Live inner renderers ──────────────────────────────────────────────────

export function renderElegooLiveInner(p) {
  const conn = _elegooConns.get(elegooKey(p));
  if (!conn) return `
    <div class="snap-empty">
      <span class="icon icon-cloud icon-18"></span>
      <span>${ctx.esc(ctx.t('snapNoConnection'))}</span>
    </div>`;
  const b = brands.get('elegoo');
  return `
    <div id="elgLiveJob">${b.renderJobCard(p, conn)}</div>
    <div id="elgLiveCtrl">${renderElegooControlCard(p, conn)}</div>
    <div id="elgLiveTemp">${b.renderTempCard(conn)}</div>
    <div id="elgLiveFil">${b.renderFilamentCard(p, conn)}</div>`;
}

export function renderElegooLogInner(p) {
  const conn = _elegooConns.get(elegooKey(p));
  const log = conn?.log || [];
  if (!log.length) {
    return `<div class="snap-log-empty">${ctx.esc(ctx.t('snapLogEmpty'))}</div>`;
  }
  const rows = log.slice().reverse().map((e, i) => {
    let pretty = e.raw;
    try { pretty = JSON.stringify(JSON.parse(e.raw), null, 2); } catch (_) {}
    const expanded = !!e.expanded;
    return `
      <div class="snap-log-row snap-log-row--${e.dir === '→' ? 'out' : 'in'}${expanded ? ' snap-log-row--expanded' : ''}"
           data-log-idx="${log.length - 1 - i}">
        <button type="button" class="snap-log-row-head" data-row-toggle="1">
          <span class="snap-log-dir">${ctx.esc(e.dir)}</span>
          <span class="snap-log-ts">${ctx.esc(e.ts)}</span>
          <span class="snap-log-summary">${ctx.esc(e.summary)}</span>
          <span class="snap-log-row-chev icon icon-chevron-r icon-13"></span>
        </button>
        <div class="snap-log-detail"${expanded ? '' : ' hidden'}>
          <button type="button" class="snap-log-detail-copy" data-copy="${ctx.esc(pretty)}" title="${ctx.esc(ctx.t('copyLabel'))}">
            <span class="icon icon-copy icon-13"></span>
            <span>${ctx.esc(ctx.t('copyLabel'))}</span>
          </button>
          <pre class="snap-log-detail-pre">${ctx.esc(pretty)}</pre>
        </div>
      </div>`;
  }).join('');
  return `<div class="snap-log">${rows}</div>`;
}

// ── Filament edit bottom sheet ────────────────────────────────────────────

let _elgFilEdit = null;
let _elgSelectedVendor = 'Generic';
let _elgSelectedMaterial = 'PLA';

function _elgRenderVendorList(selected) {
  return ELG_VENDOR_NAMES.map(v => {
    const isSel = v === selected;
    return `<button type="button" class="sfe-fil-row${isSel ? ' is-selected' : ''}" data-val="${ctx.esc(v)}">${ctx.esc(v)}</button>`;
  }).join('');
}

function _elgRenderMaterialList(_vendor, selectedMat, filter) {
  const selLower    = (selectedMat || '').toLowerCase();
  const filterLower = (filter || '').trim().toLowerCase();
  const list = filterLower
    ? ELG_MATERIAL_LIST.filter(m => m.toLowerCase().includes(filterLower))
    : ELG_MATERIAL_LIST;
  if (!list.length) {
    return `<div class="sfe-fil-empty">${ctx.esc(ctx.t('noMatch') || 'No match')}</div>`;
  }
  return list.map(m => {
    const preset   = ELG_MATERIAL_PRESETS[m];
    const isSel    = m.toLowerCase() === selLower;
    const tempHint = preset ? `<span class="sfe-fil-row-temp">${preset.tempMin}–${preset.tempMax}°</span>` : '';
    return `<button type="button" class="sfe-fil-row${isSel ? ' is-selected' : ''}" data-val="${ctx.esc(m)}">
              <span class="sfe-fil-row-text">${ctx.esc(m)}</span>
              ${tempHint}
              ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ''}
            </button>`;
  }).join('');
}

function _elgRenderColorGrid(currentColor) {
  const grid = $('elgColorGrid');
  if (!grid) return;
  const cur = (currentColor || '').toLowerCase();
  const presetCells = ctx.SNAP_FIL_COLOR_PRESETS.map(c => {
    const isSel = c.toLowerCase() === cur;
    return `<button type="button" class="sfe-color-cell${isSel ? ' is-selected' : ''}"
                    data-color="${ctx.esc(c)}"
                    style="background:${ctx.esc(c)}"
                    title="${ctx.esc(c)}"></button>`;
  }).join('');
  const safeColor = currentColor && /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : '#888888';
  const customCell = `
    <div class="sfe-color-cell sfe-color-cell--custom" id="elgColorCustomBtn"
         style="background:${ctx.esc(safeColor)}"
         title="${ctx.esc(ctx.t('snapFilEditCustomColor') || 'Custom')}">
      <span class="icon icon-edit icon-13"></span>
      <input type="color" class="sfe-color-cell-native" id="elgColorPickerInline"
             value="${ctx.esc(safeColor)}" aria-label="Custom color"/>
    </div>`;
  grid.innerHTML = presetCells + customCell;
}

function _elgUpdateSummary() {
  const vendor = _elgSelectedVendor  || '';
  const mat    = _elgSelectedMaterial || '—';
  const valEl  = $('elgFilSummaryVal');
  if (valEl) valEl.textContent = vendor ? `${vendor} ${mat}` : mat;
  const dot = $('elgColorSummaryDot');
  if (dot) dot.style.background = $('elgColorInput')?.value || '#888';
}

function _elgOpenFilamentSheet() {
  $('elgFilamentSheet')?.classList.add('open');
  $('elgFilamentSheet')?.setAttribute('aria-hidden', 'false');
}
function _elgCloseFilamentSheet() {
  $('elgFilamentSheet')?.classList.remove('open');
  $('elgFilamentSheet')?.setAttribute('aria-hidden', 'true');
}
function _elgOpenColorSheet() {
  $('elgColorSheet')?.classList.add('open');
  $('elgColorSheet')?.setAttribute('aria-hidden', 'false');
}
function _elgCloseColorSheet() {
  $('elgColorSheet')?.classList.remove('open');
  $('elgColorSheet')?.setAttribute('aria-hidden', 'true');
}

export function openElegooFilamentEdit(printer, trayIdx) {
  const conn = _elegooConns.get(elegooKey(printer));
  const fil = conn?.data?.filaments?.[trayIdx] || {};
  _elgFilEdit = { printer, trayIdx, key: elegooKey(printer) };
  _elgSelectedVendor   = (fil.vendor && ELG_VENDOR_NAMES.includes(fil.vendor)) ? fil.vendor : 'Generic';
  _elgSelectedMaterial = fil.type || 'PLA';

  const colorInp = $('elgColorInput');
  if (colorInp) {
    colorInp.value = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color))
      ? fil.color.slice(0, 7)
      : '#FF5722';
  }

  $('elgFilEditSub').textContent = '';
  const errEl = $('elgError');
  if (errEl) errEl.hidden = true;

  const initialColor = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color))
    ? fil.color.slice(0, 7) : '#FF5722';
  _elgRenderColorGrid(initialColor);

  const vendorList = $('elgVendorList');
  if (vendorList) vendorList.innerHTML = _elgRenderVendorList(_elgSelectedVendor);
  const searchInp = $('elgMatSearch');
  if (searchInp) searchInp.value = '';
  const matList = $('elgMaterialList');
  if (matList) matList.innerHTML = _elgRenderMaterialList(_elgSelectedVendor, _elgSelectedMaterial, '');

  _elgCloseFilamentSheet();
  _elgCloseColorSheet();
  _elgUpdateSummary();

  $('elgFilEditSheet').classList.add('open');
  $('elgFilEditSheet').setAttribute('aria-hidden', 'false');
  $('elgFilEditBackdrop').classList.add('open');
}

export function closeElegooFilamentEdit() {
  $('elgFilEditSheet')?.classList.remove('open');
  $('elgFilEditSheet')?.setAttribute('aria-hidden', 'true');
  $('elgFilEditBackdrop')?.classList.remove('open');
  _elgCloseFilamentSheet();
  _elgCloseColorSheet();
  _elgFilEdit = null;
}

// ── DOM event wiring ──────────────────────────────────────────────────────

$('elgFilEditClose')?.addEventListener('click', closeElegooFilamentEdit);
$('elgFilEditBackdrop')?.addEventListener('click', closeElegooFilamentEdit);

$('elgOpenFilament')?.addEventListener('click', () => {
  _elgOpenFilamentSheet();
  setTimeout(() => {
    const sel = $('elgVendorList')?.querySelector('.is-selected');
    if (sel) sel.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, 0);
});
$('elgOpenColor')?.addEventListener('click', () => {
  _elgOpenColorSheet();
});

$('elgFilamentBack')?.addEventListener('click', () => {
  _elgUpdateSummary();
  _elgCloseFilamentSheet();
});
$('elgFilamentClose')?.addEventListener('click', () => {
  _elgUpdateSummary();
  _elgCloseFilamentSheet();
});
$('elgColorBack')?.addEventListener('click', () => {
  _elgUpdateSummary();
  _elgCloseColorSheet();
});
$('elgColorClose')?.addEventListener('click', () => {
  _elgUpdateSummary();
  _elgCloseColorSheet();
});

$('elgVendorList')?.addEventListener('click', e => {
  const row = e.target.closest('.sfe-fil-row');
  if (!row) return;
  _elgSelectedVendor = row.dataset.val || 'Generic';
  $('elgVendorList').querySelectorAll('.sfe-fil-row').forEach(r =>
    r.classList.toggle('is-selected', r === row));
  const matList = $('elgMaterialList');
  const filter = $('elgMatSearch')?.value || '';
  if (matList) matList.innerHTML = _elgRenderMaterialList(_elgSelectedVendor, _elgSelectedMaterial, filter);
  const v = $('elgVendor'); if (v) v.value = '';
});

$('elgMaterialList')?.addEventListener('click', e => {
  const row = e.target.closest('.sfe-fil-row');
  if (!row) return;
  _elgSelectedMaterial = row.dataset.val || 'PLA';
  const m = $('elgMaterial'); if (m) m.value = '';
  const filter = $('elgMatSearch')?.value || '';
  $('elgMaterialList').innerHTML = _elgRenderMaterialList(_elgSelectedVendor, _elgSelectedMaterial, filter);
  setTimeout(() => {
    _elgUpdateSummary();
    _elgCloseFilamentSheet();
  }, 180);
});

$('elgMatSearch')?.addEventListener('input', e => {
  const matList = $('elgMaterialList');
  if (matList) matList.innerHTML = _elgRenderMaterialList(_elgSelectedVendor, _elgSelectedMaterial, e.target.value);
});

$('elgColorGrid')?.addEventListener('click', e => {
  if (e.target.closest('#elgColorPickerInline')) return;
  const cell = e.target.closest('.sfe-color-cell:not(.sfe-color-cell--custom)');
  if (!cell) return;
  const c = cell.dataset.color;
  if (!c) return;
  $('elgColorInput').value = c;
  _elgRenderColorGrid(c);
  setTimeout(() => {
    _elgUpdateSummary();
    _elgCloseColorSheet();
  }, 150);
});
$('elgColorGrid')?.addEventListener('input', e => {
  if (!e.target.matches?.('#elgColorPickerInline')) return;
  const c = e.target.value;
  $('elgColorInput').value = c;
  const wrap = e.target.closest('.sfe-color-cell--custom');
  if (wrap) wrap.style.background = c;
});
$('elgColorGrid')?.addEventListener('change', e => {
  if (!e.target.matches?.('#elgColorPickerInline')) return;
  const c = e.target.value;
  $('elgColorInput').value = c;
  _elgRenderColorGrid(c);
  setTimeout(() => {
    _elgUpdateSummary();
    _elgCloseColorSheet();
  }, 100);
});

// Apply — method 1055 (mono, no Canvas) or 2003 (Canvas connected)
// Observed live via MQTT sniffer: slicer uses method 1055 for single-extruder write.
$('elgFilEditSave')?.addEventListener('click', async () => {
  if (!_elgFilEdit) return;
  const conn    = _elegooConns.get(_elgFilEdit.key);
  const errEl   = $('elgError');
  errEl.hidden  = true;

  // Selected material — full subtype name (e.g. "PLA Silk", "RAPID PETG").
  // Look up in ELG_MATERIAL_PRESETS to get the base filament_type and correct temps.
  const selectedMat  = String($('elgMaterial').value || _elgSelectedMaterial || 'PLA').trim();
  const preset       = ELG_MATERIAL_PRESETS[selectedMat];
  const filamentType = preset?.main || selectedMat.split(/[\s+\-_\/]+/)[0] || selectedMat;
  const filamentName = selectedMat;   // full subtype → filament_name

  let rawColor = String($('elgColorInput').value || '#FF5722').trim();
  if (!/^#[0-9a-f]{6}$/i.test(rawColor)) rawColor = '#FF5722';
  const filamentColor = rawColor.toUpperCase();

  const trayIdx  = _elgFilEdit.trayIdx;
  const fil      = conn?.data?.filaments?.[trayIdx] || {};
  const trayId   = fil.trayId ?? trayIdx;

  // Mono mode (no Canvas): method 1055 — observed live from Elegoo slicer.
  // Canvas mode: method 2003 — canvas_id always 0.
  const isMono   = conn?.data?._canvasConnected === false;
  const method   = isMono ? 1055 : 2003;
  const payload  = {
    canvas_id:         0,
    tray_id:           trayId,
    brand:             _elgSelectedVendor || fil.vendor || 'Generic',
    filament_type:     filamentType,   // base type: "PLA", "PETG", "ABS"…
    filament_name:     filamentName,   // full subtype: "PLA Silk", "RAPID PETG"…
    filament_code:     fil.code   || '0x0000',
    filament_color:    filamentColor,
    filament_min_temp: preset?.tempMin ?? fil.minTemp ?? 190,
    filament_max_temp: preset?.tempMax ?? fil.maxTemp ?? 230,
  };

  if (!conn) {
    errEl.textContent = ctx.t('ffgErrNetwork');
    errEl.hidden = false;
    return;
  }

  const btn = $('elgFilEditSave');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    elgLogPush(conn, '→', payload, `→ method:${method} tray:${trayId}`);
    _elgPublish(conn, method, payload);

    // Capture key/conn before close (closeElegooFilamentEdit nulls _elgFilEdit).
    // Wait for the printer to confirm before updating the UI:
    // request a fresh read (1061 mono / 2005 canvas) after the write settles.
    // _routeMessage will call elgNotifyChange when the response arrives.
    const connKey = conn.key;
    setTimeout(() => {
      const c = _elegooConns.get(connKey);
      if (!c) return;
      _elgPublish(c, isMono ? 1061 : 2005, {});
    }, 1000);

    closeElegooFilamentEdit();
  } catch (e) {
    console.warn('[elg] filament edit failed:', e?.message);
    errEl.textContent = ctx.t('ffgErrNetwork');
    errEl.hidden = false;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

// ── File history bottom sheet ─────────────────────────────────────────────

// ── History thumbnail queue ───────────────────────────────────────────────
// Fetches thumbnails one at a time for the history sheet.
// Elegoo firmware echoes method number (1045) as response "id" — NOT our
// request id — so correlation by id is impossible. We use _historyThumbPendingFn
// (non-null while in-flight) to route responses, and suppress live-print
// thumbnail requests while the queue is active.

function _elgHistoryThumbAdvance(conn) {
  // Clear in-flight state
  if (conn._historyThumbTimer) { clearTimeout(conn._historyThumbTimer); conn._historyThumbTimer = null; }
  conn._historyThumbPendingFn = null;
  // Process next item immediately (synchronous — no event-loop gap)
  _elgHistoryThumbNext(conn);
}

function _elgHistoryThumbNext(conn) {
  if (!conn._historyThumbQueue.length) return;
  if (conn._historyThumbPendingFn !== null) return; // already in-flight
  const fn = conn._historyThumbQueue.shift();
  if (!fn) return;
  conn._historyThumbPendingFn = fn;
  _elgPublish(conn, 1045, { file_name: fn, storage_media: 'local' });
  // 2 s timeout in case the printer never answers for this file
  conn._historyThumbTimer = setTimeout(() => _elgHistoryThumbAdvance(conn), 2000);
}

function _elgLoadHistoryThumbs(conn) {
  if (!conn?.data.history.length) return;
  // Build queue from history items that don't yet have a cached thumbnail.
  // Limit to 20 to avoid flooding the broker.
  const todo = conn.data.history
    .filter(item => item.task_status === 1 && item.task_name && !conn._historyThumbs.has(item.task_name))
    .slice(0, 20)
    .map(item => item.task_name);
  // Prepend new items (avoid duplicates already queued)
  const alreadyQueued = new Set(conn._historyThumbQueue);
  for (const fn of todo) {
    if (!alreadyQueued.has(fn)) conn._historyThumbQueue.push(fn);
  }
  _elgHistoryThumbNext(conn);
}

// ── History sheet helpers ─────────────────────────────────────────────────

function _elgFmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function _elgFmtDate(unixSec) {
  if (!unixSec) return '';
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function _mergeHistory(conn, data) {
  if (!data) return;
  const r = data.result ?? data;
  if (r?.error_code !== 0 && r?.error_code !== undefined) return;
  const list = r?.history_task_list;
  if (!Array.isArray(list)) return;
  // Most recent first
  conn.data.history = [...list].reverse();
  conn.data.historyLoading = false;
  _elgUpdateFileSheet(conn);
  // Kick off thumbnail loading for newly arrived history items
  _elgLoadHistoryThumbs(conn);
}

function _elgHistoryHtml(conn) {
  const esc = ctx.esc;
  const t   = ctx.t;
  const d   = conn.data;
  if (d.historyLoading && !d.history.length) {
    return `<div class="cre-files-empty">${esc(t('elgFilesLoading') || 'Loading…')}</div>`;
  }
  if (!d.history.length) {
    return `<div class="cre-files-empty">${esc(t('elgFilesEmpty') || 'No print history')}</div>`;
  }
  const activeName = String(d.printFilename || '').replace(/\.gcode$/i, '').trim();
  return `<div class="cre-files">${d.history.map(item => {
    const rawName   = String(item.task_name || '');
    const cleanName = rawName.replace(/\.gcode$/i, '');
    const isActive  = activeName && cleanName === activeName;
    const ok        = item.task_status === 1;
    const dur       = _elgFmtDuration((item.end_time || 0) - (item.begin_time || 0));
    const date      = _elgFmtDate(item.begin_time);
    const thumb     = conn._historyThumbs.get(rawName);
    const thumbHtml = thumb
      ? `<div class="cre-file-thumb" style="background-image:url('${thumb}');background-size:cover;background-position:center"></div>`
      : `<div class="cre-file-thumb cre-file-thumb--placeholder"><span class="icon icon-printer icon-16"></span></div>`;
    return `
      <div class="cre-file-row${isActive ? ' cre-file-row--active' : ''}">
        ${thumbHtml}
        <div class="cre-file-info">
          <span class="cre-file-name" title="${esc(rawName)}">${esc(cleanName)}</span>
          <div class="cre-file-pills">
            ${dur  ? `<span class="cre-file-pill cre-file-pill--dim">${esc(dur)}</span>` : ''}
            ${date ? `<span class="cre-file-pill cre-file-pill--dim">${esc(date)}</span>` : ''}
            <span class="elg-hist-status elg-hist-status--${ok ? 'ok' : 'cancel'}">
              ${ok ? '✓' : '✕'}
            </span>
          </div>
        </div>
        ${(item.time_lapse_video_status === 1 && item.time_lapse_video_url) ? `
        <button type="button"
                class="elg-fs-dl-btn"
                data-elg-hist-dl="${esc(String(item.time_lapse_video_url))}"
                title="${esc(t('elgTimelapseDl') || 'Télécharger le timelapse')}">
          <span class="icon icon-download icon-13"></span>
        </button>` : ''}
        <button type="button"
                class="elg-fs-print-btn"
                data-elg-file-print="${esc(rawName)}"
                data-elg-file-storage="local"
                title="${esc(t('elgFilePrint') || 'Print')}">
          ▶
        </button>
      </div>`;
  }).join('')}</div>`;
}

function _elgTimelapseHtml(conn) {
  const esc = ctx.esc;
  const t   = ctx.t;
  const d   = conn.data;
  if (d.historyLoading && !d.history.length) {
    return `<div class="cre-files-empty">${esc(t('elgFilesLoading') || 'Loading…')}</div>`;
  }
  const items = d.history.filter(item => item.time_lapse_video_status > 0 && item.time_lapse_video_url);
  if (!items.length) {
    return `<div class="cre-files-empty">${esc(t('elgTimelapseEmpty') || 'No timelapse videos')}</div>`;
  }
  return `<div class="cre-files">${items.map(item => {
    const rawName   = String(item.task_name || '');
    const cleanName = rawName.replace(/\.gcode$/i, '');
    const dur       = _elgFmtDuration((item.end_time || 0) - (item.begin_time || 0));
    const date      = _elgFmtDate(item.begin_time);
    const thumb     = conn._historyThumbs.get(rawName);
    const thumbHtml = thumb
      ? `<div class="cre-file-thumb" style="background-image:url('${thumb}');background-size:cover;background-position:center"></div>`
      : `<div class="cre-file-thumb cre-file-thumb--placeholder"><span class="icon icon-printer icon-16"></span></div>`;
    return `
      <div class="cre-file-row">
        ${thumbHtml}
        <div class="cre-file-info">
          <span class="cre-file-name" title="${esc(rawName)}">${esc(cleanName)}</span>
          <div class="cre-file-pills">
            ${dur  ? `<span class="cre-file-pill cre-file-pill--dim">${esc(dur)}</span>` : ''}
            ${date ? `<span class="cre-file-pill cre-file-pill--dim">${esc(date)}</span>` : ''}
          </div>
        </div>
        <button type="button"
                class="elg-fs-dl-btn elg-fs-dl-btn--always"
                data-elg-hist-dl="${esc(String(item.time_lapse_video_url))}"
                title="${esc(t('elgTimelapseDl') || 'Download timelapse')}">
          <span class="icon icon-download icon-13"></span>
        </button>
      </div>`;
  }).join('')}</div>`;
}

function _elgFileListHtml(conn, storage) {
  const esc      = ctx.esc;
  const t        = ctx.t;
  const loading  = storage === 'local' ? conn._localLoading : conn._usbLoading;
  const files    = storage === 'local' ? conn._localFiles   : conn._usbFiles;

  if (loading && !files.length) {
    return `<div class="cre-files-empty">${esc(t('elgFilesLoading') || 'Loading…')}</div>`;
  }
  if (!files.length) {
    return `<div class="cre-files-empty">${esc(t('elgFilesEmpty') || 'No files found')}</div>`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `<div class="cre-files">${files.map(f => {
    const cleanName = String(f.filename || '').replace(/\.gcode$/i, '');
    const isActive  = conn.data.printFilename && f.filename === conn.data.printFilename;
    const meta      = [
      f.layer ? `${f.layer} layers` : '',
      fmtSize(f.size),
    ].filter(Boolean).join(' · ');
    return `
      <div class="cre-file-row${isActive ? ' cre-file-row--active' : ''}">
        <div class="cre-file-thumb cre-file-thumb--placeholder">
          <span class="icon icon-printer icon-16"></span>
        </div>
        <div class="cre-file-info">
          <span class="cre-file-name" title="${esc(f.filename)}">${esc(cleanName)}</span>
          ${meta ? `<span class="cre-file-meta">${esc(meta)}</span>` : ''}
        </div>
        <button type="button"
                class="elg-fs-print-btn"
                data-elg-file-print="${esc(f.filename)}"
                data-elg-file-storage="${esc(storage)}"
                title="${esc(t('elgFilePrint') || 'Print')}">
          ▶
        </button>
      </div>`;
  }).join('')}</div>`;
}

let _elgFileSheetKey = null;

function _elgUpdateFileSheet(conn) {
  const body    = document.getElementById('elgFileSheetBody');
  const refresh = document.getElementById('elgFileSheetRefresh');
  if (!body) return;

  const tab = conn._activeFileTab || 'history';

  // Sync tab buttons active state
  document.querySelectorAll('#elgFileSheetTabs .elg-fs-tab').forEach(btn => {
    btn.classList.toggle('elg-fs-tab--active', btn.dataset.elgFsTab === tab);
  });

  // Render the right content
  if (tab === 'history') {
    body.innerHTML = _elgHistoryHtml(conn);
    if (refresh) refresh.classList.toggle('cre-file-refresh--loading', !!conn.data.historyLoading);
  } else if (tab === 'timelapse') {
    body.innerHTML = _elgTimelapseHtml(conn);
    if (refresh) refresh.classList.toggle('cre-file-refresh--loading', !!conn.data.historyLoading);
  } else {
    body.innerHTML = _elgFileListHtml(conn, tab);
    const loading = tab === 'local' ? conn._localLoading : conn._usbLoading;
    if (refresh) refresh.classList.toggle('cre-file-refresh--loading', loading);
  }
}

function _elgLoadFileLists(conn) {
  // Sequential: local first, USB after (see _mergeLayerMap for advance logic)
  conn._localFiles   = [];
  conn._usbFiles     = [];
  conn._localLoading = true;
  conn._usbLoading   = true;
  conn._pendingFileMedia = 'local';
  _elgPublish(conn, 1044, { storage_media: 'local', offset: 0, limit: 50 });
}

export function openElegooFileSheet(printer) {
  const key = elegooKey(printer);
  _elgFileSheetKey = key;
  const conn = _elegooConns.get(key);
  if (!conn) return;

  // Default to history tab on first open
  if (!conn._activeFileTab) conn._activeFileTab = 'history';

  // Always re-fetch history so the Timelapse tab stays up-to-date.
  // Only show "loading" spinner if we have no cached data yet.
  if (!conn.data.history.length) conn.data.historyLoading = true;
  _elgPublish(conn, 1036, {});

  // Always (re)load file lists when opening the sheet
  _elgLoadFileLists(conn);

  _elgUpdateFileSheet(conn);
  document.getElementById('elgFileSheet')?.classList.add('open');
  document.getElementById('elgFileSheet')?.setAttribute('aria-hidden', 'false');
  document.getElementById('elgFileSheetBackdrop')?.classList.add('open');
}

/** Switch the visible tab. Called from the inventory.js delegated click handler. */
export function elegooFileSheetSetTab(tab) {
  if (!_elgFileSheetKey) return;
  const conn = _elegooConns.get(_elgFileSheetKey);
  if (!conn) return;
  conn._activeFileTab = tab;
  _elgUpdateFileSheet(conn);
}

/** Send method 1020 — start a print job. */
export function elegooStartPrint(key, filename, storage) {
  const conn = _elegooConns.get(key);
  if (!conn || conn.status !== 'connected') return false;
  _elgPublish(conn, 1020, {
    filename,
    storage_media: storage,
    config: { delay_video: true, printer_check: true, print_layout: 'A' },
  });
  return true;
}

export function closeElegooFileSheet() {
  _elgFileSheetKey = null;
  document.getElementById('elgFileSheet')?.classList.remove('open');
  document.getElementById('elgFileSheet')?.setAttribute('aria-hidden', 'true');
  document.getElementById('elgFileSheetBackdrop')?.classList.remove('open');
}

document.getElementById('elgFileSheetClose')?.addEventListener('click', closeElegooFileSheet);
document.getElementById('elgFileSheetBackdrop')?.addEventListener('click', closeElegooFileSheet);
document.getElementById('elgFileSheetRefresh')?.addEventListener('click', () => {
  if (!_elgFileSheetKey) return;
  const conn = _elegooConns.get(_elgFileSheetKey);
  if (!conn) return;
  const tab = conn._activeFileTab || 'history';
  if (tab === 'history' || tab === 'timelapse') {
    conn.data.historyLoading = true;
    _elgPublish(conn, 1036, {});
  } else {
    _elgLoadFileLists(conn);
  }
  _elgUpdateFileSheet(conn);
});

// ── Self-registration ─────────────────────────────────────────────────────

registerBrand('elegoo', {
  meta, schema, helper,
  renderJobCard:        renderElegooJobCard,
  renderTempCard:       renderElegooTempCard,
  renderFilamentCard:   renderElegooFilamentCard,
  renderSettingsWidget: schemaWidget(schema),
});
