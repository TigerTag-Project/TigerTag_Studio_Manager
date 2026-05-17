/**
 * printers/context.js — Shared rendering context for brand card widgets.
 *
 * This object is populated by inventory.js early in its initialisation
 * (after all helpers are defined). Brand card files import it and read
 * from it lazily at call time — never at module evaluation time — so the
 * timing is always correct.
 *
 * No dependencies on any other file in this project.
 */
export const ctx = {
  // HTML escape — populated immediately; fallback is a safe no-op.
  esc: s => String(s),

  // i18n lookup — reads state.i18n / state.lang at call time.
  t: k => k,

  // Format helpers (pure functions)
  snapFmtTempPair: (cur, tgt) => `${cur ?? "—"}/${tgt ?? "—"}°C`,
  snapFmtDuration: s => `${Math.floor((s || 0) / 60)}m`,
  snapTextColor: () => "#fff",

  // Printer model helpers (read state.db.printerModels at call time)
  findPrinterModel: () => null,
  printerImageUrl: () => null,
  printerImageUrlFor: () => null,

  // Snapmaker-specific
  snapFilenameRel: s => String(s || ""),

  // SVG icon strings — set to empty strings until populated
  SNAP_ICON_NOZZLE: "",
  SNAP_ICON_BED: "",
  SNAP_ICON_CHAMBER: "",
  SNAP_ICON_CLOCK: "",

  // Callbacks injected by inventory.js — used by brand files to call back
  // into the main renderer without creating circular imports.
  getActivePrinter:      () => null,
  getState:              () => ({}),
  onFullRender:          () => {},   // calls renderPrinterDetail()
  onPrinterStatusChange: () => {},   // calls refreshOpenPrinterDetail() if available
  onPrintersViewChange:  () => {},   // calls renderPrintersView()
  onPrinterGridChange:   () => {},   // renderPrintersView() only when NOT in cam view
  onGridJobsChange:      () => {},   // surgical patch of job blocks in grid cards
  // Hold-to-confirm helper — bound to setupHoldToConfirm() in inventory.js.
  // Brand modules call this after injecting dynamic buttons into the DOM.
  setupHoldToConfirm: () => {},

  // Add-flow bridge — populated by inventory.js. Used by brand add-flow
  // modules to open the global Printer Settings modal and return to the
  // brand picker without creating circular imports.
  openPrinterSettings: (brand, printer, prefill) => {},
  openBrandPicker:     () => {},
  isDebugEnabled:      () => false,
  // Re-applies data-i18n translations across the whole document.
  // Call after dynamically injecting elements that carry data-i18n attributes.
  applyTranslations:   () => {},

  // Creality camera — wired by inventory.js to avoid circular imports between
  // creality/index.js and creality/widget_camera.js.
  creCamStart: _ip => {},
  creCamStop:  ()  => {},
};
