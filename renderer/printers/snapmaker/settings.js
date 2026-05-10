/**
 * printers/snapmaker/settings.js — Snapmaker brand metadata & form schema.
 * Pure data, no dependencies.
 */

export const meta = {
  label: "Snapmaker",
  accent: "#9b59b6",
  connection: "WebSocket"
};

export const schema = {
  docsUrl: null,
  sections: [
    { titleKey: "printerSecConnection", fields: [
      { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintSnapIP",
        placeholder: "192.168.1.53", mono: true, required: true }
    ]}
  ]
};

export const helper = {
  titleKey:   "printerHelperSnapTitle",
  bulletsKey: "printerHelperSnapBullets"
};
