import { getStripeClient } from '../helpers/stripe/stripeClient.js';
import { stripePeriodDates } from '../helpers/billing/stripeSubscriptionSnapshot.js';
const unverified = () => ({
  outcome: 'unverified',
  code: 'TRIAL_EXTENSION_UNVERIFIED',
  statusCode: 409,
  message: 'Stripe has not verified the requested trial extension.'
});
function trialExtensionReceipt(remote, {
  subscriptionId,
  end,
  trialEndsAt
}) {
  if (remote?.status !== 'trialing' || remote.trial_end !== end || remote.id && remote.id !== subscriptionId) return unverified();
  const period = stripePeriodDates(remote);
  return {
    outcome: 'verified',
    receipt: Object.freeze({
      subscriptionId,
      trialEndsAt: new Date(end * 1000),
      currentPeriodEnd: period.currentPeriodEnd || new Date(trialEndsAt)
    })
  };
}
/** A domain operation: no SDK instances, Stripe date fields or request bodies escape.
 * A successful HTTP response alone does not prove the requested entitlement.
 * @param {{subscriptionId:string,trialEndsAt:Date,idempotencyKey:string,client?:object}} input
 */
export async function requestTrialExtension({
  subscriptionId,
  trialEndsAt,
  idempotencyKey,
  client
}) {
  const end = Math.floor(new Date(trialEndsAt).getTime() / 1000);
  if (typeof subscriptionId !== 'string' || !subscriptionId || !idempotencyKey || !Number.isSafeInteger(end)) {
    return {
      outcome: 'rejected',
      code: 'INVALID_BILLING_OPERATION',
      statusCode: 400,
      message: 'A subscription, valid trial end and operation identity are required.'
    };
  }
  if (client === undefined) {
    try {
      client = getStripeClient();
    } catch (cause) {
      return {
        outcome: 'unavailable',
        code: 'STRIPE_NOT_CONFIGURED',
        statusCode: 503,
        message: 'Stripe subscription management is not configured.',
        cause
      };
    }
  }
  if (typeof client?.subscriptions?.update !== 'function') return {
    outcome: 'unavailable',
    code: 'STRIPE_NOT_CONFIGURED',
    statusCode: 503,
    message: 'Stripe subscription management is not configured.'
  };
  try {
    const remote = await client.subscriptions.update(subscriptionId, {
      trial_end: end,
      proration_behavior: 'none'
    }, {
      idempotencyKey
    });
    return trialExtensionReceipt(remote, {
      subscriptionId,
      end,
      trialEndsAt
    });
  } catch (cause) {
    const statusCode = Number(cause?.statusCode || cause?.status) || 503;
    return {
      outcome: statusCode >= 400 && statusCode < 500 && statusCode !== 408 ? 'rejected' : 'uncertain',
      code: cause?.code || 'BILLING_PROVIDER_FAILED',
      statusCode,
      message: 'The billing provider operation could not be verified.',
      cause
    };
  }
}
/** Stable error translation keeps transport objects private to the integration seam. */
export function requireBillingReceipt(result) {
  if (result.outcome === 'verified') return result.receipt;
  throw Object.assign(new Error(result.message, {
    cause: result.cause
  }), {
    code: result.code,
    statusCode: result.statusCode,
    providerOutcome: result.outcome
  });
}
