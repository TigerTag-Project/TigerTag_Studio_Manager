/**
 * printers/snapmaker/cards.js — Snapmaker live-block card widgets.
 *
 * All functions read from ctx at call time — never destructure ctx at
 * module scope, so inventory.js can populate it after import resolution.
 */
import { ctx } from '../context.js';

export function renderSnapJobCard(p, conn) {
  const d = conn.data;
  if (conn.status !== "connected") return "";
  const jobState  = d.printState || "standby";
  const isActive  = !["standby", "complete", "cancelled"].includes(jobState);
  const pct       = isActive ? Math.round(((d.progress || 0) * 100)) : 0;
  const leafName  = isActive && d.printFilename
                  ? ctx.snapFilenameRel(d.printFilename).split("/").pop()
                  : "";
  const fallbackImg = ctx.printerImageUrlFor(p.brand, p.printerModelId)
                   || ctx.printerImageUrl(ctx.findPrinterModel(p.brand, "0"));
  const thumbUrl  = (isActive && d.printPreviewUrl) ? d.printPreviewUrl : (fallbackImg || "");
  const layerText = isActive && (d.currentLayer || d.totalLayer)
                  ? `${d.currentLayer || 0}/${d.totalLayer || 0}` : "";
  const durationText = isActive ? ctx.snapFmtDuration(d.printDuration) : "0m";
  const stateLabel = ctx.t("snapState_" + jobState) || jobState;
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
          <span class="snap-job-time">${ctx.SNAP_ICON_CLOCK} <span>${ctx.esc(durationText)}</span></span>
        </div>
        <div class="snap-job-bar"><span style="width:${pct}%"></span></div>
        <div class="snap-job-foot">
          <span class="snap-job-state snap-job-state--${ctx.esc(jobState)}">${ctx.esc(stateLabel)}</span>
          ${layerText ? `<span class="snap-job-layers">${ctx.esc(layerText)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

export function renderSnapTempCard(conn) {
  const d = conn.data;
  const tempPills = [];
  for (let i = 1; i <= 4; i++) {
    const cur = d.temps[`e${i}_temp`];
    const tgt = d.temps[`e${i}_target`];
    if (typeof cur !== "number" && typeof tgt !== "number") continue;
    const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
    tempPills.push(`
      <div class="snap-temp${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(ctx.snapFmtTempPair(cur, tgt))}</span>
      </div>`);
  }
  if (typeof d.temps.bed_temp === "number" || typeof d.temps.bed_target === "number") {
    const cur = d.temps.bed_temp, tgt = d.temps.bed_target;
    const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
    tempPills.push(`
      <div class="snap-temp snap-temp--bed${heating ? " snap-temp--heating" : ""}">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(ctx.snapFmtTempPair(cur, tgt))}</span>
      </div>`);
  }
  if (!tempPills.length) return "";
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t("snapTemperatureTitle"))}</h4>
      <div class="snap-temps">${tempPills.join("")}</div>
    </section>`;
}

export function renderSnapFilamentCard(p, conn) {
  const d = conn.data;
  const filCards = [];
  for (let i = 1; i <= 4; i++) {
    const fil  = d.filaments[i - 1] || {};
    const cur  = d.temps[`e${i}_temp`];
    const tgt  = d.temps[`e${i}_target`];
    const has  = !!(fil.color || fil.vendor || fil.type || fil.subType
                  || typeof cur === "number" || typeof tgt === "number");
    if (!has) continue;
    const color = fil.color || null;
    const fg    = color ? ctx.snapTextColor(color) : "var(--text)";
    const squareLabel = fil.type || ctx.t("snapNoFilament");
    const typeAndSub = fil.type
      ? (fil.subType ? `${fil.type} ${fil.subType}` : fil.type)
      : (fil.subType || "—");
    const editable = !fil.official;
    filCards.push(`
      <div class="snap-fil snap-fil--editable${editable ? "" : " snap-fil--locked"}"
           data-snap-fil-edit="1"
           data-extruder-idx="${i - 1}"
           title="${editable ? ctx.esc(ctx.t("snapFilEditableTip")) : ctx.esc(ctx.t("snapFilLockedTip"))}">
        <div class="snap-fil-tag">E${i}</div>
        <div class="snap-fil-square${color ? "" : " snap-fil-square--empty"}"
             style="${color ? `background:${ctx.esc(color)};color:${ctx.esc(fg)};border-color:${ctx.esc(color)};` : ""}">
          <span class="snap-fil-main">${ctx.esc(squareLabel)}</span>
        </div>
        <div class="snap-fil-meta">
          <span class="snap-fil-status icon ${fil.official ? "icon-eye-on snap-fil-status--locked" : "icon-edit"} icon-13"
                aria-hidden="true"></span>
          <div class="snap-fil-vendor">${ctx.esc(fil.vendor || "—")}</div>
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
