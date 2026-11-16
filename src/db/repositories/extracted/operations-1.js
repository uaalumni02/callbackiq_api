import { recordFailedLogin, clearLoginSecurityState, decayLoginSecurityState } from '../../../services/stateTransitions/accountRecords.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDboperations1Methods(deps) {
  const { safeConsole } = deps;
  return {
async recordFailedLogin(model, userId) {
    try {
      const now = new Date();
      const observationWindowStart = new Date(now.getTime() - 15 * 60 * 1000);
      const decayWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return await recordFailedLogin({ decayWindowStart, model, now, observationWindowStart, userId })
        .select(
          [
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
      safeConsole.error("Error recording failed login:", error);
      throw error;
    }
  },

async clearLoginSecurityState(model, userId) {
    try {
      return await clearLoginSecurityState({ model, userId });
    } catch (error) {
      safeConsole.error("Error clearing login security state:", error);
      throw error;
    }
  },

async decayLoginSecurityState(model, userId) {
    try {
      const decayWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

      return await decayLoginSecurityState({ decayWindowStart, model, userId });
    } catch (error) {
      safeConsole.error("Error decaying login security state:", error);
      throw error;
    }
  }
  };
}
