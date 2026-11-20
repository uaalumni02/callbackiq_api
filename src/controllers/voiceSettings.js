import VoiceSettingsVersionsController from './voiceSettings/Versions.js';
import VoiceSettingsCommandsController from './voiceSettings/Commands.js';
import VoiceSettingsReadinessController from './voiceSettings/Readiness.js';

export { validateUpdate, assertNoDialLoops } from './voiceSettings/helpers.js';

class VoiceSettingsController {
  static schema(...args) { return VoiceSettingsVersionsController.schema(...args); }
  static validateDraft(...args) { return VoiceSettingsVersionsController.validateDraft(...args); }
  static versions(...args) { return VoiceSettingsVersionsController.versions(...args); }
  static rollback(...args) { return VoiceSettingsVersionsController.rollback(...args); }
  static get(...args) { return VoiceSettingsVersionsController.get(...args); }
  static update(...args) { return VoiceSettingsCommandsController.update(...args); }
  static readiness(...args) { return VoiceSettingsReadinessController.readiness(...args); }
}

export default VoiceSettingsController;
