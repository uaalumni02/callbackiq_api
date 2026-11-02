/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbidentity1Methods(deps) {
  const { safeConsole } = deps;
  return {
async savePasswordResetToken(model, userId, resetToken, expiresAt) {
    try {
      return await model.findByIdAndUpdate(
        userId,
        {
          resetToken,
          resetTokenExpiresAt: expiresAt,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
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
      return await model.findByIdAndUpdate(
        userId,
        {
          $set: {
            password,
            resetToken: null,
            resetTokenExpiresAt: null,
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            loginBlockedUntil: null,
            loginLockoutLevel: 0,
            lastLoginLockoutAt: null,
            securityChallengeRequired: false,
            securityChallengeRequiredAt: null,
          },
          $inc: {
            sessionVersion: 1,
          },
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
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
