/**
 * printers/elegoo/cards.js — Elegoo live-block card widgets.
 *
 * Uses .snap-* CSS classes (defined in 50-snapmaker.css) for consistent
 * styling across all printer brands. Elegoo-specific overrides go in
 * 57-elegoo.css.
 *
 * All functions read from ctx at call time — never destructure ctx at
 * module scope so inventory.js can populate it after import resolution.
 */
import { ctx } from '../context.js';

// ── Local helpers ─────────────────────────────────────────────────────────

function elgFmtTemp(v) {
  return (typeof v === 'number' && isFinite(v)) ? `${Math.round(v)}°C` : '—';
}

function elgFmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

const ELEGOO_ACTIVE = new Set(['printing', 'running', 'busy', 'preparing', 'heating']);
const ELEGOO_PAUSED = new Set(['paused']);

function elgIsActiveState(s) {
  return ELEGOO_ACTIVE.has(String(s || '').toLowerCase().trim());
}

function elgIsPaused(s) {
  return ELEGOO_PAUSED.has(String(s || '').toLowerCase().trim());
}

const STATE_LABELS = {
  printing:  'snapState_printing',  running:   'snapState_printing',
  paused:    'snapState_paused',
  complete:  'snapState_complete',  completed: 'snapState_complete',
  cancelled: 'snapState_cancelled', canceled:  'snapState_cancelled',
  error:     'snapState_error',     failed:    'snapState_error',
  standby:   'snapState_standby',
  busy:      'elgState_busy',
  preparing: 'elgState_preparing',
  heating:   'elgState_heating',
};

function elgStateLabel(s) {
  const norm = String(s || '').toLowerCase().trim();
  const key = STATE_LABELS[norm];
  if (!key) return norm || '—';
  const lbl = ctx.t(key);
  return lbl && lbl !== key ? lbl : (norm || '—');
}

// ── Card renderers ────────────────────────────────────────────────────────

export function renderElegooJobCard(p, conn) {
  const d = conn.data;
  if (conn.status !== 'connected') return '';
  const jobState = d.printState || 'standby';
  const isActive = elgIsActiveState(jobState) || elgIsPaused(jobState);
  const pct      = Math.round((d.printProgress || 0) * 100);
  const leafName = isActive && d.printFilename
    ? String(d.printFilename).split('/').pop()
    : '';
  const fallbackImg = ctx.printerImageUrlFor(p.brand, p.printerModelId)
                   || ctx.printerImageUrl(ctx.findPrinterModel(p.brand, '0'));
  const thumbUrl = (isActive && d.thumbnail) ? d.thumbnail : (fallbackImg || '');
  const layerText = isActive && (d.printLayerCur || d.printLayerTotal)
    ? `${d.printLayerCur || 0}/${d.printLayerTotal || '?'}`
    : '';
  const timeText = isActive
    ? (d.printRemainingMs ? elgFmtDuration(d.printRemainingMs) : '—')
    : '0m';
  const stateLabel = elgStateLabel(jobState);
  const nameLine = leafName
    ? `<div class="snap-job-name" title="${ctx.esc(leafName)}">${ctx.esc(leafName)}</div>`
    : `<div class="snap-job-name snap-job-name--idle">${ctx.esc(ctx.t('snapJobNoActive') || '—')}</div>`;
  return `
    <div class="snap-job snap-job--${ctx.esc(jobState)}">
      <div class="snap-job-thumb"${thumbUrl ? ` style="background-image:url('${ctx.esc(thumbUrl)}')"` : ''}></div>
      <div class="snap-job-info">
        ${nameLine}
        <div class="snap-job-stats">
          <span class="snap-job-pct">${pct}%</span>
          <span class="snap-job-time">${ctx.SNAP_ICON_CLOCK} <span>${ctx.esc(timeText)}</span></span>
        </div>
        <div class="snap-job-bar"><span style="width:${pct}%"></span></div>
        <div class="snap-job-foot">
          <span class="snap-job-state snap-job-state--${ctx.esc(jobState)}">${ctx.esc(stateLabel)}</span>
          ${layerText ? `<span class="snap-job-layers">${ctx.esc(layerText)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

export function renderElegooTempCard(conn) {
  const d = conn.data;
  const pills = [];
  if (typeof d.nozzleTemp === 'number') {
    pills.push(`
      <div class="snap-temp">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(elgFmtTemp(d.nozzleTemp))}</span>
      </div>`);
  }
  if (typeof d.bedTemp === 'number') {
    pills.push(`
      <div class="snap-temp snap-temp--bed">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(elgFmtTemp(d.bedTemp))}</span>
      </div>`);
  }
  if (typeof d.chamberTemp === 'number') {
    pills.push(`
      <div class="snap-temp snap-temp--chamber">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(elgFmtTemp(d.chamberTemp))}</span>
      </div>`);
  }
  if (!pills.length) return '';
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t('snapTemperatureTitle'))}</h4>
      <div class="snap-temps">${pills.join('')}</div>
    </section>`;
}

export function renderElegooFilamentCard(p, conn) {
  const d = conn.data;
  const fils = Array.isArray(d.filaments) ? d.filaments : [];
  if (!fils.length) return '';

  // ── Mono-extruder mode ────────────────────────────────────────────────────
  // Canvas hub absent → single "Ext." square (same pattern as Creality / FFG).
  // Detect via explicit flag OR single-entry filament list (robust fallback).
  const isMono = d._canvasConnected === false || fils.length === 1;
  if (isMono) {
    const fil        = fils[0] || {};
    const color      = fil.color || null;
    const fg         = color ? ctx.snapTextColor(color) : 'var(--text)';
    const typeLbl    = fil.type || '—';
    const squareCls  = 'snap-fil-square' + (color ? ' snap-fil-square--filled' : ' snap-fil-square--empty');
    const squareStyle = color ? `background:${ctx.esc(color)};color:${ctx.esc(fg)};` : '';
    return `
      <section class="snap-block">
        <h4 class="snap-block-title">${ctx.esc(ctx.t('snapFilamentTitle'))}</h4>
        <div class="snap-fil-grid">
          <div class="snap-fil${color ? ' snap-fil--active' : ''}">
            <div class="snap-fil-tag">Ext.</div>
            <div class="${squareCls}" style="${squareStyle}">
              <span class="snap-fil-main">${ctx.esc(typeLbl)}</span>
            </div>
            <div class="snap-fil-meta">
              ${fil.vendor ? `<div class="snap-fil-vendor">${ctx.esc(fil.vendor)}</div>` : ''}
              <div class="snap-fil-sub">${ctx.esc(typeLbl)}</div>
            </div>
          </div>
        </div>
      </section>`;
  }

  // ── Canvas mode — 4-slot grid ─────────────────────────────────────────────
  const filCards = [];
  for (let i = 0; i < 4; i++) {
    const fil   = fils[i] || {};
    const color = fil.color || null;
    const type  = fil.type  || null;
    const isActive = !!fil.active;
    const fg = color ? ctx.snapTextColor(color) : 'var(--text)';
    const slotTag = `S${i + 1}`;
    const squareLabel = type || ctx.t('snapNoFilament');
    let squareCls = 'snap-fil-square';
    let squareStyle = '';
    if (color) {
      squareCls += ' snap-fil-square--filled';
      squareStyle = `background:${ctx.esc(color)};color:${ctx.esc(fg)};`;
    } else {
      squareCls += ' snap-fil-square--empty';
    }
    filCards.push(`
      <div class="snap-fil snap-fil--editable${isActive ? ' snap-fil--active' : ''}"
           data-elg-fil-edit="1"
           data-tray-idx="${i}"
           title="${ctx.esc(ctx.t('snapFilEditableTip') || 'Edit filament')}">
        <div class="snap-fil-tag">${ctx.esc(slotTag)}</div>
        <div class="${squareCls}" style="${squareStyle}">
          <span class="snap-fil-main">${ctx.esc(squareLabel)}</span>
        </div>
        <div class="snap-fil-meta">
          <span class="snap-fil-status icon icon-edit icon-13" aria-hidden="true"></span>
          ${fil.vendor ? `<div class="snap-fil-vendor">${ctx.esc(fil.vendor)}</div>` : ''}
          <div class="snap-fil-sub">${ctx.esc(type || '—')}</div>
        </div>
      </div>`);
  }
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t('snapFilamentTitle'))}</h4>
      <div class="snap-fil-grid">${filCards.join('')}</div>
    </section>`;
}
