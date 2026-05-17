/**
 * flashforge/cam_mux.js — MJPEG multiplexer for FlashForge cameras.
 *
 * FlashForge mjpg-streamer allows only ONE concurrent HTTP client.
 * This module opens that single fetch() connection, parses the multipart
 * MJPEG stream into individual JPEG frames, and distributes each frame as a
 * blob: URL to every registered <img> element (cam wall + sidecard at once).
 *
 * Public API:
 *   ffgMuxStart(key, url)       — start or restart stream for this printer
 *   ffgMuxStop(key)             — stop one printer's stream
 *   ffgMuxStopAll()             — stop all streams (leave cam view / disconnect)
 *   ffgMuxRegister(key, imgEl)  — add a consumer; immediately shows latest frame
 *   ffgMuxUnregister(key, imgEl)— remove consumer; auto-stops when none remain
 */

// Per-printer state keyed by printer key (brand:id)
const _streams = new Map();
// { abort: AbortController, url: string, consumers: Set<img>,
//   lastFrame: string|null, running: bool }

// ── Public API ────────────────────────────────────────────────────────────

export function ffgMuxStart(key, url) {
  const s = _streams.get(key);
  if (s && s.running && s.url === url) return; // already streaming same URL
  _stopStream(_streams.get(key));
  const stream = {
    abort:     new AbortController(),
    url,
    consumers: new Set(),
    lastFrame: null,
    running:   true,
  };
  _streams.set(key, stream);
  _pump(stream).catch(() => {});
}

export function ffgMuxStop(key) {
  const s = _streams.get(key);
  if (!s) return;
  _stopStream(s);
  _streams.delete(key);
}

export function ffgMuxStopAll() {
  for (const s of _streams.values()) _stopStream(s);
  _streams.clear();
}

/**
 * Restart the fetch for an existing stream without clearing consumers.
 * Used by the Retry button — the sidecard img and any cam-wall img both
 * continue receiving frames once the new connection establishes.
 */
export function ffgMuxRestart(key, url) {
  const s = _streams.get(key);
  if (!s) { ffgMuxStart(key, url); return; }
  s.abort.abort();
  s.running = false;
  if (s.lastFrame) { URL.revokeObjectURL(s.lastFrame); s.lastFrame = null; }
  // Reuse the existing consumer set — only the fetch is restarted.
  s.abort   = new AbortController();
  s.url     = url;
  s.running = true;
  _pump(s).catch(() => {});
}

export function ffgMuxRegister(key, imgEl) {
  const s = _streams.get(key);
  if (!s) return;
  s.consumers.add(imgEl);
  if (s.lastFrame) imgEl.src = s.lastFrame; // catch up with latest frame
}

export function ffgMuxUnregister(key, imgEl) {
  const s = _streams.get(key);
  if (!s) return;
  s.consumers.delete(imgEl);
  try { imgEl.src = "about:blank"; imgEl.removeAttribute("src"); } catch {}
  if (s.consumers.size === 0) ffgMuxStop(key); // auto-stop when nobody's watching
}

// ── Internal ──────────────────────────────────────────────────────────────

function _stopStream(s) {
  if (!s) return;
  s.running = false;
  s.abort.abort();
  if (s.lastFrame) { URL.revokeObjectURL(s.lastFrame); s.lastFrame = null; }
  s.consumers.forEach(el => {
    try { el.src = "about:blank"; el.removeAttribute("src"); } catch {}
  });
}

async function _pump(stream) {
  try {
    const res = await fetch(stream.url, {
      signal:  stream.abort.signal,
      cache:   "no-store",
    });
    if (!res.ok || !res.body) { stream.running = false; return; }

    // Extract boundary from: multipart/x-mixed-replace;boundary=XXXX
    const ct = res.headers.get("content-type") || "";
    const bm = ct.match(/boundary=([^\s;,]+)/i);
    const rawB = bm ? bm[1].replace(/^-+/, "") : "boundary";
    const sep  = _enc("--" + rawB);

    const reader = res.body.getReader();
    let buf = new Uint8Array(0);

    while (stream.running) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = _concat(buf, value);

      // Extract all complete frames (sep … headers … \r\n\r\n … body … sep)
      let consumed = 0;
      while (true) {
        const b1 = _indexOf(buf, sep, consumed);
        if (b1 === -1) break;
        const b2 = _indexOf(buf, sep, b1 + sep.length + 1);
        if (b2 === -1) break; // frame not yet complete — wait for more data

        const hdrEnd = _indexOf(buf, _enc("\r\n\r\n"), b1 + sep.length);
        if (hdrEnd !== -1 && hdrEnd < b2) {
          let bodyEnd = b2;
          // Trim the \r\n that precedes the next boundary marker
          if (bodyEnd >= 2 && buf[bodyEnd - 2] === 13 && buf[bodyEnd - 1] === 10) bodyEnd -= 2;
          const frame = buf.slice(hdrEnd + 4, bodyEnd);
          if (frame.length > 100) _pushFrame(stream, frame);
        }
        consumed = b2;
      }

      if (consumed > 0) buf = buf.slice(consumed);
      if (buf.length > 2_000_000) buf = new Uint8Array(0); // safety flush
    }
  } catch (e) {
    if (e?.name !== "AbortError") console.warn("[ffg-mux]", e.message);
  } finally {
    stream.running = false;
  }
}

function _pushFrame(stream, frame) {
  const blobUrl = URL.createObjectURL(new Blob([frame], { type: "image/jpeg" }));
  stream.consumers.forEach(el => { try { el.src = blobUrl; } catch {} });
  if (stream.lastFrame) URL.revokeObjectURL(stream.lastFrame);
  stream.lastFrame = blobUrl;
}

// ── Byte utilities ────────────────────────────────────────────────────────

const _te = new TextEncoder();
const _enc = s => _te.encode(s);

function _concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function _indexOf(arr, pat, from = 0) {
  outer: for (let i = from; i <= arr.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) {
      if (arr[i + j] !== pat[j]) continue outer;
    }
    return i;
  }
  return -1;
}
