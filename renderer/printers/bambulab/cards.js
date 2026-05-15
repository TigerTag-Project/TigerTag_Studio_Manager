/**
 * printers/bambulab/cards.js — Bambu Lab live-block card widgets.
 *
 * Three card renderers: job, temperature, filament/AMS.
 * All use the existing .snap-* CSS classes so no new stylesheets needed.
 * Read from `ctx` at call time — never destructure at module scope.
 */
import { ctx } from '../context.js';

// ── Job card ──────────────────────────────────────────────────────────────

export function renderBambuJobCard(p, conn) {
  if (conn.status !== "connected") return "";
  const d = conn.data;
  const state    = d.printState || "idle";
  const isActive = ["printing", "preparing", "busy", "paused"].includes(state);
  const pct      = isActive ? Math.round(+(d.progress || 0)) : 0;
  const leafName = isActive && d.printFilename ? d.printFilename : "";

  const fallbackImg = ctx.printerImageUrlFor(p.brand, p.printerModelId)
                   || ctx.printerImageUrl(ctx.findPrinterModel(p.brand, "0"));
  const thumbUrl = fallbackImg || "";

  const layerText = isActive && (d.layerNum || d.totalLayerNum)
    ? `${d.layerNum || 0}/${d.totalLayerNum || 0}` : "";
  const timeText = isActive ? _bblFmtDuration(d.remainingTime) : "—";
  const stateLabel = ctx.t("snapState_" + state) || state;

  const nameLine = leafName
    ? `<div class="snap-job-name" title="${ctx.esc(leafName)}">${ctx.esc(leafName)}</div>`
    : `<div class="snap-job-name snap-job-name--idle">${ctx.esc(ctx.t("snapJobNoActive") || "—")}</div>`;

  return `
    <div class="snap-job snap-job--${ctx.esc(state)}">
      ${thumbUrl ? `<div class="snap-job-thumb" style="background-image:url('${ctx.esc(thumbUrl)}')"></div>` : ""}
      <div class="snap-job-info">
        ${nameLine}
        <div class="snap-job-stats">
          <span class="snap-job-pct">${pct}%</span>
          <span class="snap-job-time">${ctx.SNAP_ICON_CLOCK} <span>${ctx.esc(timeText)}</span></span>
        </div>
        <div class="snap-job-bar"><span style="width:${pct}%"></span></div>
        <div class="snap-job-foot">
          <span class="snap-job-state snap-job-state--${ctx.esc(state)}">${ctx.esc(stateLabel)}</span>
          ${layerText ? `<span class="snap-job-layers">${ctx.esc(layerText)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

// ── Temperature card ──────────────────────────────────────────────────────

export function renderBambuTempCard(conn) {
  const d = conn.data;
  const pills = [];

  // Nozzle
  if (d.nozzleCurrent != null || d.nozzleTarget != null) {
    const heating = typeof d.nozzleTarget === "number" && d.nozzleTarget > 0
                 && typeof d.nozzleCurrent === "number" && d.nozzleCurrent < d.nozzleTarget - 1;
    pills.push(`
      <div class="snap-temp${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(_bblFmtTempPair(d.nozzleCurrent, d.nozzleTarget))}</span>
      </div>`);
  }

  // Bed
  if (d.bedCurrent != null || d.bedTarget != null) {
    const heating = typeof d.bedTarget === "number" && d.bedTarget > 0
                 && typeof d.bedCurrent === "number" && d.bedCurrent < d.bedTarget - 1;
    pills.push(`
      <div class="snap-temp snap-temp--bed${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(_bblFmtTempPair(d.bedCurrent, d.bedTarget))}</span>
      </div>`);
  }

  // Chamber (X1C only — null for A1)
  if (d.chamberCurrent != null) {
    pills.push(`
      <div class="snap-temp snap-temp--chamber">
        ${ctx.SNAP_ICON_CHAMBER}
        <span class="snap-temp-val">${ctx.esc(_bblFmtTemp(d.chamberCurrent))}°C</span>
      </div>`);
  }

  if (!pills.length) return "";
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapTemperatureTitle"))}</h4>
      <div class="snap-temps">${pills.join("")}</div>
    </section>`;
}

// ── Filament / AMS card ───────────────────────────────────────────────────
//
// Layout mirrors the Creality CFS pattern:
//   Row 1 : [Ext.] [S1] [S2] [S3] [S4]  ← Ext. + first AMS module
//   Row 2+: [    ] [S1] [S2] [S3] [S4]  ← invisible spacer + next AMS
// No AMS  : [Ext.] alone on row 1.

export function renderBambuFilamentCard(_p, conn) {
  const d = conn?.data;
  if (!d) return "";

  // Sort AMS modules by numeric ID so AMS 1 is always row 1.
  const amsMods = [...(d.ams || [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  // ── slot renderer ──────────────────────────────────────────────────────
  const makeSlot = (tag, t, amsId, trayId) => {
    const color  = t?.color ?? null;
    const fg     = color ? _bblTextColor(color) : "var(--text)";
    const active = t?.active ?? false;
    const isEmpty = !color && !t?.type;
    const label  = isEmpty ? "?" : (t?.type || "—");
    const editAttrs = `data-bbl-fil-edit="1" data-ams-id="${amsId ?? 255}" data-tray-id="${trayId ?? 254}"`;
    return `
      <div class="snap-fil snap-fil--editable${active ? " snap-fil--active" : ""}" ${editAttrs}>
        <div class="snap-fil-tag">${ctx.esc(tag)}</div>
        <div class="snap-fil-square${color ? "" : " snap-fil-square--empty"}"
             style="${color ? `background:${ctx.esc(color)};color:${ctx.esc(fg)};border-color:${ctx.esc(color)};` : ""}">
          <span class="snap-fil-main">${ctx.esc(label)}</span>
        </div>
        <div class="snap-fil-meta">
          <span class="snap-fil-status icon icon-edit icon-13" aria-hidden="true"></span>
          ${active ? `<span class="snap-fil-status icon icon-play icon-13"></span>` : ""}
          ${t?.type ? `<div class="snap-fil-sub">${ctx.esc(t.type)}</div>` : ""}
        </div>
      </div>`;
  };

  // Invisible placeholder that keeps the Ext. column width on rows 2+
  const extSpacer = `<div class="snap-fil cre-fil-spacer" aria-hidden="true"></div>`;

  const rows = [];

  // ── Slot renderer for one AMS module row (always 4 cells) ────────────
  // Mirrors Flutter: `for slotIndex = 0; slotIndex < 4` with empty chips
  // for slots the module doesn't have (AMS HT only has slot 0 = id "0").
  // Fixed count keeps every row at 5 flex children → columns stay aligned.
  const filSpacer = `<div class="snap-fil bbl-fil-spacer" aria-hidden="true"></div>`;

  const makeAmsRow = (mod, rowLetter, modIdx) => {
    const byId = new Map((mod?.tray || []).map(t => [parseInt(t.id, 10), t]));
    const cells = [];
    for (let i = 0; i < 4; i++) {
      const t = byId.get(i);
      cells.push(t ? makeSlot(`${rowLetter}${i + 1}`, t, modIdx, i) : filSpacer);
    }
    return cells.join("");
  };

  // ── Row 1: Ext. + first AMS module (or just Ext. if no AMS) ───────────
  {
    const row1 = [makeSlot("Ext.", d.externalTray ?? null, 255, 254)];
    if (amsMods.length > 0) {
      row1.push(makeAmsRow(amsMods[0], "A", 0));
    }
    rows.push(`<div class="cre-fil-row">${row1.join("")}</div>`);
  }

  // ── Rows 2+: extra AMS modules, Ext. column stays empty (spacer) ──────
  for (let mi = 1; mi < amsMods.length; mi++) {
    const rowLetter = String.fromCharCode(65 + mi);        // 'B', 'C', …
    rows.push(`<div class="cre-fil-row">${extSpacer}${makeAmsRow(amsMods[mi], rowLetter, mi)}</div>`);
  }

  if (!rows.length) return "";

  // AMS humidity / temp meta — shown in the title only for a single AMS unit
  let meta = "";
  if (amsMods.length === 1) {
    const parts = [];
    if (amsMods[0].humidity) parts.push(`💧${ctx.esc(String(amsMods[0].humidity))}%`);
    if (amsMods[0].temp)     parts.push(`${ctx.esc(String(amsMods[0].temp))}°C`);
    if (parts.length) meta = `<span class="snap-block-meta">${parts.join(" · ")}</span>`;
  }

  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapFilamentTitle"))}${meta}</h4>
      <div class="cre-fil-rows">${rows.join("")}</div>
    </section>`;
}

// ── Private helpers ───────────────────────────────────────────────────────


function _bblFmtTemp(v) {
  return (typeof v === "number" && v >= 0) ? `${Math.round(v)}` : "—";
}
function _bblFmtTempPair(cur, tgt) {
  return `${_bblFmtTemp(cur)}/${_bblFmtTemp(tgt)}°C`;
}
function _bblFmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}
function _bblTextColor(hex) {
  if (!hex || hex.length < 7) return "#fff";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.55 ? "#000" : "#fff";
}
