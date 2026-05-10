/**
 * printers/flashforge/cards.js — FlashForge live-block card widgets.
 *
 * All functions read from ctx at call time — never destructure ctx at
 * module scope, so inventory.js can populate it after import resolution.
 *
 * Local helpers (ffgFmtTempSolo, ffgIsActiveState, ffgStateLabel,
 * ffgFmtDuration) moved here from inventory.js — they are only used
 * by these card renderers.
 */
import { ctx } from '../context.js';

// ── Local helpers ─────────────────────────────────────────────────────────────

function ffgFmtTempSolo(v) {
  return (typeof v === "number" && isFinite(v)) ? `${Math.round(v)}°C` : "—";
}

// Print state mapping — FlashForge ships its own vocabulary that we
// surface with our own (i18n-able) labels. Active = the print-job
// card should render and progress / layer counters are meaningful.
const FFG_ACTIVE_STATES = new Set([
  "printing", "preparing", "heating", "busy", "paused"
]);

function ffgIsActiveState(s) {
  return FFG_ACTIVE_STATES.has(String(s || "").toLowerCase().trim());
}

function ffgStateLabel(s) {
  const norm = String(s || "").toLowerCase().trim();
  // We deliberately reuse the snapState_* keys for shared states so the
  // user reads the same label across brands. FlashForge introduces a
  // few extras (preparing, heating, busy, ready) we map to bespoke
  // ffgState_* keys.
  const aliases = {
    "printing":  "snapState_printing",
    "paused":    "snapState_paused",
    "complete":  "snapState_complete",
    "completed": "snapState_complete",
    "cancelled": "snapState_cancelled",
    "canceled":  "snapState_cancelled",
    "error":     "snapState_error",
    "standby":   "snapState_standby",
    "idle":      "snapState_standby",
    "ready":     "ffgState_ready",
    "preparing": "ffgState_preparing",
    "heating":   "ffgState_heating",
    "busy":      "ffgState_busy"
  };
  const key = aliases[norm];
  if (!key) return norm || "—";
  const lbl = ctx.t(key);
  return lbl && lbl !== key ? lbl : (norm || "—");
}

function ffgFmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

// ── Card renderers ────────────────────────────────────────────────────────────

export function renderFfgJobCard(p, conn) {
  const d = conn.data;
  if (conn.status !== "connected") return "";
  const jobState  = d.printState || "idle";
  const isActive  = ffgIsActiveState(jobState);
  const pct       = isActive ? Math.round((d.progress || 0) * 100) : 0;
  const leafName  = isActive && d.printFilename
                  ? String(d.printFilename).split("/").pop()
                  : "";
  const fallbackImg = ctx.printerImageUrlFor(p.brand, p.printerModelId)
                   || ctx.printerImageUrl(ctx.findPrinterModel(p.brand, "0"));
  const thumbUrl  = (isActive && d.printPreviewUrl) ? d.printPreviewUrl : (fallbackImg || "");
  const layerText = isActive && (d.currentLayer || d.totalLayer)
                  ? `${d.currentLayer || 0}/${d.totalLayer || 0}` : "";
  const timeText = isActive
                 ? (d.printEstimated ? ffgFmtDuration(d.printEstimated) : "—")
                 : "0m";
  const stateLabel = ffgStateLabel(jobState);
  const nameLine = leafName
    ? `<div class="snap-job-name" title="${ctx.esc(leafName)}">${ctx.esc(leafName)}</div>`
    : `<div class="snap-job-name snap-job-name--idle">${ctx.esc(ctx.t("snapJobNoActive") || "—")}</div>`;
  return `
    <div class="snap-job snap-job--${ctx.esc(jobState)}">
      <div class="snap-job-thumb"${thumbUrl ? ` style="background-image:url('${ctx.esc(thumbUrl)}')"` : ""}></div>
      <div class="snap-job-info">
        ${nameLine}
        <div class="snap-job-stats">
          <span class="snap-job-pct">${pct}%</span>
          <span class="snap-job-time">${ctx.SNAP_ICON_CLOCK} <span>${ctx.esc(timeText)}</span></span>
        </div>
        <div class="snap-job-bar"><span style="width:${pct}%"></span></div>
        <div class="snap-job-foot">
          <span class="snap-job-state snap-job-state--${ctx.esc(jobState)}">${ctx.esc(stateLabel)}</span>
          ${layerText ? `<span class="snap-job-layers">${ctx.esc(layerText)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

export function renderFfgTempCard(conn) {
  const d = conn.data;
  const tempPills = [];
  if (typeof d.temps.e1_temp === "number") {
    tempPills.push(`
      <div class="snap-temp">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(ffgFmtTempSolo(d.temps.e1_temp))}</span>
      </div>`);
  }
  if (typeof d.temps.bed_temp === "number") {
    tempPills.push(`
      <div class="snap-temp snap-temp--bed">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(ffgFmtTempSolo(d.temps.bed_temp))}</span>
      </div>`);
  }
  if (typeof d.temps.chamber_temp === "number") {
    tempPills.push(`
      <div class="snap-temp snap-temp--chamber">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(ffgFmtTempSolo(d.temps.chamber_temp))}</span>
      </div>`);
  }
  if (!tempPills.length) return "";
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapTemperatureTitle"))}</h4>
      <div class="snap-temps">${tempPills.join("")}</div>
    </section>`;
}

export function renderFfgFilamentCard(p, conn) {
  const d = conn.data;
  const filCards = [];
  const fils = Array.isArray(d.filaments) ? d.filaments : [];
  for (let i = 0; i < fils.length; i++) {
    const fil  = fils[i] || {};
    const has  = !!fil.hasFilament;
    const color = fil.color || null;
    const hasMeta = !!(color || fil.type);
    const isMulti = fils.length > 1;
    if (!has && !hasMeta && !isMulti) continue;
    const fg    = (has && color) ? ctx.snapTextColor(color) : "var(--text)";
    const slotId = fil.slotId || (i + 1);
    const squareLabel = has
      ? (fil.type || ctx.t("snapNoFilament"))
      : (hasMeta ? (ctx.t("ffgSlotEmpty") || "Empty") : ctx.t("snapNoFilament"));
    const typeAndSub = fil.type || "—";
    let squareCls = "snap-fil-square";
    let squareStyle = "";
    if (has && color) {
      squareCls += " snap-fil-square--filled";
      squareStyle = `background:${ctx.esc(color)};color:${ctx.esc(fg)};`;
    } else if (hasMeta && color) {
      squareCls += " snap-fil-square--configured";
      squareStyle = `box-shadow: inset 0 0 0 4px ${ctx.esc(color)};`;
    } else {
      squareCls += " snap-fil-square--empty";
    }
    const vendorRow = fil.vendor
      ? `<div class="snap-fil-vendor">${ctx.esc(fil.vendor)}</div>`
      : "";
    const slotTag = fil.slotKind === "ext"
      ? "Ext."
      : fil.slotKind === "ms"
      ? `1${"ABCD"[(slotId - 1) | 0] || ""}`
      : "E1";
    filCards.push(`
      <div class="snap-fil snap-fil--editable${fil.isActive ? " snap-fil--active" : ""}"
           data-ffg-fil-edit="1"
           data-extruder-idx="${i}"
           data-slot-id="${slotId}"
           data-slot-kind="${ctx.esc(fil.slotKind || "ext")}"
           title="${ctx.esc(ctx.t("snapFilEditableTip"))}">
        <div class="snap-fil-tag">${ctx.esc(slotTag)}</div>
        <div class="${squareCls}" style="${squareStyle}">
          <span class="snap-fil-main">${ctx.esc(squareLabel)}</span>
        </div>
        <div class="snap-fil-meta">
          <span class="snap-fil-status icon icon-edit icon-13" aria-hidden="true"></span>
          ${vendorRow}
          <div class="snap-fil-sub">${ctx.esc(typeAndSub)}</div>
        </div>
      </div>`);
  }
  if (!filCards.length) return "";
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapFilamentTitle"))}</h4>
      <div class="snap-fil-grid">${filCards.join("")}</div>
    </section>`;
}
