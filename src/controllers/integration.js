import IntegrationGoogleConnectionController from './integration/GoogleConnection.js';
import IntegrationGoogleSettingsController from './integration/GoogleSettings.js';
import IntegrationGoogleOperationsController from './integration/GoogleOperations.js';
import IntegrationJobberController from './integration/Jobber.js';

class IntegrationController {
  static googleConnect(...args) { return IntegrationGoogleConnectionController.googleConnect(...args); }
  static googleCallback(...args) { return IntegrationGoogleConnectionController.googleCallback(...args); }
  static googleStatus(...args) { return IntegrationGoogleConnectionController.googleStatus(...args); }
  static googleCalendars(...args) { return IntegrationGoogleConnectionController.googleCalendars(...args); }
  static googleSelectCalendar(...args) { return IntegrationGoogleSettingsController.googleSelectCalendar(...args); }
  static googleSaveSettings(...args) { return IntegrationGoogleSettingsController.googleSaveSettings(...args); }
  static googleDisconnect(...args) { return IntegrationGoogleSettingsController.googleDisconnect(...args); }
  static googleTest(...args) { return IntegrationGoogleOperationsController.googleTest(...args); }
  static googleSync(...args) { return IntegrationGoogleOperationsController.googleSync(...args); }
  static googleStartWatch(...args) { return IntegrationGoogleOperationsController.googleStartWatch(...args); }
  static googleStopWatch(...args) { return IntegrationGoogleOperationsController.googleStopWatch(...args); }
  static jobberConnect(...args) { return IntegrationJobberController.jobberConnect(...args); }
  static jobberCallback(...args) { return IntegrationJobberController.jobberCallback(...args); }
  static jobberDisconnect(...args) { return IntegrationJobberController.jobberDisconnect(...args); }
  static jobberStatus(...args) { return IntegrationJobberController.jobberStatus(...args); }
  static jobberTest(...args) { return IntegrationJobberController.jobberTest(...args); }
}

export default IntegrationController;
