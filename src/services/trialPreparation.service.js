import Business from '../models/business.js';
import Subscription from '../models/subscription.js';
import { completeObservedSubscription } from './subscriptionState.service.js';
import { provisionTrackingNumber } from './trackingNumberProvisioning.service.js';
import { syncA2pCustomerRegistration } from './a2pCustomerOnboarding.service.js';
import { assertTrialIdentityVerified } from './trialIdentityVerification.service.js';
import { enforceTrialActivationRisk } from './trialRisk.service.js';
import { getTrialEligibility } from '../helpers/billing/trial.js';
import { hasTrialPreparation, trialTelecomReady, preparationMessage } from '../helpers/billing/trialPreparation.js';
import { withDistributedLease } from './distributedLease.service.js';
import { getStripeClient } from '../helpers/stripe/stripeClient.js';
import { safeConsole } from '../helpers/logging/safeLogger.js';

const PREPARATION_DAYS = 30;
const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });
const loadBusiness = id => Business.findById(id).select('+trackingNumber.providerSid +messagingCompliance.messagingServiceSid');

async function expireOpenCheckout(stripe, session) {
  const expired = await stripe.checkout.sessions.expire(session.id);
  if (expired?.status !== 'expired') throw failure('TRIAL_CHECKOUT_UNKNOWN', 'Checkout expiration must be verified before continuing.');
}

async function retirePreviousTrialCheckout(subscription) {
  if (subscription?.status !== 'incomplete' || !subscription.checkoutSessionId) return;
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(subscription.checkoutSessionId);
  if (session.status === 'complete') {
    throw failure('TRIAL_ACTIVATION_RECONCILIATION_PENDING', 'Your previous activation completed. Return to its confirmation page or reload Billing before starting another activation.');
  }
  if (session.status === 'open') await expireOpenCheckout(stripe, session);
  else if (session.status !== 'expired') throw failure('TRIAL_CHECKOUT_UNKNOWN', 'Your previous activation must be reconciled before retrying.');
}

async function verifyPreparationOwner(business, ownerId, subscription) {
  if (!business || business.isActive === false || business.accountLifecycle?.status === 'deleting' ||
      String(business.owner?._id || business.owner) !== String(ownerId)) {
    throw failure('TRIAL_BUSINESS_UNAVAILABLE', 'This business is unavailable for trial preparation.');
  }
  await assertTrialIdentityVerified({ business, ownerId });
  await enforceTrialActivationRisk({ business });
  if (!(await getTrialEligibility({ business, ownerId, subscription })).eligible) {
    throw failure('TRIAL_ALREADY_USED', 'This identity is not eligible for a free trial.');
  }
}

async function advancePreparation(business, subscription) {
  let lastErrorCode = '';
  try {
    await provisionTrackingNumber(business._id);
    // A signed number-registration event is the SMS authority. Do not reset a
    // registered sender to pending by attaching it again during campaign sync.
    if (!trialTelecomReady(await loadBusiness(business._id))) {
      await syncA2pCustomerRegistration({ businessId: business._id });
    }
  } catch (error) {
    lastErrorCode = String(error.code || 'TRIAL_TELECOM_PREPARATION_PENDING').slice(0, 120);
  }
  const currentBusiness = await loadBusiness(business._id);
  const ready = !lastErrorCode && trialTelecomReady(currentBusiness);
  const completion = await completeObservedSubscription({ businessId: business._id, observed: subscription, fields: {
    'trialPreparation.state': ready ? 'ready' : 'pending',
    'trialPreparation.readyAt': ready ? new Date() : null,
    'trialPreparation.lastErrorCode': lastErrorCode,
  } });
  if (!completion.applied) throw failure('TRIAL_PREPARATION_CHANGED', 'Trial preparation changed. Reload before continuing.');
  return { ready, preparing: !ready, subscription: completion.current, message: preparationMessage(completion.current) };
}

// Invoked only after the activation challenge/risk checks. No Stripe subscription
// is created here; retries and carrier delays cannot consume trial days.
export async function prepareTrialForCheckout({ business, ownerId }) {
  const execution = await withDistributedLease(`trial-preparation:${business._id}`, async () => {
    const currentBusiness = await loadBusiness(business._id);
    let subscription = await Subscription.findOne({ business: business._id });
    await verifyPreparationOwner(currentBusiness, ownerId, subscription);
    if (subscription?.stripeSubscriptionId || !['none', 'incomplete'].includes(subscription?.status || 'none')) {
      throw failure('TRIAL_PREPARATION_UNAVAILABLE', 'Reload Billing before starting this trial.');
    }
    if (subscription?.trialPreparation?.state === 'expired') {
      throw failure('TRIAL_PREPARATION_EXPIRED', 'Trial preparation expired without starting your trial. Contact support to restart setup.');
    }
    await retirePreviousTrialCheckout(subscription);
    if (!hasTrialPreparation(subscription)) {
      if (subscription?.trialPreparation && new Date(subscription.trialPreparation.expiresAt) <= new Date()) {
        throw failure('TRIAL_PREPARATION_EXPIRED', 'Trial preparation expired. Contact support to restart setup.');
      }
      const requestedAt = subscription?.trialPreparation?.requestedAt || new Date();
      const expiresAt = subscription?.trialPreparation?.expiresAt || new Date(requestedAt.getTime() + PREPARATION_DAYS * 86400000);
      const completion = await completeObservedSubscription({ businessId: business._id, observed: subscription, fields: {
        status: 'none', lastPaymentStatus: 'trial_preparing', isActive: false, aiEnabled: false,
        trialPreparation: { requestedAt, expiresAt, state: 'pending' }, trialNumberReleaseAt: expiresAt,
      } });
      if (!completion.applied) throw failure('TRIAL_PREPARATION_CHANGED', 'Trial preparation changed. Reload before continuing.');
      subscription = completion.current;
    }
    return advancePreparation(currentBusiness, subscription);
  });
  if (!execution.acquired) throw failure('TRIAL_PREPARATION_BUSY', 'Your number is already being prepared. Retry shortly.');
  return execution.value;
}

// Progress continues after the browser closes. Readiness never starts a trial:
// the owner must still complete the existing no-card Stripe activation.
export async function reconcileTrialPreparations() {
  const rows = Subscription.find({ status: 'none', trialUsedAt: null, stripeSubscriptionId: '',
    'trialPreparation.state': { $in: ['pending', 'ready'] }, 'trialPreparation.expiresAt': { $gt: new Date() },
  }).sort({ _id: 1 }).cursor({ batchSize: 25 });
  for await (const row of rows) {
    await withDistributedLease(`trial-preparation:${row.business}`, async () => {
      const current = await Subscription.findById(row._id);
      if (!hasTrialPreparation(current)) return;
      const business = await loadBusiness(row.business);
      await verifyPreparationOwner(business, business?.owner, current);
      await advancePreparation(business, current);
    }).catch(error => safeConsole.error('Trial preparation reconciliation failed:', {
      businessId: String(row.business), code: error.code || 'TRIAL_PREPARATION_FAILED',
    })); // A failed preparation must not block other tenants or expiry.
  }
}

// Retire an unused activation link before releasing its prepared number. A
// completed session must reconcile first, so a delayed webhook cannot lose it.
export async function reconcilePreparationCheckout(subscription, syncCheckoutSession) {
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(subscription.checkoutSessionId);
  if (session.status === 'complete') {
    const result = await syncCheckoutSession(session);
    if (!result?.stripeSubscriptionId) throw failure('TRIAL_CHECKOUT_UNKNOWN', 'Completed activation is still being reconciled.');
    return result;
  }
  if (session.status === 'open') await expireOpenCheckout(stripe, session);
  else if (session.status !== 'expired') throw failure('TRIAL_CHECKOUT_UNKNOWN', 'Checkout must be reconciled before releasing the prepared number.');
}
