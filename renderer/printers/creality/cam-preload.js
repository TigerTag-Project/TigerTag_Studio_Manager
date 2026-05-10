/**
 * cre-cam-preload.js — Creality camera webview preload
 *
 * Runs INSIDE the camera page (http://ip:8000/) with full DOM access.
 * No cross-origin restriction — preload scripts execute in the page context.
 *
 * Responsibilities:
 *   1. Strip fixed widths / heights / overflow on every ancestor of <video>
 *      so the video fills 100% of the webview width at its natural ratio.
 *   2. Report the video's rendered height back to the parent renderer via
 *      ipcRenderer.sendToHost() so the webview element can be resized to
 *      match exactly (no black bars, no cropping).
 *
 * Mirrors _applyNoScrollToCameraWebView() from the Flutter app
 * (creality_websocket_page.dart line 2008) — same logic, proper Electron way.
 */

const { ipcRenderer } = require('electron');

// ── 1. Page-level reset ───────────────────────────────────────────────────
// No overflow constraints on html/body — the document must be free to grow
// to its content height so getBoundingClientRect() returns the true value.
function resetPageChrome() {
  const s = el => Object.assign(el.style, {
    margin: '0', padding: '0', width: '100%', background: '#000'
  });
  s(document.documentElement);
  if (document.body) s(document.body);
}

// ── 2. Ancestor walk ──────────────────────────────────────────────────────
// Walk from <video> up to <body> and clear every fixed dimension / clip.
function releaseAncestors(video) {
  let el = video.parentElement;
  while (el && el !== document.body) {
    el.style.setProperty('width',      '100%',    'important');
    el.style.setProperty('max-width',  '100%',    'important');
    el.style.setProperty('height',     'auto',    'important');
    el.style.setProperty('max-height', 'none',    'important');
    el.style.setProperty('overflow',   'visible', 'important');
    el.style.setProperty('margin',     '0',       'important');
    el.style.setProperty('padding',    '0',       'important');
    el = el.parentElement;
  }
}

// ── 3. Video fill ─────────────────────────────────────────────────────────
function applyVideoFit(video) {
  video.style.setProperty('width',      '100%',  'important');
  video.style.setProperty('height',     'auto',  'important');
  video.style.setProperty('max-width',  '100%',  'important');
  video.style.setProperty('max-height', 'none',  'important');
  video.style.setProperty('display',    'block', 'important');
}

// ── 4. Height report ──────────────────────────────────────────────────────
// Use getBoundingClientRect() — reliable now that no ancestor clips the video.
// Fallback to intrinsic ratio × viewport width if rect is still 0.
function reportHeight(video) {
  const rect = video.getBoundingClientRect();
  let h = rect.height;
  if (!(h > 4) && video.videoWidth > 0 && video.videoHeight > 0) {
    const vw = document.documentElement.clientWidth || video.videoWidth;
    h = Math.round(vw * video.videoHeight / video.videoWidth);
  }
  if (h > 4) ipcRenderer.sendToHost('cre-cam-height', Math.round(h));
}

// ── Main loop ─────────────────────────────────────────────────────────────
function runFit() {
  resetPageChrome();
  const video = document.querySelector('video');
  if (!video) return false;
  releaseAncestors(video);
  applyVideoFit(video);
  reportHeight(video);
  return true;
}

// Start immediately, then retry until the stream is live (max 10 s).
let found = runFit();
let tries = 0;
const timer = setInterval(() => {
  found = runFit();
  if (++tries >= 40) clearInterval(timer); // 40 × 250 ms = 10 s
}, 250);
