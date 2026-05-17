/**
 * flashforge/widget_camera.js — FlashForge MJPEG camera banner widget.
 *
 * Handles initial render + error/retry refresh cycle.
 * Moved out of index.js so inventory.js no longer builds camera HTML inline.
 *
 * Stream: raw MJPEG <img> from the URL reported by /detail.
 * The FlashForge mjpg-streamer allows only 1 concurrent client — when
 * a second viewer connects the stream 404s. We handle this with a fallback
 * overlay + Retry button wired via inventory.js event delegation.
 *
 * Public API:
 *   renderFfgCamBanner(p)  — full banner HTML (outer wrapper + inner content)
 *   ffgRefreshCamBanner()  — swaps inner of #ffgCamHost in place (error/retry)
 */
import { ctx } from '../context.js';
import { ffgGetConn, ffgKey } from './index.js';

const $ = id => document.getElementById(id);

// ── Private helpers ───────────────────────────────────────────────────────

/** Resolve the printer model hero image URL (first match, then generic "0"). */
function _heroUrl(p) {
  return ctx.printerImageUrlFor(p.brand, p.printerModelId)
      || ctx.printerImageUrl(ctx.findPrinterModel(p.brand, "0"));
}

/** Resolve the human-readable model name for the alt text / fallback. */
function _modelName(p) {
  const m = ctx.findPrinterModel(p.brand, p.printerModelId);
  return m ? m.name : (p.printerModelId || "");
}

/**
 * Returns the raw MJPEG URL from the printer's /detail response.
 * The mux controls the connection lifecycle so no cache-busting is needed.
 * Returns null if the camera URL is missing.
 */
function _camUrl(conn) {
  return conn?.data?.camera?.url || null;
}

/**
 * Returns the MJPEG URL for a printer (for use by the mux / inventory.js).
 * Returns null when unavailable.
 */
export function ffgCamBaseUrl(p) {
  return _camUrl(ffgGetConn(ffgKey(p)));
}

/**
 * Inner content for the sidecard — two branches:
 *   • healthy  → <img> whose src is driven by the MJPEG mux (no src attr here)
 *   • fallback → static hero photo + error overlay + Retry button
 *
 * The host wrapper (#ffgCamHost) is built by the caller; this helper
 * only produces what goes INSIDE so ffgRefreshCamBanner() can swap it
 * in place without rebuilding the whole panel body.
 */
function _renderInner(p) {
  const conn = ffgGetConn(ffgKey(p));
  if (conn?.camFailed) {
    const heroImgUrl = _heroUrl(p);
    const modelName  = _modelName(p);
    const photo = heroImgUrl
      ? `<img class="ffg-cam-fallback-img" src="${ctx.esc(heroImgUrl)}"
              alt="${ctx.esc(modelName)}"
              onerror="this.style.opacity='.15'"/>`
      : `<div class="ffg-cam-fallback-img ffg-cam-fallback-img--placeholder"></div>`;
    return `
      <div class="ffg-cam-fallback">
        ${photo}
        <div class="ffg-cam-fallback-overlay">
          <div class="ffg-cam-fallback-icon icon icon-warn icon-18" aria-hidden="true"></div>
          <div class="ffg-cam-fallback-msg">${ctx.esc(ctx.t("ffgCamFailMsg"))}</div>
          <button type="button" class="ffg-cam-fallback-retry" data-ffg-cam-retry="1">
            <span class="icon icon-refresh icon-13" aria-hidden="true"></span>
            <span>${ctx.esc(ctx.t("ffgCamRetry"))}</span>
          </button>
        </div>
      </div>`;
  }
  // src is left empty — the MJPEG mux sets it via blob: URL for each frame.
  return `
    <img id="ffgCamSideImg" class="ffg-camera-img"
         alt="${ctx.esc(ctx.t("ffgCameraAlt"))}"
         onload="var h=this.closest('.pp-cam-loading');if(h){h.classList.remove('pp-cam-loading');h.querySelector('.pp-cam-loading-overlay')?.remove();}"/>
    <div class="pp-cam-loading-overlay">
      <span class="pp-cam-loading-dots">
        <span></span><span></span><span></span>
      </span>
    </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Returns the full camera banner HTML (outer wrapper + inner content)
 * for a FlashForge printer, or "" when not applicable:
 *   - printer not connected
 *   - camera disabled server-side
 *   - no camera URL in /detail response
 *
 * @param  {object} p  — printer record from state.printers
 * @returns {string}   — HTML string (safe to assign to innerHTML)
 */
export function renderFfgCamBanner(p) {
  const conn    = ffgGetConn(ffgKey(p));
  if (!conn) return "";
  const enabled = !!(conn?.data?.camera?.enabled);
  const url     = _camUrl(conn);
  if (!url || !enabled || conn?.status !== "connected") return "";
  // pp-cam-loading removed by img onload; not added for error/fallback branch.
  const loadingCls = conn.camFailed ? "" : " pp-cam-loading";
  return `
    <div id="ffgCamHost" class="pp-cam-full ffg-cam-host${loadingCls}">
      ${_renderInner(p)}
    </div>`;
}

/**
 * Returns the camera HTML for a cam-wall card — img has data-ffg-cam-key so
 * inventory.js can register it with the mux after host.innerHTML.
 * Returns "" when the printer is offline or camera is disabled.
 */
export function renderFfgCamWallBanner(p) {
  const conn    = ffgGetConn(ffgKey(p));
  if (!conn) return "";
  const enabled = !!(conn?.data?.camera?.enabled);
  const url     = _camUrl(conn);
  if (!url || !enabled || conn?.status !== "connected") return "";
  return `
    <div class="pp-cam-full ffg-cam-host">
      <img class="ffg-camera-img" data-ffg-cam-key="${ctx.esc(ffgKey(p))}"
           alt="${ctx.esc(ctx.t("ffgCameraAlt"))}"/>
    </div>`;
}

/**
 * Swaps the inner of #ffgCamHost in place after an error or retry.
 * Called by inventory.js event delegation — avoids a full panel rebuild
 * which would reset the log accordion, filament edits, etc.
 */
export function ffgRefreshCamBanner() {
  const activePrinter = ctx.getActivePrinter();
  if (!activePrinter || activePrinter.brand !== "flashforge") return;
  const host = $("ffgCamHost");
  if (!host) return;
  const conn    = ffgGetConn(ffgKey(activePrinter));
  const enabled = !!(conn?.data?.camera?.enabled);
  const url     = _camUrl(conn);
  if (!url || !enabled || conn?.status !== "connected") {
    host.style.display = "none";
    return;
  }
  host.style.display = "";
  if (!conn.camFailed) host.classList.add("pp-cam-loading");
  else                 host.classList.remove("pp-cam-loading");
  host.innerHTML = _renderInner(activePrinter);
}
