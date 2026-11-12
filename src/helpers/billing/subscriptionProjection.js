import { getStripeSubscriptionPriceSnapshot } from './stripeSubscriptionPrice.js';
import { stripePeriodDates } from './stripeSubscriptionSnapshot.js';
import { TRIAL_PRICE_MONTHLY } from './trial.js';

/**
 * Plan a local projection from one provider observation. This function performs
 * no I/O; the caller must conditionally apply fields to its original snapshot.
 * @param {{remote: object, current: object|null, checkoutSessionId: string,
 *   plan: string, now: Date, releaseGraceMs: number, invoiceProjection?: object}} input
 * @returns {{fields: object, active: boolean, terminal: boolean}}
 */
export function planSubscriptionProjection({ remote, current, checkoutSessionId, plan, now,
  releaseGraceMs, invoiceProjection = {} }) {
  const status = String(remote?.status || 'none').toLowerCase();
  const active = status === 'active';
  const terminal = ['paused', 'canceled', 'unpaid', 'incomplete_expired'].includes(status);
  const price = getStripeSubscriptionPriceSnapshot(remote, {
    fallbackPriceMonthly: current?.priceMonthly ?? TRIAL_PRICE_MONTHLY,
    fallbackStripePriceId: current?.stripePriceId || '',
  });
  const latestInvoice = remote?.latest_invoice;
  const fields = {
    stripeCustomerId: remote?.customer || current?.stripeCustomerId || '',
    stripeSubscriptionId: remote?.id || current?.stripeSubscriptionId || '',
    stripePriceId: price.stripePriceId,
    checkoutSessionId: checkoutSessionId || current?.checkoutSessionId || '',
    latestInvoiceId: typeof latestInvoice === 'string' ? latestInvoice : latestInvoice?.id || '',
    plan, status, lastPaymentStatus: status,
    ...stripePeriodDates(remote),
    trialStartedAt: remote?.trial_start ? new Date(remote.trial_start * 1000) : current?.trialStartedAt || null,
    trialEndsAt: remote?.trial_end ? new Date(remote.trial_end * 1000) : current?.trialEndsAt || null,
    cancelAtPeriodEnd: Boolean(remote?.cancel_at_period_end),
    isActive: active, aiEnabled: active,
    priceMonthly: price.priceMonthly ?? TRIAL_PRICE_MONTHLY,
    ...invoiceProjection,
  };
  if (active) fields.trialNumberReleaseAt = null;
  else if (terminal && current?.trialUsedAt) {
    fields.trialNumberReleaseAt = current.trialNumberReleaseAt || new Date(now.getTime() + releaseGraceMs);
  }
  return { fields, active, terminal };
}

/** A lost CAS may acknowledge the same immutable checkout receipt, but must
 * never expose an older checkout URL after entitlement advanced. */
export function matchesCheckoutReceipt(current,{sessionId,customerId,priceId,plan,trialOffered}) {
  return current?.status==='incomplete' && current.isActive===false && current.aiEnabled===false &&
    current.checkoutSessionId===sessionId && current.stripeCustomerId===customerId &&
    current.stripePriceId===priceId && current.plan===plan &&
    current.lastPaymentStatus===(trialOffered?'trial_checkout_started':'checkout_started');
}
