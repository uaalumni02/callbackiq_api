export const isValidPlan = (plan) => {
  return ["starter", "pro", "agency"].includes(plan);
};

export const isValidSubscriptionStatus = (status) => {
  return [
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "expired",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
    "none",
  ].includes(status);
};
