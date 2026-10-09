import Message from '../../models/message.js';
import AppointmentNotice from '../../models/appointmentNotificationJob.js';
import Alert from '../../models/alert.js';
import InterventionService from '../intervention.service.js';

// Provider acceptance is not delivery. A staff resolution records contact only;
// it never invents a delivered receipt and never initiates another SMS.
export const unresolvedNoticeFailureFilter = (now = new Date()) => ({
  resolutionAt: null,
  $or: [
    { status: 'failed' },
    { status: 'sent', deliveryStatus: { $in: ['failed', 'undelivered', 'uncertain'] } },
    { status: 'sent', deliveryStatus: { $in: ['', 'queued', 'sent'] }, sentAt: { $lte: new Date(now - 15 * 60000) } },
  ],
});
export async function reconcileAppointmentNoticeFailures({ now = new Date(), limit = 100, businessId = null } = {}) {
  const rows = await AppointmentNotice.find({ ...unresolvedNoticeFailureFilter(now), ...(businessId ? { business: businessId } : {}) })
    .sort({ failureCheckedAt: 1, _id: 1 }).limit(limit).lean();
  const ids = rows.map(job => job.providerMessageId).filter(Boolean);
  const receipts = ids.length ? await Message.find({ business: { $in: rows.map(job => job.business) },
    provider: 'twilio', providerMessageId: { $in: ids },
  }).select('business providerMessageId status deliveryStatus').lean() : [];
  const byReceipt = new Map(receipts.map(receipt => [`${receipt.business}:${receipt.providerMessageId}`, receipt]));
  for (const job of rows) {
    // A receipt may arrive before the notice's provider ID is persisted. Its
    // Message remains authoritative even after reconciliation marked it applied.
    const receipt = byReceipt.get(`${job.business}:${job.providerMessageId}`);
    const delivery = receipt?.deliveryStatus || receipt?.status;
    if (['delivered', 'read'].includes(delivery)) {
      await AppointmentNotice.updateOne({ _id: job._id, business: job.business }, { $set: { deliveryStatus: 'delivered' } });
      await resolveNoticeFailure({ businessId: job.business, job, now, reason: 'delivered' });
      continue;
    }
    await InterventionService.create({ businessId: job.business, appointmentId: job.appointment,
      leadId: job.lead, conversationId: job.conversation, type: 'message_delivery_failure',
      title: 'Customer appointment message needs follow-up',
      message: 'A customer appointment message failed or delivery remains unverified. Contact the customer and record the outcome.',
      reason: job.deliveryErrorMessage || job.failureReason || 'No delivery receipt after 15 minutes.',
      recommendedAction: 'Call the customer, then record that they were contacted on the appointment.',
      dedupeKey: `appointment_notice_failure:${job._id}`, metadata: { noticeJobId: String(job._id) },
    });
    await AppointmentNotice.updateOne({ _id: job._id, business: job.business }, { $set: { failureCheckedAt: now } });
  }
  // Delivered late receipts close the same alert without resending a message.
  const delivered = await AppointmentNotice.find({ ...(businessId ? { business: businessId } : {}), resolutionAt: null, failureCheckedAt: { $ne: null },
    deliveryStatus: { $in: ['delivered', 'read'] } }).limit(limit).lean();
  for (const job of delivered) await resolveNoticeFailure({ businessId: job.business, job, now, reason: 'delivered' });
}
async function resolveNoticeFailure({ businessId, job, now, reason, userId = null }) {
  // Close the alert before committing the marker so a crash retries resolution.
  await Alert.updateMany({ business: businessId, dedupeKey: `appointment_notice_failure:${job._id}`, resolvedAt: null },
    { $set: { resolvedAt: now, actionRequired: false } });
  await AppointmentNotice.updateOne({ _id: job._id, business: businessId, resolutionAt: null }, { $set: {
    resolutionAt: now, resolutionReason: reason, resolvedBy: userId,
  } });
}
export async function recordManualNoticeContact({ businessId, appointmentId, jobId, userId, now = new Date() }) {
  const job = await AppointmentNotice.findOne({ _id: jobId, business: businessId, appointment: appointmentId });
  if (!job) throw Object.assign(new Error('Customer notice not found.'), { statusCode: 404 });
  if (!['failed', 'sent', 'canceled'].includes(job.status)) throw Object.assign(new Error('Wait for the queued notice to finish before recording contact.'), { statusCode: 409 });
  await resolveNoticeFailure({ businessId, job, now, userId, reason: 'customer_contacted' });
  return { resolved: true, deliveryStatus: job.deliveryStatus || 'unverified' };
}
