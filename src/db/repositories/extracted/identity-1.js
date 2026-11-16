import { persistPasswordResetToken, persistResetPassword } from '../../../services/stateTransitions/accountRecords.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbidentity1Methods(deps) {
  const { safeConsole } = deps;
  return {
async savePasswordResetToken(model, userId, resetToken, expiresAt) {
    try {
      return await persistPasswordResetToken({ expiresAt, model, resetToken, userId });
    } catch (error) {
      safeConsole.error("Error saving password reset token:", error);
      throw error;
    }
  },
async findUserByPasswordResetToken(model, resetToken) {
    try {
      return await model
        .findOne({
          resetToken,
          resetTokenExpiresAt: { $gt: new Date() },
        })
        .select("+password +resetToken +resetTokenExpiresAt +sessionVersion");
    } catch (error) {
      safeConsole.error("Error finding password reset token:", error);
      throw error;
    }
  },

async saveResetPassword(model, userId, password) {
    try {
      return await persistResetPassword({ model, password, userId });
    } catch (error) {
      safeConsole.error("Error saving reset password:", error);
      throw error;
    }
  },

async findUserByLogin(model, login) {
    try {
      const normalizedLogin = String(login || "").trim();
      const normalizedEmail = normalizedLogin.toLowerCase();

      return await model
        .findOne({
          $or: [{ userName: normalizedLogin }, { email: normalizedEmail }],
        })
        .select(
          [
            "+password",
            "+sessionVersion",
            "+failedLoginAttempts",
            "+lastFailedLoginAt",
            "+loginBlockedUntil",
            "+loginLockoutLevel",
            "+lastLoginLockoutAt",
            "+securityChallengeRequired",
            "+securityChallengeRequiredAt",
          ].join(" "),
        );
    } catch (error) {
      safeConsole.error("Error finding user by login:", error);
      throw new Error("Database error while finding user");
    }
  }
  };
}
