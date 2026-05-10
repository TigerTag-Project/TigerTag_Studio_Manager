import { registerBrand } from '../registry.js';
import { meta, schema, helper } from './settings.js';
import { schemaWidget } from '../modal-helpers.js';

// Card renderers not yet implemented — integration pending.
const noop = () => "";

registerBrand('bambulab', {
  meta, schema, helper,
  renderJobCard:        noop,
  renderTempCard:       noop,
  renderFilamentCard:   noop,
  renderSettingsWidget: schemaWidget(schema),
});
