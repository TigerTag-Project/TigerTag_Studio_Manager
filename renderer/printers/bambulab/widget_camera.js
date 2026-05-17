/**
 * printers/bambulab/widget_camera.js — Bambu Lab camera banner widget.
 *
 * All models use a <img data-bbl-key="…"> element updated by IPC.
 *  • IDs 1–4  (A1, A1 Mini, P1P, P1S) → JPEG TCP port 6000 (TLS).
 *  • IDs 5+   (X1C, X1E, P2S, H2x)   → RTSP port 322 via ffmpeg.
 * Both transports emit frames on the 'bambulab:cam-frame' IPC channel.
 */
import { ctx } from '../context.js';
import { bambuGetConn, bambuKey } from './index.js';

/**
 * Returns the camera banner HTML for a Bambu Lab printer.
 * Returns "" when not yet connected (hero photo shows instead).
 *
 * Each model gets a <img data-bbl-key="…"> element (no id — supports multiple
 * Bambu printers in the cam wall simultaneously).
 * Frames arrive via IPC 'bambulab:cam-frame' regardless of transport:
 *   • JPEG TCP  — A1 / A1 Mini / P1P / P1S (model IDs 1–4, port 6000 TLS)
 *   • RTSP/ffmpeg — X1C / X1E / P2S / H2x  (model IDs 5+,  port 322 TLS)
 *
 * @param  {object} p  — printer record from state.printers
 * @returns {string}   — HTML string (safe to assign to innerHTML)
 */
export function renderBambuCamBanner(p) {
  const conn = bambuGetConn(bambuKey(p));

  // Camera only shows once MQTT is connected (guarantees the IPC camera
  // stream has been started). While connecting, the hero photo is shown.
  if (!conn || conn.status !== "connected") return "";

  const lastFrame = conn.data?.lastCamFrame;
  const imgSrc    = lastFrame ? `data:image/jpeg;base64,${lastFrame}` : "";
  const loading   = !lastFrame; // still waiting for first frame from ffmpeg/JPEG-TCP

  // data-bbl-key ties this img to its printer so the global onCamFrame
  // handler only updates the element that belongs to the active side-card.
  const key = bambuKey(p);
  return `
    <div class="pp-cam-full bbl-cam-jpeg${loading ? " pp-cam-loading" : ""}">
      <img class="bbl-camera-img"
           data-bbl-key="${ctx.esc(key)}"
           src="${ctx.esc(imgSrc)}"
           alt="Bambu Lab camera"
           draggable="false"/>
      ${loading ? `<div class="pp-cam-loading-overlay">
        <span class="pp-cam-loading-dots">
          <span></span><span></span><span></span>
        </span>
      </div>` : ""}
    </div>`;
}
