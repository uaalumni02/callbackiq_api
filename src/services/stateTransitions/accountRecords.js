// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/db/repositories/extracted/business-1.js:21 — findOneAndUpdate; predicate and write options are owned here.
export function updateOwnedBusiness({ data, model, ownerId }) {
  return (model
        .findOneAndUpdate(
          {
            owner: ownerId,
          },
          data,
          {
            returnDocument: "after",
            runValidators: true,
          },
        ));
}

// src/db/repositories/extracted/demo-1.js:7 — findByIdAndUpdate; predicate and write options are owned here.
export function updateDemoRequest({ data, id, model }) {
  return (model.findByIdAndUpdate(id, data, {
        returnDocument: "after",
        runValidators: true,
      }));
}

// src/db/repositories/extracted/identity-1.js:7 — findByIdAndUpdate; predicate and write options are owned here.
export function persistPasswordResetToken({ expiresAt, model, resetToken, userId }) {
  return (model.findByIdAndUpdate(
        userId,
        {
          resetToken,
          resetTokenExpiresAt: expiresAt,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      ));
}

// src/db/repositories/extracted/identity-1.js:40 — findByIdAndUpdate; predicate and write options are owned here.
export function persistResetPassword({ model, password, userId, resetToken }) {
  if (typeof resetToken !== 'string' || !resetToken) throw new TypeError('A reset-token claim is required');
  return (model.findOneAndUpdate(
        { _id: userId, resetToken, resetTokenExpiresAt: { $gt: new Date() } },
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
      ));
}

// src/db/repositories/extracted/operations-1.js:11 — findOneAndUpdate; predicate and write options are owned here.
export function recordFailedLogin({ decayWindowStart, model, now, observationWindowStart, userId }) {
  return model.findOneAndUpdate({ _id: userId }, [
    { $set: {
      _existingFailureCount: { $cond: [
        { $and: [{ $ne: ["$lastFailedLoginAt", null] }, { $gte: ["$lastFailedLoginAt", observationWindowStart] }] },
        { $ifNull: ["$failedLoginAttempts", 0] }, 0,
      ] },
      _existingLockoutLevel: { $cond: [
        { $or: [{ $eq: ["$lastFailedLoginAt", null] }, { $lt: ["$lastFailedLoginAt", decayWindowStart] }] },
        0, { $ifNull: ["$loginLockoutLevel", 0] },
      ] },
    } },
    { $set: { _nextFailureCount: { $add: ["$_existingFailureCount", 1] } } },
    { $set: {
      _shouldBlock: { $gte: ["$_nextFailureCount", 5] },
      _nextLockoutLevel: { $cond: [
        { $gte: ["$_nextFailureCount", 5] }, { $add: ["$_existingLockoutLevel", 1] }, "$_existingLockoutLevel",
      ] },
    } },
    { $set: { _delayMinutes: { $switch: {
      branches: [
        { case: { $eq: ["$_nextLockoutLevel", 1] }, then: 1 },
        { case: { $eq: ["$_nextLockoutLevel", 2] }, then: 5 },
        { case: { $eq: ["$_nextLockoutLevel", 3] }, then: 15 },
        { case: { $eq: ["$_nextLockoutLevel", 4] }, then: 30 },
      ], default: 60,
    } } } },
    { $set: {
      failedLoginAttempts: { $cond: ["$_shouldBlock", 0, "$_nextFailureCount"] },
      lastFailedLoginAt: now,
      loginLockoutLevel: "$_nextLockoutLevel",
      loginBlockedUntil: { $cond: [
        "$_shouldBlock", { $dateAdd: { startDate: now, unit: "minute", amount: "$_delayMinutes" } },
        { $cond: [
          { $and: [{ $ne: ["$loginBlockedUntil", null] }, { $gt: ["$loginBlockedUntil", now] }] },
          "$loginBlockedUntil", null,
        ] },
      ] },
      lastLoginLockoutAt: { $cond: ["$_shouldBlock", now, "$lastLoginLockoutAt"] },
      securityChallengeRequired: { $or: [
        { $eq: [{ $ifNull: ["$securityChallengeRequired", false] }, true] }, { $gte: ["$_nextLockoutLevel", 3] },
      ] },
      securityChallengeRequiredAt: { $cond: [
        { $and: [
          "$_shouldBlock", { $gte: ["$_nextLockoutLevel", 3] },
          { $ne: [{ $ifNull: ["$securityChallengeRequired", false] }, true] },
        ] }, now, "$securityChallengeRequiredAt",
      ] },
    } },
    { $unset: ["_existingFailureCount", "_existingLockoutLevel", "_nextFailureCount", "_shouldBlock", "_nextLockoutLevel", "_delayMinutes"] },
  ], { returnDocument: "after", updatePipeline: true });
}

// src/db/repositories/extracted/operations-1.js:228 — findByIdAndUpdate; predicate and write options are owned here.
export function clearLoginSecurityState({ model, userId }) {
  return (model.findByIdAndUpdate(
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
      ));
}

// src/db/repositories/extracted/operations-1.js:256 — findOneAndUpdate; predicate and write options are owned here.
export function decayLoginSecurityState({ decayWindowStart, model, userId }) {
  return (model.findOneAndUpdate(
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
      ));
}

// src/db/repositories/subscriptionRepository.js:40 — findOneAndUpdate; predicate and write options are owned here.
export function upsertBusinessSubscription({ businessId, data, model }) {
  return (model
        .findOneAndUpdate(
          { business: businessId },
          {
            ...data,
            business: businessId,
          },
          {
            returnDocument: "after",
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        ));
}

// src/db/repositories/subscriptionRepository.js:67 — findOneAndUpdate; predicate and write options are owned here.
export function updateStripeSubscription({ data, model, stripeSubscriptionId }) {
  return (model
        .findOneAndUpdate({ stripeSubscriptionId }, data, {
          returnDocument: "after",
          runValidators: true,
        }));
}
