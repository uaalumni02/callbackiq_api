/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDboperations1Methods(deps) {
  const { safeConsole } = deps;
  return {
async recordFailedLogin(model, userId) {
    try {
      const now = new Date();
      const observationWindowStart = new Date(now.getTime() - 15 * 60 * 1000);
      const decayWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      return await model
        .findOneAndUpdate(
          { _id: userId },
          [
            {
              $set: {
                _existingFailureCount: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$lastFailedLoginAt", null] },
                        {
                          $gte: ["$lastFailedLoginAt", observationWindowStart],
                        },
                      ],
                    },
                    { $ifNull: ["$failedLoginAttempts", 0] },
                    0,
                  ],
                },

                _existingLockoutLevel: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$lastFailedLoginAt", null] },
                        {
                          $lt: ["$lastFailedLoginAt", decayWindowStart],
                        },
                      ],
                    },
                    0,
                    { $ifNull: ["$loginLockoutLevel", 0] },
                  ],
                },
              },
            },

            {
              $set: {
                _nextFailureCount: {
                  $add: ["$_existingFailureCount", 1],
                },
              },
            },

            {
              $set: {
                _shouldBlock: {
                  $gte: ["$_nextFailureCount", 5],
                },

                _nextLockoutLevel: {
                  $cond: [
                    { $gte: ["$_nextFailureCount", 5] },
                    { $add: ["$_existingLockoutLevel", 1] },
                    "$_existingLockoutLevel",
                  ],
                },
              },
            },

            {
              $set: {
                _delayMinutes: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 1],
                        },
                        then: 1,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 2],
                        },
                        then: 5,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 3],
                        },
                        then: 15,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 4],
                        },
                        then: 30,
                      },
                    ],
                    default: 60,
                  },
                },
              },
            },

            {
              $set: {
                failedLoginAttempts: {
                  $cond: ["$_shouldBlock", 0, "$_nextFailureCount"],
                },

                lastFailedLoginAt: now,

                loginLockoutLevel: "$_nextLockoutLevel",

                loginBlockedUntil: {
                  $cond: [
                    "$_shouldBlock",
                    {
                      $dateAdd: {
                        startDate: now,
                        unit: "minute",
                        amount: "$_delayMinutes",
                      },
                    },
                    {
                      $cond: [
                        {
                          $and: [
                            {
                              $ne: ["$loginBlockedUntil", null],
                            },
                            {
                              $gt: ["$loginBlockedUntil", now],
                            },
                          ],
                        },
                        "$loginBlockedUntil",
                        null,
                      ],
                    },
                  ],
                },

                lastLoginLockoutAt: {
                  $cond: ["$_shouldBlock", now, "$lastLoginLockoutAt"],
                },

                securityChallengeRequired: {
                  $or: [
                    {
                      $eq: [
                        {
                          $ifNull: ["$securityChallengeRequired", false],
                        },
                        true,
                      ],
                    },
                    {
                      $gte: ["$_nextLockoutLevel", 3],
                    },
                  ],
                },

                securityChallengeRequiredAt: {
                  $cond: [
                    {
                      $and: [
                        "$_shouldBlock",
                        {
                          $gte: ["$_nextLockoutLevel", 3],
                        },
                        {
                          $ne: [
                            {
                              $ifNull: ["$securityChallengeRequired", false],
                            },
                            true,
                          ],
                        },
                      ],
                    },
                    now,
                    "$securityChallengeRequiredAt",
                  ],
                },
              },
            },

            {
              $unset: [
                "_existingFailureCount",
                "_existingLockoutLevel",
                "_nextFailureCount",
                "_shouldBlock",
                "_nextLockoutLevel",
                "_delayMinutes",
              ],
            },
          ],
          {
            returnDocument: "after",
            updatePipeline: true,
          },
        )
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
      return await model.findByIdAndUpdate(
        userId,
        {
          $set: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            loginBlockedUntil: null,
            loginLockoutLevel: 0,
            lastLoginLockoutAt: null,
            securityChallengeRequired: false,
            securityChallengeRequiredAt: null,
            lastSuccessfulLoginAt: new Date(),
          },
        },
        {
          returnDocument: "after",
        },
      );
    } catch (error) {
      safeConsole.error("Error clearing login security state:", error);
      throw error;
    }
  },

async decayLoginSecurityState(model, userId) {
    try {
      const decayWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

      return await model.findOneAndUpdate(
        {
          _id: userId,
          lastFailedLoginAt: {
            $ne: null,
            $lt: decayWindowStart,
          },
        },
        {
          $set: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            loginBlockedUntil: null,
            loginLockoutLevel: 0,
            lastLoginLockoutAt: null,
            securityChallengeRequired: false,
            securityChallengeRequiredAt: null,
          },
        },
        {
          returnDocument: "after",
        },
      );
    } catch (error) {
      safeConsole.error("Error decaying login security state:", error);
      throw error;
    }
  }
  };
}
