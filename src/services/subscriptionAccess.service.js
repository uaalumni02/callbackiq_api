const ACCESS_LEVELS = Object.freeze({
  FULL: "full",
  READ_ONLY: "read_only",
  BILLING_ONLY: "billing_only",
  BLOCKED: "blocked",
});

const isFuture = (value, now) =>
  value && new Date(value).getTime() > now.getTime();

export const getSubscriptionAccess = (
  subscription,
  now = new Date(),
) => {
  const status = String(subscription?.status || "none").toLowerCase();

  if (
    status === "trialing" &&
    isFuture(subscription?.trialEndsAt, now) &&
    subscription?.isActive !== false
  ) {
    return {
      level: ACCESS_LEVELS.FULL,
      status,
      automationAllowed: true,
      providerActionsAllowed: true,
      reason: "active_trial",
    };
  }

  if (status === "active" && subscription?.isActive !== false) {
    return {
      level: ACCESS_LEVELS.FULL,
      status,
      automationAllowed: true,
      providerActionsAllowed: true,
      reason: subscription?.cancelAtPeriodEnd
        ? "active_until_period_end"
        : "active_subscription",
    };
  }

  if (
    status === "canceled" &&
    subscription?.cancelAtPeriodEnd &&
    isFuture(subscription?.currentPeriodEnd, now)
  ) {
    return {
      level: ACCESS_LEVELS.FULL,
      status,
      automationAllowed: true,
      providerActionsAllowed: true,
      reason: "active_until_period_end",
    };
  }

  if (status === "past_due") {
    return {
      level: ACCESS_LEVELS.READ_ONLY,
      status,
      automationAllowed: false,
      providerActionsAllowed: false,
      reason: "payment_past_due",
    };
  }

  if (status === "incomplete") {
    return {
      level: ACCESS_LEVELS.BILLING_ONLY,
      status,
      automationAllowed: false,
      providerActionsAllowed: false,
      reason: "checkout_incomplete",
    };
  }

  if (
    [
      "expired",
      "canceled",
      "unpaid",
      "paused",
      "none",
      "incomplete_expired",
    ].includes(status)
  ) {
    return {
      level: ACCESS_LEVELS.READ_ONLY,
      status,
      automationAllowed: false,
      providerActionsAllowed: false,
      reason: `inactive_${status}`,
    };
  }

  return {
    level: ACCESS_LEVELS.BLOCKED,
    status,
    automationAllowed: false,
    providerActionsAllowed: false,
    reason: "unknown_subscription_state",
  };
};

export const hasFullSubscriptionAccess = (subscription, now) =>
  getSubscriptionAccess(subscription, now).level === ACCESS_LEVELS.FULL;

export { ACCESS_LEVELS };
