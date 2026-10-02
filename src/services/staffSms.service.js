import crypto from 'node:crypto';
import Alert from '../models/alert.js';
import Business from '../models/business.js';
import Policy from '../models/schedulingPolicy.js';
import { sendSms } from './twilioSmsService.js';

const eligibleAttempt = (path, now) => ({ $or: [
  { [path]: { $exists: false } },
  { [`${path}.state`]: 'blocked', [`${path}.retryAt`]: { $lte: now } },
  { [`${path}.state`]: 'sending', [`${path}.at`]: { $lt: new Date(now.getTime() - 120000) } },
] });

export async function runStaffSms({ limit = 100, now = new Date(), send = sendSms } = {}) {
  if (process.env.STAFF_NOTIFICATION_SMS_ENABLED === 'false') return { disabled: true };
  // Explicit owner opt-in is separate from permission to text customers.
  const policies = await Policy.find({ staffSmsEnabled: true, staffSmsPhone: /^\+1\d{10}$/ }).lean();
  if (!policies.length) return { sent: 0 };
  const byBusiness = new Map(policies.map(p => [String(p.business), p]));
  const branches = ['initial', 'overdue'].map(stage => ({
    ...(stage === 'overdue' ? { dueAt: { $ne: null, $lte: now }, 'metadata.staffSms.initial': { $exists: true } } : {}),
    ...eligibleAttempt(`metadata.staffSms.${stage}`, now),
  }));
  const alerts = await Alert.find({ business: { $in: policies.map(p => p.business) },
    actionRequired: true, resolvedAt: null, acknowledgedAt: null,
    'metadata.approvalRequest': { $ne: true }, priority: { $in: ['high', 'critical'] }, $or: branches }).sort({ dueAt: 1, _id: 1 }).limit(Math.max(1, Math.min(100, Number(limit) || 25))).lean();
  let sent = 0;
  for (const alert of alerts) {
    const policy = byBusiness.get(String(alert.business));
    const business = await Business.findOne({ _id: alert.business, isActive: true });
    if (!business) continue;
    const initial = alert.metadata?.staffSms?.initial;
    const stage = !initial || (initial.state === 'blocked' && initial.retryAt && new Date(initial.retryAt) <= now) || initial.state === 'sending'
        ? 'initial' : alert.dueAt && new Date(alert.dueAt) <= now ? 'overdue' : null;
    if (!stage) continue;
    const path = `metadata.staffSms.${stage}`;
    const previous = alert.metadata?.staffSms?.[stage];
    if (previous?.state === 'sending') {
      if (new Date(previous.at) < new Date(now.getTime() - 120000)) {
        await Alert.updateOne({ _id: alert._id, [`${path}.state`]: 'sending' }, { $set: { [`${path}.state`]: 'uncertain' } });
      }
      continue;
    }
    if (previous && !(previous.state === 'blocked' && previous.retryAt && new Date(previous.retryAt) <= now)) continue;
    const token = crypto.randomUUID();
    const claimed = await Alert.findOneAndUpdate({ _id: alert._id, actionRequired: true, resolvedAt: null,
      acknowledgedAt: null, ...eligibleAttempt(path, now) },
      { $set: { [path]: { state: 'sending', at: now, token } } }, { new: true });
    if (!claimed) continue;
    try {
      if (!process.env.CLIENT_URL) throw new Error('CLIENT_URL is required for review links');
      const link = new URL('/intervention-center', process.env.CLIENT_URL);
      if (!['http:', 'https:'].includes(link.protocol)) throw new Error('Invalid application URL');
      if (alert.lead) link.searchParams.set('leadId', String(alert.lead));
      // Acknowledgment or opt-out after the claim cancels dispatch.
      const [stillOpen, stillOptedIn] = await Promise.all([
        Alert.exists({ _id: alert._id, business: alert.business, actionRequired: true, resolvedAt: null, acknowledgedAt: null }),
        Policy.exists({ business: alert.business, staffSmsEnabled: true, staffSmsPhone: policy.staffSmsPhone }),
      ]);
      if (!stillOpen || !stillOptedIn) {
        await Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [`${path}.state`]: 'canceled' } });
        continue;
      }
      const result = await send({ business, to: policy.staffSmsPhone,
        body: `CallBackIQ: ${alert.priority === 'critical' ? 'An urgent safety concern' : 'A customer request'} ${stage === 'overdue' ? 'still needs your attention' : 'needs your attention'}. Review and contact the customer: ${link}. Sign-in required.`,
        actorType: 'system', source: 'staff_request_notice', usageCategory: 'sms',
        metadata: { idempotencyKey: `staff-request:${alert._id}:${stage}` } });
      const state = result?.sid ? 'sent' : result?.suppressed || result?.policyBlocked ? 'blocked' : 'uncertain';
      const retryAt = state === 'blocked' && ['outside_send_window', 'quiet_hours'].includes(result?.reason)
        ? new Date(now.getTime() + 15 * 60000) : null;
      await Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state, at: now, retryAt, reason: result?.reason || '', providerMessageId: result?.sid || '',
      } } });
      if (state === 'sent') sent++;
    } catch (error) {
      // An unknown provider outcome must not trigger a duplicate text on retry.
      await Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state: error.deliveryUncertain ? 'uncertain' : 'failed', at: now, reason: String(error.code || error.message).slice(0, 200),
      } } });
    }
  }
  return { sent };
}
