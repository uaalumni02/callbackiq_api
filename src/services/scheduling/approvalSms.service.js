import crypto from 'node:crypto';
import Alert from '../../models/alert.js';
import Business from '../../models/business.js';
import Policy from '../../models/schedulingPolicy.js';
import { sendSms } from '../twilioSmsService.js';

const eligibleAttempt = (path, now) => ({ $or: [
  { [path]: { $exists: false } },
  { [`${path}.state`]: 'blocked', [`${path}.retryAt`]: { $lte: now } },
  { [`${path}.state`]: 'sending', [`${path}.at`]: { $lt: new Date(now.getTime() - 120000) } },
] });

export async function runApprovalSms({ limit = 100, now = new Date(), send = sendSms } = {}) {
  if (process.env.STAFF_APPROVAL_SMS_ENABLED !== 'true') return { disabled: true };
  // Explicit owner opt-in is separate from permission to text customers.
  const policies = await Policy.find({ approvalSmsEnabled: true, approvalSmsPhone: /^\+1\d{10}$/ }).lean();
  if (!policies.length) return { sent: 0 };
  const byBusiness = new Map(policies.map(p => [String(p.business), p]));
  const branches = ['initial', 'overdue', 'expired'].map(stage => ({
    ...(stage === 'expired' ? { 'metadata.approvalState': 'needs_recheck' }
      : { 'metadata.approvalState': { $ne: 'needs_recheck' } }),
    ...(stage === 'overdue' ? { dueAt: { $lte: now }, 'metadata.approvalSms.initial': { $exists: true } }
      : stage === 'initial' ? {} : {}),
    ...eligibleAttempt(`metadata.approvalSms.${stage}`, now),
  }));
  const alerts = await Alert.find({ business: { $in: policies.map(p => p.business) },
    actionRequired: true, resolvedAt: null, acknowledgedAt: null,
    'metadata.approvalRequest': true, $or: branches }).sort({ dueAt: 1, _id: 1 }).limit(limit).lean();
  let sent = 0;
  for (const alert of alerts) {
    const policy = byBusiness.get(String(alert.business));
    const business = await Business.findOne({ _id: alert.business, isActive: true });
    if (!business) continue;
    const initial = alert.metadata?.approvalSms?.initial;
    const stage = alert.metadata?.approvalState === 'needs_recheck' ? 'expired'
      : !initial || (initial.state === 'blocked' && initial.retryAt && new Date(initial.retryAt) <= now) || initial.state === 'sending'
        ? 'initial' : alert.dueAt && new Date(alert.dueAt) <= now ? 'overdue' : null;
    if (!stage) continue;
    const path = `metadata.approvalSms.${stage}`;
    const previous = alert.metadata?.approvalSms?.[stage];
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
      if (!process.env.CLIENT_URL) throw new Error('CLIENT_URL is required for approval links');
      const link = new URL('/appointments', process.env.CLIENT_URL);
      if (!['http:', 'https:'].includes(link.protocol)) throw new Error('Invalid application URL');
      link.searchParams.set('appointmentId', String(alert.appointment || alert.metadata.appointmentId));
      const result = await send({ business, to: policy.approvalSmsPhone,
        body: `CallBackIQ: ${stage === 'expired' ? 'An appointment reservation expired; the request still needs review' : stage === 'overdue' ? 'An appointment request is overdue' : 'An appointment request needs your approval'}. Review and approve securely: ${link}. Sign-in required.`,
        actorType: 'system', source: 'staff_approval_notice', usageCategory: 'sms',
        metadata: { idempotencyKey: `staff-approval:${alert._id}:${stage}` } });
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
