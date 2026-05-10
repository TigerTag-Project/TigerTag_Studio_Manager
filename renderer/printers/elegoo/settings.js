/**
 * printers/elegoo/settings.js — Elegoo brand metadata & form schema.
 * Pure data, no dependencies.
 */

export const meta = {
  label: "Elegoo",
  accent: "#00a3e0",
  connection: "MQTT"
};

export const schema = {
  docsUrl: null,
  sections: [
    { titleKey: "printerSecConnection", fields: [
      { key: "ip", labelKey: "printerLblIP",     hintKey: "printerHintElegooIP",
        placeholder: "192.168.1.51", mono: true, required: true },
      { key: "sn", labelKey: "printerLblSerial", hintKey: "printerHintElegooSerial",
        placeholder: "0CCN201XXXX",  mono: true, required: true }
    ]},
    { titleKey: "printerSecCredentialsOptional", fields: [
      { key: "mqttPassword", labelKey: "printerLblMqttPassword", hintKey: "printerHintElegooMqtt",
        placeholder: "—", mono: true, required: false, secret: true, optional: true }
    ]}
  ]
};

export const helper = {
  titleKey:   "printerHelperElegooTitle",
  bulletsKey: "printerHelperElegooBullets"
};
