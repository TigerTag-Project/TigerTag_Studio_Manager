/**
 * creality/widget_camera.js — Creality camera banner widget.
 *
 * The Creality WebRTC page at http://<ip>:8000/webrtc is a bare-bones HTML
 * page with a <video> that has no CSS size constraints — it takes on the
 * intrinsic dimensions of the incoming stream (e.g. 1280×720), making it
 * impossible to embed as a responsive iframe.
 *
 * Instead we replicate the same RTCPeerConnection signaling directly in the
 * renderer and point it at a <video> element we control. This gives us full
 * CSS control: the video is constrained to the sidecard width at 16:9.
 *
 * Public API (called by inventory.js):
 *   renderCreCamBanner(p)   — returns HTML with a <video id="creCamVideo">
 *   startCreCam(ip)         — starts WebRTC, targets #creCamVideo in the DOM
 *   stopCreCam()            — closes the peer connection
 */
import { creGetConn, creKey } from './index.js';

// Active RTCPeerConnection — module-level singleton (one camera at a time).
let _pc = null;
// IP address of the current session — used to skip redundant restarts.
let _activeIp = null;

/**
 * Returns the camera banner HTML for a Creality printer,
 * or "" when the printer is offline / not yet connected.
 *
 * The <video> element has no src — startCreCam() fills it via srcObject
 * once the WebRTC track arrives.
 *
 * @param  {object} p  — printer record from state.printers
 * @returns {string}   — HTML string (safe to assign to innerHTML)
 */
export function renderCreCamBanner(p) {
  const conn = creGetConn(creKey(p));
  if (!conn || conn.status !== "connected" || !conn.ip) return "";
  return `
    <div class="pp-cam-full">
      <video id="creCamVideo" class="cre-cam-video"
             autoplay muted playsinline></video>
    </div>`;
}

/**
 * Opens an RTCPeerConnection to the Creality WebRTC server (port 8000).
 * Targets #creCamVideo in the current DOM — must be called after
 * renderCreCamBanner() has been injected into the panel body.
 *
 * Signaling: POST /call/webrtc_local with btoa(JSON offer) → btoa(JSON answer).
 * No STUN needed for LAN — host ICE candidates are sufficient and skipping
 * STUN avoids the 5–30 s ICE gathering delay from unreachable Google servers.
 *
 * @param {string} ip — printer IP address
 */
export async function startCreCam(ip) {
  // Already streaming for this IP — avoid tearing down a live stream.
  if (_pc && _activeIp === ip) return;
  stopCreCam();
  _activeIp = ip;

  const videoEl = document.getElementById("creCamVideo");
  if (!videoEl) return;

  const pc = new RTCPeerConnection({ iceServers: [] }); // LAN — no STUN
  _pc = pc;

  pc.ontrack = ev => {
    if (videoEl && ev.streams[0]) {
      videoEl.srcObject = ev.streams[0];
      videoEl.play().catch(() => {});
    }
  };

  pc.addTransceiver("video", { direction: "sendrecv" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to finish before sending the offer.
  await new Promise(resolve => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    pc.addEventListener("icegatheringstatechange", function handler() {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", handler);
        resolve();
      }
    });
    setTimeout(resolve, 4000); // safety — 4 s max
  });

  if (_pc !== pc) return; // was stopped while waiting

  try {
    const body = btoa(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
    const res  = await fetch(`http://${ip}:8000/call/webrtc_local`, {
      method:  "POST",
      headers: { "Content-Type": "plain/text" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = JSON.parse(atob(await res.text()));
    if (_pc !== pc) return; // was stopped while fetching
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.warn("[cre-cam] signaling failed:", err.message);
    stopCreCam();
  }
}

/**
 * Closes the active RTCPeerConnection and clears the video element.
 * Safe to call multiple times.
 */
export function stopCreCam() {
  _activeIp = null;
  if (_pc) {
    try { _pc.close(); } catch {}
    _pc = null;
  }
  const videoEl = document.getElementById("creCamVideo");
  if (videoEl) {
    videoEl.srcObject = null;
  }
}
