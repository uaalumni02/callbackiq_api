import SmsProcessingJob from '../models/smsProcessingJob.js';
import AlertService from './alert.service.js';
import { reconcileExhaustedInboundSmsJobs } from './messaging/smsProcessingQueue.service.js';
import WebhookWork from '../models/webhookWork.js';

// Dead jobs remain durable even when the database was unavailable while the
// worker tried to create its original failure alert. Reconcile until an
// actionable, linked staff-review record has been stored.
export async function recoverFailedSmsStaffReviews({ now = new Date(), limit = 100 } = {}) {
  await reconcileExhaustedInboundSmsJobs({ now, limit });
  const jobs = await SmsProcessingJob.find({ status: 'dead', 'result.staffReviewAlertRecorded': { $ne: true } })
    .sort({ deadAt: 1, _id: 1 }).limit(Math.max(1, Math.min(250, limit))).lean();
  let recovered = 0;
  for (const job of jobs) {
    const result = await AlertService.create({
      businessId: job.business, leadId: job.lead, conversationId: job.conversation,
      type: 'integration_failure', priority: 'critical', actionRequired: true,
      title: 'Customer SMS requires manual review',
      message: 'Automatic SMS processing exhausted its retries. Review the customer message and any previous reply before responding manually.',
      reason: 'sms_processing_failed',
      recommendedAction: 'Open the conversation, check whether a reply was delivered, and contact the customer if appropriate. Do not assume a booking or callback was confirmed.',
      dueAt: now,
      metadata: { jobId: String(job._id), inboundMessageId: String(job.inboundMessage), attempts: job.attemptCount },
      dedupeKey: `sms_staff_review_dead:${job._id}`,
    });
    if (!result?.alert?._id) throw new Error('Failed SMS staff review was not persisted');
    await SmsProcessingJob.updateOne({ _id: job._id, business: job.business, status: 'dead' }, {
      $set: { 'result.staffReviewAlertRecorded': true },
    });
    recovered += 1;
  }
  return { recovered };
}

export async function recoverFailedWebhookReviews({ now = new Date(), limit = 100 } = {}) {
  const jobs = await WebhookWork.find({ status: 'dead', staffReviewAlertRecorded: { $ne: true } })
    .sort({ updatedAt: 1, _id: 1 }).limit(Math.max(1, Math.min(250, limit))).lean();
  let recovered = 0;
  for (const job of jobs) {
    const safety = job.kind === 'voice_safety_review';
    const result = await AlertService.create({ businessId: job.business,
      ...(safety ? { conversationId: job.payload?.conversationId } : {}),
      type: 'integration_failure', priority: 'critical', actionRequired: true, dueAt: now,
      title: safety ? 'Caller safety report requires manual review' : 'Missed-call recovery requires manual review',
      message: safety ? 'A caller safety report could not be fully processed. Review the linked voice conversation. This is not an emergency dispatch; receipt and response are not guaranteed.' : 'A durable recovery operation could not complete. Verify the provider outcome before contacting the customer.',
      reason: 'recovery_processing_failed', metadata: { jobId: job._id, kind: job.kind },
      dedupeKey: `recovery_staff_review:${job._id}` });
    if (!result?.alert?._id) throw new Error('Recovery staff review was not persisted');
    await WebhookWork.updateOne({ _id: job._id, status: 'dead' }, { $set: { staffReviewAlertRecorded: true } });
    recovered++;
  }
  return { recovered };
}
