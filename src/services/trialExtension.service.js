import {conditionalWrite} from './database/conditionalWrite.js';
import {observeSubscriptionState} from './subscriptionState.service.js';
import { createHash } from 'node:crypto';
import Subscription from '../models/subscription.js';
import TrialExtensionGrant from '../models/trialExtensionGrant.js';
import { getStripeClient } from '../helpers/stripe/stripeClient.js';
import { stripePeriodDates } from '../helpers/billing/stripeSubscriptionSnapshot.js';
import { assertDistributedLeaseActive, withDistributedLease } from './distributedLease.service.js';

const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

async function reserveExtension({ businessId, adminUserId, days, reason, operationKey }) {
  let subscription = await Subscription.findOne({ business: businessId });
  if (!subscription) throw failure('ACTIVE_TRIAL_REQUIRED', 'Only an active Stripe trial can be extended.');
  const key = createHash('sha256').update(JSON.stringify([businessId, operationKey || [adminUserId, days, reason]])).digest('hex');
  const previous = await TrialExtensionGrant.findOne({ operationKey: key });
  if (previous) return { subscription, intent: { ...previous.toObject(), key }, applied: true };
  const currentIntent = subscription.trialExtensionIntent;
  if (currentIntent?.status === 'pending') {
    if (currentIntent.key !== key) throw failure('TRIAL_EXTENSION_PENDING', 'A previous trial extension requires reconciliation.');
    return { subscription, intent: currentIntent };
  }
  if (subscription.status !== 'trialing' || !subscription.trialUsedAt || !subscription.stripeSubscriptionId ||
      !subscription.trialEndsAt || subscription.trialEndsAt <= new Date()) {
    throw failure('ACTIVE_TRIAL_REQUIRED', 'Only an active Stripe trial can be extended.');
  }
  const history = await TrialExtensionGrant.find({ business: businessId }).select('days').lean();
  const used = history.reduce((sum, grant) => sum + grant.days, 0);
  await Subscription.updateOne({ _id: subscription._id }, { $max: { trialExtensionDaysReserved: used } });
  const configured = Number(process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS ?? 14);
  const maximum = Number.isFinite(configured) && configured >= 0 ? configured : 14;
  if (maximum > 0 && used + days > maximum) throw failure('TRIAL_EXTENSION_LIMIT_REACHED', 'The lifetime trial extension allowance is exhausted.');
  const intent = { key, status: 'pending', business: businessId, subscription: subscription._id,
    grantedBy: adminUserId, days, reason, previousTrialEndsAt: subscription.trialEndsAt,
    requestOperationKey: operationKey, newTrialEndsAt: new Date(subscription.trialEndsAt.getTime() + days * 86400000),
    stripeSubscriptionId: subscription.stripeSubscriptionId };
  assertDistributedLeaseActive();
  subscription = await Subscription.findOneAndUpdate({ _id: subscription._id, status: 'trialing',
    'trialExtensionIntent.status': { $ne: 'pending' },
    ...(maximum > 0 ? { trialExtensionDaysReserved: { $lte: maximum - days } } : {}),
  }, { $inc: { trialExtensionDaysReserved: days }, $set: { trialExtensionIntent: intent } }, { returnDocument: 'after' });
  if (!subscription) throw failure('TRIAL_EXTENSION_LIMIT_REACHED', 'The trial extension allowance is exhausted or another extension is pending.');
  return { subscription, intent };
}

// The grant ledger is immutable evidence. Marking its matching pending intent
// is a monotonic receipt fact; it must not overwrite current entitlement fields.
const recordExtensionReceipt = (subscription,businessId,key) => conditionalWrite({model:Subscription,
  identity:{_id:subscription._id,business:businessId},
  observed:{'trialExtensionIntent.key':key,'trialExtensionIntent.status':'pending'},
  update:{$set:{'trialExtensionIntent.status':'applied'}}});

export async function extendTrial({ businessId, adminUserId, days = 7, reason = '', operationKey = '' }) {
  const safeDays = Math.max(1, Math.min(14, Number(days) || 7));
  const cleanReason = String(reason).trim().slice(0, 500);
  if (!cleanReason) throw failure('TRIAL_EXTENSION_REASON_REQUIRED', 'A reason is required for an administrative trial extension.');
  const execution = await withDistributedLease(`trial-extension:${businessId}`, async () => {
    const { subscription, intent, applied } = await reserveExtension({ businessId, adminUserId,
      days: safeDays, reason: cleanReason, operationKey });
    if (applied) return (await recordExtensionReceipt(subscription,businessId,intent.key)).current;
    const remote = await getStripeClient().subscriptions.update(intent.stripeSubscriptionId, {
      trial_end: Math.floor(new Date(intent.newTrialEndsAt).getTime() / 1000), proration_behavior: 'none',
    }, { idempotencyKey: `trial-extension:${intent.key}` });
    assertDistributedLeaseActive();
    if (remote.status !== 'trialing' || remote.trial_end !== Math.floor(new Date(intent.newTrialEndsAt).getTime() / 1000)) {
      throw failure('TRIAL_EXTENSION_UNVERIFIED', 'Stripe has not verified the requested trial extension.');
    }
    const completion=await conditionalWrite({model:Subscription,identity:{_id:subscription._id,business:businessId},
      observed:{...observeSubscriptionState(subscription),'trialExtensionIntent.key':intent.key},
      update:{$max:{trialEndsAt:new Date(remote.trial_end*1000)},$set:{currentPeriodEnd:
        stripePeriodDates(remote).currentPeriodEnd || new Date(intent.newTrialEndsAt)},$inc:{__v:1}}});
    if (!completion.applied) throw Object.assign(failure('TRIAL_EXTENSION_PENDING',
      'The subscription changed. Verify the Stripe outcome before another extension.'),{current:completion.current});
    const updated=completion.current;
    await TrialExtensionGrant.findOneAndUpdate({ operationKey: intent.key }, { $setOnInsert: {
      business: intent.business, subscription: intent.subscription, grantedBy: intent.grantedBy,
      days: intent.days, reason: intent.reason, previousTrialEndsAt: intent.previousTrialEndsAt,
      newTrialEndsAt: intent.newTrialEndsAt, stripeSubscriptionId: intent.stripeSubscriptionId,
    } }, { upsert: true, returnDocument: 'after', runValidators: true });
    return (await recordExtensionReceipt(updated,businessId,intent.key)).current;
  });
  if (!execution.acquired) throw failure('TRIAL_EXTENSION_PENDING', 'A trial extension is already being processed.');
  return execution.value;
}

export async function reconcileTrialExtensions(limit = 25) {
  const rows = await Subscription.find({ 'trialExtensionIntent.status': 'pending' })
    .select('business trialExtensionIntent').sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
  const errors = [];
  for (const row of rows) {
    const intent = row.trialExtensionIntent;
    try {
      await extendTrial({ businessId: String(row.business), adminUserId: intent.grantedBy,
        days: intent.days, reason: intent.reason, operationKey: intent.requestOperationKey || '' });
    } catch (error) { errors.push({ businessId: String(row.business), code: error.code || 'TRIAL_EXTENSION_RETRY' }); }
  }
  return { checked: rows.length, errors };
}
