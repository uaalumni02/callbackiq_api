const isValidPlan = (plan) => {
  const validPlans = ["starter", "pro", "agency"];
  return validPlans.includes(plan);
};

const isValidSubscriptionStatus = (status) => {
  const validStatuses = [
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
    "none",
  ];

  return validStatuses.includes(status);
};

export { isValidPlan, isValidSubscriptionStatus };
