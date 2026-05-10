/**
 * printers/flashforge/settings.js — FlashForge brand metadata & form schema.
 * Pure data, no dependencies.
 */

export const meta = {
  label: "FlashForge",
  accent: "#f39c12",
  connection: "HTTP"
};

export const schema = {
  docsUrl: null,
  sections: [
    { titleKey: "printerSecConnection", fields: [
      { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintFFGIP",
        placeholder: "192.168.1.52", mono: true, required: true }
    ]},
    { titleKey: "printerSecCredentials", fields: [
      { key: "serialNumber", labelKey: "printerLblSerial",   hintKey: "printerHintFFGSerial",
        placeholder: "FF-AD5X-XXXX", mono: true, required: true },
      { key: "password",     labelKey: "printerLblPassword", hintKey: "printerHintFFGPassword",
        placeholder: "••••••••",     mono: true, required: true, secret: true }
    ]}
  ]
};

export const helper = {
  titleKey:   "printerHelperFFGTitle",
  bulletsKey: "printerHelperFFGBullets"
};
