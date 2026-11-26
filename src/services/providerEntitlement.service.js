import { providerDispatchPaused } from "../config/pilotBudgets.js";
import { AsyncLocalStorage } from "node:async_hooks";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import { getSubscriptionAccess } from "./subscriptionAccess.service.js";
import { assertCapabilityEnabled } from "../config/capabilities.js";
const context = new AsyncLocalStorage();
/** Runs tenant provider work with an isolated async identity; never caches entitlement. */
export const withProviderBusiness = (businessId, operation) =>
  context.run({ businessId: String(businessId || "") }, operation);
/** Returns the current tenant identity, or null when provider context is absent. */
export const providerBusinessId = () => context.getStore()?.businessId || null;
/** Reads current canonical entitlement; missing/deleting/inactive records fail closed. */
export async function readProviderEntitlement(
  businessId,
  {
    BusinessModel = Business,
    SubscriptionModel = Subscription,
    now = new Date(),
    allowOnboarding = false,
  } = {},
) {
  if (providerDispatchPaused())
    return { allowed: false, reason: "provider_circuit_open" };
  if (!businessId)
    return { allowed: false, reason: "business_context_required" };
  const [business, subscription] = await Promise.all([
    BusinessModel.findById(businessId).lean(),
    SubscriptionModel.findOne({ business: businessId }).lean(),
  ]);
  const allowed = Boolean(
    business?.isActive &&
    business.accountLifecycle?.status !== "deleting" &&
    (getSubscriptionAccess(subscription, now).providerActionsAllowed ||
      (allowOnboarding &&
        subscription?.status === "none" &&
        ["trial_not_activated", "trial_preparing"].includes(
          subscription.lastPaymentStatus,
        ) &&
        !subscription.trialUsedAt &&
        subscription.trialCount === 0 &&
        !subscription.stripeSubscriptionId)),
  );
  return {
    allowed,
    reason: allowed ? "active_subscription" : "subscription_inactive",
  };
}
/** Rechecks entitlement immediately before provider dispatch; throws before any paid side effect. */
export async function assertProviderEntitlement(
  businessId = providerBusinessId(),
  channel = null,
  dependencies,
) {
  if (channel && channel !== "ai") assertCapabilityEnabled(channel);
  const access = await readProviderEntitlement(businessId, dependencies);
  if (!access.allowed)
    throw Object.assign(
      new Error(
        "Automated service is currently unavailable. Please contact the business directly.",
      ),
      { code: "PROVIDER_ENTITLEMENT_REQUIRED", statusCode: 402 },
    );
  return access;
}
/** Wraps a provider operation with fresh entitlement, including work queued before a state change. */
export async function dispatchEntitledProvider(
  { businessId = providerBusinessId(), channel, dispatch },
  dependencies,
) {
  await assertProviderEntitlement(businessId, channel, dependencies);
  return dispatch();
}

/** Allows identity-provider work for entitled accounts or unused preparation only; all inactive/used states throw before dispatch. */
export function assertVerificationProviderEntitlement(
  businessId,
  dependencies = {},
) {
  return assertProviderEntitlement(businessId, "signup", {
    ...dependencies,
    allowOnboarding: true,
  });
}
