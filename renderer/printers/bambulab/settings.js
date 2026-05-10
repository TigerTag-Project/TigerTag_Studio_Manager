/**
 * printers/bambulab/settings.js — Bambu Lab brand metadata & form schema.
 * Pure data, no dependencies.
 */

export const meta = {
  label: "Bambu Lab",
  accent: "#1ba84e",
  connection: "MQTT (LAN)"
};

export const schema = {
  docsUrl: "https://wiki.bambulab.com/en/x1/manual/lan-mode",
  sections: [
    { titleKey: "printerSecConnection", fields: [
      { key: "broker", labelKey: "printerLblIP", hintKey: "printerHintBambuIP",
        placeholder: "192.168.1.42", mono: true, required: true }
    ]},
    { titleKey: "printerSecCredentials", fields: [
      { key: "password",     labelKey: "printerLblAccessCode", hintKey: "printerHintBambuCode",
        placeholder: "12345678",     mono: true, required: true, secret: true },
      { key: "serialNumber", labelKey: "printerLblSerial",     hintKey: "printerHintBambuSerial",
        placeholder: "01S00C123456", mono: true, required: true }
    ]}
  ]
};

export const helper = {
  titleKey:   "printerHelperBambuTitle",
  bulletsKey: "printerHelperBambuBullets"
};
