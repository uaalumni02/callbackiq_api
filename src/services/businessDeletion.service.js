import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import { getStripeClient } from "../helpers/stripe/stripeClient.js";
import { releaseTrackingNumber } from "./trackingNumberProvisioning.service.js";

const cleanupError = (code, message, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const loadBusiness = async ({ ownerId, businessId, business }) => {
  if (business?._id) return business;
  const query = businessId ? { _id: businessId } : { owner: ownerId };
  return Business.findOne(query).select("+trackingNumber.providerSid");
};

const cancelStripeSubscription = async (subscription) => {
  if (!subscription?.stripeSubscriptionId) return false;
  if (
    ["canceled", "incomplete_expired"].includes(
      String(subscription.status || "").toLowerCase(),
    )
  ) {
    return false;
  }

  const stripe = getStripeClient();
  if (!stripe?.subscriptions?.cancel) {
    throw cleanupError(
      "STRIPE_CLEANUP_NOT_CONFIGURED",
      "Billing cleanup is temporarily unavailable. The business was not deleted.",
    );
  }

  try {
    await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
    return true;
  } catch (error) {
    if (
      error?.code === "resource_missing" ||
      Number(error?.statusCode || error?.status) === 404
    ) {
      return false;
    }
    throw error;
  }
};

export const deleteBusinessSafely = async ({
  ownerId = null,
  businessId = null,
  business = null,
} = {}) => {
  let current = await loadBusiness({ ownerId, businessId, business });
  if (!current) return null;

  const now = new Date();
  await Business.updateOne(
    { _id: current._id },
    {
      $set: {
        isActive: false,
        "accountLifecycle.status": "deleting",
        "accountLifecycle.deletionStartedAt": now,
        "accountLifecycle.lastError": "",
      },
    },
  );

  try {
    current = await Business.findById(current._id).select(
      "+trackingNumber.providerSid",
    );

    if (
      current?.trackingNumber?.providerSid ||
      current?.phone ||
      current?.trackingNumber?.status !== "unassigned"
    ) {
      await releaseTrackingNumber(current);
    }

    const subscription = await Subscription.findOne({
      business: current._id,
    });

    await cancelStripeSubscription(subscription);

    await Subscription.deleteOne({ business: current._id });
    await Business.deleteOne({ _id: current._id });

    return current;
  } catch (error) {
    await Business.updateOne(
      { _id: current._id },
      {
        $set: {
          isActive: false,
          "accountLifecycle.status": "deleting",
          "accountLifecycle.lastError": `${error?.code || "error"}: ${
            error?.message || "Cleanup failed"
          }`.slice(0, 1000),
        },
      },
    ).catch(() => {});

    throw cleanupError(
      error?.code || "BUSINESS_DELETION_CLEANUP_FAILED",
      error?.message ||
        "Provider cleanup failed. The business was not deleted and can be retried safely.",
      error?.statusCode || 503,
    );
  }
};

export default { deleteBusinessSafely };
