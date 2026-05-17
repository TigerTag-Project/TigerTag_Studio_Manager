// TigerTag RFID Tester — renderer-side modal logic (ES Module)
// Handles: reader slots UI, card-present state, on-demand read + result display.
// No i18n — all strings are English (internal diagnostic tool).

// ── State ─────────────────────────────────────────────────────────────────────
// Map of readerName → { connected: bool, cardPresent: bool, uid, rawUid }
const _readers = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function _$(id) { return document.getElementById(id); }

function _colId(readerName) {
  return 'rfid-col-result-' + readerName.replace(/[^a-z0-9]/gi, '_');
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Modal open / close ────────────────────────────────────────────────────────
export function openRfidTesterModal() {
  _$('rfidTestOverlay')?.classList.add('open');
  _renderSlots();
}

export function closeRfidTesterModal() {
  _$('rfidTestOverlay')?.classList.remove('open');
}

// ── Slots render ──────────────────────────────────────────────────────────────
function _renderSlots() {
  const container = _$('rfidColumns');
  if (!container) return;

  if (_readers.size === 0) {
    container.innerHTML = `<div class="rfid-no-reader">No ACR122U reader detected</div>`;
    return;
  }

  container.innerHTML = [..._readers.entries()].map(([name, r]) => {
    const shortName = name.replace(/^ACS\s*/i, '').trim() || name;
    const cardLabel = r.cardPresent ? 'Card present' : 'No card';
    const colId     = _colId(name);
    return `
      <div class="rfid-col${r.connected ? '' : ' rfid-col--off'}">
        <div class="rfid-col-header">
          <span class="rfid-slot-dot${r.connected ? ' rfid-slot-dot--on' : ''}"></span>
          <span class="rfid-slot-name">${_esc(shortName)}</span>
          <span class="rfid-col-card-lbl${r.cardPresent ? ' rfid-col-card-lbl--present' : ''}">${cardLabel}</span>
          <button class="rfid-slot-read-btn"
                  data-rfid-read="${_esc(name)}"
                  ${r.cardPresent ? '' : 'disabled'}>Read</button>
        </div>
        <div class="rfid-col-result" id="${colId}">
          <div class="rfid-col-idle">
            <span class="rfid-test-icon"></span>
            <p class="rfid-test-hint">Place a chip then click Read</p>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Result render ─────────────────────────────────────────────────────────────
function _renderResult(data, readerName) {
  const el = _$(_colId(readerName));
  if (!el) return;

  const { uid, rawUid, rawPagesHex, tigerTag, error } = data;

  if (error) {
    el.innerHTML = `<div class="rfid-result-error">${_esc(error)}</div>`;
    return;
  }

  const rawBlock = rawPagesHex
    ? `<details class="rfid-raw-block">
         <summary>Raw (${rawPagesHex.length / 2} B)</summary>
         <pre class="rfid-raw-hex">${_esc(rawPagesHex.match(/.{1,32}/g).join('\n'))}</pre>
       </details>`
    : '';

  if (!tigerTag) {
    el.innerHTML = `
      <div class="rfid-result-uid">
        <span class="rfid-result-label">UID</span>
        <code class="rfid-result-code">${_esc(rawUid?.toUpperCase())}</code>
      </div>
      <div class="rfid-unknown-badge">Unknown format</div>
      ${rawBlock}`;
    return;
  }

  const { brand, material, colorHex, colorAlpha, diameter, weight, unit,
          nozzleMin, nozzleMax, dryTemp, dryTime, bedMin, bedMax,
          date, tdMm, version, productId, aspect1, aspect2 } = tigerTag;
  const aspects = [aspect1, aspect2].filter(Boolean).join(', ');
  const field   = (label, val) =>
    `<div class="rfid-field">
       <span class="rfid-field-label">${_esc(label)}</span>
       <span class="rfid-field-val">${_esc(val)}</span>
     </div>`;

  el.innerHTML = `
    <div class="rfid-result-uid">
      <code class="rfid-result-code">${_esc(rawUid?.toUpperCase())}</code>
      <span class="rfid-version-badge">${_esc(version)}</span>
    </div>
    <div class="rfid-fields-grid">
      <div class="rfid-color-swatch-row">
        <span class="rfid-color-swatch"
              style="background:${_esc(colorHex)};opacity:${(colorAlpha / 255).toFixed(2)}"></span>
        <code class="rfid-field-val">${_esc(colorHex)}</code>
      </div>
      ${field('Brand',      brand)}
      ${field('Material',   material)}
      ${aspects ? field('Aspect', aspects) : ''}
      ${field('Diameter',   `${diameter} mm`)}
      ${field('Weight',     `${weight} ${unit}`)}
      ${field('Nozzle',     `${nozzleMin}–${nozzleMax} °C`)}
      ${field('Bed',        `${bedMin}–${bedMax} °C`)}
      ${field('Drying',     `${dryTemp} °C / ${dryTime} h`)}
      ${tdMm > 0 ? field('TD', `${tdMm.toFixed(1)} mm`) : ''}
      ${field('Mfg. date',  date)}
      ${field('Product ID', productId)}
    </div>
    ${rawBlock}`;
}

// ── IPC event wiring ──────────────────────────────────────────────────────────
/**
 * Call once at app startup (after electronAPI is available).
 * Wires up reader-connect/disconnect and card-present IPC events.
 */
export function initRfidTester() {
  // Modal open / close buttons
  _$('btnRfidTest')?.addEventListener('click', openRfidTesterModal);
  _$('rfidTestClose')?.addEventListener('click', closeRfidTesterModal);
  _$('rfidTestOverlay')?.addEventListener('click', e => {
    if (e.target === _$('rfidTestOverlay')) closeRfidTesterModal();
  });

  // Read button — event-delegated on the columns container
  _$('rfidColumns')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-rfid-read]');
    if (!btn || btn.disabled) return;
    const readerName = btn.dataset.rfidRead;
    btn.disabled    = true;
    btn.textContent = '…';
    const result    = await window.electronAPI.readRfidNow(readerName);
    btn.disabled    = false;
    btn.textContent = 'Read';
    _renderResult(result, readerName);
  });

  // Reader connected / disconnected
  window.electronAPI?.onRfidReaderUpdate(({ name, connected }) => {
    if (connected) {
      _readers.set(name, { connected: true, cardPresent: false, uid: null, rawUid: null });
    } else {
      _readers.delete(name);
    }
    _renderSlots();
  });

  // Card placed / removed
  window.electronAPI?.onRfidCardPresent(({ readerName, uid, rawUid }) => {
    const r = _readers.get(readerName);
    if (r) {
      r.cardPresent = !!uid;
      r.uid    = uid;
      r.rawUid = rawUid;
      _renderSlots();
    }
  });
}
