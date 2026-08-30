import Subscription from "../../src/models/subscription.js";
import Business from "../../src/models/business.js";

export const createActiveTrial = async (businessId) => {
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  await Business.findByIdAndUpdate(businessId, {
    isActive: true,
  });

  return await Subscription.create({
    business: businessId,
    plan: "pro",
    status: "trialing",
    trialStartedAt: now,
    trialEndsAt,
    currentPeriodStart: now,
    currentPeriodEnd: trialEndsAt,
    isActive: true,
    aiEnabled: true,
    priceMonthly: 99,
  });
};
