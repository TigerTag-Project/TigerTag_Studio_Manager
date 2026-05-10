/**
 * printers/creality/settings.js — Creality brand metadata & form schema.
 * Pure data, no dependencies.
 */

export const meta = {
  label: "Creality",
  accent: "#e22a2a",
  connection: "WebSocket"
};

export const schema = {
  docsUrl: "https://wiki.creality.com/",
  sections: [
    { titleKey: "printerSecConnection", fields: [
      { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintCrealityIP",
        placeholder: "192.168.1.50", mono: true, required: true }
    ]},
    // "Root" is a fixed brand-side username on Creality K-series — it is
    // never translated. The labelText override bypasses i18n. It sits
    // before the password by design (matches Creality's own UI order).
    { titleKey: "printerSecCredentials", fields: [
      { key: "account",  labelText: "Root",              hintKey: "printerHintCrealityAccount",
        placeholder: "Root",     mono: true, required: true },
      { key: "password", labelKey: "printerLblPassword", hintKey: "printerHintCrealityPassword",
        placeholder: "••••••••", mono: true, required: true, secret: true }
    ]}
  ]
};

export const helper = {
  titleKey:   "printerHelperCrealityTitle",
  bulletsKey: "printerHelperCrealityBullets"
};
