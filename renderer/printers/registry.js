/**
 * printers/registry.js — Brand registry.
 *
 * Each brand's index.js calls registerBrand() once at module evaluation time.
 * inventory.js imports `brands` to build PRINTER_BRAND_META / PRINTER_ADD_SCHEMA /
 * PRINTER_ADD_HELPER and to dispatch card rendering by brand id.
 */
export const brands = new Map();

export function registerBrand(id, config) {
  brands.set(id, config);
}
