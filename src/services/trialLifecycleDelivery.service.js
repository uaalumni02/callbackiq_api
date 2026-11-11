import { createHash, randomUUID } from 'node:crypto';
import Delivery from '../models/trialLifecycleDelivery.js';
import Subscription from '../models/subscription.js';
import Business from '../models/business.js';
import AlertService from './alert.service.js';
import { sendTrialWelcomeEmail, sendTrialReminderEmail, sendTrialExpiredEmail,
  sendTrackingNumberReleasedEmail } from '../helpers/email/mailer.js';

const fields = {
  welcome: 'trialWelcomeSentAt', three_day: 'trialReminder3dSentAt', one_day: 'trialReminder1dSentAt',
  expired: 'trialExpiredNotifiedAt', number_released: 'trialNumberReleasedNotifiedAt',
};
const messages = {
  welcome: sendTrialWelcomeEmail, three_day: input => sendTrialReminderEmail({ ...input, daysRemaining: 3 }),
  one_day: input => sendTrialReminderEmail({ ...input, daysRemaining: 1 }),
  expired: sendTrialExpiredEmail, number_released: sendTrackingNumberReleasedEmail,
};

export async function sendTrialNotice(subscription, kind) {
  const field = fields[kind];
  if (!subscription || !field || subscription[field]) return false;
  const business = await Business.findById(subscription.business).populate('owner', 'email');
  const email = business?.email || business?.owner?.email;
  if (!email) return false;
  // Keep one notice per lifetime trial. Admin extension does not resend reminders.
  const key = createHash('sha256').update(`${subscription._id}:${kind}`).digest('hex');
  let delivery;
  try {
    delivery = await Delivery.findOneAndUpdate({ _id: key }, { $setOnInsert: {
      business: business._id, subscription: subscription._id, kind, field,
    } }, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    delivery = await Delivery.findById(key);
  }
  if (delivery.status === 'sent') {
    await Subscription.updateOne({ _id: subscription._id, business: delivery.business, [field]: null }, { $set: { [field]: delivery.sentAt } });
    await Delivery.updateOne({ _id: key, status: 'sent' }, { $set: { subscriptionRecorded: true } });
    return false;
  }
  const claimToken = randomUUID();
  const claimed = await Delivery.findOneAndUpdate({ _id: key, status: { $in: ['queued', 'failed'] },
    availableAt: { $lte: new Date() }, attempts: { $lt: 3 },
  }, { $set: { status: 'sending', claimToken, leaseUntil: new Date(Date.now() + 120000) },
    $inc: { attempts: 1 } }, { returnDocument: 'after' });
  if (!claimed) return false;
  const owned = { _id: key, status: 'sending', claimToken };
  let accepted = false;
  try {
    const result = await messages[kind]({ email, businessName: business.businessName,
      trialEndsAt: subscription.trialEndsAt, messageId: `<trial-${key}@meekcall.com>` });
    accepted = Boolean(result?.messageId || result?.accepted?.includes(email));
    if (!accepted) throw Object.assign(new Error('Email acceptance was not verified'), { code: 'EMAIL_ACCEPTANCE_UNKNOWN' });
    const sentAt = new Date();
    const receipt = await Delivery.findOneAndUpdate(owned, { $set: { status: 'sent', sentAt,
      providerMessageId: result.messageId || '', claimToken: null, leaseUntil: null } }, { returnDocument: 'after' });
    if (!receipt) throw new Error('Trial notice claim was lost after provider acceptance');
    await Subscription.updateOne({ _id: subscription._id, business: business._id, [field]: null }, { $set: { [field]: sentAt } });
    await Delivery.updateOne({ _id: key, status: 'sent' }, { $set: { subscriptionRecorded: true } });
    return true;
  } catch (error) {
    const definitelyUnsent = !accepted && ['EMAIL_NOT_CONFIGURED', 'ECONNECTION', 'EAUTH', 'EENVELOPE'].includes(error.code);
    await Delivery.updateOne(owned, { $set: {
      status: definitelyUnsent ? 'failed' : 'uncertain', claimToken: null, leaseUntil: null,
      lastErrorCode: error.code || 'EMAIL_DELIVERY_UNCERTAIN', availableAt: new Date(Date.now() + 3600000),
    } });
    throw error;
  }
}

export async function reconcileTrialNotices(limit = 100) {
  await Delivery.updateMany({ status: 'sending', leaseUntil: { $lte: new Date() } }, {
    $set: { status: 'uncertain', lastErrorCode: 'SEND_INTERRUPTED', claimToken: null },
  });
  const jobs = await Delivery.find({ reviewRecorded: false, $or: [{ status: 'uncertain' },
    { status: 'failed', attempts: { $gte: 3 } }] }).sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
  for (const job of jobs) {
    const alert = await AlertService.createSystemAlert({ businessId: job.business, title: 'Trial email requires review',
      message: 'Trial email delivery could not be verified. Check the provider receipt before sending again.',
      priority: 'medium', metadata: { deliveryId: job._id, kind: job.kind }, dedupeKey: `trial-email:${job._id}` });
    if (alert?.alert?._id) await Delivery.updateOne({ _id: job._id }, { $set: { reviewRecorded: true } });
  }
  const pending = await Delivery.find({ $or: [
    { status: { $in: ['queued', 'failed'] }, attempts: { $lt: 3 }, availableAt: { $lte: new Date() } },
    { status: 'sent', subscriptionRecorded: { $ne: true } },
  ] }).sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
  for (const job of pending) {
    if (job.status === 'sent') {
      await Subscription.updateOne({ _id: job.subscription, business: job.business, [job.field]: null }, { $set: { [job.field]: job.sentAt } });
      await Delivery.updateOne({ _id: job._id, status: 'sent' }, { $set: { subscriptionRecorded: true } });
    } else {
      const subscription = await Subscription.findOne({ _id: job.subscription, business: job.business });
      if (subscription) await sendTrialNotice(subscription, job.kind).catch(() => {});
    }
  }
  return { reviewed: jobs.length, retried: pending.length };
}
