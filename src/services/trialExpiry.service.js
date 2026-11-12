import {observeSubscriptionState} from './subscriptionState.service.js';
import Subscription from '../models/subscription.js';
import { conditionalWrite } from './database/conditionalWrite.js';

export const observeTrialState = observeSubscriptionState;

/** The sole persisted trial-expiry transition. Access calculation remains pure. */
export async function expireObservedTrial(subscription, {
  now = new Date(), lastPaymentStatus = 'trial_expired', releaseAt,
} = {}) {
  if (!subscription || subscription.status !== 'trialing' || !subscription.trialEndsAt ||
      new Date(subscription.trialEndsAt) > now) {
    return { applied: false, current: subscription };
  }
  return conditionalWrite({
    model: Subscription,
    identity: { _id: subscription._id, business: subscription.business?._id || subscription.business },
    observed: observeTrialState(subscription),
    update: { $set: { status: 'expired', lastPaymentStatus, isActive: false, aiEnabled: false,
      ...(releaseAt === undefined ? {} : { trialNumberReleaseAt: releaseAt }) } },
  });
}

export async function expireTrialIfNeeded(subscription) {
  return (await expireObservedTrial(subscription)).current;
}
