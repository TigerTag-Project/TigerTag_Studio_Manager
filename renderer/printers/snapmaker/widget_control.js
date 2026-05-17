/**
 * printers/snapmaker/widget_control.js — Snapmaker "Control" card.
 *
 * Layout (mirrors Elegoo's widget_control.js):
 *   [Step ▾] [Speed ▾]
 *   [Z pill] [XY circle] [Home X · Home Y]
 *   Position: X · Y · Z
 *   Part cooling fan: [🌀 toggle] [−] [25%] [+]
 *
 * Commands go through snapSendGcode() via Moonraker printer.gcode.script.
 */
import { ctx } from '../context.js';

// ── Feedrates ─────────────────────────────────────────────────────────────
const FEEDRATE_XY = 6000; // mm/min for X/Y jog
const FEEDRATE_Z  =  600; // mm/min for Z jog

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtPos(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(1);
}

/** Convert Klipper fan speed float 0–1 to display percentage 0–100. */
export function snapFanPct(raw) {
  if (typeof raw !== 'number' || !isFinite(raw)) return 0;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

/** Convert percentage change ±delta into new 0–1 float. */
export function snapFanStep(current, deltaPct) {
  const cur = (typeof current === 'number' && isFinite(current)) ? current : 0;
  return Math.max(0, Math.min(1, cur + deltaPct / 100));
}

// ── Patch-only update ─────────────────────────────────────────────────────
// Updates only dynamic values — avoids full DOM re-create on every WS frame.

export function patchSnapControlCard(ctrlEl, conn) {
  const d = conn.data;

  // Main cooling fan (print head)
  const pctMain   = snapFanPct(d.fanSpeed);
  const pctMainEl = ctrlEl.querySelector('[data-snap-fan-pct="main"]');
  if (pctMainEl) pctMainEl.textContent = `${pctMain}%`;
  const fanMainBtn = ctrlEl.querySelector('[data-snap-fan-toggle="main"]');
  if (fanMainBtn) fanMainBtn.classList.toggle('elg-fan-icon-btn--on', pctMain > 0);

  // Assist cooling fan (side cavity)
  const pctAux   = snapFanPct(d.fanAuxSpeed);
  const pctAuxEl = ctrlEl.querySelector('[data-snap-fan-pct="cavity"]');
  if (pctAuxEl) pctAuxEl.textContent = `${pctAux}%`;
  const fanAuxBtn = ctrlEl.querySelector('[data-snap-fan-toggle="cavity"]');
  if (fanAuxBtn) fanAuxBtn.classList.toggle('elg-fan-icon-btn--on', pctAux > 0);

  // Position X / Y / Z
  const posEl = ctrlEl.querySelector('.snap-ctrl-pos');
  if (posEl) {
    posEl.innerHTML =
      `<span>X:<b>${ctx.esc(fmtPos(d.posX))}</b></span>` +
      `<span>Y:<b>${ctx.esc(fmtPos(d.posY))}</b></span>` +
      `<span>Z:<b>${ctx.esc(fmtPos(d.posZ))}</b></span>`;
  }

  // Speed factor
  const speedDisp = ctrlEl.querySelector('[data-snap-speed-disp]');
  if (speedDisp) speedDisp.textContent = `${Math.round(d.speedFactor ?? 100)}%`;

  // LED / caselight
  const ledBtn = ctrlEl.querySelector('[data-snap-ctrl-led]');
  if (ledBtn) {
    const led = !!d.ledOn;
    ledBtn.classList.toggle('cre-action-btn--led-on', led);
    ledBtn.title = led
      ? (ctx.t('creLedOnTip')  || 'Turn off LED')
      : (ctx.t('creLedOffTip') || 'Turn on LED');
  }
}

// ── Main render ───────────────────────────────────────────────────────────

export function renderSnapControlCard(p, conn) {
  if (conn?.status !== 'connected') return '';
  const d        = conn.data;
  const step     = conn._ctrlStep ?? 10;
  const pctMain  = snapFanPct(d.fanSpeed);
  const pctAux   = snapFanPct(d.fanAuxSpeed);
  const spd      = Math.round(d.speedFactor ?? 100);
  const led      = !!d.ledOn;
  const ledTip   = ctx.esc(led ? (ctx.t('creLedOnTip') || 'Turn off LED') : (ctx.t('creLedOffTip') || 'Turn on LED'));

  return `
    <section class="snap-block elg-ctrl">

      <!-- Jog pad ─────────────────────────────────────────────────── -->
      <div class="elg-jog-wrap">

        <!-- Z pill (left): Z↑ · home-Z · Z↓ -->
        <div class="elg-jog-z-pill">
          <button class="elg-jog-z-btn"
                  data-snap-ctrl-jog="z" data-dist="${step}"
                  title="Z+${step}mm">Z↑</button>
          <button class="elg-jog-home-btn"
                  data-snap-ctrl-home="Z"
                  title="Home Z">
            <span class="icon icon-home elg-home-icon"></span>
          </button>
          <button class="elg-jog-z-btn"
                  data-snap-ctrl-jog="z" data-dist="${-step}"
                  title="Z−${step}mm">Z↓</button>
        </div>

        <!-- XY circle -->
        <div class="elg-jog-xy-circle">
          <button class="elg-jog-xy-btn elg-jog-xy-btn--n"
                  data-snap-ctrl-jog="y" data-dist="${step}"
                  title="Y+${step}mm">Y+</button>
          <button class="elg-jog-xy-btn elg-jog-xy-btn--s"
                  data-snap-ctrl-jog="y" data-dist="${-step}"
                  title="Y−${step}mm">Y−</button>
          <button class="elg-jog-xy-btn elg-jog-xy-btn--w"
                  data-snap-ctrl-jog="x" data-dist="${-step}"
                  title="X−${step}mm">X−</button>
          <button class="elg-jog-xy-btn elg-jog-xy-btn--e"
                  data-snap-ctrl-jog="x" data-dist="${step}"
                  title="X+${step}mm">X+</button>
          <button class="elg-jog-home-btn elg-jog-home-btn--xy"
                  data-snap-ctrl-home="XY"
                  title="Home XY">
            <span class="icon icon-home elg-home-icon" aria-hidden="true"></span>
          </button>
          <div class="elg-jog-sector elg-jog-sector--n" aria-hidden="true"></div>
          <div class="elg-jog-sector elg-jog-sector--s" aria-hidden="true"></div>
          <div class="elg-jog-sector elg-jog-sector--w" aria-hidden="true"></div>
          <div class="elg-jog-sector elg-jog-sector--e" aria-hidden="true"></div>
        </div>

        <!-- Right pill: Home Y · Home X -->
        <div class="elg-jog-right-pill">
          <button class="elg-jog-home-btn"
                  data-snap-ctrl-home="Y"
                  title="Home Y">
            <span class="elg-jog-home-axis">Y</span>
            <span class="icon icon-home elg-home-icon" aria-hidden="true"></span>
          </button>
          <button class="elg-jog-home-btn"
                  data-snap-ctrl-home="X"
                  title="Home X">
            <span class="elg-jog-home-axis">X</span>
            <span class="icon icon-home elg-home-icon" aria-hidden="true"></span>
          </button>
        </div>

        <!-- Info column: folder + LED + position + step + speed -->
        <div class="elg-jog-info-col">
          <div class="elg-ctrl-actions">
            <button type="button"
                    class="cre-action-btn cre-action-btn--files elg-ctrl-action"
                    data-snap-open-files="1"
                    title="Files">
              <span class="icon icon-folder icon-16"></span>
            </button>
            <button type="button"
                    class="cre-action-btn cre-action-btn--led elg-ctrl-action${led ? ' cre-action-btn--led-on' : ''}"
                    data-snap-ctrl-led="1"
                    title="${ledTip}">
              <span class="icon icon-bulb icon-16"></span>
            </button>
          </div>
          <div class="snap-ctrl-pos">
            <span>X:<b>${ctx.esc(fmtPos(d.posX))}</b></span>
            <span>Y:<b>${ctx.esc(fmtPos(d.posY))}</b></span>
            <span>Z:<b>${ctx.esc(fmtPos(d.posZ))}</b></span>
          </div>
          <div class="elg-ctrl-speed-row">
            <span class="elg-ctrl-speed-label">${ctx.esc(ctx.t('elgCtrlStep') || 'Step')}</span>
            <select class="elg-ctrl-speed-select" data-snap-ctrl-step="1">
              ${[0.1, 1, 10, 30].map(s => `
                <option value="${s}"${s === step ? ' selected' : ''}>${s} mm</option>`).join('')}
            </select>
          </div>
          <div class="elg-ctrl-speed-row">
            <span class="elg-ctrl-speed-label">${ctx.esc(ctx.t('snapCtrlSpeed') || 'Speed')}</span>
            <select class="elg-ctrl-speed-select" data-snap-ctrl-speed="1">
              ${[25, 50, 75, 100, 125, 150, 200].map(s => `
                <option value="${s}"${s === spd ? ' selected' : ''}>${s}%</option>`).join('')}
            </select>
          </div>
        </div>

      </div>

      <!-- Fans ────────────────────────────────────────────────────── -->
      <div class="elg-fan-section">
        <div class="elg-fan-cols">

          <!-- Main Cooling (print head) — fan → M106/M107 -->
          <div class="elg-fan-col">
            <div class="elg-fan-col-head">
              <button type="button"
                      class="elg-fan-icon-btn${pctMain > 0 ? ' elg-fan-icon-btn--on' : ''}"
                      data-snap-fan-toggle="main"
                      aria-label="Main cooling fan">
                <span class="icon icon-fan icon-16" aria-hidden="true"></span>
              </button>
              <span class="elg-fan-col-label">${ctx.esc(ctx.t('snapCtrlFanMain') || 'Main')}</span>
            </div>
            <div class="elg-fan-col-controls">
              <button type="button"
                      class="elg-fan-step-btn"
                      data-snap-fan-step="main" data-dist="-10"
                      aria-label="Decrease">−</button>
              <span class="elg-fan-pct" data-snap-fan-pct="main">${pctMain}%</span>
              <button type="button"
                      class="elg-fan-step-btn"
                      data-snap-fan-step="main" data-dist="10"
                      aria-label="Increase">+</button>
            </div>
          </div>

          <!-- Assist Cooling (side cavity) — fan_generic cavity_fan → SET_FAN_SPEED -->
          <div class="elg-fan-col">
            <div class="elg-fan-col-head">
              <button type="button"
                      class="elg-fan-icon-btn${pctAux > 0 ? ' elg-fan-icon-btn--on' : ''}"
                      data-snap-fan-toggle="cavity"
                      aria-label="Assist cooling fan">
                <span class="icon icon-fan icon-16" aria-hidden="true"></span>
              </button>
              <span class="elg-fan-col-label">${ctx.esc(ctx.t('snapCtrlFanAssist') || 'Assist')}</span>
            </div>
            <div class="elg-fan-col-controls">
              <button type="button"
                      class="elg-fan-step-btn"
                      data-snap-fan-step="cavity" data-dist="-10"
                      aria-label="Decrease">−</button>
              <span class="elg-fan-pct" data-snap-fan-pct="cavity">${pctAux}%</span>
              <button type="button"
                      class="elg-fan-step-btn"
                      data-snap-fan-step="cavity" data-dist="10"
                      aria-label="Increase">+</button>
            </div>
          </div>

        </div>
      </div>

    </section>`;
}
