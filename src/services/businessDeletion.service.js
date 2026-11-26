import {releaseTenantSecondaryNumbers} from './privacy/tenantNumberCleanup.service.js';
import {revokeTenantGrants,tenantErasurePlan,eraseTenantChildren} from './privacy/tenantErasure.service.js';
import {conditionalWrite} from './database/conditionalWrite.js';
import {logOperationalError} from '../helpers/logging/safeLogger.js';
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import { getStripeClient } from "../helpers/stripe/stripeClient.js";
import Intent from '../models/trackingNumberReleaseIntent.js';
import {withTrackingNumberOperation,assertTrackingClaim,observeTrackingState} from './trackingNumberState.service.js';
import { releaseTrackingNumberWithReceipt } from "./trackingNumberProvisioning.service.js";

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

/** Atomic local cleanup after verified external receipts. Changed observations roll back both deletes. */
const deleteObservedLocalState = async (business, subscription, now) => {
    const plan=await tenantErasurePlan(business);
    await Subscription.db.transaction(async session => {
      if (subscription) {
        const removed = await Subscription.deleteOne({_id:subscription._id,business:business._id,
          stripeSubscriptionId:subscription.stripeSubscriptionId,status:subscription.status,
          trialEndsAt:subscription.trialEndsAt,__v:subscription.__v},{session});
        if (!removed.deletedCount) throw cleanupError('BUSINESS_DELETION_SUBSCRIPTION_CHANGED','Subscription changed during cleanup.');
      }
      await eraseTenantChildren({business,subscription,plan,session});
      const removed = await Business.deleteOne({_id:business._id,...observeTrackingState(business),
        'accountLifecycle.status':'deleting','accountLifecycle.deletionStartedAt':now},{session});
      if (!removed.deletedCount) throw cleanupError('BUSINESS_DELETION_RELEASE_CHANGED','Business changed during cleanup.');
    });
};

/** A failure receipt belongs to the same observed deletion and number revision. */
const recordCleanupFailure = async (business, startedAt, error) => {
  try {
    await conditionalWrite({model:Business,identity:{_id:business._id},
      observed:{...observeTrackingState(business),'accountLifecycle.status':'deleting',
        'accountLifecycle.deletionStartedAt':startedAt},
      update:{$set:{'accountLifecycle.lastError':`${error?.code || 'BUSINESS_DELETION_CLEANUP_FAILED'}: ${error?.message || 'Cleanup failed'}`.slice(0,1000)}}});
  } catch (receiptError) {
    logOperationalError('business_deletion.failure_receipt_failed',receiptError,
      {businessId:business._id,code:'BUSINESS_DELETION_RECEIPT_FAILED'});
  }
};

export const deleteBusinessSafely = async ({
  ownerId = null,
  businessId = null,
  business = null,
} = {}) => {
  let current = await loadBusiness({ ownerId, businessId, business });
  if (!current) return null;

  return withTrackingNumberOperation(current, 'release', async reserved => {
  current = reserved;
  const now = current.accountLifecycle?.deletionStartedAt || new Date();
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

    const receipt = await releaseTrackingNumberWithReceipt(current, {authorization:{kind:'business_deletion',deletionStartedAt:now}});
    current = receipt.business;
    await releaseTenantSecondaryNumbers(current);
    if (receipt.outcome === 'superseded' || current?.phone || current?.trackingNumber?.providerSid ||
        await Intent.exists({business:current._id,status:{$in:['pending','dispatching','uncertain']}})) {
      throw cleanupError('BUSINESS_DELETION_RELEASE_CHANGED','Release state changed. Reconcile before deleting the business.');
    }

    const subscription = await Subscription.findOne({
      business: current._id,
    });

    await cancelStripeSubscription(subscription);

    await revokeTenantGrants(current._id);
    await assertTrackingClaim();
    await deleteObservedLocalState(current, subscription, now);

    return current;
  } catch (error) {
    await recordCleanupFailure(current, now, error);

    throw cleanupError(
      error?.code || "BUSINESS_DELETION_CLEANUP_FAILED",
      error?.message ||
        "Provider cleanup failed. The business was not deleted and can be retried safely.",
      error?.statusCode || 503,
    );
  }
  });
};

export default { deleteBusinessSafely };
