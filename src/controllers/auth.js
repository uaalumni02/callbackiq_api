import AuthRegistrationController from './auth/Registration.js';
import AuthSessionController from './auth/Session.js';
import AuthPasswordResetController from './auth/PasswordReset.js';

class AuthController {
  static register(...args) { return AuthRegistrationController.register(...args); }
  static login(...args) { return AuthSessionController.login(...args); }
  static me(...args) { return AuthSessionController.me(...args); }
  static requestPasswordReset(...args) { return AuthPasswordResetController.requestPasswordReset(...args); }
  static resetPassword(...args) { return AuthPasswordResetController.resetPassword(...args); }
  static logout(...args) { return AuthSessionController.logout(...args); }
}

export default AuthController;
