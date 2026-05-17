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
  // Force 0 % during prep/heating or bed leveling — printProgress can still hold stale data.
  const pct = (jobState === 'heating' || jobState === 'preparing' || (d.bedMeshDetect && !(d.printLayerCur > 0)))
    ? 0
    : Math.round((d.printProgress || 0) * 100);
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
  const actionBtns = (elgIsActiveState(jobState) || elgIsPaused(jobState)) ? `
        <div class="cre-actions elg-job-actions">
          <button type="button" class="cre-action-btn cre-action-btn--pause"
                  data-elg-print-action="${elgIsPaused(jobState) ? 'resume' : 'pause'}"
                  title="${ctx.esc(ctx.t(elgIsPaused(jobState) ? 'elgResumeTitle' : 'elgPauseTitle'))}">
            <span class="icon ${elgIsPaused(jobState) ? 'icon-play' : 'icon-pause'} icon-14"></span>
            <span class="hold-progress"></span>
          </button>
          <button type="button" class="cre-action-btn cre-action-btn--stop"
                  data-elg-print-action="cancel"
                  title="${ctx.esc(ctx.t('elgCancelTitle'))}">
            <span class="icon icon-stop icon-14"></span>
            <span class="hold-progress"></span>
          </button>
        </div>` : '';
  return `
    <div class="snap-job snap-job--${ctx.esc(jobState)}">
      <div class="snap-job-thumb"${thumbUrl ? ` style="background-image:url('${ctx.esc(thumbUrl)}')"` : ''}></div>
      <div class="snap-job-info">
        <div class="elg-job-name-row${actionBtns ? ' elg-job-name-row--with-btns' : ''}">
          ${nameLine}
          ${actionBtns}
        </div>
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

// Format "current / target°C" — target always shown when the sensor is known,
// even if target is 0 (heater off). Only omits target when the field is null/undefined.
function elgFmtTempWithTarget(cur, target) {
  const curStr = (typeof cur === 'number' && isFinite(cur)) ? `${Math.round(cur)}` : '—';
  if (typeof target === 'number' && isFinite(target)) {
    return `${curStr}/${Math.round(target)}°C`;
  }
  return `${curStr}°C`;
}

export function renderElegooTempCard(conn) {
  const d = conn.data;
  const pills = [];
  if (typeof d.nozzleTemp === 'number') {
    const heating = typeof d.nozzleTarget === 'number' && d.nozzleTarget > 0
                 && d.nozzleTemp < d.nozzleTarget - 2;
    pills.push(`
      <div class="snap-temp snap-temp--editable${heating ? ' snap-temp--heating' : ''}"
           data-elg-set-temp="extruder"
           title="${ctx.esc(ctx.t('elgSetTempTip') || 'Cliquer pour régler la température')}">
        ${ctx.SNAP_ICON_NOZZLE}
        <span class="snap-temp-val">${ctx.esc(elgFmtTempWithTarget(d.nozzleTemp, d.nozzleTarget))}</span>
      </div>`);
  }
  if (typeof d.bedTemp === 'number') {
    const heating = typeof d.bedTarget === 'number' && d.bedTarget > 0
                 && d.bedTemp < d.bedTarget - 2;
    pills.push(`
      <div class="snap-temp snap-temp--bed snap-temp--editable${heating ? ' snap-temp--heating' : ''}"
           data-elg-set-temp="heater_bed"
           title="${ctx.esc(ctx.t('elgSetTempTip') || 'Cliquer pour régler la température')}">
        ${ctx.SNAP_ICON_BED}
        <span class="snap-temp-val">${ctx.esc(elgFmtTempWithTarget(d.bedTemp, d.bedTarget))}</span>
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
        <div class="snap-fil-grid snap-fil-grid--mono">
          <div class="snap-fil snap-fil--editable${color ? ' snap-fil--active' : ''}"
               data-elg-fil-edit="1"
               data-tray-idx="0"
               title="${ctx.esc(ctx.t('snapFilEditableTip') || 'Edit filament')}">
            <div class="snap-fil-tag">Ext.</div>
            <div class="${squareCls}" style="${squareStyle}">
              <span class="snap-fil-main">${ctx.esc(typeLbl)}</span>
            </div>
            <div class="snap-fil-meta">
              <span class="snap-fil-status icon icon-edit icon-13" aria-hidden="true"></span>
              ${fil.vendor ? `<div class="snap-fil-vendor">${ctx.esc(fil.vendor)}</div>` : ''}
              ${fil.name   ? `<div class="snap-fil-sub">${ctx.esc(fil.name)}</div>` : ''}
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
          ${fil.name   ? `<div class="snap-fil-sub">${ctx.esc(fil.name)}</div>` : ''}
        </div>
      </div>`);
  }
  return `
    <section class="snap-block">
      <h4 class="snap-block-title">${ctx.esc(ctx.t('snapFilamentTitle'))}</h4>
      <div class="snap-fil-grid">${filCards.join('')}</div>
    </section>`;
}
