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
  const stateLabel  = ctx.t("snapState_" + jobState) || jobState;
  const isPaused    = jobState === "paused";
  const isPrinting  = jobState === "printing";
  const nameLine = leafName
    ? `<div class="snap-job-name" title="${ctx.esc(leafName)}">${ctx.esc(leafName)}</div>`
    : `<div class="snap-job-name snap-job-name--idle">${ctx.esc(ctx.t("snapJobNoActive") || "—")}</div>`;
  const actionBtns = isActive ? `
        <div class="cre-actions elg-job-actions">
          <button type="button" class="cre-action-btn cre-action-btn--pause"
                  data-snap-print-pause="1"
                  title="${isPaused ? ctx.esc(ctx.t("snapPrintResume") || "Resume") : ctx.esc(ctx.t("snapPrintPause") || "Pause")}">
            <span class="icon ${isPaused ? "icon-play" : "icon-pause"} icon-14"></span>
            <span class="hold-progress"></span>
          </button>
          <button type="button" class="cre-action-btn cre-action-btn--stop"
                  data-snap-print-cancel="1"
                  title="${ctx.esc(ctx.t("snapPrintCancel") || "Cancel")}">
            <span class="icon icon-stop icon-14"></span>
            <span class="hold-progress"></span>
          </button>
        </div>` : "";
  return `
    <div class="snap-job snap-job--${ctx.esc(jobState)}">
      <div class="snap-job-thumb"${thumbUrl ? ` style="background-image:url('${ctx.esc(thumbUrl)}')"` : ""}></div>
      <div class="snap-job-info">
        <div class="elg-job-name-row${actionBtns ? " elg-job-name-row--with-btns" : ""}">
          ${nameLine}
          ${actionBtns}
        </div>
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

  // Klipper heater names: extruder, extruder1, extruder2, extruder3
  const NOZZLE_HEATERS = ["extruder", "extruder1", "extruder2", "extruder3"];
  for (let i = 1; i <= 4; i++) {
    const cur = d.temps[`e${i}_temp`];
    const tgt = d.temps[`e${i}_target`];
    if (typeof cur !== "number" && typeof tgt !== "number") continue;
    const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
    const heater  = NOZZLE_HEATERS[i - 1];
    const tgtVal  = typeof tgt === "number" ? Math.round(tgt) : 0;
    const isActiveExtruder = heater === d.activeExtruder;
    tempPills.push(`
      <div class="snap-temp snap-temp--editable${heating ? " snap-temp--heating" : ""}${isActiveExtruder ? " snap-temp--active" : ""}"
           data-snap-set-temp="${ctx.esc(heater)}"
           data-snap-temp-target="${tgtVal}"
           data-snap-temp-max="320"
           title="${ctx.esc(ctx.t("snapTempEditTip") || "Click to set target temperature")}">
        <span class="snap-temp-label">E${i}</span>
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(ctx.snapFmtTempPair(cur, tgt))}</span>
      </div>`);
  }

  if (typeof d.temps.bed_temp === "number" || typeof d.temps.bed_target === "number") {
    const cur = d.temps.bed_temp, tgt = d.temps.bed_target;
    const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
    const tgtVal  = typeof tgt === "number" ? Math.round(tgt) : 0;
    tempPills.push(`
      <div class="snap-temp snap-temp--bed snap-temp--editable${heating ? " snap-temp--heating" : ""}"
           data-snap-set-temp="heater_bed"
           data-snap-temp-target="${tgtVal}"
           data-snap-temp-max="130"
           title="${ctx.esc(ctx.t("snapTempEditTip") || "Click to set target temperature")}">
        <span class="snap-temp-label">BED</span>
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
  const d        = conn.data;
  const selMode  = conn._filSelectMode || null;   // "load" | "unload" | null
  const selSet   = conn._filSelected  || new Set();

  // ── Collect extruders that exist (have temp or filament data) ──────────────
  const slots = [];
  for (let i = 1; i <= 4; i++) {
    const fil = d.filaments[i - 1] || {};
    const cur = d.temps[`e${i}_temp`];
    const tgt = d.temps[`e${i}_target`];
    const has = !!(fil.color || fil.vendor || fil.type || fil.subType
                 || typeof cur === "number" || typeof tgt === "number");
    if (!has) continue;
    slots.push({ i, fil, cur, tgt });
  }
  if (!slots.length) return "";

  // ── Normal render (no selection mode) ─────────────────────────────────────
  if (!selMode) {
    // Klipper names: extruder, extruder1, extruder2, extruder3 (index 0-3)
    const KLIPPER_NAMES = ["extruder", "extruder1", "extruder2", "extruder3"];
    const filCards = slots.map(({ i, fil }) => {
      const color       = fil.color || null;
      const fg          = color ? ctx.snapTextColor(color) : "var(--text)";
      const squareLabel = fil.type || ctx.t("snapNoFilament");
      const typeAndSub  = fil.type
        ? (fil.subType ? `${fil.type} ${fil.subType}` : fil.type)
        : (fil.subType || "—");
      const editable    = !fil.official;
      const isActive    = KLIPPER_NAMES[i - 1] === d.activeExtruder;
      return `
        <div class="snap-fil snap-fil--editable${editable ? "" : " snap-fil--locked"}${isActive ? " snap-fil--active" : ""}"
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
        </div>`;
    });
    return `
      <section class="snap-block">
        <div class="snap-block-hdr">
          <h4 class="snap-block-title">${ctx.esc(ctx.t("snapFilamentTitle"))}</h4>
          <div class="snap-fil-actions">
            <button type="button" class="snap-fil-act-btn" data-snap-fil-mode="load"
                    title="${ctx.esc(ctx.t("snapFilLoadTip") || "Load filament")}">
              ${ctx.esc(ctx.t("snapFilLoad") || "Load")}
            </button>
            <button type="button" class="snap-fil-act-btn" data-snap-fil-mode="unload"
                    title="${ctx.esc(ctx.t("snapFilUnloadTip") || "Unload filament")}">
              ${ctx.esc(ctx.t("snapFilUnload") || "Unload")}
            </button>
          </div>
        </div>
        <div class="snap-fil-grid">${filCards.join("")}</div>
      </section>`;
  }

  // ── Selection mode ─────────────────────────────────────────────────────────
  // ALL slots are always shown. Valid slots can be selected; invalid ones are
  // greyed out with a reason label ("No Filament" / "Loaded") — same UX as the
  // Snapmaker native app.
  //
  // Valid means:
  //   Unload: filamentLoaded[i] === true  (has physical filament to pull back)
  //   Load:   filamentLoaded[i] === false (extruder is empty, ready to receive)
  //   null (sensor data not yet received) → allow selection (user decides)
  // Fallback when no sensor data at all: use metadata presence (color/type).
  const loadedArr    = conn.data.filamentLoaded || [null, null, null, null];
  const hasSensorData = loadedArr.some(v => v !== null);

  const _isValid = ({ i, fil }) => {
    const loaded = loadedArr[i - 1];
    if (hasSensorData && loaded !== null) {
      return selMode === "unload" ? loaded === true : loaded === false;
    }
    const hasFil = !!(fil.color || fil.type || fil.vendor);
    return selMode === "unload" ? hasFil : !hasFil;
  };

  const modeLabel   = selMode === "load"
    ? (ctx.t("snapFilLoadTitle")   || "Select extruders to load")
    : (ctx.t("snapFilUnloadTitle") || "Select extruders to unload");
  const confirmLabel = ctx.t("snapFilConfirm") || "Confirm";
  const cancelLabel  = ctx.t("cancelLabel")    || "Cancel";

  const selCards = slots.map(slot => {
    const { i, fil } = slot;
    const color       = fil.color || null;
    const fg          = color ? ctx.snapTextColor(color) : "var(--text)";
    const squareLabel = fil.type || ctx.t("snapNoFilament");
    const typeAndSub  = fil.type
      ? (fil.subType ? `${fil.type} ${fil.subType}` : fil.type)
      : (fil.subType || "—");
    const valid       = _isValid(slot);
    const isChecked   = valid && selSet.has(i - 1);

    // Reason label shown at the bottom for invalid slots
    let reasonLabel = "";
    if (!valid) {
      if (selMode === "unload") {
        reasonLabel = `<span class="snap-fil-sel-reason">${ctx.esc(ctx.t("snapFilNotLoaded") || "No Filament")}</span>`;
      } else {
        reasonLabel = `<span class="snap-fil-sel-reason snap-fil-sel-reason--loaded">${ctx.esc(ctx.t("snapFilLoaded") || "Loaded")}</span>`;
      }
    }

    return `
      <div class="snap-fil${valid ? " snap-fil--selectable" : " snap-fil--disabled"}${isChecked ? " snap-fil--checked" : ""}"
           ${valid ? `data-snap-fil-toggle="${i - 1}"` : ""}
           aria-disabled="${valid ? "false" : "true"}">
        <div class="snap-fil-tag">E${i}</div>
        <div class="snap-fil-square${color ? "" : " snap-fil-square--empty"}"
             style="${color ? `background:${ctx.esc(color)};color:${ctx.esc(fg)};border-color:${ctx.esc(color)};` : ""}">
          <span class="snap-fil-main">${ctx.esc(squareLabel)}</span>
        </div>
        <div class="snap-fil-meta">
          <div class="snap-fil-vendor">${ctx.esc(fil.vendor || "—")}</div>
          <div class="snap-fil-sub">${ctx.esc(typeAndSub)}</div>
          ${reasonLabel}
        </div>
        <div class="snap-fil-sel-check${isChecked ? " snap-fil-sel-check--on" : ""}">
          <span class="icon ${isChecked ? "icon-check" : ""} icon-13"></span>
        </div>
      </div>`;
  });

  const anyValid = slots.some(_isValid);

  return `
    <section class="snap-block snap-block--selecting">
      <div class="snap-block-hdr">
        <h4 class="snap-block-title">${ctx.esc(modeLabel)}</h4>
        <button type="button" class="snap-fil-act-btn snap-fil-act-btn--cancel"
                data-snap-fil-cancel="1">${ctx.esc(cancelLabel)}</button>
      </div>
      <div class="snap-fil-grid">${selCards.join("")}</div>
      <div class="snap-fil-sel-footer">
        <button type="button" class="snap-fil-confirm-btn"
                data-snap-fil-confirm="${selMode}"
                ${selSet.size === 0 ? "disabled" : ""}>
          ${ctx.esc(confirmLabel)}
          ${selSet.size > 0 ? `<span class="snap-fil-sel-count">${selSet.size}</span>` : ""}
        </button>
      </div>
    </section>`;
}
