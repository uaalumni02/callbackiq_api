import Subscription from '../models/subscription.js';
import { conditionalWrite } from './database/conditionalWrite.js';
import { observeTrialState } from './trialExpiry.service.js';
import { getSubscriptionAccess, ACCESS_LEVELS } from './subscriptionAccess.service.js';
import { getStripeClient } from '../helpers/stripe/stripeClient.js';
import { releaseTrackingNumberWithReceipt } from './trackingNumberProvisioning.service.js';
import { reconcilePreparationCheckout } from './trialPreparation.service.js';
import { sendTrialNotice } from './trialLifecycleDelivery.service.js';
import { safeConsole } from '../helpers/logging/safeLogger.js';

const hasFullAccess = (subscription, now) => getSubscriptionAccess(subscription, now).level === ACCESS_LEVELS.FULL;

async function reconcileBeforeRelease(subscription, now, { syncStripeSubscription, syncCheckoutSession }) {
  try {
    if (!subscription.stripeSubscriptionId && subscription.checkoutSessionId) {
      await reconcilePreparationCheckout(subscription, syncCheckoutSession);
      subscription = await Subscription.findById(subscription._id);
      if (!subscription) return null;
    }
    if (subscription.stripeSubscriptionId) {
      const remote = await getStripeClient().subscriptions.retrieve(subscription.stripeSubscriptionId, { expand: ['latest_invoice'] });
      await syncStripeSubscription({ stripeSubscription: remote, refreshFromStripe: false, observedSubscription: subscription });
      subscription = await Subscription.findById(subscription._id);
      if (!subscription) return null;
    }
    return subscription;
  } catch (error) {
    safeConsole.error('Trial number release reconciliation failed:', error);
    await conditionalWrite({ model: Subscription, identity: { _id: subscription._id, business: subscription.business },
      observed: observeTrialState(subscription), update: { $set: { trialNumberReleaseAt: new Date(now.getTime() + 86400000) } } });
    return null;
  }
}

// Reconcile Stripe immediately before destructive telecom work. Uncertain
// billing outcomes postpone release; a preparation is never a billable trial.
export async function releaseExpiredTrialNumber(subscriptionId, now, synchronizers) {
  let current = await Subscription.findById(subscriptionId);
  if (!current?.trialNumberReleaseAt || current.trialNumberReleaseAt > now || hasFullAccess(current, now)) return;
  current = await reconcileBeforeRelease(current, now, synchronizers);
  if (!current || hasFullAccess(current, now) || !current.trialNumberReleaseAt || current.trialNumberReleaseAt > now) return;
  const released = await releaseTrackingNumberWithReceipt(current.business, {
    authorization: { kind: 'trial_expiry', subscription: { subscriptionId: current._id, ...observeTrialState(current) } },
  }).catch(error => { safeConsole.error('Trial number release failed:', error); return null; });
  if (!released || !['released', 'already_released'].includes(released.outcome)) return;
  const completion = await conditionalWrite({ model: Subscription, identity: { _id: current._id, business: current.business },
    observed: observeTrialState(current), update: { $set: { trialNumberReleaseAt: null,
      ...(!current.trialUsedAt && current.trialPreparation ? { 'trialPreparation.state': 'expired' } : {}),
    } } });
  if (completion.applied && released.intentId && current.trialUsedAt) {
    await sendTrialNotice(completion.current, 'number_released').catch(error => safeConsole.error('Trial lifecycle notice failed:', error));
  }
}
